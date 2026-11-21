import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Form, SubmitButton } from "@/components/ui/form";
import { Alert, Badge, ButtonLink, Card, CardBody, CardHeader, PageHeader } from "@/components/ui/primitives";
import { requireClinic } from "@/server/auth/guards";
import { listTemplates } from "@/server/clinic/templates";
import { standardTemplatesAction } from "../../../practice-actions";

/** The clinic's own templates: printable documents and doctor's note templates. */
export default async function TemplatesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug, "clinic.settings.read");
  const [t, list] = await Promise.all([getTranslations(), listTemplates(ctx)]);
  const canManage = ctx.permissions.has("clinic.settings.manage");
  const base = `/c/${ctx.tenant.slug}/templates`;
  const docs = list.filter((x) => x.kind === "DOCUMENT");
  const notes = list.filter((x) => x.kind === "NOTE");
  const studies = list.filter((x) => x.kind === "DIAGNOSTIC");
  const schemes = list.filter((x) => x.kind === "PRESCRIPTION");
  const section = (title: string, hint: string, items: typeof list, kind: "DOCUMENT" | "NOTE" | "DIAGNOSTIC" | "PRESCRIPTION") => (
    <Card>
      <CardHeader
        title={title}
        description={hint}
        action={canManage ? <ButtonLink href={`${base}/new?kind=${kind}`} size="sm">{t("templates.new")}</ButtonLink> : null}
      />
      {items.length === 0 ? (
        <CardBody>
          <p className="text-[14px] text-text-2">{t("templates.none")}</p>
        </CardBody>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((x) => (
            <li key={x.id}>
              <Link href={`${base}/${x.id}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 hover:bg-sunken sm:px-6">
                <span className="min-w-0 font-medium">{x.name}</span>
                {x.specialty ? <Badge tone="accent">{t(`specialties.${x.specialty}` as never)}</Badge> : <Badge tone="neutral">{t("templates.allSpecialties")}</Badge>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <PageHeader title={t("templates.title")} description={t("templates.subtitle")} />
      {list.length === 0 && canManage ? (
        <Alert tone="neutral">
          <div className="space-y-3">
            <p>{t("templates.emptyHint")}</p>
            <Form action={standardTemplatesAction} className="space-y-0">
              <input type="hidden" name="$slug" value={ctx.tenant.slug} />
              <SubmitButton variant="secondary">{t("templates.addStandard")}</SubmitButton>
            </Form>
          </div>
        </Alert>
      ) : null}
      {section(t("templates.documents"), t("templates.documentsHint"), docs, "DOCUMENT")}
      {section(t("templates.notes"), t("templates.notesHint"), notes, "NOTE")}
      {section(t("templates.schemes"), t("templates.schemesHint"), schemes, "PRESCRIPTION")}
      {section(t("templates.studies"), t("templates.studiesHint"), studies, "DIAGNOSTIC")}
      {list.length > 0 && canManage ? (
        <Form action={standardTemplatesAction} className="space-y-0">
          <input type="hidden" name="$slug" value={ctx.tenant.slug} />
          <SubmitButton variant="secondary">{t("templates.addStandard")}</SubmitButton>
        </Form>
      ) : null}
    </div>
  );
}
