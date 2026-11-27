import "server-only";
import { z } from "zod";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { auditClinic, canUseBranch, inClinic, requirePermission } from "../clinic/context";
import { withAppContext } from "../db";
import { DomainError } from "../errors";
import { randomToken, sha256Hex, uuidv7 } from "../security/crypto";
import { addDays, localToInstant, todayIn } from "../scheduling/time";
import { queueEta, roundUp5 } from "@/lib/queue-eta";

/**
 * Waiting room: the doctor presses "Next patient", the waiting-room screen (a
 * TV opened by a secret link, no sign-in) shows the queue number, the name in
 * short form and the cabinet - and can say it aloud. The screen only ever
 * gets today's queue of its own branch: number, short name, cabinet, state.
 */

const uuid = z.uuid();

/** "Karimova Dilnoza" -> "Dilnoza K." (what a public screen may show). */
export function shortName(p: { lastName: string; firstName: string }): string {
  const initial = p.lastName.trim().charAt(0).toUpperCase();
  return `${p.firstName.trim()}${initial ? ` ${initial}.` : ""}`;
}

function dayBounds(tz: string) {
  const today = todayIn(tz);
  return { gte: localToInstant(today, 0, tz), lt: localToInstant(addDays(today, 1), 0, tz) };
}

/**
 * The doctor's "Next patient": calls the next checked-in patient of this
 * doctor's queue today (lowest queue number not called yet). If a called
 * patient has not come in yet, `recall` calls them again instead.
 */
export async function callNextPatient(ctx: ClinicContext, meta: RequestMeta, opts: { recall?: boolean } = {}): Promise<{ appointmentId: string; queueNumber: number | null } | null> {
  requirePermission(ctx, "emr.write", "queue.manage");
  return inClinic(ctx, async (tx) => {
    const own = await tx.doctorProfile.findUnique({ where: { membershipId: ctx.membershipId }, select: { id: true } });
    if (!own) throw new DomainError("errors.notADoctor");
    const today = dayBounds(ctx.tenant.timezone);
    const waiting = await tx.appointment.findMany({
      where: { doctorProfileId: own.id, status: "CHECKED_IN", startsAt: today },
      orderBy: [{ queueNumber: { sort: "asc", nulls: "last" } }, { checkedInAt: "asc" }],
      select: { id: true, queueNumber: true, calledAt: true },
    });
    const target = opts.recall ? [...waiting].filter((w) => w.calledAt).sort((a, b) => +b.calledAt! - +a.calledAt!)[0] : waiting.find((w) => !w.calledAt);
    if (!target) return null;
    await tx.appointment.update({ where: { id: target.id }, data: { calledAt: new Date(), calledCount: { increment: 1 } } });
    await auditClinic(tx, ctx, meta, { action: opts.recall ? "queue.patient_recalled" : "queue.patient_called", entityType: "Appointment", entityId: target.id });
    return { appointmentId: target.id, queueNumber: target.queueNumber };
  });
}

/** The doctor's cabinet shown and spoken when a patient is called. */
export async function saveCabinet(ctx: ClinicContext, raw: unknown, meta: RequestMeta) {
  const cabinet = z.string().trim().max(40, "validation.tooLong").parse((raw as { cabinet?: unknown })?.cabinet ?? "");
  await inClinic(ctx, async (tx) => {
    const own = await tx.doctorProfile.findUnique({ where: { membershipId: ctx.membershipId }, select: { id: true } });
    if (!own) throw new DomainError("errors.notADoctor");
    await tx.doctorProfile.update({ where: { id: own.id }, data: { cabinet: cabinet || null } });
    await auditClinic(tx, ctx, meta, { action: "doctor.cabinet_set", entityType: "DoctorProfile", entityId: own.id });
  });
}

// ───────────── Screens ─────────────

export async function listScreens(ctx: ClinicContext) {
  requirePermission(ctx, "queue.manage", "clinic.settings.manage");
  return inClinic(ctx, (tx) =>
    tx.displayScreen.findMany({ where: { revokedAt: null, ...(ctx.branchIds ? { branchId: { in: ctx.branchIds } } : {}) }, select: { id: true, name: true, voice: true, createdAt: true, branch: { select: { name: true } } }, orderBy: { createdAt: "asc" } }),
  );
}

export const screenSchema = z.object({ branchId: uuid, name: z.string().trim().min(1, "validation.required").max(80, "validation.tooLong"), voice: z.boolean().default(true) });

