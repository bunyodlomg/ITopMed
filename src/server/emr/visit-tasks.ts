import "server-only";
import type { DiagnosticKindKey } from "@/lib/diagnostics";
import { templatesForService } from "@/lib/service-template";
import type { ClinicContext } from "../auth/clinic-auth";
import { inClinic } from "../clinic/context";
import { sequential } from "../db";
import { DomainError } from "../errors";
import { addDays, localToInstant, todayIn } from "../scheduling/time";

/**
 * The doctor's work for each patient in today's queue: what the patient came
 * and paid for (the visit's service and today's bill), each as one button —
 * a study opens its own form (the clinic's template, or the built-in ECG /
 * echo / Holter fields), a consultation opens the visit. Done studies (a
 * result saved today under that form's name) and finished visits show a tick.
 * No clinical content leaves this function: only names and done flags.
 */
export interface VisitTask {
  serviceId: string;
  name: string;
  /** "visit": open the consultation; "template:<id>": the clinic's form; "kind:<ECG|…>": built-in fields; "choose": pick in the visit. */
  target: string;
  done: boolean;
}

/** Built-in study fields for services without a clinic form, by words of the service name. */
const KIND_WORDS: [RegExp, DiagnosticKindKey][] = [
  [/\b(ekg|ecg|экг)\b/i, "ECG"],
  [/xolter|holter|холтер/i, "HOLTER"],
  [/\b(smad|абпм|смад)\b|24 soatlik monitoring/i, "ABPM"],
  [/stress|yuklamali|veloergometr|tredmil/i, "STRESS_TEST"],
  [/ehokg|exokg|exo\b|эхокг|exokardiografiya/i, "ECHO"],
];

export async function doctorQueueTasks(ctx: ClinicContext, rows: { appointmentId: string; patientId: string; sex: string; serviceId: string | null; status: string }[]): Promise<Map<string, VisitTask[]>> {
  if (!ctx.permissions.has("emr.read")) throw new DomainError("errors.forbidden");
  const out = new Map<string, VisitTask[]>();
  if (!rows.length) return out;
  const tz = ctx.tenant.timezone;
  const day = todayIn(tz);
  const from = localToInstant(day, 0, tz);
  const to = localToInstant(addDays(day, 1), 0, tz);
  const patientIds = [...new Set(rows.map((r) => r.patientId))];
  return inClinic(ctx, async (tx) => {
    const lines = await tx.invoiceLine.findMany({
      where: { serviceId: { not: null }, invoice: { patientId: { in: patientIds }, status: { not: "VOID" }, createdAt: { gte: from, lt: to } } },
      select: { serviceId: true, invoice: { select: { patientId: true } } },
      orderBy: { id: "asc" },
    });
    const serviceIds = [...new Set([...lines.map((l) => l.serviceId!), ...rows.map((r) => r.serviceId).filter((x): x is string => Boolean(x))])];
    // One transaction = one connection: the reads run in turn (Prisma queries are lazy).
    const [services, templates, results, encounters] = await sequential([
      tx.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, name: true, kind: true } }),
      tx.clinicTemplate.findMany({ where: { tenantId: ctx.tenant.id, kind: "DIAGNOSTIC", archivedAt: null }, select: { id: true, name: true, serviceId: true }, orderBy: { name: "asc" } }),
      tx.diagnosticResult.findMany({ where: { patientId: { in: patientIds }, enteredInErrorAt: null, performedAt: { gte: from, lt: to } }, select: { patientId: true, title: true, kind: true } }),
      tx.encounter.findMany({ where: { appointmentId: { in: rows.map((r) => r.appointmentId) } }, select: { appointmentId: true, status: true } }),
    ]);
    const byId = new Map(services.map((s) => [s.id, s]));
    const closed = new Set(encounters.filter((e) => e.status === "CLOSED").map((e) => e.appointmentId!));
    for (const r of rows) {
      const ids = [...new Set([r.serviceId, ...lines.filter((l) => l.invoice.patientId === r.patientId).map((l) => l.serviceId!)].filter((x): x is string => Boolean(x)))];
      const done = results.filter((x) => x.patientId === r.patientId);
      const tasks: VisitTask[] = [];
      for (const id of ids) {
        const s = byId.get(id);
        if (!s) continue;
        if (s.kind === "CONSULTATION") {
          tasks.push({ serviceId: s.id, name: s.name, target: "visit", done: closed.has(r.appointmentId) });
          continue;
        }
        const forms = templatesForService(s, templates, r.sex);
        if (forms.length === 1) {
          tasks.push({ serviceId: s.id, name: s.name, target: `template:${forms[0]!.id}`, done: done.some((x) => x.title === forms[0]!.name) });
          continue;
        }
        const kind = KIND_WORDS.find(([re]) => re.test(s.name))?.[1];
        if (kind && forms.length === 0) {
          tasks.push({ serviceId: s.id, name: s.name, target: `kind:${kind}`, done: done.some((x) => x.kind === kind) });
          continue;
        }
        if (s.kind === "IMAGING" || s.kind === "PROCEDURE" || forms.length > 1) {
          tasks.push({ serviceId: s.id, name: s.name, target: "choose", done: forms.some((f) => done.some((x) => x.title === f.name)) });
        }
      }
      // The visit itself is always one click away, even without a consultation on the bill.
      if (!tasks.some((x) => x.target === "visit") && r.status !== "CANCELLED" && r.status !== "NO_SHOW") tasks.unshift({ serviceId: "", name: "", target: "visit", done: closed.has(r.appointmentId) });
      out.set(r.appointmentId, tasks);
    }
    return out;
  });
}

/** Where a task button leads, checked on the server (the target comes from a form). */
export function taskPath(slug: string, encounterId: string, target: string): string {
  const base = `/c/${slug}/encounters/${encounterId}`;
  const tpl = /^template:([0-9a-f-]{36})$/.exec(target);
  if (tpl) return `${base}/study?template=${tpl[1]}`;
  const kind = /^kind:([A-Z_]{3,12})$/.exec(target);
  if (kind) return `${base}/study?kind=${kind[1]}`;
  if (target === "choose") return `${base}/study`;
  return base;
}
