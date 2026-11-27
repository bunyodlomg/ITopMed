import { CalendarClock } from "lucide-react";
import { AutoRefresh } from "@/components/auto-refresh";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { PatientPicker, patientName } from "@/components/patients";
import { Form, SelectField, SubmitButton, TextField } from "@/components/ui/form";
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, STATUS_TONE, buttonClass } from "@/components/ui/primitives";
import { CANCELLATION_REASONS, listDay } from "@/server/appointments/appointments";
import { requireClinic } from "@/server/auth/guards";
import { canUseBranch, listOperationalBranches } from "@/server/clinic/context";
import { listDoctors } from "@/server/clinic/doctors";
import { withAppContext } from "@/server/db";
import { searchPatients } from "@/server/patients/patients";
import { isLocalDate, todayIn } from "@/server/scheduling/time";
import { queueAction, rescheduleAction, walkInAction } from "../../../care-actions";
import { FilterChips, hrefWith } from "@/components/ui/toolbar";
import { queueEta, roundUp5 } from "@/lib/queue-eta";

const UUID = /^[0-9a-f-]{36}$/;

export default async function QueuePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug, "queue.manage");
  const sp = await searchParams;
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  const tz = ctx.tenant.timezone;
  const today = todayIn(tz);
  const date = isLocalDate(sp.date) ? sp.date : today;
  const base = `/c/${ctx.tenant.slug}/queue`;
  const canManage = ctx.permissions.has("appointments.manage");

  const [all, doctors, branches] = await Promise.all([listDay(ctx, date), listDoctors(ctx), listOperationalBranches(ctx)]);
  // Quick filters: what the desk asks most - who is waiting, who is inside, who is done; by doctor.
  const show = (["waiting", "inside", "done", "booked"] as const).find((x) => x === sp.show);
  const doctorFilter = sp.doctor && UUID.test(sp.doctor) ? sp.doctor : undefined;
  const inGroup = (a: (typeof all)[number], g: NonNullable<typeof show>) =>
    g === "waiting" ? a.status === "CHECKED_IN" : g === "inside" ? a.status === "IN_PROGRESS" : g === "done" ? a.status === "COMPLETED" : a.status === "BOOKED";
  const ofDoctor = doctorFilter ? all.filter((a) => a.doctorProfileId === doctorFilter) : all;
  const appointments = show ? ofDoctor.filter((a) => inGroup(a, show)) : ofDoctor;
  const eta = date === today ? queueEta(all, new Date()) : new Map<string, never>();
  const here = { date: sp.date, show: sp.show, doctor: sp.doctor };
  const dayDoctors = [...new Map(all.map((a) => [a.doctorProfileId, a.doctor.membership.user.fullName])).entries()];
  const usableBranches = branches.filter((b) => canUseBranch(ctx, b.id));
  const patientId = sp.patient && UUID.test(sp.patient) ? sp.patient : undefined;
  const walkInPatient = patientId
    ? await withAppContext({ tenantId: ctx.tenant.id, userId: ctx.principal.user.id }, (tx) => tx.patient.findFirst({ where: { id: patientId, status: "ACTIVE" }, select: { id: true, mrn: true, lastName: true, firstName: true, middleName: true } }))
    : null;
  const q = sp.q ?? "";
  const results = !walkInPatient && q.trim().length >= 2 ? await searchPatients(ctx, q) : null;
  const hidden = (id: string) => (
    <>
      <input type="hidden" name="$slug" value={ctx.tenant.slug} />
      <input type="hidden" name="appointmentId" value={id} />
    </>
  );

  return (
    <div className="space-y-6">
      <AutoRefresh seconds={20} />
      <PageHeader
        title={t("clinic.queue.title")}
        description={t("clinic.queue.subtitle")}
        action={
          <form method="get" className="flex items-end gap-2">
            <input type="date" name="date" defaultValue={date} aria-label={t("clinic.queue.date")} className="h-10 rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 text-[14px]" />
            <button className={buttonClass("secondary")}>{t("clinic.booking.show")}</button>
          </form>
        }
      />
      {sp.added ? <Alert tone="success">{t("clinic.queue.added")}</Alert> : null}

      {all.length ? (
        <div className="space-y-3">
          <FilterChips
            label={t("clinic.queue.filterStatus")}
            chips={[
              { label: t("common.all"), count: ofDoctor.length, href: hrefWith(base, here, { show: undefined }), active: !show },
              ...(["waiting", "inside", "done", "booked"] as const).map((g) => ({ label: t(`clinic.queue.group.${g}`), count: ofDoctor.filter((a) => inGroup(a, g)).length, href: hrefWith(base, here, { show: g }), active: show === g })),
            ]}
          />
          {dayDoctors.length > 1 ? (
            <FilterChips
              label={t("clinic.queue.filterDoctor")}
              chips={[
                { label: t("clinic.queue.allDoctors"), href: hrefWith(base, here, { doctor: undefined }), active: !doctorFilter },
                ...dayDoctors.map(([id, name]) => ({ label: name, count: all.filter((a) => a.doctorProfileId === id && a.status === "CHECKED_IN").length, href: hrefWith(base, here, { doctor: id }), active: doctorFilter === id })),
              ]}
            />
          ) : null}
        </div>
      ) : null}

      <Card className="overflow-hidden">
        {appointments.length === 0 ? (
          <EmptyState icon={<CalendarClock className="size-6" />} title={all.length ? t("clinic.queue.emptyFilter") : t("clinic.queue.empty")} />
        ) : (
          <ul className="divide-y divide-border">
            {appointments.map((a) => (
              <li key={a.id} className="grid gap-3 px-5 py-3.5 sm:grid-cols-[72px_1fr_auto] sm:items-center sm:px-6">
                <div className="flex items-center gap-3 sm:block">
                  <p className="text-[15px] font-semibold tabular-nums">{format.dateTime(a.startsAt, { timeStyle: "short", timeZone: tz })}</p>
                  {a.queueNumber ? <p className="rounded-md bg-accent-soft px-1.5 text-center text-[12px] font-semibold text-accent">#{a.queueNumber}</p> : null}
                </div>
                <div className="min-w-0">
                  <Link href={`/c/${ctx.tenant.slug}/patients/${a.patient.id}`} className="font-medium hover:text-accent">
                    {patientName(a.patient)}
                  </Link>
                  <p className="truncate text-[13px] text-text-2">
                    {a.patient.mrn} · {a.doctor.membership.user.fullName}
                    {a.service ? ` · ${a.service.name}` : ""}
                    {a.room ? ` · ${a.room.name}` : ""} · {t(`apptSource.${a.source}`)}
                  </p>
                  {a.adminNote ? <p className="text-[12.5px] text-text-3">{a.adminNote}</p> : null}
                  {eta.get(a.id) ? (
                    <p className="text-[13px] font-medium text-accent">
                      {eta.get(a.id)!.waitMinutes === 0
                        ? t("clinic.queue.etaNext")
                        : t("clinic.queue.etaLong", { time: format.dateTime(roundUp5(eta.get(a.id)!.at), { timeStyle: "short", timeZone: tz }), minutes: eta.get(a.id)!.waitMinutes, ahead: eta.get(a.id)!.ahead })}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <Badge tone={STATUS_TONE[a.status]}>{t(`status.${a.status}`)}</Badge>
                  {a.status === "BOOKED" && date === today ? (
                    <Form action={queueAction} className="space-y-0">
                      {hidden(a.id)}
                      <div className="flex gap-2">
                        <button name="op" value="check_in" className={buttonClass("primary", "sm")}>{t("clinic.queue.checkIn")}</button>
                        {a.startsAt <= new Date() ? <button name="op" value="no_show" className={buttonClass("ghost", "sm")}>{t("clinic.queue.noShow")}</button> : null}
                      </div>
                    </Form>
                  ) : null}
                  {canManage && a.status === "BOOKED" ? (
                    <details className="w-full sm:w-auto">
                      <summary className={buttonClass("ghost", "sm", "cursor-pointer list-none")}>{t("clinic.queue.reschedule")}</summary>
                      <Form action={rescheduleAction} className="mt-2 space-y-3 rounded-[var(--radius-control)] border border-border bg-surface-2 p-3">
                        {hidden(a.id)}
                        <div className="grid grid-cols-2 gap-2">
                          <label className="text-[12px] text-text-3">
                            {t("clinic.queue.newDate")}
                            <input type="date" name="date" defaultValue={date} min={today} required className="mt-1 block h-10 w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-2 text-[14px] text-text" />
                          </label>
                          <label className="text-[12px] text-text-3">
                            {t("clinic.queue.newTime")}
                            <input type="time" name="time" step={300} required className="mt-1 block h-10 w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-2 text-[14px] text-text" />
                          </label>
                        </div>
                        <SubmitButton variant="secondary">{t("clinic.queue.rescheduleSubmit")}</SubmitButton>
                      </Form>
                    </details>
                  ) : null}
                  {canManage && (a.status === "BOOKED" || a.status === "CHECKED_IN") ? (
                    <Form action={queueAction} className="space-y-0">
                      {hidden(a.id)}
                      <div className="flex gap-2">
                        <select name="reason" aria-label={t("clinic.queue.cancelReason")} className="h-8 rounded-[8px] border border-border bg-surface px-2 text-[13px]">
                          {CANCELLATION_REASONS.map((r) => (
                            <option key={r} value={r}>{t(`cancelReason.${r}`)}</option>
                          ))}
                        </select>
                        <button name="op" value="cancel" className={buttonClass("ghost", "sm")}>{t("clinic.queue.cancel")}</button>
                      </div>
                    </Form>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {date === today ? (
        <Card>
          <CardHeader title={t("clinic.queue.walkIn")} description={t("clinic.queue.walkInHint")} />
          <CardBody className="space-y-4">
            {walkInPatient ? (
              <Form action={walkInAction}>
                <input type="hidden" name="$slug" value={ctx.tenant.slug} />
                <input type="hidden" name="patientId" value={walkInPatient.id} />
                <p className="font-medium">
                  {patientName(walkInPatient)} <span className="text-[13px] font-normal text-text-3">{walkInPatient.mrn}</span>
                </p>
                <div className="grid gap-4 sm:grid-cols-3">
                  <SelectField name="doctorProfileId" label={t("clinic.booking.doctor")} options={doctors.filter((d) => d.profile).map((d) => ({ value: d.profile!.id, label: d.fullName }))} />
                  <SelectField name="branchId" label={t("clinic.queue.branch")} options={usableBranches.map((b) => ({ value: b.id, label: b.name }))} />
                  <TextField name="adminNote" label={t("clinic.booking.adminNote")} hint={t("clinic.booking.adminNoteHint")} optionalLabel={t("common.optional")} />
                </div>
                <div className="flex justify-end gap-2">
                  <Link href={base} className={buttonClass("ghost")}>{t("clinic.booking.change")}</Link>
                  <SubmitButton>{t("clinic.queue.add")}</SubmitButton>
                </div>
              </Form>
            ) : (
              <PatientPicker results={results} q={q} keep={{}} baseHref={base} />
            )}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
