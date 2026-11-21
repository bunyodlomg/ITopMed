/**
 * DEV ONLY: fills the local development database with a synthetic demo clinic,
 * so every screen can be looked at with real-looking (but invented) data:
 * a SuperAdmin, "Demo Klinika" with its owner (a doctor + front desk), two more
 * doctors working today, a price list, and six synthetic patients checked in
 * today (paid, partly paid and on debt).
 *
 *   npm run db:start          (keep running)
 *   npm run dev:demo
 *
 * Refuses to run unless APP_URL points at this computer. Generated passwords are
 * written to .dev-mailbox/DEMO-LOGIN.txt (git-ignored), never printed.
 * Synthetic data only (*.test addresses); never real patients.
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loginClinicUser, resolveClinic, validateClinicSession } from "../src/server/auth/clinic-auth";
import { createPlatformUser } from "../src/server/auth/platform-auth";
import { addStaffMember, listStaff } from "../src/server/clinic/admin";
import { listOperationalBranches } from "../src/server/clinic/context";
import { addScheduleBlock, getMyDoctorProfileId, listDoctors, saveDoctorProfile } from "../src/server/clinic/doctors";
import { listServices } from "../src/server/clinic/resources";
import { platformDb } from "../src/server/db";
import { deskCheckIn } from "../src/server/reception/desk";
import { suggestPassword } from "../src/server/security/password";
import { isoWeekday, todayIn } from "../src/server/scheduling/time";
import { createClinicFromSpec } from "./lib/create-clinic";

const META = { ip: "127.0.0.1", userAgent: "dev-demo" };
const SLUG = "demo-klinika";

async function main() {
  const appUrl = process.env.APP_URL ?? "";
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(appUrl)) throw new Error(`dev:demo runs only against a local APP_URL (got "${appUrl}").`);
  if (await platformDb().tenant.findUnique({ where: { slug: SLUG } })) {
    console.log(`"${SLUG}" already exists. Logins: .dev-mailbox/DEMO-LOGIN.txt`);
    return;
  }

  const adminPassword = `${suggestPassword()}-${suggestPassword()}`;
  const ownerPassword = `${suggestPassword()}-${suggestPassword()}`;
  const staffPassword = `${suggestPassword()}-${suggestPassword()}`;
  const ownerLogin = "owner@demo-klinika.test";
  // Written first, so a run that fails half-way never leaves accounts nobody can open.
  const dir = path.join(process.cwd(), ".dev-mailbox");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "DEMO-LOGIN.txt"),
    [
      "ITop Med — LOCAL DEMO logins (synthetic data, this computer only)",
      "",
      `Clinic (owner, doctor + front desk):  http://127.0.0.1:3000/login`,
      `  login:    ${ownerLogin}`,
      `  password: ${ownerPassword}`,
      "",
      `Doctors:  dr.usmonova / dr.xolmatov   password: ${staffPassword}`,
      "",
      `SuperAdmin console:  http://127.0.0.1:3000/admin/login`,
      `  login:    demo-admin`,
      `  password: ${adminPassword}`,
      "",
    ].join("\n"),
    "utf8",
  );

  if (!(await platformDb().platformUser.findFirst({ where: { role: "SUPER_ADMIN", status: "ACTIVE" } }))) {
    await createPlatformUser({ username: "demo-admin", fullName: "Demo SuperAdmin", password: adminPassword, role: "SUPER_ADMIN" });
  }

  const specFile = path.join(os.tmpdir(), `itm-demo-${Date.now()}.json`);
  fs.writeFileSync(
    specFile,
    JSON.stringify({
      name: "Demo Klinika",
      slug: SLUG,
      practiceType: "MULTI_SPECIALTY",
      ownerIsDoctor: true,
      ownerFrontDesk: true,
      address: "Toshkent, Demo ko'chasi 1",
      priceList: ["Terapevt ko'rigi 150 ming", "Ginekolog ko'rigi 180 ming", "UZI qorin bo'shlig'i 200 ming", "EKG 80 ming", "Umumiy qon tahlili 60 ming"],
    }),
  );
  await createClinicFromSpec(specFile, ownerLogin, "Karimov Anvar", ownerPassword);
  fs.rmSync(specFile, { force: true });

  const login = await loginClinicUser(ownerLogin, ownerPassword, META);
  if (!login.ok) throw new Error(`owner sign-in failed: ${login.reason}`);
  const principal = (await validateClinicSession(login.token))!;
  const ctx = (await resolveClinic(principal, SLUG))!;

  // Two more doctors.
  const doctors = [
    { fullName: "Usmonova Malika", username: "dr.usmonova", specialty: "obstetrics_gynecology" },
    { fullName: "Xolmatov Sardor", username: "dr.xolmatov", specialty: "general_practice" },
  ];
  for (const d of doctors) {
    await addStaffMember(ctx, { fullName: d.fullName, roleKeys: ["doctor"], username: d.username, password: staffPassword }, META);
    const m = (await listStaff(ctx)).members.find((s) => s.user.username === d.username);
    if (!m) throw new Error(`staff ${d.username} missing`);
    await saveDoctorProfile(ctx, m.id, { specialty: d.specialty, defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
  }

  // Everyone works today.
  const today = todayIn(ctx.tenant.timezone);
  const branch = (await listOperationalBranches(ctx))[0]!;
  const fresh = (await resolveClinic(principal, SLUG))!;
  const profiles = (await listDoctors(fresh)).filter((d) => d.profile && !d.profile.archivedAt).map((d) => d.profile!.id);
  const ownerProfile = await getMyDoctorProfileId(fresh);
  for (const id of profiles) await addScheduleBlock(fresh, id, { weekday: isoWeekday(today), start: "08:00", end: "18:00", branchId: branch.id }, META);

  // Six synthetic patients checked in today.
  const services = (await listServices(fresh)).filter((s) => s.priceMinor > 0n);
  const svc = (name: string) => services.find((s) => s.name.startsWith(name))?.id;
  const visits = [
    { lastName: "Aliyev", firstName: "Jasur", birthDate: "1988", sex: "MALE", doctor: ownerProfile, services: [svc("Terapevt"), svc("EKG")], payMode: "full" },
    { lastName: "Karimova", firstName: "Dilnoza", birthDate: "1995", sex: "FEMALE", doctor: profiles[1], services: [svc("Ginekolog")], payMode: "full" },
    { lastName: "Toshmatov", firstName: "Bekzod", birthDate: "1979", sex: "MALE", doctor: ownerProfile, services: [svc("Terapevt"), svc("Umumiy")], payMode: "debt" },
    { lastName: "Rahimova", firstName: "Nigora", birthDate: "2001", sex: "FEMALE", doctor: profiles[2], services: [svc("UZI")], payMode: "partial", amount: "100000" },
    { lastName: "Yusupov", firstName: "Sardor", birthDate: "1966", sex: "MALE", doctor: profiles[2], services: [svc("UZI"), svc("Umumiy")], payMode: "full" },
    { lastName: "Qodirova", firstName: "Madina", birthDate: "1990", sex: "FEMALE", doctor: profiles[1], services: [svc("Ginekolog")], payMode: "debt" },
  ];
  for (const v of visits) {
    const r = await deskCheckIn(
      fresh,
      {
        lastName: v.lastName,
        firstName: v.firstName,
        birthDate: v.birthDate,
        sex: v.sex,
        phone: "",
        address: "",
        doctorProfileId: v.doctor,
        branchId: branch.id,
        serviceIds: v.services.filter(Boolean),
        payMode: v.payMode,
        amount: v.amount ?? "",
        method: "CASH",
        confirmNotDuplicate: "on",
      },
      META,
    );
    if (!r.ok) throw new Error(`check-in of a synthetic patient refused`);
  }

  console.log(`Demo clinic "${SLUG}" ready. Logins: .dev-mailbox/DEMO-LOGIN.txt`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
