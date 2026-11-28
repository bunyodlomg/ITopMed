"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { COMPLAINTS, historySuggestions, type Complaint, type HistoryAnswers } from "@/lib/history-wizard";
import { cx } from "./ui/primitives";

const chip = "inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-full border px-4 text-[14px] font-medium transition-colors has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:checked]:text-accent";
const input = "block h-11 w-full rounded-[var(--radius-control)] border border-border-strong bg-surface-2 px-3.5 text-[15px] focus:border-accent focus:bg-surface focus:outline-none focus:ring-4 focus:ring-[var(--focus)]";
const area = "block w-full rounded-[var(--radius-control)] border border-border-strong bg-surface-2 px-3.5 py-2.5 text-[15px] leading-relaxed focus:border-accent focus:bg-surface focus:outline-none focus:ring-4 focus:ring-[var(--focus)]";

export interface HistoryWizardProps {
  vitals: { systolic?: number; diastolic?: number; weightKg?: number; heightCm?: number };
  existing: string[];
  initial: { diabetes: HistoryAnswers["diabetes"]; smoking: HistoryAnswers["smoking"]; priorMi: boolean; hypertensionYears: string };
}

/**
 * Questions → the note's complaints and history text (editable before saving)
 * and suggested diagnoses to tick. Lives inside a server-action form.
 */
