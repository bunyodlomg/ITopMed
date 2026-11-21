import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { moneyFormatter } from "@/components/money";
import { Alert, Card, CardHeader, PageHeader, Stat, Table, Td, Th, buttonClass } from "@/components/ui/primitives";
import { requireClinic } from "@/server/auth/guards";
import { myEarnings } from "@/server/billing/earnings";
import { DomainError } from "@/server/errors";
import { addDays, isoWeekday, todayIn } from "@/server/scheduling/time";

const PERIODS = ["today", "week", "month"] as const;

/** A doctor's own money: received for their patients, by day, and their share at the clinic's percent. */
export default async function MyEarningsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ period?: string }> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug);
  const sp = await searchParams;
  const period = (PERIODS as readonly string[]).includes(sp.period ?? "") ? (sp.period as (typeof PERIODS)[number]) : "week";
  const today = todayIn(ctx.tenant.timezone);
  const from = period === "today" ? today : period === "week" ? addDays(today, 1 - isoWeekday(today)) : `${today.slice(0, 8)}01`;
  const data = await myEarnings(ctx, from, today).catch((e) => {
    if (e instanceof DomainError) notFound();
    throw e;
  });
  const [t, format, money] = await Promise.all([getTranslations(), getFormatter(), moneyFormatter()]);
  const te = (k: string, v?: Record<string, string | number>) => t(`clinic.earnings.${k}` as never, v as never);
  const dayLabel = (d: string) => format.dateTime(new Date(`${d}T12:00:00Z`), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

  return (
    <div className="space-y-6">
      <PageHeader title={te("title")} description={te("subtitle")} />
      <div className="flex flex-wrap gap-2">
        {PERIODS.map((p) => (
          <Link key={p} href={`?period=${p}`} className={buttonClass(p === period ? "primary" : "secondary", "sm")} aria-current={p === period ? "page" : undefined}>
            {te(`period.${p}`)}
          </Link>
        ))}
      </div>
      {data.percent === null ? <Alert tone="neutral">{te("noPercent")}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {(data.totals.length ? data.totals : [{ currency: ctx.tenant.currency, net: 0n, share: data.percent === null ? null : 0n }]).map((x) => (
          <Card key={x.currency} className="p-5">
            <Stat label={te("received")} value={money(x.net, x.currency)} />
            {x.share !== null ? <Stat label={te("share", { percent: data.percent ?? 0 })} value={money(x.share, x.currency)} /> : null}
          </Card>
        ))}
      </div>
      <Card className="overflow-hidden">
        <CardHeader title={te("byDay")} />
        {data.days.length === 0 ? (
          <p className="px-5 pb-5 text-[14px] text-text-2 sm:px-6">{te("none")}</p>
        ) : (
          <Table caption={te("byDay")}>
            <thead>
              <tr>
                <Th>{te("day")}</Th>
                <Th className="text-right">{te("payments")}</Th>
                <Th className="text-right">{te("received")}</Th>
                {data.percent !== null ? <Th className="text-right">{te("share", { percent: data.percent })}</Th> : null}
              </tr>
            </thead>
            <tbody>
              {data.days.map((d) => (
                <tr key={`${d.day}-${d.currency}`}>
                  <Td>{dayLabel(d.day)}</Td>
                  <Td label={te("payments")} className="text-right tabular-nums">{d.payments}</Td>
                  <Td label={te("received")} className="text-right tabular-nums">{money(d.net, d.currency)}</Td>
                  {data.percent !== null ? (
                    <Td label={te("share", { percent: data.percent })} className="text-right tabular-nums">
                      {money((d.net * BigInt(data.percent)) / 100n, d.currency)}
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
