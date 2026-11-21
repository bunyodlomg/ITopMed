import "server-only";
import { createTranslator } from "use-intl/core";
import { z } from "zod";
import type { ConsentPurpose, NotificationChannel, NotificationKind } from "@/generated/prisma/client";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { auditClinic, inClinic, requirePermission } from "../clinic/context";
import { isLocalOnly } from "../clinic/data-mode";
import { withAppContext, type Tx } from "../db";
import { env } from "../env";
import { logger } from "../logger";
import { uuidv7 } from "../security/crypto";
import { sendTelegram, telegramChatFor, telegramReady } from "./telegram";
import { sendSms, smsEnabled } from "./sms";
import { addDays, localToInstant, type LocalDate } from "../scheduling/time";

/**
 * Patient notifications through a transactional outbox.
 *
 *  - Enqueued inside the same transaction as the event (booking, cancellation,
 *    result release), only for channels the patient has consented to.
 *  - The outbox stores no text, address or clinical content. At send time the
 *    dispatcher re-checks consent, recipient and relevance (e.g. a reminder for
 *    a cancelled visit is skipped), renders the message in the patient's
 *    language and sends it.
 *  - Messages never contain clinical details: no diagnoses, no results, no
 *    doctor specialty — only clinic, date/time, branch and portal links.
 *  - Channels: Telegram (the clinic's own bot) and SMS (SIMULATED until a real
 *    provider is contracted, see ./sms.ts). There is no email channel; old
 *    EMAIL rows in the outbox are skipped.
 */

export const NOTIFICATION_KINDS = ["APPOINTMENT_BOOKED", "APPOINTMENT_REMINDER", "APPOINTMENT_CANCELLED", "RESULTS_READY", "DISPENSARY_REMINDER"] as const satisfies readonly NotificationKind[];
const CONSENT_FOR: Record<NotificationChannel, ConsentPurpose> = { SMS: "SMS_REMINDERS", EMAIL: "EMAIL_NOTIFICATIONS", TELEGRAM: "TELEGRAM_NOTIFICATIONS" };
const MAX_ATTEMPTS = 3;
const RETRY_MINUTES = [5, 30, 120];

export interface Settings {
  appointmentBooked: boolean;
  appointmentReminder: boolean;
  reminderHoursBefore: number;
  appointmentCancelled: boolean;
  resultsReady: boolean;
}
const DEFAULTS: Settings = { appointmentBooked: true, appointmentReminder: true, reminderHoursBefore: 24, appointmentCancelled: true, resultsReady: true };

async function settingsIn(tx: Tx, tenantId: string): Promise<Settings> {
  const s = await tx.notificationSettings.findUnique({ where: { tenantId } });
  return s ?? DEFAULTS;
}

function enabled(s: Settings, kind: NotificationKind) {
  return {
    APPOINTMENT_BOOKED: s.appointmentBooked,
    APPOINTMENT_REMINDER: s.appointmentReminder,
    APPOINTMENT_CANCELLED: s.appointmentCancelled,
    RESULTS_READY: s.resultsReady,
    // Follow-up reminders are reminders: the same clinic switch turns them on or off.
    DISPENSARY_REMINDER: s.appointmentReminder,
  }[kind];
}

/** Channels this patient can be reached on right now (address present + consent active + transport available). */
async function reachableChannels(tx: Tx, tenantId: string, patientId: string): Promise<{ channel: NotificationChannel; to: string }[]> {
  const p = await tx.patient.findUnique({ where: { id: patientId }, select: { phone: true, status: true } });
  if (!p || p.status !== "ACTIVE") return [];
  const consents = await tx.patientConsent.findMany({ where: { patientId, withdrawnAt: null, purpose: { in: ["SMS_REMINDERS", "TELEGRAM_NOTIFICATIONS"] } }, select: { purpose: true } });
  const has = (c: ConsentPurpose) => consents.some((x) => x.purpose === c);
  const out: { channel: NotificationChannel; to: string }[] = [];
  if (p.phone && smsEnabled() && has("SMS_REMINDERS")) out.push({ channel: "SMS", to: p.phone });
  if (has("TELEGRAM_NOTIFICATIONS") && (await telegramReady(tx, tenantId))) {
    const chat = await telegramChatFor(tx, tenantId, patientId);
    if (chat !== null) out.push({ channel: "TELEGRAM", to: chat.toString() });
  }
  return out;
}