export function HistoryWizard({ vitals, existing, initial }: HistoryWizardProps) {
  const t = useTranslations("historyWizard");
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [duration, setDuration] = useState("");
  const [unit, setUnit] = useState<"days" | "weeks" | "months" | "years">("months");
  const [bp, setBp] = useState<HistoryAnswers["bp"]>(initial.hypertensionYears ? "yes" : "");
  const [years, setYears] = useState(initial.hypertensionYears);
  const [bpMax, setBpMax] = useState("");
  const [meds, setMeds] = useState("");
  const [diabetes, setDiabetes] = useState<HistoryAnswers["diabetes"]>(initial.diabetes);
  const [smoking, setSmoking] = useState<HistoryAnswers["smoking"]>(initial.smoking);
  const [priorMi, setPriorMi] = useState(initial.priorMi);
  const [stroke, setStroke] = useState(false);
  const [heredity, setHeredity] = useState(false);
  const [extra, setExtra] = useState("");
  // Once the doctor edits a text by hand it is no longer rewritten from the answers.
  const [complaintsEdit, setComplaintsEdit] = useState<string | null>(null);
  const [historyEdit, setHistoryEdit] = useState<string | null>(null);

  const complaintsText = useMemo(() => {
    if (!complaints.length) return "";
    const list = complaints.map((c) => t(`c.${c}`)).join(", ");
    const since = Number(duration) > 0 ? ` ${t(`since.${unit}`, { n: Number(duration) })}` : "";
    return `${list.charAt(0).toUpperCase()}${list.slice(1)}.${since}`;
  }, [complaints, duration, unit, t]);

  const historyText = useMemo(() => {
    const parts: string[] = [];
    if (bp === "yes") parts.push(Number(years) > 0 ? t("h.bpYears", { n: Number(years) }) : t("h.bp"));
    if (bp === "yes" && bpMax.trim()) parts.push(t("h.bpMax", { bp: bpMax.trim() }));
    if (bp === "no") parts.push(t("h.bpNo"));
    if (meds.trim()) parts.push(t("h.meds", { meds: meds.trim() }));
    if (diabetes === "TYPE2") parts.push(t("h.diabetes2"));
    if (diabetes === "TYPE1") parts.push(t("h.diabetes1"));
    if (diabetes === "NO") parts.push(t("h.diabetesNo"));
    if (smoking === "CURRENT") parts.push(t("h.smokes"));
    if (smoking === "FORMER") parts.push(t("h.smokedBefore"));
    if (priorMi) parts.push(t("h.mi"));
    if (stroke) parts.push(t("h.stroke"));
    if (heredity) parts.push(t("h.heredity"));
    if (extra.trim()) parts.push(extra.trim());
    return parts.join(" ");
  }, [bp, years, bpMax, meds, diabetes, smoking, priorMi, stroke, heredity, extra, t]);

  const suggestions = historySuggestions({ complaints, bp, diabetes, smoking, priorMi, stroke, existing, ...vitals });

  return (
    <div className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="mb-2 text-[16px] font-semibold">{t("complaintsTitle")}</legend>
        <div className="flex flex-wrap gap-2">
          {COMPLAINTS.map((c) => (
            <label key={c} className={cx(chip, "border-border bg-surface")}>
              <input
                type="checkbox"
                className="size-4 accent-[var(--accent)]"
                checked={complaints.includes(c)}
                onChange={(e) => setComplaints((list) => (e.target.checked ? [...list, c] : list.filter((x) => x !== c)))}
              />
              {t(`label.${c}`)}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block w-28">
            <span className="mb-1 block text-[13px] font-medium">{t("duration")}</span>
            <input className={input} inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value.replace(/\D/g, "").slice(0, 3))} />
          </label>
          <label className="block w-40">
            <span className="sr-only">{t("durationUnit")}</span>
            <select className={input} value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)}>
              {(["days", "weeks", "months", "years"] as const).map((u) => (
                <option key={u} value={u}>
                  {t(`unit.${u}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-[16px] font-semibold">{t("bpTitle")}</legend>
        <div className="flex flex-wrap gap-2">
          {(["yes", "no"] as const).map((v) => (
            <label key={v} className={cx(chip, "border-border bg-surface")}>
              <input type="radio" name="bpAnswer" className="size-4 accent-[var(--accent)]" checked={bp === v} onChange={() => setBp(v)} />
              {t(`bp.${v}`)}
            </label>
          ))}
        </div>
        {bp === "yes" ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium">{t("bpYears")}</span>
              <input name="hypertensionYears" className={input} inputMode="numeric" value={years} onChange={(e) => setYears(e.target.value.replace(/\D/g, "").slice(0, 2))} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium">{t("bpMax")}</span>
              <input className={input} placeholder="180/110" value={bpMax} onChange={(e) => setBpMax(e.target.value.slice(0, 12))} />
            </label>
          </div>
        ) : null}
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium">{t("meds")}</span>
          <input className={input} placeholder={t("medsPlaceholder")} value={meds} onChange={(e) => setMeds(e.target.value.slice(0, 300))} />
        </label>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-[16px] font-semibold">{t("riskTitle")}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium">{t("diabetes")}</span>
            <select name="diabetes" className={input} value={diabetes} onChange={(e) => setDiabetes(e.target.value as HistoryAnswers["diabetes"])}>
              <option value="">—</option>
              {(["NO", "TYPE2", "TYPE1", "OTHER"] as const).map((v) => (
                <option key={v} value={v}>
                  {t(`diabetesOpt.${v}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium">{t("smoking")}</span>
            <select name="smoking" className={input} value={smoking} onChange={(e) => setSmoking(e.target.value as HistoryAnswers["smoking"])}>
              <option value="">—</option>
              {(["NEVER", "FORMER", "CURRENT"] as const).map((v) => (
                <option key={v} value={v}>
                  {t(`smokingOpt.${v}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className={cx(chip, "border-border bg-surface")}>
            <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={priorMi} onChange={(e) => setPriorMi(e.target.checked)} />
            {t("label.priorMi")}
          </label>
          <label className={cx(chip, "border-border bg-surface")}>
            <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={stroke} onChange={(e) => setStroke(e.target.checked)} />
            {t("label.stroke")}
          </label>
          <label className={cx(chip, "border-border bg-surface")}>
            <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={heredity} onChange={(e) => setHeredity(e.target.checked)} />
            {t("label.heredity")}
          </label>
        </div>
        <input type="hidden" name="priorMyocardialInfarction" value={priorMi ? "yes" : ""} />
        <input type="hidden" name="heredity" value={heredity ? "1" : ""} />
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium">{t("extra")}</span>
          <input className={input} value={extra} onChange={(e) => setExtra(e.target.value.slice(0, 500))} />
        </label>
      </fieldset>

      <fieldset className="space-y-3 rounded-[var(--radius-card)] border border-border bg-surface-2 p-4">
        <legend className="px-1 text-[16px] font-semibold">{t("previewTitle")}</legend>
        <p className="text-[13px] text-text-2">{t("previewHint")}</p>
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium">{t("complaintsText")}</span>
          <textarea name="complaintsText" rows={2} className={area} value={complaintsEdit ?? complaintsText} onChange={(e) => setComplaintsEdit(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium">{t("historyText")}</span>
          <textarea name="historyText" rows={3} className={area} value={historyEdit ?? historyText} onChange={(e) => setHistoryEdit(e.target.value)} />
        </label>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-[16px] font-semibold">{t("dxTitle")}</legend>
        <p className="text-[13px] text-text-2">{t("dxHint")}</p>
        {suggestions.length === 0 ? (
          <p className="text-[14px] text-text-3">{t("dxNone")}</p>
        ) : (
          <ul className="space-y-1.5">
            {suggestions.map((code, i) => (
              <li key={code}>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--radius-control)] border border-border bg-surface px-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                  <input type="checkbox" name="dx" value={`${code}|${t(`dx.${code.replace(".", "_")}`)}`} className="size-4 accent-[var(--accent)]" />
                  <span className="font-mono text-[13px] text-text-2">{code}</span>
                  <span className="text-[14.5px]">{t(`dx.${code.replace(".", "_")}`)}</span>
                  {i === 0 ? <span className="ml-auto text-[12px] text-text-3">{t("dxPrimary")}</span> : null}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
    </div>
  );
}
