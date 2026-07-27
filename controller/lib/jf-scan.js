'use strict';
// Jellyfin library-refresh triggering: debounced event-driven scans plus a
// trickplay-aware periodic safety net. Owns: _scanning/_lastScan/_scanRetry and
// the trickplay-busy cache. Timers: startJfScanTimers() → 5-min safety net +
// 45s startup catch-up scan.

const { cfg, HOST } = require('./config');
const { tfetch } = require('./clients');
const { isMasterPaused } = require('./state');

// ---- JellyfReady refresh (event-driven + self-healing periodic sweep) ----
let _scanning = false;
let _lastScan = 0;
let _scanRetry = null;
// opts.minAgeMs — skip if a scan finished (or started) more recently than this. Used by the two
// TIMER paths (boot catch-up + safety net), which are speculative "did we miss anything?" scans.
// Event-driven callers (a fresh *arr import) pass nothing: a new file is a real reason to scan
// even if one just ran.
async function triggerJellyfinScan(opts = {}) {
  if (_scanning || !cfg.JELLYFIN_KEY) return;
  if (Date.now() - _lastScan < 30000) return; // debounce: at most once per 30s

  // NEVER post Refresh while Jellyfin is already scanning. POST /Library/Refresh does not queue —
  // it CANCELS the in-progress scan and starts a new one from zero.
  //
  // This caused a self-sustaining scan loop on 2026-07-27 (Brennan: "there must be a bug in code
  // somewhere"). _lastScan records when the POST succeeded, not when the scan FINISHED, so the
  // 5-min safety net below treats a scan as overdue 10 min after it STARTED. A full library scan
  // on a loaded box takes longer than that, so: net fires -> POST -> cancels the running scan ->
  // restarts it -> 10 min later the net fires again. The scan never reaches 100%, and Jellyfin
  // scans (plus the per-item ffmpeg audio analysis each restart re-queues) forever. Observed:
  // "Scan Media Library ... Cancelled" back-to-back for hours at load 20-26, every heavy Jellyfin
  // query timing out, collectionsSweep failing 3x, and Jellyseerr pruning its library to 151 rows
  // because its own sync kept reading a half-scanned library.
  //
  // Skipping is always safe: the running scan covers the whole library, so it will pick up
  // whatever import triggered this call anyway.
  // Claim the slot BEFORE the first await. _scanning used to be set only after the gate below,
  // which left an await-sized window for two callers to both observe "no scan running" and both
  // POST — the second cancelling the scan the first had just started. With imports landing
  // continuously (downloads.js and importer.js each trigger on every new item) that window was
  // hit constantly, and it is what kept cancelling scans even after the running-scan gate was
  // added. It also made the boot scan return silently: a concurrent call already held _scanning.
  _scanning = true;
  try {
    if (await isLibraryScanRunning()) {
      console.log('jfScan: library scan already running — skipping (a Refresh POST would cancel and restart it)');
      return;
    }

    // Checked AFTER the gate above, because isLibraryScanRunning() -> refreshTaskState() is what
    // seeds _lastScan from Jellyfin's own LastExecutionResult. Checking first would read the
    // in-memory 0 on a fresh controller and always look overdue.
    if (opts.minAgeMs && Date.now() - _lastScan < opts.minAgeMs) {
      console.log(`jfScan: last scan ${Math.round((Date.now() - _lastScan) / 1000)}s ago — skipping speculative scan`);
      return;
    }

    const r = await tfetch(`${HOST.jellyfin}/Library/Refresh`, { method: 'POST', headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY } }, 15000);
    if (r.ok || r.status === 204) {
      console.log('jfScan: library refresh started');
      _lastScan = Date.now();
      _scanRetry = null;
      // We just started a scan, so we KNOW one is running — record it without waiting for the
      // next ScheduledTasks poll. refreshTaskState caches for 60s, and a stale "not running"
      // reading inside that window is enough for the next trigger to cancel the scan we just
      // started. Observed immediately after the 2026-07-27 deploy: "Running@15% last=Cancelled".
      _scanBusyCache = true;
      _lastTrickBusyCheck = Date.now();
    } else {
      console.log(`jfLibraryRefresh: HTTP ${r.status} — will retry`);
      if (!_scanRetry) _scanRetry = 0;
      if (++_scanRetry <= 3) setTimeout(triggerJellyfinScan, 60000);
    }
  } catch {
    if (!_scanRetry) _scanRetry = 0;
    if (++_scanRetry <= 3) setTimeout(triggerJellyfinScan, 60000);
  }
  finally { _scanning = false; }
}
// ---- Trickplay-aware scan gate ----
// If Jellyfin's "Generate Trickplay Images" task is running, skip the safety-net
// scan.  Each scan-completion triggers the next trickplay item, so feeding scans
// while trickplay is active creates a vicious cycle: trickplay takes >10 min per
// episode → watchdog fires → scan → next trickplay item → repeat for hours/days.
// When trickplay finishes, the next watchdog tick (≤2 min) will catch any real
// imports.  New imports still trigger scans directly via their own code paths.
let _lastTrickBusyCheck = 0;
async function isTrickplayBusy() {
  await refreshTaskState();
  return _trickBusyCache;
}

