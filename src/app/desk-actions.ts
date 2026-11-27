"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/lib/form-state";
import { formValues, toFormState } from "@/server/actions-util";
import { requireClinic } from "@/server/auth/guards";
import { saveLetterhead } from "@/server/clinic/branding";
import { importPriceList } from "@/server/clinic/price-list";
import { requestMeta } from "@/server/http";
import { addExtraServices, approvePatientDebt, deskCheckIn, payPatientDebt } from "@/server/reception/desk";
import { minorToDecimalString } from "@/lib/money";
import { PAYMENT_METHODS } from "@/server/billing/billing";
import { sendPapersToTelegram } from "@/server/papers/send";

async function clinicFrom(fd: FormData) {
  const slug = String(fd.get("$slug") ?? "");
  return { slug, ctx: await requireClinic(slug) };
}

function raw(fd: FormData): Record<string, unknown> {
  // Split payment: one amount field per method, "split_CASH", "split_CARD", ...
  const split = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, String(fd.get(`split_${m}`) ?? "").trim()] as const).filter(([, v]) => v !== ""));
  return { ...Object.fromEntries(fd.entries()), serviceIds: fd.getAll("serviceIds").map(String), split };
}

/** Reception desk: patient + services + payment + measurements + queue number in one submit. */
export async function deskCheckInAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  let appointmentId: string;
  try {
    const r = await deskCheckIn(ctx, raw(fd), await requestMeta());
    if (!r.ok) return { message: r.blocking ? "clinic.desk.duplicateBlocking" : "clinic.desk.duplicateFound", values: formValues(fd), nonce: Date.now() };
    appointmentId = r.appointmentId;
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/desk`);
  redirect(`/c/${slug}/desk?done=${appointmentId}`);
}

/** Extra services (e.g. echo, ECG) decided during the visit: paid now or left as debt. */
export async function extraServicesAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await addExtraServices(ctx, raw(fd), await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  const back = String(fd.get("$back") ?? "");
  if (back.startsWith(`/c/${slug}/`)) revalidatePath(back);
  return { ok: true, message: "clinic.desk.extraAdded", nonce: Date.now() };
}

/** Groups of three digits for a message ("1 300 000"); no patient data. */
function plainAmount(minor: bigint, currency: string) {
  return minorToDecimalString(minor, currency).replace(/\.00$/, "").replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Desk queue: take the patient's debt (all of it by default) in one step. */
export async function payDebtAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  let r: Awaited<ReturnType<typeof payPatientDebt>>;
  try {
    r = await payPatientDebt(ctx, raw(fd), await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/desk`);
  const fmt = (m: bigint) => plainAmount(m, ctx.tenant.currency);
  // Fully paid: the row's form disappears with the debt, so confirm at page level (amount only, no patient data in the URL).
  if (r.leftMinor === 0n) redirect(`/c/${slug}/desk?paid=${encodeURIComponent(fmt(r.paidMinor))}`);
  return { ok: true, message: "clinic.desk.debtPartlyPaid", messageValues: { paid: fmt(r.paidMinor), left: fmt(r.leftMinor) }, nonce: Date.now() };
}

/** Cashier: the patient pays everything they owe (or a part, or split over methods) before leaving. */
export async function checkoutPayAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const patientId = String(fd.get("patientId") ?? "");
  let r: Awaited<ReturnType<typeof payPatientDebt>>;
  try {
    r = await payPatientDebt(ctx, raw(fd), await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/checkout`);
  revalidatePath(`/c/${slug}/desk`);
  redirect(`/c/${slug}/checkout?patient=${encodeURIComponent(patientId)}&paid=${encodeURIComponent(plainAmount(r.paidMinor, ctx.tenant.currency))}`);
}

/** Cashier: the patient may leave owing the rest (every open bill is marked approved; audited). */
export async function approvePatientDebtAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await approvePatientDebt(ctx, String(fd.get("patientId") ?? ""), await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/checkout`);
  return { ok: true, message: "clinic.checkout.debtApproved", nonce: Date.now() };
}

export async function priceListAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  let r: Awaited<ReturnType<typeof importPriceList>>;
  try {
    r = await importPriceList(ctx, { text: String(fd.get("text") ?? "") }, await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/services`);
  return { ok: true, message: "clinic.services.priceListDone", messageValues: { created: r.created, updated: r.updated, skipped: r.skipped }, nonce: Date.now() };
}

/** Letterhead: logo (PNG/JPEG/WebP up to 300 KB) and licence line for printed documents. */
export async function letterheadAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const logo = fd.get("logo");
  try {
    await saveLetterhead(ctx, { licenseText: fd.get("licenseText"), locationUrl: fd.get("locationUrl"), removeLogo: fd.get("removeLogo"), logo: logo instanceof File ? logo : null }, await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/settings`);
  return { ok: true, message: "clinic.settings.letterheadSaved", nonce: Date.now() };
}

/** Desk: the finished visit's papers to the patient's own Telegram chat, as PDF or Word files. */
export async function sendPapersAction(_: FormState, fd: FormData): Promise<FormState> {
  const { ctx } = await clinicFrom(fd);
  let r: Awaited<ReturnType<typeof sendPapersToTelegram>>;
  try {
    r = await sendPapersToTelegram(ctx, { appointmentId: String(fd.get("appointmentId") ?? ""), format: String(fd.get("format") ?? "pdf"), items: fd.getAll("items").map(String) }, await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  if (r.sent === 0) return { message: "clinic.deskPrint.tgFailed", nonce: Date.now() };
  return { ok: r.failed === 0, message: r.failed ? "clinic.deskPrint.tgPartly" : "clinic.deskPrint.tgSent", messageValues: { sent: r.sent, failed: r.failed }, nonce: Date.now() };
}
