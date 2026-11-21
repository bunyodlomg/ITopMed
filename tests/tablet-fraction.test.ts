import { describe, expect, it } from "vitest";
import { fractionTone, parseTabletFraction } from "@/lib/tablet-fraction";

describe("tablet fractions in a prescription dose", () => {
  it("reads written fractions, mixed numbers and unicode signs", () => {
    expect(parseTabletFraction("1/4 tabletka")).toEqual({ whole: 0, num: 1, den: 4 });
    expect(parseTabletFraction("3/4 tabletka")).toEqual({ whole: 0, num: 3, den: 4 });
    expect(parseTabletFraction("1/8")).toEqual({ whole: 0, num: 1, den: 8 });
    expect(parseTabletFraction("1 1/2 tabletka")).toEqual({ whole: 1, num: 1, den: 2 });
    expect(parseTabletFraction("2/4")).toEqual({ whole: 0, num: 1, den: 2 });
    expect(parseTabletFraction("6/8")).toEqual({ whole: 0, num: 3, den: 4 });
    expect(parseTabletFraction("½ таблетки")).toEqual({ whole: 0, num: 1, den: 2 });
    expect(parseTabletFraction("1¼")).toEqual({ whole: 1, num: 1, den: 4 });
  });

  it("reads the words doctors use", () => {
    expect(parseTabletFraction("yarim tabletka")).toEqual({ whole: 0, num: 1, den: 2 });
    expect(parseTabletFraction("yarimta")).toEqual({ whole: 0, num: 1, den: 2 });
    expect(parseTabletFraction("chorak tabletka")).toEqual({ whole: 0, num: 1, den: 4 });
    expect(parseTabletFraction("uch chorak")).toEqual({ whole: 0, num: 3, den: 4 });
    expect(parseTabletFraction("1 yarim tabletka")).toEqual({ whole: 1, num: 1, den: 2 });
    expect(parseTabletFraction("половина таблетки")).toEqual({ whole: 0, num: 1, den: 2 });
  });

  it("ignores whole doses, strengths, dates and splits a tablet is not cut into", () => {
    expect(parseTabletFraction("1 tabletka")).toBeNull();
    expect(parseTabletFraction("5 mg")).toBeNull();
    expect(parseTabletFraction("1/3")).toBeNull();
    expect(parseTabletFraction("4/4")).toBeNull();
    expect(parseTabletFraction("10 ml")).toBeNull();
    expect(parseTabletFraction("12/24 mg")).toBeNull();
    expect(parseTabletFraction("Yarimbek")).toBeNull();
  });

  it("gives each piece its own colour; half is red", () => {
    expect(fractionTone({ whole: 0, num: 1, den: 2 })).toBe("danger");
    expect(fractionTone({ whole: 0, num: 1, den: 4 })).toBe("warning");
    expect(fractionTone({ whole: 0, num: 3, den: 4 })).toBe("accent");
    expect(fractionTone({ whole: 0, num: 1, den: 8 })).toBe("success");
  });
});
