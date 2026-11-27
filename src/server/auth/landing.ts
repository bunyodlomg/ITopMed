import "server-only";
import { resolveClinic, type ClinicPrincipal } from "./clinic-auth";

const USABLE = new Set(["TRIAL", "ACTIVE"]);

/**
 * The first screen a staff member needs, by role. Earlier entries win, so a
 * small-practice owner who is also the doctor lands on the dashboard.
 * Every target re-checks permissions itself; this only picks a starting page.
 */
const HOME_BY_ROLE: [role: string, path: string][] = [
  ["clinic_owner", ""],
  ["clinic_admin", ""],
  ["branch_manager", ""],
  ["head_doctor", "/my-queue"],
  ["doctor", "/my-queue"],
  ["receptionist", "/desk"],
  ["cashier", "/checkout"],
  ["nurse", "/nurse"],
  ["lab_staff", "/lab"],
  ["diagnostics", "/studies"],
  ["pharmacist", "/inventory"],
  ["accountant", "/reports"],
  ["hr_manager", "/hr"],
];

export function homeForRoles(slug: string, roleKeys: string[]): string {
  const hit = HOME_BY_ROLE.find(([role]) => roleKeys.includes(role));
  return `/c/${slug}${hit ? hit[1] : ""}`;
}

/** One usable clinic: that clinic's page for the person's role. Several (or none): the clinic chooser. */
export async function staffHome(p: ClinicPrincipal): Promise<string> {
  const usable = p.clinics.filter((c) => USABLE.has(c.status));
  if (usable.length !== 1) return "/clinics";
  const ctx = await resolveClinic(p, usable[0]!.slug);
  return ctx ? homeForRoles(ctx.tenant.slug, ctx.roleKeys) : "/clinics";
}
