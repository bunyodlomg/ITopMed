import "server-only";
import { z } from "zod";
import { Prisma, type InvoiceStatus, type PaymentMethod } from "@/generated/prisma/client";
import { parseMoney } from "@/lib/money";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { assertBranch, auditClinic, inClinic, requirePermission } from "../clinic/context";
import { policyIn } from "../clinic/policy";
import type { Tx } from "../db";
import { addDays, instantToLocalDate, localToInstant } from "../scheduling/time";
import { uuidv7 } from "../security/crypto";
import { DomainError } from "../tenancy/provisioning";

const uuid = z.uuid();
export const PAYMENT_METHODS = ["CASH", "CARD", "BANK_TRANSFER", "PAYME", "CLICK", "UZUM", "OTHER"] as const;
export const REFUND_REASONS = ["SERVICE_NOT_PROVIDED", "OVERPAYMENT", "PATIENT_REQUEST", "BILLING_ERROR", "OTHER"] as const;
export const VOID_REASONS = ["CREATED_IN_ERROR", "DUPLICATE", "SERVICE_CANCELLED", "OTHER"] as const;
const idempotencyKey = z.uuid("validation.invalid");

/** Status after a change of the paid amount. */
function statusFor(total: bigint, paid: bigint): InvoiceStatus {
  if (paid <= 0n) return "ISSUED";
  return paid >= total ? "PAID" : "PARTIALLY_PAID";
}

/** Row lock: concurrent payments on the same invoice are serialised. */
async function lockInvoice(tx: Tx, invoiceId: string) {
  if (!uuid.safeParse(invoiceId).success) throw new DomainError("errors.notFound");
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Invoice" WHERE id = ${invoiceId}::uuid FOR UPDATE`;
  if (!rows.length) throw new DomainError("errors.notFound");
  return tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
}

async function recalcTotals(tx: Tx, invoiceId: string) {
  const lines = await tx.invoiceLine.findMany({ where: { invoiceId }, select: { unitPriceMinor: true, quantity: true, discountMinor: true } });
  const subtotal = lines.reduce((s, l) => s + l.unitPriceMinor * BigInt(l.quantity), 0n);
  const discount = lines.reduce((s, l) => s + l.discountMinor, 0n);
  await tx.invoice.update({ where: { id: invoiceId }, data: { subtotalMinor: subtotal, discountMinor: discount, totalMinor: subtotal - discount } });
}

// ───────────── Invoices ─────────────

export const createInvoiceSchema = z.object({
  patientId: uuid,
  branchId: uuid,
  appointmentId: z.union([z.literal("").transform(() => undefined), uuid]).optional(),
});

/**
 * Creates a draft invoice. When created from an appointment with a service,
 * that service is added as the first line (price snapshot).
 */
export async function createInvoice(ctx: ClinicContext, raw: unknown, meta: RequestMeta): Promise<string> {
  requirePermission(ctx, "billing.invoice");
  const input = createInvoiceSchema.parse(raw);
  assertBranch(ctx, input.branchId);
  const id = uuidv7();
  await inClinic(ctx, async (tx) => {
    const patient = await tx.patient.findUnique({ where: { id: input.patientId }, select: { status: true } });
    if (!patient || patient.status !== "ACTIVE") throw new DomainError("errors.notFound");
    let service: { id: string; name: string; priceMinor: bigint; currency: string } | null = null;
    if (input.appointmentId) {
      const a = await tx.appointment.findUnique({ where: { id: input.appointmentId }, include: { service: true, invoice: { select: { id: true } } } });
      if (!a || a.patientId !== input.patientId) throw new DomainError("errors.notFound");
      if (a.invoice) throw new DomainError("errors.alreadyInvoiced");
      if (a.status === "CANCELLED" || a.status === "NO_SHOW") throw new DomainError("errors.invalidTransition");
      // Unpriced (starter) services are not copied automatically; the cashier adds a priced line instead.
      service = a.service && !a.service.archivedAt && a.service.priceMinor > 0n ? a.service : null;
    }
    await tx.invoice.create({
      data: { id, tenantId: ctx.tenant.id, patientId: input.patientId, branchId: input.branchId, appointmentId: input.appointmentId, currency: service?.currency ?? ctx.tenant.currency, createdById: ctx.principal.user.id },
    });
    if (service) {
      await tx.invoiceLine.create({ data: { id: uuidv7(), tenantId: ctx.tenant.id, invoiceId: id, serviceId: service.id, description: service.name, quantity: 1, unitPriceMinor: service.priceMinor, totalMinor: service.priceMinor } });
      await recalcTotals(tx, id);
    }
    await auditClinic(tx, ctx, meta, { action: "invoice.created", entityType: "Invoice", entityId: id, metadata: { fromAppointment: Boolean(input.appointmentId) } });
  }).catch((e) => {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new DomainError("errors.alreadyInvoiced");
    throw e;
  });
  return id;
}

