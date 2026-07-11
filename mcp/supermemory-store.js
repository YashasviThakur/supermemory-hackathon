/**
 * Supermemory store — Imprint's memory engine, powered by Supermemory Local.
 *
 * Every memory operation goes to a Supermemory server. By default that is
 * Supermemory Local on http://localhost:6767 (`npx supermemory local`), so all
 * embeddings, storage, and search happen on this machine — nothing leaves it.
 * Point SUPERMEMORY_BASE_URL at https://api.supermemory.ai to use the cloud
 * instead; the code path is identical.
 *
 * Env:
 *   SUPERMEMORY_BASE_URL       server base URL   (default http://localhost:6767)
 *   SUPERMEMORY_API_KEY        API key           (printed by supermemory local on first boot)
 *   SUPERMEMORY_CONTAINER_TAG  memory space      (default "imprint_<os-username>")
 */

import os from "os";

export const BASE_URL =
  (process.env.SUPERMEMORY_BASE_URL || "http://localhost:6767").replace(/\/+$/, "");
export const API_KEY = process.env.SUPERMEMORY_API_KEY || "";
export const CONTAINER_TAG =
  process.env.SUPERMEMORY_CONTAINER_TAG ||
  `imprint_${(os.userInfo().username || "default").toLowerCase().replace(/[^a-z0-9_-]/g, "")}`;

export const IS_LOCAL = /localhost|127\.0\.0\.1/.test(BASE_URL);

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class SupermemoryError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message);
    this.name = "SupermemoryError";
    this.status = status;
    this.cause = cause;
  }
}

/** fetch with timeout + bounded retry on 5xx / network errors. */
async function api(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok) {
        const text = await res.text();
        return text ? JSON.parse(text) : {};
      }
      const detail = await res.text().catch(() => "");
      if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
        lastErr = new SupermemoryError(`Supermemory ${res.status}`, { status: res.status });
        await sleep(300 * attempt);
        continue;
      }
      throw new SupermemoryError(`Supermemory ${res.status}: ${detail.slice(0, 300)}`, { status: res.status });
    } catch (e) {
      if (e instanceof SupermemoryError) throw e;
      lastErr = new SupermemoryError(connectHint(e), { cause: e });
      if (attempt < MAX_ATTEMPTS) { await sleep(300 * attempt); continue; }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function connectHint(e) {
  const msg = e?.message || String(e);
  if (IS_LOCAL && /(ECONNREFUSED|fetch failed|aborted|abort)/i.test(msg)) {
    return (
      `Cannot reach Supermemory Local at ${BASE_URL} (${msg}). ` +
      `Start it with \`npx supermemory local\` (or set SUPERMEMORY_BASE_URL).`
    );
  }
  return `Supermemory request failed: ${msg}`;
}

// ── Memory shape mapping ──────────────────────────────────
// Imprint memories carry { content, topic, pinned, source }. Supermemory stores
// the text in `memory`/`content` and everything else in metadata; `isStatic`
// marks permanent facts, which is exactly Imprint's "pinned" semantics.

const TOPICS = ["work", "personal", "preferences", "projects", "health", "relationships", "general"];

function toSupermemory({ content, topic = "general", pinned = false, source = "imprint" }) {
  return {
    content,
    isStatic: !!pinned,
    metadata: { topic: TOPICS.includes(topic) ? topic : "general", pinned: !!pinned, source },
  };
}

export function fromSupermemory(entry) {
  const meta = entry.metadata || {};
  return {
    memoryId: entry.id,
    content: entry.memory ?? entry.content ?? entry.chunk ?? "",
    topic: TOPICS.includes(meta.topic) ? meta.topic : "general",
    pinned: !!(meta.pinned || entry.isStatic),
    source: meta.source || "supermemory",
    createdAt: entry.createdAt || entry.updatedAt,
    updatedAt: entry.updatedAt,
    similarity: entry.similarity,
    version: entry.version,
  };
}

// ── Public API ────────────────────────────────────────────

/** Save one memory. Returns the created entry (server de-duplicates). */
export async function saveMemory(mem) {
  const res = await api("POST", "/v4/memories", {
    containerTag: CONTAINER_TAG,
    memories: [toSupermemory(mem)],
  });
  return res;
}

/** Save many memories in one call. */
export async function saveMemories(mems) {
  if (!mems.length) return { count: 0 };
  return api("POST", "/v4/memories", {
    containerTag: CONTAINER_TAG,
    memories: mems.map(toSupermemory),
  });
}

/** Semantic search, ranked by relevance. */
export async function searchMemories(q, { limit = 10, rerank = true } = {}) {
  const res = await api("POST", "/v4/search", {
    q,
    containerTag: CONTAINER_TAG,
    limit,
    rerank,
  });
  return (res.results || []).map(fromSupermemory);
}

/** List memories, newest first. */
export async function listMemories({ limit = 60, page = 1 } = {}) {
  const res = await api("POST", "/v4/memories/list", {
    containerTags: [CONTAINER_TAG],
    limit,
    page,
    sort: "createdAt",
    order: "desc",
  });
  const entries = (res.memoryEntries || []).filter((m) => !m.isForgotten);
  return entries.map(fromSupermemory);
}

/** Forget (delete) a memory by id. */
export async function deleteMemory(id) {
  return api("DELETE", "/v4/memories", { id, containerTag: CONTAINER_TAG });
}

/** Update a memory's content/metadata in place (creates a new version). */
export async function updateMemory(id, { content, topic, pinned }) {
  const body = { id, containerTag: CONTAINER_TAG };
  if (content !== undefined) body.content = content;
  const metadata = {};
  if (topic !== undefined) metadata.topic = topic;
  if (pinned !== undefined) { metadata.pinned = !!pinned; body.isStatic = !!pinned; }
  if (Object.keys(metadata).length) body.metadata = metadata;
  return api("PATCH", "/v4/memories", body);
}

/**
 * Ingest a raw document (e.g. a session transcript). Supermemory's own
 * pipeline chunks it, embeds it, and extracts memories from it — this is the
 * "let the memory engine do the remembering" path.
 */
export async function ingestDocument(content, metadata = {}) {
  return api("POST", "/v3/documents", {
    content,
    containerTag: CONTAINER_TAG,
    metadata,
  });
}

/** Connectivity + store stats, for the status tool. */
export async function status() {
  const started = Date.now();
  const memories = await listMemories({ limit: 100 });
  return {
    baseUrl: BASE_URL,
    local: IS_LOCAL,
    containerTag: CONTAINER_TAG,
    reachable: true,
    latencyMs: Date.now() - started,
    total: memories.length,
    pinned: memories.filter((m) => m.pinned).length,
  };
}
