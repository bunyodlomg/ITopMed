import { describe, expect, it } from "vitest";
import { buckets, change, methodGroup, resolvePeriod } from "@/lib/finance-period";

describe("dashboard money periods", () => {
  const today = "2026-11-24"; // a Tuesday

  it("resolves the presets in clinic days, with the same-length previous period", () => {
    expect(resolvePeriod(today, "today")).toMatchObject({ from: today, to: today, prevFrom: "2026-11-23", prevTo: "2026-11-23", days: 1 });
    expect(resolvePeriod(today, "yesterday")).toMatchObject({ from: "2026-11-23", to: "2026-11-23", prevFrom: "2026-11-22" });
    expect(resolvePeriod(today, "week")).toMatchObject({ from: "2026-11-23", to: today, days: 2, prevFrom: "2026-11-21", prevTo: "2026-11-22" });
    expect(resolvePeriod(today, "month")).toMatchObject({ from: "2026-11-01", to: today, days: 24, prevTo: "2026-10-31", prevFrom: "2026-10-08" });
    expect(resolvePeriod(today, "lastMonth")).toMatchObject({ from: "2026-10-01", to: "2026-10-31", days: 31, prevTo: "2026-09-30", prevFrom: "2026-08-31" });
    expect(resolvePeriod("2026-03-10", "lastMonth")).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("checks a custom range; nonsense falls back to this month", () => {
    expect(resolvePeriod(today, "custom", "2026-01-01", "2026-01-31")).toMatchObject({ key: "custom", days: 31 });
    expect(resolvePeriod(today, "custom", "2026-02-30", "2026-03-01").key).toBe("month");
    expect(resolvePeriod(today, "custom", "2026-05-01", "2026-04-01").key).toBe("month");
    expect(resolvePeriod(today, "custom", "2026-11-01", "2026-12-01").key).toBe("month"); // in the future
    expect(resolvePeriod(today, "custom", "2020-01-01", "2026-01-01").days).toBe(366);
    expect(resolvePeriod(today, "bogus").key).toBe("month");
  });

  it("groups methods and fills chart buckets (days up to a month, then months)", () => {
    expect([methodGroup("CASH"), methodGroup("CARD"), methodGroup("PAYME"), methodGroup("BANK_TRANSFER")]).toEqual(["cash", "card", "other", "other"]);
    const rows = [
      { day: "2026-11-02", method: "CASH", net: 100n },
      { day: "2026-11-02", method: "CARD", net: 50n },
      { day: "2026-11-03", method: "CLICK", net: 7n },
      { day: "2026-10-30", method: "CASH", net: 999n }, // outside: ignored
    ];
    const d = buckets({ from: "2026-11-01", to: "2026-11-03", days: 3 }, rows);
    expect(d.unit).toBe("day");
    expect(d.items).toEqual([
      { key: "2026-11-01", cash: 0n, card: 0n, other: 0n },
      { key: "2026-11-02", cash: 100n, card: 50n, other: 0n },
      { key: "2026-11-03", cash: 0n, card: 0n, other: 7n },
    ]);
    const m = buckets({ from: "2026-09-15", to: "2026-11-03", days: 50 }, rows);
    expect(m.unit).toBe("month");
    expect(m.items.map((b) => [b.key, b.cash])).toEqual([["2026-09", 0n], ["2026-10", 999n], ["2026-11", 100n]]);
  });

  it("compares with the previous period", () => {
    expect(change(150n, 100n)).toEqual({ value: 50, direction: "up" });
    expect(change(50n, 100n)).toEqual({ value: 50, direction: "down" });
    expect(change(100n, 0n)).toBeNull();
  });
});
