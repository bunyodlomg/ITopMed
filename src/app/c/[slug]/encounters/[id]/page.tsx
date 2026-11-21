import { notFound } from "next/navigation";
import { TabletFractionPicture } from "@/components/tablet-fraction";
import { DOSE_SUGGESTIONS } from "@/lib/tablet-fraction";
import { rxDrugLabel } from "@/lib/rx";
import { instantToLocalDate } from "@/server/scheduling/time";
import { DispensaryCard } from "@/components/dispensary";
import { patientDispensary } from "@/server/emr/dispensary";
import { parseSchemeContent } from "@/lib/rx-scheme";
import { getFormatter, getTranslations } from "next-intl/server";
import { AllergyBanner, AllergyForm, DiagnosisList, SignedNote, VitalsForm, VitalsTable } from "@/components/clinical";
import { formatBirthDate, patientName } from "@/components/patients";
import { Form, SelectField, SubmitButton, TextAreaField, TextField } from "@/components/ui/form";
import { Alert, Badge, ButtonLink, Card, CardBody, CardHeader, PageHeader, STATUS_TONE, buttonClass } from "@/components/ui/primitives";
import { requireClinic } from "@/server/auth/guards";
import { NOTE_SECTIONS, amendmentHash, getEncounter, noteHash } from "@/server/emr/record";
import { requestMeta } from "@/server/http";
import { DomainError } from "@/server/tenancy/provisioning";
import { allergyAction, amendAction, applyNoteTemplateAction, applySchemeAction, cancelPrescriptionAction, clinicalStatusAction, diagnosisAction, finishVisitAction, noteAction, prescriptionAction, vitalsAction } from "../../../../care-actions";
import { labOrderAction } from "../../../../lab-actions";
import { labReleaseAction } from "../../../../portal-actions";
import { LabResultsList } from "@/components/lab";
import { DentalChart, DentalHistory, ToothForm } from "@/components/dental";
import { toothAction } from "../../../../dental-actions";
import { listLabTests } from "@/server/lab/lab";
import { listTemplates } from "@/server/clinic/templates";
import { listServices } from "@/server/clinic/resources";
import { todayMoney } from "@/server/reception/desk";
import { moneyFormatter } from "@/components/money";
import { ServicePicker } from "@/components/service-picker";
import { extraServicesAction } from "../../../../desk-actions";
import { Anamnesis } from "@/components/anamnesis";
import { Calculators, DiagnosisChips, QuickPhrases } from "@/components/doctor-tools";
import { bmi as bmiCalc, bodySurfaceArea } from "@/lib/calculators";
import { suggestDiagnoses } from "@/lib/dx-suggest";
import { frequentDiagnoses } from "@/server/emr/assist";
import { getPatientHistory } from "@/server/emr/history";
import { copyPreviousNoteAction, diagnosticAction, diagnosticErrorAction, historyAction, nextVisitAction } from "../../../../care-actions";
import { DiagnosticFields } from "@/components/diagnostic-fields";
import { DIAGNOSTIC_FIELDS, unitKey, type DiagnosticKindKey } from "@/lib/diagnostics";
import { listDiagnosticResults } from "@/server/emr/diagnostics";
import { parseTemplateContent } from "@/lib/diagnostic-template";

