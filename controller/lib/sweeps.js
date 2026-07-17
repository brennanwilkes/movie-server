'use strict';
// Housekeeping sweeps: diskGate (decline downloads that can't fit), orphanSweep
// (torrents whose *arr item is gone + missingFiles zombies), seerrSweep
// (Jellyseerr rows whose *arr counterpart is gone), and requestGate (surface
// requests the *arrs rejected for disk space). Owns: each sweep's busy flag.
// Timers: startSweeps() → diskGate 30s/6s, orphanSweep 5m/15s, seerrSweep
// 15m/30s, requestGate 5m/15s.

const fs = require('fs');
const metrics = require('../metrics');
const { cfg } = require('./config');
const { qbit, arrGet, seerr } = require('./clients');
const { getQbitTorrents, torrentApp, arrIdForHash } = require('./arr-data');
const { declined, blocked, persistState, isMasterPaused } = require('./state');
const { buildDeletePlan, executeDelete } = require('./delete-plan');
const { freeUnderCap, arrTitle, arrHasActivity, diagnose } = require('./arr-inspect');

// ---- Disk gate: decline a download that can't fit under the 20 GB cap ----
// Single-admin Jellyseerr auto-approves the owner's OWN requests, so there's no
// "pending" window to gate at the request stage. Instead we intercept at the download
// stage: once a torrent's real size is known (from metadata, within seconds — before it
// has pulled anything meaningful), if completing it would push /data past the cap we tear
// the title down everywhere (the same recipe as a manual delete, so no Radarr re-grab
// loop and the Jellyseerr mark is cleared) and remember WHY — the Downloads view then
// shows "Declined — not enough disk space" instead of a stuck ENOSPC half-download.
let gateBusy = false;
async function diskGate() {
  if (isMasterPaused()) return;                               // Movie Mode — torrents are stopped, nothing to gate
  if (gateBusy) return;                                   // teardown can outlast the interval
  gateBusy = true;
  try {
    const now = Math.floor(Date.now() / 1000), DAY = 86400;
    for (const [h, d] of declined) if (now - d.ts > DAY) declined.delete(h); // bound memory
    let used, cap;
    try {
      const s = await fs.promises.statfs('/data');
      const total = s.blocks * s.bsize;
      used = total - s.bavail * s.bsize;
      cap = total > 0 ? total : 0;
    } catch { return; }
    const torrents = await getQbitTorrents();

    // Build hash→arrId + id→hasFile maps once so we never decline already-imported media.
    const idByHash = new Map();
    const idHasFile = {};
    for (const a of ['radarr', 'sonarr']) {
      try { for (const r of ((await arrGet(a, '/history?pageSize=500&sortKey=date&sortDirection=descending')).records || [])) { const h = (r.downloadId || '').toLowerCase(); if (h && (r.movieId || r.seriesId) != null) idByHash.set(h, { app: a, id: r.movieId || r.seriesId }); } } catch { /* */ }
      try { for (const r of ((await arrGet(a, '/queue?pageSize=200')).records || [])) { if (r.downloadId) idByHash.set(r.downloadId.toLowerCase(), { app: a, id: r.movieId || r.seriesId }); } } catch { /* */ }
      try {
        const m = new Map();
        if (a === 'radarr') for (const mv of await arrGet('radarr', '/movie')) m.set(mv.id, !!mv.hasFile);
        else for (const s of await arrGet('sonarr', '/series')) m.set(s.id, ((s.statistics && s.statistics.episodeFileCount) || 0) > 0);
        idHasFile[a] = m;
      } catch { idHasFile[a] = new Map(); }
    }

    // Pre-compute remaining bytes per *arr item so fragmented seasons are still
    // blocked collectively but independent titles don't interfere with each other.
    const pendingByItem = new Map(); // "app:id" → remaining bytes
    for (const t of torrents) {
      const app = torrentApp(t);
      if (!app) continue;
      const sz = t.size || 0;
      if (sz <= 0 || (t.state || '') === 'metaDL') continue;
      const h = (t.hash || '').toLowerCase();
      const info = idByHash.get(h);
      if (info) {
        const key = `${info.app}:${info.id}`;
        pendingByItem.set(key, (pendingByItem.get(key) || 0) + sz * (1 - (t.progress || 0)));
      }
    }

    for (const t of torrents) {
      const hash = (t.hash || '').toLowerCase();
      if (!hash) continue;
      const prev = declined.get(hash);
      if (prev && now - prev.ts < 60) continue;           // just torn down — let qbit catch up
      const app = torrentApp(t);
      if (!app) continue;                                 // only *arr-managed titles
      // Never decline a torrent whose *arr item already has files (already imported).
      const hi = idByHash.get(hash);
      if (hi && idHasFile[hi.app]?.get(hi.id) === true) continue;
      const size = t.size || 0;
      if (size <= 0 || (t.state || '') === 'metaDL') continue; // real size not known yet
      const onDisk = size * (t.progress || 0);            // this torrent's bytes already on /data
      const usedByOthers = Math.max(0, used - onDisk);
      const thisPending = size - onDisk;                  // what this torrent still needs
      // Only count other pending from the same *arr item, not cross-item.
      const key = hi ? `${hi.app}:${hi.id}` : null;
      const otherPending = key ? Math.max(0, (pendingByItem.get(key) || 0) - thisPending) : 0;
      if (usedByOthers + size + otherPending <= cap) continue; // it fits — let it run
      const freeForIt = Math.max(0, cap - usedByOthers - otherPending);
      // Look up the *arr item via our batch map (built once per cycle), falling
      // back to a fresh API call so we never miss — otherwise we'd delete the
      // torrent but leave the *arr item orphaned with no files.
      const hiId = hi ? hi.id : null;
      const arrId = hiId != null ? hiId : await arrIdForHash(app, hash).catch(() => null);
      try {
        if (arrId != null) await executeDelete(await buildDeletePlan(app, arrId)); // full teardown
        else await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ hashes: t.hash, deleteFiles: 'true' }) });
      } catch (e) { console.log(`diskGate: teardown failed for "${t.name}" — ${String(e.message || e)}`); }
      declined.set(hash, { title: t.name, neededBytes: size, freeBytes: freeForIt, ts: now, source: app, arrId });
      console.log(`diskGate: declined "${t.name}" — needs ${size} B but only ${freeForIt} B free under cap`);
      metrics.emitEvent('decline', { ti: t.name, ap: app, sB: size, free: freeForIt });
    }

    // Second pass: when we've declined a torrent for a specific *arr item, tear down
    // ALL sibling torrents belonging to the same item (fragmented seasons where one
    // episode is blocked should block the whole season). Uses `idByHash` from above.
    for (const [dh, dd] of declined) {
      if (now - dd.ts > 120 || dd.arrId == null) continue;
      for (const t of torrents) {
        const th = (t.hash || '').toLowerCase();
        if (th === dh || declined.has(th) || !torrentApp(t) || torrentApp(t) !== dd.source) continue;
        const info = idByHash.get(th);
        if (info && info.id === dd.arrId) {
          try {
            await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ hashes: t.hash, deleteFiles: 'true' }) });
          } catch { /* */ }
          declined.set(th, { title: t.name, neededBytes: t.size || 0, freeBytes: 0, ts: now, source: dd.source, arrId: dd.arrId });
        }
      }
    }
  } finally { gateBusy = false; persistState(); }
}
// ---- Orphan sweep: tear down *arr torrents whose series/movie has been deleted ----
// When a TV show or movie is deleted from the library some per-episode torrents may
// still be waiting in the qBittorrent queue (or are added asynchronously by *arr in a
// race with deletion). These orphans have an *arr category but belong to an item that
// no longer exists — they'll keep downloading forever with no parent row to delete
// them from. This sweep finds and removes them.
let orphanBusy = false;
async function orphanSweep() {
  if (isMasterPaused()) return;                               // Movie Mode — no cleanup churn
  if (orphanBusy) return;
  orphanBusy = true;
  try {
    const torrents = await getQbitTorrents();
    let hasArr = false;
    for (const t of torrents) { if (torrentApp(t)) { hasArr = true; break; } }
    if (!hasArr) return;

    const byApp = { radarr: [], sonarr: [] };
    for (const t of torrents) { const a = torrentApp(t); if (a) byApp[a].push(t); }

    for (const app of ['radarr', 'sonarr']) {
      const arrTorrents = byApp[app];
      if (!arrTorrents.length) continue;

      let items;
      try { items = await arrGet(app, app === 'radarr' ? '/movie' : '/series'); }
      catch { continue; }
      const knownIds = new Set(items.map((i) => i.id));

      // Build hash → *arrId map from history + queue so we can link a torrent
      // hash back to the movie/series it was grabbed for.
      const idByHash = new Map();
      try {
        for (const r of ((await arrGet(app, '/history?pageSize=500&sortKey=date&sortDirection=descending')).records || [])) {
          const h = (r.downloadId || '').toLowerCase(); if (!h) continue;
          const pid = r.movieId || r.seriesId;
          if (pid != null) idByHash.set(h, pid);
        }
      } catch { /* history down */ }
      try {
        for (const r of ((await arrGet(app, '/queue?pageSize=200')).records || [])) {
          if (r.downloadId) idByHash.set(r.downloadId.toLowerCase(), r.movieId || r.seriesId);
        }
      } catch { /* queue down */ }

      const toRemove = [];
      const zombies = [];
      const nowS = Math.floor(Date.now() / 1000);
      for (const t of arrTorrents) {
        const hash = (t.hash || '').toLowerCase();
        const arrId = idByHash.get(hash);
        // If we know the *arr item this torrent belongs to and that item is gone → orphan
        if (arrId != null && !knownIds.has(arrId)) { toRemove.push(t.hash); continue; }
        // Zombie ledger entries: a torrent stuck in missingFiles for days is dead weight —
        // its payload is gone from disk (the 2026-06-29 outage left 44 of these, invisible
        // to the orphan rule above because the 500-event history window no longer reaches
        // their grabs). 48h rules out a transient post-crash recheck that self-heals; if the
        // title is genuinely still wanted, the *arr sweep re-searches it. deleteFiles=false —
        // there are no files, and we never risk touching a library hardlink.
        if (t.state === 'missingFiles' && nowS - (t.added_on || 0) > 172800) zombies.push(t.hash);
      }

      if (toRemove.length) {
        try {
          const body = new URLSearchParams({ hashes: toRemove.join('|'), deleteFiles: 'true' });
          await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
          console.log(`orphanSweep: removed ${toRemove.length} orphaned torrent(s) from ${app}`);
          metrics.emitEvent('orphan', { count: toRemove.length, ap: app, type: 'orphan' });
        } catch (e) { console.log(`orphanSweep: teardown failed — ${String(e.message || e)}`); }
      }
      if (zombies.length) {
        try {
          const body = new URLSearchParams({ hashes: zombies.join('|'), deleteFiles: 'false' });
          await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
          console.log(`orphanSweep: removed ${zombies.length} zombie missingFiles torrent(s) from ${app} (entries only — no files on disk)`);
          metrics.emitEvent('zombie', { count: zombies.length, ap: app });
        } catch (e) { console.log(`orphanSweep: zombie cleanup failed — ${String(e.message || e)}`); }
      }
    }
  } finally { orphanBusy = false; }
}
// ---- Seerr orphan sweep: remove media entries whose *arr counterpart is gone ----
let seerrSweepBusy = false;
async function seerrSweep() {
  if (isMasterPaused() || seerrSweepBusy || !cfg.SEERR_KEY) return;     // Movie Mode — no request processing
  seerrSweepBusy = true;
  try {
    const [mr, sonarrItems, radarrItems] = await Promise.all([
      seerr.fetch('/api/v1/media?take=5000', { ms: 10000 }),
      arrGet('sonarr', '/series', 8000).catch(() => []),
      arrGet('radarr', '/movie', 8000).catch(() => []),
    ]);
    if (!mr.ok) return;
    const data = await mr.json();
    const allSeerr = data.results || [];
    if (!allSeerr.length) return;

    const known = new Set();
    for (const s of (Array.isArray(sonarrItems) ? sonarrItems : [])) { const t = s.tmdbId; if (t) known.add(String(t)); }
    for (const r of (Array.isArray(radarrItems) ? radarrItems : [])) { const t = r.tmdbId; if (t) known.add(String(t)); }

    const orphans = allSeerr.filter((m) => {
      const tid = m.tmdbId;
      const status = m.status || 0;
      return tid && !known.has(String(tid)) && status >= 4;
    });

    if (!orphans.length) return;
    for (const o of orphans) {
      try {
        const r = await seerr.fetch(`/api/v1/media/${o.id}`, { method: 'DELETE', ms: 5000 });
        if (r.ok || r.status === 204) console.log(`seerrSweep: removed orphan id=${o.id} tmdb=${o.tmdbId}`);
        else console.log(`seerrSweep: failed to delete id=${o.id} — HTTP ${r.status}`);
      } catch (e) { console.log(`seerrSweep: error deleting id=${o.id} — ${e.message || e}`); }
    }
  } catch (e) { console.log(`seerrSweep: sweep failed — ${e.message || e}`); }
  finally { seerrSweepBusy = false; }
}
// ---- Request gate: surface a request that Radarr/Sonarr REJECTED for disk space ----
// The *arrs enforce the 20 GB cap themselves ("…will exceed available disk space") and
// drop the release at SEARCH time — so nothing ever reaches qBittorrent and the disk gate
// above never sees it; Jellyseerr just shows "request successful" forever. We close that
// gap: for a request stuck in "processing" with no download, we reproduce the *arr's own
// rejections via an interactive search. If the only thing standing between us and a grab is
// space (a release rejected SOLELY for disk space exists), we flag it Declined with the
// real numbers. Non-disk stalls ("no release found yet") are transient — left alone.
// (`blocked` is declared up by `declined` so loadState() can restore it before this point.)
let reqBusy = false;
async function requestGate() {
  if (reqBusy) return;
  reqBusy = true;
  try {
    let results;
    try { const r = await seerr.fetch('/api/v1/request?take=50&sort=added'); results = r.ok ? (await r.json()).results || [] : null; } catch { return; }
    if (!results) return;
    const now = Math.floor(Date.now() / 1000);
    for (const [k, v] of blocked) if (now - v.ts > 86400) blocked.delete(k); // bound memory
    let free = null;
    for (const req of results) {
      const app = req.type === 'tv' ? 'sonarr' : 'radarr';
      const id = (req.media || {}).externalServiceId;
      if (id == null) continue;
      if (req.media.status !== 3) {                     // not "processing" (available/declined/etc.)
        for (const k of [...blocked.keys()]) if (k.startsWith(`${app}:${id}:`)) blocked.delete(k);
        continue;
      }
      const seasons = (req.seasons || []).map((s) => s.seasonNumber).filter((n) => n != null);
      const key = `${app}:${id}:${seasons.join(',')}`;
      const prev = blocked.get(key);
      const created = Math.floor(new Date(req.createdAt || req.updatedAt || 0).getTime() / 1000);
      if (created && now - created < 120) continue;     // let a normal grab happen first
      if (prev && now - prev.lastCheck < 1800) continue; // re-diagnose at most every 30 min
      if (await arrHasActivity(app, id)) { blocked.delete(key); continue; } // it's moving — not stuck
      const hit = await diagnose(app, id, seasons);
      if (hit) {
        if (free == null) free = await freeUnderCap();
        blocked.set(key, { title: await arrTitle(app, id, seasons), neededBytes: hit.size, freeBytes: free, ts: prev ? prev.ts : now, lastCheck: now });
        console.log(`requestGate: "${key}" blocked on disk — best release ${hit.size} B vs ${free} B free`);
        metrics.emitEvent('req_blocked', { key, sB: hit.size, free });
      } else blocked.delete(key);                       // stuck for a non-disk reason → don't flag
    }
  } finally { reqBusy = false; persistState(); }
}

function startSweeps() {
setInterval(diskGate, 30000); // 30s (was 8s); cheap (qbit info + statfs); 30s still catches a new torrent before it fills /data (3.7TB headroom)
setTimeout(diskGate, 6000);
setInterval(orphanSweep, 300000);   // every 5 min (was 60s); orphan torrents are harmless and don't trend in under 5 min
setTimeout(orphanSweep, 15000);
setInterval(seerrSweep, 900000); // every 15 min (was 5min); orphan cleanup doesn't need 5min resolution
setTimeout(seerrSweep, 30000);   // first run after 30s
setInterval(requestGate, 300000);   // every 5 min (was 60s); stuck Jellyseerr requests stay stuck for hours, not seconds
setTimeout(requestGate, 15000);
}

module.exports = { diskGate, orphanSweep, seerrSweep, requestGate, startSweeps };
