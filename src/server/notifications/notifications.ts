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
import { miniAppUrl, sendTelegram, telegramChatFor, telegramReady, type TgMarkup } from "./telegram";
import { sendSms, smsEnabled } from "./sms";
import { addDays, instantToLocalDate, localToInstant, parseHm, type LocalDate } from "../scheduling/time";

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

export const NOTIFICATION_KINDS = [
  "APPOINTMENT_BOOKED",
  "APPOINTMENT_REMINDER",
  "APPOINTMENT_CANCELLED",
  "RESULTS_READY",
  "DISPENSARY_REMINDER",
  "NO_SHOW_REBOOK",
  "VISIT_CHECKIN",
  "MEDICATION_REMINDER",
] as const satisfies readonly NotificationKind[];
/** Kinds that need answer buttons or are too frequent for SMS. */
const TELEGRAM_ONLY: ReadonlySet<NotificationKind> = new Set(["VISIT_CHECKIN", "MEDICATION_REMINDER"]);
/** A medicine reminder later than this after its time is not sent any more (e.g. after an outage). */
const MED_LATE_MS = 60 * 60_000;
/** Reminders for a prescription without a duration run this many days. */
export const MED_DEFAULT_DAYS = 30;
const CONSENT_FOR: Record<NotificationChannel, ConsentPurpose> = { SMS: "SMS_REMINDERS", EMAIL: "EMAIL_NOTIFICATIONS", TELEGRAM: "TELEGRAM_NOTIFICATIONS" };
const MAX_ATTEMPTS = 3;
const RETRY_MINUTES = [5, 30, 120];

export interface Settings {
  appointmentBooked: boolean;
  appointmentReminder: boolean;
  reminderHoursBefore: number;
  appointmentCancelled: boolean;
  resultsReady: boolean;
  noShowRebook: boolean;
  visitCheckIn: boolean;
  checkInDays: number;
  medicationReminders: boolean;
}
const DEFAULTS: Settings = {
  appointmentBooked: true,
  appointmentReminder: true,
  reminderHoursBefore: 24,
  appointmentCancelled: true,
  resultsReady: true,
  noShowRebook: true,
  visitCheckIn: true,
  checkInDays: 5,
  medicationReminders: true,
};

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
    NO_SHOW_REBOOK: s.noShowRebook,
    VISIT_CHECKIN: s.visitCheckIn,
    MEDICATION_REMINDER: s.medicationReminders,
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
  const channels = (await reachableChannels(tx, tenantId, e.patientId)).filter((c) => !TELEGRAM_ONLY.has(e.kind) || c.channel === "TELEGRAM");
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

/** The patient did not come: an offer to book again (skipped at send time if they already did). */
export async function notifyNoShow(tx: Tx, tenantId: string, a: { id: string; patientId: string }) {
  await enqueue(tx, tenantId, { patientId: a.patientId, kind: "NO_SHOW_REBOOK", subjectId: a.id, dueAt: new Date() });
}

/**
 * The visit is closed: "how are you feeling?" goes out at 10:00, N days later
 * (clinic setting), through Telegram only — the answer is a button press.
 * Nothing is created for a patient who cannot be asked.
 */
export async function scheduleVisitCheckIn(tx: Tx, tenantId: string, enc: { id: string; patientId: string; doctorProfileId: string; closedAt: Date }, timeZone: string) {
  const s = await settingsIn(tx, tenantId);
  if (!s.visitCheckIn) return null;
  const reachable = await reachableChannels(tx, tenantId, enc.patientId);
  if (!reachable.some((c) => c.channel === "TELEGRAM")) return null;
  if (await tx.visitCheckIn.findUnique({ where: { encounterId: enc.id }, select: { id: true } })) return null;
  const askAt = localToInstant(addDays(instantToLocalDate(enc.closedAt, timeZone), s.checkInDays), 10 * 60, timeZone);
  const id = uuidv7();
  await tx.visitCheckIn.create({ data: { id, tenantId, patientId: enc.patientId, encounterId: enc.id, doctorProfileId: enc.doctorProfileId, askAt } });
  await enqueue(tx, tenantId, { patientId: enc.patientId, kind: "VISIT_CHECKIN", subjectId: id, dueAt: askAt });
  return id;
}

// ───────────── Medicine reminders ─────────────

interface RxSchedule {
  createdAt: Date;
  durationDays: number | null;
  times: string | null;
}

/** Intake times ("08:00, 20:00") as minutes of the day. */
function intakeMinutes(times: string | null): number[] {
  return (times ?? "")
    .split(",")
    .map((x) => parseHm(x.trim()))
    .filter((m): m is number => m !== null);
}

/** Local dates on which a prescription is taken: from the day it was written, for its duration (or MED_DEFAULT_DAYS). */
function rxCovers(rx: RxSchedule, date: LocalDate, timeZone: string): boolean {
  const first = instantToLocalDate(rx.createdAt, timeZone);
  const last = addDays(first, (rx.durationDays ?? MED_DEFAULT_DAYS) - 1);
  return date >= first && date <= last;
}

