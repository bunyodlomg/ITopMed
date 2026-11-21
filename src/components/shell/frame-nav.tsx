"use client";

import { ChevronDown, LockKeyhole, LogOut, Moon, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocale, useTranslations } from "next-intl";
import { setLocaleAction } from "@/app/actions/preferences";
import { LOCALES, LOCALE_NATIVE_NAMES, type Locale } from "@/i18n/config";
import { cx } from "../ui/primitives";
import { Icon } from "./icon";
import type { NavGroup, NavItem } from "./nav-links";

export function isActive(item: NavItem, pathname: string) {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + "/");
}


/**
 * The ink pill behind the current link that slides to the next one on navigation
 * (a segmented control, spring-eased in CSS). Without JS or before hydration the
 * current link keeps its own fill; once placed, the list gets data-pill="on" and
 * the link turns transparent over the pill. The list must be `relative` and its
 * links `relative` (so they paint above the pill) with `data-pill-item`.
 */
function NavPill({ dep }: { dep: string }) {
  const pillRef = useRef<HTMLLIElement>(null);
  const placed = useRef(false);
  useLayoutEffect(() => {
    // The list is the pill's parent (a parent's ref is not attached yet when a child's layout effect runs on mount).
    const pill = pillRef.current;
    const list = pill?.parentElement;
    if (!list || !pill) return;
    const place = (instant: boolean) => {
      const a = list.querySelector<HTMLElement>("[data-pill-item][aria-current]");
      if (!a) {
        pill.removeAttribute("data-on");
        list.removeAttribute("data-pill");
        placed.current = false;
        return;
      }
      if (instant) pill.setAttribute("data-instant", "");
      pill.style.width = `${a.offsetWidth}px`;
      pill.style.height = `${a.offsetHeight}px`;
      pill.style.transform = `translate(${a.offsetLeft}px, ${a.offsetTop}px)`;
      pill.setAttribute("data-on", "");
      list.setAttribute("data-pill", "on");
      if (instant) {
        void pill.offsetWidth; // commit the jump before transitions come back
        pill.removeAttribute("data-instant");
      }
      placed.current = true;
    };
    place(!placed.current);
    const ro = new ResizeObserver(() => place(true));
    ro.observe(list);
    return () => ro.disconnect();
  }, [dep]);
  return <li ref={pillRef} aria-hidden className="nav-pill" />;
}

