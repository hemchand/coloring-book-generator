// Coloring Book Generator — local web app (Node 18+).
// Generates KDP coloring-book interior pages and covers with OpenAI gpt-image-2,
// then builds the interior PDF and full-wrap cover PDF.
//
// Cost levers:
//   • Batch mode — pages go through the OpenAI Batch API at 50% off (results within 24h, usually much sooner).
//   • Economy page size (720x928, the smallest 8.5:11 size the API accepts) — ~25% fewer output tokens;
//     pages are upscaled to 300 DPI locally for free when the PDF is built.
//   • Short prompts (fewer input tokens), draft covers at "low" before paying for one "medium" final.
//   • Local line cleanup + automatic shading check, so fewer pages need a paid redo.

import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, readFileSync, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateImageCost, imageOutputTokens } from './lib/cost.js';
import { buildInteriorPdf, buildCoverPdf, checkLineArt, interiorPageCount, TRIMS } from './lib/pdf.js';
import { buildFixedLayoutEpub, buildKindleCoverJpg } from './lib/epub.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.OPENAI_API_KEY || '';
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gpt-image-2';
const TEXT_MODEL = process.env.TEXT_MODEL || 'gpt-5-mini';
const PAGE_QUALITY = process.env.PAGE_QUALITY || 'low';
const PAGE_SIZES = {
  economy: process.env.PAGE_SIZE_ECONOMY || '720x928',
  standard: process.env.PAGE_SIZE_STANDARD || '1088x1408',
};
const FALLBACK_PAGE_SIZE = PAGE_SIZES.standard;
const COVER_SIZE = process.env.COVER_SIZE || '1088x1408';
const BRAND_NAME = process.env.BRAND_NAME || 'Annvay Publishing';
const BATCH_POLL_MS = Number(process.env.BATCH_POLL_SECONDS || 60) * 1000;
const OUTPUT_DIR = path.join(ROOT, 'output');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OPENAI_BASE = 'https://api.openai.com/v1';

// ---------- helpers ----------

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageFile = (i) => `page-${String(i + 1).padStart(3, '0')}.png`;

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'book';
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function bookDir(id) {
  if (!/^[a-z0-9-]+$/.test(id || '')) throw new HttpError(400, 'Invalid book id');
  const dir = path.join(OUTPUT_DIR, id);
  if (!existsSync(dir)) throw new HttpError(404, 'Book not found');
  return dir;
}

async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

// Serialise book.json updates per book (pages finish in parallel).
const locks = new Map();
async function updateBook(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  let release;
  const next = new Promise((r) => { release = r; });
  locks.set(id, prev.then(() => next));
  await prev;
  try {
    const file = path.join(bookDir(id), 'book.json');
    const book = normalizeBook(await readJson(file));
    const result = await fn(book);
    await fs.writeFile(file, JSON.stringify(book, null, 2));
    return result;
  } finally { release(); }
}

function bookName(b) {
  return (b.name || b.cover?.title || b.theme || '').trim();
}

