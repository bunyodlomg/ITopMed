import { describe, expect, it } from "vitest";
import { addStaffMember, listBranches, listStaff } from "@/server/clinic/admin";
import { saveDoctorProfile } from "@/server/clinic/doctors";
import { archiveMedicine, getMedicine, guessForm, medicinePhoto, saveMedicine, searchMedicines, setMedicinePhoto } from "@/server/emr/medicines";
import { addPrescription } from "@/server/emr/prescriptions";
import { getEncounter, startVisit } from "@/server/emr/record";
import { deskCheckIn } from "@/server/reception/desk";
import { matchScore, medicineSearchKey, searchText, splitStrength } from "@/lib/medicines";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

async function staff(o: Awaited<ReturnType<typeof clinicWithOwner>>, roleKeys: string[]) {
  const login = uniq("s");
  await addStaffMember(o.ctx, { fullName: `Synthetic ${roleKeys.join(" ")}`, username: login, roleKeys, password: PASSWORD }, META);
  const m = (await listStaff(o.ctx)).members.find((x) => x.user.username === login)!;
  return { membershipId: m.id, ctx: await clinicContext(login, o.slug) };
}

// Smallest valid PNG (1x1) - synthetic test bytes.
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
const PDF = new TextEncoder().encode("%PDF-1.4\n%synthetic\n");

describe("medicine search helpers", () => {
  it("Cyrillic and Latin spellings meet; strength is split off the name", () => {
    expect(searchText("Конкор")).toBe("konkor");
    expect(searchText("Бисопролол 5 мг")).toBe("bisoprolol 5 mg");
    expect(searchText("Ko'k choy")).toBe(searchText("Кўк чой"));
    expect(searchText("Xolesterin")).toBe(searchText("Holesterin"));
    expect(splitStrength("Bisoprolol 5 mg")).toEqual({ name: "Bisoprolol", strength: "5 mg" });
    expect(splitStrength("Trombonet 75mg")).toEqual({ name: "Trombonet", strength: "75mg" });
    expect(splitStrength("Amoksiklav 875/125 mg")).toEqual({ name: "Amoksiklav", strength: "875/125 mg" });
    expect(splitStrength("Validol")).toEqual({ name: "Validol", strength: null });
    const key = medicineSearchKey({ name: "Konkor", strength: "5 mg", inn: "bisoprolol", drugGroup: "Beta-blokator" });
    expect(matchScore("konk", { name: "Konkor", inn: "bisoprolol", key })).toBeGreaterThan(matchScore("bisop", { name: "Konkor", inn: "bisoprolol", key }));
    expect(matchScore("aspirin", { name: "Konkor", inn: "bisoprolol", key })).toBe(0);
    expect(guessForm("1 tabletka")).toBe("tablet");
    expect(guessForm("2 tomchi")).toBe("drops");
    expect(guessForm("5 ml")).toBe("other");
  });
});

