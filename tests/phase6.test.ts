import pg from "pg";
import { describe, expect, it } from "vitest";
import { bookAppointment, cancelAppointment, checkIn, listDay, markNoShow, registerWalkIn } from "@/server/appointments/appointments";
import { addStaffMember, listBranches, listClinicAudit, listStaff } from "@/server/clinic/admin";
import { listOperationalBranches } from "@/server/clinic/context";
import { addScheduleBlock, addScheduleException, doctorSlots, saveDoctorProfile } from "@/server/clinic/doctors";
import { addAllergy, addDiagnosis, amendNote, finishEncounter, getEncounter, getMedicalRecord, recordVitals, saveDraft, signNote, startVisit } from "@/server/emr/record";
import { getPatient, listRecentPatients, registerPatient, searchPatients } from "@/server/patients/patients";
import { addDays, isoWeekday, localToInstant, todayIn } from "@/server/scheduling/time";
import { startedSlot } from "./helpers/slots";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

const TZ = "Asia/Tashkent";

async function staff(owner: Awaited<ReturnType<typeof clinicWithOwner>>, roleKeys: string[]) {
  const login = uniq("s");
  await addStaffMember(owner.ctx, { fullName: `Synthetic ${roleKeys[0]}`, username: login, roleKeys, password: PASSWORD }, META);
  const m = (await listStaff(owner.ctx)).members.find((x) => x.user.username === login)!;
  return { login, membershipId: m.id, ctx: await clinicContext(login, owner.slug) };
}

/** A clinic with a receptionist and a doctor who works all day every day (synthetic). */
async function setup() {
  const a = await clinicWithOwner(await platformActor());
  const [branch] = await listBranches(a.ctx);
  const reception = await staff(a, ["receptionist"]);
  const doctor = await staff(a, ["doctor"]);
  const profileId = await saveDoctorProfile(a.ctx, doctor.membershipId, { specialty: "therapy", defaultSlotMinutes: 5, acceptsOnlineBooking: false }, META);
  for (let d = 1; d <= 7; d++) await addScheduleBlock(a.ctx, profileId, { weekday: d, start: "00:00", end: "24:00", branchId: branch!.id }, META);
  return { a, branch: branch!, reception, doctor, profileId, doctorCtx: await clinicContext(doctor.login, a.slug) };
}

let counter = 0;
const person = (over: Record<string, unknown> = {}) => ({
  lastName: "Sintetikov",
  firstName: `Bemor${++counter}`,
  middleName: "",
  birthDate: "1990-05-1" + (counter % 10),
  sex: "MALE",
  phone: "",
  address: "",
  pinfl: "",
  passport: "",
  ...over,
});

/** Next week's slot (always in the future) at local HH:MM. */
function futureSlot(hhmm: string, plusDays = 7) {
  const date = addDays(todayIn(TZ), plusDays);
  const [h, m] = hhmm.split(":").map(Number);
  return localToInstant(date, h! * 60 + m!, TZ).toISOString();
}

