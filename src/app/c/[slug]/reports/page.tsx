import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { moneyFormatter } from "@/components/money";
import { Card, CardBody, CardHeader, PageHeader, Stat, buttonClass } from "@/components/ui/primitives";
import { requireClinic } from "@/server/auth/guards";
import { financialReport, operationalReport } from "@/server/billing/reports";
import { doctorsEarnings } from "@/server/billing/earnings";
import { addDays, isLocalDate, todayIn } from "@/server/scheduling/time";

/**
 * Period reports. One chart only (net payments per day, a single series in the
 * accent colour, native hover tooltip per bar, table below as the accessible
 * view); everything else is numbers and ranked lists.
 */
export default async function ReportsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ from?: string; to?: string }> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug);
  const canFinance = ctx.permissions.has("finance.reports");
  const canOps = canFinance || ctx.permissions.has("reports.operational");
  const t = await getTranslations();
  if (!canOps) return <p className="text-text-2">{t("errors.forbidden")}</p>;
  const [format, money] = await Promise.all([getFormatter(), moneyFormatter()]);
  const sp = await searchParams;
  const today = todayIn(ctx.tenant.timezone);
  const to = isLocalDate(sp.to) ? sp.to : today;
  const from = isLocalDate(sp.from) && sp.from <= to ? sp.from : addDays(to, -29);
  const [fin, ops, shares] = await Promise.all([canFinance ? financialReport(ctx, from, to) : null, operationalReport(ctx, from, to), canFinance ? doctorsEarnings(ctx, from, to) : []]);
  const dayLabel = (d: string) => format.dateTime(new Date(`${d}T12:00:00Z`), { day: "numeric", month: "short", timeZone: "UTC" });
  const presets = [
    { label: "1", from: today },
    { label: "7", from: addDays(today, -6) },
    { label: "30", from: addDays(today, -29) },
    { label: "90", from: addDays(today, -89) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("clinic.reports.title")}
        description={t("clinic.reports.subtitle")}
        action={
          <form method="get" className="flex flex-wrap items-end gap-2">
            <label className="text-[12px] text-text-3">
              {t("clinic.reports.from")}
              <input type="date" name="from" defaultValue={from} className="mt-1 block h-10 rounded-[var(--radius-control)] border border-border-strong bg-surface px-2 text-[14px] text-text" />
            </label>
            <label className="text-[12px] text-text-3">
              {t("clinic.reports.to")}
              <input type="date" name="to" defaultValue={to} className="mt-1 block h-10 rounded-[var(--radius-control)] border border-border-strong bg-surface px-2 text-[14px] text-text" />
            </label>
            <button className={buttonClass("secondary")}>{t("clinic.reports.show")}</button>
          </form>
        }
      />
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <Link key={p.label} href={`?from=${p.from}&to=${today}`} className={buttonClass(from === p.from && to === today ? "primary" : "secondary", "sm")}>
            {p.label === "1" ? t("clinic.reports.today") : t("clinic.reports.lastDays", { days: Number(p.label) })}
          </Link>
        ))}
      </div>

      {fin ? (
        <section className="space-y-4" aria-labelledby="fin-h">
          <h2 id="fin-h" className="text-[18px] font-semibold">{t("clinic.reports.finance")}</h2>
          {fin.totals.length === 0 ? <p className="text-[14px] text-text-2">{t("clinic.reports.empty")}</p> : null}
          {fin.totals.map((c) => {
            const net = c.received - c.refunded;
            return (
              <div key={c.currency} className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-5">
                <Stat label={`${t("clinic.reports.net")} · ${c.currency}`} value={money(net, c.currency)} />
                <Stat label={t("clinic.reports.invoiced")} value={money(c.invoiced, c.currency)} />
                <Stat label={t("clinic.reports.refunded")} value={money(c.refunded, c.currency)} />
                <Stat label={t("clinic.reports.expenses")} value={money(c.expenses, c.currency)} />
                <Stat label={t("clinic.reports.outstanding")} value={money(c.outstanding, c.currency)} />
              </div>
            );
          })}

          {fin.totals.map((c) => {
            const days = fin.byDay.filter((d) => d.currency === c.currency);
            if (days.length === 0) return null;
            const max = days.reduce((m, d) => (d.received - d.refunded > m ? d.received - d.refunded : m), 1n);
            return (
              <Card key={`chart-${c.currency}`}>
                <CardHeader title={`${t("clinic.reports.byDay")} · ${c.currency}`} />
                <CardBody>
                  <div role="img" aria-label={`${t("clinic.reports.byDay")} · ${c.currency}`} className="flex h-40 items-end gap-[2px] border-b border-border">
                    {days.map((d) => {
                      const net = d.received - d.refunded;
                      const pct = net > 0n ? Math.max(2, Number((net * 1000n) / max) / 10) : 0;
                      return (
                        <div key={d.day} title={`${dayLabel(d.day)}: ${money(net, c.currency)}`} className="group flex h-full min-w-[6px] flex-1 items-end">
                          <div className="w-full rounded-t-[4px] bg-accent transition-opacity group-hover:opacity-80" style={{ height: `${pct}%` }} />
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-1 flex justify-between text-[11px] text-text-3">
                    <span>{dayLabel(days[0]!.day)}</span>
                    <span>{dayLabel(days.at(-1)!.day)}</span>
                  </div>
                  <details className="mt-3">
                    <summary className="cursor-pointer text-[13px] text-accent">{t("clinic.reports.dayTableCaption")}</summary>
                    <table className="mt-2 w-full text-[13px]">
                      <caption className="sr-only">{t("clinic.reports.dayTableCaption")}</caption>
                      <tbody>
                        {days.map((d) => (
                          <tr key={d.day} className="border-b border-border">
                            <td className="py-1">{dayLabel(d.day)}</td>
                            <td className="py-1 text-right tabular-nums">{money(d.received, c.currency)}</td>
                            <td className="py-1 text-right tabular-nums text-text-2">{d.refunded > 0n ? `−${money(d.refunded, c.currency)}` : ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                </CardBody>
              </Card>
            );
          })}

          <div className="grid gap-6 lg:grid-cols-2">
            <RankedList title={t("clinic.reports.byMethod")} rows={fin.byMethod.map((m) => ({ key: `${m.method}-${m.currency}`, label: t(`paymentMethod.${m.method}` as never), value: money(m.net, m.currency), sub: `${m.count}` }))} empty={t("clinic.reports.empty")} />
            <RankedList
              title={t("clinic.reports.byCashier")}
              rows={fin.byCashier.map((c, i) => ({
                key: `${i}-${c.currency}`,
                label: c.cashier,
                value: money(c.net, c.currency),
                sub: c.methods.map((m) => `${t(`paymentMethod.${m.method}` as never)}: ${money(m.net, c.currency)}`).join(" · "),
              }))}
              empty={t("clinic.reports.empty")}
            />
            <RankedList title={t("clinic.reports.byService")} rows={fin.byService.map((s) => ({ key: `${s.service}-${s.currency}`, label: s.service, value: money(s.amount, s.currency), sub: `${t("clinic.reports.qty")}: ${s.quantity}` }))} empty={t("clinic.reports.empty")} />
            <RankedList title={t("clinic.reports.byDoctor")} rows={fin.byDoctor.map((d) => ({ key: `${d.doctor}-${d.currency}`, label: d.doctor, value: money(d.amount, d.currency), sub: `${t("clinic.reports.invoices")}: ${d.invoices}` }))} empty={t("clinic.reports.empty")} />
            <RankedList
              title={t("clinic.reports.doctorShare")}
              rows={shares.map((d) => ({
                key: `${d.doctorProfileId}-${d.currency}`,
                label: d.doctor,
                value: d.share === null ? t("clinic.reports.noPercent") : money(d.share, d.currency),
                sub: `${t("clinic.reports.received")}: ${money(d.net, d.currency)}${d.percent === null ? "" : ` · ${d.percent}%`}`,
              }))}
              empty={t("clinic.reports.empty")}
            />
            <RankedList title={t("clinic.reports.expensesByCategory")} rows={fin.expensesByCategory.map((e) => ({ key: `${e.category}-${e.currency}`, label: t(`expenseCategory.${e.category}` as never), value: money(e.amount, e.currency) }))} empty={t("clinic.reports.empty")} />
          </div>

          <Card>
            <CardHeader title={t("clinic.reports.debtors")} />
            {fin.debtors.length === 0 ? (
              <CardBody><p className="text-[14px] text-text-2">{t("clinic.reports.noDebtors")}</p></CardBody>
            ) : (
              <ul className="divide-y divide-border">
                {fin.debtors.map((d) => (
                  <li key={d.invoiceId} className="flex items-center justify-between gap-3 px-6 py-2.5 text-[14px]">
                    <Link href={`/c/${ctx.tenant.slug}/billing/${d.invoiceId}`} className="min-w-0 hover:text-accent">
                      <span className="font-medium">{d.patient}</span> <span className="text-[12px] text-text-3">{d.mrn} · {d.number}</span>
                    </Link>
                    <span className="font-semibold tabular-nums">{money(d.outstanding, d.currency)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      ) : null}

      <section className="space-y-4" aria-labelledby="ops-h">
        <h2 id="ops-h" className="text-[18px] font-semibold">{t("clinic.reports.operations")}</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label={t("clinic.reports.appointments")} value={format.number(ops.appointmentsByStatus.reduce((s, x) => s + x.count, 0))} />
          <Stat label={t("clinic.reports.completed")} value={format.number(ops.appointmentsByStatus.find((s) => s.status === "COMPLETED")?.count ?? 0)} />
          <Stat label={t("clinic.reports.noShowRate")} value={ops.noShowRate === null ? "—" : format.number(ops.noShowRate, { style: "percent", maximumFractionDigits: 1 })} />
          <Stat label={t("clinic.reports.newPatients")} value={format.number(ops.newPatients)} />
        </div>
        <RankedList
          title={t("clinic.reports.byDoctor")}
          rows={ops.visitsByDoctor.map((d) => ({ key: d.doctor, label: d.doctor, value: `${d.completed}`, sub: `${t("clinic.reports.noShow")}: ${d.noShow}` }))}
          empty={t("clinic.reports.empty")}
        />
      </section>
    </div>
  );
}

function RankedList({ title, rows, empty }: { title: string; rows: { key: string; label: string; value: string; sub?: string }[]; empty: string }) {
  return (
    <Card>
      <CardHeader title={title} />
      {rows.length === 0 ? (
        <CardBody><p className="text-[14px] text-text-2">{empty}</p></CardBody>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center justify-between gap-3 px-6 py-2.5 text-[14px]">
              <span className="min-w-0">
                <span className="block truncate">{r.label}</span>
                {r.sub ? <span className="block text-[12px] text-text-3">{r.sub}</span> : null}
              </span>
              <span className="font-semibold tabular-nums">{r.value}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
