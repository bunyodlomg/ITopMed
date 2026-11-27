import "server-only";
import { z } from "zod";
import type { InvoiceStatus } from "@/generated/prisma/client";
import { minorToDecimalString, parseMoney } from "@/lib/money";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { addInvoiceLine, approveDebt, createInvoice, issueInvoice, PAYMENT_METHODS, recordPayment } from "../billing/billing";
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
 *
 * Without billing.invoice, billing.charge (doctors, nurses, lab) may only put
 * services on the bill as unpaid, at the catalogue price: the patient pays all
 * of it at the cashier before leaving (see patientAccount / payPatientDebt).
 */
export async function addExtraServices(ctx: ClinicContext, raw: Record<string, unknown>, meta: RequestMeta): Promise<string> {
  requirePermission(ctx, "billing.invoice", "billing.charge");
  const parsed = extraServicesSchema.parse(raw);
  const chargeOnly = !ctx.permissions.has("billing.invoice");
  const input = chargeOnly ? { ...parsed, payMode: "debt" as const, freeVisit: false } : parsed;
  if (input.payMode !== "debt") requirePermission(ctx, "billing.payment");
  const services = await loadPricedServices(ctx, input.serviceIds);
  if (!services.length) throw new DomainError("errors.noServicesChosen");
  await assertActivePatient(ctx, input.patientId);
  const attach = input.appointmentId
    ? await inClinic(ctx, (tx) => tx.invoice.findUnique({ where: { appointmentId: input.appointmentId! }, select: { id: true } })).then((x) => (x ? undefined : input.appointmentId))
    : undefined;
  return (await billServices(ctx, { patientId: input.patientId, branchId: input.branchId, appointmentId: attach, billing: input, services }, meta))!;
}

async function assertActivePatient(ctx: ClinicContext, patientId: string) {
  const p = await inClinic(ctx, (tx) => tx.patient.findUnique({ where: { id: patientId }, select: { status: true } }));
  if (!p || p.status !== "ACTIVE") throw new DomainError("errors.notFound");
}

/**
 * Services the patient already has on a bill today (any open or paid invoice),
 * so an order does not charge twice what the desk billed at check-in.
 */
export async function servicesBilledToday(ctx: ClinicContext, patientId: string): Promise<Set<string>> {
  requirePermission(ctx, "billing.invoice", "billing.charge", "billing.read");
  const day = todayIn(ctx.tenant.timezone);
  const lines = await inClinic(ctx, (tx) =>
    tx.invoiceLine.findMany({
      where: { invoice: { patientId, status: { in: ["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID"] }, createdAt: { gte: localToInstant(day, 0, ctx.tenant.timezone) } }, serviceId: { not: null } },
      select: { serviceId: true },
    }),
  );
  return new Set(lines.map((l) => l.serviceId!));
}

/**
 * Puts ordered services (e.g. the lab tests a doctor orders) on the patient's
 * bill as unpaid: skips services without a price and those already billed
 * today. Returns the invoice id, or null when nothing was left to charge.
 */
export async function chargeOrderedServices(ctx: ClinicContext, a: { patientId: string; branchId: string; serviceIds: string[] }, meta: RequestMeta): Promise<string | null> {
  if (!ctx.permissions.has("billing.charge") && !ctx.permissions.has("billing.invoice")) return null;
  const billed = await servicesBilledToday(ctx, a.patientId);
  const ids = [...new Set(a.serviceIds)].filter((id) => !billed.has(id));
  if (!ids.length) return null;
  const priced = await inClinic(ctx, (tx) => tx.service.findMany({ where: { id: { in: ids }, archivedAt: null, priceMinor: { gt: 0n } }, select: { id: true } }));
  if (!priced.length) return null;
  const keep = new Set(priced.map((p) => p.id));
  return addExtraServices(ctx, { patientId: a.patientId, branchId: a.branchId, serviceIds: ids.filter((id) => keep.has(id)), payMode: "debt" }, meta);
}

