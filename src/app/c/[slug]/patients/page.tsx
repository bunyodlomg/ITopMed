import { ConciergeBell, FileHeart, UserPlus, Users } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { moneyFormatter } from "@/components/money";
import { formatBirthDate, patientName } from "@/components/patients";
import { Badge, ButtonLink, Card, CardHeader, EmptyState, PageHeader, Table, Td, Th, buttonClass } from "@/components/ui/primitives";
import { SearchBox } from "@/components/ui/search-box";
import { FilterChips, Toolbar, hrefWith } from "@/components/ui/toolbar";
import { requireClinic } from "@/server/auth/guards";
import { ageOn, listPatients, patientVisitSummaries, type PatientListFilter } from "@/server/patients/overview";
import { searchPatients } from "@/server/patients/patients";
import { todayMoney } from "@/server/reception/desk";
import { todayIn } from "@/server/scheduling/time";

const FILTERS: PatientListFilter[] = ["recent", "today", "debt", "new"];

/**
 * Patients: search (name, phone, card number, birth year or date, PINFL), or a
 * quick list — latest, today's, with an unpaid bill, new this month. Each row
 * shows what tells patients apart at the desk: age, phone, visits, the last
 * visit, today's queue and debt, with the next step one click away.
 */
export default async function PatientsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ q?: string; f?: string }> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug, "patients.read");
  const sp = await searchParams;
  const q = (sp.q ?? "").slice(0, 100).trim();
  const searching = q.length >= 2;
  const seesMoney = ctx.permissions.has("billing.read") || ctx.permissions.has("billing.charge");
  const filter: PatientListFilter = FILTERS.includes(sp.f as PatientListFilter) && (sp.f !== "debt" || seesMoney) ? (sp.f as PatientListFilter) : "recent";
  const [t, format, money] = await Promise.all([getTranslations(), getFormatter(), moneyFormatter()]);
  const rows = searching ? await searchPatients(ctx, q) : await listPatients(ctx, filter);
  const ids = rows.map((r) => r.id);
  const [visits, debts] = await Promise.all([patientVisitSummaries(ctx, ids), seesMoney ? todayMoney(ctx, ids).then((m) => m.debt) : Promise.resolve(new Map<string, bigint>())]);
  const base = `/c/${ctx.tenant.slug}/patients`;
  const tz = ctx.tenant.timezone;
  const today = todayIn(tz);
  const toDesk = ctx.permissions.has("queue.manage");
  const toRecord = ctx.permissions.has("emr.read");
  const birth = await Promise.all(rows.map((p) => formatBirthDate(p.birthDate, p.birthYearOnly)));
  const current = { q: sp.q, f: sp.f };
  const chips = FILTERS.filter((f) => f !== "debt" || seesMoney).map((f) => ({
    label: t(`clinic.patients.filter.${f}`),
    href: hrefWith(base, current, { f: f === "recent" ? undefined : f, q: undefined }),
    active: !searching && f === filter,
  }));

  return (
    <>
      <PageHeader
        title={t("clinic.patients.title")}
        description={t("clinic.patients.subtitle")}
        action={
          ctx.permissions.has("patients.create") ? (
            <ButtonLink href={toDesk ? `/c/${ctx.tenant.slug}/desk` : `${base}/new`}>
              <UserPlus aria-hidden className="size-4" />
              {t("clinic.patients.register")}
            </ButtonLink>
          ) : null
        }
      />
      <Toolbar
        search={<SearchBox placeholder={t("clinic.patients.searchPlaceholder")} label={t("common.search")} clearLabel={t("common.clearSearch")} minLength={2} autoFocus />}
        filters={<FilterChips chips={chips} label={t("clinic.patients.filterLabel")} />}
      />
      <p className="-mt-1 mb-3 text-[12.5px] text-text-3">{t("clinic.patients.searchTips")}</p>
      <Card className="overflow-hidden">
        <CardHeader title={searching ? t("clinic.patients.resultsTitle", { count: rows.length }) : t(`clinic.patients.filterTitle.${filter}`)} />
        {rows.length === 0 ? (
          <EmptyState icon={<Users className="size-6" />} title={searching ? t("clinic.patients.noResults") : t("clinic.patients.noneYet")} />
        ) : (
          <Table caption={t("clinic.patients.title")}>
            <thead>
              <tr>
                <Th>{t("clinic.patients.colPatient")}</Th>
                <Th>{t("clinic.patients.colBirth")}</Th>
                <Th>{t("clinic.patients.colPhone")}</Th>
                <Th>{t("clinic.patients.colVisits")}</Th>
                <Th>
                  <span className="sr-only">{t("common.actions")}</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => {
                const v = visits.get(p.id);
                const owes = debts.get(p.id) ?? 0n;
                return (
                  <tr key={p.id}>
                    <Td>
                      <Link href={`${base}/${p.id}`} className="font-medium hover:text-accent">
                        {patientName(p)}
                      </Link>
                      <p className="font-mono text-[12px] text-text-3">{p.mrn}</p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {v?.today ? <Badge tone="accent">{t("clinic.patients.todayBadge")}</Badge> : null}
                        {owes > 0n ? <Badge tone="danger">{t("clinic.desk.debtShort", { amount: money(owes, ctx.tenant.currency) })}</Badge> : null}
                      </div>
                    </Td>
                    <Td label={t("clinic.patients.colBirth")} className="text-text-2">
                      <span className="block">{t("clinic.desk.age", { age: ageOn(p.birthDate, today) })}</span>
                      <span className="text-[12.5px] text-text-3">{birth[i]}</span>
                    </Td>
                    <Td label={t("clinic.patients.colPhone")} className="tabular-nums text-text-2">
                      {p.phone ?? "—"}
                    </Td>
                    <Td label={t("clinic.patients.colVisits")} className="text-text-2">
                      {v && v.visits > 0 && v.last ? (
                        <>
                          <span className="block text-text">{t("clinic.patients.visitsCount", { count: v.visits })}</span>
                          <span className="block text-[12.5px] text-text-3">
                            {t("clinic.patients.lastVisitShort", { date: format.dateTime(v.last.at, { dateStyle: "medium", timeZone: tz }), doctor: v.last.doctor })}
                          </span>
                        </>
                      ) : (
                        <span className="text-[13px] text-text-3">{t("clinic.patients.noVisits")}</span>
                      )}
                      {v?.next ? <span className="block text-[12.5px] text-accent">{t("clinic.patients.nextVisit", { date: format.dateTime(v.next.at, { dateStyle: "medium", timeStyle: "short", timeZone: tz }) })}</span> : null}
                    </Td>
                    <Td className="text-right">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {toDesk ? (
                          <Link href={`/c/${ctx.tenant.slug}/desk?patient=${p.id}`} className={buttonClass("secondary", "sm")}>
                            <ConciergeBell aria-hidden className="size-4" />
                            {t("clinic.patients.toQueue")}
                          </Link>
                        ) : null}
                        {toRecord ? (
                          <Link href={`${base}/${p.id}/record`} className={buttonClass("ghost", "sm")}>
                            <FileHeart aria-hidden className="size-4" />
                            {t("clinic.patients.recordShort")}
                          </Link>
                        ) : null}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
