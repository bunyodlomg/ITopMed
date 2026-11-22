/**
 * Opens a clinic ready to work, from a small JSON spec, without the web
 * console: clinic + owner account (the owner's password is typed by the
 * person running the command and never stored in clear), the field preset
 * (starter services, document and note templates, owner's doctor profile and
 * front-desk roles) and the clinic's own price list.
 *
 * Used by `node tasks.mjs create-clinic <spec.json> <owner-login> "<Owner Name>"`
 * on the server (see scripts/deploy/itopmed-clinic.sh).
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loginClinicUser, logoutClinic, resolveClinic, validateClinicSession } from "../../src/server/auth/clinic-auth";
import type { PlatformPrincipal, RequestMeta } from "../../src/server/auth/platform-auth";
import { applyPendingSetup } from "../../src/server/clinic/practice";
import { importPriceList, parsePriceLine, upsertPriceItems, type PriceLine } from "../../src/server/clinic/price-list";
import { LOGO_MAX_BYTES } from "../../src/server/clinic/branding";
import { PLACEHOLDERS } from "../../src/server/clinic/templates";
import { NOTE_SECTIONS } from "../../src/server/emr/record";
import { SPECIALTIES } from "../../src/server/scheduling/specialties";
import { listServices, setServiceArchived } from "../../src/server/clinic/resources";
import { recordAudit } from "../../src/server/audit";
import { platformDb, withAppContext, withPlatform, type Tx } from "../../src/server/db";
import { changeTenantStatus, createClinicWithOwner } from "../../src/server/tenancy/provisioning";
import { DIAGNOSTIC_KINDS } from "../../src/lib/diagnostics";
import { parseFieldLines, unknownPlaceholders, type DiagnosticTemplateContent } from "../../src/lib/diagnostic-template";
import { uuidv7 } from "../../src/server/security/crypto";

export const clinicSpecSchema = z.object({
  name: z.string().min(2),
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
  practiceType: z.enum(["MULTI_SPECIALTY", "SOLO_PRACTICE", "DENTAL", "DIAGNOSTIC", "OTHER"]),
  focusSpecialty: z.string().optional(),
  ownerIsDoctor: z.boolean().default(true),
  ownerFrontDesk: z.boolean().default(true),
  /** The owner is the clinic's (only or leading) doctor: oversight of all records, patient files. */
  ownerHeadDoctor: z.boolean().default(false),
  address: z.string().default(""),
  contactPhone: z.string().default(""),
  planCode: z.string().default("enterprise"),
  /** One service per line, e.g. "EKG 30 ming" (same format as the "price list" box). */
  priceList: z.array(z.string()).default([]),
  /** Letterhead details (filled only where the clinic has none yet). */
  legalName: z.string().max(200).default(""),
  licenseText: z.string().max(300).default(""),
  /** Diagnostic report templates from the clinic's own forms (fields one per line, see src/lib/diagnostic-template.ts). */
  diagnosticTemplates: z
    .array(z.object({ name: z.string().min(2).max(120), study: z.enum(DIAGNOSTIC_KINDS), fields: z.string(), body: z.string().min(1), conclusion: z.string().default("") }))
    .default([]),
  /** Printable documents from the clinic's own forms; text with {{placeholders}} (PLACEHOLDERS in src/server/clinic/templates.ts). */
  documentTemplates: z.array(z.object({ name: z.string().min(2).max(120), specialty: z.enum(SPECIALTIES).optional(), body: z.string().min(1).max(20_000) })).default([]),
  /** Visit note templates: pre-filled note sections. */
  noteTemplates: z
    .array(
      z.object({
        name: z.string().min(2).max(120),
        specialty: z.enum(SPECIALTIES).optional(),
        sections: z.partialRecord(z.enum(NOTE_SECTIONS), z.string().max(10_000)),
      }),
    )
    .default([]),
  /**
   * Live clinic whose price list changed names: the service called `from` is renamed
   * to `to` (keeping its visits and invoices) while no service is called `to` yet.
   */
  serviceRenames: z.array(z.object({ from: z.string().min(2), to: z.string().min(2) })).default([]),
  /** Live clinic: services (exact names) no longer on the price list are archived (restorable on the Services page). */
  retiredServices: z.array(z.string().min(2)).default([]),
  /** Printed on the owner-doctor's documents as {{doctor.phone}}; filled only while empty. */
  ownerDoctorPhone: z.string().max(40).default(""),
  /** Letterhead logo, a PNG/JPEG next to the spec file; set only while the clinic has none. */
  logoFile: z.string().regex(/^[a-z0-9-]+\.(png|jpe?g)$/).optional(),
});
export type ClinicSpec = z.infer<typeof clinicSpecSchema>;

