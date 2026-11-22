/**
 * Screenshots for the clinic manual (docs/pdf-src/farhod-qollanma.html). Synthetic data only,
 * LOCAL database only: opens a copy of the Farhod MedServis spec (scripts/deploy/clinics) under
 * --slug (default farhod-medservis), with an owner-doctor and a registrar account, then walks one
 * working day: settings → registrar desk → doctor's visit with the clinic's own templates →
 * prints → debt → cash → reports → test-patient removal.
 *
 *   npm run app   (in another window)
 *   npx tsx --conditions=react-server scripts/docs/farhod-screenshots.ts [--slug farhod-medservis]
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const args = process.argv.slice(2);
const SLUG = args.includes("--slug") ? args[args.indexOf("--slug") + 1]! : "farhod-medservis";
const BASE = "http://127.0.0.1:3000";
const C = `${BASE}/c/${SLUG}`;
const OUT = path.join(process.cwd(), "docs", "pdf-src", "img");
const failures: string[] = [];

async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(1300); // page-entrance motion
}
async function shot(page: Page, name: string, opts: { full?: boolean; el?: string } = {}) {
  await settle(page);
  const file = path.join(OUT, `f-${name}.png`);
  if (opts.el) await page.locator(opts.el).first().screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: opts.full ?? false });
  console.log(`  ▸ f-${name}.png`);
}
async function step(page: Page, name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`✗ ${name}: ${String(e).split("\n")[0]!.slice(0, 300)}`);
    await page.screenshot({ path: path.join(os.tmpdir(), `farhod-shot-fail-${failures.length}.png`) }).catch(() => undefined);
  }
}
async function signIn(browser: Browser, login: string, password: string, viewport = { width: 1366, height: 860 }) {
  const page = await (await browser.newContext({ viewport, deviceScaleFactor: 1.5, locale: "uz-UZ" })).newPage();
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="username"]', login);
  await page.fill('input[name="password"]', password);
  await Promise.all([page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 90_000 }), page.press('input[name="password"]', "Enter")]);
  return page;
}

async function main() {
  const { createClinicFromSpec } = await import("../lib/create-clinic");
  const { platformDb } = await import("../../src/server/db");
  if (await platformDb().tenant.findUnique({ where: { slug: SLUG } })) throw new Error(`Local clinic ${SLUG} exists already: pass another --slug (the clinic NAME on the screens stays "Farhod MedServis")`);
  const ownerLogin = `farhod.${randomBytes(2).toString("hex")}`;
  const deskLogin = `registrator.${randomBytes(2).toString("hex")}`;
  const password = `Demo-${randomBytes(6).toString("hex")}-26`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "itm-doc-"));
  const spec = JSON.parse(fs.readFileSync("scripts/deploy/clinics/farhod-medservis.json", "utf8"));
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify({ ...spec, slug: SLUG }));
  fs.copyFileSync(path.join("scripts/deploy/clinics", spec.logoFile), path.join(dir, spec.logoFile));
  await createClinicFromSpec(path.join(dir, "spec.json"), ownerLogin, "Farhod Qoraboyev", password);
  console.log(`local clinic /c/${SLUG}, owner ${ownerLogin}`);

  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge" });

  // ---------- Sign-in page ----------
  const anon = await (await browser.newContext({ viewport: { width: 1366, height: 860 }, deviceScaleFactor: 1.5 })).newPage();
  await step(anon, "login page", async () => {
    await anon.goto(`${BASE}/login`);
    await shot(anon, "01-login");
  });

  const owner = await signIn(browser, ownerLogin, password);

  // ---------- Owner: first settings ----------
  await step(owner, "home", async () => {
    await owner.goto(C);
    await shot(owner, "02-home");
  });
  await step(owner, "settings", async () => {
    await owner.goto(`${C}/settings`);
    await shot(owner, "03-settings");
  });
  await step(owner, "staff + add registrar", async () => {
    await owner.goto(`${C}/staff?panel=new`);
    await settle(owner);
    await owner.fill('input[name="fullName"]', "Dilnoza Registratorova");
    for (const r of ["receptionist", "cashier"]) await owner.locator(`input[name="roleKeys"][value="${r}"]`).check();
    await owner.fill('input[name="username"]', deskLogin);
    await owner.fill('input[name="password"]', password);
    await shot(owner, "04-staff-add");
    await owner.locator('form:has(input[name="username"]) button[type="submit"]').last().click();
    await settle(owner);
    await owner.goto(`${C}/staff`);
    await owner.getByText("Dilnoza Registratorova").first().waitFor({ timeout: 20_000 });
    await shot(owner, "05-staff");
  });
  await step(owner, "services (price list)", async () => {
    await owner.goto(`${C}/services`);
    await shot(owner, "06-services", { full: true });
  });
  await step(owner, "templates", async () => {
    await owner.goto(`${C}/templates`);
    await shot(owner, "07-templates", { full: true });
    await owner.getByText("UTT: qalqonsimon bez", { exact: true }).first().click();
    await owner.waitForURL(/\/templates\/[0-9a-f-]{36}/);
    await shot(owner, "08-template-edit");
  });
  await step(owner, "doctors and schedule", async () => {
    await owner.goto(`${C}/doctors`);
    await shot(owner, "09-doctors");
  });

  // ---------- Registrar ----------
  const desk = await signIn(browser, deskLogin, password);
  await step(desk, "desk: empty", async () => {
    await desk.goto(`${C}/desk`);
    await shot(desk, "10-desk");
  });
  const register = async (p: { last: string; first: string; year: string; sex: string; address: string; services: RegExp[]; pay: "full" | "debt"; bp: [string, string]; pulse: string; w: string; h: string }, name?: string) => {
    await desk.goto(`${C}/desk`);
    await settle(desk);
    await desk.fill('input[name="lastName"]', p.last);
    await desk.fill('input[name="firstName"]', p.first);
    await desk.fill('input[name="birthDate"]', p.year);
    await desk.selectOption('select[name="sex"]', p.sex);
    await desk.fill('input[name="address"]', p.address).catch(() => undefined);
    for (const s of p.services) await desk.locator("label").filter({ hasText: s }).locator('input[name="serviceIds"]').first().check();
    const mode = desk.locator(`input[name="payMode"][value="${p.pay}"]`);
    if (await mode.count()) await mode.check();
    // Measurements only where this account may record them.
    for (const [n, v] of [["HEIGHT", p.h], ["WEIGHT", p.w], ["SYSTOLIC_BP", p.bp[0]], ["DIASTOLIC_BP", p.bp[1]], ["HEART_RATE", p.pulse]] as const) {
      const f = desk.locator(`input[name="${n}"]`);
      if (await f.count()) await f.fill(v);
    }
    if (name) await shot(desk, name, { full: true });
    await desk.locator('form:has(input[name="lastName"]) button[type="submit"]').last().click();
    await desk.waitForURL(/done=/, { timeout: 30_000 });
  };
  await step(desk, "desk: first patient, paid", async () => {
    await register({ last: "Aliyev", first: "Botir", year: "1962", sex: "MALE", address: "Qo'rg'ontepa tumani (namuna)", services: [/Kardiolog ko'ruvi/, /^EKG/], pay: "full", bp: ["150", "95"], pulse: "84", w: "86", h: "172" }, "11-desk-filled");
    await shot(desk, "12-desk-done", { full: true });
  });
  await step(desk, "ticket", async () => {
    const href = await desk.locator('a[href*="/desk/ticket/"]').first().getAttribute("href");
    if (!href) throw new Error("no ticket link");
    await desk.goto(`${BASE}${href}`);
    await shot(desk, "13-ticket");
  });
  await step(desk, "desk: second patient, debt", async () => {
    await register({ last: "Karimova", first: "Nodira", year: "1990", sex: "FEMALE", address: "Andijon (namuna)", services: [/Bachadon va ortiqlari/], pay: "debt", bp: ["110", "70"], pulse: "76", w: "62", h: "163" });
    await register({ last: "Rahimov", first: "Sardor", year: "1975", sex: "MALE", address: "Qo'rg'ontepa (namuna)", services: [/Qalqonsimon bez/], pay: "full", bp: ["130", "85"], pulse: "70", w: "80", h: "178" });
    await desk.goto(`${C}/desk`);
    await shot(desk, "14-desk-queue", { full: true });
  });
  await step(desk, "queue page", async () => {
    await desk.goto(`${C}/queue`);
    await shot(desk, "15-queue", { full: true });
  });

  // ---------- Doctor (the owner is the doctor) ----------
  let encounterUrl = "";
  await step(owner, "my patients today", async () => {
    await owner.goto(`${C}/my-queue`);
    await shot(owner, "16-my-queue", { full: true });
    await owner.locator("main").locator("li, article, section > div, div.flex").filter({ hasText: "Aliyev" }).locator('form:has(input[name="appointmentId"]) button').last().click();
    await owner.waitForURL(/\/encounters\/[0-9a-f-]{36}/);
    encounterUrl = owner.url();
    await shot(owner, "17-visit-top");
  });
  await step(owner, "note from template, signed", async () => {
    const tplSelect = owner.locator('select:has(option:text-is("Kardiolog ko\'ruvi: ko\'rik va tavsiyalar"))').first();
    if (await tplSelect.count()) {
      await tplSelect.selectOption({ label: "Kardiolog ko'ruvi: ko'rik va tavsiyalar" });
      await owner.locator("button").filter({ hasText: /^Qo.llash$/ }).first().click();
      await owner.waitForFunction(() => ((document.querySelector('textarea[name="examination"]') as HTMLTextAreaElement | null)?.value ?? "").length > 0, null, { timeout: 20_000 });
      await settle(owner);
    }
    const complaints = owner.locator('textarea[name="complaints"]').first();
    await complaints.fill("Yurganda hansirash, bosh og'rig'i (namuna).");
    await owner.locator('textarea[name="examination"]').first().scrollIntoViewIfNeeded();
    await shot(owner, "18-note");
    const sign = owner.getByRole("button", { name: /Imzolash/ }).first();
    await sign.click();
    await settle(owner);
  });
  await step(owner, "diagnosis and prescription", async () => {
    await owner.goto(encounterUrl);
    await settle(owner);
    const dx = owner.locator('form:has(input[name="icd10Code"])').first();
    await dx.locator('[name="icd10Code"]').fill("I11.9");
    await dx.locator('[name="description"]').fill("Gipertoniya kasalligi (namuna)");
    await dx.locator('button[type="submit"]').last().click();
    await settle(owner);
    const rx = owner.locator('form:has(input[name="drug"])').first();
    await rx.locator('input[name="drug"]').fill("Bisoprolol 5 mg");
    await rx.locator('input[name="dose"]').fill("1 tabletka").catch(() => undefined);
    await rx.locator('input[name="frequency"]').fill("kuniga 1 mahal").catch(() => undefined);
    await rx.locator('button[type="submit"]').last().click();
    await settle(owner);
    await owner.goto(encounterUrl);
    await settle(owner);
    await owner.locator("#prescriptions").first().scrollIntoViewIfNeeded();
    await shot(owner, "19-dx-rx");
  });
  await step(owner, "ECG result", async () => {
    await owner.goto(encounterUrl);
    await settle(owner);
    await owner.locator("summary").filter({ hasText: /Natija qo/ }).first().click();
    const sel = owner.locator('select:has(option:text-is("Transtorakal exokardiografiya"))').first();
    await sel.selectOption({ index: (await sel.locator("option").count()) - 1 }); // "no template" -> built-in fields
    await owner.locator('select[name="kind"]').selectOption("ECG").catch(() => undefined);
    await owner.fill('[name="rhythm"]', "sinus ritm").catch(() => undefined);
    await owner.fill('[name="heartRate"]', "84").catch(() => undefined);
    await owner.fill('textarea[name="conclusion"]', "Sinus ritm, YuQS 84. Chap qorincha gipertrofiyasi belgilari (namuna).");
    await owner.locator('form:has(textarea[name="conclusion"]) button[type="submit"]').last().click();
    await settle(owner);
  });
  await step(owner, "cardiologist sheet", async () => {
    await owner.goto(encounterUrl);
    await owner.getByRole("link", { name: "Kardiolog ko'ruvi varag'i" }).first().click();
    await owner.waitForURL(/\/document\//);
    await shot(owner, "20-cardio-sheet", { full: true });
  });
  await step(owner, "certificate", async () => {
    await owner.goto(encounterUrl);
    await owner.getByRole("link", { name: "Ambulator davolanish haqida ma'lumotnoma" }).first().click();
    await owner.waitForURL(/\/document\//);
    await shot(owner, "21-certificate", { full: true });
  });
  await step(owner, "finish the visit", async () => {
    await owner.goto(encounterUrl);
    await settle(owner);
    await owner.getByRole("button", { name: /yakunlash|Yakunlash/ }).first().click();
    await settle(owner);
  });
  await step(owner, "UTT with the clinic template", async () => {
    await owner.goto(`${C}/my-queue`);
    await settle(owner);
    await owner.locator("main").locator("li, article, section > div, div.flex").filter({ hasText: "Rahimov" }).locator('form:has(input[name="appointmentId"]) button').last().click();
    await owner.waitForURL(/\/encounters\/[0-9a-f-]{36}/);
    await settle(owner);
    await owner.locator("summary").filter({ hasText: /Natija qo/ }).first().click();
    await owner.locator('select:has(option:text-is("UTT: qalqonsimon bez"))').first().selectOption({ label: "UTT: qalqonsimon bez" });
    await owner.getByRole("button", { name: /Me.yorni/ }).first().click();
    for (const [k, v] of [["isthThickness", "0,5"], ["rlLength", "6,8"], ["rlThickness", "1,7"], ["rlWidth", "1,6"], ["llLength", "5,2"], ["llThickness", "1,7"], ["llWidth", "1,5"], ["volume", "19"], ["volumeIndex", "112"]]) await owner.fill(`[name="f_${k}"]`, v!);
    const c = owner.locator('textarea[name="conclusion"]');
    await c.fill(`Exobelgilar bo'yicha qalqonsimon bez I darajali giperplaziyasi (namuna).\n${await c.inputValue()} endokrinolog ko'rigi.`);
    await shot(owner, "22-utt-form", { full: true });
    await owner.locator('form:has(input[name="templateId"]) button[type="submit"]').last().click();
    await settle(owner);
    const href = await owner.locator('a[href*="/diagnostics/"][href$="/print"]').first().getAttribute("href");
    await owner.goto(`${BASE}${href}`);
    await shot(owner, "23-utt-print", { full: true });
  });
  await step(owner, "patient card", async () => {
    await owner.goto(`${C}/patients?q=Aliyev`);
    await settle(owner);
    await owner.getByRole("link", { name: /Aliyev/ }).first().click();
    await owner.waitForURL(/\/patients\/[0-9a-f-]{36}/);
    await shot(owner, "24-patient-card");
  });

  // ---------- Money ----------
  await step(desk, "debt collection", async () => {
    await desk.goto(`${C}/desk`);
    await settle(desk);
    const more = desk.locator("summary").filter({ hasText: /Qarz/ }).first();
    if (await more.count()) await more.click();
    await shot(desk, "25-debt", { full: true });
  });
  await step(owner, "billing list", async () => {
    await owner.goto(`${C}/billing`);
    await shot(owner, "26-billing");
  });
  await step(owner, "cash", async () => {
    await owner.goto(`${C}/cash`);
    await shot(owner, "27-cash");
  });
  await step(owner, "reports", async () => {
    await owner.goto(`${C}/reports`);
    await shot(owner, "28-reports");
  });

  // ---------- Phone ----------
  await step(owner, "phone view", async () => {
    const phone = await signIn(browser, deskLogin, password, { width: 390, height: 844 });
    await phone.goto(`${C}/desk`);
    await shot(phone, "29-phone-desk");
  });

  // ---------- Test-patient removal (last: it empties the demo) ----------
  await step(owner, "purge card", async () => {
    await owner.goto(`${C}/settings`);
    await settle(owner);
    const form = owner.locator('form:has(input[name="confirm"])');
    await form.scrollIntoViewIfNeeded();
    await form.locator('input[name="confirm"]').fill(SLUG);
    await settle(owner);
    // The card around the form: the nearest ancestor that also holds the card title.
    const box = await form.evaluate((f) => {
      let el: HTMLElement | null = f as HTMLElement;
      while (el && !(el.textContent ?? "").includes("Sinov bemorlarini tozalash")) el = el.parentElement;
      const r = el!.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    await owner.screenshot({ path: path.join(OUT, "f-30-purge.png"), clip: box });
    console.log("  ▸ f-30-purge.png (not submitted)");
  });

  await browser.close();
  console.log(failures.length ? `\n${failures.length} step(s) failed: ${failures.join("; ")}` : "\nall screenshots taken");
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
