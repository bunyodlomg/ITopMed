import { CheckCircle2, FileText, FlaskConical, Pill, ScanLine, XCircle } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { patientName } from "@/components/patients";
import { Alert, ButtonLink, Card, CardHeader, EmptyState, PageHeader, buttonClass } from "@/components/ui/primitives";
import { requireClinic } from "@/server/auth/guards";
import { listTemplates } from "@/server/clinic/templates";
import { deskPrintables } from "@/server/emr/documents";
import { DomainError } from "@/server/errors";

/**
 * The desk's print list for one visit: every paper the patient takes home
 * (clinic documents, prescription, ultrasound / echo / ECG reports). Printing
 * opens only when the doctor has finished and the cashier has settled the
 * bill (green); otherwise the reason is shown in red. No clinical content here.
 */
export default async function DeskPrintPage({ params }: { params: Promise<{ slug: string; appointmentId: string }> }) {
  const { slug, appointmentId } = await params;
  const ctx = await requireClinic(slug, "documents.print");
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  const p = await deskPrintables(ctx, appointmentId).catch((e) => {
    if (e instanceof DomainError) notFound();
    throw e;
  });
  const templates = p.encounterId ? await listTemplates(ctx, { kind: "DOCUMENT" }) : [];
  const base = `/c/${ctx.tenant.slug}`;
  const ok = p.gate === "ok";
  const items: { key: string; href: string; label: string; icon: ReactNode }[] = [
    ...templates.map((tpl) => ({ key: `t-${tpl.id}`, href: `${base}/encounters/${p.encounterId}/document/${tpl.id}?print=1`, label: tpl.name, icon: <FileText aria-hidden className="size-4" /> })),
    ...(p.encounterId && p.hasPrescription ? [{ key: "rx", href: `${base}/encounters/${p.encounterId}/prescription`, label: t("clinic.deskPrint.prescription"), icon: <Pill aria-hidden className="size-4" /> }] : []),
    ...p.labOrders.map((o) => ({
      key: `l-${o.id}`,
      href: `${base}/lab/${o.id}/print`,
      label: `${t("clinic.deskPrint.labReport")}: ${o.items.map((i) => i.name).join(", ")} · ${o.number}`,
      icon: <FlaskConical aria-hidden className="size-4" />,
    })),
    ...p.diagnostics.map((d) => ({
      key: `d-${d.id}`,
      href: `${base}/diagnostics/${d.id}/print`,
      label: `${d.title} · ${format.dateTime(d.performedAt, { timeStyle: "short", timeZone: ctx.tenant.timezone })}`,
      icon: <ScanLine aria-hidden className="size-4" />,
    })),
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title={t("clinic.deskPrint.listTitle")}
        description={`${patientName(p.appointment.patient)} · ${p.appointment.patient.mrn}`}
        action={<ButtonLink href={`${base}/desk`} variant="secondary">{t("clinic.deskPrint.back")}</ButtonLink>}
      />
      {ok ? (
        <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-success bg-success-soft px-4 py-3 text-[14px]" role="status">
          <CheckCircle2 aria-hidden className="mt-0.5 size-5 shrink-0 text-success" />
          <p className="font-semibold">{t("clinic.deskPrint.ready")}</p>
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-danger bg-danger-soft px-4 py-3 text-[14px]" role="status">
          <XCircle aria-hidden className="mt-0.5 size-5 shrink-0 text-danger" />
          <div>
            <p className="font-semibold">{t("clinic.deskPrint.title")}</p>
            <p className="text-text-2">{t(`errors.deskPrint.${p.gate}` as never)}</p>
          </div>
        </div>
      )}
      <Card>
        <CardHeader title={t("clinic.deskPrint.papers")} />
        {items.length === 0 ? (
          <EmptyState icon={<FileText className="size-6" />} title={t("clinic.deskPrint.nothing")} />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((i) => (
              <li key={i.key} className="flex items-center justify-between gap-3 px-6 py-3">
                <span className="flex min-w-0 items-center gap-2.5 text-[14px] font-medium">
                  {i.icon}
                  <span className="min-w-0 break-words">{i.label}</span>
                </span>
                {ok ? (
                  <Link href={i.href} target="_blank" className={buttonClass("secondary", "sm")}>
                    {t("clinic.deskPrint.print")}
                  </Link>
                ) : (
                  <span className="shrink-0 text-[13px] text-text-3">{t("clinic.deskPrint.locked")}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {!p.encounterId && p.gate !== "notFinished" ? <Alert tone="accent">{t("clinic.deskPrint.noRecord")}</Alert> : null}
    </div>
  );
}
