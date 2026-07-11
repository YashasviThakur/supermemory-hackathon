# Imprint MCP Server — Supermemory edition

Persistent memory for AI coding agents, with **Supermemory Local** (`localhost:6767`) as the memory engine.

## Setup

```bash
# 1. Start Supermemory Local (macOS/Linux; Windows via WSL)
npx supermemory local        # note the sm_... API key it prints on first boot

# 2. Install deps
cd mcp && npm install
```

### Claude Code

```bash
claude mcp add imprint -e SUPERMEMORY_API_KEY=sm_... -- node /absolute/path/to/mcp/server.js
```

### Claude Desktop / Cursor / any MCP client

```json
{
  "mcpServers": {
    "imprint": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/server.js"],
      "env": { "SUPERMEMORY_API_KEY": "sm_..." }
    }
  }
}
```

### Stop hook (guaranteed capture, Claude Code)

Registers extraction after every assistant response — facts are saved even when the model never calls `save_memory`. In `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/mcp/extract-and-save.js" }] }]
  }
}
```

## Tools

| Tool | Description |
|---|---|
| `get_memories` | Fetch relevant memories (call at session start with `query`) — ranked pinned-first, recency-decayed, access-boosted |
| `save_memory` | Save a fact; checks it against similar existing memories and warns on contradictions |
| `search_memories` | Semantic search via Supermemory `/v4/search` |
| `update_memory` | Correct a memory in place — Supermemory keeps the old version in history |
| `delete_memory` | Forget a memory |
| `pin_memory` | Pin/unpin — pinned maps to Supermemory `isStatic` and is injected into every session |
| `summarize_session` | Batch-save end-of-session facts |
| `memory_rules` | View/toggle per-topic auto-save switches for the Stop hook |
| `sync_status` | Where memories live + server reachability |

## Environment

| Var | Default | Purpose |
|---|---|---|
| `SUPERMEMORY_BASE_URL` | `http://localhost:6767` | Supermemory server (cloud: `https://api.supermemory.ai`) |
| `SUPERMEMORY_API_KEY` | — | from `supermemory local` first boot |
| `SUPERMEMORY_CONTAINER_TAG` | `imprint_<username>` | memory space |
| `IMPRINT_INGEST_TRANSCRIPT` | off | `1` = also ingest raw dialogue via `/v3/documents` |
| `GROQ_API_KEY` | — | enables LLM extraction + contradiction detection (regex fallback without) |
| `GROQ_BASE_URL` | `https://api.groq.com` | point at any OpenAI-compatible endpoint (e.g. Ollama) for fully-local LLM checks |

## Tests

```bash
node test-supermemory.mjs   # 16 assertions; spins up the dev mock if no server is running
```