export const lineSchema = z.object({
  serviceId: uuid,
  quantity: z.coerce.number().int().min(1, "validation.quantity").max(1000, "validation.quantity"),
  discount: z.string().default(""),
  discountReason: z
    .string()
    .trim()
    .max(300, "validation.tooLong")
    .transform((v) => (v.length >= 3 ? v : undefined))
    .optional(),
});

export async function addInvoiceLine(ctx: ClinicContext, invoiceId: string, raw: unknown, meta: RequestMeta) {
  requirePermission(ctx, "billing.invoice");
  const input = lineSchema.parse(raw);
  await inClinic(ctx, async (tx) => {
    const inv = await lockInvoice(tx, invoiceId);
    assertBranch(ctx, inv.branchId);
    if (inv.status !== "DRAFT") throw new DomainError("errors.invoiceNotDraft");
    const s = await tx.service.findFirst({ where: { id: input.serviceId, archivedAt: null } });
    if (!s) throw new DomainError("errors.notFound");
    if (s.currency !== inv.currency) throw new DomainError("errors.currencyMismatch");
    // Starter services are created without a price; they cannot be billed until the clinic sets one.
    if (s.priceMinor === 0n) throw new DomainError("errors.servicePriceNotSet");
    const gross = s.priceMinor * BigInt(input.quantity);
    const discount = input.discount.trim() ? parseMoney(input.discount, inv.currency) : 0n;
    if (discount === null || discount > gross) throw new DomainError("errors.invalidDiscount");
    // Owner's control rules (Settings → Control): limit and written reason. The owner is not limited.
    if (discount > 0n) {
      const policy = await policyIn(tx, ctx.tenant.id);
      if (!ctx.roleKeys.includes("clinic_owner") && discount * 100n > gross * BigInt(policy.maxDiscountPercent)) throw new DomainError("errors.discountOverLimit");
      if (policy.discountReasonRequired && !input.discountReason) throw new DomainError("errors.discountReasonRequired");
    }
    await tx.invoiceLine.create({
      data: {
        id: uuidv7(),
        tenantId: ctx.tenant.id,
        invoiceId: inv.id,
        serviceId: s.id,
        description: s.name,
        quantity: input.quantity,
        unitPriceMinor: s.priceMinor,
        discountMinor: discount,
        discountReason: discount > 0n ? (input.discountReason ?? null) : null,
        discountKind: discount > 0n ? "MANUAL" : null,
        createdById: ctx.principal.user.id,
        totalMinor: gross - discount,
      },
    });
    await recalcTotals(tx, inv.id);
    if (discount > 0n) {
      const percent = Number((discount * 10000n) / gross) / 100;
      await auditClinic(tx, ctx, meta, { action: "invoice.discount_applied", entityType: "Invoice", entityId: inv.id, metadata: { discountMinor: discount.toString(), percent, withReason: Boolean(input.discountReason) } });
    }
  });
}

export async function removeInvoiceLine(ctx: ClinicContext, lineId: string, meta: RequestMeta) {
  requirePermission(ctx, "billing.invoice");
  await inClinic(ctx, async (tx) => {
    const line = await tx.invoiceLine.findUnique({ where: { id: uuid.parse(lineId) } });
    if (!line) throw new DomainError("errors.notFound");
    const inv = await lockInvoice(tx, line.invoiceId);
    assertBranch(ctx, inv.branchId);
    if (inv.status !== "DRAFT") throw new DomainError("errors.invoiceNotDraft");
    await tx.invoiceLine.delete({ where: { id: line.id } });
    await recalcTotals(tx, inv.id);
    await auditClinic(tx, ctx, meta, { action: "invoice.line_removed", entityType: "Invoice", entityId: inv.id });
  });
}

