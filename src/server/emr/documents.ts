import "server-only";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { auditClinic, inClinic } from "../clinic/context";
import { getTemplate, parseNoteContent } from "../clinic/templates";
import { DomainError } from "../errors";
import { NOTE_SECTIONS, getEncounter, loadEncounter, saveDraft } from "./record";
import { instantToLocalDate, localToInstant } from "../scheduling/time";

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
  const desk = !ctx.permissions.has("emr.read");
  const e = desk ? await deskEncounter(ctx, encounterId) : (await getEncounter(ctx, encounterId, meta)).encounter;
  const extra = await inClinic(ctx, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenant.id }, select: { name: true, legalName: true, address: true, contactPhone: true } });
    const doctor = e.doctorProfileId
      ? await tx.doctorProfile.findUnique({ where: { id: e.doctorProfileId }, select: { specialty: true, contactPhone: true, contactTelegram: true, membership: { select: { user: { select: { fullName: true } } } } } })
      : null;
    // Lab tests ordered in this visit and not yet taken: printed highlighted so the patient does not skip them.
    const labsToTake = await tx.labOrderItem.findMany({ where: { order: { encounterId: e.id, status: "ORDERED" } }, select: { name: true }, orderBy: { name: "asc" } });
    await auditClinic(tx, ctx, meta, { action: desk ? "document.printed_at_desk" : "document.printed", entityType: "Encounter", entityId: e.id, metadata: { templateId } });
    return { tenant, doctor, labsToTake: [...new Set(labsToTake.map((x) => x.name))] };
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
export async function deskPrintGate(ctx: ClinicContext, encounterId: string): Promise<"ok" | "notFinished" | "notToday" | "unpaid"> {
  if (!ctx.permissions.has("documents.print")) throw new DomainError("errors.forbidden");
  return inClinic(ctx, async (tx) => {
    const enc = await loadEncounter(tx, encounterId);
    if (enc.status !== "CLOSED") return "notFinished";
    const tz = ctx.tenant.timezone;
    const day = instantToLocalDate(enc.startedAt, tz);
    if (day !== instantToLocalDate(new Date(), tz)) return "notToday";
    const open = await tx.invoice.count({
      where: { patientId: enc.patientId, issuedAt: { gte: localToInstant(day, 0, tz) }, status: { in: ["ISSUED", "PARTIALLY_PAID"] }, debtApprovedAt: null },
    });
    return open > 0 ? "unpaid" : "ok";
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
