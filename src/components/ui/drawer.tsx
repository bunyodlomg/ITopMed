"use client";

import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * A panel that slides in from the right over the page (create / edit without
 * leaving the list). It is driven by the URL: the page renders it when a search
 * param asks for it (e.g. `?new=1`) and `closeHref` is the same URL without that
 * param, so Back, reload and shared links all behave. A modal <dialog>: focus
 * stays inside, Escape and a click on the dimmed page close it.
 */
export function Drawer({ title, description, closeHref, children, wide }: { title: ReactNode; description?: ReactNode; closeHref: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const t = useTranslations();
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    // The page behind must not scroll under the panel.
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = prev;
    };
  }, []);

  const close = () => router.replace(closeHref, { scroll: false });

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        // A click on the backdrop lands on the <dialog> itself, not on the panel inside it.
        if (e.target === e.currentTarget) close();
      }}
      className="drawer m-0 ml-auto h-dvh max-h-none w-full max-w-none bg-transparent p-0 text-text backdrop:bg-[rgb(10_11_13/0.45)] sm:p-3"
      style={{ maxWidth: wide ? 760 : 560 }}
    >
      <div className="drawer-panel flex h-full flex-col overflow-hidden bg-surface shadow-pop sm:rounded-[28px]">
        <header className="flex shrink-0 items-start gap-3 border-b border-border px-5 pb-4 pt-5 sm:px-6">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-balance text-[20px] font-semibold tracking-[-0.02em]">
              {title}
            </h2>
            {description ? <p className="mt-1 text-pretty text-[13.5px] text-text-3">{description}</p> : null}
          </div>
          <button type="button" onClick={close} aria-label={t("common.close")} className="grid size-10 shrink-0 place-items-center rounded-full bg-chip text-text-2 hover:bg-chip-hover hover:text-text">
            <X aria-hidden className="size-[18px]" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6" tabIndex={-1}>
          {children}
        </div>
      </div>
    </dialog>
  );
}
