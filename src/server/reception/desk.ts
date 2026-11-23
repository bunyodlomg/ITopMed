import "server-only";
import { z } from "zod";
import type { InvoiceStatus } from "@/generated/prisma/client";
import { minorToDecimalString, parseMoney } from "@/lib/money";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { addInvoiceLine, createInvoice, issueInvoice, PAYMENT_METHODS, recordPayment } from "../billing/billing";
import { openShift } from "../billing/cash";
import { applyPriceRules } from "../billing/rules";
import { inClinic, requirePermission } from "../clinic/context";
import { recordVitals, VITAL_KINDS } from "../emr/record";
import { DomainError } from "../errors";
import { registerPatient, type DuplicateCandidate } from "../patients/patients";
import { registerWalkIn } from "../appointments/appointments";
import { addDays, localToInstant, todayIn } from "../scheduling/time";
import { uuidv7 } from "../security/crypto";

/**
 * Reception desk ("Qabulxona"): the whole front-desk routine of a small or
 * busy clinic on one screen - patient (found or registered with just a birth
 * year), chosen services with their prices, payment (in full, part, or on
 * debt), optional measurements, the doctor - and the patient gets a queue
 * number. Built on the same services as the separate screens, so every rule
 * (permissions, prices, discounts, cash shifts, audit) applies unchanged.
 */

const uuid = z.uuid();
const checkbox = z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean());
const optionalUuid = z.union([z.literal("").transform(() => undefined), uuid]).optional();

export const billingSchema = z.object({
  serviceIds: z.array(uuid).max(50).default([]),
  /** split = one payment made of several methods (e.g. 200 000 cash + 100 000 card); any rest stays as debt. */
  payMode: z.enum(["full", "partial", "debt", "split"]).default("full"),
  amount: z.string().trim().default(""),
  method: z.enum(PAYMENT_METHODS).default("CASH"),
  /** payMode "split": the amount paid with each method (empty = not used). */
  split: z.partialRecord(z.enum(PAYMENT_METHODS), z.string().trim().max(30)).default({}),
  /** Free follow-up outside the free period (exception; needs billing.free_visit and a reason). */
  freeVisit: checkbox.default(false),
  freeVisitReason: z.string().trim().max(200, "validation.tooLong").default(""),
});

export const deskSchema = billingSchema.extend({
  patientId: optionalUuid,
  doctorProfileId: uuid,
  branchId: uuid,
  adminNote: z.string().trim().max(200, "validation.tooLong").default(""),
  confirmNotDuplicate: checkbox.default(false),
});

export type DeskResult =
  | { ok: true; appointmentId: string; patientId: string; queueNumber: number | null; invoiceId: string | null; vitalsSaved: boolean }
  | { ok: false; duplicates: DuplicateCandidate[]; blocking: boolean };

