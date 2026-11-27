"use client";

import { Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { useFormResult } from "@/components/ui/form";

interface Suggestion {
  icd10Code: string;
  description: string;
  uses: number;
}

const inputClass =
  "block w-full rounded-[var(--radius-control)] border border-border-strong bg-surface-2 px-4 text-[15px] text-text placeholder:text-text-3 transition-[background-color,border-color,box-shadow] duration-150 hover:border-text-3 focus:border-accent focus:bg-surface focus:outline-none focus:ring-4 focus:ring-[var(--focus)] aria-[invalid=true]:border-danger";
const KINDS = ["PRIMARY", "SECONDARY", "COMPLICATION"] as const;

/**
 * Diagnosis entry for the visit: one search box over the clinic's own codes
 * and wording (code "I1…" or words, Latin or Cyrillic), the code and the
 * wording (both editable, plain fields so the quick chips can fill them), the
 * kind as three large buttons and the stage. Nothing is chosen for the doctor.
 */
export function DiagnosisPicker({ slug, stageHint }: { slug: string; stageHint: string }) {
  const t = useTranslations();
  const result = useFormResult();
  const id = useId();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [kind, setKind] = useState<(typeof KINDS)[number]>("PRIMARY");
  const code = useRef<HTMLInputElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const seq = useRef(0);
  const [seenNonce, setSeenNonce] = useState(result.nonce);
  if (result.nonce !== seenNonce) {
    setSeenNonce(result.nonce);
    if (result.ok) {
      setQ("");
      setKind("SECONDARY"); // the next one is usually an accompanying diagnosis
    }
  }
  useEffect(() => {
    if (result.ok) {
      if (code.current) code.current.value = "";
      if (text.current) text.current.value = "";
    }
  }, [result.nonce, result.ok]);

  useEffect(() => {
    if (!open) return;
    const n = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/c/${encodeURIComponent(slug)}/diagnoses/search?q=${encodeURIComponent(q.trim())}`, { headers: { Accept: "application/json" }, cache: "no-store" });
        if (!r.ok || n !== seq.current) return;
        const data = (await r.json()) as { items: Suggestion[] };
        if (n === seq.current) {
          setItems(data.items);
          setActive(data.items.length ? 0 : -1);
        }
      } catch {
        /* offline: the fields below still work */
      }
    }, q.trim() ? 150 : 0);
    return () => clearTimeout(timer);
  }, [q, open, slug]);

  const choose = (d: Suggestion) => {
    if (code.current) code.current.value = d.icd10Code;
    if (text.current) {
      text.current.value = d.description;
      text.current.focus();
    }
    setQ("");
    setOpen(false);
  };
  /** Enter without a suggestion: what was typed becomes the code (if it looks like one) or the wording. */
  const takeTyped = () => {
    const v = q.trim();
    if (!v) return;
    if (/^[A-Za-z]\d{2}(\.[0-9A-Za-z]{1,4})?$/.test(v)) {
      if (code.current) code.current.value = v.toUpperCase();
      text.current?.focus();
    } else if (text.current) {
      text.current.value = v;
      text.current.focus();
    }
    setOpen(false);
  };
  const fe = result.fieldErrors ?? {};
  const listId = `${id}-list`;

  return (
    <div className="space-y-4">
      <div className="relative">
        <label htmlFor={`${id}-q`} className="block text-[13px] font-medium">{t("clinic.dxPicker.search")}</label>
        <div className="relative mt-1.5">
          <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-text-3" />
          <input
            id={`${id}-q`}
            role="combobox"
            aria-expanded={open && items.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
            value={q}
            autoComplete="off"
            spellCheck={false}
            placeholder={t("clinic.dxPicker.placeholder")}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (open && active >= 0 && items[active]) choose(items[active]!);
                else takeTyped();
              } else if (!open || !items.length) return;
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => (a + 1) % items.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => (a <= 0 ? items.length - 1 : a - 1));
              } else if (e.key === "Escape") setOpen(false);
            }}
            className={`${inputClass} h-11 pl-11`}
          />
        </div>
        <p className="mt-1.5 text-[12.5px] text-text-3">{t("clinic.dxPicker.hint")}</p>
        {open && items.length > 0 ? (
          <ul id={listId} role="listbox" aria-label={t("clinic.dxPicker.results")} className="absolute inset-x-0 top-[4.6rem] z-30 max-h-72 overflow-y-auto rounded-[var(--radius-control)] border border-border bg-surface p-1 shadow-lg">
            {items.map((d, i) => (
              <li
                key={`${d.icd10Code}|${d.description}`}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(d);
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex cursor-pointer items-baseline gap-3 rounded-[8px] px-3 py-2 text-[14px] ${i === active ? "bg-accent-soft" : ""}`}
              >
                <span className="w-14 shrink-0 font-mono font-semibold">{d.icd10Code || "—"}</span>
                <span className="min-w-0 flex-1 break-words">{d.description}</span>
                <span className="shrink-0 text-[12px] text-text-3">{t("clinic.dxPicker.uses", { count: d.uses })}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-[130px_1fr]">
        <div className="space-y-1.5">
          <label htmlFor={`${id}-code`} className="block text-[13px] font-medium">
            {t("clinic.visit.icd10")} <span className="font-normal text-text-3">({t("common.optional")})</span>
          </label>
          <input
            ref={code}
            id={`${id}-code`}
            name="icd10Code"
            defaultValue={result.ok ? "" : (result.values?.icd10Code ?? "")}
            autoComplete="off"
            placeholder="I10"
            aria-invalid={fe.icd10Code ? true : undefined}
            className={`${inputClass} h-11 font-mono uppercase`}
          />
          {fe.icd10Code ? <p className="text-[13px] text-danger">{t(fe.icd10Code as never)}</p> : null}
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-text`} className="block text-[13px] font-medium">{t("clinic.visit.description")}</label>
          <textarea ref={text} id={`${id}-text`} name="description" rows={2} defaultValue={result.ok ? "" : (result.values?.description ?? "")} aria-invalid={fe.description ? true : undefined} className={`${inputClass} py-2.5`} />
          {fe.description ? <p className="text-[13px] text-danger">{t(fe.description as never)}</p> : null}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)] sm:items-start">
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium">{t("clinic.visit.kind")}</legend>
          <div className="grid grid-cols-3 gap-2">
            {KINDS.map((k) => (
              <label key={k} className={`flex min-h-11 cursor-pointer items-center justify-center rounded-[var(--radius-control)] border px-2 text-center text-[13.5px] font-semibold ${kind === k ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface-2"}`}>
                <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="sr-only" />
                {t(`diagnosisKind.${k}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-stage`} className="block text-[13px] font-medium">
            {t("clinic.visit.stage")} <span className="font-normal text-text-3">({t("common.optional")})</span>
          </label>
          <input id={`${id}-stage`} name="stage" autoComplete="off" defaultValue="" key={result.nonce} className={`${inputClass} h-11`} />
          <p className="text-[12.5px] text-text-3">{stageHint}</p>
        </div>
      </div>
    </div>
  );
}
