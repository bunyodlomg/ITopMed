import { LogOut, Menu, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { InstallApp } from "../install-app";
import { AccountMenu } from "./account-menu";
import { MobileTabBar } from "./mobile-tab-bar";
import { NavLinks, type NavGroup, type NavItem } from "./nav-links";
import { Preferences } from "./preferences";
import { Breadcrumb, SIDEBAR_COOKIE, Sidebar } from "./sidebar";

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

/**
 * Workspace chrome. Desktop: a sidebar fixed to the left edge (labelled sections,
 * foldable to icons) and a top bar fixed above the page (where you are, the
 * person's menu); only the page scrolls. Phones and tablets: a sticky header with
 * the full labelled menu (native <details>) and the bottom tab bar.
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
  /** Titled sections of the navigation (items name theirs with `group`). */
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
  const folded = (await cookies()).get(SIDEBAR_COOKIE)?.value === "folded";
  const home = nav[0]?.href ?? "/";

  return (
    <div data-shell data-sidebar={folded ? "folded" : "open"} className="min-h-dvh bg-frame">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-surface focus:px-4 focus:py-2 focus:shadow-pop">
        {t("a11y.skipToContent")}
      </a>

      <Sidebar
        items={nav}
        groups={navGroups}
        label={t("a11y.mainNav")}
        folded={folded}
        foldLabel={t("a11y.foldSidebar")}
        unfoldLabel={t("a11y.unfoldSidebar")}
        brand={
          <Link href={home} className="flex min-w-0 items-center gap-3 rounded-full">
            <Mark />
            <span data-sidebar-text className="min-w-0 leading-tight">
              <span className="block text-[16px] font-bold tracking-[-0.02em]">ITop Med</span>
              <span className="block truncate text-[12px] text-text-3">{context}</span>
            </span>
          </Link>
        }
      />

      <div data-frame className="shell-main">
        {/* Desktop top bar: fixed above the page. */}
        <header data-chrome className="sticky top-0 z-20 hidden h-[84px] items-center gap-4 bg-frame/85 pr-6 pt-3 backdrop-blur-md lg:flex xl:pr-8">
          <div className="min-w-0 flex-1">
            <Breadcrumb items={nav} groups={navGroups} label={t("a11y.breadcrumb")} />
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

        <main id="main" className={primary && primary.length > 1 ? "min-w-0 pb-[calc(56px+env(safe-area-inset-bottom))] lg:pb-0" : "min-w-0"}>
          <div className="mx-auto max-w-[1560px] lg:pr-6 xl:pr-8">
            {banner}
            <div className="page-enter px-4 pb-8 pt-2 sm:px-6 lg:px-0 lg:pb-10 lg:pt-3">{children}</div>
          </div>
        </main>
      </div>
      {primary ? <MobileTabBar items={primary.slice(0, 4)} label={t("a11y.mainNav")} /> : null}
    </div>
  );
}
