'use strict';
// Cached views of qBittorrent + Radarr/Sonarr + Prowlarr data, and release/
// library correlation helpers (normName, torrentApp, arrOwns). Owns: the
// parseCache Map and the per-pass _parseBudget (reset via resetParseBudget).
// All getters are cachedFetch-backed (stale-on-error). No timers.

const { cfg, HOST } = require('./config');
const { tfetchJson, qbit, arrGet } = require('./clients');
const { cachedFetch, HIST_TTL, QUEUE_TTL } = require('./cache');

// ── Indexer health (from Prowlarr) ──
// Historical query-volume weights per indexer (from Prowlarr stats on 2026-07-06).
// These are near-static — total queries change slowly — so we hardcode to avoid a
// 15+ second Prowlarr aggregation query on every dashboard poll.
const INDEXER_WEIGHTS = {
  'YTS': 10189, 'EZTV': 1671, '1337x': 509, 'Knaben': 1641,
  'LimeTorrents': 1676, 'The Pirate Bay': 1669,
  'The Pirate Bay (year-strip)': 1614,
};
async function getIndexerSnapshot() {
  const key = cfg.PROWLARR_KEY;
  if (!key) return { total: 0, enabled: 0, degraded: 0, degradedPct: 0, indexers: [], totalQueries: 0, degradedNames: [] };
  const [indexers, health, history] = await Promise.all([
    tfetchJson(`${HOST.prowlarr}/api/v1/indexer`, { headers: { 'X-Api-Key': key } }, 10000).catch(() => null),
    tfetchJson(`${HOST.prowlarr}/api/v1/health`, { headers: { 'X-Api-Key': key } }, 5000).catch(() => null),
    tfetchJson(`${HOST.prowlarr}/api/v1/history?pageSize=200&sortKey=date&sortDirection=descending`, { headers: { 'X-Api-Key': key } }, 8000).catch(() => null),
  ]);
  if (!indexers) throw new Error('Prowlarr unreachable');
  // Count recent query failures (last 10 min) per indexer from history.
  // Any failure flags the indexer as degraded (transient 503s = effectively down for search).
  const recentFails = {}; const failCutoff = Date.now() - 600000;
  if (history && history.records) {
    for (const r of history.records) {
      if (r.successful !== false || !r.indexerId) continue;
      if (new Date(r.date).getTime() < failCutoff) continue;
      recentFails[r.indexerId] = (recentFails[r.indexerId] || 0) + 1;
    }
  }
  const healthNames = new Set((health || []).map((h) => h.source || h.type || ''));
  const out = []; let totalQueries = 0;
  for (const ix of indexers) {
    if (ix.protocol !== 'torrent') continue;
    const hw = healthNames.has(ix.name) || healthNames.has(ix.implementation || '');
    const rf = (recentFails[ix.id] || 0) >= 1;
    const q = INDEXER_WEIGHTS[ix.name] || 100;
    totalQueries += q;
    out.push({
      id: ix.id, name: ix.name, queries: q,
      enabled: !!ix.enable, priority: ix.priority || 25,
      healthy: ix.enable ? !(hw || rf) : true,
      healthReason: hw ? 'health-warning' : rf ? 'recent-failures' : null,
    });
  }
  // Weight degradation by query volume share.
  let lostWeight = 0;
  for (const ix of out) {
    if (ix.enabled && !ix.healthy && totalQueries > 0) {
      lostWeight += ix.queries / totalQueries;
    }
  }
  const total = out.length;
  const enabled = out.filter((x) => x.enabled).length;
  const degraded = out.filter((x) => x.enabled && !x.healthy).length;
  const degradedPct = totalQueries > 0 ? Math.round(lostWeight * 100) : (enabled > 0 ? Math.round((degraded / enabled) * 100) : 0);
  const degradedNames = out.filter((x) => x.enabled && !x.healthy).map((x) => x.name);
  return { total, enabled, degraded, degradedPct, indexers: out, totalQueries, degradedNames };
}
const getQbitTorrents = () => cachedFetch('qbit:torrents', 5000, async () => {
  const r = await qbit.fetch('/api/v2/torrents/info'); if (!r.ok) throw new Error('qbit ' + r.status);
  return r.json();
}, []);

const getQueueMap = (app) => cachedFetch(`queue:${app}`, QUEUE_TTL, async () => {
  const m = new Map();
  for (const r of ((await arrGet(app, '/queue?pageSize=500')).records || [])) if (r.downloadId) m.set(r.downloadId.toLowerCase(), r);
  return m;
}, new Map());

