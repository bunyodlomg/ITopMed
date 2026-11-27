import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { sniffFileType } from "@/lib/diagnostics";
import { MEDICINE_FORMS, matchScore, medicineSearchKey, splitStrength, searchText, type MedicineOption } from "@/lib/medicines";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { auditClinic, inClinic, requirePermission } from "../clinic/context";
import type { Tx } from "../db";
import { DomainError } from "../errors";
import { uuidv7 } from "../security/crypto";

/**
 * The clinic's medicine catalog ("Dori bazasi"). Doctors and the pharmacist
 * write it (medicines.manage); everyone who prescribes searches it. Reference
 * data only: no patient data, no doses or interactions from ITop Med itself.
 */

const uuid = z.uuid();
export const MEDICINE_PHOTO_MAX_BYTES = 2 * 1024 * 1024;

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "validation.tooLong")
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .default(null);

export const medicineSchema = z.object({
  name: z.string().trim().min(2, "validation.required").max(120, "validation.tooLong"),
  strength: text(60),
  inn: text(120),
  form: z.enum(MEDICINE_FORMS).default("tablet"),
  manufacturer: text(120),
  drugGroup: text(120),
  defaultDose: text(100),
  defaultFrequency: text(120),
  defaultRoute: text(60),
  defaultTimes: z
    .string()
    .trim()
    .default("")
    .transform((v) => v.replace(/[;\s]+/g, ",").split(",").filter(Boolean).map((x) => (/^\d:\d\d$/.test(x) ? `0${x}` : x)))
    .refine((list) => list.length <= 8 && list.every((x) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x)), "validation.times")
    .transform((list) => (list.length ? [...new Set(list)].sort().join(", ") : null)),
  defaultDays: z.union([z.literal("").transform(() => null), z.null(), z.coerce.number().int("validation.invalid").min(1, "validation.durationDays").max(3650, "validation.durationDays")]).default(null),
  instructions: text(1000),
});
export type MedicineInput = z.infer<typeof medicineSchema>;

/** Prescribers search the catalog; its writers manage it. */
export function canUseMedicines(ctx: ClinicContext) {
  return ctx.permissions.has("prescriptions.write") || ctx.permissions.has("medicines.manage");
}

function assertUse(ctx: ClinicContext) {
  if (!canUseMedicines(ctx)) throw new DomainError("errors.forbidden");
}

const optionSelect = {
  id: true,
  name: true,
  strength: true,
  inn: true,
  form: true,
  drugGroup: true,
  manufacturer: true,
  defaultDose: true,
  defaultFrequency: true,
  defaultRoute: true,
  defaultTimes: true,
  defaultDays: true,
  instructions: true,
  photoMime: true,
  usageCount: true,
  searchKey: true,
} satisfies Prisma.MedicineSelect;

type Row = Prisma.MedicineGetPayload<{ select: typeof optionSelect }>;

const toOption = (r: Row): MedicineOption => ({
  id: r.id,
  name: r.name,
  strength: r.strength,
  inn: r.inn,
  form: r.form,
  drugGroup: r.drugGroup,
  manufacturer: r.manufacturer,
  defaultDose: r.defaultDose,
  defaultFrequency: r.defaultFrequency,
  defaultRoute: r.defaultRoute,
  defaultTimes: r.defaultTimes,
  defaultDays: r.defaultDays,
  instructions: r.instructions,
  hasPhoto: Boolean(r.photoMime),
  usageCount: r.usageCount,
});

/**
 * Finds medicines as the doctor types: by trade name, INN, group or maker,
 * in Latin or Cyrillic ("конкор" finds "Konkor"), each word as a prefix or
 * part of a word; the names starting with the words and the most prescribed
 * come first. A small typo still finds the entry (trigram similarity).
 * An empty query lists the most used ones.
 */
