"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/lib/form-state";
import { toFormState } from "@/server/actions-util";
import { requireClinic } from "@/server/auth/guards";
import { requestMeta } from "@/server/http";
import { addAnalyte, archiveAnalyte, cancelLabOrder, collectSpecimen, createLabOrder, enterResults, verifyResults } from "@/server/lab/lab";

async function clinicFrom(fd: FormData) {
  const slug = String(fd.get("$slug") ?? "");
  return { slug, ctx: await requireClinic(slug) };
}
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const ok = (message: string, messageValues?: Record<string, string | number>): FormState => ({ ok: true, message, messageValues, nonce: Date.now() });

export async function labOrderAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const encounterId = str(fd, "encounterId");
  try {
    const r = await createLabOrder(ctx, encounterId, { serviceIds: fd.getAll("serviceIds").map(String), priority: str(fd, "priority") || "ROUTINE", indication: str(fd, "indication") }, await requestMeta());
    revalidatePath(`/c/${slug}/encounters/${encounterId}`);
    return ok(r.charged ? "clinic.labOrder.orderedCharged" : "clinic.labOrder.ordered", { number: r.number });
  } catch (e) {
    return toFormState(e, fd);
  }
}

/** One action for the lab order workflow buttons: collect, verify, cancel. */
export async function labStepAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const id = str(fd, "orderId");
  const op = str(fd, "op");
  const meta = await requestMeta();
  try {
    if (op === "collect") await collectSpecimen(ctx, id, meta);
    else if (op === "verify") await verifyResults(ctx, id, meta);
    else if (op === "cancel") await cancelLabOrder(ctx, id, meta);
    else return { message: "errors.invalidInput" };
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/c/${slug}`, "layout");
  return ok(op === "collect" ? "clinic.lab.collected" : op === "verify" ? "clinic.lab.verified" : "clinic.lab.cancelled");
}

export async function labResultsAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const id = str(fd, "orderId");
  // Result inputs are named "r:<itemId>:<analyteId>".
  const values = Object.fromEntries([...fd.entries()].filter(([k]) => k.startsWith("r:")).map(([k, v]) => [k.slice(2), String(v)]));
  try {
    await enterResults(ctx, id, values, await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}`, "layout");
  return ok("clinic.lab.saved");
}

export async function analyteAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    if (fd.get("op") === "archive") await archiveAnalyte(ctx, str(fd, "analyteId"), await requestMeta());
    else
      await addAnalyte(
        ctx,
        str(fd, "serviceId"),
        { name: str(fd, "name"), loinc: str(fd, "loinc"), unit: str(fd, "unit"), refLow: str(fd, "refLow"), refHigh: str(fd, "refHigh"), sortOrder: str(fd, "sortOrder") || "0" },
        await requestMeta(),
      );
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/lab/tests`);
  return ok(fd.get("op") === "archive" ? "clinic.labTests.archived" : "clinic.labTests.added");
}