describe("patient registry", () => {
  it("assigns sequential MRNs, detects duplicates for human review, blocks identical identifiers", async () => {
    const { reception } = await setup();
    const r1 = await registerPatient(reception.ctx, person({ lastName: "Karimov", firstName: "Aziz", birthDate: "1985-03-12", phone: "+998 90 111 22 33", pinfl: "12345678901234" }), { confirmNotDuplicate: false }, META);
    expect(r1).toMatchObject({ ok: true, mrn: "P-000001" });

    const dupByPhone = await registerPatient(reception.ctx, person({ phone: "90 111 22 33" }), { confirmNotDuplicate: false }, META);
    expect(dupByPhone).toMatchObject({ ok: false, blocking: false });
    if (!dupByPhone.ok) expect(dupByPhone.duplicates[0]!.reasons).toContain("phone");

    const similar = await registerPatient(reception.ctx, person({ lastName: "Karimow", firstName: "Aziz", birthDate: "1985-03-12" }), { confirmNotDuplicate: false }, META);
    expect(similar.ok).toBe(false);
    if (!similar.ok) expect(similar.duplicates[0]!.reasons).toContain("similar_name");

    const sameId = await registerPatient(reception.ctx, person({ pinfl: "12345678901234" }), { confirmNotDuplicate: true }, META);
    expect(sameId).toMatchObject({ ok: false, blocking: true }); // confirmation cannot override an identical PINFL

    const confirmed = await registerPatient(reception.ctx, person({ lastName: "Karimow", firstName: "Aziz", birthDate: "1985-03-12" }), { confirmNotDuplicate: true }, META);
    expect(confirmed).toMatchObject({ ok: true, mrn: "P-000002" });

    await expect(registerPatient(reception.ctx, person({ birthDate: "2999-01-01" }), { confirmNotDuplicate: true }, META)).rejects.toThrow("errors.birthDateRange");
    await expect(registerPatient(reception.ctx, person({ pinfl: "123" }), { confirmNotDuplicate: true }, META)).rejects.toThrow();
  });

  it("smart search by MRN, typo-tolerant name, phone, PINFL and birth date", async () => {
    const { reception } = await setup();
    await registerPatient(reception.ctx, person({ lastName: "Rahimova", firstName: "Nilufar", birthDate: "1992-07-04", phone: "+998931234567", pinfl: "40407920000011" }), { confirmNotDuplicate: false }, META);
    const names = async (q: string) => (await searchPatients(reception.ctx, q)).map((p) => p.lastName);
    expect(await names("P-1")).toEqual(["Rahimova"]);
    expect(await names("rahimova nil")).toEqual(["Rahimova"]);
    expect(await names("Rakhimova Nilufar")).toEqual(["Rahimova"]); // transliteration-style typo
    expect(await names("93 123 45 67")).toEqual(["Rahimova"]);
    expect(await names("40407920000011")).toEqual(["Rahimova"]);
    expect(await names("04.07.1992")).toEqual(["Rahimova"]);
    expect(await names("x")).toEqual([]);
  });

  it("lists the latest registrations first and only this clinic's", async () => {
    const { reception, a } = await setup();
    const first = await registerPatient(reception.ctx, person({ lastName: "Avvalgi" }), { confirmNotDuplicate: true }, META);
    const second = await registerPatient(reception.ctx, person({ lastName: "Keyingi" }), { confirmNotDuplicate: true }, META);
    const other = await setup();
    await registerPatient(other.reception.ctx, person({ lastName: "Begona" }), { confirmNotDuplicate: true }, META);

    const recent = await listRecentPatients(reception.ctx);
    expect(recent.map((p) => p.lastName)).toEqual(["Keyingi", "Avvalgi"]);
    expect(first.ok && second.ok).toBe(true);
    expect((await listRecentPatients(reception.ctx, 1)).map((p) => p.lastName)).toEqual(["Keyingi"]);
    // The other clinic's patient never shows here (and the reverse).
    expect((await listRecentPatients(other.reception.ctx)).map((p) => p.lastName)).toEqual(["Begona"]);
    expect(a.ctx.tenant.id).not.toBe(other.a.ctx.tenant.id);
  });

  it("demographic views are audited without personal data in the audit trail", async () => {
    const { a, reception } = await setup();
    const r = await registerPatient(reception.ctx, person({ lastName: "Yusupov", firstName: "Bobur" }), { confirmNotDuplicate: false }, META);
    if (!r.ok) throw new Error("register");
    expect((await getPatient(reception.ctx, r.id, META))?.mrn).toBe(r.mrn);
    const audit = await listClinicAudit(a.ctx, 50);
    expect(audit.some((e) => e.action === "patient.viewed" && e.entityId === r.id)).toBe(true);
    expect(JSON.stringify(audit.map((e) => e.metadata))).not.toMatch(/Yusupov|Bobur/);
  });
});

