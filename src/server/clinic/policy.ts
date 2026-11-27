import "server-only";
import { z } from "zod";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import type { Tx } from "../db";
import { DomainError } from "../errors";
import { auditClinic, inClinic, requirePermission } from "./context";

/** Defaults when the owner has not saved a policy yet (no extra restriction). */
export const DEFAULT_POLICY = { maxDiscountPercent: 100, discountReasonRequired: false, onlineBookingDays: 30, onlineBookingLeadMinutes: 120, onlineBookingMaxActive: 3, printOnlyAtDesk: false, telegramDocuments: false } as const;
export type ClinicPolicyValues = { maxDiscountPercent: number; discountReasonRequired: boolean; onlineBookingDays: number; onlineBookingLeadMinutes: number; onlineBookingMaxActive: number; printOnlyAtDesk: boolean; telegramDocuments: boolean };

export async function policyIn(tx: Tx, tenantId: string): Promise<ClinicPolicyValues> {
  const p = await tx.clinicPolicy.findUnique({ where: { tenantId }, select: { maxDiscountPercent: true, discountReasonRequired: true, onlineBookingDays: true, onlineBookingLeadMinutes: true, onlineBookingMaxActive: true, printOnlyAtDesk: true, telegramDocuments: true } });
  return p ?? { ...DEFAULT_POLICY };
}

/** Whether visit papers may only be printed at the reception desk (any staff member may ask). */
export async function printOnlyAtDesk(ctx: ClinicContext): Promise<boolean> {
  return inClinic(ctx, async (tx) => (await policyIn(tx, ctx.tenant.id)).printOnlyAtDesk);
}

/** Whether the desk may send visit papers to patients' Telegram (the owner's choice, off by default). */
export async function telegramDocumentsOn(ctx: ClinicContext): Promise<boolean> {
  return inClinic(ctx, async (tx) => (await policyIn(tx, ctx.tenant.id)).telegramDocuments);
}

export async function getClinicPolicy(ctx: ClinicContext): Promise<ClinicPolicyValues> {
  requirePermission(ctx, "clinic.settings.read", "billing.invoice");
  return inClinic(ctx, (tx) => policyIn(tx, ctx.tenant.id));
}

export const policySchema = z.object({
  maxDiscountPercent: z.coerce.number().int("validation.invalid").min(0, "validation.percent").max(100, "validation.percent"),
  discountReasonRequired: z.boolean(),
  onlineBookingDays: z.coerce.number().int("validation.invalid").min(1, "validation.bookingDays").max(180, "validation.bookingDays").default(30),
  /** Entered in hours, stored in minutes. */
  onlineBookingLeadHours: z.coerce.number().min(0, "validation.leadHours").max(168, "validation.leadHours").default(2),
  onlineBookingMaxActive: z.coerce.number().int("validation.invalid").min(1, "validation.maxActive").max(20, "validation.maxActive").default(3),
  printOnlyAtDesk: z.boolean().default(false),
  telegramDocuments: z.boolean().default(false),
});

/**
 * Control rules for the staff. Only the clinic OWNER may change them — an
 * administrator must not be able to relax the limits that apply to themself.
 */
export async function updateClinicPolicy(ctx: ClinicContext, raw: unknown, meta: RequestMeta) {
  requirePermission(ctx, "clinic.settings.manage");
  if (!ctx.roleKeys.includes("clinic_owner")) throw new DomainError("errors.ownerOnly");
  const parsed = policySchema.parse(raw);
  const { onlineBookingLeadHours, ...rest } = parsed;
  const input = { ...rest, onlineBookingLeadMinutes: Math.round(onlineBookingLeadHours * 60) };
  await inClinic(ctx, async (tx) => {
    const before = await policyIn(tx, ctx.tenant.id);
    await tx.clinicPolicy.upsert({
      where: { tenantId: ctx.tenant.id },
      create: { tenantId: ctx.tenant.id, ...input, updatedById: ctx.principal.user.id },
      update: { ...input, updatedById: ctx.principal.user.id },
    });
    await auditClinic(tx, ctx, meta, {
      action: "clinic.policy_updated",
      entityType: "ClinicPolicy",
      entityId: ctx.tenant.id,
      metadata: { maxDiscountPercent: input.maxDiscountPercent, discountReasonRequired: input.discountReasonRequired, previousMaxDiscountPercent: before.maxDiscountPercent, onlineBookingDays: input.onlineBookingDays, onlineBookingLeadMinutes: input.onlineBookingLeadMinutes, onlineBookingMaxActive: input.onlineBookingMaxActive, printOnlyAtDesk: input.printOnlyAtDesk, telegramDocuments: input.telegramDocuments },
    });
  });
}