/** A new screen link. The secret is returned once (shown to the admin) and only its hash is stored. */
export async function createScreen(ctx: ClinicContext, raw: unknown, meta: RequestMeta): Promise<{ token: string }> {
  requirePermission(ctx, "clinic.settings.manage");
  const input = screenSchema.parse(raw);
  if (!canUseBranch(ctx, input.branchId)) throw new DomainError("errors.forbidden");
  const token = randomToken(24);
  await inClinic(ctx, async (tx) => {
    const branch = await tx.branch.findFirst({ where: { id: input.branchId, archivedAt: null }, select: { id: true } });
    if (!branch) throw new DomainError("errors.notFound");
    const id = uuidv7();
    await tx.displayScreen.create({ data: { id, tenantId: ctx.tenant.id, branchId: input.branchId, name: input.name, voice: input.voice, tokenHash: sha256Hex(token), createdById: ctx.principal.user.id } });
    await auditClinic(tx, ctx, meta, { action: "screen.created", entityType: "DisplayScreen", entityId: id });
  });
  return { token };
}

export async function revokeScreen(ctx: ClinicContext, id: string, meta: RequestMeta) {
  requirePermission(ctx, "clinic.settings.manage");
  await inClinic(ctx, async (tx) => {
    const r = await tx.displayScreen.updateMany({ where: { id: uuid.parse(id), revokedAt: null }, data: { revokedAt: new Date() } });
    if (!r.count) throw new DomainError("errors.notFound");
    await auditClinic(tx, ctx, meta, { action: "screen.revoked", entityType: "DisplayScreen", entityId: id });
  });
}

export interface BoardCall {
  id: string;
  number: number | null;
  name: string;
  /** Full name for the spoken call only (the screen shows the short name). */
  spoken: string;
  cabinet: string | null;
  doctor: string;
  calledAt: string;
  calls: number;
  state: "called" | "inVisit";
}

export interface Board {
  clinic: string;
  branch: string;
  voice: boolean;
  calls: BoardCall[];
  /** eta: about when the patient goes in ("10:35", clinic time), an estimate from the planned visit lengths. */
  waiting: { number: number | null; doctor: string; eta: string | null }[];
}

/** What a screen shows; null for an unknown or revoked link. */
export async function boardForToken(token: string): Promise<Board | null> {
  if (!/^[a-z2-7]{20,80}$/.test(token)) return null;
  const hash = sha256Hex(token);
  const found = await withAppContext({}, (tx) => tx.$queryRaw<{ tenant_id: string; branch_id: string; screen_id: string; voice: boolean }[]>`SELECT * FROM app_display_lookup(${hash})`);
  const s = found[0];
  if (!s) return null;
  return withAppContext({ tenantId: s.tenant_id }, async (tx) => {
    const [tenant, branch] = [await tx.tenant.findUniqueOrThrow({ where: { id: s.tenant_id }, select: { name: true, timezone: true } }), await tx.branch.findUniqueOrThrow({ where: { id: s.branch_id }, select: { name: true } })];
    const today = dayBounds(tenant.timezone);
    const rows = await tx.appointment.findMany({
      where: { branchId: s.branch_id, startsAt: today, status: { in: ["CHECKED_IN", "IN_PROGRESS"] } },
      select: {
        id: true,
        queueNumber: true,
        status: true,
        doctorProfileId: true,
        startsAt: true,
        endsAt: true,
        startedAt: true,
        calledAt: true,
        calledCount: true,
        checkedInAt: true,
        room: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        doctor: { select: { cabinet: true, membership: { select: { user: { select: { fullName: true } } } } } },
      },
      orderBy: [{ queueNumber: { sort: "asc", nulls: "last" } }, { checkedInAt: "asc" }],
    });
    const calls = rows
      .filter((r) => r.calledAt)
      .sort((a, b) => +b.calledAt! - +a.calledAt!)
      .slice(0, 6)
      .map<BoardCall>((r) => ({
        id: r.id,
        number: r.queueNumber,
        name: shortName(r.patient),
        spoken: `${r.patient.firstName} ${r.patient.lastName}`,
        cabinet: r.room?.name ?? r.doctor.cabinet ?? null,
        doctor: r.doctor.membership.user.fullName,
        calledAt: r.calledAt!.toISOString(),
        calls: r.calledCount,
        state: r.status === "IN_PROGRESS" ? "inVisit" : "called",
      }));
    const eta = queueEta(rows, new Date());
    const hhmm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tenant.timezone });
    const waiting = rows
      .filter((r) => !r.calledAt && r.status === "CHECKED_IN")
      .slice(0, 12)
      .map((r) => ({ number: r.queueNumber, doctor: r.doctor.membership.user.fullName, eta: eta.get(r.id) ? hhmm.format(roundUp5(eta.get(r.id)!.at)) : null }));
    return { clinic: tenant.name, branch: branch.name, voice: s.voice, calls, waiting };
  });
}
