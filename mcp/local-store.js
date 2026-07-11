/**
 * Imprint — local-first store.
 *
 * Zero-dependency JSON store that lives entirely on the user's machine, so
 * Imprint works offline and without any AWS/cloud account. This is the source
 * of truth on the client; the hosted API is an optional mirror (see sync.js).
 *
 * Cross-platform: everything lives under `~/.imprint` resolved via os.homedir(),
 * which is correct on both Windows and macOS/Linux.
 *
 *   ~/.imprint/memories.json     array of memory objects (cloud-compatible shape)
 *   ~/.imprint/tombstones.json   deletions awaiting propagation to the cloud
 *   ~/.imprint/config.json       { syncEnabled, userId, lastSyncAt }
 *   ~/.imprint/.lock             advisory cross-process write lock
 *
 * Concurrency: the MCP server and the Stop hook both write the store, often at
 * the same time. Every mutation runs read-modify-write inside an exclusive file
 * lock so concurrent writers can't clobber each other's updates.
 */

import { randomUUID, scryptSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
} from "node:fs";

const DIR = join(homedir(), ".imprint");
const MEM_FILE = join(DIR, "memories.json");
const CONFIG_FILE = join(DIR, "config.json");
const TOMB_FILE = join(DIR, "tombstones.json");
const LOCK_FILE = join(DIR, ".lock");

// Mirror the cloud TTL: unpinned memories expire after 30 days, pinned never.
const MEMORY_TTL_DAYS = 30;
// Tombstones self-expire so a deletion that can never be matched in the cloud
// (e.g. the memory was only ever local) doesn't accumulate forever.
const TOMBSTONE_TTL_DAYS = 90;
const LOCK_STALE_MS = 10_000;    // steal a lock whose holder looks dead
const LOCK_MAX_WAIT_MS = 30_000; // absolute cap before force-stealing (deadlock backstop)
const VALID_TOPICS = new Set([
  "work", "personal", "preferences", "health", "projects", "relationships", "general",
]);

// ── at-rest encryption (optional) ─────────────────────────
// Set IMPRINT_ENCRYPTION_KEY to a passphrase and the sensitive store files
// (memories, tombstones) are encrypted on disk with AES-256-GCM. Without it,
// files are plaintext JSON (unchanged behaviour). Migration is automatic: an
// existing plaintext file is re-written encrypted on its next write.
const PASSPHRASE = process.env.IMPRINT_ENCRYPTION_KEY || null;
const ENC_MARK = "__imprint_enc";
const keyCache = new Map(); // saltHex -> 32-byte key (avoid re-running scrypt)

function deriveKey(saltBuf) {
  const hex = saltBuf.toString("hex");
  let k = keyCache.get(hex);
  if (!k) { k = scryptSync(PASSPHRASE, saltBuf, 32); keyCache.set(hex, k); }
  return k;
}

function isEnvelope(obj) {
  return obj && typeof obj === "object" && obj[ENC_MARK] === 1 && obj.alg === "aes-256-gcm";
}

function encryptEnvelope(plaintext, saltHint) {
  const salt = saltHint ? Buffer.from(saltHint, "hex") : randomBytes(16);
  const key = deriveKey(salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    [ENC_MARK]: 1, alg: "aes-256-gcm",
    salt: salt.toString("hex"), iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"), data: data.toString("base64"),
  };
}

function decryptEnvelope(env) {
  const key = deriveKey(Buffer.from(env.salt, "hex"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "hex"));
  decipher.setAuthTag(Buffer.from(env.tag, "hex"));
  const out = Buffer.concat([decipher.update(Buffer.from(env.data, "base64")), decipher.final()]);
  return out.toString("utf8");
}

// ── low-level file IO ─────────────────────────────────────
function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

// readJson — transparently decrypts an encrypted envelope. If a file is
// encrypted but no/incorrect passphrase is available we THROW rather than return
// the fallback, so a later write can never silently overwrite real data with empty.
function readJson(file, fallback) {
  let raw;
  try {
    if (!existsSync(file)) return fallback;
    raw = readFileSync(file, "utf8").trim();
    if (!raw) return fallback;
  } catch {
    return fallback;
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return fallback; }
  if (!isEnvelope(parsed)) return parsed; // plaintext (legacy or encryption off)
  if (!PASSPHRASE) {
    throw new Error(`${file} is encrypted but IMPRINT_ENCRYPTION_KEY is not set.`);
  }
  try {
    return JSON.parse(decryptEnvelope(parsed));
  } catch {
    throw new Error(`Failed to decrypt ${file} — wrong IMPRINT_ENCRYPTION_KEY?`);
  }
}

