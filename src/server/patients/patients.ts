import "server-only";
import { z } from "zod";
import { Prisma, type ConsentPurpose } from "@/generated/prisma/client";
import { LOCALES } from "@/i18n/config";
import { phoneSchema } from "@/lib/validation";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { auditClinic, inClinic, requirePermission } from "../clinic/context";
import type { Tx } from "../db";
import { isLocalDate, localDateToDbDate, todayIn } from "../scheduling/time";
import { uuidv7 } from "../security/crypto";
import { DomainError } from "../tenancy/provisioning";

const uuid = z.uuid();
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "validation.tooLong")
    .transform((v) => (v === "" ? undefined : v))
    .optional();
const nameField = z.string().trim().min(1, "validation.required").max(80, "validation.tooLong");

export const CONSENT_PURPOSES = ["SMS_REMINDERS", "TELEGRAM_NOTIFICATIONS", "MARKETING", "HEALTH_DATA_EXCHANGE", "PATIENT_PORTAL"] as const;
export const CONSENT_METHODS = ["PAPER_SIGNED", "VERBAL_RECORDED", "PORTAL"] as const;

/** Phone numbers are stored digits-only with a leading "+" for search and duplicate checks. */
export function normalizePhone(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const digits = v.replace(/\D/g, "");
  if (digits.length === 9) return `+998${digits}`; // local Uzbek mobile without country code
  return `+${digits}`;
}

/**
 * Date of birth as people give it at the desk: "1947" (year only), "12.03.1947"
 * or "1947-03-12". Year only is stored as 1 January with birthYearOnly = true.
 */
export function parseBirthInput(v: string): { date: string; yearOnly: boolean } | null {
  const s = v.trim();
  if (/^\d{4}$/.test(s)) return { date: `${s}-01-01`, yearOnly: true };
  const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
  const iso = dmy ? `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}` : s;
  return isLocalDate(iso) ? { date: iso, yearOnly: false } : null;
}

export const patientSchema = z
  .object({
    lastName: nameField,
    firstName: nameField,
    middleName: optionalText(80),
    birthDate: z.string().refine((v) => parseBirthInput(v) !== null, "validation.date"),
    sex: z.enum(["MALE", "FEMALE", "UNKNOWN"]),
    phone: z.union([z.literal("").transform(() => undefined), phoneSchema]).optional(),
    address: optionalText(300),
    preferredLocale: z.union([z.literal("").transform(() => undefined), z.enum(LOCALES)]).optional(),
    pinfl: z.union([z.literal("").transform(() => undefined), z.string().trim().regex(/^\d{14}$/, "validation.pinfl")]).optional(),
    passport: z.union([z.literal("").transform(() => undefined), z.string().trim().toUpperCase().regex(/^[A-Z]{2}\d{7}$/, "validation.passport")]).optional(),
    /** Who sent the patient; only changed when the form sends it. */
    referralSource: z.union([z.literal("").transform(() => null), z.enum(["SELF", "DOCTOR", "ADVERTISING", "OTHER"])]).optional(),
    referralDetail: z.union([z.literal("").transform(() => null), z.string().trim().max(120, "validation.tooLong")]).optional(),
    benefitCategoryId: z.union([z.literal("").transform(() => null), z.uuid()]).optional(),
  })
  .transform((v) => {
    const b = parseBirthInput(v.birthDate)!;
    return { ...v, birthDate: b.date, birthYearOnly: b.yearOnly, phone: normalizePhone(v.phone) };
  });

export type PatientInput = z.infer<typeof patientSchema>;

