import { describe, expect, it } from "vitest";
import { historySuggestions, type HistoryAnswers } from "@/lib/history-wizard";

const base: HistoryAnswers = { complaints: [], bp: "", diabetes: "", smoking: "", priorMi: false, stroke: false, existing: [] };

describe("create the history: suggested diagnoses", () => {
  it("raised pressure: essential hypertension; with breathlessness on exertion, hypertensive heart disease", () => {
    expect(historySuggestions({ ...base, bp: "yes" })).toEqual(["I10"]);
    expect(historySuggestions({ ...base, systolic: 160, diastolic: 95 })).toEqual(["I10"]);
    expect(historySuggestions({ ...base, bp: "yes", complaints: ["dyspneaExertion"] })[0]).toBe("I11.9");
  });

  it("chest pain on exertion → angina; oedema with breathlessness → heart failure; palpitations → arrhythmia", () => {
    expect(historySuggestions({ ...base, complaints: ["chestPainExertion"] })).toEqual(["I20.8"]);
    expect(historySuggestions({ ...base, complaints: ["edema", "dyspneaRest"] })).toContain("I50.9");
    expect(historySuggestions({ ...base, complaints: ["palpitations", "irregular"] })).toEqual(["I49.9"]);
    expect(historySuggestions({ ...base, complaints: ["chestPainRest"] })).toEqual(["R07.4"]);
  });

  it("history and measurements: past infarction, diabetes, obesity, smoking; nothing already recorded is suggested again", () => {
    expect(historySuggestions({ ...base, priorMi: true, diabetes: "TYPE2", smoking: "CURRENT", weightKg: 100, heightCm: 170 })).toEqual(["I25.2", "E11", "E66", "Z72.0"]);
    expect(historySuggestions({ ...base, bp: "yes", existing: ["I10"] })).toEqual([]);
    expect(historySuggestions({ ...base, bp: "yes", complaints: ["dyspneaExertion"], existing: ["I11.9"] })).toEqual([]);
    expect(historySuggestions(base)).toEqual([]);
  });
});
