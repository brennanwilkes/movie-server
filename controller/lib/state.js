'use strict';
// Shared cross-subsystem state + persistence to /config/state.json.
// Owns: the persisted Maps (declined, blocked, gpuSwapped, gpuPending,
// searchState, forceGrabImport, completedForceGrabs) and masterPaused (via
// accessors), plus the non-persisted importState Map shared by the import
// watchdog and buildDownloads. loadState() is invoked explicitly by server.js
// BEFORE any timer starts — module shape now guarantees the declare-before-
// restore ordering the TDZ comment below used to police by source position.
// No timers.

const fs = require('fs');

// Per-folder import-rescue state (NOT sticky): the watchdog retries with backoff, and
// a title flips to "Ready" the moment *arr reports hasFile — regardless of this.
const importState = new Map(); // folder -> { lastTry, reason }
const forceGrabImport = new Map(); // infoHash -> { app, id, seriesTitle, folder: null } — post-force-grab import guarantee
const completedForceGrabs = new Map(); // infoHash -> { id } — force-grabs the watchdog has fully imported; lets buildDownloads render them Ready (their ManualImport carries no downloadId, so *arr history isn't keyed to the hash)
const declined = new Map(); // hash -> { title, neededBytes, freeBytes, ts, source }
// These two are also restored by loadState() below, so they MUST be declared before it runs —
// a `const` referenced before its line is a ReferenceError (TDZ) that loadState's catch would
// swallow, silently losing the persisted state across reboots.
const blocked = new Map();  // `app:id:seasons` -> { title, neededBytes, freeBytes, ts, lastCheck }
// movieId -> {ts, done} for GPU-compat re-grabs (gpuVerifySweep) — once per movie EVER,
// persisted, so the verifier can never loop on a title whose only releases are 10-bit.
const gpuSwapped = new Map();
// movieId -> {oldHashes, ts, title, tmdbId}: an in-flight ZERO-GAP swap. The better H.264
// copy has been grabbed but the OLD FILE STAYS PLAYABLE until the download completes; only
// then (and only if nobody is mid-watch) is the old copy removed and the new one imported.
const gpuPending = new Map();
// Per-item *arr search state, persisted so it survives a controller restart (an in-memory-only
// version, wiped on every reboot, is what let a restart re-trigger the full search/grab storm).
// Key `app:id` -> { ts: last auto-search ms, fails: consecutive fruitless searches, blockedUntil }.
const searchState = new Map();
// Audit tab verdicts: `tv:<seriesId>:<season>` | `mv:<movieId>` -> { ts, state, best, reason }.
// state is 'improvable' | 'none' (searched, nothing better) | 'error'. Persisted because a
// full enrich is ~114 indexer searches (~25 min) — losing it on every restart would mean the
// tab is never warm and would hammer public indexers on each reboot. Entries expire on a TTL
// (see audit.js) since release availability drifts.
const auditVerdicts = new Map();
// In-flight ZERO-GAP replacements started from the Audit tab.
// `${app}:${id}:${season|'-'}` -> { app, id, season, key, title, oldFileIds, guid, ts }.
// The OLD FILES STAY PLAYABLE until the replacement finishes downloading; auditReplaceSweep
// only then removes them and imports. Persisted so a controller restart cannot strand a swap
// half-done (which would leave the title with two copies, or none).
const auditPending = new Map();
// COMPLETED Audit swaps: `${app}:${id}:${season|'-'}` -> { hash, rel, ts }.
// Records which release a row was swapped TO, so the verifier can refuse to offer that exact
// release back. Needed because the Playback section judges the current file by the release GROUP
// in its filename, and *arr's import rename strips it — so a freshly-imported pack reads as
// "unproven depth" while the identical candidate reads as proven 8-bit, and the row asks to
// re-download 30 GB to stand still (observed: Supernatural S09, 2026-07-28). Matching on the
// recorded infoHash/title is precise; a size-and-source heuristic is NOT — it would reject the
// legitimate 10-bit → 8-bit swap at the same source and size, which is this section's whole job.
const auditSwapped = new Map();
// "Movie Mode" master switch: when true, ALL background work (downloads + every sweep) is paused so
// the NUC's CPU + the single USB disk are free for smooth Jellyfin playback. Persisted so it stays
// off/on across a controller restart — only an explicit resume turns it back on.
let masterPaused = false;
// Persist declined + blocked tombstones across restarts so the "Declined" rows
// survive a controller reboot.
function persistState() {
  clearTimeout(persistState._timer);
  persistState._timer = setTimeout(() => {
    try {
      const obj = { declined: {}, blocked: {}, searchState: {}, gpuSwapped: {}, gpuPending: {}, masterPaused, forceGrabImport: {}, completedForceGrabs: {}, auditVerdicts: {}, auditPending: {}, auditSwapped: {} };
      for (const [k, v] of declined) obj.declined[k] = v;
      for (const [k, v] of blocked) obj.blocked[k] = v;
      for (const [k, v] of searchState) obj.searchState[k] = v;
      for (const [k, v] of gpuSwapped) obj.gpuSwapped[k] = v;
      for (const [k, v] of gpuPending) obj.gpuPending[k] = v;
      for (const [k, v] of forceGrabImport) obj.forceGrabImport[k] = v;
      for (const [k, v] of completedForceGrabs) obj.completedForceGrabs[k] = v;
      for (const [k, v] of auditVerdicts) obj.auditVerdicts[k] = v;
      for (const [k, v] of auditPending) obj.auditPending[k] = v;
      for (const [k, v] of auditSwapped) obj.auditSwapped[k] = v;
      fs.writeFileSync('/config/state.json', JSON.stringify(obj));
    } catch { /* */ }
  }, 500);
}
function loadState() {
  try {
    const obj = JSON.parse(fs.readFileSync('/config/state.json', 'utf8'));
    if (obj.declined) for (const [k, v] of Object.entries(obj.declined)) declined.set(k, v);
    if (obj.blocked) for (const [k, v] of Object.entries(obj.blocked)) blocked.set(k, v);
    if (obj.searchState) for (const [k, v] of Object.entries(obj.searchState)) searchState.set(k, v);
    if (obj.gpuSwapped) for (const [k, v] of Object.entries(obj.gpuSwapped)) gpuSwapped.set(Number(k), v);
    if (obj.gpuPending) for (const [k, v] of Object.entries(obj.gpuPending)) gpuPending.set(Number(k), v);
    if (typeof obj.masterPaused === 'boolean') masterPaused = obj.masterPaused;
    // Lowercase keys on load to migrate any pre-fix state written with an UPPERCASE infoHash.
    if (obj.forceGrabImport) for (const [k, v] of Object.entries(obj.forceGrabImport)) forceGrabImport.set(String(k).toLowerCase(), v);
    if (obj.completedForceGrabs) for (const [k, v] of Object.entries(obj.completedForceGrabs)) completedForceGrabs.set(String(k).toLowerCase(), v);
    if (obj.auditVerdicts) for (const [k, v] of Object.entries(obj.auditVerdicts)) auditVerdicts.set(k, v);
    if (obj.auditPending) for (const [k, v] of Object.entries(obj.auditPending)) auditPending.set(k, v);
    if (obj.auditSwapped) for (const [k, v] of Object.entries(obj.auditSwapped)) auditSwapped.set(k, v);
  } catch { /* */ }
}

