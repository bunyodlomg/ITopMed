import { getTranslations } from "next-intl/server";
import { Form, SelectField, SubmitButton, TextField } from "@/components/ui/form";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/primitives";
import { LOCALES, LOCALE_NATIVE_NAMES, TIMEZONES } from "@/i18n/config";
import { requireClinic } from "@/server/auth/guards";
import { getClinicSettings } from "@/server/clinic/admin";
import { clinicSettingsAction } from "../../../clinic-actions";
import { moduleAction, policyAction } from "../../../practice-actions";
import { listClinicModules } from "@/server/clinic/practice";
import { getClinicPolicy } from "@/server/clinic/policy";
import { Badge, ButtonLink } from "@/components/ui/primitives";
import { Letterhead } from "@/components/letterhead";
import { getLetterhead } from "@/server/clinic/branding";
import { letterheadAction } from "../../../desk-actions";
import { DataCard } from "./data-card";
import { PurgeCard } from "./purge-card";
import { ScreensCard } from "./screens-card";

export default async function ClinicSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug, "clinic.settings.read");
  const [t, s, modules, policy, head] = await Promise.all([getTranslations(), getClinicSettings(ctx), listClinicModules(ctx), getClinicPolicy(ctx), getLetterhead(ctx)]);
  const isOwner = ctx.roleKeys.includes("clinic_owner");
  const canEdit = ctx.permissions.has("clinic.settings.manage");
  const optional = t("common.optional");

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader
        title={t("clinic.settings.title")}
        description={t("clinic.settings.subtitle")}
        action={canEdit && isOwner ? <ButtonLink href={`/c/${ctx.tenant.slug}/setup`} variant="secondary">{t("setup.open")}</ButtonLink> : null}
      />
      <Form action={clinicSettingsAction} className="space-y-6">
        <input type="hidden" name="$slug" value={ctx.tenant.slug} />
        <fieldset disabled={!canEdit} className="space-y-6">
          <Card>
            <CardHeader title={t("clinic.settings.general")} />
            <CardBody className="grid gap-5 sm:grid-cols-2">
              <TextField name="name" label={t("admin.clinicNew.name")} defaultValue={s.name} required className="sm:col-span-2" />
              <TextField name="legalName" label={t("admin.clinicNew.legalName")} defaultValue={s.legalName} optionalLabel={optional} className="sm:col-span-2" />
              <TextField name="contactPhone" type="tel" label={t("admin.clinicNew.contactPhone")} defaultValue={s.contactPhone} optionalLabel={optional} />
              <TextField name="address" label={t("admin.clinicNew.address")} defaultValue={s.address} optionalLabel={optional} className="sm:col-span-2" />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={t("clinic.settings.regional")} />
            <CardBody className="grid gap-5 sm:grid-cols-2">
              <SelectField name="defaultLocale" label={t("admin.clinicNew.defaultLocale")} defaultValue={s.defaultLocale} options={LOCALES.map((l) => ({ value: l, label: LOCALE_NATIVE_NAMES[l] }))} />
              <SelectField name="timezone" label={t("admin.clinicNew.timezone")} defaultValue={s.timezone} options={TIMEZONES.map((z) => ({ value: z, label: z }))} />
            </CardBody>
          </Card>
        </fieldset>
        {canEdit ? (
          <div className="flex justify-end">
            <SubmitButton>{t("common.save")}</SubmitButton>
          </div>
        ) : null}
      </Form>

      <DataCard ctx={ctx} />

      <PurgeCard ctx={ctx} />

      <ScreensCard ctx={ctx} />

      <Card className="mt-6">
        <CardHeader title={t("clinic.policy.title")} description={isOwner ? t("clinic.policy.hint") : t("clinic.policy.ownerOnly")} />
        <CardBody>
          <Form action={policyAction} successMessage="clinic.policy.saved">
            <input type="hidden" name="$slug" value={ctx.tenant.slug} />
            <fieldset disabled={!isOwner} className="space-y-5">
              <div className="max-w-xs">
                <TextField name="maxDiscountPercent" label={t("clinic.policy.maxDiscount")} hint={t("clinic.policy.maxDiscountHint")} inputMode="numeric" defaultValue={String(policy.maxDiscountPercent)} />
              </div>
              <label className="flex items-start gap-3 text-[14px]">
                <input type="checkbox" name="discountReasonRequired" defaultChecked={policy.discountReasonRequired} className="mt-0.5 size-4 accent-[var(--accent)]" />
                <span>
                  <span className="font-medium">{t("clinic.policy.reasonRequired")}</span>
                  <span className="block text-[13px] text-text-2">{t("clinic.policy.reasonRequiredHint")}</span>
                </span>
              </label>
              <label className="flex items-start gap-3 text-[14px]">
                <input type="checkbox" name="printOnlyAtDesk" defaultChecked={policy.printOnlyAtDesk} className="mt-0.5 size-4 accent-[var(--accent)]" />
                <span>
                  <span className="font-medium">{t("clinic.policy.printOnlyAtDesk")}</span>
                  <span className="block text-[13px] text-text-2">{t("clinic.policy.printOnlyAtDeskHint")}</span>
                </span>
              </label>
              <div className="border-t border-border pt-4">
                <p className="text-[14px] font-medium">{t("clinic.policy.onlineTitle")}</p>
                <p className="mb-3 text-[13px] text-text-2">{t("clinic.policy.onlineHint")}</p>
                <div className="grid gap-4 sm:grid-cols-3">
                  <TextField name="onlineBookingDays" label={t("clinic.policy.bookingDays")} inputMode="numeric" defaultValue={String(policy.onlineBookingDays)} />
                  <TextField name="onlineBookingLeadHours" label={t("clinic.policy.leadHours")} inputMode="decimal" defaultValue={String(policy.onlineBookingLeadMinutes / 60)} />
                  <TextField name="onlineBookingMaxActive" label={t("clinic.policy.maxActive")} inputMode="numeric" defaultValue={String(policy.onlineBookingMaxActive)} />
                </div>
              </div>
            </fieldset>
            {isOwner ? <SubmitButton>{t("common.save")}</SubmitButton> : null}
          </Form>
        </CardBody>
      </Card>

      <Card className="mt-6">
        <CardHeader title={t("clinic.modules.title")} description={t("clinic.modules.hint")} />
        <ul className="divide-y divide-border">
          {modules.map((m) => (
            <li key={m.key} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
              <div className="min-w-0">
                <p className="text-[14.5px] font-medium">{t(`modules.${m.key}` as never)}</p>
                <p className="text-[13px] text-text-2">{t(`moduleHint.${m.key}` as never)}</p>
              </div>
              <div className="flex items-center gap-2">
                {!m.inPlan && !m.enabled ? <Badge>{t("clinic.modules.notInPlan")}</Badge> : <Badge tone={m.enabled ? "success" : "neutral"}>{t(m.enabled ? "clinic.modules.on" : "clinic.modules.off")}</Badge>}
                {canEdit && (m.enabled || m.inPlan) ? (
                  <Form action={moduleAction} className="space-y-1">
                    <input type="hidden" name="$slug" value={ctx.tenant.slug} />
                    <input type="hidden" name="module" value={m.key} />
                    <input type="hidden" name="op" value={m.enabled ? "off" : "on"} />
                    <SubmitButton variant="secondary" size="sm">
                      {t(m.enabled ? "clinic.modules.turnOff" : "clinic.modules.turnOn")}
                    </SubmitButton>
                  </Form>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="mt-6">
        <CardHeader title={t("clinic.settings.letterheadTitle")} description={t("clinic.settings.letterheadHint")} />
        <CardBody className="space-y-5">
          <div className="rounded-[12px] border border-border bg-surface p-4">
            <Letterhead data={head} locationLabel={t("clinic.settings.locationQrLabel")} />
          </div>
          {canEdit ? (
            <Form action={letterheadAction}>
              <input type="hidden" name="$slug" value={ctx.tenant.slug} />
              <label className="block">
                <span className="mb-1.5 block text-[14px] font-medium">{t("clinic.settings.logo")}</span>
                <input type="file" name="logo" accept="image/png,image/jpeg,image/webp" className="block w-full text-[14px] file:mr-3 file:rounded-[var(--radius-control)] file:border file:border-border-strong file:bg-surface file:px-3 file:py-2 file:text-[14px]" />
                <span className="mt-1 block text-[13px] text-text-2">{t("clinic.settings.logoHint")}</span>
              </label>
              {head.logo ? (
                <label className="flex items-center gap-2 text-[14px]">
                  <input type="checkbox" name="removeLogo" className="size-4 accent-[var(--accent)]" />
                  {t("clinic.settings.removeLogo")}
                </label>
              ) : null}
              <TextField name="licenseText" label={t("clinic.settings.license")} hint={t("clinic.settings.licenseHint")} defaultValue={head.license ?? ""} optionalLabel={optional} />
              <TextField name="locationUrl" type="url" label={t("clinic.settings.locationUrl")} hint={t("clinic.settings.locationUrlHint")} defaultValue={head.locationUrl ?? ""} placeholder="https://maps.app.goo.gl/…" optionalLabel={optional} />
              <div className="flex justify-end">
                <SubmitButton>{t("clinic.settings.letterheadSave")}</SubmitButton>
              </div>
            </Form>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
