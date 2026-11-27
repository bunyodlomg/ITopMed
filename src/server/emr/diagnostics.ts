import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { parseTemplateContent, parseTemplateValues, type TemplateField } from "@/lib/diagnostic-template";
import { DIAGNOSTIC_FILE_MAX_BYTES, DIAGNOSTIC_KINDS, parseDiagnosticData, sniffFileType, type DiagnosticKindKey } from "@/lib/diagnostics";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { auditClinic, branchWhere, inClinic } from "../clinic/context";
import { DomainError } from "../errors";
import { uuidv7 } from "../security/crypto";
import { withRecordAccess } from "./access";
import { loadEncounter } from "./record";
import { deskDiagnosticGate } from "./documents";
import { printsAtDesk } from "./print-rules";
import { printOnlyAtDesk } from "../clinic/policy";
import { addDays, instantToLocalDate, localToInstant } from "../scheduling/time";

/**
 * Diagnostic studies (ECG, echo, ultrasound, Holter, ABPM, stress test…):
 * values entered from the device or paper, a written conclusion, and attached
 * images / PDFs. Clinical data under the medical-record access rules; whoever
 * writes clinical notes (emr.write) - or works in the functional-diagnostics
 * room (diagnostics.record: ECG / echo / ultrasound devices, no notes) - and
 * has a care relationship may enter a result; the ultrasound or echo doctor
 * need not be the treating doctor.
 */

const uuid = z.uuid();

export const resultSchema = z.object({
  encounterId: z.union([z.literal("").transform(() => undefined), uuid]).optional(),
  kind: z.enum(DIAGNOSTIC_KINDS),
  /** A clinic diagnostic template: its fields replace the built-in ones. */
  templateId: z.union([z.literal("").transform(() => undefined), uuid]).optional(),
  title: z.string().trim().min(1, "validation.required").max(120, "validation.tooLong"),
  conclusion: z.string().trim().min(1, "validation.required").max(10_000, "validation.tooLong"),
});

/** Doctors (emr.write) or the functional-diagnostics room (diagnostics.record) enter study results. */
export const canRecordStudies = (ctx: ClinicContext) => ctx.permissions.has("emr.write") || ctx.permissions.has("diagnostics.record");

export async function addDiagnosticResult(ctx: ClinicContext, patientId: string, raw: Record<string, string>, meta: RequestMeta): Promise<string> {
  if (!canRecordStudies(ctx)) throw new DomainError("errors.forbidden");
  const input = resultSchema.parse(raw);
  let kind = input.kind as DiagnosticKindKey;
  let data: Record<string, string | number>;
  let snapshot: { name: string; fields: TemplateField[]; body: string } | null = null;
  if (input.templateId) {
    const t = await inClinic(ctx, (tx) => tx.clinicTemplate.findFirst({ where: { id: input.templateId, kind: "DIAGNOSTIC", archivedAt: null }, select: { name: true, content: true } }));
    const content = t ? parseTemplateContent(t.content) : null;
    if (!t || !content) throw new DomainError("errors.notFound");
    const parsed = parseTemplateValues(content.fields, raw);
    if (parsed.errors.length) throw new DomainError("errors.diagnosticValue");
    kind = content.study;
    data = parsed.values;
    snapshot = { name: t.name, fields: content.fields, body: content.body };
  } else {
    const parsed = parseDiagnosticData(kind, raw);
    if (parsed.errors.length) throw new DomainError("errors.diagnosticValue");
    data = parsed.data;
  }
  const id = uuidv7();
  await withRecordAccess(ctx, patientId, meta, { auditView: false }, async (tx, access) => {
    if (access.mode === "break_glass") throw new DomainError("errors.forbidden");
    if (input.encounterId) {
      const e = await loadEncounter(tx, input.encounterId);
      if (e.patientId !== patientId) throw new DomainError("errors.notFound");
    }
    await tx.diagnosticResult.create({ data: { id, tenantId: ctx.tenant.id, patientId, encounterId: input.encounterId, kind, title: input.title, data, conclusion: input.conclusion, performedById: ctx.principal.user.id, ...(snapshot ? { templateSnapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonObject } : {}) } });
    await auditClinic(tx, ctx, meta, { action: "diagnostic.recorded", entityType: "DiagnosticResult", entityId: id, metadata: { kind, template: Boolean(snapshot) } });
  });
  return id;
}

/**
 * The functional-diagnostics room's worklist: today's patients in the
 * person's branches who came in (checked in, being seen or seen), with how
 * many studies each has today. Names and times only - no clinical content.
 */
