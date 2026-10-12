const $ = (id) => document.getElementById(id);
const money = (n) => `$${(n || 0).toFixed(n < 0.1 ? 3 : 2)}`;
let config = null;
let book = null;
let stopRequested = false;
let running = false;
let pollTimer = null;

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

const mode = () => document.querySelector('input[name="mode"]:checked').value;
const sizeKey = () => (book && book.pageSize === config.pageSizes.standard ? 'standard' : 'economy');

// ---------- rendering ----------

function updateStats() {
  if (!book) return;
  const pages = book.pages;
  $('statDone').textContent = pages.filter((p) => p.url).length;
  $('statTotal').textContent = pages.length;
  $('statBatch').textContent = pages.filter((p) => p.inBatch).length;
  $('statFlag').textContent = pages.filter((p) => p.check?.issues?.length).length;
  $('statFailed').textContent = pages.filter((p) => !p.url && p.error).length;
  $('statCost').textContent = money(book.spend?.total || 0);
  const est = config.estimates.page[sizeKey()];
  const missing = pages.filter((p) => !p.url && !p.inBatch).length;
  $('batchEst').textContent = `≈ ${money(est.batch)}/page${missing ? ` · ${money(est.batch * missing)} for ${missing} missing` : ''}`;
  $('instantEst').textContent = `≈ ${money(est.instant)}/page${missing ? ` · ${money(est.instant * missing)} for ${missing} missing` : ''}`;
}

function renderBatches() {
  const wrap = $('batches');
  wrap.innerHTML = '';
  for (const b of book.batches.slice().reverse().slice(0, 5)) {
    const div = document.createElement('div');
    const c = b.counts ? ` · ${b.counts.completed ?? 0}/${b.counts.total ?? b.indices.length} done${b.counts.failed ? `, ${b.counts.failed} failed` : ''}` : '';
    div.innerHTML = `<span>Batch of ${b.indices.length} pages — <b>${b.status}</b>${c} · sent ${new Date(b.createdAt).toLocaleString()}</span>`;
    if (!b.done) {
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.onclick = async () => {
        if (!confirm('Cancel this batch? Pages already finished are still saved.')) return;
        try { book = await api(`/api/books/${book.id}/batches/${b.id}/cancel`, {}); renderBook(); } catch (e) { alert(e.message); }
      };
      div.appendChild(cancel);
    }
    wrap.appendChild(div);
  }
  const pending = book.batches.some((b) => !b.done);
  clearInterval(pollTimer);
  if (pending) pollTimer = setInterval(refreshBook, 30000);
}

function renderBook() {
  for (const id of BOOK_SECTIONS) $(id).classList.remove('hidden');
  $('bookNameEdit').value = book.name || '';
  $('bookMeta').textContent = `Theme: ${book.theme} · ${AUDIENCE_LABEL[book.audience] || book.audience} · ${book.subjects.length} pages · ${book.pageSize} · created ${new Date(book.createdAt).toLocaleDateString()}${book.styleNotes ? ` · style: ${book.styleNotes}` : ''}`;
  document.title = `${book.name} · Coloring Book Generator`;
  $('bookIdLabel').textContent = `· ${book.theme} · ${book.pageSize} · saved in output/${book.id}/`;
  $('title').value = book.name || '';
  if (book.cover) {
    $('title').value = book.cover.title || book.name || '';
    $('subtitle').value = book.cover.subtitle || '';
    $('coverNotes').value = book.cover.notes || '';
  }
  const grid = $('grid');
  grid.innerHTML = '';
  for (const page of book.pages) grid.appendChild(pageCard(page));
  renderCovers();
  renderBatches();
  renderPdfLinks();
  renderListing();
  renderBack();
  $('bookStyle').value = book.styleNotes || '';
  updateStats();
}

function pageCard(page) {
  const card = document.createElement('div');
  card.className = 'card' + (page.check?.issues?.length ? ' flag' : '');
  card.id = `page-${page.index}`;
  card.innerHTML = `
    <div class="thumb"></div>
    <div class="body">
      <span class="num">Page ${page.index + 1}<label><input type="checkbox" class="pick"> redo</label></span>
      <textarea></textarea>
      <button>Redo now</button>
    </div>`;
  card.querySelector('textarea').value = page.subject;
  card.querySelector('button').onclick = () => generateInstant(page.index, true);
  card.querySelector('button').disabled = page.inBatch;
  paintThumb(card, page);
  return card;
}

