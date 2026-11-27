import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import QRCode from "qrcode";
import { Letterhead } from "@/components/letterhead";
import { PaperHeading, PaperText } from "@/components/paper-section";
import { DeskPrintRefused, PaperStyle } from "@/components/paper";
import { PrintButton } from "@/components/print-button";
import { TabletFractionPicture } from "@/components/tablet-fraction";
import { rxDrugLabel } from "@/lib/rx";
import { requireClinic } from "@/server/auth/guards";
import { getLetterhead } from "@/server/clinic/branding";
import { visitSummaryForPrint } from "@/server/emr/documents";
import { env } from "@/server/env";
import { DomainError } from "@/server/errors";
import { requestMeta } from "@/server/http";
import { birthText, dmy, fullName, hm } from "@/server/papers/visit-values";

/** Sections the person printing may leave out (ticked on screen, kept in the address). */
const SECTIONS = ["complaints", "history", "examination", "vitals", "diagnoses", "studies", "medicines", "labs", "plan", "nextVisit"] as const;
type Section = (typeof SECTIONS)[number];
const VITAL_ORDER = ["SYSTOLIC_BP", "DIASTOLIC_BP", "SYSTOLIC_BP_LEFT", "DIASTOLIC_BP_LEFT", "HEART_RATE", "SPO2", "TEMPERATURE", "RESPIRATORY_RATE", "BLOOD_GLUCOSE", "WEIGHT", "HEIGHT", "WAIST"];

/**
 * "Qabul xulosasi" - the patient's paper of the visit, laid out like a Word
 * document on the clinic letterhead: who, when, complaints, examination,
 * measurements, diagnoses, study conclusions, medicines with their hours (in
 * red), tests to take (highlighted), advice and the next visit, signature and
 * stamp. The doctor's own reasoning (assessment), prices and the rest of the
 * record stay in the program. Sections can be left out before printing.
 */
