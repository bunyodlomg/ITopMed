import "server-only";
import { z } from "zod";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { auditClinic, inClinic } from "../clinic/context";
import { DomainError } from "../errors";
import { uuidv7 } from "../security/crypto";
import type { Tx } from "../db";
import { parseSchemeContent } from "@/lib/rx-scheme";
import { withRecordAccess } from "./access";
import { loadEncounter, ownOpenEncounter } from "./record";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "validation.tooLong")
    .transform((v) => (v === "" ? undefined : v))
    .optional();

export const prescriptionSchema = z.object({
  drug: z.string().trim().min(2, "validation.required").max(200, "validation.tooLong"),
  /** International non-proprietary name, printed in brackets after a trade name. */
  inn: optionalText(120),
  dose: z.string().trim().min(1, "validation.required").max(100, "validation.tooLong"),
  frequency: z.string().trim().min(1, "validation.required").max(120, "validation.tooLong"),
  route: optionalText(60),
  durationDays: z.union([z.literal("").transform(() => undefined), z.coerce.number().int("validation.invalid").min(1, "validation.durationDays").max(3650, "validation.durationDays")]).optional(),
  /** Intake times printed as a schedule, e.g. "08:00, 20:00". */
  times: z
    .string()
    .trim()
    .transform((v) => v.replace(/[;\s]+/g, ",").split(",").filter(Boolean).map((x) => (/^\d:\d\d$/.test(x) ? `0${x}` : x)))
    .refine((list) => list.length <= 8 && list.every((x) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x)), "validation.times")
    .transform((list) => (list.length ? [...new Set(list)].sort().join(", ") : undefined))
    .optional(),
  instructions: optionalText(1000),
  allergyOverride: z.boolean().default(false),
});

/**
 * Simple allergy screen: an ACTIVE recorded allergy whose substance (or a word
 * of it) appears in the medicine name, case-insensitive — allergy "Penicillin"
 * matches "Penicillin V 500 mg". It is a safety net, not a drug-interaction or
 * cross-reactivity database: the prescriber must confirm to proceed.
 */
export function allergyMatches(drug: string, substances: string[]): string[] {
  const d = drug.toLocaleLowerCase();
  return substances.filter((s) => {
    const k = s.trim().toLocaleLowerCase();
    return k.length >= 3 && (d.includes(k) || k.split(/[\s,/]+/).some((w) => w.length >= 4 && d.includes(w)));
  });
}

type PrescriptionInput = z.infer<typeof prescriptionSchema>;

/** Inserts one prescription and its audit event (caller has checked access and the open visit). */
async function insertPrescription(tx: Tx, ctx: ClinicContext, enc: { id: string; patientId: string }, input: PrescriptionInput, allergyOverride: boolean, meta: RequestMeta, schemeId?: string) {
  const id = uuidv7();
  await tx.prescription.create({
    data: {
      id,
      tenantId: ctx.tenant.id,
      patientId: enc.patientId,
      encounterId: enc.id,
      prescribedById: ctx.principal.user.id,
      drug: input.drug,
      inn: input.inn ?? null,
      dose: input.dose,
      frequency: input.frequency,
      route: input.route ?? null,
      durationDays: input.durationDays ?? null,
      times: input.times ?? null,
      instructions: input.instructions ?? null,
      allergyOverride,
    },
  });
  await auditClinic(tx, ctx, meta, { action: "prescription.created", entityType: "Prescription", entityId: id, metadata: { allergyOverride, ...(schemeId ? { schemeId } : {}) } });
  return id;
}

/** Screens the trade name and the INN: an allergy to "klopidogrel" must catch "Trombonet". */
const conflictsFor = (input: PrescriptionInput, substances: string[]) => allergyMatches([input.drug, input.inn].filter(Boolean).join(" "), substances);

