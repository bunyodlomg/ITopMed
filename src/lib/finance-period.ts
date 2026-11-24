/**
 * Periods of the dashboard's money overview (clinic-local calendar days,
 * "YYYY-MM-DD"). Pure functions: no time zone here — the caller passes the
 * clinic's "today".
 */
export const PERIODS = ["today", "yesterday", "week", "month", "lastMonth", "custom"] as const;
export type PeriodKey = (typeof PERIODS)[number];

/** The longest custom range (a year and a day, so a full leap year fits). */
export const MAX_DAYS = 366;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);

export function isDay(v: unknown): v is string {
  return typeof v === "string" && DATE.test(v) && fmt(toDate(v)) === v;
}

export function plusDays(day: string, n: number): string {
  const d = toDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86_400_000) + 1;
}

export interface Period {
  key: PeriodKey;
  from: string;
  to: string;
  /** The same number of days right before: what the period is compared with. */
  prevFrom: string;
  prevTo: string;
  days: number;
}

/** Resolves a period; anything invalid falls back to "this month". */
export function resolvePeriod(today: string, key?: string, from?: string, to?: string): Period {
  const k: PeriodKey = (PERIODS as readonly string[]).includes(key ?? "") ? (key as PeriodKey) : "month";
  let f = today;
  let t = today;
  if (k === "yesterday") f = t = plusDays(today, -1);
  else if (k === "week") f = plusDays(today, -((toDate(today).getUTCDay() + 6) % 7)); // Monday
  else if (k === "month") f = `${today.slice(0, 8)}01`;
  else if (k === "lastMonth") {
    t = plusDays(`${today.slice(0, 8)}01`, -1);
    f = `${t.slice(0, 8)}01`;
  } else if (k === "custom") {
    if (!isDay(from) || !isDay(to) || from > to || to > today) return resolvePeriod(today, "month");
    f = from;
    t = daysBetween(from, to) > MAX_DAYS ? plusDays(from, MAX_DAYS - 1) : to;
  }
  const days = daysBetween(f, t);
  const prevTo = plusDays(f, -1);
  return { key: k, from: f, to: t, prevFrom: plusDays(prevTo, -(days - 1)), prevTo, days };
}

/** How the clinic thinks about the money: cash, card (terminal), everything else (transfer, Payme, Click, Uzum…). */
export type MethodGroup = "cash" | "card" | "other";
export function methodGroup(method: string): MethodGroup {
  return method === "CASH" ? "cash" : method === "CARD" ? "card" : "other";
}

export interface Bucket {
  key: string;
  cash: bigint;
  card: bigint;
  other: bigint;
}

/**
 * Chart buckets: one per day for up to 31 days (every day present, empty ones
 * at zero), otherwise one per calendar month.
 */
export function buckets(p: Pick<Period, "from" | "to" | "days">, rows: { day: string; method: string; net: bigint }[]): { unit: "day" | "month"; items: Bucket[] } {
  const unit = p.days <= 31 ? "day" : "month";
  const map = new Map<string, Bucket>();
  for (let d = p.from; d <= p.to; d = plusDays(d, 1)) {
    const key = unit === "day" ? d : d.slice(0, 7);
    if (!map.has(key)) map.set(key, { key, cash: 0n, card: 0n, other: 0n });
  }
  for (const r of rows) {
    const b = map.get(unit === "day" ? r.day : r.day.slice(0, 7));
    if (b) b[methodGroup(r.method)] += r.net;
  }
  return { unit, items: [...map.values()] };
}

/** Percentage change, rounded; null when there is nothing to compare with. */
export function change(now: bigint, before: bigint): { value: number; direction: "up" | "down" | "flat" } | null {
  if (before <= 0n) return null;
  const pct = Math.round((Number(now - before) / Number(before)) * 100);
  return { value: Math.abs(pct), direction: pct > 0 ? "up" : pct < 0 ? "down" : "flat" };
}
