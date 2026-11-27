"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ConsentPurpose } from "@/generated/prisma/client";
import type { FormState } from "@/lib/form-state";
import { toFormState } from "@/server/actions-util";
import { bookAppointment, cancelAppointment, checkIn, markNoShow, registerWalkIn, rescheduleAppointment } from "@/server/appointments/appointments";
import { isLocalDate, localToInstant } from "@/server/scheduling/time";
import { requireClinic } from "@/server/auth/guards";
import { addAllergy, addDiagnosis, amendNote, finishEncounter, recordVitals, saveDraft, setClinicalStatus, setNextVisit, signNote, startVisit } from "@/server/emr/record";
import { addDiagnosticResult, markDiagnosticError } from "@/server/emr/diagnostics";
import { requestMeta } from "@/server/http";
import { addPrescription, applyPrescriptionScheme, cancelPrescription } from "@/server/emr/prescriptions";
import { applyNoteTemplate } from "@/server/emr/documents";
import { copyPreviousNote } from "@/server/emr/assist";
import { closeDispensary, enrollDispensary, markFollowUpDone } from "@/server/emr/dispensary";
import { addNursingRecord, savePatientHistory } from "@/server/emr/history";
import { cookies } from "next/headers";
import { BREAK_GLASS_REASONS } from "@/server/emr/access";
import { CONSENT_METHODS, CONSENT_PURPOSES, recordConsent, registerPatient, updatePatient, withdrawConsent } from "@/server/patients/patients";

async function clinicFrom(fd: FormData) {
  const slug = String(fd.get("$slug") ?? "");
  return { slug, ctx: await requireClinic(slug) };
}
const ok = (message: string, messageValues?: Record<string, string | number>): FormState => ({ ok: true, message, messageValues, nonce: Date.now() });
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");

function patientFields(fd: FormData) {
  return {
    ...Object.fromEntries(["lastName", "firstName", "middleName", "birthDate", "sex", "phone", "address", "preferredLocale", "pinfl", "passport"].map((k) => [k, str(fd, k)])),
    // Only when the form has them (otherwise the stored values stay).
    ...Object.fromEntries(["referralSource", "referralDetail", "benefitCategoryId"].filter((k) => fd.has(k)).map((k) => [k, str(fd, k)])),
  };
}

// ───────────── Patients ─────────────

export async function registerPatientAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const method = str(fd, "consentMethod");
  const consents = fd
    .getAll("consents")
    .map(String)
    .filter((p): p is (typeof CONSENT_PURPOSES)[number] => (CONSENT_PURPOSES as readonly string[]).includes(p))
    .map((purpose) => ({ purpose: purpose as ConsentPurpose, method: (CONSENT_METHODS as readonly string[]).includes(method) ? (method as (typeof CONSENT_METHODS)[number]) : "VERBAL_RECORDED" }));
  let result: Awaited<ReturnType<typeof registerPatient>>;
  try {
    result = await registerPatient(ctx, patientFields(fd), { confirmNotDuplicate: fd.get("confirmNotDuplicate") === "on", consents }, await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  if (!result.ok) {
    const values = Object.fromEntries([...fd.entries()].filter(([k, v]) => typeof v === "string" && !k.startsWith("$")).map(([k, v]) => [k, String(v)]));
    return { values, nonce: Date.now(), data: { duplicates: result.duplicates, blocking: result.blocking } };
  }
  redirect(`/c/${slug}/patients/${result.id}?registered=${encodeURIComponent(result.mrn)}`);
}

export async function updatePatientAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const id = str(fd, "patientId");
  try {
    await updatePatient(ctx, id, patientFields(fd), await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  redirect(`/c/${slug}/patients/${id}?saved=1`);
}

export async function consentAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const patientId = str(fd, "patientId");
  try {
    if (fd.get("op") === "withdraw") await withdrawConsent(ctx, str(fd, "consentId"), await requestMeta());
    else await recordConsent(ctx, patientId, { purpose: str(fd, "purpose"), method: str(fd, "method") }, await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/c/${slug}/patients/${patientId}`);
  return ok(fd.get("op") === "withdraw" ? "clinic.patients.withdrawn" : "clinic.patients.granted");
}

// ───────────── Booking & queue ─────────────

export async function bookAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await bookAppointment(
      ctx,
      { patientId: str(fd, "patientId"), doctorProfileId: str(fd, "doctorProfileId"), startsAt: str(fd, "startsAt"), serviceId: str(fd, "serviceId"), source: str(fd, "source") || "FRONT_DESK", adminNote: str(fd, "adminNote") },
      await requestMeta(),
    );
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/c/${slug}/appointments`);
  redirect(`/c/${slug}/patients/${str(fd, "patientId")}?booked=1`);
}

export async function queueAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const id = str(fd, "appointmentId");
  const op = str(fd, "op");
  const meta = await requestMeta();
  try {
    if (op === "check_in") {
      const n = await checkIn(ctx, id, meta);
      revalidatePath(`/c/${slug}/queue`);
      return ok("clinic.queue.checkedIn", { number: n });
    }
    if (op === "no_show") await markNoShow(ctx, id, meta);
    else if (op === "cancel") await cancelAppointment(ctx, id, str(fd, "reason"), meta);
    else return { message: "errors.invalidInput" };
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/c/${slug}/queue`);
  return ok("clinic.queue.statusChanged");
}

export async function walkInAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await registerWalkIn(ctx, { patientId: str(fd, "patientId"), doctorProfileId: str(fd, "doctorProfileId"), branchId: str(fd, "branchId"), serviceId: str(fd, "serviceId"), adminNote: str(fd, "adminNote") }, await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  redirect(`/c/${slug}/queue?added=1`);
}

// ───────────── Visits & medical record ─────────────

export async function startVisitAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  let encounterId: string;
  try {
    encounterId = await startVisit(ctx, str(fd, "appointmentId"), await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  redirect(`/c/${slug}/encounters/${encounterId}`);
}

export async function noteAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const sections = { complaints: str(fd, "complaints"), history: str(fd, "history"), examination: str(fd, "examination"), assessment: str(fd, "assessment"), plan: str(fd, "plan") };
  const sign = fd.get("op") === "sign";
  try {
    if (sign) await signNote(ctx, str(fd, "noteId"), sections, await requestMeta());
    else await saveDraft(ctx, str(fd, "noteId"), sections, await requestMeta());
  } catch (e) {
    return { ...toFormState(e), values: sections };
  }
  revalidatePath(`/c/${slug}/encounters/${str(fd, "encounterId")}`);
  return { ...ok(sign ? "clinic.visit.signed" : "clinic.visit.draftSaved"), values: sections };
}

export async function amendAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await amendNote(ctx, str(fd, "noteId"), { reason: str(fd, "reason"), content: str(fd, "content") }, await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}`, "layout");
  return ok("clinic.visit.amended");
}

export async function diagnosisAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await addDiagnosis(ctx, str(fd, "encounterId"), { icd10Code: str(fd, "icd10Code"), description: str(fd, "description"), kind: str(fd, "kind"), stage: str(fd, "stage") }, await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/encounters/${str(fd, "encounterId")}`);
  return ok("clinic.visit.diagnosisAdded");
}

export async function allergyAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await addAllergy(ctx, str(fd, "patientId"), { substance: str(fd, "substance"), reaction: str(fd, "reaction"), severity: str(fd, "severity") }, await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}`, "layout");
  return ok("clinic.visit.allergyAdded");
}

