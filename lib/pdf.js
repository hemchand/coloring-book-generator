// Builds the two KDP files from generated images:
//   interior.pdf — one coloring page per sheet (optional blank backs), upscaled to 300 DPI,
//                  cleaned to pure black & white, inside KDP no-bleed margins.
//   cover.pdf    — full wrap (back + spine + front) with 0.125" bleed, spine width from page count.

import sharp from 'sharp';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';

const DPI = 300;
const PT = 72; // PDF points per inch

export const TRIMS = {
  '8.5x11': { w: 8.5, h: 11 },
  '8x10': { w: 8, h: 10 },
  '8.5x8.5': { w: 8.5, h: 8.5 },
};

// KDP paperback spine width per page (inches).
const SPINE_PER_PAGE = { white: 0.002252, cream: 0.0025 };

// KDP minimum inside (gutter) margin by total page count; we use it on every side
// so the art stays centred.
function gutterFor(pageCount) {
  if (pageCount <= 150) return 0.375;
  if (pageCount <= 300) return 0.5;
  if (pageCount <= 500) return 0.625;
  return 0.75;
}

export function interiorPageCount(imageCount, blankBacks) {
  return blankBacks ? imageCount * 2 : imageCount;
}

/**
 * @param {Buffer[]} images   page PNGs in order
 * @param {{trim:string, blankBacks:boolean, cleanLines:boolean, threshold?:number}} opts
 */
export async function buildInteriorPdf(images, { trim = '8.5x11', blankBacks = true, cleanLines = true, threshold = 175 } = {}) {
  const t = TRIMS[trim] || TRIMS['8.5x11'];
  const pageCount = interiorPageCount(images.length, blankBacks);
  const margin = gutterFor(pageCount);
  const boxW = Math.round((t.w - 2 * margin) * DPI);
  const boxH = Math.round((t.h - 2 * margin) * DPI);

  const pdf = await PDFDocument.create();
  for (const input of images) {
    let img = sharp(input).flatten({ background: '#ffffff' }).grayscale()
      .resize({ width: boxW, height: boxH, fit: 'inside', kernel: 'lanczos3' });
    if (cleanLines) img = img.threshold(threshold);
    const png = await img.png({ compressionLevel: 9 }).toBuffer();
    const meta = await sharp(png).metadata();
    const embedded = await pdf.embedPng(png);

    const page = pdf.addPage([t.w * PT, t.h * PT]);
    const drawW = (meta.width / DPI) * PT;
    const drawH = (meta.height / DPI) * PT;
    page.drawImage(embedded, {
      x: (t.w * PT - drawW) / 2,
      y: (t.h * PT - drawH) / 2,
      width: drawW,
      height: drawH,
    });
    if (blankBacks) pdf.addPage([t.w * PT, t.h * PT]);
  }
  pdf.setTitle('Coloring book interior');
  return { bytes: await pdf.save(), pageCount, margin };
}

function asciiOnly(s) {
  return String(s || '').replace(/[^\x20-\x7E]/g, '').trim();
}

// Standard PDF fonts only cover WinAnsi (Latin-1); drop anything else (emoji etc.).
function winAnsi(s) {
  return String(s || '').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '').trim();
}

function wrapLines(text, font, size, maxW) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= maxW || !line) line = next;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

// Largest size (<= maxSize) at which the text fits in maxLines lines of width maxW.
function fitText(text, font, maxW, maxSize, minSize, maxLines) {
  for (let size = maxSize; size >= minSize; size -= 1) {
    const lines = wrapLines(text, font, size, maxW);
    if (lines.length <= maxLines && lines.every((l) => font.widthOfTextAtSize(l, size) <= maxW)) return { size, lines };
  }
  return { size: minSize, lines: wrapLines(text, font, minSize, maxW).slice(0, maxLines) };
}

// Text with a dark outline (drawn as offset copies), like playful book covers.
function drawOutlinedText(page, text, { x, y, size, font, fill, outline, weight = 1.4 }) {
  if (outline) {
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-0.7, -0.7], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7]]) {
      page.drawText(text, { x: x + dx * weight, y: y + dy * weight, size, font, color: outline });
    }
  }
  page.drawText(text, { x, y, size, font, color: fill });
}

function centeredLines(page, lines, { centerX, topY, size, font, fill, outline, lineGap = 1.15 }) {
  let y = topY - size;
  for (const line of lines) {
    const w = font.widthOfTextAtSize(line, size);
    drawOutlinedText(page, line, { x: centerX - w / 2, y, size, font, fill, outline, weight: Math.max(1, size / 22) });
    y -= size * lineGap;
  }
  return y + size * lineGap - size * 0.25; // bottom of the block
}

// Place a rotated rectangle/image so its centre lands on (cx, cy). pdf-lib rotates around the lower-left corner.
function rotatedOrigin(cx, cy, w, h, deg) {
  const t = (deg * Math.PI) / 180;
  return {
    x: cx - (w / 2) * Math.cos(t) + (h / 2) * Math.sin(t),
    y: cy - (w / 2) * Math.sin(t) - (h / 2) * Math.cos(t),
  };
}

