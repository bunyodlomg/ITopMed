import type { TemplateField } from "./diagnostic-template";

/**
 * Derived echocardiography values, computed from what the doctor measured so
 * they are not worked out by hand. Standard formulas only; the doctor sees
 * every result in its field and may overwrite it. A template takes part by
 * using these field keys (Farhod MedServis's echo form does):
 *
 *   lvedd, lvesd (KDR, KSR)   -> edv, esv (Teichholz: V = 7 / (2.4 + D) * D^3, D in cm)
 *   edv, esv                  -> efTeich = (EDV - ESV) / EDV * 100, sv = EDV - ESV
 *   lvedd, lvesd              -> fs = (KDR - KSR) / KDR * 100
 *   sv, hr                    -> co = SV * HR / 1000 (l/min)
 *   mvE, mvA / tvE, tvA       -> mvEA / tvEA = E / A
 *   ivs, lvedd, lvpw          -> lvMass = 0.8 * 1.04 * ((IVS + KDR + PW)^3 - KDR^3) + 0.6 (ASE, cm -> g)
 *   lvMass, bsa               -> lvMassIndex = mass / BSA
 *
 * Lengths are read in the unit of the template field ("mm" or "sm"/"cm").
 * Synonyms: edd = lvedd, esd = lvesd, lvmi = lvMassIndex (the Cyrillic form file).
 */

type Values = Record<string, string>;

interface Rule {
  target: string;
  needs: string[];
  digits: number;
  calc: (v: (key: string) => number) => number | null;
}

const toNumber = (s: string | undefined) => (s === undefined ? NaN : Number(s.trim().replace(",", ".")));

const teichholz = (dCm: number) => (7 / (2.4 + dCm)) * dCm ** 3;

const RULES: Rule[] = [
  { target: "edv", needs: ["lvedd"], digits: 0, calc: (v) => teichholz(v("lvedd")) },
  { target: "esv", needs: ["lvesd"], digits: 0, calc: (v) => teichholz(v("lvesd")) },
  { target: "efTeich", needs: ["edv", "esv"], digits: 0, calc: (v) => (v("edv") > 0 ? ((v("edv") - v("esv")) / v("edv")) * 100 : null) },
  { target: "sv", needs: ["edv", "esv"], digits: 0, calc: (v) => v("edv") - v("esv") },
  { target: "fs", needs: ["lvedd", "lvesd"], digits: 0, calc: (v) => (v("lvedd") > 0 ? ((v("lvedd") - v("lvesd")) / v("lvedd")) * 100 : null) },
  { target: "co", needs: ["sv", "hr"], digits: 1, calc: (v) => (v("sv") * v("hr")) / 1000 },
  { target: "mvEA", needs: ["mvE", "mvA"], digits: 2, calc: (v) => (v("mvA") > 0 ? v("mvE") / v("mvA") : null) },
  { target: "tvEA", needs: ["tvE", "tvA"], digits: 2, calc: (v) => (v("tvA") > 0 ? v("tvE") / v("tvA") : null) },
  { target: "lvMass", needs: ["ivs", "lvedd", "lvpw"], digits: 0, calc: (v) => 0.8 * 1.04 * ((v("ivs") + v("lvedd") + v("lvpw")) ** 3 - v("lvedd") ** 3) + 0.6 },
  { target: "lvMassIndex", needs: ["lvMass", "bsa"], digits: 0, calc: (v) => (v("bsa") > 0 ? v("lvMass") / v("bsa") : null) },
];

/** Other keys a template may use for the same value. */
const ALIASES: Record<string, string[]> = { lvedd: ["edd"], lvesd: ["esd"], lvMassIndex: ["lvmi"] };

/** The template's own key for a value (the canonical key or one of its synonyms), if it has one. */
function keyIn(keys: ReadonlySet<string>, canonical: string): string | undefined {
  return [canonical, ...(ALIASES[canonical] ?? [])].find((k) => keys.has(k));
}

/** Keys that hold a length: their value is converted to cm before a formula uses it. */
const LENGTH_KEYS = new Set(["lvedd", "lvesd", "ivs", "lvpw"]);

function toCm(value: number, unit: string | undefined): number {
  const u = (unit ?? "").trim().toLowerCase();
  return u === "mm" || u === "мм" ? value / 10 : value;
}

/** Decimal comma, as the clinics write numbers on medical paper ("5,4"). */
function format(n: number, digits: number): string {
  return String(Number(n.toFixed(digits))).replace(".", ",");
}

/** The formulas a template can use (every key of the rule is one of its fields). */
export function echoCalculations(fields: TemplateField[]): string[] {
  const keys = new Set(fields.map((f) => f.key));
  return RULES.filter((r) => keyIn(keys, r.target) && r.needs.every((k) => keyIn(keys, k))).map((r) => keyIn(keys, r.target)!);
}

/**
 * Fills the computable fields. `auto` are the keys the program filled before
 * (it may refresh them); a field the doctor typed into is never overwritten.
 * Rules run in order, so a computed EDV feeds EF and SV, SV feeds CO, and so on.
 * Returns the new values and the set of keys that are now computed.
 */
export function applyEchoCalculations(fields: TemplateField[], values: Values, auto: ReadonlySet<string>): { values: Values; auto: Set<string> } {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const keys = new Set(byKey.keys());
  const out: Values = { ...values };
  const nextAuto = new Set<string>();
  for (const rule of RULES) {
    const target = keyIn(keys, rule.target);
    const needs = rule.needs.map((k) => keyIn(keys, k));
    if (!target || needs.some((k) => !k)) continue;
    const typedByDoctor = (out[target] ?? "").trim() !== "" && !auto.has(target);
    if (typedByDoctor) continue;
    const read = (canonical: string) => {
      const key = keyIn(keys, canonical)!;
      const n = toNumber(out[key]);
      return LENGTH_KEYS.has(canonical) ? toCm(n, byKey.get(key)!.unit) : n;
    };
    const ready = needs.every((k) => Number.isFinite(toNumber(out[k!])) && (out[k!] ?? "").trim() !== "");
    const result = ready ? rule.calc(read) : null;
    if (result === null || !Number.isFinite(result) || result < 0) {
      if (auto.has(target)) out[target] = ""; // inputs gone: clear what the program had filled
      continue;
    }
    out[target] = format(result, rule.digits);
    nextAuto.add(target);
  }
  return { values: out, auto: nextAuto };
}