describe("appointments and queue", () => {
  it("books inside working hours only and prevents double booking, even under concurrency", async () => {
    const { reception, profileId, a } = await setup();
    const p = await registerPatient(reception.ctx, person(), { confirmNotDuplicate: false }, META);
    const q = await registerPatient(reception.ctx, person(), { confirmNotDuplicate: false }, META);
    if (!p.ok || !q.ok) throw new Error("register");

    const at = futureSlot("10:00");
    const results = await Promise.allSettled([
      bookAppointment(reception.ctx, { patientId: p.id, doctorProfileId: profileId, startsAt: at }, META),
      bookAppointment(reception.ctx, { patientId: q.id, doctorProfileId: profileId, startsAt: at }, META),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/errors.slotTaken/);

    // Overlapping (not identical) start is also rejected.
    await expect(bookAppointment(reception.ctx, { patientId: q.id, doctorProfileId: profileId, startsAt: futureSlot("10:02") }, META)).rejects.toThrow("errors.slotTaken");
    // Booked slot disappears from availability.
    const date = addDays(todayIn(TZ), 7);
    const slots = (await doctorSlots(reception.ctx, profileId, date)).map((s) => s.start.toISOString());
    expect(slots).not.toContain(at);

    // Cancelling frees the slot.
    const day = await listDay(reception.ctx, date);
    await cancelAppointment(reception.ctx, day[0]!.id, "PATIENT_REQUEST", META);
    await bookAppointment(reception.ctx, { patientId: q.id, doctorProfileId: profileId, startsAt: at }, META);

    // Absence days and the past are rejected.
    await addScheduleException(a.ctx, profileId, { date: addDays(todayIn(TZ), 8), kind: "VACATION" }, META);
    await expect(bookAppointment(reception.ctx, { patientId: p.id, doctorProfileId: profileId, startsAt: futureSlot("10:00", 8) }, META)).rejects.toThrow("errors.outsideSchedule");
    await expect(bookAppointment(reception.ctx, { patientId: p.id, doctorProfileId: profileId, startsAt: new Date(Date.now() - 3_600_000).toISOString() }, META)).rejects.toThrow("errors.slotInPast");
  });

  it("rejects bookings outside the doctor's hours", async () => {
    const a = await clinicWithOwner(await platformActor());
    const [branch] = await listBranches(a.ctx);
    const doctor = await staff(a, ["doctor"]);
    const profileId = await saveDoctorProfile(a.ctx, doctor.membershipId, { specialty: "therapy", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
    const date = addDays(todayIn(TZ), 7);
    await addScheduleBlock(a.ctx, profileId, { weekday: isoWeekday(date), start: "09:00", end: "12:00", branchId: branch!.id }, META);
    const p = await registerPatient(a.ctx, person(), { confirmNotDuplicate: false }, META).catch(() => null);
    // Owners lack patients.create — registration is front-desk work.
    expect(p).toBeNull();
    const rec = await staff(a, ["receptionist"]);
    const r = await registerPatient(rec.ctx, person(), { confirmNotDuplicate: false }, META);
    if (!r.ok) throw new Error("register");
    await expect(bookAppointment(rec.ctx, { patientId: r.id, doctorProfileId: profileId, startsAt: futureSlot("11:50") }, META)).rejects.toThrow("errors.outsideSchedule"); // would end 12:10
    await bookAppointment(rec.ctx, { patientId: r.id, doctorProfileId: profileId, startsAt: futureSlot("11:40") }, META);
  });

  it("check-in assigns daily queue numbers; walk-ins join the queue without blocking slots", async () => {
    const { reception, profileId, branch, doctorCtx } = await setup();
    const p = await registerPatient(reception.ctx, person(), { confirmNotDuplicate: false }, META);
    const q = await registerPatient(reception.ctx, person(), { confirmNotDuplicate: false }, META);
    if (!p.ok || !q.ok) throw new Error("register");
    const now = startedSlot(TZ, 5).toISOString(); // the doctor's slot is 5 minutes
    const apptId = await bookAppointment(reception.ctx, { patientId: p.id, doctorProfileId: profileId, startsAt: now }, META);
    expect(await checkIn(reception.ctx, apptId, META)).toBe(1);
    await expect(checkIn(reception.ctx, apptId, META)).rejects.toThrow("errors.invalidTransition");

    await registerWalkIn(reception.ctx, { patientId: q.id, doctorProfileId: profileId, branchId: branch.id }, META);
    const today = await listDay(reception.ctx, todayIn(TZ));
    expect(today.map((x) => x.queueNumber).sort()).toEqual([1, 2]);
    expect(today.find((x) => x.source === "WALK_IN")?.status).toBe("CHECKED_IN");

    // The doctor sees only their own day; future bookings cannot be marked no-show.
    expect((await listDay(doctorCtx, todayIn(TZ))).length).toBe(2);
    const later = await bookAppointment(reception.ctx, { patientId: q.id, doctorProfileId: profileId, startsAt: futureSlot("09:00") }, META);
    await expect(markNoShow(reception.ctx, later, META)).rejects.toThrow("errors.notYetStarted");
  });
});

describe("screen data for operational roles (regression)", () => {
  it("front desk, nurses and HR can load branch lists for their screens; scope is respected", async () => {
    const s = await setup();
    const nurse = await staff(s.a, ["nurse"]);
    const hr = await staff(s.a, ["hr_manager"]);
    for (const ctx of [s.reception.ctx, nurse.ctx, hr.ctx]) expect((await listOperationalBranches(ctx)).map((b) => b.id)).toEqual([s.branch.id]);
    const cashier = await staff(s.a, ["cashier"]);
    expect((await listOperationalBranches(cashier.ctx)).length).toBe(1);
    const pharmacist = await staff(s.a, ["pharmacist"]); // stock is kept per branch
    expect((await listOperationalBranches(pharmacist.ctx)).length).toBe(1);
    const lab = await staff(s.a, ["lab_staff"]);
    await expect(listOperationalBranches(lab.ctx)).rejects.toThrow("errors.forbidden");
  });
});

describe("medical record access (ABAC) and the visit workflow", () => {
  it("care relationship, denial, break-the-glass, oversight — all audited", async () => {
    const s = await setup();
    const p = await registerPatient(s.reception.ctx, person(), { confirmNotDuplicate: false }, META);
    if (!p.ok) throw new Error("register");

    // No relationship yet → denied, and the denial is audited.
    await expect(getMedicalRecord(s.doctorCtx, p.id, META)).rejects.toThrow("errors.noCareRelationship");
    // Front desk and owner have no clinical permission at all.
    await expect(getMedicalRecord(s.reception.ctx, p.id, META)).rejects.toThrow("errors.forbidden");
    await expect(getMedicalRecord(s.a.ctx, p.id, META)).rejects.toThrow("errors.forbidden");

    // Break the glass with a reason category.
    const bg = await getMedicalRecord(s.doctorCtx, p.id, META, { breakGlass: "EMERGENCY" });
    expect(bg.access.mode).toBe("break_glass");

    // A booked visit establishes the care relationship.
    await bookAppointment(s.reception.ctx, { patientId: p.id, doctorProfileId: s.profileId, startsAt: futureSlot("09:00") }, META);
    expect((await getMedicalRecord(s.doctorCtx, p.id, META)).access.mode).toBe("care");

    // Another doctor of the same clinic has no relationship.
    const other = await staff(s.a, ["doctor"]);
    await expect(getMedicalRecord(other.ctx, p.id, META)).rejects.toThrow("errors.noCareRelationship");
    // The head doctor has audited oversight access.
    const head = await staff(s.a, ["head_doctor"]);
    expect((await getMedicalRecord(head.ctx, p.id, META)).access.mode).toBe("oversight");

    const audit = await listClinicAudit(s.a.ctx, 100);
    const actions = audit.filter((e) => e.entityId === p.id).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["emr.access_denied", "emr.break_glass", "emr.viewed"]));
  });

  it("nurses see records only of patients visiting their branch today", async () => {
    const s = await setup();
    const nurse = await staff(s.a, ["nurse"]);
    const p = await registerPatient(s.reception.ctx, person(), { confirmNotDuplicate: false }, META);
    if (!p.ok) throw new Error("register");
    await expect(getMedicalRecord(nurse.ctx, p.id, META)).rejects.toThrow("errors.noCareRelationship");
    await registerWalkIn(s.reception.ctx, { patientId: p.id, doctorProfileId: s.profileId, branchId: s.branch.id }, META);
    expect((await getMedicalRecord(nurse.ctx, p.id, META)).access.mode).toBe("care");
    await recordVitals(nurse.ctx, p.id, { SYSTOLIC_BP: "120", DIASTOLIC_BP: "80", TEMPERATURE: "36,6" }, META);
    await expect(recordVitals(nurse.ctx, p.id, { TEMPERATURE: "366" }, META)).rejects.toThrow();
  });

  it("start visit → draft → sign (immutable, hashed) → amend → finish", async () => {
    const s = await setup();
    const p = await registerPatient(s.reception.ctx, person(), { confirmNotDuplicate: false }, META);
    if (!p.ok) throw new Error("register");
    const appt = await registerWalkIn(s.reception.ctx, { patientId: p.id, doctorProfileId: s.profileId, branchId: s.branch.id }, META);

    const other = await staff(s.a, ["doctor"]);
    await saveDoctorProfile(s.a.ctx, other.membershipId, { specialty: "therapy", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
    await expect(startVisit(other.ctx, appt, META)).rejects.toThrow("errors.notYourPatient");

    const encounterId = await startVisit(s.doctorCtx, appt, META);
    expect(await startVisit(s.doctorCtx, appt, META)).toBe(encounterId); // idempotent
    let enc = await getEncounter(s.doctorCtx, encounterId, META);
    const noteId = enc.encounter.notes[0]!.id;

    const content = { complaints: "Synthetic: headache", history: "Synthetic", examination: "Synthetic", assessment: "", plan: "Synthetic" };
    await saveDraft(s.doctorCtx, noteId, content, META);
    await expect(signNote(s.doctorCtx, noteId, content, META)).rejects.toThrow("errors.assessmentRequired");
    await expect(finishEncounter(s.doctorCtx, encounterId, META)).rejects.toThrow("errors.signNoteFirst");
    await addDiagnosis(s.doctorCtx, encounterId, { icd10Code: "r51", description: "Synthetic diagnosis text", kind: "PRIMARY" }, META);
    await expect(addDiagnosis(s.doctorCtx, encounterId, { icd10Code: "headache", description: "x", kind: "PRIMARY" }, META)).rejects.toThrow();
    await addAllergy(s.doctorCtx, p.id, { substance: "Synthetic substance", reaction: "", severity: "SEVERE" }, META);
    await signNote(s.doctorCtx, noteId, { ...content, assessment: "Synthetic assessment" }, META);
    await expect(saveDraft(s.doctorCtx, noteId, content, META)).rejects.toThrow("errors.noteSigned");

    // The database itself refuses to change a signed note, even for the schema owner.
    const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.connect();
    await expect(owner.query(`UPDATE "ClinicalNote" SET plan = 'tampered' WHERE id = $1`, [noteId])).rejects.toThrow(/immutable/);
    await expect(owner.query(`DELETE FROM "ClinicalNote" WHERE id = $1`, [noteId])).rejects.toThrow(/cannot be deleted/);

    await expect(amendNote(s.doctorCtx, noteId, { reason: "typo", content: "x" }, META)).rejects.toThrow();
    await amendNote(s.doctorCtx, noteId, { reason: "Synthetic correction", content: "Synthetic amended plan" }, META);
    await finishEncounter(s.doctorCtx, encounterId, META);

    const rec = await getMedicalRecord(s.doctorCtx, p.id, META);
    const note = rec.encounters[0]!.notes[0]!;
    expect(note.status).toBe("SIGNED");
    expect(note.integrityOk).toBe(true);
    expect(note.amendments[0]!.integrityOk).toBe(true);
    expect(rec.diagnoses[0]!.icd10Code).toBe("R51");
    expect(rec.allergies[0]!.severity).toBe("SEVERE");
    expect((await listDay(s.reception.ctx, todayIn(TZ))).find((x) => x.id === appt)?.status).toBe("COMPLETED");

    // Tampering outside the application is detected by the content hash.
    await owner.query(`ALTER TABLE "ClinicalNote" DISABLE TRIGGER clinical_note_guard`);
    await owner.query(`UPDATE "ClinicalNote" SET plan = 'tampered' WHERE id = $1`, [noteId]);
    await owner.query(`ALTER TABLE "ClinicalNote" ENABLE TRIGGER clinical_note_guard`);
    await owner.end();
    enc = await getEncounter(s.doctorCtx, encounterId, META);
    const after = await getMedicalRecord(s.doctorCtx, p.id, META);
    expect(after.encounters[0]!.notes[0]!.integrityOk).toBe(false);
  });

  it("clinical tables are invisible to the platform role and isolated between clinics", async () => {
    const s = await setup();
    const p = await registerPatient(s.reception.ctx, person(), { confirmNotDuplicate: false }, META);
    if (!p.ok) throw new Error("register");
    const platform = new pg.Client({ connectionString: process.env.PLATFORM_DATABASE_URL });
    await platform.connect();
    for (const t of ["Patient", "Appointment", "Encounter", "ClinicalNote", "Diagnosis", "Allergy", "VitalSign"]) {
      await expect(platform.query(`SELECT 1 FROM "${t}" LIMIT 1`)).rejects.toThrow(/permission denied/);
    }
    await platform.end();
    const other = await setup();
    expect(await getPatient(other.reception.ctx, p.id, META)).toBeNull();
    expect(await searchPatients(other.reception.ctx, "Sintetikov")).not.toContainEqual(expect.objectContaining({ id: p.id }));
  });
});
