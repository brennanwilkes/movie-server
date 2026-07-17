'use strict';
// The one-click "delete everywhere" recipe: build the 4-layer plan
// (Radarr/Sonarr → qBittorrent → Jellyfin → Jellyseerr), render it for the
// confirm sheet, and execute it in order. Shared by the /api/delete route and
// the diskGate sweep. No owned state, no timers.

const { cfg, HOST } = require('./config');
const { tfetch, qbit, arrGet, arrDelete, seerr } = require('./clients');
const { jellyfinIdByTmdb, seerrMediaId } = require('./jellyfin');
const { arrIdForHash } = require('./arr-data');

// Delete — resolve the 4-layer plan; dry-run by default, then execute in order.
async function buildDeletePlan(app, id) {
  const isMovie = app === 'radarr';
  const item = await arrGet(app, isMovie ? `/movie/${id}` : `/series/${id}`);
  const title = item.title + (item.year ? ` (${item.year})` : '');
  const sizeBytes = isMovie ? ((item.movieFile && item.movieFile.size) || item.sizeOnDisk || 0) : ((item.statistics && item.statistics.sizeOnDisk) || 0);
  // Jellyfin + Seerr (need tmdbId from item) and history→torrents are independent → parallel.
  const [histTor, jf, seerrId] = await Promise.all([
    (async () => {
      let hashes = [];
      try {
        const hist = await arrGet(app, isMovie ? `/history/movie?movieId=${id}` : `/history/series?seriesId=${id}`);
        const recs = Array.isArray(hist) ? hist : (hist.records || []);
        hashes = [...new Set(recs.map((r) => r.downloadId).filter(Boolean).map((h) => h.toLowerCase()))];
      } catch { /* no history */ }
      let torrents = [];
      if (hashes.length) {
        try { const r = await qbit.fetch(`/api/v2/torrents/info?hashes=${hashes.join('|')}`); if (r.ok) torrents = await r.json(); }
        catch { /* qbit down */ }
      }
      return torrents;
    })(),
    (async () => { try { const id = await jellyfinIdByTmdb(isMovie ? 'Movie' : 'Series', item.tmdbId); return { itemId: id }; } catch { return { itemId: null }; } })(),
    (async () => { try { if (item.tmdbId) return await seerrMediaId(isMovie ? 'movie' : 'tv', item.tmdbId); } catch { /* seerr down */ } return null; })(),
  ]);
  return { isMovie, id: Number(id), title, sizeBytes, torrents: histTor, jf, seerrId };
}

function planItems(p) {
  const n = p.torrents.length;
  return [
    { layer: 1, app: p.isMovie ? 'Radarr' : 'Sonarr', action: p.id == null ? 'Not tracked here — nothing to remove' : (p.isMovie ? 'Delete the movie & its file' : 'Delete the series & its files'), willRun: p.id != null },
    { layer: 2, app: 'qBittorrent', action: n ? `Stop seeding & remove ${n} download${n > 1 ? 's' : ''}` : 'No active download to remove', willRun: n > 0 },
    { layer: 3, app: 'Jellyfin', action: p.jf.itemId ? 'Remove from the library' : 'Clears automatically on scan', willRun: !!p.jf.itemId },
    { layer: 4, app: 'Jellyseerr', action: p.seerrId ? 'Clear the “Available” mark' : 'Not in requests', willRun: !!p.seerrId },
  ];
}