/** Referral and benefit fields that the form actually sent (others are left as they are). */
async function extraFields(tx: Tx, input: PatientInput) {
  const out: { referralSource?: "SELF" | "DOCTOR" | "ADVERTISING" | "OTHER" | null; referralDetail?: string | null; benefitCategoryId?: string | null } = {};
  if (input.referralSource !== undefined) out.referralSource = input.referralSource;
  if (input.referralDetail !== undefined) out.referralDetail = input.referralDetail;
  if (input.benefitCategoryId !== undefined) {
    if (input.benefitCategoryId) {
      // RLS: only this clinic's (active) categories are visible.
      const c = await tx.benefitCategory.findFirst({ where: { id: input.benefitCategoryId, archivedAt: null }, select: { id: true } });
      if (!c) throw new DomainError("errors.notFound");
    }
    out.benefitCategoryId = input.benefitCategoryId;
  }
  return out;
}

export interface DuplicateCandidate {
  id: string;
  mrn: string;
  fullName: string;
  birthDate: string;
  reasons: ("identifier" | "phone" | "name_birthdate" | "similar_name")[];
}

const fullName = (p: { lastName: string; firstName: string; middleName: string | null }) => [p.lastName, p.firstName, p.middleName].filter(Boolean).join(" ");

/**
 * Possible duplicates for human review. Exact identifier matches are always
 * blocking; other matches require the user to confirm "this is a new person".
 */
async function findDuplicates(tx: Tx, input: PatientInput, excludeId?: string): Promise<DuplicateCandidate[]> {
  const found = new Map<string, DuplicateCandidate>();
  const add = (p: { id: string; mrn: string; lastName: string; firstName: string; middleName: string | null; birthDate: Date }, reason: DuplicateCandidate["reasons"][number]) => {
    if (p.id === excludeId) return;
    const c = found.get(p.id) ?? { id: p.id, mrn: p.mrn, fullName: fullName(p), birthDate: p.birthDate.toISOString().slice(0, 10), reasons: [] };
    if (!c.reasons.includes(reason)) c.reasons.push(reason);
    found.set(p.id, c);
  };
  const select = { id: true, mrn: true, lastName: true, firstName: true, middleName: true, birthDate: true } as const;

  const ids = [
    ...(input.pinfl ? [{ type: "PINFL" as const, value: input.pinfl }] : []),
    ...(input.passport ? [{ type: "PASSPORT" as const, value: input.passport }] : []),
  ];
  if (ids.length) {
    const rows = await tx.patientIdentifier.findMany({ where: { OR: ids }, include: { patient: { select } } });
    for (const r of rows) add(r.patient, "identifier");
  }
  if (input.phone) for (const p of await tx.patient.findMany({ where: { phone: input.phone, status: "ACTIVE" }, select, take: 10 })) add(p, "phone");

  const bd = localDateToDbDate(input.birthDate);
  for (const p of await tx.patient.findMany({
    where: { birthDate: bd, status: "ACTIVE", lastName: { equals: input.lastName, mode: "insensitive" }, firstName: { equals: input.firstName, mode: "insensitive" } },
    select,
    take: 10,
  }))
    add(p, "name_birthdate");

  const needle = `${input.lastName} ${input.firstName} ${input.middleName ?? ""}`.toLowerCase().trim();
  const similar = await tx.$queryRaw<{ id: string; mrn: string; lastName: string; firstName: string; middleName: string | null; birthDate: Date }[]>`
    SELECT id, mrn, "lastName", "firstName", "middleName", "birthDate" FROM "Patient"
    WHERE status = 'ACTIVE' AND "birthDate" = ${bd}::date
      AND similarity(lower("lastName" || ' ' || "firstName" || ' ' || coalesce("middleName", '')), ${needle}) > 0.45
    LIMIT 10`;
  for (const p of similar) add(p, "similar_name");
  return [...found.values()];
}