function paintThumb(card, page, override) {
  const thumb = card.querySelector('.thumb');
  thumb.className = 'thumb';
  thumb.innerHTML = '';
  const state = override || {};
  if (state.text) { thumb.textContent = state.text; return; }
  if (page.url) {
    const img = document.createElement('img');
    img.src = page.url; img.alt = `Page ${page.index + 1}`;
    img.onclick = () => openViewer(page.url);
    thumb.appendChild(img);
    if (page.check?.issues?.length) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = `⚠ ${page.check.issues.join(', ')}`;
      thumb.appendChild(b);
    }
  } else if (page.inBatch) {
    thumb.textContent = 'Waiting in batch…';
  } else if (page.error) {
    thumb.classList.add('err');
    thumb.textContent = `Failed: ${page.error}`;
  } else {
    thumb.textContent = 'Not generated yet';
  }
}

function renderCovers() {
  const wrap = $('covers');
  wrap.innerHTML = '';
  for (const c of book.covers || []) {
    const div = document.createElement('div');
    const selected = book.cover?.selected === c.file;
    div.className = 'cover' + (selected ? ' selected' : '');
    div.innerHTML = `<img alt="Cover option"><span class="hint"><span>${c.file.includes('final') ? 'Final (medium)' : c.file.includes('draft') ? 'Draft (low)' : 'Cover'}</span></span>`;
    div.querySelector('img').src = c.url;
    div.querySelector('img').onclick = () => openViewer(c.url);
    const btn = document.createElement('button');
    btn.textContent = selected ? '✓ Used for PDF' : 'Use for PDF';
    btn.disabled = selected;
    btn.onclick = async () => {
      try { book = await api(`/api/books/${book.id}/select-cover`, { file: c.file }); renderCovers(); } catch (e) { alert(e.message); }
    };
    div.querySelector('.hint').appendChild(btn);
    wrap.appendChild(div);
  }
}

