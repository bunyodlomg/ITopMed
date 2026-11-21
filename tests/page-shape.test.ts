import { describe, expect, it } from "vitest";
import { shapeOf } from "@/lib/page-shape";

const id = "01a1fc59-3f64-77f3-b6d4-17c6ef52e654";

describe("loading placeholder shape", () => {
  it("matches the kind of page being opened", () => {
    expect(shapeOf("/c/shifo")).toBe("dashboard");
    expect(shapeOf("/admin")).toBe("dashboard");
    expect(shapeOf("/c/shifo/patients")).toBe("list");
    expect(shapeOf("/c/shifo/services")).toBe("list");
    expect(shapeOf("/admin/clinics")).toBe("list");
    expect(shapeOf(`/c/shifo/patients/${id}`)).toBe("detail");
    expect(shapeOf(`/c/shifo/billing/${id}/receipt`)).toBe("detail");
    expect(shapeOf(`/admin/clinics/${id}`)).toBe("detail");
    expect(shapeOf("/c/shifo/patients/new")).toBe("form");
    expect(shapeOf("/c/shifo/settings")).toBe("form");
    expect(shapeOf("/c/shifo/desk")).toBe("form");
    expect(shapeOf("/c/shifo/reports")).toBe("report");
    expect(shapeOf("/p/shifo/medicines")).toBe("list");
  });
});
