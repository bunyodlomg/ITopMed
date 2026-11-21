import "server-only";
import { z } from "zod";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { auditClinic, inClinic, requirePermission } from "../clinic/context";
import type { Tx } from "../db";
import { DomainError } from "../errors";
import { notifyDispensaryDue } from "../notifications/notifications";
import { addDays, instantToLocalDate, isLocalDate, localDateToDbDate, type LocalDate } from "../scheduling/time";
import { uuidv7 } from "../security/crypto";
import { withRecordAccess } from "./access";

/**
 * Dispensary follow-up ("dispanser kuzatuvi"): a doctor's long-term patients
 * (hypertension, heart failure, atrial fibrillation, after a heart attack, on
 * anticoagulants …) with how often they come, when next and which tests to
 * repeat. The patient gets a reminder the day before — without any clinical
 * detail. Audit events never carry the group (it is clinical information).
 */
export const DISPENSARY_GROUPS = ["HYPERTENSION", "HEART_FAILURE", "ATRIAL_FIBRILLATION", "POST_MI", "ANTICOAGULANT", "OTHER"] as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "validation.tooLong")
    .transform((v) => (v === "" ? undefined : v))
    .optional();

export const dispensarySchema = z.object({
  group: z.enum(DISPENSARY_GROUPS),
  intervalDays: z.coerce.number().int("validation.invalid").min(7, "validation.intervalDays").max(365, "validation.intervalDays"),
  /** First follow-up date; empty = today + interval. */
  firstDue: z.union([z.literal("").transform(() => undefined), z.string().refine(isLocalDate, "validation.invalid")]).optional(),
  labs: optionalText(500),
  note: optionalText(1000),
});

const uuid = z.uuid();

function today(ctx: ClinicContext): LocalDate {
  return instantToLocalDate(new Date(), ctx.tenant.timezone);
}

async function loadPlan(ctx: ClinicContext, planId: string) {
  if (!uuid.safeParse(planId).success) throw new DomainError("errors.notFound");
  const plan = await inClinic(ctx, (tx) => tx.dispensaryPlan.findFirst({ where: { id: planId, tenantId: ctx.tenant.id } }));
  if (!plan) throw new DomainError("errors.notFound");
  return plan;
}

/** The doctor puts a patient under their follow-up (care relationship required). */
export async function enrollDispensary(ctx: ClinicContext, patientId: string, raw: unknown, meta: RequestMeta) {
  requirePermission(ctx, "emr.write");
  const input = dispensarySchema.parse(raw);
  const due = input.firstDue ?? addDays(today(ctx), input.intervalDays);
  if (due < today(ctx)) throw new DomainError("errors.dateInPast");
  return withRecordAccess(ctx, patientId, meta, { auditView: false }, async (tx, access) => {
    if (!access.doctorProfileId || access.mode === "break_glass") throw new DomainError("errors.forbidden");
    const open = await tx.dispensaryPlan.findFirst({ where: { tenantId: ctx.tenant.id, patientId, doctorProfileId: access.doctorProfileId, group: input.group, closedAt: null }, select: { id: true } });
    if (open) throw new DomainError("errors.dispensaryExists");
    const id = uuidv7();
    await tx.dispensaryPlan.create({
      data: {
        id,
        tenantId: ctx.tenant.id,
        patientId,
        doctorProfileId: access.doctorProfileId,
        group: input.group,
        intervalDays: input.intervalDays,
        nextDueDate: localDateToDbDate(due),
        labs: input.labs ?? null,
        note: input.note ?? null,
        createdById: ctx.principal.user.id,
      },
    });
    await auditClinic(tx, ctx, meta, { action: "dispensary.enrolled", entityType: "DispensaryPlan", entityId: id });
    await notifyDispensaryDue(tx, ctx.tenant.id, { id, patientId, nextDueDate: due }, ctx.tenant.timezone);
    return id;
  });
}

