import "server-only";
import { createTranslator } from "use-intl/core";
import type { CheckInAnswer } from "@/generated/prisma/client";
import { parseReadingText } from "@/lib/bp";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";
import { recordAudit } from "../audit";
import { withAppContext } from "../db";
import { saveTelegramReading } from "../emr/readings";
import { telegramTransport } from "../env";
import { logger } from "../logger";
import { CHECKIN_CALLBACK, MED_RESUME_CALLBACK, MED_STOP_CALLBACK } from "../notifications/notifications";
import { api, botCall, clinicBotState, handleTelegramStart, linkChatByPhone, miniAppUrl, type TgMarkup, type TgReplyKeyboard } from "../notifications/telegram";
import { normalizePhone } from "../patients/patients";
import { openPortalWithTelegram, saveTelegramContact } from "../portal/auth";
import { rateLimit } from "../security/rate-limit";
import { ownContact } from "./central-bot";

/**
 * Everything a clinic's bot receives from patients:
 *  - "/start": a greeting; an unknown chat is asked to share its phone, a
 *    linked one gets the menu (portal, medicines, home readings);
 *  - "/start <code>" links the chat to the patient (portal deep link);
 *  - a shared OWN contact: the phone Telegram verified. Every active patient
 *    card of this clinic with that phone gets the chat linked and its portal
 *    opened (no activation code: the clinic's decision);
 *  - from a linked chat: home blood pressure and pulse as text ("135/85 72");
 *  - button presses: the answer to "how are you feeling?" after a visit, and
 *    stopping / resuming medicine reminders.
 * The bot never echoes values or names anything clinical; who the sender is
 * comes only from the linked chat id, never from the message text.
 */

export interface TgUpdate {
  update_id: number;
  message?: {
    chat: { id: number; type?: string };
    from?: { id?: number; is_bot?: boolean };
    date?: number;
    text?: string;
    contact?: { phone_number?: string; user_id?: number };
  };
  callback_query?: {
    id: string;
    from?: { id?: number; is_bot?: boolean };
    data?: string;
    message?: { message_id: number; chat: { id: number; type?: string } };
  };
}

type BotState = NonNullable<Awaited<ReturnType<typeof clinicBotState>>>;

async function botT(locale: string | null | undefined, fallback: string) {
  const l: Locale = isLocale(locale) ? locale : isLocale(fallback) ? fallback : DEFAULT_LOCALE;
  const messages = (await import(`../../../messages/${l}.json`)).default;
  return createTranslator({ locale: l, messages, namespace: "telegramBot" });
}

/**
 * The patient behind an active link of this chat (null = not linked).
 * `shared` = the chat serves several patients (a family on one phone): then a
 * typed reading cannot be attributed and is refused.
 */
async function linkedPatient(tenantId: string, chatId: bigint) {
  return withAppContext({ tenantId }, async (tx) => {
    const links = await tx.telegramLink.findMany({ where: { tenantId, chatId, revokedAt: null }, orderBy: { linkedAt: "desc" }, select: { id: true, patientId: true, medRemindersOff: true }, take: 20 });
    const patients = links.length ? await tx.patient.findMany({ where: { id: { in: links.map((l) => l.patientId) }, status: "ACTIVE" }, select: { id: true, preferredLocale: true } }) : [];
    const link = links.find((l) => patients.some((p) => p.id === l.patientId));
    if (!link) return null;
    const p = patients.find((x) => x.id === link.patientId)!;
    return { linkId: link.id, patientId: link.patientId, locale: p.preferredLocale, medRemindersOff: link.medRemindersOff, shared: patients.length > 1 };
  });
}

const ANSWERS: Record<string, CheckInAnswer> = { B: "BETTER", S: "SAME", W: "WORSE" };

/** "How are you feeling?" answered: only from the patient's own linked chat, only once. */
export async function answerCheckIn(tenantId: string, checkInId: string, chatId: bigint, answer: CheckInAnswer): Promise<"saved" | "already" | "invalid"> {
  return withAppContext({ tenantId }, async (tx) => {
    const c = await tx.visitCheckIn.findFirst({ where: { id: checkInId, tenantId }, select: { id: true, patientId: true, answer: true } });
    if (!c) return "invalid";
    const link = await tx.telegramLink.findFirst({ where: { tenantId, patientId: c.patientId, chatId, revokedAt: null }, select: { id: true } });
    if (!link) return "invalid";
    if (c.answer) return "already";
    const r = await tx.visitCheckIn.updateMany({ where: { id: c.id, answer: null }, data: { answer, answeredAt: new Date() } });
    if (r.count !== 1) return "already";
    await recordAudit(tx, { tenantId, actorType: "SYSTEM", action: "checkin.answered", entityType: "VisitCheckIn", entityId: c.id });
    return "saved";
  });
}

