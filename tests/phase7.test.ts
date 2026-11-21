import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { registerWalkIn } from "@/server/appointments/appointments";
import { addInvoiceLine, createInvoice, getInvoice, issueInvoice, listInvoices, recordPayment, refundPayment, uninvoicedVisits, voidInvoice } from "@/server/billing/billing";
import { closeShift, createExpense, myShifts, openShift } from "@/server/billing/cash";
import { financialReport, operationalReport } from "@/server/billing/reports";
import { addStaffMember, listBranches, listClinicAudit, listStaff } from "@/server/clinic/admin";
import { saveDoctorProfile } from "@/server/clinic/doctors";
import { createService } from "@/server/clinic/resources";
import { registerPatient } from "@/server/patients/patients";
import { todayIn } from "@/server/scheduling/time";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

const TZ = "Asia/Tashkent";

async function staff(owner: Awaited<ReturnType<typeof clinicWithOwner>>, roleKeys: string[]) {
  const login = uniq("s");
  await addStaffMember(owner.ctx, { fullName: `Synthetic ${roleKeys[0]}`, username: login, roleKeys, password: PASSWORD }, META);
  const m = (await listStaff(owner.ctx)).members.find((x) => x.user.username === login)!;
  return { login, membershipId: m.id, ctx: await clinicContext(login, owner.slug) };
}

