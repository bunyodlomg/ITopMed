import "server-only";
import { rxDrugLabel } from "@/lib/rx";
import { createTranslator } from "use-intl/core";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";
import { minorToNumber } from "@/lib/money";
import { excelDate, writeXlsx, zipFiles, type XCell, type XRow, type XSheet } from "@/lib/xlsx";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { auditClinic, inClinic, requirePermission } from "../clinic/context";
import { sequential, type Tx } from "../db";
import { rateLimit } from "../security/rate-limit";
import { DomainError } from "../tenancy/provisioning";
import { withRecordAccess } from "./access";

/**
 * One patient = one Excel workbook ("patient file"): demographics, allergies,
 * diagnoses, visits with the doctor's notes, prescriptions, vital signs, lab
 * results and payments. Used for the "Excel" download on the record, the
 * "all patients" ZIP and the folder of files kept by the local app.
 *
 * Clinical content is written as recorded (never translated). National
 * identifiers (passport, PINFL) are deliberately left out of the file.
 */

export async function loadPatientFileData(tx: Tx, patientId: string) {
  const [patient, allergies, diagnoses, vitals, encounters, prescriptions, labOrders, invoices] = await sequential([
    tx.patient.findUniqueOrThrow({
      where: { id: patientId },
      select: { id: true, mrn: true, lastName: true, firstName: true, middleName: true, birthDate: true, birthYearOnly: true, sex: true, phone: true, address: true, status: true, createdAt: true },
    }),
    tx.allergy.findMany({ where: { patientId, status: { not: "ENTERED_IN_ERROR" } }, orderBy: { recordedAt: "desc" } }),
    tx.diagnosis.findMany({ where: { patientId, status: { not: "ENTERED_IN_ERROR" } }, orderBy: { recordedAt: "desc" } }),
    tx.vitalSign.findMany({ where: { patientId }, orderBy: { measuredAt: "desc" }, take: 500 }),
    tx.encounter.findMany({
      where: { patientId },
      orderBy: { startedAt: "desc" },
      take: 300,
      include: {
        doctor: { select: { specialty: true, membership: { select: { user: { select: { fullName: true } } } } } },
        notes: { orderBy: { createdAt: "asc" }, include: { amendments: { orderBy: { createdAt: "asc" } } } },
      },
    }),
    tx.prescription.findMany({ where: { patientId }, orderBy: { createdAt: "desc" }, take: 500 }),
    tx.labOrder.findMany({
      where: { patientId },
      orderBy: { orderedAt: "desc" },
      take: 200,
      include: { items: { include: { results: { include: { analyte: { select: { name: true, sortOrder: true } } } } } } },
    }),
    tx.invoice.findMany({
      where: { patientId, status: { not: "DRAFT" } },
      orderBy: { createdAt: "desc" },
      take: 300,
      include: { lines: { orderBy: { createdAt: "asc" } }, payments: { orderBy: { receivedAt: "asc" } } },
    }),
  ]);
  const branchIds = [...new Set(encounters.map((e) => e.branchId))];
  const branches = new Map((await tx.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } })).map((b) => [b.id, b.name]));
  return { patient, allergies, diagnoses, vitals, encounters: encounters.map((e) => ({ ...e, branchName: branches.get(e.branchId) ?? "" })), prescriptions, labOrders, invoices };
}

export type PatientFileData = Awaited<ReturnType<typeof loadPatientFileData>>;
export interface FileClinic {
  name: string;
  address?: string | null;
  phone?: string | null;
  timezone: string;
  locale: string;
}

async function labels(locale: string) {
  const l: Locale = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const messages = (await import(`../../../messages/${l}.json`)).default;
  return createTranslator({ locale: l, messages });
}

export function fullName(p: { lastName: string; firstName: string; middleName?: string | null }) {
  return [p.lastName, p.firstName, p.middleName].filter(Boolean).join(" ");
}