function renderPdfLinks(result) {
  const out = $('pdfResult');
  out.innerHTML = '';
  const add = (html, cls) => { const d = document.createElement('div'); d.innerHTML = html; if (cls) d.className = cls; out.appendChild(d); };
  const interior = result?.interior?.url || book.pdfs?.interior;
  const cover = result?.cover?.url || book.pdfs?.cover;
  if (interior) add(`<a class="button" href="${interior}" target="_blank">Open interior.pdf</a> ${result?.interior ? `<span class="hint">${result.interior.pages} pages from ${result.interior.images} pictures</span>` : ''}`);
  if (cover) add(`<a class="button" href="${cover}" target="_blank">Open cover.pdf</a> ${result?.cover ? `<span class="hint">${result.cover.widthIn}" × ${result.cover.heightIn}", spine ${result.cover.spineIn}"${result.cover.spineText ? ' with title' : ' (too thin for spine text)'}</span>` : ''}`);
  if (result?.missingPages) add(`${result.missingPages} page(s) aren't generated yet and were left out.`, 'warn');
  for (const w of result?.warnings || []) add(w, 'warn');
  if (interior || cover) add(`Both files are saved in <code>output/${book.id}/</code>.`, 'hint');
}

function openViewer(url) { $('viewerImg').src = url; $('viewer').showModal(); }
$('viewer').onclick = () => $('viewer').close();

async function refreshBook() {
  if (!book || running) return;
  try { book = await api(`/api/books/${book.id}/refresh`, {}); renderBook(); }
  catch (e) { console.warn(e.message); }
}

// ---------- generation ----------

async function generateInstant(index, single = false) {
  const card = $(`page-${index}`);
  const btn = card.querySelector('button');
  const subject = card.querySelector('textarea').value.trim();
  btn.disabled = true;
  paintThumb(card, book.pages[index], { text: 'Generating…' });
  try {
    const r = await api(`/api/books/${book.id}/pages`, { index, subject });
    Object.assign(book.pages[index], { url: r.url, subject, error: null, check: r.check });
    book.spend.total = (book.spend.total || 0) + r.cost;
  } catch (e) {
    book.pages[index].error = e.message;
    if (single) alert(e.message);
  } finally {
    btn.disabled = false;
    const fresh = pageCard(book.pages[index]);
    card.replaceWith(fresh);
    updateStats();
  }
}

async function runInstant(indices) {
  running = true; stopRequested = false;
  $('genMissingBtn').disabled = true; $('genSelectedBtn').disabled = true; $('stopBtn').disabled = false;
  const queue = indices.slice();
  queue.forEach((i) => paintThumb($(`page-${i}`), book.pages[i], { text: 'Queued' }));
  const workers = Math.min(Math.max(Number($('concurrency').value) || 3, 1), 8);
  const next = async () => { while (queue.length && !stopRequested) await generateInstant(queue.shift()); };
  await Promise.all(Array.from({ length: workers }, next));
  queue.forEach((i) => paintThumb($(`page-${i}`), book.pages[i]));
  running = false;
  $('genMissingBtn').disabled = false; $('genSelectedBtn').disabled = false; $('stopBtn').disabled = true;
}

async function runBatch(indices) {
  const subjects = {};
  for (const i of indices) subjects[i] = $(`page-${i}`).querySelector('textarea').value;
  const btns = [$('genMissingBtn'), $('genSelectedBtn')];
  btns.forEach((b) => { b.disabled = true; });
  try {
    const r = await api(`/api/books/${book.id}/batch`, { indices, subjects });
    book = await api(`/api/books/${book.id}`);
    renderBook();
    alert(`Sent ${r.count} pages to the batch (50% off). They'll appear here as soon as OpenAI finishes — usually well under 24 hours. Keep the server running, or reopen the book later.`);
  } catch (e) { alert(e.message); }
  finally { btns.forEach((b) => { b.disabled = false; }); }
}

function start(indices) {
  if (!indices.length) return alert('Nothing to generate.');
  return mode() === 'batch' ? runBatch(indices) : runInstant(indices);
}

$('genMissingBtn').onclick = () => start(book.pages.filter((p) => !p.url && !p.inBatch).map((p) => p.index));
$('genSelectedBtn').onclick = () => {
  const picked = [...document.querySelectorAll('.card .pick:checked')].map((c) => Number(c.closest('.card').id.replace('page-', '')));
  start(picked.filter((i) => !book.pages[i].inBatch));
};
$('stopBtn').onclick = () => { stopRequested = true; $('stopBtn').disabled = true; };
$('refreshBtn').onclick = refreshBook;

// ---------- covers ----------

$('coverBtn').onclick = async () => {
  const title = $('title').value.trim();
  if (!title) return alert('Enter the cover title first.');
  const n = Math.min(Math.max(Number($('coverCount').value) || 1, 1), 4);
  const quality = $('coverQuality').value;
  const btn = $('coverBtn');
  btn.disabled = true;
  btn.textContent = `Generating ${n}…`;
  const body = { title, subtitle: $('subtitle').value, notes: $('coverNotes').value, quality };
  const results = await Promise.allSettled(Array.from({ length: n }, () => api(`/api/books/${book.id}/cover`, body)));
  const errors = results.filter((r) => r.status === 'rejected');
  book = await api(`/api/books/${book.id}`);
  renderBook();
  btn.disabled = false; btn.textContent = 'Generate cover';
  if (errors.length) alert(`${errors.length} cover(s) failed: ${errors[0].reason.message}`);
};

// ---------- PDFs ----------

$('pdfBtn').onclick = async () => {
  const btn = $('pdfBtn');
  btn.disabled = true; btn.textContent = 'Building PDFs…';
  try {
    const r = await api(`/api/books/${book.id}/pdf`, {
      trim: $('trim').value, paper: $('paper').value,
      blankBacks: $('blankBacks').checked, cleanLines: $('cleanLines').checked,
    });
    renderPdfLinks(r);
  } catch (e) { alert(e.message); }
  finally { btn.disabled = false; btn.textContent = 'Build interior.pdf + cover.pdf'; }
};

// ---------- Amazon listing ----------

const KW_MAX = 50;
const DESC_MAX = 4000;

function counter(el, len, max) {
  el.textContent = `${len}/${max}`;
  el.classList.toggle('over', len > max);
}

function updateDescPreview() {
  const html = $('lDesc').value;
  counter($('descCount'), html.length, DESC_MAX);
  // Show only the tags KDP allows; everything else is displayed as text.
  const safe = html.replace(/</g, '&lt;').replace(/&lt;(\/?)(p|b|i|br|ul|li)\s*\/?>/gi, '<$1$2>');
  $('lPreview').innerHTML = safe;
}

function renderKeywordInputs(list) {
  const wrap = $('lKeywords');
  wrap.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const div = document.createElement('div');
    div.innerHTML = `<span class="count">${i + 1}.</span><input maxlength="80"><span class="count"></span>`;
    const input = div.querySelector('input');
    const count = div.querySelectorAll('.count')[1];
    input.value = list[i] || '';
    const upd = () => counter(count, input.value.length, KW_MAX);
    input.oninput = upd; upd();
    wrap.appendChild(div);
  }
}

