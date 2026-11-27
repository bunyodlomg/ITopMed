import { describe, expect, it } from "vitest";
import { addStaffMember, listBranches, listStaff } from "@/server/clinic/admin";
import { saveDoctorProfile } from "@/server/clinic/doctors";
import { importPriceList } from "@/server/clinic/price-list";
import { listServices } from "@/server/clinic/resources";
import { saveTemplate, templatesForVisit } from "@/server/clinic/templates";
import { rankDiagnoses, searchDiagnoses } from "@/server/emr/assist";
import { recordExtractForPrint, visitSummaryForPrint } from "@/server/emr/documents";
import { addDiagnosis, finishEncounter, getEncounter, signNote, startVisit } from "@/server/emr/record";
import { addPrescription } from "@/server/emr/prescriptions";
import { approvePatientDebt, deskCheckIn } from "@/server/reception/desk";
import { summarizeDiagnoses } from "@/lib/dx-summary";
import { plannedMinutes, queueEta, roundUp5 } from "@/lib/queue-eta";
import { withAppContext } from "@/server/db";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

async function staff(o: Awaited<ReturnType<typeof clinicWithOwner>>, roleKeys: string[]) {
  const login = uniq("s");
  await addStaffMember(o.ctx, { fullName: `Synthetic ${roleKeys.join(" ")}`, username: login, roleKeys, password: PASSWORD }, META);
  const m = (await listStaff(o.ctx)).members.find((x) => x.user.username === login)!;
  return { membershipId: m.id, ctx: await clinicContext(login, o.slug) };
}

const at = (hhmm: string) => new Date(`2026-11-26T${hhmm}:00Z`);

describe("pure helpers", () => {
  it("queue estimate: the visit in progress, then the waiting ones in queue order, each with its planned length", () => {
    const v = (id: string, doctor: string, status: string, n: number | null, start: string, minutes: number, startedAt?: string) => ({
      id, doctorProfileId: doctor, status, queueNumber: n, checkedInAt: at(start), startedAt: startedAt ? at(startedAt) : null, startsAt: at(start), endsAt: new Date(+at(start) + minutes * 60_000),
    });
    const eta = queueEta(
      [v("in", "A", "IN_PROGRESS", 1, "09:00", 20, "09:50"), v("w3", "A", "CHECKED_IN", 3, "09:20", 15), v("w2", "A", "CHECKED_IN", 2, "09:10", 10), v("b", "B", "CHECKED_IN", 4, "09:30", 20), v("done", "A", "COMPLETED", 5, "08:00", 20)],
      at("10:00"),
    );
    expect(eta.get("w2")).toMatchObject({ ahead: 1, waitMinutes: 10 }); // 09:50 + 20 = 10:10
    expect(eta.get("w3")).toMatchObject({ ahead: 2, waitMinutes: 20 });
    expect(eta.get("b")).toMatchObject({ ahead: 0, waitMinutes: 0 });
    expect(eta.has("done")).toBe(false);
    // An overrun visit still counts at least 3 more minutes.
    expect(queueEta([v("in", "A", "IN_PROGRESS", 1, "09:00", 20, "09:00"), v("w", "A", "CHECKED_IN", 2, "09:05", 10)], at("10:00")).get("w")!.waitMinutes).toBe(3);
    expect(plannedMinutes({ startsAt: at("09:00"), endsAt: at("09:01") })).toBe(5);
    expect(roundUp5(at("10:31")).toISOString()).toBe(at("10:35").toISOString());
  });

  it("diagnoses: ranking by code prefix or words (Latin/Cyrillic); one profile line per code", () => {
    const pool = [
      { icd10Code: "I10", description: "Arterial gipertenziya", uses: 9 },
      { icd10Code: "I11.9", description: "Gipertonik yurak kasalligi", uses: 2 },
      { icd10Code: "E11", description: "Qandli diabet 2-tip", uses: 5 },
    ];
    expect(rankDiagnoses(pool, "I1").map((d) => d.icd10Code)).toEqual(["I10", "I11.9"]);
    expect(rankDiagnoses(pool, "гиперт").map((d) => d.icd10Code)).toEqual(["I10", "I11.9"]);
    expect(rankDiagnoses(pool, "yurak kas").map((d) => d.icd10Code)).toEqual(["I11.9"]);
    expect(rankDiagnoses(pool, "diab").map((d) => d.icd10Code)).toEqual(["E11"]);
    expect(rankDiagnoses(pool, "").map((d) => d.icd10Code)).toEqual(["I10", "E11", "I11.9"]);
    const row = (id: string, code: string, text: string, day: string, status = "ACTIVE") => ({ id, icd10Code: code, description: text, kind: "PRIMARY", stage: null, status, recordedAt: new Date(`${day}T10:00:00Z`) });
    const s = summarizeDiagnoses([row("1", "I10", "AG", "2026-01-01"), row("2", "I10", "AG II daraja", "2026-06-01"), row("3", "", "Bel og'rig'i", "2026-03-01", "RESOLVED"), row("4", "E11", "Diabet", "2026-02-01", "ENTERED_IN_ERROR")]);
    expect(s.map((x) => [x.icd10Code, x.description, x.count, x.status])).toEqual([["I10", "AG II daraja", 2, "ACTIVE"], ["", "Bel og'rig'i", 1, "RESOLVED"]]);
    expect(s[0]!.first.toISOString().slice(0, 10)).toBe("2026-01-01");
  });
});

