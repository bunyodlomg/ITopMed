import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { phoneSchema } from "@/lib/validation";
import { recordAudit } from "../audit";
import type { RequestMeta } from "../auth/platform-auth";
import { withPortal, type Tx, sequential } from "../db";
import { normalizePhone } from "../patients/patients";
import { isLocalDate } from "../scheduling/time";
import { hashIp, randomToken, sha256Hex } from "../security/crypto";
import { hashPassword, passwordSchema, verifyPassword } from "../security/password";
import { rateLimit } from "../security/rate-limit";
import { DomainError } from "../tenancy/provisioning";

/**
 * Patient portal identity realm — separate from clinic staff (User/Session).
 * All queries run as the `itopmed_portal` database role, whose policies derive
 * the patient from the presented session hash. See migration `patient_portal`.
 */
export const PATIENT_SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
/** Must match the idle window in portal_current_account() (30 minutes). */
export const PATIENT_SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const USABLE = new Set(["TRIAL", "ACTIVE"]);

export interface PortalTenant {
  id: string;
  slug: string;
  name: string;
  defaultLocale: string;
  timezone: string;
  currency: string;
}

/** Public clinic info for the portal sign-in pages (only usable clinics). */
export async function portalTenant(slug: string): Promise<PortalTenant | null> {
  if (!/^[a-z0-9-]{3,48}$/.test(slug)) return null;
  const t = await withPortal({}, async (tx) => {
    const tenant = await tx.tenant.findFirst({ where: { slug }, select: { id: true, slug: true, name: true, status: true, defaultLocale: true, timezone: true, currency: true } });
    if (!tenant) return null;
    const on = await tx.$queryRaw<{ on: boolean }[]>`SELECT portal_module_enabled(${tenant.id}::uuid, 'patient_portal') AS on`;
    return on[0]?.on ? tenant : null; // clinics without the portal module have no portal at all
  });
  if (!t || !USABLE.has(t.status)) return null;
  return { id: t.id, slug: t.slug, name: t.name, defaultLocale: t.defaultLocale, timezone: t.timezone, currency: t.currency };
}

function audit(tx: Tx, tenantId: string, meta: RequestMeta, e: { action: string; actorId?: string | null; outcome?: "SUCCESS" | "DENIED" | "FAILURE"; entityType?: string; entityId?: string; metadata?: Record<string, string | number | boolean | null> }) {
  return recordAudit(tx, {
    tenantId,
    actorType: e.actorId ? "PATIENT" : "ANONYMOUS",
    actorId: e.actorId ?? null,
    action: e.action,
    outcome: e.outcome,
    entityType: e.entityType,
    entityId: e.entityId,
    ipHash: hashIp(meta.ip),
    userAgent: meta.userAgent,
    metadata: e.metadata,
  });
}

// ───────────── Activation (code handed over in person + birth date) ─────────────

/** Unambiguous alphabet (no 0/O, 1/I/L). 12 characters ≈ 59 bits. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const ACTIVATION_TTL_MS = 72 * 60 * 60 * 1000;

export function newActivationCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  // 256 % 31 bias is negligible for a rate-limited, expiring, birth-date-checked code.
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
}

export function normalizeActivationCode(v: string): string {
  return v.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export const hashActivationCode = (code: string) => sha256Hex(`portal-activation:${normalizeActivationCode(code)}`);

export const loginPhoneSchema = phoneSchema.transform((v, c) => {
  const n = normalizePhone(v);
  if (!n || !/^\+[0-9]{9,15}$/.test(n)) {
    c.addIssue({ code: "custom", message: "validation.phone" });
    return z.NEVER;
  }
  return n;
});

export const activationSchema = z
  .object({
    code: z.string().trim().min(1, "validation.required").max(40),
    birthDate: z.string().refine(isLocalDate, "validation.date"),
    phone: loginPhoneSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, { message: "validation.passwordMismatch", path: ["confirmPassword"] });

/** Unique (tenant, login) violation, raised from inside portal_activate(). */
function isLoginConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (e.code === "P2002") return true;
  return e.code === "P2010" && /23505|PatientAccount_tenantId_login_key/.test(JSON.stringify(e.meta ?? {}) + e.message);
}

/**
 * The patient sets their login phone and password. The code must belong to an
 * INVITED account of this clinic, be unexpired, and the birth date must match.
 * Wrong answers count towards the lockout and eventually burn the code.
 */