function renderListing() {
  const l = book.listing;
  $('lTitle').value = l?.title || book.cover?.title || book.name || '';
  $('lSubtitle').value = l?.subtitle ?? book.cover?.subtitle ?? '';
  if (!l) { $('listingBody').classList.add('hidden'); return; }
  $('listingBody').classList.remove('hidden');
  $('lDesc').value = l.descriptionHtml || '';
  updateDescPreview();
  renderKeywordInputs(l.keywords || []);
  $('lCats').value = (l.categories || []).join('\n');
  $('listingFile').href = `/output/${book.id}/listing.txt?v=${Date.now()}`;
  $('listingHint').textContent = l.editedAt ? `Saved ${new Date(l.editedAt).toLocaleString()}` : `Generated ${new Date(l.generatedAt).toLocaleString()}`;
}

const currentKeywords = () => [...$('lKeywords').querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);

$('lDesc').oninput = updateDescPreview;

$('listingBtn').onclick = async () => {
  const title = $('lTitle').value.trim();
  if (!title) return alert('Enter the book title first.');
  if (book.listing && !confirm('Replace the current description and keywords with a new version?')) return;
  const btn = $('listingBtn');
  btn.disabled = true; btn.textContent = 'Writing listing…';
  try {
    const r = await api(`/api/books/${book.id}/listing`, { title, subtitle: $('lSubtitle').value, notes: $('lNotes').value });
    book.listing = r.listing;
    renderListing();
  } catch (e) { alert(e.message); }
  finally { btn.disabled = false; btn.textContent = 'Generate description & keywords'; }
};

$('listingSaveBtn').onclick = async () => {
  const long = currentKeywords().filter((k) => k.length > KW_MAX);
  if (long.length) return alert(`Shorten these keywords to ${KW_MAX} characters: ${long.join(', ')}`);
  if ($('lDesc').value.length > DESC_MAX) return alert(`The description is over ${DESC_MAX} characters.`);
  try {
    const r = await api(`/api/books/${book.id}/listing/save`, {
      title: $('lTitle').value, subtitle: $('lSubtitle').value, descriptionHtml: $('lDesc').value,
      keywords: currentKeywords(), categories: $('lCats').value.split('\n'),
    });
    book.listing = r.listing;
    renderListing();
  } catch (e) { alert(e.message); }
};

async function copy(text, btn) {
  await navigator.clipboard.writeText(text);
  const old = btn.textContent; btn.textContent = 'Copied ✓';
  setTimeout(() => { btn.textContent = old; }, 1500);
}
$('copyDescBtn').onclick = (e) => copy($('lDesc').value, e.target);
$('copyKwBtn').onclick = (e) => copy(currentKeywords().join('\n'), e.target);

// ---------- style + back cover ----------

$('saveStyleBtn').onclick = async (e) => {
  try {
    book = await api(`/api/books/${book.id}/style`, { styleNotes: $('bookStyle').value });
    $('styleNotes').value = book.styleNotes || '';
    e.target.textContent = 'Saved ✓'; setTimeout(() => { e.target.textContent = 'Save style'; }, 1500);
  } catch (err) { alert(err.message); }
};

function renderBack() {
  const b = book.backCover || {};
  $('bHeadline').value = b.headline || '';
  $('bSub').value = b.subheadline || '';
  $('bTagline').value = b.tagline || '';
  $('bBrand').value = b.brand ?? config.brandName ?? '';
  $('bPages').value = b.pages || '';
}

$('backSuggestBtn').onclick = async (e) => {
  const btn = e.target; btn.disabled = true; btn.textContent = 'Writing…';
  try {
    const r = await api(`/api/books/${book.id}/back-cover/suggest`, {});
    book.backCover = r.backCover;
    const keepBrand = $('bBrand').value, keepPages = $('bPages').value;
    renderBack();
    $('bBrand').value = keepBrand; $('bPages').value = keepPages;
    $('backHint').textContent = 'Suggested — edit if you like, then Save back cover.';
  } catch (err) { alert(err.message); }
  finally { btn.disabled = false; btn.textContent = 'Suggest text with AI'; }
};

