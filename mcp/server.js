#!/usr/bin/env node

/**
 * Imprint MCP server — powered by Supermemory Local.
 *
 * Every tool below is a thin veneer over a Supermemory server. By default that
 * server is Supermemory Local at http://localhost:6767 — one binary running on
 * this machine, so embeddings, storage, versioning, and semantic search all
 * happen locally and nothing leaves the laptop. Set SUPERMEMORY_BASE_URL to
 * https://api.supermemory.ai (+ SUPERMEMORY_API_KEY) to run the exact same
 * code against the cloud.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  BASE_URL,
  CONTAINER_TAG,
  IS_LOCAL,
  saveMemory,
  saveMemories,
  searchMemories,
  listMemories,
  deleteMemory,
  updateMemory,
  status,
} from "./supermemory-store.js";
import {
  detectContradictions,
  rankMemories,
  recordAccess,
  loadRules,
  setRule,
  RULES_FILE,
} from "./intelligence.js";

const PLATFORM = process.env.IMPRINT_PLATFORM || "claude-code";

// ── Context optimizer (token-budget trim, pinned first) ───
function optimize(memories, budget) {
  const pinned = memories.filter((m) => m.pinned);
  const rest = memories.filter((m) => !m.pinned);
  const out = [...pinned];
  let tokens = pinned.reduce((a, m) => a + Math.ceil((m.content || "").length / 4), 0);
  for (const m of rest) {
    const t = Math.ceil((m.content || "").length / 4);
    if (tokens + t > budget) break;
    out.push(m);
    tokens += t;
  }
  return out;
}

function format(memories) {
  if (!memories.length) return "No memories found.";
  const pinned = memories.filter((m) => m.pinned);
  const rest = memories.filter((m) => !m.pinned);
  let out = "";
  if (pinned.length) {
    out += "📌 PINNED (always remember):\n";
    out += pinned.map((m) => `  • [${m.topic}] ${m.content}`).join("\n") + "\n\n";
  }
  const byTopic = rest.reduce((a, m) => { (a[m.topic] = a[m.topic] || []).push(m); return a; }, {});
  for (const [t, ms] of Object.entries(byTopic)) {
    out += `${t.toUpperCase()}:\n`;
    out += ms.map((m) => `  • ${m.content}`).join("\n") + "\n";
  }
  return out.trim();
}

// ── Startup ───────────────────────────────────────────────
try {
  const s = await status();
  console.error(
    `[Imprint MCP] ✓ Ready — Supermemory ${s.local ? "Local" : "Cloud"} at ${s.baseUrl} ` +
    `(${s.latencyMs}ms). Space "${s.containerTag}": ${s.total} memories (${s.pinned} pinned).`
  );
} catch (e) {
  console.error(
    `[Imprint MCP] ⚠ ${e.message}\n` +
    `[Imprint MCP] Tools will keep retrying — memories flow as soon as the server is up.`
  );
}

// ── MCP Server ────────────────────────────────────────────

const server = new McpServer({ name: "imprint", version: "3.0.0" });

server.tool(
  "get_memories",
  "Retrieve stored memories about the user. Call at the start of every conversation. ALWAYS pass `query` = the user's first message so semantic search returns relevant memories, not just recent ones. Pass `optimize=true` to fit a token budget.",
  {
    topic: z.enum(["work","personal","preferences","projects","health","relationships","general","all"]).optional(),
    limit: z.number().optional(),
    query: z.string().optional().describe("REQUIRED for relevance: pass the user's first message or current task. Runs semantic search on Supermemory — returns memories ranked by relevance, not recency."),
    optimize: z.boolean().optional().describe("Trim memories to fit a token budget (default 2000 tokens). Pinned memories are always included first."),
    budget: z.number().optional().describe("Token budget when optimize=true. Default: 2000."),
  },
  async ({ topic, limit = 60, query, optimize: opt = false, budget = 2000 }) => {
    try {
      let memories;
      if (query) {
        memories = await searchMemories(query, { limit: Math.min(limit, 20) });
        // Pinned facts must survive relevance filtering — merge them in.
        const pinned = (await listMemories({ limit: 200 })).filter((m) => m.pinned);
        const seen = new Set(memories.map((m) => m.memoryId));
        memories = [...pinned.filter((m) => !seen.has(m.memoryId)), ...memories];
      } else {
        // No query → rank by pinned > confidence × recency decay × access boost.
        memories = rankMemories(await listMemories({ limit: 200 }));
        if (topic && topic !== "all") memories = memories.filter((m) => m.topic === topic);
        memories = opt ? optimize(memories, budget) : memories.slice(0, limit);
      }
      recordAccess(memories);
      const pinCount = memories.filter((m) => m.pinned).length;
      const header = query
        ? `${memories.length} relevant memories for "${query}" (${pinCount} pinned):\n\n`
        : opt
        ? `${memories.length} memories within ~${budget}-token budget (${pinCount} pinned):\n\n`
        : `${memories.length} memories (${pinCount} pinned):\n\n`;
      return { content: [{ type: "text", text: header + format(memories) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "save_memory",
  "Save a durable fact about the user. Call PROACTIVELY — the moment you learn anything worth recalling in a future session: their name, role, tech stack, projects, goals, deadlines, preferences, or decisions. Don't wait until the end of the conversation; save as soon as the fact appears. Supermemory de-duplicates and versions saves server-side, so re-saving something already known is safe and cheap.",
  {
    content: z.string().describe("The fact to remember — a single, self-contained sentence (e.g. 'The user is building Imprint, a persistent memory layer')."),
    topic: z.enum(["work","personal","preferences","projects","health","relationships","general"]),
    pinned: z.boolean().optional().describe("Pin to inject into EVERY future session regardless of relevance. Use for always-true essentials: name, main project, key preferences. Pinned memories are stored as static (permanent) facts."),
  },
  async ({ content, topic, pinned = false }) => {
    try {
      // Contradiction candidates must not include the fact itself — check first.
      const contradictions = await detectContradictions(content);
      await saveMemory({ content, topic, pinned, source: PLATFORM });
      let text = `✅ Saved: [${topic}] ${content}${pinned ? " 📌" : ""}`;
      if (contradictions.length) {
        text += `\n\n⚠️ This may contradict ${contradictions.length} existing memor${contradictions.length === 1 ? "y" : "ies"}:`;
        for (const c of contradictions) text += `\n  • "${c.existingMemoryContent}" — ${c.explanation}`;
        text += `\n\nTell me which is correct and I'll update or delete the stale one.`;
      }
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "search_memories",
  "Search memories by natural language, semantically ranked by Supermemory. ALWAYS call this BEFORE answering any personal question about the user (health, job, preferences, past decisions, what they're working on) — never answer such questions from assumptions. Also call it when the conversation shifts to a topic the session-start memories didn't cover.",
  { query: z.string().describe("Natural language query — pass the user's question verbatim, e.g. 'what frameworks does the user prefer?' or 'what is the user building?'") },
  async ({ query }) => {
    try {
      const results = await searchMemories(query, { limit: 10 });
      if (!results.length) return { content: [{ type: "text", text: `No memories found for "${query}".` }] };
      recordAccess(results);
      return { content: [{ type: "text", text: `${results.length} results for "${query}":\n\n${format(results)}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "delete_memory",
  "Delete (forget) a memory. Use when the user asks you to forget something.",
  { memoryId: z.string() },
  async ({ memoryId }) => {
    try {
      await deleteMemory(memoryId);
      return { content: [{ type: "text", text: "✅ Memory forgotten." }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "pin_memory",
  "Pin or unpin a memory. Pinned memories are stored as static (permanent) facts and injected into every session.",
  { memoryId: z.string(), pinned: z.boolean() },
  async ({ memoryId, pinned }) => {
    try {
      await updateMemory(memoryId, { pinned });
      return { content: [{ type: "text", text: `✅ Memory ${pinned ? "📌 pinned" : "unpinned"}.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "summarize_session",
  "Save what was learned this conversation as memories. Call at the end of any session where you learned important facts about the user.",
  {
    key_facts: z.array(z.string()).describe("Specific facts to save as individual memories — one sentence each, max 8."),
    summary: z.string().optional().describe("Optional free-text summary — saved as a single memory if no key_facts provided."),
  },
  async ({ key_facts = [], summary }) => {
    try {
      const facts = key_facts.length ? key_facts.slice(0, 8) : (summary ? [summary] : []);
      if (!facts.length) {
        return { content: [{ type: "text", text: "No facts provided — nothing saved." }] };
      }
      await saveMemories(facts.map((f) => ({ content: f, topic: "general", source: "session-summary" })));
      return {
        content: [{
          type: "text",
          text: `✅ Session saved: ${facts.length} memor${facts.length === 1 ? "y" : "ies"} sent to Supermemory.\n${facts.map((f) => `  • ${f}`).join("\n")}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "update_memory",
  "Correct or rewrite an existing memory's content or topic (e.g. the user says 'actually, change that to…'). Supermemory versions the edit — the old value stays in the memory's history instead of being lost.",
  {
    memoryId: z.string(),
    content: z.string().optional().describe("New content for the memory."),
    topic: z.enum(["work","personal","preferences","projects","health","relationships","general"]).optional(),
  },
  async ({ memoryId, content, topic }) => {
    try {
      await updateMemory(memoryId, { content, topic });
      return { content: [{ type: "text", text: `✅ Updated${content ? `: ${content}` : ""} (previous version kept in history).` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "memory_rules",
  "View or change which topics are auto-saved by the memory extraction hook. Call with no arguments to see the current rules; pass topic + enabled to flip one (e.g. the user says 'stop saving health stuff').",
  {
    topic: z.enum(["work","personal","preferences","projects","health","relationships","general"]).optional(),
    enabled: z.boolean().optional().describe("Required when topic is given: true = auto-save this topic, false = never auto-save it."),
  },
  async ({ topic, enabled }) => {
    try {
      const rules = topic !== undefined && enabled !== undefined ? setRule(topic, enabled) : loadRules();
      const lines = Object.entries(rules.topics).map(([t, on]) => `  ${on ? "✅" : "🚫"} ${t}`);
      const header = topic !== undefined && enabled !== undefined
        ? `✅ Auto-save for "${topic}" turned ${enabled ? "ON" : "OFF"}.\n\n`
        : "";
      return { content: [{ type: "text", text: `${header}Auto-save rules (${RULES_FILE}):\n${lines.join("\n")}\n\nExplicit save_memory calls always work — rules only gate the automatic Stop-hook extraction.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "sync_status",
  "Report where Imprint stores memories and the connection state. Use when the user asks whether their memories are local, where their data lives, or whether the memory server is up.",
  {},
  async () => {
    try {
      const s = await status();
      const lines = [
        `Engine: Supermemory ${s.local ? "Local — everything stays on this machine" : "Cloud"}`,
        `Server: ${s.baseUrl} (reachable, ${s.latencyMs}ms)`,
        `Space: ${s.containerTag}`,
        `Memories: ${s.total} (${s.pinned} pinned)`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) {
      return {
        content: [{
          type: "text",
          text: `Engine: Supermemory (${BASE_URL}, space "${CONTAINER_TAG}") — NOT reachable.\n${e.message}${IS_LOCAL ? "\nStart it with: npx supermemory local" : ""}`,
        }],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
