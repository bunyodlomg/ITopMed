/**
 * A patient's paper (visit document, prescription, lab report, study report)
 * as plain blocks, so the same content becomes a PDF or a Word (.docx) file.
 * Built by src/server/papers/build.ts from the same services the print pages
 * use (same access rules and audit), rendered by pdf.ts / docx.ts.
 */

export type PaperKind = "document" | "prescription" | "lab" | "study";
export type PaperFormat = "pdf" | "docx";

export interface PaperImage {
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
}

export type PaperBlock =
  /** A section heading (bold). */
  | { t: "heading"; text: string }
  /** Running text; "\n" starts a new line. */
  | { t: "text"; text: string; bold?: boolean; small?: boolean }
  /** "Label: value" lines. */
  | { t: "fields"; rows: [label: string, value: string][] }
  /** A simple grid; `strong` rows (values outside the reference range) are bold. */
  | { t: "table"; head: string[]; rows: { cells: string[]; strong?: boolean }[] }
  /** Lines the patient must not miss (lab tests still to take, intake hours). */
  | { t: "highlight"; title?: string; lines: string[] }
  | { t: "image"; image: PaperImage }
  /** "Doctor: Name ______" at the end. */
  | { t: "signature"; text: string };

export interface Paper {
  kind: PaperKind;
  title: string;
  /** Letterhead: clinic name and the small lines under it (licence, address, phone). */
  head: { name: string; lines: string[]; logo?: PaperImage | null };
  blocks: PaperBlock[];
  /** Small print at the very end (e.g. "not an electronic prescription"). */
  footer?: string;
}

export const PAPER_MIME: Record<PaperFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** A PNG or JPEG image from a data URL (the clinic logo); anything else is skipped. */
export function imageFromDataUrl(url: string | null | undefined): PaperImage | null {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(url ?? "");
  if (!m) return null;
  return { mime: m[1] as PaperImage["mime"], bytes: new Uint8Array(Buffer.from(m[2]!, "base64")) };
}

/** PNG / JPEG by their first bytes (WebP and PDF attachments are not embedded). */
export function sniffImage(bytes: Uint8Array): PaperImage["mime"] | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

/**
 * The file name the patient sees in Telegram: clinic-neutral, no name, no
 * diagnosis (rule: no PHI in names or messages) - only the kind and the date.
 */
export function paperFileName(kind: PaperKind | `${PaperKind}-device`, day: string, format: PaperFormat, n?: number): string {
  return `ITopMed-${kind}-${day}${n && n > 1 ? `-${n}` : ""}.${format}`;
}
