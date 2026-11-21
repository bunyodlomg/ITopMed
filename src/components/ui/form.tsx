"use client";

import { useTranslations } from "next-intl";
import { createContext, useActionState, useContext, useId, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { FormState } from "@/lib/form-state";
import { Alert, buttonClass, cx } from "./primitives";

type Action = (state: FormState, fd: FormData) => Promise<FormState>;

const Ctx = createContext<FormState>({});

/**
 * Progressive-enhancement form bound to a server action. Works without
 * JavaScript; with JS, shows localized field errors inline and keeps input.
 */
export function Form({
  action,
  children,
  className,
  successMessage,
}: {
  action: Action;
  children: ReactNode;
  className?: string;
  successMessage?: string;
}) {
  const [state, formAction] = useActionState(action, {});
  const t = useTranslations();
  return (
    <Ctx.Provider value={state}>
      <form action={formAction} className={cx("space-y-5", className)} noValidate>
        {state.message ? (
          <Alert tone={state.ok ? "success" : "danger"} key={state.nonce}>
            {t(state.message as never, state.messageValues as never)}
          </Alert>
        ) : state.ok && successMessage ? (
          <Alert tone="success" key={state.nonce}>
            {t(successMessage as never)}
          </Alert>
        ) : null}
        {children}
      </form>
    </Ctx.Provider>
  );
}

const inputClass =
  // Filled well that turns white on focus; the border stays so the field's edge is always visible.
  "block w-full rounded-[var(--radius-control)] border border-border-strong bg-surface-2 px-4 text-[15px] text-text placeholder:text-text-3 transition-[background-color,border-color,box-shadow] duration-150 hover:border-text-3 focus:border-accent focus:bg-surface focus:outline-none focus:ring-4 focus:ring-[var(--focus)] aria-[invalid=true]:border-danger";

interface FieldProps {
  name: string;
  label: string;
  hint?: string;
  optionalLabel?: string;
  className?: string;
}

function useField(name: string) {
  const state = useContext(Ctx);
  const t = useTranslations();
  const err = state.fieldErrors?.[name];
  return { error: err ? t(err as never) : undefined, value: state.values?.[name] };
}

function FieldShell({ id, label, hint, optionalLabel, error, children, className }: FieldProps & { id: string; error?: string; children: ReactNode }) {
  return (
    <div className={cx("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-[13px] font-medium text-text">
        {label}
        {optionalLabel ? <span className="ml-1 font-normal text-text-3">({optionalLabel})</span> : null}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-[13px] text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[12.5px] text-text-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextField({
  type = "text",
  defaultValue,
  autoComplete,
  placeholder,
  inputMode,
  required,
  autoFocus,
  list,
  ...field
}: FieldProps & {
  /** id of a <datalist> with suggested values (the field stays free text). */
  list?: string;
  type?: string;
  defaultValue?: string | null;
  autoComplete?: string;
  placeholder?: string;
  inputMode?: "text" | "email" | "numeric" | "decimal" | "tel";
  required?: boolean;
  autoFocus?: boolean;
}) {
  const id = useId();
  const { error, value } = useField(field.name);
  const keep = type !== "password";
  return (
    <FieldShell {...field} id={id} error={error}>
      <input
        id={id}
        name={field.name}
        type={type}
        defaultValue={keep ? (value ?? defaultValue ?? undefined) : undefined}
        autoComplete={autoComplete}
        placeholder={placeholder}
        inputMode={inputMode}
        required={required}
        autoFocus={autoFocus}
        list={list}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : field.hint ? `${id}-hint` : undefined}
        className={cx(inputClass, "h-11")}
      />
    </FieldShell>
  );
}

export function SelectField({ options, defaultValue, ...field }: FieldProps & { options: { value: string; label: string }[]; defaultValue?: string }) {
  const id = useId();
  const { error, value } = useField(field.name);
  return (
    <FieldShell {...field} id={id} error={error}>
      <select
        id={id}
        name={field.name}
        defaultValue={value ?? defaultValue}
        aria-invalid={error ? true : undefined}
        className={cx(inputClass, "h-11 appearance-none bg-[length:16px] bg-[right_12px_center] bg-no-repeat pr-10")}
        style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2386868b' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function CheckboxGroup({ name, label, hint, options }: { name: string; label: string; hint?: string; options: { value: string; label: string }[] }) {
  const { error } = useField(name);
  const id = useId();
  return (
    <fieldset aria-describedby={error ? `${id}-error` : undefined}>
      <legend className="text-[13px] font-medium">{label}</legend>
      {hint ? <p className="mt-0.5 text-[12.5px] text-text-3">{hint}</p> : null}
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <label key={o.value} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--radius-control)] border border-border bg-surface-2 px-3 text-[14px] has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
            <input type="checkbox" name={name} value={o.value} className="size-4 accent-[var(--accent)]" />
            {o.label}
          </label>
        ))}
      </div>
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export function SubmitButton({ children, pendingLabel, variant = "primary", className, full }: { children: ReactNode; pendingLabel?: string; variant?: "primary" | "secondary" | "danger"; className?: string; full?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={buttonClass(variant, "lg", cx(full && "w-full", className))}>
      {pending ? (
        <>
          <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
          {pendingLabel ?? children}
        </>
      ) : (
        children
      )}
    </button>
  );
}

/** Current form state (for components that render action results, e.g. duplicate review). */
export function useFormResult(): FormState {
  return useContext(Ctx);
}

export function TextAreaField({ rows = 4, defaultValue, placeholder, readOnly, ...field }: FieldProps & { rows?: number; defaultValue?: string | null; placeholder?: string; readOnly?: boolean }) {
  const id = useId();
  const { error, value } = useField(field.name);
  return (
    <FieldShell {...field} id={id} error={error}>
      <textarea
        id={id}
        name={field.name}
        rows={rows}
        defaultValue={value ?? defaultValue ?? undefined}
        placeholder={placeholder}
        readOnly={readOnly}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : field.hint ? `${id}-hint` : undefined}
        className={cx(inputClass, "min-h-24 resize-y py-2.5 leading-relaxed", readOnly && "bg-sunken")}
      />
    </FieldShell>
  );
}
