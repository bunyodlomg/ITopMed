import "server-only";
import { z } from "zod";
import { Prisma, type ScheduleExceptionKind } from "@/generated/prisma/client";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import type { Tx } from "../db";
import { blocksOverlap, daySlots } from "../scheduling/availability";
import { SPECIALTIES } from "../scheduling/specialties";
import { addDays, dbDateToLocalDate, isLocalDate, isoWeekday, localDateToDbDate, localToInstant, parseHm, todayIn, type LocalDate } from "../scheduling/time";
import { busyIntervals } from "../appointments/appointments";
import { uuidv7 } from "../security/crypto";
import { DomainError } from "../tenancy/provisioning";
import { assertBranch, auditClinic, canUseBranch, inClinic, requirePermission } from "./context";
import { sequential } from "../db";

export const DOCTOR_ROLE_KEYS = ["doctor", "head_doctor"] as const;
export const EXCEPTION_KINDS = ["DAY_OFF", "VACATION", "TRAINING", "OTHER_ABSENCE"] as const;

const uuid = z.uuid();
const optionalUuid = z.union([z.literal("").transform(() => undefined), uuid]).optional();

function canReadSchedules(ctx: ClinicContext) {
  return ["schedules.read", "schedules.manage", "staff.read"].some((p) => ctx.permissions.has(p as never));
}

/** Clinic members holding a doctor role, with their profile (if created). */
export async function listDoctors(ctx: ClinicContext) {
  if (!canReadSchedules(ctx)) throw new DomainError("errors.forbidden");
  return inClinic(ctx, async (tx) => {
    const members = await tx.membership.findMany({
      where: { tenantId: ctx.tenant.id, status: "ACTIVE", roles: { some: { role: { key: { in: [...DOCTOR_ROLE_KEYS] } } } } },
      include: {
        user: { select: { fullName: true } },
        doctorProfile: { include: { department: { select: { name: true } }, schedules: { select: { branchId: true, startMinute: true, endMinute: true } } } },
      },
      orderBy: { createdAt: "asc" },
    });
    return members.map((m) => ({
      membershipId: m.id,
      fullName: m.user.fullName,
      profile: m.doctorProfile,
      weeklyMinutes: (m.doctorProfile?.schedules ?? []).filter((s) => canUseBranch(ctx, s.branchId)).reduce((n, s) => n + s.endMinute - s.startMinute, 0),
    }));
  });
}

async function loadProfile(tx: Tx, ctx: ClinicContext, profileId: string) {
  if (!uuid.safeParse(profileId).success) throw new DomainError("errors.notFound");
  const p = await tx.doctorProfile.findUnique({ where: { id: profileId }, include: { membership: { include: { user: { select: { fullName: true } } } } } });
  if (!p || p.membership.tenantId !== ctx.tenant.id) throw new DomainError("errors.notFound");
  return p;
}

function isOwnProfile(ctx: ClinicContext, p: { membershipId: string }) {
  return p.membershipId === ctx.membershipId;
}

/** Full schedule view of one doctor. Doctors may always see their own. */
export async function getDoctorDetail(ctx: ClinicContext, profileId: string) {
  return inClinic(ctx, async (tx) => {
    const p = await loadProfile(tx, ctx, profileId);
    if (!isOwnProfile(ctx, p) && !canReadSchedules(ctx)) throw new DomainError("errors.forbidden");
    const [schedules, exceptions, services] = await sequential([
      tx.workSchedule.findMany({ where: { doctorProfileId: p.id }, include: { branch: { select: { name: true } }, room: { select: { name: true } } }, orderBy: [{ weekday: "asc" }, { startMinute: "asc" }] }),
      tx.scheduleException.findMany({ where: { doctorProfileId: p.id, date: { gte: localDateToDbDate(todayIn(ctx.tenant.timezone)) } }, orderBy: { date: "asc" }, take: 60 }),
      tx.doctorService.findMany({ where: { doctorProfileId: p.id }, select: { serviceId: true } }),
    ]);
    return {
      profile: p,
      fullName: p.membership.user.fullName,
      schedules: schedules.filter((s) => isOwnProfile(ctx, p) || canUseBranch(ctx, s.branchId)),
      exceptions: exceptions.map((e) => ({ ...e, localDate: dbDateToLocalDate(e.date) })),
      serviceIds: services.map((s) => s.serviceId),
    };
  });
}