async function enqueue(tx: Tx, tenantId: string, e: { patientId: string; kind: NotificationKind; subjectId: string; dueAt: Date; cycle?: string }) {
  const s = await settingsIn(tx, tenantId);
  if (!enabled(s, e.kind)) return 0;
  if (e.kind === "RESULTS_READY") {
    const portal = await tx.tenantModule.findUnique({ where: { tenantId_moduleKey: { tenantId, moduleKey: "patient_portal" } }, select: { enabled: true } });
    if (!portal?.enabled) return 0;
    const acc = await tx.patientAccount.findFirst({ where: { patientId: e.patientId, tenantId }, select: { status: true } });
    if (acc?.status !== "ACTIVE") return 0; // nothing to point the patient to
  }
  const channels = await reachableChannels(tx, tenantId, e.patientId);
  if (channels.length === 0) return 0;
  const r = await tx.notification.createMany({
    data: channels.map((c) => ({
      id: uuidv7(),
      tenantId,
      patientId: e.patientId,
      channel: c.channel,
      kind: e.kind,
      subjectId: e.subjectId,
      dueAt: e.dueAt,
      // A recurring subject (a follow-up plan) gets one message per cycle, e.g. per due date.
      dedupeKey: e.cycle ? `${e.kind}:${e.subjectId}:${e.cycle}:${c.channel}` : `${e.kind}:${e.subjectId}:${c.channel}`,
    })),
    skipDuplicates: true,
  });
  return r.count;
}

// ───────────── Event hooks (call inside the event's transaction) ─────────────

export async function notifyAppointmentBooked(tx: Tx, tenantId: string, a: { id: string; patientId: string; startsAt: Date }) {
  const now = new Date();
  await enqueue(tx, tenantId, { patientId: a.patientId, kind: "APPOINTMENT_BOOKED", subjectId: a.id, dueAt: now });
  const s = await settingsIn(tx, tenantId);
  const remindAt = new Date(a.startsAt.getTime() - s.reminderHoursBefore * 3_600_000);
  // Only when the reminder would still arrive meaningfully before the visit.
  if (remindAt.getTime() > now.getTime() + 30 * 60_000) {
    await enqueue(tx, tenantId, { patientId: a.patientId, kind: "APPOINTMENT_REMINDER", subjectId: a.id, dueAt: remindAt });
  }
}

/** The visit moved: the pending reminder follows the new time (or is skipped when too late now). */
export async function notifyAppointmentRescheduled(tx: Tx, tenantId: string, a: { id: string; patientId: string; startsAt: Date }) {
  const s = await settingsIn(tx, tenantId);
  const remindAt = new Date(a.startsAt.getTime() - s.reminderHoursBefore * 3_600_000);
  const inTime = remindAt.getTime() > Date.now() + 30 * 60_000;
  await tx.notification.updateMany({
    where: { tenantId, subjectId: a.id, kind: "APPOINTMENT_REMINDER", status: "PENDING" },
    data: inTime ? { dueAt: remindAt } : { status: "SKIPPED", lastError: "rescheduled" },
  });
  if (inTime) await enqueue(tx, tenantId, { patientId: a.patientId, kind: "APPOINTMENT_REMINDER", subjectId: a.id, dueAt: remindAt });
}

export async function notifyAppointmentCancelled(tx: Tx, tenantId: string, a: { id: string; patientId: string; startsAt: Date }) {
  if (a.startsAt.getTime() < Date.now()) return;
  await enqueue(tx, tenantId, { patientId: a.patientId, kind: "APPOINTMENT_CANCELLED", subjectId: a.id, dueAt: new Date() });
}

export async function notifyResultsReady(tx: Tx, tenantId: string, o: { id: string; patientId: string }) {
  await enqueue(tx, tenantId, { patientId: o.patientId, kind: "RESULTS_READY", subjectId: o.id, dueAt: new Date() });
}

/**
 * Follow-up ("dispanser") reminder at 10:00 the day before the due date (or now,
 * if that moment has passed but the due day has not begun). Earlier pending
 * reminders of the plan are dropped, so only the current due date is announced.
 */
export async function notifyDispensaryDue(tx: Tx, tenantId: string, plan: { id: string; patientId: string; nextDueDate: LocalDate }, timeZone: string) {
  await tx.notification.updateMany({ where: { tenantId, subjectId: plan.id, kind: "DISPENSARY_REMINDER", status: "PENDING" }, data: { status: "SKIPPED", lastError: "rescheduled" } });
  const now = new Date();
  const dayStart = localToInstant(plan.nextDueDate, 0, timeZone);
  if (dayStart <= now) return;
  const remindAt = localToInstant(addDays(plan.nextDueDate, -1), 10 * 60, timeZone);
  await enqueue(tx, tenantId, { patientId: plan.patientId, kind: "DISPENSARY_REMINDER", subjectId: plan.id, dueAt: remindAt > now ? remindAt : now, cycle: plan.nextDueDate });
}

// ───────────── Rendering ─────────────

async function translator(locale: Locale) {
  const messages = (await import(`../../../messages/${locale}.json`)).default;
  return createTranslator({ locale, messages, namespace: "notifications" });
}

interface Rendered {
  sms: string;
  subject: string;
  text: string;
}