/**
 * Back panel like a retail coloring book: headline + subheadline, 4 real pages on tilted cards,
 * tagline, brand. KDP's barcode box (bottom-right, next to the spine) is left empty.
 */
async function drawBackPanel(pdf, page, { x0, y0, w, h, bg, back }) {
  const PTi = PT;
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const lum = 0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b;
  const darkBg = lum < 150;
  const fill = darkBg ? rgb(1, 1, 1) : rgb(1, 1, 1);
  const outline = rgb(Math.max(0, bg.r * 0.35) / 255, Math.max(0, bg.g * 0.35) / 255, Math.max(0, bg.b * 0.35) / 255);
  const ink = darkBg ? rgb(1, 1, 1) : outline;
  const cx = (x0 + w / 2) * PTi;
  const safe = 0.375; // inches inside trim

  // Soft decorative circles in a lighter tint of the background.
  const tint = rgb(Math.min(255, bg.r + (255 - bg.r) * 0.35) / 255, Math.min(255, bg.g + (255 - bg.g) * 0.35) / 255, Math.min(255, bg.b + (255 - bg.b) * 0.35) / 255);
  for (const [fx, fy, r] of [[0.08, 0.9, 0.55], [0.86, 0.6, 0.35], [0.05, 0.35, 0.35], [0.84, 0.95, 0.3], [0.5, 0.06, 0.25]]) {
    page.drawCircle({ x: (x0 + w * fx) * PTi, y: (y0 + h * fy) * PTi, size: r * PTi, color: tint, opacity: 0.6 });
  }

  // Headline + subheadline.
  let top = (y0 + h - safe - 0.15) * PTi;
  const textW = (w - 2 * safe - 0.3) * PTi;
  const headline = winAnsi(back.headline).toUpperCase();
  if (headline) {
    const f = fitText(headline, bold, textW, 34, 18, 2);
    top = centeredLines(page, f.lines, { centerX: cx, topY: top, size: f.size, font: bold, fill, outline });
  }
  const sub = winAnsi(back.subheadline);
  if (sub) {
    const f = fitText(sub, bold, textW, 22, 12, 2);
    top = centeredLines(page, f.lines, { centerX: cx, topY: top - 6, size: f.size, font: bold, fill, outline });
  }

  // Tagline area (above the barcode box) and brand at the bottom.
  const barcodeTop = y0 + 0.25 + 1.2 + 0.15;   // KDP barcode: 2" x 1.2", 0.25" from bottom and spine edges
  const tagline = winAnsi(back.tagline);
  let gridBottom = (barcodeTop + 0.2) * PTi;
  if (tagline) {
    const f = fitText(tagline, bold, textW, 24, 13, 2);
    const blockH = f.size * (1 + 1.15 * (f.lines.length - 1));
    const tagTop = (barcodeTop + 0.15) * PTi + blockH;
    centeredLines(page, f.lines, { centerX: cx, topY: tagTop, size: f.size, font: bold, fill, outline });
    gridBottom = tagTop + 0.3 * PTi;
  }
  const brand = winAnsi(back.brand);
  if (brand) {
    const size = 13;
    const bw = bold.widthOfTextAtSize(brand, size);
    // Centre of the area left of the barcode box.
    const leftEnd = (x0 + w - 0.25 - 2.0 - 0.2) * PTi;
    const bx = Math.min(cx, (x0 * PTi + leftEnd) / 2) - bw / 2;
    page.drawText(brand, { x: bx, y: (y0 + 0.55) * PTi, size, font: bold, color: ink });
  }

  // 2x2 grid of tilted page cards between the header and the tagline.
  const imgs = (back.images || []).slice(0, 4);
  if (imgs.length) {
    const gridTop = top - 0.2 * PTi;
    const availH = gridTop - gridBottom;
    const availW = (w - 2 * safe) * PTi;
    const rows = imgs.length > 2 ? 2 : 1;
    const cols = imgs.length > 1 ? 2 : 1;
    const gap = 0.25 * PTi;
    const ratio = 8.5 / 11;
    let cardH = (availH - gap * (rows - 1)) / rows;
    let cardW = cardH * ratio;
    if (cardW * cols + gap * (cols - 1) > availW) { cardW = (availW - gap * (cols - 1)) / cols; cardH = cardW / ratio; }
    cardW *= 0.96; cardH *= 0.96; // room for tilt
    const angles = [3, -3, -2.5, 3.5];
    const pad = 0.08 * PTi;
    for (let i = 0; i < imgs.length; i++) {
      const r = Math.floor(i / cols), c = i % cols;
      const ccx = cx + (c - (cols - 1) / 2) * (cardW + gap);
      const ccy = gridTop - availH / 2 + ((rows - 1) / 2 - r) * (cardH + gap);
      const a = angles[i];
      const sh = rotatedOrigin(ccx + 3, ccy - 4, cardW, cardH, a);
      page.drawRectangle({ x: sh.x, y: sh.y, width: cardW, height: cardH, rotate: degrees(a), color: rgb(0, 0, 0), opacity: 0.18 });
      const o = rotatedOrigin(ccx, ccy, cardW, cardH, a);
      page.drawRectangle({ x: o.x, y: o.y, width: cardW, height: cardH, rotate: degrees(a), color: rgb(1, 1, 1), borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 0.6 });
      const png = await sharp(imgs[i]).flatten({ background: '#ffffff' }).grayscale()
        .resize({ width: Math.round(((cardW - 2 * pad) / PTi) * 300), height: Math.round(((cardH - 2 * pad) / PTi) * 300), fit: 'contain', background: '#ffffff' })
        .threshold(175).png().toBuffer();
      const emb = await pdf.embedPng(png);
      const io = rotatedOrigin(ccx, ccy, cardW - 2 * pad, cardH - 2 * pad, a);
      page.drawImage(emb, { x: io.x, y: io.y, width: cardW - 2 * pad, height: cardH - 2 * pad, rotate: degrees(a) });
    }
  }
}