export const payDebtSchema = z.object({
  patientId: uuid,
  /** "all" (default) / "partial" (amount) / "split" (several methods at once, e.g. cash + card). */
  payMode: z.enum(["all", "partial", "split"]).default("all"),
  amount: z.string().trim().default(""),
  method: z.enum(PAYMENT_METHODS).default("CASH"),
  split: z.partialRecord(z.enum(PAYMENT_METHODS), z.string().trim().max(30)).default({}),
});

/**
 * Takes the patient's debt in one step at the cashier: the amount (default: all
 * of it) is spread over the open invoices, oldest first, as ordinary payments -
 * so receipts, cash shift and audit work as for any payment. A split payment
 * (e.g. 200 000 cash + 100 000 card) is spread method by method. Cash opens
 * the cashier's shift if needed. Returns what was paid and what is still owed.
 */
export async function payPatientDebt(ctx: ClinicContext, raw: Record<string, unknown>, meta: RequestMeta): Promise<{ paidMinor: bigint; leftMinor: bigint; invoiceIds: string[] }> {
  requirePermission(ctx, "billing.payment");
  const input = payDebtSchema.parse(raw);
  const payMode = input.payMode === "all" && input.amount ? "partial" : input.payMode;
  const open = await openInvoices(ctx, input.patientId);
  if (!open.length) throw new DomainError("errors.noDebt");
  const currency = open[0]!.currency;
  if (open.some((i) => i.currency !== currency)) throw new DomainError("errors.currencyMismatch");
  const owed = open.reduce((s, i) => s + (i.totalMinor - i.paidMinor), 0n);

  let parts: { method: PaymentMethodKey; minor: bigint }[];
  if (payMode === "split") parts = splitParts(billingSchema.parse({ split: input.split }), currency);
  else {
    const amount = payMode === "partial" ? parseMoney(input.amount, currency) : owed;
    if (amount === null || amount <= 0n) throw new DomainError("errors.invalidAmount");
    parts = [{ method: input.method, minor: amount }];
  }
  const amount = parts.reduce((s, p) => s + p.minor, 0n);
  if (amount > owed) throw new DomainError("errors.overpayment");

  const rest = new Map(open.map((i) => [i.id, i.totalMinor - i.paidMinor]));
  const paidOn = new Set<string>();
  for (const p of parts) {
    let left = p.minor;
    for (const inv of open) {
      if (left === 0n) break;
      const part = minBig(rest.get(inv.id)!, left);
      if (part <= 0n) continue;
      if (p.method === "CASH" && ctx.permissions.has("cash.shift")) {
        const shift = await inClinic(ctx, (tx) => tx.cashShift.findFirst({ where: { branchId: inv.branchId, cashierId: ctx.principal.user.id, status: "OPEN" }, select: { id: true } }));
        if (!shift) await openShift(ctx, { branchId: inv.branchId, openingFloat: "0", currency }, meta);
      }
      await recordPayment(ctx, inv.id, { amount: minorToDecimalString(part, currency), method: p.method, idempotencyKey: uuidv7() }, meta);
      rest.set(inv.id, rest.get(inv.id)! - part);
      paidOn.add(inv.id);
      left -= part;
    }
  }
  return { paidMinor: amount, leftMinor: owed - amount, invoiceIds: [...paidOn] };
}

function openInvoices(ctx: ClinicContext, patientId: string) {
  return inClinic(ctx, (tx) =>
    tx.invoice.findMany({
      where: { patientId, status: { in: ["ISSUED", "PARTIALLY_PAID"] }, ...(ctx.branchIds ? { branchId: { in: ctx.branchIds } } : {}) },
      select: { id: true, branchId: true, totalMinor: true, paidMinor: true, currency: true, debtApprovedAt: true },
      orderBy: [{ issuedAt: "asc" }, { id: "asc" }],
    }),
  );
}

/**
 * The cashier lets the patient leave owing the rest: every open invoice is
 * marked "debt approved" (audited per invoice), which also opens the desk's
 * printing of the visit papers. Returns how many invoices were newly approved.
 */
