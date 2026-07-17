'use strict';
// Action routes driven by the dashboard: /api/jellyfin/resolve deep-links,
// /api/collections/build, /api/library, the layered /api/delete,
// torrent delete/pause/resume, Movie Mode (/api/master-pause|resume),
// /api/redownload, /api/declined/dismiss, /api/retry, and the force-grab
// pair (/api/force-grab, /api/force-grab/search). Route-local helpers:
// qbitPauseResume, qbitSetAddStopped, REDL_TIERS. No timers.

const app = require('./app');
const metrics = require('../metrics');
const { cfg, HOST } = require('./config');
const { tfetch, qbit, arrGet, arrPost, arrPut, arrDelete } = require('./clients');
const { cachedFetch } = require('./cache');
const {
  jellyfinIdByTmdb, jellyfinSearchId, jellyfinServerId, arrTmdbId,
} = require('./jellyfin');
const { arrIdForHash } = require('./arr-data');
const { videoLabel, gpuTier, arrTitle } = require('./arr-inspect');
const {
  buildDeletePlan, planItems, executeDelete, buildDeletePlanFromHash,
} = require('./delete-plan');
const {
  declined, blocked, searchState, forceGrabImport, persistState, setMasterPaused,
} = require('./state');
const {
  searchKeyClear, missingEpisodes, trackSearchDispatch, probeSearchGap, grabGapRelease,
} = require('./search-engine');
const { collectionsSweep, collectionsBusy } = require('./collections');
const { registerHssShelf } = require('./hss-shelf');
const { bustDownloadsCache } = require('./downloads');
const { triggerJellyfinScan } = require('./jf-scan');

