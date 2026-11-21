import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { parseReadingText, readingBand } from "@/lib/bp";
import { bookAppointment, markNoShow, registerWalkIn } from "@/server/appointments/appointments";
import { addStaffMember, listBranches, listStaff } from "@/server/clinic/admin";
import { addScheduleBlock, saveDoctorProfile } from "@/server/clinic/doctors";
import { withAppContext } from "@/server/db";
import { recentCheckIns, visitCheckIn } from "@/server/emr/checkins";
import { addPrescription, cancelPrescription } from "@/server/emr/prescriptions";
import { addMyReading, listMyReadings, patientReadings } from "@/server/emr/readings";
import { finishEncounter, getEncounter, signNote, startVisit } from "@/server/emr/record";
import { listNotifications, medicationSlots, processDueNotifications, scheduleMedicationReminders } from "@/server/notifications/notifications";
import { clinicBotState, createTelegramLink, handleTelegramStart } from "@/server/notifications/telegram";
import { registerPatient } from "@/server/patients/patients";
import { activatePortalAccount, loginPatient, portalTenant, validatePatientSession } from "@/server/portal/auth";
import { listMyMedicines } from "@/server/portal/medicines";
import { issuePortalCode } from "@/server/portal/staff";
import { localToInstant, todayIn, addDays, instantToLocalDate } from "@/server/scheduling/time";
import { startedSlot } from "./helpers/slots";
import { connectClinicBot } from "@/server/telegram/clinic-bot";
import { handleBotUpdate, type TgUpdate } from "@/server/telegram/updates";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

const TZ = "Asia/Tashkent";
const PATIENT_PW = "Bemor-Parol-2026x";
const FAKE_TOKEN = "123456789:AAH-synthetic-test-token-0123456789abcdef";
const OUTBOX = path.join(process.cwd(), ".dev-mailbox", "telegram");

/** SIMULATED Telegram messages (dev-outbox transport) written to one chat. */
function chatMessages(chatId: bigint): string[] {
  if (!fs.existsSync(OUTBOX)) return [];
  return fs
    .readdirSync(OUTBOX)
    .filter((f) => f.endsWith(`_chat-${chatId}.txt`))
    .sort()
    .map((f) => fs.readFileSync(path.join(OUTBOX, f), "utf8"));
}

async function staff(o: Awaited<ReturnType<typeof clinicWithOwner>>, roleKeys: string[]) {
  const login = uniq("s");
  await addStaffMember(o.ctx, { fullName: `Synthetic ${roleKeys[0]}`, username: login, roleKeys, password: PASSWORD }, META);
  const m = (await listStaff(o.ctx)).members.find((x) => x.user.username === login)!;
  return { login, membershipId: m.id, ctx: await clinicContext(login, o.slug) };
}

