import { getTranslations } from "next-intl/server";
import { SelectField, TextAreaField, TextField } from "@/components/ui/form";
import { MEDICINE_FORMS, type MedicineOption } from "@/lib/medicines";

/** The catalog entry's fields (new entry in the drawer, or the entry's own page). */
export async function MedicineFields({ m }: { m?: MedicineOption }) {
  const t = await getTranslations("medicines");
  const opt = t("optional");
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <TextField name="name" label={t("name")} hint={t("nameHint")} defaultValue={m?.name} />
        <TextField name="strength" label={t("strength")} placeholder="5 mg" defaultValue={m?.strength ?? ""} optionalLabel={opt} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="inn" label={t("inn")} hint={t("innHint")} defaultValue={m?.inn ?? ""} optionalLabel={opt} />
        <SelectField name="form" label={t("formLabel")} defaultValue={m?.form ?? "tablet"} options={MEDICINE_FORMS.map((f) => ({ value: f, label: t(`form.${f}`) }))} />
        <TextField name="drugGroup" label={t("group")} hint={t("groupHint")} defaultValue={m?.drugGroup ?? ""} optionalLabel={opt} />
        <TextField name="manufacturer" label={t("manufacturer")} defaultValue={m?.manufacturer ?? ""} optionalLabel={opt} />
      </div>
      <fieldset className="space-y-4 rounded-[12px] border border-border p-4">
        <legend className="px-1 text-[14px] font-semibold">{t("defaults")}</legend>
        <p className="text-[12.5px] text-text-3">{t("defaultsHint")}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="defaultDose" label={t("dose")} placeholder={t("dosePlaceholder")} defaultValue={m?.defaultDose ?? ""} optionalLabel={opt} />
          <TextField name="defaultFrequency" label={t("frequency")} placeholder={t("frequencyPlaceholder")} defaultValue={m?.defaultFrequency ?? ""} optionalLabel={opt} />
          <TextField name="defaultTimes" label={t("times")} placeholder="08:00, 20:00" defaultValue={m?.defaultTimes ?? ""} optionalLabel={opt} />
          <TextField name="defaultDays" label={t("days")} inputMode="numeric" defaultValue={m?.defaultDays ? String(m.defaultDays) : ""} optionalLabel={opt} />
          <TextField name="defaultRoute" label={t("route")} placeholder={t("routePlaceholder")} defaultValue={m?.defaultRoute ?? ""} optionalLabel={opt} className="sm:col-span-2" />
        </div>
        <TextAreaField name="instructions" label={t("instructions")} rows={2} defaultValue={m?.instructions ?? ""} optionalLabel={opt} />
      </fieldset>
    </div>
  );
}
