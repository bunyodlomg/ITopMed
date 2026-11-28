import "server-only";
import type { ClinicContext } from "../auth/clinic-auth";
import { inClinic, requirePermission } from "../clinic/context";
import { addDays, localToInstant, todayIn } from "../scheduling/time";

/**
 * What the front desk and the doctor need to recognise a patient at a glance,
 * without clinical content: how many visits, the last one (date, doctor,
 * service), whether the patient is in today's queue, and the next booking.
 */
export interface PatientVisitSummary {
  visits: number;
  last: { at: Date; doctor: string; service: string | null } | null;
  /** Visits before today and the latest of them: "first visit" vs "returning" for today's patient. */
  earlier: number;
  lastEarlier: { at: Date; doctor: string; service: string | null } | null;
  today: boolean;
  next: { at: Date; doctor: string } | null;
}

const COUNTED = ["CHECKED_IN", "IN_PROGRESS", "COMPLETED"] as const;

export async function patientVisitSummaries(ctx: ClinicContext, patientIds: string[]): Promise<Map<string, PatientVisitSummary>> {
  requirePermission(ctx, "patients.read");
  const out = new Map<string, PatientVisitSummary>();
  const ids = [...new Set(patientIds)].slice(0, 200);
  if (!ids.length) return out;
  const tz = ctx.tenant.timezone;
  const day = todayIn(tz);
  const from = localToInstant(day, 0, tz);
  const to = localToInstant(addDays(day, 1), 0, tz);
  const rows = await inClinic(ctx, (tx) =>
    tx.appointment.findMany({
      where: { patientId: { in: ids }, status: { not: "CANCELLED" } },
      select: { patientId: true, startsAt: true, status: true, service: { select: { name: true } }, doctor: { select: { membership: { select: { user: { select: { fullName: true } } } } } } },
      orderBy: { startsAt: "desc" },
    }),
  );
  for (const id of ids) out.set(id, { visits: 0, last: null, earlier: 0, lastEarlier: null, today: false, next: null });
  const now = new Date();
  for (const a of rows) {
    const s = out.get(a.patientId)!;
    const doctor = a.doctor.membership.user.fullName;
    if (a.startsAt >= from && a.startsAt < to) s.today = true;
    if ((COUNTED as readonly string[]).includes(a.status)) {
      s.visits++;
      if (!s.last) s.last = { at: a.startsAt, doctor, service: a.service?.name ?? null };
      if (a.startsAt < from) {
        s.earlier++;
        if (!s.lastEarlier) s.lastEarlier = { at: a.startsAt, doctor, service: a.service?.name ?? null };
      }
    } else if (a.status === "BOOKED" && a.startsAt > now) {
      // Rows are newest first: the last one seen is the nearest future booking.
      s.next = { at: a.startsAt, doctor };
    }
  }
  return out;
}

export type PatientListFilter = "recent" | "today" | "debt" | "new";

const listSelect = { id: true, mrn: true, lastName: true, firstName: true, middleName: true, birthDate: true, birthYearOnly: true, sex: true, phone: true, status: true, createdAt: true } as const;

/**
 * The patient list without a search: the latest registrations, today's patients,
 * patients with an unpaid bill (only for people who see bills), or new this month.
 */
export async function listPatients(ctx: ClinicContext, filter: PatientListFilter, take = 50) {
  requirePermission(ctx, "patients.read");
  const tz = ctx.tenant.timezone;
  const day = todayIn(tz);
  const base = { tenantId: ctx.tenant.id, status: { not: "MERGED" as const } };
  return inClinic(ctx, async (tx) => {
    if (filter === "today") {
      return tx.patient.findMany({
        where: { ...base, appointments: { some: { status: { not: "CANCELLED" }, startsAt: { gte: localToInstant(day, 0, tz), lt: localToInstant(addDays(day, 1), 0, tz) } } } },
        select: listSelect,
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
        take,
      });
    }
    if (filter === "debt" && (ctx.permissions.has("billing.read") || ctx.permissions.has("billing.charge"))) {
      const owing = await tx.invoice.findMany({ where: { status: { in: ["ISSUED", "PARTIALLY_PAID"] } }, select: { patientId: true }, distinct: ["patientId"], take: 500 });
      return tx.patient.findMany({ where: { ...base, id: { in: owing.map((o) => o.patientId) } }, select: listSelect, orderBy: [{ lastName: "asc" }, { firstName: "asc" }], take });
    }
    if (filter === "new") {
      const monthStart = `${day.slice(0, 8)}01` as typeof day;
      return tx.patient.findMany({ where: { ...base, createdAt: { gte: localToInstant(monthStart, 0, tz) } }, select: listSelect, orderBy: { createdAt: "desc" }, take });
    }
    return tx.patient.findMany({ where: base, select: listSelect, orderBy: { createdAt: "desc" }, take });
  });
}

/** Whole years between the birth date and today (in the clinic's time zone). */
export function ageOn(birthDate: Date, today: string): number {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const by = birthDate.getUTCFullYear();
  const bm = birthDate.getUTCMonth() + 1;
  const bd = birthDate.getUTCDate();
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}
