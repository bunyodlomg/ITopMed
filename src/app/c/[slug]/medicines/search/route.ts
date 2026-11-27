import { requireClinic } from "@/server/auth/guards";
import { canUseMedicines, searchMedicines } from "@/server/emr/medicines";

/**
 * Live search of the clinic's medicine catalog for the prescription form
 * (GET ?q=). Reference data only - no patient data in or out. Not cached.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug);
  if (!canUseMedicines(ctx)) return new Response("Not found", { status: 404 });
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const items = await searchMedicines(ctx, q, 12);
  return Response.json({ items }, { headers: { "Cache-Control": "no-store" } });
}