/** Builds the workbook. Pure apart from translations; dates are shown in the clinic's time zone. */
export async function patientWorkbook(d: PatientFileData, clinic: FileClinic): Promise<Uint8Array> {
  const t = await labels(clinic.locale);
  const L = (k: string, v?: Record<string, string | number>) => t(`patientFile.${k}` as never, v as never) as string;
  const tz = clinic.timezone;
  const at = (x: Date | null | undefined): XCell => (x ? { v: excelDate(x, tz), s: "datetime" } : null);
  const day = (x: Date | null | undefined): XCell => (x ? { v: excelDate(x, tz), s: "date" } : null);
  const p = d.patient;
  const name = fullName(p);
  const sheets: XSheet[] = [];

  // ── Card ──
  const card: XRow[] = [
    { cells: [{ v: clinic.name, s: "title" }], height: 26 },
    { cells: [{ v: [clinic.address, clinic.phone].filter(Boolean).join(" · "), s: "subtitle" }] },
    { cells: [] },
    { cells: [{ v: L("title"), s: "section" }, { v: null, s: "section" }], height: 20 },
    { cells: [{ v: L("name"), s: "label" }, { v: name, s: "wrap" }] },
    { cells: [{ v: L("mrn"), s: "label" }, { v: p.mrn, s: "cell" }] },
    {
      cells: [
        { v: L("birth"), s: "label" },
        p.birthYearOnly ? { v: String(p.birthDate.getUTCFullYear()), s: "cell" } : { v: excelDate(p.birthDate), s: "date" },
      ],
    },
    { cells: [{ v: L("sex"), s: "label" }, { v: t(`sex.${p.sex}` as never), s: "cell" }] },
    { cells: [{ v: L("phone"), s: "label" }, { v: p.phone ?? "—", s: "cell" }] },
    { cells: [{ v: L("address"), s: "label" }, { v: p.address ?? "—", s: "wrap" }] },
    { cells: [{ v: L("registered"), s: "label" }, day(p.createdAt)] },
    { cells: [] },
  ];
  const activeAllergies = d.allergies.filter((a) => a.status === "ACTIVE");
  card.push({ cells: [{ v: L("allergies"), s: "section" }, { v: null, s: "section" }], height: 20 });
  if (activeAllergies.length) {
    for (const a of activeAllergies) card.push({ cells: [{ v: a.substance, s: "danger" }, { v: [t(`severity.${a.severity}` as never), a.reaction].filter(Boolean).join(" — "), s: "wrap" }] });
  } else card.push({ cells: [{ v: L("noAllergies"), s: "muted" }] });
  card.push({ cells: [] });
  card.push({ cells: [{ v: L("activeDiagnoses"), s: "section" }, { v: null, s: "section" }], height: 20 });
  const active = d.diagnoses.filter((x) => x.status === "ACTIVE");
  if (active.length) {
    for (const x of active) card.push({ cells: [{ v: x.icd10Code || "—", s: "label" }, { v: x.description, s: "wrap" }] });
  } else card.push({ cells: [{ v: L("none"), s: "muted" }] });
  card.push({ cells: [] });
  const debt = d.invoices.filter((i) => i.status !== "VOID").reduce((s, i) => s + (i.totalMinor - i.paidMinor), 0n);
  const currency = d.invoices[0]?.currency ?? "UZS";
  card.push({ cells: [{ v: L("summary"), s: "section" }, { v: null, s: "section" }], height: 20 });
  card.push({ cells: [{ v: L("visitsCount"), s: "label" }, { v: d.encounters.length, s: "number" }] });
  card.push({ cells: [{ v: L("lastVisit"), s: "label" }, d.encounters[0] ? at(d.encounters[0].startedAt) : { v: "—", s: "cell" }] });
  card.push({ cells: [{ v: L("debt", { currency }), s: "label" }, { v: debt > 0n ? minorToNumber(debt, currency) : 0, s: debt > 0n ? "moneyBold" : "money" }] });
  card.push({ cells: [] });
  card.push({ cells: [{ v: L("generated", { date: new Intl.DateTimeFormat(clinic.locale, { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(new Date()) }), s: "muted" }] });
  sheets.push({ name: L("sheetCard"), columns: [28, 70], rows: card, merges: ["A1:B1", "A2:B2", "A4:B4"] });

  // ── Visits (one row per visit, the doctor's notes in readable columns) ──
  const visitRows: XRow[] = [
    { cells: [L("visitDate"), L("doctor"), L("specialty"), L("branch"), L("complaints"), L("history"), L("examination"), L("assessment"), L("plan"), L("diagnoses"), L("visitStatus")], style: "header", height: 30 },
  ];
  for (const e of d.encounters) {
    const notes = e.notes;
    const join = (k: "complaints" | "history" | "examination" | "assessment" | "plan") =>
      notes
        .map((n) => n[k])
        .filter(Boolean)
        .join("\n\n");
    const amendments = notes.flatMap((n) => n.amendments.map((a) => `${L("amendment")}: ${a.content}`));
    const dx = d.diagnoses
      .filter((x) => x.encounterId === e.id)
      .map((x) => `${x.icd10Code ? `${x.icd10Code} ` : ""}${x.description}`)
      .join("\n");
    const signed = notes.some((n) => n.status === "SIGNED");
    visitRows.push({
      cells: [
        at(e.startedAt),
        { v: e.doctor.membership.user.fullName, s: "wrap" },
        { v: e.doctor.specialty ?? "", s: "wrap" },
        { v: e.branchName, s: "wrap" },
        { v: join("complaints"), s: "wrap" },
        { v: join("history"), s: "wrap" },
        { v: join("examination"), s: "wrap" },
        { v: join("assessment"), s: "wrap" },
        { v: [join("plan"), ...amendments].filter(Boolean).join("\n\n"), s: "wrap" },
        { v: dx, s: "wrap" },
        { v: signed ? t("status.SIGNED") : t(`status.${e.status}` as never), s: "cell" },
      ],
    });
  }
  if (d.encounters.length === 0) visitRows.push({ cells: [{ v: L("none"), s: "muted" }] });
  sheets.push({ name: L("sheetVisits"), columns: [17, 22, 18, 16, 34, 30, 34, 34, 34, 30, 14], rows: visitRows, freezeRows: 1, landscape: true });

  // ── Diagnoses (history) ──
  const dxRows: XRow[] = [{ cells: [L("date"), L("icd"), L("diagnosis"), L("kind"), L("state")], style: "header", height: 22 }];
  for (const x of d.diagnoses) dxRows.push({ cells: [at(x.recordedAt), { v: x.icd10Code || "—", s: "cell" }, { v: x.description, s: "wrap" }, { v: t(`diagnosisKind.${x.kind}` as never), s: "cell" }, { v: t(`status.${x.status}` as never), s: "cell" }] });
  if (!d.diagnoses.length) dxRows.push({ cells: [{ v: L("none"), s: "muted" }] });
  sheets.push({ name: L("sheetDiagnoses"), columns: [17, 10, 60, 16, 14], rows: dxRows, freezeRows: 1 });

  // ── Prescriptions ──
  const rxRows: XRow[] = [{ cells: [L("date"), L("drug"), L("dose"), L("frequency"), L("route"), L("days"), L("instructions"), L("state")], style: "header", height: 22 }];
  for (const r of d.prescriptions)
    rxRows.push({
      cells: [
        at(r.createdAt),
        { v: rxDrugLabel(r), s: "wrap" },
        { v: r.dose, s: "wrap" },
        { v: r.frequency, s: "wrap" },
        { v: r.route ?? "", s: "cell" },
        r.durationDays ? { v: r.durationDays, s: "number" } : { v: "", s: "cell" },
        { v: r.instructions ?? "", s: "wrap" },
        { v: t(`status.${r.status}` as never), s: r.status === "CANCELLED" ? "muted" : "cell" },
      ],
    });
  if (!d.prescriptions.length) rxRows.push({ cells: [{ v: L("none"), s: "muted" }] });
  sheets.push({ name: L("sheetPrescriptions"), columns: [17, 28, 16, 18, 12, 8, 36, 14], rows: rxRows, freezeRows: 1, landscape: true });

  // ── Vital signs ──
  const vRows: XRow[] = [{ cells: [L("date"), L("indicator"), L("value"), L("unit")], style: "header", height: 22 }];
  for (const v of d.vitals) vRows.push({ cells: [at(v.measuredAt), { v: t(`vital.${v.kind}` as never), s: "cell" }, { v: Number(v.value), s: "number" }, { v: t(`vitalUnit.${v.kind}` as never) as string, s: "cell" }] });
  if (!d.vitals.length) vRows.push({ cells: [{ v: L("none"), s: "muted" }] });
  sheets.push({ name: L("sheetVitals"), columns: [17, 30, 10, 10], rows: vRows, freezeRows: 1 });

  // ── Lab results ──
  const labRows: XRow[] = [{ cells: [L("date"), L("orderNo"), L("test"), L("analyte"), L("value"), L("unit"), L("reference"), L("flag")], style: "header", height: 22 }];
  for (const o of d.labOrders) {
    if (o.status === "CANCELLED") continue;
    for (const it of o.items) {
      const results = [...it.results].sort((a, b) => a.analyte.sortOrder - b.analyte.sortOrder);
      if (!results.length) labRows.push({ cells: [at(o.orderedAt), { v: o.number, s: "cell" }, { v: it.name, s: "wrap" }, { v: t(`status.${o.status}` as never), s: "muted" }] });
      for (const r of results) {
        const ref = r.refLow !== null || r.refHigh !== null ? `${r.refLow !== null ? Number(r.refLow) : ""}–${r.refHigh !== null ? Number(r.refHigh) : ""}` : "";
        labRows.push({
          cells: [
            at(o.resultedAt ?? o.orderedAt),
            { v: o.number, s: "cell" },
            { v: it.name, s: "wrap" },
            { v: r.analyte.name, s: "wrap" },
            { v: Number(r.value), s: "number" },
            { v: r.unit, s: "cell" },
            { v: ref, s: "cell" },
            { v: t(`labFlag.${r.flag}` as never), s: r.flag === "NORMAL" ? "cell" : "danger" },
          ],
        });
      }
    }
  }
  if (labRows.length === 1) labRows.push({ cells: [{ v: L("none"), s: "muted" }] });
  sheets.push({ name: L("sheetLab"), columns: [17, 16, 26, 26, 10, 10, 14, 18], rows: labRows, freezeRows: 1, landscape: true });

  // ── Payments ──
  const payRows: XRow[] = [{ cells: [L("date"), L("invoiceNo"), L("services"), L("total", { currency }), L("paid", { currency }), L("remaining", { currency }), L("state"), L("methods")], style: "header", height: 30 }];
  for (const i of d.invoices) {
    const cur = i.currency;
    const left = i.status === "VOID" ? 0n : i.totalMinor - i.paidMinor;
    payRows.push({
      cells: [
        at(i.issuedAt ?? i.createdAt),
        { v: i.number ?? "", s: "cell" },
        { v: i.lines.map((l) => (l.quantity > 1 ? `${l.description} × ${l.quantity}` : l.description)).join("\n"), s: "wrap" },
        { v: minorToNumber(i.totalMinor, cur), s: "money" },
        { v: minorToNumber(i.paidMinor, cur), s: "money" },
        { v: minorToNumber(left, cur), s: left > 0n ? "moneyBold" : "money" },
        { v: t(`status.${i.status}` as never), s: i.status === "VOID" ? "muted" : "cell" },
        { v: [...new Set(i.payments.map((pm) => t(`paymentMethod.${pm.method}` as never) as string))].join(", "), s: "wrap" },
      ],
    });
  }
  if (!d.invoices.length) payRows.push({ cells: [{ v: L("none"), s: "muted" }] });
  sheets.push({ name: L("sheetPayments"), columns: [17, 14, 40, 15, 15, 15, 16, 18], rows: payRows, freezeRows: 1, landscape: true });

  return writeXlsx(sheets, { title: `${clinic.name} — ${p.mrn}`, creator: "ITop Med" });
}

/** Safe file name on Windows/Linux/macOS: "<MRN> - <Last First Middle>.xlsx". */
export function patientFileName(p: { mrn: string; lastName: string; firstName: string; middleName?: string | null }): string {
  const clean = (s: string) =>
     
    s.replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  const base = clean(`${p.mrn} - ${fullName(p)}`).slice(0, 120) || clean(p.mrn) || "patient";
  return `${base}.xlsx`;
}

export async function fileClinic(tx: Tx, tenantId: string): Promise<FileClinic> {
  const c = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, address: true, contactPhone: true, timezone: true, defaultLocale: true } });
  return { name: c.name, address: c.address, phone: c.contactPhone, timezone: c.timezone, locale: c.defaultLocale };
}