/** The patient stops (or resumes) medicine reminders in this chat; pending ones are dropped. */
export async function setMedicationReminders(tenantId: string, chatId: bigint, on: boolean): Promise<boolean> {
  return withAppContext({ tenantId }, async (tx) => {
    // Every patient this chat serves (a family on one phone shares the chat).
    const links = await tx.telegramLink.findMany({ where: { tenantId, chatId, revokedAt: null }, select: { id: true, patientId: true }, take: 20 });
    if (!links.length) return false;
    await tx.telegramLink.updateMany({ where: { id: { in: links.map((l) => l.id) } }, data: { medRemindersOff: !on } });
    if (!on) {
      await tx.notification.updateMany({ where: { tenantId, patientId: { in: links.map((l) => l.patientId) }, kind: "MEDICATION_REMINDER", status: "PENDING" }, data: { status: "SKIPPED", lastError: "opted_out" } });
    }
    for (const link of links) {
      await recordAudit(tx, { tenantId, actorType: "SYSTEM", action: on ? "telegram.med_reminders_resumed" : "telegram.med_reminders_stopped", entityType: "TelegramLink", entityId: link.id });
    }
    return true;
  });
}

/**
 * Handles one update of the clinic's bot. Returns true when a chat got linked.
 * Replies go through botCall (the dev-outbox transport writes them to files).
 */
