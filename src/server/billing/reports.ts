import "server-only";
import type { ClinicContext } from "../auth/clinic-auth";
import { DomainError } from "../tenancy/provisioning";
import { inClinic } from "../clinic/context";
import { addDays, isLocalDate, localToInstant } from "../scheduling/time";

/**
 * Clinic reports. All money sums are computed in SQL on BigInt minor units,
 * grouped by currency (never mixed). Days are the clinic's local calendar days.
 * Only aggregates and administrative data — no clinical content.
 */
export interface Money {
  currency: string;
  minor: bigint;
}

export interface FinancialReport {
  from: string;
  to: string;
  byDay: { day: string; currency: string; received: bigint; refunded: bigint }[];
  byMethod: { method: string; currency: string; net: bigint; count: number }[];
  /** Net payments per local day and method (refunds counted on the payment's day and method). */
  byDayMethod: { day: string; method: string; currency: string; net: bigint }[];
  /** Who took the money: one row per staff member, net of refunds, split by payment method. */
  byCashier: { cashier: string; currency: string; net: bigint; count: number; methods: { method: string; net: bigint }[] }[];
  byService: { service: string; currency: string; amount: bigint; quantity: number }[];
  byDoctor: { doctor: string; currency: string; amount: bigint; invoices: number }[];
  totals: { currency: string; invoiced: bigint; received: bigint; refunded: bigint; expenses: bigint; outstanding: bigint }[];
  debtors: { invoiceId: string; number: string | null; patient: string; mrn: string; currency: string; outstanding: bigint; issuedAt: Date | null }[];
  expensesByCategory: { category: string; currency: string; amount: bigint }[];
}

function range(ctx: ClinicContext, from: string, to: string) {
  if (!isLocalDate(from) || !isLocalDate(to) || from > to) throw new DomainError("errors.invalidInput");
  const tz = ctx.tenant.timezone;
  return { tz, start: localToInstant(from, 0, tz), end: localToInstant(addDays(to, 1), 0, tz) };
}


