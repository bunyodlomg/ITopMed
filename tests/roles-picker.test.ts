import { describe, expect, it } from "vitest";
import { PERMISSIONS, ROLE_TEMPLATES } from "@/server/authz/permissions";
import { PERMISSION_GROUPS } from "@/server/clinic/roles";

describe("role editor permission groups", () => {
  const grouped = PERMISSION_GROUPS.flatMap((g) => g.permissions);

  it("shows every permission exactly once, so saving a role never drops one it cannot see", () => {
    expect([...grouped].sort()).toEqual([...PERMISSIONS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("covers every permission of the standard role templates", () => {
    const shown = new Set(grouped);
    for (const [role, perms] of Object.entries(ROLE_TEMPLATES)) expect(perms.filter((p) => !shown.has(p)), role).toEqual([]);
  });
});
