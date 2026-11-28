import pg from "pg";
import { describe, expect, it } from "vitest";
import { addStaffMember, listBranches } from "@/server/clinic/admin";
import { saveDoctorProfile } from "@/server/clinic/doctors";
import { listStaff } from "@/server/clinic/admin";
import { importPriceList } from "@/server/clinic/price-list";
import { listServices } from "@/server/clinic/resources";
import { ageOn, listPatients, patientVisitSummaries } from "@/server/patients/overview";
import { searchPatients } from "@/server/patients/patients";
import { deskCheckIn } from "@/server/reception/desk";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

describe("working with patients: search, returning patients, quick lists", () => {
  it("finds by birth year and by name + year; tells first visits from returning patients; lists today's, debtors, new", async () => {
    const o = await clinicWithOwner(await platformActor());
    const [branch] = await listBranches(o.ctx);
    await importPriceList(o.ctx, { text: "Kardiolog ko'ruvi 100 000\nEKG 30 000" }, META);
    const services = await listServices(o.ctx);
    const doctorLogin = uniq("doc");
    await addStaffMember(o.ctx, { fullName: "Synthetic Doctor", username: doctorLogin, password: PASSWORD, roleKeys: ["doctor"] }, META);
    const m = (await listStaff(o.ctx)).members.find((x) => x.user.username === doctorLogin)!;
    const doctorProfileId = await saveDoctorProfile(o.ctx, m.id, { specialty: "cardiology", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
    const deskLogin = uniq("desk");
    await addStaffMember(o.ctx, { fullName: "Synthetic Desk", username: deskLogin, password: PASSWORD, roleKeys: ["receptionist", "cashier"] }, META);
    const desk = await clinicContext(deskLogin, o.slug);
    const surname = `Sintetikov${uniq("x").slice(-4)}`;
    const visit = async (first: string, birth: string, pay: "full" | "debt") => {
      const r = await deskCheckIn(desk, { lastName: surname, firstName: first, birthDate: birth, sex: "MALE", doctorProfileId, branchId: branch!.id, serviceIds: [services[0]!.id], payMode: pay, confirmNotDuplicate: "on" }, META);
      if (!r.ok) throw new Error("duplicate");
      return r;
    };
    const old = await visit("Eski", "1958", "full");
    const fresh = await visit("Yangi", "14.03.1962", "debt");

    // Birth year alone, and a name with the year (namesakes are told apart).
    expect((await searchPatients(desk, "1958")).map((p) => p.id)).toContain(old.patientId);
    expect((await searchPatients(desk, "1958")).map((p) => p.id)).not.toContain(fresh.patientId);
    expect((await searchPatients(desk, `${surname} 1962`)).map((p) => p.id)).toEqual([fresh.patientId]);
    expect((await searchPatients(desk, "14.03.1962")).map((p) => p.id)).toEqual([fresh.patientId]);

    // The old patient's visit moves to last month: today they are "returning", the new one is a "first visit".
    const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await db.connect();
    await db.query(`UPDATE "Appointment" SET "startsAt" = "startsAt" - interval '30 days', "endsAt" = "endsAt" - interval '30 days', status = 'COMPLETED' WHERE id = $1`, [old.appointmentId]);
    await db.end();
    const again = await deskCheckIn(desk, { patientId: old.patientId, doctorProfileId, branchId: branch!.id, serviceIds: [services[1]!.id], payMode: "full" }, META);
    expect(again.ok).toBe(true);
    const s = await patientVisitSummaries(desk, [old.patientId, fresh.patientId]);
    expect(s.get(old.patientId)).toMatchObject({ earlier: 1, today: true });
    expect(s.get(old.patientId)!.lastEarlier?.doctor).toBe("Synthetic Doctor");
    expect(s.get(fresh.patientId)).toMatchObject({ earlier: 0, lastEarlier: null, today: true, visits: 1 });

    // Quick lists.
    const today = (await listPatients(desk, "today")).map((p) => p.id);
    expect(today).toEqual(expect.arrayContaining([old.patientId, fresh.patientId]));
    expect((await listPatients(desk, "debt")).map((p) => p.id)).toContain(fresh.patientId);
    expect((await listPatients(desk, "debt")).map((p) => p.id)).not.toContain(old.patientId);
    expect((await listPatients(desk, "new")).map((p) => p.id)).toContain(fresh.patientId);

    expect(ageOn(new Date(Date.UTC(1962, 2, 14)), "2026-03-13")).toBe(63);
    expect(ageOn(new Date(Date.UTC(1962, 2, 14)), "2026-03-14")).toBe(64);
  });
});
