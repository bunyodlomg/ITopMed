import { describe, expect, it } from "vitest";
import { approveDebt, getInvoice } from "@/server/billing/billing";
import { addStaffMember, listBranches, listStaff } from "@/server/clinic/admin";
import { saveDoctorProfile } from "@/server/clinic/doctors";
import { importPriceList } from "@/server/clinic/price-list";
import { listBenefitCategories, saveBenefitCategory, saveFreeFollowUpDays, savePackage } from "@/server/clinic/pricing";
import { createService, listServices } from "@/server/clinic/resources";
import { addAnalyte, collectSpecimen, createLabOrder, enterResults, getLabOrder, labOrderForPrint, verifyResults } from "@/server/lab/lab";
import { addStandardTemplates, listTemplates } from "@/server/clinic/templates";
import { withAppContext } from "@/server/db";
import { randomUUID } from "node:crypto";
import { openShift } from "@/server/billing/cash";
import { recordPayment } from "@/server/billing/billing";
import { updateClinicPolicy } from "@/server/clinic/policy";
import { addDiagnosticResult, diagnosticForPrint } from "@/server/emr/diagnostics";
import { deskPrintGate, deskPrintables, documentForVisit, prescriptionForPrint, printsAtDesk } from "@/server/emr/documents";
import { addDiagnosis, finishEncounter, saveDraft, signNote, startVisit, getEncounter } from "@/server/emr/record";
import { getPatient } from "@/server/patients/patients";
import { deskCheckIn } from "@/server/reception/desk";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

async function staff(o: Awaited<ReturnType<typeof clinicWithOwner>>, roleKeys: string[]) {
  const login = uniq("s");
  await addStaffMember(o.ctx, { fullName: `Synthetic ${roleKeys.join(" ")}`, username: login, roleKeys, password: PASSWORD }, META);
  const m = (await listStaff(o.ctx)).members.find((x) => x.user.username === login)!;
  return { membershipId: m.id, ctx: await clinicContext(login, o.slug) };
}

