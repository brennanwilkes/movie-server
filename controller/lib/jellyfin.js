'use strict';
// Jellyfin + Jellyseerr identity resolvers (API-key auth): user/server ids
// (cached in-module), tmdbId → Jellyfin item id, title search fallback, and the
// *arr id → tmdbId lookup. Owns: _jfUserId/_jfServerId caches. No timers.

const { cfg, HOST } = require('./config');
const { tfetch, seerr, arrGet } = require('./clients');
const { _cache } = require('./cache');

// ── Jellyfin helpers (API-key auth) ──
let _jfUserId = null;
async function jellyfinUserId() {
  if (_jfUserId) return _jfUserId;
  const r = await tfetch(`${HOST.jellyfin}/Users`, { headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' } }, 15000);
  const u = await r.json();
  _jfUserId = (u.find((x) => x.Policy && x.Policy.IsAdministrator) || u[0] || {}).Id;
  return _jfUserId;
}
// Find the library item by tmdbId (preferred) or exact title match.
async function jellyfinResolve(type, title, tmdbId) {
  if (!cfg.JELLYFIN_KEY) return { itemId: null };
  const uid = await jellyfinUserId();
  const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };
  const q = new URLSearchParams({ recursive: 'true', includeItemTypes: type, searchTerm: title, fields: 'ProviderIds,ProductionYear', limit: '50' });
  const items = ((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 6000)).json()).Items) || [];
  const match = items.find((i) => tmdbId && i.ProviderIds && i.ProviderIds.Tmdb === String(tmdbId)) || (items.length === 1 ? items[0] : null);
  return { itemId: (match && match.Id) || null };
}

// Server identity (the `serverId` deep-link param) — stable per Jellyfin install, cached.
let _jfServerId = null;
async function jellyfinServerId() {
  if (_jfServerId) return _jfServerId;
  const r = await tfetch(`${HOST.jellyfin}/System/Info`, { headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' } }, 5000);
  _jfServerId = (await r.json()).Id || null;
  return _jfServerId;
}
// Exact item lookup by TMDB id — Jellyfin items carry ProviderIds.Tmdb, so a torrent's
// Radarr/Sonarr tmdbId pins the library item precisely (no fuzzy title matching). The
// server-side `anyProviderIdEquals` filter is a no-op on this build, so match client-side
// over the (small) library.
async function jellyfinIdByTmdb(type, tmdbId) {
  if (!cfg.JELLYFIN_KEY || !tmdbId) return null;
  const t = type || 'Movie,Series';
  const cacheKey = `jfTmdb:${t}:${tmdbId}`;
  // Cache POSITIVE resolutions only (a tmdb->jf id never changes). A "not found" is NOT cached:
  // negative-caching would hide a freshly-imported movie for the whole TTL after Jellyfin scans
  // it. On a miss we also drop any stale positive entry (e.g. after a delete) so it self-heals.
  const c = _cache[cacheKey];
  if (c && Date.now() - c.ts < 300_000) return c.val;
  try {
    const uid = await jellyfinUserId();
    const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };
    const q = new URLSearchParams({ recursive: 'true', includeItemTypes: t, fields: 'ProviderIds', limit: '2000' });
    const items = ((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 8000)).json()).Items) || [];
    const m = items.find((i) => i.ProviderIds && String(i.ProviderIds.Tmdb) === String(tmdbId));
    const id = (m && m.Id) || null;
    if (id) _cache[cacheKey] = { ts: Date.now(), val: id };
    else delete _cache[cacheKey];
    return id;
  } catch {
    return c ? c.val : null;   // network error → last-known-good, else null
  }
}
// Fallback title→item-id lookup (used only when there's no Radarr/Sonarr tmdb id to pin on).
async function jellyfinSearchId(title, type) {
  if (!cfg.JELLYFIN_KEY || !title) return null;
  const uid = await jellyfinUserId();
  const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };
  const q = new URLSearchParams({ recursive: 'true', searchTerm: title, includeItemTypes: type || 'Movie,Series', fields: 'ProductionYear', limit: '10' });
  const items = ((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 6000)).json()).Items) || [];
  return (items[0] && items[0].Id) || null;
}
// Look up a Radarr/Sonarr item's TMDB id (for exact Jellyfin resolution).
async function arrTmdbId(app, id) {
  try { const it = await arrGet(app, app === 'radarr' ? `/movie/${id}` : `/series/${id}`); return it.tmdbId || null; }
  catch { return null; }
}

// ── Jellyseerr media row lookup by TMDB id ──
async function seerrMediaId(kind, tmdbId) {
  const r = await seerr.fetch(`/api/v1/${kind}/${tmdbId}`, { ms: 12000 });
  if (!r.ok) { console.log(`seerrMediaId: ${kind}/${tmdbId} → HTTP ${r.status}`); return null; }
  const d = await r.json();
  if (d.mediaInfo && d.mediaInfo.id) return d.mediaInfo.id;
  // Fallback: /api/v1/media list may have the record under a different shape.
  try {
    const mr = await seerr.fetch(`/api/v1/media?take=5000&sort=mediaAddedAt&order=desc`, { ms: 8000 });
    if (mr.ok) {
      const data = await mr.json();
      const found = (data.results || []).find((x) => String(x.tmdbId) === String(tmdbId) || String(x.tvdbId) === String(tmdbId));
      if (found && found.id) { console.log(`seerrMediaId: found via media list fallback (id=${found.id})`); return found.id; }
    }
  } catch (e) { console.log(`seerrMediaId: fallback search failed — ${e.message || e}`); }
  return null;
}

module.exports = { jellyfinUserId, jellyfinResolve, jellyfinServerId, jellyfinIdByTmdb, jellyfinSearchId, arrTmdbId, seerrMediaId };
