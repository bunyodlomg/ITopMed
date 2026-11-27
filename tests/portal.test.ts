import pg from "pg";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { registerWalkIn } from "@/server/appointments/appointments";
import { addInvoiceLine, createInvoice, issueInvoice } from "@/server/billing/billing";
import { addStaffMember, listBranches, listStaff } from "@/server/clinic/admin";
import { saveDoctorProfile } from "@/server/clinic/doctors";
import { createService } from "@/server/clinic/resources";
import { startVisit } from "@/server/emr/record";
import { addAnalyte, collectSpecimen, createLabOrder, enterResults, getLabOrder, releaseLabOrder, verifyResults } from "@/server/lab/lab";
import { registerPatient, withdrawConsent } from "@/server/patients/patients";
import { activatePortalAccount, changePatientPassword, loginPatient, portalTenant, validatePatientSession } from "@/server/portal/auth";
import { cancelMyAppointment, getMyResult, grantMyConsent, listMyAppointments, listMyConsents, listMyInvoices, listMyResults, withdrawMyConsent } from "@/server/portal/data";
import { disablePortalAccount, getPortalAccount, issuePortalCode } from "@/server/portal/staff";
import { sha256Hex } from "@/server/security/crypto";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

const PATIENT_PW = "Bemor-Parol-2026x";
const owner = () => new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });

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
  const nurse = await staff(a, ["nurse"]);
  const lab1 = await staff(a, ["lab_staff"]);
  const lab2 = await staff(a, ["lab_staff"]);
  const cashier = await staff(a, ["cashier"]);
  const profileId = await saveDoctorProfile(a.ctx, doctor.membershipId, { specialty: "therapy", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
  const cbc = await createService(a.ctx, { code: `PL${++n}`, name: "Synthetic blood test", kind: "LAB_TEST", durationMinutes: 10, price: "50000", currency: "UZS" }, META);
  const hb = await addAnalyte(lab1.ctx, cbc, { name: "Hemoglobin", unit: "g/L", refLow: "120", refHigh: "160" }, META);
  const doctorCtx = await clinicContext(doctor.login, a.slug);
  const tenant = (await portalTenant(a.slug))!;

  const patient = async (first: string, birthDate: string) => {
    const p = await registerPatient(reception.ctx, { lastName: "Sintetik", firstName: `${first}${n}`, birthDate, sex: "FEMALE" }, { confirmNotDuplicate: true }, META);
    if (!p.ok) throw new Error("patient");
    return p.id;
  };
  /** A visit with a verified lab order; returns the order id. */
  const verifiedLab = async (patientId: string) => {
    const appt = await registerWalkIn(reception.ctx, { patientId, doctorProfileId: profileId, branchId: branch!.id }, META);
    const encounterId = await startVisit(doctorCtx, appt, META);
    const { id } = await createLabOrder(doctorCtx, encounterId, { serviceIds: [cbc] }, META);
    await collectSpecimen(nurse.ctx, id, META);
    const item = (await getLabOrder(lab1.ctx, id, META)).items[0]!;
    await enterResults(lab1.ctx, id, { [`${item.id}:${hb}`]: "101" }, META);
    await verifyResults(lab2.ctx, id, META);
    return { orderId: id, encounterId };
  };
  /** Code → activation → signed-in patient. */
  const portalPatient = async (patientId: string, birthDate: string, phone: string) => {
    const { code } = await issuePortalCode(reception.ctx, patientId, { consentMethod: "PAPER_SIGNED" }, META);
    await activatePortalAccount(tenant, { code, birthDate, phone, password: PATIENT_PW, confirmPassword: PATIENT_PW }, META);
    const login = await loginPatient(tenant, phone, PATIENT_PW, META);
    if (!login.ok) throw new Error(`portal login: ${login.reason}`);
    return { token: login.token, p: (await validatePatientSession(login.token))! };
  };
  /** Direct appointment insert (as schema owner) at a given offset from now. */
  const bookAt = async (patientId: string, offsetMs: number) => {
    const c = owner();
    await c.connect();
    const id = randomUUID();
    const start = new Date(Date.now() + offsetMs);
    await c.query(
      `INSERT INTO "Appointment" (id, "tenantId", "patientId", "doctorProfileId", "branchId", "startsAt", "endsAt", status, source, "createdById", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'BOOKED', 'FRONT_DESK', $8, now())`,
      // ISO strings: node-pg would otherwise send local time into the UTC timestamp columns.
      [id, a.tenantId, patientId, profileId, branch!.id, start.toISOString(), new Date(start.getTime() + 20 * 60_000).toISOString(), reception.ctx.principal.user.id],
    );
    await c.end();
    return id;
  };
  return { a, branch: branch!, reception, doctorCtx, nurse, lab1, cashier, tenant, patient, verifiedLab, portalPatient, bookAt };
}

describe("patient portal: activation and sign-in", () => {
  it("code + birth date activate the account; the patient chooses phone and password", async () => {
    const s = await setup();
    const pid = await s.patient("Portal", "1991-03-04");
    await expect(issuePortalCode(s.reception.ctx, pid, {}, META)).rejects.toThrow("errors.portalConsentRequired");
    await expect(issuePortalCode(s.doctorCtx, pid, { consentMethod: "PAPER_SIGNED" }, META)).rejects.toThrow("errors.forbidden");
    const { code } = await issuePortalCode(s.reception.ctx, pid, { consentMethod: "PAPER_SIGNED" }, META);
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    expect((await getPortalAccount(s.reception.ctx, pid))!.account!.status).toBe("INVITED");

    const form = { code: code.toLowerCase().replace(/-/g, " "), birthDate: "1991-03-04", phone: "90 123 45 67", password: PATIENT_PW, confirmPassword: PATIENT_PW };
    const other = await setup(); // a code never works at another clinic
    await expect(activatePortalAccount(other.tenant, form, META)).rejects.toThrow("errors.portalCodeInvalid");
    await expect(activatePortalAccount(s.tenant, { ...form, birthDate: "1991-03-05" }, META)).rejects.toThrow("errors.portalCodeInvalid");
    await expect(activatePortalAccount(s.tenant, { ...form, password: "short" }, META)).rejects.toThrow();
    await activatePortalAccount(s.tenant, form, META); // case, spaces and dashes in the code do not matter
    await expect(activatePortalAccount(s.tenant, form, META)).rejects.toThrow("errors.portalCodeInvalid"); // single use

    const acc = (await getPortalAccount(s.reception.ctx, pid))!.account!;
    expect(acc.status).toBe("ACTIVE");
    expect(acc.login).toBe("+998901234567");

    expect(await loginPatient(s.tenant, "+998901234567", "Wrong-Password-1", META)).toEqual({ ok: false, reason: "invalid" });
    expect(await loginPatient(other.tenant, "+998901234567", PATIENT_PW, META)).toEqual({ ok: false, reason: "invalid" });
    const ok = await loginPatient(s.tenant, "901234567", PATIENT_PW, META);
    expect(ok.ok).toBe(true);
    const p = (await validatePatientSession(ok.ok ? ok.token : ""))!;
    expect(p.patientId).toBe(pid);
    expect(p.patient.firstName).toMatch(/^Portal/);
    expect(await validatePatientSession("not-a-token")).toBeNull();

    // A second patient cannot take the same login phone in this clinic.
    const pid2 = await s.patient("Second", "1980-01-01");
    const second = await issuePortalCode(s.reception.ctx, pid2, { consentMethod: "VERBAL_RECORDED" }, META);
    await expect(activatePortalAccount(s.tenant, { ...form, code: second.code, birthDate: "1980-01-01" }, META)).rejects.toThrow("errors.portalLoginTaken");
  });

  it("lockout, wrong-birth-date code burning, password change, reissue and disabling", async () => {
    const s = await setup();
    const pid = await s.patient("Lock", "1975-05-05");
    const { code } = await issuePortalCode(s.reception.ctx, pid, { consentMethod: "PAPER_SIGNED" }, META);
    for (let i = 0; i < 5; i++) {
      await expect(activatePortalAccount(s.tenant, { code, birthDate: "2000-01-01", phone: "+998911111111", password: PATIENT_PW, confirmPassword: PATIENT_PW }, META)).rejects.toThrow("errors.portalCodeInvalid");
    }
    // The code is burnt after 5 wrong birth dates, even with the right answer now.
    await expect(activatePortalAccount(s.tenant, { code, birthDate: "1975-05-05", phone: "+998911111111", password: PATIENT_PW, confirmPassword: PATIENT_PW }, META)).rejects.toThrow("errors.portalCodeInvalid");

    const { token, p } = await s.portalPatient(pid, "1975-05-05", "+998911111111");
    const second = await loginPatient(s.tenant, "+998911111111", PATIENT_PW, META);
    if (!second.ok) throw new Error("second login");
    await expect(changePatientPassword(p, { currentPassword: "nope", password: "Yangi-Parol-2026z", confirmPassword: "Yangi-Parol-2026z" }, META)).rejects.toThrow("errors.currentPasswordWrong");
    await changePatientPassword(p, { currentPassword: PATIENT_PW, password: "Yangi-Parol-2026z", confirmPassword: "Yangi-Parol-2026z" }, META);
    expect(await validatePatientSession(token)).not.toBeNull(); // this device stays signed in
    expect(await validatePatientSession(second.token)).toBeNull(); // others are signed out
    expect((await loginPatient(s.tenant, "+998911111111", PATIENT_PW, META)).ok).toBe(false);

    for (let i = 0; i < 5; i++) await loginPatient(s.tenant, "+998911111111", "Wrong-Password-1", META);
    expect(await loginPatient(s.tenant, "+998911111111", "Yangi-Parol-2026z", META)).toEqual({ ok: false, reason: "locked" });

    // Reissuing (forgotten password, lost phone) resets the account and ends all sessions.
    const re = await issuePortalCode(s.reception.ctx, pid, {}, META); // consent already on file
    expect(await validatePatientSession(token)).toBeNull();
    await activatePortalAccount(s.tenant, { code: re.code, birthDate: "1975-05-05", phone: "+998911111112", password: PATIENT_PW, confirmPassword: PATIENT_PW }, META);
    const again = await loginPatient(s.tenant, "+998911111112", PATIENT_PW, META);
    expect(again.ok).toBe(true);

    await disablePortalAccount(s.reception.ctx, pid, META);
    expect(await validatePatientSession(again.ok ? again.token : "")).toBeNull();
    expect((await loginPatient(s.tenant, "+998911111112", PATIENT_PW, META)).ok).toBe(false);
  });
});

describe("patient portal: consent", () => {
  it("withdrawing portal consent at the front desk closes portal access at once", async () => {
    const s = await setup();
    const pid = await s.patient("Consent", "1960-06-06");
    const { token, p } = await s.portalPatient(pid, "1960-06-06", "+998946666666");
    const portalConsent = (await listMyConsents(p)).find((c) => c.purpose === "PATIENT_PORTAL")!;
    await withdrawConsent(s.reception.ctx, portalConsent.id, META);
    expect(await validatePatientSession(token)).toBeNull();
    expect((await getPortalAccount(s.reception.ctx, pid))!.account!.status).toBe("DISABLED");
    await expect(issuePortalCode(s.reception.ctx, pid, {}, META)).rejects.toThrow("errors.portalConsentRequired");
  });
});

describe("patient portal: what the patient sees and may do", () => {
  it("released lab results only, issued invoices only, own appointments with a 2-hour cancel cut-off, consents", async () => {
    const s = await setup();
    const pid = await s.patient("Data", "1988-08-08");
    const { orderId } = await s.verifiedLab(pid);
    const { p } = await s.portalPatient(pid, "1988-08-08", "+998935555555");

    // Verified but not released → invisible to the patient.
    expect(await listMyResults(p)).toEqual([]);
    expect(await getMyResult(p, orderId, META)).toBeNull();
    await expect(releaseLabOrder(s.lab1.ctx, orderId, META)).rejects.toThrow("errors.forbidden"); // lab staff cannot release
    await releaseLabOrder(s.doctorCtx, orderId, META);
    await releaseLabOrder(s.doctorCtx, orderId, META); // idempotent
    const results = await listMyResults(p);
    expect(results).toHaveLength(1);
    expect(results[0]!.items[0]!.results.map((r) => [r.analyte.name, r.value.toString(), r.flag])).toEqual([["Hemoglobin", "101", "LOW"]]);
    expect(results[0]!.doctor?.fullName).toBe("Synthetic doctor");
    expect((await getMyResult(p, orderId, META))!.number).toMatch(/^LAB-/);

    // Release is the only change the database allows on a verified order, and only once.
    const c = owner();
    await c.connect();
    await expect(c.query(`UPDATE "LabOrder" SET "releasedAt" = NULL WHERE id = $1`, [orderId])).rejects.toThrow(/final/);
    await c.end();

    // The ordered blood test went on the patient's bill (ordered = owed).
    expect((await listMyInvoices(p)).map((i) => [i.status, i.totalMinor, i.lines[0]!.description])).toEqual([["ISSUED", 5_000_000n, "Synthetic blood test"]]);
    // Draft invoices are invisible; issued ones are shown with their lines.
    const draft = await createInvoice(s.cashier.ctx, { patientId: pid, branchId: s.branch.id }, META);
    expect(await listMyInvoices(p)).toHaveLength(1);
    const svc = await createService(s.a.ctx, { code: `PX${n}`, name: "Synthetic service", kind: "OTHER", durationMinutes: 10, price: "70000", currency: "UZS" }, META);
    await addInvoiceLine(s.cashier.ctx, draft, { serviceId: svc, quantity: 1 }, META);
    await issueInvoice(s.cashier.ctx, draft, META);
    const invoices = (await listMyInvoices(p)).filter((i) => i.id === draft);
    expect(invoices.map((i) => [i.status, i.totalMinor, i.lines.length])).toEqual([["ISSUED", 7_000_000n, 1]]);

    // Appointments: cancel allowed only for own BOOKED visits more than 2 hours ahead.
    const far = await s.bookAt(pid, 2 * 24 * 60 * 60_000);
    const near = await s.bookAt(pid, 60 * 60_000);
    const appts = await listMyAppointments(p);
    expect(appts.upcoming.find((x) => x.id === far)!.canCancel).toBe(true);
    expect(appts.upcoming.find((x) => x.id === near)!.canCancel).toBe(false);
    await expect(cancelMyAppointment(p, near, META)).rejects.toThrow("errors.portalCannotCancel"); // the database refuses, not just the UI
    await cancelMyAppointment(p, far, META);
    await expect(cancelMyAppointment(p, far, META)).rejects.toThrow("errors.portalCannotCancel");

    // Consents: portal consent recorded by the front desk; others self-service.
    let consents = await listMyConsents(p);
    expect(consents.map((x) => [x.purpose, x.method])).toEqual([["PATIENT_PORTAL", "PAPER_SIGNED"]]);
    await expect(withdrawMyConsent(p, consents[0]!.id, META)).rejects.toThrow("errors.notFound"); // portal access is closed by the clinic
    await expect(grantMyConsent(p, "PATIENT_PORTAL", META)).rejects.toThrow("errors.invalidInput");
    await grantMyConsent(p, "SMS_REMINDERS", META);
    await grantMyConsent(p, "SMS_REMINDERS", META); // no duplicate
    consents = await listMyConsents(p);
    const sms = consents.filter((x) => x.purpose === "SMS_REMINDERS");
    expect(sms.map((x) => x.method)).toEqual(["PORTAL"]);
    await withdrawMyConsent(p, sms[0]!.id, META);
    expect((await listMyConsents(p)).find((x) => x.id === sms[0]!.id)!.withdrawnAt).not.toBeNull();
  });

  it("one patient can never see or change another patient's data", async () => {
    const s = await setup();
    const a = await s.patient("Alpha", "1970-01-01");
    const b = await s.patient("Beta", "1971-01-01");
    const bLab = await s.verifiedLab(b);
    await releaseLabOrder(s.doctorCtx, bLab.orderId, META);
    const bAppt = await s.bookAt(b, 3 * 24 * 60 * 60_000);
    const pa = (await s.portalPatient(a, "1970-01-01", "+998977777771")).p;

    expect(await listMyResults(pa)).toEqual([]);
    expect(await getMyResult(pa, bLab.orderId, META)).toBeNull();
    expect((await listMyAppointments(pa)).upcoming).toEqual([]);
    await expect(cancelMyAppointment(pa, bAppt, META)).rejects.toThrow("errors.portalCannotCancel");

    // Another clinic's patient with the same phone and password is a different account.
    const other = await setup();
    const c = await other.patient("Gamma", "1970-01-01");
    const pc = (await other.portalPatient(c, "1970-01-01", "+998977777771")).p;
    expect(pc.tenant.id).not.toBe(pa.tenant.id);
    expect(await listMyResults(pc)).toEqual([]);
  });
});

describe("patient portal: database role", () => {
  it("the portal role sees nothing without a valid session and has no access to clinical or staff tables", async () => {
    const s = await setup();
    const pid = await s.patient("Db", "1999-09-09");
    const lab = await s.verifiedLab(pid);
    const { token } = await s.portalPatient(pid, "1999-09-09", "+998998888888");
    const portal = new pg.Client({ connectionString: process.env.PORTAL_DATABASE_URL });
    await portal.connect();
    try {
      for (const t of ["Patient", "Appointment", "Invoice", "LabOrder", "PatientAccount", "PatientSession", "PatientConsent", "Branch"]) {
        const r = await portal.query(`SELECT count(*)::int AS n FROM "${t}"`);
        expect([t, r.rows[0].n]).toEqual([t, 0]);
      }
      for (const t of ["ClinicalNote", "ClinicalNoteAmendment", "Diagnosis", "Allergy", "VitalSign", "Encounter", "User", "Session", "Membership", "AuditEvent", "PatientIdentifier", "CashShift", "Refund", "Role"]) {
        await expect(portal.query(`SELECT 1 FROM "${t}" LIMIT 1`)).rejects.toThrow(/permission denied/);
      }
      // Columns staff wrote for internal use are not granted either.
      await expect(portal.query(`SELECT indication FROM "LabOrder"`)).rejects.toThrow(/permission denied/);
      await expect(portal.query(`SELECT "adminNote" FROM "Appointment"`)).rejects.toThrow(/permission denied/);
      await expect(portal.query(`SELECT "externalRef" FROM "Payment"`)).rejects.toThrow(/permission denied/);

      // With the patient's own session the role sees exactly that patient — and still no unreleased results.
      await portal.query("BEGIN");
      await portal.query(`SELECT set_config('app.session_id', $1, true)`, [sha256Hex(token)]);
      expect((await portal.query(`SELECT id FROM "Patient"`)).rows.map((r) => r.id)).toEqual([pid]);
      expect((await portal.query(`SELECT count(*)::int AS n FROM "LabOrder"`)).rows[0].n).toBe(0);
      await expect(portal.query(`UPDATE "Patient" SET "firstName" = 'x'`)).rejects.toThrow(/permission denied/);
      await portal.query("ROLLBACK");
      await releaseLabOrder(s.doctorCtx, lab.orderId, META);
      await portal.query("BEGIN");
      await portal.query(`SELECT set_config('app.session_id', $1, true)`, [sha256Hex(token)]);
      expect((await portal.query(`SELECT count(*)::int AS n FROM "LabOrder"`)).rows[0].n).toBe(1);
      // A forged tenant/user context does not help: identity comes from the session only.
      await portal.query(`SELECT set_config('app.session_id', 'forged', true), set_config('app.tenant_id', $1, true)`, [s.a.tenantId]);
      expect((await portal.query(`SELECT count(*)::int AS n FROM "Patient"`)).rows[0].n).toBe(0);
      await portal.query("ROLLBACK");
    } finally {
      await portal.end();
    }

    // Staff cannot read patients' password hashes; the platform role has no portal access at all.
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
    const platform = new pg.Client({ connectionString: process.env.PLATFORM_DATABASE_URL });
    await Promise.all([app.connect(), platform.connect()]);
    await expect(app.query(`SELECT "passwordHash" FROM "PatientAccount"`)).rejects.toThrow(/permission denied/);
    await expect(app.query(`SELECT "activationCodeHash" FROM "PatientAccount"`)).rejects.toThrow(/permission denied/);
    for (const t of ["PatientAccount", "PatientSession"]) await expect(platform.query(`SELECT 1 FROM "${t}"`)).rejects.toThrow(/permission denied/);
    await Promise.all([app.end(), platform.end()]);
    expect(s.reception.ctx.permissions.has("portal.manage")).toBe(true);
  });
});