export async function vitalsAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const values = Object.fromEntries([...fd.entries()].filter(([k]) => /^[A-Z_0-9]+$/.test(k)).map(([k, v]) => [k, String(v)]));
  try {
    await recordVitals(ctx, str(fd, "patientId"), values, await requestMeta(), { encounterId: str(fd, "encounterId") || undefined });
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}`, "layout");
  return ok("clinic.visit.vitalsRecorded");
}

export async function clinicalStatusAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await setClinicalStatus(ctx, fd.get("kind") === "allergy" ? "allergy" : "diagnosis", str(fd, "id"), str(fd, "status") as "RESOLVED", await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/c/${slug}`, "layout");
  return ok("clinic.visit.statusUpdated");
}

export async function finishVisitAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await finishEncounter(ctx, str(fd, "encounterId"), await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  redirect(`/c/${slug}/my-queue?finished=1`);
}

/** Break-the-glass is a POST (origin-checked) — a crafted link cannot trigger it. */
export async function breakGlassAction(fd: FormData) {
  const { slug, ctx } = await clinicFrom(fd);
  if (!ctx.permissions.has("emr.read")) redirect(`/c/${slug}`);
  const patientId = str(fd, "patientId");
  const reason = str(fd, "bg");
  if (!/^[0-9a-f-]{36}$/.test(patientId) || !(BREAK_GLASS_REASONS as readonly string[]).includes(reason)) redirect(`/c/${slug}/patients`);
  (await cookies()).set(`itm_bg_${patientId}`, reason, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: `/c/${slug}/patients/${patientId}`, maxAge: 600 });
  redirect(`/c/${slug}/patients/${patientId}/record`);
}

export async function prescriptionAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const encounterId = str(fd, "encounterId");
  try {
    const r = await addPrescription(
      ctx,
      encounterId,
      {
        drug: str(fd, "drug"),
        inn: str(fd, "inn"),
        dose: str(fd, "dose"),
        frequency: str(fd, "frequency"),
        route: str(fd, "route"),
        durationDays: str(fd, "durationDays"),
        times: str(fd, "times"),
        instructions: str(fd, "instructions"),
        allergyOverride: fd.get("allergyOverride") === "on",
        medicineId: str(fd, "medicineId"),
        saveToCatalog: fd.get("saveToCatalog") === "on",
      },
      await requestMeta(),
    );
    revalidatePath(`/c/${slug}/encounters/${encounterId}`);
    return ok(r.allergyOverride ? "clinic.rx.addedDespiteAllergy" : "clinic.rx.added");
  } catch (e) {
    return toFormState(e, fd);
  }
}

