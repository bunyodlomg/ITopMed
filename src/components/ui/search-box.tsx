"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { cx } from "./primitives";

/**
 * Search field of a list page. It is a plain GET form (works without
 * JavaScript, Enter submits); with JavaScript the list follows the typing after
 * a short pause. The query lives in the URL (`?q=`), next to the filters.
 */
export function SearchBox({ placeholder, label, clearLabel, param = "q", minLength = 0, autoFocus }: { placeholder: string; label: string; clearLabel: string; param?: string; minLength?: number; autoFocus?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const initial = params.get(param) ?? "";
  const [value, setValue] = useState(initial);
  const [pending, startTransition] = useTransition();
  const last = useRef(initial);

  useEffect(() => {
    const v = value.trim();
    if (v === last.current.trim() || (v.length > 0 && v.length < minLength)) return;
    const id = setTimeout(() => {
      last.current = v;
      const next = new URLSearchParams(params.toString());
      if (v) next.set(param, v);
      else next.delete(param);
      next.delete("page");
      const qs = next.toString();
      startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
    }, 300);
    return () => clearTimeout(id);
  }, [value, minLength, param, params, pathname, router]);

  // Other params (the filters) ride along when the form is submitted without JS.
  const hidden = [...params.entries()].filter(([k]) => k !== param && k !== "page");

  return (
    <form role="search" className="relative min-w-0 flex-1" onSubmit={(e) => e.preventDefault()} action={pathname}>
      {hidden.map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <label className="block">
        <span className="sr-only">{label}</span>
        <Search aria-hidden className={cx("pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-text-3", pending && "animate-pulse")} />
        <input
          name={param}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          className="h-12 w-full rounded-full border border-border bg-surface pl-11 pr-11 text-[15px] shadow-control placeholder:text-text-3 focus:border-accent focus:outline-none focus:ring-4 focus:ring-[var(--focus)]"
        />
      </label>
      {value ? (
        <button type="button" onClick={() => setValue("")} aria-label={clearLabel} className="absolute right-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full text-text-3 hover:bg-chip hover:text-text">
          <X aria-hidden className="size-4" />
        </button>
      ) : null}
    </form>
  );
}