/** Priced, active services by id, in the order chosen. */
async function loadPricedServices(ctx: ClinicContext, ids: string[]) {
  if (!ids.length) return [];
  const rows = await inClinic(ctx, (tx) => tx.service.findMany({ where: { id: { in: ids }, archivedAt: null }, select: { id: true, name: true, priceMinor: true, currency: true } }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const list = [...new Set(ids)].map((id) => byId.get(id));
  if (list.some((s) => !s)) throw new DomainError("errors.notFound");
  if (list.some((s) => s!.priceMinor === 0n)) throw new DomainError("errors.servicePriceNotSet");
  return list as NonNullable<(typeof list)[number]>[];
}

type PaymentMethodKey = (typeof PAYMENT_METHODS)[number];

/** The parts of a split payment by method, in catalogue order; at least one, each above zero. */
function splitParts(input: z.infer<typeof billingSchema>, currency: string): { method: PaymentMethodKey; minor: bigint }[] {
  const parts: { method: PaymentMethodKey; minor: bigint }[] = [];
  for (const method of PAYMENT_METHODS) {
    const text = input.split[method] ?? "";
    if (!text) continue;
    const minor = parseMoney(text, currency);
    if (minor === null || minor < 0n) throw new DomainError("errors.invalidAmount");
    if (minor > 0n) parts.push({ method, minor });
  }
  if (!parts.length) throw new DomainError("errors.invalidAmount");
  return parts;
}

/** How much is paid now, validated against the total before anything is written. */
function amountToPay(input: z.infer<typeof billingSchema>, total: bigint, currency: string): bigint {
  if (input.payMode === "debt") return 0n;
  if (input.payMode === "full") return total;
  const a = input.payMode === "split" ? splitParts(input, currency).reduce((s, p) => s + p.minor, 0n) : parseMoney(input.amount, currency);
  if (a === null || a <= 0n) throw new DomainError("errors.invalidAmount");
  if (a > total) throw new DomainError("errors.overpayment");
  return a;
}

/**
 * The payments to record for an invoice of `total` (after clinic discounts):
 * one per method. If a discount made the bill smaller than what was handed
 * over, the excess comes off the cash part first (change is given in cash),
 * then off the other parts in catalogue order.
 */
function paymentsFor(input: z.infer<typeof billingSchema>, total: bigint, currency: string): { method: PaymentMethodKey; minor: bigint }[] {
  if (total <= 0n || input.payMode === "debt") return [];
  if (input.payMode === "full") return [{ method: input.method, minor: total }];
  if (input.payMode === "partial") return [{ method: input.method, minor: minBig(amountToPay(input, total * 1000n, currency), total) }];
  const parts = splitParts(input, currency);
  let excess = parts.reduce((s, p) => s + p.minor, 0n) - total;
  const order = [...parts.filter((p) => p.method === "CASH"), ...parts.filter((p) => p.method !== "CASH")];
  for (const p of order) {
    if (excess <= 0n) break;
    const cut = minBig(p.minor, excess);
    p.minor -= cut;
    excess -= cut;
  }
  return parts.filter((p) => p.minor > 0n);
}

/**
 * One invoice for the chosen services, issued at once, with the payment now
 * (or none: the rest is the patient's debt). Cash needs an open cash shift:
 * if the person has none yet, it is opened for them with an empty drawer.
 */
async function billServices(
  ctx: ClinicContext,
  a: { patientId: string; branchId: string; appointmentId?: string; billing: z.infer<typeof billingSchema>; services: Awaited<ReturnType<typeof loadPricedServices>> },
  meta: RequestMeta,
): Promise<string | null> {
  if (!a.services.length) return null;
  const currency = a.services[0]!.currency;
  if (a.services.some((s) => s.currency !== currency)) throw new DomainError("errors.currencyMismatch");

  const invoiceId = await createInvoice(ctx, { patientId: a.patientId, branchId: a.branchId, appointmentId: a.appointmentId ?? "" }, meta);
  // createInvoice copies the appointment's own service; add the rest.
  const already = await inClinic(ctx, (tx) => tx.invoiceLine.findMany({ where: { invoiceId }, select: { serviceId: true } }));
  const have = new Set(already.map((l) => l.serviceId));
  for (const s of a.services) if (!have.has(s.id)) await addInvoiceLine(ctx, invoiceId, { serviceId: s.id, quantity: "1" }, meta);
  // Clinic rules (benefit category, package, free follow-up) before the invoice is issued.
  await applyPriceRules(ctx, invoiceId, a.billing.freeVisit ? { freeVisit: { reason: a.billing.freeVisitReason } } : {}, meta);
  const total = (await inClinic(ctx, (tx) => tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { totalMinor: true } }))).totalMinor;
  // The amount was checked against the full price before anything was written; after a
  // rule discount it can exceed the new total - then the total is what is paid.
  const payments = paymentsFor(a.billing, total, currency);
  await issueInvoice(ctx, invoiceId, meta);

  for (const p of payments) {
    if (p.method === "CASH" && ctx.permissions.has("cash.shift")) {
      const open = await inClinic(ctx, (tx) => tx.cashShift.findFirst({ where: { branchId: a.branchId, cashierId: ctx.principal.user.id, status: "OPEN" }, select: { id: true } }));
      if (!open) await openShift(ctx, { branchId: a.branchId, openingFloat: "0", currency }, meta);
    }
    await recordPayment(ctx, invoiceId, { amount: minorToDecimalString(p.minor, currency), method: p.method, idempotencyKey: uuidv7() }, meta);
  }
  return invoiceId;
}

