import "server-only";
import { z } from "zod";
import type { ClinicContext } from "../auth/clinic-auth";
import type { RequestMeta } from "../auth/platform-auth";
import { auditClinic, inClinic } from "../clinic/context";
import { isLocalOnly } from "../clinic/data-mode";
import { policyIn } from "../clinic/policy";
import { listTemplates } from "../clinic/templates";
import { deskPrintables } from "../emr/documents";
import { DomainError } from "../errors";
import { botToken, sendTelegramDocument, telegramChatFor, telegramEnabled } from "../notifications/telegram";
import { rateLimit } from "../security/rate-limit";
import { instantToLocalDate } from "../scheduling/time";
import { buildPaper, paperTranslator, type PaperRef } from "./build";
import { renderDocx } from "./docx";
import { PAPER_MIME, paperFileName, type PaperFormat } from "./paper";
import { renderPdf } from "./pdf";

/**
 * The desk sends a finished visit's papers to the patient's Telegram as PDF or
 * Word files - the same papers it prints, under the same rules:
 *  - the clinic owner switched it on (ClinicPolicy.telegramDocuments, off by default);
 *  - documents.print, the visit finished today and the patient's bills settled;
 *  - only to the chat the PATIENT linked (portal deep link or their own phone
 *    shared in the clinic's bot) - never to a number typed at the desk;
 *  - file names and captions carry no clinical content; each paper's
 *    hand-over is audited ("…sent_telegram") plus one summary event.
 */

/** Item keys from the desk page: "doc:<templateId>", "rx", "lab:<orderId>", "study:<resultId>". */
const sendSchema = z.object({
  appointmentId: z.uuid(),
  format: z.enum(["pdf", "docx"]),
  items: z.array(z.string().max(80)).min(1, "errors.telegramDocs.nothingChosen").max(30),
});

export type TelegramPapersState = { enabled: boolean; linked: boolean; ready: boolean };

/** Whether the desk can send this patient's papers to Telegram, and why not (for the page). */
export async function telegramPapersState(ctx: ClinicContext, patientId: string): Promise<TelegramPapersState> {
  if (!ctx.permissions.has("documents.print")) throw new DomainError("errors.forbidden");
  return inClinic(ctx, async (tx) => {
    const enabled = (await policyIn(tx, ctx.tenant.id)).telegramDocuments;
    if (!enabled) return { enabled, linked: false, ready: false };
    const bot = await tx.telegramBot.findUnique({ where: { tenantId: ctx.tenant.id }, select: { enabled: true } });
    const ready = telegramEnabled() && Boolean(bot?.enabled) && !(await isLocalOnly(tx, ctx.tenant.id));
    const linked = (await telegramChatFor(tx, ctx.tenant.id, patientId)) !== null;
    return { enabled, linked, ready };
  });
}

export async function sendPapersToTelegram(ctx: ClinicContext, raw: unknown, meta: RequestMeta): Promise<{ sent: number; failed: number }> {
  const input = sendSchema.parse(raw);
  const p = await deskPrintables(ctx, input.appointmentId); // documents.print + branch check
  const patientId = p.appointment.patientId;
  const target = await inClinic(ctx, async (tx) => {
    if (!(await policyIn(tx, ctx.tenant.id)).telegramDocuments) throw new DomainError("errors.telegramDocs.off");
    if (await isLocalOnly(tx, ctx.tenant.id)) throw new DomainError("errors.localModeNoInternet");
    if (!telegramEnabled()) throw new DomainError("errors.telegramOff");
    const bot = await tx.telegramBot.findUnique({ where: { tenantId: ctx.tenant.id }, select: { enabled: true } });
    if (!bot?.enabled) throw new DomainError("errors.telegramOff");
    const chatId = await telegramChatFor(tx, ctx.tenant.id, patientId);
    if (chatId === null) throw new DomainError("errors.telegramDocs.notLinked");
    const patient = await tx.patient.findUniqueOrThrow({ where: { id: patientId }, select: { preferredLocale: true } });
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenant.id }, select: { name: true, defaultLocale: true } });
    return { chatId, token: await botToken(tx, ctx.tenant.id), locale: patient.preferredLocale, fallback: tenant.defaultLocale, clinic: tenant.name };
  });
  if (p.gate !== "ok") throw new DomainError(`errors.deskPrint.${p.gate}`);

  // Only what the desk could print for this visit.
  const allowed = new Map<string, PaperRef>();
  if (p.encounterId) {
    for (const tpl of await listTemplates(ctx, { kind: "DOCUMENT" })) allowed.set(`doc:${tpl.id}`, { kind: "document", encounterId: p.encounterId, templateId: tpl.id });
    if (p.hasPrescription) allowed.set("rx", { kind: "prescription", encounterId: p.encounterId });
  }
  for (const o of p.labOrders) allowed.set(`lab:${o.id}`, { kind: "lab", orderId: o.id });
  for (const d of p.diagnostics) allowed.set(`study:${d.id}`, { kind: "study", resultId: d.id });
  const refs = [...new Set(input.items)].map((k) => allowed.get(k));
  if (refs.some((r) => !r)) throw new DomainError("errors.notFound");

  if (!(await rateLimit(`tgdocs:${ctx.tenant.id}:${patientId}`, 30, 60 * 60_000))) throw new DomainError("errors.rateLimited");

  const { t } = await paperTranslator(target.locale, target.fallback);
  const caption = t("papers.caption", { clinic: target.clinic });
  const format = input.format as PaperFormat;
  let sent = 0;
  let failed = 0;
  const counts = new Map<string, number>();
  const nameFor = (kind: Parameters<typeof paperFileName>[0], day: Date, ext: PaperFormat) => {
    const n = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, n);
    return paperFileName(kind, instantToLocalDate(day, ctx.tenant.timezone), ext, n);
  };
  for (const ref of refs as PaperRef[]) {
    const { paper, attachments, day } = await buildPaper(ctx, ref, t, meta);
    const bytes = format === "pdf" ? await renderPdf(paper) : renderDocx(paper);
    if (await sendTelegramDocument(target.token, target.chatId, { name: nameFor(paper.kind, day, format), bytes, mime: PAPER_MIME[format] }, caption)) sent++;
    else failed++;
    for (const a of attachments) {
      if (await sendTelegramDocument(target.token, target.chatId, { name: nameFor(`${paper.kind}-device`, day, "pdf"), bytes: a.bytes, mime: a.mime }, caption)) sent++;
      else failed++;
    }
  }
  await inClinic(ctx, (tx) =>
    auditClinic(tx, ctx, meta, { action: "telegram.papers_sent", entityType: "Patient", entityId: patientId, metadata: { format, papers: refs.length, sent, failed } }),
  );
  return { sent, failed };
}
