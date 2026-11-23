import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { referenceRange } from "@/components/lab";
import { Letterhead } from "@/components/letterhead";
import { DeskPrintRefused, PaperStyle } from "@/components/paper";
import { formatBirthDate, patientName } from "@/components/patients";
import { AutoPrint, PrintButton } from "@/components/print-button";
import { requireClinic } from "@/server/auth/guards";
import { getLetterhead } from "@/server/clinic/branding";
import { DomainError } from "@/server/errors";
import { requestMeta } from "@/server/http";
import { labOrderForPrint } from "@/server/lab/lab";

/**
 * A verified lab report as an A4 page on the clinic letterhead: every test
 * with its values, units, reference ranges and ↑/↓ for values outside them.
 * Lab staff / doctors, or the desk once the bill is settled. No prices.
 */
export default async function LabReportPrintPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const ctx = await requireClinic(slug);
  const t = await getTranslations();
  let d: Awaited<ReturnType<typeof labOrderForPrint>>;
  try {
    d = await labOrderForPrint(ctx, id, await requestMeta());
  } catch (e) {
    if (e instanceof DomainError && e.code.startsWith("errors.deskPrint.")) return <DeskPrintRefused title={t("clinic.deskPrint.title")} message={t(e.code as never)} />;
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const [format, head] = await Promise.all([getFormatter(), getLetterhead(ctx)]);
  const o = d.order;
  const tz = ctx.tenant.timezone;

  return (
    <div className="mx-auto max-w-2xl space-y-4 print:max-w-none">
      <PaperStyle width="a4" />
      <AutoPrint />
      <div className="flex justify-end print:hidden">
        <PrintButton label={t("clinic.rx.printNow")} />
      </div>
      <article className="space-y-5 rounded-[16px] border border-border bg-surface p-6 text-[15px] leading-relaxed print:border-0 print:p-0 print:text-[14px]">
        <Letterhead data={head} locationLabel={t("clinic.settings.locationQrLabel")} />
        <h1 className="text-center text-[19px] font-bold uppercase tracking-[0.04em]">{t("clinic.lab.reportTitle")}</h1>
        <p>
          <span className="font-semibold">{t("diagnostics.patient")}:</span> {patientName(o.patient)}, {await formatBirthDate(o.patient.birthDate)} · {o.patient.mrn}
          <br />
          <span className="font-semibold">{t("clinic.lab.number")}:</span> {o.number}
          <br />
          <span className="font-semibold">{t("clinic.lab.orderedBy")}:</span> {o.doctor.membership.user.fullName}
          <br />
          <span className="font-semibold">{t("clinic.lab.verifiedAt")}:</span> {format.dateTime(o.verifiedAt!, { dateStyle: "medium", timeStyle: "short", timeZone: tz })}
        </p>
        {o.items.map((item) => {
          const rows = [...item.results].sort((a, b) => a.analyte.sortOrder - b.analyte.sortOrder || a.analyte.name.localeCompare(b.analyte.name));
          return (
            <section key={item.id} className="space-y-1.5">
              <h2 className="text-[16px] font-semibold">{item.name}</h2>
              {rows.length === 0 ? (
                <p className="text-text-2">—</p>
              ) : (
                <table className="w-full border-collapse text-[14px]">
                  <thead>
                    <tr className="border-b border-border text-left text-[12.5px] text-text-2">
                      <th scope="col" className="py-1 pr-3 font-medium">{t("clinic.labTests.name")}</th>
                      <th scope="col" className="py-1 pr-3 font-medium">{t("clinic.lab.value")}</th>
                      <th scope="col" className="py-1 pr-3 font-medium">{t("clinic.lab.unit")}</th>
                      <th scope="col" className="py-1 font-medium">{t("clinic.lab.reference")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-b border-border">
                        <th scope="row" className="py-1.5 pr-3 text-left font-normal">{r.analyte.name}</th>
                        <td className="py-1.5 pr-3 tabular-nums">
                          {r.flag === "NORMAL" ? (
                            r.value.toString()
                          ) : (
                            <strong className="underline">
                              {r.value.toString()} {r.flag === "HIGH" ? "↑" : "↓"}
                              <span className="sr-only"> {t(`labFlag.${r.flag}`)}</span>
                            </strong>
                          )}
                        </td>
                        <td className="py-1.5 pr-3">{r.unit}</td>
                        <td className="py-1.5 tabular-nums">{referenceRange(r.refLow, r.refHigh)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
        <p className="pt-4">
          {t("clinic.lab.verifiedBy")}: {d.verifiedBy ?? "—"} ______________
        </p>
      </article>
    </div>
  );
}
