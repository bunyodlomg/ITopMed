import { getFormatter, getTranslations } from "next-intl/server";
import type { FormState } from "@/lib/form-state";
import { referenceRange } from "./lab";
import { Form, SubmitButton } from "./ui/form";
import { Badge, STATUS_TONE } from "./ui/primitives";

export interface PortalAppointment {
  id: string;
  startsAt: Date;
  status: string;
  canCancel: boolean;
  branch: { name: string; address: string | null; phone: string | null };
  service: { name: string } | null;
  doctor: { fullName: string; specialty: string } | null;
}

/** One appointment row; the cancel button only appears when the database would allow it. */
export async function AppointmentItem({ a, timeZone, slug, cancelAction }: { a: PortalAppointment; timeZone: string; slug: string; cancelAction?: (s: FormState, fd: FormData) => Promise<FormState> }) {
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
      <div className="min-w-0">
        <p className="text-[15px] font-semibold">{format.dateTime(a.startsAt, { weekday: "short", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone })}</p>
        <p className="mt-0.5 text-[14px] text-text-2">
          {a.doctor ? `${a.doctor.fullName} · ${t(`specialties.${a.doctor.specialty}` as never)}` : "—"}
          {a.service ? ` · ${a.service.name}` : ""}
        </p>
        <p className="text-[13px] text-text-3">
          {a.branch.name}
          {a.branch.address ? ` · ${a.branch.address}` : ""}
          {a.branch.phone ? ` · ${a.branch.phone}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Badge tone={STATUS_TONE[a.status] ?? "neutral"}>{t(`status.${a.status}` as never)}</Badge>
        {a.canCancel && cancelAction ? (
          <Form action={cancelAction} className="space-y-0">
            <input type="hidden" name="$slug" value={slug} />
            <input type="hidden" name="appointmentId" value={a.id} />
            <SubmitButton variant="secondary" size="sm">
              {t("portal.appointments.cancel")}
            </SubmitButton>
          </Form>
        ) : null}
      </div>
    </li>
  );
}

export interface PortalResultItem {
  id: string;
  name: string;
  results: { id: string; value: { toString(): string }; unit: string; refLow: { toString(): string } | null; refHigh: { toString(): string } | null; flag: string; analyte: { name: string; sortOrder: number } }[];
}

/** Released lab values with plain-language flags (text, not colour alone). */
export async function PortalResultTable({ items }: { items: PortalResultItem[] }) {
  const t = await getTranslations();
  return (
    <div className="space-y-4">
      {items.map((item) => (
        <div key={item.id}>
          <p className="text-[14px] font-semibold">{item.name}</p>
          <div className="mt-1 overflow-x-auto">
            <table className="w-full min-w-[420px] text-[14px]">
              <thead>
                <tr className="text-left text-[12px] uppercase tracking-[0.04em] text-text-3">
                  <th className="py-1 font-medium">{t("portal.results.test")}</th>
                  <th className="py-1 text-right font-medium">{t("portal.results.value")}</th>
                  <th className="py-1 text-right font-medium">{t("portal.results.normal")}</th>
                  <th className="py-1 text-right font-medium">
                    <span className="sr-only">{t("portal.results.flag")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {item.results
                  .slice()
                  .sort((a, b) => a.analyte.sortOrder - b.analyte.sortOrder)
                  .map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="py-1.5 pr-2">{r.analyte.name}</td>
                      <td className={`py-1.5 pr-2 text-right font-semibold tabular-nums ${r.flag !== "NORMAL" ? "text-danger" : ""}`}>
                        {r.value.toString()} <span className="text-[12px] font-normal text-text-3">{r.unit}</span>
                      </td>
                      <td className="py-1.5 pr-2 text-right text-[13px] tabular-nums text-text-3">{referenceRange(r.refLow, r.refHigh)}</td>
                      <td className="py-1.5 text-right">
                        {r.flag !== "NORMAL" ? <Badge tone="danger">{t(`labFlag.${r.flag}` as never)}</Badge> : <Badge tone="success">{t("labFlag.NORMAL")}</Badge>}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
