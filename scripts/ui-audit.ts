/**
 * `npm run ui:audit` — visual layout audit of every screen at phone, tablet and
 * desktop widths, in light and dark. Finds text or numbers that spill out of
 * their box, anything that sticks out of the screen (horizontal page scroll),
 * and text clipped without an ellipsis. Exit code 1 when anything is found.
 *
 * Needs a running app (npm run app / npm run local / npm run dev) and an account
 * that is clinic owner + platform SUPER_ADMIN, given by its login as
 * ITM_AUDIT_LOGIN (ITM_AUDIT_EMAIL still accepted) / ITM_AUDIT_PASSWORD.
 * Uses the installed Microsoft Edge (or Chrome) — nothing is downloaded.
 *
 *   ITM_AUDIT_LOGIN=… ITM_AUDIT_PASSWORD=… npm run ui:audit -- --slug shifo-med [--base http://127.0.0.1:3000] [--only billing]
 */
import "dotenv/config";
import { chromium, type Browser, type Page } from "playwright-core";
import pg from "pg";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const BASE = arg("base", "http://127.0.0.1:3000");
const SLUG = arg("slug", "shifo-med");
const ONLY = arg("only", "");
const EMAIL = process.env.ITM_AUDIT_LOGIN ?? process.env.ITM_AUDIT_EMAIL ?? "";
const PASSWORD = process.env.ITM_AUDIT_PASSWORD ?? "";
const WIDTHS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];

