import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addStaffMember, listStaff } from "@/server/clinic/admin";
import { exportTemplates, importTemplates, listTemplates, TEMPLATE_FILE_FORMAT } from "@/server/clinic/templates";
import { parseTemplateContent, renderReport } from "@/lib/diagnostic-template";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

const FARHOD = fs.readFileSync(path.join(process.cwd(), "docs", "klinikalar", "farhod-medservis-shablonlar.json"), "utf8");

describe("template files (export / import)", () => {
  it("the Farhod MedServis file is valid as a whole: 14 templates, nothing rejected", async () => {
    const { ctx } = await clinicWithOwner(await platformActor());
    const r = await importTemplates(ctx, FARHOD, META);
    expect(r.invalid).toEqual([]);
    expect(r.created).toBe(14);
    const list = await listTemplates(ctx);
    expect(list.filter((t) => t.kind === "DIAGNOSTIC")).toHaveLength(12);
    expect(list.filter((t) => t.kind === "DOCUMENT").map((t) => t.name).sort()).toEqual(["Кардиолог кўруви", "Маълумотнома"]);

    // A report keeps the doctor's wording; lines whose measurements were left empty drop out.
    const echo = parseTemplateContent(list.find((t) => t.name === "Трансторакал эхокардиография")!.content)!;
    expect(echo.study).toBe("ECHO");
    expect(echo.fields.find((f) => f.key === "efTeich")).toMatchObject({ unit: "%", min: 55, max: 70 });
    const text = renderReport(echo.body, { efTeich: "62", efSimpson: "60" }).text;
    expect(text).toContain("ФВ — 62% (55–70%, Тейхолц). ФВ — 60% (N > 50%, Симпсон).");
    expect(text).not.toContain("КДР");

    // Importing again changes nothing.
    const again = await importTemplates(ctx, FARHOD, META);
    expect(again.created).toBe(0);
    expect(again.skipped).toHaveLength(14);
  });

  it("export → import into another clinic gives the same templates", async () => {
    const a = await clinicWithOwner(await platformActor());
    await importTemplates(a.ctx, FARHOD, META);
    const file = await exportTemplates(a.ctx, META);
    expect(file.format).toBe(TEMPLATE_FILE_FORMAT);
    const b = await clinicWithOwner(await platformActor());
    const r = await importTemplates(b.ctx, JSON.stringify(file), META);
    expect(r).toMatchObject({ created: 14, skipped: [], invalid: [] });
    const norm = (l: Awaited<ReturnType<typeof listTemplates>>) => l.map((t) => [t.kind, t.name, t.specialty, t.content]).sort();
    expect(norm(await listTemplates(b.ctx))).toEqual(norm(await listTemplates(a.ctx)));
  });

  it("reports invalid entries by name, rejects a broken file, and needs settings rights", async () => {
    const o = await clinicWithOwner(await platformActor());
    const file = {
      format: TEMPLATE_FILE_FORMAT,
      version: 1,
      templates: [
        { kind: "DIAGNOSTIC", name: "Yaroqli", study: "ULTRASOUND", fields: ["size | O'lcham | mm | 1-5"], body: ["O'lcham: {{size}} mm"] },
        { kind: "DIAGNOSTIC", name: "Noma'lum o'rinbosar", study: "ULTRASOUND", fields: ["size | O'lcham"], body: ["{{other}}"] },
        { kind: "DIAGNOSTIC", name: "Xato qator", study: "ULTRASOUND", fields: ["1bad | x"], body: ["x"] },
        { kind: "WHATEVER", name: "Noma'lum tur" },
      ],
    };
    const r = await importTemplates(o.ctx, JSON.stringify(file), META);
    expect(r.created).toBe(1);
    expect(r.invalid.map((i) => i.name)).toEqual(["Noma'lum o'rinbosar", "Xato qator", "Noma'lum tur"]);
    await expect(importTemplates(o.ctx, "{not json", META)).rejects.toThrow("errors.templateFileInvalid");
    await expect(importTemplates(o.ctx, JSON.stringify({ format: "other", version: 1, templates: [] }), META)).rejects.toThrow("errors.templateFileInvalid");

    const login = uniq("s");
    await addStaffMember(o.ctx, { fullName: "Synthetic receptionist", username: login, roleKeys: ["receptionist"], password: PASSWORD }, META);
    expect((await listStaff(o.ctx)).members.some((m) => m.user.username === login)).toBe(true);
    const desk = await clinicContext(login, o.slug);
    await expect(importTemplates(desk, FARHOD, META)).rejects.toThrow("errors.forbidden");
    await expect(exportTemplates(desk, META)).rejects.toThrow("errors.forbidden");
  });
});
