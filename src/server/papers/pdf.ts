import fs from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import type { Paper, PaperImage } from "./paper";

/**
 * A paper as an A4 PDF: the clinic letterhead, the title, then the blocks,
 * with page breaks and page numbers. Noto Sans (SIL OFL, public/fonts) covers
 * Uzbek Latin and Cyrillic and Russian; a character the font lacks is replaced,
 * never dropped silently.
 */

const A4 = { w: 595.28, h: 841.89 };
const M = { x: 50, top: 48, bottom: 56 };
const WIDTH = A4.w - 2 * M.x;
const INK = rgb(0.1, 0.12, 0.14);
const MUTED = rgb(0.38, 0.4, 0.44);
const ACCENT = rgb(0.04, 0.36, 0.45);
const RULE = rgb(0.8, 0.82, 0.85);
const HIGHLIGHT = rgb(1, 0.95, 0.78);
const HIGHLIGHT_BAR = rgb(0.85, 0.55, 0.05);

let fontCache: Promise<{ regular: Uint8Array; bold: Uint8Array }> | null = null;
function fontBytes() {
  const dir = path.join(process.cwd(), "public", "fonts");
  fontCache ??= Promise.all([fs.readFile(path.join(dir, "NotoSans-Regular.ttf")), fs.readFile(path.join(dir, "NotoSans-Bold.ttf"))]).then(([regular, bold]) => ({ regular, bold }));
  return fontCache;
}

/** Characters the font may lack, with readable stand-ins. */
const FALLBACK: Record<string, string> = { "↑": "(+)", "↓": "(-)", "✓": "+", "№": "No.", "\t": "    " };

type Run = { text: string; bold?: boolean };
type Word = { text: string; font: PDFFont; width: number; space: boolean };

