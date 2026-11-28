import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { templatesForService } from "@/lib/service-template";

const spec = JSON.parse(fs.readFileSync("scripts/deploy/clinics/farhod-medservis.json", "utf8")) as { priceList: string[]; diagnosticTemplates: { name: string }[] };
const templates = spec.diagnosticTemplates.map((t, i) => ({ id: `t${i}`, name: t.name, serviceId: null as string | null }));
const service = (name: string) => ({ id: name, name });
const names = (name: string, sex?: "MALE" | "FEMALE") => templatesForService(service(name), templates, sex).map((t) => t.name);

describe("paid service → the clinic's form", () => {
  it("finds Farhod MedServis's own form for each study on its price list, by the words of the names", () => {
    expect(names("EhoKG (transtorakal)")).toEqual(["Transtorakal exokardiografiya"]);
    expect(names("Qalqonsimon bez UTT")).toEqual(["UTT: qalqonsimon bez"]);
    expect(names("Yorg'oq UTT")).toEqual(["UTT: yorg'oq"]);
    expect(names("Prostata bezi va siydik pufagi UTT")).toEqual(["UTT: buyraklar, siydik pufagi va prostata"]);
    expect(names("Hazm tizimi UTT (jigar, o't pufagi, oshqozon osti bezi, taloq)")).toEqual(["UTT: hazm tizimi"]);
    // The old desk names of the same services (before the rename) still find their form.
    expect(names("Qalqonsimon bez UZI")).toEqual(["UTT: qalqonsimon bez"]);
  });

  it("chooses the women's or the men's form by the patient's sex", () => {
    expect(names("Umumiy qorin bo'shlig'i a'zolari UTT", "FEMALE")).toEqual(["UTT: qorin bo'shlig'i umumiy (ayollar)"]);
    expect(names("Umumiy qorin bo'shlig'i a'zolari UTT", "MALE")).toEqual(["UTT: qorin bo'shlig'i umumiy (erkaklar)"]);
    expect(names("Umumiy qorin bo'shlig'i a'zolari UTT")).toHaveLength(2);
  });

  it("a template bound to the service wins; a consultation has no form", () => {
    const bound = [...templates, { id: "x", name: "Exo (klinika varianti)", serviceId: "EhoKG (transtorakal)" }];
    expect(templatesForService(service("EhoKG (transtorakal)"), bound).map((t) => t.id)).toEqual(["x"]);
    expect(names("Kardiolog ko'ruvi")).toEqual([]);
  });
});