async function render(
  kind: NotificationKind,
  locale: Locale,
  v: { clinic: string; slug: string; timeZone: string; startsAt?: Date; branch?: string; branchPhone?: string | null },
): Promise<Rendered> {
  const t = await translator(locale);
  const when = v.startsAt
    ? {
        date: new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: v.timeZone }).format(v.startsAt),
        time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: v.timeZone }).format(v.startsAt),
      }
    : { date: "", time: "" };
  const values = { clinic: v.clinic, branch: v.branch ?? "", phone: v.branchPhone ?? "", ...when, link: `${env().APP_URL.replace(/\/$/, "")}/p/${v.slug}` };
  const k = kind as string;
  const contact = v.branchPhone ? ` ${t("contact", { phone: v.branchPhone })}` : "";
  const sms = `${t(`${k}.sms` as never, values as never)}${kind === "RESULTS_READY" ? "" : contact}`;
  const text = `${t(`${k}.body` as never, values as never)}${kind === "RESULTS_READY" ? "" : contact}\n\n${t("footer", { clinic: v.clinic })}`;
  return { sms, subject: t(`${k}.subject` as never, values as never), text };
}

// ───────────── Dispatcher ─────────────

export interface DispatchResult {
  sent: number;
  failed: number;
  skipped: number;
  retried: number;
}

/**
 * Sends due notifications of one clinic. Each message is claimed with a row
 * lock (SKIP LOCKED) so parallel workers never send twice. Runs as the clinic
 * role with tenant context only (system job, no user).
 */
export async function processDueNotifications(tenantId: string, opts: { now?: Date; limit?: number } = {}): Promise<DispatchResult> {
  const now = opts.now ?? new Date();
  const result: DispatchResult = { sent: 0, failed: 0, skipped: 0, retried: 0 };
  const due = await withAppContext({ tenantId }, (tx) =>
    tx.notification.findMany({ where: { status: "PENDING", dueAt: { lte: now } }, select: { id: true }, orderBy: { dueAt: "asc" }, take: opts.limit ?? 100 }),
  );
  for (const { id } of due) {
    const outcome = await withAppContext({ tenantId }, (tx) => dispatchOne(tx, tenantId, id, now));
    if (outcome) result[outcome] += 1;
  }
  return result;
}

async function dispatchOne(tx: Tx, tenantId: string, id: string, now: Date): Promise<keyof DispatchResult | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Notification" WHERE id = ${id}::uuid AND status = 'PENDING' FOR UPDATE SKIP LOCKED`;
  if (!locked[0]) return null; // another worker has it, or it is done
  const n = await tx.notification.findUniqueOrThrow({ where: { id } });
  const skip = async (code: string) => {
    await tx.notification.update({ where: { id }, data: { status: "SKIPPED", lastError: code } });
    return "skipped" as const;
  };
  if (n.channel === "EMAIL") return skip("email_removed");

  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true, slug: true, timezone: true, defaultLocale: true, status: true, contactPhone: true } });
  if (!tenant || (tenant.status !== "ACTIVE" && tenant.status !== "TRIAL")) return skip("clinic_inactive");
  // Local-only clinic: nothing leaves this computer.
  if (await isLocalOnly(tx, tenantId)) return skip("local_mode");
  const patient = await tx.patient.findUnique({ where: { id: n.patientId }, select: { phone: true, preferredLocale: true, status: true } });
  if (!patient || patient.status !== "ACTIVE") return skip("patient_inactive");
  const consent = await tx.patientConsent.findFirst({ where: { patientId: n.patientId, purpose: CONSENT_FOR[n.channel], withdrawnAt: null }, select: { id: true } });
  if (!consent) return skip("no_consent");
  const chat = n.channel === "TELEGRAM" ? await telegramChatFor(tx, tenantId, n.patientId) : null;
  const to = n.channel === "SMS" ? patient.phone : chat?.toString();
  if (!to) return skip("no_address");
  if (n.channel === "SMS" && !smsEnabled()) return skip("sms_off");
  if (n.channel === "TELEGRAM" && !(await telegramReady(tx, tenantId))) return skip("telegram_off");

  let startsAt: Date | undefined;
  let branch: { name: string; phone: string | null } | undefined;
  if (n.kind === "DISPENSARY_REMINDER") {
    const plan = n.subjectId ? await tx.dispensaryPlan.findUnique({ where: { id: n.subjectId }, select: { closedAt: true, nextDueDate: true } }) : null;
    if (!plan) return skip("subject_missing");
    const due = plan.nextDueDate.toISOString().slice(0, 10);
    if (plan.closedAt || localToInstant(addDays(due, 1), 0, tenant.timezone) <= now) return skip("stale");
    startsAt = localToInstant(due, 9 * 60, tenant.timezone); // only its date is shown
    branch = { name: "", phone: tenant.contactPhone };
  } else if (n.kind !== "RESULTS_READY") {
    const a = n.subjectId ? await tx.appointment.findUnique({ where: { id: n.subjectId }, select: { status: true, startsAt: true, branch: { select: { name: true, phone: true } } } }) : null;
    if (!a) return skip("subject_missing");
    if (n.kind === "APPOINTMENT_CANCELLED" ? a.status !== "CANCELLED" : a.status !== "BOOKED") return skip("stale");
    if (n.kind === "APPOINTMENT_REMINDER" && a.startsAt <= now) return skip("stale");
    startsAt = a.startsAt;
    branch = a.branch;
  } else {
    const acc = await tx.patientAccount.findFirst({ where: { patientId: n.patientId, tenantId }, select: { status: true } });
    if (acc?.status !== "ACTIVE") return skip("portal_inactive");
  }

  const locale: Locale = isLocale(patient.preferredLocale) ? patient.preferredLocale : isLocale(tenant.defaultLocale) ? tenant.defaultLocale : DEFAULT_LOCALE;
  const msg = await render(n.kind, locale, { clinic: tenant.name, slug: tenant.slug, timeZone: tenant.timezone, startsAt, branch: branch?.name, branchPhone: branch?.phone });

  let delivered = false;
  let transport: string | null = null;
  if (n.channel === "SMS") {
    const r = await sendSms(to, msg.sms);
    delivered = r.delivered;
    transport = r.transport;
  } else {
    const r = await sendTelegram(tx, tenantId, chat!, msg.sms);
    delivered = r.delivered;
    transport = r.transport;
  }

  const attempts = n.attempts + 1;
  if (delivered) {
    await tx.notification.update({ where: { id }, data: { status: "SENT", attempts, sentAt: new Date(), transport, lastError: null } });
    return "sent";
  }
  logger.warn("notification.delivery_failed", { channel: n.channel, attempts });
  if (attempts >= MAX_ATTEMPTS) {
    await tx.notification.update({ where: { id }, data: { status: "FAILED", attempts, transport, lastError: "delivery_failed" } });
    return "failed";
  }
  await tx.notification.update({ where: { id }, data: { attempts, transport, lastError: "delivery_failed", dueAt: new Date(now.getTime() + RETRY_MINUTES[attempts - 1]! * 60_000) } });
  return "retried";
}

