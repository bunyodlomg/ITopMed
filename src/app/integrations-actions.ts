"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/lib/form-state";
import { toFormState } from "@/server/actions-util";
import { requireClinic } from "@/server/auth/guards";
import { requestMeta } from "@/server/http";
import { saveNotificationSettings, sendDueNow } from "@/server/notifications/notifications";

export async function notificationSettingsAction(_: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("$slug") ?? "");
  const ctx = await requireClinic(slug);
  const on = (k: string) => fd.get(k) === "on";
  try {
    await saveNotificationSettings(
      ctx,
      {
        appointmentBooked: on("appointmentBooked"),
        appointmentReminder: on("appointmentReminder"),
        reminderHoursBefore: String(fd.get("reminderHoursBefore") ?? ""),
        appointmentCancelled: on("appointmentCancelled"),
        resultsReady: on("resultsReady"),
        noShowRebook: on("noShowRebook"),
        visitCheckIn: on("visitCheckIn"),
        checkInDays: String(fd.get("checkInDays") ?? ""),
        medicationReminders: on("medicationReminders"),
      },
      await requestMeta(),
    );
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/integrations`);
  return { ok: true, message: "clinic.integrations.saved", nonce: Date.now() };
}

export async function dispatchNowAction(_: FormState, fd: FormData): Promise<FormState> {
  const slug = String(fd.get("$slug") ?? "");
  const ctx = await requireClinic(slug);
  try {
    const r = await sendDueNow(ctx, await requestMeta());
    revalidatePath(`/c/${slug}/integrations`);
    return { ok: true, message: "clinic.integrations.dispatched", messageValues: { sent: r.sent, failed: r.failed + r.retried, skipped: r.skipped }, nonce: Date.now() };
  } catch (e) {
    return toFormState(e);
  }
}