$('backSaveBtn').onclick = async () => {
  if (!$('bHeadline').value.trim()) return alert('Add a headline (the back cover is only drawn when it has one).');
  try {
    const r = await api(`/api/books/${book.id}/back-cover`, {
      headline: $('bHeadline').value, subheadline: $('bSub').value, tagline: $('bTagline').value,
      brand: $('bBrand').value, pages: $('bPages').value,
    });
    book.backCover = r.backCover;
    $('backHint').textContent = 'Saved — rebuild the PDFs (step 4) to update cover.pdf.';
  } catch (err) { alert(err.message); }
};

// ---------- setup ----------

$('ideasBtn').onclick = async () => {
  const theme = $('theme').value.trim();
  if (!theme) return alert('Enter a theme first.');
  const btn = $('ideasBtn');
  btn.disabled = true; $('setupHint').textContent = 'Asking the text model for page ideas…';
  try {
    const r = await api('/api/ideas', { theme, audience: $('audience').value, count: Number($('count').value) || 50, styleNotes: $('styleNotes').value });
    $('subjects').value = r.subjects.join('\n');
    $('setupHint').textContent = `${r.subjects.length} subjects suggested — edit freely before creating the book.`;
  } catch (e) { $('setupHint').textContent = ''; alert(e.message); }
  finally { btn.disabled = false; }
};

$('createBtn').onclick = async () => {
  const theme = $('theme').value.trim();
  if (!theme) return alert('Enter a theme first.');
  let subjects = $('subjects').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const count = Number($('count').value) || 50;
  if (!subjects.length) {
    if (!confirm(`No subjects listed. Create ${count} pages from the theme alone? ("Suggest subjects" gives more variety.)`)) return;
    subjects = Array.from({ length: count }, (_, i) => `${theme}, scene ${i + 1}, unlike the others`);
  }
  try {
    const created = await api('/api/books', { name: $('bookName').value, theme, audience: $('audience').value, subjects, pageSize: $('pageSize').value, styleNotes: $('styleNotes').value });
    location.hash = `#/book/${created.id}`;
  } catch (e) { alert(e.message); }
};

// ---------- books list, routing, delete ----------

const BOOK_SECTIONS = ['bookHeader', 'pagesSection', 'coverSection', 'backSection', 'pdfSection', 'listingSection'];
const ALL_VIEWS = ['booksView', 'setup', ...BOOK_SECTIONS];
const AUDIENCE_LABEL = { kids: 'Kids 4–8', teens: 'Teens', adults: 'Adults' };
let allBooks = [];
let currentHash = location.hash;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function showOnly(ids) {
  for (const id of ALL_VIEWS) $(id).classList.toggle('hidden', !ids.includes(id));
  $('navBooks').classList.toggle('active', ids.includes('booksView'));
  window.scrollTo(0, 0);
}

function renderBooksTable() {
  const q = $('bookSearch').value.trim().toLowerCase();
  const rows = allBooks.filter((b) => !q || `${b.name} ${b.theme}`.toLowerCase().includes(q));
  $('booksEmpty').classList.toggle('hidden', allBooks.length > 0);
  $('booksTable').classList.toggle('hidden', !allBooks.length);
  $('booksTable').querySelector('tbody').innerHTML = rows.map((b) => {
    const pages = b.pagesDone >= b.pageCount ? `<span class="pill ok">${b.pagesDone}/${b.pageCount}</span>`
      : `<span class="pill">${b.pagesDone}/${b.pageCount}</span>`;
    return `<tr>
      <td><a class="title" href="#/book/${esc(b.id)}">${esc(b.name)}</a><div class="sub">${esc(b.theme)}</div></td>
      <td>${esc(AUDIENCE_LABEL[b.audience] || b.audience || '')}</td>
      <td class="num">${pages}${b.batchPending ? '<span class="pill wait">batch running</span>' : ''}</td>
      <td>${b.coverSelected ? '<span class="pill ok">chosen</span>' : '<span class="pill">—</span>'}</td>
      <td>${b.interiorPdf ? '<span class="pill ok">interior</span>' : ''}${b.coverPdf ? '<span class="pill ok">cover</span>' : ''}${!b.interiorPdf && !b.coverPdf ? '<span class="pill">—</span>' : ''}</td>
      <td>${b.listing ? '<span class="pill ok">ready</span>' : '<span class="pill">—</span>'}</td>
      <td class="num">${money(b.spend)}</td>
      <td class="num">${esc(new Date(b.createdAt).toLocaleDateString())}</td>
      <td><button class="danger" data-delete="${esc(b.id)}">Delete</button></td>
    </tr>`;
  }).join('') || `<tr><td colspan="9" class="hint">No books match “${esc(q)}”.</td></tr>`;
  for (const btn of $('booksTable').querySelectorAll('[data-delete]')) {
    btn.onclick = () => deleteBook(btn.dataset.delete);
  }
}

