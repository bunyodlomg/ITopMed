import "server-only";
import { z } from "zod";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { auditClinic, inClinic, requirePermission } from "../clinic/context";
import type { Tx } from "../db";
import { DomainError } from "../errors";
import { addDays, isLocalDate, localToInstant } from "../scheduling/time";

/**
 * Doctors' share of the money received for their patients' visits.
 *
 * Base = payments received in the period for invoices linked to the doctor's
 * appointments, minus what was refunded from those payments (per payment).
 * Share = base × the doctor's percent, rounded down to whole minor units.
 * A doctor sees only their own numbers; the finance roles see everyone's.
 */
export type EarningsRow = { day: string; currency: string; net: bigint; payments: number };
export type DoctorEarnings = { percent: number | null; days: EarningsRow[]; totals: { currency: string; net: bigint; share: bigint | null }[] };

const share = (net: bigint, percent: number | null) => (percent === null ? null : (net * BigInt(percent)) / 100n);

function period(ctx: ClinicContext, from: string, to: string) {
  if (!isLocalDate(from) || !isLocalDate(to) || from > to || addDays(from, 366) < to) throw new DomainError("errors.invalidInput");
  const tz = ctx.tenant.timezone;
  return { tz, start: localToInstant(from, 0, tz), end: localToInstant(addDays(to, 1), 0, tz) };
}

async function byDay(tx: Tx, doctorProfileId: string, tz: string, start: Date, end: Date) {
  return tx.$queryRaw<EarningsRow[]>`
    SELECT to_char((p."receivedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, p.currency,
           sum(p."amountMinor" - p."refundedMinor")::bigint AS net, count(*)::int AS payments
      FROM "Payment" p
      JOIN "Invoice" i ON i.id = p."invoiceId"
      JOIN "Appointment" a ON a.id = i."appointmentId"
     WHERE a."doctorProfileId" = ${doctorProfileId}::uuid AND p."receivedAt" >= ${start} AND p."receivedAt" < ${end}
     GROUP BY 1, 2 ORDER BY 1, 2`;
}

/** The signed-in doctor's own earnings for a period of local days. */
export async function myEarnings(ctx: ClinicContext, from: string, to: string): Promise<DoctorEarnings> {
  const { tz, start, end } = period(ctx, from, to);
  return inClinic(ctx, async (tx) => {
    const own = await tx.doctorProfile.findUnique({ where: { membershipId: ctx.membershipId }, select: { id: true, commissionPercent: true } });
    if (!own) throw new DomainError("errors.forbidden");
    const days = await byDay(tx, own.id, tz, start, end);
    const currencies = [...new Set(days.map((d) => d.currency))];
    const totals = currencies.map((currency) => {
      const net = days.filter((d) => d.currency === currency).reduce((s, d) => s + d.net, 0n);
      return { currency, net, share: share(net, own.commissionPercent) };
    });
    return { percent: own.commissionPercent, days, totals };
  });
}

/** Every doctor's base and share for the period (finance report). */
export async function doctorsEarnings(ctx: ClinicContext, from: string, to: string) {
  requirePermission(ctx, "finance.reports");
  const { start, end } = period(ctx, from, to);
  return inClinic(ctx, async (tx) => {
    const rows = await tx.$queryRaw<{ doctorProfileId: string; doctor: string; percent: number | null; currency: string; net: bigint }[]>`
      SELECT d.id AS "doctorProfileId", u."fullName" AS doctor, d."commissionPercent" AS percent, p.currency,
             sum(p."amountMinor" - p."refundedMinor")::bigint AS net
        FROM "Payment" p
        JOIN "Invoice" i ON i.id = p."invoiceId"
        JOIN "Appointment" a ON a.id = i."appointmentId"
        JOIN "DoctorProfile" d ON d.id = a."doctorProfileId"
        JOIN "Membership" m ON m.id = d."membershipId"
        JOIN "User" u ON u.id = m."userId"
       WHERE p."receivedAt" >= ${start} AND p."receivedAt" < ${end}
       GROUP BY d.id, u."fullName", d."commissionPercent", p.currency
       ORDER BY net DESC`;
    return rows.map((r) => ({ ...r, share: share(r.net, r.percent) }));
  });
}

const percentSchema = z.union([z.literal("").transform(() => null), z.coerce.number().int("validation.percentRange").min(0, "validation.percentRange").max(100, "validation.percentRange")]);

/** Who may set a doctor's percent: the accountant (finance.manage) or the owner (staff + finance reports). */
export function canSetCommission(ctx: ClinicContext) {
  return ctx.permissions.has("finance.manage") || (ctx.permissions.has("staff.manage") && ctx.permissions.has("finance.reports"));
}

/** Sets (or clears) a doctor's percent. Audited without amounts. */
export async function setDoctorCommission(ctx: ClinicContext, profileId: string, raw: unknown, meta: RequestMeta) {
  if (!canSetCommission(ctx)) throw new DomainError("errors.forbidden");
  if (!z.uuid().safeParse(profileId).success) throw new DomainError("errors.notFound");
  const percent = percentSchema.parse(raw);
  await inClinic(ctx, async (tx) => {
    const r = await tx.doctorProfile.updateMany({ where: { id: profileId, tenantId: ctx.tenant.id }, data: { commissionPercent: percent } });
    if (r.count !== 1) throw new DomainError("errors.notFound");
    await auditClinic(tx, ctx, meta, { action: "doctor_profile.commission_set", entityType: "DoctorProfile", entityId: profileId, metadata: { percent } });
  });
}