export async function deskCheckIn(ctx: ClinicContext, raw: Record<string, unknown>, meta: RequestMeta): Promise<DeskResult> {
  requirePermission(ctx, "queue.manage", "appointments.manage");
  const input = deskSchema.parse(raw);
  if (input.serviceIds.length) {
    requirePermission(ctx, "billing.invoice");
    if (input.payMode !== "debt") requirePermission(ctx, "billing.payment");
  }
  // Everything that can be refused is checked before the first write.
  const services = await loadPricedServices(ctx, input.serviceIds);
  if (services.length) amountToPay(input, services.reduce((s, x) => s + x.priceMinor, 0n), services[0]!.currency);

  let patientId = input.patientId;
  if (!patientId) {
    const r = await registerPatient(ctx, raw, { confirmNotDuplicate: input.confirmNotDuplicate }, meta);
    if (!r.ok) return r;
    patientId = r.id;
  }

  const appointmentId = await registerWalkIn(ctx, { patientId, doctorProfileId: input.doctorProfileId, branchId: input.branchId, serviceId: services[0]?.id ?? "", adminNote: input.adminNote }, meta);

  let vitalsSaved = false;
  const vitals = Object.fromEntries(VITAL_KINDS.map((k) => [k, String(raw[k] ?? "")] as const).filter(([, v]) => v.trim() !== ""));
  if (Object.keys(vitals).length && ctx.permissions.has("vitals.write")) {
    try {
      await recordVitals(ctx, patientId, vitals, meta);
      vitalsSaved = true;
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
    }
  }

  const invoiceId = await billServices(ctx, { patientId, branchId: input.branchId, appointmentId, billing: input, services }, meta);
  const queueNumber = (await inClinic(ctx, (tx) => tx.appointment.findUnique({ where: { id: appointmentId }, select: { queueNumber: true } })))?.queueNumber ?? null;
  return { ok: true, appointmentId, patientId, queueNumber, invoiceId, vitalsSaved };
}

export const extraServicesSchema = billingSchema.extend({ patientId: uuid, branchId: uuid, appointmentId: optionalUuid });

/**
 * Extra services during or after the visit (e.g. the doctor decides on an echo
 * or ECG): a separate invoice, paid now or left as the patient's debt. If the
 * visit has no invoice yet, this one is attached to it.
 */
export async function addExtraServices(ctx: ClinicContext, raw: Record<string, unknown>, meta: RequestMeta): Promise<string> {
  requirePermission(ctx, "billing.invoice");
  const input = extraServicesSchema.parse(raw);
  if (input.payMode !== "debt") requirePermission(ctx, "billing.payment");
  const services = await loadPricedServices(ctx, input.serviceIds);
  if (!services.length) throw new DomainError("errors.noServicesChosen");
  const attach = input.appointmentId
    ? await inClinic(ctx, (tx) => tx.invoice.findUnique({ where: { appointmentId: input.appointmentId! }, select: { id: true } })).then((x) => (x ? undefined : input.appointmentId))
    : undefined;
  return (await billServices(ctx, { patientId: input.patientId, branchId: input.branchId, appointmentId: attach, billing: input, services }, meta))!;
}

export const payDebtSchema = z.object({
  patientId: uuid,
  amount: z.string().trim().default(""),
  method: z.enum(PAYMENT_METHODS).default("CASH"),
});

/**
 * Takes the patient's debt in one step at the desk: the amount (default: all of
 * it) is spread over the open invoices, oldest first, as ordinary payments -
 * so receipts, cash shift and audit work as for any payment. Cash opens the
 * cashier's shift if needed. Returns what was paid and what is still owed.
 */