let n = 0;
async function setup() {
  const a = await clinicWithOwner(await platformActor());
  const [branch] = await listBranches(a.ctx);
  const reception = await staff(a, ["receptionist"]);
  const cashier = await staff(a, ["cashier"]);
  const doctor = await staff(a, ["doctor"]);
  const profileId = await saveDoctorProfile(a.ctx, doctor.membershipId, { specialty: "therapy", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
  const consult = await createService(a.ctx, { code: `C${++n}`, name: "Synthetic consultation", kind: "CONSULTATION", durationMinutes: 20, price: "150000", currency: "UZS" }, META);
  const ecg = await createService(a.ctx, { code: `E${n}`, name: "Synthetic ECG", kind: "PROCEDURE", durationMinutes: 15, price: "80000", currency: "UZS" }, META);
  const usd = await createService(a.ctx, { code: `U${n}`, name: "Synthetic USD service", kind: "OTHER", durationMinutes: 15, price: "50", currency: "USD" }, META);
  const patient = await registerPatient(reception.ctx, { lastName: "Sintetik", firstName: `Bemor${n}`, birthDate: "1990-01-01", sex: "FEMALE" }, { confirmNotDuplicate: true }, META);
  if (!patient.ok) throw new Error("patient");
  const visit = async () => {
    await registerWalkIn(reception.ctx, { patientId: patient.id, doctorProfileId: profileId, branchId: branch!.id, serviceId: consult }, META);
    return (await uninvoicedVisits(cashier.ctx)).find((v) => v.patientId === patient.id)!;
  };
  return { a, branch: branch!, reception, cashier, doctor, profileId, consult, ecg, usd, patientId: patient.id, visit };
}

describe("invoices", () => {
  it("draft from a visit, lines with discounts, sequential numbers, frozen once issued", async () => {
    const s = await setup();
    const v = await s.visit();
    const id = await createInvoice(s.cashier.ctx, { patientId: s.patientId, branchId: s.branch.id, appointmentId: v.id }, META);
    await expect(createInvoice(s.cashier.ctx, { patientId: s.patientId, branchId: s.branch.id, appointmentId: v.id }, META)).rejects.toThrow("errors.alreadyInvoiced");

    await addInvoiceLine(s.cashier.ctx, id, { serviceId: s.ecg, quantity: 2, discount: "10 000" }, META);
    await expect(addInvoiceLine(s.cashier.ctx, id, { serviceId: s.ecg, quantity: 1, discount: "999999" }, META)).rejects.toThrow("errors.invalidDiscount");
    await expect(addInvoiceLine(s.cashier.ctx, id, { serviceId: s.usd, quantity: 1 }, META)).rejects.toThrow("errors.currencyMismatch");

    let inv = (await getInvoice(s.cashier.ctx, id))!;
    expect(inv.lines).toHaveLength(2);
    expect(inv.subtotalMinor).toBe(31_000_000n); // 150 000 + 2 × 80 000 (in tiyin)
    expect(inv.discountMinor).toBe(1_000_000n);
    expect(inv.totalMinor).toBe(30_000_000n);

    const year = todayIn(TZ).slice(0, 4);
    expect(await issueInvoice(s.cashier.ctx, id, META)).toBe(`INV-${year}-000001`);
    await expect(addInvoiceLine(s.cashier.ctx, id, { serviceId: s.ecg, quantity: 1 }, META)).rejects.toThrow("errors.invoiceNotDraft");

    // The database refuses to change lines or amounts of an issued invoice, even for the schema owner.
    const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.connect();
    await expect(owner.query(`DELETE FROM "InvoiceLine" WHERE "invoiceId" = $1`, [id])).rejects.toThrow(/draft/);
    await expect(owner.query(`UPDATE "Invoice" SET "totalMinor" = 1, "subtotalMinor" = 1, "discountMinor" = 0 WHERE id = $1`, [id])).rejects.toThrow(/final/);
    await expect(owner.query(`DELETE FROM "Invoice" WHERE id = $1`, [id])).rejects.toThrow(/cannot be deleted/);
    await owner.end();

    const second = await createInvoice(s.cashier.ctx, { patientId: s.patientId, branchId: s.branch.id }, META);
    await expect(issueInvoice(s.cashier.ctx, second, META)).rejects.toThrow("errors.emptyInvoice");
    await addInvoiceLine(s.cashier.ctx, second, { serviceId: s.consult, quantity: 1 }, META);
    expect(await issueInvoice(s.cashier.ctx, second, META)).toBe(`INV-${year}-000002`);
    inv = (await getInvoice(s.cashier.ctx, second))!;
    expect(inv.status).toBe("ISSUED");
  });
});

describe("payments, refunds and the cash drawer", () => {
  async function issued(s: Awaited<ReturnType<typeof setup>>) {
    const v = await s.visit();
    const id = await createInvoice(s.cashier.ctx, { patientId: s.patientId, branchId: s.branch.id, appointmentId: v.id }, META);
    await issueInvoice(s.cashier.ctx, id, META);
    return id; // total 150 000 UZS
  }

  it("cash needs an open shift; partial payments; overpayment rejected; double submit is idempotent", async () => {
    const s = await setup();
    const id = await issued(s);
    await expect(recordPayment(s.cashier.ctx, id, { amount: "50000", method: "CASH", idempotencyKey: randomUUID() }, META)).rejects.toThrow("errors.openShiftFirst");
    await openShift(s.cashier.ctx, { branchId: s.branch.id, openingFloat: "100 000" }, META);
    await expect(openShift(s.cashier.ctx, { branchId: s.branch.id, openingFloat: "0" }, META)).rejects.toThrow("errors.shiftAlreadyOpen");

    const key = randomUUID();
    const first = await recordPayment(s.cashier.ctx, id, { amount: "50 000", method: "CASH", idempotencyKey: key }, META);
    const again = await recordPayment(s.cashier.ctx, id, { amount: "50 000", method: "CASH", idempotencyKey: key }, META);
    expect(again).toEqual({ paymentId: first.paymentId, duplicate: true });
    let inv = (await getInvoice(s.cashier.ctx, id))!;
    expect(inv.status).toBe("PARTIALLY_PAID");
    expect(inv.paidMinor).toBe(5_000_000n);

    await expect(recordPayment(s.cashier.ctx, id, { amount: "100 000,01", method: "CARD", idempotencyKey: randomUUID() }, META)).rejects.toThrow("errors.overpayment");
    await recordPayment(s.cashier.ctx, id, { amount: "100000", method: "PAYME", externalRef: "SYN-TX-1", idempotencyKey: randomUUID() }, META);
    inv = (await getInvoice(s.cashier.ctx, id))!;
    expect(inv.status).toBe("PAID");
    await expect(recordPayment(s.cashier.ctx, id, { amount: "1", method: "CARD", idempotencyKey: randomUUID() }, META)).rejects.toThrow("errors.invoiceNotPayable");
  });

  it("concurrent payments can never exceed the invoice total", async () => {
    const s = await setup();
    const id = await issued(s);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => recordPayment(s.cashier.ctx, id, { amount: "150000", method: "CARD", idempotencyKey: randomUUID() }, META)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const inv = (await getInvoice(s.cashier.ctx, id))!;
    expect(inv.paidMinor).toBe(inv.totalMinor);
  });

  it("refunds reduce the paid amount; void only when nothing is paid; shift closing reconciles cash", async () => {
    const s = await setup();
    const id = await issued(s);
    const shiftId = await openShift(s.cashier.ctx, { branchId: s.branch.id, openingFloat: "200000" }, META);
    const { paymentId } = await recordPayment(s.cashier.ctx, id, { amount: "150000", method: "CASH", idempotencyKey: randomUUID() }, META);

    await expect(voidInvoice(s.cashier.ctx, id, "CREATED_IN_ERROR", META)).rejects.toThrow("errors.refundFirst");
    await expect(refundPayment(s.cashier.ctx, paymentId, { amount: "150 000,01", reason: "OVERPAYMENT", idempotencyKey: randomUUID() }, META)).rejects.toThrow("errors.refundTooLarge");
    const rk = randomUUID();
    await refundPayment(s.cashier.ctx, paymentId, { amount: "50000", reason: "SERVICE_NOT_PROVIDED", idempotencyKey: rk }, META);
    await refundPayment(s.cashier.ctx, paymentId, { amount: "50000", reason: "SERVICE_NOT_PROVIDED", idempotencyKey: rk }, META); // repeat: no-op
    let inv = (await getInvoice(s.cashier.ctx, id))!;
    expect(inv.paidMinor).toBe(10_000_000n);
    expect(inv.status).toBe("PARTIALLY_PAID");

    const shifts = await myShifts(s.cashier.ctx);
    expect(shifts[0]!.live?.expected).toBe(20_000_000n + 15_000_000n - 5_000_000n);

    const other = await staff(s.a, ["cashier"]);
    await expect(closeShift(other.ctx, shiftId, "0", META)).rejects.toThrow("errors.notYourShift");
    const closed = await closeShift(s.cashier.ctx, shiftId, "299 000", META);
    expect(closed).toEqual({ expected: 30_000_000n, counted: 29_900_000n, difference: -100_000n });

    // Cash refunds need an open shift again.
    await expect(refundPayment(s.cashier.ctx, paymentId, { amount: "100000", reason: "PATIENT_REQUEST", idempotencyKey: randomUUID() }, META)).rejects.toThrow("errors.openShiftFirst");
    await openShift(s.cashier.ctx, { branchId: s.branch.id, openingFloat: "0" }, META);
    await refundPayment(s.cashier.ctx, paymentId, { amount: "100000", reason: "PATIENT_REQUEST", idempotencyKey: randomUUID() }, META);
    await voidInvoice(s.cashier.ctx, id, "SERVICE_CANCELLED", META);
    inv = (await getInvoice(s.cashier.ctx, id))!;
    expect(inv.status).toBe("VOID");
    await expect(voidInvoice(s.cashier.ctx, id, "OTHER", META)).rejects.toThrow("errors.invalidTransition");
  });
});

describe("permissions, reports and isolation", () => {
  it("role separation: front desk cannot take money; cashier cannot read finance reports", async () => {
    const s = await setup();
    const v = await s.visit();
    await expect(createInvoice(s.reception.ctx, { patientId: s.patientId, branchId: s.branch.id, appointmentId: v.id }, META)).rejects.toThrow("errors.forbidden");
    const id = await createInvoice(s.cashier.ctx, { patientId: s.patientId, branchId: s.branch.id, appointmentId: v.id }, META);
    await issueInvoice(s.cashier.ctx, id, META);
    await expect(recordPayment(s.a.ctx, id, { amount: "1", method: "CARD", idempotencyKey: randomUUID() }, META)).rejects.toThrow("errors.forbidden");
    await expect(financialReport(s.cashier.ctx, todayIn(TZ), todayIn(TZ))).rejects.toThrow("errors.forbidden");
    await expect(createExpense(s.cashier.ctx, { category: "RENT", amount: "1", currency: "UZS", spentOn: todayIn(TZ) }, META)).rejects.toThrow("errors.forbidden");
    expect((await listInvoices(s.a.ctx)).length).toBe(1); // owner: billing.read
    // Search by the patient's name (any case), card number or invoice number; no match → empty.
    const issuedNumber = (await getInvoice(s.a.ctx, id))!.number!;
    expect((await listInvoices(s.a.ctx, { q: "sintetik" })).map((i) => i.id)).toEqual([id]);
    expect((await listInvoices(s.a.ctx, { q: issuedNumber.slice(-4) })).map((i) => i.id)).toEqual([id]);
    expect(await listInvoices(s.a.ctx, { q: "Begona" })).toEqual([]);

    // The activity log names the clinic user who acted (not just "USER").
    const audit = await listClinicAudit(s.a.ctx, 50);
    const issued = audit.find((e) => e.action === "invoice.issued")!;
    expect(issued.actorName).toBe("Synthetic cashier");
    expect(audit.find((e) => e.action === "tenant.created")!.actorName).toBeNull(); // ITop Med staff are not named to clinics
  });

  it("financial and operational reports add up", async () => {
    const s = await setup();
    const today = todayIn(TZ);
    await openShift(s.cashier.ctx, { branchId: s.branch.id, openingFloat: "0" }, META);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const v = await s.visit();
      const id = await createInvoice(s.cashier.ctx, { patientId: s.patientId, branchId: s.branch.id, appointmentId: v.id }, META);
      await issueInvoice(s.cashier.ctx, id, META);
      ids.push(id);
    }
    const p1 = await recordPayment(s.cashier.ctx, ids[0]!, { amount: "150000", method: "CASH", idempotencyKey: randomUUID() }, META);
    await recordPayment(s.cashier.ctx, ids[1]!, { amount: "40000", method: "CARD", idempotencyKey: randomUUID() }, META);
    await refundPayment(s.cashier.ctx, p1.paymentId, { amount: "20000", reason: "BILLING_ERROR", idempotencyKey: randomUUID() }, META);
    const accountant = await staff(s.a, ["accountant"]);
    await createExpense(accountant.ctx, { category: "MEDICAL_SUPPLIES", amount: "30000", currency: "UZS", spentOn: today, description: "Synthetic gloves" }, META);

    const r = await financialReport(s.a.ctx, today, today);
    const uzs = r.totals.find((x) => x.currency === "UZS")!;
    expect(uzs.invoiced).toBe(30_000_000n);
    expect(uzs.received).toBe(19_000_000n);
    expect(uzs.refunded).toBe(2_000_000n);
    expect(uzs.outstanding).toBe(30_000_000n - 17_000_000n);
    expect(uzs.expenses).toBe(3_000_000n);
    expect(r.byMethod.find((m) => m.method === "CASH")?.net).toBe(13_000_000n);
    expect(r.byService[0]).toMatchObject({ service: "Synthetic consultation", quantity: 2, amount: 30_000_000n });
    expect(r.debtors.map((d) => d.invoiceId).sort()).toEqual(ids.slice().sort());

    const ops = await operationalReport(s.a.ctx, today, today);
    expect(ops.appointmentsByStatus.reduce((x, y) => x + y.count, 0)).toBe(2);
    expect(ops.newPatients).toBe(1);
  });

  it("billing data is invisible to the platform role and to other clinics", async () => {
    const s = await setup();
    const v = await s.visit();
    const id = await createInvoice(s.cashier.ctx, { patientId: s.patientId, branchId: s.branch.id, appointmentId: v.id }, META);
    const platform = new pg.Client({ connectionString: process.env.PLATFORM_DATABASE_URL });
    await platform.connect();
    for (const t of ["Invoice", "InvoiceLine", "Payment", "Refund", "CashShift", "Expense"]) {
      await expect(platform.query(`SELECT 1 FROM "${t}" LIMIT 1`)).rejects.toThrow(/permission denied/);
    }
    await platform.end();
    const other = await setup();
    expect(await getInvoice(other.cashier.ctx, id)).toBeNull();
    await expect(recordPayment(other.cashier.ctx, id, { amount: "1", method: "CARD", idempotencyKey: randomUUID() }, META)).rejects.toThrow("errors.notFound");
  });
});
