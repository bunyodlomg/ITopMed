/**
 * Server maintenance tasks for the Linux release (bundled as app/tasks.mjs):
 *   node tasks.mjs db-init   create the database cluster and roles once (then stops it)
 *   node tasks.mjs migrate   apply migrations + plan catalog (idempotent)
 *   node tasks.mjs backup    encrypted backup into ITM_BACKUP_DIR, keep the latest 14
 *   node tasks.mjs create-clinic <spec.json> <owner-login> "<Owner Name>"
 *                            open a clinic ready to work (asks for the owner's password)
 *   node tasks.mjs clinic-admin <slug> <ops.json>
 *                            the owner's administration on the server (roles, staff, test patients;
 *                            see scripts/lib/clinic-admin.ts); prints new staff passwords once
 * Settings come from the service environment (/etc/itopmed/itopmed.env).
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { createBackup, backupKey } from "../lib/backup";
import { startEmbeddedDb } from "../lib/embedded-db";
import { applyMigrations } from "../lib/migrate";
import { seedPlans } from "../lib/seed-plans";
import { applyClinicExtras, clinicSpecSchema, createClinicFromSpec } from "../lib/create-clinic";
import { runClinicAdmin } from "../lib/clinic-admin";

/** Reads a password without showing it (falls back to a plain prompt when not on a terminal). */
function askHidden(question: string): Promise<string> {
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  const CTRL_C = String.fromCharCode(3);
  const BACKSPACE = [String.fromCharCode(127), String.fromCharCode(8)];
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c) => (buf += c));
      stdin.on("end", () => resolve(buf.split(LF)[0]!.replace(CR, "")));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === CR || c === LF) {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write(LF);
          resolve(value);
          return;
        }
        if (c === CTRL_C) process.exit(130);
        if (BACKSPACE.includes(c)) value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing ${k}`);
  return v;
};
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

async function main() {
  const task = process.argv[2];
  if (task === "db-init") {
    const db = await startEmbeddedDb({
      dataDir: path.join(need("ITM_HOME"), "pg"),
      port: Number(process.env.DEV_PG_PORT ?? 54329),
      superuserPassword: need("DEV_PG_SUPERUSER_PASSWORD"),
      ownerPassword: need("DEV_PG_OWNER_PASSWORD"),
      appPassword: need("DEV_PG_APP_PASSWORD"),
      platformPassword: need("DEV_PG_PLATFORM_PASSWORD"),
      portalPassword: need("DEV_PG_PORTAL_PASSWORD"),
      postgresFlags: ["-c", "io_method=sync"],
    });
    await db.stop();
    console.log("Database initialised.");
  } else if (task === "migrate") {
    const n = await applyMigrations(need("MIGRATION_DATABASE_URL"), path.join(here, "migrations"), (m) => console.log(m));
    console.log(`Plans: ${await seedPlans(need("MIGRATION_DATABASE_URL"))}`);
    console.log(`Migrations applied: ${n}.`);
  } else if (task === "backup") {
    const dir = need("ITM_BACKUP_DIR");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `itopmed-${new Date().toISOString().replace(/[:.]/g, "-")}.itmbk`);
    const r = await createBackup({ databaseUrl: need("MIGRATION_DATABASE_URL"), file, key: backupKey(process.env.BACKUP_ENCRYPTION_KEY) });
    const all = fs.readdirSync(dir).filter((n) => n.endsWith(".itmbk")).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 14))) fs.rmSync(path.join(dir, old), { force: true });
    console.log(`Backup saved: ${file} (${JSON.stringify(r).length} B manifest)`);
  } else if (task === "create-clinic") {
    const [specFile, login, name] = process.argv.slice(3);
    if (!specFile || !login || !name) throw new Error('Usage: tasks.mjs create-clinic <spec.json> <owner-login> "<Owner Name>"');
    // ITM_OWNER_PASSWORD only for automated runs (tests); people type it at the prompt.
    const password = process.env.ITM_OWNER_PASSWORD ?? (await askHidden("Egasining paroli / owner password (min 12, harf + raqam): "));
    const again = process.env.ITM_OWNER_PASSWORD ?? (await askHidden("Yana bir marta / again: "));
    if (password !== again) throw new Error("Parollar bir xil emas / passwords differ");
    const r = await createClinicFromSpec(specFile, login, name, password);
    console.log(`Klinika tayyor: /c/${r.slug}  (narxlar: ${r.prices.created} yangi, ${r.prices.updated} yangilandi; narxsiz standart xizmatlar arxivlandi: ${r.archived})`);
    console.log(`Kirish: /login - login "${login}" va siz bergan parol; keyin egasi Telegram'ini ulaydi (parolni tiklash klinika boti orqali).`);
  } else if (task === "update-clinic") {
    const specFile = process.argv[3];
    if (!specFile) throw new Error("Usage: tasks.mjs update-clinic <spec.json>");
    const r = await applyClinicExtras(clinicSpecSchema.parse(JSON.parse(fs.readFileSync(specFile, "utf8"))), path.dirname(specFile));
    const s = r.services;
    console.log(`Klinika yangilandi: ${r.templatesAdded} ta yangi shablon; blankada to'ldirildi: ${r.letterhead.join(", ") || "-"}`);
    console.log(`Xizmatlar: ${s.created} yangi, ${s.updated} narxi yangilandi, ${s.renamed} nomi o'zgardi, ${s.retired} arxivlandi`);
  } else if (task === "clinic-admin") {
    const [slug, opsFile] = process.argv.slice(3);
    if (!slug || !opsFile) throw new Error("Usage: tasks.mjs clinic-admin <slug> <ops.json>");
    // "-": the list comes on stdin (the root-only file is opened by the wrapper, not by this user).
    const text = opsFile === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(opsFile, "utf8");
    for (const r of await runClinicAdmin(slug, JSON.parse(text))) {
      console.log(`✓ ${r.op}: ${r.detail}${r.password ? `  — birinchi parol / first password: ${r.password}` : ""}`);
    }
  } else if (task === "check-db") {
    const c = new pg.Client({ connectionString: need("MIGRATION_DATABASE_URL") });
    await c.connect();
    console.log((await c.query("select version()")).rows[0].version);
    await c.end();
  } else {
    throw new Error("Usage: tasks.mjs db-init | migrate | backup | check-db | create-clinic");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
