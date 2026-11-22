/**
 * `npm run e2e:walkthrough` — drives the real app in Edge the way a clinic works
 * a patient through, end to end, and fails on the first broken step:
 *
 *   registrar: register a (synthetic) patient → walk-in to the doctor's queue
 *   doctor:    start the visit → note → sign → diagnosis → vital signs →
 *              prescription → print prescription → finish the visit
 *   cashier:   invoice for the visit → issue → take payment → receipt
 *   owner:     control centre, reports
 *
 * One account with all roles is used (ITM_AUDIT_LOGIN or ITM_AUDIT_EMAIL /
 * ITM_AUDIT_PASSWORD). Creates synthetic records in the clinic given by --slug: use a
 * development or demo database only.
 */
import "dotenv/config";
import { chromium, type Page } from "playwright-core";

const args = process.argv.slice(2);
const arg = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1]! : d);
const BASE = arg("base", "http://127.0.0.1:3000");
const SLUG = arg("slug", "shifo-med");
const C = `${BASE}/c/${SLUG}`;
const stamp = Date.now().toString(36).slice(-5);
let step = 0;

async function ok(page: Page, label: string, check: () => Promise<unknown>) {
  step++;
  try {
    await check();
    // Any error alert or crash page fails the step.
    const alert = await page.locator('[role="alert"]').filter({ hasNotText: /^$/ }).allTextContents();
    const danger = alert.filter((a) => a.trim()).join(" | ");
    if (danger && !/saqlandi|qo'shildi|qo‘shildi|imzolandi|yozildi|added|signed|saved/i.test(danger) && /xato|error|topilmadi|not found|ruxsat|forbidden/i.test(danger)) throw new Error(`alert: ${danger}`);
    console.log(`  ✓ ${step}. ${label}`);
  } catch (e) {
    console.error(`  ✗ ${step}. ${label}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    await page.screenshot({ path: `.data/e2e-fail-${step}.png`, fullPage: true });
    throw new Error(`walkthrough stopped at step ${step}`);
  }
}

/** The submit button of the appointment form in the row (inside <main>) that shows the given patient name. */
function rowButton(page: Page, text: string) {
  return page
    .locator("main")
    .locator("li, article, section > div, div.flex")
    .filter({ hasText: text })
    .locator('form:has(input[name="appointmentId"]) button')
    .last();
}

async function main() {
  const browser = await chromium.launch({ channel: "msedge" });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await ok(page, "sign in", async () => {
    await page.goto(`${BASE}/login`);
    await page.fill('input[name="username"]', (process.env.ITM_AUDIT_LOGIN ?? process.env.ITM_AUDIT_EMAIL)!);
    await page.fill('input[name="password"]', process.env.ITM_AUDIT_PASSWORD!);
    await Promise.all([page.waitForURL((u) => !u.pathname.endsWith("/login")), page.press('input[name="password"]', "Enter")]);
  });

  // Unique name and birth date per run, so the duplicate-patient check does not (rightly) stop the flow.
  const lastName = `Sinovov${stamp.toUpperCase()}`;
  const firstName = `Walk${stamp}`;
  let patientId = "";
  await ok(page, "registrar registers a patient", async () => {
    await page.goto(`${C}/patients/new`);
    await page.fill('input[name="lastName"]', lastName);
    await page.fill('input[name="firstName"]', firstName);
    await page.fill('input[name="birthDate"]', `19${50 + (Date.now() % 40)}-0${1 + (Date.now() % 9)}-1${Date.now() % 10}`);
    await page.selectOption('select[name="sex"]', "MALE");
    await page.locator('form button[type="submit"]').last().click();
    await page.waitForURL(/\/patients\/[0-9a-f-]{36}/);
    patientId = page.url().match(/patients\/([0-9a-f-]{36})/)![1]!;
  });

  await ok(page, "walk-in: patient joins the doctor's queue", async () => {
    await page.goto(`${C}/queue?patient=${patientId}`);
    const doctor = page.locator('select[name="doctorProfileId"]');
    // The doctor named by ITM_E2E_DOCTOR, else the first doctor of the clinic (the account itself must be that doctor to start the visit).
    const wanted = process.env.ITM_E2E_DOCTOR;
    const named = wanted ? doctor.locator("option", { hasText: wanted }) : null;
    const option = named && (await named.count()) ? await named.first().getAttribute("value") : await doctor.locator("option:not([value=''])").first().getAttribute("value");
    await doctor.selectOption(option!);
    // Wait for the server action to finish (the name is already visible in the walk-in card before that).
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/queue")),
      page.locator('form:has(select[name="doctorProfileId"]) button[type="submit"]').click(),
    ]);
    await page.waitForLoadState("networkidle");
    await page.getByText(`${lastName} ${firstName}`).first().waitFor();
  });

  let encounterUrl = "";
  await ok(page, "doctor starts the visit from 'my patients today'", async () => {
    await page.goto(`${C}/my-queue`);
    await rowButton(page, firstName).click();
    await page.waitForURL(/\/encounters\/[0-9a-f-]{36}/);
    encounterUrl = page.url();
  });

  await ok(page, "doctor writes and signs the note", async () => {
    await page.fill('textarea[name="complaints"]', "Sintetik: ko'krak qafasida bosim, hansirash.");
    await page.fill('textarea[name="examination"]', "Sintetik: AQB 150/95, puls 88.");
    await page.fill('textarea[name="assessment"]', "Sintetik: arterial gipertenziya.");
    await page.fill('textarea[name="plan"]', "Sintetik: EKG, dori, 2 haftadan keyin nazorat.");
    await page.locator('button[name="op"][value="sign"]').click();
    await page.locator('button[name="op"][value="sign"]').waitFor({ state: "detached" });
  });

  await ok(page, "diagnosis (ICD-10)", async () => {
    await page.fill('input[name="icd10Code"]', "I10");
    await page.fill('form:has(input[name="icd10Code"]) [name="description"]', "Essential hypertension (synthetic)");
    await page.locator('form:has(input[name="icd10Code"]) button[type="submit"]').click();
    await page.getByText("I10").first().waitFor();
  });

  await ok(page, "vital signs", async () => {
    await page.fill('input[name="SYSTOLIC_BP"]', "150");
    await page.fill('input[name="DIASTOLIC_BP"]', "95");
    await page.fill('input[name="HEART_RATE"]', "88");
    await page.locator('form:has(input[name="SYSTOLIC_BP"]) button[type="submit"]').click();
    await page.getByText("150").first().waitFor();
  });

  await ok(page, "prescription", async () => {
    await page.fill('input[name="drug"]', "Amlodipine 5 mg");
    await page.fill('input[name="dose"]', "1 tabletka");
    await page.fill('input[name="frequency"]', "kuniga 1 marta");
    await page.fill('input[name="durationDays"]', "30");
    await page.locator('form:has(input[name="drug"]) button[type="submit"]').click();
    await page.locator("#prescriptions").getByText("Amlodipine 5 mg").waitFor();
  });

  await ok(page, "printable prescription", async () => {
    await page.goto(`${encounterUrl}/prescription`);
    await page.getByText("Amlodipine 5 mg").waitFor();
    await page.getByText(firstName).first().waitFor();
    await page.goto(encounterUrl);
  });

  await ok(page, "owner's templates: ready-made set available, visit summary prints with the visit's data", async () => {
    await page.goto(`${C}/templates`);
    const add = page.locator('form:has(input[name="$slug"]) button[type="submit"]').first();
    if ((await page.locator('main a[href*="/templates/0"], main a[href*="/templates/01"]').count()) === 0) {
      await add.click();
      await page.waitForLoadState("networkidle");
    }
    await page.goto(encounterUrl);
    await page.locator("#documents a").first().click();
    await page.waitForURL(/\/document\//);
    await page.getByText(firstName).first().waitFor();
    await page.goto(encounterUrl);
  });

  await ok(page, "doctor finishes the visit", async () => {
    await page.locator('form:has(button) >> text=/Qabulni yakunlash|Finish/').first().waitFor().catch(() => undefined);
    const finish = page.locator("form").filter({ has: page.locator('input[name="encounterId"]') }).last().locator('button[type="submit"]').last();
    await finish.click();
    await page.waitForLoadState("networkidle");
  });

  let invoiceUrl = "";
  await ok(page, "cashier creates the invoice for the visit", async () => {
    await page.goto(`${C}/billing`);
    await rowButton(page, firstName).click();
    await page.waitForURL(/\/billing\/[0-9a-f-]{36}/);
    invoiceUrl = page.url();
  });

  await ok(page, "add a service line, issue the invoice", async () => {
    const lines = await page.locator('select[name="serviceId"]').count();
    if (lines) {
      const sel = page.locator('select[name="serviceId"]');
      const priced = await sel.locator("option").evaluateAll((os) => (os as HTMLOptionElement[]).map((o) => ({ v: o.value, t: o.textContent ?? "" })));
      const pick = priced.find((o) => /\d/.test(o.t) && !/ 0 /.test(o.t)) ?? priced[0]!;
      await sel.selectOption(pick.v);
      await page.locator('button[name="op"][value="add"]').click();
      await page.waitForLoadState("networkidle");
    }
    await page.locator("form").filter({ has: page.locator('input[name="invoiceId"]') }).locator('button[type="submit"]').filter({ hasText: /Chiqarish|Issue|Hisobni/ }).first().click();
    await page.waitForLoadState("networkidle");
    await page.locator('input[name="amount"]').waitFor();
  });

  await ok(page, "take the payment and open the receipt", async () => {
    await page.selectOption('select[name="method"]', "CARD");
    await page.locator('form:has(input[name="amount"]) button[type="submit"]').click();
    await page.waitForLoadState("networkidle");
    await page.goto(`${invoiceUrl}/receipt`);
    await page.getByText(firstName).first().waitFor();
  });

  await ok(page, "owner: control centre and reports open", async () => {
    await page.goto(`${C}/control`);
    await page.locator("h1").first().waitFor();
    await page.goto(`${C}/reports`);
    await page.locator("h1").first().waitFor();
  });

  await browser.close();
  if (errors.length) {
    console.error(`Browser errors:\n  ${errors.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`\nWalkthrough: all ${step} steps passed (patient ${lastName} ${firstName}).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
