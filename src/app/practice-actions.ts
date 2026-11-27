"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/lib/form-state";
import { toFormState } from "@/server/actions-util";
import { requireClinic } from "@/server/auth/guards";
import { completeSetup, setClinicModule } from "@/server/clinic/practice";
import { updateClinicPolicy } from "@/server/clinic/policy";
import { addStandardTemplates, archiveTemplate, importTemplates, saveTemplate } from "@/server/clinic/templates";
import { requestMeta } from "@/server/http";

export async function setupAction(_: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("$slug") ?? "");
  const ctx = await requireClinic(slug);
  const on = (k: string) => fd.get(k) === "on";
  try {
    await completeSetup(
      ctx,
      {
        practiceType: String(fd.get("practiceType") ?? ""),
        applyModules: on("applyModules"),
        addStarterServices: on("addStarterServices"),
        ownerIsDoctor: on("ownerIsDoctor"),
        ownerFrontDesk: on("ownerFrontDesk"),
        specialty: String(fd.get("specialty") ?? ""),
        focusSpecialty: String(fd.get("focusSpecialty") ?? ""),
        weekdaySchedule: on("weekdaySchedule"),
      },
      await requestMeta(),
    );
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}`, "layout");
  redirect(`/c/${slug}?setup=done`);
}

export async function moduleAction(_: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("$slug") ?? "");
  const ctx = await requireClinic(slug);
  const enabled = fd.get("op") === "on";
  try {
    await setClinicModule(ctx, String(fd.get("module") ?? ""), enabled, await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/c/${slug}`, "layout");
  return { ok: true, message: enabled ? "clinic.modules.enabled" : "clinic.modules.disabled", nonce: Date.now() };
}

export async function policyAction(_: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("$slug") ?? "");
  const ctx = await requireClinic(slug, "clinic.settings.manage");
  try {
    await updateClinicPolicy(
      ctx,
      {
        maxDiscountPercent: fd.get("maxDiscountPercent"),
        discountReasonRequired: fd.get("discountReasonRequired") === "on",
        printOnlyAtDesk: fd.get("printOnlyAtDesk") === "on",
        telegramDocuments: fd.get("telegramDocuments") === "on",
        onlineBookingDays: fd.get("onlineBookingDays") ?? undefined,
        onlineBookingLeadHours: fd.get("onlineBookingLeadHours") ?? undefined,
        onlineBookingMaxActive: fd.get("onlineBookingMaxActive") ?? undefined,
      },
      await requestMeta(),
    );
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/settings`);
  return { ok: true, nonce: Date.now() };
}

// ───────────── Templates ─────────────

export async function saveTemplateAction(_: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("$slug") ?? "");
  const ctx = await requireClinic(slug, "clinic.settings.manage");
  const kind = String(fd.get("kind") ?? "");
  const s = (k: string) => String(fd.get(k) ?? "");
  let id: string;
  try {
    id = await saveTemplate(
      ctx,
      s("id") || null,
      {
        kind,
        name: s("name"),
        specialty: s("specialty"),
        serviceId: s("serviceId"),
        body: s("body"),
        note: kind === "NOTE" ? { complaints: s("complaints"), history: s("history"), examination: s("examination"), assessment: s("assessment"), plan: s("plan") } : undefined,
        ...(kind === "DIAGNOSTIC" ? { study: s("study"), fieldsText: s("fieldsText"), conclusion: s("conclusion") } : {}),
        ...(kind === "PRESCRIPTION" ? { schemeText: s("schemeText") } : {}),
      },
      await requestMeta(),
    );
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/templates`, "layout");
  if (!s("id")) redirect(`/c/${slug}/templates/${id}`);
  return { ok: true, message: "templates.saved", nonce: Date.now() };
}

export async function archiveTemplateAction(_: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("$slug") ?? "");
  const ctx = await requireClinic(slug, "clinic.settings.manage");
  try {
    await archiveTemplate(ctx, String(fd.get("id") ?? ""), await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/c/${slug}/templates`, "layout");
  redirect(`/c/${slug}/templates`);
}

export async function standardTemplatesAction(_: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("$slug") ?? "");
  const ctx = await requireClinic(slug, "clinic.settings.manage");
  let added = 0;
  try {
    added = await addStandardTemplates(ctx, await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/c/${slug}/templates`);
  return { ok: true, message: "templates.standardAdded", messageValues: { count: added }, nonce: Date.now() };
}

/** Loads a template file (.json, see importTemplates); reports what was added, skipped and rejected. */
export async function importTemplatesAction(_: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("$slug") ?? "");
  const ctx = await requireClinic(slug, "clinic.settings.manage");
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "validation.required", nonce: Date.now() };
  if (file.size > 10 * 1024 * 1024) return { ok: false, message: "errors.fileTooLarge", nonce: Date.now() };
  let r;
  try {
    r = await importTemplates(ctx, await file.text(), await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/c/${slug}/templates`);
  return r.invalid.length
    ? { ok: true, message: "templates.importDoneInvalid", messageValues: { created: r.created, skipped: r.skipped.length, invalid: r.invalid.length, names: r.invalid.map((i) => i.name).join(", ") }, nonce: Date.now() }
    : { ok: true, message: "templates.importDone", messageValues: { created: r.created, skipped: r.skipped.length }, nonce: Date.now() };
}