async function nextMrn(tx: Tx, tenantId: string): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"mrn:" + tenantId}, 0))`;
  const rows = await tx.$queryRaw<{ n: number | null }[]>`SELECT max(substring(mrn from 3)::int) AS n FROM "Patient"`;
  return `P-${String((rows[0]?.n ?? 0) + 1).padStart(6, "0")}`;
}

function validateBirthDate(ctx: ClinicContext, birthDate: string) {
  const today = todayIn(ctx.tenant.timezone);
  const year = Number(birthDate.slice(0, 4));
  if (birthDate > today || year < Number(today.slice(0, 4)) - 130) throw new DomainError("errors.birthDateRange");
}

export type RegisterResult = { ok: true; id: string; mrn: string } | { ok: false; duplicates: DuplicateCandidate[]; blocking: boolean };

export async function registerPatient(
  ctx: ClinicContext,
  raw: unknown,
  opts: { confirmNotDuplicate: boolean; consents?: { purpose: ConsentPurpose; method: (typeof CONSENT_METHODS)[number] }[] },
  meta: RequestMeta,
): Promise<RegisterResult> {
  requirePermission(ctx, "patients.create");
  const input = patientSchema.parse(raw);
  validateBirthDate(ctx, input.birthDate);
  return inClinic(ctx, async (tx) => {
    const duplicates = await findDuplicates(tx, input);
    const blocking = duplicates.some((d) => d.reasons.includes("identifier"));
    if (duplicates.length && (blocking || !opts.confirmNotDuplicate)) return { ok: false, duplicates, blocking };

    const id = uuidv7();
    const mrn = await nextMrn(tx, ctx.tenant.id);
    await tx.patient.create({
      data: {
        id,
        tenantId: ctx.tenant.id,
        mrn,
        lastName: input.lastName,
        firstName: input.firstName,
        middleName: input.middleName,
        birthDate: localDateToDbDate(input.birthDate),
        birthYearOnly: input.birthYearOnly,
        sex: input.sex,
        phone: input.phone,
        address: input.address,
        preferredLocale: input.preferredLocale,
        createdById: ctx.principal.user.id,
        ...(await extraFields(tx, input)),
      },
    });
    const identifiers = [
      ...(input.pinfl ? [{ type: "PINFL" as const, value: input.pinfl }] : []),
      ...(input.passport ? [{ type: "PASSPORT" as const, value: input.passport }] : []),
    ];
    if (identifiers.length) await tx.patientIdentifier.createMany({ data: identifiers.map((i) => ({ id: uuidv7(), tenantId: ctx.tenant.id, patientId: id, ...i })) });
    for (const c of opts.consents ?? []) {
      await tx.patientConsent.create({ data: { id: uuidv7(), tenantId: ctx.tenant.id, patientId: id, purpose: c.purpose, method: c.method, recordedById: ctx.principal.user.id } });
    }
    await auditClinic(tx, ctx, meta, {
      action: "patient.created",
      entityType: "Patient",
      entityId: id,
      metadata: { duplicateOverride: duplicates.length > 0, consentCount: opts.consents?.length ?? 0 },
    });
    return { ok: true, id, mrn };
  });
}

/**
 * Smart search: MRN, PINFL, passport, phone digits, birth date (DD.MM.YYYY or
 * YYYY-MM-DD) or fuzzy name. Search terms are never written to logs or audit.
 */
export async function searchPatients(ctx: ClinicContext, qRaw: string) {
  requirePermission(ctx, "patients.read");
  const q = qRaw.trim().slice(0, 100);
  if (q.length < 2) return [];
  return inClinic(ctx, async (tx) => {
    const select = { id: true, mrn: true, lastName: true, firstName: true, middleName: true, birthDate: true, sex: true, phone: true, status: true } as const;
    const base = { status: { not: "MERGED" as const } };
    if (/^p-?\d+$/i.test(q)) {
      const n = q.replace(/\D/g, "");
      return tx.patient.findMany({ where: { ...base, mrn: `P-${n.padStart(6, "0")}` }, select });
    }
    const dmy = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(q);
    const iso = dmy ? `${dmy[3]}-${dmy[2]}-${dmy[1]}` : q;
    if (isLocalDate(iso)) return tx.patient.findMany({ where: { ...base, birthDate: localDateToDbDate(iso) }, select, take: 50, orderBy: { lastName: "asc" } });
    if (/^[A-Za-z]{2}\d{7}$/.test(q)) {
      return tx.patient.findMany({ where: { ...base, identifiers: { some: { type: "PASSPORT", value: q.toUpperCase() } } }, select });
    }
    const digits = q.replace(/[\s()+-]/g, "");
    if (/^\d{14}$/.test(digits)) {
      return tx.patient.findMany({ where: { ...base, identifiers: { some: { type: "PINFL", value: digits } } }, select });
    }
    if (/^\d{5,13}$/.test(digits)) return tx.patient.findMany({ where: { ...base, phone: { contains: digits } }, select, take: 20 });

    const needle = q.toLowerCase();
    const ids = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Patient"
      WHERE status <> 'MERGED' AND (
        lower("lastName" || ' ' || "firstName" || ' ' || coalesce("middleName", '')) LIKE ${"%" + needle.replace(/[%_\\]/g, "\\$&") + "%"}
        OR similarity(lower("lastName" || ' ' || "firstName" || ' ' || coalesce("middleName", '')), ${needle}) > 0.3
      )
      ORDER BY similarity(lower("lastName" || ' ' || "firstName" || ' ' || coalesce("middleName", '')), ${needle}) DESC
      LIMIT 20`;
    if (!ids.length) return [];
    const rows = await tx.patient.findMany({ where: { id: { in: ids.map((r) => r.id) } }, select });
    const order = new Map(ids.map((r, i) => [r.id, i]));
    return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  });
}