export async function payPatientDebt(ctx: ClinicContext, raw: Record<string, unknown>, meta: RequestMeta): Promise<{ paidMinor: bigint; leftMinor: bigint; invoiceIds: string[] }> {
  requirePermission(ctx, "billing.payment");
  const input = payDebtSchema.parse(raw);
  const open = await inClinic(ctx, (tx) =>
    tx.invoice.findMany({
      where: { patientId: input.patientId, status: { in: ["ISSUED", "PARTIALLY_PAID"] }, ...(ctx.branchIds ? { branchId: { in: ctx.branchIds } } : {}) },
      select: { id: true, branchId: true, totalMinor: true, paidMinor: true, currency: true },
      orderBy: { issuedAt: "asc" },
    }),
  );
  if (!open.length) throw new DomainError("errors.noDebt");
  const currency = open[0]!.currency;
  if (open.some((i) => i.currency !== currency)) throw new DomainError("errors.currencyMismatch");
  const owed = open.reduce((s, i) => s + (i.totalMinor - i.paidMinor), 0n);
  const amount = input.amount ? parseMoney(input.amount, currency) : owed;
  if (amount === null || amount <= 0n) throw new DomainError("errors.invalidAmount");
  if (amount > owed) throw new DomainError("errors.overpayment");

  let left = amount;
  const paidOn: string[] = [];
  for (const inv of open) {
    if (left === 0n) break;
    const part = inv.totalMinor - inv.paidMinor < left ? inv.totalMinor - inv.paidMinor : left;
    if (part <= 0n) continue;
    if (input.method === "CASH" && ctx.permissions.has("cash.shift")) {
      const shift = await inClinic(ctx, (tx) => tx.cashShift.findFirst({ where: { branchId: inv.branchId, cashierId: ctx.principal.user.id, status: "OPEN" }, select: { id: true } }));
      if (!shift) await openShift(ctx, { branchId: inv.branchId, openingFloat: "0", currency }, meta);
    }
    await recordPayment(ctx, inv.id, { amount: minorToDecimalString(part, currency), method: input.method, idempotencyKey: uuidv7() }, meta);
    paidOn.push(inv.id);
    left -= part;
  }
  return { paidMinor: amount, leftMinor: owed - amount, invoiceIds: paidOn };
}

export interface MoneyStatus {
  totalMinor: bigint;
  paidMinor: bigint;
  currency: string;
  services: string[];
}

const OPEN: InvoiceStatus[] = ["ISSUED", "PARTIALLY_PAID", "PAID"];

/**
 * For today's queue (desk and doctor): what each visit's patient chose and
 * paid today, and their total unpaid debt. Requires billing.read.
 */
export async function todayMoney(ctx: ClinicContext, patientIds: string[]): Promise<{ today: Map<string, MoneyStatus>; debt: Map<string, bigint> }> {
  const today = new Map<string, MoneyStatus>();
  const debt = new Map<string, bigint>();
  if (!ctx.permissions.has("billing.read") || !patientIds.length) return { today, debt };
  const day = todayIn(ctx.tenant.timezone);
  const from = localToInstant(day, 0, ctx.tenant.timezone);
  const to = localToInstant(addDays(day, 1), 0, ctx.tenant.timezone);
  const invoices = await inClinic(ctx, (tx) =>
    tx.invoice.findMany({
      where: { patientId: { in: patientIds }, status: { in: OPEN }, ...(ctx.branchIds ? { branchId: { in: ctx.branchIds } } : {}) },
      select: { patientId: true, totalMinor: true, paidMinor: true, currency: true, issuedAt: true, lines: { select: { description: true } } },
    }),
  );
  for (const i of invoices) {
    debt.set(i.patientId, (debt.get(i.patientId) ?? 0n) + (i.totalMinor - i.paidMinor));
    if (i.issuedAt && i.issuedAt >= from && i.issuedAt < to) {
      const m = today.get(i.patientId) ?? { totalMinor: 0n, paidMinor: 0n, currency: i.currency, services: [] };
      m.totalMinor += i.totalMinor;
      m.paidMinor += i.paidMinor;
      m.services.push(...i.lines.map((l) => l.description));
      today.set(i.patientId, m);
    }
  }
  return { today, debt };
}

