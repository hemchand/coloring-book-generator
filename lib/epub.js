// Builds a fixed-layout EPUB 3 for Kindle (KDP accepts fixed-layout EPUB uploads).
// One page per image: the front cover first, then every coloring page. No blank backs.
// Also writes the separate eBook cover JPEG that KDP asks for on the "Kindle eBook Content" page.

import sharp from 'sharp';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';

// Page canvas (8.5:11). Kindle scales to the screen; 1240x1600 keeps files small but sharp.
const PAGE_W = 1240;
const PAGE_H = 1600;

// ---------- tiny ZIP writer (EPUB needs "mimetype" first and uncompressed) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const { name, data, store } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const body = store ? raw : zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const method = store ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(method, 10); central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// ---------- content ----------

const xmlEscape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function pageXhtml(title, imgFile, alt) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=${PAGE_W}, height=${PAGE_H}"/>
<title>${xmlEscape(title)}</title>
<link rel="stylesheet" type="text/css" href="../css/fixed.css"/>
</head>
<body>
<div class="page"><img src="../images/${imgFile}" alt="${xmlEscape(alt)}"/></div>
</body>
</html>
`;
}

const CSS = `html, body { margin: 0; padding: 0; width: ${PAGE_W}px; height: ${PAGE_H}px; background: #ffffff; }
.page { position: absolute; top: 0; left: 0; width: ${PAGE_W}px; height: ${PAGE_H}px; overflow: hidden; }
.page img { position: absolute; top: 0; left: 0; width: ${PAGE_W}px; height: ${PAGE_H}px; }
`;

/** Coloring page → white 1240x1600 canvas with margins, cleaned to pure black & white, 1-bit-ish PNG. */
async function pageImage(buffer, cleanLines) {
  const margin = Math.round(PAGE_W * 0.05);
  let img = sharp(buffer).flatten({ background: '#ffffff' }).grayscale()
    .resize({ width: PAGE_W - 2 * margin, height: PAGE_H - 2 * margin, fit: 'inside', kernel: 'lanczos3' });
  if (cleanLines) img = img.threshold(175);
  const inner = await img.png().toBuffer();
  return sharp({ create: { width: PAGE_W, height: PAGE_H, channels: 3, background: '#ffffff' } })
    .composite([{ input: inner, gravity: 'center' }])
    .grayscale()
    .png({ compressionLevel: 9, palette: true, colors: cleanLines ? 2 : 16 })
    .toBuffer();
}

/** Front cover → full-bleed 1240x1600 JPEG for the first EPUB page. */
async function coverPageImage(buffer) {
  return sharp(buffer).flatten({ background: '#ffffff' })
    .resize({ width: PAGE_W, height: PAGE_H, fit: 'cover', kernel: 'lanczos3' })
    .jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}

/**
 * Separate KDP eBook cover: KDP recommends 1600 x 2560 px (1:1.6). We keep the art's own
 * proportions (no cropping of the title) at 1600 px wide, which KDP accepts.
 */
export async function buildKindleCoverJpg(frontImage) {
  return sharp(frontImage).flatten({ background: '#ffffff' })
    .resize({ width: 1600, height: Math.round(1600 * (PAGE_H / PAGE_W)), fit: 'cover', kernel: 'lanczos3' })
    .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

/**
 * @param {{title:string, author:string, language?:string, description?:string, cover?:Buffer|null, pages:Buffer[], cleanLines?:boolean}} o
 */
export async function buildFixedLayoutEpub({ title, author, language = 'en', description = '', cover = null, pages, cleanLines = true }) {
  if (!pages.length) throw new Error('No pages to put in the eBook');
  const uuid = randomUUID();
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const files = [];    // { href, mediaType, id, data, props }
  const spine = [];    // { idref, props }

  if (cover) {
    files.push({ id: 'cover-img', href: 'images/cover.jpg', mediaType: 'image/jpeg', data: await coverPageImage(cover), props: 'cover-image' });
    files.push({ id: 'cover', href: 'xhtml/cover.xhtml', mediaType: 'application/xhtml+xml', data: pageXhtml(title, 'cover.jpg', `Cover of ${title}`) });
    spine.push({ idref: 'cover' });
  }
  for (let i = 0; i < pages.length; i++) {
    const n = String(i + 1).padStart(3, '0');
    files.push({ id: `img-${n}`, href: `images/page-${n}.png`, mediaType: 'image/png', data: await pageImage(pages[i], cleanLines) });
    files.push({ id: `page-${n}`, href: `xhtml/page-${n}.xhtml`, mediaType: 'application/xhtml+xml', data: pageXhtml(`${title} - page ${i + 1}`, `page-${n}.png`, `Coloring page ${i + 1}`) });
    spine.push({ idref: `page-${n}` });
  }
  files.push({ id: 'css', href: 'css/fixed.css', mediaType: 'text/css', data: CSS });

  const firstPage = cover ? 'xhtml/cover.xhtml' : 'xhtml/page-001.xhtml';
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head><meta charset="UTF-8"/><title>${xmlEscape(title)}</title></head>
<body>
<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
${cover ? '<li><a href="xhtml/cover.xhtml">Cover</a></li>\n' : ''}<li><a href="xhtml/page-001.xhtml">Coloring pages</a></li>
</ol></nav>
<nav epub:type="landmarks" hidden="hidden"><ol>
${cover ? '<li><a epub:type="cover" href="xhtml/cover.xhtml">Cover</a></li>\n' : ''}<li><a epub:type="bodymatter" href="xhtml/page-001.xhtml">Start</a></li>
</ol></nav>
</body>
</html>
`;
  files.push({ id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', data: nav, props: 'nav' });

  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:uuid:${uuid}"/></head>
<docTitle><text>${xmlEscape(title)}</text></docTitle>
<navMap>
<navPoint id="np1" playOrder="1"><navLabel><text>${cover ? 'Cover' : 'Coloring pages'}</text></navLabel><content src="${firstPage}"/></navPoint>
${cover ? '<navPoint id="np2" playOrder="2"><navLabel><text>Coloring pages</text></navLabel><content src="xhtml/page-001.xhtml"/></navPoint>' : ''}
</navMap>
</ncx>
`;
  files.push({ id: 'ncx', href: 'toc.ncx', mediaType: 'application/x-dtbncx+xml', data: ncx });

  const manifest = files.map((f) => `    <item id="${f.id}" href="${f.href}" media-type="${f.mediaType}"${f.props ? ` properties="${f.props}"` : ''}/>`).join('\n');
  const spineXml = spine.map((s) => `    <itemref idref="${s.idref}"/>`).join('\n');
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${language}"
  prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${xmlEscape(title)}</dc:title>
    <dc:creator>${xmlEscape(author)}</dc:creator>
    <dc:publisher>${xmlEscape(author)}</dc:publisher>
    <dc:language>${language}</dc:language>
    ${description ? `<dc:description>${xmlEscape(description)}</dc:description>` : ''}
    <meta property="dcterms:modified">${modified}</meta>
    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:orientation">portrait</meta>
    <meta property="rendition:spread">none</meta>
    <meta name="fixed-layout" content="true"/>
    <meta name="original-resolution" content="${PAGE_W}x${PAGE_H}"/>
    <meta name="orientation-lock" content="portrait"/>
    <meta name="book-type" content="children"/>
    ${cover ? '<meta name="cover" content="cover-img"/>' : ''}
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine toc="ncx">
${spineXml}
  </spine>
</package>
`;

  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`;

  const bytes = zip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: container },
    { name: 'OEBPS/content.opf', data: opf },
    // Images are already compressed; storing them avoids wasted CPU.
    ...files.map((f) => ({ name: `OEBPS/${f.href}`, data: f.data, store: /^image\//.test(f.mediaType) })),
  ]);
  return { bytes, pages: pages.length, hasCover: Boolean(cover), sizeMB: +(bytes.length / 1048576).toFixed(2) };
}