export async function renderPdf(paper: Paper): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const bytes = await fontBytes();
  const regular = await doc.embedFont(bytes.regular, { subset: true });
  const bold = await doc.embedFont(bytes.bold, { subset: true });
  const glyphs = new Set(regular.getCharacterSet());
  doc.setTitle(paper.title);
  doc.setCreator("ITop Med");
  doc.setProducer("ITop Med");

  const clean = (s: string) =>
    [...s.replace(/\r/g, "")]
      .map((ch) => (ch === "\n" || glyphs.has(ch.codePointAt(0)!) ? ch : (FALLBACK[ch] ?? "?")))
      .join("");

  let page: PDFPage = doc.addPage([A4.w, A4.h]);
  let y = A4.h - M.top;
  const newPage = () => {
    page = doc.addPage([A4.w, A4.h]);
    y = A4.h - M.top;
  };
  const need = (h: number) => {
    if (y - h < M.bottom) newPage();
  };

  /** Splits runs into words (with their font and width) and lays them out in lines no wider than `width`. */
  const layout = (runs: Run[], size: number, width: number): Word[][] => {
    const lines: Word[][] = [[]];
    let lineW = 0;
    const push = (w: Word) => {
      const line = lines[lines.length - 1]!;
      const gap = line.length && w.space ? regular.widthOfTextAtSize(" ", size) : 0;
      if (line.length && lineW + gap + w.width > width) {
        lines.push([{ ...w, space: false }]);
        lineW = w.width;
      } else {
        line.push(line.length ? w : { ...w, space: false });
        lineW += (line.length > 1 ? gap : 0) + w.width;
      }
    };
    let spaceBefore = false;
    for (const run of runs) {
      const font = run.bold ? bold : regular;
      clean(run.text)
        .split("\n")
        .forEach((para, pi) => {
          if (pi > 0) {
            lines.push([]);
            lineW = 0;
            spaceBefore = false;
          }
          const parts = para.split(/( +)/);
          for (const part of parts) {
            if (!part) continue;
            if (/^ +$/.test(part)) {
              spaceBefore = true;
              continue;
            }
            // A word longer than the line is cut into pieces that fit.
            let rest = part;
            while (rest) {
              let take = rest.length;
              while (take > 1 && font.widthOfTextAtSize(rest.slice(0, take), size) > width) take--;
              const text = rest.slice(0, take);
              push({ text, font, width: font.widthOfTextAtSize(text, size), space: spaceBefore });
              spaceBefore = false;
              rest = rest.slice(take);
            }
          }
        });
    }
    return lines;
  };

  const lineWidth = (line: Word[], size: number) => line.reduce((s, w, i) => s + w.width + (i && w.space ? regular.widthOfTextAtSize(" ", size) : 0), 0);

  /** Draws rich text from the cursor down; returns nothing, moves the cursor. */
  const rich = (runs: Run[], o: { size?: number; x?: number; width?: number; color?: ReturnType<typeof rgb>; align?: "left" | "center"; leading?: number } = {}) => {
    const size = o.size ?? 10.5;
    const x0 = o.x ?? M.x;
    const width = o.width ?? WIDTH;
    const leading = o.leading ?? size * 1.38;
    for (const line of layout(runs, size, width)) {
      need(leading);
      let x = o.align === "center" ? x0 + (width - lineWidth(line, size)) / 2 : x0;
      for (const [i, w] of line.entries()) {
        if (i && w.space) x += regular.widthOfTextAtSize(" ", size);
        page.drawText(w.text, { x, y: y - size, size, font: w.font, color: o.color ?? INK });
        x += w.width;
      }
      y -= leading;
    }
  };

  const rule = (color = RULE, thickness = 0.6) => {
    page.drawLine({ start: { x: M.x, y }, end: { x: M.x + WIDTH, y }, thickness, color });
  };

  const embed = async (img: PaperImage): Promise<PDFImage | null> => {
    try {
      return img.mime === "image/png" ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes);
    } catch {
      return null; // a damaged picture does not stop the paper
    }
  };

  // ── Letterhead ──
  const logo = paper.head.logo ? await embed(paper.head.logo) : null;
  const headTop = y;
  let textX = M.x;
  let textW = WIDTH;
  if (logo) {
    const s = Math.min(56 / logo.height, 110 / logo.width, 1);
    page.drawImage(logo, { x: M.x, y: headTop - logo.height * s, width: logo.width * s, height: logo.height * s });
    textX = M.x + logo.width * s + 12;
    textW = WIDTH - (logo.width * s + 12) * 2;
  }
  rich([{ text: paper.head.name.toUpperCase(), bold: true }], { size: 14, x: textX, width: textW, color: ACCENT, align: "center" });
  for (const l of paper.head.lines) rich([{ text: l }], { size: 8.5, x: textX, width: textW, color: MUTED, align: "center", leading: 11 });
  if (logo) y = Math.min(y, headTop - 60);
  y -= 4;
  rule(ACCENT, 1.4);
  y -= 16;

  // ── Title ──
  rich([{ text: paper.title.toUpperCase(), bold: true }], { size: 13, align: "center" });
  y -= 6;

  for (const b of paper.blocks) {
    switch (b.t) {
      case "heading":
        y -= 6;
        need(40);
        rich([{ text: b.text, bold: true }], { size: 11.5 });
        y -= 2;
        break;
      case "text":
        rich([{ text: b.text, bold: b.bold }], { size: b.small ? 8.5 : 10.5, color: b.small ? MUTED : INK });
        y -= 4;
        break;
      case "fields":
        for (const [label, value] of b.rows) rich([{ text: `${label}: `, bold: true }, { text: value }]);
        y -= 4;
        break;
      case "table": {
        const n = b.head.length;
        const first = n > 1 ? WIDTH * 0.4 : WIDTH;
        const widths = [first, ...Array.from({ length: n - 1 }, () => (WIDTH - first) / (n - 1))];
        const row = (cells: string[], o: { bold?: boolean; size: number; color?: ReturnType<typeof rgb> }) => {
          const laid = cells.map((c, i) => layout([{ text: c, bold: o.bold }], o.size, widths[i]! - 6));
          const leading = o.size * 1.35;
          const h = Math.max(...laid.map((l) => l.length)) * leading + 5;
          need(h);
          let x = M.x;
          laid.forEach((lines, i) => {
            let ly = y - 3;
            for (const line of lines) {
              let lx = x;
              for (const [j, w] of line.entries()) {
                if (j && w.space) lx += regular.widthOfTextAtSize(" ", o.size);
                page.drawText(w.text, { x: lx, y: ly - o.size, size: o.size, font: w.font, color: o.color ?? INK });
                lx += w.width;
              }
              ly -= leading;
            }
            x += widths[i]!;
          });
          y -= h;
          rule();
        };
        row(b.head, { bold: true, size: 9, color: MUTED });
        for (const r of b.rows) row(r.cells, { bold: r.strong, size: 10 });
        y -= 8;
        break;
      }
      case "highlight": {
        const lines = [...(b.title ? [{ text: b.title, bold: true }] : []), ...b.lines.map((text) => ({ text, bold: true }))];
        for (const l of lines) {
          const laid = layout([l], 10.5, WIDTH - 16);
          const h = laid.length * 14.5 + 4;
          need(h);
          page.drawRectangle({ x: M.x, y: y - h, width: WIDTH, height: h, color: HIGHLIGHT });
          page.drawRectangle({ x: M.x, y: y - h, width: 3, height: h, color: HIGHLIGHT_BAR });
          y -= 2;
          rich([l], { x: M.x + 10, width: WIDTH - 16, leading: 14.5 });
          y -= 2;
        }
        y -= 6;
        break;
      }
      case "image": {
        const img = await embed(b.image);
        if (!img) break;
        const s = Math.min(WIDTH / img.width, 330 / img.height, 1);
        const h = img.height * s;
        need(h + 8);
        page.drawImage(img, { x: M.x + (WIDTH - img.width * s) / 2, y: y - h, width: img.width * s, height: h });
        y -= h + 10;
        break;
      }
      case "signature":
        y -= 14;
        need(30);
        rich([{ text: `${b.text}  ______________________` }]);
        break;
    }
  }
  if (paper.footer) {
    y -= 10;
    rich([{ text: paper.footer }], { size: 8, color: MUTED });
  }

  const pages = doc.getPages();
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const label = `${i + 1} / ${pages.length}`;
      p.drawText(label, { x: A4.w - M.x - regular.widthOfTextAtSize(label, 8), y: 28, size: 8, font: regular, color: MUTED });
    });
  }
  return doc.save();
}
