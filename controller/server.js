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
// CORS FOR SAFE METHODS, so the Jellyfin web client can read this API. jellyfin-web is served from
// :8096 and the controller answers on :8088 — a different port is a different ORIGIN, so the browser
// discards the response unless we say otherwise. Without this the detail page's award rows (which
// fetch /api/awards) fail silently in the browser while `curl` shows a perfectly good 200 — exactly
// the kind of bug that reads as "the feature just didn't ship".
//
// SECURITY: this widens nothing. The controller is LAN-only and deliberately unauthenticated (see
// AGENTS.md §Auth — "the controller dashboard stays unauthenticated"), and serves no per-user data,
// so anything a page can now read cross-origin it could already read by being on the network.
// Scoped to safe methods regardless: GET/HEAD/OPTIONS only, so no mutating route (replace, delete,
// reclaim) becomes cross-origin callable and no browser can be induced to fire one.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});
// NO max-age ON THE APP'S OWN ASSETS. It used to be '1h', and that made every UI deploy invisible
// for up to an hour: the browser served cached js/css without asking, so a change that WAS live on
// the server looked like a change that had not shipped. Diagnosed 2026-08-06 after a UI fix appeared
// absent while `curl` confirmed the new file was being served.
//
// `etag: true` (Express's default) + no max-age is the right trade here rather than a cache-busting
// build step: the browser still revalidates with If-None-Match and still gets a 304 with an empty
// body on the common case, so the bandwidth saving survives while correctness stops depending on the
// reader remembering to hard-refresh. This is a LAN dashboard, not a CDN-fronted site — a
// conditional request costs nothing worth measuring, and there is no build pipeline to hash names in.
app.use(express.static(path.join(__dirname, 'web'), { etag: true, lastModified: true, maxAge: 0 }));

const { cfg, PORT, NUC_IP, HOST } = require('./lib/config');
const { tfetch } = require('./lib/clients');
const state = require('./lib/state');

// Restore persisted state BEFORE any other module loads or any timer starts —
// preserves the declare-Maps-before-loadState ordering the monolith relied on.
state.loadState();

// Route modules register their endpoints on the shared app as they load
// (the middleware above is already applied). Order mirrors the original file.
require('./lib/routes-system');
// The job registry must load before any module that registers a job, and it owns /api/jobs.
// Required explicitly here (rather than relying on a transitive require) so the Jobs tab does not
// silently lose its endpoint if the last module that happened to import it is ever removed.
require('./lib/jobs');
const movieMode = require('./lib/movie-mode');
const downloads = require('./lib/downloads');
require('./lib/routes-elo');
const { registerHssShelf, startShelfTimer } = require('./lib/hss-shelf');
const metricsRecorders = require('./lib/metrics-recorders');
require('./lib/routes-actions');

const systemStats = require('./lib/system-stats');
const importer = require('./lib/importer');
const stallRecovery = require('./lib/stall-recovery');
const gpuVerify = require('./lib/gpu-verify');
const cpuCensus = require('./lib/cpu-census');
const audit = require('./lib/audit');
const { collectionsSweep, startCollectionsTimer } = require('./lib/collections');
const { oscarTagsSweep, startOscarTagsTimer } = require('./lib/oscar-tags');
const { nationTagsSweep, startNationTagsTimer } = require('./lib/nation-tags');
const { startTop100ExportTimer } = require('./lib/top100-export');
const { startTop100GuardTimer } = require('./lib/top100-guard');
const sweeps = require('./lib/sweeps');
const searchEngine = require('./lib/search-engine');
const jfScan = require('./lib/jf-scan');
const probe = require('./lib/probe');

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
audit.startAuditVerifier();   // Audit tab: paced indexer verification, one row per 45s
cpuCensus.startCpuCensus();   // report-only: counts files that can't hardware-decode (gpuVerify only fixes fresh MOVIE imports)
startCollectionsTimer();
startOscarTagsTimer();
startNationTagsTimer();
startTop100ExportTimer();   // weekly TXT snapshot of the hand-ranked Top 100 (no other copy exists)
startTop100GuardTimer();    // hourly: re-add titles a file swap orphaned (Jellyfin ids are path-derived)
setTimeout(bootSequence, 15000);   // let the container settle, then self-heal the home page
metricsRecorders.startRecorders();
sweeps.startSweeps();
searchEngine.startSearchEngine();
jfScan.startJfScanTimers();
movieMode.startMovieMode(); // auto Movie Mode: Jellyfin webhook arms it on playback, a 30s sweep
                            // expires dead sessions and runs the release grace period.
probe.startProbe();         // nightly CRF probe: measures per-film content complexity 01:00-06:00,
                            // and installs it as the BPP+ denominator app-wide (installScoring()).
                            // Must come before app.listen so no request is served with the flat
                            // fallback after a restart. See docs/DESIGN-CRF-PROBE.md.

app.listen(PORT, () => console.log(`controller listening on :${PORT} (NUC_IP=${NUC_IP}, keys ${cfg.RADARR_KEY ? 'loaded' : 'NOT provisioned'})`));
