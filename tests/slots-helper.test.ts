import { describe, expect, it } from "vitest";
import { instantToLocalDate, localToInstant } from "@/server/scheduling/time";
import { startedSlot } from "./helpers/slots";

const TZ = "Asia/Tashkent";

describe("startedSlot (test helper)", () => {
  it("stays inside today's schedule and within the 5-minute booking tolerance at any hour", () => {
    for (const hhmm of [[12, 0], [23, 44], [23, 58], [0, 2]] as const) {
      const now = localToInstant("2026-11-21", hhmm[0] * 60 + hhmm[1], TZ).getTime() + 37_000;
      const start = startedSlot(TZ, 5, now);
      const end = new Date(start.getTime() + 5 * 60_000);
      expect(start.getTime()).toBeLessThanOrEqual(now);
      expect(start.getTime()).toBeGreaterThanOrEqual(now - 5 * 60_000);
      expect(instantToLocalDate(end, TZ) === instantToLocalDate(start, TZ) || end.getTime() === localToInstant(instantToLocalDate(start, TZ), 24 * 60, TZ).getTime()).toBe(true);
    }
  });
});
