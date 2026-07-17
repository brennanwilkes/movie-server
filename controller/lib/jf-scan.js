'use strict';
// Jellyfin library-refresh triggering: debounced event-driven scans plus a
// trickplay-aware periodic safety net. Owns: _scanning/_lastScan/_scanRetry and
// the trickplay-busy cache. Timers: startJfScanTimers() → 5-min safety net +
// 45s startup catch-up scan.

const { cfg, HOST } = require('./config');
const { tfetch } = require('./clients');

// ---- JellyfReady refresh (event-driven + self-healing periodic sweep) ----
let _scanning = false;
let _lastScan = 0;
let _scanRetry = null;
async function triggerJellyfinScan() {
  if (_scanning || !cfg.JELLYFIN_KEY) return;
  if (Date.now() - _lastScan < 30000) return; // debounce: at most once per 30s
  _scanning = true;
  try {
    const r = await tfetch(`${HOST.jellyfin}/Library/Refresh`, { method: 'POST', headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY } }, 15000);
    if (r.ok || r.status === 204) {
      _lastScan = Date.now();
      _scanRetry = null;
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
  try {
    // Cache: don't hit the API more than once per 60s
    if (Date.now() - _lastTrickBusyCheck < 60000) return _trickBusyCache;
    const r = await tfetch(`${HOST.jellyfin}/ScheduledTasks`, { headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY } }, 8000);
    if (!r.ok) return (_trickBusyCache = false);
    const tasks = await r.json();
    _lastTrickBusyCheck = Date.now();
    _trickBusyCache = tasks.some(t => /trickplay/i.test(t.Name) && t.State === 'Running');
    return _trickBusyCache;
  } catch {
    _lastTrickBusyCheck = Date.now();
    return (_trickBusyCache = false);
  }
}
let _trickBusyCache = false;

function startJfScanTimers() {
// Periodic safety-net scan + startup catch-up.
// If no scan has succeeded in 10 minutes AND trickplay isn't running, fire one.
// This catches media that *arr imported while the controller was down or the
// notification missed.
setInterval(() => {
  if (!cfg.JELLYFIN_KEY) return;
  if (Date.now() - _lastScan > 600000) {
    isTrickplayBusy().then(busy => {
      if (busy) { console.log('jfScan: trickplay running — deferring scan'); return; }
      console.log('jfScan: 10 min overdue — triggering refresh');
      triggerJellyfinScan();
    });
  }
}, 300000);   // 5 min (was 120s); scans are heavy and this already defers while trickplay runs — less frequent is safer
// On controller start, wait for Jellyfin to be ready then do a catch-up scan
// so media imported during downtime gets discovered.
setTimeout(() => { if (cfg.JELLYFIN_KEY) { console.log('jfScan: startup catch-up scan'); triggerJellyfinScan(); } }, 45000);
}

module.exports = { triggerJellyfinScan, startJfScanTimers };