export async function studiesWorklist(ctx: ClinicContext) {
  if (!canRecordStudies(ctx)) throw new DomainError("errors.forbidden");
  const tz = ctx.tenant.timezone;
  const today = instantToLocalDate(new Date(), tz);
  const from = localToInstant(today, 0, tz);
  const to = localToInstant(addDays(today, 1), 0, tz);
  return inClinic(ctx, async (tx) => {
    const appts = await tx.appointment.findMany({
      where: { ...branchWhere(ctx), startsAt: { gte: from, lt: to }, status: { in: ["CHECKED_IN", "IN_PROGRESS", "COMPLETED"] } },
      orderBy: [{ queueNumber: "asc" }, { startsAt: "asc" }],
      take: 300,
      select: {
        id: true,
        status: true,
        startsAt: true,
        queueNumber: true,
        patient: { select: { id: true, mrn: true, lastName: true, firstName: true, middleName: true } },
        doctor: { select: { membership: { select: { user: { select: { fullName: true } } } } } },
      },
    });
    const counts = await tx.diagnosticResult.groupBy({
      by: ["patientId"],
      where: { patientId: { in: [...new Set(appts.map((a) => a.patient.id))] }, enteredInErrorAt: null, performedAt: { gte: from, lt: to } },
      _count: { _all: true },
    });
    const byPatient = new Map(counts.map((c) => [c.patientId, c._count._all]));
    return appts.map((a) => ({ ...a, studiesToday: byPatient.get(a.patient.id) ?? 0 }));
  });
}

/** One patient's studies of today (the room sees what it did today, not the whole history). */
export async function todayStudies(ctx: ClinicContext, patientId: string, meta: RequestMeta) {
  if (!canRecordStudies(ctx)) throw new DomainError("errors.forbidden");
  const tz = ctx.tenant.timezone;
  const today = instantToLocalDate(new Date(), tz);
  return withRecordAccess(ctx, patientId, meta, {}, async (tx) => {
    const patient = await tx.patient.findUniqueOrThrow({ where: { id: patientId }, select: { id: true, mrn: true, lastName: true, firstName: true, middleName: true, birthDate: true, birthYearOnly: true, sex: true } });
    const rows = await tx.diagnosticResult.findMany({
      where: { patientId, performedAt: { gte: localToInstant(today, 0, tz), lt: localToInstant(addDays(today, 1), 0, tz) } },
      orderBy: { performedAt: "asc" },
      include: { files: { select: { id: true, fileName: true, mimeType: true, sizeBytes: true }, orderBy: { createdAt: "asc" } } },
    });
    return { patient, results: rows.map((r) => ({ ...r, data: r.data as Record<string, string | number> })) };
  });
}

export async function listDiagnosticResults(ctx: ClinicContext, patientId: string, meta: RequestMeta) {
  return withRecordAccess(ctx, patientId, meta, { auditView: false }, async (tx) => {
    const rows = await tx.diagnosticResult.findMany({
      where: { patientId },
      orderBy: { performedAt: "desc" },
      take: 100,
      include: { files: { select: { id: true, fileName: true, mimeType: true, sizeBytes: true }, orderBy: { createdAt: "asc" } } },
    });
    const names = new Map((await tx.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.performedById))] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return rows.map((r) => ({ ...r, data: r.data as Record<string, string | number>, performedByName: names.get(r.performedById) ?? "—" }));
  });
}

async function loadResult(ctx: ClinicContext, resultId: string) {
  if (!uuid.safeParse(resultId).success) throw new DomainError("errors.notFound");
  const r = await inClinic(ctx, (tx) => tx.diagnosticResult.findUnique({ where: { id: resultId }, select: { id: true, patientId: true, performedById: true, enteredInErrorAt: true, performedAt: true } }));
  if (!r) throw new DomainError("errors.notFound");
  return r;
}

/**
 * The desk prints a diagnostic report without record access: only a valid
 * report performed today, once the patient's bills are settled.
 */
async function assertDeskMayPrint(ctx: ClinicContext, r: Awaited<ReturnType<typeof loadResult>>) {
  if (r.enteredInErrorAt) throw new DomainError("errors.notFound");
  const gate = await deskDiagnosticGate(ctx, r.patientId, r.performedAt);
  if (gate !== "ok") throw new DomainError(`errors.deskPrint.${gate}`);
}

/**
 * One result with everything needed to print it. Printing is audited. The
 * doctor prints under the record rules; the desk (or everyone, when the clinic
 * prints only at the desk) under the desk rules.
 */
