import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AllergyBanner } from "@/components/clinical";
import { HistoryWizard } from "@/components/history-wizard";
import { formatBirthDate, patientName } from "@/components/patients";
import { Form, SubmitButton } from "@/components/ui/form";
import { Alert, ButtonLink, Card, CardBody, PageHeader } from "@/components/ui/primitives";
import { requireClinic } from "@/server/auth/guards";
import { getPatientHistory } from "@/server/emr/history";
import { getEncounter } from "@/server/emr/record";
import { requestMeta } from "@/server/http";
import { DomainError } from "@/server/tenancy/provisioning";
import { historyWizardAction } from "../../../../../care-actions";

/**
 * "Create the history": a few questions → the complaints and history of the
 * visit note, the structured anamnesis and the diagnoses the doctor ticks.
 * Then back to the visit sheet (diagnosis and treatment plan).
 */
export default async function HistoryWizardPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const ctx = await requireClinic(slug, "emr.write");
  const [t, tw] = await Promise.all([getTranslations(), getTranslations("historyWizard")]);
  const meta = await requestMeta();
  const data = await getEncounter(ctx, id, meta).catch((e) => {
    if (e instanceof DomainError) notFound();
    throw e;
  });
  const { encounter: e, allergies } = data;
  const s = ctx.tenant.slug;
  const history = await getPatientHistory(ctx, e.patient.id, meta);
  const latest = new Map<string, number>();
  for (const v of [...e.vitals].sort((a, b) => +b.measuredAt - +a.measuredAt)) if (!latest.has(v.kind)) latest.set(v.kind, Number(v.value));
  const hasDraft = e.notes.some((n) => n.status === "DRAFT" && n.authorId === ctx.principal.user.id);
  const open = e.status === "OPEN";

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <PageHeader
        eyebrow={tw("eyebrow")}
        title={patientName(e.patient)}
        description={`${e.patient.mrn} · ${await formatBirthDate(e.patient.birthDate, e.patient.birthYearOnly)} · ${t(`sex.${e.patient.sex}`)}`}
        action={<ButtonLink href={`/c/${s}/encounters/${e.id}`} variant="secondary" size="sm">{tw("backToVisit")}</ButtonLink>}
      />
      <AllergyBanner allergies={allergies} />
      {!open || !hasDraft ? (
        <Alert tone="neutral">{tw("noteSigned")}</Alert>
      ) : (
        <Card>
          <CardBody>
            <Form action={historyWizardAction}>
              <input type="hidden" name="$slug" value={s} />
              <input type="hidden" name="encounterId" value={e.id} />
              <HistoryWizard
                vitals={{ systolic: latest.get("SYSTOLIC_BP"), diastolic: latest.get("DIASTOLIC_BP"), weightKg: latest.get("WEIGHT"), heightCm: latest.get("HEIGHT") }}
                existing={e.diagnoses.filter((d) => d.status === "ACTIVE" && d.icd10Code).map((d) => d.icd10Code!)}
                initial={{
                  diabetes: (history?.diabetes ?? "") as "" | "NO" | "TYPE1" | "TYPE2" | "OTHER",
                  smoking: (history?.smoking ?? "") as "" | "NEVER" | "FORMER" | "CURRENT",
                  priorMi: Boolean(history?.priorMyocardialInfarction),
                  hypertensionYears: history?.hypertensionYears ? String(history.hypertensionYears) : "",
                }}
              />
              <SubmitButton full>{tw("save")}</SubmitButton>
            </Form>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