/** Only the responsible doctor changes a plan (the head doctor with emr.read_all too). */
async function withOwnPlan<T>(ctx: ClinicContext, planId: string, meta: RequestMeta, fn: (tx: Tx, plan: Awaited<ReturnType<typeof loadPlan>>) => Promise<T>) {
  requirePermission(ctx, "emr.write");
  const plan = await loadPlan(ctx, planId);
  if (plan.closedAt) throw new DomainError("errors.invalidTransition");
  return withRecordAccess(ctx, plan.patientId, meta, { auditView: false }, async (tx, access) => {
    if (access.doctorProfileId !== plan.doctorProfileId && access.mode !== "oversight") throw new DomainError("errors.notYourPatient");
    return fn(tx, plan);
  });
}

/** The follow-up visit took place: the next one is due one interval from today. */
export async function markFollowUpDone(ctx: ClinicContext, planId: string, meta: RequestMeta) {
  return withOwnPlan(ctx, planId, meta, async (tx, plan) => {
    const next = addDays(today(ctx), plan.intervalDays);
    const r = await tx.dispensaryPlan.updateMany({ where: { id: plan.id, closedAt: null }, data: { nextDueDate: localDateToDbDate(next), lastSeenAt: new Date() } });
    if (r.count !== 1) throw new DomainError("errors.invalidTransition");
    await auditClinic(tx, ctx, meta, { action: "dispensary.followed_up", entityType: "DispensaryPlan", entityId: plan.id });
    await notifyDispensaryDue(tx, ctx.tenant.id, { id: plan.id, patientId: plan.patientId, nextDueDate: next }, ctx.tenant.timezone);
    return next;
  });
}

/** Follow-up ends (recovered, moved, …); kept for the record, pending reminders are dropped. */
export async function closeDispensary(ctx: ClinicContext, planId: string, meta: RequestMeta) {
  return withOwnPlan(ctx, planId, meta, async (tx, plan) => {
    const r = await tx.dispensaryPlan.updateMany({ where: { id: plan.id, closedAt: null }, data: { closedAt: new Date(), closedById: ctx.principal.user.id } });
    if (r.count !== 1) throw new DomainError("errors.invalidTransition");
    await tx.notification.updateMany({ where: { tenantId: ctx.tenant.id, subjectId: plan.id, kind: "DISPENSARY_REMINDER", status: "PENDING" }, data: { status: "SKIPPED", lastError: "closed" } });
    await auditClinic(tx, ctx, meta, { action: "dispensary.closed", entityType: "DispensaryPlan", entityId: plan.id });
  });
}

/** Open plans of one patient (shown in the visit; the caller already holds record access). */
export async function patientDispensary(ctx: ClinicContext, patientId: string, meta: RequestMeta) {
  return withRecordAccess(ctx, patientId, meta, { auditView: false }, (tx) =>
    tx.dispensaryPlan.findMany({
      where: { tenantId: ctx.tenant.id, patientId, closedAt: null },
      include: { doctor: { select: { membership: { select: { user: { select: { fullName: true } } } } } } },
      orderBy: { nextDueDate: "asc" },
    }),
  );
}

/**
 * The doctor's own follow-up list, nearest due date first (the head doctor
 * with emr.read_all sees the clinic's). Viewing it is audited.
 */
export async function dispensaryWorklist(ctx: ClinicContext, meta: RequestMeta) {
  requirePermission(ctx, "emr.read");
  return inClinic(ctx, async (tx) => {
    const own = await tx.doctorProfile.findUnique({ where: { membershipId: ctx.membershipId }, select: { id: true } });
    const all = ctx.permissions.has("emr.read_all");
    if (!own && !all) return { plans: [], today: today(ctx) };
    const plans = await tx.dispensaryPlan.findMany({
      where: { tenantId: ctx.tenant.id, closedAt: null, ...(all ? {} : { doctorProfileId: own!.id }) },
      include: {
        patient: { select: { id: true, mrn: true, lastName: true, firstName: true, middleName: true, phone: true } },
        doctor: { select: { membership: { select: { user: { select: { fullName: true } } } } } },
      },
      orderBy: [{ nextDueDate: "asc" }, { createdAt: "asc" }],
      take: 1000,
    });
    await auditClinic(tx, ctx, meta, { action: "dispensary.list_viewed", entityType: "Tenant", entityId: ctx.tenant.id, metadata: { count: plans.length } });
    return { plans, today: today(ctx) };
  });
}
