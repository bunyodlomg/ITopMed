import { getTranslations } from "next-intl/server";
import { moneyFormatter } from "@/components/money";
import { CheckboxGroup, Form, SubmitButton, TextField } from "@/components/ui/form";
import { Badge, Card, CardBody, CardHeader, PageHeader } from "@/components/ui/primitives";
import { requireClinic } from "@/server/auth/guards";
import { getFreeFollowUpDays, listBenefitCategories, listPackages } from "@/server/clinic/pricing";
import { listServices } from "@/server/clinic/resources";
import { archiveBenefitAction, archivePackageAction, benefitAction, followUpAction, packageAction } from "../../../../pricing-actions";

/** Services → Discounts: privileged categories, packages, free follow-up period. */
export default async function DiscountsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug, "services.read");
  const [t, money, benefits, packages, services, days] = await Promise.all([getTranslations(), moneyFormatter(), listBenefitCategories(ctx), listPackages(ctx), listServices(ctx), getFreeFollowUpDays(ctx)]);
  const canManage = ctx.permissions.has("services.manage");
  const isOwner = ctx.roleKeys.includes("clinic_owner");
  const priced = services.filter((s) => s.priceMinor > 0n);
  const hidden = <input type="hidden" name="$slug" value={ctx.tenant.slug} />;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <PageHeader title={t("clinic.pricing.title")} description={t("clinic.pricing.subtitle")} />

      <Card>
        <CardHeader title={t("clinic.pricing.followUpTitle")} description={t("clinic.pricing.followUpHint")} />
        <CardBody>
          <Form action={followUpAction} className="flex flex-wrap items-end gap-3">
            {hidden}
            <fieldset disabled={!isOwner} className="w-40">
              <TextField name="freeFollowUpDays" label={t("clinic.pricing.days")} inputMode="numeric" defaultValue={String(days)} />
            </fieldset>
            {isOwner ? <SubmitButton variant="secondary">{t("common.save")}</SubmitButton> : <p className="text-[13px] text-text-2">{t("clinic.policy.ownerOnly")}</p>}
          </Form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("clinic.pricing.benefitsTitle")} description={t("clinic.pricing.benefitsHint")} />
        <CardBody className="space-y-4">
          {benefits.length ? (
            <ul className="divide-y divide-border rounded-[12px] border border-border">
              {benefits.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0 font-medium">{b.name}</span>
                  <span className="flex items-center gap-2">
                    <Badge tone="accent">−{b.discountPercent}%</Badge>
                    {canManage ? (
                      <Form action={archiveBenefitAction}>
                        {hidden}
                        <input type="hidden" name="id" value={b.id} />
                        <SubmitButton variant="secondary" size="sm">
                          {t("clinic.pricing.archive")}
                        </SubmitButton>
                      </Form>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[14px] text-text-2">{t("clinic.pricing.noBenefits")}</p>
          )}
          {canManage ? (
            <Form action={benefitAction} className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
              {hidden}
              <TextField name="name" label={t("clinic.pricing.benefitName")} placeholder={t("clinic.pricing.benefitExample")} />
              <TextField name="discountPercent" label={t("clinic.pricing.percent")} inputMode="numeric" placeholder="20" />
              <SubmitButton variant="secondary">{t("clinic.pricing.add")}</SubmitButton>
            </Form>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("clinic.pricing.packagesTitle")} description={t("clinic.pricing.packagesHint")} />
        <CardBody className="space-y-4">
          {packages.length ? (
            <ul className="divide-y divide-border rounded-[12px] border border-border">
              {packages.map((p) => {
                const full = p.items.reduce((s, i) => s + i.service.priceMinor, 0n);
                const cur = p.items[0]?.service.currency ?? ctx.tenant.currency;
                const price = full - (full * BigInt(p.discountPercent)) / 100n;
                return (
                  <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="font-medium">{p.name}</p>
                      <p className="text-[13px] text-text-2">{p.items.map((i) => i.service.name).join(", ")}</p>
                      <p className="text-[13px]">
                        <span className="text-text-3 line-through">{money(full, cur)}</span> → <span className="font-semibold">{money(price, cur)}</span>
                      </p>
                    </div>
                    <span className="flex items-center gap-2">
                      <Badge tone="accent">−{p.discountPercent}%</Badge>
                      {canManage ? (
                        <Form action={archivePackageAction}>
                          {hidden}
                          <input type="hidden" name="id" value={p.id} />
                          <SubmitButton variant="secondary" size="sm">
                            {t("clinic.pricing.archive")}
                          </SubmitButton>
                        </Form>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[14px] text-text-2">{t("clinic.pricing.noPackages")}</p>
          )}
          {canManage && priced.length >= 2 ? (
            <Form action={packageAction} className="space-y-3">
              {hidden}
              <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
                <TextField name="name" label={t("clinic.pricing.packageName")} placeholder={t("clinic.pricing.packageExample")} />
                <TextField name="discountPercent" label={t("clinic.pricing.percent")} inputMode="numeric" placeholder="10" />
              </div>
              <CheckboxGroup name="serviceIds" label={t("clinic.pricing.packageServices")} options={priced.map((s) => ({ value: s.id, label: `${s.name} — ${money(s.priceMinor, s.currency)}` }))} />
              <SubmitButton variant="secondary">{t("clinic.pricing.addPackage")}</SubmitButton>
            </Form>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
