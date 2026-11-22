import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { registerWalkIn } from "@/server/appointments/appointments";
import { addInvoiceLine, createInvoice, issueInvoice, recordPayment, refundPayment } from "@/server/billing/billing";
import { openShift } from "@/server/billing/cash";
import { addStaffMember, listBranches, listStaff } from "@/server/clinic/admin";
import { saveDoctorProfile } from "@/server/clinic/doctors";
import { purgeTestPatients } from "@/server/clinic/purge";
import { createService, listServices } from "@/server/clinic/resources";
import { withAppContext } from "@/server/db";
import { addDiagnosticResult } from "@/server/emr/diagnostics";
import { addPrescription } from "@/server/emr/prescriptions";
import { addAllergy, addDiagnosis, recordVitals, signNote, startVisit } from "@/server/emr/record";
import { registerPatient } from "@/server/patients/patients";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

type Clinic = Awaited<ReturnType<typeof clinicWithOwner>>;

async function staff(o: Clinic, roleKeys: string[]) {
  const login = uniq("s");
  await addStaffMember(o.ctx, { fullName: `Synthetic ${roleKeys.join("+")}`, username: login, roleKeys, password: PASSWORD }, META);
  const m = (await listStaff(o.ctx)).members.find((x) => x.user.username === login)!;
  return { login, membershipId: m.id, ctx: await clinicContext(login, o.slug) };
}

