import "server-only";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { auditClinic, inClinic } from "../clinic/context";
import { getTemplate, parseNoteContent } from "../clinic/templates";
import { DomainError } from "../errors";
import { NOTE_SECTIONS, getEncounter, loadEncounter, saveDraft } from "./record";
import { addDays, instantToLocalDate, localToInstant } from "../scheduling/time";
import { printOnlyAtDesk } from "../clinic/policy";
import type { Tx } from "../db";

/**
 * Applies a note template to the doctor's draft note: only EMPTY sections are
 * filled, so nothing the doctor already wrote is overwritten.
 */
export async function applyNoteTemplate(ctx: ClinicContext, encounterId: string, templateId: string, meta: RequestMeta) {
  const template = await getTemplate(ctx, templateId);
  if (template.kind !== "NOTE") throw new DomainError("errors.notFound");
  const { encounter, isOwn } = await getEncounter(ctx, encounterId, meta);
  if (!isOwn) throw new DomainError("errors.notYourPatient");
  const draft = encounter.notes.find((n) => n.status === "DRAFT" && n.authorId === ctx.principal.user.id);
  if (!draft) throw new DomainError("errors.noDraftNote");
  const fill = parseNoteContent(template.content);
  const merged = Object.fromEntries(NOTE_SECTIONS.map((s) => [s, (draft[s] ?? "").trim() ? draft[s] : fill[s]])) as Record<(typeof NOTE_SECTIONS)[number], string>;
  await saveDraft(ctx, draft.id, merged, meta);
}

/**
 * Everything a printed document may show for one visit. Access follows the
 * medical-record rules (care relationship, audited); printing is audited too.
 */
export async function documentForVisit(ctx: ClinicContext, encounterId: string, templateId: string, meta: RequestMeta) {
  const template = await getTemplate(ctx, templateId);
  if (template.kind !== "DOCUMENT") throw new DomainError("errors.notFound");
  const desk = await printsAtDesk(ctx);
  const e = desk ? await deskEncounter(ctx, encounterId) : (await getEncounter(ctx, encounterId, meta)).encounter;
  const extra = await inClinic(ctx, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenant.id }, select: { name: true, legalName: true, address: true, contactPhone: true } });
    const doctor = e.doctorProfileId
      ? await tx.doctorProfile.findUnique({ where: { id: e.doctorProfileId }, select: { specialty: true, contactPhone: true, contactTelegram: true, membership: { select: { user: { select: { fullName: true } } } } } })
      : null;
    // Lab tests ordered in this visit and not yet taken: printed highlighted so the patient does not skip them.
    const labsToTake = await labsToTakeIn(tx, e.id);
    await auditClinic(tx, ctx, meta, { action: desk ? "document.printed_at_desk" : "document.printed", entityType: "Encounter", entityId: e.id, metadata: { templateId } });
    return { tenant, doctor, labsToTake };
  });
  const note = [...e.notes].reverse().find((n) => n.status === "SIGNED") ?? e.notes[e.notes.length - 1] ?? null;
  return { template, encounter: e, note, ...extra };
}

/**
 * The desk (documents.print, no access to the medical record itself) prints a
 * finished visit's documents for the patient - only when the doctor has closed
 * the visit today and the cashier has settled the bill: every invoice of the
 * patient since the visit day is paid, void, or its debt approved by the cashier.
 */
export type DeskPrintGate = "ok" | "notFinished" | "notToday" | "unpaid";

export async function deskPrintGate(ctx: ClinicContext, encounterId: string): Promise<DeskPrintGate> {
  if (!ctx.permissions.has("documents.print")) throw new DomainError("errors.forbidden");
  return inClinic(ctx, async (tx) => {
    const enc = await loadEncounter(tx, encounterId);
    if (enc.status !== "CLOSED") return "notFinished";
    return paidGate(tx, ctx, enc.patientId, enc.startedAt);
  });
}

/** Today's papers only, and only once every bill of the patient since that day is settled (paid, void or debt approved). */
async function paidGate(tx: Tx, ctx: ClinicContext, patientId: string, at: Date): Promise<DeskPrintGate> {
  const tz = ctx.tenant.timezone;
  const day = instantToLocalDate(at, tz);
  if (day !== instantToLocalDate(new Date(), tz)) return "notToday";
  const open = await tx.invoice.count({
    where: { patientId, issuedAt: { gte: localToInstant(day, 0, tz) }, status: { in: ["ISSUED", "PARTIALLY_PAID"] }, debtApprovedAt: null },
  });
  return open > 0 ? "unpaid" : "ok";
}

/**
 * Whether this person prints through the desk rules (bill settled, today only):
 * desk staff without record access always; everyone when the clinic prints
 * only at the desk - then a doctor without documents.print cannot print at all.
 */
export async function printsAtDesk(ctx: ClinicContext): Promise<boolean> {
  const deskOnly = await printOnlyAtDesk(ctx);
  if (deskOnly && !ctx.permissions.has("documents.print")) throw new DomainError("errors.deskPrint.atDesk");
  return deskOnly || !ctx.permissions.has("emr.read");
}

