import { Check, FileText, Stethoscope } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { moneyFormatter } from "@/components/money";
import { patientName } from "@/components/patients";
import { todayMoney, todayVitals } from "@/server/reception/desk";
import { patientVisitSummaries } from "@/server/patients/overview";
import { Form, SubmitButton, TextField } from "@/components/ui/form";
import { AutoRefresh } from "@/components/auto-refresh";
import { cabinetAction, callNextAction } from "../../../queue-actions";
import { Alert, Badge, Card, EmptyState, PageHeader, STATUS_TONE, buttonClass } from "@/components/ui/primitives";
import { listDay } from "@/server/appointments/appointments";
import { requireClinic } from "@/server/auth/guards";
import { getMyDoctorProfileId } from "@/server/clinic/doctors";
import { withAppContext } from "@/server/db";
import { todayIn } from "@/server/scheduling/time";
import { openTaskAction, startVisitAction } from "../../../care-actions";
import { doctorQueueTasks } from "@/server/emr/visit-tasks";

const ORDER: Record<string, number> = { IN_PROGRESS: 0, CHECKED_IN: 1, BOOKED: 2, COMPLETED: 3, NO_SHOW: 4, CANCELLED: 5 };

export default async function MyQueuePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ finished?: string; ready?: string }> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug, "emr.write");
  const [t, format, sp, profileId] = await Promise.all([getTranslations(), getFormatter(), searchParams, getMyDoctorProfileId(ctx)]);
  const tz = ctx.tenant.timezone;
  const all = profileId ? await listDay(ctx, todayIn(tz), { doctorProfileId: profileId }) : [];
  const mine = all.filter((a) => a.doctorProfileId === profileId).sort((a, b) => ORDER[a.status]! - ORDER[b.status]! || (a.queueNumber ?? 999) - (b.queueNumber ?? 999) || +a.startsAt - +b.startsAt);
  const ids = [...new Set(mine.map((a) => a.patientId))];
  const [{ today: paid, debt }, vitals, money, history] = await Promise.all([todayMoney(ctx, ids), todayVitals(ctx, ids), moneyFormatter(), patientVisitSummaries(ctx, ids)]);
  const year = Number(todayIn(tz).slice(0, 4));
  // What each patient came for, one button each: a study opens its own form, the consultation the visit.
  const tasks = await doctorQueueTasks(ctx, mine.map((a) => ({ appointmentId: a.id, patientId: a.patientId, sex: a.patient.sex, serviceId: a.serviceId, status: a.status })));
  const cabinet = profileId ? (await withAppContext({ tenantId: ctx.tenant.id, userId: ctx.principal.user.id }, (tx) => tx.doctorProfile.findUnique({ where: { id: profileId }, select: { cabinet: true } })))?.cabinet : null;
  const encounters = new Map(
    (await withAppContext({ tenantId: ctx.tenant.id, userId: ctx.principal.user.id }, (tx) => tx.encounter.findMany({ where: { appointmentId: { in: mine.map((a) => a.id) } }, select: { id: true, appointmentId: true } }))).map((e) => [e.appointmentId!, e.id]),
  );

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <PageHeader title={t("clinic.visit.myQueue")} description={t("clinic.visit.myQueueSubtitle")} />
      {sp.finished ? <Alert tone="success">{t("clinic.visit.finished")}</Alert> : null}
      {sp.ready ? <Alert tone="success">{t("clinic.visit.studyReady")}</Alert> : null}
      {!profileId ? <Alert tone="neutral">{t("clinic.mySchedule.noProfile")}</Alert> : null}
      {profileId ? (
        <Card>
          <div className="flex flex-wrap items-end justify-between gap-4 px-5 py-4 sm:px-6">
            <div className="flex flex-wrap gap-2">
              <Form action={callNextAction}>
                <input type="hidden" name="$slug" value={ctx.tenant.slug} />
                <SubmitButton>{t("clinic.call.next")}</SubmitButton>
              </Form>
              <Form action={callNextAction}>
                <input type="hidden" name="$slug" value={ctx.tenant.slug} />
                <input type="hidden" name="recall" value="1" />
                <SubmitButton variant="secondary">{t("clinic.call.recall")}</SubmitButton>
              </Form>
            </div>
            <Form action={cabinetAction} className="flex items-end gap-2">
              <input type="hidden" name="$slug" value={ctx.tenant.slug} />
              <TextField name="cabinet" label={t("clinic.call.cabinet")} defaultValue={cabinet ?? ""} placeholder="3-xona" />
              <SubmitButton variant="secondary">{t("common.save")}</SubmitButton>
            </Form>
          </div>
        </Card>
      ) : null}
      <AutoRefresh seconds={20} />
      <Card className="overflow-hidden">
        {mine.length === 0 ? (
          <EmptyState icon={<Stethoscope className="size-6" />} title={t("clinic.visit.emptyQueue")} />
        ) : (
          <ul className="divide-y divide-border">
            {mine.map((a) => {
              const enc = encounters.get(a.id);
              return (
                <li key={a.id} className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-start sm:justify-between sm:px-6">
                  <div className="flex min-w-0 items-start gap-4 sm:flex-1">
                    <div className="w-16 shrink-0">
                      <p className="text-[15px] font-semibold tabular-nums">{format.dateTime(a.startsAt, { timeStyle: "short", timeZone: tz })}</p>
                      {a.queueNumber ? <p className="text-[12px] font-semibold text-accent">#{a.queueNumber}</p> : null}
                      {a.calledAt && a.status === "CHECKED_IN" ? <p className="text-[11.5px] font-semibold text-accent">{t("clinic.call.calledBadge")}</p> : null}
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold">{patientName(a.patient)}</p>
                      <p className="text-[13px] text-text-2">
                        {t("clinic.desk.age", { age: year - a.patient.birthDate.getUTCFullYear() })} ({a.patient.birthDate.getUTCFullYear()}) · {t(`sex.${a.patient.sex}` as never)}
                        {a.patient.address ? ` · ${a.patient.address}` : ""}
                        {a.room ? ` · ${a.room.name}` : ""}
                      </p>
                      <p className="text-[13px] text-text-2">
                        {history.get(a.patientId)?.lastEarlier
                          ? t("clinic.patients.returning", { count: history.get(a.patientId)!.earlier, date: format.dateTime(history.get(a.patientId)!.lastEarlier!.at, { dateStyle: "medium", timeZone: ctx.tenant.timezone }), doctor: history.get(a.patientId)!.lastEarlier!.doctor })
                          : <span className="font-semibold text-accent">{t("clinic.patients.firstVisit")}</span>}
                      </p>
                      {(tasks.get(a.id) ?? []).length && a.status !== "CANCELLED" && a.status !== "NO_SHOW" ? (
                        <div className="mt-2 flex flex-wrap gap-1.5" aria-label={t("clinic.visit.tasksLabel")}>
                          {tasks.get(a.id)!.map((task) => (
                            <Form key={`${task.serviceId}-${task.target}`} action={openTaskAction} className="space-y-0">
                              <input type="hidden" name="$slug" value={ctx.tenant.slug} />
                              <input type="hidden" name="appointmentId" value={a.id} />
                              <input type="hidden" name="target" value={task.target} />
                              <button className={buttonClass(task.done ? "secondary" : task.target === "visit" ? "primary" : "secondary", "sm", task.done ? "text-success" : "")}>
                                {task.done ? <Check aria-hidden className="size-4" /> : task.target === "visit" ? <Stethoscope aria-hidden className="size-4" /> : <FileText aria-hidden className="size-4" />}
                                {task.target === "visit" ? (task.name || t("clinic.visit.taskVisit")) : task.name}
                              </button>
                            </Form>
                          ))}
                        </div>
                      ) : paid.get(a.patientId)?.services.length ? <p className="text-[13px] text-text-2">{paid.get(a.patientId)!.services.join(", ")}</p> : a.service ? <p className="text-[13px] text-text-2">{a.service.name}</p> : null}
                      {vitals.get(a.patientId) ? (
                        <p className="mt-1 flex flex-wrap gap-x-3 text-[13px] font-medium">
                          {vitals.get(a.patientId)!.systolic ? <span>{t("clinic.desk.bp")}: {vitals.get(a.patientId)!.systolic}/{vitals.get(a.patientId)!.diastolic ?? "—"}</span> : null}
                          {vitals.get(a.patientId)!.pulse ? <span>{t("clinic.desk.pulse")}: {vitals.get(a.patientId)!.pulse}</span> : null}
                          {vitals.get(a.patientId)!.weight ? <span>{t("clinic.desk.weight")}: {vitals.get(a.patientId)!.weight}</span> : null}
                          {vitals.get(a.patientId)!.height ? <span>{t("clinic.desk.height")}: {vitals.get(a.patientId)!.height}</span> : null}
                        </p>
                      ) : null}
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {paid.get(a.patientId) ? <Badge tone={paid.get(a.patientId)!.paidMinor >= paid.get(a.patientId)!.totalMinor ? "success" : "warning"}>{t("clinic.desk.paidOf", { paid: money(paid.get(a.patientId)!.paidMinor, ctx.tenant.currency), total: money(paid.get(a.patientId)!.totalMinor, ctx.tenant.currency) })}</Badge> : null}
                        {(debt.get(a.patientId) ?? 0n) > 0n ? <Badge tone="danger">{t("clinic.desk.debtShort", { amount: money(debt.get(a.patientId)!, ctx.tenant.currency) })}</Badge> : null}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={STATUS_TONE[a.status]}>{t(`status.${a.status}`)}</Badge>
                    {enc ? (
                      <Link href={`/c/${ctx.tenant.slug}/encounters/${enc}`} className={buttonClass(a.status === "IN_PROGRESS" ? "primary" : "secondary", "sm")}>
                        {t("clinic.visit.continue")}
                      </Link>
                    ) : a.status === "BOOKED" || a.status === "CHECKED_IN" ? (
                      <Form action={startVisitAction} className="space-y-0">
                        <input type="hidden" name="$slug" value={ctx.tenant.slug} />
                        <input type="hidden" name="appointmentId" value={a.id} />
                        <button className={buttonClass(a.status === "CHECKED_IN" ? "primary" : "secondary", "sm")}>{t("clinic.visit.start")}</button>
                      </Form>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