export async function diagnosticForPrint(ctx: ClinicContext, resultId: string, meta: RequestMeta, opts?: { via?: "print" | "telegram" }) {
  if (!ctx.permissions.has("emr.read") && !ctx.permissions.has("documents.print")) throw new DomainError("errors.forbidden");
  const r = await loadResult(ctx, resultId);
  const desk = await printsAtDesk(ctx, ctx.permissions.has("emr.read"));
  if (desk) await assertDeskMayPrint(ctx, r);
  const load = async (tx: Prisma.TransactionClient) => {
    const result = await tx.diagnosticResult.findUniqueOrThrow({ where: { id: resultId }, include: { files: { select: { id: true, fileName: true, mimeType: true } } } });
    const patient = await tx.patient.findUniqueOrThrow({ where: { id: r.patientId }, select: { mrn: true, lastName: true, firstName: true, middleName: true, birthDate: true, birthYearOnly: true, sex: true } });
    const author = await tx.user.findUnique({ where: { id: result.performedById }, select: { fullName: true } });
    await auditClinic(tx, ctx, meta, { action: opts?.via === "telegram" ? "diagnostic.sent_telegram" : desk ? "diagnostic.printed_at_desk" : "diagnostic.printed", entityType: "DiagnosticResult", entityId: resultId });
    return { result: { ...result, data: result.data as Record<string, string | number> }, patient, authorName: author?.fullName ?? "—" };
  };
  return desk ? inClinic(ctx, load) : withRecordAccess(ctx, r.patientId, meta, { auditView: false }, load);
}

/** A wrong result is not deleted: it is marked "entered in error" by its author. */
export async function markDiagnosticError(ctx: ClinicContext, resultId: string, meta: RequestMeta) {
  const r = await loadResult(ctx, resultId);
  if (r.performedById !== ctx.principal.user.id) throw new DomainError("errors.forbidden");
  if (r.enteredInErrorAt) return;
  await withRecordAccess(ctx, r.patientId, meta, { auditView: false }, async (tx) => {
    await tx.diagnosticResult.update({ where: { id: resultId }, data: { enteredInErrorAt: new Date() }, select: { id: true } });
    await auditClinic(tx, ctx, meta, { action: "diagnostic.entered_in_error", entityType: "DiagnosticResult", entityId: resultId });
  });
}

const safeName = (name: string) =>
   
  name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").trim().slice(0, 200) || "file";

/** Attaches an image or PDF. The real type is read from the bytes; the browser's claim is ignored. */
export async function addDiagnosticFile(ctx: ClinicContext, resultId: string, file: { name: string; bytes: Uint8Array }, meta: RequestMeta): Promise<string> {
  if (!canRecordStudies(ctx)) throw new DomainError("errors.forbidden");
  if (file.bytes.length === 0 || file.bytes.length > DIAGNOSTIC_FILE_MAX_BYTES) throw new DomainError("errors.fileTooLarge");
  const mime = sniffFileType(file.bytes);
  if (!mime) throw new DomainError("errors.fileType");
  const r = await loadResult(ctx, resultId);
  if (r.enteredInErrorAt) throw new DomainError("errors.invalidTransition");
  const id = uuidv7();
  await withRecordAccess(ctx, r.patientId, meta, { auditView: false }, async (tx, access) => {
    if (access.mode === "break_glass") throw new DomainError("errors.forbidden");
    if ((await tx.diagnosticFile.count({ where: { resultId } })) >= 20) throw new DomainError("errors.tooManyFiles");
    await tx.diagnosticFile.create({
      data: { id, tenantId: ctx.tenant.id, resultId, fileName: safeName(file.name), mimeType: mime, sizeBytes: file.bytes.length, sha256: createHash("sha256").update(file.bytes).digest("hex"), content: Buffer.from(file.bytes), uploadedById: ctx.principal.user.id },
      select: { id: true },
    });
    await auditClinic(tx, ctx, meta, { action: "diagnostic.file_added", entityType: "DiagnosticResult", entityId: resultId, metadata: { mime, sizeBytes: file.bytes.length } });
  });
  return id;
}

/** File content for viewing; access follows the record rules and is audited. */
export async function getDiagnosticFile(ctx: ClinicContext, fileId: string, meta: RequestMeta) {
  if (!uuid.safeParse(fileId).success) throw new DomainError("errors.notFound");
  const head = await inClinic(ctx, (tx) => tx.diagnosticFile.findUnique({ where: { id: fileId }, select: { resultId: true } }));
  if (!head) throw new DomainError("errors.notFound");
  const r = await loadResult(ctx, head.resultId);
  // The desk sees an attached image only to print the report (same rules as the report itself).
  const desk = !ctx.permissions.has("emr.read") || (ctx.permissions.has("documents.print") && (await printOnlyAtDesk(ctx)));
  if (desk) await assertDeskMayPrint(ctx, r);
  const load = async (tx: Prisma.TransactionClient) => {
    const f = await tx.diagnosticFile.findUniqueOrThrow({ where: { id: fileId }, select: { fileName: true, mimeType: true, content: true } });
    await auditClinic(tx, ctx, meta, { action: "diagnostic.file_viewed", entityType: "DiagnosticResult", entityId: head.resultId });
    return f;
  };
  return desk ? inClinic(ctx, load) : withRecordAccess(ctx, r.patientId, meta, { auditView: false }, load);
}
