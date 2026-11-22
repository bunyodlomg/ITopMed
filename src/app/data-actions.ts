"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/lib/form-state";
import { toFormState } from "@/server/actions-util";
import { requireClinic } from "@/server/auth/guards";
import { saveDataMode, savePatientFiles, syncPatientFilesNow } from "@/server/clinic/data-mode";
import { purgeTestPatients } from "@/server/clinic/purge";
import { requestMeta } from "@/server/http";

/** Clinic settings → "Where the data is kept": local only / with the internet. Owner only. */
export async function dataModeAction(_: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("$slug") ?? "");
  const ctx = await requireClinic(slug, "clinic.settings.manage");
  try {
    await saveDataMode(ctx, { mode: fd.get("mode") }, await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/settings`);
  return { ok: true, nonce: Date.now() };
}

/** Folder of Excel files, one per patient (local app). */
export async function patientFilesAction(_: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("$slug") ?? "");
  const ctx = await requireClinic(slug, "clinic.settings.manage");
  const enabled = fd.get("op") !== "off";
  try {
    const r = await savePatientFiles(ctx, { enabled, dir: String(fd.get("dir") ?? "") || undefined }, await requestMeta());
    revalidatePath(`/c/${slug}/settings`);
    return enabled ? { ok: true, message: "clinic.data.filesWritten", messageValues: { count: r.written }, nonce: Date.now() } : { ok: true, message: "clinic.data.filesOff", nonce: Date.now() };
  } catch (e) {
    return toFormState(e, fd);
  }
}

export async function syncPatientFilesAction(_: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("$slug") ?? "");
  const ctx = await requireClinic(slug, "clinic.settings.manage");
  try {
    const r = await syncPatientFilesNow(ctx, await requestMeta());
    revalidatePath(`/c/${slug}/settings`);
    return { ok: true, message: "clinic.data.filesWritten", messageValues: { count: r.written }, nonce: Date.now() };
  } catch (e) {
    return toFormState(e, fd);
  }
}

/** Before real work: remove every test patient with their queue, visits and payments. Owner only, typed confirmation. */
export async function purgePatientsAction(_: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("$slug") ?? "");
  const ctx = await requireClinic(slug, "clinic.settings.manage");
  try {
    const r = await purgeTestPatients(ctx, { confirm: fd.get("confirm") ?? "" }, await requestMeta());
    revalidatePath(`/c/${slug}`, "layout");
    return { ok: true, message: "clinic.purge.done", messageValues: { patients: r.patients, appointments: r.appointments }, nonce: Date.now() };
  } catch (e) {
    return toFormState(e, fd);
  }
}
