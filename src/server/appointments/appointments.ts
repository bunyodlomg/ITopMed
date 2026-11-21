import "server-only";
import { z } from "zod";
import { Prisma, type AppointmentStatus, type CancellationReason } from "@/generated/prisma/client";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { assertBranch, auditClinic, canUseBranch, inClinic, requirePermission } from "../clinic/context";
import type { Tx } from "../db";
import { addDays, instantToLocalDate, isLocalDate, isoWeekday, localDateToDbDate, localToInstant, type LocalDate } from "../scheduling/time";
import { uuidv7 } from "../security/crypto";
import { DomainError } from "../tenancy/provisioning";
import { notifyAppointmentBooked, notifyAppointmentCancelled, notifyAppointmentRescheduled, notifyNoShow } from "../notifications/notifications";

const uuid = z.uuid();
export const CANCELLATION_REASONS = ["PATIENT_REQUEST", "CLINIC_RESCHEDULE", "DOCTOR_UNAVAILABLE", "DUPLICATE", "OTHER"] as const;
export const ACTIVE_STATUSES: AppointmentStatus[] = ["BOOKED", "CHECKED_IN", "IN_PROGRESS"];
/** Appointments may be booked up to this many minutes in the past (clock drift, late entry). */
const PAST_TOLERANCE_MS = 5 * 60_000;

const adminNote = z
  .string()
  .trim()
  .max(200, "validation.tooLong")
  .transform((v) => (v === "" ? undefined : v))
  .optional();

async function loadDoctor(tx: Tx, ctx: ClinicContext, doctorProfileId: string) {
  const d = await tx.doctorProfile.findUnique({
    where: { id: uuid.parse(doctorProfileId) },
    include: { membership: { select: { status: true, tenantId: true } }, services: { select: { serviceId: true } } },
  });
  if (!d || d.archivedAt || d.membership.status !== "ACTIVE" || d.membership.tenantId !== ctx.tenant.id) throw new DomainError("errors.doctorUnavailable");
  return d;
}

async function loadActivePatient(tx: Tx, patientId: string) {
  const p = await tx.patient.findUnique({ where: { id: uuid.parse(patientId) }, select: { id: true, status: true } });
  if (!p || p.status !== "ACTIVE") throw new DomainError("errors.notFound");
  return p;
}

async function loadService(tx: Tx, serviceId: string | undefined, doctor: { services: { serviceId: string }[] }) {
  if (!serviceId) return null;
  const s = await tx.service.findFirst({ where: { id: uuid.parse(serviceId), archivedAt: null } });
  if (!s) throw new DomainError("errors.notFound");
  // If the doctor's services are configured, the chosen one must be among them.
  if (doctor.services.length && !doctor.services.some((x) => x.serviceId === s.id)) throw new DomainError("errors.serviceNotProvided");
  return s;
}

function translateConflict(e: unknown): never {
  // 23P01 = exclusion_violation (Appointment_no_overlap)
  const code = (e as { code?: string; meta?: { code?: string } })?.meta?.code ?? (e as { code?: string })?.code;
  if (code === "23P01" || (e instanceof Error && /Appointment_no_overlap|23P01|exclusion/i.test(e.message))) throw new DomainError("errors.slotTaken");
  throw e;
}

export const bookingSchema = z.object({
  patientId: uuid,
  doctorProfileId: uuid,
  startsAt: z.iso.datetime({ offset: true }),
  serviceId: z.union([z.literal("").transform(() => undefined), uuid]).optional(),
  source: z.enum(["FRONT_DESK", "PHONE"]).default("FRONT_DESK"),
  adminNote,
});

/**
 * Books a timed appointment. The slot must lie inside one of the doctor's
 * weekly working blocks on that local date (no absence), in a branch the
 * booking user may serve. Double booking is prevented by the database.
 */
