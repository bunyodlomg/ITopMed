import "server-only";
import { createTranslator } from "use-intl/core";
import { z } from "zod";
import type { TemplateKind } from "@/generated/prisma/client";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { DomainError } from "../errors";
import { NOTE_SECTIONS } from "../emr/record";
import { SPECIALTIES } from "../scheduling/specialties";
import { uuidv7 } from "../security/crypto";
import { DIAGNOSTIC_KINDS } from "@/lib/diagnostics";
import { parseFieldLines, unknownPlaceholders, type DiagnosticTemplateContent } from "@/lib/diagnostic-template";
import { parseSchemeLines, type RxSchemeContent } from "@/lib/rx-scheme";
import { prescriptionSchema } from "../emr/prescriptions";
import { auditClinic, inClinic, requirePermission } from "./context";

/**
 * Templates the clinic builds itself: note templates (pre-filled visit note
 * sections) and printable documents with placeholders. Generic text only —
 * patient data is filled in at print time from the visit, never stored here.
 */

/** Placeholders a document may use; filled from the visit at print time. */
export const PLACEHOLDERS = [
  "patient.fullName",
  "patient.birthDate",
  "patient.mrn",
  "patient.sex",
  "patient.age",
  "patient.address",
  "visit.date",
  "doctor.fullName",
  "doctor.specialty",
  "clinic.name",
  "clinic.address",
  "clinic.phone",
  "note.complaints",
  "note.history",
  "note.examination",
  "note.assessment",
  "note.plan",
  "diagnoses",
  "diagnoses.primary",
  "diagnoses.secondary",
  "diagnoses.complications",
  "vitals.bp",
  "vitals.pulse",
  "vitals.weight",
  "vitals.height",
  "prescriptions",
  "prescriptions.schedule",
  "labs",
  "visit.nextVisit",
  "doctor.phone",
  "doctor.telegram",
  "today",
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

/**
 * Replaces {{placeholder}} with values; unknown placeholders stay visible so
 * mistakes are noticed. A line whose placeholders are ALL known and empty is
 * dropped ("Asorati: {{diagnoses.complications}}" disappears when there is none).
 */
export function renderDocument(content: string, values: Partial<Record<Placeholder, string>>): string {
  const known = (key: string) => (PLACEHOLDERS as readonly string[]).includes(key);
  const re = /\{\{\s*([a-zA-Z.]+)\s*\}\}/g;
  return content
    .split("\n")
    .flatMap((line) => {
      const keys = [...line.matchAll(re)].map((m) => m[1]!);
      if (keys.length && keys.every((k) => known(k) && !(values[k as Placeholder] ?? "").trim())) return [];
      return [line.replace(re, (m, key: string) => (known(key) ? (values[key as Placeholder] ?? "") : m))];
    })
    .join("\n");
}

const sectionText = z.string().max(10_000, "validation.tooLong").default("");
export const noteContentSchema = z.object(Object.fromEntries(NOTE_SECTIONS.map((s) => [s, sectionText])) as Record<(typeof NOTE_SECTIONS)[number], typeof sectionText>);
export type NoteContent = z.infer<typeof noteContentSchema>;

export const templateSchema = z
  .object({
    kind: z.enum(["NOTE", "DOCUMENT", "DIAGNOSTIC", "PRESCRIPTION"]),
    name: z.string().trim().min(2, "validation.required").max(120, "validation.tooLong"),
    specialty: z.union([z.literal("").transform(() => undefined), z.enum(SPECIALTIES)]).optional(),
    body: z.string().max(20_000, "validation.tooLong").default(""),
    note: noteContentSchema.optional(),
    /** DIAGNOSTIC: study type, fields (one per line), default conclusion. */
    study: z.enum(DIAGNOSTIC_KINDS).optional(),
    fieldsText: z.string().max(20_000, "validation.tooLong").default(""),
    conclusion: z.string().max(5_000, "validation.tooLong").default(""),
    /** PRESCRIPTION: one medicine per line, see src/lib/rx-scheme.ts. */
    schemeText: z.string().max(20_000, "validation.tooLong").default(""),
  })
  .transform((v, c) => {
    if (v.kind === "PRESCRIPTION") {
      const { items, badLines } = parseSchemeLines(v.schemeText);
      // Each line must also be a valid prescription (lengths, intake times, days), so applying it never fails later.
      items.forEach((it, i) => {
        if (!prescriptionSchema.safeParse(it).success) badLines.push(i + 1);
      });
      if (badLines.length) {
        c.addIssue({ code: "custom", message: "validation.templateFieldLines", path: ["schemeText"], params: { lines: [...new Set(badLines)].sort((a, b) => a - b).join(", ") } });
        return z.NEVER;
      }
      if (!items.length || items.length > 30) {
        c.addIssue({ code: "custom", message: items.length ? "validation.tooLong" : "validation.required", path: ["schemeText"] });
        return z.NEVER;
      }
      const content: RxSchemeContent = { items };
      return { kind: "PRESCRIPTION" as TemplateKind, name: v.name, specialty: v.specialty ?? null, content: JSON.stringify(content) };
    }
    if (v.kind === "DIAGNOSTIC") {
      const { fields, badLines } = parseFieldLines(v.fieldsText);
      if (badLines.length) {
        c.addIssue({ code: "custom", message: "validation.templateFieldLines", path: ["fieldsText"], params: { lines: badLines.join(", ") } });
        return z.NEVER;
      }
      if (!fields.length) {
        c.addIssue({ code: "custom", message: "validation.required", path: ["fieldsText"] });
        return z.NEVER;
      }
      if (!v.body.trim()) {
        c.addIssue({ code: "custom", message: "validation.required", path: ["body"] });
        return z.NEVER;
      }
      if (unknownPlaceholders(v.body, fields).length) {
        c.addIssue({ code: "custom", message: "validation.templateUnknownPlaceholders", path: ["body"] });
        return z.NEVER;
      }
      const content: DiagnosticTemplateContent = { study: v.study ?? "OTHER", fields, body: v.body.trim(), ...(v.conclusion.trim() ? { conclusion: v.conclusion.trim() } : {}) };
      return { kind: "DIAGNOSTIC" as TemplateKind, name: v.name, specialty: v.specialty ?? null, content: JSON.stringify(content) };
    }
    const content = v.kind === "NOTE" ? JSON.stringify(v.note ?? {}) : v.body.trim();
    if (v.kind === "NOTE" ? Object.values(v.note ?? {}).every((x) => !x.trim()) : !content) {
      c.addIssue({ code: "custom", message: "validation.required", path: [v.kind === "NOTE" ? "complaints" : "body"] });
      return z.NEVER;
    }
    return { kind: v.kind as TemplateKind, name: v.name, specialty: v.specialty ?? null, content };
  });

export function parseNoteContent(content: string): NoteContent {
  try {
    return noteContentSchema.parse(JSON.parse(content));
  } catch {
    return noteContentSchema.parse({});
  }
}

function canUse(ctx: ClinicContext) {
  requirePermission(ctx, "clinic.settings.read", "emr.write", "emr.read", "documents.print");
}

export async function listTemplates(ctx: ClinicContext, opts: { kind?: TemplateKind; specialty?: string | null } = {}) {
  canUse(ctx);
  return inClinic(ctx, (tx) =>
    tx.clinicTemplate.findMany({
      where: {
        tenantId: ctx.tenant.id,
        archivedAt: null,
        ...(opts.kind ? { kind: opts.kind } : {}),
        ...(opts.specialty !== undefined ? { OR: [{ specialty: null }, ...(opts.specialty ? [{ specialty: opts.specialty }] : [])] } : {}),
      },
      orderBy: [{ kind: "asc" }, { name: "asc" }],
    }),
  );
}

export async function getTemplate(ctx: ClinicContext, id: string) {
  canUse(ctx);
  if (!z.uuid().safeParse(id).success) throw new DomainError("errors.notFound");
  const t = await inClinic(ctx, (tx) => tx.clinicTemplate.findFirst({ where: { id, tenantId: ctx.tenant.id, archivedAt: null } }));
  if (!t) throw new DomainError("errors.notFound");
  return t;
}

export async function saveTemplate(ctx: ClinicContext, id: string | null, raw: unknown, meta: RequestMeta): Promise<string> {
  requirePermission(ctx, "clinic.settings.manage");
  const input = templateSchema.parse(raw);
  return inClinic(ctx, async (tx) => {
    if (id) {
      if (!z.uuid().safeParse(id).success) throw new DomainError("errors.notFound");
      const r = await tx.clinicTemplate.updateMany({ where: { id, tenantId: ctx.tenant.id, archivedAt: null }, data: { name: input.name, specialty: input.specialty, content: input.content } });
      if (r.count !== 1) throw new DomainError("errors.notFound");
      await auditClinic(tx, ctx, meta, { action: "template.updated", entityType: "ClinicTemplate", entityId: id, metadata: { kind: input.kind } });
      return id;
    }
    const newId = uuidv7();
    await tx.clinicTemplate.create({ data: { id: newId, tenantId: ctx.tenant.id, ...input, createdById: ctx.principal.user.id } });
    await auditClinic(tx, ctx, meta, { action: "template.created", entityType: "ClinicTemplate", entityId: newId, metadata: { kind: input.kind } });
    return newId;
  });
}

export async function archiveTemplate(ctx: ClinicContext, id: string, meta: RequestMeta) {
  requirePermission(ctx, "clinic.settings.manage");
  if (!z.uuid().safeParse(id).success) throw new DomainError("errors.notFound");
  await inClinic(ctx, async (tx) => {
    const r = await tx.clinicTemplate.updateMany({ where: { id, tenantId: ctx.tenant.id, archivedAt: null }, data: { archivedAt: new Date() } });
    if (r.count !== 1) throw new DomainError("errors.notFound");
    await auditClinic(tx, ctx, meta, { action: "template.archived", entityType: "ClinicTemplate", entityId: id });
  });
}

/** Ready-made templates in the clinic's language (visit summary, referral, certificate, two note templates). Skips names that exist. */
export async function addStandardTemplates(ctx: ClinicContext, meta: RequestMeta): Promise<number> {
  requirePermission(ctx, "clinic.settings.manage");
  const locale: Locale = isLocale(ctx.tenant.defaultLocale) ? ctx.tenant.defaultLocale : DEFAULT_LOCALE;
  const messages = (await import(`../../../messages/${locale}.json`)).default;
  const tr = createTranslator({ locale, messages, namespace: "templates.std" });
  // Catalogs write placeholders as [[name]] ({{…}} is not valid ICU message syntax).
  const t = (key: Parameters<typeof tr>[0]) => tr(key).replace(/\[\[([a-zA-Z.]+)\]\]/g, "{{$1}}");
  const docs: { kind: TemplateKind; name: string; specialty: string | null; content: string }[] = [
    { kind: "DOCUMENT", name: t("summaryName"), specialty: null, content: t("summaryBody") },
    { kind: "DOCUMENT", name: t("referralName"), specialty: null, content: t("referralBody") },
    { kind: "DOCUMENT", name: t("certificateName"), specialty: null, content: t("certificateBody") },
    { kind: "DOCUMENT", name: t("cardioDocName"), specialty: "cardiology", content: t("cardioDocBody") },
    {
      kind: "NOTE",
      name: t("noteGeneralName"),
      specialty: null,
      content: JSON.stringify({ complaints: "", history: t("noteGeneralHistory"), examination: t("noteGeneralExam"), assessment: "", plan: "" }),
    },
    {
      kind: "NOTE",
      name: t("noteCardioName"),
      specialty: "cardiology",
      content: JSON.stringify({ complaints: t("noteCardioComplaints"), history: t("noteCardioHistory"), examination: t("noteCardioExam"), assessment: "", plan: t("noteCardioPlan") }),
    },
  ];
  return inClinic(ctx, async (tx) => {
    const existing = new Set((await tx.clinicTemplate.findMany({ where: { tenantId: ctx.tenant.id, archivedAt: null }, select: { name: true } })).map((x) => x.name));
    const fresh = docs.filter((d) => !existing.has(d.name));
    if (fresh.length) {
      await tx.clinicTemplate.createMany({ data: fresh.map((d) => ({ id: uuidv7(), tenantId: ctx.tenant.id, ...d, createdById: ctx.principal.user.id })) });
      await auditClinic(tx, ctx, meta, { action: "template.standard_added", entityType: "Tenant", entityId: ctx.tenant.id, metadata: { count: fresh.length } });
    }
    return fresh.length;
  });
}
