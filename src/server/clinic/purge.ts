import "server-only";
import { z } from "zod";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { DomainError } from "../errors";
import { auditClinic, inClinic, requirePermission } from "./context";

/**
 * Before real work starts: remove every patient entered while trying the
 * system out, with their queue entries, visits, records, invoices and
 * payments (see app_purge_patients in the migrations). Staff, services,
 * prices, templates, schedules and settings stay. Irreversible, so: clinic
 * owner only (checked here and again in PostgreSQL), and the owner types the
 * clinic's address (slug) to confirm. Audited with counts only.
 */
export const purgeSchema = z.object({ confirm: z.string().trim().max(100) });

export type PurgeCounts = { patients: number; appointments: number; encounters: number; invoices: number };

export async function purgeTestPatients(ctx: ClinicContext, raw: unknown, meta: RequestMeta): Promise<PurgeCounts> {
  requirePermission(ctx, "clinic.settings.manage");
  if (!ctx.roleKeys.includes("clinic_owner")) throw new DomainError("errors.ownerOnly");
  const { confirm } = purgeSchema.parse(raw);
  if (confirm.toLowerCase() !== ctx.tenant.slug.toLowerCase()) throw new DomainError("errors.purgeConfirm");
  return inClinic(ctx, async (tx) => {
    const rows = await tx.$queryRaw<{ counts: Partial<PurgeCounts> }[]>`SELECT app_purge_patients() AS counts`;
    const c = rows[0]?.counts ?? {};
    const counts: PurgeCounts = { patients: Number(c.patients ?? 0), appointments: Number(c.appointments ?? 0), encounters: Number(c.encounters ?? 0), invoices: Number(c.invoices ?? 0) };
    await auditClinic(tx, ctx, meta, { action: "clinic.patients_purged", entityType: "Tenant", entityId: ctx.tenant.id, metadata: counts });
    return counts;
  });
}
