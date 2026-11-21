import "server-only";
import { z } from "zod";
import { validReading, type Reading } from "@/lib/bp";
import { recordAudit } from "../audit";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { withAppContext, withPortal } from "../db";
import { DomainError } from "../errors";
import type { PatientPrincipal } from "../portal/auth";
import { hashIp, uuidv7 } from "../security/crypto";
import { rateLimit } from "../security/rate-limit";
import { withRecordAccess } from "./access";

/**
 * Blood pressure and pulse the patient measured at home: sent as a message to
 * the clinic's bot ("135/85 72") or entered in the patient portal. Append-only,
 * patient-reported (marked as such wherever it is shown). Values never appear
 * in audit metadata, logs or outgoing messages.
 */

const DAILY_LIMIT = 30;
const SHOWN = 60;

/** A linked Telegram chat sent a reading (worker, tenant context only). */
export async function saveTelegramReading(tenantId: string, patientId: string, r: Reading, measuredAt: Date): Promise<"saved" | "limited"> {
  if (!validReading(r)) throw new DomainError("errors.invalidInput");
  if (!(await rateLimit(`reading:${patientId}`, DAILY_LIMIT, 24 * 60 * 60_000))) return "limited";
  await withAppContext({ tenantId }, async (tx) => {
    const id = uuidv7();
    await tx.patientReading.create({ data: { id, tenantId, patientId, systolic: r.systolic, diastolic: r.diastolic, pulse: r.pulse, measuredAt, source: "TELEGRAM" } });
    await recordAudit(tx, { tenantId, actorType: "SYSTEM", action: "reading.received", entityType: "PatientReading", entityId: id, metadata: { source: "TELEGRAM" } });
  });
  return "saved";
}

const int = (lo: number, hi: number) => z.coerce.number().int("validation.invalid").min(lo, "validation.range").max(hi, "validation.range");

export const readingSchema = z
  .object({
    systolic: int(50, 300),
    diastolic: int(20, 200),
    pulse: z.union([z.literal("").transform(() => null), int(20, 250)]).default(null),
  })
  .refine((r) => r.systolic > r.diastolic, { message: "validation.bpOrder", path: ["diastolic"] });

/** The patient adds a reading in the portal (or the Telegram Mini App, which opens the portal). */
export async function addMyReading(p: PatientPrincipal, raw: unknown, meta: RequestMeta) {
  const input = readingSchema.parse(raw);
  if (!(await rateLimit(`reading:${p.patientId}`, DAILY_LIMIT, 24 * 60 * 60_000))) throw new DomainError("errors.rateLimited");
  await withPortal({ sessionId: p.sessionId }, async (tx) => {
    const id = uuidv7();
    await tx.patientReading.createMany({ data: [{ id, tenantId: p.tenant.id, patientId: p.patientId, systolic: input.systolic, diastolic: input.diastolic, pulse: input.pulse, measuredAt: new Date(), source: "PORTAL" }] });
    await recordAudit(tx, { tenantId: p.tenant.id, actorType: "PATIENT", actorId: p.accountId, action: "reading.received", entityType: "PatientReading", entityId: id, ipHash: hashIp(meta.ip), metadata: { source: "PORTAL" } });
  });
}

const readingSelect = { id: true, systolic: true, diastolic: true, pulse: true, measuredAt: true, source: true } as const;

export async function listMyReadings(p: PatientPrincipal) {
  return withPortal({ sessionId: p.sessionId }, (tx) => tx.patientReading.findMany({ select: readingSelect, orderBy: { measuredAt: "desc" }, take: SHOWN }));
}

/** Home readings of one patient for the visit screen (record access required, like vital signs). */
export async function patientReadings(ctx: ClinicContext, patientId: string, meta: RequestMeta) {
  return withRecordAccess(ctx, patientId, meta, { auditView: false }, (tx) =>
    tx.patientReading.findMany({ where: { tenantId: ctx.tenant.id, patientId }, select: readingSelect, orderBy: { measuredAt: "desc" }, take: SHOWN }),
  );
}
