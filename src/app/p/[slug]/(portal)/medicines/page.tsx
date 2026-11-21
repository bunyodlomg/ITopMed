import { getTranslations } from "next-intl/server";
import { TabletFractionPicture } from "@/components/tablet-fraction";
import { rxDrugLabel } from "@/lib/rx";
import { Card, CardHeader, PageHeader } from "@/components/ui/primitives";
import { listMyMedicines } from "@/server/portal/medicines";
import { requirePatient } from "@/server/portal/guards";

const dmy = (d: string) => d.split("-").reverse().join(".");

/** The patient's current medicines and intake times (opened from a Telegram reminder). */
export default async function PortalMedicinesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const p = await requirePatient(slug);
  const [t, list] = await Promise.all([getTranslations("portal.medicines"), listMyMedicines(p)]);
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <Card>
        <CardHeader title={t("current")} description={t("hint")} />
        {list.length === 0 ? (
          <p className="px-5 py-5 text-[14px] text-text-2 sm:px-6">{t("none")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {list.map((m) => (
              <li key={m.id} className="space-y-1.5 px-5 py-4 text-[14.5px] sm:px-6">
                <p className="break-words font-semibold">{rxDrugLabel(m)}</p>
                <p className="flex flex-wrap items-center gap-2 break-words">
                  <TabletFractionPicture dose={m.dose} />
                  <span>
                    {m.dose} · {m.frequency}
                    {m.route ? ` · ${m.route}` : ""}
                  </span>
                </p>
                {m.times ? (
                  <p>
                    <span className="text-text-2">{t("times")}:</span> <span className="font-semibold tabular-nums">{m.times}</span>
                  </p>
                ) : null}
                {m.instructions ? <p className="whitespace-pre-line break-words text-text-2">{m.instructions}</p> : null}
                <p className="text-[13px] text-text-3">{m.open ? t("noDuration") : t("until", { date: dmy(m.until) })}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="text-[13px] text-text-3">{t("note")}</p>
    </div>
  );
}
