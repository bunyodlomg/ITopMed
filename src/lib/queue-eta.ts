/**
 * Rough time when each waiting patient goes in ("taxminan soat 10:35"), per
 * doctor: the visit in progress takes its planned length (at least 3 more
 * minutes once overrun), then the checked-in patients in queue order, each
 * taking their own planned length. An estimate for the patient and the desk,
 * never a booking - shown as "about".
 */

export interface EtaVisit {
  id: string;
  doctorProfileId: string;
  status: string;
  queueNumber: number | null;
  checkedInAt: Date | null;
  startedAt: Date | null;
  startsAt: Date;
  endsAt: Date;
}

export interface Eta {
  /** Patients of the same doctor before this one (the one in the cabinet included). */
  ahead: number;
  /** About when this patient goes in. */
  at: Date;
  /** Minutes from now (0 = next, the cabinet is free). */
  waitMinutes: number;
}

const MIN = 60_000;
/** Planned length of a visit in minutes (5…120). */
export function plannedMinutes(v: Pick<EtaVisit, "startsAt" | "endsAt">): number {
  const m = Math.round((+v.endsAt - +v.startsAt) / MIN);
  return Math.min(120, Math.max(5, Number.isFinite(m) ? m : 15));
}

export function queueEta(visits: EtaVisit[], now: Date): Map<string, Eta> {
  const out = new Map<string, Eta>();
  const byDoctor = new Map<string, EtaVisit[]>();
  for (const v of visits) {
    if (v.status !== "CHECKED_IN" && v.status !== "IN_PROGRESS") continue;
    byDoctor.set(v.doctorProfileId, [...(byDoctor.get(v.doctorProfileId) ?? []), v]);
  }
  for (const list of byDoctor.values()) {
    let free = +now;
    let ahead = 0;
    for (const v of list.filter((x) => x.status === "IN_PROGRESS")) {
      const end = +(v.startedAt ?? now) + plannedMinutes(v) * MIN;
      free = Math.max(free, end, +now + 3 * MIN);
      ahead += 1;
    }
    const waiting = list
      .filter((x) => x.status === "CHECKED_IN")
      .sort((a, b) => (a.queueNumber ?? 1e9) - (b.queueNumber ?? 1e9) || +(a.checkedInAt ?? a.startsAt) - +(b.checkedInAt ?? b.startsAt));
    for (const v of waiting) {
      out.set(v.id, { ahead, at: new Date(free), waitMinutes: Math.max(0, Math.round((free - +now) / MIN)) });
      free += plannedMinutes(v) * MIN;
      ahead += 1;
    }
  }
  return out;
}

/** Rounds up to the next 5 minutes, so "about 10:35" rather than "10:33". */
export function roundUp5(d: Date): Date {
  const step = 5 * MIN;
  return new Date(Math.ceil(+d / step) * step);
}
