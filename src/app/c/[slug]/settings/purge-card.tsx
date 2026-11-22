import { getTranslations } from "next-intl/server";
import { Form, SubmitButton, TextField } from "@/components/ui/form";
import { Alert, Card, CardBody, CardHeader } from "@/components/ui/primitives";
import type { ClinicContext } from "@/server/auth/clinic-auth";
import { purgePatientsAction } from "../../../data-actions";

/** Clinic settings → remove the test patients before real work starts. Clinic owner only. */
export async function PurgeCard({ ctx }: { ctx: ClinicContext }) {
  if (!ctx.roleKeys.includes("clinic_owner") || !ctx.permissions.has("clinic.settings.manage")) return null;
  const t = await getTranslations();
  const s = ctx.tenant.slug;
  return (
    <Card className="mt-6">
      <CardHeader title={t("clinic.purge.title")} description={t("clinic.purge.hint")} />
      <CardBody className="space-y-4">
        <Alert tone="warning" title={t("clinic.purge.warningTitle")}>
          {t("clinic.purge.warning")}
        </Alert>
        <Form action={purgePatientsAction}>
          <input type="hidden" name="$slug" value={s} />
          <TextField name="confirm" label={t("clinic.purge.confirmLabel", { slug: s })} hint={t("clinic.purge.confirmHint")} autoComplete="off" required />
          <SubmitButton variant="danger" pendingLabel={t("clinic.purge.working")}>
            {t("clinic.purge.submit")}
          </SubmitButton>
        </Form>
      </CardBody>
    </Card>
  );
}
