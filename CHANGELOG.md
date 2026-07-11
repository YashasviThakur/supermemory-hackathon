# Changelog

All notable changes to Imprint are documented here. Format roughly follows
[Keep a Changelog](https://keepachangelog.com/); versions use SemVer.

## [0.3.0] — Hybrid, local-first

Imprint is now **local-first**. The MCP server and Stop hook read and write an
on-device store and work fully offline with no account. Cloud sync (DynamoDB)
becomes an **optional, per-user mirror** controlled by a dashboard toggle — turn
it off and nothing ever leaves your machine.

### Added
- **Local store** at `~/.imprint` (zero-dependency JSON) — the source of truth on
  each machine; instant and works offline. `IMPRINT_USER_ID` is now optional;
  omit it to run 100% locally.
- **Cloud-sync toggle** — per-user "Sync on / Local only" pill in the dashboard,
  backed by `syncEnabled` on the user profile (`GET`/`PATCH /api/user`). The MCP
  server live-refreshes the flag, so flipping it takes effect without restarting
  the IDE.
- **Bidirectional, convergent sync** — new memories, edits, pins, and deletes
  propagate both ways. Cloud-id reconciliation; tombstones so deletes stick and
  are never resurrected by a later pull; a pending local edit is never clobbered.
- **New MCP tools** — `update_memory` (edit content/topic in place; syncs as a
  PATCH, no duplicate) and `sync_status` (mode, counts, pending, last sync).
- **Encryption at rest (optional)** — AES-256-GCM for the local store via
  `IMPRINT_ENCRYPTION_KEY` (scrypt-derived key, per-file salt+IV, auto-migration;
  refuses to read on a wrong/missing key rather than risk data loss).
- **On-device semantic search (optional)** — `IMPRINT_LOCAL_EMBED` enables
  transformers.js + `all-MiniLM-L6-v2` (CPU, no API key). Cloud (Jina) semantic
  search is still used in hybrid mode online.
- **Hybrid retrieval** — local search now uses BM25-lite lexical ranking
  (IDF-weighted, length-normalized) fused with embedding similarity via Reciprocal
  Rank Fusion. BM25 is the default even without embeddings (much better than naive
  keyword overlap); embeddings fuse in when enabled.
- **Test suite** — `cd mcp && npm test` (58 assertions: concurrency, encryption,
  tombstones, bidirectional edit sync), plus validation end-to-end against the
  live API.

### Changed
- All MCP tools read/write the local store first; the cloud is mirrored only when
  sync is on.
- Cross-process-safe writes via a file lock shared by the server and the Stop
  hook, with Windows `EPERM`/`EACCES`/`EBUSY` retry; the Stop hook now batches its
  writes into a single read-modify-write per turn.
- README and architecture docs rewritten around the local-first model.

### Security
- Memory content can stay entirely on-device (sync off) and encrypted at rest.

## [0.1.0]
- Initial release — cloud-backed (DynamoDB) persistent memory across MCP-capable
  IDEs, the web dashboard, and an enterprise org pool.
