'use strict';
// Movie-server controller — serves the mobile dashboard (web/) and a same-origin
// API that aggregates the stack and runs the one-click "delete everywhere" recipe.
// Upstreams are reached by container name on the compose network; per-service auth
// is injected here from /config/keys.env so keys never reach the browser.
//
// This file is the thin entrypoint: the subsystems live in lib/ (see
// controller/README.md for the module map). Boot order is fixed here:
// middleware → loadState() → route modules → timers → listen. Every background
// loop is started explicitly below — modules never start timers on require.

const path = require('path');
const express = require('express');
const compression = require('compression');

const app = require('./lib/app');
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'web'), { maxAge: '1h' }));

const { cfg, PORT, NUC_IP, HOST } = require('./lib/config');
const { tfetch } = require('./lib/clients');
const state = require('./lib/state');

// Restore persisted state BEFORE any other module loads or any timer starts —
// preserves the declare-Maps-before-loadState ordering the monolith relied on.
state.loadState();

// Route modules register their endpoints on the shared app as they load
// (the middleware above is already applied). Order mirrors the original file.
require('./lib/routes-system');
const downloads = require('./lib/downloads');
require('./lib/routes-elo');
const { registerHssShelf, startShelfTimer } = require('./lib/hss-shelf');
const metricsRecorders = require('./lib/metrics-recorders');
require('./lib/routes-actions');

const systemStats = require('./lib/system-stats');
const importer = require('./lib/importer');
const stallRecovery = require('./lib/stall-recovery');
const gpuVerify = require('./lib/gpu-verify');
const { collectionsSweep, startCollectionsTimer } = require('./lib/collections');
const { oscarTagsSweep, startOscarTagsTimer } = require('./lib/oscar-tags');
const { nationTagsSweep, startNationTagsTimer } = require('./lib/nation-tags');
const sweeps = require('./lib/sweeps');
const searchEngine = require('./lib/search-engine');
const jfScan = require('./lib/jf-scan');

// Cold-boot ordering: build collections, THEN register the shelves that read them, so the home
// page is populated on first load instead of after the old 3-min gap. Polls Jellyfin (up to ~5
// min) until it answers before the first sweep — the container often starts before Jellyfin is
// ready. The two setInterval schedules above keep both fresh afterward.
async function bootSequence() {
  if (!cfg.JELLYFIN_KEY) { console.log('bootSequence: no Jellyfin key yet — skipping (provision + restart)'); return; }
  for (let i = 0; i < 30; i++) {   // ~5 min: 30 × 10s
    try { await tfetch(`${HOST.jellyfin}/System/Info`, { headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY } }, 8000); break; }
    catch (_) { await new Promise((r) => setTimeout(r, 10000)); }
  }
  console.log('bootSequence: Jellyfin reachable — building collections then registering shelves');
  await collectionsSweep();
  await registerHssShelf();
  await oscarTagsSweep();   // decorate posters with Oscar badges (metadata Tags only; safe post-boot)
  await nationTagsSweep();  // decorate non-US movies with nation flags (metadata Tags only)
  // The /System/Info poll above can pass moments before a provision-triggered Jellyfin RESTART,
  // making every boot sweep "fetch failed" — and the tag sweeps' own timers only fire every 24h.
  // One delayed second pass self-heals that window (all four are diff-only + busy-guarded: if the
  // first pass succeeded this costs a few no-op queries).
  setTimeout(async () => {
    console.log('bootSequence: 10-min self-heal pass');
    await collectionsSweep();
    await registerHssShelf();
    await oscarTagsSweep();
    await nationTagsSweep();
  }, 10 * 60000);
}

// Start every background loop. Intervals and first-run delays are identical to
// the pre-split monolith; see each module's header for its schedule.
systemStats.startCpuSampling();
downloads.startDownloadsLoop();
startShelfTimer();
importer.startWatchdog();
stallRecovery.startStallRecovery();
gpuVerify.startGpuVerify();
startCollectionsTimer();
startOscarTagsTimer();
startNationTagsTimer();
setTimeout(bootSequence, 15000);   // let the container settle, then self-heal the home page
metricsRecorders.startRecorders();
sweeps.startSweeps();
searchEngine.startSearchEngine();
jfScan.startJfScanTimers();

app.listen(PORT, () => console.log(`controller listening on :${PORT} (NUC_IP=${NUC_IP}, keys ${cfg.RADARR_KEY ? 'loaded' : 'NOT provisioned'})`));