// Is Jellyfin's own library scan in progress? Gates triggerJellyfinScan — see the long note there.
// Fails CLOSED (returns true) when Jellyfin can't be reached: if we don't know, the safe move is
// NOT to fire a Refresh that might cancel a scan we simply failed to observe. A missed scan costs
// one 5-min tick; a wrongly-cancelled one costs the whole scan and restarts the loop this fixes.
async function isLibraryScanRunning() {
  const ok = await refreshTaskState();
  return ok ? _scanBusyCache : true;
}

// Single ScheduledTasks poll feeding both gates, cached 60s (was one poll per gate).
async function refreshTaskState() {
  if (Date.now() - _lastTrickBusyCheck < 60000) return _taskStateOk;
  try {
    const r = await tfetch(`${HOST.jellyfin}/ScheduledTasks`, { headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY } }, 8000);
    if (!r.ok) { _taskStateOk = false; return false; }
    const tasks = await r.json();
    _lastTrickBusyCheck = Date.now();
    _trickBusyCache = tasks.some(t => /trickplay/i.test(t.Name) && t.State === 'Running');
    // Match on the task KEY, not the display name — "Scan Media Library" is localised, and a
    // name-only match silently stops gating on a non-English server.
    const scanTask = tasks.find(t => t.Key === 'RefreshLibrary' || /scan media library/i.test(t.Name || ''));
    _scanBusyCache = !!scanTask && scanTask.State === 'Running';
    // Jellyfin remembers when the last scan ENDED; we don't (_lastScan is in-memory and resets to
    // 0 on every restart, which is why the 45s boot catch-up scan fired on all three deploys
    // today and always looked overdue). Seed _lastScan from the server so a fresh controller
    // inherits the real history instead of assuming none.
    const endedAt = Date.parse(scanTask?.LastExecutionResult?.EndTimeUtc || '');
    if (Number.isFinite(endedAt) && endedAt > _lastScan) _lastScan = endedAt;
    // Seeing a scan in flight counts as "a scan happened recently". Without this the safety net
    // would fire the instant a long scan finished — _lastScan only records our own POSTs, so a
    // scan Jellyfin ran on its own schedule (or one still finishing) leaves it looking overdue,
    // and we'd immediately start another. This is the other half of the loop fix.
    if (_scanBusyCache) _lastScan = Date.now();
    _taskStateOk = true;
    return true;
  } catch {
    _lastTrickBusyCheck = Date.now();
    _trickBusyCache = false;
    _taskStateOk = false;
    return false;
  }
}
let _trickBusyCache = false;
let _scanBusyCache = false;
let _taskStateOk = false;

function startJfScanTimers() {
// Periodic safety-net scan + startup catch-up.
// If no scan has succeeded in 10 minutes AND trickplay isn't running, fire one.
// This catches media that *arr imported while the controller was down or the
// notification missed.
setInterval(() => {
  if (!cfg.JELLYFIN_KEY) return;
  if (isMasterPaused()) { return; }   // Movie Mode: scans hammer the USB drive mid-playback
  // No _lastScan pre-check here any more — it reads 0 on a fresh controller and so always looked
  // overdue. triggerJellyfinScan({minAgeMs}) makes the call after refreshing state from Jellyfin.
  isTrickplayBusy().then(busy => {
    if (busy) { console.log('jfScan: trickplay running — deferring scan'); return; }
    triggerJellyfinScan({ minAgeMs: 600000 });
  });
}, 300000);   // 5 min (was 120s); scans are heavy and this already defers while trickplay runs — less frequent is safer
// On controller start, wait for Jellyfin to be ready then do a catch-up scan so media imported
// during downtime gets discovered — but skip it if Jellyfin scanned recently anyway. Three
// deploys in one session on 2026-07-27 fired three full scans back-to-back.
setTimeout(() => { if (cfg.JELLYFIN_KEY) { console.log('jfScan: startup catch-up scan'); triggerJellyfinScan({ minAgeMs: 600000 }); } }, 45000);
}

module.exports = { triggerJellyfinScan, startJfScanTimers };
