import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { Letterhead } from "@/components/letterhead";
import { moneyFormatter } from "@/components/money";
import { PAPER_PREVIEW, PaperStyle, paperFrom } from "@/components/paper";
import { patientName } from "@/components/patients";
import { AutoPrint, PrintButton } from "@/components/print-button";
import { buttonClass } from "@/components/ui/primitives";
import { requireClinic } from "@/server/auth/guards";
import { getLetterhead } from "@/server/clinic/branding";
import { patientAccount } from "@/server/reception/desk";

/**
 * One receipt for everything the patient paid today at the cashier (all
 * services from the desk, the doctor, the lab), plus what is still owed.
 * NOT a fiscal receipt. Services and amounts only - no clinical content.
 */
export default async function CheckoutReceiptPage({ params, searchParams }: { params: Promise<{ slug: string; patientId: string }>; searchParams: Promise<{ w?: string }> }) {
  const { slug, patientId } = await params;
  const width = paperFrom((await searchParams).w);
  const ctx = await requireClinic(slug, "billing.read");
  const account = await patientAccount(ctx, patientId);
  if (!account || account.paidToday.length === 0) notFound();
  const [t, format, money, head] = await Promise.all([getTranslations(), getFormatter(), moneyFormatter(), getLetterhead(ctx)]);
  const tz = ctx.tenant.timezone;
  const cur = account.currency;
  const paid = account.paidToday.reduce((s, p) => s + p.amountMinor, 0n);
  const byMethod = new Map<string, bigint>();
  for (const p of account.paidToday) byMethod.set(p.method, (byMethod.get(p.method) ?? 0n) + p.amountMinor);
  const total = account.paidTodayLines.reduce((s, l) => s + l.totalMinor, 0n);

  return (
    <div className={`mx-auto space-y-4 print:max-w-none ${width === "a4" ? "max-w-md" : PAPER_PREVIEW[width]}`}>
      <PaperStyle width={width} />
      <AutoPrint />
      <div className="flex flex-wrap justify-end gap-2 print:hidden">
        {(["80", "58", "a4"] as const).map((w) => (
          <Link key={w} href={`?w=${w}`} className={buttonClass(w === width ? "primary" : "ghost", "sm")}>
            {t(`clinic.desk.paper.${w}`)}
          </Link>
        ))}
        <PrintButton label={t("clinic.billing.printReceipt")} />
      </div>
      <article className={`rounded-[16px] border border-border bg-surface text-[14px] print:border-0 print:p-0 ${width === "a4" ? "p-6" : "p-3 text-[13px]"}`}>
        <Letterhead data={head} compact />
        {head.taxId ? <p className="pt-1 text-center text-[12px] text-text-2">STIR / ИНН {head.taxId}</p> : null}
        <div className="space-y-1 border-b border-dashed border-border py-3">
          <p className="text-center font-semibold">{t("clinic.checkout.receiptTitle")}</p>
          <p className="flex justify-between gap-3"><span className="text-text-2">{t("clinic.billing.patient")}</span><span className="text-right">{patientName(account.patient)}</span></p>
          <p className="flex justify-between gap-3"><span className="text-text-2">{t("clinic.patients.mrn")}</span><span>{account.patient.mrn}</span></p>
          <p className="flex justify-between gap-3"><span className="text-text-2">{t("clinic.checkout.date")}</span><span className="tabular-nums">{format.dateTime(new Date(), { dateStyle: "short", timeStyle: "short", timeZone: tz })}</span></p>
        </div>
        <ul className="space-y-1 border-b border-dashed border-border py-3">
          {account.paidTodayLines.map((l, i) => (
            <li key={i} className="flex justify-between gap-3">
              <span className="min-w-0 break-words">{l.description}{l.quantity > 1 ? ` × ${l.quantity}` : ""}</span>
              <span className="shrink-0 tabular-nums">{money(l.totalMinor, cur)}</span>
            </li>
          ))}
        </ul>
        <div className="space-y-1 border-b border-dashed border-border py-3">
          <p className="flex justify-between font-semibold"><span>{t("clinic.billing.total")}</span><span className="tabular-nums">{money(total, cur)}</span></p>
          {[...byMethod].map(([m, a]) => (
            <p key={m} className="flex justify-between text-text-2">
              <span>{t(`paymentMethod.${m}` as never)}</span>
              <span className="tabular-nums">{money(a, cur)}</span>
            </p>
          ))}
          <p className="flex justify-between font-semibold"><span>{t("clinic.checkout.paidTotal")}</span><span className="tabular-nums">{money(paid, cur)}</span></p>
          <p className="flex justify-between"><span>{t("clinic.billing.outstanding")}</span><span className="tabular-nums">{money(account.owedMinor, cur)}</span></p>
        </div>
        <p className="pt-3 text-center text-[12px] text-text-3">{t("clinic.billing.receiptNotFiscal")}</p>
      </article>
    </div>
  );
}
