/**
 * Background worker: delivers due patient notifications for every active clinic
 * and, in the local app, keeps the folders of patient Excel files up to date.
 *   npm run worker            (loops every 60 s; Ctrl+C to stop)
 *   npm run worker -- --once  (one pass, e.g. from cron)
 *
 * Clinic ids come from the platform role (tenant list only); delivery runs as
 * the clinic role inside each clinic's tenant context, so RLS still applies.
 */
import "dotenv/config";
import { disconnectAll, platformDb } from "../src/server/db";
import { logger } from "../src/server/logger";
import { processDueNotifications, scheduleMedicationReminders } from "../src/server/notifications/notifications";
import { pollTelegram } from "../src/server/telegram/updates";
import { isLocalInstall, syncPatientFiles } from "../src/server/clinic/data-mode";
import { generateMonthlyInvoices, suspendOverdueClinics } from "../src/server/platform/billing";

// Short enough that a patient connecting Telegram sees the confirmation quickly.
const INTERVAL_MS = 20_000;
// Local app: the folder of patient Excel files is refreshed this often (only changed patients).
const FILES_EVERY_MS = 120_000;
let filesAt = 0;
// ITop Med's own billing of clinics: monthly invoices and automatic suspension of overdue clinics.
const BILLING_EVERY_MS = 60 * 60_000;
let billingAt = 0;
// Medicine reminders for the next day are (re)queued this often (idempotent).
const MEDS_EVERY_MS = 5 * 60_000;
let medsAt = 0;

async function pass() {
  const tenants = await platformDb().tenant.findMany({ where: { status: { in: ["TRIAL", "ACTIVE"] } }, select: { id: true } });
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let linked = 0;
  const meds = Date.now() - medsAt >= MEDS_EVERY_MS;
  if (meds) medsAt = Date.now();
  for (const t of tenants) {
    try {
      linked += await pollTelegram(t.id);
      if (meds) await scheduleMedicationReminders(t.id);
      const r = await processDueNotifications(t.id);
      sent += r.sent;
      failed += r.failed;
      skipped += r.skipped;
    } catch (e) {
      logger.error("worker.tenant_failed", { tenantId: t.id, error: e instanceof Error ? e.name : "unknown" });
    }
  }
  if (isLocalInstall() && Date.now() - filesAt >= FILES_EVERY_MS) {
    filesAt = Date.now();
    const withFiles = await platformDb().clinicPolicy.findMany({ where: { patientFilesEnabled: true, tenantId: { in: tenants.map((t) => t.id) } }, select: { tenantId: true } });
    for (const { tenantId } of withFiles) {
      try {
        const r = await syncPatientFiles(tenantId);
        if (r.written) logger.info("worker.patient_files", { tenantId, written: r.written });
      } catch {
        // already logged by syncPatientFiles; retried next time
      }
    }
  }
  if (!isLocalInstall() && Date.now() - billingAt >= BILLING_EVERY_MS) {
    billingAt = Date.now();
    try {
      const invoices = await generateMonthlyInvoices();
      const suspended = await suspendOverdueClinics();
      if (invoices || suspended) logger.info("worker.billing", { invoices, suspended });
    } catch (e) {
      logger.error("worker.billing_failed", { error: e instanceof Error ? e.name : "unknown" });
    }
  }
  const swept = (await platformDb().$queryRaw<{ n: number }[]>`SELECT rate_limit_sweep() AS n`)[0]?.n ?? 0;
  logger.info("worker.pass", { tenants: tenants.length, sent, failed, skipped, telegramLinked: linked, rateLimitBucketsSwept: swept });
}

async function main() {
  const once = process.argv.includes("--once");
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  do {
    await pass();
    if (once) break;
    for (let waited = 0; waited < INTERVAL_MS && !stopping; waited += 1000) await new Promise((r) => setTimeout(r, 1000));
  } while (!stopping);
  await disconnectAll();
}

main().catch((e) => {
  logger.error("worker.crashed", { error: e instanceof Error ? e.name : "unknown" });
  process.exit(1);
});