/** The doctor's visit workspace. Every load is an audited record access. */
export default async function EncounterPage({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<{ tooth?: string; dentition?: string; files?: string }> }) {
  const { slug, id } = await params;
  const sp = await searchParams;
  const ctx = await requireClinic(slug, "emr.read");
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  const data = await getEncounter(ctx, id, await requestMeta()).catch((e) => {
    if (e instanceof DomainError) notFound();
    throw e;
  });
  const { encounter: e, allergies, labOrders, dental, isOwn } = data;
  const labTests = ctx.permissions.has("orders.create") ? (await listLabTests(ctx)).filter((x) => x.labAnalytes.length > 0) : [];
  const tz = ctx.tenant.timezone;
  const open = e.status === "OPEN";
  const canWrite = isOwn && open && ctx.permissions.has("emr.write");
  const canPrescribe = isOwn && open && ctx.permissions.has("prescriptions.write");
  const templates = await listTemplates(ctx);
  const noteTemplates = templates.filter((x) => x.kind === "NOTE");
  const rxSchemes = templates.filter((x) => x.kind === "PRESCRIPTION").map((x) => ({ ...x, items: parseSchemeContent(x.content).items }));
  const docTemplates = templates.filter((x) => x.kind === "DOCUMENT");
  const hasDraft = e.notes.some((n) => n.status === "DRAFT" && n.authorId === ctx.principal.user.id);
  const authors = new Map([[ctx.principal.user.id, ctx.principal.user.fullName]]);
  const s = ctx.tenant.slug;
  const canBill = ctx.permissions.has("billing.invoice");
  const [priced, money, billing] = await Promise.all([
    canBill ? listServices(ctx).then((l) => l.filter((x) => x.priceMinor > 0n).map((x) => ({ id: x.id, name: x.name, priceMinor: x.priceMinor.toString(), currency: x.currency }))) : Promise.resolve([]),
    moneyFormatter(),
    todayMoney(ctx, [e.patient.id]),
  ]);
  const paidToday = billing.today.get(e.patient.id);
  const meta = await requestMeta();
  const [history, frequent, tv, tdx, tcalc, tan, studies, tdg, dispensary] = await Promise.all([
    getPatientHistory(ctx, e.patient.id, meta),
    canWrite ? frequentDiagnoses(ctx) : Promise.resolve([]),
    getTranslations("clinic.visit"),
    getTranslations("dxSuggest"),
    getTranslations("calc"),
    getTranslations("anamnesis"),
    listDiagnosticResults(ctx, e.patient.id, meta),
    getTranslations("diagnostics"),
    patientDispensary(ctx, e.patient.id, meta),
  ]);
  const canStudy = open && ctx.permissions.has("emr.write");
  const studyTemplates = templates
    .filter((x) => x.kind === "DIAGNOSTIC")
    .flatMap((x) => {
      const c = parseTemplateContent(x.content);
      return c ? [{ id: x.id, name: x.name, study: c.study, fields: c.fields, conclusion: c.conclusion }] : [];
    });
  // Latest value of each measurement (today's desk / triage values included).
  const latest = new Map<string, number>();
  for (const v of [...e.vitals].sort((a, b) => +b.measuredAt - +a.measuredAt)) if (!latest.has(v.kind)) latest.set(v.kind, Number(v.value));
  const ageYears = (() => {
    const b = e.patient.birthDate;
    const now = new Date();
    let a = now.getUTCFullYear() - b.getUTCFullYear();
    if (!e.patient.birthYearOnly && (now.getUTCMonth() < b.getUTCMonth() || (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate()))) a -= 1;
    return a;
  })();
  const sexForCalc = e.patient.sex === "MALE" || e.patient.sex === "FEMALE" ? e.patient.sex : undefined;
  const bmiNow = bmiCalc({ weightKg: latest.get("WEIGHT"), heightCm: latest.get("HEIGHT") });
  const bsaNow = bodySurfaceArea({ weightKg: latest.get("WEIGHT"), heightCm: latest.get("HEIGHT") });
  const suggestions = canWrite
    ? suggestDiagnoses({
        systolic: latest.get("SYSTOLIC_BP"),
        diastolic: latest.get("DIASTOLIC_BP"),
        systolicLeft: latest.get("SYSTOLIC_BP_LEFT"),
        diastolicLeft: latest.get("DIASTOLIC_BP_LEFT"),
        weightKg: latest.get("WEIGHT"),
        heightCm: latest.get("HEIGHT"),
        diabetes: history?.diabetes,
        priorMyocardialInfarction: history?.priorMyocardialInfarction,
        smoking: history?.smoking,
        existing: e.diagnoses.filter((d) => d.status === "ACTIVE").map((d) => d.icd10Code),
      })
    : [];
  const owes = billing.debt.get(e.patient.id) ?? 0n;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        eyebrow={`${t("clinic.visit.encounter")} · ${format.dateTime(e.startedAt, { dateStyle: "medium", timeStyle: "short", timeZone: tz })}`}
        title={patientName(e.patient)}
        description={`${e.patient.mrn} · ${await formatBirthDate(e.patient.birthDate, e.patient.birthYearOnly)} · ${t(`sex.${e.patient.sex}`)}${e.patient.address ? ` · ${e.patient.address}` : ""}`}
        action={
          <>
            <Badge tone={STATUS_TONE[e.status]}>{t(`status.${e.status}`)}</Badge>
            <ButtonLink href={`/c/${s}/patients/${e.patient.id}/record`} variant="secondary" size="sm">{t("clinic.record.title")}</ButtonLink>
          </>
        }
      />
      <AllergyBanner allergies={allergies} />
      {!open ? <Alert tone="neutral">{t("clinic.visit.closed")}</Alert> : null}

      <Card>
        <CardHeader title={t("clinic.visit.note")} description={canWrite ? t("clinic.visit.signHint") : undefined} />
        <CardBody className="space-y-6">
          {canWrite && hasDraft && noteTemplates.length > 0 ? (
            <Form action={applyNoteTemplateAction} className="space-y-0">
              <input type="hidden" name="$slug" value={s} />
              <input type="hidden" name="encounterId" value={e.id} />
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1 sm:max-w-sm">
                  <SelectField name="templateId" label={t("templates.applyLabel")} options={noteTemplates.map((x) => ({ value: x.id, label: x.specialty ? `${x.name} · ${t(`specialties.${x.specialty}` as never)}` : x.name }))} />
                </div>
                <SubmitButton variant="secondary">{t("templates.apply")}</SubmitButton>
              </div>
              <p className="mt-1 text-[12.5px] text-text-3">{t("templates.applyHint")}</p>
            </Form>
          ) : null}
          {canWrite && hasDraft ? (
            <div className="space-y-3 rounded-[12px] border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[14px] font-semibold">{tv("quickTitle")}</p>
                <Form action={copyPreviousNoteAction} className="space-y-0">
                  <input type="hidden" name="$slug" value={s} />
                  <input type="hidden" name="encounterId" value={e.id} />
                  <SubmitButton variant="secondary">{tv("copyPrevious")}</SubmitButton>
                </Form>
              </div>
              <QuickPhrases
                groups={[
                  { field: "complaints", label: tv("complaintsGroup"), phrases: tv.raw("complaints") as string[] },
                  { field: "examination", label: tv("heartGroup"), phrases: tv.raw("heart") as string[] },
                  { field: "examination", label: tv("lungGroup"), phrases: tv.raw("lungs") as string[] },
                  { field: "examination", label: tv("edemaGroup"), phrases: tv.raw("edema") as string[] },
                ]}
              />
              <p className="text-[12.5px] text-text-3">{tv("copyPreviousHint")}</p>
            </div>
          ) : null}
          {e.notes.map((n) =>
            n.status === "SIGNED" ? (
              <SignedNote
                key={n.id}
                note={{
                  ...n,
                  authorName: authors.get(n.authorId) ?? "—",
                  integrityOk: Boolean(n.contentHash && n.signedAt && n.signedById && n.contentHash === noteHash({ ...n, signedAt: n.signedAt, signedById: n.signedById })),
                  amendments: n.amendments.map((a) => ({ ...a, authorName: authors.get(a.authorId) ?? "—", integrityOk: a.contentHash === amendmentHash(a) })),
                }}
                timeZone={tz}
                amendAction={amendAction}
                slug={s}
                canAmend={n.authorId === ctx.principal.user.id && ctx.permissions.has("emr.amend")}
              />
            ) : n.authorId === ctx.principal.user.id && canWrite ? (
              <Form key={n.id} action={noteAction}>
                <input type="hidden" name="$slug" value={s} />
                <input type="hidden" name="noteId" value={n.id} />
                <input type="hidden" name="encounterId" value={e.id} />
                {NOTE_SECTIONS.map((sec) => (
                  <TextAreaField key={sec} name={sec} label={t(`noteSection.${sec}`)} defaultValue={n[sec]} rows={sec === "examination" || sec === "plan" ? 4 : 3} />
                ))}
                <div className="flex flex-wrap justify-end gap-2">
                  <button name="op" value="draft" className={buttonClass("secondary", "lg")}>{t("clinic.visit.saveDraft")}</button>
                  <button name="op" value="sign" className={buttonClass("primary", "lg")}>{t("clinic.visit.sign")}</button>
                </div>
              </Form>
            ) : (
              <p key={n.id} className="text-[14px] text-text-2">{t("status.DRAFT")}</p>
            ),
          )}
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("clinic.visit.diagnoses")} />
          <CardBody className="space-y-4">
            <DiagnosisList diagnoses={e.diagnoses} statusAction={clinicalStatusAction} slug={s} canEdit={canWrite} />
            {canWrite ? (
              <div className="space-y-3 border-t border-border pt-4">
                <DiagnosisChips title={tv("suggested")} items={suggestions.map((x) => ({ code: x.code, text: tdx(x.code.replace(".", "_") as never), hint: x.reason.key === "history" ? tdx("history") : tdx(x.reason.key, x.reason.values as never) }))} />
                <DiagnosisChips title={tv("frequent")} items={frequent.map((f) => ({ code: f.icd10Code, text: f.description }))} />
              </div>
            ) : null}
            {canWrite ? (
              <div data-diagnosis-form>
              <Form action={diagnosisAction} className="border-t border-border pt-4">
                <input type="hidden" name="$slug" value={s} />
                <input type="hidden" name="encounterId" value={e.id} />
                <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
                  <TextField name="icd10Code" label={t("clinic.visit.icd10")} hint={t("clinic.visit.icd10Optional")} optionalLabel={t("common.optional")} />
                  <TextAreaField name="description" label={t("clinic.visit.description")} rows={2} />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <SelectField name="kind" label={t("clinic.visit.kind")} options={(["PRIMARY", "SECONDARY", "COMPLICATION"] as const).map((k) => ({ value: k, label: t(`diagnosisKind.${k}`) }))} />
                  <TextField name="stage" label={tv("stage")} hint={tv("stageHint")} optionalLabel={t("common.optional")} />
                </div>
                <SubmitButton variant="secondary">{t("clinic.visit.addDiagnosis")}</SubmitButton>
              </Form>
              </div>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={t("clinic.visit.vitals")} />
          <CardBody className="space-y-4">
            <VitalsTable vitals={e.vitals} timeZone={tz} />
            {bmiNow.ok ? (
              <p className="text-[14px]">
                <span className="font-semibold">{tv("bmi")}:</span> {bmiNow.value.bmi} kg/m² · {tcalc(`bmiClass.${bmiNow.value.class}` as never)}
                {bsaNow.ok ? <> · <span className="font-semibold">{tv("bsa")}:</span> {bsaNow.value.bsa} m²</> : null}
              </p>
            ) : null}
            {open && ctx.permissions.has("vitals.write") ? (
              <div className="border-t border-border pt-4">
                <VitalsForm action={vitalsAction} slug={s} patientId={e.patient.id} encounterId={e.id} />
              </div>
            ) : null}
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={tan("title")} description={canWrite ? tan("hint") : undefined} />
          <CardBody>
            <Anamnesis history={history} canEdit={open && isOwn && ctx.permissions.has("emr.write")} action={historyAction} slug={s} patientId={e.patient.id} back={`/c/${s}/encounters/${e.id}`} female={e.patient.sex === "FEMALE"} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={tv("calcTitle")} />
          <CardBody>
            <Calculators
              canInsert={canWrite && hasDraft}
              defaults={{
                age: ageYears,
                sex: sexForCalc,
                weightKg: latest.get("WEIGHT"),
                heightCm: latest.get("HEIGHT"),
                heartRate: latest.get("HEART_RATE"),
                systolic: latest.get("SYSTOLIC_BP"),
                diastolic: latest.get("DIASTOLIC_BP"),
                systolicLeft: latest.get("SYSTOLIC_BP_LEFT"),
                diabetes: history?.diabetes === "TYPE1" || history?.diabetes === "TYPE2" || history?.diabetes === "OTHER",
                hypertension: (history?.hypertensionYears ?? 0) > 0,
                vascularDisease: history?.priorMyocardialInfarction === true,
              }}
            />
          </CardBody>
        </Card>
      </div>

      {dental ? (
        <Card id="dental">
          <CardHeader title={t("dental.title")} description={canWrite ? t("dental.hint") : undefined} />
          <CardBody className="space-y-5">
            <DentalChart
              current={dental.current}
              dentition={sp.dentition === "primary" ? "primary" : "permanent"}
              toothHref={canWrite ? (n) => `?tooth=${n}${sp.dentition === "primary" ? "&dentition=primary" : ""}#dental` : undefined}
              selected={Number(sp.tooth) || undefined}
              switchHref={`?dentition=${sp.dentition === "primary" ? "permanent" : "primary"}#dental`}
            />
            {canWrite ? <ToothForm action={toothAction} slug={s} encounterId={e.id} tooth={Number(sp.tooth) || undefined} /> : null}
            <details>
              <summary className="cursor-pointer text-[13px] font-medium text-accent">{t("dental.history")}</summary>
              <div className="mt-2">
                <DentalHistory history={dental.history} timeZone={tz} />
              </div>
            </details>
          </CardBody>
        </Card>
      ) : null}
      {docTemplates.length > 0 ? (
        <Card id="documents">
          <CardHeader title={t("templates.printTitle")} description={t("templates.printHint")} />
          <CardBody>
            <div className="flex flex-wrap gap-2">
              {docTemplates.map((d) => (
                <ButtonLink key={d.id} href={`/c/${s}/encounters/${e.id}/document/${d.id}`} variant="secondary" size="sm">
                  {d.name}
                </ButtonLink>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      {canBill || paidToday || owes > 0n ? (
        <Card id="services">
          <CardHeader title={t("clinic.desk.visitServices")} description={canBill ? t("clinic.desk.visitServicesHint") : undefined} />
          <CardBody className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {paidToday ? (
                <>
                  <span className="text-[14px] text-text-2">{paidToday.services.join(", ")}</span>
                  <Badge tone={paidToday.paidMinor >= paidToday.totalMinor ? "success" : "warning"}>{t("clinic.desk.paidOf", { paid: money(paidToday.paidMinor, paidToday.currency), total: money(paidToday.totalMinor, paidToday.currency) })}</Badge>
                </>
              ) : (
                <span className="text-[14px] text-text-2">{t("clinic.desk.noServicesToday")}</span>
              )}
              {owes > 0n ? <Badge tone="danger">{t("clinic.desk.debtShort", { amount: money(owes, ctx.tenant.currency) })}</Badge> : null}
            </div>
            {canBill && priced.length ? (
              <Form action={extraServicesAction} className="border-t border-border pt-4">
                <input type="hidden" name="$slug" value={s} />
                <input type="hidden" name="$back" value={`/c/${s}/encounters/${e.id}`} />
                <input type="hidden" name="patientId" value={e.patient.id} />
                <input type="hidden" name="branchId" value={e.branchId} />
                {e.appointmentId ? <input type="hidden" name="appointmentId" value={e.appointmentId} /> : null}
                <ServicePicker services={priced} withPayment={ctx.permissions.has("billing.payment")} />
                <SubmitButton>{t("clinic.desk.addExtra")}</SubmitButton>
              </Form>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <Card id="diagnostics">
        <CardHeader title={tdg("cardTitle")} description={tdg("cardHint")} />
        <CardBody className="space-y-4">
          {sp.files ? <Alert tone={sp.files === "uploaded" ? "success" : "danger"}>{tdg(`upload.${["uploaded", "fileTooLarge", "fileType", "noFile", "tooManyFiles"].includes(sp.files) ? sp.files : "failed"}` as never)}</Alert> : null}
          {studies.length === 0 ? <p className="text-[14px] text-text-2">{tdg("none")}</p> : null}
          <ul className="space-y-3">
            {studies.map((r) => (
              <li key={r.id} className={`rounded-[12px] border border-border p-3 ${r.enteredInErrorAt ? "opacity-60" : ""}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{r.title} {r.enteredInErrorAt ? <Badge tone="danger">{tdg("inError")}</Badge> : null}</p>
                    <p className="text-[12.5px] text-text-3">{format.dateTime(r.performedAt, { dateStyle: "short", timeStyle: "short", timeZone: tz })} · {r.performedByName}</p>
                  </div>
                  <ButtonLink href={`/c/${s}/diagnostics/${r.id}/print`} variant="secondary" size="sm">{tdg("print")}</ButtonLink>
                </div>
                {DIAGNOSTIC_FIELDS[r.kind as DiagnosticKindKey].some((f) => r.data[f.key] !== undefined) ? (
                  <p className="mt-2 text-[13.5px] text-text-2">
                    {DIAGNOSTIC_FIELDS[r.kind as DiagnosticKindKey]
                      .filter((f) => r.data[f.key] !== undefined)
                      .map((f) => `${tdg(`field.${f.key}` as never)}: ${r.data[f.key]}${f.type === "number" && f.unit ? ` ${tdg(`unit.${unitKey(f.unit)}` as never)}` : ""}`)
                      .join(" · ")}
                  </p>
                ) : null}
                <p className="mt-1 whitespace-pre-wrap text-[14px]">{r.conclusion}</p>
                {r.files.length ? (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {r.files.map((f) => (
                      <li key={f.id}>
                        <a href={`/c/${s}/diagnostics/files/${f.id}`} target="_blank" rel="noopener" className="text-[13px] font-medium text-accent hover:underline">
                          {f.mimeType === "application/pdf" ? "PDF" : tdg("image")}: {f.fileName}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {canStudy && !r.enteredInErrorAt ? (
                  <div className="mt-2 flex flex-wrap items-end gap-3 border-t border-border pt-2">
                    <form method="post" action={`/c/${s}/diagnostics/${r.id}/files`} encType="multipart/form-data" className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="$back" value={`/c/${s}/encounters/${e.id}`} />
                      <label className="text-[13px]">
                        <span className="sr-only">{tdg("attach")}</span>
                        <input type="file" name="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" className="max-w-[16rem] text-[13px]" />
                      </label>
                      <button className={buttonClass("secondary", "sm")}>{tdg("attach")}</button>
                    </form>
                    {r.performedById === ctx.principal.user.id ? (
                      <Form action={diagnosticErrorAction} className="space-y-0">
                        <input type="hidden" name="$slug" value={s} />
                        <input type="hidden" name="$back" value={`/c/${s}/encounters/${e.id}`} />
                        <input type="hidden" name="resultId" value={r.id} />
                        <button className="min-h-8 text-[13px] text-text-3 hover:text-danger">{tdg("markError")}</button>
                      </Form>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {canStudy ? (
            <details className="border-t border-border pt-4">
              <summary className="cursor-pointer text-[14px] font-medium text-accent">{tdg("add")}</summary>
              <Form action={diagnosticAction} className="mt-3">
                <input type="hidden" name="$slug" value={s} />
                <input type="hidden" name="$back" value={`/c/${s}/encounters/${e.id}`} />
                <input type="hidden" name="patientId" value={e.patient.id} />
                <input type="hidden" name="encounterId" value={e.id} />
                <DiagnosticFields templates={studyTemplates} />
                <p className="text-[12.5px] text-text-3">{tdg("filesAfter")}</p>
                <SubmitButton variant="secondary">{tdg("save")}</SubmitButton>
              </Form>
            </details>
          ) : null}
        </CardBody>
      </Card>

      <Card id="prescriptions">
        <CardHeader
          title={t("clinic.rx.title")}
          description={canPrescribe ? t("clinic.rx.hint") : undefined}
          action={
            e.prescriptions.some((p) => p.status === "ACTIVE") ? (
              <ButtonLink href={`/c/${s}/encounters/${e.id}/prescription`} variant="secondary" size="sm">
                {t("clinic.rx.print")}
              </ButtonLink>
            ) : null
          }
        />
        <CardBody className="space-y-4">
          {e.prescriptions.length === 0 ? <p className="text-[14px] text-text-2">{t("clinic.rx.none")}</p> : null}
          <ul className="space-y-3">
            {e.prescriptions.map((p) => (
              <li key={p.id} className={p.status === "CANCELLED" ? "text-[14px] text-text-3 line-through" : "text-[14px]"}>
                <p className="font-medium">
                  {rxDrugLabel(p)}
                  {p.allergyOverride ? (
                    <span className="ml-2 inline-block align-middle">
                      <Badge tone="danger">{t("clinic.rx.allergyOverride")}</Badge>
                    </span>
                  ) : null}
                  {p.status === "CANCELLED" ? <span className="ml-2 no-underline">({t("clinic.rx.cancelledLabel")})</span> : null}
                </p>
                <p className="text-text-2">
                  <TabletFractionPicture dose={p.dose} />{" "}
                  {[p.dose, p.frequency, p.route, p.durationDays ? t("clinic.rx.days", { count: p.durationDays }) : null, null].filter(Boolean).join(" · ")}
                </p>
                {p.times ? (
                  <p className="flex flex-wrap items-center gap-1.5">
                    <span className="text-text-2">{t("clinic.rx.intakeTimes")}:</span>
                    {p.times.split(",").map((time) => (
                      <span key={time} className="rounded-[6px] border-2 border-danger px-1.5 font-bold text-danger tabular-nums">
                        {time.trim()}
                      </span>
                    ))}
                  </p>
                ) : null}
                {p.instructions ? <p className="text-text-2">{p.instructions}</p> : null}
                {p.status === "ACTIVE" && p.prescribedById === ctx.principal.user.id && ctx.permissions.has("prescriptions.write") ? (
                  <Form action={cancelPrescriptionAction} className="mt-1 space-y-0">
                    <input type="hidden" name="$slug" value={s} />
                    <input type="hidden" name="encounterId" value={e.id} />
                    <input type="hidden" name="prescriptionId" value={p.id} />
                    <button className="min-h-8 text-[13px] text-text-3 hover:text-danger">{t("clinic.rx.cancel")}</button>
                  </Form>
                ) : null}
              </li>
            ))}
          </ul>
          {canPrescribe ? (
            <Form action={prescriptionAction} className="border-t border-border pt-4">
              <input type="hidden" name="$slug" value={s} />
              <input type="hidden" name="encounterId" value={e.id} />
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField name="drug" label={t("clinic.rx.drug")} hint={t("clinic.rx.drugHint")} required />
                <TextField name="inn" label={t("clinic.rx.inn")} hint={t("clinic.rx.innHint")} optionalLabel={t("common.optional")} />
                <TextField name="dose" label={t("clinic.rx.dose")} placeholder={t("clinic.rx.dosePlaceholder")} hint={t("clinic.rx.doseHint")} list="rx-dose-suggestions" required />
                <datalist id="rx-dose-suggestions">
                  {DOSE_SUGGESTIONS.map((d) => (
                    <option key={d} value={`${d} ${t("clinic.rx.tabletWord")}`} />
                  ))}
                </datalist>
                <TextField name="frequency" label={t("clinic.rx.frequency")} placeholder={t("clinic.rx.frequencyPlaceholder")} required />
                <TextField name="route" label={t("clinic.rx.route")} placeholder={t("clinic.rx.routePlaceholder")} optionalLabel={t("common.optional")} />
                <TextField name="durationDays" label={t("clinic.rx.duration")} inputMode="numeric" optionalLabel={t("common.optional")} />
                <TextField name="times" label={tv("rxTimes")} hint={tv("rxTimesHint")} placeholder="08:00, 20:00" optionalLabel={t("common.optional")} />
              </div>
              <TextAreaField name="instructions" label={t("clinic.rx.instructions")} rows={2} optionalLabel={t("common.optional")} />
              {allergies.length > 0 ? (
                <div className="space-y-2 rounded-[var(--radius-control)] border border-border bg-sunken p-3 text-[14px]">
                  <p>{t("clinic.rx.allergyCheck", { list: allergies.map((a) => a.substance).join(", ") })}</p>
                  <label className="flex items-start gap-2">
                    <input type="checkbox" name="allergyOverride" className="mt-0.5 size-4 accent-[var(--accent)]" />
                    <span>{t("clinic.rx.allergyConfirm")}</span>
                  </label>
                </div>
              ) : null}
              <SubmitButton variant="secondary">{t("clinic.rx.add")}</SubmitButton>
            </Form>
          ) : null}
          {canPrescribe && rxSchemes.length > 0 ? (
            <div className="space-y-2 border-t border-border pt-4">
              <p className="text-[14px] font-semibold">{t("clinic.rx.schemes")}</p>
              <p className="text-[12.5px] text-text-3">{t("clinic.rx.schemesHint")}</p>
              {rxSchemes.map((x) => (
                <details key={x.id} className="rounded-[12px] border border-border">
                  <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 px-4 py-2 font-medium">
                    <span className="min-w-0">{x.name}</span>
                    <Badge tone="neutral">{t("clinic.rx.schemeCount", { count: x.items.length })}</Badge>
                  </summary>
                  <Form action={applySchemeAction} className="space-y-3 border-t border-border p-4">
                    <input type="hidden" name="$slug" value={s} />
                    <input type="hidden" name="encounterId" value={e.id} />
                    <input type="hidden" name="templateId" value={x.id} />
                    <ul className="space-y-2">
                      {x.items.map((it, i) => (
                        <li key={i}>
                          <label className="flex items-start gap-2 text-[14px]">
                            <input type="checkbox" name="line" value={i} defaultChecked className="mt-1 size-4 shrink-0 accent-[var(--accent)]" />
                            <span className="min-w-0">
                              <span className="font-medium">{rxDrugLabel(it)}</span>
                              <span className="text-text-2"> · {[it.dose, it.frequency, it.times ? `${t("clinic.rx.intakeTimes")} ${it.times}` : null, it.durationDays ? t("clinic.rx.days", { count: Number(it.durationDays) }) : null, it.instructions].filter(Boolean).join(" · ")}</span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                    {allergies.length > 0 ? (
                      <div className="space-y-2 rounded-[var(--radius-control)] border border-border bg-sunken p-3 text-[14px]">
                        <p>{t("clinic.rx.allergyCheck", { list: allergies.map((a) => a.substance).join(", ") })}</p>
                        <label className="flex items-start gap-2">
                          <input type="checkbox" name="allergyOverride" className="mt-0.5 size-4 accent-[var(--accent)]" />
                          <span>{t("clinic.rx.allergyConfirm")}</span>
                        </label>
                      </div>
                    ) : null}
                    <SubmitButton variant="secondary">{t("clinic.rx.schemeApply")}</SubmitButton>
                  </Form>
                </details>
              ))}
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("clinic.labOrder.title")} />
        <CardBody className="space-y-4">
          <LabResultsList orders={labOrders} timeZone={tz} release={isOwn && ctx.permissions.has("emr.write") && ctx.modules.has("patient_portal") ? { slug: s, action: labReleaseAction } : undefined} />
          {canWrite && ctx.permissions.has("orders.create") ? (
            labTests.length === 0 ? (
              <p className="text-[13px] text-text-3">{t("clinic.labOrder.noLabTests")}</p>
            ) : (
              <Form action={labOrderAction} className="border-t border-border pt-4">
                <input type="hidden" name="$slug" value={s} />
                <input type="hidden" name="encounterId" value={e.id} />
                <fieldset>
                  <legend className="text-[13px] font-medium">{t("clinic.labOrder.chooseTests")}</legend>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {labTests.map((x) => (
                      <label key={x.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--radius-control)] border border-border bg-surface-2 px-3 text-[14px] has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                        <input type="checkbox" name="serviceIds" value={x.id} className="size-4 accent-[var(--accent)]" />
                        {x.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                  <SelectField name="priority" label={t("clinic.lab.priority")} options={(["ROUTINE", "URGENT"] as const).map((p) => ({ value: p, label: t(`priority.${p}`) }))} />
                  <TextField name="indication" label={t("clinic.lab.indication")} optionalLabel={t("common.optional")} />
                </div>
                <SubmitButton variant="secondary">{t("clinic.labOrder.order")}</SubmitButton>
              </Form>
            )
          ) : null}
        </CardBody>
      </Card>

      {canWrite ? (
        <Card>
          <CardHeader title={t("clinic.visit.addAllergy")} />
          <CardBody>
            <AllergyForm action={allergyAction} slug={s} patientId={e.patient.id} />
          </CardBody>
        </Card>
      ) : null}

      <DispensaryCard plans={dispensary} slug={s} patientId={e.patient.id} encounterId={e.id} doctorProfileId={e.doctorProfileId} canWrite={canWrite} today={instantToLocalDate(new Date(), tz)} />

      {canWrite ? (
        <Card>
          <CardHeader title={tv("nextVisit")} description={tv("nextVisitHint")} />
          <CardBody>
            <Form action={nextVisitAction} className="flex flex-wrap items-end gap-3 space-y-0">
              <input type="hidden" name="$slug" value={s} />
              <input type="hidden" name="encounterId" value={e.id} />
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium">{tv("nextVisitDate")}</span>
                <input type="date" name="nextVisitDate" defaultValue={e.nextVisitDate ? e.nextVisitDate.toISOString().slice(0, 10) : ""} className="h-10 rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 text-[14px]" />
              </label>
              <SubmitButton variant="secondary">{t("common.save")}</SubmitButton>
            </Form>
          </CardBody>
        </Card>
      ) : null}

      {canWrite ? (
        <Form action={finishVisitAction} className="flex flex-wrap items-center justify-end gap-3">
          <input type="hidden" name="$slug" value={s} />
          <input type="hidden" name="encounterId" value={e.id} />
          <p className="text-[13px] text-text-3">{t("clinic.visit.finishHint")}</p>
          <SubmitButton>{t("clinic.visit.finish")}</SubmitButton>
        </Form>
      ) : null}
    </div>
  );
}
