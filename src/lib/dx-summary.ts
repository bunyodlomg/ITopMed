import { searchText } from "./search-text";

export interface DxRow {
  id: string;
  icd10Code: string;
  description: string;
  kind: string;
  stage: string | null;
  status: string;
  recordedAt: Date;
}

export interface DxSummary {
  key: string;
  icd10Code: string;
  /** The latest wording. */
  description: string;
  stage: string | null;
  /** Main / accompanying / complication: the latest kind. */
  kind: string;
  /** ACTIVE if the latest entry is active. */
  status: string;
  first: Date;
  last: Date;
  /** In how many records (visits) it was written. */
  count: number;
}

/**
 * All of a patient's diagnoses in one list (the patient profile): the same
 * code (or, without a code, the same wording) once, with the first and last
 * date and how often it was written; active ones first, then the newest.
 */
export function summarizeDiagnoses(rows: DxRow[]): DxSummary[] {
  const by = new Map<string, DxSummary>();
  for (const r of [...rows].filter((x) => x.status !== "ENTERED_IN_ERROR").sort((a, b) => +a.recordedAt - +b.recordedAt)) {
    const key = r.icd10Code ? `code:${r.icd10Code.toUpperCase()}` : `text:${searchText(r.description)}`;
    const cur = by.get(key);
    if (!cur) {
      by.set(key, { key, icd10Code: r.icd10Code, description: r.description, stage: r.stage, kind: r.kind, status: r.status, first: r.recordedAt, last: r.recordedAt, count: 1 });
    } else {
      cur.description = r.description;
      cur.stage = r.stage ?? cur.stage;
      cur.kind = r.kind;
      cur.status = r.status;
      cur.last = r.recordedAt;
      cur.count += 1;
    }
  }
  return [...by.values()].sort((a, b) => Number(b.status === "ACTIVE") - Number(a.status === "ACTIVE") || +b.last - +a.last);
}
