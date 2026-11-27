"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { formatMoneyText, parseMoney } from "@/lib/money";

const METHODS = ["CASH", "CARD", "PAYME", "CLICK", "UZUM", "BANK_TRANSFER"] as const;
const SPLIT_METHODS = ["CASH", "CARD", "BANK_TRANSFER"] as const;
type Mode = "all" | "split" | "partial";

const inputClass =
  "h-12 w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-3.5 text-[17px] tabular-nums focus:border-accent focus:outline-none focus:ring-4 focus:ring-[var(--focus)]";

/**
 * How the patient pays what they owe at the cashier: everything with one
 * method, split over several (cash + card + transfer) or a part now. Posts
 * payMode, method, amount and split_<METHOD> with the surrounding form; the
 * server re-reads the debt and refuses anything above it.
 */
export function DebtPayment({ owedMinor, currency }: { owedMinor: string; currency: string }) {
  const t = useTranslations("clinic.checkout");
  const tm = useTranslations("paymentMethod");
  const locale = useLocale();
  const owed = BigInt(owedMinor);
  const money = (m: bigint) => formatMoneyText(m, currency, locale);
  const [mode, setMode] = useState<Mode>("all");
  const [split, setSplit] = useState<Record<string, string>>({});
  const [given, setGiven] = useState("");
  const values = SPLIT_METHODS.map((m) => (split[m]?.trim() ? parseMoney(split[m]!, currency) : 0n));
  const invalid = values.some((v) => v === null);
  const sum = values.reduce<bigint>((s, v) => s + (v ?? 0n), 0n);
  // Change to give back when the patient hands over more cash than owed (paying everything in cash).
  const givenMinor = given.trim() ? parseMoney(given, currency) : null;
  const change = givenMinor !== null && givenMinor > owed ? givenMinor - owed : 0n;

  return (
    <fieldset className="space-y-4">
      <legend className="sr-only">{t("howToPay")}</legend>
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t("howToPay")}>
        {(["all", "split", "partial"] as const).map((m) => (
          <label key={m} className={`flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-control)] border px-2 text-center text-[14px] font-semibold ${mode === m ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface-2"}`}>
            <input type="radio" name="payMode" value={m} checked={mode === m} onChange={() => setMode(m)} className="sr-only" />
            {t(`mode.${m}`)}
          </label>
        ))}
      </div>

      {mode === "split" ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            {SPLIT_METHODS.map((m) => (
              <label key={m} className="block min-w-0">
                <span className="mb-1.5 block text-[14px] font-medium">{tm(m)}</span>
                <input name={`split_${m}`} inputMode="decimal" autoComplete="off" value={split[m] ?? ""} onChange={(e) => setSplit((p) => ({ ...p, [m]: e.target.value }))} placeholder="0" className={inputClass} />
              </label>
            ))}
          </div>
          <p className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-[var(--radius-control)] border border-border px-4 py-2.5 text-[14px]" aria-live="polite">
            <span>
              {t("splitSum")}: <span className="font-semibold tabular-nums">{money(sum)}</span>
            </span>
            {invalid ? (
              <span className="font-medium text-danger">{t("splitInvalid")}</span>
            ) : sum > owed ? (
              <span className="font-medium text-danger">{t("splitOver", { amount: money(sum - owed) })}</span>
            ) : sum < owed ? (
              <span className="font-medium text-warning">{t("splitLeft", { amount: money(owed - sum) })}</span>
            ) : (
              <span className="font-medium text-success">{t("splitExact")}</span>
            )}
          </p>
        </div>
      ) : (
        <>
          {mode === "partial" ? (
            <label className="block max-w-xs">
              <span className="mb-1.5 block text-[14px] font-medium">{t("amountNow")}</span>
              <input name="amount" inputMode="decimal" required autoComplete="off" placeholder="50 000" className={inputClass} />
            </label>
          ) : null}
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("method")}>
            {METHODS.map((m, i) => (
              <label key={m} className="cursor-pointer">
                <input type="radio" name="method" value={m} defaultChecked={i === 0} className="peer sr-only" />
                <span className="inline-flex h-10 items-center rounded-full border border-border bg-surface px-4 text-[14px] font-medium peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:text-accent peer-focus-visible:ring-4 peer-focus-visible:ring-[var(--focus)]">{tm(m)}</span>
              </label>
            ))}
          </div>
          {mode === "all" ? (
            <div className="flex flex-wrap items-end gap-4">
              <label className="block w-full max-w-[14rem]">
                <span className="mb-1.5 block text-[13px] font-medium text-text-2">{t("cashGiven")}</span>
                <input inputMode="decimal" autoComplete="off" value={given} onChange={(e) => setGiven(e.target.value)} placeholder={money(owed)} className={inputClass} />
              </label>
              {change > 0n ? (
                <p className="pb-3 text-[15px]" aria-live="polite">
                  {t("change")}: <span className="font-bold tabular-nums">{money(change)}</span>
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </fieldset>
  );
}
