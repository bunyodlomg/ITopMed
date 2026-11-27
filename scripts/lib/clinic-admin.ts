/**
 * Clinic administration done on the server for a clinic's owner (e.g. setting a clinic up
 * for go-live without the owner's password): a short list of operations, each run through
 * the same services, permission checks, database guards and audit as in the app.
 *
 *   node tasks.mjs clinic-admin <slug> <ops.json>
 *
 * ops.json, applied in order:
 *   { "op": "role-permissions", "role": "receptionist", "add": ["billing.charge"], "remove": [] }
 *   { "op": "owner-roles", "add": [], "remove": ["cashier"] }        the owner cannot change their own roles in the app
 *   { "op": "remove-member", "login": "old.login" }
 *   { "op": "add-staff", "fullName": "Ism Familiya", "login": "kassa", "roleKeys": ["cashier"] }
 *        a first password is generated and returned once (handed over in person; never stored in clear)
 *   { "op": "purge-patients" }                                         removes every patient (test data before go-live)
 *
 * Runs as the clinic's first active owner; a SYSTEM audit event "clinic.server_task" records
 * that a server task did it (operation names only).
 */
import { z } from "zod";
import type { ClinicContext, ClinicPrincipal } from "../../src/server/auth/clinic-auth";
import { resolveClinic } from "../../src/server/auth/clinic-auth";
import type { RequestMeta } from "../../src/server/auth/platform-auth";
import { isPermission, isSystemRoleKey } from "../../src/server/authz/permissions";
import { recordAudit } from "../../src/server/audit";
import { addStaffMember, listStaff } from "../../src/server/clinic/admin";
import { setMemberStatus } from "../../src/server/clinic/members";
import { purgeTestPatients } from "../../src/server/clinic/purge";
import { listRoles, updateRole } from "../../src/server/clinic/roles";
import { platformDb, withAppContext } from "../../src/server/db";
import { suggestPassword } from "../../src/server/security/password";

const META: RequestMeta = { ip: "127.0.0.1", userAgent: "itopmed-clinic (server task)", requestId: null };

const perms = z.array(z.string().refine(isPermission, "unknown permission")).default([]);
const roleKeys = z.array(z.string().refine(isSystemRoleKey, "unknown role")).default([]);
export const clinicAdminOpsSchema = z.array(
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("role-permissions"), role: z.string().min(1), add: perms, remove: perms }),
    z.object({ op: z.literal("owner-roles"), add: roleKeys, remove: roleKeys }),
    z.object({ op: z.literal("remove-member"), login: z.string().min(1) }),
    z.object({ op: z.literal("add-staff"), fullName: z.string().min(2), login: z.string().min(3), roleKeys: z.array(z.string()).min(1) }),
    z.object({ op: z.literal("purge-patients") }),
  ]),
);
export type ClinicAdminOp = z.infer<typeof clinicAdminOpsSchema>[number];

/** The clinic context of the clinic's first active owner (no session: a server task). */
async function ownerContext(slug: string): Promise<ClinicContext> {
  const tenant = await platformDb().tenant.findUnique({ where: { slug }, select: { id: true, slug: true, name: true, status: true, defaultLocale: true } });
  if (!tenant) throw new Error(`No clinic with slug ${slug}`);
  const owner = await withAppContext({ tenantId: tenant.id }, (tx) =>
    tx.membership.findFirst({
      where: { tenantId: tenant.id, status: "ACTIVE", roles: { some: { role: { key: "clinic_owner" } } } },
      orderBy: { createdAt: "asc" },
      select: { user: { select: { id: true, username: true, fullName: true, locale: true } } },
    }),
  );
  if (!owner) throw new Error("The clinic has no active owner");
  const principal: ClinicPrincipal = { sessionId: "server-task", user: owner.user, clinics: [{ tenantId: tenant.id, slug: tenant.slug, name: tenant.name, status: tenant.status, defaultLocale: tenant.defaultLocale }] };
  const ctx = await resolveClinic(principal, slug);
  if (!ctx) throw new Error("Clinic not usable (status) or owner inactive");
  return ctx;
}

