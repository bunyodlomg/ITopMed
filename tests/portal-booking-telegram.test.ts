import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { bookAppointment, listDay } from "@/server/appointments/appointments";
import { addStaffMember, listBranches, listStaff } from "@/server/clinic/admin";
import { addScheduleBlock, addScheduleException, doctorSlots, saveDoctorProfile } from "@/server/clinic/doctors";
import { updateClinicPolicy } from "@/server/clinic/policy";
import { platformDb, withAppContext } from "@/server/db";
import { clinicBotStatus, connectClinicBot } from "@/server/telegram/clinic-bot";
import { createTelegramLink, disconnectMyTelegram, handleTelegramStart, myTelegram, telegramStatus } from "@/server/notifications/telegram";
import { processDueNotifications } from "@/server/notifications/notifications";
import { registerPatient } from "@/server/patients/patients";
import { activatePortalAccount, loginPatient, portalTenant, validatePatientSession } from "@/server/portal/auth";
import { availableDays, bookOnline, bookableDoctors } from "@/server/portal/booking";
import { cancelMyAppointment } from "@/server/portal/data";
import { issuePortalCode } from "@/server/portal/staff";
import { addDays, isoWeekday, localToInstant, todayIn } from "@/server/scheduling/time";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

const TZ = "Asia/Tashkent";
const PATIENT_PW = "Bemor-Parol-2026x";
const FAKE_TOKEN = "123456789:AAH-synthetic-test-token-0123456789abcdef";

async function staff(o: Awaited<ReturnType<typeof clinicWithOwner>>, roleKeys: string[]) {
  const login = uniq("s");
  await addStaffMember(o.ctx, { fullName: `Synthetic ${roleKeys[0]}`, username: login, roleKeys, password: PASSWORD }, META);
  const m = (await listStaff(o.ctx)).members.find((x) => x.user.username === login)!;
  return { login, membershipId: m.id, ctx: await clinicContext(login, o.slug) };
}

let n = 0;
async function setup() {
  const a = await clinicWithOwner(await platformActor());
  const [branch] = await listBranches(a.ctx);
  const reception = await staff(a, ["receptionist"]);
  const doctor = await staff(a, ["doctor"]);
  const other = await staff(a, ["doctor"]);
  const profileId = await saveDoctorProfile(a.ctx, doctor.membershipId, { specialty: "cardiology", defaultSlotMinutes: 30, acceptsOnlineBooking: true }, META);
  const otherId = await saveDoctorProfile(a.ctx, other.membershipId, { specialty: "therapy", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
  // Doctor works 09:00-12:00 three days from now (and is off four days from now).
  const day = addDays(todayIn(TZ), 3);
  await addScheduleBlock(a.ctx, profileId, { weekday: isoWeekday(day), start: "09:00", end: "12:00", branchId: branch!.id }, META);
  await addScheduleBlock(a.ctx, otherId, { weekday: isoWeekday(day), start: "09:00", end: "12:00", branchId: branch!.id }, META);
  const tenant = (await portalTenant(a.slug))!;
  const patient = async (phone: string) => {
    const birthDate = `198${++n % 10}-02-0${(n % 9) + 1}`;
    const r = await registerPatient(reception.ctx, { lastName: "Sintetik", firstName: `Onlayn${n}`, birthDate, sex: "MALE" }, { confirmNotDuplicate: true }, META);
    if (!r.ok) throw new Error("patient");
    const { code } = await issuePortalCode(reception.ctx, r.id, { consentMethod: "PAPER_SIGNED" }, META);
    await activatePortalAccount(tenant, { code, birthDate, phone, password: PATIENT_PW, confirmPassword: PATIENT_PW }, META);
    const login = await loginPatient(tenant, phone, PATIENT_PW, META);
    if (!login.ok) throw new Error(login.reason);
    return { id: r.id, p: (await validatePatientSession(login.token))! };
  };
  const at = (hhmm: string, d = day) => localToInstant(d, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)), TZ).toISOString();
  return { a, branch: branch!, reception, profileId, otherId, day, patient, at, tenant, doctorMembershipId: doctor.membershipId };
}

