import { AlertTriangle, ShieldCheck, ShieldX } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import type { FormState } from "@/lib/form-state";
import { VITAL_KINDS } from "@/server/emr/record";
import { Form, SelectField, SubmitButton, TextAreaField, TextField } from "./ui/form";
import { Badge } from "./ui/primitives";

/** Prominent allergy banner — always shown at the top of clinical screens. */
export async function AllergyBanner({ allergies }: { allergies: { id: string; substance: string; severity: string; reaction: string | null }[] }) {
  const t = await getTranslations();
  if (allergies.length === 0) {
    return <p className="rounded-[12px] bg-sunken px-4 py-2.5 text-[14px] text-text-2">{t("clinic.visit.noAllergies")}</p>;
  }
  return (
    <div role="note" className="rounded-[12px] border border-danger/30 bg-danger-soft px-4 py-3">
      <p className="flex items-center gap-2 text-[14px] font-semibold text-danger">
        <AlertTriangle aria-hidden className="size-4" />
        {t("clinic.visit.allergies")}
      </p>
      <ul className="mt-1.5 flex flex-wrap gap-2">
        {allergies.map((a) => (
          <li key={a.id} className="rounded-lg bg-surface px-2.5 py-1 text-[13px]">
            <span className="font-semibold">{a.substance}</span> · {t(`severity.${a.severity}` as never)}
            {a.reaction ? ` · ${a.reaction}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function IntegrityBadge({ ok, okLabel, failLabel }: { ok: boolean; okLabel: string; failLabel: string }) {
  return ok ? (
    <span className="inline-flex items-center gap-1 text-[12px] text-success">
      <ShieldCheck aria-hidden className="size-3.5" />
      {okLabel}
    </span>
  ) : (
    <span role="alert" className="inline-flex items-center gap-1 text-[12px] font-semibold text-danger">
      <ShieldX aria-hidden className="size-3.5" />
      {failLabel}
    </span>
  );
}

/** Read-only signed note with its amendments. */
export async function SignedNote({
  note,
  timeZone,
  amendAction,
  slug,
  canAmend,
}: {
  note: {
    id: string;
    complaints: string;
    history: string;
    examination: string;
    assessment: string;
    plan: string;
    signedAt: Date | null;
    authorName: string;
    integrityOk: boolean;
    amendments: { id: string; reason: string; content: string; createdAt: Date; authorName: string; integrityOk: boolean }[];
  };
  timeZone: string;
  amendAction?: (s: FormState, fd: FormData) => Promise<FormState>;
  slug?: string;
  canAmend?: boolean;
}) {
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  const sections = (["complaints", "history", "examination", "assessment", "plan"] as const).filter((s) => note[s].trim());
  return (
    <div className="space-y-3">
      <dl className="space-y-3">
        {sections.map((s) => (
          <div key={s}>
            <dt className="text-[12px] font-semibold uppercase tracking-[0.04em] text-text-3">{t(`noteSection.${s}`)}</dt>
            <dd className="mt-0.5 whitespace-pre-wrap break-words text-[14.5px] leading-relaxed">{note[s]}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-2 text-[12.5px] text-text-3">
        <span>{t("clinic.visit.signedBy", { name: note.authorName, date: note.signedAt ? format.dateTime(note.signedAt, { dateStyle: "medium", timeStyle: "short", timeZone }) : "—" })}</span>
        <IntegrityBadge ok={note.integrityOk} okLabel={t("clinic.visit.integrityOk")} failLabel={t("clinic.visit.integrityFailed")} />
      </div>
      {note.amendments.length > 0 ? (
        <div className="space-y-2 rounded-[12px] bg-sunken p-3">
          <p className="text-[12px] font-semibold uppercase tracking-[0.04em] text-text-3">{t("clinic.visit.amendments")}</p>
          {note.amendments.map((a) => (
            <div key={a.id} className="rounded-[10px] bg-surface p-3">
              <p className="whitespace-pre-wrap text-[14px]">{a.content}</p>
              <p className="mt-1 text-[12px] text-text-3">
                {a.reason} · {a.authorName} · {format.dateTime(a.createdAt, { dateStyle: "medium", timeStyle: "short", timeZone })}{" "}
                <IntegrityBadge ok={a.integrityOk} okLabel={t("clinic.visit.integrityOk")} failLabel={t("clinic.visit.integrityFailed")} />
              </p>
            </div>
          ))}
        </div>
      ) : null}
      {canAmend && amendAction && slug ? (
        <details className="rounded-[12px] border border-border p-3">
          <summary className="cursor-pointer text-[14px] font-medium text-accent">{t("clinic.visit.amend")}</summary>
          <Form action={amendAction} className="mt-3">
            <input type="hidden" name="$slug" value={slug} />
            <input type="hidden" name="noteId" value={note.id} />
            <TextField name="reason" label={t("clinic.visit.amendReason")} required />
            <TextAreaField name="content" label={t("clinic.visit.amendContent")} rows={3} />
            <SubmitButton variant="secondary">{t("clinic.visit.amend")}</SubmitButton>
          </Form>
        </details>
      ) : null}
    </div>
  );
}

export async function VitalsTable({ vitals, timeZone }: { vitals: { id: string; kind: string; value: { toString(): string }; unit: string; measuredAt: Date }[]; timeZone: string }) {
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  if (vitals.length === 0) return <p className="text-[14px] text-text-2">{t("clinic.visit.noVitals")}</p>;
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {vitals.map((v) => (
        <li key={v.id} className="rounded-[12px] bg-sunken px-3 py-2">
          <p className="text-[12px] text-text-3">{t(`vital.${v.kind}` as never)}</p>
          <p className="text-[16px] font-semibold tabular-nums">
            {v.value.toString().replace(/\.0+$/, "")} <span className="text-[12px] font-normal text-text-3">{t(`vitalUnit.${v.kind}` as never)}</span>
          </p>
          <p className="text-[11.5px] text-text-3">{format.dateTime(v.measuredAt, { dateStyle: "short", timeStyle: "short", timeZone })}</p>
        </li>
      ))}
    </ul>
  );
}

export async function VitalsForm({ action, slug, patientId, encounterId }: { action: (s: FormState, fd: FormData) => Promise<FormState>; slug: string; patientId: string; encounterId?: string }) {
  const t = await getTranslations();
  return (
    <Form action={action}>
      <input type="hidden" name="$slug" value={slug} />
      <input type="hidden" name="patientId" value={patientId} />
      {encounterId ? <input type="hidden" name="encounterId" value={encounterId} /> : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {VITAL_KINDS.map((k) => (
          <TextField key={k} name={k} label={`${t(`vital.${k}`)} (${t(`vitalUnit.${k}`)})`} inputMode="decimal" optionalLabel={undefined} />
        ))}
      </div>
      <SubmitButton variant="secondary">{t("clinic.visit.recordVitals")}</SubmitButton>
    </Form>
  );
}

export async function DiagnosisList({
  diagnoses,
  statusAction,
  slug,
  canEdit,
}: {
  diagnoses: { id: string; icd10Code: string; description: string; kind: string; status: string; stage?: string | null }[];
  statusAction?: (s: FormState, fd: FormData) => Promise<FormState>;
  slug?: string;
  canEdit?: boolean;
}) {
  const t = await getTranslations();
  if (diagnoses.length === 0) return <p className="text-[14px] text-text-2">{t("clinic.visit.noDiagnoses")}</p>;
  return (
    <ul className="space-y-2">
      {diagnoses.map((d) => (
        <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] bg-sunken px-3 py-2">
          <span className="min-w-0 text-[14px]">
            <span className="font-mono font-semibold">{d.icd10Code}</span> {d.description}{d.stage ? <span className="text-text-2"> · {d.stage}</span> : null}{" "}
            <Badge tone={d.kind === "PRIMARY" ? "accent" : "neutral"}>{t(`diagnosisKind.${d.kind}` as never)}</Badge>{" "}
            {d.status !== "ACTIVE" ? <Badge>{t(`status.${d.status}` as never)}</Badge> : null}
          </span>
          {canEdit && statusAction && slug && d.status === "ACTIVE" ? (
            <Form action={statusAction} className="space-y-0">
              <input type="hidden" name="$slug" value={slug} />
              <input type="hidden" name="kind" value="diagnosis" />
              <input type="hidden" name="id" value={d.id} />
              <div className="flex gap-1">
                <button name="status" value="RESOLVED" className="rounded-md px-2 py-1 text-[12px] text-text-2 hover:bg-surface">{t("clinic.visit.markResolved")}</button>
                <button name="status" value="ENTERED_IN_ERROR" className="rounded-md px-2 py-1 text-[12px] text-text-2 hover:bg-surface">{t("clinic.visit.markError")}</button>
              </div>
            </Form>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export async function AllergyForm({ action, slug, patientId }: { action: (s: FormState, fd: FormData) => Promise<FormState>; slug: string; patientId: string }) {
  const t = await getTranslations();
  return (
    <Form action={action}>
      <input type="hidden" name="$slug" value={slug} />
      <input type="hidden" name="patientId" value={patientId} />
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField name="substance" label={t("clinic.visit.substance")} required />
        <TextField name="reaction" label={t("clinic.visit.reaction")} optionalLabel={t("common.optional")} />
        <SelectField name="severity" label={t("clinic.visit.severity")} options={(["UNKNOWN", "MILD", "MODERATE", "SEVERE"] as const).map((s) => ({ value: s, label: t(`severity.${s}`) }))} />
      </div>
      <SubmitButton variant="secondary">{t("clinic.visit.addAllergy")}</SubmitButton>
    </Form>
  );
}
