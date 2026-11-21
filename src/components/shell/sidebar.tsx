"use client";

import { ChevronDown, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { cx } from "../ui/primitives";
import { RailTip, isActive } from "./rail-tip";
import { Icon } from "./icon";
import type { NavGroup, NavItem } from "./nav-links";

/** Cookie that remembers the folded sidebar (read on the server, so no flash on load). */
export const SIDEBAR_COOKIE = "itm_sidebar";

/** The most specific menu link for the current path (so "/c/x" does not light up on "/c/x/patients"). */
function currentHref(items: NavItem[], pathname: string): string | undefined {
  let best: NavItem | undefined;
  for (const i of items) if (isActive(i, pathname) && (!best || i.href.length > best.href.length)) best = i;
  return best?.href;
}

/** The section holding the current page; none on ungrouped pages (the dashboard) or pages outside the menu. */
function sectionOf(items: NavItem[], groups: NavGroup[], pathname: string): string | undefined {
  const href = currentHref(items, pathname);
  const g = items.find((i) => i.href === href)?.group;
  return g && groups.some((x) => x.id === g) ? g : undefined;
}

const linkBase =
  "flex items-center rounded-full text-[14px] transition-[background-color,color] duration-[var(--dur-quick)] ease-[var(--ease-out)] active:scale-[0.98]";

function stateClass(active: boolean) {
  return active ? "bg-accent-solid font-semibold text-on-accent shadow-ink" : "font-medium text-text-2 hover:bg-chip hover:text-text";
}

/** One section of the expanded menu: a heading that folds open, its pages under a guide line. */
function Section({ group, items, current, holds }: { group: NavGroup; items: NavItem[]; current?: string; holds: boolean }) {
  // Opens by itself when navigation lands inside it; the person can still fold it.
  const [open, setOpen] = useState(holds);
  const [seen, setSeen] = useState(holds);
  if (seen !== holds) {
    setSeen(holds);
    if (holds) setOpen(true);
  }
  const id = `sb-${group.id}`;
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className={cx(linkBase, "h-10 w-full gap-3 px-3", holds ? "font-semibold text-text" : "font-medium text-text-2 hover:bg-chip hover:text-text")}
      >
        <Icon name={group.icon ?? items[0]!.icon} className="size-[18px] shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
        <ChevronDown aria-hidden className={cx("size-4 shrink-0 text-text-3 transition-transform duration-[var(--dur-quick)] ease-[var(--ease-out)]", open && "rotate-180")} />
      </button>
      {open ? (
        <ul id={id} className="animate-rise ml-[21px] mt-0.5 space-y-0.5 border-l border-border-strong pb-1 pl-2.5">
          {items.map((item) => {
            const active = item.href === current;
            return (
              <li key={item.href}>
                <Link href={item.href} aria-current={active ? "page" : undefined} className={cx(linkBase, "h-9 px-3", stateClass(active))}>
                  <span className="truncate">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Desktop sidebar, fixed to the left edge. Expanded (248px): labelled links and
 * folding sections. Folded (76px): one icon per link or section, with tooltips.
 * The fold is stored in a cookie and mirrored on the shell's `data-sidebar`
 * attribute, which the page padding follows in CSS.
 */
export function Sidebar({
  items,
  groups = [],
  label,
  brand,
  folded: initialFolded,
  foldLabel,
  unfoldLabel,
}: {
  items: NavItem[];
  groups?: NavGroup[];
  label: string;
  /** Logo + clinic name; its [data-sidebar-text] part hides while folded (CSS). */
  brand: ReactNode;
  folded: boolean;
  foldLabel: string;
  unfoldLabel: string;
}) {
  const pathname = usePathname();
  const [folded, setFolded] = useState(initialFolded);
  const current = currentHref(items, pathname);
  const gid = sectionOf(items, groups, pathname);
  const known = new Set(groups.map((g) => g.id));
  const loose = items.filter((i) => !i.group || !known.has(i.group));
  const shown = groups.map((g) => ({ group: g, own: items.filter((i) => i.group === g.id) })).filter((s) => s.own.length);

  const toggle = () => {
    const next = !folded;
    setFolded(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "folded" : "open"}; path=/; max-age=31536000; samesite=lax`;
    document.querySelector("[data-shell]")?.setAttribute("data-sidebar", next ? "folded" : "open");
  };

  const iconLink = (href: string, text: string, icon: NavItem["icon"], active: boolean, page: boolean) => (
    <RailTip label={text}>
      {(on) => (
        <Link href={href} aria-label={text} aria-current={active ? (page ? "page" : "true") : undefined} className={cx(linkBase, "size-11 justify-center", stateClass(active))} {...on}>
          <Icon name={icon} className="size-5" />
        </Link>
      )}
    </RailTip>
  );

  return (
    <aside
      data-chrome
      className={cx(
        "fixed bottom-3 left-3 top-3 z-30 hidden flex-col rounded-[28px] bg-surface shadow-card transition-[width] duration-[var(--dur-quick)] ease-[var(--ease-out)] lg:flex",
        folded ? "w-[76px] items-center" : "w-[248px]",
      )}
    >
      <div className={cx("flex h-[72px] shrink-0 items-center", folded ? "justify-center" : "px-4")}>{brand}</div>

      <nav aria-label={label} className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <ul className={cx("space-y-1", folded && "flex flex-col items-center")}>
          {loose.map((item) => (
            <li key={item.href}>
              {folded ? (
                iconLink(item.href, item.label, item.icon, item.href === current, true)
              ) : (
                <Link href={item.href} aria-current={item.href === current ? "page" : undefined} className={cx(linkBase, "h-10 gap-3 px-3", stateClass(item.href === current))}>
                  <Icon name={item.icon} className="size-[18px] shrink-0" />
                  <span className="truncate">{item.label}</span>
                </Link>
              )}
            </li>
          ))}
          {loose.length && shown.length ? <li aria-hidden className={cx("my-2 h-px bg-border", folded ? "w-8" : "mx-3")} /> : null}
          {shown.map(({ group, own }) => {
            const holds = group.id === gid;
            if (folded) {
              const target = own.find((i) => i.href === current) ?? own[0]!;
              return <li key={group.id}>{iconLink(target.href, group.label, group.icon ?? own[0]!.icon, holds, own.length === 1)}</li>;
            }
            if (own.length === 1) {
              const item = own[0]!;
              return (
                <li key={group.id}>
                  <Link href={item.href} aria-current={item.href === current ? "page" : undefined} className={cx(linkBase, "h-10 gap-3 px-3", stateClass(item.href === current))}>
                    <Icon name={group.icon ?? item.icon} className="size-[18px] shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </Link>
                </li>
              );
            }
            return <Section key={group.id} group={group} items={own} current={current} holds={holds} />;
          })}
        </ul>
      </nav>

      <div className={cx("shrink-0 border-t border-border p-3", folded && "flex justify-center")}>
        <RailTip label={folded ? unfoldLabel : foldLabel}>
          {(on) => (
            <button
              type="button"
              onClick={toggle}
              aria-label={folded ? unfoldLabel : foldLabel}
              aria-pressed={folded}
              className={cx(linkBase, folded ? "size-11 justify-center" : "h-10 w-full gap-3 px-3", "font-medium text-text-2 hover:bg-chip hover:text-text")}
              {...(folded ? on : {})}
            >
              {folded ? <PanelLeftOpen aria-hidden className="size-5" strokeWidth={1.75} /> : <PanelLeftClose aria-hidden className="size-[18px]" strokeWidth={1.75} />}
              {folded ? null : <span className="truncate">{foldLabel}</span>}
            </button>
          )}
        </RailTip>
      </div>
    </aside>
  );
}

/** "Section › Page" for the fixed top bar; pages outside the menu show their section. */
export function Breadcrumb({ items, groups = [], label }: { items: NavItem[]; groups?: NavGroup[]; label: string }) {
  const pathname = usePathname();
  const href = currentHref(items, pathname);
  const item = items.find((i) => i.href === href);
  const gid = sectionOf(items, groups, pathname);
  const group = groups.find((g) => g.id === gid);
  const own = group ? items.filter((i) => i.group === group.id) : [];
  // A single-page section reads as just the page; a sub-page (a visit, a receipt) keeps its section link.
  const crumbs: { text: string; href?: string }[] = [];
  if (group && own.length > 1 && group.label !== item?.label) crumbs.push({ text: group.label, href: item && pathname === item.href ? undefined : own[0]!.href });
  if (item) crumbs.push({ text: item.label, href: pathname === item.href ? undefined : item.href });
  if (!crumbs.length) return null;
  return (
    <nav aria-label={label} className="min-w-0">
      <ol className="flex min-w-0 items-center gap-2 text-[14px]">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={i} className={cx("flex min-w-0 items-center gap-2", !last && "shrink-0")}>
              {i > 0 ? <span aria-hidden className="text-text-3">/</span> : null}
              {c.href ? (
                <Link href={c.href} className="truncate font-medium text-text-2 hover:text-text">
                  {c.text}
                </Link>
              ) : (
                <span aria-current={last ? "page" : undefined} className={cx("truncate", last ? "font-semibold text-text" : "font-medium text-text-2")}>
                  {c.text}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
