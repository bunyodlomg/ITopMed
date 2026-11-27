import "server-only";
import { z } from "zod";
import { Prisma, type LabFlag, type LabOrderStatus } from "@/generated/prisma/client";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { assertBranch, auditClinic, inClinic, requirePermission } from "../clinic/context";
import type { Tx } from "../db";
import { withRecordAccess } from "../emr/access";
import { paidGate, printsAtDesk } from "../emr/print-rules";
import { notifyResultsReady } from "../notifications/notifications";
import { instantToLocalDate } from "../scheduling/time";
import { uuidv7 } from "../security/crypto";
import { DomainError } from "../tenancy/provisioning";

const uuid = z.uuid();
const decimal = z
  .string()
  .trim()
  .transform((v) => v.replace(",", "."))
  .pipe(z.string().regex(/^-?\d{1,8}(\.\d{1,4})?$/, "validation.number"));
const optionalDecimal = z.union([z.literal("").transform(() => undefined), decimal]).optional();

/** HIGH/LOW against the snapshotted reference range; NORMAL when inside or no range. */
export function flagFor(value: Prisma.Decimal, low: Prisma.Decimal | null, high: Prisma.Decimal | null): LabFlag {
  if (low !== null && value.lessThan(low)) return "LOW";
  if (high !== null && value.greaterThan(high)) return "HIGH";
  return "NORMAL";
}

// ───────────── Test catalog (analytes) ─────────────

