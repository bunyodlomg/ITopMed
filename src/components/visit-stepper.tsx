"use client";

import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { buttonClass } from "./ui/primitives";

export interface VisitStep {
  id: string;
  title: string;
  /** Something has been recorded in this step (shown as a tick). */
  done?: boolean;
  content: ReactNode;
}

/**
 * The doctor's visit in steps (complaints → measurements → diagnosis → studies
 * → treatment → finish). Every step stays in the page — only hidden — so a
 * half-typed note survives moving between steps, and server actions that
 * reload the page come back to the same step (remembered per visit for the
 * tab). Steps can be opened in any order; Back/Next walk them in order.
 * A link to an element inside a step (e.g. "#dental") opens that step.
 */
export function VisitStepper({ storageKey, steps, labels }: { storageKey: string; steps: VisitStep[]; labels: { back: string; next: string; step: string; nav: string } }) {
  const [active, setActive] = useState(0);
  const panels = useRef<(HTMLDivElement | null)[]>([]);
  const top = useRef<HTMLElement | null>(null);

  const go = useCallback(
    (i: number, scroll = true) => {
      const n = Math.max(0, Math.min(steps.length - 1, i));
      setActive(n);
      try {
        sessionStorage.setItem(storageKey, steps[n]!.id);
      } catch {}
      if (scroll && top.current && top.current.getBoundingClientRect().top < 0) top.current.scrollIntoView({ block: "start", behavior: "smooth" });
    },
    [steps, storageKey],
  );

  // Where to start: a #hash inside a step wins, then the remembered step of this visit.
  useEffect(() => {
    const fromHash = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id) return -1;
      return panels.current.findIndex((p) => p?.id === `step-${id}` || Boolean(p?.querySelector(`[id="${CSS.escape(id)}"]`)));
    };
    let start = fromHash();
    if (start < 0) {
      try {
        const saved = sessionStorage.getItem(storageKey);
        start = steps.findIndex((s) => s.id === saved);
      } catch {}
    }
    if (start >= 0) setActive(start);
    const onHash = () => {
      const i = fromHash();
      if (i >= 0) go(i, false);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // Only on mount: later renders keep the doctor's current step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const last = steps.length - 1;
  return (
    <section ref={top} className="scroll-mt-4 space-y-5">
      <nav aria-label={labels.nav} className="rounded-[var(--radius-card)] bg-surface p-3 shadow-card sm:p-4">
        <ol className="flex items-start">
          {steps.map((s, i) => {
            const state = i === active ? "current" : s.done ? "done" : i < active ? "passed" : "todo";
            return (
              <li key={s.id} className="flex min-w-0 flex-1 items-start last:flex-none">
                <button
                  type="button"
                  onClick={() => go(i)}
                  aria-current={i === active ? "step" : undefined}
                  className="group flex min-w-0 flex-col items-center gap-1.5 rounded-[12px] px-1 py-1 outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span
                    className={
                      "grid size-9 shrink-0 place-items-center rounded-full text-[14px] font-semibold tabular-nums transition-[background-color,color,transform] duration-200 motion-reduce:transition-none " +
                      (state === "current"
                        ? "scale-110 bg-accent-solid text-on-accent"
                        : state === "done"
                          ? "bg-success-soft text-success"
                          : "bg-tile text-text-2 group-hover:bg-sunken")
                    }
                  >
                    {state === "done" ? <Check aria-hidden className="size-4" /> : i + 1}
                  </span>
                  <span className={`hidden max-w-[7.5rem] text-center text-[12.5px] leading-tight md:block ${i === active ? "font-semibold text-text" : "text-text-2"}`}>{s.title}</span>
                  <span className="sr-only">{`${labels.step} ${i + 1}: ${s.title}${s.done ? " ✓" : ""}`}</span>
                </button>
                {i < last ? (
                  <span aria-hidden className="mx-1 mt-[18px] h-[2px] min-w-2 flex-1 overflow-hidden rounded-full bg-tile">
                    <span className="block h-full bg-accent transition-[width] duration-300 motion-reduce:transition-none" style={{ width: i < active ? "100%" : "0%" }} />
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
        <p className="mt-2 text-center text-[14px] font-semibold md:hidden">
          {active + 1}/{steps.length} · {steps[active]!.title}
        </p>
      </nav>

      {steps.map((s, i) => (
        <div key={s.id} id={`step-${s.id}`} ref={(el) => void (panels.current[i] = el)} hidden={i !== active} className="step-panel space-y-6">
          {s.content}
        </div>
      ))}

      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <button type="button" onClick={() => go(active - 1)} disabled={active === 0} className={buttonClass("secondary", "lg")}>
          <ChevronLeft aria-hidden className="size-4" />
          {labels.back}
        </button>
        {active < last ? (
          <button type="button" onClick={() => go(active + 1)} className={buttonClass("primary", "lg")}>
            <span className="max-w-[12rem] truncate">{`${labels.next}: ${steps[active + 1]!.title}`}</span>
            <ChevronRight aria-hidden className="size-4" />
          </button>
        ) : null}
      </div>
    </section>
  );
}
