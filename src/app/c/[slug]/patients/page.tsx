import { UserPlus, Users } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { formatBirthDate, patientName } from "@/components/patients";
import { ButtonLink, Card, CardHeader, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { SearchBox } from "@/components/ui/search-box";
import { Toolbar } from "@/components/ui/toolbar";
import { requireClinic } from "@/server/auth/guards";
import { listRecentPatients, searchPatients } from "@/server/patients/patients";

export default async function PatientsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ q?: string }> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug, "patients.read");
  const q = ((await searchParams).q ?? "").slice(0, 100).trim();
  const searching = q.length >= 2;
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  // Before anything is typed the list shows the latest registrations, so the page is never empty.
  const rows = searching ? await searchPatients(ctx, q) : await listRecentPatients(ctx);
  const base = `/c/${ctx.tenant.slug}/patients`;
  const birth = await Promise.all(rows.map((p) => formatBirthDate(p.birthDate)));

  return (
    <>
      <PageHeader
        title={t("clinic.patients.title")}
        description={t("clinic.patients.subtitle")}
        action={
          ctx.permissions.has("patients.create") ? (
            <ButtonLink href={`${base}/new`}>
              <UserPlus aria-hidden className="size-4" />
              {t("clinic.patients.register")}
            </ButtonLink>
          ) : null
        }
      />
      <Toolbar search={<SearchBox placeholder={t("clinic.patients.searchPlaceholder")} label={t("common.search")} clearLabel={t("common.clearSearch")} minLength={2} autoFocus />} />
      <Card className="overflow-hidden">
        <CardHeader title={searching ? t("clinic.patients.resultsTitle", { count: rows.length }) : t("clinic.patients.recentTitle")} />
        {rows.length === 0 ? (
          <EmptyState icon={<Users className="size-6" />} title={searching ? t("clinic.patients.noResults") : t("clinic.patients.noneYet")} />
        ) : (
          <Table caption={t("clinic.patients.title")}>
            <thead>
              <tr>
                <Th>{t("clinic.patients.colPatient")}</Th>
                <Th>{t("clinic.patients.colBirth")}</Th>
                <Th>{t("clinic.patients.colPhone")}</Th>
                {searching ? null : <Th>{t("clinic.patients.colRegistered")}</Th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={p.id}>
                  <Td>
                    <Link href={`${base}/${p.id}`} className="font-medium hover:text-accent">
                      {patientName(p)}
                    </Link>
                    <p className="font-mono text-[12px] text-text-3">{p.mrn}</p>
                  </Td>
                  <Td label={t("clinic.patients.colBirth")} className="text-text-2">
                    {birth[i]}
                  </Td>
                  <Td label={t("clinic.patients.colPhone")} className="tabular-nums text-text-2">
                    {p.phone ?? "—"}
                  </Td>
                  {"createdAt" in p ? (
                    <Td label={t("clinic.patients.colRegistered")} className="text-text-2">
                      {format.relativeTime(p.createdAt as Date)}
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
