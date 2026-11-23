import "server-only";
import type { ClinicContext } from "../auth/clinic-auth";
import { printOnlyAtDesk } from "../clinic/policy";
import type { Tx } from "../db";
import { DomainError } from "../errors";
import { instantToLocalDate, localToInstant } from "../scheduling/time";

/**
 * Who may print a patient's paper and when (visit documents, prescriptions,
 * diagnostic and lab reports). Kept apart from the record services so every
 * kind of paper uses the same rules without import cycles.
 */
export type DeskPrintGate = "ok" | "notFinished" | "notToday" | "unpaid";

/** Today's papers only, and only once every bill of the patient since that day is settled (paid, void or debt approved). */
export async function paidGate(tx: Tx, ctx: ClinicContext, patientId: string, at: Date): Promise<DeskPrintGate> {
  const tz = ctx.tenant.timezone;
  const day = instantToLocalDate(at, tz);
  if (day !== instantToLocalDate(new Date(), tz)) return "notToday";
  const open = await tx.invoice.count({
    where: { patientId, issuedAt: { gte: localToInstant(day, 0, tz) }, status: { in: ["ISSUED", "PARTIALLY_PAID"] }, debtApprovedAt: null },
  });
  return open > 0 ? "unpaid" : "ok";
}

/**
 * Whether this person prints through the desk rules (bill settled, today only).
 * `ownAccess`: the person works with this kind of paper themself (record access
 * for doctors, lab work for the lab). Without it - the desk - always; with it
 * only when the clinic prints only at the desk, and then a person without
 * documents.print cannot print at all.
 */
export async function printsAtDesk(ctx: ClinicContext, ownAccess: boolean): Promise<boolean> {
  const deskOnly = await printOnlyAtDesk(ctx);
  if (deskOnly && !ctx.permissions.has("documents.print")) throw new DomainError("errors.deskPrint.atDesk");
  return deskOnly || !ownAccess;
}
