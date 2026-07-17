'use strict';
// Generic resilient TTL cache (last-known-good on refetch failure).
// Owns: the raw _cache object (exported — jellyfin.js and routes-elo.js poke
// keys directly) and the shared TTL constants. No timers.

// ── Resilient cache: fresh within `ttl`, else refetch — and CRUCIALLY, if the refetch throws
// (qBittorrent/*arr timing out while the NUC is busy) keep serving the last-known-good value
// rather than blanking. Blanking is exactly what made finished downloads flicker to a false
// "Needs attention" under load. Two payoffs: accuracy survives load spikes, and per-poll API
// calls collapse to one per TTL window no matter how many dashboard tabs are open. ────────────
const _cache = {};   // key -> { ts, val }
async function cachedFetch(key, ttl, fn, fallback) {
  const c = _cache[key];
  if (c && Date.now() - c.ts < ttl) return c.val;
  try {
    const val = await fn();
    _cache[key] = { ts: Date.now(), val };
    return val;
  } catch {
    return c ? c.val : fallback;                               // last-known-good, or the default on a cold miss
  }
}
const HIST_TTL = 20000;   // history + library hasFile: change slowly
const QUEUE_TTL = 8000;   // *arr queue + qBit torrents: change faster, but stale-on-error still beats blank

module.exports = { _cache, cachedFetch, HIST_TTL, QUEUE_TTL };
