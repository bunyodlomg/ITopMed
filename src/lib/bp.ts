/**
 * Home blood pressure and pulse that a patient types into the clinic's bot,
 * e.g. "135/85 72", "135/85, puls 72", "135 85 72", "135/85". Strict on purpose:
 * anything ambiguous is rejected and the bot shows the expected format, so a
 * typing mistake is never stored as a measurement.
 */
export interface Reading {
  systolic: number;
  diastolic: number;
  pulse: number | null;
}

export const READING_LIMITS = { systolic: [50, 300], diastolic: [20, 200], pulse: [20, 250] } as const;

const inRange = (v: number, [lo, hi]: readonly [number, number]) => Number.isInteger(v) && v >= lo && v <= hi;

export function validReading(r: Reading): boolean {
  return (
    inRange(r.systolic, READING_LIMITS.systolic) &&
    inRange(r.diastolic, READING_LIMITS.diastolic) &&
    r.systolic > r.diastolic &&
    (r.pulse === null || inRange(r.pulse, READING_LIMITS.pulse))
  );
}

// "AD" / "bosim" / "давление" before the numbers and "puls" / "пульс" / "p" before the pulse are allowed.
const RE = /^(?:(?:ad|a\/d|bosim|давление|ад)\s*:?\s*)?(\d{2,3})\s*(?:\/|\\|\s)\s*(\d{2,3})(?:\s*(?:mm\s*hg|мм\s*рт\.?\s*ст\.?))?(?:\s*[,;]?\s*(?:(?:puls|pulse|пульс|p|ps|чсс)\s*:?\s*)?(\d{2,3}))?\s*$/iu;

export function parseReadingText(text: string): Reading | null {
  const m = RE.exec(text.trim().replace(/\s+/g, " "));
  if (!m) return null;
  const r: Reading = { systolic: Number(m[1]), diastolic: Number(m[2]), pulse: m[3] ? Number(m[3]) : null };
  return validReading(r) ? r : null;
}

/**
 * Display band for the doctor's list, after the office/home thresholds of the
 * 2023 ESH guidelines (home BP ≥ 135/85 is elevated; ≥ 180/110 is grade 3 in the
 * office). Only a colour cue for the doctor — the patient gets no automatic advice.
 */
export function readingBand(r: { systolic: number; diastolic: number }): "low" | "normal" | "high" | "veryHigh" {
  if (r.systolic >= 180 || r.diastolic >= 110) return "veryHigh";
  if (r.systolic >= 135 || r.diastolic >= 85) return "high";
  if (r.systolic < 90 || r.diastolic < 60) return "low";
  return "normal";
}