export type ClinicAdminResult = { op: string; detail: string; password?: string }[];

export async function runClinicAdmin(slug: string, raw: unknown): Promise<ClinicAdminResult> {
  const ops = clinicAdminOpsSchema.parse(raw);
  const out: ClinicAdminResult = [];
  for (const op of ops) {
    // Fresh context each time: an earlier operation may have changed roles or permissions.
    const ctx = await ownerContext(slug);
    if (op.op === "role-permissions") {
      const role = (await listRoles(ctx)).find((r) => r.key === op.role || r.name === op.role);
      if (!role) throw new Error(`No role ${op.role}`);
      const next = new Set(role.permissions.map((p) => p.permission));
      for (const p of op.add) next.add(p);
      for (const p of op.remove) next.delete(p);
      await updateRole(ctx, role.id, { name: role.name ?? "", permissions: [...next] }, META);
      out.push({ op: op.op, detail: `${role.key}: +${op.add.join(",") || "-"} -${op.remove.join(",") || "-"}` });
    } else if (op.op === "owner-roles") {
      const detail = await withAppContext({ tenantId: ctx.tenant.id, userId: ctx.principal.user.id }, async (tx) => {
        const roles = await tx.role.findMany({ where: { tenantId: ctx.tenant.id, key: { in: [...op.add, ...op.remove] } }, select: { id: true, key: true } });
        const id = (k: string) => {
          const r = roles.find((x) => x.key === k);
          if (!r) throw new Error(`No role ${k}`);
          return r.id;
        };
        if (op.remove.includes("clinic_owner")) throw new Error("The owner role is not removed by this task");
        if (op.remove.length) await tx.membershipRole.deleteMany({ where: { membershipId: ctx.membershipId, roleId: { in: op.remove.map(id) } } });
        if (op.add.length) await tx.membershipRole.createMany({ data: op.add.map((k) => ({ tenantId: ctx.tenant.id, membershipId: ctx.membershipId, roleId: id(k) })), skipDuplicates: true });
        await recordAudit(tx, { tenantId: ctx.tenant.id, actorType: "SYSTEM", action: "membership.access_changed", entityType: "Membership", entityId: ctx.membershipId, metadata: { added: op.add, removed: op.remove, by: "server-task" } });
        return `+${op.add.join(",") || "-"} -${op.remove.join(",") || "-"}`;
      });
      out.push({ op: op.op, detail });
    } else if (op.op === "remove-member") {
      const m = (await listStaff(ctx)).members.find((x) => x.user.username === op.login);
      if (!m) throw new Error(`No staff member with login ${op.login}`);
      if (m.status === "REMOVED") {
        out.push({ op: op.op, detail: `${op.login}: already removed` });
        continue;
      }
      await setMemberStatus(ctx, m.id, "remove", META);
      out.push({ op: op.op, detail: op.login });
    } else if (op.op === "add-staff") {
      const password = suggestPassword();
      await addStaffMember(ctx, { fullName: op.fullName, username: op.login, password, roleKeys: op.roleKeys }, META);
      out.push({ op: op.op, detail: `${op.login} (${op.roleKeys.join(", ")})`, password });
    } else {
      const c = await purgeTestPatients(ctx, { confirm: ctx.tenant.slug }, META);
      out.push({ op: op.op, detail: `patients ${c.patients}, visits ${c.appointments}, encounters ${c.encounters}, invoices ${c.invoices}` });
    }
  }
  const ctx = await ownerContext(slug);
  await withAppContext({ tenantId: ctx.tenant.id }, (tx) =>
    recordAudit(tx, { tenantId: ctx.tenant.id, actorType: "SYSTEM", action: "clinic.server_task", entityType: "Tenant", entityId: ctx.tenant.id, metadata: { ops: ops.map((o) => o.op) } }),
  );
  return out;
}
