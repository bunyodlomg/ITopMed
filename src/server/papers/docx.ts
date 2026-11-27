import { strToU8, zipSync } from "fflate";
import type { Paper, PaperImage } from "./paper";

/**
 * A paper as a Word document (.docx, Office Open XML) the patient or another
 * doctor can open and edit: the same letterhead, title and blocks as the PDF,
 * pictures included. Written by hand (a handful of XML parts zipped with
 * fflate) so no extra dependency is needed. Font: Arial (Latin + Cyrillic on
 * every Windows / Office installation).
 */

const esc = (s: string) =>
  s
    // Characters XML 1.0 does not allow.
    .replace(/[^\u0009\u000A\u000D -퟿-�]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

type RunOpts = { bold?: boolean; size?: number; color?: string };

function run(text: string, o: RunOpts = {}): string {
  const props = `${o.bold ? "<w:b/>" : ""}${o.color ? `<w:color w:val="${o.color}"/>` : ""}${o.size ? `<w:sz w:val="${o.size * 2}"/><w:szCs w:val="${o.size * 2}"/>` : ""}`;
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line, i) => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${i ? "<w:br/>" : ""}<w:t xml:space="preserve">${esc(line)}</w:t></w:r>`)
    .join("");
}

type ParaOpts = { align?: "center" | "left"; after?: number; shade?: string; barColor?: string };
const para = (runs: string, o: ParaOpts = {}) =>
  `<w:p><w:pPr>${o.barColor ? `<w:pBdr><w:left w:val="single" w:sz="24" w:space="6" w:color="${o.barColor}"/></w:pBdr>` : ""}${o.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.shade}"/>` : ""}<w:spacing w:after="${o.after ?? 80}"/>${o.align === "center" ? '<w:jc w:val="center"/>' : ""}</w:pPr>${runs}</w:p>`;

/** Pixel size of a PNG / JPEG (for the picture's frame). */
export function imageSize(img: PaperImage): { w: number; h: number } | null {
  const b = img.bytes;
  if (img.mime === "image/png") {
    if (b.length < 24) return null;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { w: v.getUint32(16), h: v.getUint32(20) };
  }
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    // Start-of-frame markers (baseline, progressive…) hold the size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: (b[i + 5]! << 8) | b[i + 6]!, w: (b[i + 7]! << 8) | b[i + 8]! };
    }
    i += 2 + len;
  }
  return null;
}

const EMU_PER_PT = 12700;

export function renderDocx(paper: Paper): Uint8Array {
  const media: { name: string; img: PaperImage }[] = [];
  const picture = (img: PaperImage, maxWpt: number, maxHpt: number, align: "center" | "left" = "center") => {
    const size = imageSize(img);
    if (!size || !size.w || !size.h) return "";
    const s = Math.min(maxWpt / size.w, maxHpt / size.h, 1);
    const cx = Math.round(size.w * s * EMU_PER_PT);
    const cy = Math.round(size.h * s * EMU_PER_PT);
    const n = media.length + 1;
    media.push({ name: `image${n}.${img.mime === "image/png" ? "png" : "jpeg"}`, img });
    const drawing =
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}"/>` +
      `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="rImg${n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
      `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    return para(drawing, { align, after: 120 });
  };

  const body: string[] = [];
  if (paper.head.logo) body.push(picture(paper.head.logo, 110, 56));
  body.push(para(run(paper.head.name.toUpperCase(), { bold: true, size: 14, color: "0A5C73" }), { align: "center", after: 20 }));
  for (const l of paper.head.lines) body.push(para(run(l, { size: 8.5, color: "5F6670" }), { align: "center", after: 0 }));
  body.push(`<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="1" w:color="0A5C73"/></w:pBdr><w:spacing w:after="200"/></w:pPr></w:p>`);
  body.push(para(run(paper.title.toUpperCase(), { bold: true, size: 13 }), { align: "center", after: 200 }));

  for (const b of paper.blocks) {
    switch (b.t) {
      case "heading":
        body.push(para(run(b.text, { bold: true, size: 11.5 }), { after: 60 }));
        break;
      case "text":
        body.push(para(run(b.text, { bold: b.bold, size: b.small ? 8.5 : undefined, color: b.small ? "5F6670" : undefined }), { after: 120 }));
        break;
      case "fields":
        for (const [label, value] of b.rows) body.push(para(run(`${label}: `, { bold: true }) + run(value), { after: 40 }));
        body.push(para("", { after: 60 }));
        break;
      case "table": {
        const cell = (text: string, o: RunOpts, w: number) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="pct"/></w:tcPr>${para(run(text, o), { after: 0 })}</w:tc>`;
        const n = b.head.length;
        // Widths in fiftieths of a percent: the first column 40 %, the rest share 60 %.
        const widths = n > 1 ? [2000, ...Array.from({ length: n - 1 }, () => Math.floor(3000 / (n - 1)))] : [5000];
        const border = '<w:top w:val="single" w:sz="4" w:color="C8CDD3"/><w:bottom w:val="single" w:sz="4" w:color="C8CDD3"/><w:insideH w:val="single" w:sz="4" w:color="C8CDD3"/>';
        body.push(
          `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${border}</w:tblBorders><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
            `<w:tblGrid>${widths.map(() => "<w:gridCol/>").join("")}</w:tblGrid>` +
            `<w:tr><w:trPr><w:tblHeader/></w:trPr>${b.head.map((h, i) => cell(h, { bold: true, size: 9, color: "5F6670" }, widths[i]!)).join("")}</w:tr>` +
            b.rows.map((r) => `<w:tr>${r.cells.map((c, i) => cell(c, { bold: r.strong, size: 10 }, widths[i]!)).join("")}</w:tr>`).join("") +
            `</w:tbl>`,
        );
        body.push(para("", { after: 120 }));
        break;
      }
      case "highlight":
        if (b.title) body.push(para(run(b.title, { bold: true }), { shade: "FFF2C7", barColor: "D98C0D", after: 0 }));
        for (const l of b.lines) body.push(para(run(l, { bold: true }), { shade: "FFF2C7", barColor: "D98C0D", after: 0 }));
        body.push(para("", { after: 120 }));
        break;
      case "image":
        body.push(picture(b.image, 480, 330));
        break;
      case "signature":
        body.push(para(run(`${b.text}  ______________________`), { after: 120 }) );
        break;
    }
  }
  if (paper.footer) body.push(para(run(paper.footer, { size: 8, color: "5F6670" })));

  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>` +
    `<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="uz-Latn-UZ"/>` +
    `</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    media.map((m, i) => `<Relationship Id="rImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join("") +
    `</Relationships>`;

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        `<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
        `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `<Relationship Id="rCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    ),
    "docProps/core.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
        `<dc:title>${esc(paper.title)}</dc:title><dc:creator>ITop Med</dc:creator></cp:coreProperties>`,
    ),
    "word/document.xml": strToU8(document),
    "word/styles.xml": strToU8(styles),
    "word/_rels/document.xml.rels": strToU8(rels),
  };
  for (const m of media) files[`word/media/${m.name}`] = m.img.bytes;
  return zipSync(files, { level: 6 });
}
