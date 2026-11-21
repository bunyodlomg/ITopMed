import { HeartPulse } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { patientName } from "@/components/patients";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { requireClinic } from "@/server/auth/guards";
import { dispensaryWorklist } from "@/server/emr/dispensary";
import { recentCheckIns } from "@/server/emr/checkins";
import { CHECKIN_TONE } from "@/components/home-readings";
import { requestMeta } from "@/server/http";
import { instantToLocalDate } from "@/server/scheduling/time";

const dmy = (d: Date) => d.toISOString().slice(0, 10).split("-").reverse().join(".");

/** The doctor's follow-up ("dispanser") patients, nearest due date first; overdue ones stand out. */
export default async function DispensaryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug, "emr.read");
  const meta = await requestMeta();
  const [t, list, checkIns] = await Promise.all([getTranslations(), dispensaryWorklist(ctx, meta), recentCheckIns(ctx, meta)]);
  const tc = (k: string, v?: Record<string, string | number>) => t(`homeReadings.${k}` as never, v as never);
  const td = (k: string, v?: Record<string, string | number>) => t(`clinic.dispensary.${k}` as never, v as never);
  const overdue = list.plans.filter((p) => p.nextDueDate.toISOString().slice(0, 10) < list.today).length;

  return (
    <>
      <PageHeader title={td("listTitle")} description={td("listHint")} />
      <Card className="overflow-hidden">
        {list.plans.length === 0 ? (
          <EmptyState icon={<HeartPulse className="size-6" />} title={td("listEmpty")} description={td("listEmptyHint")} />
        ) : (
          <>
            {overdue > 0 ? <p className="px-5 pt-4 text-[14px] font-medium text-danger sm:px-6">{td("overdueCount", { count: overdue })}</p> : null}
            <Table caption={td("listTitle")}>
              <thead>
                <tr>
                  <Th>{td("colPatient")}</Th>
                  <Th>{td("group")}</Th>
                  <Th>{td("colDue")}</Th>
                  <Th>{td("labs")}</Th>
                  <Th>{td("colDoctor")}</Th>
                </tr>
              </thead>
              <tbody>
                {list.plans.map((p) => {
                  const due = p.nextDueDate.toISOString().slice(0, 10);
                  return (
                    <tr key={p.id} className="hover:bg-surface-2">
                      <Td>
                        <Link href={`/c/${ctx.tenant.slug}/patients/${p.patient.id}`} className="font-medium hover:text-accent">
                          {patientName(p.patient)}
                        </Link>
                        <p className="text-[12.5px] text-text-3">
                          {p.patient.mrn}
                          {p.patient.phone ? ` · ${p.patient.phone}` : ""}
                        </p>
                      </Td>
                      <Td label={td("group")}>{td(`groups.${p.group}`)}</Td>
                      <Td label={td("colDue")} className="tabular-nums">
                        <Badge tone={due < list.today ? "danger" : due === list.today ? "warning" : "neutral"}>{dmy(p.nextDueDate)}</Badge>
                        <p className="text-[12.5px] text-text-3">{td("every", { days: p.intervalDays })}</p>
                      </Td>
                      <Td label={td("labs")} className="text-text-2">{p.labs ?? "—"}</Td>
                      <Td label={td("colDoctor")} className="text-text-2">{p.doctor.membership.user.fullName}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </>
        )}
      </Card>

      <Card className="mt-6 overflow-hidden">
        <CardHeader title={tc("checkInsTitle")} description={tc("checkInsHint")} />
        {checkIns.length === 0 ? (
          <p className="px-5 py-5 text-[14px] text-text-2 sm:px-6">{tc("checkInsEmpty")}</p>
        ) : (
          <Table caption={tc("checkInsTitle")}>
            <thead>
              <tr>
                <Th>{td("colPatient")}</Th>
                <Th>{tc("checkIn")}</Th>
                <Th>{tc("answeredAt")}</Th>
              </tr>
            </thead>
            <tbody>
              {checkIns.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <Link href={`/c/${ctx.tenant.slug}/encounters/${c.encounterId}`} className="font-medium hover:text-accent">
                      {patientName(c.patient)}
                    </Link>
                    <p className="text-[12.5px] text-text-3">
                      {c.patient.mrn}
                      {c.patient.phone ? ` · ${c.patient.phone}` : ""}
                    </p>
                  </Td>
                  <Td label={tc("checkIn")}>
                    <Badge tone={CHECKIN_TONE[c.answer!]}>{tc(`answer.${c.answer}`)}</Badge>
                  </Td>
                  <Td label={tc("answeredAt")} className="tabular-nums text-text-2">
                    {instantToLocalDate(c.answeredAt!, ctx.tenant.timezone).split("-").reverse().join(".")}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
