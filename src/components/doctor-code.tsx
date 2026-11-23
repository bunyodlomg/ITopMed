"use client";

import { useTranslations } from "next-intl";
import { useId, useState, type KeyboardEvent } from "react";

export interface DoctorCodeOption {
  code: string;
  profileId: string;
  /** "Name · Specialty", shown once the code is recognised. */
  label: string;
}

/**
 * Desk shortcut: the registrar types the doctor's code ("01") and presses
 * Enter - the doctor (and so the specialty) is chosen in the form's doctor
 * select. Enter here never submits the form. Without codes nothing is shown.
 */
export function DoctorCodeInput({ doctors, selectName = "doctorProfileId" }: { doctors: DoctorCodeOption[]; selectName?: string }) {
  const t = useTranslations("clinic.desk");
  const id = useId();
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  if (!doctors.length) return null;

  const choose = (input: HTMLInputElement) => {
    const code = input.value.trim();
    if (!code) return;
    const found = doctors.find((d) => d.code === code) ?? doctors.find((d) => Number(d.code) === Number(code) && /^\d+$/.test(code));
    if (!found) {
      setStatus({ ok: false, text: t("doctorCodeUnknown", { code }) });
      return;
    }
    const select = input.form?.elements.namedItem(selectName);
    if (select instanceof HTMLSelectElement) {
      select.value = found.profileId;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    setStatus({ ok: true, text: found.label });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    choose(e.currentTarget);
  };

  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium">
        {t("doctorCode")}
      </label>
      <input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        placeholder="01"
        onKeyDown={onKeyDown}
        onBlur={(e) => choose(e.currentTarget)}
        aria-describedby={`${id}-status`}
        className="h-11 w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-3.5 text-[15px] tabular-nums focus:border-accent focus:outline-none focus:ring-4 focus:ring-[var(--focus)]"
      />
      <p id={`${id}-status`} aria-live="polite" className={`mt-1 min-h-[1.25em] text-[12.5px] ${status ? (status.ok ? "font-medium text-success" : "text-danger") : "text-text-3"}`}>
        {status ? status.text : t("doctorCodeHint")}
      </p>
    </div>
  );
}