export async function getMyDoctorProfileId(ctx: ClinicContext): Promise<string | null> {
  return inClinic(ctx, async (tx) => (await tx.doctorProfile.findUnique({ where: { membershipId: ctx.membershipId }, select: { id: true } }))?.id ?? null);
}

export const doctorProfileSchema = z.object({
  specialty: z.enum(SPECIALTIES),
  departmentId: optionalUuid,
  licenseNumber: z
    .string()
    .trim()
    .max(64, "validation.tooLong")
    .transform((v) => (v === "" ? undefined : v))
    .optional(),
  defaultSlotMinutes: z.coerce.number().int().min(5, "validation.slotRange").max(240, "validation.slotRange"),
  /** Free minutes after each appointment; an empty field means none. */
  bufferMinutes: z.union([z.literal("").transform(() => 0), z.coerce.number().int().min(0, "validation.bufferRange").max(30, "validation.bufferRange")]).default(0),
  acceptsOnlineBooking: z.boolean(),
  /** Printed on conclusions for patients' questions. */
  contactPhone: z
    .string()
    .trim()
    .max(32, "validation.tooLong")
    .refine((v) => v === "" || /^\+?[\d\s()-]{7,32}$/.test(v), "validation.phone")
    .transform((v) => (v === "" ? undefined : v))
    .optional(),
  contactTelegram: z
    .string()
    .trim()
    .transform((v) => v.replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, ""))
    .refine((v) => v === "" || /^[A-Za-z0-9_]{5,32}$/.test(v), "validation.telegram")
    .transform((v) => (v === "" ? undefined : `@${v}`))
    .optional(),
});

/** Creates or updates the practitioner profile of a member who holds a doctor role. */
export async function saveDoctorProfile(ctx: ClinicContext, membershipId: string, raw: unknown, meta: RequestMeta) {
  requirePermission(ctx, "staff.manage");
  const input = doctorProfileSchema.parse(raw);
  if (!uuid.safeParse(membershipId).success) throw new DomainError("errors.notFound");
  return inClinic(ctx, async (tx) => {
    const m = await tx.membership.findFirst({
      where: { id: membershipId, tenantId: ctx.tenant.id, status: "ACTIVE" },
      include: { roles: { include: { role: { select: { key: true } } } }, doctorProfile: true },
    });
    if (!m) throw new DomainError("errors.notFound");
    if (!m.roles.some((r) => (DOCTOR_ROLE_KEYS as readonly string[]).includes(r.role.key))) throw new DomainError("errors.notADoctor");
    const id = m.doctorProfile?.id ?? uuidv7();
    if (m.doctorProfile) await tx.doctorProfile.update({ where: { id }, data: { ...input, departmentId: input.departmentId ?? null, licenseNumber: input.licenseNumber ?? null, contactPhone: input.contactPhone ?? null, contactTelegram: input.contactTelegram ?? null } });
    else await tx.doctorProfile.create({ data: { id, tenantId: ctx.tenant.id, membershipId: m.id, ...input } });
    await auditClinic(tx, ctx, meta, { action: m.doctorProfile ? "doctor_profile.updated" : "doctor_profile.created", entityType: "DoctorProfile", entityId: id, metadata: { specialty: input.specialty } });
    return id;
  });
}

export async function setDoctorServices(ctx: ClinicContext, profileId: string, serviceIds: string[], meta: RequestMeta) {
  requirePermission(ctx, "staff.manage", "services.manage");
  const ids = z.array(uuid).max(500).parse([...new Set(serviceIds)]);
  await inClinic(ctx, async (tx) => {
    const p = await loadProfile(tx, ctx, profileId);
    const found = await tx.service.count({ where: { id: { in: ids }, archivedAt: null } });
    if (found !== ids.length) throw new DomainError("errors.invalidInput");
    await tx.doctorService.deleteMany({ where: { doctorProfileId: p.id } });
    if (ids.length) await tx.doctorService.createMany({ data: ids.map((serviceId) => ({ tenantId: ctx.tenant.id, doctorProfileId: p.id, serviceId })) });
    await auditClinic(tx, ctx, meta, { action: "doctor_services.updated", entityType: "DoctorProfile", entityId: p.id, metadata: { serviceCount: ids.length } });
  });
}

