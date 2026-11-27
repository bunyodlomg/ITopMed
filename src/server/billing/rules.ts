import "server-only";
import type { DiscountKind } from "@/generated/prisma/client";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { auditClinic, inClinic, requirePermission } from "../clinic/context";
import type { Tx } from "../db";
import { DomainError } from "../errors";
import { uuidv7 } from "../security/crypto";

/**
 * Clinic pricing rules applied automatically to a draft invoice before it is
 * issued (the desk and extra services use them):
 *  - BENEFIT   the patient's privileged category (percent set by the clinic);
 *  - PACKAGE   all services of a package billed together (package percent);
 *  - FOLLOW_UP a repeat consultation (same service) within N days of the
 *              first, paid consultation is free (N = clinic setting, default 10);
 *  - FOLLOW_UP_EXCEPTION  free outside that period - only with the
 *              billing.free_visit permission, a written reason, and who allowed it.
 * Per line the single best rule wins (rules never add up). Staff discounts
 * typed by hand stay as they are (MANUAL). Every rule applied is audited
 * (amounts and kinds only, never clinical content).
 */

export interface FreeVisitException {
  reason: string;
}

interface Rule {
  kind: DiscountKind;
  discountMinor: bigint;
  reason: string;
  approvedById?: string;
}

/** Whole so'm (minor units of 100): a percentage never produces tiyin. */
function percentOf(amount: bigint, percent: number): bigint {
  return ((amount * BigInt(percent)) / 100n / 100n) * 100n;
}

async function freeFollowUpDays(tx: Tx, tenantId: string): Promise<number> {
  const p = await tx.clinicPolicy.findUnique({ where: { tenantId }, select: { freeFollowUpDays: true } });
  return p?.freeFollowUpDays ?? 10;
}

/**
 * Was this consultation already paid for within `days`? The anchor is the last
 * consultation of the same service that was not itself free.
 */
async function withinFreePeriod(tx: Tx, patientId: string, serviceId: string, days: number, invoiceId: string): Promise<boolean> {
  if (days <= 0) return false;
  const since = new Date(Date.now() - days * 86_400_000);
  const anchor = await tx.invoiceLine.findFirst({
    where: {
      serviceId,
      invoiceId: { not: invoiceId },
      createdAt: { gte: since },
      OR: [{ discountKind: null }, { discountKind: { in: ["MANUAL", "BENEFIT", "PACKAGE"] } }],
      invoice: { patientId, status: { in: ["ISSUED", "PARTIALLY_PAID", "PAID"] } },
    },
    select: { id: true },
  });
  return Boolean(anchor);
}

