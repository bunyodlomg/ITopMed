import { Printer, ShieldAlert } from "lucide-react";
import { summarizeDiagnoses } from "@/lib/dx-summary";
import { rxDrugLabel } from "@/lib/rx";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { AllergyBanner, DiagnosisList, SignedNote, VitalsTable } from "@/components/clinical";
import { formatBirthDate, patientName } from "@/components/patients";
import { Alert, Badge, Card, CardBody, CardHeader, PageHeader, STATUS_TONE, Table, Td, Th, buttonClass } from "@/components/ui/primitives";
import { requireClinic } from "@/server/auth/guards";
import { BREAK_GLASS_REASONS, type BreakGlassReason } from "@/server/emr/access";
import { getMedicalRecord } from "@/server/emr/record";
import { requestMeta } from "@/server/http";
import { DomainError } from "@/server/tenancy/provisioning";
import { amendAction, breakGlassAction, clinicalStatusAction } from "../../../../../care-actions";
import { cookies } from "next/headers";
import { LabResultsList } from "@/components/lab";
import { DentalChart, DentalHistory } from "@/components/dental";
import { labReleaseAction } from "../../../../../portal-actions";

/**
 * The patient's medical record. Access follows the care relationship; anyone
 * else may only "break the glass" with a reason category (audited). The choice is
 * made by a POST action and kept in a short-lived cookie scoped to this patient.
 */
