import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { recordAudit } from "../audit";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { PERMISSIONS, isPermission, type Permission } from "../authz/permissions";
import { withAppContext, type Tx } from "../db";
import { hashIp, uuidv7 } from "../security/crypto";
import { DomainError } from "../tenancy/provisioning";

/** The owner role is immutable so a clinic can never lock itself out of administration. */
export const LOCKED_ROLE_KEYS = new Set(["clinic_owner"]);

/** Permissions that expose patients' medical information. Changes are flagged in the audit trail. */
export const CLINICAL_PERMISSIONS = new Set<Permission>([
  "emr.read", "emr.read_all", "emr.write", "emr.sign", "emr.amend", "vitals.write", "nursing.write",
  "orders.create", "diagnostics.record", "lab.read", "lab.process", "lab.verify", "lab.collect", "documents.read", "documents.upload", "prescriptions.write",
]);

export const PERMISSION_GROUPS: { key: string; permissions: Permission[] }[] = [
  { key: "admin", permissions: ["clinic.settings.read", "clinic.settings.manage", "clinic.branches.manage", "clinic.subscription.read", "staff.read", "staff.manage", "roles.manage", "audit.read", "support_access.decide", "services.read", "services.manage"] },
  { key: "patients", permissions: ["patients.read", "patients.create", "patients.update", "patients.merge", "appointments.read", "appointments.manage", "queue.manage", "schedules.read", "schedules.manage", "portal.manage"] },
  { key: "clinical", permissions: [...CLINICAL_PERMISSIONS] },
  { key: "finance", permissions: ["billing.read", "billing.invoice", "billing.charge", "billing.payment", "billing.refund", "cash.shift", "finance.reports", "finance.manage"] },
  { key: "operations", permissions: ["inventory.read", "inventory.manage", "inventory.dispense", "hr.read", "hr.manage", "reports.operational", "lab.manage", "medicines.manage"] },
];

/** i18n key for a permission (next-intl treats dots as nesting). */
export const permissionMessageKey = (p: Permission) => `permissions.${p.replace(/\./g, "_")}`;

function requireManage(ctx: ClinicContext) {
  if (!ctx.permissions.has("roles.manage")) throw new DomainError("errors.forbidden");
}

function inClinic<T>(ctx: ClinicContext, fn: (tx: Tx) => Promise<T>) {
  return withAppContext({ tenantId: ctx.tenant.id, userId: ctx.principal.user.id, sessionId: ctx.principal.sessionId }, fn);
}

function audit(tx: Tx, ctx: ClinicContext, meta: RequestMeta, action: string, roleId: string, metadata: Record<string, string | number | boolean | string[]>) {
  return recordAudit(tx, { tenantId: ctx.tenant.id, actorType: "USER", actorId: ctx.principal.user.id, action, entityType: "Role", entityId: roleId, ipHash: hashIp(meta.ip), userAgent: meta.userAgent, metadata });
}

export async function listRoles(ctx: ClinicContext) {
  if (!ctx.permissions.has("roles.manage") && !ctx.permissions.has("staff.read")) throw new DomainError("errors.forbidden");
  return inClinic(ctx, (tx) =>
    tx.role.findMany({
      orderBy: [{ isSystem: "desc" }, { createdAt: "asc" }],
      include: { permissions: { select: { permission: true } }, _count: { select: { members: true } } },
    }),
  );
}

export async function getRole(ctx: ClinicContext, roleId: string) {
  requireManage(ctx);
  return inClinic(ctx, (tx) => tx.role.findUnique({ where: { id: roleId }, include: { permissions: { select: { permission: true } }, _count: { select: { members: true } } } }));
}

const permissionList = z.array(z.string()).max(PERMISSIONS.length).transform((list, c) => {
  const unique = [...new Set(list)];
  if (!unique.every(isPermission)) {
    c.addIssue({ code: "custom", message: "validation.invalid" });
    return z.NEVER;
  }
  return unique as Permission[];
});

export const roleSchema = z.object({
  name: z.string().trim().min(2, "validation.required").max(60, "validation.tooLong"),
  permissions: permissionList,
});

export async function createRole(ctx: ClinicContext, raw: unknown, meta: RequestMeta) {
  requireManage(ctx);
  const input = roleSchema.parse(raw);
  const id = uuidv7();
  const key = `custom_${randomBytes(5).toString("hex")}`;
  await inClinic(ctx, async (tx) => {
    const clash = await tx.role.findFirst({ where: { name: { equals: input.name, mode: "insensitive" } } });
    if (clash) throw new DomainError("errors.roleNameTaken");
    await tx.role.create({ data: { id, tenantId: ctx.tenant.id, key, name: input.name, isSystem: false } });
    if (input.permissions.length) await tx.rolePermission.createMany({ data: input.permissions.map((permission) => ({ tenantId: ctx.tenant.id, roleId: id, permission })) });
    await audit(tx, ctx, meta, "role.created", id, { permissionCount: input.permissions.length, clinicalGranted: input.permissions.some((p) => CLINICAL_PERMISSIONS.has(p)) });
  });
  return id;
}

/** Replaces a role's permission set (and the name of custom roles). Atomic and audited with a diff. */
export async function updateRole(ctx: ClinicContext, roleId: string, raw: unknown, meta: RequestMeta) {
  requireManage(ctx);
  await inClinic(ctx, async (tx) => {
    const role = await tx.role.findUnique({ where: { id: roleId }, include: { permissions: true } });
    if (!role) throw new DomainError("errors.notFound");
    if (LOCKED_ROLE_KEYS.has(role.key)) throw new DomainError("errors.roleLocked");
    const input = role.isSystem ? { name: role.name ?? "", permissions: permissionList.parse((raw as { permissions?: unknown })?.permissions ?? []) } : roleSchema.parse(raw);
    const before = new Set(role.permissions.map((p) => p.permission));
    const after = new Set<string>(input.permissions);
    const added = [...after].filter((p) => !before.has(p));
    const removed = [...before].filter((p) => !after.has(p));
    await tx.rolePermission.deleteMany({ where: { roleId } });
    if (after.size) await tx.rolePermission.createMany({ data: [...after].map((permission) => ({ tenantId: ctx.tenant.id, roleId, permission })) });
    if (!role.isSystem && input.name !== role.name) await tx.role.update({ where: { id: roleId }, data: { name: input.name } });
    await audit(tx, ctx, meta, "role.updated", roleId, {
      added,
      removed,
      clinicalGranted: added.some((p) => CLINICAL_PERMISSIONS.has(p as Permission)),
    });
  });
}

export async function deleteRole(ctx: ClinicContext, roleId: string, meta: RequestMeta) {
  requireManage(ctx);
  await inClinic(ctx, async (tx) => {
    const role = await tx.role.findUnique({ where: { id: roleId }, include: { _count: { select: { members: true } } } });
    if (!role) throw new DomainError("errors.notFound");
    if (role.isSystem) throw new DomainError("errors.roleLocked");
    if (role._count.members > 0) throw new DomainError("errors.roleInUse");
    await tx.rolePermission.deleteMany({ where: { roleId } });
    await tx.role.delete({ where: { id: roleId } });
    await audit(tx, ctx, meta, "role.deleted", roleId, {});
  });
}