export async function applyPriceRules(ctx: ClinicContext, invoiceId: string, opts: { freeVisit?: FreeVisitException } = {}, meta: RequestMeta): Promise<{ applied: { kind: DiscountKind; lines: number }[] }> {
  // Clinic rules (benefit category, package, free follow-up) apply to charged services too.
  requirePermission(ctx, "billing.invoice", "billing.charge");
  if (opts.freeVisit) {
    requirePermission(ctx, "billing.free_visit");
    if (opts.freeVisit.reason.trim().length < 3) throw new DomainError("errors.freeVisitReasonRequired");
  }
  return inClinic(ctx, async (tx) => {
    const inv = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, status: true, patientId: true, lines: { select: { id: true, serviceId: true, quantity: true, unitPriceMinor: true, discountMinor: true, discountKind: true, service: { select: { kind: true } } } } },
    });
    if (!inv) throw new DomainError("errors.notFound");
    if (inv.status !== "DRAFT") throw new DomainError("errors.invoiceNotDraft");

    const patient = await tx.patient.findUnique({ where: { id: inv.patientId }, select: { benefitCategoryId: true } });
    const benefit = patient?.benefitCategoryId ? await tx.benefitCategory.findFirst({ where: { id: patient.benefitCategoryId, archivedAt: null }, select: { name: true, discountPercent: true } }) : null;
    const chosen = new Set(inv.lines.map((l) => l.serviceId).filter((x): x is string => Boolean(x)));
    const packages = await tx.servicePackage.findMany({ where: { archivedAt: null, discountPercent: { gt: 0 } }, select: { name: true, discountPercent: true, items: { select: { serviceId: true } } } });
    const complete = packages.filter((p) => p.items.length > 0 && p.items.every((i) => chosen.has(i.serviceId)));
    const days = await freeFollowUpDays(tx, ctx.tenant.id);

    const applied = new Map<DiscountKind, number>();
    for (const line of inv.lines) {
      // A discount the staff typed by hand is never overwritten.
      if (line.discountKind === "MANUAL" || (line.discountMinor > 0n && line.discountKind === null)) continue;
      const gross = line.unitPriceMinor * BigInt(line.quantity);
      const candidates: Rule[] = [];
      if (benefit) candidates.push({ kind: "BENEFIT", discountMinor: percentOf(gross, benefit.discountPercent), reason: `Imtiyoz: ${benefit.name}` });
      for (const p of complete) {
        if (line.serviceId && p.items.some((i) => i.serviceId === line.serviceId)) candidates.push({ kind: "PACKAGE", discountMinor: percentOf(gross, p.discountPercent), reason: `Paket: ${p.name}` });
      }
      if (line.serviceId && line.service?.kind === "CONSULTATION") {
        if (await withinFreePeriod(tx, inv.patientId, line.serviceId, days, inv.id)) {
          candidates.push({ kind: "FOLLOW_UP", discountMinor: gross, reason: `Qayta ko'rik (${days} kun ichida)` });
        } else if (opts.freeVisit) {
          candidates.push({ kind: "FOLLOW_UP_EXCEPTION", discountMinor: gross, reason: `Bepul qayta ko'rik (istisno): ${opts.freeVisit.reason.trim().slice(0, 200)}`, approvedById: ctx.principal.user.id });
        }
      }
      const best = candidates.filter((c) => c.discountMinor > 0n).sort((a, b) => (b.discountMinor > a.discountMinor ? 1 : b.discountMinor < a.discountMinor ? -1 : 0))[0];
      if (!best) continue;
      const discount = best.discountMinor > gross ? gross : best.discountMinor;
      // Invoice lines are never updated (insert/delete only, on drafts): replace the line.
      const old = await tx.invoiceLine.findUniqueOrThrow({ where: { id: line.id } });
      await tx.invoiceLine.delete({ where: { id: line.id } });
      await tx.invoiceLine.create({
        data: {
          id: uuidv7(),
          tenantId: old.tenantId,
          invoiceId: old.invoiceId,
          serviceId: old.serviceId,
          description: old.description,
          quantity: old.quantity,
          unitPriceMinor: old.unitPriceMinor,
          createdById: old.createdById,
          discountMinor: discount,
          totalMinor: gross - discount,
          discountKind: best.kind,
          discountReason: best.reason.slice(0, 300),
          discountApprovedById: best.approvedById ?? null,
        },
      });
      applied.set(best.kind, (applied.get(best.kind) ?? 0) + 1);
    }
    if (applied.size) {
      const lines = await tx.invoiceLine.findMany({ where: { invoiceId }, select: { unitPriceMinor: true, quantity: true, discountMinor: true } });
      const subtotal = lines.reduce((s, l) => s + l.unitPriceMinor * BigInt(l.quantity), 0n);
      const discount = lines.reduce((s, l) => s + l.discountMinor, 0n);
      await tx.invoice.update({ where: { id: invoiceId }, data: { subtotalMinor: subtotal, discountMinor: discount, totalMinor: subtotal - discount } });
      for (const [kind, n] of applied) {
        await auditClinic(tx, ctx, meta, {
          action: kind === "FOLLOW_UP_EXCEPTION" ? "billing.free_visit_exception" : "billing.price_rule_applied",
          entityType: "Invoice",
          entityId: invoiceId,
          metadata: { kind, lines: n },
        });
      }
    }
    return { applied: [...applied].map(([kind, lines]) => ({ kind, lines })) };
  });
}

/** Free follow-up visit: is there a paid consultation within the free period? (for the desk hint) */
export async function followUpStatus(ctx: ClinicContext, patientId: string): Promise<{ days: number; freeUntil: Date | null }> {
  requirePermission(ctx, "billing.read", "billing.invoice");
  return inClinic(ctx, async (tx) => {
    const days = await freeFollowUpDays(tx, ctx.tenant.id);
    if (days <= 0) return { days, freeUntil: null };
    const since = new Date(Date.now() - days * 86_400_000);
    const last = await tx.invoiceLine.findFirst({
      where: { createdAt: { gte: since }, service: { kind: "CONSULTATION" }, OR: [{ discountKind: null }, { discountKind: { in: ["MANUAL", "BENEFIT", "PACKAGE"] } }], invoice: { patientId, status: { in: ["ISSUED", "PARTIALLY_PAID", "PAID"] } } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    return { days, freeUntil: last ? new Date(last.createdAt.getTime() + days * 86_400_000) : null };
  });
}
