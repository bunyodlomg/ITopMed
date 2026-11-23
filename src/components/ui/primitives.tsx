import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { CountUp } from "./count-up";

/** Minimal className joiner (no runtime dependency). */
export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

// Labels stay on one line when there is room and wrap (never overflow) on narrow screens.
const base =
  "inline-flex max-w-full items-center justify-center gap-2 text-center leading-tight rounded-full font-semibold transition-[background-color,border-color,box-shadow,color,transform] duration-[var(--dur-quick)] ease-[var(--ease-out)] active:scale-[0.97] active:duration-[var(--dur-press)] disabled:pointer-events-none disabled:opacity-50 select-none";
const variants: Record<Variant, string> = {
  primary: "bg-accent-solid text-on-accent shadow-ink hover:bg-accent-solid-hover",
  // A translucent grey pill: reads the same on a white card and on the grey frame.
  secondary: "bg-chip text-text hover:bg-chip-hover",
  ghost: "text-text-2 hover:bg-chip hover:text-text",
  danger: "bg-danger-solid text-white shadow-control hover:opacity-90",
};
const sizes: Record<Size, string> = {
  sm: "min-h-9 px-3.5 py-1 text-[13px]",
  md: "min-h-11 px-5 py-2 text-[14.5px]",
  lg: "min-h-12 px-7 py-2.5 text-[15.5px]",
};

export function buttonClass(variant: Variant = "primary", size: Size = "md", extra?: string) {
  return cx(base, variants[variant], sizes[size], extra);
}

export function Button({ variant = "primary", size = "md", className, ...rest }: ComponentProps<"button"> & { variant?: Variant; size?: Size }) {
  return <button className={buttonClass(variant, size, className)} {...rest} />;
}

export function ButtonLink({ variant = "primary", size = "md", className, ...rest }: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link className={buttonClass(variant, size, className)} {...rest} />;
}

export function Card({ className, children, ...rest }: ComponentProps<"section">) {
  return (
    // min-w-0: as a grid/flex child a card must never grow to its content's width
    // (a wide table scrolls inside the card instead of widening the page).
    <section className={cx("min-w-0 rounded-[var(--radius-card)] bg-surface shadow-card", className)} {...rest}>
      {children}
    </section>
  );
}

export function CardHeader({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    // No divider: the title leads by size and weight; the content follows on the same white.
    <div className="flex flex-wrap items-start justify-between gap-3 px-5 pb-1 pt-5 sm:px-6">
      <div className="min-w-0">
        <h2 className="text-balance text-[18px] font-semibold tracking-[-0.02em]">{title}</h2>
        {description ? <p className="mt-1 text-pretty text-[13.5px] text-text-3">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("px-5 py-5 sm:px-6", className)}>{children}</div>;
}

export function PageHeader({ title, description, action, eyebrow, count }: { title: ReactNode; description?: ReactNode; action?: ReactNode; eyebrow?: ReactNode; /** How many records the list holds, shown quietly after the title. */ count?: number }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4 sm:mb-8">
      <div className="min-w-0 max-w-3xl">
        {eyebrow ? <p className="mb-2 text-[13.5px] font-medium text-text-3">{eyebrow}</p> : null}
        {/* Large but not heavy: size and tight tracking carry the title, weight stays calm. */}
        <h1 className="text-balance text-[28px] font-semibold leading-[1.1] tracking-[-0.035em] [overflow-wrap:anywhere] sm:text-[34px] xl:text-[38px]">
          {title}
          {count !== undefined ? <>{" "}<span className="ml-1.5 align-middle text-[0.55em] font-medium tracking-normal text-text-3 tabular-nums">{count}</span></> : null}
        </h1>
        {description ? <p className="mt-2.5 text-pretty text-[15.5px] leading-relaxed text-text-2">{description}</p> : null}
      </div>
      {/* Wraps on narrow screens instead of pushing the page wider than the phone. */}
      {action ? <div className="flex min-w-0 max-w-full flex-wrap gap-2">{action}</div> : null}
    </header>
  );
}

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";
const tones: Record<Tone, string> = {
  neutral: "bg-sunken text-text-2",
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

const dotTones: Record<Tone, string> = {
  neutral: "text-text-2",
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

/** Status: a coloured dot and the word, no box (quiet in tables, still unmistakable). */
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-[13px] font-medium leading-5", dotTones[tone])}>
      <span aria-hidden className={cx("size-[7px] shrink-0 rounded-full bg-current", tone === "neutral" && "opacity-60")} />
      {children}
    </span>
  );
}

export const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: "success",
  ACCEPTED: "success",
  APPROVED: "success",
  COMPLETED: "success",
  SIGNED: "success",
  BOOKED: "accent",
  OPEN: "accent",
  IN_PROGRESS: "accent",
  CHECKED_IN: "warning",
  NO_SHOW: "danger",
  CANCELLED: "neutral",
  CLOSED: "neutral",
  DRAFT: "neutral",
  RESOLVED: "neutral",
  ENTERED_IN_ERROR: "neutral",
  ORDERED: "accent",
  COLLECTED: "warning",
  RESULTED: "warning",
  VERIFIED: "success",
  ISSUED: "danger",
  PARTIALLY_PAID: "warning",
  PAID: "success",
  VOID: "neutral",
  REQUESTED: "accent",
  SUCCESS: "success",
  TRIAL: "accent",
  TRIALING: "accent",
  PENDING: "accent",
  INVITED: "accent",
  PROVISIONING: "neutral",
  SUSPENDED: "warning",
  PAST_DUE: "warning",
  EXPIRED: "neutral",
  ARCHIVED: "neutral",
  REVOKED: "neutral",
  CANCELED: "neutral",
  DISABLED: "neutral",
  REMOVED: "neutral",
  DENIED: "danger",
  FAILURE: "danger",
};

