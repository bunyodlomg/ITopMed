import { UserPlus, Users } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { roleLabel } from "@/lib/role-label";
import { Drawer } from "@/components/ui/drawer";
import { CheckboxGroup, Form, SubmitButton, TextField } from "@/components/ui/form";
import { Badge, ButtonLink, Card, EmptyState, PageHeader, STATUS_TONE, Table, Td, Th } from "@/components/ui/primitives";
import { SearchBox } from "@/components/ui/search-box";
import { FilterChips, Toolbar, hrefWith, type Chip } from "@/components/ui/toolbar";
import { listRoles } from "@/server/clinic/roles";
import { requireClinic } from "@/server/auth/guards";
import { listStaff } from "@/server/clinic/admin";
import { suggestPassword } from "@/server/security/password";
import { addStaffAction } from "../../../clinic-actions";

type Search = { q?: string; f?: string; panel?: string };

export default async function StaffPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Search> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await requireClinic(slug, "staff.read");
  const [t, format, { members }] = await Promise.all([getTranslations(), getFormatter(), listStaff(ctx)]);
  const canManage = ctx.permissions.has("staff.manage");
  const isOwner = ctx.roleKeys.includes("clinic_owner");
  const path = `/c/${ctx.tenant.slug}/staff`;
  const here: Search = { q: sp.q, f: sp.f };

  // Removed members stay out of the everyday list; they are one filter away.
  const current = members.filter((m) => m.status !== "REMOVED");
  const removed = members.filter((m) => m.status === "REMOVED");
  const roleCounts = new Map<string, { label: string; count: number }>();
  for (const m of current)
    for (const r of m.roles) {
      const e = roleCounts.get(r.role.key) ?? { label: roleLabel(t as never, r.role.key, r.role.name), count: 0 };
      e.count += 1;
      roleCounts.set(r.role.key, e);
    }
  const filter = sp.f ?? "all";
  const pool =
    filter === "removed" ? removed : filter === "suspended" ? current.filter((m) => m.status === "SUSPENDED") : filter.startsWith("role:") ? current.filter((m) => m.roles.some((r) => `role:${r.role.key}` === filter)) : current;
  const q = (sp.q ?? "").trim().toLowerCase();
  const rows = q ? pool.filter((m) => m.user.fullName.toLowerCase().includes(q) || m.user.username.toLowerCase().includes(q)) : pool;

  const chip = (f: string, label: string, count: number): Chip => ({ label, count, href: hrefWith(path, here, { f: f === "all" ? undefined : f }), active: filter === f });
  const suspended = current.filter((m) => m.status === "SUSPENDED").length;
  const chips: Chip[] = [
    chip("all", t("common.all"), current.length),
    ...[...roleCounts.entries()].sort((a, b) => b[1].count - a[1].count).map(([key, v]) => chip(`role:${key}`, v.label, v.count)),
    ...(suspended ? [chip("suspended", t("status.SUSPENDED"), suspended)] : []),
    ...(removed.length ? [chip("removed", t("status.REMOVED"), removed.length)] : []),
  ];

  const roles = canManage && sp.panel === "new" ? await listRoles(ctx) : [];
  const assignable = roles.filter((r) => r.key !== "clinic_owner" || isOwner);

  return (
    <>
      <PageHeader
        title={t("clinic.staff.title")}
        count={current.length}
        description={t("clinic.staff.subtitle")}
        action={
          canManage ? (
            <ButtonLink href={hrefWith(path, here, { panel: "new" })} scroll={false}>
              <UserPlus aria-hidden className="size-4" />
              {t("clinic.staff.invite")}
            </ButtonLink>
          ) : null
        }
      />

      <Toolbar
        search={<SearchBox placeholder={t("clinic.staff.searchPlaceholder")} label={t("common.search")} clearLabel={t("common.clearSearch")} />}
        filters={<FilterChips chips={chips} label={t("common.filters")} />}
      />

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState icon={<Users className="size-6" />} title={t("common.nothingFound")} description={t("common.nothingFoundHint")} />
        ) : (
          <Table caption={t("clinic.staff.members")}>
            <thead>
              <tr>
                <Th>{t("clinic.staff.colName")}</Th>
                <Th>{t("clinic.staff.colRoles")}</Th>
                <Th>{t("clinic.staff.colStatus")}</Th>
                <Th>{t("clinic.staff.colLastLogin")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <Td>
                    <Link href={`${path}/${m.id}`} className="font-medium hover:text-accent">
                      {m.user.fullName}
                    </Link>
                    <p className="break-all text-[13px] text-text-3">{m.user.username}</p>
                  </Td>
                  <Td className="text-text-2">{m.roles.map((r) => roleLabel(t as never, r.role.key, r.role.name)).join(", ")}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[m.status]}>{t(`status.${m.status}`)}</Badge>
                  </Td>
                  <Td label={t("clinic.staff.colLastLogin")} className="text-text-2">
                    {m.user.lastLoginAt ? format.relativeTime(m.user.lastLoginAt) : t("common.never")}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {canManage && sp.panel === "new" ? (
        <Drawer title={t("clinic.staff.invite")} description={t("clinic.staff.addHint")} closeHref={hrefWith(path, here, {})}>
          <Form action={addStaffAction}>
            <input type="hidden" name="$slug" value={ctx.tenant.slug} />
            <TextField name="fullName" label={t("clinic.staff.fullName")} autoComplete="off" required />
            <CheckboxGroup name="roleKeys" label={t("clinic.staff.roles")} hint={t("clinic.staff.rolesHint")} options={assignable.map((r) => ({ value: r.key, label: roleLabel(t as never, r.key, r.name) }))} />
            <TextField name="username" label={t("clinic.staff.username")} hint={t("clinic.staff.usernameHint")} autoComplete="off" required />
            <TextField name="password" label={t("clinic.staff.password")} hint={t("clinic.staff.passwordHint")} defaultValue={suggestPassword()} autoComplete="new-password" required />
            <SubmitButton full>{t("clinic.staff.add")}</SubmitButton>
          </Form>
        </Drawer>
      ) : null}
    </>
  );
}
