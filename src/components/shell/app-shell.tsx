import { LogOut, Menu, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { setThemeAction } from "@/app/actions/preferences";
import { InstallApp } from "../install-app";
import { AccountMenu } from "./account-menu";
import { RailForm, RailLink, RailNav, SectionRail, SectionTopNav, TopNav } from "./frame-nav";
import { MobileTabBar } from "./mobile-tab-bar";
import { NavLinks, type NavGroup, type NavItem } from "./nav-links";
import { Preferences } from "./preferences";
import { cx } from "../ui/primitives";

export async function currentTheme(): Promise<"light" | "dark" | "system"> {
  const v = (await cookies()).get("itm_theme")?.value;
  return v === "light" || v === "dark" ? v : "system";
}

function Mark({ className = "size-10" }: { className?: string }) {
  return (
    <span aria-hidden className={`grid shrink-0 place-items-center rounded-full bg-hero shadow-hero ${className}`}>
      <svg viewBox="0 0 24 24" className="size-[55%]" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </span>
  );
}

function Brand({ context }: { context: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Mark />
      <div className="min-w-0 leading-tight">
        <p className="text-[16px] font-bold tracking-[-0.02em]">ITop Med</p>
        <p className="truncate text-[12px] text-text-3">{context}</p>
      </div>
    </div>
  );
}

/** At most this many screens fit the top capsule; the rest go to the icon rail. */
const TOP_MAX = 6;

/**
 * Workspace chrome. Desktop: one large rounded frame on the grey ground — top bar
 * (brand, the primary screens as a capsule with the current one as the ink pill,
 * the person's chip) and a left rail of capsules (appearance, the remaining
 * sections as icons with tooltips, security + sign out). Phones and tablets: a
 * header with the full labelled menu (native <details>) and the bottom tab bar.
 */
export async function AppShell({
  context,
  nav,
  navGroups,
  user,
  signOut,
  securityHref,
  children,
  banner,
  primary,
}: {
  context: string;
  nav: NavItem[];
  /** Titled sections of the navigation (items name theirs with `group`); used by the phone menu. */
  navGroups?: NavGroup[];
  user: { name: string; detail: string };
  signOut: () => Promise<void>;
  /** Account security page (password). */
  securityHref?: string;
  children: ReactNode;
  banner?: ReactNode;
  /** Up to 4 primary screens for the phone/tablet bottom bar. */
  primary?: NavItem[];
}) {
  const t = await getTranslations();
  const theme = await currentTheme();
  // Sections mode: every group has a rail icon → the rail lists sections and the
  // top bar the pages of the current one. Otherwise: first screens on top, rest in the rail.
  const sections = !!navGroups?.length && navGroups.every((g) => g.icon);
  const top = nav.length <= TOP_MAX ? nav : nav.slice(0, TOP_MAX - 1);
  const rail = nav.slice(top.length);

  return (
    // Desktop: an app-like frame of exactly one screen. The top bar and the rail never move;
    // only the page area (main) scrolls. Phones keep the normal page scroll.
    <div data-shell-root className="min-h-dvh lg:relative lg:h-dvh lg:overflow-hidden lg:p-3 xl:p-4">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-surface focus:px-4 focus:py-2 focus:shadow-pop">
        {t("a11y.skipToContent")}
      </a>

      <div data-frame className="mx-auto min-h-dvh max-w-[1680px] bg-frame lg:flex lg:h-full lg:min-h-0 lg:flex-col lg:rounded-[40px] lg:bg-frame lg:px-6 lg:pt-5 xl:px-8">
        {/* Desktop top bar */}
        <header data-chrome className="hidden shrink-0 items-center gap-3 lg:flex">
          <Link href={nav[0]?.href ?? "/"} className="flex h-14 min-w-0 shrink-0 items-center gap-3 rounded-full bg-surface py-2 pl-2 pr-2 shadow-control xl:max-w-[260px] xl:pr-5">
            <Mark />
            <span className="hidden min-w-0 leading-tight xl:block">
              <span className="block text-[16px] font-bold tracking-[-0.02em]">ITop Med</span>
              <span className="block truncate text-[12px] text-text-3">{context}</span>
            </span>
            <span className="sr-only xl:hidden">ITop Med · {context}</span>
          </Link>
          <div className="flex min-w-0 flex-1">
            {sections ? <SectionTopNav items={nav} groups={navGroups!} label={t("a11y.mainNav")} /> : <TopNav items={top} label={t("a11y.mainNav")} />}
          </div>
          <AccountMenu name={user.name} detail={user.detail} signOut={signOut} securityHref={securityHref} theme={theme} />
        </header>

        {/* Phone / tablet header */}
        <details data-chrome className="group sticky top-0 z-30 bg-frame lg:hidden">
          <summary className="flex h-16 cursor-pointer list-none items-center justify-between gap-3 px-4 [&::-webkit-details-marker]:hidden">
            <Brand context={context} />
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-surface text-text-2 shadow-control group-open:bg-accent-solid group-open:text-on-accent">
              <Menu aria-hidden className="size-5" />
              <span className="sr-only">{t("a11y.openMenu")}</span>
            </span>
          </summary>
          <div className="animate-drop max-h-[calc(100dvh-4rem)] space-y-4 overflow-y-auto border-t border-border px-4 pb-5 pt-4">
            <NavLinks items={nav} groups={navGroups} label={t("a11y.mainNav")} />
            <div className="space-y-2.5 rounded-[24px] bg-surface p-3">
              <InstallApp />
              <Preferences theme={theme} />
              <div className="flex items-center gap-2 px-1 pt-1">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold">{user.name}</p>
                  <p className="truncate text-[12px] text-text-3">{user.detail}</p>
                </div>
                {securityHref ? (
                  <Link href={securityHref} aria-label={t("common.accountSecurity")} className="grid size-11 shrink-0 place-items-center rounded-full bg-tile text-text-2 hover:text-text">
                    <ShieldCheck aria-hidden className="size-[18px]" />
                  </Link>
                ) : null}
                <form action={signOut}>
                  <button type="submit" aria-label={t("common.signOut")} className="grid size-11 place-items-center rounded-full bg-tile text-text-2 hover:text-text">
                    <LogOut aria-hidden className="size-[18px]" />
                  </button>
                </form>
              </div>
            </div>
          </div>
        </details>

        <div className="lg:mt-6 lg:flex lg:min-h-0 lg:flex-1 lg:gap-6 xl:gap-8">
          {/* Desktop rail */}
          <aside data-chrome className="hidden w-14 shrink-0 flex-col items-center justify-between gap-3 pb-6 lg:flex">
            <div className="flex flex-col gap-1 rounded-full bg-surface p-1.5 shadow-control">
              <RailForm action={setThemeAction} label={t("common.themeLight")} icon="sun" field={{ name: "theme", value: "light" }} pressed={theme === "light"} />
              <RailForm action={setThemeAction} label={t("common.themeDark")} icon="moon" field={{ name: "theme", value: "dark" }} pressed={theme === "dark"} />
            </div>
            <div className="flex min-h-0 flex-1 flex-col justify-center">
              {sections ? <SectionRail items={nav} groups={navGroups!} label={t("a11y.sectionsNav")} /> : <RailNav items={rail} label={t("a11y.sectionsNav")} />}
            </div>
            <div className="flex flex-col gap-1 rounded-full bg-surface p-1.5 shadow-control">
              {securityHref ? <RailLink href={securityHref} label={t("common.accountSecurity")} icon="security" /> : null}
              <RailForm action={signOut} label={t("common.signOut")} icon="signOut" />
            </div>
          </aside>

          {/* The only scrolling area on desktop (side padding keeps card shadows from being clipped). */}
          <main id="main" data-scroll-root className={cx("min-w-0 flex-1 lg:relative lg:-mx-4 lg:overflow-y-auto lg:px-4 lg:[scrollbar-gutter:stable]", primary && primary.length > 1 && "pb-[calc(56px+env(safe-area-inset-bottom))] lg:pb-0")}>
            {banner}
            <div className="page-enter px-4 pb-8 pt-2 sm:px-6 lg:px-0 lg:pb-10 lg:pt-1">{children}</div>
          </main>
        </div>
      </div>
      {primary ? <MobileTabBar items={primary.slice(0, 4)} label={t("a11y.mainNav")} /> : null}
    </div>
  );
}