function isMasterPaused() { return masterPaused; }
function setMasterPaused(v) { masterPaused = !!v; }

// ---- AUDIT SWAP IDENTITY ───────────────────────────────────────────────────────────────────
// "Is this torrent an in-flight Audit replacement?" — the question that decides whether a delete may
// touch the library. During a swap the ORIGINAL is still on disk and still playable (the swap is
// zero-gap by design), and the replacement torrent resolves to that same movie/series id, so a
// hash-based layered delete of the replacement would take the original with it.
//
// It lives HERE, next to auditPending, rather than in audit.js, because both downloads.js and
// routes-actions.js need it and audit.js sits downstream of importer.js, which requires downloads.js:
// exporting it from audit.js created a downloads → audit → importer → downloads cycle that handed
// importer a partially-initialised module (its destructured getDl came back undefined, which would
// have broken the import watchdog). state.js is a leaf, so asking it costs nothing.
function swapForHash(hash) {
  const h = String(hash || '').toLowerCase();
  if (!h) return null;
  for (const [k, p] of auditPending) {
    if (String(p.hash || '').toLowerCase() === h) return { key: k, pending: p };
  }
  return null;
}
const isSwapHash = (hash) => !!swapForHash(hash);

module.exports = {
  declined, blocked, gpuSwapped, gpuPending, searchState, auditVerdicts, auditPending, auditSwapped,
  forceGrabImport, completedForceGrabs, importState,
  persistState, loadState, isMasterPaused, setMasterPaused,
  swapForHash, isSwapHash,
};
