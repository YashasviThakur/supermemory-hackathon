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

const here = dirname(fileURLToPath(import.meta.url));

const store = await import("./supermemory-store.js");

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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error(`\nFATAL: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (mock) mock.kill();
}
