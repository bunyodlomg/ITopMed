import pg from "pg";
import { describe, expect, it } from "vitest";
import { loginPlatformUser, validatePlatformSession } from "@/server/auth/platform-auth";
import { resolveClinic, validateClinicSession, loginClinicUser } from "@/server/auth/clinic-auth";
import { addStaffMember, createBranch, listBranches, listClinicAudit, updateClinicSettings } from "@/server/clinic/admin";
import { acceptInvitation } from "@/server/tenancy/invitations";
import { changeTenantStatus, createClinicWithOwner, provisionClinic, setTenantModule } from "@/server/tenancy/provisioning";
import { platformDb } from "@/server/db";
import { createPlatformUser } from "@/server/auth/platform-auth";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

describe("acceptance 1: super admin signs in with login name + password", () => {
  it("signs in by login name (case-insensitive) and locks after repeated failures", async () => {
    const username = uniq("root.admin");
    await createPlatformUser({ username, fullName: "Synthetic Root", password: PASSWORD, role: "SUPER_ADMIN" });

    const login = await loginPlatformUser(username.toUpperCase(), PASSWORD, META);
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    const p = await validatePlatformSession(login.token);
    expect(p?.user.username).toBe(username);
    // No email anywhere: the account carries none.
    expect((await platformDb().platformUser.findUniqueOrThrow({ where: { username } })).email).toBeNull();

    for (let i = 0; i < 5; i++) expect((await loginPlatformUser(username, "wrong-password-123", META)).ok).toBe(false);
    const locked = await loginPlatformUser(username, PASSWORD, META);
    expect(locked).toEqual({ ok: false, reason: "locked" });
  });

  it("refuses a login name that is already taken", async () => {
    const username = uniq("taken");
    await createPlatformUser({ username, fullName: "Synthetic A", password: PASSWORD, role: "SUPPORT" });
    await expect(createPlatformUser({ username, fullName: "Synthetic B", password: PASSWORD, role: "SUPPORT" })).rejects.toThrow("errors.usernameTaken");
  });

  it("rejects unknown accounts without revealing whether they exist", async () => {
    expect(await loginPlatformUser("nobody.here", PASSWORD, META)).toEqual({ ok: false, reason: "invalid" });
  });
});

const clinicInput = (slug: string, extra: Record<string, unknown> = {}) => ({
  name: "Synthetic MedLife",
  slug,
  defaultLocale: "ru",
  timezone: "Asia/Tashkent",
  planCode: "starter",
  ownerFullName: "Synthetic Owner",
  taxId: "123456789",
  ...extra,
});

describe("acceptance 2–5: clinic provisioning and owner account (login + password, no email)", () => {
  it("provisions an isolated workspace atomically", async () => {
    const actor = await platformActor();
    const r = await provisionClinic(actor, clinicInput(uniq("medlife")), META);
    const t = await platformDb().tenant.findUniqueOrThrow({ where: { id: r.tenantId }, include: { branches: true, roles: true, modules: true, subscription: true, invitations: true } });
    expect(t.status).toBe("TRIAL");
    expect(t.contactEmail).toBeNull();
    expect(t.branches).toHaveLength(1);
    expect(t.branches[0]!.isMain).toBe(true);
    expect(t.roles.map((x) => x.key).sort()).toContain("clinic_owner");
    expect(t.roles).toHaveLength(13);
    expect(t.subscription?.status).toBe("TRIALING");
    expect(t.modules.find((m) => m.moduleKey === "core")?.enabled).toBe(true);
    expect(t.modules.find((m) => m.moduleKey === "laboratory")?.enabled).toBe(false); // not in starter plan
    expect(t.invitations[0]!.email).toBeNull();
    expect(t.invitations[0]!.tokenHash).not.toContain(r.inviteToken); // only the hash is stored
    expect(t.invitations[0]!.tokenHash).toHaveLength(64);
  });

  it("rejects duplicate and reserved slugs, and unauthorised platform roles", async () => {
    const actor = await platformActor();
    const slug = uniq("dup");
    await provisionClinic(actor, clinicInput(slug), META);
    await expect(provisionClinic(actor, clinicInput(slug), META)).rejects.toThrow("errors.slugTaken");
    await expect(provisionClinic(actor, clinicInput("admin"), META)).rejects.toThrow();
    const support = await platformActor("SUPPORT");
    await expect(provisionClinic(support, clinicInput(uniq("x")), META)).rejects.toThrow("errors.forbidden");
  });

  it("creates the clinic with the owner's login and password in one step, then the owner configures it", async () => {
    const actor = await platformActor();
    const slug = uniq("shifo");
    const ownerLogin = uniq("owner");
    // Login and password are required; a weak password is refused before anything is created.
    await expect(createClinicWithOwner(actor, clinicInput(slug, { ownerUsername: ownerLogin, ownerPassword: "short" }), META)).rejects.toThrow();
    await expect(createClinicWithOwner(actor, clinicInput(slug, { ownerPassword: PASSWORD }), META)).rejects.toThrow();
    expect(await platformDb().tenant.findUnique({ where: { slug } })).toBeNull();

    const r = await createClinicWithOwner(actor, clinicInput(slug, { name: "Synthetic Shifo", planCode: "professional", ownerUsername: ownerLogin, ownerPassword: PASSWORD }), META);
    expect(r.slug).toBe(slug);
    // A second clinic cannot reuse a taken login (checked before the clinic exists).
    const slug2 = uniq("shifo2");
    await expect(createClinicWithOwner(actor, clinicInput(slug2, { ownerUsername: ownerLogin, ownerPassword: PASSWORD }), META)).rejects.toThrow("errors.usernameTaken");
    expect(await platformDb().tenant.findUnique({ where: { slug: slug2 } })).toBeNull();

    const ctx = await clinicContext(ownerLogin, slug);
    expect(ctx.roleKeys).toEqual(["clinic_owner"]);
    expect(ctx.permissions.has("clinic.settings.manage")).toBe(true);
    expect(ctx.permissions.has("emr.read")).toBe(false); // admin authority ≠ medical access

    await updateClinicSettings(ctx, { name: "Synthetic Shifo Plus", defaultLocale: "ru", timezone: "Asia/Tashkent", contactPhone: "+998 90 000 00 00", address: "" }, META);
    await createBranch(ctx, { name: "Chilonzor", address: "", phone: "" }, META);
    const branches = await listBranches(ctx);
    expect(branches.map((b) => b.name)).toEqual(["Synthetic Shifo", "Chilonzor"]);

    const events = await listClinicAudit(ctx);
    const actions = events.map((e) => e.action);
    for (const a of ["tenant.created", "invitation.created", "invitation.accepted", "membership.created", "tenant.owner_account_created", "clinic.settings.updated", "branch.created"]) {
      expect(actions).toContain(a);
    }
  });

  it("an internal invitation is single use and expires", async () => {
    const actor = await platformActor();
    const r = await provisionClinic(actor, clinicInput(uniq("once")), META);
    await acceptInvitation(r.inviteToken, { fullName: "Synthetic Owner", username: uniq("o"), password: PASSWORD, confirmPassword: PASSWORD }, META);
    await expect(acceptInvitation(r.inviteToken, { fullName: "X Y", username: uniq("o"), password: PASSWORD, confirmPassword: PASSWORD }, META)).rejects.toThrow("errors.invitationInvalid");

    const r2 = await provisionClinic(actor, clinicInput(uniq("exp")), META);
    const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.connect();
    await owner.query(`UPDATE "Invitation" SET "expiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 hour' WHERE "tenantId" = $1`, [r2.tenantId]);
    await owner.end();
    await expect(acceptInvitation(r2.inviteToken, { fullName: "Synthetic Owner", username: uniq("o"), password: PASSWORD, confirmPassword: PASSWORD }, META)).rejects.toThrow("errors.invitationExpired");
  });
});

