import { ClipboardList, Plus, Stethoscope } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { ServiceFields } from "@/components/service-form";
import { Drawer } from "@/components/ui/drawer";
import { Form, SubmitButton, TextAreaField } from "@/components/ui/form";
import { Badge, ButtonLink, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { SearchBox } from "@/components/ui/search-box";
import { FilterChips, Toolbar, hrefWith, type Chip } from "@/components/ui/toolbar";
import { minorToNumber, wrapCurrency } from "@/lib/money";
import { requireClinic } from "@/server/auth/guards";
import { listDepartments, listServices } from "@/server/clinic/resources";
import { createServiceAction } from "../../../workspace-actions";
import { priceListAction } from "../../../desk-actions";

type Search = { q?: string; f?: string; panel?: string };

export default async function ServicesPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Search> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await requireClinic(slug, "services.read");
  const canManage = ctx.permissions.has("services.manage");
  const [t, format, services, departments] = await Promise.all([getTranslations(), getFormatter(), listServices(ctx, { includeArchived: canManage }), canManage ? listDepartments(ctx) : []]);
  const path = `/c/${ctx.tenant.slug}/services`;
  const here: Search = { q: sp.q, f: sp.f };

  // Quick filters: active services by kind, those without a price, the archive.
  const active = services.filter((s) => !s.archivedAt);
  const archived = services.filter((s) => s.archivedAt);
  const kinds = [...new Set(active.map((s) => s.kind))];
  const filter = sp.f ?? "all";
  const pool =
    filter === "archived" ? archived : filter === "noPrice" ? active.filter((s) => s.priceMinor === 0n) : filter.startsWith("kind:") ? active.filter((s) => `kind:${s.kind}` === filter) : active;
  const q = (sp.q ?? "").trim().toLowerCase();
  const rows = q ? pool.filter((s) => s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)) : pool;

  const chip = (f: string, label: string, count: number): Chip => ({ label, count, href: hrefWith(path, here, { f: f === "all" ? undefined : f }), active: filter === f });
  const chips: Chip[] = [
    chip("all", t("common.all"), active.length),
    ...kinds.map((k) => chip(`kind:${k}`, t(`serviceKind.${k}`), active.filter((s) => s.kind === k).length)),
    ...(active.some((s) => s.priceMinor === 0n) ? [chip("noPrice", t("clinic.services.filterNoPrice"), active.filter((s) => s.priceMinor === 0n).length)] : []),
    ...(archived.length ? [chip("archived", t("clinic.services.archivedBadge"), archived.length)] : []),
  ];

  const panel = canManage ? sp.panel : undefined;
  const closeHref = hrefWith(path, here, {});

  return (
    <>
      <PageHeader
        title={t("clinic.services.title")}
        count={active.length}
        description={t("clinic.services.subtitle")}
        action={
          <>
            <ButtonLink href={`${path}/discounts`} variant="secondary">
              {t("clinic.pricing.title")}
            </ButtonLink>
            {canManage ? (
              <>
                <ButtonLink href={hrefWith(path, here, { panel: "paste" })} scroll={false} variant="secondary">
                  <ClipboardList aria-hidden className="size-4" />
                  {t("clinic.services.pasteList")}
                </ButtonLink>
                <ButtonLink href={hrefWith(path, here, { panel: "new" })} scroll={false}>
                  <Plus aria-hidden className="size-4" />
                  {t("clinic.services.add")}
                </ButtonLink>
              </>
            ) : null}
          </>
        }
      />

      <Toolbar
        search={<SearchBox placeholder={t("clinic.services.searchPlaceholder")} label={t("common.search")} clearLabel={t("common.clearSearch")} />}
        filters={<FilterChips chips={chips} label={t("common.filters")} />}
      />

      <Card className="overflow-hidden">
        {services.length === 0 ? (
          <EmptyState
            icon={<Stethoscope className="size-6" />}
            title={t("clinic.services.empty")}
            description={t("clinic.services.emptyHint")}
            action={
              canManage ? (
                <ButtonLink href={hrefWith(path, here, { panel: "paste" })} scroll={false}>
                  {t("clinic.services.pasteList")}
                </ButtonLink>
              ) : undefined
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState icon={<Stethoscope className="size-6" />} title={t("common.nothingFound")} description={t("common.nothingFoundHint")} />
        ) : (
          <Table caption={t("clinic.services.title")}>
            <thead>
              <tr>
                <Th>{t("clinic.services.colService")}</Th>
                <Th>{t("clinic.services.colKind")}</Th>
                <Th className="text-right">{t("clinic.services.colDuration")}</Th>
                <Th className="text-right">{t("clinic.services.colPrice")}</Th>
                <Th className="text-right">{t("clinic.services.colDoctors")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className={s.archivedAt ? "text-text-3" : undefined}>
                  <Td>
                    {canManage ? (
                      <Link href={`${path}/${s.id}`} className="font-medium hover:text-accent">
                        {s.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{s.name}</span>
                    )}
                    <p className="font-mono text-[12px] text-text-3">
                      {s.code}
                      {s.department ? ` · ${s.department.name}` : ""}
                    </p>
                  </Td>
                  <Td className="text-text-2">{t(`serviceKind.${s.kind}`)}</Td>
                  <Td className="text-right tabular-nums text-text-2">{t("clinic.services.minutes", { count: s.durationMinutes })}</Td>
                  <Td className="text-right font-medium tabular-nums">
                    {s.priceMinor === 0n ? (
                      <Badge tone="warning">{t("clinic.services.priceNotSet")}</Badge>
                    ) : (
                      wrapCurrency(format.number(minorToNumber(s.priceMinor, s.currency), { style: "currency", currency: s.currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }))
                    )}
                  </Td>
                  <Td label={t("clinic.services.colDoctors")} className="text-right tabular-nums">
                    {s._count.doctors}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {panel === "new" ? (
        <Drawer title={t("clinic.services.add")} closeHref={closeHref}>
          <Form action={createServiceAction}>
            <input type="hidden" name="$slug" value={ctx.tenant.slug} />
            <ServiceFields departments={departments} />
            <div className="flex justify-end">
              <SubmitButton>{t("clinic.services.add")}</SubmitButton>
            </div>
          </Form>
        </Drawer>
      ) : panel === "paste" ? (
        <Drawer title={t("clinic.services.priceListTitle")} description={t("clinic.services.priceListHint")} closeHref={closeHref}>
          <Form action={priceListAction}>
            <input type="hidden" name="$slug" value={ctx.tenant.slug} />
            <TextAreaField name="text" label={t("clinic.services.priceListTitle")} rows={12} placeholder={t("clinic.services.priceListExample")} />
            <div className="flex justify-end">
              <SubmitButton>{t("clinic.services.priceListSubmit")}</SubmitButton>
            </div>
          </Form>
        </Drawer>
      ) : null}
    </>
  );
}
