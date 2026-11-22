import "server-only";
import { z } from "zod";
import type { ServiceKind } from "@/generated/prisma/client";
import { parseMoney } from "@/lib/money";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import type { Tx } from "../db";
import { DomainError } from "../errors";
import { uuidv7 } from "../security/crypto";
import { auditClinic, inClinic, requirePermission } from "./context";

/**
 * Price list pasted as text, one service per line - the way clinics keep it in
 * a notebook or a Telegram message:
 *   Kardiolog ko'ruvi — 100 000
 *   EXO 120 ming so'm
 *   EKG: 30000
 * New names become services; names that already exist get the new price (so
 * pasting the list again updates prices). Nothing else is changed.
 */
export interface PriceLine {
  name: string;
  priceMinor: bigint;
  kind: ServiceKind;
}

const UNIT = /\s*(so['ʻ’`]?m|сўм|сум|uzs|sum)\.?\s*$/i;

/** Parses one line; null when it has no price. */
export function parsePriceLine(line: string, currency = "UZS"): PriceLine | null {
  let s = line.replace(/^\s*(\d+[.)]|[-•*–—])\s+/, "").trim();
  if (!s) return null;
  s = s.replace(UNIT, "");
  let multiplier = 1n;
  const m = /\s*(ming|минг|тыс\.?|тысяч|k|mln|млн)\.?\s*$/i.exec(s);
  if (m) {
    multiplier = /mln|млн/i.test(m[1]!) ? 1_000_000n : 1000n;
    s = s.slice(0, m.index).replace(UNIT, "");
  }
  const p = /^(.*?)[\s:;=|–—-]*(\d[\d\s'’.,]*)$/.exec(s);
  if (!p) return null;
  const name = p[1]!.replace(/[\s:;=|–—-]+$/, "").trim();
  const digits = p[2]!.replace(/[\s'’]/g, "");
  // "100.000" / "100,000" are thousands separators; "12.5" with multiplier is a decimal.
  const normalized = multiplier > 1n ? digits.replace(",", ".") : digits.replace(/[.,](?=\d{3}(\D|$))/g, "").replace(",", ".");
  const base = parseMoney(normalized, currency);
  if (!name || name.length < 2 || base === null || base <= 0n) return null;
  const priceMinor = multiplier > 1n ? (base * multiplier) : base;
  return { name: name.slice(0, 200), priceMinor, kind: guessKind(name) };
}

export function guessKind(name: string): ServiceKind {
  const n = name.toLowerCase();
  if (/(ekg|ecg|экг|holter|холтер|smad|сутки|monitoring)/.test(n)) return "PROCEDURE";
  if (/(exo|eho|эхо|ехо|uzi|узи|uzd|utt|утт|ultra|допплер|doppler|rentgen|рентген|mrt|мрт|kt\b|кт\b|skan|скан)/.test(n)) return "IMAGING";
  if (/(tahlil|анализ|qon |крови|siydik|моча|biokim|биохим|gormon|гормон)/.test(n)) return "LAB_TEST";
  if (/(ko['ʻ’`]?r(uv|ig)|кўрув|кўриг|осмотр|konsult|консульт|qabul|приём|прием|maslahat)/.test(n)) return "CONSULTATION";
  return "PROCEDURE";
}

/** Service code from the name ("Kardiolog ko'ruvi" -> "KARDIOLOG-KORUVI"), unique in the clinic. */
export function codeFor(name: string, taken: Set<string>): string {
  const map: Record<string, string> = { ш: "SH", ч: "CH", ж: "J", ю: "YU", я: "YA", ё: "YO", ў: "O", қ: "Q", ғ: "G", ҳ: "H", х: "X", ц: "TS", щ: "SH", э: "E", й: "Y", ы: "I" };
  const lat = "абвгдезиклмнопрстуф".split("");
  const rep = "ABVGDEZIKLMNOPRSTUF".split("");
  let base = name
    .toLowerCase()
    .split("")
    .map((ch) => map[ch] ?? (lat.indexOf(ch) >= 0 ? rep[lat.indexOf(ch)] : ch))
    .join("")
    .toUpperCase()
    .replace(/[ʻ'’`]/g, "")
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  if (!base) base = "SERVICE";
  let code = base;
  for (let i = 2; taken.has(code); i++) code = `${base.slice(0, 26)}-${i}`;
  taken.add(code);
  return code;
}

export const priceListSchema = z.object({ text: z.string().max(20_000, "validation.tooLong") });

export async function importPriceList(ctx: ClinicContext, raw: unknown, meta: RequestMeta): Promise<{ created: number; updated: number; skipped: number }> {
  requirePermission(ctx, "services.manage");
  const { text } = priceListSchema.parse(raw);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const parsed = lines.map((l) => parsePriceLine(l, ctx.tenant.currency));
  const items = parsed.filter((p): p is PriceLine => p !== null);
  if (!items.length) throw new DomainError("errors.priceListEmpty");
  return inClinic(ctx, async (tx) => {
    const r = await upsertPriceItems(tx, { id: ctx.tenant.id, currency: ctx.tenant.currency }, items, (e) => auditClinic(tx, ctx, meta, e));
    return { ...r, skipped: lines.length - items.length };
  });
}

type AuditEntry = { action: string; entityType: string; entityId: string; metadata?: Record<string, string> };

/**
 * New names become services; existing names (case-insensitive) get the new
 * price and are restored if archived. Shared by the "price list" box and the
 * server task that applies a clinic spec. Runs inside the caller's clinic transaction.
 */
export async function upsertPriceItems(tx: Tx, tenant: { id: string; currency: string }, items: PriceLine[], audit: (e: AuditEntry) => Promise<void>): Promise<{ created: number; updated: number }> {
  const existing = await tx.service.findMany({ where: { tenantId: tenant.id }, select: { id: true, name: true, code: true, priceMinor: true, archivedAt: true } });
  const byName = new Map(existing.map((s) => [s.name.trim().toLowerCase(), s]));
  const taken = new Set(existing.map((s) => s.code));
  let created = 0;
  let updated = 0;
  for (const it of items) {
    const found = byName.get(it.name.toLowerCase());
    if (found) {
      if (found.priceMinor !== it.priceMinor || found.archivedAt) {
        await tx.service.update({ where: { id: found.id }, data: { priceMinor: it.priceMinor, archivedAt: null } });
        await audit({ action: "service.price_changed", entityType: "Service", entityId: found.id, metadata: { from: found.priceMinor.toString(), to: it.priceMinor.toString(), via: "price_list" } });
        updated++;
      }
      continue;
    }
    const id = uuidv7();
    await tx.service.create({ data: { id, tenantId: tenant.id, code: codeFor(it.name, taken), name: it.name, kind: it.kind, durationMinutes: it.kind === "CONSULTATION" ? 20 : 15, priceMinor: it.priceMinor, currency: tenant.currency } });
    await audit({ action: "service.created", entityType: "Service", entityId: id, metadata: { priceMinor: it.priceMinor.toString(), via: "price_list" } });
    byName.set(it.name.toLowerCase(), { id, name: it.name, code: "", priceMinor: it.priceMinor, archivedAt: null });
    created++;
  }
  return { created, updated };
}
