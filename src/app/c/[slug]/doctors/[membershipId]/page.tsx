import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ScheduleView, weekdayNames } from "@/components/schedule-view";
import { Form, SelectField, SubmitButton, TextField } from "@/components/ui/form";
import { Alert, Badge, Card, CardBody, CardHeader, PageHeader, buttonClass } from "@/components/ui/primitives";
import { requireClinic } from "@/server/auth/guards";
import { canUseBranch, listOperationalBranches } from "@/server/clinic/context";
import { EXCEPTION_KINDS, doctorSlots, getDoctorDetail, listDoctors } from "@/server/clinic/doctors";
import { listDepartments, listRooms, listServices } from "@/server/clinic/resources";
import { SPECIALTIES } from "@/server/scheduling/specialties";
import { canSetCommission } from "@/server/billing/earnings";
import { isLocalDate, todayIn } from "@/server/scheduling/time";
import { addBlockAction, addExceptionAction, commissionAction, doctorProfileAction, doctorServicesAction, removeScheduleItemAction } from "../../../../workspace-actions";

const choice =
  "flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--radius-control)] border border-border bg-surface-2 px-3 text-[14px] has-[:checked]:border-accent has-[:checked]:bg-accent-soft";

export default async function DoctorPage({ params, searchParams }: { params: Promise<{ slug: string; membershipId: string }>; searchParams: Promise<{ date?: string }> }) {
  const { slug, membershipId } = await params;
  const ctx = await requireClinic(slug, "schedules.read");
  const doctor = (await listDoctors(ctx)).find((d) => d.membershipId === membershipId);
  if (!doctor) notFound();

  const t = await getTranslations();
  const format = await getFormatter();
  const canEditProfile = ctx.permissions.has("staff.manage");
  const canEditSchedule = ctx.permissions.has("schedules.manage");
  const canEditServices = ctx.permissions.has("staff.manage") || ctx.permissions.has("services.manage");
  const tz = ctx.tenant.timezone;
  const sp = await searchParams;
  const date = isLocalDate(sp.date) ? sp.date : todayIn(tz);

  const [departments, detail, branches, rooms, services, names] = await Promise.all([
    listDepartments(ctx),
    doctor.profile ? getDoctorDetail(ctx, doctor.profile.id) : null,
    listOperationalBranches(ctx),
    listRooms(ctx),
    ctx.permissions.has("services.read") ? listServices(ctx) : Promise.resolve([]),
    weekdayNames(),
  ]);
  const slots = doctor.profile ? await doctorSlots(ctx, doctor.profile.id, date) : [];
  const usableBranches = branches.filter((b) => canUseBranch(ctx, b.id));
  const p = doctor.profile;
  const hidden = (
    <>
      <input type="hidden" name="$slug" value={ctx.tenant.slug} />
      <input type="hidden" name="membershipId" value={membershipId} />
      {p ? <input type="hidden" name="profileId" value={p.id} /> : null}
    </>
  );

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader eyebrow={t("clinic.doctors.title")} title={doctor.fullName} description={p ? t(`specialties.${p.specialty}` as never) : undefined} />

      <Card>
        <CardHeader title={t("clinic.doctors.profile")} />
        <CardBody>
          <Form action={doctorProfileAction}>
            {hidden}
            <fieldset disabled={!canEditProfile} className="grid gap-5 sm:grid-cols-2">
              <SelectField name="specialty" label={t("clinic.doctors.specialty")} defaultValue={p?.specialty ?? "therapy"} options={SPECIALTIES.map((s) => ({ value: s, label: t(`specialties.${s}`) }))} />
              <SelectField name="departmentId" label={t("clinic.doctors.department")} defaultValue={p?.departmentId ?? ""} options={[{ value: "", label: t("clinic.services.noDepartment") }, ...departments.map((d) => ({ value: d.id, label: d.name }))]} />
              <TextField name="code" label={t("clinic.doctors.code")} hint={t("clinic.doctors.codeHint")} inputMode="numeric" placeholder="01" defaultValue={p?.code ?? ""} optionalLabel={t("common.optional")} />
              <TextField name="licenseNumber" label={t("clinic.doctors.license")} defaultValue={p?.licenseNumber} optionalLabel={t("common.optional")} />
              <TextField name="defaultSlotMinutes" label={t("clinic.doctors.slot")} hint={t("clinic.doctors.slotHint")} inputMode="numeric" defaultValue={String(p?.defaultSlotMinutes ?? 20)} />
              <TextField name="bufferMinutes" label={t("clinic.doctors.buffer")} hint={t("clinic.doctors.bufferHint")} inputMode="numeric" defaultValue={String(p?.bufferMinutes ?? 0)} />
              <TextField name="contactPhone" type="tel" label={t("clinic.doctors.contactPhone")} hint={t("clinic.doctors.contactHint")} defaultValue={p?.contactPhone ?? ""} optionalLabel={t("common.optional")} />
              <TextField name="contactTelegram" label={t("clinic.doctors.contactTelegram")} hint={t("clinic.doctors.contactTelegramHint")} defaultValue={p?.contactTelegram ?? ""} optionalLabel={t("common.optional")} />
              <label className={`${choice} sm:col-span-2`}>
                <input type="checkbox" name="acceptsOnlineBooking" defaultChecked={p?.acceptsOnlineBooking ?? false} className="size-4 accent-[var(--accent)]" />
                {t("clinic.doctors.onlineBooking")}
              </label>
            </fieldset>
            {canEditProfile ? (
              <div className="flex justify-end">
                <SubmitButton>{p ? t("common.save") : t("clinic.doctors.setupProfile")}</SubmitButton>
              </div>
            ) : null}
          </Form>
        </CardBody>
      </Card>

      {p && canSetCommission(ctx) ? (
        <Card>
          <CardHeader title={t("clinic.doctors.commission")} description={t("clinic.doctors.commissionHint")} />
          <CardBody>
            <Form action={commissionAction} className="flex flex-wrap items-end gap-3 space-y-0">
              {hidden}
              <div className="w-40">
                <TextField name="commissionPercent" label={t("clinic.doctors.commissionPercent")} inputMode="numeric" defaultValue={p.commissionPercent === null ? "" : String(p.commissionPercent)} />
              </div>
              <SubmitButton variant="secondary">{t("common.save")}</SubmitButton>
            </Form>
          </CardBody>
        </Card>
      ) : null}

      {p && detail ? (
        <>
          <Card>
            <CardHeader title={t("clinic.doctors.schedule")} />
            <ScheduleView blocks={detail.schedules} removeAction={canEditSchedule ? (removeScheduleItemAction as never) : undefined} slug={ctx.tenant.slug} />
            {canEditSchedule && usableBranches.length > 0 ? (
              <CardBody className="border-t border-border">
                <Form action={addBlockAction}>
                  {hidden}
                  <p className="text-[14px] font-semibold">{t("clinic.doctors.addBlock")}</p>
                  <div className="grid gap-4 sm:grid-cols-5">
                    <SelectField name="weekday" label={t("clinic.doctors.weekday")} options={[1, 2, 3, 4, 5, 6, 7].map((d) => ({ value: String(d), label: names[d]! }))} />
                    <TextField name="start" type="time" label={t("clinic.doctors.start")} defaultValue="09:00" />
                    <TextField name="end" type="time" label={t("clinic.doctors.end")} defaultValue="13:00" />
                    <SelectField name="branchId" label={t("clinic.doctors.branch")} options={usableBranches.map((b) => ({ value: b.id, label: b.name }))} />
                    <SelectField name="roomId" label={t("clinic.doctors.room")} defaultValue="" options={[{ value: "", label: t("clinic.doctors.noRoom") }, ...rooms.map((r) => ({ value: r.id, label: `${r.name} · ${r.branch.name}` }))]} />
                  </div>
                  <div className="flex justify-end">
                    <SubmitButton variant="secondary">{t("clinic.doctors.addBlock")}</SubmitButton>
                  </div>
                </Form>
              </CardBody>
            ) : null}
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title={t("clinic.doctors.exceptions")} description={t("clinic.doctors.privacyHint")} />
              {detail.exceptions.length === 0 ? (
                <CardBody><p className="text-[14px] text-text-2">{t("clinic.doctors.noExceptions")}</p></CardBody>
              ) : (
                <ul className="divide-y divide-border">
                  {detail.exceptions.map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-3 px-6 py-2.5 text-[14px]">
                      <span>
                        <span className="font-medium">{format.dateTime(new Date(`${e.localDate}T12:00:00Z`), { dateStyle: "medium", timeZone: "UTC" })}</span>
                        <span className="text-text-2"> · {t(`exceptionKind.${e.kind}`)}</span>
                      </span>
                      {canEditSchedule ? (
                        <Form action={removeScheduleItemAction} className="space-y-0">
                          <input type="hidden" name="$slug" value={ctx.tenant.slug} />
                          <input type="hidden" name="type" value="exception" />
                          <input type="hidden" name="id" value={e.id} />
                          <button className={buttonClass("ghost", "sm")}>{t("clinic.doctors.remove")}</button>
                        </Form>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {canEditSchedule ? (
                <CardBody className="border-t border-border">
                  <Form action={addExceptionAction}>
                    {hidden}
                    <div className="grid gap-4 sm:grid-cols-2">
                      <TextField name="date" type="date" label={t("clinic.doctors.date")} defaultValue={date} />
                      <SelectField name="kind" label={t("clinic.doctors.exceptionKind")} options={EXCEPTION_KINDS.map((k) => ({ value: k, label: t(`exceptionKind.${k}`) }))} />
                    </div>
                    <SubmitButton variant="secondary" full>{t("clinic.doctors.addException")}</SubmitButton>
                  </Form>
                </CardBody>
              ) : null}
            </Card>

            <Card>
              <CardHeader title={t("clinic.doctors.slotsTitle")} />
              <CardBody className="space-y-4">
                <form method="get" className="flex items-end gap-2">
                  <label className="flex-1">
                    <span className="mb-1.5 block text-[13px] font-medium">{t("clinic.doctors.date")}</span>
                    <input type="date" name="date" defaultValue={date} className="h-11 w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 text-[15px]" />
                  </label>
                  <button className={buttonClass("secondary", "lg")}>{t("clinic.doctors.showSlots")}</button>
                </form>
                <p className="text-[13px] font-medium text-text-2">{t("clinic.doctors.slotsFor", { date: format.dateTime(new Date(`${date}T12:00:00Z`), { dateStyle: "full", timeZone: "UTC" }) })}</p>
                {slots.length === 0 ? (
                  <p className="text-[14px] text-text-2">{t("clinic.doctors.noSlots")}</p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {slots.map((s) => (
                      <li key={s.start.toISOString()} className="rounded-lg bg-accent-soft px-2.5 py-1 text-[13px] font-medium tabular-nums text-accent">
                        {format.dateTime(s.start, { timeStyle: "short", timeZone: tz })}
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          </div>

          {services.length > 0 ? (
            <Card>
              <CardHeader title={t("clinic.doctors.services")} />
              <CardBody>
                <Form action={doctorServicesAction}>
                  {hidden}
                  <fieldset disabled={!canEditServices} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {services.map((s) => (
                      <label key={s.id} className={choice}>
                        <input type="checkbox" name="serviceIds" value={s.id} defaultChecked={detail.serviceIds.includes(s.id)} className="size-4 accent-[var(--accent)]" />
                        <span className="min-w-0">
                          <span className="block truncate">{s.name}</span>
                          <span className="block font-mono text-[11px] text-text-3">{s.code}</span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  {canEditServices ? (
                    <div className="flex justify-end">
                      <SubmitButton variant="secondary">{t("common.save")}</SubmitButton>
                    </div>
                  ) : null}
                </Form>
              </CardBody>
            </Card>
          ) : null}
        </>
      ) : (
        <Alert tone="neutral">
          <Badge tone="warning">{t("clinic.doctors.noProfile")}</Badge>
        </Alert>
      )}
    </div>
  );
}
