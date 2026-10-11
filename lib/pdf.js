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

/**
 * @param {Buffer} frontImage  chosen cover PNG
 * @param {{trim:string, pageCount:number, paper:'white'|'cream', title?:string}} opts
 */
export async function buildCoverPdf(frontImage, { trim = '8.5x11', pageCount, paper = 'white', title = '' }) {
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
