import { describe, expect, it } from "vitest";
import { registerWalkIn } from "@/server/appointments/appointments";
import { addStaffMember, listBranches, listStaff } from "@/server/clinic/admin";
import { saveDoctorProfile } from "@/server/clinic/doctors";
import { createService } from "@/server/clinic/resources";
import { cancelLabOrder, createLabOrder } from "@/server/lab/lab";
import { addStandardTemplates, archiveTemplate, listTemplates, parseNoteContent, renderDocument, saveTemplate } from "@/server/clinic/templates";
import { platformDb } from "@/server/db";
import { applyNoteTemplate, documentForVisit } from "@/server/emr/documents";
import { addDiagnosis, getEncounter, saveDraft, startVisit } from "@/server/emr/record";
import { registerPatient } from "@/server/patients/patients";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

async function staff(o: Awaited<ReturnType<typeof clinicWithOwner>>, roleKeys: string[]) {
  const login = uniq("s");
  await addStaffMember(o.ctx, { fullName: `Synthetic ${roleKeys[0]}`, username: login, roleKeys, password: PASSWORD }, META);
  const m = (await listStaff(o.ctx)).members.find((x) => x.user.username === login)!;
  return { login, membershipId: m.id, ctx: await clinicContext(login, o.slug) };
}

describe("clinic templates", () => {
  it("ready-made templates in the clinic language, own templates, permissions, removal", async () => {
    const a = await clinicWithOwner(await platformActor());
    expect(await addStandardTemplates(a.ctx, META)).toBe(6);
    expect(await addStandardTemplates(a.ctx, META)).toBe(0); // idempotent by name
    const all = await listTemplates(a.ctx);
    const summary = all.find((x) => x.name === "Qabul xulosasi")!; // clinic language uz-Latn
    expect(summary.kind).toBe("DOCUMENT");
    expect(summary.content).toContain("{{patient.fullName}}"); // [[…]] in the catalog became {{…}}
    expect(summary.content).toContain("{{labs}}"); // lab tests still to take, printed highlighted
    expect(all.find((x) => x.kind === "NOTE" && x.specialty === "cardiology")).toBeTruthy();

    const doctor = await staff(a, ["doctor"]);
    await expect(saveTemplate(doctor.ctx, null, { kind: "DOCUMENT", name: "Mine", body: "x" }, META)).rejects.toThrow("errors.forbidden");
    expect((await listTemplates(doctor.ctx)).length).toBe(6); // doctors can use them

    const id = await saveTemplate(a.ctx, null, { kind: "DOCUMENT", name: "Synthetic certificate", body: "Hello {{patient.fullName}}" }, META);
    await expect(saveTemplate(a.ctx, null, { kind: "DOCUMENT", name: "Empty", body: "   " }, META)).rejects.toThrow();
    await expect(saveTemplate(a.ctx, null, { kind: "NOTE", name: "Empty note", note: { complaints: "", history: "", examination: "", assessment: "", plan: "" } }, META)).rejects.toThrow();
    await archiveTemplate(a.ctx, id, META);
    expect((await listTemplates(a.ctx)).some((x) => x.id === id)).toBe(false);
    await expect(platformDb().$queryRawUnsafe(`SELECT count(*) FROM "ClinicTemplate"`)).rejects.toThrow(/permission denied/);
  });

  it("placeholders are filled; unknown ones stay visible", () => {
    expect(renderDocument("{{patient.fullName}} · {{ today }} · {{nope}}", { "patient.fullName": "Sintetik Bemor", today: "14.11.2026" })).toBe("Sintetik Bemor · 14.11.2026 · {{nope}}");
    // A line whose placeholders are all empty disappears; other lines stay.
    expect(renderDocument("Tashxis: {{diagnoses.primary}}\nAsorati: {{diagnoses.complications}}\nTavsiya:", { "diagnoses.primary": "I10" })).toBe("Tashxis: I10\nTavsiya:");
    // Lab tests to take keep their "!! " marker line by line (the printed text highlights them).
    expect(renderDocument("Tahlillar:\n{{labs}}", { labs: "!! Qon tahlili\n!! Lipid spektri" })).toBe("Tahlillar:\n!! Qon tahlili\n!! Lipid spektri");
    expect(parseNoteContent("not json")).toEqual({ complaints: "", history: "", examination: "", assessment: "", plan: "" });
  });

  it("note template fills only empty sections of the doctor's draft; document prints with visit data, only for the treating doctor", async () => {
    const a = await clinicWithOwner(await platformActor());
    const [branch] = await listBranches(a.ctx);
    const reception = await staff(a, ["receptionist"]);
    const doctor = await staff(a, ["doctor"]);
    const profileId = await saveDoctorProfile(a.ctx, doctor.membershipId, { specialty: "cardiology", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
    const p = await registerPatient(reception.ctx, { lastName: "Sintetik", firstName: "Shablon", birthDate: "1977-07-07", sex: "MALE" }, { confirmNotDuplicate: true }, META);
    if (!p.ok) throw new Error("patient");
    const noteT = await saveTemplate(a.ctx, null, { kind: "NOTE", name: "Synthetic note", note: { complaints: "From template", history: "", examination: "Exam from template", assessment: "", plan: "" } }, META);
    const docT = await saveTemplate(a.ctx, null, { kind: "DOCUMENT", name: "Synthetic summary", body: "{{patient.fullName}}\n{{diagnoses}}\n{{note.examination}}" }, META);

    const doctorCtx = await clinicContext(doctor.login, a.slug);
    const appt = await registerWalkIn(reception.ctx, { patientId: p.id, doctorProfileId: profileId, branchId: branch!.id }, META);
    const enc = await startVisit(doctorCtx, appt, META);
    const noteId = (await getEncounter(doctorCtx, enc, META)).encounter.notes[0]!.id;
    await saveDraft(doctorCtx, noteId, { complaints: "Doctor wrote this", history: "", examination: "", assessment: "", plan: "" }, META);
    await applyNoteTemplate(doctorCtx, enc, noteT, META);
    const note = (await getEncounter(doctorCtx, enc, META)).encounter.notes[0]!;
    expect(note.complaints).toBe("Doctor wrote this"); // not overwritten
    expect(note.examination).toBe("Exam from template");
    await expect(applyNoteTemplate(doctorCtx, enc, docT, META)).rejects.toThrow("errors.notFound"); // wrong kind

    await addDiagnosis(doctorCtx, enc, { icd10Code: "I10", description: "Essential hypertension (synthetic)", kind: "PRIMARY" }, META);
    // Lab tests ordered in this visit and not yet taken are listed for the paper; cancelled ones are not.
    const cbc = await createService(a.ctx, { code: "TCBC", name: "Synthetic blood count", kind: "LAB_TEST", durationMinutes: 10, price: "1000", currency: "UZS" }, META);
    const lipids = await createService(a.ctx, { code: "TLIP", name: "Synthetic lipid panel", kind: "LAB_TEST", durationMinutes: 10, price: "1000", currency: "UZS" }, META);
    await createLabOrder(doctorCtx, enc, { serviceIds: [cbc] }, META);
    await cancelLabOrder(doctorCtx, (await createLabOrder(doctorCtx, enc, { serviceIds: [lipids] }, META)).id, META);
    const d = await documentForVisit(doctorCtx, enc, docT, META);
    expect(d.labsToTake).toEqual(["Synthetic blood count"]);
    expect(d.encounter.diagnoses[0]!.icd10Code).toBe("I10");
    expect(d.note?.examination).toBe("Exam from template");

    const other = await staff(a, ["doctor"]);
    await saveDoctorProfile(a.ctx, other.membershipId, { specialty: "therapy", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
    await expect(documentForVisit(await clinicContext(other.login, a.slug), enc, docT, META)).rejects.toThrow(); // no care relationship
  });
});
