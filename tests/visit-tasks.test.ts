import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createClinicFromSpec } from "../scripts/lib/create-clinic";
import { addStaffMember } from "@/server/clinic/admin";
import { listOperationalBranches } from "@/server/clinic/context";
import { listDoctors } from "@/server/clinic/doctors";
import { listServices } from "@/server/clinic/resources";
import { addDiagnosticResult } from "@/server/emr/diagnostics";
import { searchMedicines } from "@/server/emr/medicines";
import { startVisit } from "@/server/emr/record";
import { doctorQueueTasks, taskPath } from "@/server/emr/visit-tasks";
import { deskCheckIn } from "@/server/reception/desk";
import { withAppContext } from "@/server/db";
import { META, PASSWORD, clinicContext, platformActor, uniq } from "./helpers/fixtures";

describe("doctor's queue: one button per paid service, the study's own form", () => {
  it("Farhod MedServis: forms bound to services, starter medicines; EhoKG opens the echo form and is ticked when done", async () => {
    await platformActor();
    const slug = uniq("farhodq").toLowerCase();
    const spec = JSON.parse(fs.readFileSync("scripts/deploy/clinics/farhod-medservis.json", "utf8"));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "itm-spec-")), "spec.json");
    fs.writeFileSync(file, JSON.stringify({ ...spec, name: "Synthetic Farhod", slug }));
    fs.copyFileSync(path.join("scripts/deploy/clinics", spec.logoFile), path.join(path.dirname(file), spec.logoFile));
    const owner = uniq("owner");
    const r = await createClinicFromSpec(file, owner, "Synthetic Owner Doctor", PASSWORD);
    expect(r.extras.templatesBound).toBe(10);
    expect(r.extras.medicinesAdded).toBe(spec.medicines.length);
    const doc = await clinicContext(owner, slug);

    // "bis" finds Bisoprolol (and Konkor, also bisoprolol) in the starter catalog.
    const bis = await searchMedicines(doc, "bis");
    expect(bis.map((m) => m.name)).toEqual(expect.arrayContaining(["Bisoprolol", "Konkor"]));

    const desk = uniq("desk");
    await addStaffMember(doc, { fullName: "Synthetic Desk", username: desk, password: PASSWORD, roleKeys: ["receptionist", "cashier"] }, META);
    const d = await clinicContext(desk, slug);
    const [branch] = await listOperationalBranches(d);
    const doctorProfileId = (await listDoctors(d)).find((x) => x.profile)!.profile!.id;
    const services = await listServices(d);
    const sid = (n: string) => services.find((s) => s.name === n)!.id;
    const visit = await deskCheckIn(d, { lastName: "Sintetik", firstName: "Exo", birthDate: "1970", sex: "MALE", doctorProfileId, branchId: branch!.id, serviceIds: [sid("Kardiolog ko'ruvi"), sid("EhoKG (transtorakal)"), sid("Umumiy qorin bo'shlig'i a'zolari UTT")], payMode: "full" }, META);
    if (!visit.ok) throw new Error("duplicate");

    const row = { appointmentId: visit.appointmentId, patientId: visit.patientId, sex: "MALE", serviceId: sid("Kardiolog ko'ruvi"), status: "CHECKED_IN" };
    const tasks = (await doctorQueueTasks(doc, [row])).get(visit.appointmentId)!;
    const echo = tasks.find((t) => t.name === "EhoKG (transtorakal)")!;
    const abdomen = tasks.find((t) => t.name === "Umumiy qorin bo'shlig'i a'zolari UTT")!;
    expect(tasks.find((t) => t.target === "visit")?.name).toBe("Kardiolog ko'ruvi");
    const templates = await withAppContext({ tenantId: doc.tenant.id, userId: doc.principal.user.id }, (tx) => tx.clinicTemplate.findMany({ where: { kind: "DIAGNOSTIC" }, select: { id: true, name: true } }));
    const idOf = (n: string) => templates.find((t) => t.name === n)!.id;
    expect(echo.target).toBe(`template:${idOf("Transtorakal exokardiografiya")}`);
    // A man gets the men's abdominal form.
    expect(abdomen.target).toBe(`template:${idOf("UTT: qorin bo'shlig'i umumiy (erkaklar)")}`);
    expect(echo.done).toBe(false);

    const enc = await startVisit(doc, visit.appointmentId, META);
    expect(taskPath(slug, enc, echo.target)).toBe(`/c/${slug}/encounters/${enc}/study?template=${idOf("Transtorakal exokardiografiya")}`);
    expect(taskPath(slug, enc, "visit")).toBe(`/c/${slug}/encounters/${enc}`);
    expect(taskPath(slug, enc, "javascript:alert(1)")).toBe(`/c/${slug}/encounters/${enc}`);
    await addDiagnosticResult(doc, visit.patientId, { templateId: idOf("Transtorakal exokardiografiya"), kind: "ECHO", title: "Transtorakal exokardiografiya", conclusion: "Sintetik xulosa.", encounterId: enc }, META);
    const after = (await doctorQueueTasks(doc, [row])).get(visit.appointmentId)!;
    expect(after.find((t) => t.name === "EhoKG (transtorakal)")!.done).toBe(true);
    expect(after.find((t) => t.name === "Umumiy qorin bo'shlig'i a'zolari UTT")!.done).toBe(false);
  });
});
