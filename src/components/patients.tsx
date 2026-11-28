import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { LOCALES, LOCALE_NATIVE_NAMES } from "@/i18n/config";
import { SelectField, TextField } from "./ui/form";
import { buttonClass } from "./ui/primitives";

export function patientName(p: { lastName: string; firstName: string; middleName?: string | null }) {
  return [p.lastName, p.firstName, p.middleName].filter(Boolean).join(" ");
}

/** Birth dates are calendar dates (no time zone): always format in UTC. Year-only births show just the year. */
export async function formatBirthDate(d: Date, yearOnly = false) {
  if (yearOnly) return String(d.getUTCFullYear());
  const format = await getFormatter();
  return format.dateTime(d, { dateStyle: "medium", timeZone: "UTC" });
}

export async function PatientFields({
  initial,
}: {
  initial?: {
    lastName: string;
    firstName: string;
    middleName: string | null;
    birthDate: Date;
    sex: string;
    phone: string | null;
    address: string | null;
    preferredLocale: string | null;
    pinfl?: string;
    passport?: string;
  };
}) {
  const t = await getTranslations();
  const opt = t("common.optional");
  return (
    <div className="space-y-6">
      <fieldset className="grid gap-5 sm:grid-cols-6">
        <legend className="mb-3 text-[13px] font-semibold uppercase tracking-[0.04em] text-text-3">{t("clinic.patients.identity")}</legend>
        <TextField name="lastName" label={t("clinic.patients.lastName")} defaultValue={initial?.lastName} autoComplete="off" required className="sm:col-span-2" />
        <TextField name="firstName" label={t("clinic.patients.firstName")} defaultValue={initial?.firstName} autoComplete="off" required className="sm:col-span-2" />
        <TextField name="middleName" label={t("clinic.patients.middleName")} defaultValue={initial?.middleName} autoComplete="off" optionalLabel={opt} className="sm:col-span-2" />
        <TextField name="birthDate" type="date" label={t("clinic.patients.birthDate")} defaultValue={initial?.birthDate.toISOString().slice(0, 10)} required className="sm:col-span-2" />
        <SelectField name="sex" label={t("clinic.patients.sex")} defaultValue={initial?.sex ?? "UNKNOWN"} options={(["FEMALE", "MALE", "UNKNOWN"] as const).map((s) => ({ value: s, label: t(`sex.${s}`) }))} className="sm:col-span-2" />
        <SelectField
          name="preferredLocale"
          label={t("clinic.patients.preferredLocale")}
          defaultValue={initial?.preferredLocale ?? ""}
          options={[{ value: "", label: t("clinic.patients.noPreference") }, ...LOCALES.map((l) => ({ value: l, label: LOCALE_NATIVE_NAMES[l] }))]}
          className="sm:col-span-2"
        />
        <TextField name="pinfl" label={t("clinic.patients.pinfl")} hint={t("clinic.patients.pinflHint")} inputMode="numeric" defaultValue={initial?.pinfl} autoComplete="off" optionalLabel={opt} className="sm:col-span-3" />
        <TextField name="passport" label={t("clinic.patients.passport")} hint={t("clinic.patients.passportHint")} defaultValue={initial?.passport} autoComplete="off" optionalLabel={opt} className="sm:col-span-3" />
      </fieldset>
      <fieldset className="grid gap-5 sm:grid-cols-2">
        <legend className="mb-3 text-[13px] font-semibold uppercase tracking-[0.04em] text-text-3">{t("clinic.patients.contacts")}</legend>
        <TextField name="phone" type="tel" label={t("clinic.patients.phone")} inputMode="tel" placeholder="+998" defaultValue={initial?.phone} autoComplete="off" optionalLabel={opt} />
        <TextField name="address" label={t("clinic.patients.address")} defaultValue={initial?.address} autoComplete="off" optionalLabel={opt} className="sm:col-span-2" />
      </fieldset>
    </div>
  );
}

/**
 * Patient search used inside other workflows (booking, walk-in). Plain GET
 * form that keeps the other query parameters; results link back with ?patient=.
 */
export async function PatientPicker({
  results,
  q,
  keep,
  baseHref,
  visits,
  timeZone = "UTC",
}: {
  results: { id: string; mrn: string; lastName: string; firstName: string; middleName: string | null; birthDate: Date; birthYearOnly?: boolean; phone?: string | null }[] | null;
  q: string;
  keep: Record<string, string | undefined>;
  baseHref: string;
  /** Visit counts and the last visit (optional), shown under each match. */
  visits?: Map<string, { visits: number; last: { at: Date; doctor: string } | null; today: boolean }>;
  timeZone?: string;
}) {
  const t = await getTranslations();
  const format = await getFormatter();
  const params = (extra: Record<string, string>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...keep, ...extra })) if (v) sp.set(k, v);
    return `${baseHref}?${sp.toString()}`;
  };
  return (
    <div className="space-y-3">
      <form method="get" action={baseHref} className="flex gap-2">
        {Object.entries(keep).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
        <label className="flex-1">
          <span className="sr-only">{t("clinic.booking.findPatient")}</span>
          <input name="q" defaultValue={q} placeholder={t("clinic.patients.searchPlaceholder")} className="h-11 w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-3.5 text-[15px] focus:border-accent focus:outline-none focus:ring-4 focus:ring-[var(--focus)]" />
        </label>
        <button className={buttonClass("secondary", "lg")}>{t("common.search")}</button>
      </form>
      {results === null ? null : results.length === 0 ? (
        <p className="text-[14px] text-text-2">{t("clinic.patients.noResults")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {await Promise.all(
            results.map(async (p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-medium">{patientName(p)}</p>
                  <p className="text-[12.5px] text-text-3">
                    {p.mrn} · {await formatBirthDate(p.birthDate, p.birthYearOnly)}
                    {p.phone ? ` · ${p.phone}` : ""}
                  </p>
                  {visits?.get(p.id) ? (
                    <p className="text-[12.5px] text-text-2">
                      {visits.get(p.id)!.last
                        ? t("clinic.patients.lastVisitShort", { date: format.dateTime(visits.get(p.id)!.last!.at, { dateStyle: "medium", timeZone }), doctor: visits.get(p.id)!.last!.doctor }) + ` · ${t("clinic.patients.visitsCount", { count: visits.get(p.id)!.visits })}`
                        : t("clinic.patients.noVisits")}
                      {visits.get(p.id)!.today ? ` · ${t("clinic.patients.todayBadge")}` : ""}
                    </p>
                  ) : null}
                </div>
                <Link href={params({ patient: p.id, q: "" })} className={buttonClass("secondary", "sm")}>
                  {t("clinic.booking.choosePatient")}
                </Link>
              </li>
            )),
          )}
        </ul>
      )}
    </div>
  );
}
