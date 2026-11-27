import { requireClinic } from "@/server/auth/guards";
import { addDiagnosticFile, canRecordStudies } from "@/server/emr/diagnostics";
import { env } from "@/server/env";
import { DomainError } from "@/server/errors";
import { isSameOriginRequest, requestMeta } from "@/server/http";

/**
 * Attach images / PDFs to a diagnostic result (form POST, multipart). A route
 * handler, not a server action: files are up to 10 MB each. Same-origin only.
 * Redirects back to the page the form came from, with the outcome code.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  if (!isSameOriginRequest(request, env().APP_URL)) return new Response("Forbidden", { status: 403 });
  const { slug, id } = await params;
  const ctx = await requireClinic(slug);
  if (!canRecordStudies(ctx)) return new Response("Not found", { status: 404 });
  const form = await request.formData();
  const back = String(form.get("$back") ?? "");
  const target = back.startsWith(`/c/${ctx.tenant.slug}/`) ? back : `/c/${ctx.tenant.slug}`;
  const files = form.getAll("file").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f && (f as File).size > 0);
  let code = "uploaded";
  try {
    if (!files.length) throw new DomainError("errors.noFile");
    const meta = await requestMeta();
    for (const f of files.slice(0, 10)) await addDiagnosticFile(ctx, id, { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }, meta);
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    code = e.code.replace(/^errors\./, "");
  }
  const url = new URL(target, request.url);
  url.searchParams.set("files", code);
  url.hash = "diagnostics";
  // Relative Location: behind the proxy request.url carries the internal address.
  return new Response(null, { status: 303, headers: { Location: `${url.pathname}${url.search}${url.hash}` } });
}
