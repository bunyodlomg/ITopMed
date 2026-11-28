"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { flagOf, type TemplateField } from "@/lib/diagnostic-template";
import { applyEchoCalculations, echoCalculations } from "@/lib/echo-calc";
import { DIAGNOSTIC_FIELDS, DIAGNOSTIC_KINDS, unitKey, type DiagnosticKindKey } from "@/lib/diagnostics";

const input = "h-10 w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 text-[14px] focus:border-accent focus:outline-none focus:ring-4 focus:ring-[var(--focus)]";
const area = "w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 py-2 text-[14px] focus:border-accent focus:outline-none focus:ring-4 focus:ring-[var(--focus)]";

export interface StudyTemplate {
  id: string;
  name: string;
  study: DiagnosticKindKey;
  fields: TemplateField[];
  conclusion?: string;
}

/**
 * The inside of the "add result" form: either one of the clinic's diagnostic
 * templates (its fields with the clinic's normal ranges, "fill normal",
 * values outside the range marked at once) or the built-in fields of a study.
 */
export function DiagnosticFields({ templates, initialTemplateId = "", initialKind = "ECG" }: { templates: StudyTemplate[]; initialTemplateId?: string; initialKind?: DiagnosticKindKey }) {
  const t = useTranslations("diagnostics");
  const locale = useLocale();
  /** Numbers of the clinic's ranges with a decimal comma, except in English. */
  const dec = (n: number) => (locale === "en" ? String(n) : String(n).replace(".", ","));
  // Starts with the built-in study (ECG, echo, ...): one of the clinic's templates (e.g. a
  // pregnancy ultrasound form) is picked on purpose, never pre-selected for every patient.
  // From the doctor's queue a paid service opens its own form (initialTemplateId / initialKind).
  const [templateId, setTemplateId] = useState<string>(templates.some((x) => x.id === initialTemplateId) ? initialTemplateId : "");
  const tpl = templates.find((x) => x.id === templateId) ?? null;
  const [kind, setKind] = useState<DiagnosticKindKey>(initialKind);
  const [title, setTitle] = useState<string>(tpl?.name ?? t(`kind.${initialKind}`));
  const [values, setValues] = useState<Record<string, string>>({});
  // Fields the program computed (echo formulas); a field the doctor types into leaves this set.
  const [auto, setAuto] = useState<Set<string>>(new Set());
  const [conclusion, setConclusion] = useState<string>(tpl?.conclusion ?? "");
  const computable = tpl ? new Set(echoCalculations(tpl.fields)) : new Set<string>();

  /** New values with the computable fields refreshed. */
  const recompute = (next: Record<string, string>, keepAuto: Set<string>) => {
    if (!tpl || computable.size === 0) {
      setValues(next);
      return;
    }
    const r = applyEchoCalculations(tpl.fields, next, keepAuto);
    setValues(r.values);
    setAuto(r.auto);
  };
  const edit = (key: string, value: string) => {
    const keepAuto = new Set(auto);
    keepAuto.delete(key); // typed by the doctor: never overwritten again
    recompute({ ...values, [key]: value }, keepAuto);
  };

  const pickTemplate = (id: string) => {
    setTemplateId(id);
    const next = templates.find((x) => x.id === id);
    setValues({});
    setAuto(new Set());
    setTitle(next ? next.name : t(`kind.${kind}`));
    setConclusion(next?.conclusion ?? "");
  };
  const fillNormal = () => {
    if (!tpl) return;
    const out = { ...values };
    for (const f of tpl.fields) if (f.normal && !(out[f.key] ?? "").trim()) out[f.key] = f.normal;
    recompute(out, auto);
  };
  const abnormal = tpl ? tpl.fields.filter((f) => flagOf(f, values[f.key])) : [];
  /** A draft conclusion from the values outside the clinic's ranges; the doctor edits it. */
  const draftConclusion = () => {
    if (!tpl) return;
    const lines = abnormal.map((f) => {
      const flag = flagOf(f, values[f.key])!;
      return t("draftLine", { label: f.label, value: `${values[f.key]}${f.unit ? ` ${f.unit}` : ""}`, flag: t(flag === "HIGH" ? "high" : "low"), min: dec(f.min!), max: dec(f.max!) });
    });
    const draft = lines.length ? lines.join("\n") : t("draftAllNormal");
    const current = conclusion.trim();
    // Empty or still the template's own text: the draft goes first; otherwise it is added below what the doctor wrote.
    setConclusion(!current || current === (tpl.conclusion ?? "").trim() ? `${draft}\n${tpl.conclusion ?? ""}`.trim() : `${current}\n${draft}`);
  };

  return (
    <div className="space-y-3">
      {templates.length ? (
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium">{t("template")}</span>
          <select value={templateId} onChange={(e) => pickTemplate(e.target.value)} className={input}>
            <option value="">{t("noTemplate")}</option>
            {templates.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {tpl ? (
        <>
          <input type="hidden" name="templateId" value={tpl.id} />
          <input type="hidden" name="kind" value={tpl.study} />
        </>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {!tpl ? (
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium">{t("kindLabel")}</span>
            <select
              name="kind"
              value={kind}
              onChange={(e) => {
                const k = e.target.value as DiagnosticKindKey;
                setKind(k);
                setTitle(t(`kind.${k}`));
              }}
              className={input}
            >
              {DIAGNOSTIC_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`kind.${k}`)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium">{t("title")}</span>
          <input name="title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required className={input} />
        </label>
      </div>

      {tpl ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] text-text-2">{t("templateHint")}</p>
            {tpl.fields.some((f) => f.normal) ? (
              <button type="button" onClick={fillNormal} className="rounded-full border border-border bg-surface-2 px-3 py-1.5 text-[13px] font-medium hover:border-accent hover:text-accent">
                {t("fillNormal")}
              </button>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {tpl.fields.map((f) => {
              const flag = flagOf(f, values[f.key]);
              return (
                <label key={`${tpl.id}-${f.key}`} className="block min-w-0">
                  <span className="mb-1 block text-[12.5px] font-medium text-text-2">
                    {f.label}
                    {f.unit ? <span className="font-normal text-text-3"> ({f.unit})</span> : null}
                  </span>
                  <input
                    name={`f_${f.key}`}
                    value={values[f.key] ?? ""}
                    onChange={(e) => edit(f.key, e.target.value)}
                    inputMode={f.min !== undefined ? "decimal" : undefined}
                    maxLength={1000}
                    aria-invalid={flag ? true : undefined}
                    className={`${input} ${flag ? "border-danger font-semibold text-danger" : ""}`}
                  />
                  {f.min !== undefined && f.max !== undefined ? (
                    <span className={`mt-0.5 block text-[11.5px] ${flag ? "font-semibold text-danger" : "text-text-3"}`}>
                      {flag ? t(flag === "HIGH" ? "high" : "low") + " · " : ""}
                      {t("normalRange", { min: dec(f.min), max: dec(f.max) })}
                      {auto.has(f.key) ? ` · ${t("computed")}` : ""}
                    </span>
                  ) : auto.has(f.key) ? (
                    <span className="mt-0.5 block text-[11.5px] text-text-3">{t("computed")}</span>
                  ) : computable.has(f.key) ? (
                    <span className="mt-0.5 block text-[11.5px] text-text-3">{t("computable")}</span>
                  ) : null}
                </label>
              );
            })}
          </div>
          {abnormal.length ? (
            <p className="rounded-[10px] bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger" role="status">
              {t("abnormalList", { list: abnormal.map((f) => f.label).join(", ") })}
            </p>
          ) : null}
        </>
      ) : DIAGNOSTIC_FIELDS[kind].length ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {DIAGNOSTIC_FIELDS[kind].map((f) => (
            <label key={`${kind}-${f.key}`} className={`block min-w-0 ${f.type === "text" && f.max > 300 ? "sm:col-span-3" : ""}`}>
              <span className="mb-1 block text-[12.5px] font-medium text-text-2">
                {t(`field.${f.key}`)}
                {f.type === "number" && f.unit ? <span className="font-normal text-text-3"> ({t(`unit.${unitKey(f.unit)}`)})</span> : null}
              </span>
              {f.type === "text" && f.max > 300 ? (
                <textarea name={f.key} rows={2} maxLength={f.max} className={area} />
              ) : (
                <input name={f.key} inputMode={f.type === "number" ? "decimal" : undefined} maxLength={f.type === "text" ? f.max : 12} className={input} />
              )}
            </label>
          ))}
        </div>
      ) : null}

      {tpl ? (
        <div className="flex justify-end">
          <button type="button" onClick={draftConclusion} className="rounded-full border border-border bg-surface-2 px-3 py-1.5 text-[13px] font-medium hover:border-accent hover:text-accent">
            {t("draftConclusion")}
          </button>
        </div>
      ) : null}
      <label className="block">
        <span className="mb-1 block text-[13px] font-medium">{t("conclusion")}</span>
        <textarea name="conclusion" value={conclusion} onChange={(e) => setConclusion(e.target.value)} rows={3} maxLength={10000} required className={area} />
      </label>
    </div>
  );
}
