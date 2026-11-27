import "server-only";
import { createTranslator } from "use-intl/core";
import { DIAGNOSTIC_FIELDS, unitKey, type DiagnosticKindKey } from "@/lib/diagnostics";
import { flagOf, renderReport, type TemplateField } from "@/lib/diagnostic-template";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { getLetterhead } from "../clinic/branding";
import { inClinic } from "../clinic/context";
import { renderDocument } from "../clinic/templates";
import { diagnosticForPrint } from "../emr/diagnostics";
import { documentForVisit, prescriptionForPrint } from "../emr/documents";
import { labOrderForPrint } from "../lab/lab";
import { imageFromDataUrl, sniffImage, type Paper, type PaperBlock, type PaperKind } from "./paper";
import { birthText, dmy, fullName, hm, intakeSchedule, prescriptionLines, visitDocumentValues, type Tr } from "./visit-values";

/**
 * Builds a patient's paper (the same content as the print pages) for a PDF or
 * Word file. Every builder goes through the print services, so the same access
 * rules apply (desk rules: the visit finished today and the bill settled) and
 * the hand-over is audited ("…sent_telegram"). Texts are in the patient's
 * language when known, else the clinic's.
 */

export type PaperRef =
  | { kind: "document"; encounterId: string; templateId: string }
  | { kind: "prescription"; encounterId: string }
  | { kind: "lab"; orderId: string }
  | { kind: "study"; resultId: string };

/** A device file attached to a study (an ECG machine's own PDF): sent as it is, next to the report. */
export interface PaperAttachment {
  bytes: Uint8Array;
  mime: "application/pdf";
}

export async function paperTranslator(locale: string | null | undefined, fallback: string): Promise<{ t: Tr; locale: Locale }> {
  const l: Locale = isLocale(locale) ? locale : isLocale(fallback) ? fallback : DEFAULT_LOCALE;
  const messages = (await import(`../../../messages/${l}.json`)).default;
  const tr = createTranslator({ locale: l, messages });
  return { t: tr as unknown as Tr, locale: l };
}

async function head(ctx: ClinicContext): Promise<Paper["head"]> {
  const h = await getLetterhead(ctx);
  return { name: h.legalName ?? h.name, lines: [h.license, h.address, h.phone].filter((x): x is string => Boolean(x)), logo: imageFromDataUrl(h.logo) };
}

const strip = (n: string) => n.replace(/\.0+$/, "");

