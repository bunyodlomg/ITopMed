import { getTranslations } from "next-intl/server";
import { roleLabel } from "@/lib/role-label";
import { AppShell } from "@/components/shell/app-shell";
import type { NavItem } from "@/components/shell/nav-links";
import { requireClinic } from "@/server/auth/guards";
import type { Permission } from "@/server/authz/permissions";
import { DOCTOR_ROLE_KEYS } from "@/server/clinic/doctors";
import { clinicLogoutAction } from "../../clinic-actions";
import { moneyFormatter } from "@/components/money";
import { Alert } from "@/components/ui/primitives";
import { subscriptionDue } from "@/server/clinic/subscription";

export default async function ClinicLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug);
  const t = await getTranslations();
  const base = `/c/${ctx.tenant.slug}`;
  const can = (p: Permission) => ctx.permissions.has(p);
  const isDoctor = ctx.roleKeys.some((r) => (DOCTOR_ROLE_KEYS as readonly string[]).includes(r));

  // Navigation is derived from permissions; every page re-checks on the server.
  const nav: NavItem[] = [
    { href: base, label: t("nav.dashboard"), icon: "dashboard", exact: true },
    ...(can("queue.manage") ? [{ href: `${base}/desk`, label: t("nav.desk"), icon: "desk" as const, group: "reception" as const }] : []),
    ...(isDoctor && can("emr.write") ? [{ href: `${base}/my-queue`, label: t("nav.myQueue"), icon: "visits" as const, group: "doctor" as const }] : []),
    ...(can("vitals.write") && !isDoctor ? [{ href: `${base}/nurse`, label: t("nav.nurse"), icon: "nurse" as const, group: "reception" as const }] : []),
    ...(can("patients.read") ? [{ href: `${base}/patients`, label: t("nav.patients"), icon: "patients" as const, group: "patients" as const }] : []),
    ...(can("queue.manage") ? [{ href: `${base}/queue`, label: t("nav.queue"), icon: "queue" as const, group: "reception" as const }] : []),
    ...(can("appointments.manage") ? [{ href: `${base}/appointments`, label: t("nav.appointments"), icon: "booking" as const, group: "reception" as const }] : []),
    ...(can("lab.read") || can("lab.process") ? [{ href: `${base}/lab`, label: t("nav.lab"), icon: "lab" as const, group: "patients" as const }] : []),
    ...((isDoctor && can("emr.read")) || can("emr.read_all") ? [{ href: `${base}/dispensary`, label: t("nav.dispensary"), icon: "activity" as const, group: "patients" as const }] : []),
    ...(isDoctor ? [{ href: `${base}/my-schedule`, label: t("nav.mySchedule"), icon: "calendar" as const, group: "doctor" as const }] : []),
    ...(isDoctor ? [{ href: `${base}/my-earnings`, label: t("nav.myEarnings"), icon: "cash" as const, group: "doctor" as const }] : []),
    ...(can("billing.read") ? [{ href: `${base}/billing`, label: t("nav.billing"), icon: "billing" as const, group: "cash" as const }] : []),
    ...(can("cash.shift") ? [{ href: `${base}/cash`, label: t("nav.cash"), icon: "cash" as const, group: "cash" as const }] : []),
    ...(can("finance.manage") ? [{ href: `${base}/expenses`, label: t("nav.expenses"), icon: "expenses" as const, group: "cash" as const }] : []),
    ...(can("finance.reports") || can("reports.operational") ? [{ href: `${base}/reports`, label: t("nav.reports"), icon: "reports" as const, group: "reports" as const }] : []),
    ...(can("schedules.read") ? [{ href: `${base}/doctors`, label: t("nav.doctors"), icon: "doctors" as const, group: "settings" as const }] : []),
    ...(can("services.read") ? [{ href: `${base}/services`, label: t("nav.services"), icon: "services" as const, group: "settings" as const }] : []),
    ...(can("inventory.read") || can("inventory.dispense") ? [{ href: `${base}/inventory`, label: t("nav.inventory"), icon: "inventory" as const, group: "stock" as const }] : []),
    ...(can("hr.read") ? [{ href: `${base}/hr`, label: t("nav.hr"), icon: "hr" as const, group: "settings" as const }] : []),
    ...(can("staff.read") ? [{ href: `${base}/staff`, label: t("nav.team"), icon: "staff" as const, group: "settings" as const }] : []),
    ...(can("audit.read") ? [{ href: `${base}/control`, label: t("nav.control"), icon: "shield" as const, group: "reports" as const }] : []),
    ...(can("clinic.settings.read") ? [{ href: `${base}/settings`, label: t("nav.settings"), icon: "settings" as const, group: "settings" as const }] : []),
    ...(can("clinic.settings.read") ? [{ href: `${base}/templates`, label: t("nav.templates"), icon: "activity" as const, group: "settings" as const }] : []),
    ...(can("clinic.settings.read") ? [{ href: `${base}/facilities`, label: t("nav.facilities"), icon: "facilities" as const, group: "settings" as const }] : []),
    ...(can("clinic.settings.read") ? [{ href: `${base}/branches`, label: t("nav.branches"), icon: "branches" as const, group: "settings" as const }] : []),
    ...(can("roles.manage") ? [{ href: `${base}/roles`, label: t("nav.roles"), icon: "roles" as const, group: "settings" as const }] : []),
    ...(can("clinic.settings.read") ? [{ href: `${base}/integrations`, label: t("nav.integrations"), icon: "integrations" as const, group: "settings" as const }] : []),
    ...(can("support_access.decide") ? [{ href: `${base}/support-access`, label: t("nav.supportAccess"), icon: "support" as const, group: "settings" as const }] : []),
    ...(can("audit.read") ? [{ href: `${base}/audit`, label: t("nav.clinicAudit"), icon: "audit" as const, group: "settings" as const }] : []),
  ];
  // Subscription payment overdue: only those who manage the clinic see it.
  const due = await subscriptionDue(ctx);
  const money = due ? await moneyFormatter() : null;
  return (
    <AppShell
      context={ctx.tenant.name}
      nav={nav}
      navGroups={[
        { id: "reception", label: t("nav.groupReception"), icon: "desk" },
        { id: "doctor", label: t("nav.groupDoctor"), icon: "visits" },
        { id: "patients", label: t("nav.groupPatients"), icon: "patients" },
        { id: "cash", label: t("nav.groupCash"), icon: "cash" },
        { id: "reports", label: t("nav.groupReports"), icon: "reports" },
        { id: "stock", label: t("nav.groupStock"), icon: "inventory" },
        { id: "settings", label: t("nav.groupSettings"), collapsible: true, icon: "settings" },
      ]}
      user={{ name: ctx.principal.user.fullName, detail: ctx.roleKeys.map((r) => roleLabel(t as never, r)).join(", ") }}
      signOut={clinicLogoutAction}
      securityHref={`/account/security?next=${encodeURIComponent(base)}`}
      primary={nav.slice(0, 4)}
    >
      {due && money ? (
        <div className="mb-6" role="status">
          <Alert tone="warning" title={t("clinic.subscription.overdueTitle")}>
            {t("clinic.subscription.overdueBody", { amount: money(due.debtMinor, due.currency), date: due.suspendOn ? due.suspendOn.toISOString().slice(0, 10) : "—" })}
          </Alert>
        </div>
      ) : null}
      {children}
    </AppShell>
  );
}
