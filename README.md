# Imprint × Supermemory Local

> Persistent memory for every AI coding agent — with **Supermemory Local (`localhost:6767`)** as the memory engine.

Built for the **[Localhost:6767 hackathon](https://instinctive-chance-ed9.notion.site/Localhost-6767-392222a60c568030ab86e7729d765bbe)** — Supermemory's first hackathon, celebrating running the entire memory layer on your own machine.

## What it does

Your AI coding assistant forgets you the moment a session ends. Imprint fixes that: an MCP server plus Claude Code hooks that silently extract the durable facts from your sessions, store them, and inject the relevant ones back at the start of the next session — across Claude Code, Cursor, Codex, and any MCP-capable agent.

In this project, the entire storage/retrieval brain is **Supermemory Local**:

- **Every memory lives in Supermemory** at `http://localhost:6767` — embeddings, semantic search, versioning, and de-duplication all happen on your machine. No AWS, no Jina, no cloud database. Nothing leaves your laptop.
- **8 MCP tools** (`get_memories`, `save_memory`, `search_memories`, `delete_memory`, `pin_memory`, `update_memory`, `summarize_session`, `sync_status`) are thin veneers over Supermemory's `/v4/memories` and `/v4/search` APIs.
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

10 end-to-end assertions covering save, batch save, list, semantic search, versioned update, pin round-trip, forget, transcript ingestion, and status. The suite runs against `SUPERMEMORY_TEST_URL` if set; otherwise it spins up `scripts/dev/mock-supermemory.mjs` — a tiny dev stand-in for the Local API used on machines that can't run the real binary (it ships for macOS/Linux only).

## What's in the repo

- `mcp/` — the Supermemory-backed MCP server, Stop-hook extractor, store client, and tests (**the hackathon integration lives here**)
- `app/`, `lib/` — Imprint's original Next.js dashboard (memory graph, analytics), from the pre-existing [Imprint](https://github.com/yashasvithakur/imprint) project
- `scripts/dev/mock-supermemory.mjs` — dev-only mock of the Local API for Windows development

## Provenance

This project builds on [Imprint](https://github.com/yashasvithakur/imprint), my existing open-source memory layer (pre-dates the hackathon). **Written fresh during the build window (July 9–13):** the entire Supermemory integration — `mcp/supermemory-store.js`, the rewritten `mcp/server.js`, the rewired `mcp/extract-and-save.js`, the mock server, and the test suite — replacing Imprint's DynamoDB + Jina + custom retrieval stack with Supermemory Local.

## License

MIT
