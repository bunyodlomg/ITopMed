import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { inClinic, requirePermission } from "../clinic/context";
import { isLocalOnly } from "../clinic/data-mode";
import { withAppContext, withPortal, type Tx } from "../db";
import { env, telegramTransport } from "../env";
import { DomainError } from "../errors";
import type { PatientPrincipal } from "../portal/auth";
import { decryptField, hashIp, randomToken, sha256Hex, uuidv7 } from "../security/crypto";
import { rateLimit } from "../security/rate-limit";
import { mailboxRoot } from "../local/paths";

/**
 * Telegram notifications through the CLINIC's own bot (created by the clinic
 * with @BotFather — the official Bot API, https://core.telegram.org/bots/api).
 *
 *  - ITop Med creates the bot and the SuperAdmin connects it in the console
 *    (src/server/telegram/clinic-bot.ts); the token is AES-GCM encrypted and never shown again.
 *  - A patient connects from the portal: a one-time deep link (t.me/<bot>?start=<code>)
 *    opens the bot; the worker reads "/start <code>" and links that chat to the patient.
 *    Connecting records the patient's TELEGRAM_NOTIFICATIONS consent; disconnecting withdraws it.
 *  - Messages carry no clinical content (same texts as SMS).
 *
 * Transports: "api" (real), "dev-outbox" (SIMULATED: files in .dev-mailbox/telegram), "none".
 */

const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const CODE_TTL_MS = 15 * 60_000;
export const ctxKey = (tenantId: string) => `telegram:${tenantId}`;
/** The clinic bot's Mini App (menu button, /start reply). */
export const miniAppUrl = (slug: string) => new URL(`/tg/${slug}`, env().APP_URL).toString();

export async function api<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) throw new Error(`telegram_${method}_failed`);
  return json.result as T;
}

async function writeOutbox(name: string, text: string) {
  const dir = path.join(mailboxRoot(), "telegram");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${name}.txt`), `SIMULATED TELEGRAM (dev-outbox transport)\n\n${text}\n`, "utf8");
}

/**
 * One message from a given bot to a Telegram chat, with an optional link button.
 * Honours the transport (dev-outbox writes a file). Never throws.
 */
export async function sendBotMessage(token: string, chatId: bigint, text: string, button?: { text: string; url: string }): Promise<boolean> {
  const mode = telegramTransport();
  if (mode === "none") return false;
  try {
    if (mode === "dev-outbox") {
      await writeOutbox(`chat-${chatId}`, button ? `${text}\n\n[${button.text}] ${button.url}` : text);
      return true;
    }
    await api(token, "sendMessage", {
      chat_id: chatId.toString(),
      text,
      ...(button ? { reply_markup: { inline_keyboard: [[{ text: button.text, url: button.url }]] } } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

export function telegramEnabled() {
  return telegramTransport() !== "none";
}

// ───────────── Clinic: connect the bot ─────────────

export const botTokenSchema = z.string().trim().regex(TOKEN_RE, "validation.telegramToken");

export async function telegramStatus(ctx: ClinicContext) {
  requirePermission(ctx, "clinic.settings.read");
  return inClinic(ctx, async (tx) => {
    const bot = await tx.telegramBot.findUnique({ where: { tenantId: ctx.tenant.id }, select: { username: true, enabled: true, connectedAt: true } });
    const linked = await tx.telegramLink.count({ where: { tenantId: ctx.tenant.id, revokedAt: null } });
    return { transport: telegramTransport(), bot, linkedPatients: linked };
  });
}

// ───────────── Patient: connect / disconnect ─────────────

export async function myTelegram(p: PatientPrincipal) {
  return withPortal({ sessionId: p.sessionId }, async (tx) => {
    const bot = (await tx.$queryRaw<{ username: string | null }[]>`SELECT portal_telegram_bot() AS username`)[0]?.username ?? null;
    const link = await tx.telegramLink.findFirst({ where: { revokedAt: null }, select: { id: true, linkedAt: true } });
    return { bot, linked: link ? { id: link.id, linkedAt: link.linkedAt } : null };
  });
}

/** One-time deep link to the clinic's bot. Clicking "connect" is the patient's consent to Telegram messages. */
export async function createTelegramLink(p: PatientPrincipal, meta: RequestMeta): Promise<string> {
  if (!(await rateLimit(`tglink:${p.accountId}`, 10, 60 * 60_000))) throw new DomainError("errors.rateLimited");
  const code = randomToken(16);
  return withPortal({ sessionId: p.sessionId }, async (tx) => {
    const bot = (await tx.$queryRaw<{ username: string | null }[]>`SELECT portal_telegram_bot() AS username`)[0]?.username;
    if (!bot) throw new DomainError("errors.telegramOff");
    await tx.telegramLinkCode.createMany({ data: [{ codeHash: sha256Hex(code), tenantId: p.tenant.id, patientId: p.patientId, expiresAt: new Date(Date.now() + CODE_TTL_MS) }] });
    const active = await tx.patientConsent.findFirst({ where: { purpose: "TELEGRAM_NOTIFICATIONS", withdrawnAt: null }, select: { id: true } });
    if (!active) {
      const id = uuidv7();
      await tx.patientConsent.createMany({ data: [{ id, tenantId: p.tenant.id, patientId: p.patientId, purpose: "TELEGRAM_NOTIFICATIONS", method: "PORTAL", recordedById: p.accountId }] });
      await recordAudit(tx, { tenantId: p.tenant.id, actorType: "PATIENT", actorId: p.accountId, action: "portal.consent_granted", entityType: "PatientConsent", entityId: id, ipHash: hashIp(meta.ip), metadata: { purpose: "TELEGRAM_NOTIFICATIONS" } });
    }
    return `https://t.me/${bot}?start=${code}`;
  });
}

