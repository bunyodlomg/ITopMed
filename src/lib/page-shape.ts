/** Which loading placeholder fits a page (see PageSkeleton). Pure, so it is unit-tested. */
export type PageShape = "dashboard" | "list" | "detail" | "form" | "report";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORM_PAGES = new Set(["settings", "desk", "nurse", "branches", "facilities", "integrations", "support-access", "setup", "new", "edit", "security"]);
const REPORT_PAGES = new Set(["reports", "control", "my-earnings", "cash"]);

/**
 * A record (an id in the path), a form-like screen, a report, the dashboard,
 * or — most screens — a list.
 */
export function shapeOf(pathname: string): PageShape {
  const parts = pathname.split("/").filter(Boolean);
  // /c/<slug>/…, /p/<slug>/…, /admin/…
  const rest = parts[0] === "admin" ? parts.slice(1) : parts.slice(2);
  if (!rest.length) return "dashboard";
  if (rest.some((p) => ID.test(p))) return "detail";
  if (FORM_PAGES.has(rest[rest.length - 1]!)) return "form";
  if (REPORT_PAGES.has(rest[0]!)) return "report";
  return "list";
}
