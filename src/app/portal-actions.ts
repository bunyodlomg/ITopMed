"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { LOCALE_COOKIE, isLocale } from "@/i18n/config";
import type { FormState } from "@/lib/form-state";
import { toFormState } from "@/server/actions-util";
import { requireClinic } from "@/server/auth/guards";
import { clearPatientCookie, readPatientToken, setPatientSessionCookie } from "@/server/auth/cookies";
import { env } from "@/server/env";
import { requestMeta } from "@/server/http";
import { releaseLabOrder } from "@/server/lab/lab";
import { activatePortalAccount, changePatientPassword, loginPatient, logoutPatient } from "@/server/portal/auth";
import { cancelMyAppointment, grantMyConsent, withdrawMyConsent } from "@/server/portal/data";
import { getPortalTenant, requirePatient } from "@/server/portal/guards";
import { bookOnline } from "@/server/portal/booking";
import { createTelegramLink, disconnectMyTelegram } from "@/server/notifications/telegram";
import { disablePortalAccount, issuePortalCode } from "@/server/portal/staff";
import { addMyReading } from "@/server/emr/readings";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const ok = (message: string, messageValues?: Record<string, string | number>): FormState => ({ ok: true, message, messageValues, nonce: Date.now() });

// ───────────── Patient: sign-in, activation ─────────────

async function tenantFrom(fd: FormData) {
  const tenant = await getPortalTenant(str(fd, "$slug"));
  if (!tenant) notFound();
  return tenant;
}

export async function portalLoginAction(_: FormState, fd: FormData): Promise<FormState> {
  const tenant = await tenantFrom(fd);
  const phone = str(fd, "phone");
  const r = await loginPatient(tenant, phone, str(fd, "password"), await requestMeta());
  if (!r.ok) return { message: `auth.${r.reason === "rate_limited" ? "rateLimited" : r.reason === "locked" ? "locked" : "portalInvalid"}`, values: { phone }, nonce: Date.now() };
  await setPatientSessionCookie(r.token);
  // Language: saved preference → this browser's choice → clinic default.
  const store = await cookies();
  const browser = store.get(LOCALE_COOKIE)?.value;
  const preferred = r.locale ?? (isLocale(browser) ? browser : tenant.defaultLocale);
  if (isLocale(preferred)) store.set(LOCALE_COOKIE, preferred, { path: "/", maxAge: 31536000, sameSite: "lax" });
  redirect(`/p/${tenant.slug}`);
}

export async function portalActivateAction(_: FormState, fd: FormData): Promise<FormState> {
  const tenant = await tenantFrom(fd);
  try {
    await activatePortalAccount(
      tenant,
      { code: str(fd, "activationCode"), birthDate: str(fd, "birthDate"), phone: str(fd, "phone"), password: str(fd, "password"), confirmPassword: str(fd, "confirmPassword") },
      await requestMeta(),
    );
  } catch (e) {
    const s = toFormState(e, fd);
    // Field names differ from the service's: map "code" errors to the visible field.
    if (s.fieldErrors?.code) s.fieldErrors = { ...s.fieldErrors, activationCode: s.fieldErrors.code };
    return s;
  }
  redirect(`/p/${tenant.slug}/login?activated=1`);
}

/** Bound to the clinic slug by the portal layout (the slug only decides where to redirect). */
export async function portalLogoutAction(slug: string) {
  await logoutPatient(await readPatientToken());
  await clearPatientCookie();
  redirect(`/p/${encodeURIComponent(slug)}/login`);
}

// ───────────── Patient: self-service ─────────────

export async function portalCancelAction(_: FormState, fd: FormData): Promise<FormState> {
  const p = await requirePatient(str(fd, "$slug"));
  try {
    await cancelMyAppointment(p, str(fd, "appointmentId"), await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/p/${p.tenant.slug}`, "layout");
  return ok("portal.appointments.cancelled");
}

export async function portalConsentAction(_: FormState, fd: FormData): Promise<FormState> {
  const p = await requirePatient(str(fd, "$slug"));
  try {
    if (fd.get("op") === "withdraw") await withdrawMyConsent(p, str(fd, "consentId"), await requestMeta());
    else await grantMyConsent(p, str(fd, "purpose"), await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/p/${p.tenant.slug}/account`);
  return ok(fd.get("op") === "withdraw" ? "portal.account.consentWithdrawn" : "portal.account.consentGranted");
}

export async function portalPasswordAction(_: FormState, fd: FormData): Promise<FormState> {
  const p = await requirePatient(str(fd, "$slug"));
  try {
    await changePatientPassword(p, { currentPassword: str(fd, "currentPassword"), password: str(fd, "password"), confirmPassword: str(fd, "confirmPassword") }, await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  return ok("portal.account.passwordChanged");
}

// ───────────── Clinic staff: portal accounts, result release ─────────────

export async function portalCodeAction(_: FormState, fd: FormData): Promise<FormState> {
  const slug = str(fd, "$slug");
  const ctx = await requireClinic(slug);
  const patientId = str(fd, "patientId");
  try {
    if (fd.get("op") === "disable") {
      await disablePortalAccount(ctx, patientId, await requestMeta());
      revalidatePath(`/c/${slug}/patients/${patientId}`);
      return ok("clinic.portal.disabled");
    }
    const method = str(fd, "consentMethod");
    const { code } = await issuePortalCode(ctx, patientId, { consentMethod: method || undefined }, await requestMeta());
    revalidatePath(`/c/${slug}/patients/${patientId}`);
    // Shown once to the staff member, never stored in plain text, never put in a URL.
    return ok("clinic.portal.codeIssued", { code, url: `${env().APP_URL.replace(/\/$/, "")}/p/${ctx.tenant.slug}/activate` });
  } catch (e) {
    return toFormState(e);
  }
}

export async function labReleaseAction(_: FormState, fd: FormData): Promise<FormState> {
  const slug = str(fd, "$slug");
  const ctx = await requireClinic(slug);
  try {
    await releaseLabOrder(ctx, str(fd, "orderId"), await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/c/${slug}`, "layout");
  return ok("clinic.labOrder.released");
}

// ───────────── Patient: online booking, Telegram ─────────────

export async function portalBookAction(_: FormState, fd: FormData): Promise<FormState> {
  const p = await requirePatient(str(fd, "$slug"));
  try {
    await bookOnline(p, { doctorId: str(fd, "doctorId"), startsAt: str(fd, "startsAt") }, await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/p/${p.tenant.slug}`, "layout");
  redirect(`/p/${p.tenant.slug}/appointments?booked=1`);
}

export async function portalTelegramLinkAction(_: FormState, fd: FormData): Promise<FormState> {
  const p = await requirePatient(str(fd, "$slug"));
  try {
    const link = await createTelegramLink(p, await requestMeta());
    return { ok: true, data: { link }, nonce: Date.now() };
  } catch (e) {
    return toFormState(e);
  }
}

export async function portalTelegramDisconnectAction(_: FormState, fd: FormData): Promise<FormState> {
  const p = await requirePatient(str(fd, "$slug"));
  try {
    await disconnectMyTelegram(p, await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/p/${p.tenant.slug}/account`);
  return ok("portal.telegram.disconnected");
}

export async function portalReadingAction(_: FormState, fd: FormData): Promise<FormState> {
  const p = await requirePatient(str(fd, "$slug"));
  try {
    await addMyReading(p, { systolic: str(fd, "systolic"), diastolic: str(fd, "diastolic"), pulse: str(fd, "pulse") }, await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/p/${p.tenant.slug}/readings`);
  return ok("portal.readings.saved");
}
