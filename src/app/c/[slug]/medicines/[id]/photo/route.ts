import { requireClinic } from "@/server/auth/guards";
import { canUseMedicines, medicinePhoto, setMedicinePhoto } from "@/server/emr/medicines";
import { env } from "@/server/env";
import { DomainError } from "@/server/errors";
import { isSameOriginRequest, requestMeta } from "@/server/http";

/** The picture of a medicine (box or tablet). The type comes from the stored, sniffed value. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const ctx = await requireClinic(slug);
  if (!canUseMedicines(ctx)) return new Response("Not found", { status: 404 });
  const p = await medicinePhoto(ctx, id);
  if (!p) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(p.bytes), {
    headers: {
      "Content-Type": p.mime,
      "Content-Disposition": `inline; filename="${id}.${p.mime.split("/")[1]}"`,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}

/**
 * Upload (field "photo") or remove ("remove=1") the picture: form POST,
 * multipart, same-origin only. Redirects back to the medicine with the outcome.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  if (!isSameOriginRequest(request, env().APP_URL)) return new Response("Forbidden", { status: 403 });
  const { slug, id } = await params;
  const ctx = await requireClinic(slug);
  if (!ctx.permissions.has("medicines.manage")) return new Response("Not found", { status: 404 });
  const form = await request.formData();
  const file = form.get("photo");
  let code = "saved";
  try {
    if (form.get("remove") === "1") {
      await setMedicinePhoto(ctx, id, null, await requestMeta());
      code = "removed";
    } else {
      if (!(typeof file === "object" && file !== null && "arrayBuffer" in file && file.size > 0)) throw new DomainError("errors.noFile");
      await setMedicinePhoto(ctx, id, new Uint8Array(await file.arrayBuffer()), await requestMeta());
    }
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    code = e.code.replace(/^errors\./, "");
  }
  // Relative Location: behind the proxy request.url carries the internal address.
  return new Response(null, { status: 303, headers: { Location: `/c/${ctx.tenant.slug}/medicines/${encodeURIComponent(id)}?photo=${encodeURIComponent(code)}` } });
}