export default async function VisitSummaryPage({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<{ on?: string | string[]; all?: string }> }) {
  const { slug, id } = await params;
  const ctx = await requireClinic(slug);
  if (!ctx.permissions.has("emr.read") && !ctx.permissions.has("documents.print")) notFound();
  const sp = await searchParams;
  const t = await getTranslations();
  let d: Awaited<ReturnType<typeof visitSummaryForPrint>>;
  try {
    d = await visitSummaryForPrint(ctx, id, await requestMeta());
  } catch (e) {
    if (e instanceof DomainError && e.code.startsWith("errors.deskPrint.")) return <DeskPrintRefused title={t("clinic.deskPrint.title")} message={t(e.code as never)} />;
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const tz = ctx.tenant.timezone;
  const e = d.encounter;
  // The on-screen form sends the ticked sections ("on") and the offered ones ("all"); without it everything is printed.
  const ticked = new Set(Array.isArray(sp.on) ? sp.on : sp.on ? [sp.on] : []);
  const offList = sp.all ? sp.all.split(",").filter((x) => !ticked.has(x)) : [];
  const on = (s: Section) => !offList.includes(s);
  const head = await getLetterhead(ctx);
  const note = d.note;
  const latest = new Map<string, string>();
  for (const v of [...e.vitals].sort((a, b) => +b.measuredAt - +a.measuredAt)) if (!latest.has(v.kind)) latest.set(v.kind, v.value.toString().replace(/\.0+$/, ""));
  const bp = (s: string, dd: string) => (latest.get(s) ? `${latest.get(s)}/${latest.get(dd) ?? "—"}` : null);
  const vitals: { label: string; value: string }[] = [
    ...(bp("SYSTOLIC_BP", "DIASTOLIC_BP") ? [{ label: t("clinic.summary.bpRight"), value: `${bp("SYSTOLIC_BP", "DIASTOLIC_BP")} ${t("vitalUnit.SYSTOLIC_BP")}` }] : []),
    ...(bp("SYSTOLIC_BP_LEFT", "DIASTOLIC_BP_LEFT") ? [{ label: t("clinic.summary.bpLeft"), value: `${bp("SYSTOLIC_BP_LEFT", "DIASTOLIC_BP_LEFT")} ${t("vitalUnit.SYSTOLIC_BP")}` }] : []),
    ...VITAL_ORDER.filter((k) => !k.includes("_BP") && latest.has(k)).map((k) => ({ label: t(`vital.${k}` as never), value: `${latest.get(k)} ${t(`vitalUnit.${k}` as never)}` })),
  ];
  const dx = e.diagnoses.filter((x) => x.status === "ACTIVE");
  const meds = e.prescriptions.filter((p) => p.status === "ACTIVE");
  const text = (v: string | null | undefined) => (v ?? "").trim();
  const portalUrl = ctx.modules.has("patient_portal") ? `${env().APP_URL.replace(/\/$/, "")}/p/${ctx.tenant.slug}` : null;
  const qr = portalUrl ? await QRCode.toDataURL(portalUrl, { margin: 1, width: 132, errorCorrectionLevel: "M" }) : null;
  const doctorName = d.doctor?.membership.user.fullName ?? "—";

  const available: Record<Section, boolean> = {
    complaints: Boolean(text(note?.complaints)),
    history: Boolean(text(note?.history)),
    examination: Boolean(text(note?.examination)),
    vitals: vitals.length > 0,
    diagnoses: dx.length > 0,
    studies: d.studies.length > 0,
    medicines: meds.length > 0,
    labs: d.labsToTake.length > 0,
    plan: Boolean(text(note?.plan)),
    nextVisit: Boolean(e.nextVisitDate),
  };
  const show = (s: Section) => available[s] && on(s);
  const shown = SECTIONS.filter(show);
  const no = (x: Section) => shown.indexOf(x) + 1;

  return (
    <div className="mx-auto max-w-[800px] space-y-4 print:max-w-none">
      <PaperStyle width="a4" />
      <form method="get" className="space-y-3 rounded-[16px] border border-border bg-surface p-4 print:hidden">
        <p className="text-[14px] font-semibold">{t("clinic.summary.chooseTitle")}</p>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {SECTIONS.filter((s) => available[s]).map((s) => (
            <label key={s} className="flex items-center gap-2 text-[14px]">
              <input type="checkbox" name="on" value={s} defaultChecked={on(s)} className="size-4 accent-[var(--accent)]" />
              {t(`clinic.summary.section.${s}`)}
            </label>
          ))}
        </div>
        <input type="hidden" name="all" value={SECTIONS.filter((s) => available[s]).join(",")} />
        <div className="flex flex-wrap justify-end gap-2">
          <button className="inline-flex min-h-10 items-center rounded-full border border-border px-4 text-[14px] font-medium hover:border-accent">{t("clinic.summary.apply")}</button>
          <PrintButton label={t("clinic.rx.printNow")} />
        </div>
      </form>

      <article className="space-y-4 rounded-[16px] border border-border bg-surface p-8 text-[14.5px] leading-relaxed print:border-0 print:p-0 print:text-[13.5px]">
        <Letterhead data={head} locationLabel={t("clinic.settings.locationQrLabel")} />
        <h1 className="text-center text-[20px] font-extrabold uppercase tracking-[0.06em]">{t("clinic.summary.title")}</h1>

        <table className="w-full border-collapse text-[13.5px] [&_td]:border [&_td]:border-text-3 [&_td]:px-2 [&_td]:py-1">
          <tbody>
            <tr>
              <td className="w-[22%] font-semibold">{t("clinic.summary.patient")}</td>
              <td colSpan={3} className="font-bold">{fullName(e.patient)}</td>
            </tr>
            <tr>
              <td className="font-semibold">{t("clinic.summary.birth")}</td>
              <td>{birthText(e.patient.birthDate, e.patient.birthYearOnly)}</td>
              <td className="w-[18%] font-semibold">{t("clinic.summary.sex")}</td>
              <td>{t(`sex.${e.patient.sex}` as never)}</td>
            </tr>
            <tr>
              <td className="font-semibold">{t("clinic.summary.card")}</td>
              <td className="font-mono">{e.patient.mrn}</td>
              <td className="font-semibold">{t("clinic.summary.date")}</td>
              <td className="tabular-nums">{dmy(e.startedAt, tz)} {hm(e.startedAt, tz)}</td>
            </tr>
            {e.patient.address ? (
              <tr>
                <td className="font-semibold">{t("clinic.summary.address")}</td>
                <td colSpan={3}>{e.patient.address}</td>
              </tr>
            ) : null}
            <tr>
              <td className="font-semibold">{t("clinic.summary.doctor")}</td>
              <td colSpan={3}>
                {doctorName}
                {d.doctor ? ` · ${t(`specialties.${d.doctor.specialty}` as never)}` : ""}
              </td>
            </tr>
          </tbody>
        </table>

        {show("complaints") ? (<section><PaperHeading no={no("complaints")}>{t("clinic.summary.section.complaints")}</PaperHeading><PaperText text={note?.complaints} /></section>) : null}
        {show("history") ? (<section><PaperHeading no={no("history")}>{t("clinic.summary.section.history")}</PaperHeading><PaperText text={note?.history} /></section>) : null}
        {show("examination") ? (<section><PaperHeading no={no("examination")}>{t("clinic.summary.section.examination")}</PaperHeading><PaperText text={note?.examination} /></section>) : null}
        {show("vitals") ? (
          <section>
            <PaperHeading no={no("vitals")}>{t("clinic.summary.section.vitals")}</PaperHeading>
            <ul className="grid grid-cols-2 gap-x-6 gap-y-0.5 sm:grid-cols-3 print:grid-cols-3">
              {vitals.map((v) => (
                <li key={v.label} className="flex justify-between gap-2 border-b border-dotted border-text-3">
                  <span>{v.label}</span>
                  <span className="font-semibold tabular-nums">{v.value}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {show("diagnoses") ? (
          <section>
            <PaperHeading no={no("diagnoses")}>{t("clinic.summary.section.diagnoses")}</PaperHeading>
            <ul className="space-y-1">
              {(["PRIMARY", "SECONDARY", "COMPLICATION"] as const).flatMap((k) =>
                dx
                  .filter((x) => x.kind === k)
                  .map((x) => (
                    <li key={x.id}>
                      <span className="font-semibold">{t(`diagnosisKind.${k}`)}:</span> {x.description}
                      {x.stage ? `, ${x.stage}` : ""}
                      {x.icd10Code ? <span className="font-mono"> ({x.icd10Code})</span> : null}
                    </li>
                  )),
              )}
            </ul>
          </section>
        ) : null}
        {show("studies") ? (
          <section>
            <PaperHeading no={no("studies")}>{t("clinic.summary.section.studies")}</PaperHeading>
            <ul className="space-y-1.5">
              {d.studies.map((r) => (
                <li key={r.id}>
                  <span className="font-semibold">{r.title}:</span> <span className="whitespace-pre-wrap">{r.conclusion}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[12px] text-text-2">{t("clinic.summary.studiesNote")}</p>
          </section>
        ) : null}
        {show("medicines") ? (
          <section>
            <PaperHeading no={no("medicines")}>{t("clinic.summary.section.medicines")}</PaperHeading>
            <table className="w-full border-collapse text-[13px] [&_td]:border [&_td]:border-text-3 [&_td]:px-1.5 [&_td]:py-1 [&_td]:align-top [&_th]:border [&_th]:border-text-3 [&_th]:bg-sunken [&_th]:px-1.5 [&_th]:py-1 [&_th]:text-left [print-color-adjust:exact]">
              <thead>
                <tr>
                  <th className="w-7">№</th>
                  <th>{t("clinic.summary.colMedicine")}</th>
                  <th>{t("clinic.summary.colDose")}</th>
                  <th>{t("clinic.summary.colHow")}</th>
                  <th>{t("clinic.summary.colTimes")}</th>
                  <th className="w-14">{t("clinic.summary.colDays")}</th>
                </tr>
              </thead>
              <tbody>
                {meds.map((p, i) => (
                  <tr key={p.id}>
                    <td className="text-center">{i + 1}</td>
                    <td className="font-semibold">{rxDrugLabel(p)}{p.instructions ? <span className="block font-normal text-text-2">{p.instructions}</span> : null}</td>
                    <td><TabletFractionPicture dose={p.dose} /> {p.dose}</td>
                    <td>{[p.frequency, p.route].filter(Boolean).join(", ")}</td>
                    <td>
                      <span className="flex flex-wrap gap-1">
                        {(p.times ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((time) => (
                          <span key={time} className="rounded-[5px] border-2 border-danger px-1 font-bold text-danger tabular-nums [print-color-adjust:exact] [-webkit-print-color-adjust:exact]">{time}</span>
                        ))}
                      </span>
                    </td>
                    <td className="text-center tabular-nums">{p.durationDays ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
        {show("labs") ? (
          <section>
            <PaperHeading no={no("labs")}>{t("clinic.summary.section.labs")}</PaperHeading>
            <ul className="space-y-1">
              {d.labsToTake.map((name) => (
                <li key={name} className="border-l-4 border-warning bg-warning-soft px-2 py-0.5 font-semibold [print-color-adjust:exact] [-webkit-print-color-adjust:exact]">{name}</li>
              ))}
            </ul>
          </section>
        ) : null}
        {show("plan") ? (<section><PaperHeading no={no("plan")}>{t("clinic.summary.section.plan")}</PaperHeading><PaperText text={note?.plan} /></section>) : null}
        {show("nextVisit") && e.nextVisitDate ? (
          <section>
            <PaperHeading no={no("nextVisit")}>{t("clinic.summary.section.nextVisit")}</PaperHeading>
            <p className="text-[16px] font-bold tabular-nums">{e.nextVisitDate.toISOString().slice(0, 10).split("-").reverse().join(".")}</p>
          </section>
        ) : null}

        <footer className="space-y-5 border-t border-text-3 pt-4 [break-inside:avoid]">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div className="space-y-1">
              <p>
                <span className="font-semibold">{t("clinic.summary.doctor")}:</span> {doctorName}
              </p>
              {d.doctor?.contactPhone || d.doctor?.contactTelegram ? (
                <p className="text-[13px] text-text-2">{[d.doctor.contactPhone, d.doctor.contactTelegram ? `Telegram: ${d.doctor.contactTelegram}` : null].filter(Boolean).join(" · ")}</p>
              ) : null}
              <p className="pt-4">{t("clinic.rx.signature")}: ______________________</p>
            </div>
            <div className="grid size-28 place-items-center rounded-full border border-dashed border-text-3 text-[12px] text-text-3">{t("clinic.rx.stamp")}</div>
          </div>
          {qr ? (
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- QR as a data URL */}
              <img src={qr} alt={t("templates.qrAlt")} width={76} height={76} />
              <p className="text-[12px] text-text-2">{t("templates.qrHint")}</p>
            </div>
          ) : null}
        </footer>
      </article>
    </div>
  );
}