/** One complete synthetic visit: queue, encounter, signed note, diagnosis, vitals, allergy, Rx, ECG, paid (and partly refunded) invoice. */
async function fullVisit(o: Clinic) {
  const [branch] = await listBranches(o.ctx);
  const reception = await staff(o, ["receptionist", "cashier"]);
  const doctor = await staff(o, ["doctor"]);
  const profileId = await saveDoctorProfile(o.ctx, doctor.membershipId, { specialty: "cardiology", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
  const service = await createService(o.ctx, { code: uniq("S").toUpperCase(), name: "Synthetic consultation", kind: "CONSULTATION", durationMinutes: 20, price: "100000", currency: "UZS" }, META);
  const p = await registerPatient(reception.ctx, { lastName: "Sintetik", firstName: "Sinov", birthDate: "1970", sex: "MALE" }, { confirmNotDuplicate: true }, META);
  if (!p.ok) throw new Error("patient");
  const appt = await registerWalkIn(reception.ctx, { patientId: p.id, doctorProfileId: profileId, branchId: branch!.id, serviceId: service }, META);
  const enc = await startVisit(doctor.ctx, appt, META);
  const note = await withAppContext({ tenantId: o.ctx.tenant.id }, (tx) => tx.clinicalNote.findFirstOrThrow({ where: { encounterId: enc }, select: { id: true } }));
  await signNote(doctor.ctx, note.id, { complaints: "Synthetic", history: "", examination: "", assessment: "Synthetic", plan: "" }, META);
  await addDiagnosis(doctor.ctx, enc, { icd10Code: "I10", description: "Synthetic", kind: "PRIMARY" }, META);
  await recordVitals(doctor.ctx, p.id, { SYSTOLIC_BP: "150", DIASTOLIC_BP: "95" }, META, { encounterId: enc });
  await addAllergy(doctor.ctx, p.id, { substance: "Synthetic", reaction: "", severity: "MILD" }, META).catch(() => undefined);
  await addPrescription(doctor.ctx, enc, { drug: "Bisoprolol 5 mg", dose: "1 tablet", frequency: "once daily" }, META);
  await addDiagnosticResult(doctor.ctx, p.id, { encounterId: enc, kind: "ECG", title: "EKG", conclusion: "Synthetic", rhythm: "sinus", heartRate: "72" }, META);
  await openShift(reception.ctx, { branchId: branch!.id, openingFloat: "0", currency: "UZS" }, META);
  const inv = await createInvoice(reception.ctx, { patientId: p.id, branchId: branch!.id, appointmentId: appt }, META);
  await addInvoiceLine(reception.ctx, inv, { serviceId: service, quantity: 1 }, META);
  await issueInvoice(reception.ctx, inv, META);
  const { paymentId } = await recordPayment(reception.ctx, inv, { amount: "100000", method: "CASH", idempotencyKey: randomUUID() }, META);
  await refundPayment(reception.ctx, paymentId, { amount: "10000", reason: "SERVICE_NOT_PROVIDED", idempotencyKey: randomUUID() }, META);
  return { reception, doctor, patientId: p.id };
}

const count = (tenantId: string) =>
  withAppContext({ tenantId }, async (tx) => ({
    patients: await tx.patient.count({ where: { tenantId } }),
    appointments: await tx.appointment.count({ where: { tenantId } }),
    encounters: await tx.encounter.count({ where: { tenantId } }),
    notes: await tx.clinicalNote.count({ where: { tenantId } }),
    prescriptions: await tx.prescription.count({ where: { tenantId } }),
    diagnostics: await tx.diagnosticResult.count({ where: { tenantId } }),
    invoices: await tx.invoice.count({ where: { tenantId } }),
    payments: await tx.payment.count({ where: { tenantId } }),
    shifts: await tx.cashShift.count({ where: { tenantId } }),
  }));

describe("removing test patients before real work", () => {
  it("owner only, typed confirmation; removes every patient with all their data in this clinic only; guards stay on", async () => {
    const actor = await platformActor();
    const a = await clinicWithOwner(actor);
    const b = await clinicWithOwner(actor);
    const sa = await fullVisit(a);
    await fullVisit(b);
    const before = await count(a.ctx.tenant.id);
    expect(before).toMatchObject({ patients: 1, appointments: 1, encounters: 1, notes: 1, prescriptions: 1, diagnostics: 1, invoices: 1, payments: 1, shifts: 1 });
    const servicesBefore = (await listServices(a.ctx)).length;

    // Not the owner (even with every desk permission), or a wrong address: nothing happens.
    await expect(purgeTestPatients(sa.reception.ctx, { confirm: a.slug }, META)).rejects.toThrow();
    await expect(purgeTestPatients(sa.doctor.ctx, { confirm: a.slug }, META)).rejects.toThrow();
    await expect(purgeTestPatients(a.ctx, { confirm: "wrong" }, META)).rejects.toThrow("errors.purgeConfirm");
    // The database function itself refuses a non-owner, whatever the app sends.
    await expect(
      withAppContext({ tenantId: a.ctx.tenant.id, userId: sa.reception.ctx.principal.user.id }, (tx) => tx.$queryRaw`SELECT app_purge_patients()`),
    ).rejects.toThrow();
    expect(await count(a.ctx.tenant.id)).toEqual(before);

    const r = await purgeTestPatients(a.ctx, { confirm: ` ${a.slug.toUpperCase()} ` }, META);
    expect(r).toEqual({ patients: 1, appointments: 1, encounters: 1, invoices: 1 });
    expect(Object.values(await count(a.ctx.tenant.id)).every((n) => n === 0)).toBe(true);
    // Settings, services and staff stay; the other clinic is untouched.
    expect((await listServices(a.ctx)).length).toBe(servicesBefore);
    expect((await listStaff(a.ctx)).members.length).toBeGreaterThanOrEqual(3);
    expect(await count(b.ctx.tenant.id)).toEqual(before);
    // Audited, counts only.
    const audit = await withAppContext({ tenantId: a.ctx.tenant.id }, (tx) => tx.auditEvent.findFirst({ where: { tenantId: a.ctx.tenant.id, action: "clinic.patients_purged" }, select: { metadata: true } }));
    expect(audit?.metadata).toEqual({ patients: 1, appointments: 1, encounters: 1, invoices: 1 });

    // Clinical guards are back on: a signed note in the other clinic still cannot be deleted, even by the table owner path.
    await expect(withAppContext({ tenantId: b.ctx.tenant.id }, (tx) => tx.clinicalNote.deleteMany({ where: { tenantId: b.ctx.tenant.id } }))).rejects.toThrow();
    const guards = await withAppContext({}, (tx) =>
      tx.$queryRaw<{ tgname: string; tgenabled: string }[]>`SELECT tgname::text AS tgname, tgenabled::text AS tgenabled FROM pg_trigger WHERE tgname IN ('clinical_note_guard','invoice_guard','invoice_line_guard','lab_order_guard','lab_result_guard','prescription_guard','dental_chart_no_change','stock_movement_no_change')`,
    );
    expect(guards).toHaveLength(8);
    expect(guards.every((g) => g.tgenabled === "O")).toBe(true);

    // The clinic works again from a clean start: queue number 1 for the next patient.
    const again = await fullVisit(a);
    const appt = await withAppContext({ tenantId: a.ctx.tenant.id }, (tx) => tx.appointment.findFirstOrThrow({ where: { patientId: again.patientId }, select: { queueNumber: true } }));
    expect(appt.queueNumber).toBe(1);
    // Running it twice is harmless.
    await purgeTestPatients(a.ctx, { confirm: a.slug }, META);
    expect(await purgeTestPatients(a.ctx, { confirm: a.slug }, META)).toEqual({ patients: 0, appointments: 0, encounters: 0, invoices: 0 });
  });
});
