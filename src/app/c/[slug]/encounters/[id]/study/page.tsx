import { CheckCircle2 } from "lucide-react";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { AllergyBanner } from "@/components/clinical";
import { DiagnosticFields } from "@/components/diagnostic-fields";
import { formatBirthDate, patientName } from "@/components/patients";
import { Form, SubmitButton } from "@/components/ui/form";
import { Alert, ButtonLink, Card, CardBody, CardHeader, PageHeader } from "@/components/ui/primitives";
import { parseTemplateContent } from "@/lib/diagnostic-template";
import { DIAGNOSTIC_KINDS, type DiagnosticKindKey } from "@/lib/diagnostics";
import { requireClinic } from "@/server/auth/guards";
import { listTemplates } from "@/server/clinic/templates";
import { todayStudies } from "@/server/emr/diagnostics";
import { getEncounter } from "@/server/emr/record";
import { requestMeta } from "@/server/http";
import { DomainError } from "@/server/tenancy/provisioning";
import { diagnosticAction } from "../../../../../care-actions";

/**
 * One paid study, opened from the doctor's queue: the patient on top, the
 * service's own form below, ready to fill — nothing else. "Tayyor" saves the
 * result (ready to print at the desk) and goes back to the queue.
 */
export default async function StudyPage({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<{ template?: string; kind?: string }> }) {
  const { slug, id } = await params;
  const sp = await searchParams;
  const ctx = await requireClinic(slug, "emr.write");
  const [t, tdg, format] = await Promise.all([getTranslations(), getTranslations("diagnostics"), getFormatter()]);
  const meta = await requestMeta();
  const data = await getEncounter(ctx, id, meta).catch((e) => {
    if (e instanceof DomainError) notFound();
    throw e;
  });
  const { encounter: e, allergies } = data;
  const s = ctx.tenant.slug;
  const templates = (await listTemplates(ctx, { kind: "DIAGNOSTIC" })).flatMap((x) => {
    const c = parseTemplateContent(x.content);
    return c ? [{ id: x.id, name: x.name, study: c.study, fields: c.fields, conclusion: c.conclusion }] : [];
  });
  const initialTemplateId = templates.some((x) => x.id === sp.template) ? sp.template! : "";
  const initialKind = (DIAGNOSTIC_KINDS as readonly string[]).includes(sp.kind ?? "") ? (sp.kind as DiagnosticKindKey) : (templates.find((x) => x.id === initialTemplateId)?.study ?? "ECG");
  const today = await todayStudies(ctx, e.patient.id, meta);
  const open = e.status === "OPEN";

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <PageHeader
        eyebrow={tdg("studyEyebrow")}
        title={patientName(e.patient)}
        description={`${e.patient.mrn} · ${await formatBirthDate(e.patient.birthDate, e.patient.birthYearOnly)} · ${t(`sex.${e.patient.sex}`)}`}
        action={
          <>
            <ButtonLink href={`/c/${s}/my-queue`} variant="secondary" size="sm">{tdg("backToQueue")}</ButtonLink>
            <ButtonLink href={`/c/${s}/encounters/${e.id}`} variant="ghost" size="sm">{tdg("openVisit")}</ButtonLink>
          </>
        }
      />
      <AllergyBanner allergies={allergies} />
      {today.results.length ? (
        <Card>
          <CardHeader title={tdg("doneToday")} />
          <CardBody>
            <ul className="space-y-2">
              {today.results.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-[14px]">
                  <span className="flex items-center gap-2">
                    <CheckCircle2 aria-hidden className="size-4 text-success" />
                    <span className={r.enteredInErrorAt ? "line-through text-text-3" : "font-medium"}>{r.title}</span>
                    <span className="text-text-3">{format.dateTime(r.performedAt, { timeStyle: "short", timeZone: ctx.tenant.timezone })}</span>
                  </span>
                  {!r.enteredInErrorAt ? <ButtonLink href={`/c/${s}/diagnostics/${r.id}/print`} variant="ghost" size="sm">{tdg("print")}</ButtonLink> : null}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
      {open ? (
        <Card>
          <CardHeader title={templates.find((x) => x.id === initialTemplateId)?.name ?? tdg(`kind.${initialKind}`)} description={tdg("studyHint")} />
          <CardBody>
            <Form action={diagnosticAction}>
              <input type="hidden" name="$slug" value={s} />
              <input type="hidden" name="$back" value={`/c/${s}/my-queue`} />
              <input type="hidden" name="$next" value={`/c/${s}/my-queue?ready=1`} />
              <input type="hidden" name="patientId" value={e.patient.id} />
              <input type="hidden" name="encounterId" value={e.id} />
              <DiagnosticFields templates={templates} initialTemplateId={initialTemplateId} initialKind={initialKind} />
              <SubmitButton full>{tdg("ready")}</SubmitButton>
            </Form>
          </CardBody>
        </Card>
      ) : (
        <Alert tone="neutral">{t("clinic.visit.closed")}</Alert>
      )}
    </div>
  );
}
