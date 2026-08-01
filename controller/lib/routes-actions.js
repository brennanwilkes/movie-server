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
const {
  arrIdForHash, arrParseEntity, normName, getQbitTorrents, torrentApp,
} = require('./arr-data');
// Shared release-title rules — the same gate the Audit tab uses for its candidates.
const {
  srcRank, REENC_RE, audioOf, refusedReason, scopeOf, SCOPE_LABEL, resOf, codecOf, TENBIT_RE,
  supersedes, editionRefusal, overResCeiling,
} = require('./release-rules');
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
// Audit swap identity. An in-flight swap keeps the ORIGINAL on disk while the replacement downloads,
// so a hash-based delete of the replacement would take the original with it — see audit.js.
const { isSwapHash, swapForHash } = require('./state');
const { forgetSwap } = require('./audit');
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
          const mf = m.movieFile;
          const mi = mf && mf.mediaInfo;
          const item = { id: m.id, title: m.title, year: m.year, hasFile: !!m.hasFile, sizeBytes: (mf && mf.size) || m.sizeOnDisk || 0, tmdbId: m.tmdbId, runtimeMinutes: m.runtime || 0, videoLabel: videoLabel(mi), gpuCompat: gpuTier(mi), source: (mf && mf.quality && mf.quality.quality && mf.quality.quality.name) || null, audioCodec: (mi && mi.audioCodec) || null, audioCh: (mi && mi.audioChannels) || null };
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
          const ef = efs.find((ef) => ef.mediaInfo);
          if (ef) miBySeries[s.id] = { mi: ef.mediaInfo, src: ((ef.quality || {}).quality || {}).name || null };
        }));
        items = seriesList.map((s) => {
          const mi = miBySeries[s.id];
          const item = { id: s.id, title: s.title, year: s.year, hasFile: ((s.statistics && s.statistics.episodeFileCount) || 0) > 0, sizeBytes: (s.statistics && s.statistics.sizeOnDisk) || 0, tmdbId: s.tmdbId, runtimeMinutes: (s.runtime && s.statistics && s.statistics.episodeFileCount) ? s.runtime * s.statistics.episodeFileCount : 0, videoLabel: videoLabel(mi && mi.mi), gpuCompat: gpuTier(mi && mi.mi), source: (mi && mi.src) || null, audioCodec: (mi && mi.mi && mi.mi.audioCodec) || null, audioCh: (mi && mi.mi && mi.mi.audioChannels) || null };
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
    // AN IN-FLIGHT AUDIT SWAP IS NOT DELETABLE BY HASH. The replacement torrent resolves to the same
    // library item as the original, which is still on disk and still playable — so the layered plan
    // built from this hash would delete the whole title when the user only meant "stop this
    // download". Enforced HERE and not just in the UI: a stale tab, a direct curl, or a future caller
    // must not be able to reach that path. /api/torrent/delete is the correct door, and it forgets
    // the swap without touching a file.
    if (byHash && !String(hash).startsWith('missing:') && (isSwapHash(hash) || forceGrabImport.has(String(hash).toLowerCase()))) {
      const sw = swapForHash(hash);
      if (sw) {
        return res.status(409).json({
          error: 'This is an Audit replacement download. Cancelling it must not delete the copy you '
            + 'already have — use the cancel-download path instead.',
          swap: true,
          title: (sw.pending && sw.pending.title) || null,
        });
      }
      // A MANUAL FORCE-GRAB (`sonarr-force`): the import watchdog is the ONLY thing allowed to import
      // or delete those files (AGENTS.md force-grab invariants), and a hash delete here would wipe the
      // download folder the watchdog needs. Same 409, pointing at the safe cancel-download path.
      return res.status(409).json({
        error: 'This is a manual force-grab owned by the import watchdog. Deleting it here would '
          + 'destroy files only the watchdog may import or remove — use the cancel-download path instead.',
        forceGrab: true,
      });
    }
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
//
// This is also the ONLY correct way to cancel an in-flight Audit swap. It touches the torrent and
// nothing else: deleteFiles removes the partial download from the downloads directory, and because
// imports are hardlinked, even a swap that already imported keeps its library copy (a hardlink is a
// second directory entry for the same data — this is the same reason the reclaim sweep is safe).
// The original file the swap was going to replace is never in scope here at all.
app.post('/api/torrent/delete', async (req, res) => {
  const { hash, deleteFiles = true } = req.body || {};
  if (!hash) return res.status(400).json({ error: 'hash is required' });
  try {
    // Forget the swap FIRST. If qBittorrent errors we have still stopped the sweep from acting on a
    // torrent the user has asked to be rid of, and the swap's own 48h abandon keeps the original
    // either way. Doing it after a failed delete would leave the sweep chasing a cancelled swap.
    const wasSwap = forgetSwap(hash);
    const body = new URLSearchParams({ hashes: hash, deleteFiles: String(deleteFiles) });
    const r = await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    bustDownloadsCache();
    if (wasSwap) {
      metrics.emitEvent('audit_replace_cancelled', { ti: wasSwap.title, ap: wasSwap.app, id: wasSwap.id });
      console.log(`torrent/delete: cancelled the audit replacement for "${wasSwap.title}" — the existing copy is untouched`);
    }
    res.json({ ok: r.ok, swapCancelled: !!wasSwap, title: wasSwap ? wasSwap.title : null });
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

// When a human picks a release, the dead download it was picked to REPLACE used to keep running
// until its own stall clock expired — so a fresh S05 pack sat alongside the stalled S05E09 that
// prompted the pick, and both were racing to import the same episode. Cancel the superseded ones.
//
// Every guard below exists to make a wrong cancel impossible rather than merely unlikely, because a
// MISSED cancel is harmless (the torrent's own give-up clock still ends it) while a wrong cancel
// throws away real progress. All of these must hold:
//   - same Sonarr series, proven by *arr's own queue/history record for that hash. Unresolvable id
//     means skip: it is exactly the ambiguity we must not guess through.
//   - stalled with ZERO seeds. A stalled torrent with peers may still resume; one with no swarm
//     cannot, so nothing is being discarded.
//   - the new pick genuinely COVERS it — every season the old release carries is inside the new
//     one's span, and an episode is only superseded by a pack or by that same episode. 'unknown'
//     scope on either side is a skip, never an assumption.
//   - not an in-flight audit swap (that original is still on disk — see /api/torrent/delete) and
//     not the torrent we just added.
async function cancelSuperseded(seriesId, newHash, newTitle) {
  const neu = scopeOf(newTitle);
  const out = [];
  for (const t of await getQbitTorrents()) {
    const h = String(t.hash || '').toLowerCase();
    if (!h || h === String(newHash || '').toLowerCase()) continue;
    if (torrentApp(t) !== 'sonarr') continue;
    if (t.state !== 'stalledDL' || (t.num_seeds || 0) > 0) continue;
    if (isSwapHash(h)) continue;
    if (!supersedes(neu, scopeOf(t.name))) continue;
    if (await arrIdForHash('sonarr', h) !== Number(seriesId)) continue;
    try {
      await qbit.fetch('/api/v2/torrents/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ hashes: h, deleteFiles: 'true' }),
      });
      out.push(t.name);
      console.log(`force-grab: cancelled "${t.name}" — superseded by "${newTitle}" (stalled, 0 seeds)`);
    } catch (e) { console.log(`force-grab: could not cancel "${t.name}" — ${String(e.message || e)}`); }
  }
  return out;
}

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
    // AFTER the grab, never before: if adding the release fails we must not have thrown away the
    // dead one it was meant to replace. Non-fatal — a grab that worked is reported as a success even
    // if the tidy-up did not, since the stalled row's own clock is still there as the backstop.
    let superseded = [];
    try { superseded = await cancelSuperseded(Number(id), result.infoHash, relTitle); } catch (e) {
      console.log(`force-grab: supersede sweep failed — ${String(e.message || e)}`);
    }
    bustDownloadsCache();
    res.json({
      ok: true, grabbed: relTitle, seeders, method: result.method, superseded,
    });
  } catch (e) {
    const msg = String(e.message || e);
    metrics.emitEvent('force_grab', { ap: a, id: Number(id), error: msg });
    console.log(`force-grab: failed for sonarr id=${id} — ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ---- Manual-grab release picker (read-only) ────────────────────────────────────────────────
// The raw output of probeSearchGap is a Prowlarr TEXT search, which is why the picker exists at all
// (Sonarr's structured season search is what missed these releases). But raw text search is also
// why the list was close to unusable: searching "The Wire" returned 156 results whose top five were
// packs of seasons that are ALREADY COMPLETE, with the one useful release — S05, 236 seeds — buried
// below them, and "Resident Alien S02E02 The Wire" ranked ninth.
//
// So this endpoint now does the work the Audit tab does for its candidates, using the same shared
// rules (./release-rules) so the two can never drift:
//   1. Drop releases that are not this series at all.
//   2. Drop the hard refusals — camrip, extras disc, dubbed/multi-audio, foreign-audio-only.
//   3. Rank releases that cover a season we are actually MISSING episodes from to the top.
//   4. Demote (never drop) low-quality releases, so the rescue tool still works when junk is all
//      that exists — the whole point of the picker is the case where nothing good is seeded.
// Nothing here grabs: the endpoint is a GET-shaped POST with no side effects.

// Below this vertical resolution a release goes in the "lower quality" bucket rather than the main
// list. 720p is the floor for "looks fine on the TV"; 480p/DVD is a visible downgrade that is still
// better than a missing episode, so it is demoted, not refused.
const PICK_RES_FLOOR = 720;
// A release with no seeders cannot finish. probeSearchGap already filters seeders>=1; this is a
// second gate so a future change there cannot silently reintroduce dead releases into the picker.
const PICK_MIN_SEEDERS = 1;
// Sonarr's own parser is authoritative for "is this release this series", but it is a network call
// per release. Most releases are settled by the cheap title test, so only the leftovers are parsed,
// and only up to this many — a 156-result search must not turn into 156 round-trips.
const PICK_MAX_PARSES = 25;

// Does this release cover any season we are missing episodes from? Returns
// 'gap' (covers a season with missing episodes) | 'complete' (only seasons we already have) |
// 'unknown' (scope unclear — cannot tell, so do not claim either way).
function coverageOf(scope, missingSeasons) {
  if (!missingSeasons || !missingSeasons.size) return 'unknown';   // nothing missing, or we could not tell
  if (scope.kind === 'multi' && scope.seasons == null) return 'gap'; // "Complete Series" covers everything
  if (!scope.seasons || !scope.seasons.length) return 'unknown';
  return scope.seasons.some((n) => missingSeasons.has(n)) ? 'gap' : 'complete';
}

app.post('/api/force-grab/search', async (req, res) => {
  const { app: a, id, want } = req.body || {};
  if (a !== 'sonarr' || id == null) return res.status(400).json({ error: 'body must be {app:"sonarr",id}' });
  try {
    const sid = Number(id);
    // `want` is the release title of the row the user clicked the picker on, when there is one. It
    // carries INTENT that the library state cannot: opening the picker on a stalled "American Gods
    // S01" download means S01, even though Sonarr reports no missing episodes there (it is a re-grab,
    // not a gap) — without this the list led with S03 packs. Optional; absent for "Not found" rows,
    // which have no release to point at.
    const wantSeasons = new Set((want ? (scopeOf(want).seasons || []) : []));
    const st = searchState.get(`${a}:${sid}`) || {};
    const title = st.lastSearchTitle || (st.searchProbe && st.searchProbe.title) || await arrTitle(a, sid, []);
    // Fetch series metadata from Sonarr (best-effort). originalLanguage matters: it is what makes a
    // lone foreign-language tag correct rather than a dub — see isForeignOnly.
    let series = null, origLang = null;
    try {
      const s = await arrGet('sonarr', `/series/${sid}`, 6000);
      if (s) {
        const monitoredSeasons = (s.seasons || []).filter((sn) => sn.monitored && sn.seasonNumber > 0);
        origLang = ((s.originalLanguage || {}).name) || null;
        series = {
          title: s.title,
          year: s.year || null,
          tvdbId: s.tvdbId || null,
          monitoredSeasonCount: monitoredSeasons.length,
          episodeCount: (s.statistics && s.statistics.episodeCount) || null,
          runtime: s.runtime || null,
          origLang,
        };
      }
    } catch { /* best-effort */ }

    // WHICH SEASONS ARE ACTUALLY MISSING. This is the single most useful signal in the whole list:
    // for The Wire it is the difference between offering the S05 pack that fixes the gap and
    // offering four packs of seasons that are already finished.
    let missingSeasons = new Set(), gapLabel = null;
    try {
      const miss = await missingEpisodes(sid);
      missingSeasons = new Set(miss.map((e) => e.seasonNumber));
      if (miss.length) {
        const bySeason = new Map();
        for (const e of miss) bySeason.set(e.seasonNumber, (bySeason.get(e.seasonNumber) || 0) + 1);
        gapLabel = [...bySeason.entries()].sort((x, y) => x[0] - y[0])
          .map(([sn, n]) => `S${String(sn).padStart(2, '0')} (${n} ep${n > 1 ? 's' : ''})`).join(', ');
      }
    } catch { /* best-effort — an unknown gap just means no gap-aware ranking */ }

    const gap = await probeSearchGap(title, []);
    const raw = (gap && gap.all) || [];
    if (!raw.length) return res.json({ results: [], weak: [], query: gap?.query || null, series, gapLabel });

    // ── Wrong-series drop. The cheap test first: after normalisation the release must START with
    // the series title. "Resident Alien S02E02 The Wire" contains "the wire" but does not start with
    // it, which is exactly the case that ranked ninth. Releases that fail the cheap test are not
    // discarded blind — they go to Sonarr's own parser, which is authoritative, up to a budget.
    const seriesTitles = [series && series.title, title].filter(Boolean);
    const norms = seriesTitles.map((s) => normName(s));
    // Group prefixes ("[SubsPlease] Show - 01") would defeat a strict prefix test, so a leading
    // bracketed or "Group -" prefix is stripped before comparing.
    const stripPrefix = (s) => normName(String(s || '').replace(/^\s*[[(][^\])]{1,30}[\])]\s*/, ''));
    let parses = 0;
    const kept = [];
    for (const r of raw) {
      const t = r.title || '';
      const nt = stripPrefix(t);
      let mine = norms.some((n) => n && (nt === n || nt.startsWith(n + ' ')));
      if (!mine && parses < PICK_MAX_PARSES) {
        parses++;
        const ent = await arrParseEntity('sonarr', t);   // authoritative; shares the global parseCache
        mine = !!(ent && ent.id === sid);
      }
      if (mine) kept.push(r);
    }

    // ── Hard refusals + shaping. Everything a card needs is derived here, once, from the title.
    const refusedCounts = new Map();
    const shaped = [];
    for (const r of kept) {
      const t = r.title || '';
      // 2160p is refused, not merely demoted: nothing here can play it (see MAX_USABLE_RES). This
      // list comes from RAW Prowlarr text search, so *arr's 1080p profile ceiling never filtered it.
      const why = refusedReason(t, origLang) || editionRefusal(t, null, title)
        || (overResCeiling(t) ? 'above 1080p — nothing here can play it' : null);
      if (why) { refusedCounts.set(why, (refusedCounts.get(why) || 0) + 1); continue; }
      if ((r.seeders || 0) < PICK_MIN_SEEDERS) {
        refusedCounts.set('no seeders', (refusedCounts.get('no seeders') || 0) + 1);
        continue;
      }
      const scope = scopeOf(t);
      const res720 = resOf(t);
      shaped.push({
        // Identity — unchanged, this is what /api/force-grab takes back.
        title: t, guid: r.guid, infoHash: r.infoHash || null, indexerId: r.indexerId,
        indexer: r.indexer || null, size: r.size || 0, seeders: r.seeders || 0,
        // Presentation / ranking signals.
        res: res720,
        codec: codecOf(t),
        source: (() => { for (const [re, name] of [[/remux/i, 'Remux'], [/bluray|blu-?ray/i, 'BluRay'],
          [/brrip|bdrip/i, 'BRRip'], [/web-?dl/i, 'WEB-DL'], [/webrip/i, 'WEBRip'],
          [/hdtv/i, 'HDTV'], [/dvd/i, 'DVD']]) if (re.test(t)) return name; return null; })(),
        srcRank: srcRank(t),
        audio: audioOf(t),
        reenc: REENC_RE.test(t),
        tenbit: TENBIT_RE.test(t),
        scope: scope.kind,
        scopeLabel: SCOPE_LABEL[scope.kind],
        seasons: scope.seasons,
        episode: scope.episode,
        coverage: coverageOf(scope, missingSeasons),
        // Does this release cover the season the user actually clicked on? Null when no `want` was
        // sent, so the UI can stay silent rather than implying "no".
        wanted: wantSeasons.size
          ? (scope.kind === 'multi' && scope.seasons == null) || (scope.seasons || []).some((n) => wantSeasons.has(n))
          : null,
        // Below the resolution floor is a DEMOTION, not a refusal — see PICK_RES_FLOOR. The source
        // test matters independently: "The Wire S05 - DVDRip - x264" carries no resolution tag at
        // all, so a res-only check let a DVD rip sit in the main list. srcRank <= 1 is DVD/SDTV.
        weak: (res720 != null && res720 < PICK_RES_FLOOR) || (srcRank(t) ?? 9) <= 1,
      });
    }

    // ── Rank. This picker's job is not the Audit tab's job. The Audit tab ranks quality first,
    // because it is choosing whether to REPLACE a file that already plays. Here nothing plays: the
    // episodes are missing and the previous grabs died at 0 seeds. So the order is what actually
    // gets the gap filled:
    //   1. coverage  — a release that cannot fix the gap is not an answer however pretty it is.
    //   2. scope     — prefer the narrowest thing that covers it. Filling a 3-episode hole in S05
    //                  does not justify a 137 GB five-season pack, and both said "fills your gap".
    //   3. resolution— 1080p is the target, 720p is fine, 2160p is a transcode burden on this NUC
    //                  (see DESIGN-THERMAL), unknown is unknown.
    //   4. seeders   — deliberately ABOVE source tier, which is the opposite of the Audit tab. The
    //                  entire reason this button exists is releases that never downloaded, so a
    //                  236-seed BluRay x265 beats a 16-seed 110 GB REMUX every time.
    //   5. source    — the last tiebreak among otherwise equal options.
    const COV_RANK = { gap: 0, unknown: 1, complete: 2 };
    const SCOPE_RANK = { season: 0, episode: 1, unknown: 2, multi: 3 };
    const resBand = (r) => (r == null ? 0 : r >= 2160 ? 1 : r >= 1080 ? 3 : r >= 720 ? 2 : 0);
    // Seeder buckets, not raw counts: 236 vs 184 seeds is no real difference in whether a torrent
    // finishes, so comparing them directly would let a trivial gap outweigh resolution or scope.
    const seedBand = (n) => (n >= 50 ? 3 : n >= 15 ? 2 : n >= 5 ? 1 : 0);
    // The clicked row's own season outranks everything, INCLUDING our inferred gap: it is stated
    // intent rather than inference. A release can be both, and usually is.
    const cmp = (x, y) => ((x.wanted === false ? 1 : 0) - (y.wanted === false ? 1 : 0))
      || (COV_RANK[x.coverage] - COV_RANK[y.coverage])
      || ((SCOPE_RANK[x.scope] ?? 2) - (SCOPE_RANK[y.scope] ?? 2))
      || (resBand(y.res) - resBand(x.res))
      || (seedBand(y.seeders) - seedBand(x.seeders))
      || ((y.srcRank ?? 2) - (x.srcRank ?? 2))
      || (y.seeders - x.seeders);
    const results = shaped.filter((r) => !r.weak).sort(cmp);
    const weak = shaped.filter((r) => r.weak).sort(cmp);

    const refused = [...refusedCounts.entries()].map(([reason, n]) => ({ reason, n }));
    console.log(`force-grab/search: sonarr id=${sid} "${title}" — ${raw.length} raw → ${kept.length} this series`
      + ` → ${results.length} offered + ${weak.length} lower-quality`
      + (refused.length ? ` (refused: ${refused.map((x) => `${x.n} ${x.reason}`).join(', ')})` : '')
      + (parses ? `; ${parses} *arr parse${parses > 1 ? 's' : ''}` : '')
      + (gapLabel ? `; gap ${gapLabel}` : ''));
    return res.json({
      results, weak, refused, gapLabel, series,
      query: gap.query, summary: gap.summary,
      // Honest accounting so a short list never looks like "nothing exists".
      counts: { raw: raw.length, series: kept.length, offered: results.length, weak: weak.length },
    });
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
