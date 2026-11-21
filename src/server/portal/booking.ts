import "server-only";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { RequestMeta } from "../auth/platform-auth";
import { withAppContext, withPortal, type Tx } from "../db";
import { DomainError } from "../errors";
import { notifyAppointmentBooked } from "../notifications/notifications";
import { daySlots } from "../scheduling/availability";
import { addDays, instantToLocalDate, isLocalDate, type LocalDate } from "../scheduling/time";
import { hashIp, uuidv7 } from "../security/crypto";
import { rateLimit } from "../security/rate-limit";
import type { PatientPrincipal } from "./auth";

/**
 * Online self-booking for patients. Runs as `itopmed_portal`: the role cannot
 * see other patients' appointments, so availability comes from SECURITY DEFINER
 * functions that return times only, and portal_book() validates and writes the
 * booking inside PostgreSQL (doctor opted in, clinic rules, working hours, days
 * off, slot alignment). Double booking is impossible: the exclusion constraint.
 */
function inPortal<T>(p: PatientPrincipal, fn: (tx: Tx) => Promise<T>) {
  return withPortal({ sessionId: p.sessionId }, fn);
}

export interface BookableDoctor {
  id: string;
  fullName: string;
  specialty: string;
  slotMinutes: number;
  bufferMinutes: number;
}

export async function bookableDoctors(p: PatientPrincipal): Promise<BookableDoctor[]> {
  return inPortal(p, (tx) => tx.$queryRaw<BookableDoctor[]>`SELECT id, "fullName", specialty, "slotMinutes", "bufferMinutes" FROM portal_booking_doctors()`);
}

export interface BookingRules {
  days: number;
  leadMinutes: number;
  maxActive: number;
  timezone: string;
  activeCount: number;
}

async function rulesIn(tx: Tx): Promise<BookingRules> {
  const r = (await tx.$queryRaw<BookingRules[]>`SELECT days, "leadMinutes", "maxActive", timezone, "activeCount" FROM portal_booking_rules()`)[0];
  if (!r) throw new DomainError("errors.forbidden");
  return r;
}

/** Free slots of one doctor for up to `maxDays` days with at least one slot (clinic rules applied). */
export async function availableDays(p: PatientPrincipal, doctorId: string, opts: { from?: string; maxDays?: number } = {}) {
  if (!z.uuid().safeParse(doctorId).success) throw new DomainError("errors.notFound");
  return inPortal(p, async (tx) => {
    const rules = await rulesIn(tx);
    const doctor = (await tx.$queryRaw<BookableDoctor[]>`SELECT id, "fullName", specialty, "slotMinutes", "bufferMinutes" FROM portal_booking_doctors() WHERE id = ${doctorId}::uuid`)[0];
    if (!doctor) throw new DomainError("errors.doctorUnavailable");
    const tz = rules.timezone;
    const now = new Date();
    const notBefore = new Date(now.getTime() + rules.leadMinutes * 60_000);
    const today = instantToLocalDate(now, tz);
    const first = isLocalDate(opts.from) && opts.from > today ? opts.from : today;
    const last = addDays(today, rules.days);
    const span = Math.min(rules.days + 1, 31);
    const to = addDays(first, span - 1) < last ? addDays(first, span - 1) : last;
    const blocks = await tx.$queryRaw<{ weekday: number; startMinute: number; endMinute: number; branchId: string; roomId: string | null }[]>`
      SELECT weekday, "startMinute", "endMinute", "branchId", "roomId" FROM portal_booking_blocks(${doctorId}::uuid)`;
    const absences = new Set(
      (await tx.$queryRaw<{ d: Date }[]>`SELECT d FROM portal_booking_absences(${doctorId}::uuid, ${first}::date, ${to}::date) AS d`).map((r) => r.d.toISOString().slice(0, 10)),
    );
    const rangeStart = new Date(`${first}T00:00:00Z`);
    const rangeEnd = new Date(new Date(`${to}T00:00:00Z`).getTime() + 2 * 86_400_000);
    const busy = (
      await tx.$queryRaw<{ startsAt: Date; endsAt: Date }[]>`SELECT "startsAt", "endsAt" FROM portal_booking_busy(${doctorId}::uuid, ${rangeStart}::timestamp, ${rangeEnd}::timestamp)`
    ).map((b) => ({ start: b.startsAt, end: b.endsAt }));
    const days: { date: LocalDate; slots: string[] }[] = [];
    for (let d: LocalDate = first; d <= to && days.length < (opts.maxDays ?? 7); d = addDays(d, 1)) {
      const slots = daySlots({ date: d, timeZone: tz, blocks, hasException: absences.has(d), slotMinutes: doctor.slotMinutes, bufferMinutes: doctor.bufferMinutes, busy, notBefore }).filter(
        (s) => s.start.getTime() <= now.getTime() + rules.days * 86_400_000,
      );
      if (slots.length) days.push({ date: d, slots: slots.map((s) => s.start.toISOString()) });
    }
    const next = days.length ? addDays(days[days.length - 1]!.date, 1) : null;
    return { doctor, rules, days, next: next && next <= last ? next : null, timezone: tz };
  });
}

const BOOK_ERRORS: Record<string, string> = {
  forbidden: "errors.forbidden",
  doctor_unavailable: "errors.doctorUnavailable",
  too_soon: "errors.bookingTooSoon",
  too_far: "errors.bookingTooFar",
  too_many: "errors.bookingTooMany",
  outside_schedule: "errors.outsideSchedule",
};

export const onlineBookingSchema = z.object({ doctorId: z.uuid(), startsAt: z.iso.datetime({ offset: true }) });

/** Patient books a free slot. The clinic is notified like any booking; the patient gets the usual confirmation and reminder. */
export async function bookOnline(p: PatientPrincipal, raw: unknown, meta: RequestMeta): Promise<string> {
  if (!(await rateLimit(`pbook:${p.accountId}`, 10, 60 * 60_000))) throw new DomainError("errors.rateLimited");
  const input = onlineBookingSchema.parse(raw);
  const startsAt = new Date(input.startsAt);
  const id = uuidv7();
  await inPortal(p, async (tx) => {
    let code: string | undefined;
    try {
      code = (await tx.$queryRaw<{ r: string }[]>`SELECT portal_book(${id}::uuid, ${input.doctorId}::uuid, (${startsAt.toISOString()}::timestamptz AT TIME ZONE 'UTC')) AS r`)[0]?.r;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (/23P01|Appointment_no_overlap|exclusion/i.test(msg)) throw new DomainError("errors.slotTaken");
      throw e;
    }
    if (code !== "ok") throw new DomainError(BOOK_ERRORS[code ?? ""] ?? "errors.forbidden");
    await recordAudit(tx, { tenantId: p.tenant.id, actorType: "PATIENT", actorId: p.accountId, action: "portal.appointment_booked", entityType: "Appointment", entityId: id, ipHash: hashIp(meta.ip), userAgent: meta.userAgent });
  });
  // Confirmation and reminder go through the clinic's notification outbox (server-side; the patient never reads it).
  await withAppContext({ tenantId: p.tenant.id }, (tx) => notifyAppointmentBooked(tx, p.tenant.id, { id, patientId: p.patientId, startsAt }));
  return id;
}