// downloadId(hash) -> { imported, id, size }. One newest-first pass over *arr history captures
// everything: import events flag `imported` (+ movie/series id), and GRABBED events carry the
// indexer-reported `data.size` — the only place we learn a magnet's size BEFORE qBittorrent
// fetches its metadata, which is what makes the progress bar real immediately. A thrown page
// aborts the whole fetch so cachedFetch falls back to the last good index (no half-built map).
const getHistoryIndex = (app) => cachedFetch(`hist:${app}`, HIST_TTL, async () => {
  const idx = new Map();
  // A re-grab of the SAME release (identical magnet/hash) is common after an upgrade deletes a
  // file and the next search turns up nothing better — Radarr/Sonarr reuse the exact downloadId.
  // Records are newest-first, so once we reach a hash's most recent 'grabbed' event, everything
  // OLDER for that same hash belongs to a previous cycle (possibly already imported-then-deleted)
  // and must not leak its "imported" flag into the current one — else a re-grab that never
  // actually re-imports gets mislabeled Ready forever, which also disables the import watchdog.
  const cycleClosed = new Set();
  const PAGE = 250, MAX_PAGES = 20;                            // backstop ceiling: 5000 events
  for (let page = 1; page <= MAX_PAGES; page++) {
    const recs = (await arrGet(app, `/history?page=${page}&pageSize=${PAGE}&sortKey=date&sortDirection=descending`)).records || [];
    for (const r of recs) {
      const h = (r.downloadId || '').toLowerCase(); if (!h) continue;
      if (cycleClosed.has(h)) continue;                        // stale cycle of a reused hash — ignore
      const et = (r.eventType || '').toLowerCase();
      const cur = idx.get(h) || { imported: false, id: null, size: 0 };
      if (et.includes('import')) cur.imported = true;
      if (r.movieId) cur.id = r.movieId; if (r.seriesId) cur.id = r.seriesId;
      const sz = Number(r.data && r.data.size) || 0; if (sz > cur.size) cur.size = sz;   // indexer-reported size
      idx.set(h, cur);
      if (et === 'grabbed') cycleClosed.add(h);                // cycle boundary — older records are a prior grab
    }
    if (recs.length < PAGE) break;                             // exhausted history
  }
  return idx;
}, new Map());