export async function financialReport(ctx: ClinicContext, from: string, to: string): Promise<FinancialReport> {
  if (!ctx.permissions.has("finance.reports")) throw new DomainError("errors.forbidden");
  const { tz, start, end } = range(ctx, from, to);
  const scoped = ctx.branchIds ?? null;
  return inClinic(ctx, async (tx) => {
    const byDay = await tx.$queryRaw<{ day: string; currency: string; received: bigint; refunded: bigint }[]>`
      WITH p AS (
        SELECT to_char(("receivedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, currency, "amountMinor" AS amt
        FROM "Payment" WHERE "receivedAt" >= ${start} AND "receivedAt" < ${end}
          AND (${scoped}::uuid[] IS NULL OR "branchId" = ANY(${scoped}::uuid[]))
      ), r AS (
        SELECT to_char((rf."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, pm.currency, rf."amountMinor" AS amt
        FROM "Refund" rf JOIN "Payment" pm ON pm.id = rf."paymentId"
        WHERE rf."createdAt" >= ${start} AND rf."createdAt" < ${end}
          AND (${scoped}::uuid[] IS NULL OR pm."branchId" = ANY(${scoped}::uuid[]))
      )
      SELECT day, currency, COALESCE(sum(received), 0)::bigint AS received, COALESCE(sum(refunded), 0)::bigint AS refunded FROM (
        SELECT day, currency, amt AS received, 0::bigint AS refunded FROM p
        UNION ALL SELECT day, currency, 0::bigint, amt FROM r
      ) x GROUP BY day, currency ORDER BY day`;

    const byMethod = await tx.$queryRaw<{ method: string; currency: string; net: bigint; count: number }[]>`
      SELECT method::text AS method, currency, (sum("amountMinor") - sum("refundedMinor"))::bigint AS net, count(*)::int AS count
      FROM "Payment" WHERE "receivedAt" >= ${start} AND "receivedAt" < ${end}
        AND (${scoped}::uuid[] IS NULL OR "branchId" = ANY(${scoped}::uuid[]))
      GROUP BY method, currency ORDER BY net DESC`;

    const byDayMethod = await tx.$queryRaw<{ day: string; method: string; currency: string; net: bigint }[]>`
      SELECT to_char(("receivedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, method::text AS method, currency,
             (sum("amountMinor") - sum("refundedMinor"))::bigint AS net
      FROM "Payment" WHERE "receivedAt" >= ${start} AND "receivedAt" < ${end}
        AND (${scoped}::uuid[] IS NULL OR "branchId" = ANY(${scoped}::uuid[]))
      GROUP BY 1, method, currency ORDER BY 1`;

    const cashierRows = await tx.$queryRaw<{ userId: string; cashier: string; method: string; currency: string; net: bigint; count: number }[]>`
      SELECT p."receivedById"::text AS "userId", u."fullName" AS cashier, p.method::text AS method, p.currency,
             (sum(p."amountMinor") - sum(p."refundedMinor"))::bigint AS net, count(*)::int AS count
      FROM "Payment" p JOIN "User" u ON u.id = p."receivedById"
      WHERE p."receivedAt" >= ${start} AND p."receivedAt" < ${end}
        AND (${scoped}::uuid[] IS NULL OR p."branchId" = ANY(${scoped}::uuid[]))
      GROUP BY p."receivedById", u."fullName", p.method, p.currency`;
    const byCashierMap = new Map<string, FinancialReport["byCashier"][number]>();
    for (const r of cashierRows) {
      const key = `${r.userId}|${r.currency}`;
      const row = byCashierMap.get(key) ?? { cashier: r.cashier, currency: r.currency, net: 0n, count: 0, methods: [] };
      row.net += r.net;
      row.count += r.count;
      row.methods.push({ method: r.method, net: r.net });
      byCashierMap.set(key, row);
    }
    const byCashier = [...byCashierMap.values()].sort((a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0));
    for (const c of byCashier) c.methods.sort((a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0));

    const byService = await tx.$queryRaw<{ service: string; currency: string; amount: bigint; quantity: number }[]>`
      SELECT l.description AS service, i.currency, sum(l."totalMinor")::bigint AS amount, sum(l.quantity)::int AS quantity
      FROM "InvoiceLine" l JOIN "Invoice" i ON i.id = l."invoiceId"
      WHERE i.status IN ('ISSUED','PARTIALLY_PAID','PAID') AND i."issuedAt" >= ${start} AND i."issuedAt" < ${end}
        AND (${scoped}::uuid[] IS NULL OR i."branchId" = ANY(${scoped}::uuid[]))
      GROUP BY l.description, i.currency ORDER BY amount DESC LIMIT 20`;

    const byDoctor = await tx.$queryRaw<{ doctor: string; currency: string; amount: bigint; invoices: number }[]>`
      SELECT u."fullName" AS doctor, i.currency, sum(i."totalMinor")::bigint AS amount, count(*)::int AS invoices
      FROM "Invoice" i
      JOIN "Appointment" a ON a.id = i."appointmentId"
      JOIN "DoctorProfile" d ON d.id = a."doctorProfileId"
      JOIN "Membership" m ON m.id = d."membershipId"
      JOIN "User" u ON u.id = m."userId"
      WHERE i.status IN ('ISSUED','PARTIALLY_PAID','PAID') AND i."issuedAt" >= ${start} AND i."issuedAt" < ${end}
        AND (${scoped}::uuid[] IS NULL OR i."branchId" = ANY(${scoped}::uuid[]))
      GROUP BY u."fullName", i.currency ORDER BY amount DESC LIMIT 20`;

    const invoiced = await tx.$queryRaw<{ currency: string; invoiced: bigint }[]>`
      SELECT currency, sum("totalMinor")::bigint AS invoiced FROM "Invoice"
      WHERE status IN ('ISSUED','PARTIALLY_PAID','PAID') AND "issuedAt" >= ${start} AND "issuedAt" < ${end}
        AND (${scoped}::uuid[] IS NULL OR "branchId" = ANY(${scoped}::uuid[]))
      GROUP BY currency`;

    const outstanding = await tx.$queryRaw<{ currency: string; outstanding: bigint }[]>`
      SELECT currency, sum("totalMinor" - "paidMinor")::bigint AS outstanding FROM "Invoice"
      WHERE status IN ('ISSUED','PARTIALLY_PAID') AND (${scoped}::uuid[] IS NULL OR "branchId" = ANY(${scoped}::uuid[]))
      GROUP BY currency`;

    const expensesByCategory = await tx.$queryRaw<{ category: string; currency: string; amount: bigint }[]>`
      SELECT category::text AS category, currency, sum("amountMinor")::bigint AS amount FROM "Expense"
      WHERE "voidedAt" IS NULL AND "spentOn" >= ${from}::date AND "spentOn" <= ${to}::date
        AND (${scoped}::uuid[] IS NULL OR "branchId" IS NULL OR "branchId" = ANY(${scoped}::uuid[]))
      GROUP BY category, currency ORDER BY amount DESC`;

    const debtorRows = await tx.invoice.findMany({
      where: { status: { in: ["ISSUED", "PARTIALLY_PAID"] }, ...(scoped ? { branchId: { in: scoped } } : {}) },
      include: { patient: { select: { mrn: true, lastName: true, firstName: true, middleName: true } } },
      orderBy: { issuedAt: "asc" },
      take: 50,
    });

    const currencies = new Set<string>([...byDay.map((d) => d.currency), ...invoiced.map((d) => d.currency), ...outstanding.map((d) => d.currency), ...expensesByCategory.map((d) => d.currency)]);
    const totals = [...currencies].map((currency) => ({
      currency,
      invoiced: invoiced.find((x) => x.currency === currency)?.invoiced ?? 0n,
      received: byDay.filter((x) => x.currency === currency).reduce((s, x) => s + x.received, 0n),
      refunded: byDay.filter((x) => x.currency === currency).reduce((s, x) => s + x.refunded, 0n),
      expenses: expensesByCategory.filter((x) => x.currency === currency).reduce((s, x) => s + x.amount, 0n),
      outstanding: outstanding.find((x) => x.currency === currency)?.outstanding ?? 0n,
    }));

    return {
      from,
      to,
      byDay,
      byMethod,
      byDayMethod,
      byCashier,
      byService,
      byDoctor,
      totals,
      expensesByCategory,
      debtors: debtorRows.map((i) => ({
        invoiceId: i.id,
        number: i.number,
        patient: [i.patient.lastName, i.patient.firstName, i.patient.middleName].filter(Boolean).join(" "),
        mrn: i.patient.mrn,
        currency: i.currency,
        outstanding: i.totalMinor - i.paidMinor,
        issuedAt: i.issuedAt,
      })),
    };
  });
}