/** Whether any of the prescriptions has an intake at this instant. */
export function rxDueAt(rxs: RxSchedule[], at: Date, timeZone: string): boolean {
  const date = instantToLocalDate(at, timeZone);
  return rxs.some((rx) => rx.createdAt < at && rxCovers(rx, date, timeZone) && intakeMinutes(rx.times).some((m) => localToInstant(date, m, timeZone).getTime() === at.getTime()));
}

/** Intake instants in (from, to] — one per distinct time, however many medicines share it. */
export function medicationSlots(rxs: RxSchedule[], from: Date, to: Date, timeZone: string): Date[] {
  const out = new Map<number, Date>();
  for (let d = instantToLocalDate(from, timeZone); d <= instantToLocalDate(to, timeZone); d = addDays(d, 1)) {
    for (const rx of rxs) {
      if (!rxCovers(rx, d, timeZone)) continue;
      for (const m of intakeMinutes(rx.times)) {
        const at = localToInstant(d, m, timeZone);
        if (at > from && at <= to && at > rx.createdAt) out.set(at.getTime(), at);
      }
    }
  }
  return [...out.values()].sort((a, b) => +a - +b);
}

const MED_HORIZON_MS = 26 * 60 * 60_000;

/**
 * Queues Telegram reminders for the next ~day from the intake times of active
 * prescriptions (worker, every few minutes; idempotent through the dedupe key).
 * Only patients with a linked chat, active Telegram consent and reminders not
 * stopped in the bot. The message names the time, never the medicine.
 */
export async function scheduleMedicationReminders(tenantId: string, now = new Date()): Promise<number> {
  return withAppContext({ tenantId }, async (tx) => {
    if (!(await settingsIn(tx, tenantId)).medicationReminders) return 0;
    if (await isLocalOnly(tx, tenantId)) return 0;
    if (!(await telegramReady(tx, tenantId))) return 0;
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    if (!tenant) return 0;
    const links = await tx.telegramLink.findMany({ where: { tenantId, revokedAt: null, medRemindersOff: false }, select: { patientId: true } });
    if (!links.length) return 0;
    const consented = await tx.patientConsent.findMany({
      where: { tenantId, patientId: { in: [...new Set(links.map((l) => l.patientId))] }, purpose: "TELEGRAM_NOTIFICATIONS", withdrawnAt: null },
      select: { patientId: true },
    });
    const patients = [...new Set(consented.map((c) => c.patientId))];
    if (!patients.length) return 0;
    const rxs = await tx.prescription.findMany({
      where: { tenantId, patientId: { in: patients }, status: "ACTIVE", times: { not: null }, createdAt: { gte: new Date(now.getTime() - 3651 * 86_400_000) } },
      select: { patientId: true, createdAt: true, durationDays: true, times: true },
    });
    const byPatient = new Map<string, RxSchedule[]>();
    for (const rx of rxs) byPatient.set(rx.patientId, [...(byPatient.get(rx.patientId) ?? []), rx]);
    const data = [...byPatient].flatMap(([patientId, list]) =>
      medicationSlots(list, now, new Date(now.getTime() + MED_HORIZON_MS), tenant.timezone).map((at) => ({
        id: uuidv7(),
        tenantId,
        patientId,
        channel: "TELEGRAM" as const,
        kind: "MEDICATION_REMINDER" as const,
        subjectId: patientId,
        dueAt: at,
        dedupeKey: `MEDICATION_REMINDER:${patientId}:${at.toISOString()}:TELEGRAM`,
      })),
    );
    if (!data.length) return 0;
    return (await tx.notification.createMany({ data, skipDuplicates: true })).count;
  });
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
  /** Telegram buttons (answers, open the Mini App, stop reminders). */
  markup?: TgMarkup;
}

/** Callback data of the bot buttons — ids only, never content (Telegram limit: 64 bytes). */
export const CHECKIN_CALLBACK = /^ci:([0-9a-f-]{36}):([BSW])$/;
export const MED_STOP_CALLBACK = "mr:off";
export const MED_RESUME_CALLBACK = "mr:on";