// Transient Windows fs errors (AV scanners, indexer, concurrent create/delete)
// surface as EPERM/EACCES/EBUSY and just need a brief retry, not a crash.
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

function renameWithRetry(tmp, file) {
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); return; }
    catch (e) {
      if (i >= 25 || !TRANSIENT.has(e.code)) throw e;
      sleepSync(5 + i * 2);
    }
  }
}

// Reuse a file's existing salt (if it's already an encrypted envelope) so the
// derived key stays cached across writes; otherwise a fresh random salt is used.
function existingSalt(file) {
  try {
    const obj = JSON.parse(readFileSync(file, "utf8"));
    if (isEnvelope(obj)) return obj.salt;
  } catch { /* not an envelope */ }
  return null;
}

// Atomic write — write to a unique temp file then rename, so a crash mid-write
// can never leave a half-written (corrupt) JSON file, and concurrent temp files
// from different processes never collide. Sensitive files are encrypted when a
// passphrase is set (config holds only flags, so it stays plaintext).
function writeJson(file, data) {
  ensureDir();
  let payload;
  if (PASSPHRASE && file !== CONFIG_FILE) {
    payload = JSON.stringify(encryptEnvelope(JSON.stringify(data), existingSalt(file)), null, 2);
  } else {
    payload = JSON.stringify(data, null, 2);
  }
  const tmp = `${file}.${process.pid}.${Math.floor(performance.now())}.tmp`;
  writeFileSync(tmp, payload, "utf8");
  renameWithRetry(tmp, file);
}

// Synchronous sleep without busy-spinning the CPU (used only while lock-waiting).
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const until = Date.now() + ms; while (Date.now() < until) { /* fallback spin */ } }
}

// Run `fn` while holding an exclusive cross-process lock. All store mutations go
// through this so the server and the Stop hook can't lose each other's writes.
// We never proceed unlocked (that would risk lost updates) — instead we wait,
// and only steal a lock whose holder appears dead (stale mtime / hard cap).
function withLock(fn) {
  ensureDir();
  let held = false;
  const start = Date.now();
  const jitter = 6 + (process.pid % 10); // de-synchronize retriers (thundering herd)
  for (;;) {
    try {
      const fd = openSync(LOCK_FILE, "wx"); // exclusive create — fails if locked
      closeSync(fd);
      held = true;
      break;
    } catch (e) {
      // EEXIST = lock held; EPERM/EACCES/EBUSY = transient Windows race — both
      // mean "try again". Anything else is a real error.
      if (e.code !== "EEXIST" && !TRANSIENT.has(e.code)) throw e;
      let age = Infinity;
      try { age = Date.now() - statSync(LOCK_FILE).mtimeMs; }
      catch { sleepSync(jitter); continue; } // lock vanished/unreadable — back off and retry
      if (age > LOCK_STALE_MS || Date.now() - start > LOCK_MAX_WAIT_MS) {
        try { unlinkSync(LOCK_FILE); } catch { /* someone else stole it */ }
        continue; // steal a dead lock, then retry
      }
      sleepSync(jitter);
    }
  }
  try {
    return fn();
  } finally {
    if (held) { try { unlinkSync(LOCK_FILE); } catch { /* already gone */ } }
  }
}

// ── config ────────────────────────────────────────────────
export function loadConfig() {
  const cfg = readJson(CONFIG_FILE, {});
  return {
    // Default ON so existing cloud accounts keep syncing after upgrade. A purely
    // local user simply never sets a userId, so nothing is ever uploaded anyway.
    syncEnabled: cfg.syncEnabled !== false,
    userId: cfg.userId || process.env.IMPRINT_USER_ID || null,
    lastSyncAt: cfg.lastSyncAt || null,
  };
}

export function saveConfig(patch) {
  return withLock(() => {
    const current = readJson(CONFIG_FILE, {});
    const next = { ...current, ...patch };
    writeJson(CONFIG_FILE, next);
    return next;
  });
}

// ── helpers ───────────────────────────────────────────────
const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
const prefixOf = (content) => norm(content).slice(0, 40);

function deriveKeywords(content) {
  return norm(content)
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6);
}

