import { describe, expect, it } from "vitest";
import { parseFieldLines } from "@/lib/diagnostic-template";
import { applyEchoCalculations, echoCalculations } from "@/lib/echo-calc";

// The shape of Farhod MedServis's echo form (lengths in cm).
const { fields } = parseFieldLines(
  [
    "hr | YuQS | marta |  | ",
    "bsa | BSA | m² |  | ",
    "ivs | Qorinchalararo to'siq | sm | 0.7-1.1 | ",
    "lvpw | ChQ orqa devori | sm | 0.7-1.1 | ",
    "lvedd | KDR | sm | 3.8-5.6 | ",
    "lvesd | KSR | sm | 2.5-3.8 | ",
    "efTeich | FV (Teyxolts) | % | 55-70 | ",
    "fs | FU | % | 28-43 | ",
    "sv | UO | ml | 60-100 | ",
    "edv | KDO | ml | 110-147 | ",
    "esv | KSO | ml | 46-75 | ",
    "co | MO | l/min | 3.5-4.5 | ",
    "lvMass | ChQ massasi | g |  | ",
    "lvMassIndex | ChQ massasi indeksi | g/m² |  | ",
    "mvE | E | m/s |  | ",
    "mvA | A | m/s |  | ",
    "mvEA | E/A |  | 1-2 | ",
  ].join("\n"),
);

describe("echo calculations", () => {
  it("knows which formulas a template can use", () => {
    expect(echoCalculations(fields).sort()).toEqual(["co", "edv", "efTeich", "esv", "fs", "lvMass", "lvMassIndex", "mvEA", "sv"].sort());
    expect(echoCalculations(parseFieldLines("organ | A'zo |  |  | ").fields)).toEqual([]);
  });

  it("computes Teichholz volumes, EF, FS, SV, CO, E/A and LV mass from the measurements", () => {
    const r = applyEchoCalculations(fields, { lvedd: "5,0", lvesd: "3.2", hr: "70", ivs: "1.0", lvpw: "1.0", mvE: "0.8", mvA: "0.6", bsa: "1.9" }, new Set());
    // EDV = 7 / 7.4 * 125 = 118.2; ESV = 7 / 5.6 * 32.768 = 41.0
    expect(r.values).toMatchObject({ edv: "118", esv: "41", efTeich: "65", fs: "36", sv: "77", co: "5,4", mvEA: "1,33", lvMass: "182", lvMassIndex: "96" });
    expect([...r.auto].sort()).toEqual(["co", "edv", "efTeich", "esv", "fs", "lvMass", "lvMassIndex", "mvEA", "sv"].sort());
  });

  it("never overwrites a value the doctor typed, but uses it for the next formulas", () => {
    const r = applyEchoCalculations(fields, { lvedd: "5.0", lvesd: "3.2", edv: "120", esv: "40" }, new Set());
    expect(r.values).toMatchObject({ edv: "120", esv: "40", efTeich: "67", sv: "80" });
    expect(r.auto.has("edv")).toBe(false);
  });

  it("refreshes what it computed when a measurement changes, and clears it when the input is removed", () => {
    const first = applyEchoCalculations(fields, { mvE: "0.8", mvA: "0.4" }, new Set());
    expect(first.values.mvEA).toBe("2");
    const changed = applyEchoCalculations(fields, { ...first.values, mvA: "0.8" }, first.auto);
    expect(changed.values.mvEA).toBe("1");
    const removed = applyEchoCalculations(fields, { ...changed.values, mvA: "" }, changed.auto);
    expect(removed.values.mvEA).toBe("");
    expect(removed.auto.has("mvEA")).toBe(false);
  });

  it("reads lengths given in mm", () => {
    const mm = parseFieldLines(["lvedd | KDR | mm |  | ", "edv | KDO | ml |  | "].join("\n")).fields;
    expect(applyEchoCalculations(mm, { lvedd: "50" }, new Set()).values.edv).toBe("118");
  });

  it("ignores text that is not a number", () => {
    const r = applyEchoCalculations(fields, { lvedd: "normada" }, new Set());
    expect(r.values.edv).toBeUndefined();
  });
});

describe("echo calculations with the Cyrillic form's keys", () => {
  it("edd / esd / lvmi work like lvedd / lvesd / lvMassIndex; lengths in см", () => {
    const cyr = parseFieldLines(["edd | КДР | см | 3,8-5,6 | ", "esd | КСР | см |  | ", "edv | КДО | мл |  | ", "esv | КСО | мл |  | ", "efTeich | ФВ | % |  | ", "ivs | МЖП | см |  | ", "lvpw | ЗСЛЖ | см |  | ", "lvMass | Масса | г |  | ", "bsa | BSA | м2 |  | ", "lvmi | ИММ | г/м2 |  | "].join("\n")).fields;
    expect(echoCalculations(cyr).sort()).toEqual(["edv", "efTeich", "esv", "lvMass", "lvmi"].sort());
    const r = applyEchoCalculations(cyr, { edd: "5,0", esd: "3,2", ivs: "1", lvpw: "1", bsa: "1,9" }, new Set());
    expect(r.values).toMatchObject({ edv: "118", esv: "41", efTeich: "65", lvMass: "182", lvmi: "96" });
  });
});
