import { notFound } from "next/navigation";
import { rxDrugLabel } from "@/lib/rx";
import { getTranslations } from "next-intl/server";
import { DocumentText } from "@/components/document-text";
import { Letterhead } from "@/components/letterhead";
import { PaperStyle } from "@/components/paper";
import { Alert } from "@/components/ui/primitives";
import { formatBirthDate, patientName } from "@/components/patients";
import { AutoPrint, PrintButton } from "@/components/print-button";
import { requireClinic } from "@/server/auth/guards";
import { getLetterhead } from "@/server/clinic/branding";
import { renderDocument } from "@/server/clinic/templates";
import { documentForVisit } from "@/server/emr/documents";
import { DomainError } from "@/server/errors";
import { requestMeta } from "@/server/http";
import { instantToLocalDate } from "@/server/scheduling/time";
import QRCode from "qrcode";
import { env } from "@/server/env";

/**
 * Prints one of the clinic's document templates for this visit (A4) on the
 * clinic letterhead. Contains no prices: payments are for the desk and doctor only.
 */
export default async function VisitDocumentPage({ params }: { params: Promise<{ slug: string; id: string; templateId: string }> }) {
  const { slug, id, templateId } = await params;
  const ctx = await requireClinic(slug);
  // Doctors (record access) or the desk (documents.print, once the cashier has settled the bill).
  if (!ctx.permissions.has("emr.read") && !ctx.permissions.has("documents.print")) notFound();
  const t = await getTranslations();
  let d: Awaited<ReturnType<typeof documentForVisit>>;
  try {
    d = await documentForVisit(ctx, id, templateId, await requestMeta());
  } catch (e) {
    if (e instanceof DomainError && e.code.startsWith("errors.deskPrint.")) {
      return (
        <div className="mx-auto max-w-xl">
          <Alert tone="warning" title={t("clinic.deskPrint.title")}>
            {t(e.code as never)}
          </Alert>
        </div>
      );
    }
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const head = await getLetterhead(ctx);
  const tz = ctx.tenant.timezone;
  const e = d.encounter;
  const active = e.diagnoses.filter((x) => x.status === "ACTIVE" || x.status === undefined);
  const dx = (kind: string) =>
    active
      .filter((x) => x.kind === kind)
      .map((x) => (x.icd10Code ? `${x.description} (${x.icd10Code})` : x.description))
      .join("; ");
  const latest = (kind: string) => [...(e.vitals ?? [])].filter((v) => v.kind === kind).sort((a, b) => +b.measuredAt - +a.measuredAt)[0]?.value.toString().replace(/\.0+$/, "");
  const sys = latest("SYSTOLIC_BP");
  const dia = latest("DIASTOLIC_BP");
  const visitYear = Number(instantToLocalDate(e.startedAt, tz).slice(0, 4));
  // Dates on medical paperwork in Uzbekistan: DD.MM.YYYY.
  const dmy = (d: Date) => instantToLocalDate(d, tz).split("-").reverse().join(".");

  const text = renderDocument(d.template.content, {
    "patient.fullName": patientName(e.patient),
    "patient.birthDate": await formatBirthDate(e.patient.birthDate, e.patient.birthYearOnly),
    "patient.mrn": e.patient.mrn,
    "patient.sex": t(`sex.${e.patient.sex}` as never),
    "patient.age": String(visitYear - e.patient.birthDate.getUTCFullYear()),
    "patient.address": e.patient.address ?? "",
    "visit.date": dmy(e.startedAt),
    "doctor.fullName": d.doctor?.membership.user.fullName ?? "",
    "doctor.specialty": d.doctor ? t(`specialties.${d.doctor.specialty}` as never) : "",
    "clinic.name": d.tenant.legalName ?? d.tenant.name,
    "clinic.address": d.tenant.address ?? "",
    "clinic.phone": d.tenant.contactPhone ?? "",
    "note.complaints": d.note?.complaints ?? "",
    "note.history": d.note?.history ?? "",
    "note.examination": d.note?.examination ?? "",
    "note.assessment": d.note?.assessment ?? "",
    "note.plan": d.note?.plan ?? "",
    diagnoses: active.map((x) => (x.icd10Code ? `${x.icd10Code} — ${x.description}` : x.description)).join("\n"),
    "diagnoses.primary": dx("PRIMARY"),
    "diagnoses.secondary": dx("SECONDARY"),
    "diagnoses.complications": dx("COMPLICATION"),
    "vitals.bp": sys ? `${sys}/${dia ?? "—"}` : "",
    "vitals.pulse": latest("HEART_RATE") ?? "",
    "vitals.weight": latest("WEIGHT") ?? "",
    "vitals.height": latest("HEIGHT") ?? "",
    prescriptions: e.prescriptions
      .filter((p) => p.status === "ACTIVE")
      .map((p, i) => `${i + 1}. ${[rxDrugLabel(p), p.dose, p.frequency, p.route, p.durationDays ? t("clinic.rx.days", { count: p.durationDays }) : null].filter(Boolean).join(" ")}`)
      .join("\n"),
    "prescriptions.schedule": intakeSchedule(e.prescriptions.filter((p) => p.status === "ACTIVE")),
    labs: d.labsToTake.map((name) => `!! ${name}`).join("\n"),
    "visit.nextVisit": e.nextVisitDate ? e.nextVisitDate.toISOString().slice(0, 10).split("-").reverse().join(".") : "",
    "doctor.phone": d.doctor?.contactPhone ?? "",
    "doctor.telegram": d.doctor?.contactTelegram ?? "",
    today: dmy(new Date()),
  });

  // Patient portal: a QR code on the paper opens the clinic's portal (results after sign-in).
  const portalUrl = ctx.modules.has("patient_portal") ? `${env().APP_URL.replace(/\/$/, "")}/p/${ctx.tenant.slug}` : null;
  const qr = portalUrl ? await QRCode.toDataURL(portalUrl, { margin: 1, width: 132, errorCorrectionLevel: "M" }) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-4 print:max-w-none">
      <PaperStyle width="a4" />
      <AutoPrint />
      <div className="flex justify-end print:hidden">
        <PrintButton label={t("clinic.rx.printNow")} />
      </div>
      <article className="space-y-5 rounded-[16px] border border-border bg-surface p-6 text-[15px] leading-relaxed print:border-0 print:p-0 print:text-[14px]">
        <Letterhead data={head} locationLabel={t("clinic.settings.locationQrLabel")} />
        <h1 className="text-center text-[19px] font-bold uppercase tracking-[0.04em]">{d.template.name}</h1>
        <DocumentText text={text} />
        {qr ? (
          <div className="flex items-center gap-3 border-t border-border pt-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt={t("templates.qrAlt")} width={88} height={88} />
            <p className="text-[12.5px] text-text-2">{t("templates.qrHint")}</p>
          </div>
        ) : null}
      </article>
    </div>
  );
}

/** "08:00 — Veroshpiron 25 mg (spironolakton), 1/2 tabletka" lines, by time of day; medicines without times are not listed here. */
function intakeSchedule(rx: { drug: string; inn: string | null; dose: string; times: string | null }[]): string {
  const byTime = new Map<string, string[]>();
  for (const p of rx) for (const time of (p.times ?? "").split(",").map((x) => x.trim()).filter(Boolean)) byTime.set(time, [...(byTime.get(time) ?? []), `${rxDrugLabel(p)}, ${p.dose}`]);
  return [...byTime.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([time, list]) => `${time} — ${list.join("; ")}`)
    .join("\n");
}
