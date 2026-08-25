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
// RELEASES PROVEN DEAD, keyed by the release TITLE (lowercased): -> { ts, hash, title }.
//
// Separate from auditSwapped, which is keyed by ROW and therefore holds exactly one entry per film
// — the last release swapped to. That is the wrong shape for remembering corpses, because a film
// with a dead swarm burns SEVERAL releases in a row: Gladiator (2000) lost CiNEFiLE, and then the
// record was about to be overwritten by OFT, forgetting the first. Keying by release means every
// one that failed stays remembered, and remembered ACROSS films — the same dead pack is often
// listed by several indexers under near-identical names.
//
// Written only by abandonDeadSwap(); read at serve time to mark candidates in the Audit tab so a
// human is not offered a corpse with no warning. Entries expire after DEAD_REFUSE_TTL_MS (7 days)
// because swarms do revive, so this map stays small and self-pruning.
const auditDead = new Map();
// RECENT REPLACEMENT OUTCOMES — newest first, capped by AUDIT_HISTORY_MAX. Every swap that ENDS
// lands here: verified, abandoned, refused, timed out.
//
// It exists because outcomes were previously write-only. A swap that failed logged one line to
// stdout, deleted its own tracking record, and vanished from the UI entirely — so the tab showed
// only what was still in flight and there was no way to learn that 60 replacements had died
// overnight (2026-08-11: "Cause I had no idea so many of them failed"). Docker log history is also
// destroyed by every `make deploy`, so stdout is not a record either.
//
// A bounded array rather than a Map: this is a feed, order is the point, and nothing looks entries
// up by key. Capped so state.json — rewritten in full on a 500ms debounce — cannot grow without
// bound; see the size note on auditVerdicts below for why that matters.
const auditHistory = [];
// 150, sized against how this is actually used: replacements are requested in BATCHES — 74 in one
// sitting on 2026-08-10 — and a cap below a batch size means a batch's own outcomes push each other
// out before they can be read, which defeats the point. Entries are ~150 bytes, so the whole ring is
// ~22 KB against a state.json already around 130 KB.
//
// Deliberately NOT deduplicated by title. A film that failed twice and then landed is three facts,
// and collapsing them to the latest would hide exactly the pattern worth seeing ("this one keeps
// failing"). The newest is on top; older ones age out on their own.
const AUDIT_HISTORY_MAX = 150;
// "Movie Mode" master switch: when true, ALL background work (downloads + every sweep) is paused so
// the NUC's CPU + the single USB disk are free for smooth Jellyfin playback.
//
// TWO INDEPENDENT LATCHES, because the switch now has two owners with different lifetimes:
//   manualPause  the button on the Processes tab. PERSISTED — it stays on across a controller
//                restart and is cleared only by an explicit tap. This is a human saying "leave
//                the box alone", and a deploy must not silently override that.
//   autoPause    playback detected via the Jellyfin webhook (see movie-mode.js). NOT persisted:
//                it is a statement about right now, and a restored-from-disk "someone is
//                watching" would be a guess about a session we can no longer see. On restart it
//                starts false and the next PlaybackProgress event re-arms it within a minute.
//
// isMasterPaused() is the OR of the two, so all ten gating modules keep working unchanged — none
// of them needs to care why the box is quiet, only that it is.
let manualPause = false;
let autoPause = false;
// THE AUTO LATCH IS NOT PERSISTED, BUT ITS SIDE EFFECT IS. Stopping every torrent and setting
// add_stopped_enabled lives in qBittorrent's own config, which survives a controller restart — so a
// deploy (or a crash) while auto Movie Mode was holding the box would clear the latch on boot and
// leave the torrents stopped with nothing left that knows to resume them. Downloads would silently
// never restart until someone toggled Movie Mode by hand.
//
// This records that AUTO — not the human — is the reason qBittorrent is currently held down, so
// startMovieMode() can undo exactly that on boot and nothing else. Deliberately narrow: it is never
// set for a manual pause, so a restart can never override a deliberate human hold.
let autoHeldQbit = false;
// Persist declined + blocked tombstones across restarts so the "Declined" rows
// survive a controller reboot.
function persistState() {
  clearTimeout(persistState._timer);
  persistState._timer = setTimeout(() => {
    try {
      // NOTE: `auditVerdicts` is deliberately NOT in here — it lives in its own file. See
      // persistVerdicts() below for why.
      const obj = { declined: {}, blocked: {}, searchState: {}, gpuSwapped: {}, gpuPending: {}, masterPaused: manualPause, autoHeldQbit, forceGrabImport: {}, completedForceGrabs: {}, auditPending: {}, auditSwapped: {}, auditDead: {}, auditHistory };
      for (const [k, v] of declined) obj.declined[k] = v;
      for (const [k, v] of blocked) obj.blocked[k] = v;
      for (const [k, v] of searchState) obj.searchState[k] = v;
      for (const [k, v] of gpuSwapped) obj.gpuSwapped[k] = v;
      for (const [k, v] of gpuPending) obj.gpuPending[k] = v;
      for (const [k, v] of forceGrabImport) obj.forceGrabImport[k] = v;
      for (const [k, v] of completedForceGrabs) obj.completedForceGrabs[k] = v;
      for (const [k, v] of auditPending) obj.auditPending[k] = v;
      for (const [k, v] of auditSwapped) obj.auditSwapped[k] = v;
      for (const [k, v] of auditDead) obj.auditDead[k] = v;
      // Atomic replace (temp + rename on the same filesystem): a kill/crash mid-write can never
      // truncate the live file — a truncated state.json is silently parsed as empty by loadState,
      // which wipes every persisted guard (gpuSwapped, searchState, declined, blocked, auditPending…).
      const tmp = '/config/state.json.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, '/config/state.json');
    } catch { /* */ }
  }, 500);
}
// ---- AUDIT VERDICTS: THEIR OWN FILE ─────────────────────────────────────────────────────────
// Measured 2026-08-09: state.json was 3.79 MB, of which auditVerdicts was 3.72 MB — 98% of it, at
// ~9.9 KB per verdict (each carries up to MAX_CANDIDATES=12 decorated releases). state.json is
// rewritten IN FULL, SYNCHRONOUSLY, on a 500 ms debounce from a dozen call sites, so every one of
// those writes was already stringifying and fsyncing ~4 MB to say that one torrent changed state.
//
// The upgrade scanner would have made that untenable rather than merely wasteful: it verdicts every
// movie under BPP+ 100, which is 754 titles today, taking the file to roughly 11 MB on a 4-core NUC
// that is also transcoding. A synchronous multi-megabyte write on the event loop, several times a
// minute, is exactly the kind of background cost that shows up as playback stutter.
//
// Same split, and the same reasoning, as probe.js's /config/probe-cache.json — see the comment
// there. Verdicts change on their own slow cadence (one search per 45-60 s), so they get their own
// debounce and their own file, and the hot state.json path goes back to being small.
//
// LOSS MODEL: a verdict is a cache, not a fact. Losing this file re-runs searches; it cannot
// corrupt the library or drop a persisted guard. That is why it is safe to split out and why the
// read path below fails silently to empty rather than shouting.
const VERDICTS_PATH = '/config/audit-verdicts.json';
// 5 s, not 500 ms: nothing reads this file while the process is up, so the only thing the debounce
// buys is crash-window narrowing on a cache. Coalescing hard is the better trade.
function persistVerdicts() {
  clearTimeout(persistVerdicts._timer);
  persistVerdicts._timer = setTimeout(() => {
    try {
      const obj = {};
      for (const [k, v] of auditVerdicts) obj[k] = v;
      const tmp = `${VERDICTS_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ verdicts: obj, ts: Date.now() }));
      fs.renameSync(tmp, VERDICTS_PATH);
    } catch { /* a cache that cannot be written is still a working cache in memory */ }
  }, 5000);
}

function loadVerdicts() {
  let raw;
  try { raw = fs.readFileSync(VERDICTS_PATH, 'utf8'); }
  catch { return false; }                  // no file yet — caller migrates from state.json
  try {
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries((obj && obj.verdicts) || {})) auditVerdicts.set(k, v);
    return true;
  } catch {
    // Corrupt cache: drop it and re-verify rather than refusing to boot. Loud, because silently
    // re-running ~400 paced indexer searches would otherwise look like the sweep had gone rogue.
    console.log('WARN state: /config/audit-verdicts.json is corrupt — discarding, verdicts will re-verify');
    return true;
  }
}

function loadState() {
  // Separate the READ (first boot — no file yet → silent) from the PARSE (corrupt file → loud, backed
  // up). A silently-empty parse is how the persisted guards used to be wiped without a trace.
  let raw;
  try { raw = fs.readFileSync('/config/state.json', 'utf8'); }
  catch { return; }                       // first boot — nothing persisted yet
  let obj;
  try { obj = JSON.parse(raw); }
  catch {
    try { fs.renameSync('/config/state.json', `/config/state.json.corrupt-${Date.now()}`); } catch { /* */ }
    console.log('WARN state: /config/state.json is corrupt — backed it up and starting with empty state');
    return;
  }
  try {
    if (obj.declined) for (const [k, v] of Object.entries(obj.declined)) declined.set(k, v);
    if (obj.blocked) for (const [k, v] of Object.entries(obj.blocked)) blocked.set(k, v);
    if (obj.searchState) for (const [k, v] of Object.entries(obj.searchState)) searchState.set(k, v);
    if (obj.gpuSwapped) for (const [k, v] of Object.entries(obj.gpuSwapped)) gpuSwapped.set(Number(k), v);
    if (obj.gpuPending) for (const [k, v] of Object.entries(obj.gpuPending)) gpuPending.set(Number(k), v);
    // On-disk key stays `masterPaused` so an existing state.json keeps working with no migration.
    if (typeof obj.masterPaused === 'boolean') manualPause = obj.masterPaused;
    if (typeof obj.autoHeldQbit === 'boolean') autoHeldQbit = obj.autoHeldQbit;
    // Lowercase keys on load to migrate any pre-fix state written with an UPPERCASE infoHash.
    if (obj.forceGrabImport) for (const [k, v] of Object.entries(obj.forceGrabImport)) forceGrabImport.set(String(k).toLowerCase(), v);
    if (obj.completedForceGrabs) for (const [k, v] of Object.entries(obj.completedForceGrabs)) completedForceGrabs.set(String(k).toLowerCase(), v);
    // ONE-TIME MIGRATION. Verdicts now live in their own file (see persistVerdicts). Prefer it;
    // fall back to the copy still embedded in an old state.json and write the new file immediately,
    // so the very next persistState() drops ~3.7 MB from the hot path. The embedded copy is simply
    // left behind — it stops being written, so it disappears on that same write.
    if (!loadVerdicts() && obj.auditVerdicts) {
      for (const [k, v] of Object.entries(obj.auditVerdicts)) auditVerdicts.set(k, v);
      console.log(`state: migrated ${auditVerdicts.size} audit verdicts out of state.json into ${VERDICTS_PATH}`);
      persistVerdicts();
    }
    if (obj.auditPending) for (const [k, v] of Object.entries(obj.auditPending)) auditPending.set(k, v);
    if (obj.auditSwapped) for (const [k, v] of Object.entries(obj.auditSwapped)) auditSwapped.set(k, v);
    if (obj.auditDead) for (const [k, v] of Object.entries(obj.auditDead)) auditDead.set(k, v);
    if (Array.isArray(obj.auditHistory)) auditHistory.push(...obj.auditHistory.slice(0, AUDIT_HISTORY_MAX));
  } catch { /* */ }
}

// The only question the sweeps ask, and the only one they should: is the box meant to be quiet?
// Record how a swap ended. `outcome` is one of: replaced | abandoned | refused | timeout | failed.
// Callers pass whatever detail they already have; nothing here is required beyond a title.
// Deliberately does NOT call persistState() — every call site already does, and this runs inside
// their existing write.
function recordAuditOutcome(entry) {
  auditHistory.unshift({ ts: Date.now(), ...entry });
  if (auditHistory.length > AUDIT_HISTORY_MAX) auditHistory.length = AUDIT_HISTORY_MAX;
}

function isMasterPaused() { return manualPause || autoPause; }
// setMasterPaused keeps its name and its meaning — it is the MANUAL button's setter, which is the
// only thing that ever called it. Renaming it would touch every call site to no benefit.
function setMasterPaused(v) { manualPause = !!v; }
function isManualPaused() { return manualPause; }
function isAutoPaused() { return autoPause; }
function setAutoPaused(v) { autoPause = !!v; }
function isAutoHeldQbit() { return autoHeldQbit; }
function setAutoHeldQbit(v) { autoHeldQbit = !!v; }
// Manual wins the description when both are set: it is the one the user can act on, and the one
// that will still be holding the box after the credits roll.
function pauseReason() {
  if (manualPause) return 'held on manually';
  if (autoPause) return 'someone is watching';
  return '';
}
function movieModeStatus() {
  return { on: isMasterPaused(), manual: manualPause, auto: autoPause, reason: pauseReason() };
}

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
  declined, blocked, gpuSwapped, gpuPending, searchState, auditVerdicts, auditPending, auditSwapped, auditDead,
  auditHistory, recordAuditOutcome,
  forceGrabImport, completedForceGrabs, importState,
  persistState, persistVerdicts, loadState, isMasterPaused, setMasterPaused,
  // The two-latch Movie Mode accessors. isMasterPaused() stays the only thing the sweeps use.
  isManualPaused, isAutoPaused, setAutoPaused, pauseReason, movieModeStatus,
  isAutoHeldQbit, setAutoHeldQbit,
  swapForHash, isSwapHash,
};
