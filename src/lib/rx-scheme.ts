/**
 * Ready-made prescription schemes ("tayyor davolash sxemalari"): the doctor's
 * own list of medicines for a typical case, written one per line and applied
 * to a visit with a click (unneeded lines are unticked first). ITop Med ships
 * no schemes of its own — doses are clinical decisions of the clinic.
 *
 * Line format (pipe-separated, trailing columns optional):
 *   drug | INN | dose | how often | intake times | days | instructions
 *   Bisoprolol 5 mg | bisoprolol | 1 tabletka | kuniga 1 marta | 08:00 | 30 | ovqatdan keyin
 */
export type RxSchemeItem = {
  drug: string;
  inn?: string;
  dose: string;
  frequency: string;
  times?: string;
  durationDays?: string;
  instructions?: string;
};

export type RxSchemeContent = { items: RxSchemeItem[] };

const COLS = ["drug", "inn", "dose", "frequency", "times", "durationDays", "instructions"] as const;

/** Parses the editor text. `badLines` are 1-based line numbers missing drug, dose or frequency. */
export function parseSchemeLines(text: string): { items: RxSchemeItem[]; badLines: number[] } {
  const items: RxSchemeItem[] = [];
  const badLines: number[] = [];
  text.split("\n").forEach((raw, i) => {
    if (!raw.trim()) return;
    const cells = raw.split("|").map((c) => c.trim());
    if (cells.length > COLS.length) return badLines.push(i + 1);
    const item = Object.fromEntries(COLS.map((k, j) => [k, cells[j] ?? ""]).filter(([, v]) => v)) as RxSchemeItem;
    if (!item.drug || !item.dose || !item.frequency) return badLines.push(i + 1);
    items.push(item);
  });
  return { items, badLines };
}

/** Back to editor text (inverse of parseSchemeLines). */
export function schemeLines(content: RxSchemeContent): string {
  return content.items
    .map((it) => {
      const cells = COLS.map((k) => it[k] ?? "");
      while (cells.length > 4 && !cells[cells.length - 1]) cells.pop();
      return cells.join(" | ");
    })
    .join("\n");
}

export function parseSchemeContent(content: string): RxSchemeContent {
  try {
    const v = JSON.parse(content) as RxSchemeContent;
    return { items: Array.isArray(v.items) ? v.items.filter((x) => x && typeof x.drug === "string" && typeof x.dose === "string" && typeof x.frequency === "string") : [] };
  } catch {
    return { items: [] };
  }
}