let n = 0;
let chatSeq = 0;
/** A clinic with a connected (simulated) bot, a doctor, and a portal patient whose Telegram chat is linked. */
async function setup() {
  const a = await clinicWithOwner(await platformActor());
  const [branch] = await listBranches(a.ctx);
  const reception = await staff(a, ["receptionist"]);
  const doctor = await staff(a, ["doctor"]);
  const other = await staff(a, ["doctor"]);
  const profileId = await saveDoctorProfile(a.ctx, doctor.membershipId, { specialty: "cardiology", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
  await saveDoctorProfile(a.ctx, other.membershipId, { specialty: "therapy", defaultSlotMinutes: 20, acceptsOnlineBooking: false }, META);
  for (let d = 1; d <= 7; d++) await addScheduleBlock(a.ctx, profileId, { weekday: d, start: "00:00", end: "24:00", branchId: branch!.id }, META);
  await connectClinicBot(await platformActor(), a.tenantId, { token: FAKE_TOKEN }, META);

  const birthDate = `197${++n % 10}-03-0${(n % 9) + 1}`;
  const phone = `+99893${String(1000000 + n * 7717 + (Date.now() % 997)).slice(-7)}`;
  const r = await registerPatient(reception.ctx, { lastName: "Sintetik", firstName: `Telegram${n}`, birthDate, sex: "FEMALE", phone }, { confirmNotDuplicate: true }, META);
  if (!r.ok) throw new Error("patient");
  const tenant = (await portalTenant(a.slug))!;
  const { code } = await issuePortalCode(reception.ctx, r.id, { consentMethod: "PAPER_SIGNED" }, META);
  await activatePortalAccount(tenant, { code, birthDate, phone, password: PATIENT_PW, confirmPassword: PATIENT_PW }, META);
  const login = await loginPatient(tenant, phone, PATIENT_PW, META);
  if (!login.ok) throw new Error(login.reason);
  const p = (await validatePatientSession(login.token))!;
  const chatId = BigInt(880_000_000 + Date.now() % 100_000_000 + ++chatSeq);
  const link = await createTelegramLink(p, META);
  expect(await handleTelegramStart(a.tenantId, link.split("start=")[1]!, chatId)).toBe(true);
  const state = (await clinicBotState(a.tenantId))!;
  const doctorCtx = await clinicContext(doctor.login, a.slug);
  return { a, branch: branch!, reception, doctorCtx, otherCtx: await clinicContext(other.login, a.slug), profileId, doctorMembershipId: doctor.membershipId, patientId: r.id, p, chatId, state };
}

/** A visit that has just started (5-minute slot), valid at any hour — see startedSlot. */
async function startedVisit(s: Awaited<ReturnType<typeof setup>>) {
  await saveDoctorProfile(s.a.ctx, s.doctorMembershipId, { specialty: "cardiology", defaultSlotMinutes: 5, acceptsOnlineBooking: false }, META);
  return startedSlot(TZ, 5);
}

const textUpdate = (chatId: bigint, text: string): TgUpdate => ({ update_id: 1, message: { chat: { id: Number(chatId), type: "private" }, from: { id: Number(chatId) }, date: Math.floor(Date.now() / 1000), text } });
const buttonUpdate = (chatId: bigint, data: string): TgUpdate => ({ update_id: 2, callback_query: { id: "cb1", from: { id: Number(chatId) }, data, message: { message_id: 7, chat: { id: Number(chatId), type: "private" } } } });

/** A visit of the doctor with a signed note (the visit can be closed). */
async function visit(s: Awaited<ReturnType<typeof setup>>) {
  const appt = await registerWalkIn(s.reception.ctx, { patientId: s.patientId, doctorProfileId: s.profileId, branchId: s.branch.id }, META);
  const enc = await startVisit(s.doctorCtx, appt, META);
  const note = (await getEncounter(s.doctorCtx, enc, META)).encounter.notes[0]!;
  await signNote(s.doctorCtx, note.id, { complaints: "Synthetic", history: "", examination: "", assessment: "Synthetic", plan: "" }, META);
  return enc;
}

describe("home blood pressure text", () => {
  it("parses the usual ways patients write it and rejects anything ambiguous", () => {
    expect(parseReadingText("135/85 72")).toEqual({ systolic: 135, diastolic: 85, pulse: 72 });
    expect(parseReadingText("135/85")).toEqual({ systolic: 135, diastolic: 85, pulse: null });
    expect(parseReadingText("135 85 72")).toEqual({ systolic: 135, diastolic: 85, pulse: 72 });
    expect(parseReadingText("AD 150/95, puls 80")).toEqual({ systolic: 150, diastolic: 95, pulse: 80 });
    expect(parseReadingText("давление 120/80 пульс 64")).toEqual({ systolic: 120, diastolic: 80, pulse: 64 });
    expect(parseReadingText("85/135")).toBeNull(); // lower above upper
    expect(parseReadingText("1358572")).toBeNull();
    expect(parseReadingText("salom")).toBeNull();
    expect(parseReadingText("400/90")).toBeNull();
    expect(parseReadingText("135/85 5")).toBeNull();
    expect(readingBand({ systolic: 185, diastolic: 100 })).toBe("veryHigh");
    expect(readingBand({ systolic: 138, diastolic: 80 })).toBe("high");
    expect(readingBand({ systolic: 118, diastolic: 76 })).toBe("normal");
    expect(readingBand({ systolic: 85, diastolic: 55 })).toBe("low");
  });
});

describe("Telegram care", () => {
  it("a linked chat sends blood pressure; the reply repeats no values; the treating doctor sees it; the portal adds its own", async () => {
    const s = await setup();
    await handleBotUpdate(s.a.tenantId, textUpdate(s.chatId, "142/91 76"), s.state);
    await handleBotUpdate(s.a.tenantId, textUpdate(s.chatId, "salom doktor"), s.state);
    // An unknown chat cannot send readings for anyone.
    await handleBotUpdate(s.a.tenantId, textUpdate(123456789n, "120/80 60"), s.state);
    const replies = chatMessages(s.chatId).join("\n");
    expect(replies).toMatch(/135\/85 72/); // the format hint
    expect(replies).not.toMatch(/142|91\b/);

    await addMyReading(s.p, { systolic: "128", diastolic: "82", pulse: "" }, META);
    await expect(addMyReading(s.p, { systolic: "80", diastolic: "120", pulse: "" }, META)).rejects.toThrow();
    expect((await listMyReadings(s.p)).map((r) => [r.systolic, r.diastolic, r.pulse, r.source]).sort()).toEqual([
      [128, 82, null, "PORTAL"],
      [142, 91, 76, "TELEGRAM"],
    ]);

    // The doctor needs a care relationship (a visit) to see them; another doctor without one cannot.
    await visit(s);
    expect((await patientReadings(s.doctorCtx, s.patientId, META)).length).toBe(2);
    await expect(patientReadings(s.otherCtx, s.patientId, META)).rejects.toThrow("errors.noCareRelationship");

    // The portal role sees nothing without a patient session and cannot write for others.
    const c = new pg.Client({ host: "localhost", port: Number(process.env.TEST_PG_PORT ?? 54339), user: "itopmed_portal", password: "test-portal", database: "itopmed" });
    await c.connect();
    expect((await c.query(`SELECT count(*)::int AS c FROM "PatientReading"`)).rows[0].c).toBe(0);
    await expect(c.query(`INSERT INTO "PatientReading" (id, "tenantId", "patientId", systolic, diastolic, "measuredAt", source) VALUES (gen_random_uuid(), $1, $2, 120, 80, now(), 'PORTAL')`, [s.a.tenantId, s.patientId])).rejects.toThrow(/row-level security/);
    await expect(c.query(`SELECT count(*) FROM "VisitCheckIn"`)).rejects.toThrow(/permission denied/);
    await c.end();
  });

  it("a missed visit gets an offer to book again, unless the patient already booked", async () => {
    const s = await setup();
    const now = (await startedVisit(s)).toISOString();
    const appt = await bookAppointment(s.reception.ctx, { patientId: s.patientId, doctorProfileId: s.profileId, startsAt: now }, META);
    await markNoShow(s.reception.ctx, appt, META);
    const rows = (await listNotifications(s.a.ctx)).rows.filter((r) => r.kind === "NO_SHOW_REBOOK");
    expect(rows.map((r) => r.channel).sort()).toEqual(["TELEGRAM"]);
    await processDueNotifications(s.a.tenantId);
    const sent = (await listNotifications(s.a.ctx)).rows.filter((r) => r.kind === "NO_SHOW_REBOOK");
    expect(sent.map((r) => r.status)).toEqual(["SENT"]);
    expect(chatMessages(s.chatId).join("\n")).toMatch(/\/p\/[a-z0-9-]+\/book/);

  });

  it("no offer when the patient has already booked again", async () => {
    const s = await setup();
    const now = await startedVisit(s);
    const appt = await bookAppointment(s.reception.ctx, { patientId: s.patientId, doctorProfileId: s.profileId, startsAt: now.toISOString() }, META);
    await markNoShow(s.reception.ctx, appt, META);
    await bookAppointment(s.reception.ctx, { patientId: s.patientId, doctorProfileId: s.profileId, startsAt: new Date(now.getTime() + 2 * 86_400_000).toISOString() }, META);
    await processDueNotifications(s.a.tenantId);
    const rows = (await listNotifications(s.a.ctx)).rows.filter((r) => r.kind === "NO_SHOW_REBOOK");
    expect(rows.map((r) => [r.status, r.lastError])).toEqual([["SKIPPED", "rebooked"]]);
  });

  it("five days after a visit the patient is asked; only their own chat can answer, once; the doctor sees worse first", async () => {
    const s = await setup();
    const enc = await visit(s);
    await finishEncounter(s.doctorCtx, enc, META);
    const askAt = localToInstant(addDays(todayIn(TZ), 5), 10 * 60, TZ);
    const rows = (await listNotifications(s.a.ctx)).rows.filter((r) => r.kind === "VISIT_CHECKIN");
    expect(rows.map((r) => [r.channel, r.dueAt.toISOString()])).toEqual([["TELEGRAM", askAt.toISOString()]]); // never SMS
    expect(await visitCheckIn(s.doctorCtx, s.patientId, enc, META)).toMatchObject({ answer: null });

    await processDueNotifications(s.a.tenantId, { now: new Date(askAt.getTime() + 60_000) });
    const msg = chatMessages(s.chatId).find((m) => m.includes("callback:ci:"))!;
    expect(msg).toBeDefined();
    const checkInId = /callback:ci:([0-9a-f-]{36}):W/.exec(msg)![1]!;

    // A stranger's chat pressing the same button changes nothing.
    await handleBotUpdate(s.a.tenantId, buttonUpdate(999_111_222n, `ci:${checkInId}:B`), s.state);
    expect(await visitCheckIn(s.doctorCtx, s.patientId, enc, META)).toMatchObject({ answer: null });
    await handleBotUpdate(s.a.tenantId, buttonUpdate(s.chatId, `ci:${checkInId}:W`), s.state);
    await handleBotUpdate(s.a.tenantId, buttonUpdate(s.chatId, `ci:${checkInId}:B`), s.state); // second press ignored
    expect(await visitCheckIn(s.doctorCtx, s.patientId, enc, META)).toMatchObject({ answer: "WORSE" });

    expect((await recentCheckIns(s.doctorCtx, META)).map((c) => [c.encounterId, c.answer])).toEqual([[enc, "WORSE"]]);
    expect(await recentCheckIns(s.otherCtx, META)).toEqual([]);
    await expect(recentCheckIns(s.reception.ctx, META)).rejects.toThrow("errors.forbidden");
  });

  it("medicine reminders follow the intake times, never name the medicine, stop with the prescription or the patient's button", async () => {
    const s = await setup();
    const enc = await visit(s);
    const rx = await addPrescription(s.doctorCtx, enc, { drug: "Sintetikol 5 mg", inn: "sintetikol", dose: "1/2 tabletka", frequency: "kuniga 2 marta", times: "08:00, 20:00", durationDays: "3" }, META);
    expect((await listMyMedicines(s.p)).map((m) => [m.drug, m.times])).toEqual([["Sintetikol 5 mg", "08:00, 20:00"]]);

    const now = new Date();
    expect(await scheduleMedicationReminders(s.a.tenantId, now)).toBeGreaterThanOrEqual(2);
    expect(await scheduleMedicationReminders(s.a.tenantId, now)).toBe(0); // idempotent
    const pending = (await listNotifications(s.a.ctx)).rows.filter((r) => r.kind === "MEDICATION_REMINDER").sort((x, y) => +x.dueAt - +y.dueAt);
    expect(pending.every((r) => r.channel === "TELEGRAM")).toBe(true);
    for (const r of pending) expect(["08:00", "20:00"]).toContain(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TZ }).format(r.dueAt));

    const first = pending[0]!.dueAt;
    await processDueNotifications(s.a.tenantId, { now: new Date(first.getTime() + 60_000) });
    const msgs = chatMessages(s.chatId).filter((m) => m.includes("callback:mr:off"));
    expect(msgs.length).toBe(1);
    expect(msgs[0]).not.toMatch(/sintetikol/i);
    expect(msgs[0]).toMatch(/\/tg\/[a-z0-9-]+\?next=medicines/);

    // The patient stops them: pending ones are dropped, no new ones are queued.
    await handleBotUpdate(s.a.tenantId, buttonUpdate(s.chatId, "mr:off"), s.state);
    expect((await listNotifications(s.a.ctx)).rows.filter((r) => r.kind === "MEDICATION_REMINDER" && r.status === "PENDING")).toEqual([]);
    expect(await scheduleMedicationReminders(s.a.tenantId, new Date(now.getTime() + 86_400_000))).toBe(0);
    await handleBotUpdate(s.a.tenantId, buttonUpdate(s.chatId, "mr:on"), s.state);
    expect(await scheduleMedicationReminders(s.a.tenantId, new Date(now.getTime() + 86_400_000))).toBeGreaterThan(0);

    // A cancelled prescription stops its reminders at send time.
    await cancelPrescription(s.doctorCtx, rx.id, META);
    const later = (await listNotifications(s.a.ctx)).rows.filter((r) => r.kind === "MEDICATION_REMINDER" && r.status === "PENDING");
    await processDueNotifications(s.a.tenantId, { now: new Date(Math.max(...later.map((r) => +r.dueAt)) + 60_000) });
    const after = await withAppContext({ tenantId: s.a.tenantId }, (tx) => tx.notification.findMany({ where: { id: { in: later.map((r) => r.id) } }, select: { status: true } }));
    expect(after.every((r) => r.status === "SKIPPED")).toBe(true);
    expect(await listMyMedicines(s.p)).toEqual([]);
  });

  it("intake slots cover the course from the day it was written, one per time", () => {
    const createdAt = localToInstant("2026-11-20", 9 * 60, TZ);
    const slots = medicationSlots([{ createdAt, durationDays: 2, times: "08:00, 20:00" }, { createdAt, durationDays: 2, times: "20:00" }], createdAt, new Date(createdAt.getTime() + 5 * 86_400_000), TZ);
    expect(slots.map((d) => `${instantToLocalDate(d, TZ)} ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TZ }).format(d)}`)).toEqual([
      "2026-11-20 20:00",
      "2026-11-21 08:00",
      "2026-11-21 20:00",
    ]);
  });
});
