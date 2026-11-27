import { ScanLine } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { DiagnosticFields } from "@/components/diagnostic-fields";
import { patientName } from "@/components/patients";
import { Form, SubmitButton } from "@/components/ui/form";
import { Alert, Badge, ButtonLink, Card, CardBody, CardHeader, EmptyState, PageHeader, STATUS_TONE, buttonClass } from "@/components/ui/primitives";
import { parseTemplateContent } from "@/lib/diagnostic-template";
import { DIAGNOSTIC_FIELDS, unitKey, type DiagnosticKindKey } from "@/lib/diagnostics";
import { requireClinic } from "@/server/auth/guards";
import { printOnlyAtDesk } from "@/server/clinic/policy";
import { listTemplates } from "@/server/clinic/templates";
import { canRecordStudies, studiesWorklist, todayStudies } from "@/server/emr/diagnostics";
import { DomainError } from "@/server/errors";
import { requestMeta } from "@/server/http";
import { diagnosticAction, diagnosticErrorAction } from "../../../care-actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Functional diagnostics room (ECG, echo, ultrasound devices): today's
 * patients who came in; for the chosen one, today's study results with the
 * device's pictures / PDFs, and the form for a new result. For the
 * "diagnostics" role (often the receptionist of a small clinic) and doctors.
 */
