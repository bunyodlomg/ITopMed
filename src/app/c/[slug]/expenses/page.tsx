import { Plus, TrendingDown } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { moneyFormatter } from "@/components/money";
import { Drawer } from "@/components/ui/drawer";
import { Form, SelectField, SubmitButton, TextField } from "@/components/ui/form";
import { ButtonLink, Card, CardHeader, EmptyState, PageHeader, Table, Td, Th, buttonClass } from "@/components/ui/primitives";
import { FilterChips, Toolbar, hrefWith, type Chip } from "@/components/ui/toolbar";
import { requireClinic } from "@/server/auth/guards";
import { EXPENSE_CATEGORIES, listExpenses } from "@/server/billing/cash";
import { listOperationalBranches } from "@/server/clinic/context";
import { addDays, isLocalDate, todayIn } from "@/server/scheduling/time";
import { expenseAction } from "../../../billing-actions";

type Search = { from?: string; to?: string; period?: string; cat?: string; panel?: string };

/** Quick periods; a custom from/to in the URL still works (reports link here with one). */
function period(key: string | undefined, today: string): { from: string; to: string } {
  const month = today.slice(0, 7);
  if (key === "7d") return { from: addDays(today, -6), to: today };
  if (key === "month") return { from: `${month}-01`, to: today };
  if (key === "lastMonth") {
    const lastDay = addDays(`${month}-01`, -1);
    return { from: `${lastDay.slice(0, 7)}-01`, to: lastDay };
  }
  return { from: addDays(today, -29), to: today };
}