/** The capsule of primary screens in the top bar; the current one is the ink pill. */
export function TopNav({ items, label }: { items: NavItem[]; label: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="min-w-0">
      {/* Scrolls sideways only if long labels ever outgrow the bar (never clips). */}
      <ul className="scroll-quiet relative flex items-center gap-1 overflow-x-auto rounded-full bg-surface p-1.5 shadow-control">
        <NavPill dep={pathname} />
        {items.map((item) => {
          const active = isActive(item, pathname);
          return (
            <li key={item.href} className="shrink-0">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                data-pill-item
                className={cx(
                  "relative flex h-11 items-center rounded-full px-5 text-[15px] whitespace-nowrap transition-[background-color,color] duration-[var(--dur-quick)] ease-[var(--ease-out)] active:scale-[0.97]",
                  active ? "bg-accent-solid font-semibold text-on-accent" : "font-medium text-text-2 hover:bg-chip hover:text-text",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Icon button of the left rail. The name is its accessible label and appears as a
 * tooltip on hover or keyboard focus. The tooltip is portalled to <body>: the rail
 * is sticky (its own stacking context), so a tooltip inside it would slide under
 * the page. It hides on scroll and on navigation so it never lingers.
 */
export function RailTip({ label, children }: { label: string; children: (on: { onPointerEnter: (e: React.PointerEvent<HTMLElement>) => void; onPointerLeave: () => void; onFocus: (e: React.FocusEvent<HTMLElement>) => void; onBlur: () => void }) => ReactNode }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const pathname = usePathname();
  const [shownOn, setShownOn] = useState(pathname);
  if (shownOn !== pathname) {
    setShownOn(pathname);
    if (at) setAt(null);
  }
  useEffect(() => {
    if (!at) return;
    const hide = () => setAt(null);
    window.addEventListener("scroll", hide, { capture: true, passive: true });
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, { capture: true });
      window.removeEventListener("resize", hide);
    };
  }, [at]);
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setAt({ x: r.right + 12, y: r.top + r.height / 2 });
  };
  return (
    <>
      {children({
        onPointerEnter: (e) => (e.pointerType === "mouse" ? show(e.currentTarget) : undefined),
        onPointerLeave: () => setAt(null),
        onFocus: (e) => (e.currentTarget.matches(":focus-visible") ? show(e.currentTarget) : undefined),
        onBlur: () => setAt(null),
      })}
      {at
        ? createPortal(
            <span
              aria-hidden
              style={{ left: at.x, top: at.y }}
              className="animate-tip pointer-events-none fixed z-[60] -translate-y-1/2 rounded-full bg-accent-solid px-3 py-1.5 text-[13px] font-medium whitespace-nowrap text-on-accent shadow-pop"
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}

/** The group holding the current page (longest matching link wins); else the first group. */
export function activeGroup(items: NavItem[], groups: NavGroup[], pathname: string): string | undefined {
  let best: NavItem | undefined;
  for (const i of items) if (isActive(i, pathname) && (!best || i.href.length > best.href.length)) best = i;
  if (best?.group && groups.some((g) => g.id === best.group)) return best.group;
  // Pages outside the menu (a visit, a receipt…) belong to the section whose base path they share.
  for (const i of [...items].sort((a, b) => b.href.length - a.href.length)) {
    const root = i.href.split("/").slice(0, 4).join("/");
    if (pathname.startsWith(root + "/") && i.group) return i.group;
  }
  return groups.find((g) => items.some((i) => i.group === g.id))?.id;
}

/**
 * Sections mode, top bar: the pages of the section that holds the current page,
 * labelled with icons, the current one as the ink pill.
 */
export function SectionTopNav({ items, groups, label }: { items: NavItem[]; groups: NavGroup[]; label: string }) {
  const pathname = usePathname();
  const gid = activeGroup(items, groups, pathname);
  const group = groups.find((g) => g.id === gid);
  const own = items.filter((i) => i.group === gid);
  return (
    <nav aria-label={group ? `${label}: ${group.label}` : label} className="min-w-0 flex-1">
      <div className="flex h-14 min-w-0 items-center gap-1 rounded-full bg-surface p-1.5 shadow-control">
        {group ? (
          <span className="hidden shrink-0 items-center gap-2 pl-3 pr-3 text-[13px] font-semibold text-text-3 2xl:flex">
            {group.icon ? <Icon name={group.icon} className="size-4" /> : null}
            {group.label}
            <span aria-hidden className="ml-2 h-5 w-px bg-border-strong" />
          </span>
        ) : null}
        <FitPills items={own} pathname={pathname} />
      </div>
    </nav>
  );
}

const pillClass =
  "relative flex h-11 items-center gap-2 rounded-full pl-3.5 pr-4 text-[14.5px] whitespace-nowrap 2xl:gap-2.5 2xl:pl-4 2xl:pr-5 2xl:text-[15px] transition-[background-color,color] duration-[var(--dur-quick)] ease-[var(--ease-out)] active:scale-[0.97]";

/**
 * The section's pages as pills that never scroll sideways: as many as fit the
 * bar are shown (the current page always among them) and the rest wait behind
 * a "More N" pill that drops a menu. Widths are measured from an invisible copy
 * of the row, again whenever the bar changes size.
 */
function FitPills({ items, pathname }: { items: NavItem[]; pathname: string }) {
  const t = useTranslations("common");
  const box = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLUListElement>(null);
  const [fit, setFit] = useState(items.length);
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const activeIndex = items.findIndex((i) => isActive(i, pathname));

  useLayoutEffect(() => {
    const el = box.current;
    const r = ruler.current;
    if (!el || !r) return;
    const measure = () => {
      const widths = Array.from(r.children).map((c) => (c as HTMLElement).offsetWidth);
      const more = widths.pop() ?? 0;
      const gap = 4;
      const room = el.clientWidth;
      const total = widths.reduce((a, w) => a + w + gap, -gap);
      if (total <= room) return setFit(widths.length);
      let used = more;
      let n = 0;
      while (n < widths.length && used + gap + widths[n]! <= room) used += gap + widths[n++]!;
      setFit(Math.max(1, n));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items]);

  // Navigation closes the menu.
  const [seen, setSeen] = useState(pathname);
  if (seen !== pathname) {
    setSeen(pathname);
    if (open) setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menu.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  // The first `fit` pages, with the current page swapped in if it would be hidden.
  let shown = items.slice(0, fit);
  if (activeIndex >= fit) shown = [...items.slice(0, Math.max(0, fit - 1)), items[activeIndex]!];
  const hidden = items.filter((i) => !shown.includes(i));

  const pill = (item: NavItem, measuring = false) => {
    const active = !measuring && isActive(item, pathname);
    return (
      <Link
        href={item.href}
        tabIndex={measuring ? -1 : undefined}
        aria-current={active ? "page" : undefined}
        data-pill-item={measuring ? undefined : true}
        className={cx(pillClass, active ? "bg-accent-solid font-semibold text-on-accent" : "font-medium text-text-2 hover:bg-chip hover:text-text")}
      >
        <Icon name={item.icon} className="size-[18px] shrink-0" />
        {item.label}
      </Link>
    );
  };
  const moreLabel = t("morePages", { count: hidden.length || items.length });

  return (
    <div ref={box} className="relative flex min-w-0 flex-1 items-center">
      {/* Invisible copy of every pill (+ the More pill) for measuring. */}
      <ul ref={ruler} aria-hidden inert className="pointer-events-none invisible absolute left-0 top-0 flex w-max gap-1">
        {items.map((i) => (
          <li key={i.href}>{pill(i, true)}</li>
        ))}
        <li>
          <span className={cx(pillClass, "font-medium")}>
            {t("morePages", { count: items.length })}
            <ChevronDown className="size-4" />
          </span>
        </li>
      </ul>
      <ul className="relative flex min-w-0 items-center gap-1">
        <NavPill dep={`${pathname}|${shown.length}`} />
        {shown.map((item) => (
          <li key={item.href} className="shrink-0">
            {pill(item)}
          </li>
        ))}
      </ul>
      {hidden.length ? (
        <div ref={menu} className="relative ml-1 shrink-0">
          <button
            type="button"
            aria-expanded={open}
            aria-haspopup="true"
            onClick={() => setOpen((v) => !v)}
            className={cx(pillClass, "font-medium", open ? "bg-chip text-text" : "text-text-2 hover:bg-chip hover:text-text")}
          >
            {moreLabel}
            <ChevronDown aria-hidden className={cx("size-4 transition-transform duration-[var(--dur-quick)] ease-[var(--ease-out)]", open && "rotate-180")} />
          </button>
          {open ? (
            <ul className="animate-rise absolute right-0 top-[calc(100%+10px)] z-40 min-w-[240px] space-y-0.5 rounded-[24px] border border-border bg-surface p-2 shadow-pop">
              {hidden.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="flex h-11 items-center gap-3 rounded-full px-3.5 text-[14px] font-medium text-text-2 hover:bg-chip hover:text-text">
                    <Icon name={item.icon} className="size-[18px] shrink-0" />
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Sections mode, rail: one icon per section; it opens the section's first page. */
export function SectionRail({ items, groups, label }: { items: NavItem[]; groups: NavGroup[]; label: string }) {
  const pathname = usePathname();
  const gid = activeGroup(items, groups, pathname);
  const shown = groups.filter((g) => items.some((i) => i.group === g.id));
  return (
    <nav aria-label={label}>
      <ul className="relative flex flex-col items-center gap-1 rounded-full bg-surface p-1.5 shadow-control">
        <NavPill dep={gid ?? ""} />
        {shown.map((g) => {
          const first = items.find((i) => i.group === g.id)!;
          const active = g.id === gid;
          return (
            <li key={g.id}>
              <RailTip label={g.label}>
                {(on) => (
                  <Link
                    href={first.href}
                    aria-label={g.label}
                    aria-current={active ? "true" : undefined}
                    data-pill-item
                    className={cx("relative", railButton(active ? "on" : "idle"))}
                    {...on}
                  >
                    <Icon name={g.icon ?? first.icon} className="size-5" />
                  </Link>
                )}
              </RailTip>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const railBase =
  "grid size-11 place-items-center rounded-full transition-[background-color,color] duration-[var(--dur-quick)] ease-[var(--ease-out)] active:scale-[0.95]";
/** One colour pair per state (two text colours in one class list would fight over CSS order). */
export function railButton(state: "idle" | "on" | "pressed" = "idle") {
  return cx(railBase, state === "on" ? "bg-accent-solid text-on-accent" : state === "pressed" ? "bg-tile text-text" : "text-text-2 hover:bg-chip hover:text-text");
}

/** The rail's capsule of the remaining sections, one thin divider between groups. */
export function RailNav({ items, label }: { items: NavItem[]; label: string }) {
  const pathname = usePathname();
  if (!items.length) return null;
  return (
    <nav aria-label={label} className="flex min-h-0 flex-col">
      <ul className="scroll-quiet flex min-h-0 flex-col items-center gap-1 overflow-y-auto rounded-full bg-surface p-1.5 shadow-control">
        {items.map((item, i) => {
          const active = isActive(item, pathname);
          const newGroup = i > 0 && item.group !== items[i - 1]!.group;
          return (
            <Fragment key={item.href}>
              {newGroup ? <li aria-hidden className="my-1 h-px w-6 shrink-0 bg-border-strong" /> : null}
              <li className="shrink-0">
                <RailTip label={item.label}>
                  {(on) => (
                    <Link
                      href={item.href}
                      aria-label={item.label}
                      aria-current={active ? "page" : undefined}
                      className={railButton(active ? "on" : "idle")}
                      {...on}
                    >
                      <Icon name={item.icon} className="size-5" />
                    </Link>
                  )}
                </RailTip>
              </li>
            </Fragment>
          );
        })}
      </ul>
    </nav>
  );
}

const RAIL_ICONS = { sun: Sun, moon: Moon, security: LockKeyhole, signOut: LogOut } as const;

/** A rail button that submits a form (theme, sign out); works before hydration too. */
export function RailForm({ action, label, icon, field, pressed }: { action: (fd: FormData) => void | Promise<void>; label: string; icon: keyof typeof RAIL_ICONS; field?: { name: string; value: string }; pressed?: boolean }) {
  const I = RAIL_ICONS[icon];
  return (
    <form action={action}>
      {field ? <input type="hidden" name={field.name} value={field.value} /> : null}
      <RailTip label={label}>
        {(on) => (
          <button type="submit" aria-label={label} aria-pressed={pressed} className={railButton(pressed ? "pressed" : "idle")} {...on}>
            <I aria-hidden className="size-5" strokeWidth={1.75} />
          </button>
        )}
      </RailTip>
    </form>
  );
}

/** A rail link with a tooltip (account security). */
export function RailLink({ href, label, icon }: { href: string; label: string; icon: keyof typeof RAIL_ICONS }) {
  const I = RAIL_ICONS[icon];
  const pathname = usePathname();
  const active = pathname === href.split("?")[0];
  return (
    <RailTip label={label}>
      {(on) => (
        <Link href={href} aria-label={label} aria-current={active ? "page" : undefined} className={railButton(active ? "on" : "idle")} {...on}>
          <I aria-hidden className="size-5" strokeWidth={1.75} />
        </Link>
      )}
    </RailTip>
  );
}

/** Short codes on the rail button (each in its own script). */
const LOCALE_CODES: Record<Locale, string> = { "uz-Latn": "UZ", "uz-Cyrl": "ЎЗ", ru: "RU", en: "EN" };

/**
 * Language switch on the rail: a round button with the current language's code;
 * it slides out a capsule of the four languages to its right (the current one in
 * ink). Escape, a click elsewhere or a choice closes it.
 */
export function RailLanguage() {
  const t = useTranslations("common");
  const locale = useLocale() as Locale;
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [pending, start] = useTransition();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!at) return;
    panel.current?.querySelector<HTMLButtonElement>("[aria-pressed=true]")?.focus();
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
        setAt(null);
        button.current?.focus();
        return;
      }
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setAt(null);
    };
    const hide = () => setAt(null);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
      window.removeEventListener("resize", hide);
    };
  }, [at]);

  const toggle = () => {
    if (at) return setAt(null);
    const r = button.current!.getBoundingClientRect();
    setAt({ x: r.right + 14, y: r.top + r.height / 2 });
  };
  const choose = (l: Locale) => {
    setAt(null);
    if (l === locale) return;
    const fd = new FormData();
    fd.set("locale", l);
    start(() => setLocaleAction(fd));
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-label={`${t("language")}: ${LOCALE_NATIVE_NAMES[locale]}`}
        aria-expanded={!!at}
        aria-controls={at ? id : undefined}
        aria-busy={pending}
        className={cx(railButton(at ? "pressed" : "idle"), "text-[13px] font-bold tracking-[0.02em]", pending && "animate-pulse")}
      >
        {LOCALE_CODES[locale]}
      </button>
      {at
        ? createPortal(
            <div
              ref={panel}
              id={id}
              role="group"
              aria-label={t("language")}
              style={{ left: at.x, top: at.y }}
              className="animate-tip fixed z-[60] flex -translate-y-1/2 gap-1 rounded-full bg-surface p-1.5 shadow-pop"
            >
              {LOCALES.map((l) => {
                const on = l === locale;
                return (
                  <button
                    key={l}
                    type="button"
                    lang={l}
                    aria-pressed={on}
                    onClick={() => choose(l)}
                    className={cx(
                      "flex h-11 items-center gap-2 rounded-full pl-2 pr-4 text-[14px] whitespace-nowrap transition-[background-color,color] duration-[var(--dur-quick)] ease-[var(--ease-out)] active:scale-[0.97]",
                      on ? "bg-accent-solid font-semibold text-on-accent shadow-ink" : "font-medium text-text-2 hover:bg-chip hover:text-text",
                    )}
                  >
                    <span aria-hidden className={cx("grid size-7 place-items-center rounded-full text-[11px] font-bold", on ? "bg-white/15" : "bg-tile")}>
                      {LOCALE_CODES[l]}
                    </span>
                    {LOCALE_NATIVE_NAMES[l]}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
