import { rxDrugLabel } from "@/lib/rx";
import type { Placeholder } from "../clinic/templates";
import { instantToLocalDate, zoneOffsetMs } from "../scheduling/time";

/**
 * The values of a visit document's {{placeholders}}: one place for the print
 * page and the PDF / Word file sent to the patient, so both always say the same.
 */

/** A translator with plain string keys (next-intl's `t` or `createTranslator`). */
export type Tr = (key: string, values?: Record<string, string | number>) => string;

/** Dates on medical paperwork in Uzbekistan: DD.MM.YYYY. */
export const dmy = (d: Date, tz: string) => instantToLocalDate(d, tz).split("-").reverse().join(".");
/** "14:05" in the clinic's time zone. */
export const hm = (d: Date, tz: string) => new Date(d.getTime() + zoneOffsetMs(d, tz)).toISOString().slice(11, 16);
/** Birth dates are calendar dates (stored at UTC midnight). */
export const birthText = (d: Date, yearOnly?: boolean) => (yearOnly ? String(d.getUTCFullYear()) : d.toISOString().slice(0, 10).split("-").reverse().join("."));

interface VisitDoc {
  encounter: {
    startedAt: Date;
    nextVisitDate: Date | null;
    patient: { lastName: string; firstName: string; middleName: string | null; birthDate: Date; birthYearOnly?: boolean; mrn: string; sex: string; address: string | null };
    diagnoses: { kind: string; status?: string; description: string; icd10Code: string | null }[];
    vitals: { kind: string; value: { toString(): string }; measuredAt: Date }[];
    prescriptions: { status: string; drug: string; inn: string | null; dose: string; frequency: string | null; route: string | null; durationDays: number | null; times: string | null }[];
  };
  note: { complaints: string | null; history: string | null; examination: string | null; assessment: string | null; plan: string | null } | null;
  tenant: { name: string; legalName: string | null; address: string | null; contactPhone: string | null };
  doctor: { specialty: string; contactPhone: string | null; contactTelegram: string | null; membership: { user: { fullName: string } } } | null;
  labsToTake: string[];
}

export const fullName = (p: { lastName: string; firstName: string; middleName?: string | null }) => [p.lastName, p.firstName, p.middleName].filter(Boolean).join(" ");

/** "1. Trombonet 75 mg (klopidogrel) 1 tab. 1 marta per os 30 kun" lines. */
export function prescriptionLines(rx: VisitDoc["encounter"]["prescriptions"], t: Tr): string[] {
  return rx.map((p, i) => `${i + 1}. ${[rxDrugLabel(p), p.dose, p.frequency, p.route, p.durationDays ? t("clinic.rx.days", { count: p.durationDays }) : null].filter(Boolean).join(" ")}`);
}

/** "08:00 — Veroshpiron 25 mg (spironolakton), 1/2 tabletka" lines, by time of day; medicines without times are not listed here. */
export function intakeSchedule(rx: { drug: string; inn: string | null; dose: string; times: string | null }[]): string {
  const byTime = new Map<string, string[]>();
  for (const p of rx) for (const time of (p.times ?? "").split(",").map((x) => x.trim()).filter(Boolean)) byTime.set(time, [...(byTime.get(time) ?? []), `${rxDrugLabel(p)}, ${p.dose}`]);
  return [...byTime.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([time, list]) => `${time} — ${list.join("; ")}`)
    .join("\n");
}

export function visitDocumentValues(d: VisitDoc, t: Tr, tz: string, birthDate: string): Partial<Record<Placeholder, string>> {
  const e = d.encounter;
  const active = e.diagnoses.filter((x) => x.status === "ACTIVE" || x.status === undefined);
  const dx = (kind: string) =>
    active
      .filter((x) => x.kind === kind)
      .map((x) => (x.icd10Code ? `${x.description} (${x.icd10Code})` : x.description))
      .join("; ");
  const latest = (kind: string) => [...(e.vitals ?? [])].filter((v) => v.kind === kind).sort((a, b) => +b.measuredAt - +a.measuredAt)[0]?.value.toString().replace(/\.0+$/, "");
  const sys = latest("SYSTOLIC_BP");
  const dia = latest("DIASTOLIC_BP");
  const visitYear = Number(instantToLocalDate(e.startedAt, tz).slice(0, 4));
  const rx = e.prescriptions.filter((p) => p.status === "ACTIVE");
  return {
    "patient.fullName": fullName(e.patient),
    "patient.birthDate": birthDate,
    "patient.mrn": e.patient.mrn,
    "patient.sex": t(`sex.${e.patient.sex}`),
    "patient.age": String(visitYear - e.patient.birthDate.getUTCFullYear()),
    "patient.address": e.patient.address ?? "",
    "visit.date": dmy(e.startedAt, tz),
    "doctor.fullName": d.doctor?.membership.user.fullName ?? "",
    "doctor.specialty": d.doctor ? t(`specialties.${d.doctor.specialty}`) : "",
    "clinic.name": d.tenant.legalName ?? d.tenant.name,
    "clinic.address": d.tenant.address ?? "",
    "clinic.phone": d.tenant.contactPhone ?? "",
    "note.complaints": d.note?.complaints ?? "",
    "note.history": d.note?.history ?? "",
    "note.examination": d.note?.examination ?? "",
    "note.assessment": d.note?.assessment ?? "",
    "note.plan": d.note?.plan ?? "",
    diagnoses: active.map((x) => (x.icd10Code ? `${x.icd10Code} — ${x.description}` : x.description)).join("\n"),
    "diagnoses.primary": dx("PRIMARY"),
    "diagnoses.secondary": dx("SECONDARY"),
    "diagnoses.complications": dx("COMPLICATION"),
    "vitals.bp": sys ? `${sys}/${dia ?? "—"}` : "",
    "vitals.pulse": latest("HEART_RATE") ?? "",
    "vitals.weight": latest("WEIGHT") ?? "",
    "vitals.height": latest("HEIGHT") ?? "",
    prescriptions: prescriptionLines(rx, t).join("\n"),
    "prescriptions.schedule": intakeSchedule(rx),
    labs: d.labsToTake.map((name) => `!! ${name}`).join("\n"),
    "visit.nextVisit": e.nextVisitDate ? e.nextVisitDate.toISOString().slice(0, 10).split("-").reverse().join(".") : "",
    "doctor.phone": d.doctor?.contactPhone ?? "",
    "doctor.telegram": d.doctor?.contactTelegram ?? "",
    today: dmy(new Date(), tz),
  };
}
