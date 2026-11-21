import { getTranslations } from "next-intl/server";
import { HomeReadingsTable } from "@/components/home-readings";
import { Form, SubmitButton, TextField } from "@/components/ui/form";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/primitives";
import { listMyReadings } from "@/server/emr/readings";
import { requirePatient } from "@/server/portal/guards";
import { portalReadingAction } from "../../../../portal-actions";

/** Home blood pressure and pulse: the patient adds a measurement; the clinic's doctors see them in the visit. */
export default async function PortalReadingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const p = await requirePatient(slug);
  const [t, readings] = await Promise.all([getTranslations("portal.readings"), listMyReadings(p)]);
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <Card>
        <CardHeader title={t("add")} description={t("telegramHint")} />
        <CardBody>
          <Form action={portalReadingAction} className="space-y-4">
            <input type="hidden" name="$slug" value={p.tenant.slug} />
            <div className="grid gap-3 sm:grid-cols-3">
              <TextField name="systolic" label={t("systolic")} inputMode="numeric" required />
              <TextField name="diastolic" label={t("diastolic")} inputMode="numeric" required />
              <TextField name="pulse" label={t("pulse")} inputMode="numeric" />
            </div>
            <SubmitButton>{t("save")}</SubmitButton>
          </Form>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={t("history")} />
        {readings.length === 0 ? <p className="px-5 py-5 text-[14px] text-text-2 sm:px-6">{t("none")}</p> : <HomeReadingsTable readings={readings} timeZone={p.tenant.timezone} caption={t("history")} />}
      </Card>
      <p className="text-[13px] text-text-3">{t("note")}</p>
    </div>
  );
}