export const scheduleBlockSchema = z
  .object({
    weekday: z.coerce.number().int().min(1).max(7),
    start: z.string(),
    end: z.string(),
    branchId: uuid,
    roomId: optionalUuid,
  })
  .transform((v, c) => {
    const startMinute = parseHm(v.start);
    const endMinute = parseHm(v.end);
    if (startMinute === null) c.addIssue({ code: "custom", message: "validation.time", path: ["start"] });
    if (endMinute === null) c.addIssue({ code: "custom", message: "validation.time", path: ["end"] });
    if (startMinute !== null && endMinute !== null && startMinute >= endMinute) c.addIssue({ code: "custom", message: "validation.timeOrder", path: ["end"] });
    if (startMinute === null || endMinute === null || startMinute >= endMinute) return z.NEVER;
    return { weekday: v.weekday, startMinute, endMinute, branchId: v.branchId, roomId: v.roomId };
  });

/** Adds a weekly working block. A doctor cannot be in two places at once (any branch). */
export async function addScheduleBlock(ctx: ClinicContext, profileId: string, raw: unknown, meta: RequestMeta) {
  requirePermission(ctx, "schedules.manage");
  const input = scheduleBlockSchema.parse(raw);
  assertBranch(ctx, input.branchId);
  const id = uuidv7();
  await inClinic(ctx, async (tx) => {
    const p = await loadProfile(tx, ctx, profileId);
    if (p.archivedAt) throw new DomainError("errors.notFound");
    const branch = await tx.branch.findFirst({ where: { id: input.branchId, archivedAt: null } });
    if (!branch) throw new DomainError("errors.notFound");
    if (input.roomId) {
      const room = await tx.room.findFirst({ where: { id: input.roomId, branchId: input.branchId, archivedAt: null } });
      if (!room) throw new DomainError("errors.roomNotInBranch");
    }
    // Serialise concurrent edits of the same doctor's schedule.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"schedule:" + p.id}, 0))`;
    const existing = await tx.workSchedule.findMany({ where: { doctorProfileId: p.id, weekday: input.weekday } });
    if (existing.some((b) => blocksOverlap(b, input))) throw new DomainError("errors.scheduleOverlap");
    await tx.workSchedule.create({ data: { id, tenantId: ctx.tenant.id, doctorProfileId: p.id, ...input } });
    await auditClinic(tx, ctx, meta, { action: "schedule.block_added", entityType: "DoctorProfile", entityId: p.id, metadata: { weekday: input.weekday, startMinute: input.startMinute, endMinute: input.endMinute } });
  });
  return id;
}

export async function removeScheduleBlock(ctx: ClinicContext, blockId: string, meta: RequestMeta) {
  requirePermission(ctx, "schedules.manage");
  await inClinic(ctx, async (tx) => {
    const b = await tx.workSchedule.findUnique({ where: { id: uuid.parse(blockId) } });
    if (!b) throw new DomainError("errors.notFound");
    assertBranch(ctx, b.branchId);
    await tx.workSchedule.delete({ where: { id: b.id } });
    await auditClinic(tx, ctx, meta, { action: "schedule.block_removed", entityType: "DoctorProfile", entityId: b.doctorProfileId, metadata: { weekday: b.weekday } });
  });
}

export const exceptionSchema = z.object({
  date: z.string().refine(isLocalDate, "validation.date"),
  kind: z.enum(EXCEPTION_KINDS),
});

