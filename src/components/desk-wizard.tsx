"use client";

import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { formatMoneyText } from "@/lib/money";

export interface DeskWizardStep {
  key: "patient" | "services" | "vitals" | "doctor";
  label: string;
}

/**
 * The reception desk as steps on one screen: patient → services and payment → measurements →
 * doctor. Everything stays one form (the server action is unchanged); a step only shows the
 * panels marked `data-step="<index>"` anywhere inside (the patient search, which is its own
 * GET form, sits outside the check-in form but in step 0). The hiding is plain CSS keyed on
 * `data-wizard-active` (globals.css), so the server-rendered page already shows one step.
 * "Next" checks the visible step's required fields; Enter in a field moves on instead of
 * submitting early; a server error on a field opens the step that holds it.
 */
export function DeskWizard({
  steps,
  initial = 0,
  formId,
  patientLabel,
  prices,
  currency,
  children,
}: {
  steps: DeskWizardStep[];
  initial?: number;
  formId: string;
  /** The chosen patient's name (else read from the new-patient fields). */
  patientLabel?: string;
  /** Service id -> price in minor units, for the live summary. */
  prices: Record<string, string>;
  currency: string;
  children: ReactNode;
}) {
  const t = useTranslations("clinic.desk.wizard");
  const locale = useLocale();
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(Math.min(Math.max(initial, 0), steps.length - 1));
  const [summary, setSummary] = useState<Partial<Record<DeskWizardStep["key"], string>>>({});
  const last = steps.length - 1;
  const moved = useRef(false);

  const form = useCallback(() => document.getElementById(formId) as HTMLFormElement | null, [formId]);

  const read = useCallback(() => {
    const f = form();
    if (!f) return;
    const v = (name: string) => (f.elements.namedItem(name) as HTMLInputElement | null)?.value?.trim() ?? "";
    const next: Partial<Record<DeskWizardStep["key"], string>> = {};
    const name = patientLabel ?? [v("lastName"), v("firstName")].filter(Boolean).join(" ");
    if (name) next.patient = name;
    const ids = new Set<string>();
    f.querySelectorAll<HTMLInputElement>('input[name="serviceIds"]').forEach((el) => {
      if (el.type === "hidden" || el.checked) ids.add(el.value);
    });
    if (ids.size) {
      let total = 0n;
      for (const id of ids) total += BigInt(prices[id] ?? "0");
      next.services = t("servicesSummary", { count: ids.size, total: formatMoneyText(total, currency, locale) });
    }
    const sys = v("SYSTOLIC_BP");
    const dia = v("DIASTOLIC_BP");
    const filled = ["HEIGHT", "WEIGHT", "SYSTOLIC_BP", "DIASTOLIC_BP", "HEART_RATE"].filter((n) => v(n)).length;
    if (sys && dia) next.vitals = t("bpSummary", { bp: `${sys}/${dia}` });
    else if (filled) next.vitals = t("filledSummary", { count: filled });
    const doctor = f.elements.namedItem("doctorProfileId") as HTMLSelectElement | null;
    const label = doctor?.selectedOptions?.[0]?.textContent ?? "";
    if (label) next.doctor = label.split(" · ").find((part, i, all) => (all.length > 2 ? i === 1 : i === 0)) ?? label;
    setSummary(next);
  }, [form, patientLabel, prices, currency, locale, t]);

  const readLater = useRef(read);
  useEffect(() => {
    readLater.current = read;
  }, [read]);

  const fields = (i: number) => [...(root.current?.querySelectorAll<HTMLElement>(`[data-step="${i}"]`) ?? [])].flatMap((p) => [...p.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea")]);

  /** The visible step's required fields; reports the first empty one. */
  const check = (i: number) => {
    for (const el of fields(i)) {
      if (el.form?.id !== formId || !el.required) continue;
      if (!el.value.trim()) {
        el.reportValidity();
        el.focus();
        return false;
      }
    }
    return true;
  };

  const go = (i: number) => {
    if (i === active || i < 0 || i > last) return;
    if (i > active && !check(active)) return;
    moved.current = true;
    setActive(i);
  };

  // A new step: its first empty field gets the cursor; the step header comes into view.
  useEffect(() => {
    const raf = requestAnimationFrame(read);
    if (moved.current) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      const first = fields(active).find((el) => el.form?.id === formId && el.type !== "hidden" && el.type !== "checkbox" && el.type !== "radio" && !el.value);
      first?.focus({ preventScroll: true });
    }
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the step changes
  }, [active]);

  // A server error on a field (or a duplicate-patient warning) opens the step that holds it.
  useEffect(() => {
    const box = root.current;
    if (!box) return;
    // Only a new error counts: the same message must not pull the desk back on every re-render.
    const seen = new WeakSet<Element>();
    const obs = new MutationObserver(() => {
      requestAnimationFrame(() => readLater.current());
      const bad = box.querySelector<HTMLElement>('[aria-invalid="true"]');
      const alert = box.querySelector(`#${CSS.escape(formId)} > [role="alert"]`);
      const fresh = bad && !seen.has(bad) ? bad : alert && !seen.has(alert) ? alert : null;
      if (bad) seen.add(bad);
      if (alert) seen.add(alert);
      if (!fresh) return;
      const step = fresh.closest<HTMLElement>("[data-step]")?.dataset.step;
      setActive(step !== undefined ? Number(step) : 0);
    });
    obs.observe(box, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-invalid"] });
    return () => obs.disconnect();
  }, [formId]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (e.key !== "Enter" || active === last || el.tagName !== "INPUT") return;
    if ((el as HTMLInputElement).form?.id !== formId) return;
    e.preventDefault();
    go(active + 1);
  };

  return (
    <div ref={root} data-wizard-active={active} onKeyDown={onKeyDown} onInput={() => requestAnimationFrame(read)} onChange={() => requestAnimationFrame(read)} className="scroll-mt-4 space-y-4">
      <nav aria-label={t("label")}>
        <ol className="grid gap-2" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
          {steps.map((s, i) => {
            const state = i === active ? "active" : i < active ? "done" : "todo";
            return (
              <li key={s.key} className="min-w-0">
                <button
                  type="button"
                  onClick={() => go(i)}
                  aria-current={state === "active" ? "step" : undefined}
                  className={`flex h-full w-full min-w-0 items-center gap-2.5 rounded-[16px] border px-3 py-2.5 text-left transition-colors ${
                    state === "active" ? "border-accent bg-accent-soft" : state === "done" ? "border-border bg-surface hover:border-border-strong" : "border-border bg-surface-2 hover:border-border-strong"
                  }`}
                >
                  <span
                    className={`grid size-8 shrink-0 place-items-center rounded-full text-[14px] font-bold tabular-nums ${
                      state === "active" ? "bg-accent-solid text-on-accent" : state === "done" ? "bg-success-soft text-success" : "bg-sunken text-text-2"
                    }`}
                  >
                    {state === "done" ? <Check aria-hidden className="size-4" /> : i + 1}
                  </span>
                  <span className="hidden min-w-0 sm:block">
                    <span className={`block truncate text-[13.5px] font-semibold ${state === "todo" ? "text-text-2" : "text-text"}`}>{s.label}</span>
                    <span className="block truncate text-[12px] text-text-3">{summary[s.key] ?? (state === "todo" ? t("pending") : "")}</span>
                  </span>
                  <span className="sr-only sm:hidden">{s.label}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="mt-2 text-[13px] font-semibold sm:hidden">
          {t("stepOf", { n: active + 1, total: steps.length })} · {steps[active]!.label}
        </p>
      </nav>

      {active === last && last > 0 ? (
        // Before the queue number: the whole check-in at a glance; a tap goes back to fix a step.
        <section aria-label={t("check")} className="grid gap-2 rounded-[var(--radius-card)] bg-surface p-3 shadow-card sm:grid-cols-3">
          {steps.slice(0, last).map((s, i) => (
            <button key={s.key} type="button" onClick={() => go(i)} className="min-w-0 rounded-[14px] bg-surface-2 px-3 py-2 text-left hover:bg-sunken">
              <span className="block text-[12px] text-text-3">{s.label}</span>
              <span className="block truncate text-[14px] font-semibold">{summary[s.key] ?? t("empty")}</span>
            </button>
          ))}
        </section>
      ) : null}

      {children}

      {/* Always in reach: the way forward stays at the bottom of the screen however long the step is. */}
      <div className="sticky bottom-[calc(76px+env(safe-area-inset-bottom))] z-10 flex lg:bottom-3 flex-wrap items-center justify-between gap-3 rounded-full bg-surface/95 p-2 shadow-card backdrop-blur">
        {active > 0 ? (
          <button type="button" onClick={() => go(active - 1)} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border-strong bg-surface px-5 text-[14px] font-semibold hover:bg-surface-2">
            <ArrowLeft aria-hidden className="size-4" /> {t("back")}
          </button>
        ) : (
          <span />
        )}
        {summary.services && active > 0 && active < last ? <span className="min-w-0 truncate px-2 text-[14px] font-semibold tabular-nums">{summary.services}</span> : null}
        {active < last ? (
          <button type="button" onClick={() => go(active + 1)} className="inline-flex min-h-12 items-center gap-2 rounded-full bg-accent-solid px-6 text-[15px] font-semibold text-on-accent hover:opacity-90">
            {t("next", { step: steps[active + 1]!.label })} <ArrowRight aria-hidden className="size-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
