import { describe, expect, it } from "vitest";
import { addStaffMember, listBranches, listStaff } from "@/server/clinic/admin";
import { saveDoctorProfile } from "@/server/clinic/doctors";
import { importPriceList, parsePriceLine } from "@/server/clinic/price-list";
import { listServices } from "@/server/clinic/resources";
import { getInvoice } from "@/server/billing/billing";
import { getPatient } from "@/server/patients/patients";
import { addExtraServices, deskCheckIn, payPatientDebt, todayMoney, todayVitals } from "@/server/reception/desk";
import { parseBirthInput } from "@/server/patients/patients";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

async function staff(o: Awaited<ReturnType<typeof clinicWithOwner>>, roleKeys: string[]) {
  const login = uniq("s");
  await addStaffMember(o.ctx, { fullName: `Synthetic ${roleKeys.join(" ")}`, username: login, roleKeys, password: PASSWORD }, META);
  const m = (await listStaff(o.ctx)).members.find((x) => x.user.username === login)!;
  return { login, membershipId: m.id, ctx: await clinicContext(login, o.slug) };
}

const PRICE_LIST = ["Kardiolog ko'ruvi — 100 ming so'm", "Umumiy ayollar 100 000", "EXO 120 ming som", "Buyraklar: 70000", "EKG 30 ming"].join("\n");

describe("price list from text", () => {
  it("reads the ways people write prices", () => {
    expect(parsePriceLine("Kardiolog ko'ruvi — 100 ming so'm")).toMatchObject({ name: "Kardiolog ko'ruvi", priceMinor: 10_000_000n, kind: "CONSULTATION" });
    expect(parsePriceLine("EXO 120 000")).toMatchObject({ name: "EXO", priceMinor: 12_000_000n, kind: "IMAGING" });
    expect(parsePriceLine("1. EKG: 30000 сум")).toMatchObject({ name: "EKG", priceMinor: 3_000_000n, kind: "PROCEDURE" });
    expect(parsePriceLine("Qalqonsimon bez UZI - 70.000")).toMatchObject({ priceMinor: 7_000_000n, kind: "IMAGING" });
    expect(parsePriceLine("just text")).toBeNull();
  });

  it("creates services, then updates prices when pasted again", async () => {
    const o = await clinicWithOwner(await platformActor());
    expect(await importPriceList(o.ctx, { text: PRICE_LIST }, META)).toEqual({ created: 5, updated: 0, skipped: 0 });
    expect(await importPriceList(o.ctx, { text: "EKG 35 ming\nnot a price" }, META)).toEqual({ created: 0, updated: 1, skipped: 1 });
  });

  it("birth: year only, day.month.year, ISO", () => {
    expect(parseBirthInput("1947")).toEqual({ date: "1947-01-01", yearOnly: true });
    expect(parseBirthInput("5.3.1960")).toEqual({ date: "1960-03-05", yearOnly: false });
    expect(parseBirthInput("1960-03-05")).toEqual({ date: "1960-03-05", yearOnly: false });
    expect(parseBirthInput("47")).toBeNull();
  });
});

