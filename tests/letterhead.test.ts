import { describe, expect, it } from "vitest";
import { addStaffMember, listStaff } from "@/server/clinic/admin";
import { getLetterhead, saveLetterhead } from "@/server/clinic/branding";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

describe("letterhead", () => {
  it("licence line and a map link printed as a QR code; only https links; only managers change it", async () => {
    const a = await clinicWithOwner(await platformActor());
    expect((await getLetterhead(a.ctx)).locationQr).toBeNull();

    await expect(saveLetterhead(a.ctx, { licenseText: "", locationUrl: "http://maps.example.test/x" }, META)).rejects.toThrow();
    await expect(saveLetterhead(a.ctx, { licenseText: "", locationUrl: "javascript:alert(1)" }, META)).rejects.toThrow();
    await saveLetterhead(a.ctx, { licenseText: "Litsenziya № 000000 (synthetic)", locationUrl: "https://maps.example.test/clinic" }, META);
    const head = await getLetterhead(a.ctx);
    expect(head.locationUrl).toBe("https://maps.example.test/clinic");
    expect(head.locationQr).toMatch(/^data:image\/png;base64,/);

    // Clearing the field removes the QR code.
    await saveLetterhead(a.ctx, { licenseText: "Litsenziya № 000000 (synthetic)", locationUrl: "" }, META);
    expect((await getLetterhead(a.ctx)).locationQr).toBeNull();

    const login = uniq("s");
    await addStaffMember(a.ctx, { fullName: "Synthetic doctor", username: login, roleKeys: ["doctor"], password: PASSWORD }, META);
    expect((await listStaff(a.ctx)).members.some((m) => m.user.username === login)).toBe(true);
    await expect(saveLetterhead(await clinicContext(login, a.slug), { licenseText: "", locationUrl: "https://maps.example.test/x" }, META)).rejects.toThrow("errors.forbidden");
  });
});
