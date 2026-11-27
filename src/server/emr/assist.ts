import "server-only";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { inClinic } from "../clinic/context";
import { sequential } from "../db";
import { searchText } from "@/lib/search-text";
import { DomainError } from "../errors";
import { NOTE_SECTIONS, getEncounter, saveDraft } from "./record";

/**
 * Helpers that make the doctor faster without deciding anything for them:
 * the clinic's most used diagnoses (one click fills the form) and copying the
 * previous visit's signed note into the empty sections of today's draft.
 */

/** The clinic's most used diagnoses (code + wording as the doctors wrote them). */
export async function frequentDiagnoses(ctx: ClinicContext, take = 12): Promise<{ icd10Code: string; description: string; uses: number }[]> {
  if (!ctx.permissions.has("emr.write")) return [];
  const rows = await inClinic(ctx, (tx) =>
    tx.diagnosis.groupBy({
      by: ["icd10Code", "description"],
      where: { status: { not: "ENTERED_IN_ERROR" }, recordedAt: { gte: new Date(Date.now() - 365 * 86_400_000) } },
      _count: { _all: true },
      orderBy: { _count: { icd10Code: "desc" } },
      take,
    }),
  );
  return rows.map((r) => ({ icd10Code: r.icd10Code, description: r.description, uses: r._count._all }));
}

/**
 * Fills the EMPTY sections of today's draft from the patient's last signed
 * note of an earlier visit; nothing the doctor already wrote is replaced.
 * Returns false when there is no earlier signed note.
 */
export async function copyPreviousNote(ctx: ClinicContext, encounterId: string, meta: RequestMeta): Promise<boolean> {
  const { encounter, isOwn } = await getEncounter(ctx, encounterId, meta);
  if (!isOwn) throw new DomainError("errors.notYourPatient");
  const draft = encounter.notes.find((n) => n.status === "DRAFT" && n.authorId === ctx.principal.user.id);
  if (!draft) throw new DomainError("errors.noDraftNote");
  const previous = await inClinic(ctx, (tx) =>
    tx.clinicalNote.findFirst({
      where: { patientId: encounter.patient.id, status: "SIGNED", encounterId: { not: encounter.id }, encounter: { startedAt: { lt: encounter.startedAt } } },
      orderBy: { signedAt: "desc" },
      select: { complaints: true, history: true, examination: true, assessment: true, plan: true },
    }),
  );
  if (!previous) return false;
  const merged = Object.fromEntries(NOTE_SECTIONS.map((s) => [s, (draft[s] ?? "").trim() ? draft[s] : previous[s]])) as Record<(typeof NOTE_SECTIONS)[number], string>;
  await saveDraft(ctx, draft.id, merged, meta);
  return true;
}

export interface DiagnosisSuggestion {
  icd10Code: string;
  description: string;
  uses: number;
}

/**
 * Diagnoses as the doctor types (code "I1" or words, Latin or Cyrillic): the
 * clinic's own codes and wording from the last three years. To keep one
 * patient's free text out of other doctors' lists, a wording is offered only
 * when it was used at least twice in the clinic or written by this doctor.
 * ITop Med adds no codes of its own (no official ICD-10 file is loaded).
 */
export async function searchDiagnoses(ctx: ClinicContext, q: string, take = 10): Promise<DiagnosisSuggestion[]> {
  if (!ctx.permissions.has("emr.write")) return [];
  const since = new Date(Date.now() - 3 * 365 * 86_400_000);
  const where = { status: { not: "ENTERED_IN_ERROR" as const }, recordedAt: { gte: since } };
  const [all, mine] = await inClinic(ctx, (tx) =>
    sequential([
      tx.diagnosis.groupBy({ by: ["icd10Code", "description"], where, _count: { _all: true }, orderBy: { _count: { icd10Code: "desc" } }, take: 3000 }),
      tx.diagnosis.groupBy({ by: ["icd10Code", "description"], where: { ...where, recordedById: ctx.principal.user.id }, _count: { _all: true }, orderBy: { _count: { icd10Code: "desc" } }, take: 3000 }),
    ]),
  );
  const own = new Set(mine.map((r) => `${r.icd10Code}|${r.description}`));
  const pool = all.filter((r) => r._count._all >= 2 || own.has(`${r.icd10Code}|${r.description}`)).map((r) => ({ icd10Code: r.icd10Code, description: r.description, uses: r._count._all }));
  return rankDiagnoses(pool, q).slice(0, take);
}

/** Ranking for searchDiagnoses (pure): code prefix, then words of the wording, then the most used. */
export function rankDiagnoses(pool: DiagnosisSuggestion[], q: string): DiagnosisSuggestion[] {
  const query = q.trim().slice(0, 80);
  if (!query) return [...pool].sort((a, b) => b.uses - a.uses);
  const code = query.toUpperCase().replace(/\s+/g, "");
  const words = searchText(query).split(" ").filter(Boolean);
  const scored = pool.flatMap((d) => {
    let s = 0;
    if (/^[A-Z]\d/.test(code) && d.icd10Code.startsWith(code)) s = 1000 - d.icd10Code.length;
    else {
      const text = searchText(d.description);
      const parts = text.split(" ");
      for (const w of words) {
        if (parts.some((p) => p.startsWith(w))) s += 50;
        else if (text.includes(w)) s += 20;
        else return [];
      }
    }
    return s > 0 ? [{ d, s: s + Math.min(d.uses, 100) }] : [];
  });
  return scored.sort((a, b) => b.s - a.s || a.d.description.localeCompare(b.d.description)).map((x) => x.d);
}