// Resolve a (cleaned) title to a Jellyfin item id + server id, so the UI can deep-link
// straight to the item's details page instead of dropping the user on a search results page.
app.get('/api/jellyfin/resolve', async (req, res) => {
  const title = String(req.query.title || '');
  const hash = String(req.query.hash || '').toLowerCase();
  const src = String(req.query.source || req.query.type || '').toLowerCase();
  const app = src === 'sonarr' ? 'sonarr' : src === 'radarr' ? 'radarr' : null;
  const typeMap = { radarr: 'Movie', movie: 'Movie', sonarr: 'Series', series: 'Series', tv: 'Series' };
  const type = typeMap[src] || null;
  try {
    let id = null;
    if (app && hash) {                                   // exact: hash → *arr id → tmdb → Jellyfin item
      const arrId = await arrIdForHash(app, hash);
      if (arrId != null) id = await jellyfinIdByTmdb(type, await arrTmdbId(app, arrId));
    }
    if (!id && title) id = await jellyfinSearchId(title, type);   // fallback for non-*arr titles
    const serverId = await jellyfinServerId();
    res.json({ id, serverId });
  } catch { res.json({ id: null, serverId: null }); }
});
// Manual kick: build/refresh collections, then re-register the home shelves that read them.
// Handy right after a boot — the scheduled sweep is 3 min out and shelves need the box sets to
// exist first. POST (no body) → runs synchronously and reports; 409 if a sweep is already running.
app.post('/api/collections/build', async (_req, res) => {
  if (collectionsBusy()) return res.status(409).json({ ok: false, error: 'sweep already running' });
  try {
    await collectionsSweep();
    await registerHssShelf();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
// Library — titles to clean up, biggest first.  Cached 15s to deduplicate tab switches + 4s poll.
app.get('/api/library', async (req, res) => {
  const a = req.query.app === 'sonarr' ? 'sonarr' : 'radarr';
  try {
    const result = await cachedFetch(`lib:${a}`, 15_000, async () => {
      let items, queue = [];
      try { const qr = await arrGet(a, `/queue?pageSize=200&includeUnknownMovieItems=true`); queue = qr.records || []; }
      catch { /* queue down */ }
      const qByItemId = {};
      for (const qe of queue) {
        const id = qe.movieId || qe.seriesId;
        if (id != null && !qByItemId[id]) qByItemId[id] = qe;
      }
      if (a === 'radarr') {
        const movies = await arrGet('radarr', '/movie');
        items = movies.map((m) => {
          const item = { id: m.id, title: m.title, year: m.year, hasFile: !!m.hasFile, sizeBytes: (m.movieFile && m.movieFile.size) || m.sizeOnDisk || 0, tmdbId: m.tmdbId, runtimeMinutes: m.runtime || 0, videoLabel: videoLabel(m.movieFile && m.movieFile.mediaInfo), gpuCompat: gpuTier(m.movieFile && m.movieFile.mediaInfo) };
          if (!m.hasFile) {
            const qe = qByItemId[m.id];
            if (qe) {
              if (qe.status === 'completed' || qe.trackedDownloadState === 'imported') { item.downloadStatus = 'importing'; item.downloadDetail = 'Importing…'; }
              else if (qe.status === 'downloading') { item.downloadStatus = 'downloading'; item.downloadDetail = `Downloading${qe.size && qe.sizeleft ? ' (' + Math.round((1 - qe.sizeleft / qe.size) * 100) + '%)' : ''}`; }
              else if (qe.status === 'queued' || qe.status === 'paused') { item.downloadStatus = 'queued'; item.downloadDetail = 'Queued'; }
              else if (qe.trackedDownloadState === 'importBlocked') { item.downloadStatus = 'blocked'; item.downloadDetail = qe.errorMessage || 'Import blocked'; }
              else if (qe.trackedDownloadState === 'failed') { item.downloadStatus = 'failed'; item.downloadDetail = qe.errorMessage || 'Download failed'; }
              else { item.downloadStatus = 'queued'; item.downloadDetail = qe.status || 'Queued'; }
            } else {
              item.downloadStatus = m.monitored === false ? 'paused' : 'missing';
              item.downloadDetail = m.monitored === false ? 'Paused (unmonitored)' : 'Not found';
            }
          }
          return item;
        });
      } else {
        const seriesList = await arrGet('sonarr', '/series');
        let miBySeries = {};
        await Promise.allSettled(seriesList.filter((s) => s.statistics && s.statistics.episodeFileCount > 0).map(async (s) => {
          const efs = await arrGet('sonarr', `/episodefile?seriesId=${s.id}`, 5000);
          if (!Array.isArray(efs) || !efs.length) return;
          const mi = efs.find((ef) => ef.mediaInfo);
          if (mi) miBySeries[s.id] = mi.mediaInfo;
        }));
        items = seriesList.map((s) => {
          const mi = miBySeries[s.id];
          const item = { id: s.id, title: s.title, year: s.year, hasFile: ((s.statistics && s.statistics.episodeFileCount) || 0) > 0, sizeBytes: (s.statistics && s.statistics.sizeOnDisk) || 0, tmdbId: s.tmdbId, runtimeMinutes: (s.runtime && s.statistics && s.statistics.episodeFileCount) ? s.runtime * s.statistics.episodeFileCount : 0, videoLabel: videoLabel(mi), gpuCompat: gpuTier(mi) };
          if (!item.hasFile) {
            const qe = qByItemId[s.id];
            if (qe) {
              if (qe.status === 'completed' || qe.trackedDownloadState === 'imported') { item.downloadStatus = 'importing'; item.downloadDetail = 'Importing…'; }
              else if (qe.status === 'downloading') { item.downloadStatus = 'downloading'; item.downloadDetail = `Downloading${qe.size && qe.sizeleft ? ' (' + Math.round((1 - qe.sizeleft / qe.size) * 100) + '%)' : ''}`; }
              else if (qe.status === 'queued' || qe.status === 'paused') { item.downloadStatus = 'queued'; item.downloadDetail = 'Queued'; }
              else if (qe.trackedDownloadState === 'importBlocked') { item.downloadStatus = 'blocked'; item.downloadDetail = qe.errorMessage || 'Import blocked'; }
              else if (qe.trackedDownloadState === 'failed') { item.downloadStatus = 'failed'; item.downloadDetail = qe.errorMessage || 'Download failed'; }
              else { item.downloadStatus = 'queued'; item.downloadDetail = qe.status || 'Queued'; }
            } else {
              item.downloadStatus = s.monitored === false ? 'paused' : 'missing';
              item.downloadDetail = s.monitored === false ? 'Paused (unmonitored)' : 'Not found';
            }
          }
          return item;
        });
      }
      items.sort((x, y) => y.sizeBytes - x.sizeBytes);
      return { app: a, items };
    });
    res.json(result);
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});
app.post('/api/delete', async (req, res) => {
  const { app: a, id, hash, source, dryRun = true } = req.body || {};
  const byHash = id == null && !!hash;
  if (!byHash && (!['radarr', 'sonarr'].includes(a) || id == null)) return res.status(400).json({ error: 'body must be {app,id} or {hash,source?}' });
  try {
    let p;
    if (byHash && hash.startsWith('missing:')) {
      const parts = hash.split(':');
      p = await buildDeletePlan(parts[1], Number(parts[2]));
    } else {
      p = byHash ? await buildDeletePlanFromHash(hash, source) : await buildDeletePlan(a, id);
    }
    if (dryRun) return res.json({ dryRun: true, title: p.title, freedBytes: p.sizeBytes, plan: planItems(p) });
    const results = await executeDelete(p);
    triggerJellyfinScan(); // reconciling sweep AFTER files are gone (the explicit item delete already removed it)
    bustDownloadsCache();
    res.json({ dryRun: false, title: p.title, freedBytes: p.sizeBytes, results });
  } catch (e) {
    const msg = String(e.message || e);
    res.status(/HTTP 404/.test(msg) ? 404 : 500).json({ error: msg });
  }
});

// Delete a specific torrent from qBittorrent (used by the Downloads page stop button).
app.post('/api/torrent/delete', async (req, res) => {
  const { hash, deleteFiles = true } = req.body || {};
  if (!hash) return res.status(400).json({ error: 'hash is required' });
  try {
    const body = new URLSearchParams({ hashes: hash, deleteFiles: String(deleteFiles) });
    const r = await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    bustDownloadsCache();
    res.json({ ok: r.ok });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Pause / resume ONE torrent. qBittorrent v5 renamed pause→stop, resume→start; try the v5 verb
// and fall back to the legacy one so this is version-robust. Acts only on the single hash passed.
async function qbitPauseResume(hash, resume) {
  const verbs = resume ? ['start', 'resume'] : ['stop', 'pause'];
  let r;
  for (const v of verbs) {
    r = await qbit.fetch(`/api/v2/torrents/${v}`, { method: 'POST', body: new URLSearchParams({ hashes: hash }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (r.status !== 404) break;   // 404 = this qBittorrent version doesn't have that verb → try the other
  }
  return r;
}
app.post('/api/torrent/pause', async (req, res) => {
  const { hash } = req.body || {};
  if (!hash || typeof hash !== 'string') return res.status(400).json({ error: 'hash (string) is required' });
  try { const r = await qbitPauseResume(hash, false); bustDownloadsCache(); res.status(r.ok ? 200 : 502).json({ ok: r.ok, paused: true }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/torrent/resume', async (req, res) => {
  const { hash } = req.body || {};
  if (!hash || typeof hash !== 'string') return res.status(400).json({ error: 'hash (string) is required' });
  try { const r = await qbitPauseResume(hash, true); bustDownloadsCache(); res.status(r.ok ? 200 : 502).json({ ok: r.ok, paused: false }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ── Movie Mode (master pause) — free the NUC's CPU + the USB disk for smooth Jellyfin playback ──
// Pauses ALL torrents AND every controller background sweep (search/import/recovery/dedup/disk-gate).
// New *arr grabs (if RSS fires) land stopped while paused, so nothing consumes resources. Resume
// restores auto-start + starts every torrent + re-enables the sweeps.
async function qbitSetAddStopped(v) {
  try { await qbit.fetch('/api/v2/app/setPreferences', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ json: JSON.stringify({ add_stopped_enabled: !!v }) }) }); } catch { /* qbit down */ }
}
app.post('/api/master-pause', async (_req, res) => {
  setMasterPaused(true); persistState();
  await qbitSetAddStopped(true);                       // grabs during Movie Mode stay stopped
  let ok = false;
  try { ok = (await qbitPauseResume('all', false)).ok; } catch { /* qbit down — flag still set, sweeps paused */ }
  console.log('master-pause: Movie Mode ON — torrents stopped, all sweeps paused');
  bustDownloadsCache();
  res.json({ ok: true, paused: true, qbit: ok });
});
app.post('/api/master-resume', async (_req, res) => {
  setMasterPaused(false); persistState();
  await qbitSetAddStopped(false);                      // back to normal auto-start
  let ok = false;
  try { ok = (await qbitPauseResume('all', true)).ok; } catch { /* qbit down */ }
  console.log('master-resume: Movie Mode OFF — torrents + sweeps resumed');
  bustDownloadsCache();
  res.json({ ok: true, paused: false, qbit: ok });
});

// Redownload a MOVIE at a chosen quality tier: deep-delete the current file + torrent(s) + Jellyfin
// entry (the movie stays in Radarr), switch its quality profile to the tier, then trigger a fresh
// search. dryRun returns the title/tier/size for the confirm sheet without changing anything.
// Movies only — TV season/episode teardown is out of scope (per product decision).
const REDL_TIERS = { low: 'Low (save space)', normal: 'Normal', beloved: 'Beloved (best quality)' };
app.post('/api/redownload', async (req, res) => {
  const { app: a, id, tier, dryRun } = req.body || {};
  if (a !== 'radarr') return res.status(400).json({ error: 'redownload is movies-only (radarr)' });
  const mid = Number(id);
  if (!Number.isInteger(mid) || mid <= 0) return res.status(400).json({ error: 'valid movie id required' });
  if (!REDL_TIERS[tier]) return res.status(400).json({ error: 'tier must be one of low|normal|beloved' });
  try {
    const profs = await arrGet('radarr', '/qualityprofile');
    const prof = profs.find((p) => p.name === REDL_TIERS[tier]);
    if (!prof) return res.status(500).json({ error: `quality profile "${REDL_TIERS[tier]}" not found — run provision.sh radarr` });
    const movie = await arrGet('radarr', `/movie/${mid}`);
    const title = movie.title + (movie.year ? ` (${movie.year})` : '');
    const files = await arrGet('radarr', `/moviefile?movieId=${mid}`).catch(() => []);
    const freedBytes = (Array.isArray(files) ? files : []).reduce((s, f) => s + (f.size || 0), 0) || movie.sizeOnDisk || 0;
    // Torrents that belong to this movie (matched via *arr grab history → downloadId).
    let hashes = [];
    try {
      const hist = await arrGet('radarr', `/history/movie?movieId=${mid}`);
      const recs = Array.isArray(hist) ? hist : (hist.records || []);
      hashes = [...new Set(recs.map((r) => r.downloadId).filter(Boolean).map((x) => String(x).toLowerCase()))];
    } catch { /* no history */ }
    if (dryRun) return res.json({ dryRun: true, title, tier, tierName: REDL_TIERS[tier], freedBytes, fileCount: (files || []).length, torrentCount: hashes.length });

    const steps = [];
    // 1) Switch the quality profile to the chosen tier (and ensure it's monitored so the search grabs).
    try { await arrPut('radarr', `/movie/${mid}`, { ...movie, qualityProfileId: prof.id, monitored: true }); steps.push(`profile→${REDL_TIERS[tier]}`); }
    catch (e) { return res.status(502).json({ error: `could not set quality profile: ${String(e.message || e)}` }); }
    // 2) Delete the current movie file(s) — keeps the movie in Radarr, frees the disk.
    for (const f of (Array.isArray(files) ? files : [])) {
      try { await arrDelete('radarr', `/moviefile/${f.id}`); } catch { /* best-effort */ }
    }
    if ((files || []).length) steps.push(`removed ${(files || []).length} file(s)`);
    // 3) Remove the torrent(s) from qBittorrent (deleteFiles: partial/complete data gone too).
    if (hashes.length) {
      try {
        await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', body: new URLSearchParams({ hashes: hashes.join('|'), deleteFiles: 'true' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        steps.push(`removed ${hashes.length} torrent(s)`);
      } catch { /* qbit down — file+profile already changed; search still proceeds */ }
    }
    // 4) Remove the stale Jellyfin entry so it doesn't point at a deleted file (re-added on import).
    try { const jfId = await jellyfinIdByTmdb('Movie', movie.tmdbId); if (jfId) { await tfetch(`${HOST.jellyfin}/Items/${jfId}`, { method: 'DELETE', headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' } }, 10000); } } catch { /* auto-scan reconciles */ }
    // 5) Fresh search — clear the sweep cooldown/negative-cache so it grabs immediately at the new tier.
    searchKeyClear('radarr', mid); persistState();
    await arrPost('radarr', '/command', { name: 'MoviesSearch', movieIds: [mid] }, 8000);
    console.log(`redownload: "${title}" → ${REDL_TIERS[tier]} (${steps.join(', ')}) — search triggered`);
    metrics.emitEvent('redownload', { ti: title, tier, steps: steps.length });
    bustDownloadsCache();
    res.json({ ok: true, title, tier, tierName: REDL_TIERS[tier], freedBytes });
  } catch (e) { console.log(`redownload: failed for radarr id=${mid} — ${e.message || e}`); res.status(500).json({ error: String(e.message || e) }); }
});

// Dismiss a declined entry from the Downloads view (torrent already gone, just
// remove the tombstone so the row disappears).
app.post('/api/declined/dismiss', (req, res) => {
  const { hash } = req.body || {};
  if (!hash) return res.status(400).json({ error: 'hash is required' });
  // A "Declined" row's hash is its source map's key: torrent hash (declined, download-stage
  // gate) OR app:id:seasons (blocked, request-stage gate). Clearing only `declined` made
  // request-stage rows undismissable — the button flashed a checkmark, then the row returned.
  declined.delete(hash);
  blocked.delete(hash);
  persistState();
  bustDownloadsCache();
  res.json({ ok: true });
});

// Retry search for a missing monitored item — same call arrSweep uses.
app.post('/api/retry', async (req, res) => {
  const { app: a, id } = req.body || {};
  if (!['radarr', 'sonarr'].includes(a) || id == null) return res.status(400).json({ error: 'body must be {app,id}' });
  try {
    searchKeyClear(a, Number(id));  // clear cooldown / block before stamping the manual retry state
    const key = `${a}:${Number(id)}`;
    const st = searchState.get(key) || {};
    Object.assign(st, {
      firstMissing: Date.now(),
      manualRetryAt: Date.now(),
      lastReason: 'manual_retry',
      lastAt: Date.now(),
      lastError: null,
    });
    searchState.set(key, st);
    persistState();
    const refs = a === 'sonarr' ? await missingEpisodes(Number(id)) : [];
    const seasons = a === 'sonarr' ? [...new Set(refs.map((e) => e.seasonNumber))] : [];
    const title = a === 'radarr'
      ? await arrTitle(a, Number(id), [])
      : await arrTitle(a, Number(id), seasons);
    if (a === 'radarr') {
      await arrPost(a, '/command', { name: 'MoviesSearch', movieIds: [Number(id)] }, 5000);
      st.ts = Date.now();
      searchState.set(key, st);
      trackSearchDispatch(a, { id: Number(id), title }, { searchAt: st.ts, mode: 'MoviesSearch', manual: true });
      metrics.emitEvent('search', { ti: title, ap: a, id: Number(id), mode: 'MoviesSearch', manual: true });
    }
    else {
      if (refs.length) {
        metrics.emitEvent('retry', {
          ap: a,
          id: Number(id),
          mode: 'EpisodeSearch',
          manual: true,
          eps: refs.map((e) => `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}`),
        });
        await arrPost(a, '/command', { name: 'EpisodeSearch', episodeIds: refs.map((e) => e.id) }, 8000);
        st.ts = Date.now();
        searchState.set(key, st);
        trackSearchDispatch(a, { id: Number(id), title }, {
          searchAt: st.ts,
          mode: 'EpisodeSearch',
          manual: true,
          episodeCodes: refs.map((e) => `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}`),
        });
        metrics.emitEvent('search', { ti: title, ap: a, id: Number(id), mode: 'EpisodeSearch', manual: true, eps: refs.map((e) => `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}`) });
      } else {
        metrics.emitEvent('retry', { ap: a, id: Number(id), mode: 'SeriesSearch', manual: true });
        await arrPost(a, '/command', { name: 'SeriesSearch', seriesId: Number(id) }, 5000);
        st.ts = Date.now();
        searchState.set(key, st);
        trackSearchDispatch(a, { id: Number(id), title }, { searchAt: st.ts, mode: 'SeriesSearch', manual: true });
        metrics.emitEvent('search', { ti: title, ap: a, id: Number(id), mode: 'SeriesSearch', manual: true });
      }
    }
    persistState();
    console.log(`retry: triggered search for ${a} id=${id}`);
    bustDownloadsCache();
    res.json({ ok: true });
  } catch (e) {
    const key = `${a}:${Number(id)}`;
    const msg = String(e.message || e);
    const st = searchState.get(key) || {};
    Object.assign(st, {
      lastReason: 'trigger_failed',
      lastError: msg,
      lastAt: Date.now(),
      lastOutcomeKind: 'error',
      lastOutcomeSummary: `search trigger failed: ${msg}`,
      lastOutcomeAt: Date.now(),
    });
    searchState.set(key, st);
    persistState();
    metrics.emitEvent('search_skip', { ap: a, id: Number(id), reason: 'trigger_failed', error: msg, manual: true });
    console.log(`retry: failed for ${a} id=${id} — ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// Force-grab the best "search gap" release — one that's healthy upstream (raw text search) but that
// Sonarr's structured season-search never surfaced (e.g. a year-named full-series pack with no S01
// marker). Adds the release to qBittorrent directly via its magnet link or infoHash (bypassing the
// broken Prowlarr POST /api/v1/search grab path). Sonarr's download client monitor will pick it up
// from the qBittorrent queue and import it when complete.
app.post('/api/force-grab', async (req, res) => {
  const { app: a, id, release } = req.body || {};
  if (a !== 'sonarr' || id == null) return res.status(400).json({ error: 'body must be {app:"sonarr",id}' });
  try {
    const key = `${a}:${Number(id)}`;
    const st = searchState.get(key) || {};
    let rel, title;
    if (release && (release.guid || release.infoHash)) {
      // User-selected release from the UI — use it directly
      rel = release;
      title = release.title || 'Unknown';
    } else {
      // Fallback: fresh search + best pick (backward compat for scripts/curl)
      title = st.lastSearchTitle || (st.searchProbe && st.searchProbe.title) || await arrTitle(a, Number(id), []);
      let gap = await probeSearchGap(title, []);
      if ((!gap || !gap.best) && st.lastSearchGap) gap = st.lastSearchGap;
      if (!gap || !gap.best) return res.status(404).json({ error: 'no grabbable gap release found' });
      rel = gap.best;
    }
    const { title: relTitle, seeders } = rel;
    const result = await grabGapRelease(rel, 'sonarr-force');
    // Track for post-grab import guarantee: when the torrent completes (or lands on disk),
    // the watchdog will retry Manual Import until all episodes are accounted for.
    if (result.infoHash) {
      forceGrabImport.set(String(result.infoHash).toLowerCase(), { app: a, id: Number(id), seriesTitle: title, folder: null });
    }
    searchKeyClear(a, Number(id));
    Object.assign(st, { lastReason: 'force_grab', lastAt: Date.now(), lastOutcomeKind: 'grabbing', lastOutcomeSummary: `force-grabbed "${relTitle}"`, lastOutcomeAt: Date.now(), lastError: null, fails: 0, blockedUntil: 0 });
    searchState.set(key, st);
    persistState();
    metrics.emitEvent('force_grab', { ap: a, id: Number(id), ti: title, rel: relTitle, seeders, indexer: rel.indexer, method: result.method, infoHash: result.infoHash });
    console.log(`force-grab: sonarr id=${id} → "${relTitle}" (${seeders} seeders, ${result.method})`);
    bustDownloadsCache();
    res.json({ ok: true, grabbed: relTitle, seeders, method: result.method });
  } catch (e) {
    const msg = String(e.message || e);
    metrics.emitEvent('force_grab', { ap: a, id: Number(id), error: msg });
    console.log(`force-grab: failed for sonarr id=${id} — ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// Read-only: return all grabbable gap releases for a Sonarr item (no side effects).
// The UI calls this to populate the manual-grab release picker.
app.post('/api/force-grab/search', async (req, res) => {
  const { app: a, id } = req.body || {};
  if (a !== 'sonarr' || id == null) return res.status(400).json({ error: 'body must be {app:"sonarr",id}' });
  try {
    const st = searchState.get(`${a}:${Number(id)}`) || {};
    const title = st.lastSearchTitle || (st.searchProbe && st.searchProbe.title) || await arrTitle(a, Number(id), []);
    // Fetch series metadata from Sonarr (best-effort)
    let series = null;
    try {
      const s = await arrGet('sonarr', `/series/${Number(id)}`, 6000);
      if (s) {
        const monitoredSeasons = (s.seasons || []).filter((sn) => sn.monitored && sn.seasonNumber > 0);
        series = {
          title: s.title,
          year: s.year || null,
          tvdbId: s.tvdbId || null,
          monitoredSeasonCount: monitoredSeasons.length,
          episodeCount: (s.statistics && s.statistics.episodeCount) || null,
          runtime: s.runtime || null,
        };
      }
    } catch { /* best-effort */ }
    let gap = await probeSearchGap(title, []);
    if (!gap || !gap.all || !gap.all.length) return res.json({ results: [], query: gap?.query || null, series });
    return res.json({ results: gap.all, query: gap.query, summary: gap.summary, series });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- Disk gate: decline a download that can't fit under the 20 GB cap ----
// Single-admin Jellyseerr auto-approves the owner's OWN requests, so there's no
// "pending" window to gate at the request stage. Instead we intercept at the download
// stage: once a torrent's real size is known (from metadata, within seconds — before it
// has pulled anything meaningful), if completing it would push /data past the cap we tear
// the title down everywhere (the same recipe as a manual delete, so no Radarr re-grab
// loop and the Jellyseerr mark is cleared) and remember WHY — the Downloads view then

module.exports = {};
