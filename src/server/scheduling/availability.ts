import { isoWeekday, localToInstant, type LocalDate } from "./time";

export interface ScheduleBlock {
  weekday: number;
  startMinute: number;
  endMinute: number;
  branchId: string;
  roomId: string | null;
}

export interface Busy {
  start: Date;
  end: Date;
}

export interface Slot {
  start: Date;
  end: Date;
  branchId: string;
  roomId: string | null;
}

/**
 * Bookable slots of one practitioner on one local date.
 *
 * - Uses the weekly blocks for that weekday, unless the date has an exception
 *   (day off, vacation, ...) in which case there are none.
 * - Slots are aligned to the block start and never cross the block end.
 * - `bufferMinutes` (optional) is left free after each slot: 15-minute visits
 *   with a 2-minute buffer start at 09:00, 09:17, 09:34 …
 * - Slots overlapping any `busy` interval (existing appointments — Phase 6)
 *   or starting before `notBefore` (e.g. "now") are removed.
 *
 * Pure function: deterministic and unit-tested in tests/availability.test.ts.
 */
export function daySlots(args: {
  date: LocalDate;
  timeZone: string;
  blocks: ScheduleBlock[];
  hasException: boolean;
  slotMinutes: number;
  bufferMinutes?: number;
  busy?: Busy[];
  notBefore?: Date;
}): Slot[] {
  if (args.hasException) return [];
  if (!Number.isInteger(args.slotMinutes) || args.slotMinutes < 5) throw new Error("slotMinutes must be an integer ≥ 5");
  const buffer = args.bufferMinutes ?? 0;
  if (!Number.isInteger(buffer) || buffer < 0 || buffer > 30) throw new Error("bufferMinutes must be an integer 0–30");
  const weekday = isoWeekday(args.date);
  const busy = args.busy ?? [];
  const out: Slot[] = [];
  const blocks = args.blocks.filter((b) => b.weekday === weekday).sort((a, b) => a.startMinute - b.startMinute);
  for (const b of blocks) {
    for (let m = b.startMinute; m + args.slotMinutes <= b.endMinute; m += args.slotMinutes + buffer) {
      const start = localToInstant(args.date, m, args.timeZone);
      const end = localToInstant(args.date, m + args.slotMinutes, args.timeZone);
      if (args.notBefore && start < args.notBefore) continue;
      if (busy.some((x) => x.start < end && x.end > start)) continue;
      out.push({ start, end, branchId: b.branchId, roomId: b.roomId });
    }
  }
  return out;
}

/** True when two weekly blocks on the same weekday overlap. */
export function blocksOverlap(a: Pick<ScheduleBlock, "weekday" | "startMinute" | "endMinute">, b: Pick<ScheduleBlock, "weekday" | "startMinute" | "endMinute">) {
  return a.weekday === b.weekday && a.startMinute < b.endMinute && b.startMinute < a.endMinute;
}

/** Total scheduled minutes per week — used for workload overviews. */
export function weeklyMinutes(blocks: Pick<ScheduleBlock, "startMinute" | "endMinute">[]) {
  return blocks.reduce((sum, b) => sum + (b.endMinute - b.startMinute), 0);
}
