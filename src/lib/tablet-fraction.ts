/**
 * Tablet fractions in a prescription dose ("1/4 tabletka", "1 1/2", "½", "yarim",
 * "chorak"). Doctors split tablets into halves, quarters and eighths and draw the
 * piece for the patient; the printed prescription shows the same picture.
 * Only splits a scored tablet can sensibly be cut into are recognised (2, 4, 8).
 */
export type TabletFraction = { whole: number; num: number; den: 2 | 4 | 8 };

const UNICODE: Record<string, [number, 2 | 4 | 8]> = { "½": [1, 2], "¼": [1, 4], "¾": [3, 4], "⅛": [1, 8], "⅜": [3, 8], "⅝": [5, 8], "⅞": [7, 8] };

/** Word forms in the clinic languages; checked longest first ("uch chorak" before "chorak"). */
const WORDS: [RegExp, number, 2 | 4 | 8][] = [
  [/(^|[^\p{L}])(uch\s+chorak|уч\s+чорак|три\s+четверти)(?![\p{L}])/iu, 3, 4],
  [/(^|[^\p{L}])(chorak|чорак|четверть|quarter)(?![\p{L}])/iu, 1, 4],
  [/(^|[^\p{L}])(yarim(ta)?|ярим(та)?|половин[аеуы]|half)(?![\p{L}])/iu, 1, 2],
];

function make(whole: number, num: number, den: number): TabletFraction | null {
  if (den !== 2 && den !== 4 && den !== 8) return null;
  if (num <= 0 || num >= den || whole < 0 || whole > 9) return null;
  // Reduce 2/4 → 1/2, 4/8 → 1/2, 2/8 → 1/4, 6/8 → 3/4.
  while (num % 2 === 0 && den > 2) {
    num /= 2;
    den /= 2;
  }
  return { whole, num, den: den as 2 | 4 | 8 };
}

export function parseTabletFraction(dose: string): TabletFraction | null {
  const s = dose.trim();
  // "1 1/2", "1/4", "3/4 tabletka" — a whole number may precede the fraction.
  const m = /(?:^|[^\d/.,])(?:(\d)\s+)?(\d)\s*\/\s*(\d)(?![\d/])/.exec(` ${s}`);
  if (m) return make(m[1] ? Number(m[1]) : 0, Number(m[2]), Number(m[3]));
  const u = /(?:(\d)\s*)?([½¼¾⅛⅜⅝⅞])/.exec(s);
  if (u) return make(u[1] ? Number(u[1]) : 0, UNICODE[u[2]!]![0], UNICODE[u[2]!]![1]);
  for (const [re, num, den] of WORDS) {
    if (re.test(s)) {
      const w = /^(\d)\s/.exec(s);
      return make(w ? Number(w[1]) : 0, num, den);
    }
  }
  return null;
}

/** Colour family per piece so whole / half / quarter are told apart at a glance (half = red, as doctors mark it). */
export function fractionTone(f: TabletFraction): "danger" | "warning" | "accent" | "success" {
  if (f.den === 2) return "danger";
  if (f.den === 4) return f.num === 1 ? "warning" : "accent";
  return "success";
}

/** Doses offered as one-click choices on the prescription form. */
export const DOSE_SUGGESTIONS = ["1", "1/2", "1/4", "3/4", "1/8", "1 1/2", "2"] as const;