export async function bookAppointment(ctx: ClinicContext, raw: unknown, meta: RequestMeta) {
  requirePermission(ctx, "appointments.manage");
  const input = bookingSchema.parse(raw);
  const startsAt = new Date(input.startsAt);
  if (startsAt.getTime() < Date.now() - PAST_TOLERANCE_MS) throw new DomainError("errors.slotInPast");
  const id = uuidv7();
  await inClinic(ctx, async (tx) => {
    const doctor = await loadDoctor(tx, ctx, input.doctorProfileId);
    await loadActivePatient(tx, input.patientId);
    const service = await loadService(tx, input.serviceId, doctor);
    const minutes = service?.durationMinutes ?? doctor.defaultSlotMinutes;
    const endsAt = new Date(startsAt.getTime() + minutes * 60_000);

    const tz = ctx.tenant.timezone;
    const date = instantToLocalDate(startsAt, tz);
    const absent = await tx.scheduleException.findUnique({ where: { doctorProfileId_date: { doctorProfileId: doctor.id, date: localDateToDbDate(date) } } });
    if (absent) throw new DomainError("errors.outsideSchedule");
    const blocks = await tx.workSchedule.findMany({ where: { doctorProfileId: doctor.id, weekday: isoWeekday(date) } });
    const block = blocks.find((b) => localToInstant(date, b.startMinute, tz) <= startsAt && endsAt <= localToInstant(date, b.endMinute, tz));
    if (!block) throw new DomainError("errors.outsideSchedule");
    assertBranch(ctx, block.branchId);

    await tx.appointment.create({
      data: {
        id,
        tenantId: ctx.tenant.id,
        patientId: input.patientId,
        doctorProfileId: doctor.id,
        branchId: block.branchId,
        roomId: block.roomId,
        serviceId: service?.id,
        startsAt,
        endsAt,
        source: input.source,
        adminNote: input.adminNote,
        createdById: ctx.principal.user.id,
      },
    });
    await auditClinic(tx, ctx, meta, { action: "appointment.booked", entityType: "Appointment", entityId: id, metadata: { source: input.source } });
    await notifyAppointmentBooked(tx, ctx.tenant.id, { id, patientId: input.patientId, startsAt });
  }).catch(translateConflict);
  return id;
}

export const walkInSchema = z.object({
  patientId: uuid,
  doctorProfileId: uuid,
  branchId: uuid,
  serviceId: z.union([z.literal("").transform(() => undefined), uuid]).optional(),
  adminNote,
});

/** Walk-in: joins the doctor's queue immediately (checked in) without occupying a timed slot. */
export async function registerWalkIn(ctx: ClinicContext, raw: unknown, meta: RequestMeta) {
  requirePermission(ctx, "queue.manage", "appointments.manage");
  const input = walkInSchema.parse(raw);
  assertBranch(ctx, input.branchId);
  const id = uuidv7();
  await inClinic(ctx, async (tx) => {
    const doctor = await loadDoctor(tx, ctx, input.doctorProfileId);
    await loadActivePatient(tx, input.patientId);
    const service = await loadService(tx, input.serviceId, doctor);
    const now = new Date();
    const queueNumber = await nextQueueNumber(tx, ctx, input.branchId, now);
    await tx.appointment.create({
      data: {
        id,
        tenantId: ctx.tenant.id,
        patientId: input.patientId,
        doctorProfileId: doctor.id,
        branchId: input.branchId,
        serviceId: service?.id,
        startsAt: now,
        endsAt: new Date(now.getTime() + (service?.durationMinutes ?? doctor.defaultSlotMinutes) * 60_000),
        status: "CHECKED_IN",
        source: "WALK_IN",
        adminNote: input.adminNote,
        queueNumber,
        checkedInAt: now,
        createdById: ctx.principal.user.id,
      },
    });
    await auditClinic(tx, ctx, meta, { action: "appointment.walk_in", entityType: "Appointment", entityId: id, metadata: { queueNumber } });
  });
  return id;
}