// ───────────── Clinic screens ─────────────

export const settingsSchema = z.object({
  appointmentBooked: z.boolean(),
  appointmentReminder: z.boolean(),
  reminderHoursBefore: z.coerce.number().int().min(1, "validation.range").max(72, "validation.range"),
  appointmentCancelled: z.boolean(),
  resultsReady: z.boolean(),
});

export async function getNotificationSettings(ctx: ClinicContext): Promise<Settings> {
  requirePermission(ctx, "clinic.settings.read");
  return inClinic(ctx, (tx) => settingsIn(tx, ctx.tenant.id));
}

export async function saveNotificationSettings(ctx: ClinicContext, raw: unknown, meta: RequestMeta) {
  requirePermission(ctx, "clinic.settings.manage");
  const input = settingsSchema.parse(raw);
  await inClinic(ctx, async (tx) => {
    await tx.notificationSettings.upsert({ where: { tenantId: ctx.tenant.id }, create: { tenantId: ctx.tenant.id, ...input, updatedById: ctx.principal.user.id }, update: { ...input, updatedById: ctx.principal.user.id } });
    await auditClinic(tx, ctx, meta, { action: "notifications.settings_saved", entityType: "Tenant", entityId: ctx.tenant.id });
  });
}

/** Delivery log (no message content exists to show). */
export async function listNotifications(ctx: ClinicContext, opts: { status?: string } = {}) {
  requirePermission(ctx, "clinic.settings.read");
  const status = z.enum(["PENDING", "SENT", "FAILED", "SKIPPED"]).safeParse(opts.status);
  return inClinic(ctx, async (tx) => {
    const [rows, counts] = [
      await tx.notification.findMany({
        where: status.success ? { status: status.data } : {},
        include: { patient: { select: { mrn: true } } },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      await tx.notification.groupBy({ by: ["status"], _count: { _all: true } }),
    ];
    return { rows, counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Partial<Record<string, number>> };
  });
}

/** "Send due now" for clinics without a running worker (and for checking delivery). */
export async function sendDueNow(ctx: ClinicContext, meta: RequestMeta) {
  requirePermission(ctx, "clinic.settings.manage");
  const r = await processDueNotifications(ctx.tenant.id);
  await inClinic(ctx, (tx) => auditClinic(tx, ctx, meta, { action: "notifications.dispatched", entityType: "Tenant", entityId: ctx.tenant.id, metadata: { sent: r.sent, failed: r.failed, skipped: r.skipped } }));
  return r;
}
