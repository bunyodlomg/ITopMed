import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Letterhead } from "@/components/letterhead";
import { PaperHeading } from "@/components/paper-section";
import { DeskPrintRefused, PaperStyle } from "@/components/paper";
import { PrintButton } from "@/components/print-button";
import { summarizeDiagnoses } from "@/lib/dx-summary";
import { rxDrugLabel } from "@/lib/rx";
import { requireClinic } from "@/server/auth/guards";
import { getLetterhead } from "@/server/clinic/branding";
import { recordExtractForPrint } from "@/server/emr/documents";
import { DomainError } from "@/server/errors";
import { requestMeta } from "@/server/http";
import { birthText, dmy, fullName } from "@/server/papers/visit-values";

const SECTIONS = ["diagnoses", "allergies", "medicines", "visits", "studies", "labs", "vitals"] as const;
type Section = (typeof SECTIONS)[number];
/** Off by default: the full history of visits is long; the doctor ticks it when needed. */
const DEFAULT_OFF: Section[] = ["visits"];

/**
 * Bemor ko'chirmasi: the patient's profile on paper - every diagnosis with its
 * dates, allergies, current medicines, visits, study conclusions, lab results
 * and the latest measurements. The person printing ticks what goes on paper.
 * Doctors with a care relationship only; audited.
 */