export async function buildPaper(ctx: ClinicContext, ref: PaperRef, t: Tr, meta: RequestMeta): Promise<{ paper: Paper; attachments: PaperAttachment[]; day: Date }> {
  const tz = ctx.tenant.timezone;
  const via = { via: "telegram" as const };
  const letterhead = await head(ctx);
  const mk = (kind: PaperKind, title: string, blocks: PaperBlock[], footer?: string): Paper => ({ kind, title, head: letterhead, blocks, ...(footer ? { footer } : {}) });

  if (ref.kind === "document") {
    const d = await documentForVisit(ctx, ref.encounterId, ref.templateId, meta, via);
    const e = d.encounter;
    const text = renderDocument(d.template.content, visitDocumentValues(d, t, tz, birthText(e.patient.birthDate, e.patient.birthYearOnly)));
    // "!! name" lines (lab tests to take) stand out, as on the printed page.
    const blocks: PaperBlock[] = [];
    let buf: string[] = [];
    let marks: string[] = [];
    const flush = () => {
      if (buf.length) blocks.push({ t: "text", text: buf.join("\n") });
      if (marks.length) blocks.push({ t: "highlight", lines: marks });
      buf = [];
      marks = [];
    };
    for (const line of text.split("\n")) {
      const m = /^!!\s*(.+)$/.exec(line);
      if (m) {
        if (buf.length) flush();
        marks.push(m[1]!);
      } else {
        if (marks.length) flush();
        buf.push(line);
      }
    }
    flush();
    return { paper: mk("document", d.template.name, blocks), attachments: [], day: e.startedAt };
  }

  if (ref.kind === "prescription") {
    const data = await prescriptionForPrint(ctx, ref.encounterId, meta, via);
    const e = data.encounter;
    const rx = e.prescriptions.filter((p) => p.status === "ACTIVE");
    const info = await inClinic(ctx, async (tx) =>
      e.doctorProfileId ? tx.doctorProfile.findUnique({ where: { id: e.doctorProfileId }, select: { specialty: true, licenseNumber: true, membership: { select: { user: { select: { fullName: true } } } } } }) : null,
    );
    const blocks: PaperBlock[] = [
      { t: "fields", rows: [[t("clinic.billing.patient"), fullName(e.patient)], [t("clinic.patients.birthDate"), birthText(e.patient.birthDate, e.patient.birthYearOnly)], [t("clinic.patients.mrn"), e.patient.mrn], [t("diagnostics.date"), dmy(e.startedAt, tz)]] },
    ];
    const lines = prescriptionLines(rx, t);
    rx.forEach((p, i) => {
      blocks.push({ t: "text", text: `Rp.: ${lines[i]!.replace(/^\d+\.\s*/, `${i + 1}. `)}`, bold: true });
      if (p.instructions) blocks.push({ t: "text", text: p.instructions });
    });
    const schedule = intakeSchedule(rx);
    if (schedule) blocks.push({ t: "highlight", title: t("clinic.rx.intakeTimes"), lines: schedule.split("\n") });
    if (data.labsToTake.length) blocks.push({ t: "highlight", title: t("clinic.rx.labsToTake"), lines: data.labsToTake });
    const doctor = info ? [info.membership.user.fullName, t(`specialties.${info.specialty}`), info.licenseNumber ? `${t("clinic.rx.license")} ${info.licenseNumber}` : null].filter(Boolean).join(" · ") : "—";
    blocks.push({ t: "signature", text: `${t("clinic.rx.doctor")}: ${doctor}` });
    return { paper: mk("prescription", t("clinic.rx.paperTitle"), blocks, t("clinic.rx.notElectronic")), attachments: [], day: e.startedAt };
  }

  if (ref.kind === "lab") {
    const d = await labOrderForPrint(ctx, ref.orderId, meta, via);
    const o = d.order;
    const blocks: PaperBlock[] = [
      {
        t: "fields",
        rows: [
          [t("diagnostics.patient"), `${fullName(o.patient)}, ${birthText(o.patient.birthDate)} · ${o.patient.mrn}`],
          [t("clinic.lab.number"), o.number],
          [t("clinic.lab.orderedBy"), o.doctor.membership.user.fullName],
          [t("clinic.lab.verifiedAt"), `${dmy(o.verifiedAt!, tz)} ${hm(o.verifiedAt!, tz)}`],
        ],
      },
    ];
    for (const item of o.items) {
      blocks.push({ t: "heading", text: item.name });
      const rows = [...item.results].sort((a, b) => a.analyte.sortOrder - b.analyte.sortOrder || a.analyte.name.localeCompare(b.analyte.name));
      if (!rows.length) {
        blocks.push({ t: "text", text: "—" });
        continue;
      }
      blocks.push({
        t: "table",
        head: [t("clinic.labTests.name"), t("clinic.lab.value"), t("clinic.lab.unit"), t("clinic.lab.reference")],
        rows: rows.map((r) => ({
          strong: r.flag !== "NORMAL",
          cells: [r.analyte.name, r.flag === "NORMAL" ? r.value.toString() : `${r.value.toString()} ${r.flag === "HIGH" ? "↑" : "↓"} (${t(`labFlag.${r.flag}`)})`, r.unit ?? "", range(r.refLow, r.refHigh)],
        })),
      });
    }
    blocks.push({ t: "signature", text: `${t("clinic.lab.verifiedBy")}: ${d.verifiedBy ?? "—"}` });
    return { paper: mk("lab", t("clinic.lab.reportTitle"), blocks), attachments: [], day: o.verifiedAt! };
  }

  const d = await diagnosticForPrint(ctx, ref.resultId, meta, via);
  const r = d.result;
  const blocks: PaperBlock[] = [
    { t: "fields", rows: [[t("diagnostics.patient"), `${fullName(d.patient)}, ${birthText(d.patient.birthDate, d.patient.birthYearOnly)} · ${d.patient.mrn}`], [t("diagnostics.date"), `${dmy(r.performedAt, tz)} ${hm(r.performedAt, tz)}`]] },
  ];
  const snap = r.templateSnapshot as { fields: TemplateField[]; body: string } | null;
  if (snap) {
    const byKey = new Map(snap.fields.map((f) => [f.key, f]));
    const report = renderReport(snap.body, r.data as Record<string, string>);
    const text = report.parts
      .map((line) =>
        line
          .map((p) => {
            const flag = p.key && byKey.get(p.key) ? flagOf(byKey.get(p.key)!, p.text) : null;
            return flag ? `${p.text} ${flag === "HIGH" ? "↑" : "↓"}` : p.text;
          })
          .join(""),
      )
      .join("\n");
    blocks.push({ t: "text", text });
  } else {
    const fields = DIAGNOSTIC_FIELDS[r.kind as DiagnosticKindKey].filter((f) => r.data[f.key] !== undefined);
    if (fields.length) {
      blocks.push({
        t: "table",
        head: [t("diagnostics.kindLabel"), t("clinic.lab.value")],
        rows: fields.map((f) => ({ cells: [t(`diagnostics.field.${f.key}`), `${String(r.data[f.key])}${f.type === "number" && f.unit ? ` ${t(`diagnostics.unit.${unitKey(f.unit)}`)}` : ""}`] })),
      });
    }
  }
  blocks.push({ t: "heading", text: `${t("diagnostics.conclusion")}:` }, { t: "text", text: r.conclusion });
  // The device's pictures go into the paper; its own PDFs travel next to it as they are.
  const files = await inClinic(ctx, (tx) => tx.diagnosticFile.findMany({ where: { resultId: r.id }, orderBy: { createdAt: "asc" }, select: { content: true, mimeType: true } }));
  const attachments: PaperAttachment[] = [];
  for (const f of files) {
    const bytes = new Uint8Array(f.content);
    const mime = sniffImage(bytes);
    if (mime) blocks.push({ t: "image", image: { bytes, mime } });
    else if (f.mimeType === "application/pdf") attachments.push({ bytes, mime: "application/pdf" });
  }
  blocks.push({ t: "signature", text: `${t("diagnostics.performedBy")}: ${d.authorName}` });
  return { paper: mk("study", r.title, blocks), attachments, day: r.performedAt };
}

function range(low: { toString(): string } | null, high: { toString(): string } | null) {
  if (low && high) return `${strip(low.toString())}–${strip(high.toString())}`;
  if (low) return `≥ ${strip(low.toString())}`;
  if (high) return `≤ ${strip(high.toString())}`;
  return "—";
}