/** Doctor prescribes a medicine during their own open visit. */
export async function addPrescription(ctx: ClinicContext, encounterId: string, raw: unknown, meta: RequestMeta) {
  if (!ctx.permissions.has("prescriptions.write")) throw new DomainError("errors.forbidden");
  const input = prescriptionSchema.parse(raw);
  const enc = await inClinic(ctx, (tx) => loadEncounter(tx, encounterId));
  return withRecordAccess(ctx, enc.patientId, meta, { auditView: false }, async (tx, access) => {
    await ownOpenEncounter(tx, enc.id, access.doctorProfileId);
    const allergies = await tx.allergy.findMany({ where: { patientId: enc.patientId, status: "ACTIVE" }, select: { substance: true } });
    const conflicts = conflictsFor(input, allergies.map((a) => a.substance));
    if (conflicts.length > 0 && !input.allergyOverride) throw new DomainError("errors.allergyConflict");
    const id = await insertPrescription(tx, ctx, enc, input, conflicts.length > 0, meta);
    return { id, allergyOverride: conflicts.length > 0 };
  });
}

/**
 * Applies the chosen lines of a ready-made prescription scheme to the doctor's
 * own open visit, all or nothing. Every line goes through the same validation
 * and allergy screen as a single prescription; one confirmation covers the
 * lines that match a recorded allergy (they are flagged like single ones).
 */
export async function applyPrescriptionScheme(ctx: ClinicContext, encounterId: string, templateId: string, raw: unknown, meta: RequestMeta) {
  if (!ctx.permissions.has("prescriptions.write")) throw new DomainError("errors.forbidden");
  const opts = z.object({ lines: z.array(z.coerce.number().int().min(0).max(29)), allergyOverride: z.boolean().default(false) }).parse(raw);
  if (!opts.lines.length) throw new DomainError("errors.schemeNothingChosen");
  if (!z.uuid().safeParse(templateId).success) throw new DomainError("errors.notFound");
  const enc = await inClinic(ctx, (tx) => loadEncounter(tx, encounterId));
  return withRecordAccess(ctx, enc.patientId, meta, { auditView: false }, async (tx, access) => {
    await ownOpenEncounter(tx, enc.id, access.doctorProfileId);
    const t = await tx.clinicTemplate.findFirst({ where: { id: templateId, tenantId: ctx.tenant.id, kind: "PRESCRIPTION", archivedAt: null }, select: { id: true, content: true } });
    if (!t) throw new DomainError("errors.notFound");
    const scheme = parseSchemeContent(t.content).items;
    const chosen = [...new Set(opts.lines)].sort((a, b) => a - b).map((i) => scheme[i]);
    if (chosen.some((x) => !x)) throw new DomainError("errors.invalidInput");
    const inputs = chosen.map((x) => prescriptionSchema.parse({ ...x }));
    const allergies = (await tx.allergy.findMany({ where: { patientId: enc.patientId, status: "ACTIVE" }, select: { substance: true } })).map((a) => a.substance);
    const flagged = inputs.map((x) => conflictsFor(x, allergies).length > 0);
    if (flagged.some(Boolean) && !opts.allergyOverride) throw new DomainError("errors.allergyConflict");
    for (const [i, input] of inputs.entries()) await insertPrescription(tx, ctx, enc, input, flagged[i]!, meta, t.id);
    return { count: inputs.length, allergyOverride: flagged.some(Boolean) };
  });
}

/** Mistakes are cancelled (kept for the record), never edited or deleted. Only the prescriber. */
export async function cancelPrescription(ctx: ClinicContext, prescriptionId: string, meta: RequestMeta) {
  if (!ctx.permissions.has("prescriptions.write")) throw new DomainError("errors.forbidden");
  if (!z.uuid().safeParse(prescriptionId).success) throw new DomainError("errors.notFound");
  const rx = await inClinic(ctx, (tx) => tx.prescription.findUnique({ where: { id: prescriptionId }, select: { id: true, patientId: true, prescribedById: true, status: true } }));
  if (!rx) throw new DomainError("errors.notFound");
  if (rx.prescribedById !== ctx.principal.user.id) throw new DomainError("errors.notYourPatient");
  if (rx.status !== "ACTIVE") throw new DomainError("errors.invalidTransition");
  await withRecordAccess(ctx, rx.patientId, meta, { auditView: false }, async (tx) => {
    const r = await tx.prescription.updateMany({ where: { id: rx.id, status: "ACTIVE" }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledById: ctx.principal.user.id } });
    if (r.count !== 1) throw new DomainError("errors.invalidTransition");
    await auditClinic(tx, ctx, meta, { action: "prescription.cancelled", entityType: "Prescription", entityId: rx.id });
  });
}