describe("reception desk", () => {
  it("registers, queues, measures, bills and takes payment in one step; the doctor sees it before the visit", async () => {
    const o = await clinicWithOwner(await platformActor());
    const [branch] = await listBranches(o.ctx);
    await importPriceList(o.ctx, { text: PRICE_LIST }, META);
    const services = await listServices(o.ctx);
    const sid = (n: string) => services.find((s) => s.name === n)!.id;

    const desk = await staff(o, ["receptionist", "cashier", "nurse"]);
    const doctor = await staff(o, ["doctor"]);
    const profileId = await saveDoctorProfile(o.ctx, doctor.membershipId, { specialty: "cardiology", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);

    const first = await deskCheckIn(
      desk.ctx,
      {
        lastName: "Sintetik",
        firstName: "Bemor",
        birthDate: "1947",
        sex: "MALE",
        address: "Synthetic street 1",
        doctorProfileId: profileId,
        branchId: branch!.id,
        serviceIds: [sid("Kardiolog ko'ruvi"), sid("EKG")],
        payMode: "partial",
        amount: "50000",
        method: "CASH",
        SYSTOLIC_BP: "140",
        DIASTOLIC_BP: "80",
        WEIGHT: "82",
        HEIGHT: "176",
      },
      META,
    );
    if (!first.ok) throw new Error("duplicate");
    expect(first.queueNumber).toBe(1);
    expect(first.vitalsSaved).toBe(true);
    const inv = (await getInvoice(desk.ctx, first.invoiceId!))!;
    expect([inv.totalMinor, inv.paidMinor, inv.status]).toEqual([13_000_000n, 5_000_000n, "PARTIALLY_PAID"]);
    expect((await getPatient(desk.ctx, first.patientId, META))!.birthYearOnly).toBe(true);

    // Second patient fully on debt: next queue number.
    const second = await deskCheckIn(desk.ctx, { lastName: "Sintetik", firstName: "Ikkinchi", birthDate: "12.05.1970", sex: "FEMALE", doctorProfileId: profileId, branchId: branch!.id, serviceIds: [sid("Umumiy ayollar")], payMode: "debt" }, META);
    if (!second.ok) throw new Error("duplicate");
    expect(second.queueNumber).toBe(2);

    // Overpaying or unknown services are refused before anything is written.
    await expect(deskCheckIn(desk.ctx, { patientId: first.patientId, doctorProfileId: profileId, branchId: branch!.id, serviceIds: [sid("EKG")], payMode: "partial", amount: "999999" }, META)).rejects.toThrow("errors.overpayment");

    // Money: the desk sees today's services and the debt.
    const money = await todayMoney(desk.ctx, [first.patientId, second.patientId]);
    expect(money.debt.get(first.patientId)).toBe(8_000_000n);
    expect(money.today.get(second.patientId)?.services).toEqual(["Umumiy ayollar"]);

    // The doctor sees the measurements before the patient comes in; without billing rights, no money.
    const v = await todayVitals(doctor.ctx, [first.patientId]);
    expect(v.get(first.patientId)).toMatchObject({ systolic: "140", diastolic: "80", weight: "82", height: "176" });
    expect((await todayMoney(doctor.ctx, [first.patientId])).debt.size).toBe(0);
    await expect(addExtraServices(doctor.ctx, { patientId: first.patientId, branchId: branch!.id, serviceIds: [sid("EXO")], payMode: "debt" }, META)).rejects.toThrow("errors.forbidden");

    // A doctor who also has the cashier role adds an echo on debt.
    const fullDoctor = await staff(o, ["doctor", "receptionist", "cashier"]);
    const extra = await addExtraServices(fullDoctor.ctx, { patientId: first.patientId, branchId: branch!.id, appointmentId: first.appointmentId, serviceIds: [sid("EXO")], payMode: "debt" }, META);
    expect(extra).toBeTruthy();
    expect((await todayMoney(fullDoctor.ctx, [first.patientId])).debt.get(first.patientId)).toBe(20_000_000n);

    // The desk takes the debt in one step over both invoices: part first, then the rest.
    await expect(payPatientDebt(desk.ctx, { patientId: first.patientId, amount: "999999999", method: "CASH" }, META)).rejects.toThrow("errors.overpayment");
    const part = await payPatientDebt(desk.ctx, { patientId: first.patientId, amount: "100000", method: "CASH" }, META);
    expect(part.leftMinor).toBe(10_000_000n);
    expect(part.invoiceIds).toHaveLength(2); // 80 000 of the visit, then 20 000 of the echo
    const rest = await payPatientDebt(desk.ctx, { patientId: first.patientId, method: "CARD" }, META);
    expect(rest).toMatchObject({ paidMinor: 10_000_000n, leftMinor: 0n });
    expect((await todayMoney(desk.ctx, [first.patientId])).debt.get(first.patientId)).toBe(0n);
    await expect(payPatientDebt(desk.ctx, { patientId: first.patientId }, META)).rejects.toThrow("errors.noDebt");
    // A doctor without the cashier role cannot take money.
    await expect(payPatientDebt(doctor.ctx, { patientId: first.patientId }, META)).rejects.toThrow("errors.forbidden");
  });

  it("split payment: cash + card + transfer on one bill, one payment per method; the rest is debt", async () => {
    const o = await clinicWithOwner(await platformActor());
    const [branch] = await listBranches(o.ctx);
    await importPriceList(o.ctx, { text: PRICE_LIST }, META);
    const services = await listServices(o.ctx);
    const sid = (n: string) => services.find((s) => s.name === n)!.id;
    const desk = await staff(o, ["receptionist", "cashier"]);
    const doctor = await staff(o, ["doctor"]);
    const profileId = await saveDoctorProfile(o.ctx, doctor.membershipId, { specialty: "cardiology", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
    const visit = { lastName: "Sintetik", firstName: "Aralash", birthDate: "1965", sex: "MALE", doctorProfileId: profileId, branchId: branch!.id, confirmNotDuplicate: "on" };

    // 100 000 + 120 000 + 30 000 = 250 000: 200 000 cash, 50 000 card.
    const r = await deskCheckIn(desk.ctx, { ...visit, serviceIds: [sid("Kardiolog ko'ruvi"), sid("EXO"), sid("EKG")], payMode: "split", split: { CASH: "200 000", CARD: "50000" } }, META);
    if (!r.ok) throw new Error("duplicate");
    const inv = (await getInvoice(desk.ctx, r.invoiceId!))!;
    expect([inv.totalMinor, inv.paidMinor, inv.status]).toEqual([25_000_000n, 25_000_000n, "PAID"]);
    expect(inv.payments.map((p) => [p.method, p.amountMinor])).toEqual([["CASH", 20_000_000n], ["CARD", 5_000_000n]]);

    // Less than the total: paid parts are recorded, the rest is the patient's debt.
    const short = await deskCheckIn(desk.ctx, { patientId: r.patientId, doctorProfileId: profileId, branchId: branch!.id, serviceIds: [sid("EXO")], payMode: "split", split: { CARD: "50000", BANK_TRANSFER: "20000" } }, META);
    if (!short.ok) throw new Error("duplicate");
    const s = (await getInvoice(desk.ctx, short.invoiceId!))!;
    expect([s.paidMinor, s.status]).toEqual([7_000_000n, "PARTIALLY_PAID"]);
    expect(s.payments.map((p) => p.method)).toEqual(["CARD", "BANK_TRANSFER"]);

    // More than the total, nothing filled in, or not a number: refused before anything is written.
    const base = { patientId: r.patientId, doctorProfileId: profileId, branchId: branch!.id, serviceIds: [sid("EKG")], payMode: "split" };
    await expect(deskCheckIn(desk.ctx, { ...base, split: { CASH: "20000", CARD: "20000" } }, META)).rejects.toThrow("errors.overpayment");
    await expect(deskCheckIn(desk.ctx, { ...base, split: {} }, META)).rejects.toThrow("errors.invalidAmount");
    await expect(deskCheckIn(desk.ctx, { ...base, split: { CASH: "ko'p" } }, META)).rejects.toThrow("errors.invalidAmount");
  });

  it("possible duplicates stop registration until confirmed", async () => {
    const o = await clinicWithOwner(await platformActor());
    const [branch] = await listBranches(o.ctx);
    const desk = await staff(o, ["receptionist"]);
    const doctor = await staff(o, ["doctor"]);
    const profileId = await saveDoctorProfile(o.ctx, doctor.membershipId, { specialty: "therapy", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
    const base = { lastName: "Takror", firstName: "Bemor", birthDate: "1980", sex: "MALE", doctorProfileId: profileId, branchId: branch!.id };
    expect((await deskCheckIn(desk.ctx, base, META)).ok).toBe(true);
    const again = await deskCheckIn(desk.ctx, base, META);
    expect(again.ok).toBe(false);
    expect((await deskCheckIn(desk.ctx, { ...base, confirmNotDuplicate: "on" }, META)).ok).toBe(true);
  });
});