/** Freezes the invoice and assigns its sequential number (per clinic and year). */
export async function issueInvoice(ctx: ClinicContext, invoiceId: string, meta: RequestMeta): Promise<string> {
  requirePermission(ctx, "billing.invoice");
  return inClinic(ctx, async (tx) => {
    const inv = await lockInvoice(tx, invoiceId);
    assertBranch(ctx, inv.branchId);
    if (inv.status !== "DRAFT") throw new DomainError("errors.invoiceNotDraft");
    // A bill with services but nothing to pay (e.g. a free follow-up visit) is issued as paid.
    const lineCount = await tx.invoiceLine.count({ where: { invoiceId: inv.id } });
    if (lineCount === 0 || inv.totalMinor < 0n) throw new DomainError("errors.emptyInvoice");
    const settled = inv.totalMinor === 0n;
    const year = instantToLocalDate(new Date(), ctx.tenant.timezone).slice(0, 4);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`invoice-number:${ctx.tenant.id}:${year}`}, 0))`;
    const last = await tx.$queryRaw<{ n: number | null }[]>`SELECT max(split_part(number, '-', 3)::int) AS n FROM "Invoice" WHERE number LIKE ${`INV-${year}-%`}`;
    const number = `INV-${year}-${String((last[0]?.n ?? 0) + 1).padStart(6, "0")}`;
    await tx.invoice.update({ where: { id: inv.id }, data: { status: settled ? "PAID" : "ISSUED", number, issuedAt: new Date() } });
    await auditClinic(tx, ctx, meta, { action: "invoice.issued", entityType: "Invoice", entityId: inv.id, metadata: { number, totalMinor: inv.totalMinor.toString(), currency: inv.currency } });
    return number;
  });
}

/** Voiding is only possible while nothing is paid (refund first). Void is final. */
export async function voidInvoice(ctx: ClinicContext, invoiceId: string, reason: string, meta: RequestMeta) {
  requirePermission(ctx, "billing.invoice");
  const r = z.enum(VOID_REASONS).parse(reason);
  await inClinic(ctx, async (tx) => {
    const inv = await lockInvoice(tx, invoiceId);
    assertBranch(ctx, inv.branchId);
    if (inv.status === "VOID") throw new DomainError("errors.invalidTransition");
    if (inv.paidMinor > 0n) throw new DomainError("errors.refundFirst");
    await tx.invoice.update({ where: { id: inv.id }, data: { status: "VOID", voidedAt: new Date(), voidReason: r } });
    await auditClinic(tx, ctx, meta, { action: "invoice.voided", entityType: "Invoice", entityId: inv.id, metadata: { reason: r } });
  });
}

// ───────────── Payments & refunds ─────────────

async function openShiftFor(tx: Tx, ctx: ClinicContext, branchId: string) {
  return tx.cashShift.findFirst({ where: { branchId, cashierId: ctx.principal.user.id, status: "OPEN" } });
}

export const paymentSchema = z.object({
  amount: z.string(),
  method: z.enum(PAYMENT_METHODS),
  externalRef: z
    .string()
    .trim()
    .max(64, "validation.tooLong")
    .transform((v) => (v === "" ? undefined : v))
    .optional(),
  idempotencyKey,
});

/**
 * Records a payment. Safe against double submission (idempotency key: a
 * repeat returns the original payment) and against concurrent payments
 * (row lock) — the paid amount can never exceed the invoice total.
 * Cash requires the cashier's open shift at the invoice's branch.
 * Provider methods (Payme, Click, Uzum) are recorded manually with the
 * transaction reference until provider integrations are contracted.
 */
export async function recordPayment(ctx: ClinicContext, invoiceId: string, raw: unknown, meta: RequestMeta): Promise<{ paymentId: string; duplicate: boolean }> {
  requirePermission(ctx, "billing.payment");
  const input = paymentSchema.parse(raw);
  return inClinic(ctx, async (tx) => {
    const existing = await tx.payment.findUnique({ where: { tenantId_idempotencyKey: { tenantId: ctx.tenant.id, idempotencyKey: input.idempotencyKey } } });
    if (existing) {
      if (existing.invoiceId !== invoiceId) throw new DomainError("errors.invalidInput");
      return { paymentId: existing.id, duplicate: true };
    }
    const inv = await lockInvoice(tx, invoiceId);
    assertBranch(ctx, inv.branchId);
    if (inv.status !== "ISSUED" && inv.status !== "PARTIALLY_PAID") throw new DomainError("errors.invoiceNotPayable");
    const amount = parseMoney(input.amount, inv.currency);
    if (amount === null || amount <= 0n) throw new DomainError("errors.invalidAmount");
    const outstanding = inv.totalMinor - inv.paidMinor;
    if (amount > outstanding) throw new DomainError("errors.overpayment");
    const shift = input.method === "CASH" ? await openShiftFor(tx, ctx, inv.branchId) : null;
    if (input.method === "CASH" && !shift) throw new DomainError("errors.openShiftFirst");
    if (shift && shift.currency !== inv.currency) throw new DomainError("errors.currencyMismatch");

    const paymentId = uuidv7();
    await tx.payment.create({
      data: {
        id: paymentId,
        tenantId: ctx.tenant.id,
        invoiceId: inv.id,
        branchId: inv.branchId,
        amountMinor: amount,
        currency: inv.currency,
        method: input.method as PaymentMethod,
        externalRef: input.externalRef,
        idempotencyKey: input.idempotencyKey,
        cashShiftId: shift?.id,
        receivedById: ctx.principal.user.id,
      },
    });
    const paid = inv.paidMinor + amount;
    await tx.invoice.update({ where: { id: inv.id }, data: { paidMinor: paid, status: statusFor(inv.totalMinor, paid) } });
    await auditClinic(tx, ctx, meta, { action: "payment.recorded", entityType: "Invoice", entityId: inv.id, metadata: { paymentId, amountMinor: amount.toString(), currency: inv.currency, method: input.method } });
    return { paymentId, duplicate: false };
  });
}

/**
 * The cashier accepts that the rest of an issued invoice stays as the patient's
 * debt (e.g. the patient pays later). Only then may the desk print the visit's
 * final documents for an unpaid bill. Audited.
 */
export async function approveDebt(ctx: ClinicContext, invoiceId: string, meta: RequestMeta) {
  requirePermission(ctx, "billing.payment");
  await inClinic(ctx, async (tx) => {
    const inv = await lockInvoice(tx, invoiceId);
    assertBranch(ctx, inv.branchId);
    if (inv.status !== "ISSUED" && inv.status !== "PARTIALLY_PAID") throw new DomainError("errors.invoiceNotPayable");
    if (inv.debtApprovedAt) return;
    await tx.invoice.update({ where: { id: inv.id }, data: { debtApprovedAt: new Date(), debtApprovedById: ctx.principal.user.id } });
    await auditClinic(tx, ctx, meta, { action: "invoice.debt_approved", entityType: "Invoice", entityId: inv.id, metadata: { debtMinor: (inv.totalMinor - inv.paidMinor).toString(), currency: inv.currency } });
  });
}

export const refundSchema = z.object({ amount: z.string(), reason: z.enum(REFUND_REASONS), idempotencyKey });

/** Refunds part or all of one payment. Cash refunds come out of the cashier's open shift. */
export async function refundPayment(ctx: ClinicContext, paymentId: string, raw: unknown, meta: RequestMeta) {
  requirePermission(ctx, "billing.refund");
  const input = refundSchema.parse(raw);
  await inClinic(ctx, async (tx) => {
    const dup = await tx.refund.findUnique({ where: { tenantId_idempotencyKey: { tenantId: ctx.tenant.id, idempotencyKey: input.idempotencyKey } } });
    if (dup) return;
    const p0 = await tx.payment.findUnique({ where: { id: uuid.parse(paymentId) } });
    if (!p0) throw new DomainError("errors.notFound");
    const inv = await lockInvoice(tx, p0.invoiceId);
    assertBranch(ctx, inv.branchId);
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: p0.id } });
    const amount = parseMoney(input.amount, payment.currency);
    if (amount === null || amount <= 0n) throw new DomainError("errors.invalidAmount");
    if (amount > payment.amountMinor - payment.refundedMinor) throw new DomainError("errors.refundTooLarge");
    const shift = payment.method === "CASH" ? await openShiftFor(tx, ctx, inv.branchId) : null;
    if (payment.method === "CASH" && !shift) throw new DomainError("errors.openShiftFirst");

    const id = uuidv7();
    await tx.refund.create({ data: { id, tenantId: ctx.tenant.id, paymentId: payment.id, invoiceId: inv.id, amountMinor: amount, reason: input.reason, idempotencyKey: input.idempotencyKey, cashShiftId: shift?.id, createdById: ctx.principal.user.id } });
    await tx.payment.update({ where: { id: payment.id }, data: { refundedMinor: payment.refundedMinor + amount } });
    const paid = inv.paidMinor - amount;
    await tx.invoice.update({ where: { id: inv.id }, data: { paidMinor: paid, status: statusFor(inv.totalMinor, paid) } });
    await auditClinic(tx, ctx, meta, { action: "refund.recorded", entityType: "Invoice", entityId: inv.id, metadata: { paymentId: payment.id, amountMinor: amount.toString(), reason: input.reason } });
  });
}

// ───────────── Reads ─────────────

const invoiceListInclude = {
  patient: { select: { id: true, mrn: true, lastName: true, firstName: true, middleName: true } },
  branch: { select: { name: true } },
} satisfies Prisma.InvoiceInclude;

/** `q`: part of the invoice number, the patient's name or card number (case-insensitive). */
export async function listInvoices(ctx: ClinicContext, opts: { status?: InvoiceStatus; patientId?: string; take?: number; q?: string } = {}) {
  requirePermission(ctx, "billing.read");
  const q = opts.q?.trim().slice(0, 100);
  const like = { contains: q, mode: "insensitive" as const };
  return inClinic(ctx, (tx) =>
    tx.invoice.findMany({
      where: {
        ...(opts.status ? { status: opts.status } : {}),
        ...(q ? { OR: [{ number: like }, { patient: { OR: [{ lastName: like }, { firstName: like }, { mrn: like }] } }] } : {}),
        ...(opts.patientId && uuid.safeParse(opts.patientId).success ? { patientId: opts.patientId } : {}),
        ...(ctx.branchIds ? { branchId: { in: ctx.branchIds } } : {}),
      },
      include: invoiceListInclude,
      orderBy: { createdAt: "desc" },
      take: opts.take ?? 100,
    }),
  );
}

export async function getInvoice(ctx: ClinicContext, invoiceId: string) {
  requirePermission(ctx, "billing.read");
  if (!uuid.safeParse(invoiceId).success) return null;
  return inClinic(ctx, async (tx) => {
    const inv = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        ...invoiceListInclude,
        lines: { orderBy: { createdAt: "asc" } },
        payments: { orderBy: { receivedAt: "asc" }, include: { refunds: { orderBy: { createdAt: "asc" } } } },
        appointment: { select: { startsAt: true, doctor: { select: { membership: { select: { user: { select: { fullName: true } } } } } } } },
      },
    });
    if (!inv || (ctx.branchIds && !ctx.branchIds.includes(inv.branchId))) return null;
    return inv;
  });
}

/** Today's visits that still need an invoice (front-desk / cashier "to bill" list). */
export async function uninvoicedVisits(ctx: ClinicContext) {
  requirePermission(ctx, "billing.invoice");
  const tz = ctx.tenant.timezone;
  const today = instantToLocalDate(new Date(), tz);
  return inClinic(ctx, (tx) =>
    tx.appointment.findMany({
      where: {
        startsAt: { gte: localToInstant(addDays(today, -1), 0, tz), lt: localToInstant(addDays(today, 1), 0, tz) },
        status: { in: ["CHECKED_IN", "IN_PROGRESS", "COMPLETED"] },
        invoice: null,
        ...(ctx.branchIds ? { branchId: { in: ctx.branchIds } } : {}),
      },
      include: {
        patient: { select: { id: true, mrn: true, lastName: true, firstName: true, middleName: true } },
        service: { select: { name: true, priceMinor: true, currency: true } },
        doctor: { select: { membership: { select: { user: { select: { fullName: true } } } } } },
      },
      orderBy: { startsAt: "asc" },
    }),
  );
}