async function showBooks() {
  showOnly(['booksView']);
  document.title = 'My books · Coloring Book Generator';
  book = null;
  try { allBooks = (await api('/api/books')).books; } catch (e) { alert(e.message); allBooks = []; }
  renderBooksTable();
}

function showNewBook() {
  showOnly(['setup']);
  document.title = 'New book · Coloring Book Generator';
  book = null;
  for (const id of ['bookName', 'theme', 'styleNotes', 'subjects']) $(id).value = '';
  $('audience').value = 'kids';
  $('pageSize').value = 'economy';
  $('count').value = 50;
  $('setupHint').textContent = '';
  $('bookName').focus();
}

async function showBook(id) {
  try {
    book = await api(`/api/books/${id}/refresh`, {}).catch(() => api(`/api/books/${id}`));
  } catch (e) {
    alert(`Couldn't open that book: ${e.message}`);
    location.hash = '#/';
    return;
  }
  showOnly(BOOK_SECTIONS);
  renderBook();
}

async function deleteBook(id) {
  const b = allBooks.find((x) => x.id === id) || (book?.id === id ? book : null);
  const name = b?.name || id;
  if (!confirm(`Delete "${name}"?\n\nThis permanently removes its pages, covers, PDFs and listing from the output folder. Running batches are cancelled. This can't be undone.`)) return;
  try {
    const res = await fetch(`/api/books/${id}`, { method: 'DELETE' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    if (json.warnings?.length) alert(json.warnings.join('\n'));
    if (location.hash === '#/' || location.hash === '') await showBooks();
    else location.hash = '#/';
  } catch (e) { alert(e.message); }
}

$('bookSearch').oninput = renderBooksTable;
$('deleteBookBtn').onclick = () => book && deleteBook(book.id);
$('renameBtn').onclick = async (e) => {
  const name = $('bookNameEdit').value.trim();
  if (!name) return alert('Book name cannot be empty.');
  try {
    book = await api(`/api/books/${book.id}/meta`, { name });
    document.title = `${book.name} · Coloring Book Generator`;
    e.target.textContent = 'Saved ✓'; setTimeout(() => { e.target.textContent = 'Save name'; }, 1500);
  } catch (err) { alert(err.message); }
};

async function route() {
  if (running && location.hash !== currentHash) {
    if (!confirm('Pages are still generating (instant mode). Stop and leave this book?')) {
      history.replaceState(null, '', currentHash || '#/');
      return;
    }
    stopRequested = true;
  }
  currentHash = location.hash;
  clearInterval(pollTimer);
  const h = location.hash.replace(/^#/, '') || '/';
  const m = h.match(/^\/book\/([a-z0-9-]+)$/);
  if (h === '/new') showNewBook();
  else if (m) await showBook(m[1]);
  else await showBooks();
}
window.addEventListener('hashchange', route);

(async function init() {
  config = await api('/api/config');
  const e = config.estimates;
  $('modelInfo').textContent = `${config.imageModel} · pages ${config.pageQuality}`;
  $('pageSize').innerHTML =
    `<option value="economy">Economy ${config.pageSizes.economy} · ${money(e.page.economy.batch)}/page batch</option>` +
    `<option value="standard">Standard ${config.pageSizes.standard} · ${money(e.page.standard.batch)}/page batch</option>`;
  $('coverQuality').innerHTML =
    `<option value="low">Draft (low) ≈ ${money(e.cover.low)}</option>` +
    `<option value="medium">Final (medium) ≈ ${money(e.cover.medium)}</option>`;
  $('trim').innerHTML = config.trims.map((t) => `<option value="${t}">${t.replace('x', ' × ')} in</option>`).join('');
  if (!config.hasKey) $('keyBanner').classList.remove('hidden');
  await route();
})();