/** Runs inside the page: returns innermost offending elements only. */
function detect() {
  const vw = document.documentElement.clientWidth;
  const found: { kind: string; el: Element; detail: string }[] = [];
  const inScroller = (el: Element) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      // The desktop page area scrolls vertically; it is the page, not a sideways scroller.
      if (p.hasAttribute("data-scroll-root")) return false;
      const o = getComputedStyle(p).overflowX;
      if (o === "auto" || o === "scroll") return true;
    }
    return false;
  };
  const root = document.querySelector("main") ?? document.body;
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (!(el instanceof HTMLElement) || !el.getClientRects().length) continue;
    const cs = getComputedStyle(el);
    if (cs.position === "fixed" || el.closest("[aria-hidden=true],.sr-only")) continue;
    if (["inline", "contents"].includes(cs.display) || el.tagName === "svg") continue;
    const r = el.getBoundingClientRect();
    if (cs.overflowX === "visible" && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && !inScroller(el))
      found.push({ kind: "SPILL", el, detail: `${el.scrollWidth}>${el.clientWidth}` });
    if ((r.right > vw + 1 || r.left < -1) && r.width > 0 && !inScroller(el)) found.push({ kind: "OFFSCREEN", el, detail: `${Math.round(r.left)}..${Math.round(r.right)} vw=${vw}` });
    if (cs.overflowX === "hidden" && el.children.length === 0 && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== "ellipsis")
      found.push({ kind: "CLIPPED", el, detail: `${el.scrollWidth}>${el.clientWidth}` });
  }
  // A button beside a field in one row must line up with it (top and bottom), e.g. "Ulush, % [   ] [Saqlash]".
  const fields = Array.from(root.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select")).filter((f) => f.getClientRects().length);
  for (const b of Array.from(root.querySelectorAll("button, a[class*='rounded-full']"))) {
    if (!(b instanceof HTMLElement) || !b.getClientRects().length || b.closest("[aria-hidden=true],.sr-only,nav,dialog:not([open])")) continue;
    const br = b.getBoundingClientRect();
    if (br.height < 30) continue;
    for (const f of fields) {
      const fr = f.getBoundingClientRect();
      const sideBySide = fr.right <= br.left + 1 || br.right <= fr.left + 1;
      const near = Math.min(Math.abs(fr.right - br.left), Math.abs(br.right - fr.left)) < 48;
      const overlap = Math.min(fr.bottom, br.bottom) - Math.max(fr.top, br.top);
      // Same layer only: a page button behind an open drawer is not beside the drawer's field.
      if (!sideBySide || !near || overlap <= 0 || b.closest("dialog") !== f.closest("dialog")) continue;
      const dTop = Math.abs(fr.top - br.top);
      const dBottom = Math.abs(fr.bottom - br.bottom);
      if (dTop > 3 && dBottom > 3) found.push({ kind: "MISALIGNED", el: b, detail: `top ${Math.round(dTop)}px bottom ${Math.round(dBottom)}px vs field` });
    }
  }
  // Keep the innermost element of each problem (a parent spills because its child does).
  const els = new Set(found.map((f) => f.el));
  const innermost = found.filter((f) => !Array.from(f.el.querySelectorAll("*")).some((c) => els.has(c)));
  const label = (el: Element) => {
    const cls = typeof el.className === "string" ? el.className.split(/\s+/).filter(Boolean).slice(0, 4).join(".") : "";
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""} "${(el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 48)}"`;
  };
  const pageScroll = document.documentElement.scrollWidth > vw + 1 ? [`PAGE_HSCROLL ${document.documentElement.scrollWidth}>${vw}`] : [];
  return [...pageScroll, ...innermost.map((f) => `${f.kind} ${f.detail} ${label(f.el)}`)];
}

async function sampleIds() {
  const c = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await c.connect();
  try {
    const t = (await c.query(`SELECT id FROM "Tenant" WHERE slug = $1`, [SLUG])).rows[0]?.id;
    if (!t) throw new Error(`clinic ${SLUG} not found`);
    const one = async (sql: string) => (await c.query(sql, [t])).rows[0]?.id as string | undefined;
    return {
      tenant: t as string,
      network: (await c.query(`SELECT id FROM "Network" WHERE "archivedAt" IS NULL ORDER BY "createdAt" LIMIT 1`)).rows[0]?.id as string | undefined,
      invoice: await one(`SELECT id FROM "Invoice" WHERE "tenantId" = $1 ORDER BY "totalMinor" DESC LIMIT 1`),
      patient: await one(`SELECT p.id FROM "Patient" p WHERE p."tenantId" = $1 AND EXISTS (SELECT 1 FROM "Invoice" i WHERE i."patientId" = p.id) LIMIT 1`),
      encounter: await one(`SELECT id FROM "Encounter" WHERE "tenantId" = $1 ORDER BY "createdAt" DESC LIMIT 1`),
      // A visit (one with a record if any): the desk's print list (documents, prescription, reports).
      appointment: await one(`SELECT a.id FROM "Appointment" a WHERE a."tenantId" = $1 ORDER BY EXISTS (SELECT 1 FROM "Encounter" e WHERE e."appointmentId" = a.id) DESC, a."startsAt" DESC LIMIT 1`),
      lab: await one(`SELECT id FROM "LabOrder" WHERE "tenantId" = $1 LIMIT 1`),
      labVerified: await one(`SELECT id FROM "LabOrder" WHERE "tenantId" = $1 AND status = 'VERIFIED' LIMIT 1`),
      item: await one(`SELECT id FROM "InventoryItem" WHERE "tenantId" = $1 LIMIT 1`),
      staffProfile: await one(`SELECT "membershipId" AS id FROM "StaffProfile" WHERE "tenantId" = $1 LIMIT 1`),
      doctor: await one(`SELECT "membershipId" AS id FROM "DoctorProfile" WHERE "tenantId" = $1 LIMIT 1`),
      member: await one(`SELECT id FROM "Membership" WHERE "tenantId" = $1 LIMIT 1`),
      role: await one(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'doctor'`),
      service: await one(`SELECT id FROM "Service" WHERE "tenantId" = $1 LIMIT 1`),
    };
  } finally {
    await c.end();
  }
}

