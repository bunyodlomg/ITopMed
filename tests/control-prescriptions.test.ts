import pg from "pg";
import { describe, expect, it } from "vitest";
import { bookAppointment, cancelAppointment, registerWalkIn, rescheduleAppointment } from "@/server/appointments/appointments";
import { addInvoiceLine, createInvoice, getInvoice, issueInvoice, recordPayment } from "@/server/billing/billing";
import { openShift } from "@/server/billing/cash";
import { addStaffMember, listBranches, listStaff } from "@/server/clinic/admin";
import { addScheduleBlock, saveDoctorProfile } from "@/server/clinic/doctors";
import { controlCenter } from "@/server/clinic/oversight";
import { getClinicPolicy, updateClinicPolicy } from "@/server/clinic/policy";
import { completeSetup } from "@/server/clinic/practice";
import { createService } from "@/server/clinic/resources";
import { platformDb } from "@/server/db";
import { addPrescription, allergyMatches, applyPrescriptionScheme, cancelPrescription } from "@/server/emr/prescriptions";
import { saveTemplate } from "@/server/clinic/templates";
import { parseSchemeLines, schemeLines } from "@/lib/rx-scheme";
import { addAllergy, getEncounter, startVisit } from "@/server/emr/record";
import { rxDrugLabel } from "@/lib/rx";
import { registerPatient } from "@/server/patients/patients";
import { addDays, isoWeekday, localToInstant, todayIn } from "@/server/scheduling/time";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

const TZ = "Asia/Tashkent";

async function staff(owner: Awaited<ReturnType<typeof clinicWithOwner>>, roleKeys: string[]) {
  const login = uniq("s");
  await addStaffMember(owner.ctx, { fullName: `Synthetic ${roleKeys.join("+")}`, username: login, roleKeys, password: PASSWORD }, META);
  const m = (await listStaff(owner.ctx)).members.find((x) => x.user.username === login)!;
  return { login, membershipId: m.id, ctx: await clinicContext(login, owner.slug) };
}

