/**
 * Imprint MCP test suite — `npm test` (from mcp/).
 *
 * Exercises the local-first store and the cloud sync engine end-to-end against a
 * mock cloud, plus a real cross-process concurrency test. Uses a throwaway temp
 * HOME so it never touches the real ~/.imprint.
 */

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

// Point the store at a temp home BEFORE importing local-store (it resolves the
// directory at module load).
const HOME = mkdtempSync(join(tmpdir(), "imprint-test-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
delete process.env.IMPRINT_USER_ID;

const here = dirname(fileURLToPath(import.meta.url));
const store = await import("./local-store.js");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ✓", msg); } else { fail++; console.log("  ✗ FAIL:", msg); } };
const section = (s) => console.log(`\n── ${s} ──`);

// ── Mock cloud (mirrors /api/memories + /api/user contract) ──
const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
function jsonRes(obj) {
  return { ok: true, status: 200, async json() { return obj; }, async text() { return JSON.stringify(obj); } };
}
function makeCloud() {
  const mems = new Map();
  let seq = 0;
  const cloud = {
    mems,
    syncEnabled: true,
    requests: [],
    async handle(url, opts = {}) {
      const method = (opts.method || "GET").toUpperCase();
      const u = new URL(url, "http://cloud");
      cloud.requests.push(`${method} ${u.pathname}`);
      if (u.pathname === "/api/user") {
        return jsonRes({ userId: u.searchParams.get("userId"), syncEnabled: cloud.syncEnabled !== false });
      }
      if (u.pathname === "/api/memories") {
        if (method === "GET") return jsonRes({ memories: [...mems.values()] });
        if (method === "POST") {
          const b = JSON.parse(opts.body);
          const prefix = norm(b.content).slice(0, 40);
          const dup = [...mems.values()].find((m) => norm(m.content).slice(0, 40) === prefix);
          if (dup) { if (b.pinned && !dup.pinned) dup.pinned = true; return jsonRes({ memory: dup, deduped: true }); }
          seq++;
          const m = { memoryId: `cloud-${seq}`, createdAt: new Date(Date.now() + seq).toISOString(),
            content: b.content, topic: b.topic, pinned: !!b.pinned, keywords: [], contradicts: [], confidence: 1, source: b.source };
          mems.set(m.memoryId, m);
          return jsonRes({ memory: m, contradictions: [] });
        }
        if (method === "PATCH") {
          const b = JSON.parse(opts.body);
          const m = mems.get(b.memoryId);
          if (m) {
            if (b.pinned !== undefined) m.pinned = b.pinned;
            if (b.content !== undefined) m.content = b.content;
            if (b.topic !== undefined) m.topic = b.topic;
          }
          return jsonRes({ success: true });
        }
        if (method === "DELETE") {
          mems.delete(u.searchParams.get("memoryId"));
          return jsonRes({ success: true });
        }
      }
      return { ok: false, status: 404, async json() { return {}; }, async text() { return "not found"; } };
    },
  };
  return cloud;
}

// ════════════════════════════════════════════════════════════
section("local store basics");
{
  const a = store.localSave({ content: "User is building Imprint, a memory layer.", topic: "projects" });
  ok(!a.deduped && a.memory.memoryId, "save creates a memory");
  const b = store.localSave({ content: "User is building Imprint, a memory layer.", topic: "projects" });
  ok(b.deduped, "duplicate save deduped by prefix");
  store.localSave({ content: "User prefers TypeScript and Next.js.", topic: "preferences" });
  store.localSave({ content: "User has type 2 diabetes.", topic: "health", pinned: true });

  const all = store.localGet({ limit: 50 });
  ok(all.length === 3, `3 unique memories (got ${all.length})`);
  ok(all[0].pinned, "pinned ranks first");
  ok(store.localGet({ topic: "preferences" }).length === 1, "topic filter works");

  const s = store.localSearch("what does the user prefer", 10);
  ok(s.some((m) => m.content.includes("TypeScript")), "search finds preferences memory");
  ok(s.some((m) => m.pinned), "search always includes pinned");

  const pinnedMem = all.find((m) => m.pinned);
  ok(store.localPin(pinnedMem.memoryId, false)?.pinned === false, "unpin returns updated memory");
}

section("tombstones on delete");
{
  const m = store.localSave({ content: "Temporary fact to be forgotten.", topic: "general" }).memory;
  const before = store.getTombstones().length;
  const deleted = store.localDelete(m.memoryId);
  ok(deleted && deleted.memoryId === m.memoryId, "delete returns the removed memory");
  ok(!store.localGet({ limit: 99 }).some((x) => x.memoryId === m.memoryId), "memory gone from store");
  ok(store.getTombstones().length === before + 1, "a tombstone was recorded");
  ok(store.localDelete("nope") === null, "deleting a missing id returns null");
}

section("sync: pull inserts, push uploads + reconciles id");
{
  const cloud = makeCloud();
  global.fetch = (url, opts) => cloud.handle(url, opts);
  const { pushPull } = await import("./sync.js");

  // Seed a cloud-only memory and a local-only (dirty) memory.
  cloud.mems.set("cloud-seed", { memoryId: "cloud-seed", createdAt: new Date().toISOString(),
    content: "Cloud-only fact from another device.", topic: "general", pinned: false, keywords: [], contradicts: [], confidence: 1 });
  const local = store.localSave({ content: "Local-only fact made offline.", topic: "general" }).memory;
  ok(local._dirty !== false, "new local memory is dirty (pending push)");

  const r = await pushPull("u1", "http://cloud");
  ok(r.pulled >= 1, `pulled the cloud-only memory (pulled=${r.pulled})`);
  ok(store.localGet({ limit: 99 }).some((m) => m.content.includes("Cloud-only fact")), "cloud memory now local");
  ok([...cloud.mems.values()].some((m) => m.content.includes("Local-only fact made offline")), "local memory pushed to cloud");

  // The pushed local memory should have adopted the cloud id (reconciled).
  const reconciled = store.localReadAll().find((m) => m.content.includes("Local-only fact made offline"));
  ok(reconciled.memoryId.startsWith("cloud-") && reconciled._dirty === false, "local memory adopted cloud id and is no longer dirty");
}

section("sync: delete propagates and is NOT resurrected");
{
  const cloud = makeCloud();
  global.fetch = (url, opts) => cloud.handle(url, opts);
  const { pushPull } = await import("./sync.js");

  // A memory that exists in both places (push it first).
  const m = store.localSave({ content: "Synced fact that will be deleted.", topic: "general" }).memory;
  await pushPull("u1", "http://cloud");
  const cloudId = store.localReadAll().find((x) => x.content.includes("Synced fact that will be deleted")).memoryId;
  ok(cloud.mems.has(cloudId), "memory is in the cloud after first sync");

  // Delete locally, then sync.
  store.localDelete(cloudId);
  const r = await pushPull("u1", "http://cloud");
  ok(r.deleted >= 1, `delete propagated to cloud (deleted=${r.deleted})`);
  ok(!cloud.mems.has(cloudId), "memory removed from the cloud");

  // Sync again — the deleted memory must NOT come back.
  await pushPull("u1", "http://cloud");
  ok(!store.localGet({ limit: 99 }).some((x) => x.memoryId === cloudId), "deleted memory not resurrected locally");
  ok(store.getTombstones().length === 0, "tombstone cleared after successful propagation");
}

section("sync: resurrection guard when cloud delete fails once");
{
  const cloud = makeCloud();
  let failDelete = true;
  global.fetch = (url, opts) => {
    const method = (opts?.method || "GET").toUpperCase();
    if (method === "DELETE" && failDelete) return Promise.resolve({ ok: false, status: 500, async json() { return {}; }, async text() { return "err"; } });
    return cloud.handle(url, opts);
  };
  const { pushPull } = await import("./sync.js");

  const m = store.localSave({ content: "Fact whose cloud delete will fail first.", topic: "general" }).memory;
  await pushPull("u1", "http://cloud");
  const cloudId = store.localReadAll().find((x) => x.content.includes("cloud delete will fail first")).memoryId;
  store.localDelete(cloudId);

  await pushPull("u1", "http://cloud"); // DELETE fails → tombstone kept, not inserted
  ok(cloud.mems.has(cloudId), "cloud still has it (delete failed)");
  ok(!store.localGet({ limit: 99 }).some((x) => x.memoryId === cloudId), "still gone locally (not resurrected despite failed delete)");
  ok(store.getTombstones().length >= 1, "tombstone retained for retry");

  failDelete = false;
  const r = await pushPull("u1", "http://cloud"); // retry succeeds
  ok(r.deleted >= 1 && !cloud.mems.has(cloudId), "retry deletes it from the cloud");
}

section("sync: pin/unpin propagation");
{
  const cloud = makeCloud();
  global.fetch = (url, opts) => cloud.handle(url, opts);
  const { pushPull } = await import("./sync.js");

  const m = store.localSave({ content: "Fact to be pinned and synced.", topic: "general" }).memory;
  await pushPull("u1", "http://cloud");
  const cloudId = store.localReadAll().find((x) => x.content.includes("Fact to be pinned")).memoryId;

  store.localPin(cloudId, true);
  await pushPull("u1", "http://cloud");
  ok(cloud.mems.get(cloudId)?.pinned === true, "pin propagated to cloud");

  store.localPin(cloudId, false);
  await pushPull("u1", "http://cloud");
  ok(cloud.mems.get(cloudId)?.pinned === false, "unpin propagated to cloud");
}

section("sync: refreshSyncFlag reads the website toggle");
{
  const cloud = makeCloud();
  cloud.syncEnabled = false;
  global.fetch = (url, opts) => cloud.handle(url, opts);
  const { refreshSyncFlag } = await import("./sync.js");
  const enabled = await refreshSyncFlag("u1", "http://cloud");
  ok(enabled === false, "refreshSyncFlag returns the cloud toggle value");
  ok(store.loadConfig().syncEnabled === false, "toggle cached to local config");
  store.saveConfig({ syncEnabled: true }); // restore for cleanliness
}

section("local semantic search (opt-in, on-device)");
{
  const embed = await import("./embed-local.js");

  // pure helpers
  ok(Math.abs(embed.cosine([1, 0, 0], [1, 0, 0]) - 1) < 1e-9, "cosine of identical vectors = 1");
  ok(Math.abs(embed.cosine([1, 0, 0], [0, 1, 0])) < 1e-9, "cosine of orthogonal vectors = 0");
  const un = Array.from(embed.unpackVec(embed.packVec([0.5, -0.25, 0.125])));
  ok(un.length === 3 && Math.abs(un[0] - 0.5) < 1e-6 && Math.abs(un[1] + 0.25) < 1e-6, "pack/unpack round-trips a vector");

  // Inject a deterministic concept embedder so no model download is needed.
  // dims: [framework, health, location, bias]
  const fake = (text) => {
    const t = String(text).toLowerCase();
    return [
      /(framework|typescript|next|react|svelte|library|stack)/.test(t) ? 1 : 0,
      /(health|diabetes|medical|condition|illness|sleep|diet)/.test(t) ? 1 : 0,
      /(live|lives|from|city|delhi|location|based)/.test(t) ? 1 : 0,
      0.001,
    ];
  };
  embed.setEmbedderForTest(fake);
  ok((await embed.available()) === true, "embedder reports available with test override");

  // "frameworks" shares NO words with "TypeScript and Next.js" → keyword misses it.
  const kw = store.localSearch("frameworks", 10);
  ok(!kw.some((m) => m.content.includes("TypeScript")), "keyword search misses the synonym (no shared words)");

  const sem = await store.localSearchSemantic("frameworks", 10);
  ok(sem.some((m) => m.content.includes("TypeScript")), "semantic search FINDS it via meaning");
  ok(sem[0].content.includes("TypeScript"), "and ranks it first");

  const med = await store.localSearchSemantic("a medical condition", 10);
  ok(med.some((m) => m.content.toLowerCase().includes("diabetes")), "semantic matches 'medical condition' → diabetes");

  ok(store.localReadAll().filter((m) => m._localEmbedding && m._embModel).length > 0, "computed embeddings cached to the store");

  // Disable → the semantic entrypoint transparently falls back to keyword.
  embed.setEmbedderForTest(null);
  delete process.env.IMPRINT_LOCAL_EMBED;
  const fb = await store.localSearchSemantic("TypeScript", 10);
  const kw2 = store.localSearch("TypeScript", 10);
  ok(fb.length === kw2.length && fb.length > 0, "falls back to keyword when embeddings are disabled");
}

section("batched save (localSaveMany)");
{
  const before = store.localReadAll().length;
  const res = store.localSaveMany([
    { content: "Batch fact alpha one.", topic: "general" },
    { content: "Batch fact beta two.", topic: "work" },
    { content: "Batch fact gamma three.", topic: "preferences" },
    { content: "Batch fact alpha one.", topic: "general" }, // dup of #1
  ]);
  ok(res.length === 4, "returns a result per input");
  ok(res.filter((r) => r.deduped).length === 1, "the duplicate is deduped");
  ok(store.localReadAll().length === before + 3, "exactly 3 new memories added in one batch");
}

section("content-edit sync (local→cloud PATCH, not duplicate)");
{
  const cloud = makeCloud();
  global.fetch = (url, opts) => cloud.handle(url, opts);
  const { pushPull } = await import("./sync.js");

  const m = store.localSave({ content: "Editable fact, original wording.", topic: "general" }).memory;
  await pushPull("u1", "http://cloud");
  const cloudId = store.localReadAll().find((x) => x.content.startsWith("Editable fact")).memoryId;
  const cloudCountAfterCreate = cloud.mems.size;

  // Edit locally, then sync — must PATCH the same row, not create a new one.
  store.localUpdate(cloudId, { content: "Editable fact, REVISED wording." });
  await pushPull("u1", "http://cloud");
  ok(cloud.mems.size === cloudCountAfterCreate, "edit did NOT create a duplicate cloud row");
  ok(cloud.mems.get(cloudId)?.content === "Editable fact, REVISED wording.", "edit PATCHed the existing cloud row");
  ok(store.localReadAll().find((x) => x.memoryId === cloudId)?._dirty === false, "local row marked clean after edit push");
}

section("content-edit sync (cloud→local on pull, protecting local edits)");
{
  const cloud = makeCloud();
  global.fetch = (url, opts) => cloud.handle(url, opts);
  const { pushPull } = await import("./sync.js");

  const m = store.localSave({ content: "Two-way edit base fact.", topic: "general" }).memory;
  await pushPull("u1", "http://cloud");
  const id = store.localReadAll().find((x) => x.content.startsWith("Two-way edit base")).memoryId;

  // Edit on the "cloud" (another device / dashboard); a clean local row adopts it.
  cloud.mems.get(id).content = "Two-way edit base fact — edited elsewhere.";
  await pushPull("u1", "http://cloud");
  ok(store.localReadAll().find((x) => x.memoryId === id)?.content === "Two-way edit base fact — edited elsewhere.", "clean local row picks up the cloud edit");

  // Now make a PENDING local edit, then change the cloud too — local must win.
  store.localUpdate(id, { content: "Local pending edit wins." });
  cloud.mems.get(id).content = "Cloud tries to overwrite.";
  await pushPull("u1", "http://cloud");
  const finalLocal = store.localReadAll().find((x) => x.memoryId === id)?.content;
  ok(finalLocal === "Local pending edit wins.", "pending local edit is not clobbered by pull");
  ok(cloud.mems.get(id)?.content === "Local pending edit wins.", "and the local edit was pushed up");
}

section("at-rest encryption (separate processes)");
{
  const childCode = `
    const s = await import(process.env.STORE_URL);
    try {
      if (process.env.ACTION === 'save') { s.localSave({ content: process.env.CONTENT, topic: 'general' }); process.stdout.write('OK'); }
      else { process.stdout.write(JSON.stringify(s.localGet({ limit: 99 }).map(m => m.content))); }
      process.exit(0);
    } catch (e) { process.stderr.write(String(e.message)); process.exit(3); }
  `;
  const storeUrl = pathToFileURL(join(here, "local-store.js")).href;
  const run = (home, env) => new Promise((resolve) => {
    let out = "", err = "";
    const p = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
      env: { ...process.env, USERPROFILE: home, HOME: home, STORE_URL: storeUrl, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => resolve({ code, out, err }));
  });
  // The child must NOT inherit the parent test's keys/ids.
  const cleanEnv = { IMPRINT_ENCRYPTION_KEY: "", IMPRINT_USER_ID: "" };

  const encHome = mkdtempSync(join(tmpdir(), "imprint-enc-"));
  const memFile = join(encHome, ".imprint", "memories.json");

  await run(encHome, { ...cleanEnv, IMPRINT_ENCRYPTION_KEY: "correct horse", ACTION: "save", CONTENT: "TOP SECRET diagnosis details" });
  const raw = readFileSync(memFile, "utf8");
  ok(raw.includes("__imprint_enc"), "file on disk is an encrypted envelope");
  ok(!raw.includes("TOP SECRET diagnosis"), "plaintext content is NOT present on disk");

  const right = await run(encHome, { ...cleanEnv, IMPRINT_ENCRYPTION_KEY: "correct horse", ACTION: "get" });
  ok(right.code === 0 && right.out.includes("TOP SECRET diagnosis"), "correct key decrypts");

  const none = await run(encHome, { ...cleanEnv, ACTION: "get" });
  ok(none.code !== 0, "missing key refuses to read (no silent data loss)");

  const wrong = await run(encHome, { ...cleanEnv, IMPRINT_ENCRYPTION_KEY: "wrong key", ACTION: "get" });
  ok(wrong.code !== 0, "wrong key fails to decrypt");

  // Migration: plaintext file becomes encrypted on its next write under a key.
  const migHome = mkdtempSync(join(tmpdir(), "imprint-mig-"));
  const migFile = join(migHome, ".imprint", "memories.json");
  await run(migHome, { ...cleanEnv, ACTION: "save", CONTENT: "Plain fact written first" });
  ok(!readFileSync(migFile, "utf8").includes("__imprint_enc"), "starts as plaintext");
  await run(migHome, { ...cleanEnv, IMPRINT_ENCRYPTION_KEY: "k2", ACTION: "save", CONTENT: "Encrypted fact written second" });
  ok(readFileSync(migFile, "utf8").includes("__imprint_enc"), "auto-migrated to encrypted on next write");
  const both = await run(migHome, { ...cleanEnv, IMPRINT_ENCRYPTION_KEY: "k2", ACTION: "get" });
  ok(both.out.includes("Plain fact written first") && both.out.includes("Encrypted fact written second"), "migration preserved existing data");

  try { rmSync(encHome, { recursive: true, force: true }); rmSync(migHome, { recursive: true, force: true }); } catch {}
}

section("hybrid retrieval (BM25 + RRF)");
{
  // BM25/IDF: a rare query term should dominate a generic common one.
  store.localSave({ content: "User deploys Kubernetes clusters every morning.", topic: "work" });
  const lex = store.localSearch("user kubernetes", 10);
  ok(lex[0]?.content.includes("Kubernetes"), "BM25 ranks the rare-term match first (IDF), not a generic 'user' match");

  // Hybrid RRF: a doc matching BOTH lexically and semantically ranks top.
  const embed = await import("./embed-local.js");
  embed.setEmbedderForTest((t) => {
    const x = String(t).toLowerCase();
    return [/(kube|helm|cluster|devops)/.test(x) ? 1 : 0, /(framework|typescript|next)/.test(x) ? 1 : 0, 0];
  });
  const hyb = await store.localSearchSemantic("kubernetes", 10);
  ok(hyb[0]?.content.includes("Kubernetes"), "RRF fuses lexical + semantic — the doc matching both ranks first");
  embed.setEmbedderForTest(null);
}

// ════════════════════════════════════════════════════════════
section("cross-process concurrency (the file lock)");
{
  // Spawn N child processes that each save M distinct memories into the SAME
  // store concurrently. Without the lock, racing read-modify-write loses writes.
  const storeUrl = pathToFileURL(join(here, "local-store.js")).href;
  const N = 5, M = 20;
  const childCode = `
    const s = await import(process.env.STORE_URL);
    const wid = process.env.WID, n = +process.env.WN;
    for (let i = 0; i < n; i++) s.localSave({ content: 'w' + wid + ' concurrent memory ' + i, topic: 'general' });
  `;
  const before = store.localReadAll().length;
  const kids = Array.from({ length: N }, (_, w) =>
    new Promise((resolve) => {
      let err = "";
      const p = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
        env: { ...process.env, STORE_URL: storeUrl, WID: String(w), WN: String(M) },
        stdio: ["ignore", "ignore", "pipe"],
      });
      p.stderr.on("data", (d) => (err += d));
      p.on("exit", (code) => resolve({ code, err: err.trim() }));
    })
  );
  const outcomes = await Promise.all(kids);
  const crashed = outcomes.filter((o) => o.code !== 0);
  if (crashed.length) crashed.forEach((o, i) => console.log(`    child crash #${i}: exit=${o.code} ${o.err.split("\n")[0] || ""}`));
  const added = store.localReadAll().length - before;
  ok(added === N * M, `all ${N * M} concurrent writes persisted (got ${added}) — no lost updates`);
}

// ── cleanup ──
try { rmSync(HOME, { recursive: true, force: true }); } catch {}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
