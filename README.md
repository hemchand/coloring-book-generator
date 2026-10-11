# Coloring Book Generator

A local web app that turns one prompt into the two files Amazon KDP needs for a coloring book:

- **interior.pdf**: your coloring pages, upscaled to 300 DPI, cleaned to pure black & white, inside KDP margins, with an optional blank page behind each picture
- **cover.pdf**: a full wrap (back + spine + front, 0.125" bleed). The spine width is worked out from the page count and paper type, and the title goes on the spine when KDP allows it (over 79 pages).

Images come from OpenAI `gpt-image-2`: `low` quality for pages, `low` (draft) or `medium` (final) for covers.

## Setup (one time)

1. Install Node.js 18.17 or newer (`node -v`; https://nodejs.org).
2. In this folder: `npm install`
3. `cp .env.example .env`, then paste your OpenAI API key into `.env`.
4. Set a monthly budget limit at https://platform.openai.com/usage.

## Run

```bash
cd ~/"Claude-Cowork/PROJECTS/Coloring Book Generator"
npm start
```

Open http://localhost:3000.

## Workflow

1. **Setup:** enter a theme, audience, page resolution and page count. Click **Suggest subjects with AI** or type your own subjects, one per line. Then click **Create book**.
2. **Pages:** pick **Batch (50% off)** or **Instant** and click **Generate missing pages**.
   - Batch results arrive within 24h, usually much sooner. The server checks every minute while it's running, and you can reopen the book any time from the top-right menu.
   - Pages that look shaded or have big black areas get a ⚠ badge. Tick **redo**, edit the subject, and click **Regenerate ticked pages**. Batch mode is half price for redos too.
3. **Cover:** make a few **Draft (low)** covers to find a layout you like, then one **Final (medium)**. Click **Use for PDF** on the one you want.
4. **PDFs:** choose the trim size and paper, then click **Build interior.pdf + cover.pdf**. Both files are saved in `output/<book>/`. Upload them to KDP and say the images are AI-generated.

## What it costs (estimates; real numbers at platform.openai.com/usage)

| Item | Before | Now (default) |
|---|---|---|
| Interior page | ~$0.0056 (1088×1408, instant) | **~$0.0022** (720×928, batch) |
| 50-page book (pages only) | ~$0.28 | **~$0.11** |
| Cover | ~$0.048 each (medium) | drafts ~$0.0056, one final ~$0.048 |
| **20 books/month (1 redo per page; before: 2 medium covers, now: 2 drafts + 1 final)** | **~$13** | **~$5.60** |

Where the savings come from:
- **Batch API:** 50% off every page and every redo.
- **Economy size:** 720×928 is the smallest 8.5:11 size the API accepts, about 25% fewer output tokens. The PDF builder upscales it to 2550×3300 (300 DPI) for free. Choose **Standard** for detailed adult pages.
- **Shorter prompts:** about half the input tokens per image.
- **Cheap cover drafts:** about 1/8 the price of a medium cover.
- **Local cleanup:** line cleanup and a shading check mean fewer paid redos.

Per-image estimates use the community-measured gpt-image-2 token formula (`lib/cost.js`). When the API returns real token usage, that is used instead.

## Files

```
server.js        web server, OpenAI calls, Batch API, PDF routes
lib/cost.js      cost estimates
lib/pdf.js       interior/cover PDF builder and line-art check
public/          the web page
output/<book>/   book.json, pages/, cover/, interior.pdf, cover.pdf   (not committed)
```