let n = 0;
async function setup() {
  const a = await clinicWithOwner(await platformActor());
  const [branch] = await listBranches(a.ctx);
  const reception = await staff(a, ["receptionist"]);
  const cashier = await staff(a, ["cashier"]);
  const admin = await staff(a, ["clinic_admin"]);
  const doctor = await staff(a, ["doctor"]);
  const profileId = await saveDoctorProfile(a.ctx, doctor.membershipId, { specialty: "cardiology", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
  const service = await createService(a.ctx, { code: `S${++n}`, name: "Synthetic consultation", kind: "CONSULTATION", durationMinutes: 20, price: "200000", currency: "UZS" }, META);
  const patient = await registerPatient(reception.ctx, { lastName: "Sintetik", firstName: `Bemor${n}`, birthDate: "1980-03-03", sex: "MALE" }, { confirmNotDuplicate: true }, META);
  if (!patient.ok) throw new Error("patient");
  return { a, branch: branch!, reception, cashier, admin, doctor, profileId, service, patientId: patient.id, doctorCtx: await clinicContext(doctor.login, a.slug) };
}

describe("clinic control policy: discount limits", () => {
  it("staff are limited, the owner is not; a reason can be required; only the owner sets the rules", async () => {
    const s = await setup();
    expect(await getClinicPolicy(s.a.ctx)).toMatchObject({ maxDiscountPercent: 100, discountReasonRequired: false });
    await expect(updateClinicPolicy(s.admin.ctx, { maxDiscountPercent: 100, discountReasonRequired: false }, META)).rejects.toThrow("errors.ownerOnly");
    await expect(updateClinicPolicy(s.a.ctx, { maxDiscountPercent: 150, discountReasonRequired: false }, META)).rejects.toThrow();
    await updateClinicPolicy(s.a.ctx, { maxDiscountPercent: 10, discountReasonRequired: true }, META); // booking rules keep their defaults

    const inv = await createInvoice(s.cashier.ctx, { patientId: s.patientId, branchId: s.branch.id }, META);
    // 200 000 so'm line: 10% = 20 000.
    await expect(addInvoiceLine(s.cashier.ctx, inv, { serviceId: s.service, quantity: 1, discount: "20001", discountReason: "Regular patient" }, META)).rejects.toThrow("errors.discountOverLimit");
    await expect(addInvoiceLine(s.cashier.ctx, inv, { serviceId: s.service, quantity: 1, discount: "20000" }, META)).rejects.toThrow("errors.discountReasonRequired");
    await addInvoiceLine(s.cashier.ctx, inv, { serviceId: s.service, quantity: 1, discount: "20000", discountReason: "Regular patient" }, META);
    await addInvoiceLine(s.cashier.ctx, inv, { serviceId: s.service, quantity: 1 }, META); // no discount: no reason needed
    // The owner may exceed the limit (still with a reason, the rule applies to everyone). A small-practice
    // owner who also runs the front desk gets the cashier role through the setup assistant.
    await completeSetup(s.a.ctx, { practiceType: "SOLO_PRACTICE", applyModules: false, addStarterServices: false, ownerIsDoctor: false, ownerFrontDesk: true, specialty: "", weekdaySchedule: false }, META);
    const ownerCtx = await clinicContext(s.a.ownerLogin, s.a.slug);
    await addInvoiceLine(ownerCtx, inv, { serviceId: s.service, quantity: 1, discount: "100000", discountReason: "Owner decision" }, META);

    const full = (await getInvoice(s.cashier.ctx, inv))!;
    const discounted = full.lines.filter((l) => l.discountMinor > 0n);
    expect(discounted.map((l) => l.discountReason).sort()).toEqual(["Owner decision", "Regular patient"]);
    expect(discounted.find((l) => l.discountReason === "Regular patient")?.createdById).toBe(s.cashier.ctx.principal.user.id);
  });
});

describe("control centre", () => {
  it("shows today's money, open cash, discounts by person and discipline items; needs audit.read", async () => {
    const s = await setup();
    await openShift(s.cashier.ctx, { branchId: s.branch.id, openingFloat: "100000", currency: "UZS" }, META);
    const inv = await createInvoice(s.cashier.ctx, { patientId: s.patientId, branchId: s.branch.id }, META);
    await addInvoiceLine(s.cashier.ctx, inv, { serviceId: s.service, quantity: 3, discount: "50000" }, META);
    await issueInvoice(s.cashier.ctx, inv, META);
    await recordPayment(s.cashier.ctx, inv, { amount: "300000", method: "CASH", idempotencyKey: crypto.randomUUID() }, META);

    await expect(controlCenter(s.cashier.ctx)).rejects.toThrow("errors.forbidden");
    const c = await controlCenter(await clinicContext(s.a.ownerLogin, s.a.slug));
    expect(c.money?.todayNet).toBe(30_000_000n); // 300 000 so'm in tiyin
    expect(c.money?.outstandingMinor).toBe(25_000_000n); // 600 000 − 50 000 − 300 000
    expect(c.shifts).toHaveLength(1);
    expect(c.shifts[0]!.expectedMinor).toBe(40_000_000n); // float 100 000 + cash 300 000
    expect(c.discounts).toEqual([expect.objectContaining({ name: "Synthetic cashier", count: 1, amountMinor: 5_000_000n, grossMinor: 60_000_000n })]);

    // Administrators do not get the owner's control centre (no audit.read by default).
    await expect(controlCenter(s.admin.ctx)).rejects.toThrow("errors.forbidden");
  });
});

describe("prescriptions", () => {
  it("doctor prescribes in their own visit, allergy screen needs confirmation, cancel only, never edit", async () => {
    const s = await setup();
    const appt = await registerWalkIn(s.reception.ctx, { patientId: s.patientId, doctorProfileId: s.profileId, branchId: s.branch.id }, META);
    const enc = await startVisit(s.doctorCtx, appt, META);
    await addAllergy(s.doctorCtx, s.patientId, { substance: "Penicillin", severity: "SEVERE" }, META);

    const rx = { drug: "Bisoprolol 5 mg", dose: "1 tablet", frequency: "once daily", route: "by mouth", durationDays: "30", instructions: "In the morning" };
    const { id } = await addPrescription(s.doctorCtx, enc, rx, META);
    await expect(addPrescription(s.doctorCtx, enc, { ...rx, drug: "Penicillin V 500 mg" }, META)).rejects.toThrow("errors.allergyConflict");
    const forced = await addPrescription(s.doctorCtx, enc, { ...rx, drug: "Penicillin V 500 mg", allergyOverride: true }, META);
    expect(forced.allergyOverride).toBe(true);
    await expect(addPrescription(s.reception.ctx, enc, rx, META)).rejects.toThrow("errors.forbidden");

    const other = await staff(s.a, ["doctor"]);
    await saveDoctorProfile(s.a.ctx, other.membershipId, { specialty: "therapy", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
    const otherCtx = await clinicContext(other.login, s.a.slug);
    await expect(addPrescription(otherCtx, enc, rx, META)).rejects.toThrow();
    await expect(cancelPrescription(otherCtx, id, META)).rejects.toThrow("errors.notYourPatient");
    await cancelPrescription(s.doctorCtx, id, META);
    await expect(cancelPrescription(s.doctorCtx, id, META)).rejects.toThrow("errors.invalidTransition");

    const view = await getEncounter(s.doctorCtx, enc, META);
    expect(view.encounter.prescriptions.map((p) => [p.drug, p.status, p.allergyOverride])).toEqual([
      ["Bisoprolol 5 mg", "CANCELLED", false],
      ["Penicillin V 500 mg", "ACTIVE", true],
    ]);

    // Database guards: no editing, no reactivation, no deleting; platform staff cannot read prescriptions.
    const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.connect();
    await expect(owner.query(`UPDATE "Prescription" SET status = 'ACTIVE', "cancelledAt" = NULL WHERE id = $1`, [id])).rejects.toThrow(/only be cancelled once/);
    await expect(owner.query(`DELETE FROM "Prescription" WHERE id = $1`, [id])).rejects.toThrow(/cannot be deleted/);
    await owner.end();
    await expect(platformDb().$queryRawUnsafe(`SELECT count(*) FROM "Prescription"`)).rejects.toThrow(/permission denied/);
  });

  it("keeps the international name (INN) next to the trade name and screens allergies by it", async () => {
    const s = await setup();
    const appt = await registerWalkIn(s.reception.ctx, { patientId: s.patientId, doctorProfileId: s.profileId, branchId: s.branch.id }, META);
    const enc = await startVisit(s.doctorCtx, appt, META);
    await addAllergy(s.doctorCtx, s.patientId, { substance: "Klopidogrel", severity: "MODERATE" }, META);

    const rx = { drug: "Veroshpiron 25 mg", inn: "spironolakton", dose: "1 tablet", frequency: "once daily" };
    await addPrescription(s.doctorCtx, enc, rx, META);
    // The brand name alone does not reveal the allergy; the INN does.
    await expect(addPrescription(s.doctorCtx, enc, { ...rx, drug: "Trombonet 75 mg", inn: "klopidogrel" }, META)).rejects.toThrow("errors.allergyConflict");
    await addPrescription(s.doctorCtx, enc, { ...rx, drug: "Bisoprolol 5 mg", inn: "" }, META);

    const view = await getEncounter(s.doctorCtx, enc, META);
    expect(view.encounter.prescriptions.map((p) => rxDrugLabel(p))).toEqual(["Veroshpiron 25 mg (spironolakton)", "Bisoprolol 5 mg"]);
  });

  it("ready-made scheme: the doctor's own lines, ticked lines added in one step, allergy screen on each", async () => {
    const s = await setup();
    const appt = await registerWalkIn(s.reception.ctx, { patientId: s.patientId, doctorProfileId: s.profileId, branchId: s.branch.id }, META);
    const enc = await startVisit(s.doctorCtx, appt, META);
    const text = ["Bisoprolol 5 mg | bisoprolol | 1 tabletka | kuniga 1 marta | 08:00 | 30 | ovqatdan keyin", "Trombonet 75 mg | klopidogrel | 1 tabletka | kuniga 1 marta | 20:00", "Veroshpiron 25 mg | spironolakton | 1/2 tabletka | kuniga 1 marta"].join("\n");
    // Only administrators write schemes; every line must be a valid prescription.
    await expect(saveTemplate(s.doctorCtx, null, { kind: "PRESCRIPTION", name: "Synthetic AG scheme", schemeText: text }, META)).rejects.toThrow("errors.forbidden");
    await expect(saveTemplate(s.a.ctx, null, { kind: "PRESCRIPTION", name: "Broken", schemeText: "Bisoprolol 5 mg | | 1 tabletka" }, META)).rejects.toThrow();
    await expect(saveTemplate(s.a.ctx, null, { kind: "PRESCRIPTION", name: "Bad time", schemeText: "Bisoprolol | | 1 | daily | 25:00" }, META)).rejects.toThrow();
    const scheme = await saveTemplate(s.a.ctx, null, { kind: "PRESCRIPTION", name: "Synthetic AG scheme", schemeText: text }, META);

    await expect(applyPrescriptionScheme(s.doctorCtx, enc, scheme, { lines: [] }, META)).rejects.toThrow("errors.schemeNothingChosen");
    await expect(applyPrescriptionScheme(s.reception.ctx, enc, scheme, { lines: [0] }, META)).rejects.toThrow("errors.forbidden");
    await expect(applyPrescriptionScheme(s.doctorCtx, enc, scheme, { lines: [7] }, META)).rejects.toThrow("errors.invalidInput");

    await addAllergy(s.doctorCtx, s.patientId, { substance: "Klopidogrel", severity: "MODERATE" }, META);
    // All or nothing: the allergy on line 2 blocks the whole step until confirmed.
    await expect(applyPrescriptionScheme(s.doctorCtx, enc, scheme, { lines: [0, 1] }, META)).rejects.toThrow("errors.allergyConflict");
    expect((await getEncounter(s.doctorCtx, enc, META)).encounter.prescriptions).toHaveLength(0);

    expect(await applyPrescriptionScheme(s.doctorCtx, enc, scheme, { lines: ["2", "0"] }, META)).toEqual({ count: 2, allergyOverride: false });
    const rx = (await getEncounter(s.doctorCtx, enc, META)).encounter.prescriptions;
    expect(rx.map((p) => [rxDrugLabel(p), p.dose, p.times, p.durationDays, p.instructions])).toEqual([
      ["Bisoprolol 5 mg", "1 tabletka", "08:00", 30, "ovqatdan keyin"], // the name already is the INN
      ["Veroshpiron 25 mg (spironolakton)", "1/2 tabletka", null, null, null],
    ]);
    const forced = await applyPrescriptionScheme(s.doctorCtx, enc, scheme, { lines: [1], allergyOverride: true }, META);
    expect(forced.allergyOverride).toBe(true);
    expect((await getEncounter(s.doctorCtx, enc, META)).encounter.prescriptions.find((p) => p.drug.startsWith("Trombonet"))?.allergyOverride).toBe(true);
  });

  it("scheme lines round-trip and report the lines that miss a required column", () => {
    const { items, badLines } = parseSchemeLines("Aspirin 100 mg | | 1 tabletka | kuniga 1 marta\n\nonly a name\nA | b | c | d | e | f | g | h");
    expect(items).toEqual([{ drug: "Aspirin 100 mg", dose: "1 tabletka", frequency: "kuniga 1 marta" }]);
    expect(badLines).toEqual([3, 4]);
    expect(schemeLines({ items })).toBe("Aspirin 100 mg |  | 1 tabletka | kuniga 1 marta");
  });

  it("prints the INN in brackets unless the name already contains it", () => {
    expect(rxDrugLabel({ drug: "Roxera 10 mg", inn: "rozuvastatin" })).toBe("Roxera 10 mg (rozuvastatin)");
    expect(rxDrugLabel({ drug: "Rozuvastatin 10 mg", inn: "rozuvastatin" })).toBe("Rozuvastatin 10 mg");
    expect(rxDrugLabel({ drug: "Aspirin 100 mg", inn: null })).toBe("Aspirin 100 mg");
    expect(rxDrugLabel({ drug: "Aspirin 100 mg", inn: "  " })).toBe("Aspirin 100 mg");
  });

  it("allergy screen matches the substance or a word of it, case-insensitively", () => {
    expect(allergyMatches("Penicillin V 500 mg", ["penicillin"])).toEqual(["penicillin"]);
    expect(allergyMatches("Aspirin Cardio 100 mg", ["Acetylsalicylic acid, aspirin"])).toEqual(["Acetylsalicylic acid, aspirin"]);
    expect(allergyMatches("Bisoprolol 5 mg", ["Penicillin", "Pollen"])).toEqual([]);
  });
});

describe("rescheduling", () => {
  it("moves a booked visit with the booking rules, keeps the count, refuses conflicts and wrong states", async () => {
    const s = await setup();
    const date = addDays(todayIn(TZ), 2);
    await addScheduleBlock(s.a.ctx, s.profileId, { weekday: isoWeekday(date), start: "09:00", end: "13:00", branchId: s.branch.id }, META);
    const at = (hhmm: string, d = date) => localToInstant(d, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)), TZ).toISOString();
    const p2 = await registerPatient(s.reception.ctx, { lastName: "Sintetik", firstName: `Ikkinchi${n}`, birthDate: "1975-04-04", sex: "FEMALE" }, { confirmNotDuplicate: true }, META);
    if (!p2.ok) throw new Error("patient");

    const a1 = await bookAppointment(s.reception.ctx, { patientId: s.patientId, doctorProfileId: s.profileId, startsAt: at("09:00"), serviceId: s.service }, META);
    await bookAppointment(s.reception.ctx, { patientId: p2.id, doctorProfileId: s.profileId, startsAt: at("10:00") }, META);

    await expect(rescheduleAppointment(s.reception.ctx, a1, { startsAt: at("10:10") }, META)).rejects.toThrow("errors.slotTaken");
    await expect(rescheduleAppointment(s.reception.ctx, a1, { startsAt: at("12:50") }, META)).rejects.toThrow("errors.outsideSchedule"); // would end 13:10
    await rescheduleAppointment(s.reception.ctx, a1, { startsAt: at("11:00") }, META);
    await rescheduleAppointment(s.reception.ctx, a1, { startsAt: at("11:30") }, META);

    const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.connect();
    // timestamp columns are UTC; read them as text so the computer's own time zone does not interfere.
    const row = (await owner.query(`SELECT to_char("startsAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startsAt", extract(epoch FROM "endsAt" - "startsAt")::int AS secs, "rescheduleCount" FROM "Appointment" WHERE id = $1`, [a1])).rows[0];
    const audits = (await owner.query(`SELECT count(*)::int AS c FROM "AuditEvent" WHERE action = 'appointment.rescheduled' AND "entityId" = $1`, [a1])).rows[0].c;
    await owner.end();
    expect(row.startsAt).toBe(at("11:30"));
    expect(row.secs).toBe(20 * 60);
    expect(row.rescheduleCount).toBe(2);
    expect(audits).toBe(2);

    await cancelAppointment(s.reception.ctx, a1, "PATIENT_REQUEST", META);
    await expect(rescheduleAppointment(s.reception.ctx, a1, { startsAt: at("12:00") }, META)).rejects.toThrow("errors.invalidTransition");
    await expect(rescheduleAppointment(s.doctorCtx, a1, { startsAt: at("12:00") }, META)).rejects.toThrow("errors.forbidden");
  });
});
