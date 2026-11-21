import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "./primitives";

type Params = Record<string, string | string[] | undefined>;

/**
 * The page URL with some params changed (`undefined` removes one). Lists keep
 * their search, filters and open drawer in the URL, so every state is linkable.
 */
export function hrefWith(path: string, current: Params, changes: Record<string, string | undefined>): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) if (typeof v === "string" && v) next.set(k, v);
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined || v === "") next.delete(k);
    else next.set(k, v);
  }
  const qs = next.toString();
  return qs ? `${path}?${qs}` : path;
}

export interface Chip {
  label: string;
  href: string;
  active: boolean;
  count?: number;
}

/** Quick filters of a list: one row of pills, the chosen one in ink. Scrolls sideways on a phone. */
export function FilterChips({ chips, label }: { chips: Chip[]; label: string }) {
  if (chips.length < 2) return null;
  return (
    <nav aria-label={label} className="scroll-quiet overflow-x-auto">
      <ul className="flex w-max gap-1.5 p-0.5">
        {chips.map((c) => (
          <li key={c.href}>
            <Link
              href={c.href}
              scroll={false}
              aria-current={c.active ? "true" : undefined}
              className={cx(
                "flex h-9 items-center gap-2 rounded-full px-4 text-[13.5px] whitespace-nowrap transition-[background-color,color] duration-[var(--dur-quick)] ease-[var(--ease-out)]",
                c.active ? "bg-accent-solid font-semibold text-on-accent shadow-ink" : "bg-surface font-medium text-text-2 shadow-control hover:text-text",
              )}
            >
              {c.label}
              {c.count !== undefined ? <span className={cx("tabular-nums", c.active ? "opacity-80" : "text-text-3")}>{c.count}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Search on the left, the page's secondary actions on the right; filters under them. */
export function Toolbar({ search, actions, filters }: { search?: ReactNode; actions?: ReactNode; filters?: ReactNode }) {
  return (
    <div className="mb-4 space-y-3">
      {search || actions ? (
        <div className="flex flex-wrap items-center gap-2">
          {search}
          {actions ? <div className="flex min-w-0 flex-wrap gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {filters}
    </div>
  );
}