/** Daily, per-branch ticket numbers (1, 2, 3 …) in the clinic's local day. */
async function nextQueueNumber(tx: Tx, ctx: ClinicContext, branchId: string, at: Date) {
  const day = instantToLocalDate(at, ctx.tenant.timezone);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`queue:${branchId}:${day}`}, 0))`;
  const from = localToInstant(day, 0, ctx.tenant.timezone);
  const to = localToInstant(addDays(day, 1), 0, ctx.tenant.timezone);
  const agg = await tx.appointment.aggregate({ where: { branchId, checkedInAt: { gte: from, lt: to } }, _max: { queueNumber: true } });
  return (agg._max.queueNumber ?? 0) + 1;
}

async function loadAppointment(tx: Tx, ctx: ClinicContext, id: string) {
  if (!uuid.safeParse(id).success) throw new DomainError("errors.notFound");
  const a = await tx.appointment.findUnique({ where: { id } });
  if (!a) throw new DomainError("errors.notFound");
  if (!canUseBranch(ctx, a.branchId)) throw new DomainError("errors.branchScope");
  return a;
}

const TRANSITIONS: Record<"check_in" | "no_show" | "cancel", AppointmentStatus[]> = {
  check_in: ["BOOKED"],
  no_show: ["BOOKED"],
  cancel: ["BOOKED", "CHECKED_IN"],
};

export async function checkIn(ctx: ClinicContext, appointmentId: string, meta: RequestMeta) {
  requirePermission(ctx, "queue.manage", "appointments.manage");
  return inClinic(ctx, async (tx) => {
    const a = await loadAppointment(tx, ctx, appointmentId);
    if (!TRANSITIONS.check_in.includes(a.status)) throw new DomainError("errors.invalidTransition");
    const now = new Date();
    if (instantToLocalDate(a.startsAt, ctx.tenant.timezone) !== instantToLocalDate(now, ctx.tenant.timezone)) throw new DomainError("errors.notToday");
    const queueNumber = await nextQueueNumber(tx, ctx, a.branchId, now);
    await tx.appointment.update({ where: { id: a.id }, data: { status: "CHECKED_IN", checkedInAt: now, queueNumber } });
    await auditClinic(tx, ctx, meta, { action: "appointment.checked_in", entityType: "Appointment", entityId: a.id, metadata: { queueNumber } });
    return queueNumber;
  });
}

export async function markNoShow(ctx: ClinicContext, appointmentId: string, meta: RequestMeta) {
  requirePermission(ctx, "queue.manage", "appointments.manage");
  await inClinic(ctx, async (tx) => {
    const a = await loadAppointment(tx, ctx, appointmentId);
    if (!TRANSITIONS.no_show.includes(a.status)) throw new DomainError("errors.invalidTransition");
    if (a.startsAt > new Date()) throw new DomainError("errors.notYetStarted");
    await tx.appointment.update({ where: { id: a.id }, data: { status: "NO_SHOW" } });
    await auditClinic(tx, ctx, meta, { action: "appointment.no_show", entityType: "Appointment", entityId: a.id });
    await notifyNoShow(tx, ctx.tenant.id, { id: a.id, patientId: a.patientId });
  });
}

export async function cancelAppointment(ctx: ClinicContext, appointmentId: string, reason: string, meta: RequestMeta) {
  requirePermission(ctx, "appointments.manage");
  const r = z.enum(CANCELLATION_REASONS).parse(reason) as CancellationReason;
  await inClinic(ctx, async (tx) => {
    const a = await loadAppointment(tx, ctx, appointmentId);
    if (!TRANSITIONS.cancel.includes(a.status)) throw new DomainError("errors.invalidTransition");
    await tx.appointment.update({ where: { id: a.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancellationReason: r } });
    await auditClinic(tx, ctx, meta, { action: "appointment.cancelled", entityType: "Appointment", entityId: a.id, metadata: { reason: r } });
    await notifyAppointmentCancelled(tx, ctx.tenant.id, { id: a.id, patientId: a.patientId, startsAt: a.startsAt });
  });
}

export const rescheduleSchema = z.object({
  startsAt: z.iso.datetime({ offset: true }),
  doctorProfileId: z.union([z.literal("").transform(() => undefined), uuid]).optional(),
});

/**
 * Moves a booked visit to another time (and optionally another doctor) with
 * the same checks as a new booking: working hours, absences, branch scope and
 * the database's no-double-booking constraint. History stays in the audit log;
 * the patient's pending reminder follows the new time.
 */
export async function rescheduleAppointment(ctx: ClinicContext, appointmentId: string, raw: unknown, meta: RequestMeta) {
  requirePermission(ctx, "appointments.manage");
  const input = rescheduleSchema.parse(raw);
  const startsAt = new Date(input.startsAt);
  if (startsAt.getTime() < Date.now() - PAST_TOLERANCE_MS) throw new DomainError("errors.slotInPast");
  await inClinic(ctx, async (tx) => {
    const a = await loadAppointment(tx, ctx, appointmentId);
    if (a.status !== "BOOKED") throw new DomainError("errors.invalidTransition");
    const doctor = await loadDoctor(tx, ctx, input.doctorProfileId ?? a.doctorProfileId);
    if (a.serviceId && doctor.services.length && !doctor.services.some((x) => x.serviceId === a.serviceId)) throw new DomainError("errors.serviceNotProvided");
    const endsAt = new Date(startsAt.getTime() + (a.endsAt.getTime() - a.startsAt.getTime()));
    const tz = ctx.tenant.timezone;
    const date = instantToLocalDate(startsAt, tz);
    const absent = await tx.scheduleException.findUnique({ where: { doctorProfileId_date: { doctorProfileId: doctor.id, date: localDateToDbDate(date) } } });
    if (absent) throw new DomainError("errors.outsideSchedule");
    const blocks = await tx.workSchedule.findMany({ where: { doctorProfileId: doctor.id, weekday: isoWeekday(date) } });
    const block = blocks.find((b) => localToInstant(date, b.startMinute, tz) <= startsAt && endsAt <= localToInstant(date, b.endMinute, tz));
    if (!block) throw new DomainError("errors.outsideSchedule");
    assertBranch(ctx, block.branchId);
    await tx.appointment.update({
      where: { id: a.id },
      data: { startsAt, endsAt, doctorProfileId: doctor.id, branchId: block.branchId, roomId: block.roomId, rescheduledAt: new Date(), rescheduleCount: { increment: 1 } },
    });
    await auditClinic(tx, ctx, meta, {
      action: "appointment.rescheduled",
      entityType: "Appointment",
      entityId: a.id,
      metadata: { from: a.startsAt.toISOString(), to: startsAt.toISOString(), doctorChanged: doctor.id !== a.doctorProfileId },
    });
    await notifyAppointmentRescheduled(tx, ctx.tenant.id, { id: a.id, patientId: a.patientId, startsAt });
  }).catch(translateConflict);
}

const apptInclude = {
  patient: { select: { id: true, mrn: true, lastName: true, firstName: true, middleName: true, birthDate: true, birthYearOnly: true, sex: true, address: true, phone: true } },
  doctor: { select: { id: true, specialty: true, membership: { select: { user: { select: { fullName: true } } } } } },
  service: { select: { name: true } },
  branch: { select: { name: true } },
  room: { select: { name: true } },
} satisfies Prisma.AppointmentInclude;

export type AppointmentRow = Prisma.AppointmentGetPayload<{ include: typeof apptInclude }>;

/**
 * Appointments of one local day. Front-desk users see all doctors within their
 * branch scope; clinicians without `appointments.manage` see only their own.
 */
export async function listDay(ctx: ClinicContext, date: LocalDate, opts: { doctorProfileId?: string } = {}): Promise<AppointmentRow[]> {
  requirePermission(ctx, "appointments.read", "appointments.manage", "queue.manage");
  if (!isLocalDate(date)) throw new DomainError("errors.invalidInput");
  return inClinic(ctx, async (tx) => {
    const tz = ctx.tenant.timezone;
    const ownOnly = !ctx.permissions.has("appointments.manage") && !ctx.permissions.has("queue.manage");
    let doctorFilter = opts.doctorProfileId ? uuid.parse(opts.doctorProfileId) : undefined;
    if (ownOnly) {
      const own = await tx.doctorProfile.findUnique({ where: { membershipId: ctx.membershipId }, select: { id: true } });
      if (!own) return [];
      doctorFilter = own.id;
    }
    return tx.appointment.findMany({
      where: {
        startsAt: { gte: localToInstant(date, 0, tz), lt: localToInstant(addDays(date, 1), 0, tz) },
        ...(doctorFilter ? { doctorProfileId: doctorFilter } : {}),
        ...(ctx.branchIds ? { branchId: { in: ctx.branchIds } } : {}),
      },
      include: apptInclude,
      orderBy: [{ startsAt: "asc" }],
    });
  });
}

/** Busy intervals of a doctor on a date (for slot calculation). Walk-ins never block slots. */
export async function busyIntervals(tx: Tx, doctorProfileId: string, from: Date, to: Date) {
  const rows = await tx.appointment.findMany({
    where: { doctorProfileId, status: { in: ACTIVE_STATUSES.concat("COMPLETED") }, source: { not: "WALK_IN" }, startsAt: { lt: to }, endsAt: { gt: from } },
    select: { startsAt: true, endsAt: true },
  });
  return rows.map((r) => ({ start: r.startsAt, end: r.endsAt }));
}
