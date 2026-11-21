"use client";

import { ChevronDown, LogOut, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { InstallApp } from "../install-app";

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "·";
}

/**
 * The person chip at the right of the top bar. A native <details>, so it opens
 * without JavaScript; with it, a click outside or Escape closes it.
 */
export function AccountMenu({ name, detail, signOut, securityHref }: { name: string; detail: string; signOut: () => Promise<void>; securityHref?: string }) {
  const t = useTranslations();
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !el.contains(e.target as Node)) {
        el.open = false;
        if (e instanceof KeyboardEvent) el.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);

  return (
    <details ref={ref} className="group/acc relative shrink-0">
      <summary
        aria-label={t("a11y.accountMenu")}
        className="flex h-14 cursor-pointer list-none items-center gap-3 rounded-full bg-surface py-1.5 pl-1.5 pr-1.5 shadow-control transition-shadow hover:shadow-raise xl:pr-4 [&::-webkit-details-marker]:hidden"
      >
        <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-full bg-tile text-[14px] font-semibold text-text">
          {initials(name)}
        </span>
        <span className="hidden min-w-0 max-w-[180px] leading-tight xl:block">
          <span className="block truncate text-[15px] font-semibold">{name}</span>
          <span className="block truncate text-[12.5px] text-text-3">{detail}</span>
        </span>
        <ChevronDown aria-hidden className="hidden size-4 text-text-3 transition-transform duration-[var(--dur-quick)] ease-[var(--ease-out)] group-open/acc:rotate-180 xl:block" />
      </summary>
      <div className="animate-drop absolute right-0 top-[calc(100%+8px)] z-40 w-[280px] space-y-3 rounded-[24px] border border-border bg-surface p-3 shadow-pop [transform-origin:top_right]">
        <div className="px-2 pt-1">
          <p className="truncate text-[15px] font-semibold">{name}</p>
          <p className="truncate text-[13px] text-text-3">{detail}</p>
        </div>
        <InstallApp />
        <div className="space-y-1 border-t border-border pt-2">
          {securityHref ? (
            <Link href={securityHref} className="flex h-11 items-center gap-3 rounded-full px-3 text-[14px] font-medium text-text-2 hover:bg-chip hover:text-text">
              <ShieldCheck aria-hidden className="size-[18px]" />
              {t("common.accountSecurity")}
            </Link>
          ) : null}
          <form action={signOut}>
            <button type="submit" className="flex h-11 w-full items-center gap-3 rounded-full px-3 text-[14px] font-medium text-text-2 hover:bg-chip hover:text-text">
              <LogOut aria-hidden className="size-[18px]" />
              {t("common.signOut")}
            </button>
          </form>
        </div>
      </div>
    </details>
  );
}
