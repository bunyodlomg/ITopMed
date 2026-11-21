import "server-only";
import QRCode from "qrcode";
import { z } from "zod";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { DomainError } from "../errors";
import { auditClinic, inClinic, requirePermission } from "./context";

export interface Letterhead {
  name: string;
  legalName: string | null;
  address: string | null;
  phone: string | null;
  taxId: string | null;
  logo: string | null;
  license: string | null;
  /** Map link and its QR code (data URL) for the letterhead. */
  locationUrl: string | null;
  locationQr: string | null;
}

/** The clinic's letterhead for printed documents, receipts and tickets (no clinical data). */
export async function getLetterhead(ctx: ClinicContext): Promise<Letterhead> {
  const t = await inClinic(ctx, (tx) =>
    tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenant.id }, select: { name: true, legalName: true, address: true, contactPhone: true, taxId: true, logoDataUrl: true, licenseText: true, locationUrl: true } }),
  );
  const locationQr = t.locationUrl ? await QRCode.toDataURL(t.locationUrl, { margin: 1, width: 120, errorCorrectionLevel: "M" }) : null;
  return { name: t.name, legalName: t.legalName, address: t.address, phone: t.contactPhone, taxId: t.taxId, logo: t.logoDataUrl, license: t.licenseText, locationUrl: t.locationUrl, locationQr };
}

export const LOGO_MAX_BYTES = 300 * 1024;
const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

const locationUrl = z
  .string()
  .trim()
  .max(500, "validation.tooLong")
  .refine((v) => {
    if (v === "") return true;
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  }, "validation.httpsUrl")
  .default("");
const letterheadSchema = z.object({ licenseText: z.string().trim().max(300, "validation.tooLong").default(""), locationUrl, removeLogo: z.preprocess((v) => v === "on" || v === true, z.boolean()).default(false) });

/** Logo is checked by its real bytes (PNG/JPEG/WebP signature), not only by the name or the browser's claim. */
function sniff(b: Buffer): string | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export async function saveLetterhead(ctx: ClinicContext, raw: { licenseText?: unknown; locationUrl?: unknown; removeLogo?: unknown; logo?: File | null }, meta: RequestMeta) {
  requirePermission(ctx, "clinic.settings.manage");
  const input = letterheadSchema.parse({ licenseText: raw.licenseText ?? "", locationUrl: raw.locationUrl ?? "", removeLogo: raw.removeLogo });
  let logo: string | null | undefined; // undefined = keep
  if (input.removeLogo) logo = null;
  else if (raw.logo && raw.logo.size > 0) {
    if (raw.logo.size > LOGO_MAX_BYTES) throw new DomainError("errors.logoTooLarge");
    const bytes = Buffer.from(await raw.logo.arrayBuffer());
    const type = sniff(bytes);
    if (!type || !LOGO_TYPES.has(type)) throw new DomainError("errors.logoType");
    logo = `data:${type};base64,${bytes.toString("base64")}`;
  }
  await inClinic(ctx, async (tx) => {
    await tx.tenant.update({ where: { id: ctx.tenant.id }, data: { licenseText: input.licenseText || null, locationUrl: input.locationUrl || null, ...(logo !== undefined ? { logoDataUrl: logo } : {}) } });
    await auditClinic(tx, ctx, meta, { action: "clinic.letterhead_updated", entityType: "Tenant", entityId: ctx.tenant.id, metadata: { logo: logo === undefined ? "kept" : logo === null ? "removed" : "uploaded" } });
  });
}