export async function handleBotUpdate(tenantId: string, u: TgUpdate, state: BotState): Promise<boolean> {
  const send = (chatId: number, text: string, markup?: TgMarkup | TgReplyKeyboard | { remove_keyboard: true }) =>
    botCall(state.token, "sendMessage", { chat_id: chatId, text, ...(markup ? { reply_markup: markup } : {}) });
  type T = Awaited<ReturnType<typeof botT>>;
  /** The menu of a linked chat: the portal and the two pages a patient uses most. */
  const menu = (t: T): TgMarkup => ({
    inline_keyboard: [
      [{ text: t("menuPortal"), web_app: { url: miniAppUrl(state.slug) } }],
      [
        { text: t("menuMedicines"), web_app: { url: `${miniAppUrl(state.slug)}?next=medicines` } },
        { text: t("menuReadings"), web_app: { url: `${miniAppUrl(state.slug)}?next=readings` } },
      ],
    ],
  });
  const askPhone = (t: T): TgReplyKeyboard => ({ keyboard: [[{ text: t("sharePhone"), request_contact: true }]], resize_keyboard: true, one_time_keyboard: true });

  const cb = u.callback_query;
  if (cb) {
    const chat = cb.message?.chat;
    if (!chat || chat.type !== "private" || cb.from?.is_bot) return false;
    const chatId = BigInt(chat.id);
    const who = await linkedPatient(tenantId, chatId);
    const t = await botT(who?.locale, state.locale);
    const data = cb.data ?? "";
    const ci = CHECKIN_CALLBACK.exec(data);
    let toast = "";
    if (ci && who) {
      const r = await answerCheckIn(tenantId, ci[1]!, chatId, ANSWERS[ci[2]!]!);
      toast = r === "saved" ? t("checkInThanks") : r === "already" ? t("checkInAlready") : "";
      if (r !== "invalid" && cb.message) await botCall(state.token, "editMessageReplyMarkup", { chat_id: chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
      if (r === "saved") await send(chat.id, t("checkInThanks"));
    } else if ((data === MED_STOP_CALLBACK || data === MED_RESUME_CALLBACK) && who) {
      const on = data === MED_RESUME_CALLBACK;
      if (await setMedicationReminders(tenantId, chatId, on)) {
        toast = on ? t("remindersResumed") : t("remindersStopped");
        await send(chat.id, toast, on ? undefined : { inline_keyboard: [[{ text: t("resume"), callback_data: MED_RESUME_CALLBACK }]] });
      }
    }
    await botCall(state.token, "answerCallbackQuery", { callback_query_id: cb.id, ...(toast ? { text: toast } : {}) });
    return false;
  }

  const msg = u.message;
  if (!msg || msg.chat.type !== "private" || msg.from?.is_bot) return false;
  const text = msg.text?.trim() ?? "";
  const start = /^\/start\s+([a-z2-7]+)$/.exec(text);
  if (start) {
    const ok = await handleTelegramStart(tenantId, start[1]!, BigInt(msg.chat.id));
    const who = ok ? await linkedPatient(tenantId, BigInt(msg.chat.id)) : null;
    const t = await botT(who?.locale, state.locale);
    await send(msg.chat.id, ok ? `✅ ${t("linked")}\n\n${t("readingHelp")}` : t("linkExpired"));
    return ok;
  }
  if (msg.contact) {
    // Shared from the chat keyboard or asked for by the Mini App: only the sender's OWN contact counts.
    const own = ownContact(u);
    const phone = own ? normalizePhone(own.phone) : null;
    const saved = own && phone ? await saveTelegramContact(own.tgId, own.phone) : false;
    if (!own || !phone || !saved) {
      const t = await botT(null, state.locale);
      await send(msg.chat.id, t("phoneNotOwn"), askPhone(t));
      return false;
    }
    const linkedCount = await linkChatByPhone(tenantId, phone, BigInt(msg.chat.id));
    await openPortalWithTelegram(own.tgId, tenantId);
    const who = linkedCount ? await linkedPatient(tenantId, BigInt(msg.chat.id)) : null;
    const t = await botT(who?.locale, state.locale);
    if (!linkedCount) {
      await send(msg.chat.id, t("phoneUnknown", { clinic: state.name }), { remove_keyboard: true });
      return false;
    }
    await send(msg.chat.id, `✅ ${t("phoneLinked", { clinic: state.name, count: linkedCount })}`, menu(t));
    return true;
  }
  if (/^\/(start|menu)(@\w+)?$/.test(text)) {
    const who = await linkedPatient(tenantId, BigInt(msg.chat.id));
    const t = await botT(who?.locale, state.locale);
    if (who) await send(msg.chat.id, `${t("welcomeBack", { clinic: state.name })}\n\n${t(who.shared ? "readingFamily" : "readingHelp")}`, menu(t));
    else await send(msg.chat.id, t("welcome", { clinic: state.name }), askPhone(t));
    return false;
  }
  // Free text from a linked chat: a home blood pressure reading, or the format hint.
  const who = await linkedPatient(tenantId, BigInt(msg.chat.id));
  if (!text) return false;
  if (!who) {
    // An unknown chat writing anything: how to start (at most twice in a few minutes).
    if (await rateLimit(`tgstart:${tenantId}:${msg.chat.id}`, 2, 10 * 60_000)) {
      const t = await botT(null, state.locale);
      await send(msg.chat.id, t("welcome", { clinic: state.name }), askPhone(t));
    }
    return false;
  }
  const t = await botT(who.locale, state.locale);
  if (who.shared) {
    // Several patients share this chat: a typed reading could land on the wrong card.
    if (await rateLimit(`tghint:${who.linkId}`, 3, 10 * 60_000)) await send(msg.chat.id, t("readingFamily"), menu(t));
    return false;
  }
  const reading = parseReadingText(text);
  if (!reading) {
    // A hint at most every few minutes, so a chatty patient is not flooded.
    if (await rateLimit(`tghint:${who.linkId}`, 3, 10 * 60_000)) await send(msg.chat.id, t("readingHelp"));
    return false;
  }
  const sentAt = msg.date ? new Date(msg.date * 1000) : new Date();
  const measuredAt = sentAt > new Date() || Date.now() - sentAt.getTime() > 7 * 86_400_000 ? new Date() : sentAt;
  const r = await saveTelegramReading(tenantId, who.patientId, reading, measuredAt);
  await send(msg.chat.id, r === "saved" ? `✅ ${t("readingSaved")}` : t("readingLimited"));
  return false;
}

/**
 * Reads new updates of the clinic's bot (API transport) and handles each.
 * Safe every pass: the offset moves past what was handled.
 */
export async function pollTelegram(tenantId: string): Promise<number> {
  if (telegramTransport() !== "api") return 0;
  const state = await clinicBotState(tenantId);
  if (!state) return 0;
  let updates: TgUpdate[];
  try {
    updates = await api(state.token, "getUpdates", { offset: Number(state.offset), timeout: 0, allowed_updates: ["message", "callback_query"] });
  } catch {
    logger.warn("telegram.poll_failed", {});
    return 0;
  }
  let linked = 0;
  for (const u of updates) {
    try {
      if (await handleBotUpdate(tenantId, u, state)) linked++;
    } catch (e) {
      logger.warn("telegram.update_failed", { error: e instanceof Error ? e.name : "unknown" });
    }
  }
  if (updates.length) {
    const next = BigInt(updates[updates.length - 1]!.update_id + 1);
    await withAppContext({ tenantId }, (tx) => tx.telegramBot.updateMany({ where: { tenantId }, data: { updateOffset: next } }));
  }
  return linked;
}
