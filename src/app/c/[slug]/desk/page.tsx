import { ConciergeBell, FileText, Printer, Receipt, UserPlus } from "lucide-react";
import { AutoRefresh } from "@/components/auto-refresh";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { moneyFormatter } from "@/components/money";
import { minorToDecimalString } from "@/lib/money";
import { PatientPicker, formatBirthDate, patientName } from "@/components/patients";
import { ageOn, patientVisitSummaries } from "@/server/patients/overview";
import { ServicePicker } from "@/components/service-picker";
import { DoctorCodeInput } from "@/components/doctor-code";
import { DeskWizard, type DeskWizardStep } from "@/components/desk-wizard";
import { Form, SelectField, SubmitButton, TextField } from "@/components/ui/form";
import { Alert, Badge, ButtonLink, Card, CardBody, CardHeader, EmptyState, STATUS_TONE, buttonClass } from "@/components/ui/primitives";
import { listDay } from "@/server/appointments/appointments";
import { requireClinic } from "@/server/auth/guards";
import { listOperationalBranches } from "@/server/clinic/context";
import { doctorsWorkingOn, listDoctors } from "@/server/clinic/doctors";
import { listServices } from "@/server/clinic/resources";
import { withAppContext } from "@/server/db";
import { searchPatients } from "@/server/patients/patients";
import { todayMoney } from "@/server/reception/desk";
import { followUpStatus } from "@/server/billing/rules";
import { listBenefitCategories } from "@/server/clinic/pricing";
import { listTemplates } from "@/server/clinic/templates";
import { todayIn } from "@/server/scheduling/time";
import { deskCheckInAction, payDebtAction } from "../../../desk-actions";
import { PAYMENT_METHODS } from "@/server/billing/billing";
import { queueEta, roundUp5 } from "@/lib/queue-eta";

/**
 * Qabulxona - the reception desk on one screen: find or register the patient,
 * tick the services (live total), take the payment or leave a debt, measure
 * height/weight/blood pressure, choose the doctor -> queue number and print.
 * Today's queue with who paid what is on the right.
 */