export async function activatePortalAccount(tenant: PortalTenant, raw: unknown, meta: RequestMeta): Promise<void> {
  const ipHash = hashIp(meta.ip);
  if (!(await rateLimit(`pact:${ipHash ?? "noip"}`, 10, 15 * 60_000))) throw new DomainError("auth.rateLimited");
  const input = activationSchema.parse(raw);
  const codeHash = hashActivationCode(input.code);

  const rows = await withPortal({}, (tx) =>
    tx.$queryRaw<{ id: string; tenantId: string; birthDate: string; status: string; activationExpiresAt: Date | null; lockedUntil: Date | null }[]>`
      SELECT id, "tenantId", "birthDate"::text AS "birthDate", status::text AS status, "activationExpiresAt", "lockedUntil" FROM portal_activation_lookup(${codeHash})`,
  );
  const acc = rows[0];
  const now = new Date();
  const usable = acc && acc.tenantId === tenant.id && acc.status === "INVITED" && acc.activationExpiresAt && acc.activationExpiresAt > now && !(acc.lockedUntil && acc.lockedUntil > now);
  if (!usable) {
    await withPortal({}, (tx) => audit(tx, tenant.id, meta, { action: "portal.activation", outcome: "FAILURE", metadata: { reason: acc ? "unusable" : "unknown" } }));
    throw new DomainError("errors.portalCodeInvalid");
  }
  if (acc.birthDate !== input.birthDate) {
    await withPortal({}, async (tx) => {
      await tx.$executeRaw`SELECT portal_auth_record_failure(${acc.id}::uuid, ${MAX_FAILED}::int, ${LOCK_MINUTES}::int)`;
      await audit(tx, tenant.id, meta, { action: "portal.activation", outcome: "FAILURE", actorId: acc.id, metadata: { reason: "identity_mismatch" } });
    });
    throw new DomainError("errors.portalCodeInvalid");
  }

  const passwordHash = await hashPassword(input.password);
  try {
    await withPortal({}, async (tx) => {
      // Atomic in the database: code, expiry, lock and birth date are checked again there.
      const done = await tx.$queryRaw<{ id: string | null }[]>`
        SELECT portal_activate(${codeHash}, ${input.birthDate}::date, ${input.phone}, ${passwordHash}) AS id`;
      if (done[0]?.id !== acc.id) throw new DomainError("errors.portalCodeInvalid");
      await audit(tx, tenant.id, meta, { action: "portal.activated", actorId: acc.id, entityType: "PatientAccount", entityId: acc.id });
    });
  } catch (e) {
    if (isLoginConflict(e)) throw new DomainError("errors.portalLoginTaken");
    throw e;
  }
}

// ───────────── Sign-in and sessions ─────────────

export type PortalLoginResult = { ok: true; token: string; locale: string | null } | { ok: false; reason: "invalid" | "locked" | "rate_limited" };

