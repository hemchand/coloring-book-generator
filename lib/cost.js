// Cost estimates for gpt-image-2.
// Output-token formula from the OpenAI community calculator (reverse-engineered, not official):
//   short_axis = round(q * short_edge / long_edge),  q = 16 (low) | 48 (medium) | 96 (high)
//   tokens     = ceil(q * short_axis * (2,000,000 + width * height) / 4,000,000)
// When the API returns `usage`, real token counts are used instead.

const QUALITY_FACTOR = { low: 16, medium: 48, high: 96 };

// Read lazily: .env is loaded after ES-module imports are evaluated.
export function prices() {
  return {
    imageOutputPerM: Number(process.env.IMAGE_OUTPUT_PRICE_PER_M || 30), // $ per 1M image output tokens
    textInputPerM: Number(process.env.TEXT_INPUT_PRICE_PER_M || 5),      // $ per 1M text input tokens
  };
}

export const BATCH_DISCOUNT = 0.5;

export function parseSize(size) {
  const [w, h] = String(size).split('x').map(Number);
  return { w, h };
}

export function imageOutputTokens(size, quality) {
  const { w, h } = parseSize(size);
  const q = QUALITY_FACTOR[quality] ?? 48;
  const shortAxis = Math.floor((q * Math.min(w, h)) / Math.max(w, h) + 0.5);
  return Math.ceil((q * shortAxis * (2_000_000 + w * h)) / 4_000_000);
}

export function estimateImageCost({ size, quality, prompt = '', usage = null, batch = false }) {
  let outTokens = imageOutputTokens(size, quality);
  let inTokens = Math.ceil(prompt.length / 4);
  if (usage && Number.isFinite(usage.output_tokens)) {
    outTokens = usage.output_tokens;
    inTokens = usage.input_tokens ?? inTokens;
  }
  const p = prices();
  const cost = (outTokens * p.imageOutputPerM + inTokens * p.textInputPerM) / 1_000_000;
  return +(cost * (batch ? BATCH_DISCOUNT : 1)).toFixed(5);
}
