import "server-only";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { auditClinic, inClinic, requirePermission } from "../clinic/context";
import { withRecordAccess } from "./access";

/**
 * Answers to "how are you feeling?" that the patient gave with a bot button a
 * few days after a visit (see notifications.ts → VISIT_CHECKIN). The doctor sees
 * them on the follow-up page (worse first) and in the visit.
 */

const RECENT_DAYS = 14;

/** The check-in of one visit (shown in the visit; record access required). */
export async function visitCheckIn(ctx: ClinicContext, patientId: string, encounterId: string, meta: RequestMeta) {
  return withRecordAccess(ctx, patientId, meta, { auditView: false }, (tx) =>
    tx.visitCheckIn.findFirst({ where: { tenantId: ctx.tenant.id, encounterId, patientId }, select: { askAt: true, answer: true, answeredAt: true } }),
  );
}

/** Answers of the last two weeks to the doctor's own visits (the head doctor with emr.read_all: the clinic's). */
export async function recentCheckIns(ctx: ClinicContext, meta: RequestMeta) {
  requirePermission(ctx, "emr.read");
  return inClinic(ctx, async (tx) => {
    const own = await tx.doctorProfile.findUnique({ where: { membershipId: ctx.membershipId }, select: { id: true } });
    const all = ctx.permissions.has("emr.read_all");
    if (!own && !all) return [];
    const rows = await tx.visitCheckIn.findMany({
      where: { tenantId: ctx.tenant.id, answeredAt: { gte: new Date(Date.now() - RECENT_DAYS * 86_400_000) }, ...(all ? {} : { doctorProfileId: own!.id }) },
      select: {
        id: true,
        answer: true,
        answeredAt: true,
        encounterId: true,
        patient: { select: { id: true, mrn: true, lastName: true, firstName: true, middleName: true, phone: true } },
      },
      orderBy: { answeredAt: "desc" },
      take: 300,
    });
    await auditClinic(tx, ctx, meta, { action: "checkin.list_viewed", entityType: "Tenant", entityId: ctx.tenant.id, metadata: { count: rows.length } });
    const order = { WORSE: 0, SAME: 1, BETTER: 2 } as const;
    return rows.sort((a, b) => order[a.answer!] - order[b.answer!]);
  });
}
