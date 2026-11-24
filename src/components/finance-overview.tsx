import { Banknote, CreditCard, HandCoins, Receipt, Smartphone, TrendingUp, Undo2, Wallet } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { moneyFormatter } from "@/components/money";
import { Card, CardBody, CardHeader, Delta, Stat, buttonClass } from "@/components/ui/primitives";
import { buckets, change, methodGroup, type MethodGroup, type Period } from "@/lib/finance-period";
import type { ClinicContext } from "@/server/auth/clinic-auth";
import { financialReport, methodTotals, operationalReport } from "@/server/billing/reports";

const SERIES: { key: MethodGroup; color: string }[] = [
  { key: "cash", color: "var(--chart-cash)" },
  { key: "card", color: "var(--chart-card)" },
  { key: "other", color: "var(--chart-other)" },
];

/**
 * The dashboard's money overview (finance.reports): what came in for the chosen
 * period, split into cash / card / other, compared with the same number of days
 * before; the trend per day (or month); and who/what brought it. Figures are in
 * the clinic's currency; refunds are already taken off.
 */
export async function FinanceOverview({ ctx, period, base }: { ctx: ClinicContext; period: Period; base: string }) {
  const [t, tm, format, money] = await Promise.all([getTranslations("finance"), getTranslations(), getFormatter(), moneyFormatter()]);
  const cur = ctx.tenant.currency;
  const [fin, prev, ops] = await Promise.all([financialReport(ctx, period.from, period.to), methodTotals(ctx, period.prevFrom, period.prevTo), operationalReport(ctx, period.from, period.to)]);

  const sum = (rows: { method: string; currency: string; net: bigint; count: number }[]) => {
    const g = { cash: 0n, card: 0n, other: 0n, total: 0n, count: 0 };
    for (const r of rows) {
      if (r.currency !== cur) continue;
      g[methodGroup(r.method)] += r.net;
      g.total += r.net;
      g.count += r.count;
    }
    return g;
  };
  const now = sum(fin.byMethod);
  const before = sum(prev);
  const totals = fin.totals.find((x) => x.currency === cur);
  const expenses = totals?.expenses ?? 0n;
  const delta = (a: bigint, b: bigint) => {
    const c = change(a, b);
    return c ? <Delta value={`${c.value}%`} direction={c.direction} /> : undefined;
  };
  const share = (v: bigint) => (now.total > 0n ? Math.round((Number(v) / Number(now.total)) * 100) : 0);
  const chart = buckets(period, fin.byDayMethod.filter((r) => r.currency === cur));
  const label = (key: string) =>
    chart.unit === "day"
      ? format.dateTime(new Date(`${key}T12:00:00Z`), { day: "numeric", month: "short", timeZone: "UTC" })
      : format.dateTime(new Date(`${key}-15T12:00:00Z`), { month: "short", year: "2-digit", timeZone: "UTC" });
  const range = period.days === 1 ? label(period.from) : `${format.dateTime(new Date(`${period.from}T12:00:00Z`), { dateStyle: "medium", timeZone: "UTC" })} — ${format.dateTime(new Date(`${period.to}T12:00:00Z`), { dateStyle: "medium", timeZone: "UTC" })}`;
  const others = fin.byMethod.filter((m) => m.currency === cur && methodGroup(m.method) === "other" && m.net !== 0n);
  const completed = ops.appointmentsByStatus.find((s) => s.status === "COMPLETED")?.count ?? 0;

  return (
    <section aria-labelledby="finance-h" className="space-y-4">
      <PeriodBar period={period} base={base} t={t} range={range} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat variant="hero" label={t("total")} value={money(now.total, cur)} icon={<Wallet />} delta={deltaHero(change(now.total, before.total))} hint={t("payments", { count: now.count })} />
        <Stat label={t("cash")} value={money(now.cash, cur)} icon={<Banknote />} delta={delta(now.cash, before.cash)} hint={t("share", { pct: share(now.cash) })} />
        <Stat label={t("card")} value={money(now.card, cur)} icon={<CreditCard />} delta={delta(now.card, before.card)} hint={t("share", { pct: share(now.card) })} />
        <Stat
          label={t("other")}
          value={money(now.other, cur)}
          icon={<Smartphone />}
          delta={delta(now.other, before.other)}
          hint={others.length ? others.map((m) => `${tm(`paymentMethod.${m.method}` as never)} ${money(m.net, cur)}`).join(" · ") : t("share", { pct: share(now.other) })}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
        <Stat variant="inset" label={t("invoiced")} value={money(totals?.invoiced ?? 0n, cur)} icon={<Receipt />} />
        <Stat variant="inset" label={t("refunded")} value={money(totals?.refunded ?? 0n, cur)} icon={<Undo2 />} />
        <Stat variant="inset" label={t("expenses")} value={money(expenses, cur)} icon={<HandCoins />} />
        <Stat variant="inset" label={t("profit")} value={money(now.total - expenses, cur)} icon={<TrendingUp />} hint={t("profitHint")} />
        <Stat variant="inset" label={t("debt")} value={money(totals?.outstanding ?? 0n, cur)} hint={t("debtHint")} />
        <Stat variant="inset" label={t("avgCheck")} value={now.count ? money(now.total / BigInt(now.count), cur) : "—"} hint={t("visits", { completed, patients: ops.newPatients })} />
      </div>

      <Card>
        <CardHeader title={t("chartTitle")} description={t(chart.unit === "day" ? "chartByDay" : "chartByMonth")} />
        <CardBody>
          {now.total === 0n && chart.items.every((b) => b.cash + b.card + b.other === 0n) ? (
            <p className="text-[14px] text-text-2">{t("empty")}</p>
          ) : (
            <StackedBars
              caption={t("chartTitle")}
              names={{ cash: t("cash"), card: t("card"), other: t("other"), total: t("totalShort"), table: t("table") }}
              items={chart.items.map((b) => ({ ...b, label: label(b.key), money: (v: bigint) => money(v, cur) as unknown as string }))}
            />
          )}
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Ranked
          title={t("cashiersTitle")}
          empty={t("empty")}
          rows={fin.byCashier
            .filter((c) => c.currency === cur)
            .map((c, i) => ({
              key: `${i}`,
              label: c.cashier,
              value: money(c.net, cur),
              sub: SERIES.map((s) => {
                const v = c.methods.filter((m) => methodGroup(m.method) === s.key).reduce((a, m) => a + m.net, 0n);
                return v ? `${t(s.key)}: ${money(v, cur)}` : null;
              })
                .filter(Boolean)
                .join(" · "),
            }))}
        />
        <Ranked title={t("doctorsTitle")} empty={t("empty")} rows={fin.byDoctor.filter((d) => d.currency === cur).slice(0, 6).map((d) => ({ key: d.doctor, label: d.doctor, value: money(d.amount, cur), sub: t("invoices", { count: d.invoices }) }))} />
        <Ranked title={t("servicesTitle")} empty={t("empty")} rows={fin.byService.filter((s) => s.currency === cur).slice(0, 6).map((s) => ({ key: s.service, label: s.service, value: money(s.amount, cur), sub: t("qty", { count: s.quantity }) }))} />
      </div>

      <div className="flex justify-end">
        <Link href={`${base}/reports?from=${period.from}&to=${period.to}`} className={buttonClass("secondary", "sm")}>
          {t("fullReport")}
        </Link>
      </div>
    </section>
  );
}

