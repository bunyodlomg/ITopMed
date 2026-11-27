"use client";

import { Pill } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { useFormResult } from "@/components/ui/form";
import { medicineLabel, type MedicineOption } from "@/lib/medicines";

const inputClass =
  "block h-11 w-full rounded-[var(--radius-control)] border border-border-strong bg-surface-2 px-4 text-[15px] text-text placeholder:text-text-3 transition-[background-color,border-color,box-shadow] duration-150 hover:border-text-3 focus:border-accent focus:bg-surface focus:outline-none focus:ring-4 focus:ring-[var(--focus)] aria-[invalid=true]:border-danger";
const chipClass = "inline-flex min-h-8 items-center rounded-full border border-border bg-surface px-3 text-[12.5px] font-medium hover:border-accent hover:text-accent";

type Fields = { drug: string; inn: string; dose: string; frequency: string; route: string; durationDays: string; times: string; instructions: string };
const EMPTY: Fields = { drug: "", inn: "", dose: "", frequency: "", route: "", durationDays: "", times: "", instructions: "" };

/**
 * The prescription's medicine fields with a live search of the clinic's
 * medicine catalog: type a few letters of the trade name or the INN (Latin or
 * Cyrillic), pick with the mouse or the arrow keys + Enter, and the name, INN,
 * dose, frequency, times and days are filled from the catalog - all of them
 * stay editable. A typed medicine can be kept in the catalog for next time.
 */