async function setup() {
  const o = await clinicWithOwner(await platformActor());
  const [branch] = await listBranches(o.ctx);
  await importPriceList(o.ctx, { text: "Kardiolog ko'ruvi 100 ming\nEKG 30 ming\nEXO 120 ming" }, META);
  const services = await listServices(o.ctx);
  const sid = (n: string) => services.find((s) => s.name === n)!.id;
  const desk = await staff(o, ["receptionist"]);
  const cashier = await staff(o, ["cashier"]);
  const frontDesk = await staff(o, ["receptionist", "cashier"]);
  const doctor = await staff(o, ["doctor"]);
  const profileId = await saveDoctorProfile(o.ctx, doctor.membershipId, { specialty: "cardiology", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
  return { o, branchId: branch!.id, sid, desk, cashier, frontDesk, doctor, profileId };
}

const invoiceOf = async (ctx: Parameters<typeof getInvoice>[0], appointmentId: string) =>
  withAppContext({ tenantId: ctx.tenant.id, userId: ctx.principal.user.id }, (tx) => tx.invoice.findUniqueOrThrow({ where: { appointmentId }, include: { lines: true } }));

describe("desk pricing rules", () => {
  it("referral source and benefit category are stored; the category discount applies with its reason", async () => {
    const s = await setup();
    await saveBenefitCategory(s.o.ctx, { name: "Synthetic veterans", discountPercent: 20 }, META);
    const [benefit] = await listBenefitCategories(s.o.ctx);
    const r = await deskCheckIn(
      s.frontDesk.ctx,
      { lastName: "Sintetik", firstName: "Imtiyoz", birthDate: "1950", sex: "MALE", referralSource: "ADVERTISING", referralDetail: "Instagram", benefitCategoryId: benefit!.id, doctorProfileId: s.profileId, branchId: s.branchId, serviceIds: [s.sid("Kardiolog ko'ruvi")], payMode: "full", method: "CARD" },
      META,
    );
    if (!r.ok) throw new Error("duplicate");
    const p = await getPatient(s.frontDesk.ctx, r.patientId, META);
    expect(p).toMatchObject({ referralSource: "ADVERTISING", referralDetail: "Instagram", benefitCategoryId: benefit!.id });
    const inv = await invoiceOf(s.frontDesk.ctx, r.appointmentId);
    expect(inv.totalMinor).toBe(8_000_000n); // 100 000 - 20 %
    expect(inv.lines[0]).toMatchObject({ discountKind: "BENEFIT", discountReason: "Imtiyoz: Synthetic veterans" });
    expect(inv.paidMinor).toBe(8_000_000n);
  });

  it("split payment after a discount: what was handed over beyond the new total comes off the cash part", async () => {
    const s = await setup();
    await saveBenefitCategory(s.o.ctx, { name: "Synthetic pensioners", discountPercent: 20 }, META);
    const [benefit] = await listBenefitCategories(s.o.ctx);
    // Price 100 000, desk enters 60 000 cash + 40 000 card; the benefit makes it 80 000.
    const r = await deskCheckIn(
      s.frontDesk.ctx,
      { lastName: "Sintetik", firstName: "Qaytim", birthDate: "1952", sex: "FEMALE", benefitCategoryId: benefit!.id, doctorProfileId: s.profileId, branchId: s.branchId, serviceIds: [s.sid("Kardiolog ko'ruvi")], payMode: "split", split: { CASH: "60000", CARD: "40000" } },
      META,
    );
    if (!r.ok) throw new Error("duplicate");
    const inv = (await getInvoice(s.frontDesk.ctx, (await invoiceOf(s.frontDesk.ctx, r.appointmentId)).id))!;
    expect([inv.totalMinor, inv.paidMinor, inv.status]).toEqual([8_000_000n, 8_000_000n, "PAID"]);
    expect(inv.payments.map((p) => [p.method, p.amountMinor])).toEqual([["CASH", 4_000_000n], ["CARD", 4_000_000n]]);
  });

  it("a package applies when all its services are billed together; the best single rule wins", async () => {
    const s = await setup();
    await savePackage(s.o.ctx, { name: "Synthetic heart check", discountPercent: 10, serviceIds: [s.sid("EKG"), s.sid("EXO")] }, META);
    await expect(savePackage(s.o.ctx, { name: "One", discountPercent: 10, serviceIds: [s.sid("EKG")] }, META)).rejects.toThrow();
    const r = await deskCheckIn(s.frontDesk.ctx, { lastName: "Sintetik", firstName: "Paket", birthDate: "1970", sex: "FEMALE", doctorProfileId: s.profileId, branchId: s.branchId, serviceIds: [s.sid("EKG"), s.sid("EXO")], payMode: "debt" }, META);
    if (!r.ok) throw new Error("duplicate");
    const inv = await invoiceOf(s.frontDesk.ctx, r.appointmentId);
    expect(inv.totalMinor).toBe(13_500_000n); // (30 000 + 120 000) - 10 %
    expect(inv.lines.every((l) => l.discountKind === "PACKAGE")).toBe(true);
  });

  it("follow-up consultation is free within N days; outside it only by exception with reason and permission", async () => {
    const s = await setup();
    const first = await deskCheckIn(s.frontDesk.ctx, { lastName: "Sintetik", firstName: "Qayta", birthDate: "1960", sex: "MALE", doctorProfileId: s.profileId, branchId: s.branchId, serviceIds: [s.sid("Kardiolog ko'ruvi")], payMode: "full", method: "CARD" }, META);
    if (!first.ok) throw new Error("duplicate");
    expect((await invoiceOf(s.frontDesk.ctx, first.appointmentId)).totalMinor).toBe(10_000_000n);

    // A few minutes later (same day) is within 10 days: free, nothing to pay.
    const again = await deskCheckIn(s.frontDesk.ctx, { patientId: first.patientId, doctorProfileId: s.profileId, branchId: s.branchId, serviceIds: [s.sid("Kardiolog ko'ruvi"), s.sid("EKG")], payMode: "full", method: "CARD" }, META);
    if (!again.ok) throw new Error("duplicate");
    const inv2 = await invoiceOf(s.frontDesk.ctx, again.appointmentId);
    expect(inv2.lines.find((l) => l.serviceId === s.sid("Kardiolog ko'ruvi"))).toMatchObject({ discountKind: "FOLLOW_UP", totalMinor: 0n });
    expect(inv2.totalMinor).toBe(3_000_000n); // the ECG is still paid

    // Period switched off: not free any more; the exception needs billing.free_visit and a reason.
    await saveFreeFollowUpDays(s.o.ctx, { freeFollowUpDays: 0 }, META);
    const base = { patientId: first.patientId, doctorProfileId: s.profileId, branchId: s.branchId, serviceIds: [s.sid("Kardiolog ko'ruvi")], payMode: "debt" };
    await expect(deskCheckIn(s.desk.ctx, { ...base, freeVisit: "on", freeVisitReason: "Synthetic reason" }, META)).rejects.toThrow();
    await expect(deskCheckIn(s.frontDesk.ctx, { ...base, freeVisit: "on", freeVisitReason: "" }, META)).rejects.toThrow("errors.freeVisitReasonRequired");
    const exc = await deskCheckIn(s.frontDesk.ctx, { ...base, freeVisit: "on", freeVisitReason: "Synthetic: complication check" }, META);
    if (!exc.ok) throw new Error("duplicate");
    const inv3 = await invoiceOf(s.frontDesk.ctx, exc.appointmentId);
    expect(inv3.lines[0]).toMatchObject({ discountKind: "FOLLOW_UP_EXCEPTION", totalMinor: 0n, discountApprovedById: s.frontDesk.ctx.principal.user.id });
    expect(inv3.lines[0]!.discountReason).toContain("Synthetic: complication check");
  });
});

describe("desk prints final documents only after the cashier", () => {
  it("not before the visit is closed, not while unpaid; after the cashier allows the debt it prints", async () => {
    const s = await setup();
    await addStandardTemplates(s.o.ctx, META);
    const [doc] = await listTemplates(s.o.ctx, { kind: "DOCUMENT" });
    const r = await deskCheckIn(s.frontDesk.ctx, { lastName: "Sintetik", firstName: "Hujjat", birthDate: "1965", sex: "MALE", doctorProfileId: s.profileId, branchId: s.branchId, serviceIds: [s.sid("Kardiolog ko'ruvi")], payMode: "debt" }, META);
    if (!r.ok) throw new Error("duplicate");
    const enc = await startVisit(s.doctor.ctx, r.appointmentId, META);
    expect(await deskPrintGate(s.desk.ctx, enc)).toBe("notFinished");
    const note = (await getEncounter(s.doctor.ctx, enc, META)).encounter.notes[0]!;
    await saveDraft(s.doctor.ctx, note.id, { complaints: "Synthetic", history: "", examination: "", assessment: "Synthetic", plan: "" }, META);
    await signNote(s.doctor.ctx, note.id, { complaints: "Synthetic", history: "", examination: "", assessment: "Synthetic", plan: "" }, META);
    await addDiagnosis(s.doctor.ctx, enc, { icd10Code: "I10", description: "Synthetic", kind: "PRIMARY" }, META);
    await finishEncounter(s.doctor.ctx, enc, META);

    expect(await deskPrintGate(s.desk.ctx, enc)).toBe("unpaid");
    await expect(documentForVisit(s.desk.ctx, enc, doc!.id, META)).rejects.toThrow("errors.deskPrint.unpaid");
    // The registrar cannot allow the debt; the cashier can.
    const inv = await invoiceOf(s.cashier.ctx, r.appointmentId);
    await expect(approveDebt(s.desk.ctx, inv.id, META)).rejects.toThrow();
    await approveDebt(s.cashier.ctx, inv.id, META);
    expect(await deskPrintGate(s.desk.ctx, enc)).toBe("ok");
    const d = await documentForVisit(s.desk.ctx, enc, doc!.id, META);
    expect(d.encounter.patient.firstName).toBe("Hujjat");
  });

  it("clinic rule 'print only at the desk': the doctor cannot print; the desk prints visit papers and diagnostic reports once paid", async () => {
    const s = await setup();
    await addStandardTemplates(s.o.ctx, META);
    const [doc] = await listTemplates(s.o.ctx, { kind: "DOCUMENT" });
    const r = await deskCheckIn(s.frontDesk.ctx, { lastName: "Sintetik", firstName: "Muhr", birthDate: "1970", sex: "FEMALE", doctorProfileId: s.profileId, branchId: s.branchId, serviceIds: [s.sid("EXO")], payMode: "debt" }, META);
    if (!r.ok) throw new Error("duplicate");
    const enc = await startVisit(s.doctor.ctx, r.appointmentId, META);
    const echo = await addDiagnosticResult(s.doctor.ctx, r.patientId, { encounterId: enc, kind: "ECHO", title: "ExoKG", conclusion: "Synthetic" }, META);
    const note = (await getEncounter(s.doctor.ctx, enc, META)).encounter.notes[0]!;
    await signNote(s.doctor.ctx, note.id, { complaints: "Synthetic", history: "", examination: "", assessment: "Synthetic", plan: "" }, META);
    await addDiagnosis(s.doctor.ctx, enc, { icd10Code: "I10", description: "Synthetic", kind: "PRIMARY" }, META);
    await finishEncounter(s.doctor.ctx, enc, META);

    // Rule off (default): the doctor prints as before.
    expect(await printsAtDesk(s.doctor.ctx, true)).toBe(false);
    expect((await diagnosticForPrint(s.doctor.ctx, echo, META)).result.title).toBe("ExoKG");

    // Only the owner switches the rule on; then the doctor cannot print any paper.
    await updateClinicPolicy(s.o.ctx, { maxDiscountPercent: 100, discountReasonRequired: false, printOnlyAtDesk: true }, META);
    await expect(documentForVisit(s.doctor.ctx, enc, doc!.id, META)).rejects.toThrow("errors.deskPrint.atDesk");
    await expect(diagnosticForPrint(s.doctor.ctx, echo, META)).rejects.toThrow("errors.deskPrint.atDesk");
    await expect(prescriptionForPrint(s.doctor.ctx, enc, META)).rejects.toThrow("errors.deskPrint.atDesk");

    // The desk sees what can be printed, locked while the echo is unpaid (red).
    const before = await deskPrintables(s.desk.ctx, r.appointmentId);
    expect(before).toMatchObject({ gate: "unpaid", encounterId: enc, hasPrescription: false });
    expect(before.diagnostics.map((x) => x.id)).toEqual([echo]);
    await expect(diagnosticForPrint(s.desk.ctx, echo, META)).rejects.toThrow("errors.deskPrint.unpaid");
    await expect(deskPrintables(s.doctor.ctx, r.appointmentId)).rejects.toThrow("errors.forbidden");

    // The cashier takes the money (cash + card): green, and the desk prints both papers.
    const inv = await invoiceOf(s.cashier.ctx, r.appointmentId);
    await openShift(s.cashier.ctx, { branchId: s.branchId, openingFloat: "0" }, META);
    await recordPayment(s.cashier.ctx, inv.id, { amount: "100000", method: "CASH", idempotencyKey: randomUUID() }, META);
    await recordPayment(s.cashier.ctx, inv.id, { amount: "20000", method: "CARD", idempotencyKey: randomUUID() }, META);
    expect((await deskPrintables(s.desk.ctx, r.appointmentId)).gate).toBe("ok");
    expect((await diagnosticForPrint(s.desk.ctx, echo, META)).result.title).toBe("ExoKG");
    expect((await documentForVisit(s.desk.ctx, enc, doc!.id, META)).encounter.patient.firstName).toBe("Muhr");
    expect((await prescriptionForPrint(s.desk.ctx, enc, META)).encounter.id).toBe(enc);
  });
  it("lab report: printed by the lab once verified; at the desk only when paid; desk-only rule stops the lab", async () => {
    const s = await setup();
    const lab1 = await staff(s.o, ["lab_staff"]);
    const lab2 = await staff(s.o, ["lab_staff"]);
    const nurse = await staff(s.o, ["nurse"]);
    const svc = await createService(s.o.ctx, { code: "HB1", name: "Synthetic blood count", kind: "LAB_TEST", durationMinutes: 10, price: "40000", currency: "UZS" }, META);
    const analyte = await addAnalyte(lab1.ctx, svc, { name: "Hemoglobin", unit: "g/L", refLow: "120", refHigh: "160" }, META);
    const r = await deskCheckIn(s.frontDesk.ctx, { lastName: "Sintetik", firstName: "Tahlil", birthDate: "1975", sex: "FEMALE", doctorProfileId: s.profileId, branchId: s.branchId, serviceIds: [s.sid("Kardiolog ko'ruvi")], payMode: "debt" }, META);
    if (!r.ok) throw new Error("duplicate");
    const enc = await startVisit(s.doctor.ctx, r.appointmentId, META);
    const { id } = await createLabOrder(s.doctor.ctx, enc, { serviceIds: [svc] }, META);
    await expect(labOrderForPrint(lab1.ctx, id, META)).rejects.toThrow("errors.deskPrint.labNotVerified");
    await collectSpecimen(nurse.ctx, id, META);
    const item = (await getLabOrder(lab1.ctx, id, META)).items[0]!;
    await enterResults(lab1.ctx, id, { [`${item.id}:${analyte}`]: "99.5" }, META);
    await verifyResults(lab2.ctx, id, META);

    // The lab prints the verified report (value below the range is flagged).
    const printed = await labOrderForPrint(lab1.ctx, id, META);
    expect(printed.order.items[0]!.results[0]).toMatchObject({ flag: "LOW" });
    expect(printed.verifiedBy).toBe("Synthetic lab_staff");

    // The desk lists it with today's papers, but prints only once the bill is settled.
    expect((await deskPrintables(s.desk.ctx, r.appointmentId)).labOrders.map((o) => o.id)).toEqual([id]);
    await expect(labOrderForPrint(s.desk.ctx, id, META)).rejects.toThrow("errors.deskPrint.unpaid");
    await approveDebt(s.cashier.ctx, (await invoiceOf(s.cashier.ctx, r.appointmentId)).id, META);
    expect((await labOrderForPrint(s.desk.ctx, id, META)).order.number).toBe(printed.order.number);
    await expect(labOrderForPrint(s.doctor.ctx, "00000000-0000-0000-0000-000000000000", META)).rejects.toThrow();

    // Print only at the desk: the lab can no longer print.
    await updateClinicPolicy(s.o.ctx, { maxDiscountPercent: 100, discountReasonRequired: false, printOnlyAtDesk: true }, META);
    await expect(labOrderForPrint(lab1.ctx, id, META)).rejects.toThrow("errors.deskPrint.atDesk");
    expect((await labOrderForPrint(s.desk.ctx, id, META)).order.id).toBe(id);
  });
});
