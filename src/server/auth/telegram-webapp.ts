import "server-only";
import { createHmac } from "node:crypto";
import { loginPatientWithTelegram, openPortalWithTelegram, telegramPatientAccounts } from "../portal/auth";
import { hashIp, safeEqual } from "../security/crypto";
import { rateLimit } from "../security/rate-limit";
import { clinicBot } from "../telegram/clinic-bot";
import type { RequestMeta } from "./platform-auth";

/**
 * Mini Apps of the clinics' bots (/tg/<slug>) — for PATIENTS only. Staff and
 * the console sign in with login + password; there is no Telegram sign-in for
 * them. Telegram hands the page signed launch data (initData); its HMAC is
 * checked with the bot token
 * (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
 * before the Telegram user id in it is trusted. Then the clinic's patient whose
 * Telegram-verified phone is a portal login → the portal; several → the person
 * chooses; nobody → the patient page (share phone / not registered). A patient
 * card whose phone is the Telegram-verified one opens its portal on the way.
 */

/** A Telegram user id: positive integer, at most 2^52 (Telegram's documented range). */
function parseTelegramId(v: unknown): bigint | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,16}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? BigInt(n) : null;
}

/** Launch data older than this is refused (Telegram re-signs it at every launch). */
const MAX_AGE_S = 24 * 60 * 60;

export function verifyInitData(initData: string, botToken: string, nowS = Math.floor(Date.now() / 1000)): bigint | null {
  if (!initData || initData.length > 8192) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  const pairs: string[] = [];
  for (const [k, v] of params) if (k !== "hash") pairs.push(`${k}=${v}`);
  pairs.sort();
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
  if (!safeEqual(expected, hash)) return null;
  const authDate = Number(params.get("auth_date"));
  if (!Number.isInteger(authDate) || authDate > nowS + 60 || nowS - authDate > MAX_AGE_S) return null;
  try {
    const user = JSON.parse(params.get("user") ?? "null") as { id?: unknown; is_bot?: unknown } | null;
    if (!user || user.is_bot === true) return null;
    return parseTelegramId(user.id);
  } catch {
    return null;
  }
}

export interface Choice {
  /** "patient:<accountId>" */
  key: string;
  kind: "patient";
  clinic: string | null;
  patient: string;
}

export type WebAppResult =
  | { status: "signed_in"; target: "patient"; token: string; locale: string | null; go: string }
  | { status: "choose"; choices: Choice[] }
  | { status: "patient"; phoneKnown: boolean }
  | { status: "error"; reason: "invalid" | "disabled" | "locked" | "rate_limited" };

/**
 * Resolves a Mini App launch of a clinic's bot (`slug`). Only that clinic's
 * patients count. `choice` must be one of the keys offered earlier (re-checked here).
 */
export async function resolveWebApp(initData: string, choice: string | null, meta: RequestMeta, slug: string | null = null): Promise<WebAppResult> {
  if (!(await rateLimit(`tgapp:${hashIp(meta.ip) ?? "noip"}`, 60, 15 * 60_000))) return { status: "error", reason: "rate_limited" };
  const bot = slug ? await clinicBot(slug) : null;
  if (!bot) return { status: "error", reason: "disabled" };
  const tgId = verifyInitData(initData, bot.token);
  if (!tgId) return { status: "error", reason: "invalid" };

  // A patient card of this clinic with the Telegram-verified phone opens the portal (no code needed).
  await openPortalWithTelegram(tgId, bot.tenantId);
  const patients = await telegramPatientAccounts(tgId);
  const choices: Choice[] = patients.accounts.filter((x) => x.tenantId === bot.tenantId).map((a) => ({ key: `patient:${a.id}`, kind: "patient", clinic: a.name, patient: a.patientName }));
  if (choices.length === 0) return { status: "patient", phoneKnown: patients.phoneKnown };
  const pick = choice ? choices.find((x) => x.key === choice) : choices.length === 1 ? choices[0] : undefined;
  if (!pick) return { status: "choose", choices };

  const r = await loginPatientWithTelegram(tgId, pick.key.slice("patient:".length), meta);
  if (!r.ok) return { status: "error", reason: r.reason };
  return { status: "signed_in", target: "patient", token: r.token, locale: r.locale, go: `/p/${r.slug}` };
}