function nowTtl(pinned) {
  return pinned ? undefined : Math.floor(Date.now() / 1000) + MEMORY_TTL_DAYS * 86400;
}

function isExpired(m) {
  return !m.pinned && m.ttl && m.ttl < Math.floor(Date.now() / 1000);
}

function readAll() {
  const items = readJson(MEM_FILE, []);
  return Array.isArray(items) ? items : [];
}

function writeAll(items) {
  writeJson(MEM_FILE, items);
}

// Read for a mutation: returns the raw list with expired unpinned memories
// dropped. Persistence of the pruning happens when the caller writes back.
function readForWrite() {
  return readAll().filter((m) => !isExpired(m));
}

// Read-only view with expiry applied in memory (no write — safe outside a lock).
function readLive() {
  return readAll().filter((m) => !isExpired(m));
}

// ── tombstones ────────────────────────────────────────────
function readTombstones() {
  const t = readJson(TOMB_FILE, []);
  return Array.isArray(t) ? t : [];
}

function pruneTombstones(list) {
  const cutoff = Date.now() - TOMBSTONE_TTL_DAYS * 86400_000;
  return list.filter((t) => new Date(t.deletedAt).getTime() > cutoff);
}

export function getTombstones() {
  return pruneTombstones(readTombstones());
}

// Record a deletion so sync.js can (a) delete it from the cloud and (b) refuse
// to resurrect it on the next pull. Stores cloud id + createdAt when known.
function addTombstone(mem) {
  const list = readTombstones().filter((t) => t.memoryId !== mem.memoryId);
  list.push({
    memoryId: mem.memoryId,
    createdAt: mem.createdAt,
    prefix: prefixOf(mem.content),
    deletedAt: new Date().toISOString(),
  });
  writeJson(TOMB_FILE, pruneTombstones(list));
}

export function dropTombstone(memoryId) {
  return withLock(() => {
    const list = readTombstones();
    const next = list.filter((t) => t.memoryId !== memoryId);
    if (next.length !== list.length) writeJson(TOMB_FILE, next);
    return next.length !== list.length;
  });
}

// Attach the cloud's identity to a tombstone (so a delete can be propagated even
// when the deleted memory was created locally and only later seen in the cloud).
export function setTombstoneCloudId(memoryId, cloudId, cloudCreatedAt) {
  return withLock(() => {
    const list = readTombstones();
    const t = list.find((x) => x.memoryId === memoryId);
    if (!t) return false;
    t.memoryId = cloudId;
    t.createdAt = cloudCreatedAt;
    writeJson(TOMB_FILE, list);
    return true;
  });
}

// ── ranking (ported from lib/rank.ts) ─────────────────────
const LAMBDA = 0.05; // half-life ≈ 14 days
function scoreMemory(m) {
  if (m.pinned) return 2.0;
  const daysOld = (Date.now() - new Date(m.createdAt).getTime()) / 86_400_000;
  const recencyDecay = Math.exp(-LAMBDA * daysOld);
  const accessBoost = Math.min((m.accessCount ?? 0) / 10, 0.5);
  return (m.confidence ?? 1) * recencyDecay * (1 + accessBoost);
}

function rank(items) {
  return [...items].sort((a, b) => scoreMemory(b) - scoreMemory(a));
}

// Pinned = "always remember": guarantee they survive any limit/relevance filter.
function withPinnedFirst(all, results) {
  const seen = new Set(results.map((m) => m.memoryId));
  const pinned = all.filter((m) => m.pinned && !seen.has(m.memoryId));
  return [...pinned, ...results];
}

// ── public API (mirrors lib/dynamodb.ts semantics) ────────

// Insert one memory into an in-memory list, applying prefix dedup. Mutates
// `all`. Returns { memory, deduped, changed }. (changed = the list needs writing)
function insertInto(all, { content, topic = "general", pinned = false, source = "local" }, userId) {
  const memTopic = VALID_TOPICS.has(topic) ? topic : "general";
  const newPrefix = prefixOf(content);
  const dup = all.find((e) => prefixOf(e.content) === newPrefix);
  if (dup) {
    if (pinned && !dup.pinned) { // upgrade an existing memory to pinned
      dup.pinned = true; dup.ttl = undefined; dup._dirty = true; dup._pinDirty = true;
      return { memory: dup, deduped: true, changed: true };
    }
    return { memory: dup, deduped: true, changed: false };
  }
  const now = new Date().toISOString();
  const memory = {
    userId,
    memoryId: randomUUID(),
    content: content.trim(),
    topic: memTopic,
    keywords: deriveKeywords(content),
    createdAt: now,
    accessedAt: now,
    ttl: nowTtl(pinned),
    pinned: !!pinned,
    contradicts: [],
    confidence: 1.0,
    accessCount: 0,
    source,
    tags: [],
    _dirty: true,    // not yet pushed to cloud
    _synced: false,  // never round-tripped — push as a new row, not an edit
  };
  all.push(memory);
  return { memory, deduped: false, changed: true };
}

