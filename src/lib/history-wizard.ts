/**
 * "Create the history": the cardiologist answers a few questions (chips and
 * short fields) and gets the complaints and history text of the note plus
 * suggested diagnoses to confirm. Suggestions are hints for the doctor — never
 * recorded without a tick — and follow common cardiology reasoning only.
 */
import { bmi as bmiCalc } from "./calculators";

export const COMPLAINTS = [
  "chestPainExertion",
  "chestPainRest",
  "dyspneaExertion",
  "dyspneaRest",
  "palpitations",
  "irregular",
  "headache",
  "dizziness",
  "weakness",
  "edema",
  "syncope",
] as const;
export type Complaint = (typeof COMPLAINTS)[number];

export interface HistoryAnswers {
  complaints: Complaint[];
  /** Blood pressure known to rise. */
  bp: "yes" | "no" | "";
  diabetes: "" | "NO" | "TYPE1" | "TYPE2" | "OTHER";
  smoking: "" | "NEVER" | "FORMER" | "CURRENT";
  priorMi: boolean;
  stroke: boolean;
  /** Today's measurements (desk or triage). */
  systolic?: number;
  diastolic?: number;
  weightKg?: number;
  heightCm?: number;
  /** Codes the patient already has (active), not suggested again. */
  existing: string[];
}

/** Suggested ICD-10 codes, most relevant first. */
export function historySuggestions(a: HistoryAnswers): string[] {
  const has = (code: string) => a.existing.some((c) => c === code || c.startsWith(`${code}.`) || code.startsWith(`${c}.`));
  const c = new Set(a.complaints);
  const out: string[] = [];
  const add = (code: string, when: boolean) => {
    if (when && !has(code) && !out.includes(code)) out.push(code);
  };
  const highBp = (a.systolic ?? 0) >= 140 || (a.diastolic ?? 0) >= 90;
  const failure = c.has("edema") && (c.has("dyspneaExertion") || c.has("dyspneaRest"));
  const hypertension = a.bp === "yes" || highBp;
  // Hypertension with signs of heart involvement → hypertensive heart disease; otherwise essential hypertension.
  add("I11.9", hypertension && (failure || c.has("dyspneaExertion")) && !has("I10"));
  add("I10", hypertension && !out.includes("I11.9") && !has("I11") && !has("I13"));
  add("I20.8", c.has("chestPainExertion"));
  add("I50.9", failure);
  add("I49.9", c.has("palpitations") || c.has("irregular"));
  add("R07.4", c.has("chestPainRest") && !c.has("chestPainExertion"));
  add("R55", c.has("syncope"));
  add("I25.2", a.priorMi);
  add("I69.4", a.stroke);
  add("E11", a.diabetes === "TYPE2");
  add("E10", a.diabetes === "TYPE1");
  const b = bmiCalc({ weightKg: a.weightKg, heightCm: a.heightCm });
  add("E66", b.ok && b.value.bmi >= 30);
  add("Z72.0", a.smoking === "CURRENT");
  return out;
}
