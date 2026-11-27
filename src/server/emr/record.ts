import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma, type VitalKind } from "@/generated/prisma/client";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { auditClinic, canUseBranch, inClinic } from "../clinic/context";
import type { Tx } from "../db";
import { uuidv7 } from "../security/crypto";
import { addDays, instantToLocalDate, localToInstant } from "../scheduling/time";
import { DomainError } from "../tenancy/provisioning";
import { withRecordAccess, type BreakGlassReason } from "./access";
import { labOrdersForRecord } from "../lab/lab";
import { sequential } from "../db";
import { dentalChartForRecord } from "./dental";
import { scheduleVisitCheckIn } from "../notifications/notifications";

const uuid = z.uuid();
const clinicalText = z.string().max(10_000, "validation.tooLong");

export const NOTE_SECTIONS = ["complaints", "history", "examination", "assessment", "plan"] as const;
type Sections = Record<(typeof NOTE_SECTIONS)[number], string>;

/**
 * Vital-sign kinds with UCUM units, LOINC codes (for future FHIR exchange) and
 * plausibility ranges. Ranges reject typing errors, they are not clinical limits.
 */
export const VITALS: Record<VitalKind, { unit: string; loinc: string; min: number; max: number }> = {
  SYSTOLIC_BP: { unit: "mm[Hg]", loinc: "8480-6", min: 40, max: 300 },
  DIASTOLIC_BP: { unit: "mm[Hg]", loinc: "8462-4", min: 20, max: 200 },
  HEART_RATE: { unit: "/min", loinc: "8867-4", min: 20, max: 300 },
  RESPIRATORY_RATE: { unit: "/min", loinc: "9279-1", min: 4, max: 80 },
  TEMPERATURE: { unit: "Cel", loinc: "8310-5", min: 30, max: 45 },
  SPO2: { unit: "%", loinc: "59408-5", min: 50, max: 100 },
  WEIGHT: { unit: "kg", loinc: "29463-7", min: 0.3, max: 400 },
  HEIGHT: { unit: "cm", loinc: "8302-2", min: 20, max: 260 },
  BLOOD_GLUCOSE: { unit: "mmol/L", loinc: "15074-8", min: 0.5, max: 50 },
  // Left arm (the plain kinds are the right arm or a single measurement); same LOINC codes, laterality is the kind.
  SYSTOLIC_BP_LEFT: { unit: "mm[Hg]", loinc: "8480-6", min: 40, max: 300 },
  DIASTOLIC_BP_LEFT: { unit: "mm[Hg]", loinc: "8462-4", min: 20, max: 200 },
  WAIST: { unit: "cm", loinc: "8280-0", min: 30, max: 250 },
};
export const VITAL_KINDS = Object.keys(VITALS) as VitalKind[];