/**
 * @param {Buffer} frontImage  chosen cover PNG
 * @param {{trim:string, pageCount:number, paper:'white'|'cream', title?:string}} opts
 */
export async function buildCoverPdf(frontImage, { trim = '8.5x11', pageCount, paper = 'white', title = '', back = null }) {
  const t = TRIMS[trim] || TRIMS['8.5x11'];
  const bleed = 0.125;
  const spine = +(pageCount * (SPINE_PER_PAGE[paper] || SPINE_PER_PAGE.white)).toFixed(4);
  const fullW = bleed + t.w + spine + t.w + bleed;
  const fullH = bleed + t.h + bleed;

  // Back panel + spine take the average colour of the front art's left edge, so the wrap
  // continues smoothly from the front across the spine.
  const meta = await sharp(frontImage).metadata();
  const strip = await sharp(frontImage)
    .extract({ left: 0, top: 0, width: Math.max(8, Math.round(meta.width * 0.04)), height: meta.height })
    .stats();
  const [r, g, b] = strip.channels.map((c) => Math.round(c.mean));
  const dominant = { r, g, b };
  const bg = rgb(dominant.r / 255, dominant.g / 255, dominant.b / 255);
  const luminance = 0.2126 * dominant.r + 0.7152 * dominant.g + 0.0722 * dominant.b;
  const textColor = luminance > 140 ? rgb(0.1, 0.1, 0.1) : rgb(1, 1, 1);

  // Front panel: trim + bleed on the right, top and bottom. Fill it (crop, not stretch).
  const frontW = t.w + bleed;
  const frontJpg = await sharp(frontImage).flatten({ background: '#ffffff' })
    .resize({ width: Math.round(frontW * DPI), height: Math.round(fullH * DPI), fit: 'cover', kernel: 'lanczos3' })
    .jpeg({ quality: 92 }).toBuffer();

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([fullW * PT, fullH * PT]);
  page.drawRectangle({ x: 0, y: 0, width: fullW * PT, height: fullH * PT, color: bg });
  if (back) {
    await drawBackPanel(pdf, page, { x0: bleed, y0: bleed, w: t.w, h: t.h, bg: dominant, back });
  }
  const front = await pdf.embedJpg(frontJpg);
  page.drawImage(front, { x: (fullW - frontW) * PT, y: 0, width: frontW * PT, height: fullH * PT });

  // KDP allows spine text only for books with more than 79 pages.
  const spineTitle = asciiOnly(title);
  if (pageCount > 79 && spineTitle) {
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const spinePt = spine * PT;
    let size = Math.min(14, spinePt - 2 * 0.0625 * PT - 2);
    const maxLen = (t.h - 1) * PT;
    while (size > 4 && font.widthOfTextAtSize(spineTitle, size) > maxLen) size -= 0.5;
    if (size >= 5) {
      const textW = font.widthOfTextAtSize(spineTitle, size);
      const spineCenterX = (bleed + t.w + spine / 2) * PT;
      // Rotated -90° so it reads top-to-bottom, as on US spines.
      page.drawText(spineTitle, {
        x: spineCenterX - size * 0.35,
        y: (fullH * PT + textW) / 2,
        size, font, color: textColor, rotate: degrees(-90),
      });
    }
  }
  pdf.setTitle('Coloring book cover');
  return {
    bytes: await pdf.save(),
    spine,
    widthIn: +fullW.toFixed(4),
    heightIn: +fullH.toFixed(4),
    spineText: pageCount > 79,
  };
}

/** Rough check for shading / heavy black fills, so bad pages are flagged before a redo. */
export async function checkLineArt(input) {
  const { data } = await sharp(input).grayscale().resize({ width: 256 }).raw().toBuffer({ resolveWithObject: true });
  let mid = 0, dark = 0;
  for (const v of data) { if (v < 80) dark++; else if (v < 200) mid++; }
  const grayPct = +(100 * mid / data.length).toFixed(1);
  const darkPct = +(100 * dark / data.length).toFixed(1);
  const issues = [];
  if (grayPct > 18) issues.push('possible gray shading');
  if (darkPct > 25) issues.push('large black areas');
  return { grayPct, darkPct, issues };
}
