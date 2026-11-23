import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { referenceRange } from "@/components/lab";
import { formatBirthDate, patientName } from "@/components/patients";
import { Form, SubmitButton } from "@/components/ui/form";
import { Alert, Badge, ButtonLink, Card, CardBody, CardHeader, DescriptionList, PageHeader, STATUS_TONE, buttonClass } from "@/components/ui/primitives";
import { requireClinic } from "@/server/auth/guards";
import { printOnlyAtDesk } from "@/server/clinic/policy";
import { requestMeta } from "@/server/http";
import { getLabOrder } from "@/server/lab/lab";
import { DomainError } from "@/server/tenancy/provisioning";
import { labResultsAction, labStepAction } from "../../../../lab-actions";

export default async function LabOrderPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const ctx = await requireClinic(slug);
  const order = await getLabOrder(ctx, id, await requestMeta()).catch((e) => {
    if (e instanceof DomainError) notFound();
    throw e;
  });
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  const tz = ctx.tenant.timezone;
  const s = ctx.tenant.slug;
  const can = (p: string) => ctx.permissions.has(p as never);
  const editable = (order.status === "COLLECTED" || order.status === "RESULTED") && can("lab.process");
  // A verified report can be printed here unless the clinic prints only at the desk.
  const canPrint = order.status === "VERIFIED" && (!(await printOnlyAtDesk(ctx)) || can("documents.print"));
  const hidden = (
    <>
      <input type="hidden" name="$slug" value={s} />
      <input type="hidden" name="orderId" value={order.id} />
    </>
  );

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <PageHeader
        eyebrow={t("clinic.lab.title")}
        title={order.number}
        description={`${patientName(order.patient)} · ${order.patient.mrn} · ${await formatBirthDate(order.patient.birthDate)} · ${t(`sex.${order.patient.sex}`)}`}
        action={
          <>
            {order.priority === "URGENT" ? <Badge tone="danger">{t("priority.URGENT")}</Badge> : null}
            <Badge tone={STATUS_TONE[order.status] ?? "neutral"}>{t(`status.${order.status}`)}</Badge>
            {canPrint ? (
              <ButtonLink href={`/c/${s}/lab/${order.id}/print`} target="_blank" variant="secondary" size="sm">
                {t("clinic.lab.print")}
              </ButtonLink>
            ) : null}
            <ButtonLink href={`/c/${s}/lab`} variant="ghost" size="sm">
              {t("clinic.lab.back")}
            </ButtonLink>
          </>
        }
      />
      <Card>
        <CardBody>
          <DescriptionList
            items={[
              {
                label: t("clinic.lab.orderedBy"),
                value: order.doctor.membership.user.fullName,
              },
              {
                label: t("clinic.lab.orderedAt"),
                value: format.dateTime(order.orderedAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: tz,
                }),
              },
              {
                label: t("clinic.lab.indication"),
                value: order.indication ?? "—",
              },
              { label: t("clinic.billing.branch"), value: order.branch.name },
            ]}
          />
        </CardBody>
      </Card>

      {order.status === "ORDERED" && can("lab.collect") ? (
        <Form action={labStepAction} className="flex justify-end">
          {hidden}
          <button name="op" value="collect" className={buttonClass("primary", "lg")}>
            {t("clinic.lab.collect")}
          </button>
        </Form>
      ) : null}

      <Card>
        <CardHeader title={editable ? t("clinic.lab.enter") : t("clinic.lab.tests")} description={editable ? t("clinic.lab.enterHint") : undefined} />
        <CardBody>
          <Form action={labResultsAction}>
            {hidden}
            {order.items.map((item) => {
              const byAnalyte = new Map(item.results.map((r) => [r.analyteId, r]));
              return (
                <fieldset key={item.id} disabled={!editable} className="space-y-2">
                  <legend className="text-[14px] font-semibold">{item.name}</legend>
                  {item.service.labAnalytes.length === 0 ? <p className="text-[13px] text-text-3">{t("clinic.lab.noAnalytes")}</p> : null}
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[480px] text-[14px]">
                      <thead>
                        <tr className="text-left text-[12px] uppercase tracking-[0.04em] text-text-3">
                          <th className="py-1 font-medium">{t("clinic.labTests.name")}</th>
                          <th className="py-1 font-medium">{t("clinic.lab.value")}</th>
                          <th className="py-1 font-medium">{t("clinic.lab.unit")}</th>
                          <th className="py-1 font-medium">{t("clinic.lab.reference")}</th>
                          <th className="py-1 font-medium">{t("clinic.lab.flag")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {item.service.labAnalytes.map((a) => {
                          const r = byAnalyte.get(a.id);
                          return (
                            <tr key={a.id} className="border-t border-border">
                              <td className="py-1.5 pr-2">{a.name}</td>
                              <td className="py-1.5 pr-2">
                                {editable ? (
                                  <>
                                    <label className="sr-only" htmlFor={`r-${item.id}-${a.id}`}>
                                      {a.name}
                                    </label>
                                    <input
                                      id={`r-${item.id}-${a.id}`}
                                      name={`r:${item.id}:${a.id}`}
                                      defaultValue={r?.value.toString() ?? ""}
                                      inputMode="decimal"
                                      className="h-9 w-28 rounded-[8px] border border-border-strong bg-surface px-2 text-right tabular-nums disabled:bg-sunken"
                                    />
                                  </>
                                ) : (
                                  <span className="font-semibold tabular-nums">{r ? r.value.toString() : "—"}</span>
                                )}
                              </td>
                              <td className="py-1.5 pr-2 text-text-2">{a.unit}</td>
                              <td className="py-1.5 pr-2 tabular-nums text-text-2">{referenceRange(a.refLow, a.refHigh)}</td>
                              <td className="py-1.5">{r && r.flag !== "NORMAL" ? <Badge tone="danger">{t(`labFlag.${r.flag}`)}</Badge> : r ? <Badge tone="success">{t("labFlag.NORMAL")}</Badge> : null}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </fieldset>
              );
            })}
            {editable ? (
              <div className="flex justify-end">
                <SubmitButton>{t("clinic.lab.save")}</SubmitButton>
              </div>
            ) : null}
          </Form>
        </CardBody>
      </Card>

      {order.status === "RESULTED" && can("lab.verify") ? (
        <Card>
          <CardHeader title={t("clinic.lab.verify")} description={t("clinic.lab.verifyHint")} />
          <CardBody>
            {order.resultedById === ctx.principal.user.id ? (
              <Alert tone="neutral">{t("errors.fourEyes")}</Alert>
            ) : (
              <Form action={labStepAction}>
                {hidden}
                <button name="op" value="verify" className={buttonClass("primary", "lg")}>
                  {t("clinic.lab.verify")}
                </button>
              </Form>
            )}
          </CardBody>
        </Card>
      ) : null}

      {(order.status === "ORDERED" || order.status === "COLLECTED") && can("lab.process") ? (
        <Form action={labStepAction} className="flex justify-end">
          {hidden}
          <button name="op" value="cancel" className={buttonClass("ghost")}>
            {t("clinic.lab.cancel")}
          </button>
        </Form>
      ) : null}
    </div>
  );
}