/** Canonical content hash of a signed note: any later change is detectable. */
export function noteHash(n: { id: string; patientId: string; signedById: string; signedAt: Date } & Sections): string {
  const canonical = JSON.stringify([n.id, n.patientId, n.signedById, n.signedAt.toISOString(), ...NOTE_SECTIONS.map((s) => n[s])]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function amendmentHash(a: { id: string; noteId: string; authorId: string; reason: string; content: string; createdAt: Date }): string {
  return createHash("sha256").update(JSON.stringify([a.id, a.noteId, a.authorId, a.reason, a.content, a.createdAt.toISOString()]), "utf8").digest("hex");
}

// ───────────── Read ─────────────

/** The full medical record of one patient, subject to care-relationship access. Audited. */
export async function getMedicalRecord(ctx: ClinicContext, patientId: string, meta: RequestMeta, opts: { breakGlass?: BreakGlassReason } = {}) {
  return withRecordAccess(ctx, patientId, meta, { breakGlass: opts.breakGlass }, async (tx, access) => {
    const [patient, allergies, diagnoses, vitals, encounters, labOrders] = await sequential([
      tx.patient.findUniqueOrThrow({ where: { id: patientId }, select: { id: true, mrn: true, lastName: true, firstName: true, middleName: true, birthDate: true, sex: true } }),
      tx.allergy.findMany({ where: { patientId, status: { not: "ENTERED_IN_ERROR" } }, orderBy: { recordedAt: "desc" } }),
      tx.diagnosis.findMany({ where: { patientId, status: { not: "ENTERED_IN_ERROR" } }, orderBy: { recordedAt: "desc" } }),
      tx.vitalSign.findMany({ where: { patientId }, orderBy: { measuredAt: "desc" }, take: 60 }),
      tx.encounter.findMany({
        where: { patientId },
        orderBy: { startedAt: "desc" },
        take: 50,
        include: {
          doctor: { select: { specialty: true, membership: { select: { user: { select: { fullName: true } } } } } },
          notes: { include: { amendments: { orderBy: { createdAt: "asc" } } }, orderBy: { createdAt: "asc" } },
        },
      }),
      labOrdersForRecord(tx, patientId),
    ]);
    // For the patient's profile: medicines and study conclusions over time (no files).
    const prescriptions = await tx.prescription.findMany({ where: { patientId }, orderBy: { createdAt: "desc" }, take: 200 });
    const studies = await tx.diagnosticResult.findMany({ where: { patientId, enteredInErrorAt: null }, select: { id: true, kind: true, title: true, conclusion: true, performedAt: true, encounterId: true }, orderBy: { performedAt: "desc" }, take: 100 });
    const authorIds = [...new Set(encounters.flatMap((e) => e.notes.flatMap((n) => [n.authorId, ...n.amendments.map((a) => a.authorId)])))];
    const authors = new Map((await tx.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const dental = ctx.modules.has("dental") ? await dentalChartForRecord(tx, patientId) : null;
    return {
      access,
      patient,
      allergies,
      diagnoses,
      vitals,
      labOrders,
      dental,
      prescriptions,
      studies,
      encounters: encounters.map((e) => ({
        ...e,
        notes: e.notes.map((n) => ({
          ...n,
          authorName: authors.get(n.authorId) ?? "—",
          integrityOk: n.status !== "SIGNED" || (n.contentHash !== null && n.signedById !== null && n.signedAt !== null && n.contentHash === noteHash({ ...n, signedById: n.signedById, signedAt: n.signedAt })),
          amendments: n.amendments.map((a) => ({ ...a, authorName: authors.get(a.authorId) ?? "—", integrityOk: a.contentHash === amendmentHash(a) })),
        })),
      })),
    };
  });
}

// ───────────── Encounters ─────────────

export async function loadEncounter(tx: Tx, encounterId: string) {
  if (!uuid.safeParse(encounterId).success) throw new DomainError("errors.notFound");
  const e = await tx.encounter.findUnique({ where: { id: encounterId } });
  if (!e) throw new DomainError("errors.notFound");
  return e;
}

/**
 * Doctor starts the visit for their own appointment: appointment → IN_PROGRESS,
 * an encounter and an empty draft note are created. Idempotent.
 */
export async function startVisit(ctx: ClinicContext, appointmentId: string, meta: RequestMeta): Promise<string> {
  if (!ctx.permissions.has("emr.write")) throw new DomainError("errors.forbidden");
  const appt = await inClinic(ctx, async (tx) => {
    const a = await tx.appointment.findUnique({ where: { id: uuid.parse(appointmentId) }, include: { encounter: { select: { id: true } } } });
    if (!a) throw new DomainError("errors.notFound");
    const own = await tx.doctorProfile.findUnique({ where: { membershipId: ctx.membershipId }, select: { id: true } });
    if (!own || own.id !== a.doctorProfileId) throw new DomainError("errors.notYourPatient");
    return a;
  });
  if (appt.encounter) return appt.encounter.id;
  if (!["BOOKED", "CHECKED_IN"].includes(appt.status)) throw new DomainError("errors.invalidTransition");

  return withRecordAccess(ctx, appt.patientId, meta, { auditView: false }, async (tx) => {
    const now = new Date();
    const encounterId = uuidv7();
    await tx.appointment.update({ where: { id: appt.id }, data: { status: "IN_PROGRESS", startedAt: now, checkedInAt: appt.checkedInAt ?? now } });
    await tx.encounter.create({ data: { id: encounterId, tenantId: ctx.tenant.id, patientId: appt.patientId, doctorProfileId: appt.doctorProfileId, appointmentId: appt.id, branchId: appt.branchId } });
    await tx.clinicalNote.create({ data: { id: uuidv7(), tenantId: ctx.tenant.id, encounterId, patientId: appt.patientId, authorId: ctx.principal.user.id } });
    await auditClinic(tx, ctx, meta, { action: "encounter.started", entityType: "Encounter", entityId: encounterId, metadata: { appointmentId: appt.id } });
    return encounterId;
  });
}

/** Encounter workspace for its doctor: record + this visit's note, diagnoses and vitals. */
export async function getEncounter(ctx: ClinicContext, encounterId: string, meta: RequestMeta) {
  const enc = await inClinic(ctx, (tx) => loadEncounter(tx, encounterId));
  return withRecordAccess(ctx, enc.patientId, meta, {}, async (tx, access) => {
    const [encounter, allergies, labOrders] = await sequential([
      tx.encounter.findUniqueOrThrow({
        where: { id: enc.id },
        include: {
          patient: { select: { id: true, mrn: true, lastName: true, firstName: true, middleName: true, birthDate: true, birthYearOnly: true, sex: true, address: true } },
          notes: { include: { amendments: true }, orderBy: { createdAt: "asc" } },
          diagnoses: { where: { status: { not: "ENTERED_IN_ERROR" } }, orderBy: { recordedAt: "asc" } },
          vitals: { orderBy: { measuredAt: "desc" } },
          prescriptions: { orderBy: { createdAt: "asc" } },
          appointment: { select: { id: true, status: true, startsAt: true } },
        },
      }),
      tx.allergy.findMany({ where: { patientId: enc.patientId, status: "ACTIVE" } }),
      labOrdersForRecord(tx, enc.patientId, enc.id),
    ]);
    // Measurements taken at the desk on the visit day (before the visit existed) belong to this visit too.
    // Vital signs are append-only, so they are shown with the visit rather than re-linked.
    const dayStart = localToInstant(instantToLocalDate(encounter.startedAt, ctx.tenant.timezone), 0, ctx.tenant.timezone);
    const desk = await tx.vitalSign.findMany({ where: { patientId: enc.patientId, encounterId: null, measuredAt: { gte: dayStart, lte: encounter.closedAt ?? new Date() } }, orderBy: { measuredAt: "desc" } });
    encounter.vitals = [...encounter.vitals, ...desk].sort((a, b) => +b.measuredAt - +a.measuredAt);
    const dental = ctx.modules.has("dental") ? await dentalChartForRecord(tx, enc.patientId) : null;
    return { encounter, allergies, labOrders, dental, isOwn: access.doctorProfileId === enc.doctorProfileId };
  });
}

/** Closes the visit: requires at least one signed note; appointment → COMPLETED. */
export async function finishEncounter(ctx: ClinicContext, encounterId: string, meta: RequestMeta) {
  if (!ctx.permissions.has("emr.write")) throw new DomainError("errors.forbidden");
  const enc = await inClinic(ctx, (tx) => loadEncounter(tx, encounterId));
  await withRecordAccess(ctx, enc.patientId, meta, { auditView: false }, async (tx, access) => {
    if (access.doctorProfileId !== enc.doctorProfileId) throw new DomainError("errors.notYourPatient");
    if (enc.status !== "OPEN") throw new DomainError("errors.invalidTransition");
    const signed = await tx.clinicalNote.count({ where: { encounterId: enc.id, status: "SIGNED" } });
    if (signed === 0) throw new DomainError("errors.signNoteFirst");
    const now = new Date();
    await tx.encounter.update({ where: { id: enc.id }, data: { status: "CLOSED", closedAt: now } });
    if (enc.appointmentId) await tx.appointment.update({ where: { id: enc.appointmentId }, data: { status: "COMPLETED", completedAt: now } });
    await auditClinic(tx, ctx, meta, { action: "encounter.closed", entityType: "Encounter", entityId: enc.id });
    await scheduleVisitCheckIn(tx, ctx.tenant.id, { id: enc.id, patientId: enc.patientId, doctorProfileId: enc.doctorProfileId, closedAt: now }, ctx.tenant.timezone);
  });
}

// ───────────── Notes ─────────────

export const noteSchema = z.object(Object.fromEntries(NOTE_SECTIONS.map((s) => [s, clinicalText.default("")])) as Record<(typeof NOTE_SECTIONS)[number], z.ZodDefault<typeof clinicalText>>);

async function loadOwnDraft(tx: Tx, ctx: ClinicContext, noteId: string) {
  if (!uuid.safeParse(noteId).success) throw new DomainError("errors.notFound");
  const n = await tx.clinicalNote.findUnique({ where: { id: noteId } });
  if (!n) throw new DomainError("errors.notFound");
  if (n.authorId !== ctx.principal.user.id) throw new DomainError("errors.notAuthor");
  if (n.status !== "DRAFT") throw new DomainError("errors.noteSigned");
  return n;
}

export async function saveDraft(ctx: ClinicContext, noteId: string, raw: unknown, meta: RequestMeta) {
  if (!ctx.permissions.has("emr.write")) throw new DomainError("errors.forbidden");
  const sections = noteSchema.parse(raw);
  const note = await inClinic(ctx, (tx) => loadOwnDraft(tx, ctx, noteId));
  await withRecordAccess(ctx, note.patientId, meta, { auditView: false }, async (tx) => {
    await loadOwnDraft(tx, ctx, noteId);
    await tx.clinicalNote.update({ where: { id: note.id }, data: sections });
    await auditClinic(tx, ctx, meta, { action: "note.draft_saved", entityType: "ClinicalNote", entityId: note.id });
  });
}

/** Signs the author's draft: content becomes immutable and hash-protected. */
export async function signNote(ctx: ClinicContext, noteId: string, raw: unknown, meta: RequestMeta) {
  if (!ctx.permissions.has("emr.sign")) throw new DomainError("errors.forbidden");
  const sections = noteSchema.parse(raw);
  if (!sections.assessment.trim()) throw new DomainError("errors.assessmentRequired");
  const note = await inClinic(ctx, (tx) => loadOwnDraft(tx, ctx, noteId));
  await withRecordAccess(ctx, note.patientId, meta, { auditView: false }, async (tx) => {
    await loadOwnDraft(tx, ctx, noteId);
    const signedAt = new Date();
    const signedById = ctx.principal.user.id;
    const contentHash = noteHash({ id: note.id, patientId: note.patientId, signedById, signedAt, ...sections });
    await tx.clinicalNote.update({ where: { id: note.id }, data: { ...sections, status: "SIGNED", signedAt, signedById, contentHash } });
    await auditClinic(tx, ctx, meta, { action: "note.signed", entityType: "ClinicalNote", entityId: note.id });
  });
}

export const amendmentSchema = z.object({
  reason: z.string().trim().min(5, "validation.amendReason").max(300, "validation.tooLong"),
  content: z.string().trim().min(1, "validation.required").max(10_000, "validation.tooLong"),
});

/** Appends a correction to a signed note. The original stays unchanged and visible. */
export async function amendNote(ctx: ClinicContext, noteId: string, raw: unknown, meta: RequestMeta) {
  if (!ctx.permissions.has("emr.amend")) throw new DomainError("errors.forbidden");
  const input = amendmentSchema.parse(raw);
  const note = await inClinic(ctx, async (tx) => {
    const n = await tx.clinicalNote.findUnique({ where: { id: uuid.parse(noteId) } });
    if (!n) throw new DomainError("errors.notFound");
    return n;
  });
  if (note.status !== "SIGNED") throw new DomainError("errors.noteNotSigned");
  if (note.authorId !== ctx.principal.user.id && !ctx.permissions.has("emr.read_all")) throw new DomainError("errors.notAuthor");
  await withRecordAccess(ctx, note.patientId, meta, { auditView: false }, async (tx) => {
    const id = uuidv7();
    const createdAt = new Date();
    const authorId = ctx.principal.user.id;
    await tx.clinicalNoteAmendment.create({
      data: { id, tenantId: ctx.tenant.id, noteId: note.id, authorId, reason: input.reason, content: input.content, createdAt, contentHash: amendmentHash({ id, noteId: note.id, authorId, reason: input.reason, content: input.content, createdAt }) },
    });
    await auditClinic(tx, ctx, meta, { action: "note.amended", entityType: "ClinicalNote", entityId: note.id });
  });
}

// ───────────── Diagnoses, allergies, vitals ─────────────

export const diagnosisSchema = z.object({
  // The ICD-10 code is optional: many diagnoses are written as text first.
  icd10Code: z
    .string()
    .trim()
    .toUpperCase()
    .default("")
    .refine((v) => v === "" || /^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/.test(v), "validation.icd10"),
  description: z.string().trim().min(2, "validation.required").max(1000, "validation.tooLong"),
  kind: z.enum(["PRIMARY", "SECONDARY", "COMPLICATION"]).default("PRIMARY"),
  stage: z
    .string()
    .trim()
    .max(120, "validation.tooLong")
    .transform((v) => (v === "" ? undefined : v))
    .optional(),
});

export async function ownOpenEncounter(tx: Tx, encounterId: string, doctorProfileId: string | null) {
  const e = await loadEncounter(tx, encounterId);
  if (e.doctorProfileId !== doctorProfileId) throw new DomainError("errors.notYourPatient");
  if (e.status !== "OPEN") throw new DomainError("errors.encounterClosed");
  return e;
}

export async function addDiagnosis(ctx: ClinicContext, encounterId: string, raw: unknown, meta: RequestMeta) {
  if (!ctx.permissions.has("emr.write")) throw new DomainError("errors.forbidden");
  const input = diagnosisSchema.parse(raw);
  const enc = await inClinic(ctx, (tx) => loadEncounter(tx, encounterId));
  await withRecordAccess(ctx, enc.patientId, meta, { auditView: false }, async (tx, access) => {
    await ownOpenEncounter(tx, enc.id, access.doctorProfileId);
    const id = uuidv7();
    await tx.diagnosis.create({ data: { id, tenantId: ctx.tenant.id, patientId: enc.patientId, encounterId: enc.id, ...input, recordedById: ctx.principal.user.id } });
    await auditClinic(tx, ctx, meta, { action: "diagnosis.recorded", entityType: "Diagnosis", entityId: id });
  });
}

export const nextVisitSchema = z.object({ nextVisitDate: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "validation.date")]) });

/** The next visit agreed with the patient (printed on the conclusion); empty clears it. */
export async function setNextVisit(ctx: ClinicContext, encounterId: string, raw: unknown, meta: RequestMeta) {
  if (!ctx.permissions.has("emr.write")) throw new DomainError("errors.forbidden");
  const { nextVisitDate } = nextVisitSchema.parse(raw);
  if (nextVisitDate && nextVisitDate <= instantToLocalDate(new Date(), ctx.tenant.timezone)) throw new DomainError("errors.nextVisitPast");
  const enc = await inClinic(ctx, (tx) => loadEncounter(tx, encounterId));
  await withRecordAccess(ctx, enc.patientId, meta, { auditView: false }, async (tx, access) => {
    await ownOpenEncounter(tx, enc.id, access.doctorProfileId);
    await tx.encounter.update({ where: { id: enc.id }, data: { nextVisitDate: nextVisitDate ? new Date(`${nextVisitDate}T00:00:00Z`) : null }, select: { id: true } });
    await auditClinic(tx, ctx, meta, { action: "encounter.next_visit_set", entityType: "Encounter", entityId: enc.id, metadata: { set: Boolean(nextVisitDate) } });
  });
}

export const allergySchema = z.object({
  substance: z.string().trim().min(2, "validation.required").max(120, "validation.tooLong"),
  reaction: z
    .string()
    .trim()
    .max(200, "validation.tooLong")
    .transform((v) => (v === "" ? undefined : v))
    .optional(),
  severity: z.enum(["MILD", "MODERATE", "SEVERE", "UNKNOWN"]),
});

export async function addAllergy(ctx: ClinicContext, patientId: string, raw: unknown, meta: RequestMeta) {
  if (!ctx.permissions.has("emr.write")) throw new DomainError("errors.forbidden");
  const input = allergySchema.parse(raw);
  await withRecordAccess(ctx, patientId, meta, { auditView: false }, async (tx) => {
    const id = uuidv7();
    await tx.allergy.create({ data: { id, tenantId: ctx.tenant.id, patientId, ...input, recordedById: ctx.principal.user.id } });
    await auditClinic(tx, ctx, meta, { action: "allergy.recorded", entityType: "Allergy", entityId: id });
  });
}

/** Status changes instead of deletion: RESOLVED, or ENTERED_IN_ERROR for mistakes. */
export async function setClinicalStatus(ctx: ClinicContext, kind: "diagnosis" | "allergy", id: string, status: "ACTIVE" | "RESOLVED" | "ENTERED_IN_ERROR", meta: RequestMeta) {
  if (!ctx.permissions.has("emr.write")) throw new DomainError("errors.forbidden");
  const s = z.enum(["ACTIVE", "RESOLVED", "ENTERED_IN_ERROR"]).parse(status);
  const row = await inClinic(ctx, async (tx) => {
    const r = kind === "diagnosis" ? await tx.diagnosis.findUnique({ where: { id: uuid.parse(id) } }) : await tx.allergy.findUnique({ where: { id: uuid.parse(id) } });
    if (!r) throw new DomainError("errors.notFound");
    return r;
  });
  await withRecordAccess(ctx, row.patientId, meta, { auditView: false }, async (tx) => {
    if (kind === "diagnosis") await tx.diagnosis.update({ where: { id: row.id }, data: { status: s } });
    else await tx.allergy.update({ where: { id: row.id }, data: { status: s } });
    await auditClinic(tx, ctx, meta, { action: `${kind}.status_changed`, entityType: kind === "diagnosis" ? "Diagnosis" : "Allergy", entityId: row.id, metadata: { status: s } });
  });
}

export const vitalsSchema = z
  .record(z.string(), z.string())
  .transform((raw, c) => {
    const out: { kind: VitalKind; value: Prisma.Decimal }[] = [];
    for (const kind of VITAL_KINDS) {
      const v = raw[kind]?.trim().replace(",", ".");
      if (!v) continue;
      const n = Number(v);
      const spec = VITALS[kind];
      if (!/^\d{1,4}(\.\d{1,2})?$/.test(v) || n < spec.min || n > spec.max) {
        c.addIssue({ code: "custom", message: "validation.vitalRange", path: [kind] });
        continue;
      }
      out.push({ kind, value: new Prisma.Decimal(v) });
    }
    if (out.length === 0) c.addIssue({ code: "custom", message: "validation.vitalRequired", path: ["_form"] });
    return out;
  });

/** Nurses and doctors with a care relationship record vital signs (optionally within an encounter). */
export async function recordVitals(ctx: ClinicContext, patientId: string, raw: unknown, meta: RequestMeta, opts: { encounterId?: string } = {}) {
  if (!ctx.permissions.has("vitals.write")) throw new DomainError("errors.forbidden");
  const values = vitalsSchema.parse(raw);
  if (!ctx.permissions.has("emr.read")) {
    // Front desk measuring before the visit (vitals.write without record access): write only,
    // nothing of the record is read, and only for a patient with a visit today in one of the
    // person's branches. Visit-bound measurements stay with clinical staff.
    if (opts.encounterId) throw new DomainError("errors.forbidden");
    await inClinic(ctx, async (tx) => {
      const tz = ctx.tenant.timezone;
      const today = instantToLocalDate(new Date(), tz);
      const visits = await tx.appointment.findMany({
        where: { patientId, status: { in: ["BOOKED", "CHECKED_IN", "IN_PROGRESS"] }, startsAt: { gte: localToInstant(today, 0, tz), lt: localToInstant(addDays(today, 1), 0, tz) } },
        select: { branchId: true },
      });
      if (!visits.some((v) => canUseBranch(ctx, v.branchId))) throw new DomainError("errors.noCareRelationship");
      const measuredAt = new Date();
      await tx.vitalSign.createMany({
        data: values.map((v) => ({ id: uuidv7(), tenantId: ctx.tenant.id, patientId, kind: v.kind, value: v.value, unit: VITALS[v.kind].unit, measuredAt, recordedById: ctx.principal.user.id })),
      });
      await auditClinic(tx, ctx, meta, { action: "vitals.recorded", entityType: "Patient", entityId: patientId, metadata: { count: values.length, desk: true } });
    });
    return;
  }
  await withRecordAccess(ctx, patientId, meta, { auditView: false }, async (tx) => {
    if (opts.encounterId) {
      const e = await loadEncounter(tx, opts.encounterId);
      if (e.patientId !== patientId || e.status !== "OPEN") throw new DomainError("errors.encounterClosed");
    }
    const measuredAt = new Date();
    await tx.vitalSign.createMany({
      data: values.map((v) => ({ id: uuidv7(), tenantId: ctx.tenant.id, patientId, encounterId: opts.encounterId, kind: v.kind, value: v.value, unit: VITALS[v.kind].unit, measuredAt, recordedById: ctx.principal.user.id })),
    });
    await auditClinic(tx, ctx, meta, { action: "vitals.recorded", entityType: "Patient", entityId: patientId, metadata: { count: values.length } });
  });
}
