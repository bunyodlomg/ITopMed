import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerWalkIn } from "@/server/appointments/appointments";
import { addStaffMember, listBranches, listStaff } from "@/server/clinic/admin";
import { saveDoctorProfile } from "@/server/clinic/doctors";
import { platformDb } from "@/server/db";
import { closeDispensary, dispensaryWorklist, enrollDispensary, markFollowUpDone, patientDispensary } from "@/server/emr/dispensary";
import { startVisit } from "@/server/emr/record";
import { listNotifications, processDueNotifications } from "@/server/notifications/notifications";
import { recordConsent, registerPatient } from "@/server/patients/patients";
import { addDays, localToInstant, todayIn } from "@/server/scheduling/time";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

const TZ = "Asia/Tashkent";

async function staff(o: Awaited<ReturnType<typeof clinicWithOwner>>, roleKeys: string[]) {
  const login = uniq("s");
  await addStaffMember(o.ctx, { fullName: `Synthetic ${roleKeys[0]}`, username: login, roleKeys, password: PASSWORD }, META);
  const m = (await listStaff(o.ctx)).members.find((x) => x.user.username === login)!;
  return { login, membershipId: m.id, ctx: await clinicContext(login, o.slug) };
}

let n = 0;
async function setup() {
  const a = await clinicWithOwner(await platformActor());
  const [branch] = await listBranches(a.ctx);
  const reception = await staff(a, ["receptionist"]);
  const doctor = await staff(a, ["doctor"]);
  const other = await staff(a, ["doctor"]);
  const profileId = await saveDoctorProfile(a.ctx, doctor.membershipId, { specialty: "cardiology", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
  await saveDoctorProfile(a.ctx, other.membershipId, { specialty: "therapy", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
  const phone = `+99897${String(1000000 + ++n * 7919 + (Date.now() % 1000)).slice(-7)}`;
  const p = await registerPatient(reception.ctx, { lastName: "Sintetik", firstName: `Dispanser${n}`, birthDate: "1960-04-04", sex: "MALE", phone }, { confirmNotDuplicate: true }, META);
  if (!p.ok) throw new Error("patient");
  await recordConsent(reception.ctx, p.id, { purpose: "SMS_REMINDERS", method: "PAPER_SIGNED" }, META);
  // The doctor sees the patient today (care relationship).
  const appt = await registerWalkIn(reception.ctx, { patientId: p.id, doctorProfileId: profileId, branchId: branch!.id }, META);
  const doctorCtx = await clinicContext(doctor.login, a.slug);
  await startVisit(doctorCtx, appt, META);
  return { a, reception, doctorCtx, otherCtx: await clinicContext(other.login, a.slug), patientId: p.id, phone };
}

describe("dispensary follow-up", () => {
  it("the treating doctor enrols, marks follow-ups and closes; others cannot; reminders carry no clinical detail", async () => {
    const s = await setup();
    const today = todayIn(TZ);
    const plan = await enrollDispensary(s.doctorCtx, s.patientId, { group: "ANTICOAGULANT", intervalDays: "30", firstDue: addDays(today, 3), labs: "Koagulogramma (INR)" }, META);
    await expect(enrollDispensary(s.doctorCtx, s.patientId, { group: "ANTICOAGULANT", intervalDays: "30" }, META)).rejects.toThrow("errors.dispensaryExists");
    await expect(enrollDispensary(s.doctorCtx, s.patientId, { group: "HYPERTENSION", intervalDays: "3" }, META)).rejects.toThrow();
    await expect(enrollDispensary(s.doctorCtx, s.patientId, { group: "HYPERTENSION", intervalDays: "30", firstDue: addDays(today, -1) }, META)).rejects.toThrow("errors.dateInPast");
    await expect(enrollDispensary(s.reception.ctx, s.patientId, { group: "HYPERTENSION", intervalDays: "30" }, META)).rejects.toThrow("errors.forbidden");
    await expect(enrollDispensary(s.otherCtx, s.patientId, { group: "HYPERTENSION", intervalDays: "30" }, META)).rejects.toThrow("errors.noCareRelationship");

    // Reminder queued for 10:00 the day before the due date.
    let rows = (await listNotifications(s.a.ctx)).rows.filter((r) => r.kind === "DISPENSARY_REMINDER");
    expect(rows.map((r) => [r.status, r.dueAt.toISOString()])).toEqual([["PENDING", localToInstant(addDays(today, 2), 600, TZ).toISOString()]]);

    // The worklist: the doctor sees their own plan; the other doctor sees none.
    const list = await dispensaryWorklist(s.doctorCtx, META);
    expect(list.plans.map((p) => [p.id, p.labs, p.nextDueDate.toISOString().slice(0, 10)])).toEqual([[plan, "Koagulogramma (INR)", addDays(today, 3)]]);
    expect((await dispensaryWorklist(s.otherCtx, META)).plans).toEqual([]);
    await expect(dispensaryWorklist(s.reception.ctx, META)).rejects.toThrow("errors.forbidden");

    // Follow-up done: next due = today + interval; the old reminder is dropped, a new one queued.
    await expect(markFollowUpDone(s.otherCtx, plan, META)).rejects.toThrow();
    expect(await markFollowUpDone(s.doctorCtx, plan, META)).toBe(addDays(today, 30));
    rows = (await listNotifications(s.a.ctx)).rows.filter((r) => r.kind === "DISPENSARY_REMINDER");
    expect(rows.map((r) => r.status).sort()).toEqual(["PENDING", "SKIPPED"]);

    // Delivery: the message names the date, never the group or the tests.
    await processDueNotifications(s.a.tenantId, { now: localToInstant(addDays(today, 29), 11 * 60, TZ) });
    const dir = path.join(process.cwd(), ".dev-mailbox", "sms");
    const sms = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(`_${s.phone}.txt`)).map((f) => fs.readFileSync(path.join(dir, f), "utf8")) : [];
    expect(sms.length).toBeGreaterThan(0);
    expect(sms.join("\n")).not.toMatch(/antikoagul|koagulogramma|INR/i);

    await closeDispensary(s.doctorCtx, plan, META);
    await expect(closeDispensary(s.doctorCtx, plan, META)).rejects.toThrow("errors.invalidTransition");
    expect(await patientDispensary(s.doctorCtx, s.patientId, META)).toEqual([]);

    // Clinical table: no platform access.
    await expect(platformDb().$queryRawUnsafe(`SELECT count(*) FROM "DispensaryPlan"`)).rejects.toThrow(/permission denied/);
  });
});