function deltaHero(c: ReturnType<typeof change>) {
  if (!c) return undefined;
  return (
    <span className="rounded-[8px] bg-white/20 px-1.5 py-0.5 font-semibold">
      {c.direction === "down" ? "↓" : c.direction === "up" ? "↑" : "→"} {c.value}%
    </span>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<"finance">>>;

/** Presets as links (works without JS) and a from–to form for any range. */
function PeriodBar({ period, base, t, range }: { period: Period; base: string; t: T; range: string }) {
  const presets = ["today", "yesterday", "week", "month", "lastMonth"] as const;
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 id="finance-h" className="text-[18px] font-semibold">{t("title")}</h2>
        <p className="text-[13px] text-text-3">
          {range} · {t("vsPrev")}
        </p>
      </div>
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <nav aria-label={t("periodLabel")} className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <Link key={p} href={`${base}?fp=${p}`} aria-current={period.key === p ? "page" : undefined} className={buttonClass(period.key === p ? "primary" : "secondary", "sm")} scroll={false}>
              {t(`period.${p}`)}
            </Link>
          ))}
        </nav>
        <form method="get" action={base} className="flex flex-wrap items-end gap-1.5">
          <input type="hidden" name="fp" value="custom" />
          <label className="text-[12px] text-text-3">
            {t("from")}
            <input type="date" name="from" required defaultValue={period.from} className="mt-0.5 block h-9 rounded-[var(--radius-control)] border border-border-strong bg-surface px-2 text-[13px] text-text" />
          </label>
          <label className="text-[12px] text-text-3">
            {t("to")}
            <input type="date" name="to" required defaultValue={period.to} className="mt-0.5 block h-9 rounded-[var(--radius-control)] border border-border-strong bg-surface px-2 text-[13px] text-text" />
          </label>
          <button className={buttonClass(period.key === "custom" ? "primary" : "secondary", "sm")}>{t("show")}</button>
        </form>
      </div>
    </div>
  );
}