// ───────────── Downloads ─────────────

/** "Excel" button on the medical record: same access rules as viewing the record. Audited. */
export async function exportPatientWorkbook(ctx: ClinicContext, patientId: string, meta: RequestMeta): Promise<{ bytes: Uint8Array; mrn: string }> {
  const { data, clinic } = await withRecordAccess(ctx, patientId, meta, { auditView: false }, async (tx, access) => {
    if (access.mode === "break_glass") throw new DomainError("errors.forbidden");
    const [data, clinic] = [await loadPatientFileData(tx, patientId), await fileClinic(tx, ctx.tenant.id)];
    await auditClinic(tx, ctx, meta, { action: "emr.exported", entityType: "Patient", entityId: patientId, metadata: { format: "xlsx", mode: access.mode } });
    return { data, clinic };
  });
  return { bytes: await patientWorkbook(data, clinic), mrn: data.patient.mrn };
}

const BATCH = 100;

/**
 * All patients of the clinic as one ZIP with a workbook per patient plus a
 * list. Only for oversight access to medical records (head doctor). Audited
 * with the number of patients only.
 */
export async function exportAllPatients(ctx: ClinicContext, meta: RequestMeta): Promise<{ bytes: Uint8Array; count: number }> {
  requirePermission(ctx, "emr.read_all");
  if (!(await rateLimit(`bulkexport:${ctx.tenant.id}`, 5, 60 * 60_000))) throw new DomainError("errors.rateLimited");
  const { ids, clinic } = await inClinic(ctx, async (tx) => ({
    ids: (await tx.patient.findMany({ where: { status: { not: "MERGED" } }, select: { id: true }, orderBy: { mrn: "asc" } })).map((p) => p.id),
    clinic: await fileClinic(tx, ctx.tenant.id),
  }));
  const files: Record<string, Uint8Array> = {};
  const list: PatientFileData["patient"][] = [];
  const lastVisit = new Map<string, Date>();
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const datas = await inClinic(ctx, async (tx) => {
      const out: PatientFileData[] = [];
      for (const id of chunk) out.push(await loadPatientFileData(tx, id));
      return out;
    });
    for (const d of datas) {
      files[uniqueName(files, patientFileName(d.patient))] = await patientWorkbook(d, clinic);
      list.push(d.patient);
      if (d.encounters[0]) lastVisit.set(d.patient.id, d.encounters[0].startedAt);
    }
  }
  files[await indexFileName(clinic.locale)] = await patientIndexWorkbook(list, lastVisit, clinic);
  await inClinic(ctx, (tx) => auditClinic(tx, ctx, meta, { action: "emr.bulk_exported", entityType: "Tenant", entityId: ctx.tenant.id, metadata: { format: "xlsx-zip", count: ids.length } }));
  return { bytes: zipFiles(files), count: ids.length };
}

