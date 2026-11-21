import { Receipt } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { moneyFormatter } from "@/components/money";
import { patientName } from "@/components/patients";
import { Form } from "@/components/ui/form";
import { Badge, Card, CardHeader, EmptyState, PageHeader, STATUS_TONE, Table, Td, Th, buttonClass } from "@/components/ui/primitives";
import { SearchBox } from "@/components/ui/search-box";
import { FilterChips, Toolbar, hrefWith } from "@/components/ui/toolbar";
import type { InvoiceStatus } from "@/generated/prisma/client";
import { requireClinic } from "@/server/auth/guards";
import { listInvoices, uninvoicedVisits } from "@/server/billing/billing";
import { createInvoiceAction } from "../../../billing-actions";

const STATUSES: InvoiceStatus[] = ["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "VOID"];

export default async function BillingPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ status?: string; q?: string }> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug, "billing.read");
  const sp = await searchParams;
  const status = STATUSES.find((s) => s === sp.status);
  const canInvoice = ctx.permissions.has("billing.invoice");
  const [t, format, money, invoices, toBill] = await Promise.all([getTranslations(), getFormatter(), moneyFormatter(), listInvoices(ctx, { status, q: sp.q }), canInvoice ? uninvoicedVisits(ctx) : Promise.resolve([])]);
  const tz = ctx.tenant.timezone;
  const base = `/c/${ctx.tenant.slug}/billing`;

  return (
    <>
      <PageHeader title={t("clinic.billing.title")} description={t("clinic.billing.subtitle")} />

      {canInvoice && toBill.length ? (
        <Card className="mb-6">
          <CardHeader title={`${t("clinic.billing.toBill")} · ${toBill.length}`} />
          <ul className="divide-y divide-border">
            {toBill.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
                <div className="min-w-0">
                  <p className="font-medium">{patientName(v.patient)}</p>
                  <p className="text-[13px] text-text-2">
                    {format.dateTime(v.startsAt, { timeStyle: "short", timeZone: tz })} · {v.doctor.membership.user.fullName}
                    {v.service ? ` · ${v.service.name} · ${money(v.service.priceMinor, v.service.currency)}` : ""}
                  </p>
                </div>
                <Form action={createInvoiceAction} className="space-y-0">
                  <input type="hidden" name="$slug" value={ctx.tenant.slug} />
                  <input type="hidden" name="patientId" value={v.patient.id} />
                  <input type="hidden" name="branchId" value={v.branchId} />
                  <input type="hidden" name="appointmentId" value={v.id} />
                  <button className={buttonClass("primary", "sm")}>{t("clinic.billing.createInvoice")}</button>
                </Form>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Toolbar
        search={<SearchBox placeholder={t("clinic.billing.searchPlaceholder")} label={t("common.search")} clearLabel={t("common.clearSearch")} />}
        filters={
          <FilterChips
            label={t("clinic.billing.colStatus")}
            chips={[undefined, ...STATUSES].map((s) => ({ label: s ? t(`status.${s}`) : t("common.all"), href: hrefWith(base, { q: sp.q }, { status: s }), active: s === status }))}
          />
        }
      />

      <Card className="overflow-hidden">
        {invoices.length === 0 ? (
          <EmptyState icon={<Receipt className="size-6" />} title={sp.q || status ? t("common.nothingFound") : t("clinic.billing.empty")} />
        ) : (
          <Table caption={t("clinic.billing.title")}>
            <thead>
              <tr>
                <Th>{t("clinic.billing.colNumber")}</Th>
                <Th>{t("clinic.billing.colPatient")}</Th>
                <Th>{t("clinic.billing.colDate")}</Th>
                <Th className="text-right">{t("clinic.billing.colTotal")}</Th>
                <Th className="text-right">{t("clinic.billing.colPaid")}</Th>
                <Th>{t("clinic.billing.colStatus")}</Th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id} className="hover:bg-surface-2">
                  <Td>
                    <Link href={`${base}/${i.id}`} className="font-mono text-[13px] font-medium hover:text-accent">
                      {i.number ?? t("clinic.billing.draft")}
                    </Link>
                  </Td>
                  <Td>
                    <p className="font-medium">{patientName(i.patient)}</p>
                    <p className="text-[12px] text-text-3">{i.patient.mrn}</p>
                  </Td>
                  <Td className="whitespace-nowrap text-text-2">{format.dateTime(i.issuedAt ?? i.createdAt, { dateStyle: "medium", timeZone: tz })}</Td>
                  <Td label={t("clinic.billing.colTotal")} className="text-right font-medium tabular-nums">{money(i.totalMinor, i.currency)}</Td>
                  <Td label={t("clinic.billing.colPaid")} className="text-right tabular-nums text-text-2">{money(i.paidMinor, i.currency)}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[i.status] ?? "neutral"}>{t(`status.${i.status}`)}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