export interface VitalsSummary {
  systolic?: string;
  diastolic?: string;
  pulse?: string;
  weight?: string;
  height?: string;
  measuredAt: Date;
}

/**
 * Latest measurements of today's patients, for the doctor before the patient
 * comes in. Only for people with clinical access (emr.read) and only for the
 * patients in the given (own) queue.
 */
export async function todayVitals(ctx: ClinicContext, patientIds: string[]): Promise<Map<string, VitalsSummary>> {
  const out = new Map<string, VitalsSummary>();
  if (!ctx.permissions.has("emr.read") || !patientIds.length) return out;
  const day = todayIn(ctx.tenant.timezone);
  const rows = await inClinic(ctx, (tx) =>
    tx.vitalSign.findMany({
      where: { patientId: { in: patientIds }, measuredAt: { gte: localToInstant(day, 0, ctx.tenant.timezone) }, kind: { in: ["SYSTOLIC_BP", "DIASTOLIC_BP", "HEART_RATE", "WEIGHT", "HEIGHT"] } },
      orderBy: { measuredAt: "asc" },
      select: { patientId: true, kind: true, value: true, measuredAt: true },
    }),
  );
  const key = { SYSTOLIC_BP: "systolic", DIASTOLIC_BP: "diastolic", HEART_RATE: "pulse", WEIGHT: "weight", HEIGHT: "height" } as const;
  for (const r of rows) {
    const s = out.get(r.patientId) ?? { measuredAt: r.measuredAt };
    s[key[r.kind as keyof typeof key]] = r.value.toString().replace(/\.0+$|(\.\d*?)0+$/, "$1");
    s.measuredAt = r.measuredAt;
    out.set(r.patientId, s);
  }
  return out;
}

export interface IncomeSummary {
  currency: string;
  days: { date: string; amountMinor: bigint }[];
  todayMinor: bigint;
  weekMinor: bigint;
  debtMinor: bigint;
}

/**
 * Money at a glance (home page): payments minus refunds per local day for the
 * last 14 days, today, 7 days, and what patients still owe. billing.read only.
 */
export async function incomeSummary(ctx: ClinicContext, days = 14): Promise<IncomeSummary | null> {
  if (!ctx.permissions.has("billing.read")) return null;
  const tz = ctx.tenant.timezone;
  const today = todayIn(tz);
  const first = addDays(today, -(days - 1));
  const from = localToInstant(first, 0, tz);
  const branch = ctx.branchIds;
  return inClinic(ctx, async (tx) => {
    const pays = await tx.payment.findMany({ where: { receivedAt: { gte: from }, ...(branch ? { branchId: { in: branch } } : {}) }, select: { receivedAt: true, amountMinor: true } });
    const refunds = await tx.refund.findMany({ where: { createdAt: { gte: from }, ...(branch ? { invoice: { branchId: { in: branch } } } : {}) }, select: { createdAt: true, amountMinor: true } });
    const open = await tx.invoice.findMany({ where: { status: { in: ["ISSUED", "PARTIALLY_PAID"] }, ...(branch ? { branchId: { in: branch } } : {}) }, select: { totalMinor: true, paidMinor: true } });
    const byDay = new Map<string, bigint>();
    for (let i = 0; i < days; i++) byDay.set(addDays(first, i), 0n);
    const local = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    for (const p of pays) byDay.set(local(p.receivedAt), (byDay.get(local(p.receivedAt)) ?? 0n) + p.amountMinor);
    for (const r of refunds) byDay.set(local(r.createdAt), (byDay.get(local(r.createdAt)) ?? 0n) - r.amountMinor);
    const list = [...byDay.entries()].filter(([d]) => d >= first && d <= today).map(([date, amountMinor]) => ({ date, amountMinor }));
    const weekFrom = addDays(today, -6);
    return {
      currency: ctx.tenant.currency,
      days: list,
      todayMinor: byDay.get(today) ?? 0n,
      weekMinor: list.filter((d) => d.date >= weekFrom).reduce((s, d) => s + d.amountMinor, 0n),
      debtMinor: open.reduce((s, i) => s + (i.totalMinor - i.paidMinor), 0n),
    };
  });
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