export async function disconnectMyTelegram(p: PatientPrincipal, meta: RequestMeta) {
  await withPortal({ sessionId: p.sessionId }, async (tx) => {
    const now = new Date();
    await tx.telegramLink.updateMany({ where: { revokedAt: null }, data: { revokedAt: now } });
    await tx.patientConsent.updateMany({ where: { purpose: "TELEGRAM_NOTIFICATIONS", withdrawnAt: null }, data: { withdrawnAt: now } });
    await recordAudit(tx, { tenantId: p.tenant.id, actorType: "PATIENT", actorId: p.accountId, action: "portal.telegram_disconnected", ipHash: hashIp(meta.ip) });
  });
}

// ───────────── Worker: link chats, deliver messages ─────────────

/** "/start <code>" from a chat: links it to the patient who created the code. Returns true when linked. */
export async function handleTelegramStart(tenantId: string, code: string, chatId: bigint): Promise<boolean> {
  if (!/^[a-z2-7]{20,40}$/.test(code)) return false;
  return withAppContext({ tenantId }, async (tx) => {
    const c = await tx.telegramLinkCode.findUnique({ where: { codeHash: sha256Hex(code) } });
    if (!c || c.usedAt || c.expiresAt <= new Date()) return false;
    const used = await tx.telegramLinkCode.updateMany({ where: { codeHash: c.codeHash, usedAt: null }, data: { usedAt: new Date() } });
    if (used.count !== 1) return false;
    await tx.telegramLink.updateMany({ where: { patientId: c.patientId, revokedAt: null }, data: { revokedAt: new Date() } });
    const id = uuidv7();
    await tx.telegramLink.create({ data: { id, tenantId, patientId: c.patientId, chatId } });
    await recordAudit(tx, { tenantId, actorType: "SYSTEM", action: "telegram.patient_linked", entityType: "TelegramLink", entityId: id });
    return true;
  });
}

