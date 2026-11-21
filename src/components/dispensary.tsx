import { getTranslations } from "next-intl/server";
import { closeDispensaryAction, enrollDispensaryAction, followUpDoneAction } from "@/app/care-actions";
import { Form, SelectField, SubmitButton, TextAreaField, TextField } from "@/components/ui/form";
import { Badge, Card, CardBody, CardHeader } from "@/components/ui/primitives";
import { DISPENSARY_GROUPS } from "@/server/emr/dispensary";

type Plan = {
  id: string;
  doctorProfileId: string;
  group: (typeof DISPENSARY_GROUPS)[number];
  intervalDays: number;
  nextDueDate: Date;
  labs: string | null;
  note: string | null;
  doctor: { membership: { user: { fullName: string } } };
};

const dmy = (d: Date) => d.toISOString().slice(0, 10).split("-").reverse().join(".");

/** Follow-up plans of the patient in the visit; the treating doctor enrols, marks visits done and closes. */
export async function DispensaryCard({ plans, slug, patientId, encounterId, doctorProfileId, canWrite, today }: { plans: Plan[]; slug: string; patientId: string; encounterId: string; doctorProfileId: string | null; canWrite: boolean; today: string }) {
  const t = await getTranslations("clinic.dispensary");
  const tc = await getTranslations("common");
  const hidden = (
    <>
      <input type="hidden" name="$slug" value={slug} />
      <input type="hidden" name="encounterId" value={encounterId} />
    </>
  );
  return (
    <Card>
      <CardHeader title={t("title")} description={t("hint")} />
      <CardBody className="space-y-4">
        {plans.length === 0 ? <p className="text-[14px] text-text-2">{t("none")}</p> : null}
        <ul className="space-y-3">
          {plans.map((p) => {
            const due = p.nextDueDate.toISOString().slice(0, 10);
            const mine = canWrite && p.doctorProfileId === doctorProfileId;
            return (
              <li key={p.id} className="space-y-2 rounded-[12px] border border-border p-3 text-[14px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{t(`groups.${p.group}`)}</span>
                  <Badge tone={due < today ? "danger" : due === today ? "warning" : "neutral"}>{t("nextDue", { date: dmy(p.nextDueDate) })}</Badge>
                  <span className="text-text-3">{t("every", { days: p.intervalDays })}</span>
                </div>
                {p.labs ? (
                  <p>
                    <span className="text-text-2">{t("labs")}: </span>
                    {p.labs}
                  </p>
                ) : null}
                {p.note ? <p className="text-text-2">{p.note}</p> : null}
                <p className="text-[12.5px] text-text-3">{t("doctor", { name: p.doctor.membership.user.fullName })}</p>
                {mine ? (
                  <div className="flex flex-wrap gap-2">
                    <Form action={followUpDoneAction} className="space-y-0">
                      {hidden}
                      <input type="hidden" name="planId" value={p.id} />
                      <SubmitButton variant="secondary">{t("done")}</SubmitButton>
                    </Form>
                    <Form action={closeDispensaryAction} className="space-y-0">
                      {hidden}
                      <input type="hidden" name="planId" value={p.id} />
                      <SubmitButton variant="secondary">{t("close")}</SubmitButton>
                    </Form>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {canWrite && doctorProfileId ? (
          <details className="rounded-[12px] border border-border">
            <summary className="flex min-h-11 cursor-pointer items-center px-4 py-2 font-medium">{t("enroll")}</summary>
            <Form action={enrollDispensaryAction} className="space-y-3 border-t border-border p-4">
              {hidden}
              <input type="hidden" name="patientId" value={patientId} />
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField name="group" label={t("group")} options={DISPENSARY_GROUPS.map((g) => ({ value: g, label: t(`groups.${g}`) }))} />
                <TextField name="intervalDays" label={t("interval")} hint={t("intervalHint")} inputMode="numeric" defaultValue="30" required />
                <TextField name="firstDue" type="date" label={t("firstDue")} hint={t("firstDueHint")} optionalLabel={tc("optional")} />
                <TextField name="labs" label={t("labs")} placeholder={t("labsPlaceholder")} optionalLabel={tc("optional")} />
              </div>
              <TextAreaField name="note" label={t("note")} rows={2} optionalLabel={tc("optional")} />
              <SubmitButton variant="secondary">{t("enrollSubmit")}</SubmitButton>
            </Form>
          </details>
        ) : null}
      </CardBody>
    </Card>
  );
}
