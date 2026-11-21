import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { moneyFormatter } from "@/components/money";
import { Form, SelectField, SubmitButton, TextField } from "@/components/ui/form";
import { Badge, Card, CardBody, CardHeader, PageHeader, Table, Td, Th, buttonClass } from "@/components/ui/primitives";
import { requireClinic } from "@/server/auth/guards";
import { listOperationalBranches } from "@/server/clinic/context";
import { EXPIRY_WARNING_DAYS, INVENTORY_CATEGORIES, INVENTORY_UNITS, WRITE_OFF_REASONS, getItem, listIssueDepartments, listSuppliers } from "@/server/inventory/inventory";
import { addDays, localDateToDbDate, todayIn } from "@/server/scheduling/time";
import { itemAction, stockAction } from "../../../../inventory-hr-actions";

const KIND_TONE = { RECEIPT: "success", ISSUE: "accent", DISPENSE: "accent", ADJUSTMENT: "warning", WRITE_OFF: "danger" } as const;

export default async function InventoryItemPage({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<{ branch?: string }> }) {
  const { slug, id } = await params;
  const ctx = await requireClinic(slug);
  if (!ctx.permissions.has("inventory.read") && !ctx.permissions.has("inventory.dispense")) notFound();
  const canManage = ctx.permissions.has("inventory.manage");
  const canIssue = ctx.permissions.has("inventory.dispense");
  const sp = await searchParams;
  const [t, format, money, data, branches] = await Promise.all([getTranslations(), getFormatter(), moneyFormatter(), getItem(ctx, id), listOperationalBranches(ctx)]);
  if (!data) notFound();
  const [suppliers, departments] = await Promise.all([canManage ? listSuppliers(ctx) : Promise.resolve([]), canIssue ? listIssueDepartments(ctx) : Promise.resolve([])]);
  const { item, batches, movements } = data;
  const s = ctx.tenant.slug;
  const defaultBranch = branches.find((b) => b.id === sp.branch)?.id ?? branches[0]?.id ?? "";
  const today = localDateToDbDate(todayIn(ctx.tenant.timezone));
  const soon = localDateToDbDate(addDays(todayIn(ctx.tenant.timezone), EXPIRY_WARNING_DAYS));
  const unit = t(`inventoryUnit.${item.unit}` as never);
  const d = (x: Date) => format.dateTime(x, { dateStyle: "medium", timeZone: "UTC" });
  const usable = batches.filter((b) => b.quantity > 0 && (!b.expiresOn || b.expiresOn >= today));
  const branchOptions = branches.map((b) => ({ value: b.id, label: b.name }));
  const hidden = (
    <>
      <input type="hidden" name="$slug" value={s} />
      <input type="hidden" name="itemId" value={item.id} />
    </>
  );

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        eyebrow={`${t("clinic.inventory.title")} · ${item.code}`}
        title={item.name}
        description={[t(`inventoryCategory.${item.category}`), item.form, item.strength].filter(Boolean).join(" · ")}
        action={item.archivedAt ? <Badge>{t("clinic.inventory.archived")}</Badge> : <Badge tone="accent">{t("clinic.inventory.onHandTotal", { count: usable.reduce((n, b) => n + b.quantity, 0), unit })}</Badge>}
      />

      {!item.archivedAt && (canIssue || canManage) ? (
        <div className="grid gap-6 lg:grid-cols-2">
          {canIssue ? (
            <Card>
              <CardHeader title={t("clinic.inventory.issueTitle")} description={t("clinic.inventory.issueHint")} />
              <CardBody>
                <Form action={stockAction}>
                  {hidden}
                  <input type="hidden" name="op" value="issue" />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <SelectField name="kind" label={t("clinic.inventory.issueKind")} options={(["DISPENSE", "ISSUE"] as const).map((k) => ({ value: k, label: t(`clinic.inventory.kindOption.${k}`) }))} />
                    <TextField name="quantity" label={`${t("clinic.inventory.quantity")} (${unit})`} inputMode="numeric" required />
                    <TextField name="patientMrn" label={t("clinic.inventory.patientMrn")} hint={t("clinic.inventory.patientMrnHint")} placeholder="P-000001" />
                    <SelectField name="departmentId" label={t("clinic.inventory.department")} hint={t("clinic.inventory.departmentHint")} options={[{ value: "", label: "—" }, ...departments.map((x) => ({ value: x.id, label: x.name }))]} />
                    {branches.length > 1 ? <SelectField name="branchId" label={t("clinic.inventory.branch")} defaultValue={defaultBranch} options={branchOptions} /> : <input type="hidden" name="branchId" value={defaultBranch} />}
                  </div>
                  <SubmitButton>{t("clinic.inventory.issueSubmit")}</SubmitButton>
                </Form>
              </CardBody>
            </Card>
          ) : null}
          {canManage ? (
            <Card>
              <CardHeader title={t("clinic.inventory.receiveTitle")} description={t("clinic.inventory.receiveHint")} />
              <CardBody>
                <Form action={stockAction}>
                  {hidden}
                  <input type="hidden" name="op" value="receive" />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <TextField name="lotNumber" label={t("clinic.inventory.lot")} required />
                    <TextField name="expiresOn" type="date" label={t("clinic.inventory.expiresOn")} optionalLabel={t("common.optional")} />
                    <TextField name="quantity" label={`${t("clinic.inventory.quantity")} (${unit})`} inputMode="numeric" required />
                    <TextField name="unitCost" label={t("clinic.inventory.unitCost", { currency: ctx.tenant.currency })} inputMode="decimal" optionalLabel={t("common.optional")} />
                    <SelectField name="supplierId" label={t("clinic.inventory.supplier")} options={[{ value: "", label: "—" }, ...suppliers.map((x) => ({ value: x.id, label: x.name }))]} />
                    <TextField name="documentRef" label={t("clinic.inventory.documentRef")} optionalLabel={t("common.optional")} />
                    {branches.length > 1 ? <SelectField name="branchId" label={t("clinic.inventory.branch")} defaultValue={defaultBranch} options={branchOptions} /> : <input type="hidden" name="branchId" value={defaultBranch} />}
                  </div>
                  <SubmitButton variant="secondary">{t("clinic.inventory.receiveSubmit")}</SubmitButton>
                </Form>
              </CardBody>
            </Card>
          ) : null}
        </div>
      ) : null}

      <Card>
        <CardHeader title={t("clinic.inventory.batches")} description={t("clinic.inventory.batchesHint")} />
        {batches.length === 0 ? (
          <CardBody>
            <p className="text-[14px] text-text-2">{t("clinic.inventory.noBatches")}</p>
          </CardBody>
        ) : (
          <Table caption={t("clinic.inventory.batches")}>
            <thead>
              <tr>
                <Th>{t("clinic.inventory.lot")}</Th>
                <Th>{t("clinic.inventory.expiresOn")}</Th>
                <Th className="text-right">{t("clinic.inventory.quantity")}</Th>
                <Th>{t("clinic.inventory.source")}</Th>
                {canManage ? <Th>{t("clinic.inventory.actions")}</Th> : null}
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => {
                const expired = b.expiresOn !== null && b.expiresOn < today;
                return (
                  <tr key={b.id} className={b.quantity === 0 ? "text-text-3" : ""}>
                    <Td>
                      <span className="font-mono">{b.lotNumber}</span>
                      {branches.length > 1 ? <p className="text-[12px] text-text-3">{b.branch.name}</p> : null}
                    </Td>
                    <Td>
                      <span className="flex flex-wrap items-center gap-2 tabular-nums">
                        {b.expiresOn ? d(b.expiresOn) : "—"}
                        {expired && b.quantity > 0 ? <Badge tone="danger">{t("clinic.inventory.expired")}</Badge> : !expired && b.expiresOn && b.expiresOn <= soon && b.quantity > 0 ? <Badge tone="warning">{t("clinic.inventory.soon")}</Badge> : null}
                      </span>
                    </Td>
                    <Td label={t("clinic.inventory.quantity")} className="text-right font-semibold tabular-nums">{b.quantity}</Td>
                    <Td className="text-[13px] text-text-2">
                      {d(b.receivedAt)}
                      {b.supplier ? ` · ${b.supplier.name}` : ""}
                      {b.unitCostMinor !== null ? ` · ${money(b.unitCostMinor, b.currency)}` : ""}
                    </Td>
                    {canManage ? (
                      <Td>
                        {b.quantity > 0 || !expired ? (
                          <details className="text-[13px]">
                            <summary className="cursor-pointer font-medium text-accent">{t("clinic.inventory.batchActions")}</summary>
                            <div className="mt-2 grid gap-3">
                              {b.quantity > 0 ? (
                                <Form action={stockAction} className="space-y-2">
                                  <input type="hidden" name="$slug" value={s} />
                                  <input type="hidden" name="batchId" value={b.id} />
                                  <input type="hidden" name="op" value="writeOff" />
                                  <div className="grid grid-cols-2 gap-2">
                                    <TextField name="quantity" label={t("clinic.inventory.quantity")} inputMode="numeric" defaultValue={expired ? String(b.quantity) : undefined} required />
                                    <SelectField name="reason" label={t("clinic.inventory.reason")} defaultValue={expired ? "EXPIRED" : "DAMAGED"} options={WRITE_OFF_REASONS.map((r) => ({ value: r, label: t(`stockReason.${r}`) }))} />
                                  </div>
                                  <SubmitButton variant="danger" size="sm">{t("clinic.inventory.writeOff")}</SubmitButton>
                                </Form>
                              ) : null}
                              <Form action={stockAction} className="space-y-2">
                                <input type="hidden" name="$slug" value={s} />
                                <input type="hidden" name="batchId" value={b.id} />
                                <input type="hidden" name="op" value="count" />
                                <TextField name="counted" label={t("clinic.inventory.counted")} inputMode="numeric" defaultValue={String(b.quantity)} required />
                                <SubmitButton variant="secondary" size="sm">{t("clinic.inventory.recordCount")}</SubmitButton>
                              </Form>
                            </div>
                          </details>
                        ) : null}
                      </Td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title={t("clinic.inventory.movements")} description={t("clinic.inventory.movementsHint")} />
        {movements.length === 0 ? (
          <CardBody>
            <p className="text-[14px] text-text-2">{t("clinic.inventory.noMovements")}</p>
          </CardBody>
        ) : (
          <ul className="divide-y divide-border">
            {movements.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-2.5 text-[14px]">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone={KIND_TONE[m.kind]}>{t(`stockKind.${m.kind}`)}</Badge>
                    <span className="font-mono text-[13px]">{m.batch.lotNumber}</span>
                    {m.reason ? <span className="text-text-2">· {t(`stockReason.${m.reason}`)}</span> : null}
                    {m.patient ? <span className="text-text-2">· {m.patient.mrn}</span> : null}
                    {m.documentRef ? <span className="text-text-2">· {m.documentRef}</span> : null}
                  </p>
                  <p className="text-[12.5px] text-text-3">
                    {format.dateTime(m.createdAt, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.tenant.timezone })} · {m.createdByName ?? "—"}
                    {branches.length > 1 ? ` · ${m.branch.name}` : ""}
                  </p>
                </div>
                <span className={`font-semibold tabular-nums ${m.quantity < 0 ? "text-danger" : "text-success"}`}>
                  {m.quantity > 0 ? `+${m.quantity}` : m.quantity} {unit}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canManage && !item.archivedAt ? (
        <details className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
          <summary className="cursor-pointer text-[15px] font-semibold">{t("clinic.inventory.editItem")}</summary>
          <Form action={itemAction} className="mt-4">
            {hidden}
            <div className="grid gap-3 sm:grid-cols-4">
              <TextField name="code" label={t("clinic.inventory.code")} defaultValue={item.code} required />
              <TextField name="name" label={t("clinic.inventory.name")} defaultValue={item.name} required className="sm:col-span-3" />
              <SelectField name="category" label={t("clinic.inventory.category")} defaultValue={item.category} options={INVENTORY_CATEGORIES.map((c) => ({ value: c, label: t(`inventoryCategory.${c}`) }))} />
              <TextField name="form" label={t("clinic.inventory.form")} defaultValue={item.form} optionalLabel={t("common.optional")} />
              <TextField name="strength" label={t("clinic.inventory.strength")} defaultValue={item.strength} optionalLabel={t("common.optional")} />
              <SelectField name="unit" label={t("clinic.inventory.unit")} defaultValue={item.unit} options={INVENTORY_UNITS.map((u) => ({ value: u, label: t(`inventoryUnit.${u}`) }))} />
              <TextField name="minStock" label={t("clinic.inventory.minStock")} defaultValue={String(item.minStock)} inputMode="numeric" />
              <TextField name="barcode" label={t("clinic.inventory.barcode")} defaultValue={item.barcode} optionalLabel={t("common.optional")} />
            </div>
            <div className="flex flex-wrap gap-3">
              <SubmitButton>{t("common.save")}</SubmitButton>
              <button name="op" value="archive" className={buttonClass("ghost")}>
                {t("clinic.inventory.archive")}
              </button>
            </div>
          </Form>
        </details>
      ) : null}
    </div>
  );
}