describe("medicine catalog", () => {
  it("doctors write and search it (Latin, Cyrillic, INN, a typo); a prescription from it counts its use; typed ones can be kept", async () => {
    const o = await clinicWithOwner(await platformActor());
    const [branch] = await listBranches(o.ctx);
    const doctor = await staff(o, ["doctor"]);
    const desk = await staff(o, ["receptionist"]);
    const profileId = await saveDoctorProfile(o.ctx, doctor.membershipId, { specialty: "cardiology", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);

    const konkor = await saveMedicine(doctor.ctx, null, { name: "Konkor", strength: "5 mg", inn: "bisoprolol", form: "tablet", drugGroup: "Beta-blokator", defaultDose: "1 tabletka", defaultFrequency: "kuniga 1 mahal ertalab", defaultTimes: "8:00", defaultDays: "30" }, META);
    await saveMedicine(doctor.ctx, null, { name: "Trombonet", strength: "75 mg", inn: "klopidogrel", form: "tablet" }, META);
    await saveMedicine(doctor.ctx, null, { name: "Kardiomagnil", strength: "75 mg", inn: "atsetilsalitsil kislota", form: "tablet" }, META);
    await expect(saveMedicine(doctor.ctx, null, { name: "konkor", strength: "5 MG", form: "tablet" }, META)).rejects.toThrow("errors.medicineExists");
    await expect(saveMedicine(doctor.ctx, null, { name: "Konkor", form: "tablet", defaultTimes: "25:00" }, META)).rejects.toThrow();
    expect((await getMedicine(doctor.ctx, konkor)).defaultTimes).toBe("08:00");

    const names = async (q: string) => (await searchMedicines(doctor.ctx, q)).map((m) => m.name);
    expect(await names("konk")).toEqual(["Konkor"]);
    expect(await names("конк")).toEqual(["Konkor"]);
    expect(await names("bisopr")).toEqual(["Konkor"]);
    expect(await names("beta")).toEqual(["Konkor"]);
    expect(await names("75")).toEqual(["Kardiomagnil", "Trombonet"]);
    expect(await names("trambonet")).toEqual(["Trombonet"]); // typo
    expect(await names("zzzz")).toEqual([]);

    // Not for staff who do not prescribe; another clinic never sees it.
    await expect(searchMedicines(desk.ctx, "konk")).rejects.toThrow("errors.forbidden");
    await expect(saveMedicine(desk.ctx, null, { name: "Synthetic", form: "tablet" }, META)).rejects.toThrow("errors.forbidden");
    const other = await clinicWithOwner(await platformActor());
    const otherDoctor = await staff(other, ["doctor"]);
    expect(await searchMedicines(otherDoctor.ctx, "konk")).toEqual([]);
    await expect(getMedicine(otherDoctor.ctx, konkor)).rejects.toThrow("errors.notFound");

    // Prescribing from the catalog counts the use (most used first in an empty search).
    const r = await deskCheckIn(desk.ctx, { lastName: "Sintetik", firstName: "Dori", birthDate: "1958", sex: "MALE", doctorProfileId: profileId, branchId: branch!.id }, META);
    if (!r.ok) throw new Error("duplicate");
    const enc = await startVisit(doctor.ctx, r.appointmentId, META);
    await addPrescription(doctor.ctx, enc, { drug: "Konkor 5 mg", inn: "bisoprolol", dose: "1 tabletka", frequency: "kuniga 1 mahal", medicineId: konkor }, META);
    expect((await getMedicine(doctor.ctx, konkor)).usageCount).toBe(1);
    expect((await searchMedicines(doctor.ctx, ""))[0]!.name).toBe("Konkor");

    // A typed medicine kept in the catalog on request; without the request it is not.
    await addPrescription(doctor.ctx, enc, { drug: "Lorista 50 mg", inn: "losartan", dose: "1 tabletka", frequency: "kuniga 1 mahal", times: "20:00", saveToCatalog: true }, META);
    await addPrescription(doctor.ctx, enc, { drug: "Validol", dose: "1 tabletka", frequency: "kerak bo'lganda" }, META);
    const [lorista] = await searchMedicines(doctor.ctx, "lorista");
    expect(lorista).toMatchObject({ name: "Lorista", strength: "50 mg", inn: "losartan", form: "tablet", defaultTimes: "20:00", usageCount: 1 });
    expect(await names("validol")).toEqual([]);
    const rx = (await getEncounter(doctor.ctx, enc, META)).encounter.prescriptions;
    expect(rx.map((p) => [p.drug, Boolean(p.medicineId)])).toEqual([["Konkor 5 mg", true], ["Lorista 50 mg", true], ["Validol", false]]);
    // An unknown catalog id is refused (and nothing is written).
    await expect(addPrescription(doctor.ctx, enc, { drug: "Konkor 5 mg", dose: "1", frequency: "1", medicineId: "00000000-0000-7000-8000-000000000000" }, META)).rejects.toThrow("errors.notFound");

    // Archived: out of the search, back when restored.
    await archiveMedicine(doctor.ctx, konkor, false, META);
    expect(await names("konk")).toEqual([]);
    await archiveMedicine(doctor.ctx, konkor, true, META);
    expect(await names("konk")).toEqual(["Konkor"]);
  });

  it("photo: an image checked from its bytes, at most 2 MB; PDFs and other files refused", async () => {
    const o = await clinicWithOwner(await platformActor());
    const doctor = await staff(o, ["doctor"]);
    const pharmacist = await staff(o, ["pharmacist"]);
    const id = await saveMedicine(pharmacist.ctx, null, { name: "Synthetic Tabs", form: "tablet" }, META);
    await setMedicinePhoto(pharmacist.ctx, id, PNG, META);
    expect(await medicinePhoto(doctor.ctx, id)).toMatchObject({ mime: "image/png" });
    expect((await searchMedicines(doctor.ctx, "synthetic"))[0]!.hasPhoto).toBe(true);
    await expect(setMedicinePhoto(pharmacist.ctx, id, PDF, META)).rejects.toThrow("errors.photoType");
    await expect(setMedicinePhoto(pharmacist.ctx, id, new Uint8Array(2 * 1024 * 1024 + 1), META)).rejects.toThrow("errors.photoTooLarge");
    await expect(setMedicinePhoto(pharmacist.ctx, id, new TextEncoder().encode("not an image"), META)).rejects.toThrow("errors.photoType");
    await setMedicinePhoto(pharmacist.ctx, id, null, META);
    expect(await medicinePhoto(doctor.ctx, id)).toBeNull();
  });
});