/** The most recently registered patients (the list before anything is typed). Same columns as search. */
export async function listRecentPatients(ctx: ClinicContext, take = 30) {
  requirePermission(ctx, "patients.read");
  return inClinic(ctx, (tx) =>
    tx.patient.findMany({
      where: { tenantId: ctx.tenant.id, status: { not: "MERGED" } },
      select: { id: true, mrn: true, lastName: true, firstName: true, middleName: true, birthDate: true, sex: true, phone: true, status: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(take, 1), 100),
    }),
  );
}

/** Demographics, identifiers, consents and appointments — no clinical content. Audited. */
export async function getPatient(ctx: ClinicContext, id: string, meta: RequestMeta) {
  requirePermission(ctx, "patients.read");
  if (!uuid.safeParse(id).success) return null;
  return inClinic(ctx, async (tx) => {
    const p = await tx.patient.findUnique({
      where: { id },
      include: {
        identifiers: { orderBy: { type: "asc" } },
        consents: { orderBy: { grantedAt: "desc" } },
        appointments: {
          orderBy: { startsAt: "desc" },
          take: 30,
          include: { doctor: { include: { membership: { include: { user: { select: { fullName: true } } } } } }, service: { select: { name: true } }, branch: { select: { name: true } } },
        },
      },
    });
    if (!p) return null;
    await auditClinic(tx, ctx, meta, { action: "patient.viewed", entityType: "Patient", entityId: p.id });
    return p;
  });
}