// Save a memory locally. Dedupes by normalized 40-char prefix, same rule the
// cloud API uses, so re-saving a known fact is cheap and clean.
// Returns { memory, deduped }.
export function localSave({ content, topic = "general", pinned = false, source = "local" }) {
  if (!content || !content.trim()) throw new Error("content required");
  const userId = loadConfig().userId || "local";
  return withLock(() => {
    const all = readForWrite();
    const r = insertInto(all, { content, topic, pinned, source }, userId);
    if (r.changed) writeAll(all);
    return { memory: r.memory, deduped: r.deduped };
  });
}

// Save many memories in a SINGLE lock + read + write. The Stop hook extracts
// several facts per turn; batching avoids rewriting the whole store once per fact
// (which, on every assistant response, adds up fast). Returns [{memory, deduped}].
export function localSaveMany(items = []) {
  const clean = items.filter((it) => it && it.content && it.content.trim());
  if (!clean.length) return [];
  const userId = loadConfig().userId || "local";
  return withLock(() => {
    const all = readForWrite();
    let changed = false;
    const out = clean.map((it) => {
      const r = insertInto(all, it, userId);
      changed = changed || r.changed;
      return { memory: r.memory, deduped: r.deduped };
    });
    if (changed) writeAll(all);
    return out;
  });
}

// Fetch memories, optionally filtered by topic, ranked, pinned-first.
export function localGet({ topic, limit = 60 } = {}) {
  let items = readLive();
  if (topic && topic !== "all") items = items.filter((m) => m.topic === topic);
  return rank(items).slice(0, limit);
}

// Persist computed on-device embeddings back to the store (under lock) so they
// only need to be computed once per memory. Stored base64-packed in a local-only
// field; never pushed to the cloud (which uses its own Jina embeddings).
export function persistLocalEmbeddings(updates) {
  if (!updates || !updates.length) return;
  return withLock(() => {
    const byId = new Map(updates.map((u) => [u.memoryId, u]));
    const all = readAll();
    let changed = false;
    for (const m of all) {
      const u = byId.get(m.memoryId);
      if (u) { m._localEmbedding = u.packed; m._embModel = u.model; changed = true; }
    }
    if (changed) writeAll(all);
  });
}

// ── lexical scoring: BM25-lite ────────────────────────────
// Proper IDF-weighted, length-normalized term scoring (Okapi BM25) over each
// memory's content + keywords — far better than naive overlap: rare terms count
// more, common terms less, and long memories don't win by sheer length. A light
// prefix match (prefer↔prefers, framework↔frameworks) stands in for stemming.
const tokenize = (s) => norm(s).split(/\s+/).filter(Boolean);
const termMatch = (token, term) => token === term || token.startsWith(term) || term.startsWith(token);