/** Net payments by method in a period: the comparison figures of the dashboard (one light query). */
export async function methodTotals(ctx: ClinicContext, from: string, to: string): Promise<{ method: string; currency: string; net: bigint; count: number }[]> {
  if (!ctx.permissions.has("finance.reports")) throw new DomainError("errors.forbidden");
  const { start, end } = range(ctx, from, to);
  const scoped = ctx.branchIds ?? null;
  return inClinic(ctx, (tx) => tx.$queryRaw<{ method: string; currency: string; net: bigint; count: number }[]>`
    SELECT method::text AS method, currency, (sum("amountMinor") - sum("refundedMinor"))::bigint AS net, count(*)::int AS count
    FROM "Payment" WHERE "receivedAt" >= ${start} AND "receivedAt" < ${end}
      AND (${scoped}::uuid[] IS NULL OR "branchId" = ANY(${scoped}::uuid[]))
    GROUP BY method, currency`);
}

export interface OperationalReport {
  appointmentsByStatus: { status: string; count: number }[];
  newPatients: number;
  visitsByDoctor: { doctor: string; completed: number; noShow: number }[];
  noShowRate: number | null;
}

export async function operationalReport(ctx: ClinicContext, from: string, to: string): Promise<OperationalReport> {
  if (!ctx.permissions.has("reports.operational") && !ctx.permissions.has("finance.reports")) throw new DomainError("errors.forbidden");
  const { start, end } = range(ctx, from, to);
  const scoped = ctx.branchIds ?? null;
  return inClinic(ctx, async (tx) => {
    const byStatus = await tx.$queryRaw<{ status: string; count: number }[]>`
      SELECT status::text AS status, count(*)::int AS count FROM "Appointment"
      WHERE "startsAt" >= ${start} AND "startsAt" < ${end} AND (${scoped}::uuid[] IS NULL OR "branchId" = ANY(${scoped}::uuid[]))
      GROUP BY status`;
    const byDoctor = await tx.$queryRaw<{ doctor: string; completed: number; noShow: number }[]>`
      SELECT u."fullName" AS doctor,
             count(*) FILTER (WHERE a.status = 'COMPLETED')::int AS completed,
             count(*) FILTER (WHERE a.status = 'NO_SHOW')::int AS "noShow"
      FROM "Appointment" a JOIN "DoctorProfile" d ON d.id = a."doctorProfileId"
      JOIN "Membership" m ON m.id = d."membershipId" JOIN "User" u ON u.id = m."userId"
      WHERE a."startsAt" >= ${start} AND a."startsAt" < ${end} AND (${scoped}::uuid[] IS NULL OR a."branchId" = ANY(${scoped}::uuid[]))
      GROUP BY u."fullName" ORDER BY completed DESC`;
    const newPatients = await tx.patient.count({ where: { createdAt: { gte: start, lt: end } } });
    const done = byStatus.find((s) => s.status === "COMPLETED")?.count ?? 0;
    const noShow = byStatus.find((s) => s.status === "NO_SHOW")?.count ?? 0;
    return { appointmentsByStatus: byStatus, newPatients, visitsByDoctor: byDoctor, noShowRate: done + noShow > 0 ? noShow / (done + noShow) : null };
  });
}

