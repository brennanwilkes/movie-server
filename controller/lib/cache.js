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

// SINGLE-FLIGHT. key -> in-flight promise, so N simultaneous misses share ONE fetch.
//
// Without this, concurrent callers each ran `fn()`. On a cheap key that is just waste; on the
// expensive ones it is a stampede that makes the very thing it is waiting for slower. Measured
// on 2026-09-08 from the TV telemetry: three `controller_rows_failed` (SocketTimeoutException,
// 8s) landed inside ONE second at 04:30, because each Fire Stick request to /api/hss/rows kicked
// off its own copy of the ~11s BoxSet catalog query instead of joining the one already running.
// 7 of 29 home builds that week fell back to the slow client-side path for this reason, and the
// worst home build took 43s.
const _inflight = new Map();

// `opts.serveStale` — return the previous value IMMEDIATELY on a stale (not cold) hit and let the
// refresh finish in the background. Opt-in per call site, because for most keys a caller asking
// past the TTL wants the new number; it is right only where staleness is explicitly harmless and
// latency is not (the shelf catalog on the TV's splash path).
async function cachedFetch(key, ttl, fn, fallback, opts = {}) {
  const c = _cache[key];
  if (c && Date.now() - c.ts < ttl) return c.val;

  let p = _inflight.get(key);
  if (!p) {
    p = (async () => {
      const val = await fn();
      _cache[key] = { ts: Date.now(), val };
      return val;
    })();
    // Cleared from the OUTSIDE, so the entry is gone by the time any awaiting caller resumes and
    // the next miss starts a fresh fetch. `then(clear, clear)` and not `finally(clear)`: finally
    // returns a derived promise that re-raises the rejection, which would be an unhandled one.
    const clear = () => { if (_inflight.get(key) === p) _inflight.delete(key); };
    p.then(clear, clear);
    _inflight.set(key, p);
  }

  if (opts.serveStale && c) {
    p.catch(() => {});   // the refresh is nobody's `await` now; don't let a failure go unhandled
    return c.val;
  }
  try {
    return await p;
  } catch {
    return c ? c.val : fallback;                               // last-known-good, or the default on a cold miss
  }
}
const HIST_TTL = 20000;   // history + library hasFile: change slowly
const QUEUE_TTL = 8000;   // *arr queue + qBit torrents: change faster, but stale-on-error still beats blank

module.exports = { _cache, cachedFetch, HIST_TTL, QUEUE_TTL };