function bm25Ranked(query, docs) {
  const terms = tokenize(query).filter((w) => w.length > 2);
  if (!terms.length || !docs.length) return [];
  const k1 = 1.5, b = 0.75;
  const N = docs.length;
  const docTokens = docs.map((d) => tokenize(`${d.content} ${(d.keywords || []).join(" ")}`));
  const avgdl = docTokens.reduce((a, t) => a + t.length, 0) / N || 1;
  const df = {};
  for (const t of terms) df[t] = docTokens.filter((dt) => dt.some((w) => termMatch(w, t))).length;

  return docs
    .map((d, i) => {
      const dt = docTokens[i];
      const dl = dt.length || 1;
      let s = 0;
      for (const t of terms) {
        const n = df[t];
        if (!n) continue;
        const tf = dt.reduce((c, w) => c + (termMatch(w, t) ? 1 : 0), 0);
        if (!tf) continue;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl));
      }
      return { m: d, score: s };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

// Keyword search — BM25-lite, with a light recency/pin nudge; pinned guaranteed.
export function localSearch(query, limit = 10) {
  const all = readLive();
  const ranked = bm25Ranked(query, all)
    .map((x) => ({ m: x.m, score: x.score * (1 + Math.min(scoreMemory(x.m) / 2, 1) * 0.15) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.m);
  return withPinnedFirst(all, ranked.slice(0, limit));
}

// Hybrid semantic search — fuses lexical (BM25) and on-device embedding ranks via
// Reciprocal Rank Fusion (the technique strong retrieval stacks use), so a result
// that's a good lexical AND semantic match outranks one that's only one or the
// other. Falls back to pure keyword search when embeddings aren't available.
export async function localSearchSemantic(query, limit = 10) {
  let embedder;
  try { embedder = await import("./embed-local.js"); } catch { return localSearch(query, limit); }
  if (!(await embedder.available())) return localSearch(query, limit);

  const all = readLive();
  if (!all.length) return [];

  // Ensure each memory has an up-to-date on-device embedding (computed + cached).
  const model = embedder.MODEL_NAME;
  const updates = [];
  for (const m of all) {
    if (m._localEmbedding && m._embModel === model) continue;
    const vec = await embedder.embed(m.content);
    if (vec) {
      m._localEmbedding = embedder.packVec(vec);
      m._embModel = model;
      updates.push({ memoryId: m.memoryId, packed: m._localEmbedding, model });
    }
  }
  if (updates.length) persistLocalEmbeddings(updates);

  const qvec = await embedder.embed(query);
  if (!qvec) return localSearch(query, limit);

  // Lexical ranking (BM25) and semantic ranking (cosine), each as ordered lists.
  const lexRank = new Map(bm25Ranked(query, all).map((x, i) => [x.m.memoryId, i]));
  const semRank = new Map(
    all
      .map((m) => ({ m, score: m._localEmbedding ? embedder.cosine(qvec, embedder.unpackVec(m._localEmbedding)) : 0 }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x, i) => [x.m.memoryId, i])
  );

  // Reciprocal Rank Fusion (k=60) + a tiny recency/pin tiebreak.
  const K = 60;
  const ids = new Set([...lexRank.keys(), ...semRank.keys()]);
  const fused = [...ids]
    .map((id) => {
      const m = all.find((x) => x.memoryId === id);
      let s = 0;
      if (lexRank.has(id)) s += 1 / (K + lexRank.get(id));
      if (semRank.has(id)) s += 1 / (K + semRank.get(id));
      return { m, score: s + scoreMemory(m) * 0.001 };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.m);

  if (!fused.length) return localSearch(query, limit);
  return withPinnedFirst(all, fused.slice(0, limit));
}

// Delete a memory and record a tombstone so the deletion propagates to the cloud
// and the memory is never resurrected by a later pull. Returns the deleted
// memory (with its id + createdAt for an immediate cloud delete) or null.
export function localDelete(memoryId) {
  return withLock(() => {
    const all = readAll();
    const target = all.find((m) => m.memoryId === memoryId);
    if (!target) return null;
    addTombstone(target);
    writeAll(all.filter((m) => m.memoryId !== memoryId));
    return target;
  });
}

// Pin/unpin a memory. Returns the updated memory (for an immediate cloud PATCH)
// or null if not found.
export function localPin(memoryId, pinned) {
  return withLock(() => {
    const all = readForWrite();
    const m = all.find((x) => x.memoryId === memoryId);
    if (!m) return null;
    m.pinned = !!pinned;
    m.ttl = nowTtl(pinned);
    m.accessedAt = new Date().toISOString();
    m._dirty = true;
    m._pinDirty = true; // pin state changed — sync should PATCH the cloud
    writeAll(all);
    return { ...m };
  });
}

// Edit a memory's content and/or topic. Marks it dirty so the change syncs as a
// PATCH to the existing cloud row (not a duplicate). Returns the updated memory,
// the unchanged memory if nothing differed, or null if not found.
export function localUpdate(memoryId, { content, topic } = {}) {
  return withLock(() => {
    const all = readForWrite();
    const m = all.find((x) => x.memoryId === memoryId);
    if (!m) return null;
    let changed = false;
    if (content !== undefined && content.trim() && content.trim() !== m.content) {
      m.content = content.trim();
      m.keywords = deriveKeywords(m.content);
      m._localEmbedding = undefined; m._embModel = undefined; // stale — re-embed on next semantic search
      changed = true;
    }
    if (topic !== undefined && VALID_TOPICS.has(topic) && topic !== m.topic) { m.topic = topic; changed = true; }
    if (!changed) return { ...m };
    m._dirty = true;
    m.accessedAt = new Date().toISOString();
    writeAll(all);
    return { ...m };
  });
}

// ── sync support (used by sync.js) ────────────────────────

export function localReadAll() {
  return readAll();
}

// Memories created/changed locally that still need pushing to the cloud.
export function getDirty() {
  return readAll().filter((m) => m._dirty);
}

// Memories whose pin state changed locally and have a cloud identity to PATCH.
export function getPinDirty() {
  return readAll().filter((m) => m._pinDirty && m.createdAt);
}

// Insert a memory pulled from the cloud, OR reconcile identity if we already
// have the same content locally (adopt the cloud's memoryId + createdAt so future
// deletes/pins target the same row in both places). Returns the action taken.
export function reconcileFromCloud(cloud) {
  return withLock(() => {
    const all = readAll();
    const prefix = prefixOf(cloud.content);
    const existing = all.find(
      (m) => m.memoryId === cloud.memoryId || prefixOf(m.content) === prefix
    );
    if (!existing) {
      all.push({ ...cloud, _dirty: false, _pinDirty: false, _synced: true });
      writeAll(all);
      return "inserted";
    }
    let changed = false;
    // Adopt the cloud identity if ours differs (locally-created, now in cloud).
    if (existing.memoryId !== cloud.memoryId) {
      existing.memoryId = cloud.memoryId;
      existing.createdAt = cloud.createdAt;
      changed = true;
    }
    if (!existing._synced) { existing._synced = true; changed = true; }
    // Bring down field edits made elsewhere (dashboard / another device) — but
    // ONLY when this row has no un-pushed local changes, so we never clobber a
    // pending local edit. The push step is responsible for sending those up.
    if (!existing._dirty && !existing._pinDirty) {
      if (cloud.content !== undefined && cloud.content !== existing.content) {
        existing.content = cloud.content;
        existing.keywords = deriveKeywords(cloud.content);
        existing._localEmbedding = undefined; existing._embModel = undefined; // re-embed later
        changed = true;
      }
      if (cloud.topic !== undefined && cloud.topic !== existing.topic) { existing.topic = cloud.topic; changed = true; }
      if (cloud.pinned !== undefined && !!cloud.pinned !== !!existing.pinned) {
        existing.pinned = !!cloud.pinned; existing.ttl = nowTtl(cloud.pinned); changed = true;
      }
    }
    if (changed) writeAll(all);
    return changed ? "reconciled" : "noop";
  });
}

// After a successful push, adopt the cloud-assigned identity for a local memory
// and clear its dirty flags so we don't push it again.
export function reconcileAfterPush(localMemoryId, cloud) {
  return withLock(() => {
    const all = readAll();
    const m = all.find((x) => x.memoryId === localMemoryId);
    if (!m) return false;
    if (cloud && cloud.memoryId) {
      m.memoryId = cloud.memoryId;
      if (cloud.createdAt) m.createdAt = cloud.createdAt;
    }
    m._dirty = false;
    m._pinDirty = false; // the POST already carried the current pin state
    m._synced = true;    // now exists in the cloud — future edits PATCH, not POST
    writeAll(all);
    return true;
  });
}

export function clearPinDirty(memoryId) {
  return withLock(() => {
    const all = readAll();
    const m = all.find((x) => x.memoryId === memoryId);
    if (!m || !m._pinDirty) return false;
    m._pinDirty = false;
    writeAll(all);
    return true;
  });
}

// Mark the given memoryIds as synced (clear the dirty flag) after a push.
export function markSynced(memoryIds) {
  const set = new Set(memoryIds);
  return withLock(() => {
    const all = readAll();
    let changed = false;
    for (const m of all) {
      if (set.has(m.memoryId) && m._dirty) { m._dirty = false; changed = true; }
    }
    if (changed) writeAll(all);
    return changed;
  });
}

// Counts for status/observability.
export function localStats() {
  const all = readLive();
  return {
    total: all.length,
    pinned: all.filter((m) => m.pinned).length,
    dirty: all.filter((m) => m._dirty).length,
    pendingDeletes: getTombstones().length,
  };
}

export const STORE_DIR = DIR;
export const MEMORIES_FILE = MEM_FILE;
export { prefixOf };
