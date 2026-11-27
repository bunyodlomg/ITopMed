import { describe, expect, it } from "vitest";
import { addInvoiceLine, createInvoice, getInvoice } from "@/server/billing/billing";
import { addStaffMember, listBranches, listStaff } from "@/server/clinic/admin";
import { saveDoctorProfile } from "@/server/clinic/doctors";
import { importPriceList } from "@/server/clinic/price-list";
import { createService, listServices } from "@/server/clinic/resources";
import { deskPrintables } from "@/server/emr/documents";
import { finishEncounter, getEncounter, signNote, startVisit } from "@/server/emr/record";
import { addAnalyte, createLabOrder } from "@/server/lab/lab";
import { addExtraServices, approvePatientDebt, deskCheckIn, listDebtors, patientAccount, payPatientDebt, servicesBilledToday } from "@/server/reception/desk";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

async function staff(o: Awaited<ReturnType<typeof clinicWithOwner>>, roleKeys: string[], fullName = `Synthetic ${roleKeys.join(" ")}`) {
  const login = uniq("s");
  await addStaffMember(o.ctx, { fullName, username: login, roleKeys, password: PASSWORD }, META);
  const m = (await listStaff(o.ctx)).members.find((x) => x.user.username === login)!;
  return { membershipId: m.id, ctx: await clinicContext(login, o.slug) };
}