export default async function DeskPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ q?: string; patient?: string; done?: string; doctor?: string; paid?: string; vitals?: string }> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug, "queue.manage");
  const sp = await searchParams;
  const [t, format, money] = await Promise.all([getTranslations(), getFormatter(), moneyFormatter()]);
  const tz = ctx.tenant.timezone;
  const today = todayIn(tz);
  const base = `/c/${ctx.tenant.slug}`;
  // billing.invoice: the desk also takes the money (or decides on debt); billing.charge alone
  // (a receptionist next to a separate cashier): the chosen services go on the bill unpaid.
  const canInvoice = ctx.permissions.has("billing.invoice");
  const canBill = canInvoice || ctx.permissions.has("billing.charge");
  const canPay = ctx.permissions.has("billing.payment");
  const canMeasure = ctx.permissions.has("vitals.write");
  const db = { tenantId: ctx.tenant.id, userId: ctx.principal.user.id };

  const canFreeVisit = canInvoice && ctx.permissions.has("billing.free_visit");
  // The desk opens a visit's print list (documents, prescription, diagnostic reports; only once paid);
  // a doctor working the desk without documents.print keeps the quick link to the first document.
  const deskPrints = ctx.permissions.has("documents.print");
  const canPrint = !deskPrints && ctx.permissions.has("emr.read");
  const [branches, doctors, working, services, day, benefits, docTemplates] = await Promise.all([
    listOperationalBranches(ctx),
    listDoctors(ctx),
    doctorsWorkingOn(ctx, today),
    canBill ? listServices(ctx) : Promise.resolve([]),
    listDay(ctx, today),
    listBenefitCategories(ctx),
    canPrint ? listTemplates(ctx, { kind: "DOCUMENT" }) : Promise.resolve([]),
  ]);
  const withProfile = doctors.filter((d) => d.profile && !d.profile.archivedAt);
  const workingIds = new Set(working.map((w) => w.profileId));
  const doctorOptions = [...withProfile].sort((a, b) => Number(workingIds.has(b.profile!.id)) - Number(workingIds.has(a.profile!.id))).map((d) => ({
    value: d.profile!.id,
    label: `${d.profile!.code ? `${d.profile!.code} · ` : ""}${d.fullName} · ${t(`specialties.${d.profile!.specialty}` as never)}${workingIds.has(d.profile!.id) ? "" : ` (${t("clinic.desk.notToday")})`}`,
  }));
  const doctorCodes = withProfile
    .filter((d) => d.profile!.code)
    .map((d) => ({ code: d.profile!.code!, profileId: d.profile!.id, label: `${d.fullName} · ${t(`specialties.${d.profile!.specialty}` as never)}${workingIds.has(d.profile!.id) ? "" : ` (${t("clinic.desk.notToday")})`}` }));
  const priced = services.filter((s) => s.priceMinor > 0n).map((s) => ({ id: s.id, name: s.name, priceMinor: s.priceMinor.toString(), currency: s.currency }));
  const unpriced = services.filter((s) => s.priceMinor === 0n).length;

  const chosen = sp.patient
    ? await withAppContext(db, (tx) => tx.patient.findFirst({ where: { id: sp.patient, status: "ACTIVE" }, select: { id: true, mrn: true, lastName: true, firstName: true, middleName: true, birthDate: true, birthYearOnly: true, phone: true, address: true } })).catch(() => null)
    : null;
  const results = !chosen && sp.q ? await searchPatients(ctx, sp.q) : null;
  const visitInfo = await patientVisitSummaries(ctx, [...(results ?? []).map((r) => r.id), ...(chosen ? [chosen.id] : [])]);
  const chosenVisits = chosen ? visitInfo.get(chosen.id) : undefined;

  const queue = day.filter((a) => a.queueNumber !== null || a.status !== "CANCELLED").sort((a, b) => (a.queueNumber ?? 999) - (b.queueNumber ?? 999) || +a.startsAt - +b.startsAt);
  const { today: paidToday, debt } = await todayMoney(ctx, [...new Set([...queue.map((a) => a.patientId), ...(chosen ? [chosen.id] : [])])]);
  const done = sp.done ? queue.find((a) => a.id === sp.done) : undefined;
  const finished = queue.filter((a) => a.status === "COMPLETED").map((a) => a.id);
  const encounters = canPrint && finished.length ? new Map((await withAppContext(db, (tx) => tx.encounter.findMany({ where: { appointmentId: { in: finished } }, select: { id: true, appointmentId: true } }))).map((e) => [e.appointmentId!, e.id])) : new Map<string, string>();
  // Header figures: today's queue, who is still waiting (checked in, not yet called), money.
  const waiting = queue.filter((a) => a.status === "CHECKED_IN" && !a.calledAt);
  const eta = queueEta(queue, new Date());
  const next = waiting[0];
  let paidSum = 0n;
  for (const m of paidToday.values()) if (m.currency === ctx.tenant.currency) paidSum += m.paidMinor;
  let debtSum = 0n;
  for (const a of new Set(queue.map((q) => q.patientId))) debtSum += debt.get(a) ?? 0n;
  const followUp = chosen && canInvoice ? await followUpStatus(ctx, chosen.id) : null;
  const doneInvoice = done ? await withAppContext(db, (tx) => tx.invoice.findUnique({ where: { appointmentId: done.id }, select: { id: true, totalMinor: true, paidMinor: true, currency: true } })).catch(() => null) : null;

  const wizardSteps: DeskWizardStep[] = [
    { key: "patient", label: t("clinic.desk.wizard.patient") },
    ...(canBill ? [{ key: "services" as const, label: t("clinic.desk.wizard.services") }] : []),
    ...(canMeasure ? [{ key: "vitals" as const, label: t("clinic.desk.wizard.vitals") }] : []),
    { key: "doctor", label: t("clinic.desk.wizard.doctor") },
  ];

  // Today's queue in the order the desk works it: waiting (by number), in the doctor's room,
  // booked but not here yet, finished; no-shows and cancellations folded away.
  type Row = (typeof queue)[number];
  const groupOf = (a: Row) =>
    a.status === "IN_PROGRESS" || (a.status === "CHECKED_IN" && a.calledAt) ? "inRoom" : a.status === "CHECKED_IN" ? "waiting" : a.status === "BOOKED" ? "booked" : a.status === "COMPLETED" ? "done" : "other";
  const groups = (["waiting", "inRoom", "booked", "done", "other"] as const).map((key) => ({ key, rows: queue.filter((a) => groupOf(a) === key) }));
  const queueRow = (a: Row, group: string) => {
    const m = paidToday.get(a.patientId);
    const owes = debt.get(a.patientId) ?? 0n;
    const tone = group === "inRoom" ? "border-l-accent-solid" : group === "waiting" ? "border-l-warning" : group === "done" ? "border-l-success" : "border-l-transparent";
    return (
      <li key={a.id} className={`flex items-start gap-3 border-l-4 px-4 py-3 ${tone} ${group === "done" || group === "other" ? "opacity-80" : ""}`}>
        <span className={`grid size-11 shrink-0 place-items-center rounded-[14px] text-[17px] font-extrabold tabular-nums ${group === "inRoom" ? "bg-accent-solid text-on-accent" : "bg-sunken text-text"}`}>{a.queueNumber ?? "·"}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14.5px] font-semibold">{patientName(a.patient)}</p>
          <p className="truncate text-[12.5px] text-text-2">
            {a.doctor.membership.user.fullName}
            {a.room ? ` · ${a.room.name}` : ""}
            {group === "booked" ? ` · ${format.dateTime(a.startsAt, { timeStyle: "short", timeZone: tz })}` : ""}
          </p>
          {m?.services.length ? <p className="truncate text-[12.5px] text-text-3">{m.services.join(", ")}</p> : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {group === "inRoom" ? <Badge tone="accent">{a.status === "IN_PROGRESS" ? t("status.IN_PROGRESS") : t("clinic.call.calledBadge")}</Badge> : null}
            {group === "other" ? <Badge tone={STATUS_TONE[a.status]}>{t(`status.${a.status}`)}</Badge> : null}
            {group === "waiting" && eta.get(a.id) ? (
              <span className="text-[12.5px] font-medium text-text-2">
                {t("clinic.queue.etaShort", { time: format.dateTime(roundUp5(eta.get(a.id)!.at), { timeStyle: "short", timeZone: tz }), ahead: eta.get(a.id)!.ahead })}
              </span>
            ) : null}
            {m ? (
              m.paidMinor >= m.totalMinor ? (
                <Badge tone="success">{t("clinic.desk.payPaid")}</Badge>
              ) : (
                <Badge tone={m.paidMinor === 0n ? "danger" : "warning"}>{t("clinic.desk.payDue", { amount: money(m.totalMinor - m.paidMinor, m.currency) })}</Badge>
              )
            ) : null}
            {owes > (m ? m.totalMinor - m.paidMinor : 0n) ? <Badge tone="danger">{t("clinic.desk.debtShort", { amount: money(owes, ctx.tenant.currency) })}</Badge> : null}
            {owes > 0n && canPay && ctx.permissions.has("billing.read") ? (
              <Link href={`${base}/checkout?patient=${a.patientId}`} className="text-[13px] font-semibold text-accent hover:underline">
                {t("clinic.checkout.openCheckout")}
              </Link>
            ) : null}
          </div>
          {owes > 0n && canPay ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[13px] font-medium text-accent">{t("clinic.desk.takeDebt")}</summary>
              <Form action={payDebtAction} className="mt-2 space-y-2">
                <input type="hidden" name="$slug" value={ctx.tenant.slug} />
                <input type="hidden" name="patientId" value={a.patientId} />
                <TextField name="amount" label={t("clinic.desk.debtAmount")} hint={t("clinic.desk.debtAmountHint")} inputMode="decimal" placeholder={minorToDecimalString(owes, ctx.tenant.currency).replace(/\.00$/, "")} />
                <SelectField name="method" label={t("clinic.desk.method")} defaultValue="CASH" options={PAYMENT_METHODS.map((pm) => ({ value: pm, label: t(`paymentMethod.${pm}` as never) }))} />
                <SubmitButton variant="secondary">{t("clinic.desk.takeDebtSubmit")}</SubmitButton>
              </Form>
            </details>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          {deskPrints && a.status !== "CANCELLED" ? (
            <Link href={`${base}/desk/print/${a.id}`} className={buttonClass("ghost", "sm")} aria-label={t("clinic.deskPrint.listFor", { number: a.queueNumber ?? "—" })} title={t("clinic.deskPrint.listTitle")}>
              <FileText aria-hidden className="size-4" />
            </Link>
          ) : encounters.get(a.id) && docTemplates[0] ? (
            <Link href={`${base}/encounters/${encounters.get(a.id)}/document/${docTemplates[0].id}?print=1`} target="_blank" className={buttonClass("ghost", "sm")} aria-label={t("clinic.desk.printDocument", { name: docTemplates[0].name })} title={docTemplates[0].name}>
              <FileText aria-hidden className="size-4" />
            </Link>
          ) : null}
          {group !== "other" ? (
            <Link href={`${base}/desk/ticket/${a.id}?print=1`} target="_blank" className={buttonClass("ghost", "sm")} aria-label={t("clinic.desk.printTicket")} title={t("clinic.desk.printTicket")}>
              <Printer aria-hidden className="size-4" />
            </Link>
          ) : null}
        </div>
      </li>
    );
  };

  return (
    <div className="space-y-6">
      <AutoRefresh seconds={20} />
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[28px] font-semibold leading-[1.1] tracking-[-0.035em] sm:text-[32px]">{t("clinic.desk.title")}</h1>
        <dl aria-label={t("clinic.desk.today")} className="grid w-full min-w-0 grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
          {[
            [t("clinic.desk.statPatients"), `${queue.length}`, ""],
            [t("clinic.desk.statWaiting"), `${waiting.length}`, ""],
            [t("clinic.desk.statPaid"), money(paidSum, ctx.tenant.currency), "text-success"],
            [t("clinic.desk.statDebt"), money(debtSum, ctx.tenant.currency), debtSum > 0n ? "text-danger" : ""],
          ].map(([label, value, tone]) => (
            <div key={label} className="flex min-w-0 flex-wrap items-baseline gap-x-2 rounded-[16px] bg-surface px-3 py-1.5 shadow-card sm:rounded-full sm:px-4 sm:py-2">
              <dt className="text-[12.5px] text-text-2">{label}</dt>
              <dd className={`text-[15px] font-bold tabular-nums ${tone}`}>{value}</dd>
            </div>
          ))}
        </dl>
      </header>

      {done && sp.vitals === "lost" ? <Alert tone="warning">{t("clinic.desk.vitalsLost")}</Alert> : null}
      {sp.paid && /^[\d ]{1,20}$/.test(sp.paid) ? <Alert tone="success">{t("clinic.desk.debtPaid", { paid: sp.paid })}</Alert> : null}

      {done ? (
        <Card className="border-2 border-accent-solid">
          <CardBody className="flex flex-wrap items-center justify-between gap-5">
            <div className="flex min-w-0 items-center gap-5">
              <div className="grid size-20 shrink-0 place-items-center rounded-[22px] bg-accent-solid text-on-accent">
                <span className="text-[13px] font-medium leading-none opacity-90">{t("clinic.desk.number")}</span>
                <span className="text-[34px] font-bold leading-none tabular-nums">{done.queueNumber ?? "—"}</span>
              </div>
              <div className="min-w-0">
                <p className="text-[18px] font-semibold">{patientName(done.patient)}</p>
                <p className="text-[14px] text-text-2">
                  {t("clinic.desk.toDoctor", { name: done.doctor.membership.user.fullName })}
                  {done.room ? ` · ${done.room.name}` : ""}
                </p>
                {doneInvoice && doneInvoice.totalMinor > doneInvoice.paidMinor && !canPay ? (
                  <p className="mt-1 text-[15px] font-semibold text-warning">{t("clinic.desk.payAtCashier", { amount: money(doneInvoice.totalMinor - doneInvoice.paidMinor, doneInvoice.currency) })}</p>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href={`${base}/desk/ticket/${done.id}?print=1`} target="_blank" className={buttonClass("secondary", "md")}>
                <Printer aria-hidden className="size-4" /> {t("clinic.desk.printTicket")}
              </Link>
              {doneInvoice && ctx.permissions.has("billing.read") ? (
                <Link href={`${base}/billing/${doneInvoice.id}/receipt?w=80&print=1`} target="_blank" className={buttonClass("secondary", "md")}>
                  <Receipt aria-hidden className="size-4" /> {t("clinic.desk.printReceipt")}
                </Link>
              ) : null}
              <ButtonLink href={`${base}/desk`}>
                <UserPlus aria-hidden className="size-4" /> {t("clinic.desk.next")}
              </ButtonLink>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0">
        <DeskWizard key={done?.id ?? chosen?.id ?? "new"} steps={wizardSteps} initial={chosen ? 1 : 0} formId="desk-form" patientLabel={chosen ? patientName(chosen) : undefined} prices={Object.fromEntries(priced.map((p) => [p.id, p.priceMinor]))} currency={ctx.tenant.currency}>
        {!chosen ? (
          <Card data-step={0}>
            <CardHeader title={t("clinic.desk.step1")} description={t("clinic.desk.searchHint")} />
            <CardBody>
              <PatientPicker results={results} q={sp.q ?? ""} keep={{}} baseHref={`${base}/desk`} visits={visitInfo} timeZone={tz} />
            </CardBody>
          </Card>
        ) : null}
        <Form id="desk-form" action={deskCheckInAction} className="space-y-4">
          <input type="hidden" name="$slug" value={ctx.tenant.slug} />

          <Card data-step={0}>
            <CardHeader title={chosen ? t("clinic.desk.step1") : t("clinic.desk.newPatient")} />
            <CardBody className="space-y-4">
              {chosen ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-accent bg-accent-soft px-4 py-3">
                  <input type="hidden" name="patientId" value={chosen.id} />
                  <div className="min-w-0">
                    <p className="font-semibold">{patientName(chosen)}</p>
                    <p className="text-[13px] text-text-2">
                      {chosen.mrn} · {t("clinic.desk.age", { age: ageOn(chosen.birthDate, today) })} ({await formatBirthDate(chosen.birthDate, chosen.birthYearOnly)})
                      {chosen.phone ? ` · ${chosen.phone}` : ""}
                      {chosen.address ? ` · ${chosen.address}` : ""}
                    </p>
                    <p className="mt-1 text-[13px] text-text-2">
                      {chosenVisits?.lastEarlier
                        ? t("clinic.patients.returning", { count: chosenVisits.earlier, date: format.dateTime(chosenVisits.lastEarlier.at, { dateStyle: "medium", timeZone: tz }), doctor: chosenVisits.lastEarlier.doctor })
                        : t("clinic.patients.firstVisit")}
                    </p>
                    {chosenVisits?.today ? <p className="mt-1 text-[13px] font-semibold text-warning">{t("clinic.patients.alreadyToday")}</p> : null}
                    {(debt.get(chosen.id) ?? 0n) > 0n ? <p className="mt-1 text-[13px] font-semibold text-danger">{t("clinic.desk.hasDebt", { amount: money(debt.get(chosen.id)!, ctx.tenant.currency) })}</p> : null}
                  </div>
                  <Link href={`${base}/desk`} className={buttonClass("ghost", "sm")}>
                    {t("clinic.desk.otherPatient")}
                  </Link>
                </div>
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <TextField name="lastName" label={t("clinic.patients.lastName")} autoComplete="off" required />
                    <TextField name="firstName" label={t("clinic.patients.firstName")} autoComplete="off" required />
                    <TextField name="middleName" label={t("clinic.patients.middleName")} autoComplete="off" optionalLabel={t("common.optional")} />
                    <TextField name="birthDate" label={t("clinic.desk.birth")} hint={t("clinic.desk.birthHint")} placeholder="1947" inputMode="numeric" autoComplete="off" required />
                    <SelectField name="sex" label={t("clinic.patients.sex")} defaultValue="UNKNOWN" options={(["FEMALE", "MALE", "UNKNOWN"] as const).map((s) => ({ value: s, label: t(`sex.${s}`) }))} />
                    <TextField name="phone" type="tel" label={t("clinic.patients.phone")} inputMode="tel" placeholder="+998" autoComplete="off" optionalLabel={t("common.optional")} />
                  </div>
                  <details className="group rounded-[var(--radius-control)] border border-border px-4 py-2">
                    <summary className="flex min-h-9 cursor-pointer items-center text-[13.5px] font-medium text-text-2">{t("clinic.desk.wizard.more")}</summary>
                  <div className="grid gap-4 pb-2 pt-3 sm:grid-cols-3">
                    <TextField name="address" label={t("clinic.patients.address")} autoComplete="off" optionalLabel={t("common.optional")} className="sm:col-span-3" />
                    <SelectField
                      name="referralSource"
                      label={t("clinic.desk.referral")}
                      defaultValue="SELF"
                      options={(["SELF", "DOCTOR", "ADVERTISING", "OTHER"] as const).map((r) => ({ value: r, label: t(`referralSource.${r}`) }))}
                    />
                    <TextField name="referralDetail" label={t("clinic.desk.referralDetail")} hint={t("clinic.desk.referralDetailHint")} autoComplete="off" optionalLabel={t("common.optional")} />
                    {benefits.length ? (
                      <SelectField name="benefitCategoryId" label={t("clinic.desk.benefit")} defaultValue="" options={[{ value: "", label: t("clinic.desk.noBenefit") }, ...benefits.map((b) => ({ value: b.id, label: `${b.name} (−${b.discountPercent}%)` }))]} />
                    ) : null}
                  </div>
                  </details>
                  <label className="flex items-start gap-2 text-[13px] text-text-2">
                    <input type="checkbox" name="confirmNotDuplicate" className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" />
                    <span>{t("clinic.desk.confirmNew")}</span>
                  </label>
                </>
              )}
            </CardBody>
          </Card>

          {canBill ? (
            <Card data-step={wizardSteps.findIndex((w) => w.key === "services")}>
              <CardHeader
                title={t("clinic.desk.step2")}
                action={ctx.permissions.has("services.manage") ? <ButtonLink href={`${base}/services`} variant="ghost" size="sm">{t("clinic.desk.editPrices")}</ButtonLink> : undefined}
              />
              <CardBody className="space-y-3">
                {priced.length ? <ServicePicker services={priced} withPayment={canPay && canInvoice} dense /> : <Alert tone="warning">{t("clinic.desk.noPrices")}</Alert>}
                {unpriced > 0 ? <p className="text-[12.5px] text-text-3">{t("clinic.desk.unpriced", { count: unpriced })}</p> : null}
                {followUp?.freeUntil ? <Alert tone="success">{t("clinic.desk.followUpFree", { date: format.dateTime(followUp.freeUntil, { dateStyle: "medium", timeZone: tz }) })}</Alert> : null}
                {canFreeVisit ? (
                  <details className="rounded-[12px] border border-border px-3 py-2">
                    <summary className="cursor-pointer text-[13px] font-medium">{t("clinic.desk.freeVisit")}</summary>
                    <div className="mt-2 space-y-2">
                      <label className="flex items-start gap-2 text-[13px]">
                        <input type="checkbox" name="freeVisit" className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" />
                        <span>{t("clinic.desk.freeVisitConfirm")}</span>
                      </label>
                      <TextField name="freeVisitReason" label={t("clinic.desk.freeVisitReason")} hint={t("clinic.desk.freeVisitReasonHint")} />
                    </div>
                  </details>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          {canMeasure ? (
            <Card data-step={wizardSteps.findIndex((w) => w.key === "vitals")}>
              <CardHeader title={t("clinic.desk.step3")} description={t("clinic.desk.step3Hint")} />
              <CardBody className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                <TextField name="HEIGHT" label={t("clinic.desk.height")} inputMode="decimal" placeholder="170" />
                <TextField name="WEIGHT" label={t("clinic.desk.weight")} inputMode="decimal" placeholder="75" />
                <TextField name="SYSTOLIC_BP" label={t("clinic.desk.systolic")} inputMode="numeric" placeholder="120" />
                <TextField name="DIASTOLIC_BP" label={t("clinic.desk.diastolic")} inputMode="numeric" placeholder="80" />
                <TextField name="HEART_RATE" label={t("clinic.desk.pulse")} inputMode="numeric" placeholder="72" />
              </CardBody>
            </Card>
          ) : null}

          <div data-step={wizardSteps.length - 1} className="space-y-4">
          <Card>
            <CardHeader title={t("clinic.desk.step4")} />
            <CardBody className="grid gap-4 sm:grid-cols-2">
              {doctorOptions.length ? <DoctorCodeInput doctors={doctorCodes} /> : null}
              {doctorOptions.length ? (
                <SelectField name="doctorProfileId" label={t("clinic.desk.doctor")} options={doctorOptions} defaultValue={sp.doctor ?? doctorOptions[0]!.value} />
              ) : (
                <Alert tone="warning">{t("clinic.desk.noDoctors")}</Alert>
              )}
              {branches.length > 1 ? (
                <SelectField name="branchId" label={t("clinic.booking.branch")} options={branches.map((b) => ({ value: b.id, label: b.name }))} defaultValue={branches.find((b) => b.isMain)?.id ?? branches[0]!.id} />
              ) : branches[0] ? (
                <input type="hidden" name="branchId" value={branches[0].id} />
              ) : null}
              <TextField name="adminNote" label={t("clinic.desk.note")} optionalLabel={t("common.optional")} className="sm:col-span-2" />
            </CardBody>
          </Card>

          <SubmitButton full>{t("clinic.desk.submit")}</SubmitButton>
          </div>
        </Form>
        </DeskWizard>
        </div>

        <div className="h-fit min-w-0 space-y-4 xl:sticky xl:top-4">
        <section aria-label={t("clinic.desk.nextUp")} className="rounded-[var(--radius-card)] bg-accent-solid p-5 text-on-accent">
          <p className="text-[13px] font-semibold opacity-80">{t("clinic.desk.nextUp")}</p>
          {next ? (
            // Compact: the number and the patient side by side, so today's queue below stays in view.
            <div className="mt-2 flex items-center gap-4">
              <p className="text-[44px] font-extrabold leading-none tracking-[-0.04em] tabular-nums">{next.queueNumber ?? "—"}</p>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[16px] font-bold">{patientName(next.patient)}</p>
                <p className="truncate text-[13px] opacity-80">
                  {next.doctor.membership.user.fullName}
                  {next.room ? ` · ${next.room.name}` : ""}
                </p>
                {waiting.length > 1 ? <p className="text-[13px] opacity-80">{t("clinic.queue.waitingMore", { count: waiting.length - 1 })}</p> : null}
              </div>
              <Link href={`${base}/desk/ticket/${next.id}?print=1`} target="_blank" className="grid size-11 shrink-0 place-items-center rounded-full border border-current" aria-label={t("clinic.desk.printTicket")} title={t("clinic.desk.printTicket")}>
                <Printer aria-hidden className="size-4" />
              </Link>
            </div>
          ) : (
            <p className="mt-2 text-pretty text-[14px] opacity-80">{t("clinic.desk.nextNone")}</p>
          )}
        </section>
        <Card>
          <CardHeader title={t("clinic.desk.today")} description={todayIso(format, today)} />
          {queue.length === 0 ? (
            <EmptyState icon={<ConciergeBell className="size-6" />} title={t("clinic.desk.emptyToday")} />
          ) : (
            <div className="max-h-[75vh] overflow-y-auto" tabIndex={0} aria-label={t("clinic.desk.today")}>
              <p className="flex flex-wrap gap-x-3 gap-y-1 border-b border-border px-4 pb-3 text-[13px] text-text-2">
                {groups
                  .filter((g) => g.rows.length && g.key !== "other")
                  .map((g) => (
                    <span key={g.key}>
                      {t(`clinic.desk.group.${g.key}`)} <strong className="tabular-nums text-text">{g.rows.length}</strong>
                    </span>
                  ))}
              </p>
              {groups.map((g) =>
                g.rows.length === 0 ? null : g.key === "other" ? (
                  <details key={g.key} className="border-t border-border">
                    <summary className="flex min-h-11 cursor-pointer items-center justify-between px-4 text-[12px] font-semibold uppercase tracking-[0.06em] text-text-3">
                      {t(`clinic.desk.group.${g.key}`)} <span className="tabular-nums">{g.rows.length}</span>
                    </summary>
                    <ul className="divide-y divide-border">{g.rows.map((a) => queueRow(a, g.key))}</ul>
                  </details>
                ) : (
                  <section key={g.key} className="border-t border-border first-of-type:border-t-0">
                    <h3 className="flex items-center justify-between bg-sunken/60 px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-text-3">
                      {t(`clinic.desk.group.${g.key}`)}
                      <span className="grid min-w-6 place-items-center rounded-full bg-surface px-2 text-[12px] tabular-nums text-text">{g.rows.length}</span>
                    </h3>
                    <ul className="divide-y divide-border">{g.rows.map((a) => queueRow(a, g.key))}</ul>
                  </section>
                ),
              )}
            </div>
          )}
        </Card>
        </div>
      </div>
    </div>
  );
}

function todayIso(format: Awaited<ReturnType<typeof getFormatter>>, day: string) {
  return format.dateTime(new Date(`${day}T12:00:00Z`), { dateStyle: "full", timeZone: "UTC" });
}
