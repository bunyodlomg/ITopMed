import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runClinicAdmin } from "../scripts/lib/clinic-admin";
import { createClinicFromSpec } from "../scripts/lib/create-clinic";
import { addStaffMember, listBranches, listStaff } from "@/server/clinic/admin";
import { listDoctors } from "@/server/clinic/doctors";
import { listServices } from "@/server/clinic/resources";
import { addExtraServices, deskCheckIn } from "@/server/reception/desk";
import { loginClinicUser, resolveClinic, validateClinicSession } from "@/server/auth/clinic-auth";
import { platformDb, withAppContext } from "@/server/db";
import { META, PASSWORD, clinicContext, platformActor, uniq } from "./helpers/fixtures";

describe("server task: the owner's administration (go-live of a three-person clinic)", () => {
  it("roles, the owner's own roles, staff out and in, test patients removed — audited, through the app's rules", async () => {
    await platformActor();
    const slug = uniq("farhodadm").toLowerCase();
    const spec = JSON.parse(fs.readFileSync("scripts/deploy/clinics/farhod-medservis.json", "utf8"));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "itm-spec-")), "spec.json");
    fs.writeFileSync(file, JSON.stringify({ ...spec, name: "Synthetic Farhod", slug }));
    fs.copyFileSync(path.join("scripts/deploy/clinics", spec.logoFile), path.join(path.dirname(file), spec.logoFile));
    const owner = uniq("owner");
    await createClinicFromSpec(file, owner, "Synthetic Owner Doctor", PASSWORD);
    const octx = await clinicContext(owner, slug);
    const oldDesk = uniq("old");
    await addStaffMember(octx, { fullName: "Synthetic Old Desk", username: oldDesk, password: PASSWORD, roleKeys: ["receptionist", "cashier"] }, META);
    const [branch] = await listBranches(octx);
    const doctorProfileId = (await listDoctors(octx)).find((d) => d.profile)!.profile!.id;
    const services = await listServices(octx);
    const r = await deskCheckIn(octx, { lastName: "Sintetik", firstName: "Sinov", birthDate: "1970", sex: "MALE", doctorProfileId, branchId: branch!.id, serviceIds: [services[0]!.id], payMode: "debt" }, META);
    expect(r.ok).toBe(true);

    const qabul = uniq("qabul");
    const kassa = uniq("kassa");
    const out = await runClinicAdmin(slug, [
      { op: "role-permissions", role: "receptionist", add: ["billing.charge", "vitals.write"] },
      { op: "owner-roles", remove: ["cashier"] },
      { op: "remove-member", login: oldDesk },
      { op: "add-staff", fullName: "Synthetic Qabulxona", login: qabul, roleKeys: ["receptionist"] },
      { op: "add-staff", fullName: "Synthetic Kassa", login: kassa, roleKeys: ["cashier"] },
      { op: "purge-patients" },
    ]);
    expect(out.map((o) => o.op)).toEqual(["role-permissions", "owner-roles", "remove-member", "add-staff", "add-staff", "purge-patients"]);
    expect(out[5]!.detail).toContain("patients 1");

    // New staff sign in with the printed first passwords.
    const qPass = out[3]!.password!;
    const kPass = out[4]!.password!;
    expect((await loginClinicUser(qabul, qPass, META)).ok).toBe(true);
    expect((await loginClinicUser(kassa, kPass, META)).ok).toBe(true);
    expect((await loginClinicUser(oldDesk, PASSWORD, META)).ok).toBe(true); // the account exists, but not in this clinic any more
    const staffNow = (await listStaff(octx)).members;
    expect(staffNow.find((m) => m.user.username === oldDesk)?.status).toBe("REMOVED");

    // The owner: doctor + admin, no till — an extra service from the visit goes to the cashier unpaid.
    const after = await clinicContext(owner, slug);
    expect(after.roleKeys).toEqual(expect.arrayContaining(["clinic_owner", "doctor", "head_doctor"]));
    expect(after.roleKeys).not.toContain("cashier");
    expect(after.permissions.has("billing.payment")).toBe(false);
    const ql = await loginClinicUser(qabul, qPass, META);
    if (!ql.ok) throw new Error("qabul login");
    const q = (await resolveClinic((await validateClinicSession(ql.token))!, slug))!;
    expect([q.permissions.has("billing.charge"), q.permissions.has("vitals.write"), q.permissions.has("emr.read")]).toEqual([true, true, false]);
    const r2 = await deskCheckIn(q, { lastName: "Sintetik", firstName: "Ikki", birthDate: "1980", sex: "FEMALE", doctorProfileId, branchId: branch!.id, serviceIds: [services[0]!.id], SYSTOLIC_BP: "130" }, META);
    if (!r2.ok) throw new Error("duplicate");
    expect(r2.vitalsSaved).toBe(true);
    const inv = await addExtraServices(after, { patientId: r2.patientId, branchId: branch!.id, serviceIds: [services[1]!.id], payMode: "full", method: "CASH" }, META);
    const paid = await withAppContext({ tenantId: after.tenant.id, userId: after.principal.user.id }, (tx) => tx.invoice.findUniqueOrThrow({ where: { id: inv }, select: { paidMinor: true, status: true } }));
    expect(paid).toEqual({ paidMinor: 0n, status: "ISSUED" });

    // Queue numbers start again at 1 after the purge (the first patient today is now #1).
    expect(r2.queueNumber).toBe(1);
    const audit = await platformDb().$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "AuditEvent" WHERE "tenantId" = ${after.tenant.id}::uuid AND action = 'clinic.server_task'`;
    expect(Number(audit[0]!.n)).toBe(1);
    // Unknown permissions or roles are refused before anything runs.
    await expect(runClinicAdmin(slug, [{ op: "role-permissions", role: "receptionist", add: ["everything"] }])).rejects.toThrow();
  });
});
