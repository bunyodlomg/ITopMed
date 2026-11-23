import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Letterhead } from "@/components/letterhead";
import { DeskPrintRefused, PaperStyle } from "@/components/paper";
import { formatBirthDate, patientName } from "@/components/patients";
import { AutoPrint, PrintButton } from "@/components/print-button";
import { DIAGNOSTIC_FIELDS, unitKey, type DiagnosticKindKey } from "@/lib/diagnostics";
import { flagOf, renderReport, type TemplateField } from "@/lib/diagnostic-template";
import { requireClinic } from "@/server/auth/guards";
import { getLetterhead } from "@/server/clinic/branding";
import { diagnosticForPrint } from "@/server/emr/diagnostics";
import { DomainError } from "@/server/errors";
import { requestMeta } from "@/server/http";

/** One diagnostic result (ECG, echo, ultrasound…) as its own A4 document on the clinic letterhead. No prices. */
export default async function DiagnosticPrintPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const ctx = await requireClinic(slug);
  // The doctor (record access) or the desk (documents.print, once the bill is settled).
  if (!ctx.permissions.has("emr.read") && !ctx.permissions.has("documents.print")) notFound();
  const t = await getTranslations();
  let d: Awaited<ReturnType<typeof diagnosticForPrint>>;
  try {
    d = await diagnosticForPrint(ctx, id, await requestMeta());
  } catch (e) {
    if (e instanceof DomainError && e.code.startsWith("errors.deskPrint.")) return <DeskPrintRefused title={t("clinic.deskPrint.title")} message={t(e.code as never)} />;
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const [format, head] = await Promise.all([getFormatter(), getLetterhead(ctx)]);
  const r = d.result;
  const fields = DIAGNOSTIC_FIELDS[r.kind as DiagnosticKindKey].filter((f) => r.data[f.key] !== undefined);
  const images = r.files.filter((f) => f.mimeType.startsWith("image/"));
  const snap = r.templateSnapshot as { fields: TemplateField[]; body: string } | null;
  const report = snap ? renderReport(snap.body, r.data as Record<string, string>) : null;
  const byKey = new Map((snap?.fields ?? []).map((f) => [f.key, f]));

  return (
    <div className="mx-auto max-w-2xl space-y-4 print:max-w-none">
      <PaperStyle width="a4" />
      <AutoPrint />
      <div className="flex justify-end print:hidden">
        <PrintButton label={t("clinic.rx.printNow")} />
      </div>
      <article className="space-y-5 rounded-[16px] border border-border bg-surface p-6 text-[15px] leading-relaxed print:border-0 print:p-0 print:text-[14px]">
        <Letterhead data={head} locationLabel={t("clinic.settings.locationQrLabel")} />
        <h1 className="text-center text-[19px] font-bold uppercase tracking-[0.04em]">{r.title}</h1>
        {r.enteredInErrorAt ? <p className="text-center font-semibold text-danger">{t("diagnostics.inError")}</p> : null}
        <p>
          <span className="font-semibold">{t("diagnostics.patient")}:</span> {patientName(d.patient)}, {await formatBirthDate(d.patient.birthDate, d.patient.birthYearOnly)} · {d.patient.mrn}
          <br />
          <span className="font-semibold">{t("diagnostics.date")}:</span> {format.dateTime(r.performedAt, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.tenant.timezone })}
        </p>
        {report ? (
          <div className="space-y-1">
            {report.parts.map((line, i) => (
              <p key={i} className="min-h-[1em]">
                {line.map((p, j) => {
                  const flag = p.key ? flagOf(byKey.get(p.key)!, p.text) : null;
                  return flag ? (
                    <strong key={j} className="underline">{p.text} {flag === "HIGH" ? "↑" : "↓"}</strong>
                  ) : p.key ? (
                    <span key={j} className="font-semibold">{p.text}</span>
                  ) : (
                    <span key={j}>{p.text}</span>
                  );
                })}
              </p>
            ))}
          </div>
        ) : fields.length ? (
          <table className="w-full border-collapse text-[14px]">
            <tbody>
              {fields.map((f) => (
                <tr key={f.key} className="border-b border-border">
                  <th scope="row" className="py-1.5 pr-3 text-left font-medium">{t(`diagnostics.field.${f.key}` as never)}</th>
                  <td className="py-1.5">
                    {String(r.data[f.key])}
                    {f.type === "number" && f.unit ? ` ${t(`diagnostics.unit.${unitKey(f.unit)}` as never)}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <div>
          <p className="font-semibold">{t("diagnostics.conclusion")}:</p>
          <p className="whitespace-pre-wrap">{r.conclusion}</p>
        </div>
        {images.length ? (
          <div className="grid grid-cols-2 gap-3">
            {images.map((f) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={f.id} src={`/c/${slug}/diagnostics/files/${f.id}`} alt={t("diagnostics.image")} className="w-full rounded-[8px] border border-border" />
            ))}
          </div>
        ) : null}
        <p className="pt-4">
          {t("diagnostics.performedBy")}: {d.authorName} ______________
        </p>
      </article>
    </div>
  );
}