export async function addScheduleException(ctx: ClinicContext, profileId: string, raw: unknown, meta: RequestMeta) {
  requirePermission(ctx, "schedules.manage");
  const input = exceptionSchema.parse(raw);
  await inClinic(ctx, async (tx) => {
    const p = await loadProfile(tx, ctx, profileId);
    try {
      await tx.scheduleException.create({ data: { id: uuidv7(), tenantId: ctx.tenant.id, doctorProfileId: p.id, date: localDateToDbDate(input.date), kind: input.kind as ScheduleExceptionKind } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new DomainError("errors.exceptionExists");
      throw e;
    }
    await auditClinic(tx, ctx, meta, { action: "schedule.exception_added", entityType: "DoctorProfile", entityId: p.id, metadata: { date: input.date, kind: input.kind } });
  });
}

export async function removeScheduleException(ctx: ClinicContext, exceptionId: string, meta: RequestMeta) {
  requirePermission(ctx, "schedules.manage");
  await inClinic(ctx, async (tx) => {
    const e = await tx.scheduleException.findUnique({ where: { id: uuid.parse(exceptionId) } });
    if (!e) throw new DomainError("errors.notFound");
    await tx.scheduleException.delete({ where: { id: e.id } });
    await auditClinic(tx, ctx, meta, { action: "schedule.exception_removed", entityType: "DoctorProfile", entityId: e.doctorProfileId });
  });
}

export interface WorkingDoctor {
  profileId: string;
  fullName: string;
  specialty: string;
  blocks: { startMinute: number; endMinute: number; branchName: string; roomName: string | null }[];
}

/** Who works on a local date (within the caller's branch scope), with hours. Front-desk view. */
export async function doctorsWorkingOn(ctx: ClinicContext, date: LocalDate): Promise<WorkingDoctor[]> {
  if (!canReadSchedules(ctx)) throw new DomainError("errors.forbidden");
  if (!isLocalDate(date)) throw new DomainError("errors.invalidInput");
  const weekday = isoWeekday(date);
  return inClinic(ctx, async (tx) => {
    const blocks = await tx.workSchedule.findMany({
      where: { weekday, ...(ctx.branchIds ? { branchId: { in: ctx.branchIds } } : {}), doctor: { archivedAt: null, membership: { status: "ACTIVE" }, exceptions: { none: { date: localDateToDbDate(date) } } } },
      include: { branch: { select: { name: true } }, room: { select: { name: true } }, doctor: { include: { membership: { include: { user: { select: { fullName: true } } } } } } },
      orderBy: { startMinute: "asc" },
    });
    const byDoctor = new Map<string, WorkingDoctor>();
    for (const b of blocks) {
      const d = byDoctor.get(b.doctorProfileId) ?? { profileId: b.doctorProfileId, fullName: b.doctor.membership.user.fullName, specialty: b.doctor.specialty, blocks: [] };
      d.blocks.push({ startMinute: b.startMinute, endMinute: b.endMinute, branchName: b.branch.name, roomName: b.room?.name ?? null });
      byDoctor.set(b.doctorProfileId, d);
    }
    return [...byDoctor.values()].sort((a, b) => a.blocks[0]!.startMinute - b.blocks[0]!.startMinute);
  });
}

/** Bookable slots for one doctor on one date (appointments are subtracted in Phase 6). */
export async function doctorSlots(ctx: ClinicContext, profileId: string, date: LocalDate, opts: { includePast?: boolean } = {}) {
  if (!isLocalDate(date)) throw new DomainError("errors.invalidInput");
  return inClinic(ctx, async (tx) => {
    const p = await loadProfile(tx, ctx, profileId);
    if (!isOwnProfile(ctx, p) && !canReadSchedules(ctx)) throw new DomainError("errors.forbidden");
    const [blocks, exception] = await sequential([
      tx.workSchedule.findMany({ where: { doctorProfileId: p.id, weekday: isoWeekday(date) } }),
      tx.scheduleException.findUnique({ where: { doctorProfileId_date: { doctorProfileId: p.id, date: localDateToDbDate(date) } } }),
    ]);
    const tz = ctx.tenant.timezone;
    const busy = await busyIntervals(tx, p.id, localToInstant(date, 0, tz), localToInstant(addDays(date, 1), 0, tz));
    return daySlots({
      date,
      timeZone: tz,
      blocks: blocks.filter((b) => isOwnProfile(ctx, p) || canUseBranch(ctx, b.branchId)),
      hasException: Boolean(exception),
      slotMinutes: p.defaultSlotMinutes,
      bufferMinutes: p.bufferMinutes,
      busy,
      notBefore: opts.includePast ? undefined : new Date(),
    });
  });
}
