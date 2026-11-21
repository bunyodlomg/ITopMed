import { getTranslations } from "next-intl/server";
import { AppShell } from "@/components/shell/app-shell";
import type { NavItem } from "@/components/shell/nav-links";
import { requirePatient } from "@/server/portal/guards";
import { portalLogoutAction } from "../../../portal-actions";

export default async function PortalLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const p = await requirePatient(slug);
  const t = await getTranslations();
  const base = `/p/${p.tenant.slug}`;
  const nav: NavItem[] = [
    { href: base, label: t("portal.nav.home"), icon: "dashboard", exact: true },
    { href: `${base}/book`, label: t("portal.nav.book"), icon: "booking" },
    { href: `${base}/appointments`, label: t("portal.nav.appointments"), icon: "calendar" },
    { href: `${base}/results`, label: t("portal.nav.results"), icon: "lab" },
    { href: `${base}/medicines`, label: t("portal.nav.medicines"), icon: "pill" },
    { href: `${base}/readings`, label: t("portal.nav.readings"), icon: "activity" },
    { href: `${base}/invoices`, label: t("portal.nav.invoices"), icon: "billing" },
    { href: `${base}/account`, label: t("portal.nav.account"), icon: "settings" },
  ];
  return (
    <AppShell
      context={`${p.tenant.name} · ${t("portal.title")}`}
      nav={nav}
      user={{ name: [p.patient.lastName, p.patient.firstName].join(" "), detail: p.patient.mrn }}
      signOut={portalLogoutAction.bind(null, p.tenant.slug)}
      primary={nav.slice(0, 4)}
    >
      {children}
    </AppShell>
  );
}
