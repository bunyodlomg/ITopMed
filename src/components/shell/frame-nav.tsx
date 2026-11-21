"use client";

import { LockKeyhole, LogOut, Moon, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
        <ul className="scroll-quiet relative flex min-w-0 items-center gap-1 overflow-x-auto">
          <NavPill dep={pathname} />
          {own.map((item) => {
            const active = isActive(item, pathname);
            return (
              <li key={item.href} className="shrink-0">
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  data-pill-item
                  className={cx(
                    "relative flex h-11 items-center gap-2 rounded-full pl-3.5 pr-4 text-[14.5px] whitespace-nowrap 2xl:gap-2.5 2xl:pl-4 2xl:pr-5 2xl:text-[15px] transition-[background-color,color] duration-[var(--dur-quick)] ease-[var(--ease-out)] active:scale-[0.97]",
                    active ? "bg-accent-solid font-semibold text-on-accent" : "font-medium text-text-2 hover:bg-chip hover:text-text",
                  )}
                >
                  <Icon name={item.icon} className="size-[18px] shrink-0" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
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
