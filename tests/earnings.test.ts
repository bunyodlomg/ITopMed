import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { registerWalkIn } from "@/server/appointments/appointments";
import { addInvoiceLine, createInvoice, issueInvoice, recordPayment, refundPayment } from "@/server/billing/billing";
import { openShift } from "@/server/billing/cash";
import { doctorsEarnings, myEarnings, setDoctorCommission } from "@/server/billing/earnings";
import { addStaffMember, listBranches, listStaff } from "@/server/clinic/admin";
import { saveDoctorProfile } from "@/server/clinic/doctors";
import { createService } from "@/server/clinic/resources";
import { registerPatient } from "@/server/patients/patients";
import { todayIn } from "@/server/scheduling/time";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

async function staff(o: Awaited<ReturnType<typeof clinicWithOwner>>, roleKeys: string[]) {
  const login = uniq("s");
  await addStaffMember(o.ctx, { fullName: `Synthetic ${roleKeys.join("+")}`, username: login, roleKeys, password: PASSWORD }, META);
  const m = (await listStaff(o.ctx)).members.find((x) => x.user.username === login)!;
  return { login, membershipId: m.id, ctx: await clinicContext(login, o.slug) };
}

describe("doctor earnings", () => {
  it("share of received money (less refunds) for the doctor's own patients; doctors see only their own", async () => {
    const a = await clinicWithOwner(await platformActor());
    const [branch] = await listBranches(a.ctx);
    const reception = await staff(a, ["receptionist"]);
    const cashier = await staff(a, ["cashier"]);
    const doctor = await staff(a, ["doctor"]);
    const other = await staff(a, ["doctor"]);
    const profileId = await saveDoctorProfile(a.ctx, doctor.membershipId, { specialty: "cardiology", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
    await saveDoctorProfile(a.ctx, other.membershipId, { specialty: "therapy", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
    const service = await createService(a.ctx, { code: "EARN1", name: "Synthetic consultation", kind: "CONSULTATION", durationMinutes: 20, price: "200000", currency: "UZS" }, META);
    const p = await registerPatient(reception.ctx, { lastName: "Sintetik", firstName: "Daromad", birthDate: "1975-05-05", sex: "MALE" }, { confirmNotDuplicate: true }, META);
    if (!p.ok) throw new Error("patient");
    const appt = await registerWalkIn(reception.ctx, { patientId: p.id, doctorProfileId: profileId, branchId: branch!.id }, META);

    await openShift(cashier.ctx, { branchId: branch!.id, openingFloat: "0", currency: "UZS" }, META);
    const inv = await createInvoice(cashier.ctx, { patientId: p.id, branchId: branch!.id, appointmentId: appt }, META);
    await addInvoiceLine(cashier.ctx, inv, { serviceId: service, quantity: 1 }, META);
    await issueInvoice(cashier.ctx, inv, META);
    const { paymentId } = await recordPayment(cashier.ctx, inv, { amount: "200000", method: "CASH", idempotencyKey: randomUUID() }, META);
    await refundPayment(cashier.ctx, paymentId, { amount: "50000", reason: "SERVICE_NOT_PROVIDED", idempotencyKey: randomUUID() }, META);

    const today = todayIn("Asia/Tashkent");
    const doctorCtx = await clinicContext(doctor.login, a.slug);
    // No percent yet: the base is shown, the share is not.
    expect(await myEarnings(doctorCtx, today, today)).toEqual({ percent: null, days: [{ day: today, currency: "UZS", net: 15_000_000n, payments: 1 }], totals: [{ currency: "UZS", net: 15_000_000n, share: null }] });

    await expect(setDoctorCommission(doctorCtx, profileId, "30", META)).rejects.toThrow("errors.forbidden");
    await expect(setDoctorCommission(a.ctx, profileId, "101", META)).rejects.toThrow();
    await setDoctorCommission(a.ctx, profileId, "30", META);
    expect((await myEarnings(doctorCtx, today, today)).totals).toEqual([{ currency: "UZS", net: 15_000_000n, share: 4_500_000n }]); // 150 000 × 30% = 45 000 so'm

    // The other doctor has nothing; the receptionist is not a doctor; finance sees everyone.
    expect((await myEarnings(await clinicContext(other.login, a.slug), today, today)).days).toEqual([]);
    await expect(myEarnings(reception.ctx, today, today)).rejects.toThrow("errors.forbidden");
    await expect(doctorsEarnings(doctorCtx, today, today)).rejects.toThrow("errors.forbidden");
    expect(await doctorsEarnings(a.ctx, today, today)).toEqual([expect.objectContaining({ doctorProfileId: profileId, percent: 30, currency: "UZS", net: 15_000_000n, share: 4_500_000n })]);

    await setDoctorCommission(a.ctx, profileId, "", META); // cleared
    expect((await myEarnings(doctorCtx, today, today)).percent).toBeNull();
  });
});