async function render(
  kind: NotificationKind,
  locale: Locale,
  v: { clinic: string; slug: string; timeZone: string; startsAt?: Date; branch?: string; branchPhone?: string | null; subjectId?: string | null; online?: boolean },
): Promise<Rendered> {
  const t = await translator(locale);
  const when = v.startsAt
    ? {
        date: new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: v.timeZone }).format(v.startsAt),
        time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: v.timeZone }).format(v.startsAt),
      }
    : { date: "", time: "" };
  const portal = `${env().APP_URL.replace(/\/$/, "")}/p/${v.slug}`;
  const values = { clinic: v.clinic, branch: v.branch ?? "", phone: v.branchPhone ?? "", ...when, link: kind === "NO_SHOW_REBOOK" ? `${portal}/book` : portal };
  const k = kind as string;
  const noContact = kind === "RESULTS_READY" || TELEGRAM_ONLY.has(kind);
  const contact = v.branchPhone && !noContact ? ` ${t("contact", { phone: v.branchPhone })}` : "";
  // The missed-visit offer links to online booking only where the portal is on.
  const online = kind === "NO_SHOW_REBOOK" && v.online ? ` ${t("NO_SHOW_REBOOK.online", values)}` : "";
  const sms = `${t(`${k}.sms` as never, values as never)}${online}${contact}`;
  const text = `${t(`${k}.body` as never, values as never)}${online}${contact}\n\n${t("footer", { clinic: v.clinic })}`;
  let markup: TgMarkup | undefined;
  if (kind === "VISIT_CHECKIN" && v.subjectId) {
    markup = { inline_keyboard: [(["B", "S", "W"] as const).map((a) => ({ text: t(`buttons.${a}`), callback_data: `ci:${v.subjectId}:${a}` }))] };
  } else if (kind === "MEDICATION_REMINDER") {
    markup = {
      inline_keyboard: [[{ text: t("buttons.medicines"), web_app: { url: `${miniAppUrl(v.slug)}?next=medicines` } }], [{ text: t("buttons.stop"), callback_data: MED_STOP_CALLBACK }]],
    };
  }
  return { sms, subject: t(`${k}.subject` as never, values as never), text, markup };
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
  let online = false;
  if (n.kind === "MEDICATION_REMINDER") {
    if (now.getTime() - n.dueAt.getTime() > MED_LATE_MS) return skip("stale");
    const link = await tx.telegramLink.findFirst({ where: { tenantId, patientId: n.patientId, revokedAt: null }, orderBy: { linkedAt: "desc" }, select: { medRemindersOff: true } });
    if (!link || link.medRemindersOff) return skip("opted_out");
    if (!(await settingsIn(tx, tenantId)).medicationReminders) return skip("disabled");
    // Still prescribed at this time? (cancelled or finished prescriptions stop their reminders)
    const rxs = await tx.prescription.findMany({ where: { tenantId, patientId: n.patientId, status: "ACTIVE", times: { not: null } }, select: { createdAt: true, durationDays: true, times: true } });
    if (!rxDueAt(rxs, n.dueAt, tenant.timezone)) return skip("stale");
    startsAt = n.dueAt; // only its time is shown
  } else if (n.kind === "VISIT_CHECKIN") {
    const c = n.subjectId ? await tx.visitCheckIn.findUnique({ where: { id: n.subjectId }, select: { answer: true, askAt: true } }) : null;
    if (!c) return skip("subject_missing");
    if (c.answer || now.getTime() - c.askAt.getTime() > 3 * 86_400_000) return skip("stale");
  } else if (n.kind === "NO_SHOW_REBOOK") {
    const a = n.subjectId ? await tx.appointment.findUnique({ where: { id: n.subjectId }, select: { status: true, startsAt: true, branch: { select: { name: true, phone: true } } } }) : null;
    if (!a) return skip("subject_missing");
    if (a.status !== "NO_SHOW" || now.getTime() - a.startsAt.getTime() > 3 * 86_400_000) return skip("stale");
    // Already booked again (desk or online): no offer needed.
    const again = await tx.appointment.count({ where: { tenantId, patientId: n.patientId, status: { in: ["BOOKED", "CHECKED_IN"] }, startsAt: { gte: now } } });
    if (again > 0) return skip("rebooked");
    const portal = await tx.tenantModule.findUnique({ where: { tenantId_moduleKey: { tenantId, moduleKey: "patient_portal" } }, select: { enabled: true } });
    online = Boolean(portal?.enabled);
    startsAt = a.startsAt;
    branch = a.branch;
  } else if (n.kind === "DISPENSARY_REMINDER") {
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
  const msg = await render(n.kind, locale, { clinic: tenant.name, slug: tenant.slug, timeZone: tenant.timezone, startsAt, branch: branch?.name, branchPhone: branch?.phone, subjectId: n.subjectId, online });

  let delivered = false;
  let transport: string | null = null;
  if (n.channel === "SMS") {
    const r = await sendSms(to, msg.sms);
    delivered = r.delivered;
    transport = r.transport;
  } else {
    const r = await sendTelegram(tx, tenantId, chat!, msg.sms, msg.markup);
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
  noShowRebook: z.boolean().default(DEFAULTS.noShowRebook),
  visitCheckIn: z.boolean().default(DEFAULTS.visitCheckIn),
  checkInDays: z.coerce.number().int("validation.invalid").min(1, "validation.range").max(30, "validation.range").default(DEFAULTS.checkInDays),
  medicationReminders: z.boolean().default(DEFAULTS.medicationReminders),
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
  await scheduleMedicationReminders(ctx.tenant.id);
  const r = await processDueNotifications(ctx.tenant.id);
  await inClinic(ctx, (tx) => auditClinic(tx, ctx, meta, { action: "notifications.dispatched", entityType: "Tenant", entityId: ctx.tenant.id, metadata: { sent: r.sent, failed: r.failed, skipped: r.skipped } }));
  return r;
}
