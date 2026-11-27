import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { DocumentText } from "@/components/document-text";
import { Letterhead } from "@/components/letterhead";
import { DeskPrintRefused, PaperStyle } from "@/components/paper";
import { formatBirthDate } from "@/components/patients";
import { AutoPrint, PrintButton } from "@/components/print-button";
import { requireClinic } from "@/server/auth/guards";
import { getLetterhead } from "@/server/clinic/branding";
import { renderDocument } from "@/server/clinic/templates";
import { documentForVisit } from "@/server/emr/documents";
import { DomainError } from "@/server/errors";
import { requestMeta } from "@/server/http";
import { visitDocumentValues, type Tr } from "@/server/papers/visit-values";
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
    if (e instanceof DomainError && e.code.startsWith("errors.deskPrint.")) return <DeskPrintRefused title={t("clinic.deskPrint.title")} message={t(e.code as never)} />;
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const head = await getLetterhead(ctx);
  const e = d.encounter;
  const text = renderDocument(d.template.content, visitDocumentValues(d, t as unknown as Tr, ctx.tenant.timezone, await formatBirthDate(e.patient.birthDate, e.patient.birthYearOnly)));

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
