"use server";

import { setDoctorCommission } from "@/server/billing/earnings";
import { revalidatePath } from "next/cache";
import type { FormState } from "@/lib/form-state";
import { toFormState } from "@/server/actions-util";
import { requireClinic } from "@/server/auth/guards";
import {
  addScheduleBlock,
  addScheduleException,
  removeScheduleBlock,
  removeScheduleException,
  saveDoctorProfile,
  setDoctorServices,
} from "@/server/clinic/doctors";
import { archiveDepartment, archiveRoom, createDepartment, createRoom, createService, setServiceArchived, updateService } from "@/server/clinic/resources";
import { requestMeta } from "@/server/http";

/** Every action re-checks the clinic membership; services re-check permissions and branch scope. */
async function clinicFrom(fd: FormData) {
  const slug = String(fd.get("$slug") ?? "");
  return { slug, ctx: await requireClinic(slug) };
}

const ok = (message: string): FormState => ({ ok: true, message, nonce: Date.now() });

function fields(fd: FormData) {
  return Object.fromEntries([...fd.entries()].filter(([k]) => !k.startsWith("$")).map(([k, v]) => [k, String(v)]));
}

// ───────────── Departments & rooms ─────────────

export async function createDepartmentAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await createDepartment(ctx, fields(fd), await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/facilities`);
  return ok("clinic.facilities.created");
}

export async function createRoomAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await createRoom(ctx, fields(fd), await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/facilities`);
  return ok("clinic.facilities.created");
}

export async function archiveFacilityAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    const id = String(fd.get("id"));
    if (fd.get("type") === "room") await archiveRoom(ctx, id, await requestMeta());
    else await archiveDepartment(ctx, id, await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/c/${slug}/facilities`);
  return ok("clinic.facilities.archived");
}

// ───────────── Services ─────────────

export async function createServiceAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await createService(ctx, fields(fd), await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/services`);
  return ok("clinic.services.created");
}

export async function updateServiceAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await updateService(ctx, String(fd.get("id")), fields(fd), await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/services`, "layout");
  return ok("clinic.services.saved");
}

export async function serviceArchiveAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await setServiceArchived(ctx, String(fd.get("id")), fd.get("archived") === "true", await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/c/${slug}/services`, "layout");
  return ok("clinic.services.saved");
}

// ───────────── Doctors & schedules ─────────────

export async function doctorProfileAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  const membershipId = String(fd.get("membershipId"));
  try {
    await saveDoctorProfile(
      ctx,
      membershipId,
      {
        specialty: fd.get("specialty"),
        departmentId: fd.get("departmentId") ?? "",
        licenseNumber: fd.get("licenseNumber") ?? "",
        defaultSlotMinutes: fd.get("defaultSlotMinutes"),
        bufferMinutes: fd.get("bufferMinutes") ?? "",
        acceptsOnlineBooking: fd.get("acceptsOnlineBooking") === "on",
        contactPhone: String(fd.get("contactPhone") ?? ""),
        contactTelegram: String(fd.get("contactTelegram") ?? ""),
        code: String(fd.get("code") ?? ""),
      },
      await requestMeta(),
    );
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/doctors`, "layout");
  return ok("clinic.doctors.profileSaved");
}

export async function commissionAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await setDoctorCommission(ctx, String(fd.get("profileId") ?? ""), String(fd.get("commissionPercent") ?? "").trim(), await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/doctors`, "layout");
  return ok("clinic.doctors.commissionSaved");
}

export async function doctorServicesAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await setDoctorServices(ctx, String(fd.get("profileId")), fd.getAll("serviceIds").map(String), await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/c/${slug}/doctors`, "layout");
  return ok("clinic.doctors.servicesSaved");
}

export async function addBlockAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await addScheduleBlock(ctx, String(fd.get("profileId")), fields(fd), await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/doctors`, "layout");
  return ok("clinic.doctors.blockAdded");
}

export async function addExceptionAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    await addScheduleException(ctx, String(fd.get("profileId")), fields(fd), await requestMeta());
  } catch (e) {
    return toFormState(e, fd);
  }
  revalidatePath(`/c/${slug}/doctors`, "layout");
  return ok("clinic.doctors.exceptionAdded");
}

export async function removeScheduleItemAction(_: FormState, fd: FormData): Promise<FormState> {
  const { slug, ctx } = await clinicFrom(fd);
  try {
    const id = String(fd.get("id"));
    if (fd.get("type") === "exception") await removeScheduleException(ctx, id, await requestMeta());
    else await removeScheduleBlock(ctx, id, await requestMeta());
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath(`/c/${slug}/doctors`, "layout");
  return ok("clinic.doctors.removed");
}
