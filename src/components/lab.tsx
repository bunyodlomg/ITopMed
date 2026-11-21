import { getFormatter, getTranslations } from "next-intl/server";
import type { FormState } from "@/lib/form-state";
import { Form, SubmitButton } from "./ui/form";
import { Badge, STATUS_TONE } from "./ui/primitives";

interface ResultRow {
  id: string;
  value: { toString(): string };
  unit: string;
  refLow: { toString(): string } | null;
  refHigh: { toString(): string } | null;
  flag: string;
  analyte: { name: string; sortOrder: number };
}

export interface LabOrderForDisplay {
  id: string;
  number: string;
  status: string;
  priority: string;
  orderedAt: Date;
  verifiedAt: Date | null;
  /** Set once the doctor has released verified results to the patient portal. */
  releasedAt?: Date | null;
  items: { id: string; name: string; results: ResultRow[] }[];
}

export function referenceRange(low: { toString(): string } | null, high: { toString(): string } | null) {
  if (low && high) return `${low.toString()}–${high.toString()}`;
  if (low) return `≥ ${low.toString()}`;
  if (high) return `≤ ${high.toString()}`;
  return "—";
}

/**
 * Lab results as clinicians see them: values only once VERIFIED (preliminary
 * numbers are never shown in the record), abnormal values flagged with text,
 * not colour alone.
 */
export async function LabResultsList({
  orders,
  timeZone,
  release,
}: {
  orders: LabOrderForDisplay[];
  timeZone: string;
  /** Doctors in a care relationship may release verified results to the patient portal. */
  release?: { slug: string; action: (s: FormState, fd: FormData) => Promise<FormState> };
}) {
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  if (orders.length === 0) return <p className="text-[14px] text-text-2">{t("clinic.labOrder.none")}</p>;
  return (
    <ul className="space-y-3">
      {orders.map((o) => (
        <li key={o.id} className="rounded-[12px] border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[14px]">
              <span className="font-mono font-semibold">{o.number}</span>
              <span className="text-text-2"> · {format.dateTime(o.orderedAt, { dateStyle: "medium", timeStyle: "short", timeZone })}</span>
              {o.priority === "URGENT" ? <span className="ml-2"><Badge tone="danger">{t("priority.URGENT")}</Badge></span> : null}
            </p>
            <span className="flex flex-wrap items-center gap-2">
              {o.releasedAt ? <Badge tone="success">{t("clinic.labOrder.releasedBadge")}</Badge> : null}
              <Badge tone={STATUS_TONE[o.status] ?? "neutral"}>{t(`status.${o.status}` as never)}</Badge>
            </span>
          </div>
          {release && o.status === "VERIFIED" && !o.releasedAt ? (
            <Form action={release.action} className="mt-2 space-y-2">
              <input type="hidden" name="$slug" value={release.slug} />
              <input type="hidden" name="orderId" value={o.id} />
              <SubmitButton variant="secondary" size="sm">
                {t("clinic.labOrder.release")}
              </SubmitButton>
            </Form>
          ) : null}
          {o.items.map((item) => (
            <div key={item.id} className="mt-2">
              <p className="text-[13px] font-semibold">{item.name}</p>
              {o.status !== "VERIFIED" ? (
                <p className="text-[13px] text-text-3">{t("clinic.lab.pending")}</p>
              ) : (
                <table className="mt-1 w-full text-[13.5px]">
                  <tbody>
                    {item.results
                      .slice()
                      .sort((a, b) => a.analyte.sortOrder - b.analyte.sortOrder)
                      .map((r) => (
                        <tr key={r.id} className="border-b border-border last:border-0">
                          <td className="py-1 pr-2">{r.analyte.name}</td>
                          <td className={`py-1 pr-2 text-right font-semibold tabular-nums ${r.flag !== "NORMAL" ? "text-danger" : ""}`}>
                            {r.value.toString()} <span className="text-[12px] font-normal text-text-3">{r.unit}</span>
                          </td>
                          <td className="py-1 pr-2 text-right text-[12px] text-text-3 tabular-nums">{referenceRange(r.refLow, r.refHigh)}</td>
                          <td className="py-1 text-right">{r.flag !== "NORMAL" ? <Badge tone="danger">{t(`labFlag.${r.flag}` as never)}</Badge> : null}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}
