import { Alert } from "@/components/ui/primitives";

/**
 * Paper size for printing: A4/A5 pages, or the 80 mm / 58 mm rolls of receipt
 * (thermal) printers. Thermal printers are ordinary Windows printers: choose
 * the receipt printer in the print dialog (or make it the default).
 */
export type PaperWidth = "a4" | "80" | "58";

export function paperFrom(v: string | undefined): PaperWidth {
  return v === "80" || v === "58" ? v : "a4";
}

export function PaperStyle({ width }: { width: PaperWidth }) {
  if (width === "a4") return <style>{"@page { size: A4; margin: 14mm 14mm 16mm; }"}</style>;
  const mm = Number(width);
  return (
    <style>{`@page { size: ${mm}mm auto; margin: 2mm; } @media print { html, body { width: ${mm - 4}mm; } body { font-size: ${mm === 58 ? 11 : 12}px; } }`}</style>
  );
}

/** Tailwind width of the on-screen preview for each paper. */
export const PAPER_PREVIEW: Record<PaperWidth, string> = { a4: "max-w-2xl", "80": "max-w-[320px]", "58": "max-w-[240px]" };

/** Shown instead of a paper the desk may not print yet (visit not finished, bill not settled…) or a doctor may not print at all. */
export function DeskPrintRefused({ title, message }: { title: string; message: string }) {
  return (
    <div className="mx-auto max-w-xl">
      <Alert tone="warning" title={title}>
        {message}
      </Alert>
    </div>
  );
}