describe("visit papers and templates", () => {
  it("templates per doctor: specialty and service; diagnosis search keeps one-off wording private; summary and extract follow the print rules", async () => {
    const o = await clinicWithOwner(await platformActor());
    const [branch] = await listBranches(o.ctx);
    await importPriceList(o.ctx, { text: "Kardiolog ko'ruvi 100 ming\nEXO 120 ming\nUZI 70 ming" }, META);
    const services = await listServices(o.ctx);
    const sid = (n: string) => services.find((s) => s.name === n)!.id;
    const desk = await staff(o, ["receptionist"]);
    const cashier = await staff(o, ["receptionist", "cashier"]);
    const cardio = await staff(o, ["doctor"]);
    const other = await staff(o, ["doctor"]);
    const cardioId = await saveDoctorProfile(o.ctx, cardio.membershipId, { specialty: "cardiology", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
    const otherId = await saveDoctorProfile(o.ctx, other.membershipId, { specialty: "therapy", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);

    // Templates: all specialties, cardiology only, and one bound to the EXO service.
    const all = await saveTemplate(o.ctx, null, { kind: "DOCUMENT", name: "Synthetic general", body: "{{patient.fullName}}" }, META);
    const cardioDoc = await saveTemplate(o.ctx, null, { kind: "DOCUMENT", name: "Synthetic cardio", specialty: "cardiology", body: "{{patient.fullName}}" }, META);
    const echoDoc = await saveTemplate(o.ctx, null, { kind: "DOCUMENT", name: "Synthetic echo form", serviceId: sid("EXO"), body: "{{patient.fullName}}" }, META);
    await expect(saveTemplate(o.ctx, null, { kind: "DOCUMENT", name: "Bad service", serviceId: "00000000-0000-7000-8000-000000000000", body: "x" }, META)).rejects.toThrow("errors.notFound");
    const ids = async (ctx: typeof o.ctx, doctor: string, svc: string[]) => (await templatesForVisit(ctx, { doctorProfileId: doctor, serviceIds: svc })).map((x) => x.id);
    expect(await ids(cardio.ctx, cardioId, [])).toEqual(expect.arrayContaining([all, cardioDoc]));
    expect(await ids(cardio.ctx, cardioId, [])).not.toContain(echoDoc);
    expect((await ids(cardio.ctx, cardioId, [sid("EXO")]))[0]).toBe(echoDoc); // the visit's service first
    expect(await ids(other.ctx, otherId, [])).toEqual([all]);

    // A visit: diagnosis, medicine, finish.
    const r = await deskCheckIn(cashier.ctx, { lastName: "Sintetik", firstName: "Xulosa", birthDate: "1960", sex: "MALE", doctorProfileId: cardioId, branchId: branch!.id, serviceIds: [sid("Kardiolog ko'ruvi")], payMode: "debt" }, META);
    if (!r.ok) throw new Error("duplicate");
    const enc = await startVisit(cardio.ctx, r.appointmentId, META);
    const note = (await getEncounter(cardio.ctx, enc, META)).encounter.notes[0]!;
    await signNote(cardio.ctx, note.id, { complaints: "Synthetic headache", history: "", examination: "Synthetic exam", assessment: "Synthetic internal reasoning", plan: "Synthetic advice" }, META);
    await addDiagnosis(cardio.ctx, enc, { icd10Code: "I10", description: "Synthetic hypertension", kind: "PRIMARY" }, META);
    await addDiagnosis(cardio.ctx, enc, { icd10Code: "", description: "Synthetic one-off wording", kind: "SECONDARY" }, META);
    await addPrescription(cardio.ctx, enc, { drug: "Synthetic 5 mg", dose: "1 tabletka", frequency: "kuniga 1 mahal", times: "08:00" }, META);
    await finishEncounter(cardio.ctx, enc, META);

    // Diagnosis search: the author sees their own wording; another doctor only wording used at least twice.
    expect((await searchDiagnoses(cardio.ctx, "synthetic")).map((d) => d.description).sort()).toEqual(["Synthetic hypertension", "Synthetic one-off wording"]);
    expect(await searchDiagnoses(other.ctx, "synthetic")).toEqual([]);
    expect(await searchDiagnoses(desk.ctx, "I1")).toEqual([]);

    // Visit summary: the doctor prints under the record rules; the desk only once the bill is settled.
    const doc = await visitSummaryForPrint(cardio.ctx, enc, META);
    expect(doc.encounter.diagnoses.map((d) => d.icd10Code)).toContain("I10");
    expect(doc.note?.plan).toBe("Synthetic advice");
    await expect(visitSummaryForPrint(desk.ctx, enc, META)).rejects.toThrow("errors.deskPrint.unpaid");
    await approvePatientDebt(cashier.ctx, r.patientId, META);
    expect((await visitSummaryForPrint(desk.ctx, enc, META)).encounter.prescriptions).toHaveLength(1);
    const audit = await withAppContext({ tenantId: o.ctx.tenant.id }, (tx) => tx.auditEvent.count({ where: { entityId: enc, action: { in: ["document.printed", "document.printed_at_desk"] } } }));
    expect(audit).toBe(2);

    // Record extract: the treating doctor; not the desk, not a doctor without a care relationship.
    const x = await recordExtractForPrint(cardio.ctx, r.patientId, META);
    expect(summarizeDiagnoses(x.diagnoses).map((d) => d.description)).toContain("Synthetic hypertension");
    expect(x.prescriptions).toHaveLength(1);
    await expect(recordExtractForPrint(desk.ctx, r.patientId, META)).rejects.toThrow("errors.forbidden");
    await expect(recordExtractForPrint(other.ctx, r.patientId, META)).rejects.toThrow();
  });
});