/** Lab tests ordered in a visit and not yet taken (printed highlighted so the patient does not skip them). */
async function labsToTakeIn(tx: Tx, encounterId: string): Promise<string[]> {
  const rows = await tx.labOrderItem.findMany({ where: { order: { encounterId, status: "ORDERED" } }, select: { name: true }, orderBy: { name: "asc" } });
  return [...new Set(rows.map((x) => x.name))];
}

/**
 * The paper prescription of a visit. The doctor prints it under the record
 * rules; the desk (or everyone, when the clinic prints only at the desk) once
 * the visit is finished and the bill settled. Printing at the desk is audited.
 */
export async function prescriptionForPrint(ctx: ClinicContext, encounterId: string, meta: RequestMeta) {
  if (!ctx.permissions.has("emr.read") && !ctx.permissions.has("documents.print")) throw new DomainError("errors.forbidden");
  if (!(await printsAtDesk(ctx))) {
    const data = await getEncounter(ctx, encounterId, meta);
    return { encounter: data.encounter, labsToTake: [...new Set(data.labOrders.filter((o) => o.status === "ORDERED").flatMap((o) => o.items.map((i) => i.name)))] };
  }
  const encounter = await deskEncounter(ctx, encounterId);
  const labsToTake = await inClinic(ctx, async (tx) => {
    await auditClinic(tx, ctx, meta, { action: "prescription.printed_at_desk", entityType: "Encounter", entityId: encounter.id });
    return labsToTakeIn(tx, encounter.id);
  });
  return { encounter, labsToTake };
}

/** Desk rules for one diagnostic report (ultrasound, echo, ECG…): performed today, the patient's bills settled. */
export async function deskDiagnosticGate(ctx: ClinicContext, patientId: string, performedAt: Date): Promise<DeskPrintGate> {
  if (!ctx.permissions.has("documents.print")) throw new DomainError("errors.forbidden");
  return inClinic(ctx, (tx) => paidGate(tx, ctx, patientId, performedAt));
}

/**
 * What the desk can print for one of today's visits: the clinic's document
 * templates (when the visit has a record), the prescription (when there are
 * active medicines) and the patient's diagnostic reports of that day - with
 * the gate that decides whether printing is allowed now. No clinical content.
 */
export async function deskPrintables(ctx: ClinicContext, appointmentId: string) {
  if (!ctx.permissions.has("documents.print")) throw new DomainError("errors.forbidden");
  return inClinic(ctx, async (tx) => {
    const appt = await tx.appointment.findUnique({
      where: { id: appointmentId },
      select: { id: true, patientId: true, branchId: true, startsAt: true, status: true, patient: { select: { mrn: true, lastName: true, firstName: true, middleName: true } } },
    });
    if (!appt || (ctx.branchIds && !ctx.branchIds.includes(appt.branchId))) throw new DomainError("errors.notFound");
    const enc = await tx.encounter.findFirst({ where: { appointmentId }, select: { id: true, status: true, startedAt: true, _count: { select: { prescriptions: { where: { status: "ACTIVE" } } } } } });
    const tz = ctx.tenant.timezone;
    const day = instantToLocalDate(enc?.startedAt ?? appt.startsAt, tz);
    const diagnostics = await tx.diagnosticResult.findMany({
      where: { patientId: appt.patientId, enteredInErrorAt: null, performedAt: { gte: localToInstant(day, 0, tz), lt: localToInstant(addDays(day, 1), 0, tz) } },
      select: { id: true, title: true, performedAt: true },
      orderBy: { performedAt: "asc" },
    });
    const gate: DeskPrintGate = enc && enc.status !== "CLOSED" ? "notFinished" : await paidGate(tx, ctx, appt.patientId, enc?.startedAt ?? appt.startsAt);
    return { appointment: appt, encounterId: enc?.status === "CLOSED" ? enc.id : null, hasPrescription: (enc?._count.prescriptions ?? 0) > 0, diagnostics, gate };
  });
}

async function deskEncounter(ctx: ClinicContext, encounterId: string) {
  const gate = await deskPrintGate(ctx, encounterId);
  if (gate !== "ok") throw new DomainError(`errors.deskPrint.${gate}`);
  return inClinic(ctx, async (tx) => {
    const encounter = await tx.encounter.findUniqueOrThrow({
      where: { id: encounterId },
      include: {
        patient: { select: { id: true, mrn: true, lastName: true, firstName: true, middleName: true, birthDate: true, birthYearOnly: true, sex: true, address: true } },
        notes: { include: { amendments: true }, orderBy: { createdAt: "asc" } },
        diagnoses: { where: { status: { not: "ENTERED_IN_ERROR" } }, orderBy: { recordedAt: "asc" } },
        vitals: { orderBy: { measuredAt: "desc" } },
        prescriptions: { orderBy: { createdAt: "asc" } },
        appointment: { select: { id: true, status: true, startsAt: true } },
      },
    });
    const dayStart = localToInstant(instantToLocalDate(encounter.startedAt, ctx.tenant.timezone), 0, ctx.tenant.timezone);
    const deskVitals = await tx.vitalSign.findMany({ where: { patientId: encounter.patientId, encounterId: null, measuredAt: { gte: dayStart, lte: encounter.closedAt ?? new Date() } }, orderBy: { measuredAt: "desc" } });
    encounter.vitals = [...encounter.vitals, ...deskVitals].sort((a, b) => +b.measuredAt - +a.measuredAt);
    return encounter;
  });
}
