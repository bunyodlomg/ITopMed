import { CalendarPlus, FileHeart, Pencil } from "lucide-react";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { formatBirthDate, patientName } from "@/components/patients";
import { Form, SelectField, SubmitButton } from "@/components/ui/form";
import { Alert, Badge, ButtonLink, Card, CardBody, CardHeader, DescriptionList, PageHeader, STATUS_TONE, buttonClass } from "@/components/ui/primitives";
import { requireClinic } from "@/server/auth/guards";
import { requestMeta } from "@/server/http";
import { CONSENT_METHODS, CONSENT_PURPOSES, getPatient } from "@/server/patients/patients";
import { consentAction } from "../../../../care-actions";
import { portalCodeAction } from "../../../../portal-actions";
import { PortalAccessCard } from "@/components/portal-staff";
import { getPortalAccount } from "@/server/portal/staff";
import { todayMoney } from "@/server/reception/desk";
import { moneyFormatter } from "@/components/money";

export default async function PatientPage({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<{ registered?: string; saved?: string; booked?: string }> }) {
  const { slug, id } = await params;
  const ctx = await requireClinic(slug, "patients.read");
  const [t, format, sp] = await Promise.all([getTranslations(), getFormatter(), searchParams]);
  const p = await getPatient(ctx, id, await requestMeta());
  if (!p) notFound();
  const portal = ctx.modules.has("patient_portal") ? await getPortalAccount(ctx, p.id) : null;
  const base = `/c/${ctx.tenant.slug}`;
  const tz = ctx.tenant.timezone;
  const canUpdate = ctx.permissions.has("patients.update");
  const activeConsents = p.consents.filter((c) => !c.withdrawnAt);
  const missingPurposes = CONSENT_PURPOSES.filter((pp) => !activeConsents.some((c) => c.purpose === pp));
  const owes = (await todayMoney(ctx, [p.id])).debt.get(p.id) ?? 0n;
  const money = owes > 0n ? await moneyFormatter() : null;
  const ident = (type: string) => p.identifiers.find((i) => i.type === type)?.value ?? "—";

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        eyebrow={`${t("clinic.patients.title")} · ${p.mrn}`}
        title={patientName(p)}
        description={`${await formatBirthDate(p.birthDate)} · ${t(`sex.${p.sex}`)}`}
        action={
          <>
            {ctx.permissions.has("appointments.manage") ? (
              <ButtonLink href={`${base}/appointments?patient=${p.id}`}>
                <CalendarPlus aria-hidden className="size-4" />
                {t("clinic.patients.book")}
              </ButtonLink>
            ) : null}
            {ctx.permissions.has("emr.read") ? (
              <ButtonLink href={`${base}/patients/${p.id}/record`} variant="secondary">
                <FileHeart aria-hidden className="size-4" />
                {t("clinic.patients.openRecord")}
              </ButtonLink>
            ) : null}
          </>
        }
      />
      {sp.registered ? <Alert tone="success">{t("clinic.patients.registered", { mrn: sp.registered })}</Alert> : null}
      {sp.saved ? <Alert tone="success">{t("clinic.patients.saved")}</Alert> : null}
      {sp.booked ? <Alert tone="success">{t("clinic.booking.booked")}</Alert> : null}
      {owes > 0n && money ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-danger bg-danger-soft px-5 py-3" role="status">
          <p className="text-[14px] font-semibold text-danger">{t("clinic.desk.hasDebt", { amount: money(owes, ctx.tenant.currency) })}</p>
          {ctx.permissions.has("billing.payment") && ctx.permissions.has("billing.read") ? (
            <ButtonLink href={`${base}/checkout?patient=${p.id}`} size="sm">{t("clinic.checkout.openCheckout")}</ButtonLink>
          ) : null}
        </div>
      ) : null}

      <Card>
        <CardHeader title={t("clinic.patients.identity")} action={canUpdate ? <ButtonLink href={`${base}/patients/${p.id}/edit`} variant="ghost" size="sm"><Pencil aria-hidden className="size-4" />{t("clinic.patients.edit")}</ButtonLink> : null} />
        <CardBody>
          <DescriptionList
            items={[
              { label: t("clinic.patients.mrn"), value: <span className="font-mono">{p.mrn}</span> },
              { label: t("clinic.patients.pinfl"), value: <span className="font-mono">{ident("PINFL")}</span> },
              { label: t("clinic.patients.passport"), value: <span className="font-mono">{ident("PASSPORT")}</span> },
              { label: t("clinic.patients.phone"), value: p.phone ?? "—" },
              { label: t("clinic.patients.address"), value: p.address ?? "—" },
            ]}
          />
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("clinic.patients.appointments")} />
          {p.appointments.length === 0 ? (
            <CardBody><p className="text-[14px] text-text-2">{t("clinic.patients.noAppointments")}</p></CardBody>
          ) : (
            <ul className="divide-y divide-border">
              {p.appointments.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 px-6 py-3">
                  <div className="min-w-0">
                    <p className="text-[14px] font-medium tabular-nums">{format.dateTime(a.startsAt, { dateStyle: "medium", timeStyle: "short", timeZone: tz })}</p>
                    <p className="truncate text-[13px] text-text-2">
                      {a.doctor.membership.user.fullName}
                      {a.service ? ` · ${a.service.name}` : ""} · {a.branch.name}
                    </p>
                  </div>
                  <Badge tone={STATUS_TONE[a.status] ?? (a.status === "COMPLETED" ? "success" : a.status === "BOOKED" ? "accent" : "neutral")}>{t(`status.${a.status}`)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title={t("clinic.patients.consents")} description={t("clinic.patients.consentsHint")} />
          {activeConsents.length === 0 ? (
            <CardBody><p className="text-[14px] text-text-2">{t("clinic.patients.noConsents")}</p></CardBody>
          ) : (
            <ul className="divide-y divide-border">
              {activeConsents.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 px-6 py-2.5">
                  <div className="min-w-0">
                    <p className="text-[14px] font-medium">{t(`consentPurpose.${c.purpose}`)}</p>
                    <p className="text-[12.5px] text-text-3">
                      {t(`consentMethod.${c.method}`)} · {t("clinic.patients.since", { date: format.dateTime(c.grantedAt, { dateStyle: "medium", timeZone: tz }) })}
                    </p>
                  </div>
                  {canUpdate ? (
                    <Form action={consentAction} className="space-y-0">
                      <input type="hidden" name="$slug" value={ctx.tenant.slug} />
                      <input type="hidden" name="patientId" value={p.id} />
                      <input type="hidden" name="consentId" value={c.id} />
                      <button name="op" value="withdraw" className={buttonClass("ghost", "sm")}>{t("clinic.patients.withdraw")}</button>
                    </Form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {canUpdate && missingPurposes.length > 0 ? (
            <CardBody className="border-t border-border">
              <Form action={consentAction}>
                <input type="hidden" name="$slug" value={ctx.tenant.slug} />
                <input type="hidden" name="patientId" value={p.id} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <SelectField name="purpose" label={t("clinic.patients.consents")} options={missingPurposes.map((pp) => ({ value: pp, label: t(`consentPurpose.${pp}`) }))} />
                  <SelectField name="method" label={t("clinic.patients.consentMethod")} options={CONSENT_METHODS.map((m) => ({ value: m, label: t(`consentMethod.${m}`) }))} />
                </div>
                <SubmitButton variant="secondary" full>{t("clinic.patients.grant")}</SubmitButton>
              </Form>
            </CardBody>
          ) : null}
        </Card>
      </div>

      {ctx.modules.has("patient_portal") ? (
      <PortalAccessCard
        slug={ctx.tenant.slug}
        patientId={p.id}
        account={portal?.account ?? null}
        hasConsent={portal?.hasConsent ?? false}
        canManage={ctx.permissions.has("portal.manage")}
        action={portalCodeAction}
        timeZone={tz}
      />
      ) : null}
    </div>
  );
}
