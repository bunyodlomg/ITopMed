import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectClinicBot } from "@/server/telegram/clinic-bot";
import { homeForRoles } from "@/server/auth/landing";
import { resolveWebApp, verifyInitData } from "@/server/auth/telegram-webapp";
import { addStaffMember } from "@/server/clinic/admin";
import { resetEnvCache } from "@/server/env";
import { registerPatient } from "@/server/patients/patients";
import { activatePortalAccount, portalTenant, saveTelegramContact, validatePatientSession } from "@/server/portal/auth";
import { issuePortalCode } from "@/server/portal/staff";
import { ownContact } from "@/server/telegram/central-bot";
import { clinicBotState } from "@/server/notifications/telegram";
import { withAppContext } from "@/server/db";
import { handleBotUpdate } from "@/server/telegram/updates";
import { META, PASSWORD, clinicContext, clinicWithOwner, platformActor, uniq } from "./helpers/fixtures";

// Synthetic bot token (format only; not a real bot). All people and phones are synthetic.
const TOKEN = "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const now = () => Math.floor(Date.now() / 1000);
const newTgId = () => Math.floor(Math.random() * 1e12) + 1;
const newPhone = () => `+99890${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

/** Launch data exactly as Telegram signs it for a Mini App. */
function initData(user: Record<string, unknown>, opts: { authDate?: number; token?: string } = {}) {
  const fields: Record<string, string> = { auth_date: String(opts.authDate ?? now()), query_id: "AAE-synthetic", user: JSON.stringify(user) };
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(opts.token ?? TOKEN).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

beforeAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  resetEnvCache();
});
afterAll(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  resetEnvCache();
});

describe("Mini App launch data", () => {
  it("accepts Telegram's signature and refuses anything else", () => {
    expect(verifyInitData(initData({ id: 42 }), TOKEN)).toBe(42n);
    expect(verifyInitData(initData({ id: 42 }, { token: "999:other" }), TOKEN)).toBeNull();
    expect(verifyInitData(initData({ id: 42 }).replace("42", "43"), TOKEN)).toBeNull();
    expect(verifyInitData(initData({ id: 42 }, { authDate: now() - 3 * 86400 }), TOKEN)).toBeNull();
    expect(verifyInitData(initData({ id: 42, is_bot: true }), TOKEN)).toBeNull();
    expect(verifyInitData("", TOKEN)).toBeNull();
  });

  it("the bot accepts only a person's own phone number", () => {
    const own = { message: { chat: { id: 5, type: "private" }, from: { id: 5, is_bot: false }, contact: { phone_number: "998901112233", user_id: 5 } } };
    expect(ownContact(own)).toEqual({ tgId: 5n, phone: "998901112233" });
    expect(ownContact({ message: { ...own.message, contact: { phone_number: "998901112233", user_id: 6 } } })).toBeNull();
    expect(ownContact({ message: { ...own.message, contact: { phone_number: "998901112233" } } })).toBeNull();
    expect(ownContact({ message: { ...own.message, chat: { id: -1, type: "group" } } })).toBeNull();
  });
});

describe("who opened a clinic bot's Mini App", () => {
  /** A clinic with its own bot (token `botToken`), a receptionist and a way to add portal patients. */
  async function clinic() {
    const o = await clinicWithOwner(await platformActor());
    const botToken = `${Math.floor(Math.random() * 9e9) + 1e9}:${"B".repeat(35)}`;
    await connectClinicBot(await platformActor(), o.tenantId, { token: botToken }, META);
    const recLogin = uniq("reception");
    await addStaffMember(o.ctx, { fullName: "Synthetic Reception", username: recLogin, roleKeys: ["receptionist"], password: PASSWORD }, META);
    const reception = await clinicContext(recLogin, o.slug);
    const tenant = (await portalTenant(o.slug))!;
    /** A patient with an activated portal account whose login is `phone`. */
    const patient = async (phone: string) => {
      const birthDate = "1990-04-12";
      const p = await registerPatient(reception, { lastName: "Sintetik", firstName: uniq("Bemor"), birthDate, sex: "FEMALE" }, { confirmNotDuplicate: true }, META);
      if (!p.ok) throw new Error("patient");
      const { code } = await issuePortalCode(reception, p.id, { consentMethod: "PAPER_SIGNED" }, META);
      await activatePortalAccount(tenant, { code, birthDate, phone, password: "Bemor-Parol-2026x", confirmPassword: "Bemor-Parol-2026x" }, META);
    };
    /** Only a patient card with this phone: no portal code was ever issued. */
    const card = async (phone: string, firstName = uniq("Bemor")) => {
      const p = await registerPatient(reception, { lastName: "Sintetik", firstName, birthDate: "1988-02-03", sex: "MALE", phone }, { confirmNotDuplicate: true }, META);
      if (!p.ok) throw new Error("patient");
      return p.id;
    };
    const launch = (id: number) => initData({ id }, { token: botToken });
    return { o, reception, patient, card, launch, slug: o.slug };
  }

  it("a stranger gets the patient page; after sharing an unknown number: not found", async () => {
    const c = await clinic();
    const tg = newTgId();
    expect(await resolveWebApp(c.launch(tg), null, META, c.slug)).toEqual({ status: "patient", phoneKnown: false });
    expect(await saveTelegramContact(BigInt(tg), newPhone())).toBe(true);
    expect(await resolveWebApp(c.launch(tg), null, META, c.slug)).toEqual({ status: "patient", phoneKnown: true });
    // Launch data signed by another bot is refused.
    expect(await resolveWebApp(initData({ id: tg }), null, META, c.slug)).toEqual({ status: "error", reason: "invalid" });
  });

  it("a patient of this clinic lands in its portal; a patient of another clinic is not recognised here", async () => {
    const c = await clinic();
    const phone = newPhone();
    await c.patient(phone);
    const tg = newTgId();
    // Telegram sends the number without "+"; it is normalised.
    await saveTelegramContact(BigInt(tg), phone.slice(1));
    const r = await resolveWebApp(c.launch(tg), null, META, c.slug);
    expect(r).toMatchObject({ status: "signed_in", target: "patient", go: `/p/${c.slug}` });
    if (r.status === "signed_in") expect((await validatePatientSession(r.token))?.tenant.slug).toBe(c.slug);
    const other = await clinic();
    expect(await resolveWebApp(other.launch(tg), null, META, other.slug)).toEqual({ status: "patient", phoneKnown: true });
  });

  it("a patient card with the Telegram-verified phone opens the portal without a code; a family picks the card", async () => {
    const c = await clinic();
    const phone = newPhone();
    await c.card(phone, "Ali");
    const tg = newTgId();
    await saveTelegramContact(BigInt(tg), phone.slice(1));
    const r = await resolveWebApp(c.launch(tg), null, META, c.slug);
    expect(r).toMatchObject({ status: "signed_in", target: "patient", go: `/p/${c.slug}` });
    if (r.status === "signed_in") expect((await validatePatientSession(r.token))?.patient.firstName).toBe("Ali");
    // A second card with the same phone (a child): now the person chooses, by first name.
    await c.card(phone, "Vali");
    const r2 = await resolveWebApp(c.launch(tg), null, META, c.slug);
    expect(r2.status).toBe("choose");
    if (r2.status !== "choose") return;
    expect(r2.choices.map((x) => x.patient)).toEqual(["Ali S.", "Vali S."]);
    const vali = await resolveWebApp(c.launch(tg), r2.choices[1]!.key, META, c.slug);
    if (vali.status !== "signed_in") throw new Error(vali.status);
    expect((await validatePatientSession(vali.token))?.patient.firstName).toBe("Vali");
    // A forged choice is refused; another clinic's bot does not see these cards.
    expect(await resolveWebApp(c.launch(tg), "patient:00000000-0000-0000-0000-000000000000", META, c.slug)).toMatchObject({ status: "choose" });
    const other = await clinic();
    expect(await resolveWebApp(other.launch(tg), null, META, other.slug)).toEqual({ status: "patient", phoneKnown: true });
  });

  it("sharing the phone in the bot chat links the chat to every card with that number", async () => {
    const c = await clinic();
    const phone = newPhone();
    const a = await c.card(phone);
    const b = await c.card(phone);
    const state = (await clinicBotState(c.o.tenantId))!;
    const tg = newTgId();
    const contact = (user: number, from = tg) => ({ update_id: 3, message: { chat: { id: from, type: "private" }, from: { id: from, is_bot: false }, contact: { phone_number: phone.slice(1), user_id: user } } });
    // Someone else's contact is not accepted.
    expect(await handleBotUpdate(c.o.tenantId, contact(tg + 1), state)).toBe(false);
    expect(await handleBotUpdate(c.o.tenantId, contact(tg), state)).toBe(true);
    const links = await withAppContext({ tenantId: c.o.tenantId }, (tx) => tx.telegramLink.findMany({ where: { tenantId: c.o.tenantId, chatId: BigInt(tg), revokedAt: null }, select: { patientId: true } }));
    expect(links.map((l) => l.patientId).sort()).toEqual([a, b].sort());
    // The portal is open too: the Mini App offers both cards.
    expect(await resolveWebApp(c.launch(tg), null, META, c.slug)).toMatchObject({ status: "choose" });
    // An unknown number links nothing.
    const stranger = newTgId();
    const unknown = { update_id: 4, message: { chat: { id: stranger, type: "private" }, from: { id: stranger, is_bot: false }, contact: { phone_number: newPhone().slice(1), user_id: stranger } } };
    expect(await handleBotUpdate(c.o.tenantId, unknown, state)).toBe(false);
  });

  it("staff never sign in through the Mini App (login + password only); the landing page per role is unchanged", async () => {
    const c = await clinic();
    // Even the receptionist's own Telegram, opened in this clinic's bot, is just a stranger here.
    expect(await resolveWebApp(c.launch(newTgId()), "staff", META, c.slug)).toEqual({ status: "patient", phoneKnown: false });
    expect(homeForRoles("x", ["clinic_owner", "doctor"])).toBe("/c/x");
    expect(homeForRoles("x", ["doctor"])).toBe("/c/x/my-queue");
    expect(homeForRoles("x", ["cashier"])).toBe("/c/x/billing");
  });
});

describe("the central ITop Med bot", () => {
  it("signs nobody in: its Mini App is gone", async () => {
    expect(await resolveWebApp(initData({ id: newTgId() }), null, META)).toEqual({ status: "error", reason: "disabled" });
  });
});
