/**
 * The clinic's medicine catalog: forms and search helpers shared by the server
 * and the prescription form. ITop Med ships no medicines, doses or interactions
 * of its own - every entry is written by the clinic's doctors or pharmacist.
 */

export const MEDICINE_FORMS = ["tablet", "capsule", "syrup", "suspension", "drops", "injection", "infusion", "ointment", "cream", "gel", "spray", "inhaler", "powder", "suppository", "patch", "solution", "other"] as const;
export type MedicineForm = (typeof MEDICINE_FORMS)[number];

/** Usual route of a form, offered as the default "how to take" (the doctor changes it). */
export const FORM_ROUTE_KEY: Partial<Record<MedicineForm, "oral" | "injection" | "topical" | "inhaled" | "rectal" | "drops">> = {
  tablet: "oral",
  capsule: "oral",
  syrup: "oral",
  suspension: "oral",
  powder: "oral",
  solution: "oral",
  injection: "injection",
  infusion: "injection",
  ointment: "topical",
  cream: "topical",
  gel: "topical",
  patch: "topical",
  spray: "inhaled",
  inhaler: "inhaled",
  suppository: "rectal",
  drops: "drops",
};

import { searchText } from "./search-text";

export { searchText };

/** The stored search key of an entry (name, strength, INN, group, manufacturer). */
export function medicineSearchKey(m: { name: string; strength?: string | null; inn?: string | null; drugGroup?: string | null; manufacturer?: string | null }): string {
  return searchText([m.name, m.strength, m.inn, m.drugGroup, m.manufacturer].filter(Boolean).join(" ")).slice(0, 600);
}

/** How well an entry matches the typed words: higher is better, 0 = no match. Every word must match. */
export function matchScore(query: string, m: { name: string; inn?: string | null; key: string; usageCount?: number }): number {
  const words = searchText(query).split(" ").filter(Boolean);
  if (!words.length) return 0;
  const name = searchText(m.name);
  const inn = searchText(m.inn ?? "");
  let score = 0;
  for (const w of words) {
    if (name.startsWith(w)) score += 100;
    else if (name.split(" ").some((x) => x.startsWith(w))) score += 70;
    else if (inn.startsWith(w) || inn.split(" ").some((x) => x.startsWith(w))) score += 60;
    else if (m.key.includes(w)) score += 30;
    else return 0;
  }
  return score + Math.min(m.usageCount ?? 0, 50);
}

/**
 * Splits "Bisoprolol 5 mg" into the name and the strength. A trailing amount
 * with a unit is the strength; otherwise everything is the name.
 */
export function splitStrength(text: string): { name: string; strength: string | null } {
  const t = text.trim().replace(/\s+/g, " ");
  const m = /^(.*?\S)\s+(\d+(?:[.,]\d+)?(?:\s*[/+]\s*\d+(?:[.,]\d+)?)*\s*(?:mg|mkg|mcg|µg|g|ml|%|me|iu|ед|мг|мкг|г|мл|tb|таб)(?:\s*\/\s*(?:ml|мл|doza|доза|dose|sutka))?\.?)$/i.exec(t);
  return m ? { name: m[1]!, strength: m[2]! } : { name: t, strength: null };
}

/** "Konkor 5 mg" - the line printed in a prescription. */
export function medicineLabel(m: { name: string; strength?: string | null }): string {
  return [m.name, m.strength].filter(Boolean).join(" ");
}

/** What the prescription form receives for one catalog entry. */
export interface MedicineOption {
  id: string;
  name: string;
  strength: string | null;
  inn: string | null;
  form: string;
  drugGroup: string | null;
  manufacturer: string | null;
  defaultDose: string | null;
  defaultFrequency: string | null;
  defaultRoute: string | null;
  defaultTimes: string | null;
  defaultDays: number | null;
  instructions: string | null;
  hasPhoto: boolean;
  usageCount: number;
}
