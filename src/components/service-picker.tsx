"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useFormResult } from "@/components/ui/form";
import { formatMoneyText, parseMoney } from "@/lib/money";

export interface PickerService {
  id: string;
  name: string;
  /** Price in minor units as a string (bigint is not serialisable to the client). */
  priceMinor: string;
  currency: string;
}

const METHODS = ["CASH", "CARD", "PAYME", "CLICK", "UZUM", "BANK_TRANSFER"] as const;
/** Methods offered in a split payment (cash + card + transfer, as the clinics pay). */
const SPLIT_METHODS = ["CASH", "CARD", "BANK_TRANSFER"] as const;
type PayMode = "full" | "partial" | "split" | "debt";

/**
 * Services with prices as large tap targets, a live total and how the patient
 * pays: in full, in part, or on debt. Posts serviceIds[], payMode, amount and
 * method with the surrounding form. Prices are display only - the server
 * recomputes everything from the service catalogue.
 */
export function ServicePicker({ services, withPayment, initial = [], dense = false }: { services: PickerService[]; withPayment: boolean; initial?: string[]; /** Tighter tiles (the desk's step fits on one screen). */ dense?: boolean }) {
  const t = useTranslations("clinic.desk");
  const tm = useTranslations("paymentMethod");
  const locale = useLocale();
  const [chosen, setChosen] = useState<Set<string>>(new Set(initial));
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<PayMode>("full");
  const [split, setSplit] = useState<Record<string, string>>({});
  const [epoch, setEpoch] = useState(0);
  // After a successful submit the same page stays open (e.g. extra services in a visit):
  // clear the choice so a second click cannot bill the same services twice.
  const result = useFormResult();
  const [seenNonce, setSeenNonce] = useState(result.nonce);
  if (result.nonce !== seenNonce) {
    setSeenNonce(result.nonce);
    if (result.ok) {
      setChosen(new Set());
      setMode("full");
      setSplit({});
      setQ("");
    } else {
      // React resets the form after every action (the ticks would clear while the choice stays):
      // a new key re-mounts the controls from the remembered choice.
      setEpoch((n) => n + 1);
    }
  }
  const currency = services[0]?.currency ?? "UZS";
  const money = (minor: bigint) => formatMoneyText(minor, currency, locale);
  const total = services.filter((s) => chosen.has(s.id)).reduce((sum, s) => sum + BigInt(s.priceMinor), 0n);
  // Split payment: live sum of the parts; what is left is the patient's debt.
  const splitValues = SPLIT_METHODS.map((m) => (split[m]?.trim() ? parseMoney(split[m]!, currency) : 0n));
  const splitInvalid = splitValues.some((v) => v === null);
  const splitSum = splitValues.reduce<bigint>((s, v) => s + (v ?? 0n), 0n);
  const visible = q.trim() ? services.filter((s) => s.name.toLowerCase().includes(q.trim().toLowerCase())) : services;
  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div key={epoch} className="space-y-4">
      {services.length > 8 ? (
        <label className="block">
          <span className="sr-only">{t("searchServices")}</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("searchServices")}
            className="h-10 w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 text-[14px] focus:border-accent focus:outline-none focus:ring-4 focus:ring-[var(--focus)]"
          />
        </label>
      ) : null}
      <fieldset>
        <legend className="sr-only">{t("services")}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {visible.map((s) => {
            const on = chosen.has(s.id);
            return (
              <label
                key={s.id}
                className={`flex min-w-0 cursor-pointer items-center justify-between gap-3 rounded-[var(--radius-control)] border px-3 ${dense ? "py-1.5 text-[13.5px] leading-snug" : "py-2.5 text-[14px]"} transition-colors ${on ? "border-accent bg-accent-soft" : "border-border bg-surface-2 hover:border-border-strong"}`}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <input type="checkbox" name="serviceIds" value={s.id} checked={on} onChange={() => toggle(s.id)} className="size-4 shrink-0 accent-[var(--accent)]" />
                  <span className="min-w-0 break-words font-medium">{s.name}</span>
                </span>
                <span className="shrink-0 tabular-nums text-text-2">{money(BigInt(s.priceMinor))}</span>
              </label>
            );
          })}
        </div>
        {/* Chosen services hidden by the search box are still posted. */}
        {[...chosen].filter((id) => !visible.some((s) => s.id === id)).map((id) => (
          <input key={id} type="hidden" name="serviceIds" value={id} />
        ))}
      </fieldset>

      <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-[var(--radius-control)] bg-surface-2 px-4 py-3">
        <span className="text-[14px] text-text-2">
          {t("total")} · {t("chosenCount", { count: chosen.size })}
        </span>
        <span className="text-[22px] font-semibold tabular-nums">{money(total)}</span>
      </div>

      {withPayment && total > 0n ? (
        <fieldset className="space-y-3">
          <legend className="mb-2 text-[14px] font-medium">{t("payment")}</legend>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {(["full", "split", "partial", "debt"] as const).map((m) => (
              <label key={m} className={`flex cursor-pointer items-center gap-2 rounded-[var(--radius-control)] border px-3 py-2.5 text-[14px] ${mode === m ? "border-accent bg-accent-soft" : "border-border bg-surface-2"}`}>
                <input type="radio" name="payMode" value={m} checked={mode === m} onChange={() => setMode(m)} className="size-4 accent-[var(--accent)]" />
                <span className="font-medium">{t(`payMode.${m}`)}</span>
              </label>
            ))}
          </div>
          {mode === "partial" ? (
            <label className="block max-w-xs">
              <span className="mb-1.5 block text-[14px] font-medium">{t("amountNow")}</span>
              <input name="amount" inputMode="decimal" required placeholder="50 000" className="h-11 w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-3.5 text-[15px] tabular-nums focus:border-accent focus:outline-none focus:ring-4 focus:ring-[var(--focus)]" />
            </label>
          ) : null}
          {mode === "split" ? (
            <div className="space-y-3">
              <p className="text-[13px] text-text-2">{t("splitHint")}</p>
              <div className="grid gap-3 sm:grid-cols-3">
                {SPLIT_METHODS.map((m) => (
                  <label key={m} className="block min-w-0">
                    <span className="mb-1.5 block text-[14px] font-medium">{tm(m)}</span>
                    <input
                      name={`split_${m}`}
                      inputMode="decimal"
                      autoComplete="off"
                      value={split[m] ?? ""}
                      onChange={(e) => setSplit((prev) => ({ ...prev, [m]: e.target.value }))}
                      placeholder="0"
                      className="h-11 w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-3.5 text-[15px] tabular-nums focus:border-accent focus:outline-none focus:ring-4 focus:ring-[var(--focus)]"
                    />
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-[var(--radius-control)] border border-border px-4 py-2.5 text-[14px]" aria-live="polite">
                <span>
                  {t("splitSum")}: <span className="font-semibold tabular-nums">{money(splitSum)}</span>
                </span>
                {splitInvalid ? (
                  <span className="font-medium text-danger">{t("splitInvalid")}</span>
                ) : splitSum > total ? (
                  <span className="font-medium text-danger">{t("splitOver", { amount: money(splitSum - total) })}</span>
                ) : splitSum < total ? (
                  <span className="font-medium text-warning">{t("splitLeft", { amount: money(total - splitSum) })}</span>
                ) : (
                  <span className="font-medium text-success">{t("splitExact")}</span>
                )}
              </div>
            </div>
          ) : mode !== "debt" ? (
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("method")}>
              {METHODS.map((m, i) => (
                <label key={m} className="cursor-pointer">
                  <input type="radio" name="method" value={m} defaultChecked={i === 0} className="peer sr-only" />
                  <span className="inline-flex h-9 items-center rounded-full border border-border bg-surface px-3.5 text-[13px] font-medium peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:text-accent peer-focus-visible:ring-4 peer-focus-visible:ring-[var(--focus)]">{tm(m)}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-text-2">{t("debtHint")}</p>
          )}
        </fieldset>
      ) : (
        <input type="hidden" name="payMode" value={withPayment ? "full" : "debt"} />
      )}
    </div>
  );
}