export async function approvePatientDebt(ctx: ClinicContext, patientId: string, meta: RequestMeta): Promise<number> {
  requirePermission(ctx, "billing.payment");
  if (!uuid.safeParse(patientId).success) throw new DomainError("errors.notFound");
  const open = await openInvoices(ctx, patientId);
  if (!open.length) throw new DomainError("errors.noDebt");
  const fresh = open.filter((i) => !i.debtApprovedAt);
  for (const inv of fresh) await approveDebt(ctx, inv.id, meta);
  return fresh.length;
}

export interface AccountLine {
  invoiceId: string;
  invoiceNumber: string | null;
  description: string;
  quantity: number;
  totalMinor: bigint;
  discountMinor: bigint;
  /** Who put it on the bill (desk, doctor, lab…), null if unknown. */
  addedBy: string | null;
  addedAt: Date;
}

export interface PatientAccount {
  patient: { id: string; mrn: string; lastName: string; firstName: string; middleName: string | null; phone: string | null };
  currency: string;
  /** Unpaid invoices, oldest first, with their lines. */
  open: { id: string; number: string | null; issuedAt: Date | null; totalMinor: bigint; paidMinor: bigint; debtApproved: boolean; lines: AccountLine[] }[];
  owedMinor: bigint;
  /** Today's payments of this patient (for the combined receipt). */
  paidToday: { invoiceId: string; invoiceNumber: string | null; method: string; amountMinor: bigint; receivedAt: Date }[];
  /** The services of the invoices paid on today. */
  paidTodayLines: AccountLine[];
}

/**
 * The cashier's view of one patient: every unpaid service, whoever added it
 * (desk, doctor, nurse, lab), the total owed, and what was paid today.
 * Money and service names only - no clinical content.
 */
export async function patientAccount(ctx: ClinicContext, patientId: string): Promise<PatientAccount | null> {
  requirePermission(ctx, "billing.read");
  if (!uuid.safeParse(patientId).success) return null;
  const tz = ctx.tenant.timezone;
  const from = localToInstant(todayIn(tz), 0, tz);
  const branch = ctx.branchIds ? { branchId: { in: ctx.branchIds } } : {};
  return inClinic(ctx, async (tx) => {
    const patient = await tx.patient.findUnique({ where: { id: patientId }, select: { id: true, mrn: true, lastName: true, firstName: true, middleName: true, phone: true, status: true } });
    if (!patient || patient.status !== "ACTIVE") return null;
    const lineSelect = { id: true, description: true, quantity: true, totalMinor: true, discountMinor: true, createdById: true, createdAt: true } as const;
    const open = await tx.invoice.findMany({
      where: { patientId, status: { in: ["ISSUED", "PARTIALLY_PAID"] }, ...branch },
      select: { id: true, number: true, issuedAt: true, totalMinor: true, paidMinor: true, currency: true, createdById: true, debtApprovedAt: true, lines: { select: lineSelect, orderBy: { createdAt: "asc" } } },
      orderBy: [{ issuedAt: "asc" }, { id: "asc" }],
    });
    const pays = await tx.payment.findMany({
      where: { invoice: { patientId, ...branch }, receivedAt: { gte: from } },
      select: { invoiceId: true, method: true, amountMinor: true, refundedMinor: true, receivedAt: true, invoice: { select: { number: true } } },
      orderBy: { receivedAt: "asc" },
    });
    const paidIds = [...new Set(pays.map((p) => p.invoiceId))];
    const paidInvoices = paidIds.length
      ? await tx.invoice.findMany({ where: { id: { in: paidIds } }, select: { id: true, number: true, createdById: true, lines: { select: lineSelect, orderBy: { createdAt: "asc" } } }, orderBy: [{ issuedAt: "asc" }, { id: "asc" }] })
      : [];
    const userIds = [...new Set([...open, ...paidInvoices].flatMap((i) => [i.createdById, ...i.lines.map((l) => l.createdById)]).filter((x): x is string => Boolean(x)))];
    // Co-members only (RLS on User): the names of the staff who added the services.
    const users = userIds.length ? await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } }) : [];
    const name = new Map(users.map((u) => [u.id, u.fullName]));
    const toLine = (inv: { id: string; number: string | null; createdById: string }, l: { description: string; quantity: number; totalMinor: bigint; discountMinor: bigint; createdById: string | null; createdAt: Date }): AccountLine => ({
      invoiceId: inv.id,
      invoiceNumber: inv.number,
      description: l.description,
      quantity: l.quantity,
      totalMinor: l.totalMinor,
      discountMinor: l.discountMinor,
      addedBy: name.get(l.createdById ?? inv.createdById) ?? null,
      addedAt: l.createdAt,
    });
    return {
      patient: { id: patient.id, mrn: patient.mrn, lastName: patient.lastName, firstName: patient.firstName, middleName: patient.middleName, phone: patient.phone },
      currency: open[0]?.currency ?? ctx.tenant.currency,
      open: open.map((i) => ({ id: i.id, number: i.number, issuedAt: i.issuedAt, totalMinor: i.totalMinor, paidMinor: i.paidMinor, debtApproved: Boolean(i.debtApprovedAt), lines: i.lines.map((l) => toLine(i, l)) })),
      owedMinor: open.reduce((s, i) => s + (i.totalMinor - i.paidMinor), 0n),
      paidToday: pays.map((p) => ({ invoiceId: p.invoiceId, invoiceNumber: p.invoice.number, method: p.method, amountMinor: p.amountMinor - p.refundedMinor, receivedAt: p.receivedAt })),
      paidTodayLines: paidInvoices.flatMap((i) => i.lines.map((l) => toLine(i, l))),
    };
  });
}