export default async function StudiesPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ p?: string; files?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await requireClinic(slug);
  if (!canRecordStudies(ctx) || !ctx.permissions.has("emr.read")) notFound();
  const [t, tdg, format] = await Promise.all([getTranslations(), getTranslations("diagnostics"), getFormatter()]);
  const tz = ctx.tenant.timezone;
  const s = ctx.tenant.slug;
  const list = await studiesWorklist(ctx);
  const chosen = sp.p && UUID.test(sp.p) ? list.find((a) => a.patient.id === sp.p) ?? null : null;
  const meta = await requestMeta();
  let current: Awaited<ReturnType<typeof todayStudies>> | null = null;
  if (chosen) {
    current = await todayStudies(ctx, chosen.patient.id, meta).catch((e) => {
      if (e instanceof DomainError) return null;
      throw e;
    });
  }
  const templates = (await listTemplates(ctx, { kind: "DIAGNOSTIC" })).flatMap((x) => {
    const c = parseTemplateContent(x.content);
    return c ? [{ id: x.id, name: x.name, study: c.study, fields: c.fields, conclusion: c.conclusion }] : [];
  });
  const canPrintHere = !(await printOnlyAtDesk(ctx)) || ctx.permissions.has("documents.print");
  const back = chosen ? `/c/${s}/studies?p=${chosen.patient.id}` : `/c/${s}/studies`;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader title={t("studies.title")} description={t("studies.subtitle")} count={list.length} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card className="overflow-hidden">
          <CardHeader title={t("studies.today")} />
          {list.length === 0 ? (
            <EmptyState icon={<ScanLine className="size-6" />} title={t("studies.empty")} />
          ) : (
            <ul className="divide-y divide-border">
              {list.map((a) => {
                const active = chosen?.id === a.id;
                return (
                  <li key={a.id}>
                    <Link
                      href={`/c/${s}/studies?p=${a.patient.id}`}
                      aria-current={active ? "true" : undefined}
                      className={`flex items-start justify-between gap-3 px-5 py-3 hover:bg-sunken ${active ? "bg-accent-soft" : ""}`}
                    >
                      <span className="min-w-0">
                        <span className="block font-medium">
                          {a.queueNumber ? <span className="mr-2 rounded-md bg-accent-soft px-1.5 text-[12px] font-semibold text-accent">#{a.queueNumber}</span> : null}
                          <span className="break-words">{patientName(a.patient)}</span>
                        </span>
                        <span className="block text-[13px] text-text-2">
                          {a.patient.mrn} · {format.dateTime(a.startsAt, { timeStyle: "short", timeZone: tz })} · {a.doctor.membership.user.fullName}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <Badge tone={STATUS_TONE[a.status]}>{t(`status.${a.status}` as never)}</Badge>
                        {a.studiesToday ? <Badge tone="success">{t("studies.done", { count: a.studiesToday })}</Badge> : null}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="min-w-0 space-y-6">
          {!chosen ? (
            <Card>
              <CardBody>
                <p className="text-[14px] text-text-2">{t("studies.choose")}</p>
              </CardBody>
            </Card>
          ) : !current ? (
            <Alert tone="danger">{t("errors.noCareRelationship")}</Alert>
          ) : (
            <Card>
              <CardHeader title={patientName(current.patient)} description={`${current.patient.mrn} · ${t(`sex.${current.patient.sex}` as never)}`} />
              <CardBody className="space-y-4">
                {sp.files ? <Alert tone={sp.files === "uploaded" ? "success" : "danger"}>{tdg(`upload.${["uploaded", "fileTooLarge", "fileType", "noFile", "tooManyFiles"].includes(sp.files) ? sp.files : "failed"}` as never)}</Alert> : null}
                {current.results.length === 0 ? <p className="text-[14px] text-text-2">{tdg("none")}</p> : null}
                <ul className="space-y-3">
                  {current.results.map((r) => (
                    <li key={r.id} className={`rounded-[12px] border border-border p-3 ${r.enteredInErrorAt ? "opacity-60" : ""}`}>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium">
                            {r.title} {r.enteredInErrorAt ? <Badge tone="danger">{tdg("inError")}</Badge> : null}
                          </p>
                          <p className="text-[12.5px] text-text-3">{format.dateTime(r.performedAt, { timeStyle: "short", timeZone: tz })}</p>
                        </div>
                        {canPrintHere && !r.enteredInErrorAt ? (
                          <ButtonLink href={`/c/${s}/diagnostics/${r.id}/print`} variant="secondary" size="sm">
                            {tdg("print")}
                          </ButtonLink>
                        ) : null}
                      </div>
                      {DIAGNOSTIC_FIELDS[r.kind as DiagnosticKindKey].some((f) => r.data[f.key] !== undefined) ? (
                        <p className="mt-2 text-[13.5px] text-text-2">
                          {DIAGNOSTIC_FIELDS[r.kind as DiagnosticKindKey]
                            .filter((f) => r.data[f.key] !== undefined)
                            .map((f) => `${tdg(`field.${f.key}` as never)}: ${r.data[f.key]}${f.type === "number" && f.unit ? ` ${tdg(`unit.${unitKey(f.unit)}` as never)}` : ""}`)
                            .join(" · ")}
                        </p>
                      ) : null}
                      <p className="mt-1 whitespace-pre-wrap break-words text-[14px]">{r.conclusion}</p>
                      {r.files.length ? (
                        <ul className="mt-2 flex flex-wrap gap-2">
                          {r.files.map((f) => (
                            <li key={f.id} className="min-w-0">
                              <a href={`/c/${s}/diagnostics/files/${f.id}`} target="_blank" rel="noopener" className="break-all text-[13px] font-medium text-accent hover:underline">
                                {f.mimeType === "application/pdf" ? "PDF" : tdg("image")}: {f.fileName}
                              </a>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {!r.enteredInErrorAt ? (
                        <div className="mt-2 flex flex-wrap items-end gap-3 border-t border-border pt-2">
                          <form method="post" action={`/c/${s}/diagnostics/${r.id}/files`} encType="multipart/form-data" className="flex flex-wrap items-center gap-2">
                            <input type="hidden" name="$back" value={back} />
                            <label className="text-[13px]">
                              <span className="sr-only">{tdg("attach")}</span>
                              <input type="file" name="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" className="max-w-[16rem] text-[13px]" />
                            </label>
                            <button className={buttonClass("secondary", "sm")}>{tdg("attach")}</button>
                          </form>
                          {r.performedById === ctx.principal.user.id ? (
                            <Form action={diagnosticErrorAction} className="space-y-0">
                              <input type="hidden" name="$slug" value={s} />
                              <input type="hidden" name="$back" value={back} />
                              <input type="hidden" name="resultId" value={r.id} />
                              <button className="min-h-8 text-[13px] text-text-3 hover:text-danger">{tdg("markError")}</button>
                            </Form>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <div className="border-t border-border pt-4">
                  <p className="mb-3 text-[14px] font-medium">{tdg("add")}</p>
                  <Form action={diagnosticAction}>
                    <input type="hidden" name="$slug" value={s} />
                    <input type="hidden" name="$back" value={back} />
                    <input type="hidden" name="patientId" value={current.patient.id} />
                    <DiagnosticFields templates={templates} />
                    <p className="text-[12.5px] text-text-3">{tdg("filesAfter")}</p>
                    <SubmitButton>{tdg("save")}</SubmitButton>
                  </Form>
                </div>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