describe("patient portal self-booking", () => {
  it("lists only doctors who accept online booking, shows free slots and books one inside PostgreSQL", async () => {
    const s = await setup();
    const { p, id } = await s.patient(`+99890${String(Date.now()).slice(-7)}`);

    const doctors = await bookableDoctors(p);
    expect(doctors.map((d) => d.id)).toEqual([s.profileId]); // the other doctor did not opt in

    // Someone else already holds 09:30 (front desk booking).
    const other = await registerPatient(s.reception.ctx, { lastName: "Sintetik", firstName: `Band${n}`, birthDate: "1970-01-01", sex: "FEMALE" }, { confirmNotDuplicate: true }, META);
    if (!other.ok) throw new Error("x");
    await bookAppointment(s.reception.ctx, { patientId: other.id, doctorProfileId: s.profileId, startsAt: s.at("09:30") }, META);

    const avail = await availableDays(p, s.profileId, { maxDays: 10 });
    const day = avail.days.find((d) => d.date === s.day)!;
    expect(day.slots).toEqual([s.at("09:00"), s.at("10:00"), s.at("10:30"), s.at("11:00"), s.at("11:30")]);

    await bookOnline(p, { doctorId: s.profileId, startsAt: s.at("10:00") }, META);
    const appts = await listDay(s.reception.ctx, s.day);
    const mine = appts.find((x) => x.patientId === id)!;
    expect(mine).toMatchObject({ source: "PORTAL", status: "BOOKED", createdById: null });
    expect(new Date(mine.endsAt).getTime() - new Date(mine.startsAt).getTime()).toBe(30 * 60_000);

    // Same time again, a taken time, an unaligned time, a time outside hours, a doctor who did not opt in.
    await expect(bookOnline(p, { doctorId: s.profileId, startsAt: s.at("10:00") }, META)).rejects.toThrow("errors.slotTaken");
    await expect(bookOnline(p, { doctorId: s.profileId, startsAt: s.at("09:30") }, META)).rejects.toThrow("errors.slotTaken");
    await expect(bookOnline(p, { doctorId: s.profileId, startsAt: s.at("10:10") }, META)).rejects.toThrow("errors.outsideSchedule");
    await expect(bookOnline(p, { doctorId: s.profileId, startsAt: s.at("11:45") }, META)).rejects.toThrow("errors.outsideSchedule");
    await expect(bookOnline(p, { doctorId: s.otherId, startsAt: s.at("10:00") }, META)).rejects.toThrow("errors.doctorUnavailable");

    // The patient can still cancel their own online booking.
    await cancelMyAppointment(p, mine.id, META);
  });

  it("a buffer between appointments moves every slot on the desk and online, and online booking follows it", async () => {
    const s = await setup();
    const { p } = await s.patient(`+99894${String(Date.now()).slice(-7)}`);
    // 30-minute visits + 5-minute buffer inside 09:00-12:00: 09:00, 09:35, 10:10, 10:45, 11:20 (11:55 would not fit).
    await saveDoctorProfile(s.a.ctx, s.doctorMembershipId, { specialty: "cardiology", defaultSlotMinutes: 30, bufferMinutes: 5, acceptsOnlineBooking: true }, META);
    await expect(saveDoctorProfile(s.a.ctx, s.doctorMembershipId, { specialty: "cardiology", defaultSlotMinutes: 30, bufferMinutes: 45, acceptsOnlineBooking: true }, META)).rejects.toThrow();
    const expected = ["09:00", "09:35", "10:10", "10:45", "11:20"].map((x) => s.at(x));
    expect((await doctorSlots(s.a.ctx, s.profileId, s.day)).map((x) => x.start.toISOString())).toEqual(expected);
    expect((await availableDays(p, s.profileId, { maxDays: 10 })).days.find((d) => d.date === s.day)!.slots).toEqual(expected);
    await expect(bookOnline(p, { doctorId: s.profileId, startsAt: s.at("09:30") }, META)).rejects.toThrow("errors.outsideSchedule"); // the old grid
    await bookOnline(p, { doctorId: s.profileId, startsAt: s.at("09:35") }, META);
  });

  it("applies the clinic's rules: how far ahead, how soon, how many, days off", async () => {
    const s = await setup();
    const { p } = await s.patient(`+99891${String(Date.now()).slice(-7)}`);
    await updateClinicPolicy(s.a.ctx, { maxDiscountPercent: 100, discountReasonRequired: false, onlineBookingDays: 2, onlineBookingLeadHours: 1, onlineBookingMaxActive: 1 }, META);
    await expect(bookOnline(p, { doctorId: s.profileId, startsAt: s.at("09:00") }, META)).rejects.toThrow("errors.bookingTooFar"); // 3 days ahead > 2
    await updateClinicPolicy(s.a.ctx, { maxDiscountPercent: 100, discountReasonRequired: false, onlineBookingDays: 30, onlineBookingLeadHours: 1, onlineBookingMaxActive: 1 }, META);
    await bookOnline(p, { doctorId: s.profileId, startsAt: s.at("09:00") }, META);
    await expect(bookOnline(p, { doctorId: s.profileId, startsAt: s.at("11:00") }, META)).rejects.toThrow("errors.bookingTooMany");

    // A day off removes the slots and refuses bookings; the reason is never shown to the patient.
    const off = addDays(s.day, 7);
    await addScheduleException(s.a.ctx, s.profileId, { date: off, kind: "VACATION" }, META);
    const { p: p2 } = await s.patient(`+99893${String(Date.now()).slice(-7)}`);
    expect((await availableDays(p2, s.profileId, { from: off, maxDays: 1 })).days.find((d) => d.date === off)).toBeUndefined();
    await expect(bookOnline(p2, { doctorId: s.profileId, startsAt: s.at("09:00", off) }, META)).rejects.toThrow("errors.outsideSchedule");
  });

  it("the portal role still cannot read other patients' appointments; busy times carry no identities", async () => {
    const s = await setup();
    const c = new pg.Client({ host: "localhost", port: Number(process.env.TEST_PG_PORT ?? 54339), user: "itopmed_portal", password: "test-portal", database: "itopmed" });
    await c.connect();
    // Without a patient session every function returns nothing.
    expect((await c.query(`SELECT * FROM portal_booking_doctors()`)).rows).toEqual([]);
    expect((await c.query(`SELECT * FROM portal_booking_busy($1, now()::timestamp, (now() + interval '10 days')::timestamp)`, [s.profileId])).rows).toEqual([]);
    expect((await c.query(`SELECT portal_book(gen_random_uuid(), $1, (now() + interval '3 days')::timestamp) AS r`, [s.profileId])).rows[0].r).toBe("forbidden");
    await expect(c.query(`SELECT "patientId" FROM "Appointment" LIMIT 1`)).resolves.toMatchObject({ rows: [] });
    await expect(c.query(`INSERT INTO "Appointment" (id) VALUES (gen_random_uuid())`)).rejects.toThrow(/permission denied/);
    await c.end();
  });
});