function routes(ids: Awaited<ReturnType<typeof sampleIds>>): string[] {
  const c = `/c/${SLUG}`;
  const list = [
    "/admin", "/admin/clinics", "/admin/clinics/new", `/admin/clinics/${ids.tenant}`, "/admin/networks", ...(ids.network ? [`/admin/networks/${ids.network}`] : []), "/admin/staff", "/admin/audit", "/admin/security",
    "/clinics", "/account/security",
    c, `${c}/control`, `${c}/setup`, `${c}/patients`, `${c}/patients/new`, `${c}/appointments`, `${c}/queue`, `${c}/desk`, `${c}/my-queue`, `${c}/my-schedule`, `${c}/nurse`,
    `${c}/lab`, `${c}/lab/tests`, `${c}/billing`, `${c}/cash`, `${c}/reports`, `${c}/expenses`, `${c}/inventory`, `${c}/inventory/suppliers`,
    `${c}/hr`, `${c}/doctors`, `${c}/services`, `${c}/staff`, `${c}/roles`, `${c}/facilities`, `${c}/branches`, `${c}/integrations`,
    `${c}/settings`, `${c}/audit`, `${c}/support-access`, `${c}/templates`,
    // Right-hand drawers (create over a list).
    `${c}/services?panel=new`, `${c}/services?panel=paste`, `${c}/staff?panel=new`, `${c}/expenses?panel=new`, `${c}/templates/new?kind=DOCUMENT`, `${c}/templates/new?kind=NOTE`,
  ];
  const dyn: [string | undefined, string][] = [
    [ids.invoice, `${c}/billing/${ids.invoice}`], [ids.invoice, `${c}/billing/${ids.invoice}/receipt`],
    [ids.patient, `${c}/patients/${ids.patient}`], [ids.patient, `${c}/patients/${ids.patient}/edit`], [ids.patient, `${c}/patients/${ids.patient}/record`],
    [ids.encounter, `${c}/encounters/${ids.encounter}`], [ids.appointment, `${c}/desk/print/${ids.appointment}`], [ids.lab, `${c}/lab/${ids.lab}`], [ids.labVerified, `${c}/lab/${ids.labVerified}/print`], [ids.item, `${c}/inventory/${ids.item}`],
    [ids.staffProfile, `${c}/hr/${ids.staffProfile}`], [ids.doctor, `${c}/doctors/${ids.doctor}`], [ids.member, `${c}/staff/${ids.member}`],
    [ids.role, `${c}/roles/${ids.role}`], [ids.service, `${c}/services/${ids.service}`],
  ];
  for (const [id, url] of dyn) if (id) list.push(url);
  return ONLY ? list.filter((u) => u.includes(ONLY)) : list;
}

async function signIn(page: Page, path: string) {
  await page.goto(`${BASE}${path}`);
  await page.fill('input[name="username"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 30_000 }), page.press('input[name="password"]', "Enter")]);
}

async function main() {
  if (!EMAIL || !PASSWORD) throw new Error("Set ITM_AUDIT_LOGIN and ITM_AUDIT_PASSWORD");
  const ids = await sampleIds();
  let browser: Browser;
  try {
    browser = await chromium.launch({ channel: "msedge" });
  } catch {
    browser = await chromium.launch({ channel: "chrome" });
  }
  let total = 0;
  let screens = 0;
  const audit = async (page: Page, list: string[]) => {
    screens += list.length;
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const w of WIDTHS) {
        await page.setViewportSize({ width: w.width, height: w.height });
        for (const url of list) {
          const res = await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
          if (!res || res.status() >= 400) {
            console.log(`[${scheme}/${w.name}] ${url} → HTTP ${res?.status()}`);
            total++;
            continue;
          }
          const issues = await page.evaluate(detect);
          if (issues.length) {
            total += issues.length;
            console.log(`[${scheme}/${w.name}] ${url}`);
            for (const i of issues.slice(0, 12)) console.log(`   ${i}`);
            if (issues.length > 12) console.log(`   … ${issues.length - 12} more`);
          }
        }
      }
      if (args.includes("--light-only")) break;
    }
  };
  const fresh = async () => {
    const ctx = await browser.newContext();
    // tsx/esbuild wraps named functions with __name(); provide it in the page for detect().
    await ctx.addInitScript({ content: "window.__name = (f) => f;" });
    return ctx.newPage();
  };

  // 1. Public screens (signed out).
  if (!ONLY) await audit(await fresh(), ["/", "/login", "/connect", "/admin/login", "/forgot-password", `/p/${SLUG}/login`, `/p/${SLUG}/activate`]);

  // 2. Staff: platform console + clinic workspace.
  const staff = await fresh();
  // --only on clinic screens needs no console account (the console routes are filtered out anyway).
  if (!ONLY || ONLY.includes("/admin")) await signIn(staff, "/admin/login");
  await signIn(staff, "/login");
  await audit(staff, routes(ids));

  // 3. Patient portal (optional: ITM_AUDIT_PORTAL_PHONE + the same password).
  const phone = process.env.ITM_AUDIT_PORTAL_PHONE;
  if (phone && !ONLY) {
    const patient = await fresh();
    await patient.goto(`${BASE}/p/${SLUG}/login`);
    await patient.fill('input[name="phone"]', phone);
    await patient.fill('input[name="password"]', PASSWORD);
    await Promise.all([patient.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 30_000 }), patient.press('input[name="password"]', "Enter")]);
    await audit(patient, ["", "/book", "/appointments", "/results", "/invoices", "/account"].map((p) => `/p/${SLUG}${p}`));
  }

  await browser.close();
  console.log(total === 0 ? `\nUI audit: ${screens} screens × ${WIDTHS.length} widths — no layout problems.` : `\nUI audit: ${total} problem(s).`);
  process.exit(total === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
});