export default async function RecordExtractPage({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<{ on?: string | string[]; all?: string }> }) {
  const { slug, id } = await params;
  const ctx = await requireClinic(slug, "emr.read");
  const sp = await searchParams;
  const t = await getTranslations();
  let r: Awaited<ReturnType<typeof recordExtractForPrint>>;
  try {
    r = await recordExtractForPrint(ctx, id, await requestMeta());
  } catch (e) {
    if (e instanceof DomainError && e.code.startsWith("errors.deskPrint.")) return <DeskPrintRefused title={t("clinic.deskPrint.title")} message={t(e.code as never)} />;
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const tz = ctx.tenant.timezone;
  const ticked = new Set(Array.isArray(sp.on) ? sp.on : sp.on ? [sp.on] : []);
  const on = (s: Section) => (sp.all ? ticked.has(s) : !DEFAULT_OFF.includes(s));
  const head = await getLetterhead(ctx);
  const dx = summarizeDiagnoses(r.diagnoses);
  const meds = r.prescriptions.filter((p) => p.status === "ACTIVE");
  const allergies = r.allergies.filter((a) => a.status === "ACTIVE");
  const labs = r.labOrders.filter((o) => o.status === "VERIFIED");
  const latest = new Map<string, { value: string; at: Date }>();
  for (const v of r.vitals) if (!latest.has(v.kind)) latest.set(v.kind, { value: v.value.toString().replace(/\.0+$/, ""), at: v.measuredAt });
  const visits = r.encounters.filter((e) => e.status === "CLOSED").slice(0, 20);
  const dxByVisit = new Map<string, string[]>();
  for (const d of r.diagnoses) if (d.encounterId && d.status !== "ENTERED_IN_ERROR") dxByVisit.set(d.encounterId, [...(dxByVisit.get(d.encounterId) ?? []), d.icd10Code ? `${d.description} (${d.icd10Code})` : d.description]);
  const available: Record<Section, boolean> = { diagnoses: dx.length > 0, allergies: allergies.length > 0, medicines: meds.length > 0, visits: visits.length > 0, studies: r.studies.length > 0, labs: labs.length > 0, vitals: latest.size > 0 };
  const show = (s: Section) => available[s] && on(s);
  const shown = SECTIONS.filter(show);
  const no = (x: Section) => shown.indexOf(x) + 1;
  const cell = "[&_td]:border [&_td]:border-text-3 [&_td]:px-1.5 [&_td]:py-1 [&_td]:align-top [&_th]:border [&_th]:border-text-3 [&_th]:bg-sunken [&_th]:px-1.5 [&_th]:py-1 [&_th]:text-left [print-color-adjust:exact]";

  return (
    <div className="mx-auto max-w-[800px] space-y-4 print:max-w-none">
      <PaperStyle width="a4" />
      <form method="get" className="space-y-3 rounded-[16px] border border-border bg-surface p-4 print:hidden">
        <p className="text-[14px] font-semibold">{t("clinic.summary.chooseTitle")}</p>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {SECTIONS.filter((s) => available[s]).map((s) => (
            <label key={s} className="flex items-center gap-2 text-[14px]">
              <input type="checkbox" name="on" value={s} defaultChecked={on(s)} className="size-4 accent-[var(--accent)]" />
              {t(`clinic.profile.section.${s}`)}
            </label>
          ))}
        </div>
        <input type="hidden" name="all" value="1" />
        <div className="flex flex-wrap justify-end gap-2">
          <button className="inline-flex min-h-10 items-center rounded-full border border-border px-4 text-[14px] font-medium hover:border-accent">{t("clinic.summary.apply")}</button>
          <PrintButton label={t("clinic.rx.printNow")} />
        </div>
      </form>

      <article className="space-y-4 rounded-[16px] border border-border bg-surface p-8 text-[14px] leading-relaxed print:border-0 print:p-0 print:text-[13px]">
        <Letterhead data={head} locationLabel={t("clinic.settings.locationQrLabel")} />
        <h1 className="text-center text-[20px] font-extrabold uppercase tracking-[0.06em]">{t("clinic.profile.extractTitle")}</h1>
        <table className={`w-full border-collapse text-[13.5px] ${cell}`}>
          <tbody>
            <tr>
              <td className="w-[22%] font-semibold">{t("clinic.summary.patient")}</td>
              <td colSpan={3} className="font-bold">{fullName(r.patient)}</td>
            </tr>
            <tr>
              <td className="font-semibold">{t("clinic.summary.birth")}</td>
              <td>{birthText(r.patient.birthDate)}</td>
              <td className="w-[18%] font-semibold">{t("clinic.summary.card")}</td>
              <td className="font-mono">{r.patient.mrn}</td>
            </tr>
            <tr>
              <td className="font-semibold">{t("clinic.summary.sex")}</td>
              <td>{t(`sex.${r.patient.sex}` as never)}</td>
              <td className="font-semibold">{t("clinic.summary.date")}</td>
              <td className="tabular-nums">{dmy(new Date(), tz)}</td>
            </tr>
          </tbody>
        </table>

        {show("diagnoses") ? (
          <section>
            <PaperHeading no={no("diagnoses")}>{t("clinic.profile.section.diagnoses")}</PaperHeading>
            <table className={`w-full border-collapse text-[13px] ${cell}`}>
              <thead>
                <tr>
                  <th>{t("clinic.profile.colDx")}</th>
                  <th className="w-20">{t("clinic.profile.colCode")}</th>
                  <th className="w-24">{t("clinic.profile.colFirst")}</th>
                  <th className="w-24">{t("clinic.profile.colLast")}</th>
                  <th className="w-24">{t("clinic.profile.colStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {dx.map((d) => (
                  <tr key={d.key}>
                    <td><span className="font-semibold">{d.description}</span>{d.stage ? `, ${d.stage}` : ""}</td>
                    <td className="font-mono">{d.icd10Code || "—"}</td>
                    <td className="tabular-nums">{dmy(d.first, tz)}</td>
                    <td className="tabular-nums">{dmy(d.last, tz)}</td>
                    <td>{t(`status.${d.status}` as never)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
        {show("allergies") ? (
          <section>
            <PaperHeading no={no("allergies")}>{t("clinic.profile.section.allergies")}</PaperHeading>
            <p className="font-semibold text-danger [print-color-adjust:exact]">{allergies.map((a) => `${a.substance} (${t(`severity.${a.severity}` as never)})`).join("; ")}</p>
          </section>
        ) : null}
        {show("medicines") ? (
          <section>
            <PaperHeading no={no("medicines")}>{t("clinic.profile.section.medicines")}</PaperHeading>
            <table className={`w-full border-collapse text-[13px] ${cell}`}>
              <thead>
                <tr>
                  <th>{t("clinic.summary.colMedicine")}</th>
                  <th>{t("clinic.summary.colDose")}</th>
                  <th>{t("clinic.summary.colHow")}</th>
                  <th>{t("clinic.summary.colTimes")}</th>
                  <th className="w-24">{t("clinic.profile.colSince")}</th>
                </tr>
              </thead>
              <tbody>
                {meds.map((p) => (
                  <tr key={p.id}>
                    <td className="font-semibold">{rxDrugLabel(p)}</td>
                    <td>{p.dose}</td>
                    <td>{[p.frequency, p.route].filter(Boolean).join(", ")}</td>
                    <td className="font-bold text-danger tabular-nums [print-color-adjust:exact]">{p.times ?? "—"}</td>
                    <td className="tabular-nums">{dmy(p.createdAt, tz)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
        {show("visits") ? (
          <section>
            <PaperHeading no={no("visits")}>{t("clinic.profile.section.visits")}</PaperHeading>
            <ol className="space-y-2">
              {visits.map((e) => {
                const note = [...e.notes].reverse().find((x) => x.status === "SIGNED");
                return (
                  <li key={e.id} className="[break-inside:avoid]">
                    <p className="font-semibold">
                      {dmy(e.startedAt, tz)} · {e.doctor.membership.user.fullName} · {t(`specialties.${e.doctor.specialty}` as never)}
                    </p>
                    {dxByVisit.get(e.id)?.length ? <p><span className="text-text-2">{t("clinic.profile.visitDx")}:</span> {dxByVisit.get(e.id)!.join("; ")}</p> : null}
                    {note?.complaints ? <p className="whitespace-pre-wrap"><span className="text-text-2">{t("noteSection.complaints")}:</span> {note.complaints}</p> : null}
                    {note?.plan ? <p className="whitespace-pre-wrap"><span className="text-text-2">{t("noteSection.plan")}:</span> {note.plan}</p> : null}
                  </li>
                );
              })}
            </ol>
          </section>
        ) : null}
        {show("studies") ? (
          <section>
            <PaperHeading no={no("studies")}>{t("clinic.profile.section.studies")}</PaperHeading>
            <ul className="space-y-1.5">
              {r.studies.slice(0, 30).map((x) => (
                <li key={x.id} className="[break-inside:avoid]">
                  <span className="font-semibold">{dmy(x.performedAt, tz)} · {x.title}:</span> <span className="whitespace-pre-wrap">{x.conclusion}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {show("labs") ? (
          <section>
            <PaperHeading no={no("labs")}>{t("clinic.profile.section.labs")}</PaperHeading>
            <ul className="space-y-1.5">
              {labs.slice(0, 20).map((o) => (
                <li key={o.id} className="[break-inside:avoid]">
                  <p className="font-semibold">{dmy(o.orderedAt, tz)} · {o.items.map((i) => i.name).join(", ")}</p>
                  <p>
                    {o.items
                      .flatMap((i) => [...i.results].sort((a, b) => a.analyte.sortOrder - b.analyte.sortOrder))
                      .map((x) => `${x.analyte.name}: ${x.value.toString().replace(/\.0+$|(\.\d*?)0+$/, "$1")} ${x.unit}${x.flag === "HIGH" ? " ↑" : x.flag === "LOW" ? " ↓" : ""}`)
                      .join("; ")}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {show("vitals") ? (
          <section>
            <PaperHeading no={no("vitals")}>{t("clinic.profile.section.vitals")}</PaperHeading>
            <ul className="grid grid-cols-2 gap-x-6 gap-y-0.5 sm:grid-cols-3 print:grid-cols-3">
              {[...latest.entries()].map(([k, v]) => (
                <li key={k} className="flex justify-between gap-2 border-b border-dotted border-text-3">
                  <span>{t(`vital.${k}` as never)}</span>
                  <span className="font-semibold tabular-nums">{v.value} {t(`vitalUnit.${k}` as never)} <span className="font-normal text-text-3">({dmy(v.at, tz)})</span></span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="space-y-4 border-t border-text-3 pt-4 [break-inside:avoid]">
          <p>
            <span className="font-semibold">{t("clinic.summary.doctor")}:</span> {r.printedBy.fullName}
            {r.printedBy.specialty ? ` · ${t(`specialties.${r.printedBy.specialty}` as never)}` : ""}
          </p>
          <div className="flex flex-wrap justify-between gap-6 text-[13px]">
            <span>{t("clinic.rx.signature")}: ______________________</span>
            <span className="text-text-3">{t("clinic.rx.stamp")}</span>
          </div>
        </footer>
      </article>
    </div>
  );
}
