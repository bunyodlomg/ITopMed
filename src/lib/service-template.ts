/**
 * Which of the clinic's diagnostic templates (forms) belongs to a paid service, so
 * the doctor clicks "EhoKG" and the echo form opens ready. A template bound to the
 * service wins; otherwise the words of the service name are matched against the
 * template names ("Qalqonsimon bez UTT" → "UTT: qalqonsimon bez"). When the
 * template exists for women and for men, the patient's sex decides.
 */
export interface MatchTemplate {
  id: string;
  name: string;
  serviceId: string | null;
}

/** Words that say nothing about the organ studied. */
const NOISE = new Set(["utt", "uzi", "uzd", "va", "bilan", "umumiy", "a'zolari", "a'zolar", "tizimi", "+", "-", "–"]);

export function nameWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[ʻʼ’‘`´]/g, "'")
    .replace(/[(),.:;/]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length >= 3 && !NOISE.has(w));
}

export function templatesForService<T extends MatchTemplate>(service: { id: string; name: string }, templates: T[], sex?: "MALE" | "FEMALE" | string | null): T[] {
  let found = templates.filter((t) => t.serviceId === service.id);
  if (!found.length) found = byWords(nameWords(service.name.replace(/\([^)]*\)/g, " ")), templates);
  // Words in brackets are details ("… (jigar, o't pufagi, …)"); used only when the main name finds nothing.
  if (!found.length) found = byWords(nameWords(service.name), templates);
  if (found.length > 1 && (sex === "MALE" || sex === "FEMALE")) {
    const own = sex === "FEMALE" ? "ayollar" : "erkaklar";
    const other = sex === "FEMALE" ? "erkaklar" : "ayollar";
    const kept = found.filter((t) => !t.name.toLowerCase().includes(other));
    if (kept.length) found = kept.some((t) => t.name.toLowerCase().includes(own)) ? kept.filter((t) => t.name.toLowerCase().includes(own)) : kept;
  }
  return found;
}

/** The templates sharing the most words with the service name (a word matches its own start: "pufagi" ~ "pufak…"). */
function byWords<T extends MatchTemplate>(words: string[], templates: T[]): T[] {
  if (!words.length) return [];
  const scored = templates
    .map((t) => {
      const tw = nameWords(t.name);
      const score = words.filter((w) => tw.some((x) => x === w || (w.length >= 5 && (x.startsWith(w.slice(0, 6)) || w.startsWith(x.slice(0, 6)))))).length;
      return { t, score };
    })
    .filter((x) => x.score > 0);
  const best = Math.max(0, ...scored.map((x) => x.score));
  return scored.filter((x) => x.score === best).map((x) => x.t);
}