// Older books (created before batch/PDF support) get the new fields.
function normalizeBook(b) {
  b.pageSize ||= FALLBACK_PAGE_SIZE;
  b.generated ||= { pages: 0, covers: 0 };
  b.spend ||= { pages: 0, covers: 0, ideas: 0 };
  b.checks ||= {};
  b.batches ||= [];
  return b;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Body must be JSON'); }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function hasKey() { return Boolean(API_KEY) && !API_KEY.startsWith('sk-your'); }
function requireKey() {
  if (!hasKey()) throw new HttpError(400, 'OPENAI_API_KEY is not set. Copy .env.example to .env, add your key, and restart the server.');
}

// ---------- prompts (kept short: every word is billed as input tokens) ----------

const AUDIENCE_STYLE = {
  kids: 'cute, simple, very thick bold outlines, big open areas, minimal background, for ages 4-8',
  teens: 'moderate detail, clean medium outlines, some background',
  adults: 'intricate detail, fine solid outlines, decorative patterned background',
};

function pagePrompt({ theme, subject, audience, styleNotes }) {
  return `Coloring book page, black line art on pure white. Theme: ${theme}. Scene: ${subject}. ` +
    `Style: ${AUDIENCE_STYLE[audience] || AUDIENCE_STYLE.kids}. ` +
    (styleNotes ? `Book style (apply to every page): ${styleNotes}. ` : '') +
    'Closed outlines only; no color, gray, shading, hatching or solid black fills. ' +
    'Whole drawing inside a wide white margin. No text, border or watermark.';
}

function coverPrompt({ theme, title, subtitle, audience, notes }) {
  return [
    `Front cover of a printed ${audience === 'kids' ? "children's " : ''}coloring book, portrait, full color, vibrant, professional.`,
    `Theme: ${theme}.`,
    `Title text exactly: "${title}" — large, bold, legible, near the top.`,
    subtitle ? `Subtitle text exactly: "${subtitle}".` : 'No other text.',
    'Keep text and key details away from the edges; background art fills every edge.',
    'No barcode, author name, logo or price. No misspellings.',
    notes ? `Direction: ${notes}` : '',
  ].filter(Boolean).join(' ');
}

// ---------- OpenAI calls ----------

async function openaiRequest(endpoint, { method = 'POST', json, form, raw = false } = {}) {
  requireKey();
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await fetch(`${OPENAI_BASE}${endpoint}`, {
        method,
        headers: { Authorization: `Bearer ${API_KEY}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
        body: json ? JSON.stringify(json) : form,
      });
    } catch (e) {
      lastErr = new HttpError(502, `Could not reach OpenAI: ${e.message}`);
      await sleep(1500 * attempt);
      continue;
    }
    if (res.ok) return raw ? res : res.json();
    const body = await res.json().catch(() => ({}));
    const msg = body?.error?.message || `OpenAI returned HTTP ${res.status}`;
    lastErr = new HttpError(res.status === 401 ? 401 : res.status === 400 ? 400 : 502, msg);
    if (res.status === 429 || res.status >= 500) { await sleep(2000 * attempt); continue; }
    break;
  }
  throw lastErr;
}

function imageBody({ prompt, quality, size }) {
  return { model: IMAGE_MODEL, prompt, quality, size, n: 1, output_format: 'png' };
}

async function generateImage({ prompt, quality, size }) {
  let usedSize = size;
  let json;
  try {
    json = await openaiRequest('/images/generations', { json: imageBody({ prompt, quality, size }) });
  } catch (e) {
    // If the API rejects the economy size, fall back once to the standard size.
    if (e.status === 400 && /size/i.test(e.message) && size !== FALLBACK_PAGE_SIZE) {
      console.warn(`Size ${size} rejected (${e.message}); retrying at ${FALLBACK_PAGE_SIZE}`);
      usedSize = FALLBACK_PAGE_SIZE;
      json = await openaiRequest('/images/generations', { json: imageBody({ prompt, quality, size: usedSize }) });
    } else throw e;
  }
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new HttpError(502, 'OpenAI response contained no image');
  return { buffer: Buffer.from(b64, 'base64'), usage: json.usage || null, size: usedSize };
}

async function suggestSubjects({ theme, audience, count, styleNotes = '' }) {
  const json = await openaiRequest('/responses', {
    json: {
      model: TEXT_MODEL,
      input: `Coloring book about "${theme}" for ${audience}. List exactly ${count} distinct page subjects, ` +
        'each one short sentence describing one scene that works as black-and-white line art. Vary characters, settings and actions.' +
        (styleNotes
          ? ` Every page will be drawn with this book-wide style: "${styleNotes}". Choose scenes that suit it and respect it ` +
            '(e.g. if it asks for one big character per page, describe one main character; if it asks for minimal backgrounds, ' +
            "don't describe busy settings; if it names an art style, pick subjects that work in that style). " +
            "Describe only what is in each scene; don't repeat the style words in every line."
          : ''),
      text: {
        format: {
          type: 'json_schema', name: 'subjects', strict: true,
          schema: {
            type: 'object', additionalProperties: false, required: ['subjects'],
            properties: { subjects: { type: 'array', items: { type: 'string' } } },
          },
        },
      },
    },
  });
  const text = (json.output || []).flatMap((o) => o.content || [])
    .filter((c) => c.type === 'output_text').map((c) => c.text).join('');
  try { return JSON.parse(text).subjects.slice(0, count); }
  catch { throw new HttpError(502, 'Could not read subject list from the text model'); }
}

// ---------- Amazon listing (description + keywords) ----------

const LISTING_LIMITS = { description: 4000, keyword: 50, keywords: 7, title: 200 };

function responseText(json) {
  return (json.output || []).flatMap((o) => o.content || [])
    .filter((c) => c.type === 'output_text').map((c) => c.text).join('');
}

async function generateListing(book, { title, subtitle, notes }) {
  const sample = book.subjects.slice(0, 15).map((s) => `- ${s}`).join('\n');
  const json = await openaiRequest('/responses', {
    json: {
      model: TEXT_MODEL,
      input: [
        'Write the Amazon KDP listing for a paperback coloring book.',
        `Title: ${title}`, subtitle ? `Subtitle: ${subtitle}` : '',
        `Theme: ${book.theme}. Audience: ${book.audience === 'kids' ? 'children ages 4-8' : book.audience}.`,
        `Coloring pages: ${book.subjects.length}, printed single-sided (one picture per sheet), 8.5 x 11 in.`,
        `Some of the pages:\n${sample}`,
        notes ? `Seller notes: ${notes}` : '',
        '',
        'Rules:',
        `- description_html: 150-250 words, under ${LISTING_LIMITS.description} characters. Hook sentence first, then a short bulleted list of what is inside, then who it is for and gift occasions. Only use these HTML tags: <p>, <b>, <i>, <br>, <ul>, <li>.`,
        `- keywords: exactly ${LISTING_LIMITS.keywords} search phrases a buyer would type, each under ${LISTING_LIMITS.keyword} characters, lowercase, no commas or quotes, not repeating words already in the title, no trademarked names or characters, no "amazon", "kindle", "bestseller", "free", "new" or other promotional claims.`,
        '- categories: 3 suggested Amazon book category paths, e.g. "Children\'s Books > Activities, Crafts & Games > Activity Books > Coloring".',
        '- Do not claim awards, sales ranks or reviews. Do not mention AI.',
      ].filter(Boolean).join('\n'),
      text: {
        format: {
          type: 'json_schema', name: 'listing', strict: true,
          schema: {
            type: 'object', additionalProperties: false,
            required: ['description_html', 'keywords', 'categories'],
            properties: {
              description_html: { type: 'string' },
              keywords: { type: 'array', items: { type: 'string' } },
              categories: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  });
  let data;
  try { data = JSON.parse(responseText(json)); }
  catch { throw new HttpError(502, 'Could not read the listing from the text model'); }
  return {
    title, subtitle: subtitle || '',
    descriptionHtml: cleanDescription(data.description_html),
    keywords: cleanKeywords(data.keywords),
    categories: data.categories.slice(0, 3),
    generatedAt: new Date().toISOString(),
  };
}

// KDP descriptions accept only a few HTML tags; drop everything else (and any <script>/<style> content).
function cleanDescription(html) {
  return String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?!\/?(p|b|i|br|ul|li)\s*\/?>)[^>]*>/gi, '')
    .trim()
    .slice(0, LISTING_LIMITS.description);
}

function cleanKeywords(list) {
  return (list || []).map((k) => String(k).replace(/[",]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean).map((k) => k.slice(0, LISTING_LIMITS.keyword)).slice(0, LISTING_LIMITS.keywords);
}

async function suggestBackText(book) {
  const json = await openaiRequest('/responses', {
    json: {
      model: TEXT_MODEL,
      input: `Back-cover text for a printed coloring book. Theme: ${book.theme}. Audience: ${book.audience === 'kids' ? 'children ages 4-8' : book.audience}. ` +
        `${book.subjects.length} coloring pages. Title: ${book.cover?.title || bookName(book)}.\n` +
        'Write: headline (max 32 characters, e.g. "50 Animals Coloring Book"), subheadline (max 40 characters, e.g. "& Fun Facts for Kids"), ' +
        'tagline (max 60 characters, inviting, e.g. "Discover a Colorful World of Amazing Animals"). ' +
        'Plain words only, no emoji, no trademarked names, no claims like bestseller.',
      text: {
        format: {
          type: 'json_schema', name: 'back_cover', strict: true,
          schema: {
            type: 'object', additionalProperties: false, required: ['headline', 'subheadline', 'tagline'],
            properties: { headline: { type: 'string' }, subheadline: { type: 'string' }, tagline: { type: 'string' } },
          },
        },
      },
    },
  });
  try {
    const d = JSON.parse(responseText(json));
    return { headline: d.headline.slice(0, 60), subheadline: d.subheadline.slice(0, 80), tagline: d.tagline.slice(0, 90) };
  } catch { throw new HttpError(502, 'Could not read the back-cover text from the text model'); }
}

function listingText(l) {
  return [
    `TITLE\n${l.title}`, l.subtitle ? `SUBTITLE\n${l.subtitle}` : '',
    `DESCRIPTION (paste into KDP; HTML allowed)\n${l.descriptionHtml}`,
    `KEYWORDS (one per KDP box)\n${l.keywords.map((k, i) => `${i + 1}. ${k}`).join('\n')}`,
    `SUGGESTED CATEGORIES\n${l.categories.map((c) => `- ${c}`).join('\n')}`,
  ].filter(Boolean).join('\n\n') + '\n';
}

async function saveListing(id, listing) {
  await fs.writeFile(path.join(bookDir(id), 'listing.txt'), listingText(listing));
  await updateBook(id, (b) => { b.listing = listing; });
}

// ---------- page saving (shared by instant + batch) ----------

async function savePage(id, index, buffer, { cost, size }) {
  const dir = bookDir(id);
  await fs.writeFile(path.join(dir, 'pages', pageFile(index)), buffer);
  const check = await checkLineArt(buffer).catch(() => null);
  await updateBook(id, (b) => {
    b.generated.pages += 1;
    b.spend.pages = +(b.spend.pages + cost).toFixed(5);
    if (check) b.checks[index] = check;
    if (size !== b.pageSize) b.pageSizeNote = `Some pages generated at ${size}`;
  });
  return check;
}

// ---------- Batch API (50% off) ----------

function pendingIndices(book) {
  return new Set(book.batches.filter((x) => !x.done).flatMap((x) => x.indices));
}

async function submitBatch(id, indices) {
  const book = normalizeBook(await readJson(path.join(bookDir(id), 'book.json')));
  const lines = indices.map((i) => JSON.stringify({
    custom_id: `page-${i}`,
    method: 'POST',
    url: '/v1/images/generations',
    body: imageBody({
      prompt: pagePrompt({ theme: book.theme, subject: book.subjects[i], audience: book.audience, styleNotes: book.styleNotes }),
      quality: PAGE_QUALITY, size: book.pageSize,
    }),
  }));
  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', new Blob([lines.join('\n')], { type: 'application/jsonl' }), `${id}-pages.jsonl`);
  const file = await openaiRequest('/files', { form });
  const batch = await openaiRequest('/batches', {
    json: { input_file_id: file.id, endpoint: '/v1/images/generations', completion_window: '24h', metadata: { book: id } },
  });
  await updateBook(id, (b) => {
    b.batches.push({
      id: batch.id, indices, status: batch.status, createdAt: new Date().toISOString(),
      counts: batch.request_counts || null, done: false, size: b.pageSize,
    });
  });
  return batch;
}

async function importBatchOutput(id, fileId, size, book) {
  const res = await openaiRequest(`/files/${fileId}/content`, { method: 'GET', raw: true });
  const rl = readline.createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
  let saved = 0;
  const failures = {};
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const index = Number(String(row.custom_id).replace('page-', ''));
    const body = row.response?.body;
    const b64 = body?.data?.[0]?.b64_json;
    if (row.response?.status_code === 200 && b64) {
      const prompt = pagePrompt({ theme: book.theme, subject: book.subjects[index], audience: book.audience, styleNotes: book.styleNotes });
      const cost = estimateImageCost({ size, quality: PAGE_QUALITY, prompt, usage: body.usage, batch: true });
      await savePage(id, index, Buffer.from(b64, 'base64'), { cost, size });
      saved++;
    } else {
      failures[index] = body?.error?.message || row.error?.message || 'Generation failed';
    }
  }
  return { saved, failures };
}

async function importBatchErrors(fileId) {
  const failures = {};
  const res = await openaiRequest(`/files/${fileId}/content`, { method: 'GET', raw: true });
  const rl = readline.createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const index = Number(String(row.custom_id).replace('page-', ''));
    failures[index] = row.response?.body?.error?.message || row.error?.message || 'Generation failed';
  }
  return failures;
}

const refreshing = new Set();
async function refreshBatches(id) {
  if (refreshing.has(id)) return;
  refreshing.add(id);
  try {
    const book = normalizeBook(await readJson(path.join(bookDir(id), 'book.json')));
    for (const entry of book.batches.filter((x) => !x.done)) {
      const remote = await openaiRequest(`/batches/${entry.id}`, { method: 'GET' });
      let saved = 0;
      let failures = {};
      const finished = ['completed', 'failed', 'expired', 'cancelled'].includes(remote.status);
      if (finished) {
        if (remote.output_file_id) ({ saved, failures } = await importBatchOutput(id, remote.output_file_id, entry.size, book));
        if (remote.error_file_id) Object.assign(failures, await importBatchErrors(remote.error_file_id));
        if (remote.status === 'failed' && remote.errors?.data?.length) {
          for (const i of entry.indices) failures[i] ||= remote.errors.data[0].message;
        }
      }
      await updateBook(id, (b) => {
        const e = b.batches.find((x) => x.id === entry.id);
        e.status = remote.status;
        e.counts = remote.request_counts || e.counts;
        if (finished) {
          e.done = true;
          e.finishedAt = new Date().toISOString();
          e.saved = saved;
          e.failures = failures;
        }
      });
    }
  } finally { refreshing.delete(id); }
}

async function pollAllBatches() {
  if (!hasKey() || !existsSync(OUTPUT_DIR)) return;
  for (const id of await fs.readdir(OUTPUT_DIR)) {
    const file = path.join(OUTPUT_DIR, id, 'book.json');
    if (!existsSync(file)) continue;
    const book = normalizeBook(await readJson(file));
    if (book.batches.some((x) => !x.done)) {
      await refreshBatches(id).catch((e) => console.error(`Batch check for ${id} failed: ${e.message}`));
    }
  }
}

// ---------- book storage ----------

async function listBooks() {
  if (!existsSync(OUTPUT_DIR)) return [];
  const ids = (await fs.readdir(OUTPUT_DIR)).filter((n) => existsSync(path.join(OUTPUT_DIR, n, 'book.json')));
  const books = await Promise.all(ids.map(async (id) => {
    const b = await readJson(path.join(OUTPUT_DIR, id, 'book.json'));
    const pagesDir = path.join(OUTPUT_DIR, id, 'pages');
    const done = existsSync(pagesDir) ? (await fs.readdir(pagesDir)).filter((f) => /^page-\d+\.png$/.test(f)).length : 0;
    const spend = b.spend || {};
    return {
      id, name: bookName(b), theme: b.theme, audience: b.audience, createdAt: b.createdAt,
      pageCount: b.subjects.length, pagesDone: done,
      batchPending: (b.batches || []).some((x) => !x.done),
      coverSelected: Boolean(b.cover?.selected),
      interiorPdf: existsSync(path.join(OUTPUT_DIR, id, 'interior.pdf')),
      coverPdf: existsSync(path.join(OUTPUT_DIR, id, 'cover.pdf')),
      epub: existsSync(path.join(OUTPUT_DIR, id, 'kindle.epub')),
      listing: Boolean(b.listing),
      spend: +((spend.pages || 0) + (spend.covers || 0) + (spend.ideas || 0)).toFixed(4),
    };
  }));
  return books.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function loadBook(id) {
  const dir = bookDir(id);
  const book = normalizeBook(await readJson(path.join(dir, 'book.json')));
  const pageFiles = existsSync(path.join(dir, 'pages')) ? await fs.readdir(path.join(dir, 'pages')) : [];
  const coverFiles = existsSync(path.join(dir, 'cover'))
    ? (await fs.readdir(path.join(dir, 'cover'))).filter((f) => f.endsWith('.png')).sort() : [];
  const pending = pendingIndices(book);
  const lastFailures = Object.assign({}, ...book.batches.filter((x) => x.done).map((x) => x.failures || {}));
  book.pages = book.subjects.map((subject, i) => {
    const has = pageFiles.includes(pageFile(i));
    return {
      index: i, subject,
      url: has ? `/output/${id}/pages/${pageFile(i)}` : null,
      inBatch: pending.has(i),
      error: !has ? lastFailures[i] || null : null,
      check: has ? book.checks[i] || null : null,
    };
  });
  book.covers = coverFiles.map((f) => ({ file: f, url: `/output/${id}/cover/${f}` }));
  book.pdfs = {
    interior: existsSync(path.join(dir, 'interior.pdf')) ? `/output/${id}/interior.pdf` : null,
    cover: existsSync(path.join(dir, 'cover.pdf')) ? `/output/${id}/cover.pdf` : null,
    epub: existsSync(path.join(dir, 'kindle.epub')) ? `/output/${id}/kindle.epub` : null,
    kindleCover: existsSync(path.join(dir, 'kindle-cover.jpg')) ? `/output/${id}/kindle-cover.jpg` : null,
  };
  book.spend.total = +(book.spend.pages + book.spend.covers + book.spend.ideas).toFixed(4);
  book.name = bookName(book);
  return book;
}

// ---------- routes ----------

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  if (req.method === 'GET' && url.pathname === '/api/config') {
    const est = (size, quality, batch = false) =>
      estimateImageCost({ size, quality, prompt: 'x'.repeat(420), batch });
    return sendJson(res, 200, {
      hasKey: hasKey(), brandName: BRAND_NAME, imageModel: IMAGE_MODEL, textModel: TEXT_MODEL,
      pageQuality: PAGE_QUALITY, pageSizes: PAGE_SIZES, coverSize: COVER_SIZE, trims: Object.keys(TRIMS),
      estimates: {
        page: {
          economy: { instant: est(PAGE_SIZES.economy, PAGE_QUALITY), batch: est(PAGE_SIZES.economy, PAGE_QUALITY, true) },
          standard: { instant: est(PAGE_SIZES.standard, PAGE_QUALITY), batch: est(PAGE_SIZES.standard, PAGE_QUALITY, true) },
        },
        cover: { low: est(COVER_SIZE, 'low'), medium: est(COVER_SIZE, 'medium') },
      },
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/ideas') {
    const { theme, audience = 'kids', count = 50, styleNotes = '' } = await readBody(req);
    if (!theme?.trim()) throw new HttpError(400, 'Theme is required');
    const n = Math.min(Math.max(Number(count) || 50, 1), 120);
    const style = String(styleNotes).trim().slice(0, 600);
    return sendJson(res, 200, { subjects: await suggestSubjects({ theme: theme.trim(), audience, count: n, styleNotes: style }) });
  }

  if (req.method === 'GET' && url.pathname === '/api/books') {
    return sendJson(res, 200, { books: await listBooks() });
  }

  if (req.method === 'POST' && url.pathname === '/api/books') {
    const { name = '', theme, audience = 'kids', subjects, pageSize = 'economy', styleNotes = '' } = await readBody(req);
    if (!theme?.trim()) throw new HttpError(400, 'Theme is required');
    const bookTitle = String(name).trim().slice(0, 200) || theme.trim();
    const list = (subjects || []).map((s) => String(s).trim()).filter(Boolean);
    if (!list.length) throw new HttpError(400, 'Add at least one page subject');
    const id = `${slugify(bookTitle)}-${timestamp()}`;
    const dir = path.join(OUTPUT_DIR, id);
    await fs.mkdir(path.join(dir, 'pages'), { recursive: true });
    await fs.mkdir(path.join(dir, 'cover'), { recursive: true });
    await fs.writeFile(path.join(dir, 'book.json'), JSON.stringify(normalizeBook({
      id, name: bookTitle, theme: theme.trim(), audience, subjects: list, styleNotes: String(styleNotes).trim().slice(0, 600), createdAt: new Date().toISOString(),
      imageModel: IMAGE_MODEL, pageQuality: PAGE_QUALITY, pageSize: PAGE_SIZES[pageSize] || PAGE_SIZES.economy,
    }), null, 2));
    return sendJson(res, 200, await loadBook(id));
  }

  if (parts[1] === 'books' && parts[2]) {
    const id = parts[2];
    const dir = bookDir(id);

    if (req.method === 'GET' && parts.length === 3) return sendJson(res, 200, await loadBook(id));

    // Rename the book.
    if (req.method === 'POST' && parts[3] === 'meta') {
      const { name } = await readBody(req);
      const n = String(name || '').trim().slice(0, 200);
      if (!n) throw new HttpError(400, 'Book name cannot be empty');
      await updateBook(id, (b) => { b.name = n; });
      return sendJson(res, 200, await loadBook(id));
    }

    // Delete the book folder. Running batches are cancelled first so they stop billing.
    if (req.method === 'DELETE' && parts.length === 3) {
      const book = normalizeBook(await readJson(path.join(dir, 'book.json')));
      const warnings = [];
      for (const b of book.batches.filter((x) => !x.done)) {
        try { await openaiRequest(`/batches/${encodeURIComponent(b.id)}/cancel`, {}); }
        catch (e) { warnings.push(`Could not cancel batch ${b.id}: ${e.message}`); }
      }
      await fs.rm(dir, { recursive: true, force: true });
      locks.delete(id);
      return sendJson(res, 200, { deleted: id, warnings });
    }

    // Instant generation of one page (full price).
    if (req.method === 'POST' && parts[3] === 'pages') {
      const { index, subject } = await readBody(req);
      const book = normalizeBook(await readJson(path.join(dir, 'book.json')));
      const i = Number(index);
      if (!Number.isInteger(i) || i < 0 || i >= book.subjects.length) throw new HttpError(400, 'Bad page index');
      if (pendingIndices(book).has(i)) throw new HttpError(409, 'This page is waiting in a batch');
      const subj = subject?.trim() || book.subjects[i];
      if (subj !== book.subjects[i]) await updateBook(id, (b) => { b.subjects[i] = subj; });
      const prompt = pagePrompt({ theme: book.theme, subject: subj, audience: book.audience, styleNotes: book.styleNotes });
      const { buffer, usage, size } = await generateImage({ prompt, quality: PAGE_QUALITY, size: book.pageSize });
      const cost = estimateImageCost({ size, quality: PAGE_QUALITY, prompt, usage });
      const check = await savePage(id, i, buffer, { cost, size });
      return sendJson(res, 200, { index: i, url: `/output/${id}/pages/${pageFile(i)}?v=${Date.now()}`, cost, check });
    }

    // Batch generation (50% off) for a list of pages.
    if (req.method === 'POST' && parts[3] === 'batch') {
      const { indices, subjects } = await readBody(req);
      const book = normalizeBook(await readJson(path.join(dir, 'book.json')));
      if (subjects && typeof subjects === 'object') {
        await updateBook(id, (b) => {
          for (const [k, v] of Object.entries(subjects)) if (v?.trim() && b.subjects[k] !== undefined) b.subjects[k] = v.trim();
        });
      }
      const pending = pendingIndices(book);
      const list = [...new Set((indices || []).map(Number))]
        .filter((i) => Number.isInteger(i) && i >= 0 && i < book.subjects.length && !pending.has(i));
      if (!list.length) throw new HttpError(400, 'No pages to submit (they may already be waiting in a batch)');
      const batch = await submitBatch(id, list);
      return sendJson(res, 200, { batchId: batch.id, count: list.length });
    }

    if (req.method === 'POST' && parts[3] === 'refresh') {
      await refreshBatches(id);
      return sendJson(res, 200, await loadBook(id));
    }

    if (req.method === 'POST' && parts[3] === 'batches' && parts[5] === 'cancel') {
      await openaiRequest(`/batches/${encodeURIComponent(parts[4])}/cancel`, {});
      await refreshBatches(id);
      return sendJson(res, 200, await loadBook(id));
    }

    // Cover: draft (low) or final (medium).
    if (req.method === 'POST' && parts[3] === 'cover') {
      const { title, subtitle, notes, quality = 'low' } = await readBody(req);
      if (!title?.trim()) throw new HttpError(400, 'Cover title is required');
      const q = quality === 'medium' ? 'medium' : 'low';
      const book = normalizeBook(await readJson(path.join(dir, 'book.json')));
      const prompt = coverPrompt({ theme: book.theme, title: title.trim(), subtitle: subtitle?.trim(), audience: book.audience, notes: notes?.trim() });
      const { buffer, usage } = await generateImage({ prompt, quality: q, size: COVER_SIZE });
      const cost = estimateImageCost({ size: COVER_SIZE, quality: q, prompt, usage });
      const file = await updateBook(id, async (b) => {
        const existing = (await fs.readdir(path.join(dir, 'cover'))).filter((f) => f.endsWith('.png')).length;
        const name = `cover-${String(existing + 1).padStart(2, '0')}-${q === 'medium' ? 'final' : 'draft'}.png`;
        await fs.writeFile(path.join(dir, 'cover', name), buffer);
        b.cover = { ...(b.cover || {}), title: title.trim(), subtitle: subtitle?.trim() || '', notes: notes?.trim() || '' };
        b.generated.covers += 1;
        b.spend.covers = +(b.spend.covers + cost).toFixed(5);
        return name;
      });
      return sendJson(res, 200, { file, url: `/output/${id}/cover/${file}`, cost });
    }

    if (req.method === 'POST' && parts[3] === 'select-cover') {
      const { file } = await readBody(req);
      if (!/^[\w.-]+\.png$/.test(file || '') || !existsSync(path.join(dir, 'cover', file))) throw new HttpError(400, 'Unknown cover file');
      await updateBook(id, (b) => { b.cover = { ...(b.cover || {}), selected: file }; });
      return sendJson(res, 200, await loadBook(id));
    }

    // Book-wide style notes (used in every page prompt from now on).
    if (req.method === 'POST' && parts[3] === 'style') {
      const { styleNotes = '' } = await readBody(req);
      await updateBook(id, (b) => { b.styleNotes = String(styleNotes).trim().slice(0, 600); });
      return sendJson(res, 200, await loadBook(id));
    }

    // Back cover text: AI suggestion or saved edits.
    if (req.method === 'POST' && parts[3] === 'back-cover') {
      const body = await readBody(req);
      const book = normalizeBook(await readJson(path.join(dir, 'book.json')));
      let back;
      if (parts[4] === 'suggest') {
        back = { ...(book.backCover || {}), ...(await suggestBackText(book)) };
      } else {
        back = {
          ...(book.backCover || {}),
          headline: String(body.headline || '').trim().slice(0, 60),
          subheadline: String(body.subheadline || '').trim().slice(0, 80),
          tagline: String(body.tagline || '').trim().slice(0, 90),
          brand: String(body.brand ?? BRAND_NAME).trim().slice(0, 60),
          pages: String(body.pages || '').replace(/[^0-9, ]/g, '').trim(),
        };
      }
      back.brand ??= BRAND_NAME;
      await updateBook(id, (b) => { b.backCover = back; });
      return sendJson(res, 200, { backCover: back });
    }

    // Amazon listing: generate with the text model, or save the user's edits.
    if (req.method === 'POST' && parts[3] === 'listing') {
      const body = await readBody(req);
      const book = normalizeBook(await readJson(path.join(dir, 'book.json')));
      const title = (body.title || book.cover?.title || bookName(book)).trim();
      if (!title) throw new HttpError(400, 'Enter the book title first');
      let listing;
      if (parts[4] === 'save') {
        listing = {
          ...(book.listing || {}),
          title, subtitle: (body.subtitle || '').trim(),
          descriptionHtml: cleanDescription(body.descriptionHtml),
          keywords: cleanKeywords(body.keywords),
          categories: (body.categories || []).map((c) => String(c).trim()).filter(Boolean).slice(0, 3),
          editedAt: new Date().toISOString(),
        };
      } else {
        listing = await generateListing(book, { title, subtitle: body.subtitle?.trim(), notes: body.notes?.trim() });
      }
      await saveListing(id, listing);
      return sendJson(res, 200, { listing, file: `/output/${id}/listing.txt` });
    }

    // Kindle eBook: fixed-layout EPUB 3 (cover page + one page per picture) and the separate eBook cover JPEG.
    if (req.method === 'POST' && parts[3] === 'epub') {
      const { cleanLines = true } = await readBody(req);
      const book = await loadBook(id);
      const ready = book.pages.filter((p) => p.url);
      if (!ready.length) throw new HttpError(400, 'No pages generated yet');
      const pages = await Promise.all(ready.map((p) => fs.readFile(path.join(dir, 'pages', pageFile(p.index)))));
      const selected = book.cover?.selected;
      const cover = selected && existsSync(path.join(dir, 'cover', selected)) ? await fs.readFile(path.join(dir, 'cover', selected)) : null;
      const title = (book.listing?.title || book.cover?.title || book.name).trim();
      const description = String(book.listing?.descriptionHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const author = (book.backCover?.brand || BRAND_NAME).trim();
      const epub = await buildFixedLayoutEpub({ title, author, description, cover, pages, cleanLines });
      await fs.writeFile(path.join(dir, 'kindle.epub'), epub.bytes);
      const result = {
        epub: { url: `/output/${id}/kindle.epub?v=${Date.now()}`, pages: epub.pages, sizeMB: epub.sizeMB, hasCover: epub.hasCover },
        missingPages: book.pages.length - ready.length,
        warnings: [],
      };
      if (cover) {
        await fs.writeFile(path.join(dir, 'kindle-cover.jpg'), await buildKindleCoverJpg(cover));
        result.kindleCover = { url: `/output/${id}/kindle-cover.jpg?v=${Date.now()}` };
      } else {
        result.warnings.push('No cover selected, so the eBook has no cover page and no kindle-cover.jpg. Click "Use for PDF" under a cover and build again.');
      }
      return sendJson(res, 200, result);
    }

    // Build interior.pdf and (if a cover is chosen) cover.pdf.
    if (req.method === 'POST' && parts[3] === 'pdf') {
      const { trim = '8.5x11', blankBacks = true, cleanLines = true, paper = 'white' } = await readBody(req);
      const book = await loadBook(id);
      const ready = book.pages.filter((p) => p.url);
      if (!ready.length) throw new HttpError(400, 'No pages generated yet');
      const images = await Promise.all(ready.map((p) => fs.readFile(path.join(dir, 'pages', pageFile(p.index)))));
      const interior = await buildInteriorPdf(images, { trim, blankBacks, cleanLines });
      await fs.writeFile(path.join(dir, 'interior.pdf'), interior.bytes);
      const result = {
        interior: { url: `/output/${id}/interior.pdf?v=${Date.now()}`, pages: interior.pageCount, images: ready.length },
        missingPages: book.pages.length - ready.length,
        warnings: [],
      };
      if (interior.pageCount < 24) result.warnings.push(`KDP paperbacks need at least 24 pages; this interior has ${interior.pageCount}.`);
      const selected = book.cover?.selected;
      if (selected && existsSync(path.join(dir, 'cover', selected))) {
        const back = book.backCover?.headline ? book.backCover : null;
        let backImages = [];
        if (back) {
          const wanted = String(back.pages || '').split(/[ ,]+/).map(Number).filter((n) => n >= 1)
            .map((n) => n - 1).filter((i) => book.pages[i]?.url);
          const auto = ready.filter((p) => !p.check?.issues?.length).map((p) => p.index);
          const picks = [...new Set([...wanted, ...auto, ...ready.map((p) => p.index)])].slice(0, 4);
          backImages = await Promise.all(picks.map((i) => fs.readFile(path.join(dir, 'pages', pageFile(i)))));
        }
        const cover = await buildCoverPdf(await fs.readFile(path.join(dir, 'cover', selected)), {
          trim, pageCount: interior.pageCount, paper, title: book.cover?.title,
          back: back ? { ...back, images: backImages } : null,
        });
        await fs.writeFile(path.join(dir, 'cover.pdf'), cover.bytes);
        result.cover = { url: `/output/${id}/cover.pdf?v=${Date.now()}`, spineIn: cover.spine, widthIn: cover.widthIn, heightIn: cover.heightIn, spineText: cover.spineText };
      } else {
        result.warnings.push('No cover selected — click "Use for PDF" under a cover, then build again to get cover.pdf.');
      }
      return sendJson(res, 200, result);
    }
  }

  throw new HttpError(404, 'Not found');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json', '.pdf': 'application/pdf', '.epub': 'application/epub+zip', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(res, baseDir, relPath) {
  const file = path.normalize(path.join(baseDir, relPath));
  if (!file.startsWith(baseDir) || !existsSync(file) || (await fs.stat(file)).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/output/')) return await serveStatic(res, OUTPUT_DIR, decodeURIComponent(url.pathname.slice('/output/'.length)));
    return await serveStatic(res, PUBLIC_DIR, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    sendJson(res, status, { error: e.message || 'Server error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Coloring Book Generator running at http://localhost:${PORT}`);
  console.log(`Pages: ${IMAGE_MODEL} ${PAGE_QUALITY} (economy ${PAGE_SIZES.economy} ≈ ${imageOutputTokens(PAGE_SIZES.economy, PAGE_QUALITY)} output tokens)`);
  if (!hasKey()) console.log('WARNING: OPENAI_API_KEY is not set — copy .env.example to .env and add your key.');
  setInterval(() => pollAllBatches().catch((e) => console.error(e.message)), BATCH_POLL_MS).unref();
  pollAllBatches().catch((e) => console.error(e.message));
});

export { pagePrompt, coverPrompt };
