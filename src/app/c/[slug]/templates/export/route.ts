import { requireClinic } from "@/server/auth/guards";
import { exportTemplates } from "@/server/clinic/templates";
import { requestMeta } from "@/server/http";

/** The clinic's templates as a .json file (templates hold no patient data). */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireClinic(slug, "clinic.settings.manage");
  const file = await exportTemplates(ctx, await requestMeta());
  const date = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(file, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="templates-${ctx.tenant.slug}-${date}.json"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
