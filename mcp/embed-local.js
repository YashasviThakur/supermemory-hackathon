/**
 * Imprint — optional on-device embeddings for local semantic search.
 *
 * Uses a small sentence-transformer (all-MiniLM-L6-v2, 384-dim, CPU, no API key)
 * via transformers.js IF it's installed; otherwise callers fall back to keyword
 * search. This is NOT a hard dependency of Imprint — the local store stays
 * zero-dependency and instant by default. To turn it on:
 *
 *   npm i @huggingface/transformers      (or the older @xenova/transformers)
 *   export IMPRINT_LOCAL_EMBED=1
 *
 * Model weights (~25 MB) download once into ~/.imprint/models and are cached.
 * Everything degrades gracefully: if the library or model is missing, or a flag
 * isn't set, semantic search simply isn't used and keyword search takes over.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";

const MODEL = "Xenova/all-MiniLM-L6-v2";

let pipePromise = null;
let unavailable = false;
let override = null; // test hook — see setEmbedderForTest

/** Tests inject a deterministic embedder so the suite needs no model download. */
export function setEmbedderForTest(fn) { override = fn; unavailable = false; pipePromise = null; }

export const MODEL_NAME = MODEL;

/** Opt-in switch — only attempt embeddings when the user explicitly enables them. */
export function isEnabled() {
  const f = (process.env.IMPRINT_LOCAL_EMBED || "").toLowerCase();
  return f === "1" || f === "true" || f === "yes" || f === "on";
}

async function loadLib() {
  // Support both the current and legacy package names.
  for (const name of ["@huggingface/transformers", "@xenova/transformers"]) {
    try { return await import(name); } catch { /* try next */ }
  }
  throw new Error("transformers.js not installed");
}

async function getPipe() {
  if (override || unavailable) return null;
  if (!pipePromise) {
    pipePromise = (async () => {
      try {
        const t = await loadLib();
        try { t.env.cacheDir = join(homedir(), ".imprint", "models"); } catch { /* older API */ }
        return await t.pipeline("feature-extraction", MODEL);
      } catch (e) {
        unavailable = true;
        process.stderr.write(
          `[Imprint] local semantic search unavailable (${e.message}). ` +
          `Enable it with: npm i @huggingface/transformers\n`
        );
        return null;
      }
    })();
  }
  return pipePromise;
}

/** True if semantic search can actually run right now. */
export async function available() {
  if (override) return true;
  if (!isEnabled()) return false;
  return (await getPipe()) != null;
}

/** Embed one text into a unit-normalized vector, or null if unavailable. */
export async function embed(text) {
  if (override) return override(text);
  const pipe = await getPipe();
  if (!pipe) return null;
  try {
    const out = await pipe(String(text).slice(0, 2000), { pooling: "mean", normalize: true });
    return Array.from(out.data);
  } catch {
    return null;
  }
}

/** Cosine similarity over plain arrays / typed arrays. */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Embeddings are stored base64-packed so memories.json stays compact (one short
// string per memory instead of hundreds of pretty-printed float lines).
export function packVec(arr) {
  const f = Float32Array.from(arr);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString("base64");
}
export function unpackVec(b64) {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}