describe("acceptance 6: clinic creates individual staff accounts", () => {
  it("owner adds a doctor (login + password) who gets doctor permissions only", async () => {
    const actor = await platformActor();
    const { ctx, slug } = await clinicWithOwner(actor);
    const login = uniq("dr");
    await expect(addStaffMember(ctx, { fullName: "Synthetic Doctor", username: login, password: "short", roleKeys: ["doctor"] }, META)).rejects.toThrow();
    expect(await addStaffMember(ctx, { fullName: "Synthetic Doctor", username: login, password: PASSWORD, roleKeys: ["doctor"] }, META)).toBe(login);
    await expect(addStaffMember(ctx, { fullName: "Synthetic Twin", username: login, password: PASSWORD, roleKeys: ["doctor"] }, META)).rejects.toThrow("errors.usernameTaken");
    const dr = await clinicContext(login, slug);
    expect(dr.roleKeys).toEqual(["doctor"]);
    expect(dr.permissions.has("emr.read")).toBe(true);
    expect(dr.permissions.has("staff.manage")).toBe(false);
    await expect(addStaffMember(dr, { fullName: "Someone Else", username: uniq("x"), password: PASSWORD, roleKeys: ["receptionist"] }, META)).rejects.toThrow("errors.forbidden");
  });

  it("a clinic admin cannot grant the owner role", async () => {
    const actor = await platformActor();
    const { ctx, slug } = await clinicWithOwner(actor);
    const login = uniq("adm");
    await addStaffMember(ctx, { fullName: "Synthetic Admin", username: login, password: PASSWORD, roleKeys: ["clinic_admin"] }, META);
    const admin = await clinicContext(login, slug);
    await expect(addStaffMember(admin, { fullName: "Would Be Owner", username: uniq("w"), password: PASSWORD, roleKeys: ["clinic_owner"] }, META)).rejects.toThrow("errors.forbidden");
  });
});

describe("tenant lifecycle and feature flags", () => {
  it("suspension blocks clinic access immediately; reactivation restores it", async () => {
    const actor = await platformActor();
    const { tenantId, ownerLogin, slug } = await clinicWithOwner(actor);
    await expect(changeTenantStatus(actor, tenantId, "suspend", "short", META)).rejects.toThrow();
    await changeTenantStatus(actor, tenantId, "suspend", "Unpaid invoice for synthetic test period", META);

    const login = await loginClinicUser(ownerLogin, PASSWORD, META);
    if (!login.ok) throw new Error("login");
    const principal = await validateClinicSession(login.token);
    expect(await resolveClinic(principal!, slug)).toBeNull();

    await changeTenantStatus(actor, tenantId, "reactivate", undefined, META);
    const principal2 = await validateClinicSession(login.token);
    expect(await resolveClinic(principal2!, slug)).not.toBeNull();
    await expect(changeTenantStatus(actor, tenantId, "activate", undefined, META)).rejects.toThrow("errors.invalidTransition");
  });

  it("modules can be toggled, but the core module cannot be disabled", async () => {
    const actor = await platformActor();
    const { tenantId } = await clinicWithOwner(actor);
    await setTenantModule(actor, tenantId, "laboratory", false, META);
    await expect(setTenantModule(actor, tenantId, "core", false, META)).rejects.toThrow("errors.coreModule");
    await expect(setTenantModule(await platformActor("SUPPORT"), tenantId, "emr", false, META)).rejects.toThrow("errors.forbidden");
  });
});
