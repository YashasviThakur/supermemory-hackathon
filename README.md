# Imprint × Supermemory Local

> Persistent memory for every AI coding agent — with **Supermemory Local (`localhost:6767`)** as the memory engine.

Built for the **[Localhost:6767 hackathon](https://instinctive-chance-ed9.notion.site/Localhost-6767-392222a60c568030ab86e7729d765bbe)** — Supermemory's first hackathon, celebrating running the entire memory layer on your own machine.

## What it does

Your AI coding assistant forgets you the moment a session ends. Imprint fixes that: an MCP server plus Claude Code hooks that silently extract the durable facts from your sessions, store them, and inject the relevant ones back at the start of the next session — across Claude Code, Cursor, Codex, and any MCP-capable agent.

In this project, the entire storage/retrieval brain is **Supermemory Local**:

- **Every memory lives in Supermemory** at `http://localhost:6767` — embeddings, semantic search, versioning, and de-duplication all happen on your machine. No AWS, no Jina, no cloud database. Nothing leaves your laptop.
- **9 MCP tools** (`get_memories`, `save_memory`, `search_memories`, `delete_memory`, `pin_memory`, `update_memory`, `summarize_session`, `memory_rules`, `sync_status`) are thin veneers over Supermemory's `/v4/memories` and `/v4/search` APIs.
- **Contradiction detection** — on every save, the new fact is checked against its most semantically similar existing memories. Candidate selection is Supermemory's own `/v4/search` (the job embeddings used to do), and a strict "could both be true at once?" LLM check confirms genuine conflicts: *"You said you prefer dark mode, but this says you prefer light mode."*
- **Smart ranking** — memory lists are ordered by pinned-first, then confidence × recency decay (14-day half-life) × access boost (up to +50% for frequently injected facts).
- **Memory rules** — per-topic auto-save switches (`memory_rules` tool): tell the agent "stop saving health stuff" and the extraction hook respects it.
- **Guaranteed capture**: a Claude Code Stop hook extracts facts after every response (Groq LLM with regex fallback) and batch-saves them to Supermemory — even when the model forgets to call `save_memory`. Set `IMPRINT_INGEST_TRANSCRIPT=1` and the raw dialogue is also handed to Supermemory's own extraction pipeline via `POST /v3/documents`.
- **Pinned = static.** Imprint's "pinned" memories map to Supermemory's `isStatic` permanent facts, and are merged into every retrieval so they can never be filtered out by relevance limits.
- **Versioned corrections.** "Actually, change that to…" uses `PATCH /v4/memories` — Supermemory keeps the old value in the memory's history instead of losing it.

## How Supermemory Local is used

```
Claude Code / Cursor / Codex
        │  MCP (stdio)                 Stop hook (every response)
        ▼                                      ▼
  mcp/server.js                    mcp/extract-and-save.js
        │                                      │
        └──────► mcp/supermemory-store.js ◄────┘
                            │
                            ▼
              Supermemory Local — localhost:6767
              POST /v4/memories      (save, batch save)
              POST /v4/search        (semantic retrieval, reranked)
              POST /v4/memories/list (pinned merge, status)
              PATCH/DELETE /v4/memories (versioned edit, forget)
              POST /v3/documents     (raw transcript ingestion)
```

| Imprint concept | Supermemory feature |
|---|---|
| memory content | `memories[].content` |
| pinned (never expires, always injected) | `isStatic: true` + merged into every result |
| topic / source | `metadata` |
| correction without losing history | `PATCH /v4/memories` versioning |
| de-duplication on save | server-side dedup |
| session-transcript extraction | `POST /v3/documents` ingestion pipeline |
| user/space isolation | `containerTag` |

## Quickstart

```bash
# 1. Start Supermemory Local (macOS/Linux; on Windows use WSL)
npx supermemory local          # serves http://localhost:6767, prints an API key

# 2. Install the MCP server
cd mcp && npm install

# 3. Register with Claude Code
claude mcp add imprint -e SUPERMEMORY_API_KEY=sm_... -- node /path/to/mcp/server.js

# (optional) Stop hook for guaranteed capture — see mcp/README.md
```

Talk to your agent normally. Facts about you are saved as you work; open a new session and it already knows your name, stack, project state, and what's next.

### Configuration

| Env var | Default | Purpose |
|---|---|---|
| `SUPERMEMORY_BASE_URL` | `http://localhost:6767` | Supermemory server (point at `https://api.supermemory.ai` for cloud — same code path) |
| `SUPERMEMORY_API_KEY` | — | printed by `supermemory local` on first boot |
| `SUPERMEMORY_CONTAINER_TAG` | `imprint_<username>` | memory space / isolation |
| `IMPRINT_INGEST_TRANSCRIPT` | off | `1` = also ingest raw dialogue via `/v3/documents` |
| `GROQ_API_KEY` | — | optional: LLM extraction in the Stop hook (regex fallback without it) |

## Tests

```bash
node mcp/test-supermemory.mjs
```

16 end-to-end assertions covering save, batch save, list, semantic search, versioned update, pin round-trip, forget, transcript ingestion, status, contradiction detection (flags genuine conflicts, ignores rewordings), ranking (pinned-first, recency decay, access boost), and memory rules. The suite runs against `SUPERMEMORY_TEST_URL` if set; otherwise it spins up `scripts/dev/mock-supermemory.mjs` — a tiny dev stand-in for the Local API used on machines that can't run the real binary (it ships for macOS/Linux only).

## What's in the repo

- `mcp/server.js` — the MCP server: 9 memory tools over Supermemory
- `mcp/supermemory-store.js` — the Supermemory API client (`/v4/memories`, `/v4/search`, `/v3/documents`)
- `mcp/intelligence.js` — contradiction detection, ranking (recency decay + access boost), memory rules
- `mcp/extract-and-save.js` — Claude Code Stop hook: guaranteed fact extraction after every response
- `mcp/test-supermemory.mjs` — 16 end-to-end assertions
- `scripts/dev/mock-supermemory.mjs` — dev-only mock of the Local API for Windows development

## Provenance

The concept and tool design come from [Imprint](https://github.com/yashasvithakur/imprint), my open-source memory layer that pre-dates the hackathon. **Built during the window (July 9–13):** the Supermemory store client, the MCP server, the intelligence layer (contradiction detection via Supermemory search, ranking, memory rules), the dev mock, and the test suite — replacing Imprint's DynamoDB + Jina + custom sync/retrieval stack with Supermemory Local as the single memory engine. The Stop-hook extractor reuses Imprint's transcript parser and extraction prompts (treated as boilerplate, per the rules), rewired to save into Supermemory. Nothing else from Imprint — no dashboard, no hosted API, no local store — ships in this repo.

## License

MIT
