import { CheckCircle2, Printer, Wallet } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { AutoRefresh } from "@/components/auto-refresh";
import { DebtPayment } from "@/components/debt-payment";
import { moneyFormatter } from "@/components/money";
import { patientName } from "@/components/patients";
import { Form, SubmitButton } from "@/components/ui/form";
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, Table, Td, Th, buttonClass } from "@/components/ui/primitives";
import { SearchBox } from "@/components/ui/search-box";
import { requireClinic } from "@/server/auth/guards";
import { listDebtors, patientAccount } from "@/server/reception/desk";
import { approvePatientDebtAction, checkoutPayAction } from "../../../desk-actions";

const UUID = /^[0-9a-f-]{36}$/;

/**
 * Kassa: the patient pays everything before leaving. On the left, everyone who
 * owes (today's patients first); on the right, the chosen patient's unpaid
 * services - from the desk, the doctor, the nurse, the lab - with who added
 * each one, the total and one payment for all of it (cash, card, split or a
 * part). Money and service names only, no clinical content.
 */
export default async function CheckoutPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ q?: string; patient?: string; paid?: string }> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug, "billing.payment");
  const sp = await searchParams;
  const [t, format, money] = await Promise.all([getTranslations(), getFormatter(), moneyFormatter()]);
  const tz = ctx.tenant.timezone;
  const base = `/c/${ctx.tenant.slug}/checkout`;
  const patientId = sp.patient && UUID.test(sp.patient) ? sp.patient : undefined;
  const [debtors, account] = await Promise.all([listDebtors(ctx, { q: sp.q }), patientId ? patientAccount(ctx, patientId) : Promise.resolve(null)]);
  const todayCount = debtors.filter((d) => d.today).length;
  const keepQ = sp.q ? `&q=${encodeURIComponent(sp.q)}` : "";
  const paidMsg = sp.paid && /^[\d ]{1,20}$/.test(sp.paid) ? sp.paid : null;

  return (
    <div className="space-y-6">
      <AutoRefresh seconds={30} />
      <PageHeader title={t("clinic.checkout.title")} description={t("clinic.checkout.subtitle")} count={debtors.length} />

      <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
        <Card className="h-fit min-w-0">
          <CardHeader title={t("clinic.checkout.owing")} description={todayCount ? t("clinic.checkout.todayCount", { count: todayCount }) : undefined} />
          <CardBody className="space-y-3">
            <SearchBox placeholder={t("clinic.checkout.search")} label={t("common.search")} clearLabel={t("common.clearSearch")} />
          </CardBody>
          {debtors.length === 0 ? (
            <EmptyState icon={<Wallet className="size-6" />} title={t("clinic.checkout.nobody")} />
          ) : (
            <ul className="max-h-[70vh] divide-y divide-border overflow-y-auto border-t border-border" tabIndex={0} aria-label={t("clinic.checkout.owing")}>
              {debtors.map((d) => {
                const on = d.patient.id === patientId;
                return (
                  <li key={d.patient.id}>
                    <Link
                      href={`${base}?patient=${d.patient.id}${keepQ}`}
                      aria-current={on ? "true" : undefined}
                      className={`flex items-center justify-between gap-3 px-5 py-3 ${on ? "bg-accent-soft" : "hover:bg-surface-2"}`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] font-semibold">{patientName(d.patient)}</span>
                        <span className="block truncate text-[12.5px] text-text-2">
                          {d.patient.mrn} · {t("clinic.checkout.services", { count: d.lines })}
                          {d.today ? ` · ${t("clinic.checkout.today")}` : ` · ${format.dateTime(d.lastAt, { dateStyle: "short", timeZone: tz })}`}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <span className="text-[15px] font-bold tabular-nums text-danger">{money(d.owedMinor, d.currency)}</span>
                        {d.approved ? <Badge tone="warning">{t("clinic.checkout.approvedShort")}</Badge> : null}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="min-w-0 space-y-6">
          {paidMsg ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-success bg-success-soft px-5 py-4" role="status">
              <p className="flex items-center gap-2 text-[15px] font-semibold">
                <CheckCircle2 aria-hidden className="size-5 text-success" />
                {t("clinic.checkout.paidDone", { paid: paidMsg })}
              </p>
              {account ? (
                <Link href={`${base}/${account.patient.id}/receipt?w=80&print=1`} target="_blank" className={buttonClass("secondary", "md")}>
                  <Printer aria-hidden className="size-4" /> {t("clinic.checkout.printReceipt")}
                </Link>
              ) : null}
            </div>
          ) : null}

          {!account ? (
            <Card>
              <EmptyState icon={<Wallet className="size-6" />} title={t("clinic.checkout.choose")} description={t("clinic.checkout.chooseHint")} />
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader
                  title={patientName(account.patient)}
                  description={`${account.patient.mrn}${account.patient.phone ? ` · ${account.patient.phone}` : ""}`}
                  action={
                    account.paidToday.length ? (
                      <Link href={`${base}/${account.patient.id}/receipt?w=80&print=1`} target="_blank" className={buttonClass("ghost", "sm")}>
                        <Printer aria-hidden className="size-4" /> {t("clinic.checkout.todayReceipt")}
                      </Link>
                    ) : undefined
                  }
                />
                {account.open.length === 0 ? (
                  <CardBody>
                    <Alert tone="success">{t("clinic.checkout.allPaid")}</Alert>
                  </CardBody>
                ) : (
                  <>
                    <Table caption={t("clinic.checkout.unpaidServices")}>
                      <thead>
                        <tr>
                          <Th>{t("clinic.checkout.colService")}</Th>
                          <Th>{t("clinic.checkout.colAddedBy")}</Th>
                          <Th>{t("clinic.checkout.colWhen")}</Th>
                          <Th className="text-right">{t("clinic.checkout.colPrice")}</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {account.open.flatMap((inv) =>
                          inv.lines.map((l, i) => (
                            <tr key={`${inv.id}-${i}`}>
                              <Td>
                                <span className="font-medium">{l.description}</span>
                                {l.quantity > 1 ? <span className="text-text-2"> × {l.quantity}</span> : null}
                                {l.discountMinor > 0n ? <span className="block text-[12.5px] text-text-3">{t("clinic.checkout.discount", { amount: money(l.discountMinor, account.currency) })}</span> : null}
                              </Td>
                              <Td label={t("clinic.checkout.colAddedBy")}>{l.addedBy ?? "—"}</Td>
                              <Td label={t("clinic.checkout.colWhen")}>{format.dateTime(l.addedAt, { dateStyle: "short", timeStyle: "short", timeZone: tz })}</Td>
                              <Td label={t("clinic.checkout.colPrice")} className="text-right font-semibold">{money(l.totalMinor, account.currency)}</Td>
                            </tr>
                          )),
                        )}
                      </tbody>
                    </Table>
                    <CardBody className="space-y-2 border-t border-border">
                      {account.open.some((i) => i.paidMinor > 0n) ? (
                        <p className="flex justify-between gap-3 text-[14px] text-text-2">
                          <span>{t("clinic.checkout.alreadyPaid")}</span>
                          <span className="tabular-nums">{money(account.open.reduce((s, i) => s + i.paidMinor, 0n), account.currency)}</span>
                        </p>
                      ) : null}
                      <p className="flex flex-wrap items-baseline justify-between gap-3">
                        <span className="text-[15px] font-semibold">{t("clinic.checkout.toPay")}</span>
                        <span className="text-[28px] font-extrabold tabular-nums text-danger">{money(account.owedMinor, account.currency)}</span>
                      </p>
                    </CardBody>
                  </>
                )}
              </Card>

              {account.owedMinor > 0n ? (
                <Card>
                  <CardHeader title={t("clinic.checkout.payTitle")} description={t("clinic.checkout.payHint")} />
                  <CardBody className="space-y-5">
                    <Form action={checkoutPayAction} className="space-y-5">
                      <input type="hidden" name="$slug" value={ctx.tenant.slug} />
                      <input type="hidden" name="patientId" value={account.patient.id} />
                      <DebtPayment owedMinor={account.owedMinor.toString()} currency={account.currency} />
                      <SubmitButton full pendingLabel={t("clinic.checkout.paying")}>{t("clinic.checkout.pay")}</SubmitButton>
                    </Form>
                    {account.open.some((i) => !i.debtApproved) ? (
                      <details className="rounded-[12px] border border-border px-4 py-3">
                        <summary className="cursor-pointer text-[14px] font-medium">{t("clinic.checkout.leaveOwing")}</summary>
                        <Form action={approvePatientDebtAction} className="mt-3 space-y-3">
                          <input type="hidden" name="$slug" value={ctx.tenant.slug} />
                          <input type="hidden" name="patientId" value={account.patient.id} />
                          <p className="text-[13px] text-text-2">{t("clinic.checkout.leaveOwingHint")}</p>
                          <SubmitButton variant="secondary">{t("clinic.checkout.approveDebt")}</SubmitButton>
                        </Form>
                      </details>
                    ) : (
                      <Alert tone="warning">{t("clinic.checkout.approvedLong")}</Alert>
                    )}
                  </CardBody>
                </Card>
              ) : null}

              {account.paidToday.length ? (
                <Card>
                  <CardHeader title={t("clinic.checkout.paidTodayTitle")} />
                  <ul className="divide-y divide-border">
                    {account.paidToday.map((p, i) => (
                      <li key={i} className="flex flex-wrap items-center justify-between gap-3 px-6 py-2.5 text-[14px]">
                        <span className="text-text-2">
                          {format.dateTime(p.receivedAt, { timeStyle: "short", timeZone: tz })} · {t(`paymentMethod.${p.method}` as never)}
                        </span>
                        <span className="font-semibold tabular-nums">{money(p.amountMinor, account.currency)}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
