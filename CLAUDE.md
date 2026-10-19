# Coloring Book Generator — project notes

Goal: publish AI coloring books on Amazon KDP (~50 pages each, ~20 books/month) at minimum AI cost.
Node web app (server.js + lib/ + public/), deps: sharp, pdf-lib. Real OpenAI API calls only — no mocks.

- Pages: gpt-image-2, quality low. Default size 720x928 (smallest 8.5:11 size ≥ 655,360 px; both sides divisible by 16);
  falls back to 1088x1408 if the API rejects the size. Pages go through the Batch API (50% off) by default.
- Covers: draft = low, final = medium, 1088x1408. User picks one with "Use for PDF".
- Endpoints: POST /v1/images/generations (b64_json); Batch: POST /v1/files (purpose=batch) → POST /v1/batches
  (endpoint /v1/images/generations, 24h) → poll GET /v1/batches/{id} → GET /v1/files/{output_file_id}/content (JSONL, custom_id = page-<index>).
- Ideas: POST /v1/responses with json_schema output (TEXT_MODEL); /api/ideas takes styleNotes so subjects fit the book-wide style.
- PDFs (lib/pdf.js): interior = 300 DPI upscale + threshold, KDP gutter margin on all sides, optional blank backs;
  cover = full wrap with 0.125" bleed, spine = pages × 0.002252" (white) / 0.0025" (cream), spine text only if > 79 pages.
- Listing: POST /api/books/:id/listing (TEXT_MODEL, json_schema → description_html, 7 keywords, 3 categories);
  /listing/save stores edits. Description sanitised to KDP tags (p,b,i,br,ul,li), ≤4000 chars; keywords ≤50 chars. Written to listing.txt.
- Style notes: book.styleNotes appended to every page prompt (POST /api/books/:id/style).
- Fonts: all PDF text uses lib/fonts/Fredoka-Bold.ttf embedded via @pdf-lib/fontkit (KDP flags non-embedded standard-14 fonts like Helvetica).
- Back cover (lib/pdf.js drawBackPanel): headline/subheadline (outlined Fredoka Bold), 2x2 tilted cards of real pages,
  tagline, brand (BRAND_NAME, default "Annvay Publishing"); KDP barcode box 2"x1.2" bottom-right kept clear.
  Text via POST /api/books/:id/back-cover[/suggest]; only drawn when a headline is saved.
- Books: book.name (fallback cover.title → theme); GET /api/books lists status per book; POST /api/books/:id/meta renames;
  DELETE /api/books/:id cancels pending batches then removes the folder. UI is hash-routed: #/ list, #/new, #/book/<id>.
- Cost estimates: lib/cost.js (community token formula; real `usage` used when returned).
- Output: output/<book-id>/{book.json,pages/,cover/,interior.pdf,cover.pdf,listing.txt}. Secrets in .env (gitignored).