export async function updatePatient(ctx: ClinicContext, id: string, raw: unknown, meta: RequestMeta) {
  requirePermission(ctx, "patients.update");
  const input = patientSchema.parse(raw);
  validateBirthDate(ctx, input.birthDate);
  await inClinic(ctx, async (tx) => {
    const p = await tx.patient.findUnique({ where: { id: uuid.parse(id) } });
    if (!p || p.status !== "ACTIVE") throw new DomainError("errors.notFound");
    const dupes = await findDuplicates(tx, input, p.id);
    if (dupes.some((d) => d.reasons.includes("identifier"))) throw new DomainError("errors.identifierInUse");
    await tx.patient.update({
      where: { id: p.id },
      data: {
        lastName: input.lastName,
        firstName: input.firstName,
        middleName: input.middleName ?? null,
        birthDate: localDateToDbDate(input.birthDate),
        birthYearOnly: input.birthYearOnly,
        sex: input.sex,
        phone: input.phone ?? null,
        address: input.address ?? null,
        preferredLocale: input.preferredLocale ?? null,
        ...(await extraFields(tx, input)),
      },
    });
    for (const [type, value] of [["PINFL", input.pinfl], ["PASSPORT", input.passport]] as const) {
      await tx.patientIdentifier.deleteMany({ where: { patientId: p.id, type } });
      if (value) await tx.patientIdentifier.create({ data: { id: uuidv7(), tenantId: ctx.tenant.id, patientId: p.id, type, value } });
    }
    // Field names only: the audit trail records that demographics changed, not the values.
    await auditClinic(tx, ctx, meta, { action: "patient.updated", entityType: "Patient", entityId: p.id });
  }).catch((e) => {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new DomainError("errors.identifierInUse");
    throw e;
  });
}

export const consentSchema = z.object({ purpose: z.enum(CONSENT_PURPOSES), method: z.enum(CONSENT_METHODS) });

export async function recordConsent(ctx: ClinicContext, patientId: string, raw: unknown, meta: RequestMeta) {
  requirePermission(ctx, "patients.update");
  const input = consentSchema.parse(raw);
  await inClinic(ctx, async (tx) => {
    const p = await tx.patient.findUnique({ where: { id: uuid.parse(patientId) } });
    if (!p) throw new DomainError("errors.notFound");
    const active = await tx.patientConsent.findFirst({ where: { patientId: p.id, purpose: input.purpose, withdrawnAt: null } });
    if (active) throw new DomainError("errors.consentActive");
    const id = uuidv7();
    await tx.patientConsent.create({ data: { id, tenantId: ctx.tenant.id, patientId: p.id, purpose: input.purpose, method: input.method, recordedById: ctx.principal.user.id } });
    await auditClinic(tx, ctx, meta, { action: "consent.granted", entityType: "Patient", entityId: p.id, metadata: { purpose: input.purpose, method: input.method } });
  });
}

export async function withdrawConsent(ctx: ClinicContext, consentId: string, meta: RequestMeta) {
  requirePermission(ctx, "patients.update");
  await inClinic(ctx, async (tx) => {
    const c = await tx.patientConsent.findUnique({ where: { id: uuid.parse(consentId) } });
    if (!c || c.withdrawnAt) throw new DomainError("errors.notFound");
    await tx.patientConsent.update({ where: { id: c.id }, data: { withdrawnAt: new Date() } });
    await auditClinic(tx, ctx, meta, { action: "consent.withdrawn", entityType: "Patient", entityId: c.patientId, metadata: { purpose: c.purpose } });
    if (c.purpose === "PATIENT_PORTAL") {
      // No consent, no portal: close the account and end its sessions in the same transaction.
      const acc = await tx.patientAccount.findFirst({ where: { patientId: c.patientId, tenantId: ctx.tenant.id }, select: { id: true, status: true } });
      if (acc && acc.status !== "DISABLED") {
        await tx.patientAccount.updateMany({ where: { id: acc.id }, data: { status: "DISABLED", activationCodeHash: null, activationExpiresAt: null } });
        await tx.patientSession.updateMany({ where: { accountId: acc.id, revokedAt: null }, data: { revokedAt: new Date() } });
        await auditClinic(tx, ctx, meta, { action: "portal.disabled", entityType: "Patient", entityId: c.patientId, metadata: { reason: "consent_withdrawn" } });
      }
    }
  });
}

/** True when the patient currently consents to a purpose (e.g. before sending an SMS reminder). */
export async function hasActiveConsent(tx: Tx, patientId: string, purpose: ConsentPurpose) {
  return Boolean(await tx.patientConsent.findFirst({ where: { patientId, purpose, withdrawnAt: null } }));
}
