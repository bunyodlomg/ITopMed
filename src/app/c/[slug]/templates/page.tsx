import { Download, Upload } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Drawer } from "@/components/ui/drawer";
import { Form, SubmitButton } from "@/components/ui/form";
import { Alert, Badge, ButtonLink, Card, CardBody, CardHeader, PageHeader, buttonClass } from "@/components/ui/primitives";
import { requireClinic } from "@/server/auth/guards";
import { listTemplates } from "@/server/clinic/templates";
import { importTemplatesAction, standardTemplatesAction } from "../../../practice-actions";

/** The clinic's own templates: printable documents and doctor's note templates. */
export default async function TemplatesPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ panel?: string }> }) {
  const { slug } = await params;
  const { panel } = await searchParams;
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
      <PageHeader
        title={t("templates.title")}
        description={t("templates.subtitle")}
        action={
          canManage ? (
            <>
              <ButtonLink href={`${base}?panel=import`} scroll={false} variant="secondary">
                <Upload aria-hidden className="size-4" />
                {t("templates.import")}
              </ButtonLink>
              {/* A file download, not a page: a plain link (no client-side navigation). */}
              <a href={`${base}/export`} download className={buttonClass("secondary")}>
                <Download aria-hidden className="size-4" />
                {t("templates.export")}
              </a>
            </>
          ) : null
        }
      />
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
      {canManage && panel === "import" ? (
        <Drawer title={t("templates.importTitle")} description={t("templates.importHint")} closeHref={base}>
          <Form action={importTemplatesAction}>
            <input type="hidden" name="$slug" value={ctx.tenant.slug} />
            <label className="block space-y-1.5">
              <span className="block text-[13px] font-medium">{t("templates.importFile")}</span>
              <input
                type="file"
                name="file"
                required
                accept=".json,application/json"
                className="block w-full text-[14px] file:mr-3 file:rounded-[var(--radius-control)] file:border file:border-border-strong file:bg-surface file:px-3 file:py-2 file:text-[14px]"
              />
            </label>
            <div className="flex justify-end">
              <SubmitButton>{t("templates.importSubmit")}</SubmitButton>
            </div>
          </Form>
        </Drawer>
      ) : null}
    </div>
  );
}