/** Adds the ticked lines of a ready-made prescription scheme to the visit. */
export async function applySchemeAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const encounterId = str(fd, "encounterId");
  try {
    const r = await applyPrescriptionScheme(ctx, encounterId, str(fd, "templateId"), { lines: fd.getAll("line").map(String), allergyOverride: fd.get("allergyOverride") === "on" }, await requestMeta());
    revalidatePath(`/c/${slug}/encounters/${encounterId}`);
    return ok(r.allergyOverride ? "clinic.rx.addedDespiteAllergy" : "clinic.rx.schemeApplied");
  } catch (e) {
    return toFormState(e);
  }
}

export async function cancelPrescriptionAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await cancelPrescription(ctx, str(fd, "prescriptionId"), await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/c/${slug}/encounters/${str(fd, "encounterId")}`);
  return ok("clinic.rx.cancelled");
}

export async function rescheduleAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const date = str(fd, "date");
  const time = /^(\d{2}):(\d{2})$/.exec(str(fd, "time"));
  if (!isLocalDate(date) || !time) return { message: "validation.date", nonce: Date.now() };
  const startsAt = localToInstant(date, Number(time[1]) * 60 + Number(time[2]), ctx.tenant.timezone).toISOString();
  try {
    await rescheduleAppointment(ctx, str(fd, "appointmentId"), { startsAt, doctorProfileId: str(fd, "doctorProfileId") }, await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/c/${slug}/queue`);
  revalidatePath(`/c/${slug}/appointments`);
  return ok("clinic.queue.rescheduled");
}

export async function applyNoteTemplateAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const encounterId = str(fd, "encounterId");
  try {
    await applyNoteTemplate(ctx, encounterId, str(fd, "templateId"), await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/c/${slug}/encounters/${encounterId}`);
  return ok("templates.applied");
}

export async function copyPreviousNoteAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const encounterId = str(fd, "encounterId");
  let copied: boolean;
  try {
    copied = await copyPreviousNote(ctx, encounterId, await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  if (!copied) return { message: "errors.noPreviousNote", nonce: Date.now() };
  revalidatePath(`/c/${slug}/encounters/${encounterId}`);
  return ok("clinic.visit.copied");
}

export async function historyAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const fields = ["pregnancy", "pregnancyWeeks", "priorMyocardialInfarction", "diabetes", "smoking", "hypertensionYears", "hereditary", "surgeries", "otherNotes"] as const;
  try {
    await savePatientHistory(ctx, str(fd, "patientId"), Object.fromEntries(fields.map((k) => [k, str(fd, k)])), await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  const back = str(fd, "$back");
  if (back.startsWith(`/c/${slug}/`)) revalidatePath(back);
  return ok("anamnesis.saved");
}

export async function nursingAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await addNursingRecord(ctx, str(fd, "patientId"), { kind: str(fd, "kind"), text: str(fd, "text"), drug: str(fd, "drug"), dose: str(fd, "dose"), route: str(fd, "route"), appointmentId: str(fd, "appointmentId") }, await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/nurse`);
  return ok("nursingLog.saved");
}

export async function nextVisitAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const encounterId = str(fd, "encounterId");
  try {
    await setNextVisit(ctx, encounterId, { nextVisitDate: str(fd, "nextVisitDate") }, await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/encounters/${encounterId}`);
  return ok("clinic.visit.nextVisitSaved");
}

export async function diagnosticAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const raw = Object.fromEntries([...fd.entries()].filter(([k, v]) => !k.startsWith("$") && typeof v === "string").map(([k, v]) => [k, String(v)]));
  try {
    await addDiagnosticResult(ctx, str(fd, "patientId"), raw, await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  const back = str(fd, "$back");
  if (back.startsWith(`/c/${slug}/`)) revalidatePath(back);
  return ok("diagnostics.saved");
}

export async function diagnosticErrorAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await markDiagnosticError(ctx, str(fd, "resultId"), await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  const back = str(fd, "$back");
  if (back.startsWith(`/c/${slug}/`)) revalidatePath(back);
  return ok("diagnostics.markedError");
}

// ───────────── Dispensary follow-up ─────────────

function revalidateDispensary(slug: string, encounterId: string) {
  if (encounterId) revalidatePath(`/c/${slug}/encounters/${encounterId}`);
  revalidatePath(`/c/${slug}/dispensary`);
}

export async function enrollDispensaryAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await enrollDispensary(ctx, str(fd, "patientId"), { group: str(fd, "group"), intervalDays: str(fd, "intervalDays"), firstDue: str(fd, "firstDue"), labs: str(fd, "labs"), note: str(fd, "note") }, await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidateDispensary(slug, str(fd, "encounterId"));
  return ok("clinic.dispensary.enrolled");
}

export async function followUpDoneAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  let next: string;
  try {
    next = await markFollowUpDone(ctx, str(fd, "planId"), await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidateDispensary(slug, str(fd, "encounterId"));
  return ok("clinic.dispensary.followedUp", { date: next.split("-").reverse().join(".") });
}

export async function closeDispensaryAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await closeDispensary(ctx, str(fd, "planId"), await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidateDispensary(slug, str(fd, "encounterId"));
  return ok("clinic.dispensary.closed");
}