async function setup() {
  const o = await clinicWithOwner(await platformActor());
  const [branch] = await listBranches(o.ctx);
  await importPriceList(o.ctx, { text: "Kardiolog ko'ruvi 100 ming\nEKG 30 ming\nEXO 120 ming" }, META);
  const services = await listServices(o.ctx);
  const sid = (n: string) => services.find((s) => s.name === n)!.id;
  const desk = await staff(o, ["receptionist"], "Synthetic Registrator");
  const cashier = await staff(o, ["cashier"], "Synthetic Kassir");
  const doctor = await staff(o, ["doctor"], "Synthetic Doktor");
  const lab = await staff(o, ["lab_staff"]);
  const profileId = await saveDoctorProfile(o.ctx, doctor.membershipId, { specialty: "cardiology", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
  return { o, branchId: branch!.id, sid, desk, cashier, doctor, lab, profileId };
}

async function finish(ctx: Parameters<typeof finishEncounter>[0], enc: string) {
  const note = (await getEncounter(ctx, enc, META)).encounter.notes[0]!;
  await signNote(ctx, note.id, { complaints: "Synthetic", history: "", examination: "", assessment: "Synthetic", plan: "" }, META);
  await finishEncounter(ctx, enc, META);
}

describe("one bill for the whole visit, paid at the cashier", () => {
  it("the desk, the doctor and the lab order add services as debt; the cashier sees them all and takes everything in one payment", async () => {
    const s = await setup();
    const cbc = await createService(s.o.ctx, { code: "CBC1", name: "Umumiy qon tahlili", kind: "LAB_TEST", durationMinutes: 10, price: "30000", currency: "UZS" }, META);
    await addAnalyte(s.lab.ctx, cbc, { name: "Hemoglobin", unit: "g/L", refLow: "120", refHigh: "160" }, META);

    // Desk: registration with the consultation on debt (no payment taken at the desk).
    const r = await deskCheckIn(s.desk.ctx, { lastName: "Sintetik", firstName: "Kassa", birthDate: "1961", sex: "MALE", doctorProfileId: s.profileId, branchId: s.branchId, serviceIds: [], payMode: "debt" }, META);
    if (!r.ok) throw new Error("duplicate");
    const enc = await startVisit(s.doctor.ctx, r.appointmentId, META);

    // Doctor (billing.charge, no cashier role): echo + ECG go on the bill as unpaid, whatever pay mode is posted.
    await addExtraServices(s.doctor.ctx, { patientId: r.patientId, branchId: s.branchId, appointmentId: r.appointmentId, serviceIds: [s.sid("EXO"), s.sid("EKG")], payMode: "full", method: "CASH" }, META);
    // The doctor may not give discounts by hand nor take money.
    const draft = await createInvoice(s.doctor.ctx, { patientId: r.patientId, branchId: s.branchId }, META);
    await expect(addInvoiceLine(s.doctor.ctx, draft, { serviceId: s.sid("EKG"), quantity: "1", discount: "5000" }, META)).rejects.toThrow("errors.forbidden");
    await expect(payPatientDebt(s.doctor.ctx, { patientId: r.patientId }, META)).rejects.toThrow("errors.forbidden");

    // Lab order: the priced test is charged; ordering an already billed test again does not charge twice.
    const first = await createLabOrder(s.doctor.ctx, enc, { serviceIds: [cbc] }, META);
    expect(first.charged).toBe(true);
    expect((await servicesBilledToday(s.doctor.ctx, r.patientId)).has(cbc)).toBe(true);
    const again = await createLabOrder(s.doctor.ctx, enc, { serviceIds: [cbc] }, META);
    expect(again.charged).toBe(false);
    await finish(s.doctor.ctx, enc);

    // The desk cannot print until the cashier settles the bill.
    expect((await deskPrintables(s.desk.ctx, r.appointmentId)).gate).toBe("unpaid");

    // Cashier: the patient is in today's debtors with every line and who added it.
    const debtors = await listDebtors(s.cashier.ctx);
    const me = debtors.find((d) => d.patient.id === r.patientId)!;
    expect(me).toMatchObject({ owedMinor: 18_000_000n, today: true, approved: false, lines: 3 });
    expect((await listDebtors(s.cashier.ctx, { q: "Kassa" })).map((d) => d.patient.id)).toEqual([r.patientId]);
    const acc = (await patientAccount(s.cashier.ctx, r.patientId))!;
    expect(acc.owedMinor).toBe(18_000_000n);
    const lines = acc.open.flatMap((i) => i.lines).map((l) => [l.description, l.totalMinor, l.addedBy]);
    expect(lines).toEqual([
      ["EXO", 12_000_000n, "Synthetic Doktor"],
      ["EKG", 3_000_000n, "Synthetic Doktor"],
      ["Umumiy qon tahlili", 3_000_000n, "Synthetic Doktor"],
    ]);

    // One payment for everything, split: 100 000 cash + 80 000 card, spread over both bills.
    await expect(payPatientDebt(s.cashier.ctx, { patientId: r.patientId, payMode: "split", split: { CASH: "100000", CARD: "90000" } }, META)).rejects.toThrow("errors.overpayment");
    const paid = await payPatientDebt(s.cashier.ctx, { patientId: r.patientId, payMode: "split", split: { CASH: "100 000", CARD: "80000" } }, META);
    expect(paid).toMatchObject({ paidMinor: 18_000_000n, leftMinor: 0n });
    expect(paid.invoiceIds).toHaveLength(2);
    const byMethod = new Map<string, bigint>();
    for (const id of paid.invoiceIds) for (const p of (await getInvoice(s.cashier.ctx, id))!.payments) byMethod.set(p.method, (byMethod.get(p.method) ?? 0n) + p.amountMinor);
    expect(Object.fromEntries(byMethod)).toEqual({ CASH: 10_000_000n, CARD: 8_000_000n });

    // Settled: green at the desk, the patient leaves the debtors' list, today's receipt has all three services.
    expect((await deskPrintables(s.desk.ctx, r.appointmentId)).gate).toBe("ok");
    expect((await listDebtors(s.cashier.ctx)).some((d) => d.patient.id === r.patientId)).toBe(false);
    const after = (await patientAccount(s.cashier.ctx, r.patientId))!;
    expect(after.owedMinor).toBe(0n);
    expect(after.paidToday.reduce((sum, p) => sum + p.amountMinor, 0n)).toBe(18_000_000n);
    expect(after.paidTodayLines.map((l) => l.description).sort()).toEqual(["EKG", "EXO", "Umumiy qon tahlili"]);
    await expect(payPatientDebt(s.cashier.ctx, { patientId: r.patientId }, META)).rejects.toThrow("errors.noDebt");
  });

  it("a part now, the rest allowed as debt: the papers can be printed, the debtor stays listed", async () => {
    const s = await setup();
    const r = await deskCheckIn(s.desk.ctx, { lastName: "Sintetik", firstName: "Qarz", birthDate: "1970", sex: "FEMALE", doctorProfileId: s.profileId, branchId: s.branchId, payMode: "debt" }, META);
    if (!r.ok) throw new Error("duplicate");
    const enc = await startVisit(s.doctor.ctx, r.appointmentId, META);
    await addExtraServices(s.doctor.ctx, { patientId: r.patientId, branchId: s.branchId, serviceIds: [s.sid("Kardiolog ko'ruvi")], payMode: "debt" }, META);
    await finish(s.doctor.ctx, enc);

    const part = await payPatientDebt(s.cashier.ctx, { patientId: r.patientId, payMode: "partial", amount: "40000", method: "CARD" }, META);
    expect(part).toMatchObject({ paidMinor: 4_000_000n, leftMinor: 6_000_000n });
    expect((await deskPrintables(s.desk.ctx, r.appointmentId)).gate).toBe("unpaid");
    // Only the cashier may let the patient leave owing.
    await expect(approvePatientDebt(s.desk.ctx, r.patientId, META)).rejects.toThrow("errors.forbidden");
    expect(await approvePatientDebt(s.cashier.ctx, r.patientId, META)).toBe(1);
    expect((await deskPrintables(s.desk.ctx, r.appointmentId)).gate).toBe("ok");
    expect((await listDebtors(s.cashier.ctx)).find((d) => d.patient.id === r.patientId)).toMatchObject({ owedMinor: 6_000_000n, approved: true });
    // Invalid input is refused.
    await expect(payPatientDebt(s.cashier.ctx, { patientId: r.patientId, payMode: "partial", amount: "abc" }, META)).rejects.toThrow("errors.invalidAmount");
    await expect(payPatientDebt(s.cashier.ctx, { patientId: r.patientId, payMode: "split", split: {} }, META)).rejects.toThrow("errors.invalidAmount");
    expect(await patientAccount(s.cashier.ctx, "not-a-uuid")).toBeNull();
  });
});
