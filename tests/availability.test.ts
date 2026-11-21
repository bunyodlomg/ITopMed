import { describe, expect, it } from "vitest";
import { blocksOverlap, daySlots } from "@/server/scheduling/availability";
import { addDays, instantToLocalDate, isLocalDate, isoWeekday, localToInstant, parseHm, formatHm, todayIn } from "@/server/scheduling/time";
import { minorToDecimalString, parseMoney } from "@/lib/money";

const B = "branch-1";

describe("time-zone helpers", () => {
  it("converts Tashkent local time to UTC (UTC+5, no DST)", () => {
    expect(localToInstant("2026-11-16", 9 * 60, "Asia/Tashkent").toISOString()).toBe("2026-11-16T04:00:00.000Z");
    expect(instantToLocalDate(new Date("2026-11-15T20:30:00Z"), "Asia/Tashkent")).toBe("2026-11-16");
    expect(todayIn("Asia/Tashkent", new Date("2026-11-15T19:00:00Z"))).toBe("2026-11-16");
  });

  it("handles DST zones correctly", () => {
    // Berlin switches to summer time on 2026-03-29.
    expect(localToInstant("2026-03-28", 9 * 60, "Europe/Berlin").toISOString()).toBe("2026-03-28T08:00:00.000Z");
    expect(localToInstant("2026-03-30", 9 * 60, "Europe/Berlin").toISOString()).toBe("2026-03-30T07:00:00.000Z");
  });

  it("weekdays, dates and HH:MM parsing", () => {
    expect(isoWeekday("2026-11-16")).toBe(1); // Monday
    expect(isoWeekday("2026-11-22")).toBe(7); // Sunday
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(isLocalDate("2026-02-30")).toBe(false);
    expect(isLocalDate("2026-02-28")).toBe(true);
    expect(parseHm("09:30")).toBe(570);
    expect(parseHm("24:00")).toBe(1440);
    expect(parseHm("24:30")).toBeNull();
    expect(parseHm("9:30")).toBeNull();
    expect(formatHm(570)).toBe("09:30");
  });
});

describe("availability engine", () => {
  const blocks = [
    { weekday: 1, startMinute: 9 * 60, endMinute: 12 * 60, branchId: B, roomId: "r1" },
    { weekday: 1, startMinute: 14 * 60, endMinute: 15 * 60 + 10, branchId: B, roomId: null },
    { weekday: 2, startMinute: 9 * 60, endMinute: 10 * 60, branchId: B, roomId: null },
  ];

  it("leaves a buffer after each slot when the doctor sets one", () => {
    const at = (m: number) => localToInstant("2026-11-16", m, "Asia/Tashkent");
    const slots = daySlots({ date: "2026-11-16", timeZone: "Asia/Tashkent", blocks: [{ weekday: 1, startMinute: 9 * 60, endMinute: 10 * 60, branchId: B, roomId: null }], hasException: false, slotMinutes: 15, bufferMinutes: 2 });
    // 09:00, 09:17, 09:34 (09:51 + 15 = 10:06 would cross the block end); each slot lasts 15 minutes.
    expect(slots.map((x) => x.start)).toEqual([at(540), at(557), at(574)]);
    expect(slots.every((x) => x.end.getTime() - x.start.getTime() === 15 * 60_000)).toBe(true);
    expect(() => daySlots({ date: "2026-11-16", timeZone: "Asia/Tashkent", blocks: [], hasException: false, slotMinutes: 15, bufferMinutes: 31 })).toThrow();
  });

  it("generates aligned slots that never cross the end of a block", () => {
    const s = daySlots({ date: "2026-11-16", timeZone: "Asia/Tashkent", blocks, hasException: false, slotMinutes: 30 });
    expect(s).toHaveLength(6 + 2); // 09:00–12:00 → 6, 14:00–15:10 → 2 (15:00–15:30 would cross)
    expect(s[0]!.start.toISOString()).toBe("2026-11-16T04:00:00.000Z");
    expect(s[0]!.roomId).toBe("r1");
    expect(s.at(-1)!.end.toISOString()).toBe("2026-11-16T10:00:00.000Z");
  });

  it("returns nothing on exception days or days without blocks", () => {
    expect(daySlots({ date: "2026-11-16", timeZone: "Asia/Tashkent", blocks, hasException: true, slotMinutes: 30 })).toEqual([]);
    expect(daySlots({ date: "2026-11-18", timeZone: "Asia/Tashkent", blocks, hasException: false, slotMinutes: 30 })).toEqual([]);
  });

  it("removes busy and past slots", () => {
    const busy = [{ start: new Date("2026-11-16T04:30:00Z"), end: new Date("2026-11-16T05:10:00Z") }]; // 09:30–10:10 local
    const s = daySlots({ date: "2026-11-16", timeZone: "Asia/Tashkent", blocks, hasException: false, slotMinutes: 30, busy, notBefore: new Date("2026-11-16T04:00:01Z") });
    const starts = s.map((x) => x.start.toISOString().slice(11, 16));
    expect(starts).toEqual(["05:30", "06:00", "06:30", "09:00", "09:30"]); // UTC times
  });

  it("detects overlapping weekly blocks", () => {
    expect(blocksOverlap({ weekday: 1, startMinute: 540, endMinute: 600 }, { weekday: 1, startMinute: 599, endMinute: 700 })).toBe(true);
    expect(blocksOverlap({ weekday: 1, startMinute: 540, endMinute: 600 }, { weekday: 1, startMinute: 600, endMinute: 700 })).toBe(false);
    expect(blocksOverlap({ weekday: 1, startMinute: 540, endMinute: 600 }, { weekday: 2, startMinute: 540, endMinute: 600 })).toBe(false);
  });
});

describe("money", () => {
  it("parses localized input into minor units", () => {
    expect(parseMoney("150 000")).toBe(15_000_000n);
    expect(parseMoney("150000,5")).toBe(15_000_050n);
    expect(parseMoney("1 250.75")).toBe(125_075n);
    expect(parseMoney("-5")).toBeNull();
    expect(parseMoney("1.234")).toBeNull();
    expect(parseMoney("abc")).toBeNull();
    expect(minorToDecimalString(15_000_050n)).toBe("150000.5");
    expect(minorToDecimalString(15_000_000n)).toBe("150000");
  });
});
