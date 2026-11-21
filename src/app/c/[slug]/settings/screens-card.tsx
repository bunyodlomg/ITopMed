import { getTranslations } from "next-intl/server";
import { Form, SelectField, SubmitButton, TextField } from "@/components/ui/form";
import { Card, CardBody, CardHeader } from "@/components/ui/primitives";
import type { ClinicContext } from "@/server/auth/clinic-auth";
import { listOperationalBranches } from "@/server/clinic/context";
import { listScreens } from "@/server/queue/board";
import { createScreenAction, revokeScreenAction } from "../../../queue-actions";

/** Settings → waiting-room screens (TV): create a secret link, revoke it. */
export async function ScreensCard({ ctx }: { ctx: ClinicContext }) {
  if (!ctx.permissions.has("clinic.settings.manage")) return null;
  const [t, screens, branches] = await Promise.all([getTranslations(), listScreens(ctx), listOperationalBranches(ctx)]);
  const hidden = <input type="hidden" name="$slug" value={ctx.tenant.slug} />;
  return (
    <Card className="mt-6">
      <CardHeader title={t("clinic.screens.title")} description={t("clinic.screens.hint")} />
      <CardBody className="space-y-4">
        {screens.length ? (
          <ul className="divide-y divide-border rounded-[12px] border border-border">
            {screens.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="block font-medium">{s.name}</span>
                  <span className="block text-[13px] text-text-2">{s.branch.name} · {t(s.voice ? "clinic.screens.voiceOn" : "clinic.screens.voiceOff")}</span>
                </span>
                <Form action={revokeScreenAction}>
                  {hidden}
                  <input type="hidden" name="id" value={s.id} />
                  <SubmitButton variant="secondary" size="sm">
                    {t("clinic.screens.revoke")}
                  </SubmitButton>
                </Form>
              </li>
            ))}
          </ul>
        ) : null}
        <Form action={createScreenAction} className="grid gap-3 sm:grid-cols-2 sm:items-end">
          {hidden}
          <TextField name="name" label={t("clinic.screens.name")} placeholder={t("clinic.screens.nameExample")} />
          {branches.length > 1 ? (
            <SelectField name="branchId" label={t("clinic.booking.branch")} options={branches.map((b) => ({ value: b.id, label: b.name }))} />
          ) : branches[0] ? (
            <input type="hidden" name="branchId" value={branches[0].id} />
          ) : null}
          <label className="flex items-center gap-2 text-[14px] sm:col-span-2">
            <input type="checkbox" name="voice" defaultChecked className="size-4 accent-[var(--accent)]" />
            <span>{t("clinic.screens.voice")}</span>
          </label>
          <div className="sm:col-span-2">
            <SubmitButton variant="secondary">{t("clinic.screens.create")}</SubmitButton>
          </div>
        </Form>
      </CardBody>
    </Card>
  );
}
