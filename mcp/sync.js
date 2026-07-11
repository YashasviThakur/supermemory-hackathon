/**
 * Imprint — cloud sync engine (optional mirror).
 *
 * The local store (local-store.js) is always the source of truth on the client.
 * When sync is ON and a userId is configured, this module keeps DynamoDB in step
 * with the local store — bidirectionally and best-effort:
 *
 *   • Pull   cloud memories down (insert new, reconcile shared identity).
 *   • Delete cloud rows for memories deleted locally (tombstones), and refuse to
 *            resurrect a deleted memory on pull.
 *   • Push   new local memories up, then adopt the cloud's id so future
 *            deletes/pins target the same row in both places.
 *   • Pin    propagate local pin/unpin changes.
 *
 * Everything swallows network errors: offline simply means we stay local and the
 * pending work (dirty flags, tombstones) retries on the next sync. When sync is
 * OFF none of this runs, so no memory content ever leaves the machine.
 */

import {
  getTombstones,
  dropTombstone,
  setTombstoneCloudId,
  reconcileFromCloud,
  reconcileAfterPush,
  getDirty,
  getPinDirty,
  clearPinDirty,
  markSynced,
  saveConfig,
  prefixOf,
} from "./local-store.js";

const enc = encodeURIComponent;

async function apiGet(apiBase, path) {
  const res = await fetch(`${apiBase}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}
async function apiSend(apiBase, path, method, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

/**
 * Full bidirectional reconcile. Returns { pulled, pushed, deleted } (zeros on a
 * total failure). Safe to call on every startup.
 */
export async function pushPull(userId, apiBase) {
  if (!userId) return { pulled: 0, pushed: 0, deleted: 0 };
  let pulled = 0, pushed = 0, deleted = 0;

  // ── 1. Pull cloud memories ──
  let cloudMemories = [];
  let pullOk = false;
  try {
    const data = await apiGet(apiBase, `/api/memories?userId=${enc(userId)}&limit=1000`);
    cloudMemories = data.memories || [];
    pullOk = true;
  } catch { /* offline — pushes below still no-op gracefully */ }

  // ── 2. Reconcile, honoring tombstones so deletions are never resurrected ──
  const tombs = getTombstones();
  const tombById = new Map(tombs.map((t) => [t.memoryId, t]));
  const tombByPrefix = new Map(tombs.map((t) => [t.prefix, t]));
  const matchedTombKeys = new Set();
  const cloudDeleteTargets = []; // memories present in cloud but deleted locally

  if (pullOk) {
    for (const cm of cloudMemories) {
      const tomb = tombById.get(cm.memoryId) || tombByPrefix.get(prefixOf(cm.content));
      if (tomb) {
        matchedTombKeys.add(tomb.memoryId);
        // Capture the cloud identity so we can DELETE it (handles the case where
        // the local memory was pushed without learning its cloud id).
        if (tomb.memoryId !== cm.memoryId || tomb.createdAt !== cm.createdAt) {
          setTombstoneCloudId(tomb.memoryId, cm.memoryId, cm.createdAt);
        }
        cloudDeleteTargets.push({ key: cm.memoryId, memoryId: cm.memoryId, createdAt: cm.createdAt });
        continue; // do NOT insert a memory the user deleted
      }
      if (reconcileFromCloud(cm) === "inserted") pulled++;
    }
  }

  // ── 3. Propagate deletions to the cloud ──
  for (const d of cloudDeleteTargets) {
    try {
      await apiSend(apiBase, `/api/memories?userId=${enc(userId)}&memoryId=${enc(d.memoryId)}&createdAt=${enc(d.createdAt)}`, "DELETE");
      dropTombstone(d.key);
      deleted++;
    } catch { /* retry next sync */ }
  }
  // Tombstones never seen in the cloud during a good pull → the memory isn't in
  // the cloud, so the deletion is fully settled; drop them.
  if (pullOk) {
    for (const t of tombs) {
      if (!matchedTombKeys.has(t.memoryId)) dropTombstone(t.memoryId);
    }
  }

  // ── 4. Push local changes ──
  // A row already in the cloud (_synced) that's dirty is an EDIT → PATCH the
  // existing row. A never-synced dirty row is NEW → POST (and adopt its id).
  for (const m of getDirty()) {
    try {
      if (m._synced && m.createdAt) {
        await apiSend(apiBase, "/api/memories", "PATCH", {
          userId, memoryId: m.memoryId, createdAt: m.createdAt,
          content: m.content, topic: m.topic, pinned: m.pinned,
        });
        markSynced([m.memoryId]);
        clearPinDirty(m.memoryId);
      } else {
        const res = await apiSend(apiBase, "/api/memories", "POST", {
          userId, content: m.content, topic: m.topic, pinned: m.pinned, source: m.source || "local",
        });
        if (res && res.memory) reconcileAfterPush(m.memoryId, res.memory);
        else markSynced([m.memoryId]);
      }
      pushed++;
    } catch { /* keep _dirty for the next sync */ }
  }

  // ── 5. Propagate pin/unpin changes ──
  for (const m of getPinDirty()) {
    try {
      await apiSend(apiBase, "/api/memories", "PATCH", {
        userId, memoryId: m.memoryId, createdAt: m.createdAt, pinned: m.pinned,
      });
      clearPinDirty(m.memoryId);
    } catch { /* retry next sync */ }
  }

  if (pulled || pushed || deleted) saveConfig({ lastSyncAt: new Date().toISOString() });
  return { pulled, pushed, deleted };
}

/**
 * Fetch the user's sync preference from the cloud profile and cache it locally.
 * Sends only the userId (no memory content) — it's how a machine learns the
 * website toggle was flipped. Returns the resolved value, or undefined if the
 * network call failed (caller should fall back to the cached config).
 */
export async function refreshSyncFlag(userId, apiBase) {
  if (!userId) return undefined;
  try {
    const user = await apiGet(apiBase, `/api/user?userId=${enc(userId)}`);
    const enabled = user.syncEnabled !== false; // default ON
    saveConfig({ userId, syncEnabled: enabled });
    return enabled;
  } catch {
    return undefined;
  }
}

/**
 * Mirror a single freshly-saved memory to the cloud and adopt the cloud id so a
 * later delete/pin targets the same row. Returns the API response (with any
 * contradiction warnings) or null on failure.
 */
export async function mirrorSave(userId, apiBase, localMemory) {
  if (!userId || !localMemory) return null;
  try {
    const res = await apiSend(apiBase, "/api/memories", "POST", {
      userId,
      content: localMemory.content,
      topic: localMemory.topic,
      pinned: localMemory.pinned,
      source: localMemory.source || "local",
    });
    if (res && res.memory) reconcileAfterPush(localMemory.memoryId, res.memory);
    return res;
  } catch {
    return null; // _dirty stays set; next pushPull retries
  }
}

/** Mirror a single delete to the cloud immediately; tombstone covers retries. */
export async function mirrorDelete(userId, apiBase, deleted) {
  if (!userId || !deleted || !deleted.createdAt) return false;
  try {
    await apiSend(apiBase, `/api/memories?userId=${enc(userId)}&memoryId=${enc(deleted.memoryId)}&createdAt=${enc(deleted.createdAt)}`, "DELETE");
    dropTombstone(deleted.memoryId);
    return true;
  } catch {
    return false; // tombstone remains; pushPull retries
  }
}

/** Mirror a single content/topic edit to the cloud immediately (PATCH). */
export async function mirrorUpdate(userId, apiBase, memory) {
  if (!userId || !memory || !memory.createdAt) return false;
  try {
    await apiSend(apiBase, "/api/memories", "PATCH", {
      userId, memoryId: memory.memoryId, createdAt: memory.createdAt,
      content: memory.content, topic: memory.topic,
    });
    markSynced([memory.memoryId]);
    return true;
  } catch {
    return false; // _dirty remains; pushPull retries
  }
}

/** Mirror a single pin/unpin to the cloud immediately. */
export async function mirrorPin(userId, apiBase, memory) {
  if (!userId || !memory || !memory.createdAt) return false;
  try {
    await apiSend(apiBase, "/api/memories", "PATCH", {
      userId, memoryId: memory.memoryId, createdAt: memory.createdAt, pinned: memory.pinned,
    });
    clearPinDirty(memory.memoryId);
    return true;
  } catch {
    return false; // _pinDirty remains; pushPull retries
  }
}
