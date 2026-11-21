import { localToInstant, todayIn } from "@/server/scheduling/time";

/**
 * Start of a visit "happening now" that still fits today's 00:00–24:00 schedule:
 * the current minute, but never later than midnight minus the slot length.
 * Booking accepts a start up to 5 minutes in the past, so with slots of up to
 * 5 minutes this works at any hour (tests booked at "now" used to fail between
 * 23:45 and 00:00 Tashkent time, when the slot ran past midnight).
 */
export function startedSlot(timeZone: string, slotMinutes: number, nowMs = Date.now()): Date {
  if (slotMinutes > 5) throw new Error("startedSlot needs a slot of at most 5 minutes");
  const minute = Math.floor(nowMs / 60_000) * 60_000;
  const latest = localToInstant(todayIn(timeZone, new Date(nowMs)), 24 * 60 - slotMinutes, timeZone).getTime();
  return new Date(Math.min(minute, latest));
}