/** Lab tests = services of kind LAB_TEST, with their analytes. */
export async function listLabTests(ctx: ClinicContext) {
  requirePermission(ctx, "orders.create", "lab.read", "lab.manage");
  return inClinic(ctx, (tx) =>
    tx.service.findMany({
      where: { kind: "LAB_TEST", archivedAt: null },
      include: { labAnalytes: { where: { archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } },
      orderBy: { name: "asc" },
    }),
  );
}

export const analyteSchema = z
  .object({
    name: z.string().trim().min(1, "validation.required").max(120, "validation.tooLong"),
    loinc: z.union([z.literal("").transform(() => undefined), z.string().trim().regex(/^\d{1,7}-\d$/, "validation.loinc")]).optional(),
    unit: z.string().trim().min(1, "validation.required").max(30, "validation.tooLong"),
    refLow: optionalDecimal,
    refHigh: optionalDecimal,
    sortOrder: z.coerce.number().int().min(0).max(999).default(0),
  })
  .refine((v) => v.refLow === undefined || v.refHigh === undefined || Number(v.refLow) <= Number(v.refHigh), { message: "validation.rangeOrder", path: ["refHigh"] });

export async function addAnalyte(ctx: ClinicContext, serviceId: string, raw: unknown, meta: RequestMeta) {
  requirePermission(ctx, "lab.manage");
  const input = analyteSchema.parse(raw);
  const id = uuidv7();
  await inClinic(ctx, async (tx) => {
    const s = await tx.service.findFirst({ where: { id: uuid.parse(serviceId), kind: "LAB_TEST", archivedAt: null } });
    if (!s) throw new DomainError("errors.notFound");
    await tx.labAnalyte.create({
      data: {
        id,
        tenantId: ctx.tenant.id,
        serviceId: s.id,
        name: input.name,
        loinc: input.loinc,
        unit: input.unit,
        refLow: input.refLow !== undefined ? new Prisma.Decimal(input.refLow) : null,
        refHigh: input.refHigh !== undefined ? new Prisma.Decimal(input.refHigh) : null,
        sortOrder: input.sortOrder,
      },
    });
    await auditClinic(tx, ctx, meta, { action: "lab.analyte_added", entityType: "LabAnalyte", entityId: id });
  });
  return id;
}

export async function archiveAnalyte(ctx: ClinicContext, analyteId: string, meta: RequestMeta) {
  requirePermission(ctx, "lab.manage");
  await inClinic(ctx, async (tx) => {
    const a = await tx.labAnalyte.findUnique({ where: { id: uuid.parse(analyteId) } });
    if (!a || a.archivedAt) throw new DomainError("errors.notFound");
    await tx.labAnalyte.update({ where: { id: a.id }, data: { archivedAt: new Date() } });
    await auditClinic(tx, ctx, meta, { action: "lab.analyte_archived", entityType: "LabAnalyte", entityId: a.id });
  });
}

// ───────────── Ordering (doctor) ─────────────

export const labOrderSchema = z.object({
  serviceIds: z.array(uuid).min(1, "validation.chooseTest").max(30),
  priority: z.enum(["ROUTINE", "URGENT"]).default("ROUTINE"),
  indication: z
    .string()
    .trim()
    .max(500, "validation.tooLong")
    .transform((v) => (v === "" ? undefined : v))
    .optional(),
});

async function nextLabNumber(tx: Tx, ctx: ClinicContext) {
  const year = instantToLocalDate(new Date(), ctx.tenant.timezone).slice(0, 4);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`lab-number:${ctx.tenant.id}:${year}`}, 0))`;
  const last = await tx.$queryRaw<{ n: number | null }[]>`SELECT max(split_part(number, '-', 3)::int) AS n FROM "LabOrder" WHERE number LIKE ${`LAB-${year}-%`}`;
  return `LAB-${year}-${String((last[0]?.n ?? 0) + 1).padStart(6, "0")}`;
}

/** The treating doctor orders lab tests from their own open visit. */
export async function createLabOrder(ctx: ClinicContext, encounterId: string, raw: unknown, meta: RequestMeta): Promise<{ id: string; number: string; charged: boolean }> {
  requirePermission(ctx, "orders.create");
  const input = labOrderSchema.parse(raw);
  const enc = await inClinic(ctx, async (tx) => {
    const e = await tx.encounter.findUnique({ where: { id: uuid.parse(encounterId) } });
    if (!e) throw new DomainError("errors.notFound");
    return e;
  });
  const order = await withRecordAccess(ctx, enc.patientId, meta, { auditView: false }, async (tx, access) => {
    if (access.doctorProfileId !== enc.doctorProfileId) throw new DomainError("errors.notYourPatient");
    if (enc.status !== "OPEN") throw new DomainError("errors.encounterClosed");
    const ids = [...new Set(input.serviceIds)];
    const tests = await tx.service.findMany({ where: { id: { in: ids }, kind: "LAB_TEST", archivedAt: null } });
    if (tests.length !== ids.length) throw new DomainError("errors.invalidInput");
    const id = uuidv7();
    const number = await nextLabNumber(tx, ctx);
    await tx.labOrder.create({
      data: {
        id,
        tenantId: ctx.tenant.id,
        number,
        patientId: enc.patientId,
        encounterId: enc.id,
        doctorProfileId: enc.doctorProfileId,
        branchId: enc.branchId,
        priority: input.priority,
        indication: input.indication,
        orderedById: ctx.principal.user.id,
      },
    });
    await tx.labOrderItem.createMany({ data: tests.map((s) => ({ id: uuidv7(), tenantId: ctx.tenant.id, orderId: id, serviceId: s.id, name: s.name })) });
    await auditClinic(tx, ctx, meta, { action: "lab.ordered", entityType: "LabOrder", entityId: id, metadata: { tests: tests.length, priority: input.priority } });
    return { id, number, serviceIds: ids };
  });
  // Ordered = owed: the priced tests go on the patient's bill as unpaid (not those the desk
  // already billed today), so the patient pays everything at the cashier before leaving.
  // Loaded lazily: the desk module reaches the lab through the record services (import cycle).
  const { chargeOrderedServices } = await import("../reception/desk");
  const charged = await chargeOrderedServices(ctx, { patientId: enc.patientId, branchId: enc.branchId, serviceIds: order.serviceIds }, meta);
  return { id: order.id, number: order.number, charged: Boolean(charged) };
}

// ───────────── Laboratory work (lab staff, nurses) ─────────────

const orderInclude = {
  patient: { select: { id: true, mrn: true, lastName: true, firstName: true, middleName: true, birthDate: true, sex: true } },
  doctor: { select: { membership: { select: { user: { select: { fullName: true } } } } } },
  branch: { select: { name: true } },
  items: {
    include: {
      results: { include: { analyte: { select: { name: true, sortOrder: true } } } },
      service: { select: { labAnalytes: { where: { archivedAt: null }, orderBy: [{ sortOrder: "asc" as const }, { name: "asc" as const }] } } },
    },
  },
} satisfies Prisma.LabOrderInclude;

export type LabOrderView = Prisma.LabOrderGetPayload<{ include: typeof orderInclude }>;

function canWorkLab(ctx: ClinicContext) {
  return ["lab.read", "lab.collect", "lab.process", "lab.verify"].some((p) => ctx.permissions.has(p as never));
}

/**
 * Lab worklist within the caller's branch scope. Lab staff see the lab order
 * (patient identity, tests, indication) — not the rest of the medical record.
 */
export async function labWorklist(ctx: ClinicContext, statuses: LabOrderStatus[]) {
  if (!canWorkLab(ctx)) throw new DomainError("errors.forbidden");
  return inClinic(ctx, (tx) =>
    tx.labOrder.findMany({
      where: { status: { in: statuses }, ...(ctx.branchIds ? { branchId: { in: ctx.branchIds } } : {}) },
      include: orderInclude,
      orderBy: [{ priority: "desc" }, { orderedAt: "asc" }],
      take: 200,
    }),
  );
}

async function loadOrder(tx: Tx, ctx: ClinicContext, orderId: string) {
  if (!uuid.safeParse(orderId).success) throw new DomainError("errors.notFound");
  const o = await tx.labOrder.findUnique({ where: { id: orderId }, include: orderInclude });
  if (!o) throw new DomainError("errors.notFound");
  assertBranch(ctx, o.branchId);
  return o;
}

export async function getLabOrder(ctx: ClinicContext, orderId: string, meta: RequestMeta) {
  if (!canWorkLab(ctx)) throw new DomainError("errors.forbidden");
  return inClinic(ctx, async (tx) => {
    const o = await loadOrder(tx, ctx, orderId);
    await auditClinic(tx, ctx, meta, { action: "lab.order_viewed", entityType: "LabOrder", entityId: o.id });
    return o;
  });
}

/**
 * A verified lab report to print on the clinic letterhead. Lab staff and
 * doctors print under the lab rules; the desk (documents.print), or everyone
 * when the clinic prints only at the desk, once the report was verified today
 * and the patient's bills are settled. Printing is audited; no prices.
 */
export async function labOrderForPrint(ctx: ClinicContext, orderId: string, meta: RequestMeta, opts?: { via?: "print" | "telegram" }) {
  if (!canWorkLab(ctx) && !ctx.permissions.has("documents.print")) throw new DomainError("errors.forbidden");
  const desk = await printsAtDesk(ctx, canWorkLab(ctx));
  return inClinic(ctx, async (tx) => {
    const o = await loadOrder(tx, ctx, orderId);
    if (o.status !== "VERIFIED" || !o.verifiedAt) throw new DomainError("errors.deskPrint.labNotVerified");
    if (desk) {
      const gate = await paidGate(tx, ctx, o.patientId, o.verifiedAt);
      if (gate !== "ok") throw new DomainError(`errors.deskPrint.${gate}`);
    }
    const verifier = o.verifiedById ? await tx.user.findUnique({ where: { id: o.verifiedById }, select: { fullName: true } }) : null;
    await auditClinic(tx, ctx, meta, { action: opts?.via === "telegram" ? "lab.sent_telegram" : desk ? "lab.printed_at_desk" : "lab.printed", entityType: "LabOrder", entityId: o.id });
    return { order: o, verifiedBy: verifier?.fullName ?? null };
  });
}

export async function collectSpecimen(ctx: ClinicContext, orderId: string, meta: RequestMeta) {
  requirePermission(ctx, "lab.collect");
  await inClinic(ctx, async (tx) => {
    const o = await loadOrder(tx, ctx, orderId);
    if (o.status !== "ORDERED") throw new DomainError("errors.invalidTransition");
    await tx.labOrder.update({ where: { id: o.id }, data: { status: "COLLECTED", collectedAt: new Date(), collectedById: ctx.principal.user.id } });
    await auditClinic(tx, ctx, meta, { action: "lab.collected", entityType: "LabOrder", entityId: o.id });
  });
}

/**
 * Enters (or corrects, before verification) analyte values. Flags are computed
 * from the reference range snapshot. When every analyte of every test has a
 * value the order becomes RESULTED and awaits a second person's verification.
 */
export async function enterResults(ctx: ClinicContext, orderId: string, raw: Record<string, string>, meta: RequestMeta) {
  requirePermission(ctx, "lab.process");
  return inClinic(ctx, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "LabOrder" WHERE id = ${uuid.parse(orderId)}::uuid FOR UPDATE`;
    const o = await loadOrder(tx, ctx, orderId);
    if (o.status !== "COLLECTED" && o.status !== "RESULTED") throw new DomainError("errors.invalidTransition");
    const now = new Date();
    let entered = 0;
    for (const item of o.items) {
      for (const a of item.service.labAnalytes) {
        const rawValue = raw[`${item.id}:${a.id}`];
        if (rawValue === undefined || rawValue.trim() === "") continue;
        const parsed = decimal.safeParse(rawValue);
        if (!parsed.success) throw new DomainError("errors.invalidResultValue");
        const value = new Prisma.Decimal(parsed.data);
        const data = { value, unit: a.unit, refLow: a.refLow, refHigh: a.refHigh, flag: flagFor(value, a.refLow, a.refHigh), enteredById: ctx.principal.user.id, enteredAt: now };
        await tx.labResult.upsert({
          where: { orderItemId_analyteId: { orderItemId: item.id, analyteId: a.id } },
          create: { id: uuidv7(), tenantId: ctx.tenant.id, orderItemId: item.id, analyteId: a.id, ...data },
          update: data,
        });
        entered++;
      }
    }
    if (entered === 0) throw new DomainError("errors.noResultsEntered");
    const expected = o.items.reduce((n, i) => n + i.service.labAnalytes.length, 0);
    const have = await tx.labResult.count({ where: { item: { orderId: o.id } } });
    const complete = expected > 0 && have >= expected;
    await tx.labOrder.update({
      where: { id: o.id },
      data: complete ? { status: "RESULTED", resultedAt: now, resultedById: ctx.principal.user.id } : { status: "COLLECTED" },
    });
    await auditClinic(tx, ctx, meta, { action: "lab.results_entered", entityType: "LabOrder", entityId: o.id, metadata: { values: entered, complete } });
    return { complete };
  });
}

