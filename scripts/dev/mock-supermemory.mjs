#!/usr/bin/env node

/**
 * Dev-only mock of Supermemory Local for machines that can't run the real
 * binary (it ships for macOS/Linux only). Implements just the endpoints
 * Imprint uses — POST /v4/memories, /v4/search, /v4/memories/list,
 * DELETE/PATCH /v4/memories, POST /v3/documents — with an in-memory store and
 * naive keyword similarity. NOT part of the product: for the real thing run
 * `npx supermemory local`, which serves the same API at localhost:6767.
 *
 * Usage: node scripts/dev/mock-supermemory.mjs [port]
 */

import http from "http";
import crypto from "crypto";

const PORT = Number(process.argv[2]) || 6767;

/** entries: id → { id, memory, metadata, isStatic, isLatest, isForgotten, version, containerTag, createdAt, updatedAt, history } */
const entries = new Map();

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function tokenize(s) {
  return new Set(String(s).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

function similarity(q, text) {
  const a = tokenize(q), b = tokenize(text);
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / a.size;
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const routes = {
  "POST /v4/memories": (body) => {
    const created = [];
    for (const m of body.memories || []) {
      const id = uid();
      const entry = {
        id,
        memory: m.content,
        metadata: m.metadata || {},
        isStatic: !!m.isStatic,
        isLatest: true,
        isForgotten: false,
        version: 1,
        containerTag: body.containerTag,
        createdAt: now(),
        updatedAt: now(),
        history: [],
      };
      entries.set(id, entry);
      created.push({ id });
    }
    return [200, { memories: created, count: created.length }];
  },

  "POST /v4/search": (body) => {
    const results = [...entries.values()]
      .filter((e) => e.isLatest && !e.isForgotten && (!body.containerTag || e.containerTag === body.containerTag))
      .map((e) => ({
        id: e.id,
        memory: e.memory,
        metadata: e.metadata,
        updatedAt: e.updatedAt,
        createdAt: e.createdAt,
        isStatic: e.isStatic,
        similarity: similarity(body.q, e.memory),
        version: e.version,
      }))
      .filter((r) => r.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, body.limit || 10);
    return [200, { results, timing: 1, total: results.length }];
  },

  "POST /v4/memories/list": (body) => {
    const tags = body.containerTags || [];
    const all = [...entries.values()]
      .filter((e) => e.isLatest && (!tags.length || tags.includes(e.containerTag)))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const limit = body.limit || 60;
    const page = body.page || 1;
    const slice = all.slice((page - 1) * limit, page * limit);
    return [200, {
      memoryEntries: slice.map((e) => ({ ...e, history: e.history })),
      pagination: { currentPage: page, limit, totalItems: all.length, totalPages: Math.ceil(all.length / limit) },
    }];
  },

  "DELETE /v4/memories": (body) => {
    const e = entries.get(body.id);
    if (!e) return [404, { error: "memory not found" }];
    e.isForgotten = true;
    e.updatedAt = now();
    return [200, { success: true }];
  },

  "PATCH /v4/memories": (body) => {
    const e = entries.get(body.id);
    if (!e) return [404, { error: "memory not found" }];
    e.history.push({ id: e.id, memory: e.memory, version: e.version, createdAt: e.createdAt, updatedAt: e.updatedAt });
    if (body.content !== undefined) e.memory = body.content;
    if (body.isStatic !== undefined) e.isStatic = !!body.isStatic;
    if (body.metadata) e.metadata = { ...e.metadata, ...body.metadata };
    e.version += 1;
    e.updatedAt = now();
    return [200, { id: e.id, version: e.version }];
  },

  "POST /v3/documents": (body) => {
    // Real Supermemory extracts memories from the document; the mock just
    // stores one memory per non-empty line that looks like a user statement.
    const id = uid();
    const derived = String(body.content || "")
      .split("\n")
      .filter((l) => /^user:/i.test(l.trim()))
      .slice(0, 5);
    for (const line of derived) {
      const mid = uid();
      entries.set(mid, {
        id: mid,
        memory: line.replace(/^user:\s*/i, ""),
        metadata: { ...(body.metadata || {}), derivedFromDocument: id },
        isStatic: false, isLatest: true, isForgotten: false, version: 1,
        containerTag: body.containerTag, createdAt: now(), updatedAt: now(), history: [],
      });
    }
    return [200, { id, status: "queued" }];
  },
};

const server = http.createServer(async (req, res) => {
  const key = `${req.method} ${req.url.split("?")[0]}`;
  const handler = routes[key];
  if (!handler) return json(res, 404, { error: `no route: ${key}` });
  try {
    const body = await readBody(req);
    const [code, out] = handler(body);
    json(res, code, out);
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`[mock-supermemory] listening on http://localhost:${PORT} (dev mock — run \`npx supermemory local\` for the real server)`);
});
