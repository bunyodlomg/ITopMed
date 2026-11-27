import { Pill, Plus } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { MedicineFields } from "@/components/medicine-fields";
import { Drawer } from "@/components/ui/drawer";
import { Form, SubmitButton } from "@/components/ui/form";
import { Alert, Badge, ButtonLink, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { SearchBox } from "@/components/ui/search-box";
import { FilterChips, Toolbar, hrefWith } from "@/components/ui/toolbar";
import { medicineLabel } from "@/lib/medicines";
import { requireClinic } from "@/server/auth/guards";
import { canUseMedicines, countMedicines, listMedicines } from "@/server/emr/medicines";
import { saveMedicineAction } from "../../../medicine-actions";

/**
 * Dori bazasi - the clinic's own medicine catalog. Doctors search it while
 * prescribing; doctors and the pharmacist add medicines (trade name, INN,
 * form, usual dose and times, a photo of the box). ITop Med ships no
 * medicines or doses of its own.
 */
export default async function MedicinesPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ q?: string; panel?: string; show?: string; archived?: string }> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug);
  if (!canUseMedicines(ctx)) notFound();
  const sp = await searchParams;
  const t = await getTranslations();
  const canManage = ctx.permissions.has("medicines.manage");
  const showArchived = sp.show === "archived" && !sp.q;
  const [items, total] = await Promise.all([listMedicines(ctx, { q: sp.q, archived: showArchived }), countMedicines(ctx)]);
  const path = `/c/${ctx.tenant.slug}/medicines`;
  const here = { q: sp.q, show: sp.show };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("medicines.title")}
        description={t("medicines.subtitle")}
        count={total}
        action={
          canManage ? (
            <ButtonLink href={hrefWith(path, here, { panel: "new" })} scroll={false}>
              <Plus aria-hidden className="size-4" /> {t("medicines.add")}
            </ButtonLink>
          ) : undefined
        }
      />
      {sp.archived ? <Alert tone="success">{t("medicines.archived")}</Alert> : null}
      <Toolbar
        search={<SearchBox placeholder={t("medicines.searchPlaceholder")} label={t("common.search")} clearLabel={t("common.clearSearch")} autoFocus />}
        filters={
          canManage ? (
            <FilterChips
              label={t("medicines.title")}
              chips={[
                { label: t("medicines.active"), href: hrefWith(path, { q: sp.q }, { show: undefined }), active: !showArchived },
                { label: t("medicines.archivedList"), href: hrefWith(path, {}, { show: "archived" }), active: showArchived },
              ]}
            />
          ) : undefined
        }
      />
      <Card className="overflow-hidden">
        {items.length === 0 ? (
          <EmptyState icon={<Pill className="size-6" />} title={sp.q ? t("medicines.noMatch") : t("medicines.empty")} description={canManage && !sp.q ? t("medicines.emptyHint") : undefined} />
        ) : (
          <Table caption={t("medicines.title")}>
            <thead>
              <tr>
                <Th>{t("medicines.name")}</Th>
                <Th>{t("medicines.formLabel")}</Th>
                <Th>{t("medicines.group")}</Th>
                <Th>{t("medicines.usual")}</Th>
                <Th className="text-right">{t("medicines.used")}</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id}>
                  <Td>
                    <Link href={`${path}/${m.id}`} className="flex min-w-0 items-center gap-3 hover:text-accent">
                      {m.hasPhoto ? (
                        // eslint-disable-next-line @next/next/no-img-element -- private thumbnail from our own route
                        <img src={`${path}/${m.id}/photo`} alt="" className="size-10 shrink-0 rounded-[8px] border border-border object-cover" loading="lazy" />
                      ) : (
                        <span className="grid size-10 shrink-0 place-items-center rounded-[8px] bg-sunken text-text-3"><Pill aria-hidden className="size-5" /></span>
                      )}
                      <span className="min-w-0">
                        <span className="block break-words font-semibold">{medicineLabel(m)}</span>
                        {m.inn ? <span className="block break-words text-[12.5px] text-text-2">{m.inn}</span> : null}
                      </span>
                    </Link>
                  </Td>
                  <Td label={t("medicines.formLabel")}>{t(`medicines.form.${m.form}` as never)}</Td>
                  <Td label={t("medicines.group")}>{m.drugGroup ?? "—"}</Td>
                  <Td label={t("medicines.usual")}>
                    <span className="break-words text-text-2">{[m.defaultDose, m.defaultFrequency, m.defaultTimes].filter(Boolean).join(" · ") || "—"}</span>
                  </Td>
                  <Td label={t("medicines.used")} className="text-right">
                    {m.usageCount > 0 ? <Badge tone="accent">{m.usageCount}</Badge> : <span className="text-text-3">0</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {canManage && sp.panel === "new" ? (
        <Drawer title={t("medicines.add")} description={t("medicines.addHint")} closeHref={hrefWith(path, here, {})} wide>
          <Form action={saveMedicineAction} className="space-y-5">
            <input type="hidden" name="$slug" value={ctx.tenant.slug} />
            <MedicineFields />
            <SubmitButton full>{t("medicines.create")}</SubmitButton>
          </Form>
        </Drawer>
      ) : null}
    </div>
  );
}