/** Second person confirms the results (four-eyes, also enforced by a DB CHECK). Final. */
export async function verifyResults(ctx: ClinicContext, orderId: string, meta: RequestMeta) {
  requirePermission(ctx, "lab.verify");
  await inClinic(ctx, async (tx) => {
    const o = await loadOrder(tx, ctx, orderId);
    if (o.status !== "RESULTED") throw new DomainError("errors.invalidTransition");
    if (o.resultedById === ctx.principal.user.id) throw new DomainError("errors.fourEyes");
    await tx.labOrder.update({ where: { id: o.id }, data: { status: "VERIFIED", verifiedAt: new Date(), verifiedById: ctx.principal.user.id } });
    await auditClinic(tx, ctx, meta, { action: "lab.verified", entityType: "LabOrder", entityId: o.id });
  });
}

export async function cancelLabOrder(ctx: ClinicContext, orderId: string, meta: RequestMeta) {
  requirePermission(ctx, "orders.create", "lab.process");
  await inClinic(ctx, async (tx) => {
    const o = await loadOrder(tx, ctx, orderId);
    if (o.status !== "ORDERED" && o.status !== "COLLECTED") throw new DomainError("errors.invalidTransition");
    if (!ctx.permissions.has("lab.process") && o.orderedById !== ctx.principal.user.id) throw new DomainError("errors.forbidden");
    await tx.labOrder.update({ where: { id: o.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    await auditClinic(tx, ctx, meta, { action: "lab.cancelled", entityType: "LabOrder", entityId: o.id });
  });
}

/**
 * A doctor caring for the patient releases verified results to the patient
 * portal. One-way and audited; the database trigger only permits this change
 * on a verified order. Break-the-glass access cannot release.
 */
export async function releaseLabOrder(ctx: ClinicContext, orderId: string, meta: RequestMeta) {
  requirePermission(ctx, "emr.write");
  if (!ctx.modules.has("patient_portal")) throw new DomainError("errors.moduleDisabled");
  const id = uuid.safeParse(orderId);
  if (!id.success) throw new DomainError("errors.notFound");
  const order = await inClinic(ctx, (tx) => tx.labOrder.findUnique({ where: { id: id.data }, select: { id: true, patientId: true, status: true, releasedAt: true } }));
  if (!order) throw new DomainError("errors.notFound");
  await withRecordAccess(ctx, order.patientId, meta, { auditView: false }, async (tx, access) => {
    if (access.mode !== "care" && access.mode !== "oversight") throw new DomainError("errors.noCareRelationship");
    if (order.status !== "VERIFIED") throw new DomainError("errors.invalidTransition");
    if (order.releasedAt) return;
    await tx.labOrder.update({ where: { id: order.id }, data: { releasedAt: new Date(), releasedById: ctx.principal.user.id } });
    await auditClinic(tx, ctx, meta, { action: "lab.released_to_portal", entityType: "LabOrder", entityId: order.id });
    await notifyResultsReady(tx, ctx.tenant.id, { id: order.id, patientId: order.patientId });
  });
}

/** Lab orders of one patient for the medical record (inside an access-checked transaction). */
export function labOrdersForRecord(tx: Tx, patientId: string, encounterId?: string) {
  return tx.labOrder.findMany({
    where: { patientId, ...(encounterId ? { encounterId } : {}) },
    include: { items: { include: { results: { include: { analyte: { select: { name: true, sortOrder: true } } } } } } },
    orderBy: { orderedAt: "desc" },
    take: 50,
  });
}
