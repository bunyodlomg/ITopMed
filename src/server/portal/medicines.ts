import "server-only";
import { withPortal } from "../db";
import { addDays, instantToLocalDate } from "../scheduling/time";
import type { PatientPrincipal } from "./auth";

/** Without a duration a medicine stays on the list for a year (MED_DEFAULT_DAYS in notifications.ts limits the reminders, not this list). */
const OPEN_ENDED_DAYS = 365;

/**
 * The patient's current medicines (the Mini App opens this from a reminder):
 * active prescriptions still within their course — medicine, dose and schedule
 * only. The portal role has no access to the visit, notes or diagnoses.
 */
export async function listMyMedicines(p: PatientPrincipal) {
  const today = instantToLocalDate(new Date(), p.tenant.timezone);
  const rows = await withPortal({ sessionId: p.sessionId }, (tx) =>
    tx.prescription.findMany({
      where: { status: "ACTIVE", createdAt: { gte: new Date(Date.now() - 3651 * 86_400_000) } },
      select: { id: true, drug: true, inn: true, dose: true, frequency: true, route: true, durationDays: true, times: true, instructions: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  );
  return rows
    .map((r) => {
      const first = instantToLocalDate(r.createdAt, p.tenant.timezone);
      return { ...r, until: addDays(first, (r.durationDays ?? OPEN_ENDED_DAYS) - 1), open: r.durationDays === null };
    })
    .filter((r) => r.until >= today)
    .slice(0, 50);
}