export interface Debtor {
  patient: { id: string; mrn: string; lastName: string; firstName: string; middleName: string | null };
  owedMinor: bigint;
  currency: string;
  /** Number of unpaid services. */
  lines: number;
  /** Newest unpaid bill. */
  lastAt: Date;
  /** Billed today: the patient is probably still in the building. */
  today: boolean;
  /** The cashier already let the patient leave owing (every open bill approved). */
  approved: boolean;
}

/**
 * Patients who owe money, for the cashier: today's first (they are still in
 * the building), then older debts. `q` filters by name, card number or phone.
 */
export async function listDebtors(ctx: ClinicContext, opts: { q?: string; take?: number } = {}): Promise<Debtor[]> {
  requirePermission(ctx, "billing.read");
  const tz = ctx.tenant.timezone;
  const from = localToInstant(todayIn(tz), 0, tz);
  const q = opts.q?.trim().slice(0, 100);
  const like = { contains: q, mode: "insensitive" as const };
  const rows = await inClinic(ctx, (tx) =>
    tx.invoice.findMany({
      where: {
        status: { in: ["ISSUED", "PARTIALLY_PAID"] },
        ...(ctx.branchIds ? { branchId: { in: ctx.branchIds } } : {}),
        ...(q ? { patient: { OR: [{ lastName: like }, { firstName: like }, { mrn: like }, { phone: like }] } } : {}),
      },
      select: {
        totalMinor: true,
        paidMinor: true,
        currency: true,
        issuedAt: true,
        createdAt: true,
        debtApprovedAt: true,
        _count: { select: { lines: true } },
        patient: { select: { id: true, mrn: true, lastName: true, firstName: true, middleName: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 2000,
    }),
  );
  const by = new Map<string, Debtor>();
  for (const r of rows) {
    const at = r.issuedAt ?? r.createdAt;
    const d = by.get(r.patient.id) ?? { patient: r.patient, owedMinor: 0n, currency: r.currency, lines: 0, lastAt: at, today: false, approved: true };
    d.owedMinor += r.totalMinor - r.paidMinor;
    d.lines += r._count.lines;
    if (at > d.lastAt) d.lastAt = at;
    d.today ||= at >= from;
    d.approved &&= Boolean(r.debtApprovedAt);
    by.set(r.patient.id, d);
  }
  return [...by.values()]
    .filter((d) => d.owedMinor > 0n)
    .sort((a, b) => Number(b.today) - Number(a.today) || Number(a.approved) - Number(b.approved) || +b.lastAt - +a.lastAt)
    .slice(0, opts.take ?? 200);
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
  // billing.charge: the doctor who adds services sees what is on today's bill and what is owed.
  if ((!ctx.permissions.has("billing.read") && !ctx.permissions.has("billing.charge")) || !patientIds.length) return { today, debt };
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
