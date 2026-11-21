import { notFound } from "next/navigation";
import { TabletFractionPicture } from "@/components/tablet-fraction";
import { rxDrugLabel } from "@/lib/rx";
import { getFormatter, getTranslations } from "next-intl/server";
import { formatBirthDate, patientName } from "@/components/patients";
import { PrintButton } from "@/components/print-button";
import { requireClinic } from "@/server/auth/guards";
import { withAppContext } from "@/server/db";
import { getEncounter } from "@/server/emr/record";
import { requestMeta } from "@/server/http";
import { DomainError } from "@/server/tenancy/provisioning";

/**
 * Printable prescription (A5). Access follows the medical-record rules (care
 * relationship, audited). Only ACTIVE prescriptions are printed. This is a
 * paper prescription signed and stamped by the doctor — not the national
 * electronic prescription system (that needs an official integration).
 */
export default async function PrescriptionPrintPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const ctx = await requireClinic(slug, "emr.read");
  const data = await getEncounter(ctx, id, await requestMeta()).catch((e) => {
    if (e instanceof DomainError) notFound();
    throw e;
  });
  const e = data.encounter;
  const items = e.prescriptions.filter((p) => p.status === "ACTIVE");
  // Lab tests ordered in this visit and not yet taken: highlighted so the patient does not skip them.
  const labsToTake = [...new Set(data.labOrders.filter((o) => o.status === "ORDERED").flatMap((o) => o.items.map((i) => i.name)))];
  if (items.length === 0) notFound();
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  const info = await withAppContext({ tenantId: ctx.tenant.id, userId: ctx.principal.user.id }, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenant.id }, select: { name: true, legalName: true, address: true, contactPhone: true } });
    const doctor = e.doctorProfileId
      ? await tx.doctorProfile.findUnique({ where: { id: e.doctorProfileId }, select: { specialty: true, licenseNumber: true, membership: { select: { user: { select: { fullName: true } } } } } })
      : null;
    return { tenant, doctor };
  });
  const tz = ctx.tenant.timezone;

  return (
    <div className="mx-auto max-w-xl space-y-4 print:max-w-none">
      <div className="flex justify-end print:hidden">
        <PrintButton label={t("clinic.rx.printNow")} />
      </div>
      <article className="space-y-5 rounded-[16px] border border-border bg-surface p-6 text-[14px] print:border-0 print:p-0">
        <header className="border-b border-border pb-3 text-center">
          <p className="text-[16px] font-semibold">{info.tenant.legalName ?? info.tenant.name}</p>
          {info.tenant.address ? <p className="text-[12px] text-text-2">{info.tenant.address}</p> : null}
          {info.tenant.contactPhone ? <p className="text-[12px] text-text-2">{info.tenant.contactPhone}</p> : null}
        </header>

        <div className="text-center">
          <p className="text-[18px] font-semibold tracking-[0.08em]">{t("clinic.rx.paperTitle")}</p>
          <p className="text-[13px] text-text-2">{format.dateTime(e.startedAt, { dateStyle: "long", timeZone: tz })}</p>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-text-2">{t("clinic.billing.patient")}</dt>
          <dd className="font-medium">{patientName(e.patient)}</dd>
          <dt className="text-text-2">{t("clinic.patients.birthDate")}</dt>
          <dd>{formatBirthDate(e.patient.birthDate)}</dd>
          <dt className="text-text-2">{t("clinic.patients.mrn")}</dt>
          <dd className="font-mono">{e.patient.mrn}</dd>
        </dl>

        <ol className="space-y-3">
          {items.map((p, i) => (
            <li key={p.id} className="border-t border-border pt-3">
              <p className="font-semibold">
                {i + 1}. Rp.: {rxDrugLabel(p)}
              </p>
              <p>
                <TabletFractionPicture dose={p.dose} />{" "}
                {[p.dose, p.frequency, p.route, p.durationDays ? t("clinic.rx.days", { count: p.durationDays }) : null].filter(Boolean).join(" · ")}
              </p>
              {p.times ? (
                // Intake hours stand out in red, the way doctors mark them by hand, so patients do not miss a dose.
                <p className="flex flex-wrap items-center gap-1.5">
                  <span className="text-text-2">{t("clinic.rx.intakeTimes")}:</span>
                  {p.times.split(",").map((time) => (
                    <span key={time} data-intake-time className="rounded-[6px] border-2 border-danger px-1.5 font-bold text-danger tabular-nums [print-color-adjust:exact] [-webkit-print-color-adjust:exact]">
                      {time.trim()}
                    </span>
                  ))}
                </p>
              ) : null}
              {p.instructions ? <p className="text-text-2">{p.instructions}</p> : null}
            </li>
          ))}
        </ol>

        {labsToTake.length > 0 ? (
          <section className="space-y-1 border-t border-border pt-3">
            <p className="font-semibold">{t("clinic.rx.labsToTake")}</p>
            <ul className="space-y-1">
              {labsToTake.map((name) => (
                <li key={name} data-highlight className="border-l-4 border-warning bg-warning-soft px-2 py-0.5 font-semibold [print-color-adjust:exact] [-webkit-print-color-adjust:exact]">
                  {name}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="space-y-6 border-t border-border pt-4">
          <p>
            <span className="text-text-2">{t("clinic.rx.doctor")}: </span>
            <span className="font-medium">{info.doctor?.membership.user.fullName ?? "—"}</span>
            {info.doctor ? <span className="text-text-2"> · {t(`specialties.${info.doctor.specialty}` as never)}</span> : null}
            {info.doctor?.licenseNumber ? <span className="text-text-2"> · {t("clinic.rx.license")} {info.doctor.licenseNumber}</span> : null}
          </p>
          <div className="flex flex-wrap justify-between gap-6 text-[13px] text-text-2">
            <span>{t("clinic.rx.signature")}: ______________________</span>
            <span>{t("clinic.rx.stamp")}</span>
          </div>
          <p className="text-[12px] text-text-3">{t("clinic.rx.notElectronic")}</p>
        </footer>
      </article>
    </div>
  );
}