export function Alert({ tone = "accent", title, children }: { tone?: Tone; title?: ReactNode; children?: ReactNode }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx("rounded-[16px] px-4 py-3 text-[14px] leading-relaxed", tones[tone])}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={title ? "mt-0.5" : undefined}>{children}</div> : null}
    </div>
  );
}

export function EmptyState({ title, description, action, icon }: { title: ReactNode; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center sm:py-16">
      {icon ? (
        // A white tile on a hatched disc: the same pattern as the charts, so empty reads as "nothing yet", not "broken".
        <div aria-hidden className="hatch-track mb-5 grid size-24 place-items-center rounded-full">
          <div className="grid size-14 place-items-center rounded-[18px] bg-surface text-text-2 shadow-raise [&_svg]:size-6">{icon}</div>
        </div>
      ) : null}
      <p className="text-balance text-[16px] font-semibold tracking-[-0.01em]">{title}</p>
      {description ? <p className="mt-1.5 max-w-md text-pretty text-[14px] leading-relaxed text-text-2">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/** A change against the previous period: green up / red down chip (the arrow carries meaning, not only the colour). */
export function Delta({ value, direction }: { value: ReactNode; direction: "up" | "down" | "flat" }) {
  const tone = direction === "up" ? "bg-success-soft text-success" : direction === "down" ? "bg-danger-soft text-danger" : "bg-chip text-text-2";
  return (
    <span className={cx("inline-flex items-center gap-0.5 rounded-[8px] px-1.5 py-0.5 text-[12px] font-semibold tabular-nums", tone)}>
      <span aria-hidden>{direction === "up" ? "\u2191" : direction === "down" ? "\u2193" : "\u2192"}</span>
      {value}
    </span>
  );
}

/**
 * A figure. `card` stands on the frame (white), `inset` sits inside a card (grey
 * tile), `hero` is the one blue panel per screen.
 */
export function Stat({
  label,
  value,
  hint,
  icon,
  delta,
  variant = "card",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  delta?: ReactNode;
  variant?: "card" | "inset" | "hero";
  className?: string;
}) {
  const shell = variant === "hero" ? "bg-hero rounded-[var(--radius-tile)] shadow-hero" : variant === "inset" ? "bg-tile rounded-[var(--radius-tile)]" : "bg-surface rounded-[var(--radius-card)] shadow-card";
  const iconShell = variant === "hero" ? "bg-white/20 text-on-hero" : variant === "inset" ? "bg-surface text-text-2" : "bg-tile text-text-2";
  const meta = variant === "hero" ? "text-on-hero" : "text-text-3";
  return (
    <div className={cx("@container flex min-w-0 flex-col p-4 sm:p-5", shell, className)}>
      <div className="flex items-start justify-between gap-2">
        <p className={cx("min-w-0 pt-1 text-[13.5px] font-medium", variant === "hero" ? "text-on-hero" : "text-text-2")}>{label}</p>
        {icon ? <span className={cx("grid size-9 shrink-0 place-items-center rounded-full [&_svg]:size-4", iconShell)}>{icon}</span> : null}
      </div>
      {/* Size follows the tile width, so large sums never leave it; the currency may wrap below the digits. */}
      <p className="mt-auto pt-4 text-[clamp(1.25rem,13cqi,2.25rem)] font-semibold leading-[1.1] tracking-[-0.035em] tabular-nums [overflow-wrap:anywhere]">{typeof value === "string" || typeof value === "number" ? <CountUp value={String(value)} /> : value}</p>
      {delta || hint ? (
        <div className={cx("mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]", meta)}>
          {delta}
          {hint ? <span className="min-w-0">{hint}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Loading placeholder block (sized by the caller); calm pulse, still under reduced motion. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cx("skeleton block", className)} />;
}

/** Responsive table: scrolls horizontally inside its card on narrow screens. */
/**
 * Data table. On phones (`phone="cards"`, the default) every row becomes a compact
 * card — first cell as the title, the other cells wrapping below it — so nothing
 * needs sideways scrolling. Use `phone="scroll"` where columns only make sense
 * side by side (e.g. a matrix).
 */
export function Table({ children, caption, phone = "cards" }: { children: ReactNode; caption?: string; phone?: "cards" | "scroll" }) {
  return (
    // Focusable so keyboard users can scroll wide tables on narrow screens (WCAG 2.1.1).
    // Sits in a quiet rounded well inside its card: grey head, white rows.
    <div className="mx-3 mb-3 mt-2 overflow-x-auto rounded-[var(--radius-tile)] border border-border sm:mx-4 sm:mb-4" tabIndex={0} role={caption ? "region" : undefined} aria-label={caption}>
      <table className={cx("w-full border-collapse text-left text-[14px] tabular-nums [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-surface-2", phone === "cards" ? "table-cards sm:min-w-[640px]" : "min-w-[640px]")}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th scope="col" className={cx("border-b border-border bg-tile px-4 py-3 text-[13px] font-medium text-text-3 first:pl-5", className)}>
      {children}
    </th>
  );
}

/** `label`: shown before the value only in the phone card layout, for cells that are ambiguous without their column header (e.g. two amounts). */
export function Td({ children, className, label }: { children?: ReactNode; className?: string; label?: string }) {
  return (
    <td data-label={label} className={cx("border-b border-border px-4 py-3.5 align-middle first:pl-5 [tr:last-child>&]:border-b-0", className)}>
      {children}
    </td>
  );
}

export function DescriptionList({ items }: { items: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
      {items.map((it, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-[12px] font-medium uppercase tracking-[0.04em] text-text-3">{it.label}</dt>
          <dd className="mt-1 break-words text-[14px]">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