describe("Telegram notifications", () => {
  it("ITop Med connects the clinic's bot; a patient links their chat with a one-time code; reminders go to Telegram; disconnect stops them", async () => {
    const s = await setup();
    const { p, id } = await s.patient(`+99894${String(Date.now()).slice(-7)}`);
    expect((await myTelegram(p)).bot).toBeNull();
    await expect(createTelegramLink(p, META)).rejects.toThrow("errors.telegramOff");

    const admin = await platformActor();
    await expect(connectClinicBot(admin, s.a.tenantId, { token: "not-a-token" }, META)).rejects.toThrow();
    await expect(connectClinicBot(await platformActor("SUPPORT"), s.a.tenantId, { token: FAKE_TOKEN }, META)).rejects.toThrow("errors.forbidden");
    const { username } = await connectClinicBot(admin, s.a.tenantId, { token: FAKE_TOKEN }, META); // dev-outbox transport in tests: SIMULATED
    expect(username).toBe("itopmed_simulated_bot");
    expect(await clinicBotStatus(admin, s.a.tenantId)).toMatchObject({ username, enabled: true });
    // The token is stored encrypted; the platform role hands it over but cannot read the bot table at all.
    const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.connect();
    const stored = (await owner.query(`SELECT "tokenEnc" FROM "TelegramBot" WHERE "tenantId" = $1`, [s.a.tenantId])).rows[0].tokenEnc as string;
    expect(stored).not.toContain("synthetic-test-token");
    await expect(platformDb().$queryRawUnsafe(`SELECT count(*) FROM "TelegramBot"`)).rejects.toThrow(/permission denied/);

    const link = await createTelegramLink(p, META);
    expect(link).toMatch(/^https:\/\/t\.me\/itopmed_simulated_bot\?start=[a-z2-7]+$/);
    const code = link.split("start=")[1]!;
    expect(await handleTelegramStart(s.a.tenantId, "wrongcodewrongcodewrong", 111n)).toBe(false);
    expect(await handleTelegramStart(s.a.tenantId, code, 424242n)).toBe(true);
    expect(await handleTelegramStart(s.a.tenantId, code, 999n)).toBe(false); // single use
    expect((await myTelegram(p)).linked).not.toBeNull();
    expect((await telegramStatus(s.a.ctx)).linkedPatients).toBe(1);

    // A booking now queues a Telegram confirmation, delivered by the worker (simulated outbox).
    await bookAppointment(s.reception.ctx, { patientId: id, doctorProfileId: s.profileId, startsAt: s.at("11:00") }, META);
    const before = fs.existsSync(path.join(process.cwd(), ".dev-mailbox", "telegram")) ? fs.readdirSync(path.join(process.cwd(), ".dev-mailbox", "telegram")).length : 0;
    await processDueNotifications(s.a.tenantId);
    const rows = (await owner.query(`SELECT channel, kind, status, transport FROM "Notification" WHERE "patientId" = $1 AND channel = 'TELEGRAM' ORDER BY "createdAt"`, [id])).rows;
    expect(rows[0]).toMatchObject({ channel: "TELEGRAM", kind: "APPOINTMENT_BOOKED", status: "SENT", transport: "telegram-dev-outbox" });
    expect(fs.readdirSync(path.join(process.cwd(), ".dev-mailbox", "telegram")).length).toBe(before + 1);
    const chats = (await owner.query(`SELECT "chatId"::text AS chat FROM "TelegramLink" WHERE "patientId" = $1 AND "revokedAt" IS NULL`, [id])).rows;
    expect(chats).toEqual([{ chat: "424242" }]);

    // The patient disconnects: link revoked and consent withdrawn, so nothing more is queued.
    await disconnectMyTelegram(p, META);
    expect((await myTelegram(p)).linked).toBeNull();
    const consent = (await owner.query(`SELECT count(*)::int AS c FROM "PatientConsent" WHERE "patientId" = $1 AND purpose = 'TELEGRAM_NOTIFICATIONS' AND "withdrawnAt" IS NULL`, [id])).rows[0].c;
    expect(consent).toBe(0);
    await owner.end();
    const reachable = await withAppContext({ tenantId: s.a.tenantId }, (tx) => tx.telegramLink.count({ where: { patientId: id, revokedAt: null } }));
    expect(reachable).toBe(0);
  });
});