export async function loginPatient(tenant: PortalTenant, phoneRaw: string, password: string, meta: RequestMeta): Promise<PortalLoginResult> {
  const ipHash = hashIp(meta.ip);
  const phone = loginPhoneSchema.safeParse(phoneRaw);
  const login = phone.success ? phone.data : "";
  if (!(await rateLimit(`ptlogin:${ipHash ?? "noip"}`, 30, 15 * 60_000)) || !(await rateLimit(`ptlogin:${tenant.id}:${login}`, 10, 15 * 60_000))) {
    return { ok: false, reason: "rate_limited" };
  }
  const found = login
    ? await withPortal({}, (tx) =>
        tx.$queryRaw<{ id: string; passwordHash: string | null; status: string; lockedUntil: Date | null }[]>`
          SELECT id, "passwordHash", status::text AS status, "lockedUntil" FROM portal_auth_lookup(${tenant.id}::uuid, ${login})`,
      )
    : [];
  const acc = found[0];
  if (acc?.lockedUntil && acc.lockedUntil > new Date()) {
    await withPortal({}, (tx) => audit(tx, tenant.id, meta, { action: "portal.login", outcome: "DENIED", actorId: acc.id, metadata: { reason: "locked" } }));
    return { ok: false, reason: "locked" };
  }
  const valid = await verifyPassword(acc?.passwordHash, password);
  if (!acc || !valid || acc.status !== "ACTIVE") {
    await withPortal({}, async (tx) => {
      if (acc) await tx.$executeRaw`SELECT portal_auth_record_failure(${acc.id}::uuid, ${MAX_FAILED}::int, ${LOCK_MINUTES}::int)`;
      await audit(tx, tenant.id, meta, {
        action: "portal.login",
        outcome: "FAILURE",
        actorId: acc?.id,
        metadata: { reason: acc ? (valid ? "inactive" : "bad_credentials") : "unknown_account" },
      });
    });
    return { ok: false, reason: "invalid" };
  }

  const token = randomToken();
  const sessionId = sha256Hex(token);
  const locale = await withPortal({ sessionId }, async (tx) => {
    await tx.patientSession.create({
      data: { id: sessionId, tenantId: tenant.id, accountId: acc.id, expiresAt: new Date(Date.now() + PATIENT_SESSION_ABSOLUTE_MS), ipHash, userAgent: meta.userAgent?.slice(0, 256) },
    });
    // From here on the database recognises this session as the patient's.
    await tx.patientAccount.updateMany({ where: { id: acc.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
    await audit(tx, tenant.id, meta, { action: "portal.login", actorId: acc.id });
    const a = await tx.patientAccount.findFirst({ where: { id: acc.id }, select: { locale: true } });
    return a?.locale ?? null;
  });
  return { ok: true, token, locale };
}

// ───────────── Telegram (central bot) ─────────────

/**
 * Stores the phone number Telegram verified for this Telegram user. Called only
 * for a contact the person shared about THEMSELVES (checked by the caller).
 */
export async function saveTelegramContact(tgId: bigint, phoneRaw: string): Promise<boolean> {
  const phone = normalizePhone(phoneRaw);
  if (!phone || !/^\+[0-9]{9,15}$/.test(phone)) return false;
  await withPortal({}, (tx) => tx.$executeRaw`SELECT tg_contact_save(${tgId}::bigint, ${phone})`);
  return true;
}

export interface TelegramPatientAccount {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  /** First name + last-name initial, so a family sharing one phone can pick the right card. */
  patientName: string;
}

/** Whether the person shared their phone, and the active portal accounts they may enter with it. */
export async function telegramPatientAccounts(tgId: bigint): Promise<{ phoneKnown: boolean; accounts: TelegramPatientAccount[] }> {
  return withPortal({}, async (tx) => {
    const known = await tx.$queryRaw<{ known: boolean }[]>`SELECT tg_contact_known(${tgId}::bigint) AS known`;
    const rows = await tx.$queryRaw<TelegramPatientAccount[]>`
      SELECT id, "tenantId", slug, name, "patientName" FROM portal_telegram_accounts(${tgId}::bigint)`;
    return { phoneKnown: Boolean(known[0]?.known), accounts: rows };
  });
}

/**
 * Opens the portal for every ACTIVE patient of this clinic whose card phone is
 * the phone Telegram verified for this person (no activation code: the clinic's
 * decision). Invited accounts are activated; disabled ones stay disabled.
 * Returns how many accounts were opened now.
 */
export async function openPortalWithTelegram(tgId: bigint, tenantId: string): Promise<number> {
  return withPortal({}, async (tx) => {
    const rows = await tx.$queryRaw<{ accountId: string; created: boolean }[]>`
      SELECT "accountId", created FROM portal_telegram_open(${tgId}::bigint, ${tenantId}::uuid)`;
    for (const r of rows) {
      await recordAudit(tx, { tenantId, actorType: "PATIENT", actorId: r.accountId, action: "portal.opened_telegram", entityType: "PatientAccount", entityId: r.accountId, metadata: { created: r.created } });
    }
    return rows.length;
  });
}

/**
 * Signs a patient in through the central bot: the Telegram user (verified
 * initData) shared a phone that is the login of this portal account.
 */
export async function loginPatientWithTelegram(
  tgId: bigint,
  accountId: string,
  meta: RequestMeta,
): Promise<{ ok: true; token: string; locale: string | null; slug: string } | { ok: false; reason: "invalid" | "locked" | "rate_limited" }> {
  const ipHash = hashIp(meta.ip);
  if (!(await rateLimit(`pttg:${ipHash ?? "noip"}`, 30, 15 * 60_000))) return { ok: false, reason: "rate_limited" };
  const rows = await withPortal({}, (tx) =>
    tx.$queryRaw<{ id: string; tenantId: string; slug: string; lockedUntil: Date | null }[]>`
      SELECT id, "tenantId", slug, "lockedUntil" FROM portal_telegram_accounts(${tgId}::bigint)`,
  );
  const acc = rows.find((r) => r.id === accountId);
  if (!acc) return { ok: false, reason: "invalid" };
  if (acc.lockedUntil && acc.lockedUntil > new Date()) {
    await withPortal({}, (tx) => audit(tx, acc.tenantId, meta, { action: "portal.login.telegram", outcome: "DENIED", actorId: acc.id, metadata: { reason: "locked" } }));
    return { ok: false, reason: "locked" };
  }
  const token = randomToken();
  const sessionId = sha256Hex(token);
  const locale = await withPortal({ sessionId }, async (tx) => {
    await tx.patientSession.create({
      data: { id: sessionId, tenantId: acc.tenantId, accountId: acc.id, expiresAt: new Date(Date.now() + PATIENT_SESSION_ABSOLUTE_MS), ipHash, userAgent: meta.userAgent?.slice(0, 256) },
    });
    await tx.patientAccount.updateMany({ where: { id: acc.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
    await audit(tx, acc.tenantId, meta, { action: "portal.login.telegram", actorId: acc.id });
    const a = await tx.patientAccount.findFirst({ where: { id: acc.id }, select: { locale: true } });
    return a?.locale ?? null;
  });
  return { ok: true, token, locale, slug: acc.slug };
}

export interface PatientPrincipal {
  sessionId: string;
  accountId: string;
  patientId: string;
  locale: string | null;
  tenant: PortalTenant;
  patient: { mrn: string; firstName: string; lastName: string; middleName: string | null };
}

export async function validatePatientSession(token: string | undefined | null): Promise<PatientPrincipal | null> {
  if (!token || token.length > 64) return null;
  const sessionId = sha256Hex(token);
  return withPortal({ sessionId }, async (tx) => {
    const s = await tx.patientSession.findFirst({ where: { id: sessionId } });
    const now = Date.now();
    if (!s || s.revokedAt || s.expiresAt.getTime() <= now || now - s.lastSeenAt.getTime() > PATIENT_SESSION_IDLE_MS) return null;
    const account = await tx.patientAccount.findFirst({ where: { id: s.accountId }, select: { id: true, patientId: true, status: true, locale: true } });
    if (!account || account.status !== "ACTIVE") return null;
    const [patient, tenant] = await sequential([
      tx.patient.findFirst({ where: { id: account.patientId }, select: { mrn: true, firstName: true, lastName: true, middleName: true } }),
      tx.tenant.findFirst({ where: { id: s.tenantId }, select: { id: true, slug: true, name: true, status: true, defaultLocale: true, timezone: true, currency: true } }),
    ]);
    if (!patient || !tenant || !USABLE.has(tenant.status)) return null;
    const portalOn = await tx.$queryRaw<{ on: boolean }[]>`SELECT portal_module_enabled(${tenant.id}::uuid, 'patient_portal') AS on`;
    if (!portalOn[0]?.on) return null; // module switched off: existing sessions stop working
    if (now - s.lastSeenAt.getTime() > 60_000) await tx.patientSession.updateMany({ where: { id: sessionId }, data: { lastSeenAt: new Date(now) } });
    return {
      sessionId,
      accountId: account.id,
      patientId: account.patientId,
      locale: account.locale,
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, defaultLocale: tenant.defaultLocale, timezone: tenant.timezone, currency: tenant.currency },
      patient,
    };
  });
}

export async function logoutPatient(token: string | undefined | null) {
  if (!token) return;
  const sessionId = sha256Hex(token);
  await withPortal({ sessionId }, (tx) => tx.patientSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } }));
}

export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1, "validation.required"), password: passwordSchema, confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, { message: "validation.passwordMismatch", path: ["confirmPassword"] });

