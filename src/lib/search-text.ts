/** Matching text for searches typed in Latin or Cyrillic (medicines, diagnoses). */

// Uzbek (Cyrillic) and Russian letters to the Latin spelling people type.
const CYR: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", ғ: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "y", к: "k", қ: "q", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ў: "o", ф: "f", х: "x", ҳ: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sh", ъ: "", ы: "i", ь: "", э: "e", ю: "yu", я: "ya",
};

/**
 * Lower-case Latin text for matching: Cyrillic transliterated, apostrophes and
 * punctuation dropped, spelling variants folded ("Конкор" = "konkor",
 * "Bisoprolol" = "bisoprolol", "x"/"h", "c"/"k"/"q" and "ph"/"f" meet).
 */
export function searchText(input: string): string {
  const lower = input.toLocaleLowerCase("ru");
  let out = "";
  for (const ch of lower) out += CYR[ch] ?? ch;
  return out
    .normalize("NFKD")
    .replace(/\p{Mn}/gu, "")
    .replace(/['`ʻʼ‘’]/g, "")
    .replace(/ph/g, "f")
    .replace(/[xh]/g, "h")
    .replace(/[cq]/g, "k")
    .replace(/[^a-z0-9.,%/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
