import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createClinicFromSpec } from "../scripts/lib/create-clinic";
import { listServices } from "@/server/clinic/resources";
import { PASSWORD, clinicContext, platformActor, uniq } from "./helpers/fixtures";

describe("server task: open a clinic ready to work", () => {
  it("creates the clinic, the owner (doctor + front desk + head doctor), its own prices only", async () => {
    await platformActor(); // a SuperAdmin must exist
    const slug = uniq("farhod").toLowerCase();
    const spec = JSON.parse(fs.readFileSync("scripts/deploy/clinics/farhod-medservis.json", "utf8"));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "itm-spec-")), "spec.json");
    fs.writeFileSync(file, JSON.stringify({ ...spec, name: "Synthetic Farhod", slug }));
    fs.copyFileSync(path.join("scripts/deploy/clinics", spec.logoFile), path.join(path.dirname(file), spec.logoFile));
    const login = uniq("owner");

    const r = await createClinicFromSpec(file, login, "Synthetic Owner Doctor", PASSWORD);
    expect(r.slug).toBe(slug);
    expect(r.prices.created + r.prices.updated).toBe(spec.priceList.length);

    const ctx = await clinicContext(login, slug);
    expect(ctx.roleKeys).toEqual(expect.arrayContaining(["clinic_owner", "doctor", "head_doctor", "receptionist", "cashier"]));
    const services = await listServices(ctx);
    expect(services).toHaveLength(spec.priceList.length);
    expect(services.every((s) => s.priceMinor > 0n)).toBe(true);
    expect(services.find((s) => s.name === "EhoKG (transtorakal)")?.priceMinor).toBe(12_000_000n);
    expect(services.find((s) => s.name === "Yorg'oq UTT")?.kind).toBe("IMAGING");
    expect(r.extras.letterhead).toEqual(expect.arrayContaining(["logoDataUrl", "doctorPhone"]));
    expect(r.extras.templatesAdded).toBe(15);
    // The owner's session used by the task is signed out again; the owner still signs in normally.
    expect(ctx.tenant.status).toBe("ACTIVE");
  });
});