async function botToken(tx: Tx, tenantId: string): Promise<string | null> {
  const bot = await tx.telegramBot.findUnique({ where: { tenantId }, select: { tokenEnc: true, enabled: true } });
  return bot?.enabled ? decryptField(bot.tokenEnc, ctxKey(tenantId)) : null;
}

/** Inline keyboard of a bot message: links, Mini App buttons, answer buttons (callback data = ids only). */
export type TgButton = { text: string; url: string } | { text: string; web_app: { url: string } } | { text: string; callback_data: string };
export interface TgMarkup {
  inline_keyboard: TgButton[][];
}

function outboxText(text: string, markup?: TgMarkup) {
  if (!markup) return text;
  const buttons = markup.inline_keyboard.flat().map((b) => `[${b.text}] ${"url" in b ? b.url : "web_app" in b ? b.web_app.url : `callback:${b.callback_data}`}`);
  return `${text}\n\n${buttons.join("\n")}`;
}

/**
 * A Bot API call of the clinic's bot that honours the transport: the API for
 * real, a file in .dev-mailbox/telegram for "dev-outbox" (SIMULATED; only
 * messages are written), nothing for "none". Never throws.
 */
export async function botCall(token: string, method: string, body: Record<string, unknown>): Promise<boolean> {
  const mode = telegramTransport();
  if (mode === "none") return false;
  try {
    if (mode === "dev-outbox") {
      if (method === "sendMessage") await writeOutbox(`chat-${String(body.chat_id)}`, outboxText(String(body.text ?? ""), body.reply_markup as TgMarkup | undefined));
      return true;
    }
    await api(token, method, body);
    return true;
  } catch {
    return false;
  }
}

/** The clinic's bot for handling updates: token, workspace address and polling offset (null when off or local-only). */
export async function clinicBotState(tenantId: string): Promise<{ token: string; slug: string; offset: bigint; locale: string } | null> {
  return withAppContext({ tenantId }, async (tx) => {
    if (await isLocalOnly(tx, tenantId)) return null; // local-only clinic: no internet calls
    const b = await tx.telegramBot.findUnique({ where: { tenantId }, select: { tokenEnc: true, enabled: true, updateOffset: true } });
    const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { slug: true, defaultLocale: true } });
    return b?.enabled && t ? { token: decryptField(b.tokenEnc, ctxKey(tenantId)), offset: b.updateOffset, slug: t.slug, locale: t.defaultLocale } : null;
  });
}

/** Active chat of a patient (for the dispatcher). */
export async function telegramChatFor(tx: Tx, tenantId: string, patientId: string): Promise<bigint | null> {
  const l = await tx.telegramLink.findFirst({ where: { tenantId, patientId, revokedAt: null }, orderBy: { linkedAt: "desc" }, select: { chatId: true } });
  return l?.chatId ?? null;
}

export async function telegramReady(tx: Tx, tenantId: string): Promise<boolean> {
  if (!telegramEnabled()) return false;
  const b = await tx.telegramBot.findUnique({ where: { tenantId }, select: { enabled: true } });
  return Boolean(b?.enabled);
}

export async function sendTelegram(tx: Tx, tenantId: string, chatId: bigint, text: string, markup?: TgMarkup): Promise<{ delivered: boolean; transport: string | null }> {
  const mode = telegramTransport();
  if (mode === "none") return { delivered: false, transport: null };
  if (mode === "dev-outbox") {
    try {
      await writeOutbox(`chat-${chatId}`, outboxText(text, markup));
      return { delivered: true, transport: "telegram-dev-outbox" };
    } catch {
      return { delivered: false, transport: "telegram-dev-outbox" };
    }
  }
  const token = await botToken(tx, tenantId);
  if (!token) return { delivered: false, transport: "telegram" };
  try {
    await api(token, "sendMessage", { chat_id: chatId.toString(), text, ...(markup ? { reply_markup: markup } : {}) });
    return { delivered: true, transport: "telegram" };
  } catch {
    return { delivered: false, transport: "telegram" };
  }
}
