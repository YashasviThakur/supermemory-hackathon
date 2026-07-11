/**
 * Intelligence layer — the Imprint features that used to live in the cloud
 * API (DynamoDB + Jina + Vercel), rebuilt locally on top of Supermemory:
 *
 *  1. Contradiction detection — candidate facts come from Supermemory's own
 *     semantic search (it already ranks by similarity, replacing the old
 *     Jina-cosine selection), then a strict "could both be true at once?"
 *     LLM check (Groq) confirms genuine conflicts.
 *  2. Ranking — pinned first (2.0), then confidence × recency decay
 *     (14-day half-life) × access boost (up to +50%), same formula as
 *     lib/rank.ts. Access counts are tracked in a local JSON file.
 *  3. Memory rules — per-topic auto-save switches in a local config file,
 *     honored by the Stop-hook extractor and editable via an MCP tool.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { searchMemories } from "./supermemory-store.js";

const CONFIG_DIR = join(homedir(), ".imprint-supermemory");
const RULES_FILE = join(CONFIG_DIR, "rules.json");
const ACCESS_FILE = join(CONFIG_DIR, "access.json");

export const TOPICS = ["work", "personal", "preferences", "projects", "health", "relationships", "general"];

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJson(file, data) {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch { /* best-effort */ }
}

// ── 1. Contradiction detection ────────────────────────────

const GROQ_BASE = process.env.GROQ_BASE_URL || "https://api.groq.com";
const GROQ_KEY = process.env.GROQ_API_KEY;

const CONTRADICTION_SYSTEM = `You decide whether two facts about the same person are a genuine CONTRADICTION — two statements that CANNOT both be true at the same time.

Return JSON only: { "contradicts": boolean, "reason": string, "confidence": number }

THE TEST: Could both statements be true simultaneously? If yes → contradicts: false.

CONTRADICTIONS (true) — one statement makes the other impossible:
- "uses React" vs "switched to Vue and no longer uses React" → true
- "is a full-time student" vs "works full-time as an engineer" → true
- "prefers dark mode" vs "prefers light mode" → true
- "the deadline is June 29" vs "the deadline is July 5" → true

NOT contradictions (false) — both can be true together; do NOT flag these:
- "working with a Claude plugin" vs "having issues with Claude Code" → false (you can use something AND have problems with it)
- "building project X" vs "fixed a bug in project X" → false (working on it includes hitting problems)
- "uses TypeScript" vs "is learning Rust" → false (can do both)
- "building project A" vs "also building project B" → false (additions, not conflicts)
- one fact adds detail to the other, or describes a problem/task/activity → false
- the same fact worded differently → false

Be STRICT. A problem, an update, an addition, a task, or extra detail is NOT a contradiction. Only flag a true logical conflict where one fact directly negates the other. When unsure, answer false.

"reason" must be one short human-readable sentence, e.g. "You said you use React, but this says you switched to Vue."`;

async function checkContradiction(newContent, existingContent) {
  try {
    const res = await fetch(`${GROQ_BASE}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: CONTRADICTION_SYSTEM },
          { role: "user", content: `Fact A (new): "${newContent}"\nFact B (stored): "${existingContent}"` },
        ],
        temperature: 0,
        max_tokens: 120,
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) return { contradicts: false, reason: "", confidence: 0 };
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    return {
      contradicts: !!parsed.contradicts,
      reason: String(parsed.reason ?? ""),
      confidence: Number(parsed.confidence) || 0.8,
    };
  } catch {
    return { contradicts: false, reason: "", confidence: 0 };
  }
}

const TOP_K = 5;        // most-similar candidates checked per new fact
const SIM_FLOOR = 0.3;  // below this similarity, don't bother asking the LLM
const SAME_FACT = 0.95; // at/above this it's the same fact reworded, not a conflict

/**
 * Check a just-saved fact against its most semantically similar existing
 * memories (across ALL topics). Candidate selection is Supermemory's search —
 * exactly the job embeddings used to do. Returns confirmed conflicts only
 * (LLM confidence ≥ 0.7); empty array when no GROQ key or nothing conflicts.
 */
export async function detectContradictions(newContent) {
  if (!GROQ_KEY || GROQ_KEY === "gsk_YOUR_GROQ_KEY_HERE") return [];
  let candidates;
  try {
    candidates = (await searchMemories(newContent, { limit: TOP_K + 3, rerank: false }))
      .filter((m) => {
        const sim = m.similarity ?? 0;
        return sim >= SIM_FLOOR && sim < SAME_FACT && m.content !== newContent;
      })
      .slice(0, TOP_K);
  } catch {
    return [];
  }

  const hits = [];
  await Promise.all(
    candidates.map(async (m) => {
      const check = await checkContradiction(newContent, m.content);
      if (check.contradicts && check.confidence >= 0.7) {
        hits.push({
          existingMemoryId: m.memoryId,
          existingMemoryContent: m.content,
          explanation: check.reason,
          confidence: check.confidence,
        });
      }
    })
  );
  return hits;
}

// ── 2. Ranking — recency decay + access boost ─────────────

// Decay constant: half-life ≈ 14 days (e^(-0.05 × 14) ≈ 0.5)
const LAMBDA = 0.05;

function accessCounts() {
  return readJson(ACCESS_FILE, {});
}

/** Record that these memories were injected into a session (access boost). */
export function recordAccess(memories) {
  if (!memories.length) return;
  const counts = accessCounts();
  for (const m of memories) {
    if (m.memoryId) counts[m.memoryId] = (counts[m.memoryId] || 0) + 1;
  }
  // Cap the file at the 500 most-used ids so it never grows unbounded.
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 500);
  writeJson(ACCESS_FILE, Object.fromEntries(entries));
}

// Pinned memories always float to the top with score 2.0.
// Unpinned: confidence × recency_decay × (1 + access_boost)
export function scoreMemory(memory, counts = accessCounts()) {
  if (memory.pinned) return 2.0;
  const daysOld = (Date.now() - new Date(memory.createdAt || Date.now()).getTime()) / 86_400_000;
  const recencyDecay = Math.exp(-LAMBDA * daysOld);
  const accessBoost = Math.min((counts[memory.memoryId] || 0) / 10, 0.5);
  return (memory.confidence ?? 0.8) * recencyDecay * (1 + accessBoost);
}

export function rankMemories(memories) {
  const counts = accessCounts();
  return [...memories].sort((a, b) => scoreMemory(b, counts) - scoreMemory(a, counts));
}

// ── 3. Memory rules — per-topic auto-save switches ────────

/** { topics: { work: true, ... } } — a missing file/topic means enabled. */
export function loadRules() {
  const raw = readJson(RULES_FILE, { topics: {} });
  const topics = {};
  for (const t of TOPICS) topics[t] = raw.topics?.[t] !== false;
  return { topics };
}

export function setRule(topic, enabled) {
  const rules = loadRules();
  rules.topics[topic] = !!enabled;
  writeJson(RULES_FILE, rules);
  return rules;
}

/** Filter extracted facts down to topics the user has left enabled. */
export function applyRules(facts) {
  const { topics } = loadRules();
  return facts.filter((f) => topics[f.topic] !== false);
}

export { RULES_FILE };
