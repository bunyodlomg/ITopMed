"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { NavItem } from "./nav-links";

export function isActive(item: NavItem, pathname: string) {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + "/");
}

/**
 * Tooltip for an icon-only control of the sidebar. The name is its accessible label and appears as a
 * tooltip on hover or keyboard focus. The tooltip is portalled to <body>: the sidebar
 * is fixed (its own stacking context), so a tooltip inside it would be clipped. It hides on scroll and on navigation so it never lingers.
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