function uniqueName(taken: Record<string, unknown>, name: string): string {
  if (!(name in taken)) return name;
  const base = name.replace(/\.xlsx$/, "");
  for (let n = 2; ; n++) if (!(`${base} (${n}).xlsx` in taken)) return `${base} (${n}).xlsx`;
}

export async function indexFileName(locale: string): Promise<string> {
  const t = await labels(locale);
  return `${t("patientFile.indexFile")}.xlsx`;
}

/** The overview workbook: one row per patient with the name of their file. */
export async function patientIndexWorkbook(patients: PatientFileData["patient"][], lastVisit: Map<string, Date>, clinic: FileClinic): Promise<Uint8Array> {
  const t = await labels(clinic.locale);
  const L = (k: string) => t(`patientFile.${k}` as never) as string;
  const rows: XRow[] = [
    { cells: [{ v: clinic.name, s: "title" }], height: 26 },
    { cells: [{ v: `${L("indexFile")} · ${patients.length}`, s: "subtitle" }] },
    { cells: [L("mrn"), L("name"), L("birth"), L("sex"), L("phone"), L("lastVisit"), L("file")], style: "header", height: 22 },
  ];
  for (const p of [...patients].sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName))) {
    const lv = lastVisit.get(p.id);
    rows.push({
      cells: [
        { v: p.mrn, s: "cell" },
        { v: fullName(p), s: "wrap" },
        p.birthYearOnly ? { v: String(p.birthDate.getUTCFullYear()), s: "cell" } : { v: excelDate(p.birthDate), s: "date" },
        { v: t(`sex.${p.sex}` as never), s: "cell" },
        { v: p.phone ?? "", s: "cell" },
        lv ? { v: excelDate(lv, clinic.timezone), s: "datetime" } : { v: "", s: "cell" },
        { v: patientFileName(p), s: "wrap" },
      ],
    });
  }
  return writeXlsx([{ name: L("indexFile"), columns: [12, 36, 12, 10, 18, 17, 44], rows, merges: ["A1:G1", "A2:G2"], freezeRows: 3, landscape: true }], { title: clinic.name });
}
