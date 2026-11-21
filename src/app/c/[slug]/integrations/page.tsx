import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { Form, SubmitButton, TextField } from "@/components/ui/form";
import { Badge, Card, CardBody, CardHeader, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { requireClinic } from "@/server/auth/guards";
import { integrationStatuses, type IntegrationStatus } from "@/server/integrations/catalog";
import { getNotificationSettings, listNotifications } from "@/server/notifications/notifications";
import { dispatchNowAction, notificationSettingsAction } from "../../../integrations-actions";
import { telegramStatus } from "@/server/notifications/telegram";

const STATUS_TONE: Record<IntegrationStatus, "success" | "warning" | "neutral" | "accent"> = { connected: "success", simulated: "warning", off: "neutral", partial: "accent", planned: "neutral" };
const LOG_TONE = { PENDING: "accent", SENT: "success", FAILED: "danger", SKIPPED: "neutral" } as const;
const SWITCHES = ["appointmentBooked", "appointmentReminder", "appointmentCancelled", "resultsReady", "noShowRebook", "visitCheckIn", "medicationReminders"] as const;

export default async function IntegrationsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ status?: string }> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug, "clinic.settings.read");
  const sp = await searchParams;
  const canManage = ctx.permissions.has("clinic.settings.manage");
  const [t, format, settings, log, tg] = await Promise.all([getTranslations(), getFormatter(), getNotificationSettings(ctx), listNotifications(ctx, { status: sp.status }), telegramStatus(ctx)]);
  const base = `/c/${ctx.tenant.slug}/integrations`;
  const dt = (d: Date) => format.dateTime(d, { dateStyle: "short", timeStyle: "short", timeZone: ctx.tenant.timezone });

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader title={t("clinic.integrations.title")} description={t("clinic.integrations.subtitle")} />

      <Card id="telegram">
        <CardHeader title={t("clinic.telegram.title")} description={t("clinic.telegram.hint")} />
        <CardBody className="space-y-4 text-[14px]">
          {tg.transport === "dev-outbox" ? <p className="text-text-2">{t("clinic.telegram.simulated")}</p> : null}
          {tg.bot ? (
            <p>
              <span className="font-medium">@{tg.bot.username}</span> · {t("clinic.telegram.connectedAt", { date: dt(tg.bot.connectedAt) })} ·{" "}
              {t("clinic.telegram.linkedPatients", { count: tg.linkedPatients })}
            </p>
          ) : (
            <p className="text-text-2">{t("clinic.telegram.notConnected")}</p>
          )}
          <p className="text-text-2">{t("clinic.telegram.byItopmed")}</p>
          <p className="text-text-2">
            {t("clinic.telegram.loginPage")} <span className="break-all font-mono">/login/{ctx.tenant.slug}</span>
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("clinic.integrations.statusTitle")} description={t("clinic.integrations.statusHint")} />
        <ul className="divide-y divide-border">
          {integrationStatuses({ telegramBot: Boolean(tg.bot) }).map((i) => (
            <li key={i.key} className="flex flex-wrap items-start justify-between gap-3 px-6 py-3">
              <div className="min-w-0 max-w-2xl">
                <p className="text-[14.5px] font-medium">{t(`integration.${i.key}.name`)}</p>
                <p className="text-[13px] text-text-2">{t(`integration.${i.key}.note`)}</p>
              </div>
              <Badge tone={STATUS_TONE[i.status]}>{t(`integrationStatus.${i.status}`)}</Badge>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader title={t("clinic.integrations.notifications")} description={t("clinic.integrations.notificationsHint")} />
        <CardBody>
          <Form action={notificationSettingsAction}>
            <input type="hidden" name="$slug" value={ctx.tenant.slug} />
            <fieldset disabled={!canManage} className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                {SWITCHES.map((k) => (
                  <label key={k} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--radius-control)] border border-border bg-surface-2 px-3 text-[14px] has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                    <input type="checkbox" name={k} defaultChecked={settings[k]} className="size-4 accent-[var(--accent)]" />
                    {t(`notificationKind.${k}`)}
                  </label>
                ))}
              </div>
              <div className="max-w-xs">
                <TextField name="reminderHoursBefore" label={t("clinic.integrations.reminderHours")} defaultValue={String(settings.reminderHoursBefore)} inputMode="numeric" />
              </div>
              <div className="max-w-xs">
                <TextField name="checkInDays" label={t("clinic.integrations.checkInDays")} hint={t("clinic.integrations.checkInDaysHint")} defaultValue={String(settings.checkInDays)} inputMode="numeric" />
              </div>
              <p className="text-[13px] text-text-2">{t("clinic.integrations.telegramOnlyHint")}</p>
            </fieldset>
            {canManage ? <SubmitButton>{t("common.save")}</SubmitButton> : null}
          </Form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={t("clinic.integrations.log")}
          description={t("clinic.integrations.logHint")}
          action={
            canManage ? (
              <Form action={dispatchNowAction} className="space-y-2">
                <input type="hidden" name="$slug" value={ctx.tenant.slug} />
                <SubmitButton variant="secondary" className="h-9 px-3 text-[13px]">
                  {t("clinic.integrations.sendNow")}
                </SubmitButton>
              </Form>
            ) : null
          }
        />
        <div className="flex flex-wrap gap-2 px-6 pt-4">
          {(["", "PENDING", "SENT", "FAILED", "SKIPPED"] as const).map((st) => (
            <Link
              key={st || "all"}
              href={st ? `${base}?status=${st}` : base}
              className={`rounded-full px-3 py-1 text-[13px] ${(sp.status ?? "") === st ? "bg-accent-solid text-on-accent" : "bg-sunken text-text-2"}`}
            >
              {st ? `${t(`notificationStatus.${st}`)} · ${log.counts[st] ?? 0}` : t("clinic.integrations.all")}
            </Link>
          ))}
        </div>
        {log.rows.length === 0 ? (
          <CardBody>
            <p className="text-[14px] text-text-2">{t("clinic.integrations.empty")}</p>
          </CardBody>
        ) : (
          <Table caption={t("clinic.integrations.log")}>
            <thead>
              <tr>
                <Th>{t("clinic.integrations.kind")}</Th>
                <Th>{t("clinic.integrations.patient")}</Th>
                <Th>{t("clinic.integrations.channel")}</Th>
                <Th>{t("clinic.integrations.when")}</Th>
                <Th>{t("clinic.integrations.status")}</Th>
              </tr>
            </thead>
            <tbody>
              {log.rows.map((n) => (
                <tr key={n.id}>
                  <Td>{t(`notificationKind.${KIND_KEY[n.kind]}`)}</Td>
                  <Td className="font-mono text-[13px]">{n.patient.mrn}</Td>
                  <Td>
                    {t(`notificationChannel.${n.channel}`)}
                    {n.transport ? <p className="text-[12px] text-text-3">{n.transport}</p> : null}
                  </Td>
                  <Td className="text-[13px] tabular-nums">
                    {n.sentAt ? dt(n.sentAt) : dt(n.dueAt)}
                    {n.attempts > 0 && n.status !== "SENT" ? <p className="text-[12px] text-text-3">{t("clinic.integrations.attempts", { count: n.attempts })}</p> : null}
                  </Td>
                  <Td>
                    <Badge tone={LOG_TONE[n.status]}>{t(`notificationStatus.${n.status}`)}</Badge>
                    {n.lastError ? <p className="mt-1 text-[12px] text-text-3">{t(`notificationReason.${n.lastError}` as never)}</p> : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

const KIND_KEY = {
  APPOINTMENT_BOOKED: "appointmentBooked",
  APPOINTMENT_REMINDER: "appointmentReminder",
  APPOINTMENT_CANCELLED: "appointmentCancelled",
  RESULTS_READY: "resultsReady",
  DISPENSARY_REMINDER: "dispensaryReminder",
  NO_SHOW_REBOOK: "noShowRebook",
  VISIT_CHECKIN: "visitCheckIn",
  MEDICATION_REMINDER: "medicationReminders",
} as const;