/**
 * Stacked bars (cash at the base, then card, then other), one per day or
 * month. A legend names the series; each bar has a hover/focus tooltip with all
 * three figures; the same numbers are in a table (screen readers, and a
 * "table view" toggle for everyone).
 */
function StackedBars({
  caption,
  names,
  items,
}: {
  caption: string;
  names: Record<MethodGroup | "total" | "table", string>;
  items: { key: string; label: string; cash: bigint; card: bigint; other: bigint; money: (v: bigint) => string }[];
}) {
  const pos = (v: bigint) => (v > 0n ? v : 0n);
  const max = items.reduce((m, b) => {
    const s = pos(b.cash) + pos(b.card) + pos(b.other);
    return s > m ? s : m;
  }, 1n);
  const pct = (v: bigint) => Number((pos(v) * 10000n) / max) / 100;
  const every = items.length > 16 ? Math.ceil(items.length / 8) : 1; // keep axis labels readable
  return (
    <figure className="space-y-3">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-text-2" aria-hidden>
        {SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[3px]" style={{ background: s.color }} />
            {names[s.key]}
          </li>
        ))}
      </ul>
      <div className="flex h-48 items-end gap-[3px] border-b border-border sm:gap-1.5" role="img" aria-label={caption}>
        {items.map((b) => {
          const total = b.cash + b.card + b.other;
          return (
            <div key={b.key} tabIndex={0} className="group relative flex h-full min-w-0 flex-1 flex-col justify-end outline-none" aria-label={`${b.label}: ${b.money(total)}`}>
              {/* 2px surface gaps between segments; the top segment carries the rounded end. */}
              <div className="flex flex-col-reverse gap-[2px] [&>*:last-child]:rounded-t-[4px]">
                {SERIES.map((s) =>
                  b[s.key] > 0n ? <div key={s.key} className="bar-grow w-full" style={{ height: `${(pct(b[s.key]) / 100) * 12}rem`, background: s.color }} /> : null,
                )}
              </div>
              <div
                role="tooltip"
                className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden w-max max-w-[14rem] -translate-x-1/2 rounded-[10px] border border-border bg-surface px-3 py-2 text-[12.5px] shadow-card group-hover:block group-focus-visible:block"
              >
                <p className="font-semibold">{b.label}</p>
                {SERIES.map((s) => (
                  <p key={s.key} className="flex items-center justify-between gap-3 tabular-nums text-text-2">
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-[2px]" style={{ background: s.color }} />
                      {names[s.key]}
                    </span>
                    <span className="text-text">{b.money(b[s.key])}</span>
                  </p>
                ))}
                <p className="mt-1 flex justify-between gap-3 border-t border-border pt-1 font-semibold tabular-nums">
                  <span>{names.total}</span>
                  <span>{b.money(total)}</span>
                </p>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex gap-[3px] sm:gap-1.5" aria-hidden>
        {items.map((b, i) => (
          <span key={b.key} className="min-w-0 flex-1 truncate text-center text-[11.5px] tabular-nums text-text-3">
            {i % every === 0 ? b.label : ""}
          </span>
        ))}
      </div>
      <details>
        <summary className="cursor-pointer text-[13px] font-medium text-accent">{names.table}</summary>
        <table className="mt-2 w-full text-[13px] tabular-nums">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border text-left text-text-3">
              <th scope="col" className="py-1 font-medium"></th>
              {SERIES.map((s) => (
                <th key={s.key} scope="col" className="py-1 text-right font-medium">{names[s.key]}</th>
              ))}
              <th scope="col" className="py-1 text-right font-medium">{names.total}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((b) => (
              <tr key={b.key} className="border-b border-border">
                <th scope="row" className="py-1 text-left font-normal">{b.label}</th>
                {SERIES.map((s) => (
                  <td key={s.key} className="py-1 text-right">{b.money(b[s.key])}</td>
                ))}
                <td className="py-1 text-right font-semibold">{b.money(b.cash + b.card + b.other)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function Ranked({ title, rows, empty }: { title: string; rows: { key: string; label: string; value: string; sub?: string }[]; empty: string }) {
  return (
    <Card>
      <CardHeader title={title} />
      {rows.length === 0 ? (
        <CardBody>
          <p className="text-[14px] text-text-2">{empty}</p>
        </CardBody>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.key} className="flex items-start justify-between gap-3 px-5 py-2.5 text-[14px]">
              <span className="min-w-0">
                <span className="block [overflow-wrap:anywhere]">{r.label}</span>
                {r.sub ? <span className="block text-[12px] text-text-3">{r.sub}</span> : null}
              </span>
              <span className="max-w-[55%] text-right font-semibold tabular-nums">{r.value}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
