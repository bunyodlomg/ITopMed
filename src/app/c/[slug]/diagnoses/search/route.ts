import { requireClinic } from "@/server/auth/guards";
import { searchDiagnoses } from "@/server/emr/assist";

/**
 * Diagnosis suggestions for the visit form (GET ?q=): the clinic's own codes
 * and wording (see searchDiagnoses). Doctors only (emr.write). Not cached.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug, "emr.write");
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const items = await searchDiagnoses(ctx, q, 10);
  return Response.json({ items }, { headers: { "Cache-Control": "no-store" } });
}
