import { Pill } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { MedicineFields } from "@/components/medicine-fields";
import { Form, SubmitButton } from "@/components/ui/form";
import { Alert, Badge, ButtonLink, Card, CardBody, CardHeader, DescriptionList, PageHeader, buttonClass } from "@/components/ui/primitives";
import { medicineLabel } from "@/lib/medicines";
import { requireClinic } from "@/server/auth/guards";
import { canUseMedicines, getMedicine } from "@/server/emr/medicines";
import { DomainError } from "@/server/errors";
import { archiveMedicineAction, saveMedicineAction } from "../../../../medicine-actions";

const PHOTO_CODES = ["saved", "removed", "noFile", "photoTooLarge", "photoType", "notFound"];

/** One medicine of the catalog: its details, usual dose and times, and the photo of the box / tablet. */
export default async function MedicinePage({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<{ created?: string; photo?: string }> }) {
  const { slug, id } = await params;
  const ctx = await requireClinic(slug);
  if (!canUseMedicines(ctx)) notFound();
  const sp = await searchParams;
  const t = await getTranslations();
  const m = await getMedicine(ctx, id).catch((e) => {
    if (e instanceof DomainError) notFound();
    throw e;
  });
  const canManage = ctx.permissions.has("medicines.manage");
  const base = `/c/${ctx.tenant.slug}/medicines`;
  const photoCode = sp.photo && PHOTO_CODES.includes(sp.photo) ? sp.photo : null;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <PageHeader
        eyebrow={t("medicines.title")}
        title={medicineLabel(m)}
        description={[m.inn, t(`medicines.form.${m.form}` as never), m.drugGroup].filter(Boolean).join(" · ")}
        action={
          <>
            {m.archivedAt ? <Badge tone="neutral">{t("medicines.archivedBadge")}</Badge> : null}
            <ButtonLink href={base} variant="secondary">{t("medicines.backToList")}</ButtonLink>
          </>
        }
      />
      {sp.created ? <Alert tone="success">{t("medicines.created")}</Alert> : null}
      {photoCode ? <Alert tone={photoCode === "saved" || photoCode === "removed" ? "success" : "danger"}>{t(`medicines.photoResult.${photoCode}` as never)}</Alert> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <Card className="min-w-0">
          <CardHeader title={canManage && !m.archivedAt ? t("medicines.edit") : t("medicines.details")} />
          <CardBody>
            {canManage && !m.archivedAt ? (
              <Form action={saveMedicineAction} className="space-y-5">
                <input type="hidden" name="$slug" value={ctx.tenant.slug} />
                <input type="hidden" name="medicineId" value={m.id} />
                <MedicineFields m={m} />
                <SubmitButton>{t("common.save")}</SubmitButton>
              </Form>
            ) : (
              <DescriptionList
                items={[
                  { label: t("medicines.inn"), value: m.inn ?? "—" },
                  { label: t("medicines.manufacturer"), value: m.manufacturer ?? "—" },
                  { label: t("medicines.dose"), value: m.defaultDose ?? "—" },
                  { label: t("medicines.frequency"), value: m.defaultFrequency ?? "—" },
                  { label: t("medicines.times"), value: m.defaultTimes ?? "—" },
                  { label: t("medicines.days"), value: m.defaultDays ?? "—" },
                  { label: t("medicines.route"), value: m.defaultRoute ?? "—" },
                  { label: t("medicines.instructions"), value: m.instructions ?? "—" },
                ]}
              />
            )}
          </CardBody>
        </Card>

        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title={t("medicines.photo")} description={canManage ? t("medicines.photoHint") : undefined} />
            <CardBody className="space-y-4">
              {m.hasPhoto ? (
                // eslint-disable-next-line @next/next/no-img-element -- private image from our own route
                <img src={`${base}/${m.id}/photo`} alt={t("medicines.photoAlt", { name: medicineLabel(m) })} className="aspect-square w-full rounded-[12px] border border-border bg-sunken object-contain" />
              ) : (
                <div className="grid aspect-square w-full place-items-center rounded-[12px] border border-dashed border-border bg-sunken text-text-3">
                  <Pill aria-hidden className="size-10" />
                </div>
              )}
              {canManage && !m.archivedAt ? (
                <>
                  <form method="post" action={`${base}/${m.id}/photo`} encType="multipart/form-data" className="space-y-2">
                    <input type="hidden" name="$slug" value={ctx.tenant.slug} />
                    <label className="block text-[13px]">
                      <span className="sr-only">{t("medicines.choosePhoto")}</span>
                      <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" capture="environment" className="w-full text-[13px]" />
                    </label>
                    <button className={buttonClass("secondary", "sm")}>{m.hasPhoto ? t("medicines.replacePhoto") : t("medicines.uploadPhoto")}</button>
                  </form>
                  {m.hasPhoto ? (
                    <form method="post" action={`${base}/${m.id}/photo`} encType="multipart/form-data">
                      <input type="hidden" name="remove" value="1" />
                      <button className="min-h-8 text-[13px] text-text-3 hover:text-danger">{t("medicines.removePhoto")}</button>
                    </form>
                  ) : null}
                </>
              ) : null}
            </CardBody>
          </Card>
          <Card>
            <CardBody className="space-y-3">
              <p className="text-[14px]">{t("medicines.usedTimes", { count: m.usageCount })}</p>
              {canManage ? (
                <Form action={archiveMedicineAction} className="space-y-0">
                  <input type="hidden" name="$slug" value={ctx.tenant.slug} />
                  <input type="hidden" name="medicineId" value={m.id} />
                  {m.archivedAt ? (
                    <button name="op" value="restore" className={buttonClass("secondary", "sm")}>{t("medicines.restore")}</button>
                  ) : (
                    <button name="op" value="archive" className={buttonClass("ghost", "sm", "text-danger")}>{t("medicines.archive")}</button>
                  )}
                </Form>
              ) : null}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