export default async function RecordPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const ctx = await requireClinic(slug);
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  if (!ctx.permissions.has("emr.read")) {
    return (
      <div className="mx-auto w-full max-w-2xl">
        <Alert tone="neutral">{t("clinic.record.noClinicalAccess")}</Alert>
      </div>
    );
  }
  // Set only by the POST break-glass action (origin-checked), scoped to this patient, 10 minutes.
  const bgRaw = (await cookies()).get(`itm_bg_${id}`)?.value;
  const breakGlass = (BREAK_GLASS_REASONS as readonly string[]).includes(bgRaw ?? "") ? (bgRaw as BreakGlassReason) : undefined;

  let record: Awaited<ReturnType<typeof getMedicalRecord>>;
  try {
    record = await getMedicalRecord(ctx, id, await requestMeta(), { breakGlass });
  } catch (e) {
    if (e instanceof DomainError && e.code === "errors.notFound") notFound();
    if (e instanceof DomainError && e.code === "errors.noCareRelationship") {
      return (
        <div className="mx-auto w-full max-w-2xl space-y-6">
          <PageHeader title={t("clinic.record.title")} />
          <Card>
            <CardBody className="space-y-4">
              <p className="flex items-center gap-2 text-[16px] font-semibold">
                <ShieldAlert aria-hidden className="size-5 text-warning" />
                {t("clinic.record.breakGlassTitle")}
              </p>
              <p className="text-[14px] text-text-2">{t("clinic.record.breakGlassBody")}</p>
              <form action={breakGlassAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="$slug" value={ctx.tenant.slug} />
                <input type="hidden" name="patientId" value={id} />
                <label className="flex-1">
                  <span className="mb-1.5 block text-[13px] font-medium">{t("clinic.record.breakGlassReason")}</span>
                  <select name="bg" className="h-11 w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 text-[15px]">
                    {BREAK_GLASS_REASONS.map((r) => (
                      <option key={r} value={r}>{t(`breakGlass.${r}`)}</option>
                    ))}
                  </select>
                </label>
                <button className={buttonClass("danger", "lg")}>{t("clinic.record.breakGlassSubmit")}</button>
              </form>
            </CardBody>
          </Card>
        </div>
      );
    }
    throw e;
  }

  const { patient, allergies, diagnoses, vitals, encounters, access, labOrders, dental, prescriptions, studies } = record;
  const dxAll = summarizeDiagnoses(diagnoses);
  const activeMeds = prescriptions.filter((p) => p.status === "ACTIVE").slice(0, 30);
  const canExtract = access.mode === "care" || access.mode === "oversight";
  const tz = ctx.tenant.timezone;
  const s = ctx.tenant.slug;
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        eyebrow={`${t("clinic.record.title")} · ${patient.mrn}`}
        title={patientName(patient)}
        description={`${await formatBirthDate(patient.birthDate)} · ${t(`sex.${patient.sex}`)}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {canExtract ? (
              <Link href={`/c/${s}/patients/${patient.id}/record/print`} className={buttonClass("primary", "sm")}>
                <Printer aria-hidden className="size-4" /> {t("clinic.profile.print")}
              </Link>
            ) : null}
            <Badge tone={access.mode === "break_glass" ? "danger" : "neutral"}>{t("clinic.record.accessAs", { mode: t(`accessMode.${access.mode}`) })}</Badge>
            {access.mode === "care" || access.mode === "oversight" ? (
              <form method="post" action={`/c/${s}/patients/${patient.id}/record/xlsx`}>
                <button type="submit" className={buttonClass("secondary", "sm")} title={t("clinic.record.excelHint")}>
                  {t("clinic.record.excelExport")}
                </button>
              </form>
            ) : null}
            {access.mode === "care" || access.mode === "oversight" ? (
              <form method="post" action={`/c/${s}/patients/${patient.id}/record/fhir`}>
                <button type="submit" className={buttonClass("ghost", "sm")} title={t("clinic.record.fhirHint")}>
                  {t("clinic.record.fhirExport")}
                </button>
              </form>
            ) : null}
          </div>
        }
      />
      <AllergyBanner allergies={allergies.filter((a) => a.status === "ACTIVE")} />

      <Card>
        <CardHeader title={t("clinic.profile.dxTitle")} description={t("clinic.profile.dxHint")} />
        {dxAll.length === 0 ? (
          <CardBody><p className="text-[14px] text-text-2">{t("clinic.profile.noDx")}</p></CardBody>
        ) : (
          <Table caption={t("clinic.profile.dxTitle")}>
            <thead>
              <tr>
                <Th>{t("clinic.profile.colDx")}</Th>
                <Th>{t("clinic.profile.colCode")}</Th>
                <Th>{t("clinic.profile.colFirst")}</Th>
                <Th>{t("clinic.profile.colLast")}</Th>
                <Th>{t("clinic.profile.colTimes")}</Th>
                <Th>{t("clinic.profile.colStatus")}</Th>
              </tr>
            </thead>
            <tbody>
              {dxAll.map((d) => (
                <tr key={d.key}>
                  <Td>
                    <span className="font-semibold">{d.description}</span>
                    {d.stage ? <span className="text-text-2">, {d.stage}</span> : null}
                    <span className="block text-[12.5px] text-text-3">{t(`diagnosisKind.${d.kind}` as never)}</span>
                  </Td>
                  <Td label={t("clinic.profile.colCode")}><span className="font-mono">{d.icd10Code || "—"}</span></Td>
                  <Td label={t("clinic.profile.colFirst")}>{format.dateTime(d.first, { dateStyle: "short", timeZone: tz })}</Td>
                  <Td label={t("clinic.profile.colLast")}>{format.dateTime(d.last, { dateStyle: "short", timeZone: tz })}</Td>
                  <Td label={t("clinic.profile.colTimes")}>{d.count}</Td>
                  <Td label={t("clinic.profile.colStatus")}><Badge tone={d.status === "ACTIVE" ? "accent" : "neutral"}>{t(`status.${d.status}` as never)}</Badge></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("clinic.profile.medsTitle")} />
          {activeMeds.length === 0 ? (
            <CardBody><p className="text-[14px] text-text-2">{t("clinic.rx.none")}</p></CardBody>
          ) : (
            <ul className="divide-y divide-border">
              {activeMeds.map((p) => (
                <li key={p.id} className="px-6 py-2.5 text-[14px]">
                  <p className="font-medium">{rxDrugLabel(p)}</p>
                  <p className="text-text-2">{[p.dose, p.frequency, p.times, format.dateTime(p.createdAt, { dateStyle: "short", timeZone: tz })].filter(Boolean).join(" · ")}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title={t("clinic.profile.studiesTitle")} />
          {studies.length === 0 ? (
            <CardBody><p className="text-[14px] text-text-2">{t("diagnostics.none")}</p></CardBody>
          ) : (
            <ul className="divide-y divide-border">
              {studies.slice(0, 20).map((r) => (
                <li key={r.id} className="px-6 py-2.5 text-[14px]">
                  <p className="font-medium">{r.title} <span className="font-normal text-text-3">· {format.dateTime(r.performedAt, { dateStyle: "short", timeZone: tz })}</span></p>
                  <p className="line-clamp-3 whitespace-pre-wrap text-text-2">{r.conclusion}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("clinic.visit.diagnoses")} />
          <CardBody>
            <DiagnosisList diagnoses={diagnoses} statusAction={clinicalStatusAction} slug={s} canEdit={ctx.permissions.has("emr.write") && access.mode === "care"} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t("clinic.visit.vitals")} />
          <CardBody>
            <VitalsTable vitals={vitals.slice(0, 9)} timeZone={tz} />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title={t("clinic.labOrder.results")} />
        {dental ? (
          <Card>
            <CardHeader title={t("dental.title")} />
            <CardBody className="space-y-4">
              <DentalChart current={dental.current} dentition="permanent" />
              <DentalHistory history={dental.history} timeZone={tz} />
            </CardBody>
          </Card>
        ) : null}
        <CardBody>
          <LabResultsList
            orders={labOrders}
            timeZone={tz}
            release={ctx.permissions.has("emr.write") && ctx.modules.has("patient_portal") && (access.mode === "care" || access.mode === "oversight") ? { slug: s, action: labReleaseAction } : undefined}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("clinic.record.encounters")} />
        {encounters.length === 0 ? (
          <CardBody><p className="text-[14px] text-text-2">{t("clinic.record.noEncounters")}</p></CardBody>
        ) : (
          <ul className="divide-y divide-border">
            {encounters.map((e) => (
              <li key={e.id} className="space-y-3 px-6 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[14px] font-semibold">
                    {format.dateTime(e.startedAt, { dateStyle: "medium", timeStyle: "short", timeZone: tz })}
                    <span className="font-normal text-text-2">
                      {" "}
                      · {e.doctor.membership.user.fullName} · {t(`specialties.${e.doctor.specialty}` as never)}
                    </span>
                  </p>
                  <div className="flex items-center gap-2">
                    <Badge tone={STATUS_TONE[e.status]}>{t(`status.${e.status}`)}</Badge>
                    {e.status === "OPEN" && e.doctorProfileId === access.doctorProfileId ? (
                      <Link href={`/c/${s}/encounters/${e.id}`} className={buttonClass("secondary", "sm")}>{t("clinic.visit.continue")}</Link>
                    ) : null}
                  </div>
                </div>
                {e.notes
                  .filter((n) => n.status === "SIGNED")
                  .map((n) => (
                    <SignedNote key={n.id} note={n} timeZone={tz} amendAction={amendAction} slug={s} canAmend={ctx.permissions.has("emr.amend") && (n.authorId === ctx.principal.user.id || ctx.permissions.has("emr.read_all"))} />
                  ))}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