export default async function ExpensesPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Search> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug, "finance.manage");
  const sp = await searchParams;
  const today = todayIn(ctx.tenant.timezone);
  const custom = isLocalDate(sp.from) && isLocalDate(sp.to) && sp.from <= sp.to;
  const periodKey = custom ? "custom" : ["7d", "30d", "month", "lastMonth"].includes(sp.period ?? "") ? sp.period! : "30d";
  const { from, to } = custom ? { from: sp.from!, to: sp.to! } : period(periodKey, today);
  const [t, format, money, expenses, branches] = await Promise.all([getTranslations(), getFormatter(), moneyFormatter(), listExpenses(ctx, from, to), listOperationalBranches(ctx)]);
  const path = `/c/${ctx.tenant.slug}/expenses`;
  const here: Search = { from: sp.from, to: sp.to, period: sp.period, cat: sp.cat };

  const live = expenses.filter((e) => !e.voidedAt);
  const cat = EXPENSE_CATEGORIES.find((c) => c === sp.cat);
  const rows = cat ? expenses.filter((e) => e.category === cat) : expenses;
  // Totals per currency (a clinic may record some expenses in USD).
  const totals = new Map<string, bigint>();
  for (const e of rows) if (!e.voidedAt) totals.set(e.currency, (totals.get(e.currency) ?? 0n) + e.amountMinor);

  const periodChips: Chip[] = [
    { key: "7d", label: t("clinic.expenses.period7d") },
    { key: "30d", label: t("clinic.expenses.period30d") },
    { key: "month", label: t("clinic.expenses.periodMonth") },
    { key: "lastMonth", label: t("clinic.expenses.periodLastMonth") },
  ].map((p) => ({ label: p.label, href: hrefWith(path, { cat: sp.cat }, { period: p.key === "30d" ? undefined : p.key }), active: periodKey === p.key }));
  const used = EXPENSE_CATEGORIES.filter((c) => live.some((e) => e.category === c));
  const catChips: Chip[] = [
    { label: t("common.all"), count: live.length, href: hrefWith(path, here, { cat: undefined }), active: !cat },
    ...used.map((c) => ({ label: t(`expenseCategory.${c}`), count: live.filter((e) => e.category === c).length, href: hrefWith(path, here, { cat: c }), active: cat === c })),
  ];
  const range = `${format.dateTime(new Date(`${from}T12:00:00Z`), { dateStyle: "medium", timeZone: "UTC" })} — ${format.dateTime(new Date(`${to}T12:00:00Z`), { dateStyle: "medium", timeZone: "UTC" })}`;

  return (
    <>
      <PageHeader
        title={t("clinic.expenses.title")}
        description={t("clinic.expenses.subtitle")}
        action={
          <ButtonLink href={hrefWith(path, here, { panel: "new" })} scroll={false}>
            <Plus aria-hidden className="size-4" />
            {t("clinic.expenses.add")}
          </ButtonLink>
        }
      />

      <Toolbar
        filters={
          <div className="space-y-2.5">
            <FilterChips chips={periodChips} label={t("clinic.expenses.period")} />
            <FilterChips chips={catChips} label={t("clinic.expenses.category")} />
          </div>
        }
      />

      <Card className="overflow-hidden">
        <CardHeader
          title={range}
          action={
            totals.size ? (
              <p className="text-right">
                <span className="block text-[12.5px] text-text-3">{t("clinic.expenses.total")}</span>
                {[...totals.entries()].map(([cur, sum]) => (
                  <span key={cur} className="block text-[20px] font-semibold tabular-nums tracking-[-0.02em]">
                    {money(sum, cur)}
                  </span>
                ))}
              </p>
            ) : null
          }
        />
        {rows.length === 0 ? (
          <EmptyState icon={<TrendingDown className="size-6" />} title={t("clinic.expenses.empty")} />
        ) : (
          <Table caption={t("clinic.expenses.title")}>
            <thead>
              <tr>
                <Th>{t("clinic.expenses.date")}</Th>
                <Th>{t("clinic.expenses.category")}</Th>
                <Th>{t("clinic.expenses.branch")}</Th>
                <Th className="text-right">{t("clinic.expenses.amount")}</Th>
                <Th>
                  <span className="sr-only">{t("common.actions")}</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className={e.voidedAt ? "text-text-3" : undefined}>
                  <Td className="whitespace-nowrap text-text-2">{format.dateTime(e.spentOn, { dateStyle: "medium", timeZone: "UTC" })}</Td>
                  <Td>
                    <p className={e.voidedAt ? "font-medium line-through" : "font-medium"}>{t(`expenseCategory.${e.category}`)}</p>
                    {e.description ? <p className="text-[12.5px] text-text-3">{e.description}</p> : null}
                  </Td>
                  <Td label={t("clinic.expenses.branch")} className="text-text-2">
                    {e.branch?.name ?? t("clinic.expenses.allBranches")}
                  </Td>
                  <Td label={t("clinic.expenses.amount")} className={e.voidedAt ? "text-right tabular-nums line-through" : "text-right font-semibold tabular-nums"}>
                    {money(e.amountMinor, e.currency)}
                  </Td>
                  <Td className="text-right">
                    {e.voidedAt ? (
                      <span className="text-[13px]">{t("clinic.expenses.voidedBadge")}</span>
                    ) : (
                      <Form action={expenseAction} className="space-y-0">
                        <input type="hidden" name="$slug" value={ctx.tenant.slug} />
                        <input type="hidden" name="expenseId" value={e.id} />
                        <button name="op" value="void" className={buttonClass("ghost", "sm")}>
                          {t("clinic.expenses.void")}
                        </button>
                      </Form>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {sp.panel === "new" ? (
        <Drawer title={t("clinic.expenses.add")} closeHref={hrefWith(path, here, {})}>
          <Form action={expenseAction}>
            <input type="hidden" name="$slug" value={ctx.tenant.slug} />
            <SelectField name="category" label={t("clinic.expenses.category")} options={EXPENSE_CATEGORIES.map((c) => ({ value: c, label: t(`expenseCategory.${c}`) }))} />
            <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
              <TextField name="amount" label={t("clinic.expenses.amount")} inputMode="numeric" required />
              <SelectField name="currency" label={t("clinic.expenses.currency")} defaultValue={ctx.tenant.currency} options={[{ value: "UZS", label: "UZS" }, { value: "USD", label: "USD" }]} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField name="spentOn" type="date" label={t("clinic.expenses.date")} defaultValue={today} />
              <SelectField name="branchId" label={t("clinic.expenses.branch")} defaultValue="" options={[{ value: "", label: t("clinic.expenses.allBranches") }, ...branches.map((b) => ({ value: b.id, label: b.name }))]} />
            </div>
            <TextField name="description" label={t("clinic.expenses.description")} hint={t("clinic.expenses.descriptionHint")} optionalLabel={t("common.optional")} />
            <div className="flex justify-end">
              <SubmitButton>{t("clinic.expenses.add")}</SubmitButton>
            </div>
          </Form>
        </Drawer>
      ) : null}
    </>
  );
}