export function MedicinePicker({ slug, canManage, doseSuggestions, tabletWord }: { slug: string; canManage: boolean; doseSuggestions: string[]; tabletWord: string }) {
  const t = useTranslations("clinic.rx");
  const tm = useTranslations("medicines");
  const result = useFormResult();
  const id = useId();
  const [f, setF] = useState<Fields>(() => ({ ...EMPTY, ...Object.fromEntries(Object.entries(result.values ?? {}).filter(([k]) => k in EMPTY)) }));
  const [medicineId, setMedicineId] = useState("");
  const [items, setItems] = useState<MedicineOption[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [picked, setPicked] = useState<MedicineOption | null>(null);
  const [save, setSave] = useState(true);
  const seq = useRef(0);
  const [seenNonce, setSeenNonce] = useState(result.nonce);
  // After a medicine was added the form stays open for the next one: start empty.
  if (result.nonce !== seenNonce) {
    setSeenNonce(result.nonce);
    if (result.ok) {
      setF(EMPTY);
      setMedicineId("");
      setPicked(null);
      setItems([]);
    }
  }

  useEffect(() => {
    if (!open) return;
    const q = f.drug.trim();
    const n = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/c/${encodeURIComponent(slug)}/medicines/search?q=${encodeURIComponent(q)}`, { headers: { Accept: "application/json" }, cache: "no-store" });
        if (!r.ok || n !== seq.current) return;
        const data = (await r.json()) as { items: MedicineOption[] };
        if (n === seq.current) {
          setItems(data.items);
          setActive(data.items.length ? 0 : -1);
        }
      } catch {
        /* offline or signed out: the fields keep working as plain text */
      }
    }, q ? 150 : 0);
    return () => clearTimeout(timer);
  }, [f.drug, open, slug]);

  const set = (k: keyof Fields, v: string) => setF((p) => ({ ...p, [k]: v }));
  const choose = (m: MedicineOption) => {
    setF((p) => ({
      drug: medicineLabel(m),
      inn: m.inn ?? "",
      dose: m.defaultDose ?? p.dose,
      frequency: m.defaultFrequency ?? p.frequency,
      route: m.defaultRoute ?? p.route,
      durationDays: m.defaultDays ? String(m.defaultDays) : p.durationDays,
      times: m.defaultTimes ?? p.times,
      instructions: m.instructions ?? p.instructions,
    }));
    setMedicineId(m.id);
    setPicked(m);
    setOpen(false);
  };
  const err = (k: string) => {
    const e = result.fieldErrors?.[k];
    return e ? e : null;
  };
  const tErr = useTranslations();
  const listId = `${id}-list`;
  const freq = t.raw("freqPresets") as string[];
  const notes = t.raw("instructionPresets") as string[];
  const timeSets = ["08:00", "08:00, 20:00", "08:00, 14:00, 20:00", "22:00"];

  const field = (k: keyof Fields, label: string, opts: { hint?: string; placeholder?: string; optional?: boolean; inputMode?: "numeric"; list?: string; required?: boolean } = {}) => (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={`${id}-${k}`} className="block text-[13px] font-medium">
        {label}
        {opts.optional ? <span className="ml-1 font-normal text-text-3">({tm("optional")})</span> : null}
      </label>
      <input
        id={`${id}-${k}`}
        name={k}
        value={f[k]}
        onChange={(e) => set(k, e.target.value)}
        placeholder={opts.placeholder}
        inputMode={opts.inputMode}
        list={opts.list}
        required={opts.required}
        autoComplete="off"
        aria-invalid={err(k) ? true : undefined}
        aria-describedby={err(k) || opts.hint ? `${id}-${k}-msg` : undefined}
        className={inputClass}
      />
      {err(k) ? (
        <p id={`${id}-${k}-msg`} className="text-[13px] text-danger">{tErr(err(k) as never)}</p>
      ) : opts.hint ? (
        <p id={`${id}-${k}-msg`} className="text-[12.5px] text-text-3">{opts.hint}</p>
      ) : null}
    </div>
  );

  return (
    <div className="space-y-4">
      <input type="hidden" name="medicineId" value={medicineId} />
      <div className="relative">
        <label htmlFor={`${id}-drug`} className="block text-[13px] font-medium">{t("drug")}</label>
        <div className="relative mt-1.5">
          {picked?.hasPhoto ? (
            // eslint-disable-next-line @next/next/no-img-element -- small private thumbnail served by our own route
            <img src={`/c/${slug}/medicines/${picked.id}/photo`} alt="" className="pointer-events-none absolute left-2 top-1/2 size-8 -translate-y-1/2 rounded-[6px] object-cover" />
          ) : (
            <Pill aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-text-3" />
          )}
          <input
            id={`${id}-drug`}
            name="drug"
            role="combobox"
            aria-expanded={open && items.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
            aria-invalid={err("drug") ? true : undefined}
            aria-describedby={`${id}-drug-msg`}
            value={f.drug}
            required
            autoComplete="off"
            spellCheck={false}
            placeholder={tm("searchPlaceholder")}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onChange={(e) => {
              set("drug", e.target.value);
              setOpen(true);
              if (medicineId) {
                setMedicineId("");
                setPicked(null);
              }
            }}
            onKeyDown={(e) => {
              if (!open || !items.length) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => (a + 1) % items.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => (a <= 0 ? items.length - 1 : a - 1));
              } else if (e.key === "Enter" && active >= 0) {
                e.preventDefault();
                choose(items[active]!);
              } else if (e.key === "Escape") setOpen(false);
            }}
            className={`${inputClass} pl-12`}
          />
        </div>
        {err("drug") ? (
          <p id={`${id}-drug-msg`} className="mt-1.5 text-[13px] text-danger">{tErr(err("drug") as never)}</p>
        ) : (
          <p id={`${id}-drug-msg`} className="mt-1.5 text-[12.5px] text-text-3">{picked ? tm("pickedHint") : tm("searchHint")}</p>
        )}
        {open && items.length > 0 ? (
          <ul id={listId} role="listbox" aria-label={tm("results")} className="absolute inset-x-0 top-[4.6rem] z-30 max-h-80 overflow-y-auto rounded-[var(--radius-control)] border border-border bg-surface p-1 shadow-lg">
            {items.map((m, i) => (
              <li
                key={m.id}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(m);
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex cursor-pointer items-center gap-3 rounded-[8px] px-2.5 py-2 ${i === active ? "bg-accent-soft" : ""}`}
              >
                {m.hasPhoto ? (
                  // eslint-disable-next-line @next/next/no-img-element -- small private thumbnail served by our own route
                  <img src={`/c/${slug}/medicines/${m.id}/photo`} alt="" className="size-10 shrink-0 rounded-[8px] border border-border object-cover" loading="lazy" />
                ) : (
                  <span className="grid size-10 shrink-0 place-items-center rounded-[8px] bg-sunken text-text-3"><Pill aria-hidden className="size-5" /></span>
                )}
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-semibold">
                    {medicineLabel(m)}
                    {m.inn ? <span className="font-normal text-text-2"> ({m.inn})</span> : null}
                  </span>
                  <span className="block truncate text-[12.5px] text-text-3">
                    {[tm(`form.${m.form}` as never), m.drugGroup, m.defaultDose, m.defaultFrequency].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {!medicineId && canManage && f.drug.trim().length >= 2 ? (
        <label className="flex items-start gap-2 text-[13.5px]">
          <input type="checkbox" name="saveToCatalog" checked={save} onChange={(e) => setSave(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" />
          <span>{tm("saveToCatalog")}</span>
        </label>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {field("inn", t("inn"), { hint: t("innHint"), optional: true })}
        {field("dose", t("dose"), { placeholder: t("dosePlaceholder"), hint: t("doseHint"), list: `${id}-dose`, required: true })}
        <datalist id={`${id}-dose`}>
          {doseSuggestions.map((d) => (
            <option key={d} value={`${d} ${tabletWord}`} />
          ))}
        </datalist>
        <div className="min-w-0 space-y-2">
          {field("frequency", t("frequency"), { placeholder: t("frequencyPlaceholder"), required: true })}
          <div className="flex flex-wrap gap-1.5" aria-label={t("frequency")}>
            {freq.map((x) => (
              <button key={x} type="button" onClick={() => set("frequency", x)} className={chipClass}>{x}</button>
            ))}
          </div>
        </div>
        <div className="min-w-0 space-y-2">
          {field("times", t("timesLabel"), { placeholder: "08:00, 20:00", hint: t("timesHint"), optional: true })}
          <div className="flex flex-wrap gap-1.5" aria-label={t("timesLabel")}>
            {timeSets.map((x) => (
              <button key={x} type="button" onClick={() => set("times", x)} className={chipClass}>{x}</button>
            ))}
          </div>
        </div>
        {field("route", t("route"), { placeholder: t("routePlaceholder"), optional: true })}
        {field("durationDays", t("duration"), { inputMode: "numeric", optional: true })}
      </div>
      <div className="space-y-2">
        <label htmlFor={`${id}-instructions`} className="block text-[13px] font-medium">
          {t("instructions")}
          <span className="ml-1 font-normal text-text-3">({tm("optional")})</span>
        </label>
        <textarea id={`${id}-instructions`} name="instructions" rows={2} value={f.instructions} onChange={(e) => set("instructions", e.target.value)} className={`${inputClass} h-auto py-2.5`} />
        <div className="flex flex-wrap gap-1.5">
          {notes.map((x) => (
            <button key={x} type="button" onClick={() => set("instructions", f.instructions.includes(x) ? f.instructions : [f.instructions.trim(), x].filter(Boolean).join(", "))} className={chipClass}>
              + {x}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