const META: RequestMeta = { ip: "127.0.0.1", userAgent: "itopmed-clinic (server task)", requestId: null };

/**
 * The owner signs in with `ownerLogin` and the password typed by the operator
 * (handed over in person); they then link Telegram for sign-in and password
 * reset through the clinic's bot. No email anywhere.
 */
export async function createClinicFromSpec(specFile: string, ownerLogin: string, ownerName: string, password: string) {
  const spec = clinicSpecSchema.parse(JSON.parse(fs.readFileSync(specFile, "utf8")));
  const admin = await platformDb().platformUser.findFirst({ where: { role: "SUPER_ADMIN", status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
  if (!admin) throw new Error("No active SuperAdmin: create one first (itopmed-admin).");
  const actor: PlatformPrincipal = { sessionId: "server-task", user: { id: admin.id, username: admin.username, fullName: admin.fullName, role: "SUPER_ADMIN", locale: "uz-Latn" } };

  const created = await createClinicWithOwner(
    actor,
    {
      name: spec.name,
      slug: spec.slug,
      practiceType: spec.practiceType,
      focusSpecialty: spec.focusSpecialty ?? "",
      ownerIsDoctor: spec.ownerIsDoctor,
      ownerFrontDesk: spec.ownerFrontDesk,
      contactPhone: spec.contactPhone,
      address: spec.address,
      taxId: "",
      defaultLocale: "uz-Latn",
      timezone: "Asia/Tashkent",
      planCode: spec.planCode,
      ownerFullName: ownerName,
      ownerUsername: ownerLogin,
      ownerPassword: password,
    },
    META,
  );
  // Paid customer: active right away, no trial.
  await changeTenantStatus(actor, created.tenantId, "activate", undefined, META);
  await withPlatform((tx) => tx.subscription.updateMany({ where: { tenantId: created.tenantId }, data: { status: "ACTIVE", trialEndsAt: null } }));

  // Finish the setup in the owner's own context (their audit trail), then sign that session out.
  const login = await loginClinicUser(ownerLogin, password, META);
  if (!login.ok) throw new Error(`Owner sign-in failed: ${login.reason}`);
  try {
    const principal = await validateClinicSession(login.token);
    const ctx = principal && (await resolveClinic(principal, created.slug));
    if (!ctx) throw new Error("Owner context unavailable");
    await applyPendingSetup(ctx, META);
    const again = await resolveClinic(principal!, created.slug); // roles added by the preset
    const prices = spec.priceList.length ? await importPriceList(again!, { text: spec.priceList.join("\n") }, META) : { created: 0, updated: 0, skipped: 0 };
    if (spec.ownerHeadDoctor) {
      await withAppContext({ tenantId: again!.tenant.id, userId: again!.principal.user.id, sessionId: again!.principal.sessionId }, async (tx) => {
        const role = await tx.role.findFirst({ where: { tenantId: again!.tenant.id, key: "head_doctor" }, select: { id: true } });
        if (!role) throw new Error("head_doctor role missing");
        await tx.membershipRole.createMany({ data: [{ tenantId: again!.tenant.id, membershipId: again!.membershipId, roleId: role.id }], skipDuplicates: true });
        await recordAudit(tx, { tenantId: again!.tenant.id, actorType: "USER", actorId: again!.principal.user.id, action: "clinic.owner_clinical_role", entityType: "Membership", entityId: again!.membershipId, metadata: { role: "head_doctor", clinical: true, by: "server-task" } });
      });
    }
    // The clinic's own price list replaces the field's starter catalogue: starter services
    // left without a price would only duplicate it at the front desk (they stay archived, restorable).
    let archived = 0;
    if (spec.priceList.length) {
      for (const sv of await listServices(again!)) {
        if (!sv.priceMinor || sv.priceMinor <= 0n) {
          await setServiceArchived(again!, sv.id, true, META);
          archived++;
        }
      }
    }
    const extras = await applyClinicExtras(spec, path.dirname(specFile));
    return { slug: created.slug, prices, archived, extras };
  } finally {
    await logoutClinic(login.token);
  }
}

export interface ExtrasResult {
  templatesAdded: number;
  letterhead: string[];
  services: { created: number; updated: number; renamed: number; retired: number };
}

type AuditEntry = { action: string; entityType: string; entityId: string; metadata?: Record<string, string> };

/**
 * Brings a clinic up to its spec without overwriting what the clinic changed itself:
 * - templates (diagnostic, document, note) are added by kind + name; an existing one is left alone;
 * - letterhead details, the owner-doctor's phone and the logo are filled only while EMPTY;
 * - price list: `serviceRenames` first, then new names are added and listed names get the
 *   spec's price; `retiredServices` are archived.
 * Safe to run again on a live clinic: `node tasks.mjs update-clinic <spec.json>`.
 * Runs as a system job in the clinic's tenant context; audited.
 */
export async function applyClinicExtras(spec: ClinicSpec, specDir?: string): Promise<ExtrasResult> {
  const tenant = await platformDb().tenant.findUnique({ where: { slug: spec.slug }, select: { id: true, currency: true } });
  if (!tenant) throw new Error(`No clinic with slug ${spec.slug}`);
  const templates = specTemplates(spec);
  const prices = spec.priceList.map((l) => {
    const p = parsePriceLine(l, tenant.currency);
    if (!p) throw new Error(`Price list: cannot read "${l}"`);
    return p;
  });
  const logo = spec.logoFile && specDir ? logoDataUrl(path.join(specDir, spec.logoFile)) : null;
  return withAppContext({ tenantId: tenant.id }, async (tx) => {
    const owner = await tx.membership.findFirst({ where: { tenantId: tenant.id, status: "ACTIVE", roles: { some: { role: { key: "clinic_owner" } } } }, select: { id: true, userId: true }, orderBy: { createdAt: "asc" } });
    if (!owner) throw new Error("The clinic has no active owner");
    const audit = (e: AuditEntry) => recordAudit(tx, { ...e, tenantId: tenant.id, actorType: "SYSTEM", metadata: { ...e.metadata, by: "clinic-spec" } });

    let templatesAdded = 0;
    for (const c of templates) {
      if (await tx.clinicTemplate.findFirst({ where: { tenantId: tenant.id, kind: c.kind, name: c.name, archivedAt: null }, select: { id: true } })) continue;
      await tx.clinicTemplate.create({ data: { id: uuidv7(), tenantId: tenant.id, kind: c.kind, name: c.name, specialty: c.specialty, content: c.content, createdById: owner.userId } });
      templatesAdded++;
    }

    const current = await tx.tenant.findUniqueOrThrow({ where: { id: tenant.id }, select: { legalName: true, address: true, licenseText: true, contactPhone: true, logoDataUrl: true } });
    const fill: Record<string, string> = {};
    if (!current.legalName && spec.legalName) fill.legalName = spec.legalName;
    if (!current.address && spec.address) fill.address = spec.address;
    if (!current.licenseText && spec.licenseText) fill.licenseText = spec.licenseText;
    if (!current.contactPhone && spec.contactPhone) fill.contactPhone = spec.contactPhone;
    if (!current.logoDataUrl && logo) fill.logoDataUrl = logo;
    if (Object.keys(fill).length) await tx.tenant.update({ where: { id: tenant.id }, data: fill, select: { id: true } });
    const letterhead = Object.keys(fill);
    if (spec.ownerDoctorPhone) {
      const r = await tx.doctorProfile.updateMany({ where: { tenantId: tenant.id, membershipId: owner.id, OR: [{ contactPhone: null }, { contactPhone: "" }] }, data: { contactPhone: spec.ownerDoctorPhone } });
      if (r.count) letterhead.push("doctorPhone");
    }

    const services = await applyServices(tx, tenant, spec, prices, audit);
    if (templatesAdded || letterhead.length) {
      await recordAudit(tx, { tenantId: tenant.id, actorType: "SYSTEM", action: "clinic.spec_applied", entityType: "Tenant", entityId: tenant.id, metadata: { templatesAdded, letterhead } });
    }
    return { templatesAdded, letterhead, services };
  });
}

export type SpecTemplate = { kind: "DIAGNOSTIC" | "DOCUMENT" | "NOTE"; name: string; specialty: string | null; content: string };

/** Every template of the spec, checked the way the Templates page checks them (fields, placeholders). */
export function specTemplates(spec: ClinicSpec): SpecTemplate[] {
  const diagnostic = spec.diagnosticTemplates.map((t): SpecTemplate => {
    const { fields, badLines } = parseFieldLines(t.fields);
    if (badLines.length || !fields.length) throw new Error(`Template "${t.name}": bad field lines ${badLines.join(", ")}`);
    const unknown = unknownPlaceholders(t.body, fields);
    if (unknown.length) throw new Error(`Template "${t.name}": unknown placeholders ${unknown.join(", ")}`);
    const content: DiagnosticTemplateContent = { study: t.study, fields, body: t.body, ...(t.conclusion.trim() ? { conclusion: t.conclusion.trim() } : {}) };
    return { kind: "DIAGNOSTIC", name: t.name, specialty: null, content: JSON.stringify(content) };
  });
  const documents = spec.documentTemplates.map((t): SpecTemplate => {
    const unknown = [...t.body.matchAll(/\{\{\s*([a-zA-Z.]+)\s*\}\}/g)].map((m) => m[1]!).filter((k) => !(PLACEHOLDERS as readonly string[]).includes(k));
    if (unknown.length) throw new Error(`Document "${t.name}": unknown placeholders ${unknown.join(", ")}`);
    return { kind: "DOCUMENT", name: t.name, specialty: t.specialty ?? null, content: t.body.trim() };
  });
  const notes = spec.noteTemplates.map((t): SpecTemplate => {
    const sections = Object.fromEntries(NOTE_SECTIONS.map((k) => [k, t.sections[k] ?? ""]));
    if (Object.values(sections).every((v) => !v.trim())) throw new Error(`Note template "${t.name}" is empty`);
    return { kind: "NOTE", name: t.name, specialty: t.specialty ?? null, content: JSON.stringify(sections) };
  });
  return [...diagnostic, ...documents, ...notes];
}

async function applyServices(tx: Tx, tenant: { id: string; currency: string }, spec: ClinicSpec, prices: PriceLine[], audit: (e: AuditEntry) => Promise<void>): Promise<ExtrasResult["services"]> {
  const all = await tx.service.findMany({ where: { tenantId: tenant.id }, select: { id: true, name: true, archivedAt: true } });
  const byName = (n: string) => all.find((s) => s.name.trim().toLowerCase() === n.trim().toLowerCase());
  let renamed = 0;
  for (const r of spec.serviceRenames) {
    const from = byName(r.from);
    if (!from || byName(r.to)) continue;
    await tx.service.update({ where: { id: from.id }, data: { name: r.to } });
    await audit({ action: "service.renamed", entityType: "Service", entityId: from.id });
    from.name = r.to;
    renamed++;
  }
  const { created, updated } = prices.length ? await upsertPriceItems(tx, tenant, prices, audit) : { created: 0, updated: 0 };
  let retired = 0;
  for (const name of spec.retiredServices) {
    const s = byName(name);
    if (!s || s.archivedAt) continue;
    await tx.service.update({ where: { id: s.id }, data: { archivedAt: new Date() } });
    await audit({ action: "service.archived", entityType: "Service", entityId: s.id });
    retired++;
  }
  return { created, updated, renamed, retired };
}

/** The logo as a data URL, checked by its real bytes and size like an uploaded one. */
function logoDataUrl(file: string): string {
  const b = fs.readFileSync(file);
  const png = b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (!png && !jpeg) throw new Error(`Logo ${file}: not a PNG or JPEG`);
  if (b.length > LOGO_MAX_BYTES) throw new Error(`Logo ${file}: larger than ${LOGO_MAX_BYTES} bytes`);
  return `data:${png ? "image/png" : "image/jpeg"};base64,${b.toString("base64")}`;
}