/** Changes the password and signs out every other device. */
export async function changePatientPassword(p: PatientPrincipal, raw: unknown, meta: RequestMeta) {
  const input = changePasswordSchema.parse(raw);
  if (!(await rateLimit(`ppw:${p.accountId}`, 5, 15 * 60_000))) throw new DomainError("auth.rateLimited");
  const current = await withPortal({ sessionId: p.sessionId }, (tx) => tx.patientAccount.findFirst({ where: { id: p.accountId }, select: { passwordHash: true } }));
  if (!(await verifyPassword(current?.passwordHash, input.currentPassword))) throw new DomainError("errors.currentPasswordWrong");
  const passwordHash = await hashPassword(input.password);
  await withPortal({ sessionId: p.sessionId }, async (tx) => {
    await tx.patientAccount.updateMany({ where: { id: p.accountId }, data: { passwordHash } });
    await tx.patientSession.updateMany({ where: { accountId: p.accountId, id: { not: p.sessionId }, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(tx, p.tenant.id, meta, { action: "portal.password_changed", actorId: p.accountId, entityType: "PatientAccount", entityId: p.accountId });
  });
}

export async function setPatientLocale(p: PatientPrincipal, locale: string) {
  if (!["uz-Latn", "uz-Cyrl", "ru", "en"].includes(locale)) return;
  await withPortal({ sessionId: p.sessionId }, (tx) => tx.patientAccount.updateMany({ where: { id: p.accountId }, data: { locale } }));
}