// Normalize a title/release name for string matching. Apostrophes are DELETED (not spaced) so
// "Bob's Burgers" → "bobs burgers" matches the release "Bobs.Burgers.S01…" → "bobs burgers s01…";
// every other separator collapses to a single space.
const normName = (s) => String(s || '').toLowerCase().replace(/['’]/g, '').replace(/[._:()\-]/g, ' ').replace(/\s+/g, ' ').trim();

// id -> hasFile, the authoritative "in the library" flag (cached + stale-on-error, like history).
const getHasFileMap = (app) => cachedFetch(`hasFile:${app}`, HIST_TTL, async () => {
  const hasFile = new Map(), nameIds = new Map();
  if (app === 'radarr') for (const mv of await arrGet('radarr', '/movie')) {
    hasFile.set(mv.id, !!mv.hasFile);
    nameIds.set(normName(mv.title), mv.id);
    if (mv.year) nameIds.set(normName(`${mv.title} ${mv.year}`), mv.id);
  } else for (const s of await arrGet('sonarr', '/series')) {
    hasFile.set(s.id, ((s.statistics && s.statistics.episodeFileCount) || 0) > 0);
    nameIds.set(normName(s.title), s.id);
    if (s.year) nameIds.set(normName(`${s.title} ${s.year}`), s.id);
  }
  return { hasFile, nameIds };
}, { hasFile: new Map(), nameIds: new Map() });
// `sonarr-force` is the manual force-grab category. It is NOT one of Sonarr's monitored download
// categories (Sonarr's client uses `sonarr`), so Sonarr's Completed Download Handling never sees
// these torrents and can't auto-import a mis-parsed release into the wrong series. The controller's
// watchdog owns their import (always with the user-chosen seriesId). Here it still maps to 'sonarr'
// so the Downloads UI groups/renders it like any other Sonarr download.
const torrentApp = (t) => { const c = (t.category || '').toLowerCase(); return (c === 'radarr' || c === 'sonarr' || c === 'tv-sonarr' || c === 'sonarr-force') ? (c === 'radarr' ? 'radarr' : 'sonarr') : null; };

// Per-series episodeId -> hasFile, so we can ask "does the library already hold the exact episodes
// this torrent contains" (series-level hasFile is too coarse — true if ANY episode is present).
const getEpisodeHasFile = (seriesId) => cachedFetch(`eps:${seriesId}`, HIST_TTL, async () => {
  const m = new Map();
  for (const e of await arrGet('sonarr', `/episode?seriesId=${seriesId}`, 10000)) m.set(e.id, !!e.hasFile);
  return m;
}, new Map());

// AUTHORITATIVE "is this torrent's content already in the library", independent of the volatile
// history window and of fragile filename matching. Two tiers: (1) a cheap in-memory match of the
// release name against library titles; (2) *arr's own release parser as a fallback for group-
// prefixed / oddly-named releases (e.g. "Star.Wars.Andor.Season.2…" whose series is just "Andor").
// Radarr's hasFile is 1:1 with a movie; Sonarr is verified per-episode via the parsed episode ids.
// Parse results are cached by release name (a name always parses to the same entity + episodes);
// hasFile is re-read live so a later import flips the row to Ready with no cache bust.
const parseCache = new Map(); // `${app}:${name}` -> { id, episodeIds } (only successful parses cached)
// Cold /parse calls are network round-trips to a possibly-loaded *arr. buildDownloads runs every
// 5s over every torrent, so an unbounded parse burst (e.g. ~80 completed Sonarr torrents after a
// restart) would stall the whole snapshot for minutes. We bound cold parses PER buildDownloads
// pass: deferred items simply render "Importing" for a beat and resolve over the next few passes
// (parseCache is permanent, so the backlog drains in seconds). Cache hits are unaffected.
let _parseBudget = 0;
async function arrOwns(app, name, hasFileMap, nameIds) {
  const tn = normName(name);
  const yr = (name || '').match(/\b(19\d\d|20\d\d)\b/)?.[1];
  // Radarr: an in-memory title match is enough (movie hasFile is authoritative & 1:1) — no parse.
  if (app === 'radarr' && nameIds) {
    for (const [nt, id] of nameIds) {
      if (tn === nt || (tn.startsWith(nt + ' ') && (!yr || tn.includes(yr)))) {
        return hasFileMap && hasFileMap.get(id) === true ? { id } : null;
      }
    }
  }
  // Parse fallback (always, for Sonarr — we need the exact episode ids; and for unmatched Radarr).
  const ck = `${app}:${name}`;
  let ent = parseCache.get(ck);
  if (ent === undefined) {
    if (_parseBudget <= 0) return null;        // defer cold parse to a later pass — keeps the 5s refresh fast
    _parseBudget--;
    ent = null;
    try {
      const p = await arrGet(app, `/parse?title=${encodeURIComponent(name)}`, 10000);
      if (app === 'radarr' && p && p.movie && p.movie.id != null) ent = { id: p.movie.id, episodeIds: [] };
      else if (app === 'sonarr' && p && p.series && p.series.id != null) ent = { id: p.series.id, episodeIds: (p.episodes || []).map((e) => e.id) };
      if (ent) parseCache.set(ck, ent); // cache only definitive resolutions; unknown releases re-parse (series may be added later)
    } catch { /* parser unreachable — leave unresolved, retry next poll */ }
  }
  if (!ent) return null;
  if (app === 'radarr') return hasFileMap && hasFileMap.get(ent.id) === true ? { id: ent.id } : null;
  if (!ent.episodeIds.length) return null;                 // couldn't pin episodes → don't claim ownership
  const eps = await getEpisodeHasFile(ent.id);
  return ent.episodeIds.every((id) => eps.get(id) === true) ? { id: ent.id } : null;
}
async function arrIdForHash(app, hash) {
  const r = (await getQueueMap(app)).get(hash);
  if (r) return app === 'radarr' ? r.movieId : r.seriesId;
  const hi = (await getHistoryIndex(app)).get(hash);
  return hi ? hi.id : null;
}

function resetParseBudget(n) { _parseBudget = n; }

module.exports = {
  INDEXER_WEIGHTS, getIndexerSnapshot, getQbitTorrents, getQueueMap,
  getHistoryIndex, normName, getHasFileMap, torrentApp, getEpisodeHasFile,
  arrOwns, resetParseBudget, arrIdForHash,
};
