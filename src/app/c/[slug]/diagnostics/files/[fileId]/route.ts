import { requireClinic } from "@/server/auth/guards";
import { getDiagnosticFile } from "@/server/emr/diagnostics";
import { DomainError } from "@/server/errors";
import { requestMeta } from "@/server/http";

/** Shows an attached image / PDF. Never cached; the type comes from the stored (sniffed) value. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string; fileId: string }> }) {
  const { slug, fileId } = await params;
  const ctx = await requireClinic(slug);
  try {
    const f = await getDiagnosticFile(ctx, fileId, await requestMeta());
    return new Response(Buffer.from(f.content), {
      headers: {
        "Content-Type": f.mimeType,
        // File id only in the header name; the stored name may contain a patient's name.
        "Content-Disposition": `inline; filename="${fileId}.${f.mimeType === "application/pdf" ? "pdf" : f.mimeType.split("/")[1]}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; plugin-types application/pdf",
      },
    });
  } catch (e) {
    if (e instanceof DomainError) return new Response("Not found", { status: 404 });
    throw e;
  }
}
