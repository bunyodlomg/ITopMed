"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/lib/form-state";
import { toFormState } from "@/server/actions-util";
import { requireClinic } from "@/server/auth/guards";
import { archiveMedicine, saveMedicine } from "@/server/emr/medicines";
import { requestMeta } from "@/server/http";

async function clinicFrom(fd: FormData) {
  const slug = String(fd.get("$slug") ?? "");
  return { slug, ctx: await requireClinic(slug) };
}

const FIELDS = ["name", "strength", "inn", "form", "manufacturer", "drugGroup", "defaultDose", "defaultFrequency", "defaultRoute", "defaultTimes", "defaultDays", "instructions"] as const;

/** Medicine catalog: a new entry opens its page (to add a photo); an edit stays. */
export async function saveMedicineAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const id = String(fd.get("medicineId") ?? "") || null;
  let saved: string;
  try {
    saved = await saveMedicine(ctx, id, Object.fromEntries(FIELDS.map((k) => [k, String(fd.get(k) ?? "")])), await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/medicines`);
  if (!id) redirect(`/c/${slug}/medicines/${saved}?created=1`);
  return { ok: true, message: "medicines.saved", nonce: Date.now() };
}

export async function archiveMedicineAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const id = String(fd.get("medicineId") ?? "");
  const restore = fd.get("op") === "restore";
  try {
    await archiveMedicine(ctx, id, restore, await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/medicines`);
  if (!restore) redirect(`/c/${slug}/medicines?archived=1`);
  return { ok: true, message: "medicines.restored", nonce: Date.now() };
}
