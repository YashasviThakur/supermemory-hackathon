#!/usr/bin/env node

/**
 * End-to-end test of the Supermemory store integration.
 *
 * Runs against whatever SUPERMEMORY_BASE_URL points at. With no server
 * running, it spawns the dev mock on a scratch port first — so the suite
 * passes on machines that can't run the real Supermemory Local binary.
 *
 * Usage: node mcp/test-supermemory.mjs
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const PORT = 6768; // scratch port — never collides with a real local server
process.env.SUPERMEMORY_BASE_URL = process.env.SUPERMEMORY_TEST_URL || `http://localhost:${PORT}`;
process.env.SUPERMEMORY_CONTAINER_TAG = `imprint_test_${Date.now()}`;
// Contradiction checks route to the mock's fake Groq endpoint (offline test).
process.env.GROQ_BASE_URL = process.env.SUPERMEMORY_BASE_URL;
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || "gsk_test_offline";

const here = dirname(fileURLToPath(import.meta.url));

const store = await import("./supermemory-store.js");
const intel = await import("./intelligence.js");

let mock = null;
async function ensureServer() {
  try {
    await store.listMemories({ limit: 1 });
    return; // something is already answering
  } catch {
    mock = spawn(process.execPath, [join(here, "..", "scripts", "dev", "mock-supermemory.mjs"), String(PORT)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("mock did not start")), 5000);
      mock.stdout.on("data", (d) => {
        if (String(d).includes("listening")) { clearTimeout(t); resolve(); }
      });
    });
  }
}

let passed = 0, failed = 0;
function assert(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
}

try {
  await ensureServer();
  console.log(`Testing against ${store.BASE_URL} (space ${store.CONTAINER_TAG})\n`);

  // save
  await store.saveMemory({ content: "The user's name is Yashasvi and they build memory layers.", topic: "personal", pinned: true });
  await store.saveMemories([
    { content: "The user prefers TypeScript over JavaScript.", topic: "preferences" },
    { content: "The user is entering the Supermemory Localhost:6767 hackathon.", topic: "projects" },
  ]);
  assert("saveMemory / saveMemories complete without error", true);

  // list
  const all = await store.listMemories({ limit: 50 });
  assert("listMemories returns the saved memories", all.length >= 3, `got ${all.length}`);
  assert("pinned flag round-trips", all.some((m) => m.pinned), JSON.stringify(all.map(m => m.pinned)));
  assert("topic metadata round-trips", all.some((m) => m.topic === "preferences"), JSON.stringify(all.map(m => m.topic)));

  // search
  const hits = await store.searchMemories("what hackathon is the user entering?", { limit: 5 });
  assert("searchMemories finds the hackathon memory", hits.some((m) => /hackathon/i.test(m.content)), JSON.stringify(hits.map(m => m.content)));

  // update (versioned)
  const target = all.find((m) => m.topic === "preferences");
  await store.updateMemory(target.memoryId, { content: "The user prefers TypeScript, and Bun over Node." });
  const afterUpdate = await store.listMemories({ limit: 50 });
  assert("updateMemory rewrites content in place",
    afterUpdate.some((m) => /Bun over Node/.test(m.content)) && !afterUpdate.some((m) => m.content === target.content),
    JSON.stringify(afterUpdate.map(m => m.content)));

  // pin toggle
  const proj = afterUpdate.find((m) => /hackathon/i.test(m.content));
  await store.updateMemory(proj.memoryId, { pinned: true });
  const afterPin = await store.listMemories({ limit: 50 });
  assert("pin toggle persists", afterPin.find((m) => m.memoryId === proj.memoryId)?.pinned === true);

  // delete
  await store.deleteMemory(proj.memoryId);
  const afterDelete = await store.listMemories({ limit: 50 });
  assert("deleteMemory forgets the memory", !afterDelete.some((m) => m.memoryId === proj.memoryId));

  // document ingestion
  await store.ingestDocument("User: I am based in India.\nAssistant: Noted!", { source: "test" });
  assert("ingestDocument accepts a transcript", true);

  // status
  const s = await store.status();
  assert("status reports reachable server", s.reachable && typeof s.total === "number");

  // ── intelligence layer ──────────────────────────────────

  // contradiction detection (candidates from Supermemory search, verdict from LLM)
  await store.saveMemory({ content: "The user prefers dark mode.", topic: "preferences" });
  const conflicts = await intel.detectContradictions("The user prefers light mode.");
  assert("detectContradictions flags a genuine conflict",
    conflicts.some((c) => /dark mode/.test(c.existingMemoryContent)), JSON.stringify(conflicts));
  const noConflicts = await intel.detectContradictions("The user prefers dark mode.");
  assert("detectContradictions ignores the same fact reworded", noConflicts.length === 0, JSON.stringify(noConflicts));

  // ranking: pinned floats to 2.0, newer beats older, access boost lifts score
  const old = { memoryId: "a", content: "old", confidence: 0.9, createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), pinned: false };
  const fresh = { memoryId: "b", content: "new", confidence: 0.9, createdAt: new Date().toISOString(), pinned: false };
  const pinnedMem = { memoryId: "c", content: "pin", confidence: 0.1, createdAt: old.createdAt, pinned: true };
  const ranked = intel.rankMemories([old, fresh, pinnedMem]);
  assert("ranking puts pinned first", ranked[0].memoryId === "c");
  assert("ranking prefers newer memories (14-day half-life decay)", ranked[1].memoryId === "b");
  assert("access boost lifts a memory's score",
    intel.scoreMemory(old, { a: 10 }) > intel.scoreMemory(old, {}));

  // memory rules: disabling a topic filters extracted facts
  intel.setRule("health", false);
  const kept = intel.applyRules([
    { content: "User has a cold.", topic: "health" },
    { content: "User builds MCP servers.", topic: "work" },
  ]);
  assert("memory rules filter disabled topics from auto-save",
    kept.length === 1 && kept[0].topic === "work", JSON.stringify(kept));
  intel.setRule("health", true); // restore default

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error(`\nFATAL: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (mock) mock.kill();
}