async function executeDelete(p) {
  const out = [];
  const arrName = p.isMovie ? 'Radarr' : 'Sonarr';
  // 1 — Radarr/Sonarr (file + Jellyfin auto-scan notification fires here).
  if (p.id == null) {
    out.push({ layer: 1, app: arrName, status: 'skipped', detail: 'not tracked' });
  } else try {
    const r = await arrDelete(p.isMovie ? 'radarr' : 'sonarr', p.isMovie ? `/movie/${p.id}?deleteFiles=true&addImportExclusion=false` : `/series/${p.id}?deleteFiles=true&addImportExclusion=false`);
    out.push({ layer: 1, app: arrName, status: r.ok ? 'done' : 'error', detail: r.ok ? 'deleted' : `HTTP ${r.status}` });
  } catch (e) { out.push({ layer: 1, app: arrName, status: 'error', detail: String(e.message || e) }); }
  // 2 — qBittorrent (hardlinks: space frees once both 1 & 2 are gone).
  if (p.torrents.length) {
    try {
      const body = new URLSearchParams({ hashes: p.torrents.map((t) => t.hash).join('|'), deleteFiles: 'true' });
      const r = await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      out.push({ layer: 2, app: 'qBittorrent', status: r.ok ? 'done' : 'error', detail: r.ok ? `removed ${p.torrents.length}` : `HTTP ${r.status}` });
    } catch (e) { out.push({ layer: 2, app: 'qBittorrent', status: 'error', detail: String(e.message || e) }); }
  } else out.push({ layer: 2, app: 'qBittorrent', status: 'skipped', detail: 'no active download' });
  // 3 — Jellyfin: remove the item directly so it disappears immediately (event-based),
  // rather than waiting on a periodic library scan. Radarr's delete notification is
  // unreliable here, so we don't lean on it. Self-heals: if we miss/mis-resolve, the
  // file is already gone (layer 1) and the next scan reconciles.
  if (p.jf.itemId) {
    try {
      const r = await tfetch(`${HOST.jellyfin}/Items/${p.jf.itemId}`, { method: 'DELETE', headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' } }, 10000);
      out.push({ layer: 3, app: 'Jellyfin', status: (r.ok || r.status === 204) ? 'done' : 'error', detail: (r.ok || r.status === 204) ? 'removed' : `HTTP ${r.status}` });
    } catch (e) { out.push({ layer: 3, app: 'Jellyfin', status: 'error', detail: String(e.message || e) }); }
  } else out.push({ layer: 3, app: 'Jellyfin', status: 'skipped', detail: 'auto-scan clears it' });
  // 4 — Jellyseerr (idempotent; 404 = already gone).
  if (p.seerrId) {
    try {
      const r = await seerr.fetch(`/api/v1/media/${p.seerrId}`, { method: 'DELETE' });
      out.push({ layer: 4, app: 'Jellyseerr', status: (r.ok || r.status === 204 || r.status === 404) ? 'done' : 'error', detail: r.status === 404 ? 'already gone' : (r.ok || r.status === 204) ? 'cleared' : `HTTP ${r.status}` });
    } catch (e) { out.push({ layer: 4, app: 'Jellyseerr', status: 'error', detail: String(e.message || e) }); }
  } else out.push({ layer: 4, app: 'Jellyseerr', status: 'skipped', detail: 'not in requests' });
  return out;
}

// Build a deletion plan from a torrent hash — used by the Downloads page so its delete
// button does the same deep, layered teardown as the Library tab. Resolves the torrent to
// its Radarr/Sonarr item when one exists; otherwise falls back to a torrent-only removal.
async function buildDeletePlanFromHash(hash, source) {
  const h = hash.toLowerCase();
  const order = source === 'sonarr' ? ['sonarr', 'radarr'] : source === 'radarr' ? ['radarr', 'sonarr'] : ['radarr', 'sonarr'];
  for (const app of order) {
    const id = await arrIdForHash(app, h);
    if (id != null) return buildDeletePlan(app, id);
  }
  // No *arr item — assemble a torrent-only plan (layer 1 will show as "not tracked").
  let t = null;
  try { const r = await qbit.fetch('/api/v2/torrents/info'); if (r.ok) t = (await r.json()).find((x) => (x.hash || '').toLowerCase() === h); } catch { /* qbit down */ }
  return { isMovie: source !== 'sonarr', id: null, title: (t && t.name) || 'this download', sizeBytes: (t && t.size) || 0, torrents: t ? [t] : [], jf: { itemId: null }, seerrId: null };
}

module.exports = { buildDeletePlan, planItems, executeDelete, buildDeletePlanFromHash };