export async function searchMedicines(ctx: ClinicContext, q: string, take = 12): Promise<MedicineOption[]> {
  assertUse(ctx);
  const query = searchText(q.slice(0, 100));
  const words = query.split(" ").filter(Boolean).slice(0, 6);
  return inClinic(ctx, async (tx) => {
    if (!words.length) {
      const rows = await tx.medicine.findMany({ where: { archivedAt: null }, select: optionSelect, orderBy: [{ usageCount: "desc" }, { name: "asc" }], take });
      return rows.map(toOption);
    }
    const rows = await tx.medicine.findMany({
      where: { archivedAt: null, AND: words.map((w) => ({ searchKey: { contains: w } })) },
      select: optionSelect,
      take: 200,
    });
    let hits = rows.map((r) => ({ r, s: matchScore(query, { name: r.name, inn: r.inn, key: r.searchKey, usageCount: r.usageCount }) })).filter((x) => x.s > 0);
    if (!hits.length && query.length >= 3) {
      // Typo tolerance: the closest entries by trigram similarity of the search key.
      const ids = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Medicine"
        WHERE "archivedAt" IS NULL AND word_similarity(${query}, "searchKey") >= 0.45
        ORDER BY word_similarity(${query}, "searchKey") DESC, "usageCount" DESC
        LIMIT ${take}`;
      if (ids.length) {
        const near = await tx.medicine.findMany({ where: { id: { in: ids.map((x) => x.id) } }, select: optionSelect });
        const order = new Map(ids.map((x, i) => [x.id, i]));
        hits = near.map((r) => ({ r, s: 1000 - order.get(r.id)! }));
      }
    }
    return hits
      .sort((a, b) => b.s - a.s || a.r.name.localeCompare(b.r.name))
      .slice(0, take)
      .map((x) => toOption(x.r));
  });
}

/** The catalog page: everything, filtered by the search words, most used first. */
export async function listMedicines(ctx: ClinicContext, opts: { q?: string; archived?: boolean } = {}) {
  assertUse(ctx);
  if (opts.q?.trim()) return searchMedicines(ctx, opts.q, 200);
  return inClinic(ctx, async (tx) =>
    (await tx.medicine.findMany({ where: { archivedAt: opts.archived ? { not: null } : null }, select: optionSelect, orderBy: [{ usageCount: "desc" }, { name: "asc" }], take: 500 })).map(toOption),
  );
}

export async function countMedicines(ctx: ClinicContext) {
  assertUse(ctx);
  return inClinic(ctx, (tx) => tx.medicine.count({ where: { archivedAt: null } }));
}

export async function getMedicine(ctx: ClinicContext, id: string) {
  assertUse(ctx);
  if (!uuid.safeParse(id).success) throw new DomainError("errors.notFound");
  const m = await inClinic(ctx, (tx) => tx.medicine.findUnique({ where: { id }, select: { ...optionSelect, archivedAt: true, createdAt: true, updatedAt: true } }));
  if (!m) throw new DomainError("errors.notFound");
  return { ...toOption(m), archivedAt: m.archivedAt };
}

function data(input: MedicineInput) {
  return { ...input, searchKey: medicineSearchKey(input) };
}

function duplicate(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new DomainError("errors.medicineExists");
  throw e;
}

/** Creates (id null) or updates an entry. Name + strength are unique among the active entries. */
export async function saveMedicine(ctx: ClinicContext, id: string | null, raw: unknown, meta: RequestMeta): Promise<string> {
  requirePermission(ctx, "medicines.manage");
  const input = medicineSchema.parse(raw);
  return inClinic(ctx, async (tx) => {
    if (id) {
      if (!uuid.safeParse(id).success) throw new DomainError("errors.notFound");
      const r = await tx.medicine.updateMany({ where: { id, archivedAt: null }, data: data(input) });
      if (r.count !== 1) throw new DomainError("errors.notFound");
      await auditClinic(tx, ctx, meta, { action: "medicine.updated", entityType: "Medicine", entityId: id });
      return id;
    }
    const newId = uuidv7();
    await tx.medicine.create({ data: { id: newId, tenantId: ctx.tenant.id, ...data(input), createdById: ctx.principal.user.id }, select: { id: true } });
    await auditClinic(tx, ctx, meta, { action: "medicine.created", entityType: "Medicine", entityId: newId });
    return newId;
  }).catch(duplicate);
}

/** Archived entries leave the search; prescriptions that used them keep their text. */
export async function archiveMedicine(ctx: ClinicContext, id: string, restore: boolean, meta: RequestMeta) {
  requirePermission(ctx, "medicines.manage");
  if (!uuid.safeParse(id).success) throw new DomainError("errors.notFound");
  await inClinic(ctx, async (tx) => {
    const r = await tx.medicine.updateMany({ where: { id, archivedAt: restore ? { not: null } : null }, data: { archivedAt: restore ? null : new Date() } });
    if (r.count !== 1) throw new DomainError("errors.notFound");
    await auditClinic(tx, ctx, meta, { action: restore ? "medicine.restored" : "medicine.archived", entityType: "Medicine", entityId: id });
  }).catch(duplicate);
}

/** Picture of the box or the tablet: JPEG / PNG / WebP (checked from the bytes), up to 2 MB. Empty bytes remove it. */
export async function setMedicinePhoto(ctx: ClinicContext, id: string, bytes: Uint8Array | null, meta: RequestMeta) {
  requirePermission(ctx, "medicines.manage");
  if (!uuid.safeParse(id).success) throw new DomainError("errors.notFound");
  let mime: string | null = null;
  if (bytes) {
    if (bytes.length === 0) throw new DomainError("errors.noFile");
    if (bytes.length > MEDICINE_PHOTO_MAX_BYTES) throw new DomainError("errors.photoTooLarge");
    mime = sniffFileType(bytes);
    if (!mime || mime === "application/pdf") throw new DomainError("errors.photoType");
  }
  await inClinic(ctx, async (tx) => {
    const r = await tx.medicine.updateMany({ where: { id, archivedAt: null }, data: { photo: bytes ? Buffer.from(bytes) : null, photoMime: mime, photoUpdatedAt: bytes ? new Date() : null } });
    if (r.count !== 1) throw new DomainError("errors.notFound");
    await auditClinic(tx, ctx, meta, {
      action: bytes ? "medicine.photo_set" : "medicine.photo_removed",
      entityType: "Medicine",
      entityId: id,
      metadata: bytes ? { mime: mime!, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16) } : {},
    });
  });
}

export async function medicinePhoto(ctx: ClinicContext, id: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  assertUse(ctx);
  if (!uuid.safeParse(id).success) return null;
  const m = await inClinic(ctx, (tx) => tx.medicine.findUnique({ where: { id }, select: { photo: true, photoMime: true } }));
  return m?.photo && m.photoMime ? { bytes: m.photo, mime: m.photoMime } : null;
}

/**
 * Inside the prescription's transaction: the chosen catalog entry is counted
 * (most used first in search), or - when the doctor asked to keep a typed
 * medicine and may write the catalog - a new entry is made from the
 * prescription. Returns the entry id for the prescription, or null.
 */
export async function catalogForPrescription(
  tx: Tx,
  ctx: ClinicContext,
  rx: { medicineId?: string; saveToCatalog: boolean; drug: string; inn?: string; dose: string; frequency: string; route?: string; times?: string; durationDays?: number; instructions?: string },
  meta: RequestMeta,
): Promise<string | null> {
  if (rx.medicineId) {
    const r = await tx.medicine.updateMany({ where: { id: rx.medicineId, archivedAt: null }, data: { usageCount: { increment: 1 } } });
    if (r.count !== 1) throw new DomainError("errors.notFound");
    return rx.medicineId;
  }
  if (!rx.saveToCatalog || !ctx.permissions.has("medicines.manage")) return null;
  const { name, strength } = splitStrength(rx.drug);
  if (name.length < 2 || name.length > 120) return null;
  const existing = await tx.medicine.findFirst({ where: { archivedAt: null, name: { equals: name, mode: "insensitive" }, strength: strength ? { equals: strength, mode: "insensitive" } : null }, select: { id: true } });
  if (existing) {
    await tx.medicine.update({ where: { id: existing.id }, data: { usageCount: { increment: 1 } }, select: { id: true } });
    return existing.id;
  }
  const parsed = medicineSchema.safeParse({
    name,
    strength: strength ?? "",
    inn: rx.inn ?? "",
    form: guessForm(rx.dose),
    defaultDose: rx.dose,
    defaultFrequency: rx.frequency,
    defaultRoute: rx.route ?? "",
    defaultTimes: rx.times ?? "",
    defaultDays: rx.durationDays ?? "",
    instructions: rx.instructions ?? "",
  });
  if (!parsed.success) return null;
  const id = uuidv7();
  await tx.medicine.create({ data: { id, tenantId: ctx.tenant.id, ...data(parsed.data), usageCount: 1, createdById: ctx.principal.user.id }, select: { id: true } });
  await auditClinic(tx, ctx, meta, { action: "medicine.created", entityType: "Medicine", entityId: id, metadata: { source: "rx_form" } });
  return id;
}

/** The form a typed dose suggests ("1 tabletka" - tablet); "other" when unclear. The doctor corrects it in the catalog. */
export function guessForm(dose: string): (typeof MEDICINE_FORMS)[number] {
  const d = dose.toLocaleLowerCase("ru");
  if (/tab|таб/.test(d)) return "tablet";
  if (/kaps|капс/.test(d)) return "capsule";
  if (/tomchi|томчи|kapl|капл|drop/.test(d)) return "drops";
  if (/ampul|ампул|in'?y?ek|инъек|ukol|укол/.test(d)) return "injection";
  if (/sirop|сироп|syrup/.test(d)) return "syrup";
  if (/surtma|суртма|maz|маз|ointment/.test(d)) return "ointment";
  if (/sham|шам|svech|свеч|suppos/.test(d)) return "suppository";
  if (/sprey|спрей|spray|ingal|ингал|inhal/.test(d)) return "spray";
  if (/paket|пакет|poroshok|порош|powder/.test(d)) return "powder";
  return "other";
}
