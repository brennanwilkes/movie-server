'use strict';
// Movie-server controller — serves the mobile dashboard (web/) and a same-origin
// API that aggregates the stack and runs the one-click "delete everywhere" recipe.
// Upstreams are reached by container name on the compose network; per-service auth
// is injected here from /config/keys.env so keys never reach the browser.

const fs = require('fs');
const path = require('path');
const express = require('express');

// ── Config: /config/keys.env (written by scripts/provision/controller.sh) over env ──
function loadCfg() {
  const c = { ...process.env };
  try {
    for (const line of fs.readFileSync('/config/keys.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      c[m[1]] = v;
    }
  } catch { /* not provisioned yet — run degraded */ }
  return c;
}
const cfg = loadCfg();

const PORT = Number(cfg.CONTROLLER_PORT || 8088);
const NUC_IP = cfg.NUC_IP || '192.168.1.74';
// The $DATA loopback image IS the hard cap, so its live filesystem size (from statfs
// below) is the real number — no hardcoded constant to drift out of sync on resize.

// Internal (container-network) bases + external ports for browser deep-links.
const HOST = {
  jellyfin: `http://${NUC_IP}:8096`,   // Jellyfin runs on host networking (for PS3 DLNA), so reach it
                                        // via the NUC's IP, not the container DNS name 'jellyfin'.
  qbittorrent: 'http://qbittorrent:8080',
  prowlarr: 'http://prowlarr:9696',
  radarr: 'http://radarr:7878',
  sonarr: 'http://sonarr:8989',
  bazarr: 'http://bazarr:6767',
  jellyseerr: 'http://jellyseerr:5055',
  flaresolverr: 'http://flaresolverr:8191',
};
const PORTS = { jellyfin: 8096, qbittorrent: 8080, prowlarr: 9696, radarr: 7878, sonarr: 8989, bazarr: 6767, jellyseerr: 5055, flaresolverr: 8191 };
const linkFor = (id) => `http://${NUC_IP}:${PORTS[id]}`;

// ── fetch with timeout (fetch only rejects on network error/abort, not HTTP status) ──
async function tfetch(url, opts = {}, ms = 3000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// ── Cookie-auth clients (qBittorrent + Jellyseerr), mirroring the provisioners ──
const qbit = {
  cookie: null,
  async login() {
    const body = new URLSearchParams({ username: cfg.QBIT_USER || '', password: cfg.QBIT_PASS || '' });
    const r = await tfetch(`${HOST.qbittorrent}/api/v2/auth/login`, { method: 'POST', body, headers: { Referer: HOST.qbittorrent } }, 5000);
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    return this.cookie;
  },
  async fetch(p, opts = {}) {
    if (!this.cookie) await this.login();
    const go = () => tfetch(`${HOST.qbittorrent}${p}`, { ...opts, headers: { ...(opts.headers || {}), Cookie: this.cookie || '', Referer: HOST.qbittorrent } }, opts.ms || 5000);
    let r = await go();
    if (r.status === 403) { await this.login(); r = await go(); }
    return r;
  },
};

const seerr = {
  _key: cfg.SEERR_KEY || '',
  fetch(p, opts = {}) {
    return tfetch(`${HOST.jellyseerr}${p}`, { ...opts, headers: { ...(opts.headers || {}), 'X-Api-Key': this._key } }, opts.ms || 10000);
  },
};

// ── *arr REST helpers ──
function arrOf(app) {
  if (app === 'radarr') return { base: `${HOST.radarr}/api/v3`, key: cfg.RADARR_KEY };
  if (app === 'sonarr') return { base: `${HOST.sonarr}/api/v3`, key: cfg.SONARR_KEY };
  throw new Error(`unknown app: ${app}`);
}
async function arrGet(app, p, ms = 8000) {
  const { base, key } = arrOf(app);
  const r = await tfetch(`${base}${p}`, { headers: { 'X-Api-Key': key || '' } }, ms);
  if (!r.ok) throw new Error(`${app}${p} → HTTP ${r.status}`);
  return r.json();
}
async function arrDelete(app, p) {
  const { base, key } = arrOf(app);
  return tfetch(`${base}${p}`, { method: 'DELETE', headers: { 'X-Api-Key': key || '' } }, 15000);
}
async function arrPost(app, p, body, ms = 10000) {
  const { base, key } = arrOf(app);
  const r = await tfetch(`${base}${p}`, { method: 'POST', headers: { 'X-Api-Key': key || '', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, ms);
  if (!r.ok) throw new Error(`${app} POST ${p} → HTTP ${r.status}`);
  return r.json();
}
async function arrPut(app, p, body, ms = 15000) {
  const { base, key } = arrOf(app);
  const r = await tfetch(`${base}${p}`, { method: 'PUT', headers: { 'X-Api-Key': key || '', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, ms);
  if (!r.ok) throw new Error(`${app} PUT ${p} → HTTP ${r.status}`);
  return r.json();
}

// ── Jellyfin helpers (API-key auth) ──
let _jfUserId = null;
async function jellyfinUserId() {
  if (_jfUserId) return _jfUserId;
  const r = await tfetch(`${HOST.jellyfin}/Users`, { headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' } }, 5000);
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
  const uid = await jellyfinUserId();
  const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };
  const q = new URLSearchParams({ recursive: 'true', includeItemTypes: type || 'Movie,Series', fields: 'ProviderIds', limit: '2000' });
  const items = ((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 8000)).json()).Items) || [];
  const m = items.find((i) => i.ProviderIds && String(i.ProviderIds.Tmdb) === String(tmdbId));
  return (m && m.Id) || null;
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

// ── App ──
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));

// Status — probe each service in parallel. up = the HTTP request resolved at all
// (any status code, even 401 from a missing key); only a network error/timeout is
// "down". version is best-effort and never affects up (the UI hides it anyway).
const STATUS_SERVICES = [
  // Jellyfin (Watch) + Jellyseerr (Request) are the everyday actions — promoted to the
  // two big buttons on Home, so they're intentionally not in this "tools" status list.
  { id: 'qbittorrent', name: 'Torrents', brand: 'qBittorrent', url: `${HOST.qbittorrent}/api/v2/app/version`, text: true },
  { id: 'radarr', name: 'Movies', brand: 'Radarr', url: `${HOST.radarr}/api/v3/system/status`, headers: () => ({ 'X-Api-Key': cfg.RADARR_KEY || '' }), version: (j) => j.version },
  { id: 'sonarr', name: 'TV Shows', brand: 'Sonarr', url: `${HOST.sonarr}/api/v3/system/status`, headers: () => ({ 'X-Api-Key': cfg.SONARR_KEY || '' }), version: (j) => j.version },
  { id: 'prowlarr', name: 'Sources', brand: 'Prowlarr', url: `${HOST.prowlarr}/api/v1/system/status`, headers: () => ({ 'X-Api-Key': cfg.PROWLARR_KEY || '' }), version: (j) => j.version },
  { id: 'bazarr', name: 'Subtitles', brand: 'Bazarr', url: `${HOST.bazarr}/api/system/status`, headers: () => ({ 'X-Api-Key': cfg.BAZARR_KEY || '' }), version: (j) => j.data && j.data.bazarr_version },
  // FlareSolverr is internal plumbing (Cloudflare proxy for Prowlarr) — not user-facing.
];

app.get('/api/status', async (_req, res) => {
  const out = await Promise.all(STATUS_SERVICES.map(async (s) => {
    let up = false, version = null;
    try {
      const r = await tfetch(s.url, { headers: s.headers ? s.headers() : {} });
      up = true; // request resolved → service is reachable
      try { version = s.text ? (r.ok ? (await r.text()).trim() : null) : (r.ok ? (s.version(await r.json()) || null) : null); } catch { /* version is optional */ }
    } catch { up = false; }
    return { id: s.id, name: s.name, brand: s.brand, up, version, url: linkFor(s.id) };
  }));
  res.json(out);
});

app.get('/api/disk', async (_req, res) => {
  try {
    const s = await fs.promises.statfs('/data');
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const used = total - free;
    const cap = total > 0 ? total : 0;
    res.json({ path: '/data', used_bytes: used, total_bytes: total, free_bytes: free, cap_bytes: cap, used_pct: cap ? Math.round((used / cap) * 100) : 0 });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ── NUC host stats (CPU% / RAM% / CPU temperature) ──
// In a container /proc and /sys still reflect the HOST, so these read the NUC itself.
// CPU% is sampled on a rolling interval (a single reading can't yield a rate).
let _cpuPrev = null, _cpuPct = null;
function readCpuTimes() {
  try {
    const t = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    return { idle: (t[3] || 0) + (t[4] || 0), total: t.reduce((a, b) => a + (b || 0), 0) }; // idle = idle + iowait
  } catch { return null; }
}
function sampleCpu() {
  const cur = readCpuTimes();
  if (cur && _cpuPrev) {
    const dt = cur.total - _cpuPrev.total, di = cur.idle - _cpuPrev.idle;
    if (dt > 0) _cpuPct = Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100)));
  }
  if (cur) _cpuPrev = cur;
}
sampleCpu();
setInterval(sampleCpu, 3000); // rolling CPU% over ~the last 3s
function readMemPct() {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8');
    const g = (k) => { const x = m.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')); return x ? Number(x[1]) : null; };
    const total = g('MemTotal'), avail = g('MemAvailable');
    return (total && avail != null) ? Math.round((1 - avail / total) * 100) : null;
  } catch { return null; }
}
// Prefer the CPU package sensor; else the hottest real zone (ignore the wifi radio).
function readTempC() {
  try {
    const base = '/sys/class/thermal';
    let pkg = null, best = null;
    for (const z of fs.readdirSync(base).filter((z) => z.startsWith('thermal_zone'))) {
      let type = '', milli = NaN;
      try { type = fs.readFileSync(`${base}/${z}/type`, 'utf8').trim(); } catch { /* */ }
      try { milli = Number(fs.readFileSync(`${base}/${z}/temp`, 'utf8').trim()); } catch { /* */ }
      if (!Number.isFinite(milli)) continue;
      const c = milli / 1000;
      if (type === 'x86_pkg_temp') pkg = c;
      if (!/iwlwifi|wifi/i.test(type) && (best == null || c > best)) best = c;
    }
    const c = pkg != null ? pkg : best;
    return c == null ? null : Math.round(c);
  } catch { return null; }
}
app.get('/api/system', (_req, res) => {
  res.json({ cpuPct: _cpuPct, memPct: readMemPct(), tempC: readTempC() });
});

// Downloads — qBittorrent torrents (live progress) merged with *arr queue extras.
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
function parseTimeleft(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return (+(m[1] || 0)) * 86400 + (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4]);
}
function friendlyTorrentState(t) {
  const s = t.state || '';
  if (s.startsWith('paused') || s.startsWith('stopped')) return 'Paused';   // qBittorrent v5 renamed paused* → stopped*
  if (s === 'error' || s === 'missingFiles') return 'Error';
  if ((t.progress || 0) >= 1) return 'Seeding';
  if (s === 'metaDL' || s.startsWith('checking')) return 'Starting';
  if (s.startsWith('queued')) return 'Queued';
  if (s.startsWith('stalled')) return 'Stalled';
  return 'Downloading';
}
// ---- Pipeline correlation: qBittorrent + *arr queue + *arr library (hasFile) ----
// The AUTHORITY for "it's in the library and playable" is Radarr/Sonarr's own hasFile —
// not a filesystem guess. So the bar can never say "ready" before the app actually has
// the file, and never falsely flags an imported title.
// ── Resilient cache: fresh within `ttl`, else refetch — and CRUCIALLY, if the refetch throws
// (qBittorrent/*arr timing out while the NUC is busy) keep serving the last-known-good value
// rather than blanking. Blanking is exactly what made finished downloads flicker to a false
// "Needs attention" under load. Two payoffs: accuracy survives load spikes, and per-poll API
// calls collapse to one per TTL window no matter how many dashboard tabs are open. ────────────
const _cache = {};   // key -> { ts, val }
async function cachedFetch(key, ttl, fn, fallback) {
  const c = _cache[key];
  if (c && Date.now() - c.ts < ttl) return c.val;
  try {
    const val = await fn();
    _cache[key] = { ts: Date.now(), val };
    return val;
  } catch {
    return c ? c.val : fallback;                               // last-known-good, or the default on a cold miss
  }
}
const HIST_TTL = 20000;   // history + library hasFile: change slowly
const QUEUE_TTL = 8000;   // *arr queue + qBit torrents: change faster, but stale-on-error still beats blank

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

// id -> hasFile, the authoritative "in the library" flag (cached + stale-on-error, like history).
const getHasFileMap = (app) => cachedFetch(`hasFile:${app}`, HIST_TTL, async () => {
  const hasFile = new Map(), nameIds = new Map();
  const norm = (s) => String(s || '').toLowerCase().replace(/[._'’:()\-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (app === 'radarr') for (const mv of await arrGet('radarr', '/movie')) {
    hasFile.set(mv.id, !!mv.hasFile);
    nameIds.set(norm(mv.title), mv.id);
    if (mv.year) nameIds.set(norm(`${mv.title} ${mv.year}`), mv.id);
  } else for (const s of await arrGet('sonarr', '/series')) {
    hasFile.set(s.id, ((s.statistics && s.statistics.episodeFileCount) || 0) > 0);
    nameIds.set(norm(s.title), s.id);
    if (s.year) nameIds.set(norm(`${s.title} ${s.year}`), s.id);
  }
  return { hasFile, nameIds };
}, { hasFile: new Map(), nameIds: new Map() });
const torrentApp = (t) => { const c = (t.category || '').toLowerCase(); return (c === 'radarr' || c === 'sonarr' || c === 'tv-sonarr') ? (c === 'tv-sonarr' ? 'sonarr' : c) : null; };

// ── Bazarr: subtitle-acquisition gate ──
// A freshly-imported title is in the library, but Bazarr is still off fetching subs for it.
// We hold the Downloads row at "Getting subtitles" (yellow, not clickable) until Bazarr has
// them, so it doesn't go green/playable early.
async function bazarrGet(p, ms = 6000) {
  const r = await tfetch(`${HOST.bazarr}${p}`, { headers: { 'X-Api-Key': cfg.BAZARR_KEY || '' } }, ms);
  if (!r.ok) throw new Error(`bazarr HTTP ${r.status}`);
  return r.json();
}
// True once Bazarr has the title's subtitles — or once we've waited long enough that we stop
// holding the row (subs may simply be unavailable for an obscure release). Fails OPEN (returns
// true) whenever Bazarr isn't provisioned/reachable or we can't pin the *arr id, so subtitles
// never wedge a download permanently at "Getting subtitles".
const SUBS_GRACE = 1800; // s — max time to hold a freshly-imported title waiting on subs
async function subsReady(app, id, completionOn) {
  if (!cfg.BAZARR_KEY || id == null) return true;                       // can't gate → don't
  if (completionOn && Math.floor(Date.now() / 1000) - completionOn > SUBS_GRACE) return true;
  try {
    if (app === 'radarr') {
      const m = ((await bazarrGet(`/api/movies?radarrid[]=${id}`)).data || [])[0];
      if (!m) return false;                                             // Bazarr hasn't synced it yet
      return (m.missing_subtitles || []).length === 0;                  // every wanted language present
    }
    // sonarr: ready once no episode of the series is still wanting subtitles
    const wanted = (await bazarrGet('/api/episodes/wanted?start=0&length=-1')).data || [];
    return !wanted.some((r) => r.sonarrSeriesId === id);
  } catch { return true; }                                              // Bazarr down → fail open
}

// ── Jellyfin: scan-and-probe gate ──
// *arr reporting hasFile means the file is in the library FOLDER — but Jellyfin still has to
// scan that folder and ffprobe each file before a playable MediaSource exists. In that window
// the episode/movie ITEM exists (so it shows in Jellyfin) but tapping Watch errors with
// "Unable to find a valid media source to play". So we hold the Downloads row at "Processing"
// until Jellyfin has actually probed the title (RunTimeTicks populated). Fails OPEN (returns
// true) whenever we can't resolve the item or Jellyfin is unreachable, and lapses after
// JF_GRACE, so a probe that never registers can never wedge a row permanently.
const JF_GRACE = 1800; // s — max time to hold a freshly-imported title at "Processing"
async function jellyfinReady(app, arrId, completionOn) {
  if (!cfg.JELLYFIN_KEY || arrId == null) return true;                 // can't gate → don't
  if (completionOn && Math.floor(Date.now() / 1000) - completionOn > JF_GRACE) return true;
  try {
    const type = app === 'sonarr' ? 'Series' : 'Movie';
    const arrItem = await arrGet(app, app === 'radarr' ? `/movie/${arrId}` : `/series/${arrId}`);
    // Resolve the Jellyfin item: pin on TMDB id, else fall back to a title search.
    let itemId = await jellyfinIdByTmdb(type, arrItem.tmdbId);
    if (!itemId) itemId = await jellyfinSearchId(arrItem.title, type);
    if (!itemId) return false;                                         // Jellyfin hasn't created it yet
    const uid = await jellyfinUserId();
    const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };
    if (app === 'radarr') {                                            // movie: the item itself carries the runtime once probed
      const it = await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items/${itemId}`, { headers: h }, 6000)).json();
      return (it.RunTimeTicks || 0) > 0;
    }
    // sonarr: every imported episode must be present AND probed — a half-scanned season would
    // otherwise go green while its later episodes still error on Watch.
    const expected = ((arrItem.statistics || {}).episodeFileCount) || 0;
    const q = new URLSearchParams({ parentId: itemId, recursive: 'true', includeItemTypes: 'Episode', fields: 'RunTimeTicks', limit: '2000' });
    const eps = ((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 8000)).json()).Items) || [];
    const allProbed = eps.length > 0 && eps.every((e) => (e.RunTimeTicks || 0) > 0);
    return expected > 0 ? (eps.length >= expected && allProbed) : allProbed;
  } catch { return true; }                                            // Jellyfin hiccup → fail open
}

// Per-folder import-rescue state (NOT sticky): the watchdog retries with backoff, and
// a title flips to "Ready" the moment *arr reports hasFile — regardless of this.
const importState = new Map(); // folder -> { lastTry, reason }
const knownInLibrary = new Set(); // torrent hash -> tracked for event-driven scan

// A torrent qBittorrent has flagged as broken — typically after an unclean shutdown (power
// loss), when on recheck its files don't line up with its resume data. It reports progress 0
// even though the real media is usually still on disk (and often already imported by *arr).
const isErrored = (t) => { const s = t.state || ''; return s === 'error' || s === 'missingFiles'; };

// Resolve a torrent that *arr has already imported to its user-facing "in the library" state,
// gating green on Bazarr subs + a Jellyfin probe (so Watch never errors). Shared by the normal
// completed path and the self-heal path for errored-but-imported torrents.
async function resolveLibraryState(app, hi, t) {
  const h = (t.hash || '').toLowerCase();
  if (!knownInLibrary.has(h)) { knownInLibrary.add(h); triggerJellyfinScan(); }
  if (!(await subsReady(app, hi && hi.id, t.completion_on))) return 'Getting subtitles';
  if (!(await jellyfinReady(app, hi && hi.id, t.completion_on))) return 'Processing';
  return 'Ready';
}

async function buildDownloads() {
  const now = Math.floor(Date.now() / 1000), DAY = 86400;
  const torrents = await getQbitTorrents();
  const queues = { radarr: await getQueueMap('radarr'), sonarr: await getQueueMap('sonarr') };
  // History (imported flag + indexer-reported size) and library hasFile, for whichever apps own a
  // torrent. Both are 20s-cached, so fetching unconditionally is cheap — we need them to size queued
  // torrents (real progress bar) and to classify idle/errored ones against the library.
  const hist = {}, hasFile = {}, nameIds = {};
  for (const app of new Set(torrents.map(torrentApp).filter(Boolean))) {
    hist[app] = await getHistoryIndex(app);
    const lib = await getHasFileMap(app);
    hasFile[app] = lib.hasFile;
    nameIds[app] = lib.nameIds;
  }

  const items = [];
  // arrIds that already have a torrent-derived row (downloading/importing/seeding/etc.). The
  // missing-item surfacing below skips these so a title can't appear BOTH as its live download AND
  // as a phantom "Searching…/Not found" row (e.g. a season pack downloading before Sonarr queues it).
  const shownIds = { radarr: new Set(), sonarr: new Set() };
  // Collapse duplicate COMPLETED rows for the same MOVIE (e.g. an old orphaned torrent still seeding
  // after an upgrade/redownload + the current library copy) — keep the most-recently-completed. Movies
  // only: a Sonarr series legitimately has many completed torrents (one per season/episode).
  const completedByMovie = new Map();   // "radarr:movieId" -> { completion, item }
  for (const t of torrents) {
    const h = (t.hash || '').toLowerCase();
    const app = torrentApp(t);
    const prog = Math.round((t.progress || 0) * 100);
    const eta = (t.eta && t.eta < 8640000) ? t.eta : null;
    const qrec = app ? queues[app].get(h) : null;
    // Ground truth, independent of qBittorrent's (post-crash) progress/state: has *arr actually
    // imported this release into the library?
    const hi = app && hist[app] && hist[app].get(h);
    // Has *arr actually imported THIS torrent? `hi.imported` is per-downloadId (an import event
    // referenced this exact hash) and is authoritative for both apps. The hasFile fallback (for a
    // cold history cache after restart) is RADARR-ONLY: a movie's hasFile is 1:1 with its torrent,
    // but a Sonarr series' hasFile is true if it holds ANY episode — so using it here flagged every
    // still-downloading episode of a partially-present series as "imported → Ready", hiding the
    // live download from the UI. For Sonarr we trust the per-hash import event alone.
    const imported = !!(hi && (hi.imported || (app === 'radarr' && hi.id != null && hasFile[app] && hasFile[app].get(hi.id) === true)));
    const _arrId = (qrec && (qrec.movieId || qrec.seriesId)) ?? (hi && hi.id);
    if (app && _arrId != null) shownIds[app].add(_arrId);   // this title has a live download → don't also list it as missing
    let state, attention = false, recover = null;
    if (app && imported) {
      // Already imported into the library = the download is DONE, no matter what the torrent is
      // doing now (errored after a crash, paused, or a zombie pointing at files *arr already
      // hardlinked/moved out). Trust the library, never the torrent — and never re-download
      // content we already have. resolveLibraryState still gates green on subs + a Jellyfin probe.
      state = await resolveLibraryState(app, hi, t);
    } else if (isErrored(t) && app) {
      // Errored AND not in the library via history (hi=null = cold cache after restart, or
      // history window too small). Try a title match as fallback before flagging — the media
      // is often still on disk and already imported by *arr (qBittorrent just lost its resume
      // data after a crash/recheck). Only if the *arr library also has no file for this title
      // do we flag for human attention.
      let resolved = false;
      if (!hi && nameIds[app]) {
        const tn = (t.name || '').toLowerCase().replace(/[._'’:()\-]/g, ' ').replace(/\s+/g, ' ').trim();
        const yr = (t.name || '').match(/\b(19\d\d|20\d\d)\b/)?.[1];
        for (const [nt, id] of nameIds[app]) {
          if (tn === nt || (tn.startsWith(nt + ' ') && (!yr || tn.includes(yr)))) {
            if (hasFile[app] && hasFile[app].get(id) === true) {
              state = await resolveLibraryState(app, { id, imported: true, size: 0 }, t);
              resolved = true;
            }
            break;
          }
        }
      }
      if (!resolved) {
        state = 'Needs attention'; attention = true;
      }
    } else if (qrec) {                              // *arr is actively tracking it
      // *arr's queue exposes BOTH its own view (trackedDownloadState/Status) and the underlying
      // torrent (t.state). Surface real trouble from EITHER source — a stalled or errored
      // download that *arr still lists must never masquerade as "Downloading".
      const tds = (qrec.trackedDownloadState || '').toLowerCase();      // downloading|importPending|importing|imported|failedPending|failed
      const tdStatus = (qrec.trackedDownloadStatus || '').toLowerCase(); // ok|warning|error
      const ts = friendlyTorrentState(t);                               // Paused|Error|Seeding|Starting|Queued|Stalled|Downloading
      if ((qrec.status || '').toLowerCase() === 'paused' || ts === 'Paused') state = 'Paused';
      else if (tds === 'failed' || tds === 'failedpending' || tdStatus === 'error') { state = 'Needs attention'; attention = true; } // download/import failed in *arr
      else if (tds.includes('import')) {
        state = 'Importing';
        // *arr parked the import (e.g. importBlocked: "matched by ID — manual import required").
        // Hand it to the recovery sweep so it runs a Manual Import automatically rather than
        // sitting in 'Importing' forever.
        if (tdStatus === 'warning' && t.content_path) recover = { app, folder: t.content_path, id: app === 'radarr' ? qrec.movieId : qrec.seriesId, hash: h };
      }
      else if (prog < 100) state = (ts === 'Stalled' || ts === 'Queued' || ts === 'Starting') ? ts : 'Downloading'; // honour a real stall
      else state = 'Importing';                                         // complete in qbit, waiting on *arr to import
    } else if (prog < 100) {                        // still downloading, *arr not (yet) tracking
      state = friendlyTorrentState(t);
    } else if (app) {                               // complete, no longer in the *arr queue
      if (imported) {
        // *arr has the file, but "Ready" is the only clickable/playable state — so it must mean
        // *fully* ready: subtitles fetched AND Jellyfin has scanned+probed the file (else Watch
        // errors with "no valid media source"). resolveLibraryState kicks the scan and gates green.
        state = await resolveLibraryState(app, hi, t);
      } else {                                      // downloaded but *arr has NOT imported it
        recover = { app, folder: t.content_path, id: hi && hi.id, hash: h };
        const reason = (importState.get(t.content_path) || {}).reason;
        if (reason) { state = 'Needs attention'; attention = true; }
        else state = 'Importing';                   // the watchdog will import it shortly
      }
    } else {
      state = 'Done';                               // a non-*arr torrent, just complete
    }
    const finished = state === 'Ready' || state === 'Done';
    const show = !finished || ((t.completion_on || 0) > 0 && now - t.completion_on <= DAY);
    // "Ready"/"Done" items always show full bar even if qBit reports 0% (missing files)
    const displayProg = (finished || state === 'Importing' || state === 'Needs attention' || state === 'Getting subtitles' || state === 'Processing') ? 100 : prog;
    if (show) {
      // Seed count is only meaningful once a torrent is actually talking to the swarm: while
      // 'Downloading' (explains progress/speed) or 'Stalled' (0 seeds explains the stall). A
      // 'Queued'/'Starting' torrent hasn't announced to the tracker yet, so its num_seeds is a
      // misleading 0 that isn't a true reflection of the release's availability — omit it there.
      const seeds = (state === 'Downloading' || state === 'Stalled') && typeof t.num_seeds === 'number' ? t.num_seeds : null;
      // "Stalled" mirrors stallRecovery's own give-up clock (STALL_DEAD after first seen at 0
      // seeds) so the UI can say when it'll blocklist-and-research instead of sitting silent.
      const stallGiveUpAt = state === 'Stalled' && _stallSince.has(h) ? (_stallSince.get(h) + STALL_DEAD) * 1000 : null;
      const item = { title: t.name, progress: displayProg, state, etaSeconds: state === 'Downloading' ? eta : null, sizeBytes: t.size || (hi && hi.size) || (qrec && qrec.size) || 0, source: app || 'torrent', attention, _recover: recover, hash: t.hash, seeds, stallGiveUpAt };
      // An auto-upgrade the user didn't request must explain itself in the UI.
      if (app === 'radarr' && qrec && qrec.movieId != null && gpuPending.has(qrec.movieId)) {
        item.note = 'Auto-upgrade: fetching a GPU-friendly copy — your current file stays watchable until this finishes';
      }
      if (finished && app === 'radarr' && _arrId != null) {
        const key = `radarr:${_arrId}`, comp = t.completion_on || 0, prev = completedByMovie.get(key);
        if (prev && comp <= prev.completion) continue;                 // older/equal duplicate of a movie we already show — drop it
        if (prev) { const i = items.indexOf(prev.item); if (i >= 0) items.splice(i, 1); }  // newer copy wins — remove the stale row
        completedByMovie.set(key, { completion: comp, item });
      }
      items.push(item);
    }
  }
  // Surface missing items: monitored, no file, no queue, no torrent — as warnings.
  try {
    const appIdsInQueue = { radarr: new Set(), sonarr: new Set() };
    for (const app of ['radarr', 'sonarr']) {
      if (!queues[app]) continue;
      for (const [, qrec] of queues[app]) {
        const id = qrec.movieId || qrec.seriesId;
        if (id != null) appIdsInQueue[app].add(id);
      }
    }
    // A JUST-grabbed torrent (redownload / fresh request) is in qBittorrent seconds before the
    // 20s-cached *arr queue/history links it to its item — so shownIds/queue miss it and the title
    // would show BOTH its download row AND a phantom "Searching…" row. Bridge that window by matching
    // the item's title+year against the raw torrent names of the same category.
    const norm = (s) => String(s || '').toLowerCase().replace(/[._'’:()\-]/g, ' ').replace(/\s+/g, ' ').trim();
    const catTorNames = { radarr: [], sonarr: [] };
    for (const t of torrents) { const a = torrentApp(t); if (a) catTorNames[a].push(norm(t.name)); }
    const beingFetched = (app, it) => {
      const tn = norm(it.title); if (!tn) return false;
      const yr = it.year ? String(it.year) : '';
      return catTorNames[app].some((n) => (n === tn || n.startsWith(tn + ' ')) && (!yr || n.includes(yr)));
    };
    for (const app of ['radarr', 'sonarr']) {
      let list = [];
      try { list = await arrGet(app, app === 'radarr' ? '/movie' : '/series', 8000); } catch { continue; }
      for (const it of list) {
        const id = it.id;
        const hasF = app === 'radarr' ? !!it.hasFile : (it.statistics && it.statistics.episodeFileCount) > 0;
        if (hasF || it.monitored === false) { noteResolved(app, id); continue; }
        if (appIdsInQueue[app].has(id) || shownIds[app].has(id) || beingFetched(app, it)) { noteResolved(app, id); continue; }   // in queue / linked / freshly-grabbed torrent → not missing
        // A freshly-requested item briefly has no file/queue while *arr's own search resolves. Show
        // "Searching…" (not the alarming "Not found") until NOTFOUND_GRACE — this is what stops the
        // "Not found → found seconds later" flip-flop. Only after the grace do we call it "Not found".
        const firstMissing = noteMissing(app, id);
        const now2 = Date.now();
        const searching = now2 - firstMissing < NOTFOUND_GRACE_MS;
        const title = it.title + (it.year ? ` (${it.year})` : '');
        // Mirror arrSweep's own scheduling logic so the UI can say when the NEXT recovery search
        // will actually fire, instead of leaving "Not found" with no indication of what happens next.
        const st = searchState.get(`${app}:${id}`) || {};
        const recoveryBlocked = !!(st.blockedUntil && st.blockedUntil > now2);
        let recoveryNext;
        if (recoveryBlocked) recoveryNext = st.blockedUntil;
        else if (now2 - firstMissing < RECOVERY_GRACE_MS) recoveryNext = firstMissing + RECOVERY_GRACE_MS;
        else if (st.ts) recoveryNext = st.ts + SEARCH_COOLDOWN_MS;
        else recoveryNext = now2; // sweep hasn't tried yet — due on its next 5-min tick
        // attention (→ red) is reserved for items automation has actually given up on
        // (negative-cached). A "Not found" that's still going to retry on its own is orange, not
        // red — red should mean "a human needs to look at this," not "still working on it."
        items.push({ title, progress: 0, state: searching ? 'Searching…' : 'Not found',
          etaSeconds: null, sizeBytes: 0, source: app, attention: recoveryBlocked,
          hash: `missing:${app}:${id}`, _id: id,
          recoveryNext, recoveryFails: st.fails || 0, recoveryBlocked });
      }
    }
  } catch { /* missing scan best-effort */ }

  // Sort tiers: any problem to the very top, then anything actively transferring (partial
  // progress, whatever its label), then the rest in progress, then recently-finished (Ready/Done
  // only ever survive the 24h `show` window above), and finally the long Queued backlog at the
  // bottom. Within a tier, the closer to done floats higher.
  const rank = (it) => {
    const s = it.state, p = it.progress || 0;
    if (s === 'Needs attention' || s === 'Error' || s === 'Not found') return 0;    // errors of any kind first
    if (p > 0 && p < 100) return 1;                            // mid-transfer → near the top regardless of status
    if (s === 'Queued') return 4;                              // the big backlog at the bottom
    if (s === 'Ready' || s === 'Done') return 3;               // recently finished (≤ 24h)
    return 2;                                                  // everything else in progress (100% but not done: Importing/Processing/…)
  };
  items.sort((a, b) => rank(a) - rank(b) || (b.progress || 0) - (a.progress || 0));
  return items;
}

// Precomputed snapshot. The heavy work — qBittorrent + both *arr queues + history + library +
// the per-item Bazarr/Jellyfin gate checks — runs in ONE background loop, never inside a client
// request. So /api/downloads returns instantly from memory: a dashboard tab can't hang waiting on
// a busy NUC, requests can't pile up, and N open tabs cost the same as one. The snapshot keeps its
// last good value if a refresh fails, and `_dlRefreshing` guarantees refreshes never overlap (so a
// slow cycle under load self-throttles instead of stacking).
let _dl = { served: [], raw: [], summary: null, ts: 0 };
let _dlRefreshing = false;
// Titles declined for disk space — the download-stage gate (`declined`, keyed by torrent
// hash) and the request-stage gate (`blocked`, keyed by app:id:seasons). Rendered as
// terminal red "Declined" rows. They join the snapshot BEFORE the summary is computed so
// the legend always counts exactly what the list shows (they used to be injected per-request
// afterwards, leaving the summary blind to them).
const asDeclinedRow = (hash, d) => ({ title: d.title, progress: 0, state: 'Declined', etaSeconds: null,
  sizeBytes: d.neededBytes, neededBytes: d.neededBytes, freeBytes: d.freeBytes, source: d.source || 'request', attention: false, hash });
async function refreshDownloads() {
  if (_dlRefreshing) return;
  _dlRefreshing = true;
  try {
    const raw = await buildDownloads();
    const served = raw.map(({ _recover, ...r }) => r);
    const now = Math.floor(Date.now() / 1000), DAY = 86400;
    for (const [h, d] of declined) if (now - d.ts <= DAY) served.unshift(asDeclinedRow(h, d));
    for (const [h, b] of blocked) if (now - b.ts <= DAY) served.unshift(asDeclinedRow(h, b));
    const summary = await downloadSummary(served);
    _dl = { served, raw, summary, ts: Date.now() };
  } catch (e) { console.log('refreshDownloads failed (keeping last snapshot):', e.message || e); }
  finally { _dlRefreshing = false; }
}
setInterval(refreshDownloads, 5000);
setTimeout(refreshDownloads, 1500);
// A mutation just changed qBittorrent/*arr state — drop the caches that would keep serving
// the pre-mutation view and rebuild the snapshot now, so the UI reflects the action on its
// next poll (~4s) instead of after cache TTL + snapshot loop + poll (~15s worst case).
function bustDownloadsCache() {
  delete _cache['qbit:torrents'];
  delete _cache['queue:radarr'];
  delete _cache['queue:sonarr'];
  setTimeout(refreshDownloads, 400);   // give the service a beat to register the change
}

app.get('/api/downloads', (_req, res) => {
  res.json({ items: _dl.served, summary: _dl.summary, ts: _dl.ts, masterPaused });
});

// Batch ETA — "how long until this whole backlog is done?" Remaining bytes ÷ throughput.
// Wrinkles, all handled:
//  • Concurrency (qBittorrent runs ~3 at once): no special-casing needed — we divide by the
//    AGGREGATE speed (sum across all active torrents), so total wall-clock time is the same
//    however the queue is sliced, as long as it stays saturated (it is: 100+ queued).
//  • Speed stability: instantaneous aggregate speed is noisy, so we blend it with the SUSTAINED
//    throughput actually achieved by recently-completed torrents (bytes done ÷ wall-clock span).
//    That historic rate already reflects the real 3-at-a-time concurrency and disk/peer ceiling.
//  • Unknown sizes: queued torrents without metadata (size 0) are estimated at the average size
//    of the releases we do know, and we report how many are still being sized.
//  • Only states that actually consume bandwidth count toward remaining (Paused/Error/finished
//    are excluded from the in-progress + queued buckets below).
async function downloadSummary(items) {
  let liveSpeed = 0, torrents = [];
  try { const r = await qbit.fetch('/api/v2/transfer/info'); if (r.ok) liveSpeed = (await r.json()).dl_info_speed || 0; } catch { /* qbit down */ }
  try { torrents = await getQbitTorrents(); } catch { /* qbit down */ }

  // Sustained throughput from torrents completed in the last 6h: total bytes ÷ time since the
  // first of them finished. Needs a few data points to be meaningful, else we lean on live speed.
  const now = Math.floor(Date.now() / 1000), WINDOW = 6 * 3600;
  const doneRecently = torrents.filter((t) => t.completion_on > 0 && now - t.completion_on <= WINDOW && t.size > 0);
  let histSpeed = null;
  if (doneRecently.length >= 3) {
    const span = now - Math.min(...doneRecently.map((t) => t.completion_on));
    if (span > 120) histSpeed = doneRecently.reduce((a, t) => a + t.size, 0) / span;
  }
  // Blend: weight the stable historic rate, let live speed pull it toward current conditions.
  const speedBytes = Math.round((histSpeed && liveSpeed) ? histSpeed * 0.6 + liveSpeed * 0.4 : (histSpeed || liveSpeed));

  // Estimate the size of metadata-less queued torrents (size 0) from the average of EVERY release
  // we do have metadata for — completed, downloading, and queued alike — the broadest sample.
  const knownSized = items.filter((i) => i.sizeBytes > 0 && i.state !== 'Declined');
  const avgItemBytes = knownSized.length ? knownSized.reduce((a, i) => a + i.sizeBytes, 0) / knownSized.length : 0;
  const sizeOf = (i) => (i.sizeBytes > 0 ? i.sizeBytes : avgItemBytes);

  // Buckets for the visual bar mirror the row colors exactly, so the summary never shows a
  // different picture than the list underneath it: red = needs a human, blue = actively resolving
  // on its own (including subtitles/import/processing, not just live byte transfer), orange =
  // mid-recovery (stalled/retrying/paused), grey = plain pending, green = done.
  const DONE = new Set(['Ready', 'Done']);
  const BLUE_STATES = new Set(['Downloading', 'Importing', 'Getting subtitles', 'Processing']);
  const ORANGE_STATES = new Set(['Stalled', 'Not found', 'Paused']);
  const done = items.filter((i) => DONE.has(i.state));
  const attention = items.filter((i) => i.attention || i.state === 'Needs attention' || i.state === 'Error' || i.state === 'Declined');
  const inProg = items.filter((i) => BLUE_STATES.has(i.state) && !attention.includes(i));
  const blocked = items.filter((i) => ORANGE_STATES.has(i.state) && !attention.includes(i));
  const queued = items.filter((i) => !DONE.has(i.state) && !attention.includes(i) && !inProg.includes(i) && !blocked.includes(i));
  const sum = (arr) => Math.round(arr.reduce((a, i) => a + sizeOf(i), 0));
  const bytes = { completed: sum(done), inProgress: sum(inProg), queued: sum(queued), attention: sum(attention), blocked: sum(blocked) };

  // Remaining to download = the unfinished part of everything not done (downloading + all pending).
  const remainingBytes = Math.round([...inProg, ...queued].reduce((a, i) => a + sizeOf(i) * (1 - Math.min(100, i.progress || 0) / 100), 0));
  const sizing = [...queued, ...inProg].filter((i) => !(i.sizeBytes > 0)).length;   // still fetching metadata

  return {
    counts: { completed: done.length, inProgress: inProg.length, queued: queued.length, attention: attention.length, blocked: blocked.length },
    bytes,
    remainingBytes,
    speedBytes,
    liveSpeedBytes: liveSpeed,
    histSpeedBytes: histSpeed ? Math.round(histSpeed) : null,
    etaSeconds: speedBytes > 0 && remainingBytes > 0 ? Math.round(remainingBytes / speedBytes) : null,
    sizing,
    avgItemBytes: Math.round(avgItemBytes),
  };
}

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

// ── What to watch: unwatched-library picker ──
// Full unwatched-movie list straight from Jellyfin (play state is per-user; the household
// shares the admin user), with the fields the picker filters on. 60s cache; filtering/sort
// happens client-side (the library is a few hundred titles — one small payload). Poster URLs
// are Jellyfin's anonymous image endpoints, loaded by the browser directly.
app.get('/api/whattowatch', async (_req, res) => {
  try {
    const data = await cachedFetch('jf:unwatched', 60000, async () => {
      const uid = await jellyfinUserId();
      const q = new URLSearchParams({
        IncludeItemTypes: 'Movie', Recursive: 'true', Filters: 'IsUnplayed',
        Fields: 'Genres,CommunityRating,ProductionYear,RunTimeTicks', Limit: '2000',
      });
      const r = await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' } }, 10000);
      if (!r.ok) throw new Error(`jellyfin ${r.status}`);
      const items = ((await r.json()).Items) || [];
      const serverId = await jellyfinServerId();
      return {
        serverId,
        items: items.map((i) => ({
          id: i.Id, title: i.Name, year: i.ProductionYear || null,
          rating: i.CommunityRating ? Math.round(i.CommunityRating * 10) / 10 : null,
          runtimeMinutes: i.RunTimeTicks ? Math.round(i.RunTimeTicks / 600000000) : null,
          genres: i.Genres || [],
          poster: `http://${NUC_IP}:8096/Items/${i.Id}/Images/Primary?maxWidth=160&quality=90`,
        })),
      };
    }, null);
    if (!data) return res.status(502).json({ error: 'jellyfin unavailable' });
    res.json(data);
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// ---- Auto-import watchdog (backend, container-to-container; NOT driven by the UI) ----
// The happy path is event-driven: qBittorrent finishes → *arr imports → *arr pushes a
// "library updated" notification to Jellyfin. But when *arr DROPS a completed download
// without importing (the delete→re-download race), there's no event to react to — so a
// periodic sweep is the only way to catch the *absence* of an import. It runs the same
// Manual Import the *arr UI offers, and retries with backoff until the file lands.
async function importViaManual(app, folder, expectedId) {
  const { base, key } = arrOf(app);
  const r = await tfetch(`${base}/manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=true`, { headers: { 'X-Api-Key': key } }, 20000);
  if (!r.ok) return { ok: false, reason: `manualimport HTTP ${r.status}` };
  const files = []; let reason = 'no importable file found yet';
  for (const c of await r.json()) {
    if (!c.path) continue;
    if (c.rejections && c.rejections.length) { reason = c.rejections[0].reason || 'rejected'; continue; }
    const f = { path: c.path, quality: c.quality, languages: c.languages || [], releaseGroup: c.releaseGroup || '' };
    // Fall back to the grab-history movie id (expectedId) when the FILE NAME doesn't parse to a
    // movie — e.g. a release titled "Monty Python Life of Brian" for the library entry "Life of
    // Brian". *arr blocks auto-import on an ID-only match; we trust the grab link and import anyway.
    if (app === 'radarr') { const mid = (c.movie && c.movie.id) || expectedId; if (!mid) { reason = 'no matching movie'; continue; } f.movieId = mid; }
    else { if (!c.series) { reason = 'no matching series'; continue; } f.seriesId = c.series.id; f.episodeIds = (c.episodes || []).map((e) => e.id); if (!f.episodeIds.length) { reason = 'no matching episode'; continue; } }
    files.push(f);
  }
  if (!files.length) return { ok: false, reason };
  const cmd = await tfetch(`${base}/command`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ManualImport', importMode: 'auto', files }) }, 20000);
  return { ok: cmd.ok, count: files.length, reason: cmd.ok ? null : `command HTTP ${cmd.status}` };
}

async function importWatchdog() {
  if (masterPaused) return;                                         // Movie Mode — no imports/analysis
  const snap = _dl.raw;                                             // reuse the background snapshot — no extra buildDownloads
  if (!snap || !snap.length) return;
  const now = Math.floor(Date.now() / 1000);
  for (const it of snap) {
    const rec = it._recover; if (!rec) continue;                    // only completed-but-not-imported / import-blocked
    try { await fs.promises.stat(rec.folder); } catch { continue; } // content gone → nothing to import
    // (manualimport accepts a single file path OR a folder, so we no longer skip single-file torrents —
    //  import-blocked single files like "matched by ID, manual import required" must be rescued too.)
    const st = importState.get(rec.folder) || { lastTry: 0, reason: null };
    if (now - st.lastTry < 120) continue;                           // backoff between attempts
    st.lastTry = now;
    // Fresh per-hash ground truth before importing: the snapshot's history view is 20s-cached
    // and raced *arr's own importer, producing duplicate "Upgrade over itself" imports
    // (Moneyball ×2, Mormon Wives ×3 in the audit). Walk this download's own history newest-
    // first: an import event BEFORE the latest grab means this cycle already imported — skip.
    // (Import-after-grab ordering matters because an upgrade re-grab reuses the same hash.)
    if (rec.hash) {
      try {
        const hr = await arrGet(rec.app, `/history?pageSize=30&sortKey=date&sortDirection=descending&downloadId=${rec.hash.toUpperCase()}`, 8000);
        let alreadyImported = false;
        for (const r of (hr.records || [])) {
          const et = (r.eventType || '').toLowerCase();
          if (et.includes('import')) { alreadyImported = true; break; }
          if (et === 'grabbed') break;                              // reached the grab first → not imported this cycle
        }
        if (alreadyImported) { importState.delete(rec.folder); continue; }
      } catch { /* history unavailable — fall through to the existing rescue path */ }
    }
    const res = await importViaManual(rec.app, rec.folder, rec.id);
    st.reason = res.ok ? null : res.reason;                         // cleared on success; retried next sweep
    if (res.ok) triggerJellyfinScan();
    importState.set(rec.folder, st);
    console.log(res.ok ? `watchdog: imported ${res.count} file(s) from "${rec.folder}"` : `watchdog: "${rec.folder}" not importable yet — ${res.reason}`);
  }
}
setInterval(importWatchdog, 30000); // sweep often; per-folder 120s backoff caps real attempts
setTimeout(importWatchdog, 8000);

// ── Stalled-download recovery (backend, container-to-container) ──────────────────────────────
// Two tiers, escalating, so the queue heals itself instead of sitting on dead torrents:
//   1. Gentle: a stalled torrent gets periodic reannounces — enough to wake one that simply lost
//      its peers (e.g. our Out of Africa, 9 seeds).
//   2. Give-up: a torrent stalled with ZERO seeds for STALL_DEAD has grabbed a dead release (the
//      movie isn't obscure — Cast Away had 121-seed alternatives). We blocklist that release in
//      *arr (so it won't be re-grabbed) and kick off a fresh search, which pulls a seeded copy.
// All actions are throttled per-hash so a sweep can't thrash trackers or *arr.
async function qbitReannounce(hash) {
  try { await qbit.fetch('/api/v2/torrents/reannounce', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `hashes=${hash}` }); } catch { /* qbit hiccup */ }
}
async function arrBlocklistAndResearch(app, queueId, itemId) {
  const { base, key } = arrOf(app);
  // remove from qBittorrent + blocklist the dead release so *arr never re-grabs this exact copy
  await tfetch(`${base}/queue/${queueId}?removeFromClient=true&blocklist=true`, { method: 'DELETE', headers: { 'X-Api-Key': key } }, 20000);
  // then search for a replacement (a better-seeded release)
  const cmd = app === 'radarr' ? { name: 'MoviesSearch', movieIds: [itemId] } : { name: 'SeriesSearch', seriesId: itemId };
  await tfetch(`${base}/command`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) }, 20000);
}
// Grab the single best-seeded release available for a title (radarr only — Sonarr's interactive
// search is per-episode and messier). Used by the "accept rare" tier: when re-searching keeps
// turning up only dead releases, we stop churning and just take the healthiest option there is.
async function grabBestSeeded(app, itemId) {
  if (app !== 'radarr') return null;
  const { base, key } = arrOf(app);
  const rels = await (await tfetch(`${base}/release?movieId=${itemId}`, { headers: { 'X-Api-Key': key } }, 60000)).json();
  // Only releases the profile itself would accept (not rejected), ranked by the SAME
  // custom-format score the profiles grab on, THEN seeders. The old pure best-seeded pick
  // bypassed every quality/codec/size rule and could force-grab a 40 GB 10-bit HDR remux.
  // If everything is rejected there is nothing worth forcing — return null and let it sit.
  const ok = (Array.isArray(rels) ? rels : []).filter((r) => !r.rejected && (r.seeders || 0) > 0);
  const best = ok.sort((a, b) => (b.customFormatScore || 0) - (a.customFormatScore || 0) || (b.seeders || 0) - (a.seeders || 0))[0];
  if (!best || !best.guid) return null;
  await tfetch(`${base}/release`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ guid: best.guid, indexerId: best.indexerId }) }, 30000);
  return best.seeders || 0;
}
const _stallSince = new Map();   // hash -> first-seen-stalled-with-0-seeds ts
const _lastReannounce = new Map();
const _lastResearch = new Map();
const _researchCount = new Map(); // app:itemId -> how many times we've blocklisted+re-searched this title
const _accepted = new Set();      // app:itemId -> rare title: best-available grabbed, never abandon again
const STALL_DEAD = 3600;          // s a torrent may sit at 0 seeds before we abandon the release
const REANNOUNCE_EVERY = 600;
const RESEARCH_EVERY = 6 * 3600;  // never re-research the same hash more than this often
const MAX_RESEARCH = 3;           // after this many dead re-searches, accept the title is rare & let it sit
async function stallRecovery() {
  if (masterPaused) return;                                         // Movie Mode — leave torrents as-is
  const now = Math.floor(Date.now() / 1000);
  let torrents; try { torrents = await getQbitTorrents(); } catch { return; }
  const queues = { radarr: await getQueueMap('radarr'), sonarr: await getQueueMap('sonarr') };
  for (const t of torrents) {
    const h = (t.hash || '').toLowerCase();
    const stalled = (t.state === 'stalledDL' || t.state === 'metaDL') && (t.progress || 0) < 1;
    if (!stalled) { _stallSince.delete(h); continue; }
    if (now - (_lastReannounce.get(h) || 0) > REANNOUNCE_EVERY) { _lastReannounce.set(h, now); qbitReannounce(h); }  // tier 1
    // A stalledDL WITH seeds is recoverable — reannounce reconnects it, so don't abandon. But
    // metaDL (can't even fetch the torrent's metadata) or a 0-seed stall is dead even if it claims
    // a seed (an unresponsive one), so let those escalate to blocklist+research below.
    if (t.state !== 'metaDL' && (t.num_complete || 0) > 0) { _stallSince.delete(h); continue; }
    if (!_stallSince.has(h)) _stallSince.set(h, now);
    if (now - _stallSince.get(h) < STALL_DEAD) continue;                                 // give a 0-seed swarm time to appear
    const app = torrentApp(t); const qrec = app && queues[app].get(h);
    if (app && (!qrec || qrec.id == null)) {
      // Dead download that *arr no longer tracks (queue record gone — e.g. a prior cleanup
      // removed the record but the qBittorrent delete failed). NOTHING else can rescue it:
      // the escalation below needs a queue id, and the orphan sweep only acts when the
      // movie/series itself is deleted — so it sits as "Starting"/"Stalled" forever
      // (observed: Were.the.Millers x265 10bit metaDL, weeks stuck). Blocklist the release
      // via its grab-history record (so it isn't re-grabbed) and drop the torrent; the
      // missing-item sweep then re-searches a healthy copy on its normal schedule.
      try {
        const { base, key } = arrOf(app);
        const hr = await arrGet(app, `/history?pageSize=20&sortKey=date&sortDirection=descending&downloadId=${h.toUpperCase()}`);
        const grab = (hr.records || []).find((r) => (r.eventType || '').toLowerCase() === 'grabbed');
        if (grab) await tfetch(`${base}/history/failed/${grab.id}`, { method: 'POST', headers: { 'X-Api-Key': key } }, 15000);
      } catch { /* blocklist is best-effort — removing the torrent still unsticks the title */ }
      try {
        await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ hashes: t.hash, deleteFiles: 'true' }) });
        console.log(`recovery: removed *arr-orphaned dead download "${t.name}" (no queue record — blocklisted via history)`);
      } catch { /* qbit hiccup — retried next sweep */ }
      _stallSince.delete(h);
      continue;
    }
    if (!qrec || qrec.id == null) continue;
    const itemId = app === 'radarr' ? qrec.movieId : qrec.seriesId;
    const key = `${app}:${itemId}`;
    if (_accepted.has(key)) { _stallSince.delete(h); continue; }                         // rare title we already chose to let sit
    if (now - (_lastResearch.get(h) || 0) < RESEARCH_EVERY) continue;
    _lastResearch.set(h, now);
    const cnt = _researchCount.get(key) || 0;
    try {
      if (cnt < MAX_RESEARCH) {
        // Still worth trying for a healthy copy: blocklist the dead one and re-search.
        await arrBlocklistAndResearch(app, qrec.id, itemId);
        _researchCount.set(key, cnt + 1);
        console.log(`recovery: dead release blocklisted + re-searched (try ${cnt + 1}/${MAX_RESEARCH}): ${t.name}`);
      } else {
        // Tried enough — this title is genuinely rare. Drop the dead copy, grab the single
        // best-seeded release available, and ACCEPT it: never abandon again, let it sit until a
        // seed shows up. (Sonarr: just stop churning and let the current copy ride.)
        await tfetch(`${arrOf(app).base}/queue/${qrec.id}?removeFromClient=true&blocklist=true`, { method: 'DELETE', headers: { 'X-Api-Key': arrOf(app).key } }, 20000);
        const seeders = await grabBestSeeded(app, itemId);
        _accepted.add(key);
        console.log(`recovery: "${t.name}" is rare after ${MAX_RESEARCH} tries — grabbed best available (${seeders == null ? 'left as-is' : seeders + ' seeds'}) and letting it sit`);
      }
      _stallSince.delete(h);
    } catch (e) { console.log(`recovery action failed for ${t.name}: ${e.message || e}`); }
  }
}
setInterval(stallRecovery, 300000); // every 5 min — STALL_DEAD/throttles gate the actual actions
setTimeout(stallRecovery, 20000);

// ---- GPU-compat verification sweep (movies): post-import ground truth ────────────────────
// Release titles can't prove bit depth — modern x265 is 10-bit-by-default without saying so,
// so some hidden-10-bit releases will always slip past the title-based custom formats. After
// import, Radarr's ffprobe mediaInfo KNOWS the truth.
//
// SWAP-SAFE DESIGN (a library title must never just vanish, and a swap must never downgrade):
//   1. Only files imported < 48h ago — a settled library is NEVER touched.
//   2. Playstate guard: skip anything anyone has started watching (fail-CLOSED: if Jellyfin
//      can't confirm, we don't act); already-watched titles are marked done (swap value ~0).
//   3. Search FIRST, act only if a STRICTLY better GPU-friendly release exists (custom-format
//      score > the current file's, real H.264, no 10-bit/HDR/AV1 markers, actually seeded) —
//      an indexer outage can't make us trade a small 10-bit file for a bloated x264.
//   4. ZERO-GAP: the old file is NOT deleted when the replacement is grabbed. It stays fully
//      playable until the new download COMPLETES; only then (Phase 1, playstate re-checked)
//      is the old copy removed and the new file imported. If the replacement never completes
//      (48h), the swap is abandoned and the old copy simply stays.
//   5. Once per movie EVER on success/watched (persisted in gpuSwapped); a no-better-release
//      pass retries at most every 6h within the 48h window. Max 2 new swaps per cycle. Never
//      in Movie Mode. Movies only. The Downloads UI labels the replacement download as an
//      auto-upgrade so an un-requested download always explains itself.
const GPU_SWAP_WINDOW_MS = 48 * 3600 * 1000;
let gpuVerifyBusy = false;
async function gpuVerifySweep() {
  if (masterPaused || gpuVerifyBusy) return;
  gpuVerifyBusy = true;
  try {
    let movies; try { movies = await arrGet('radarr', '/movie'); } catch { return; }
    const queue = await getQueueMap('radarr');
    const queuedIds = new Set([...queue.values()].map((q) => q.movieId));
    const now = Date.now();

    // Phase 1 — finalize in-flight zero-gap swaps. The old copy is removed ONLY here: after
    // the replacement finished downloading, and never while someone is mid-watch.
    if (gpuPending.size) {
      let torrents = [];
      try { torrents = await getQbitTorrents(); } catch { /* qbit down — try next cycle */ }
      for (const [mid, p] of gpuPending) {
        if (now - p.ts > 48 * 3600000) {              // replacement never completed — stand down, keep the old copy
          gpuPending.delete(mid); gpuSwapped.set(mid, { ts: now, done: true }); persistState();
          console.log(`gpuVerify: upgrade of "${p.title}" abandoned after 48h — old copy kept`);
          continue;
        }
        const old = new Set((p.oldHashes || []).map((x) => x.toLowerCase()));
        const fresh = torrents.filter((t) => torrentApp(t) === 'radarr'
          && !old.has((t.hash || '').toLowerCase())
          && (queue.get((t.hash || '').toLowerCase()) || {}).movieId === mid);
        const done = fresh.find((t) => (t.progress || 0) >= 1);
        if (!done) continue;                          // replacement still downloading — old copy stays playable
        try {                                          // fail CLOSED: no playstate confirmation → no deletion
          const jfId = await jellyfinIdByTmdb('Movie', p.tmdbId);
          if (jfId) {
            const uid = await jellyfinUserId();
            const it = await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items/${jfId}`, { headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' } }, 6000)).json();
            if (((it.UserData || {}).PlaybackPositionTicks || 0) > 0) {
              console.log(`gpuVerify: "${p.title}" replacement ready but someone is mid-watch — waiting`);
              continue;
            }
          }
        } catch { continue; }
        const files = await arrGet('radarr', `/moviefile?movieId=${mid}`).catch(() => []);
        for (const f of (Array.isArray(files) ? files : [])) { try { await arrDelete('radarr', `/moviefile/${f.id}`); } catch { /* */ } }
        if (old.size) {
          try { await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ hashes: [...old].join('|'), deleteFiles: 'true' }) }); } catch { /* */ }
        }
        if (done.content_path) { try { await importViaManual('radarr', done.content_path, mid); } catch { /* watchdog retries */ } }
        gpuPending.delete(mid); gpuSwapped.set(mid, { ts: now, done: true }); persistState();
        console.log(`gpuVerify: "${p.title}" upgraded — replacement complete, old copy removed, new file importing`);
      }
    }

    // Phase 2 — scan fresh imports for non-GPU-decodable files and start new swaps.
    let acted = 0;
    const BAD_CF = new Set(['10-bit (CPU)', 'HDR / Dolby Vision (CPU)', 'Likely 10-bit group (CPU)', 'AV1 (CPU)', 'VP9 (CPU)']);
    for (const m of movies) {
      if (acted >= 2) break;
      const mf = m.movieFile;
      if (!m.hasFile || !mf || !mf.mediaInfo) continue;
      if (queuedIds.has(m.id) || gpuPending.has(m.id)) continue;
      const st = gpuSwapped.get(m.id);
      if (st && (st.done || st === true || typeof st === 'number')) continue;   // done (legacy entries = plain ts)
      if (st && now - st.ts < 6 * 3600000) continue;                            // no-better-release backoff
      const added = new Date(mf.dateAdded || 0).getTime();
      if (!added || now - added > GPU_SWAP_WINDOW_MS) continue;    // settled library — only police fresh imports
      if (gpuTier(mf.mediaInfo) === 'ok') continue;
      const label = videoLabel(mf.mediaInfo);
      try {
        // Playstate guard — fail CLOSED: if Jellyfin can't confirm nobody's watching, don't act.
        try {
          const jfId = await jellyfinIdByTmdb('Movie', m.tmdbId);
          if (jfId) {
            const uid = await jellyfinUserId();
            const it = await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items/${jfId}`, { headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' } }, 6000)).json();
            const ud = it.UserData || {};
            if (ud.PlayCount > 0) { gpuSwapped.set(m.id, { ts: now, done: true }); persistState(); continue; }  // already watched fine — swap value ~0
            if ((ud.PlaybackPositionTicks || 0) > 0) continue;                   // someone is mid-watch — hands off
          }
        } catch { continue; }
        // Search FIRST. Act only if a STRICTLY better GPU-friendly release exists right now.
        const fileScore = mf.customFormatScore ?? 0;
        const { base, key } = arrOf('radarr');
        const rels = await (await tfetch(`${base}/release?movieId=${m.id}`, { headers: { 'X-Api-Key': key } }, 90000)).json();
        const best = (Array.isArray(rels) ? rels : [])
          .filter((r) => !r.rejected && (r.seeders || 0) > 0)
          .filter((r) => {
            const names = (r.customFormats || []).map((c) => c.name);
            return names.includes('H.264 (GPU)') && !names.some((n) => BAD_CF.has(n));
          })
          .sort((a, b) => (b.customFormatScore || 0) - (a.customFormatScore || 0) || (b.seeders || 0) - (a.seeders || 0))[0];
        acted++;                                                   // a /release search is the expensive unit — count it
        if (!best || (best.customFormatScore || 0) <= fileScore) {
          gpuSwapped.set(m.id, { ts: now, done: false });          // nothing better out there — retry in 6h within the window
          persistState();
          console.log(`gpuVerify: "${m.title}" is ${label} but no better H.264 release available (file score ${fileScore}) — keeping it, retry in 6h`);
          continue;
        }
        // Snapshot the OLD copy's torrent hashes BEFORE grabbing, so the replacement's own
        // torrent can never appear in the removal list.
        let oldHashes = [];
        try {
          const hist = await arrGet('radarr', `/history/movie?movieId=${m.id}`);
          const recs = Array.isArray(hist) ? hist : (hist.records || []);
          oldHashes = [...new Set(recs.map((r) => r.downloadId).filter(Boolean))];
        } catch { /* */ }
        // Grab the replacement FIRST — if this fails, the current file is untouched.
        const gr = await tfetch(`${base}/release`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ guid: best.guid, indexerId: best.indexerId }) }, 30000);
        if (!gr.ok) { console.log(`gpuVerify: "${m.title}" replacement grab failed (HTTP ${gr.status}) — leaving file in place`); continue; }
        // ZERO-GAP: the old file is NOT touched now. Register the pending swap — Phase 1
        // removes the old copy only after the replacement finishes downloading (and nobody
        // is watching). The Downloads UI labels this download as an auto-upgrade.
        gpuPending.set(m.id, { oldHashes, ts: now, title: m.title, tmdbId: m.tmdbId });
        persistState();
        console.log(`gpuVerify: "${m.title}" is ${label} (file score ${fileScore}) — grabbed better H.264 "${(best.title || '').slice(0, 60)}" (score ${best.customFormatScore}, ${best.seeders} seeds); old copy stays until it completes`);
      } catch (e) { console.log(`gpuVerify: failed for "${m.title}" — ${e.message || e}`); }
    }
  } finally { gpuVerifyBusy = false; }
}
setInterval(gpuVerifySweep, 600000); // every 10 min; per-cycle cap + once-per-movie guard bound the work
setTimeout(gpuVerifySweep, 60000);

// ---- Auto-collections sweep: decade / genre / top-rated collections, maintained natively ──
// "Automatic playlists by decade and genre" with NO third-party plugin: the controller derives
// rule-based Jellyfin COLLECTIONS (box sets — poster tiles in Movies → Collections) from
// library metadata and reconciles membership every pass, so they grow with the library and
// survive Jellyfin upgrades. Distinct names ("90s Movies", "Comedy Movies") can't collide
// with TMDb franchise box sets ("James Bond Collection"). Thin buckets (<5 titles) skipped.
let collSweepBusy = false;
async function collectionsSweep() {
  if (masterPaused || collSweepBusy || !cfg.JELLYFIN_KEY) return;
  collSweepBusy = true;
  try {
    const uid = await jellyfinUserId();
    const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };
    const q = new URLSearchParams({ IncludeItemTypes: 'Movie', Recursive: 'true', Fields: 'ProductionYear,Genres,CommunityRating,RunTimeTicks', Limit: '5000' });
    const movies = ((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 15000)).json()).Items) || [];
    if (movies.length < 20) return;                       // tiny library — don't spam collections
    const buckets = new Map();                            // collection name -> Set(itemId)
    const add = (name, id) => { if (!buckets.has(name)) buckets.set(name, new Set()); buckets.get(name).add(id); };
    const genreCount = {};
    for (const m of movies) {
      const y = m.ProductionYear || 0;
      if (y >= 1950) {
        const d = Math.floor(y / 10) * 10;
        add(`${d >= 2000 ? d : String(d).slice(2)}s Movies`, m.Id);
      }
      for (const g of (m.Genres || [])) genreCount[g] = (genreCount[g] || 0) + 1;
      if ((m.CommunityRating || 0) >= 7.5) add('Critically Loved', m.Id);
      const mins = m.RunTimeTicks ? Math.round(m.RunTimeTicks / 600000000) : 0;
      if (mins > 0 && mins <= 100) add('Short & Sweet', m.Id);        // weeknight-sized
      if (mins >= 150) add('Epic Runtimes', m.Id);                    // settle-in-for-it
    }
    // Genres: the top-8 by volume PLUS a curated set that's browse-worthy even when small
    // (Horror for October, Family for kids' nights, …) — anything with ≥5 titles makes it.
    const CURATED = ['Horror', 'Animation', 'Family', 'Documentary', 'Fantasy', 'Mystery', 'War', 'Western', 'Music'];
    const topGenres = new Set(Object.entries(genreCount).sort((a, b) => b[1] - a[1]).slice(0, 8).filter(([, c]) => c >= 10).map(([g]) => g));
    for (const g of CURATED) if ((genreCount[g] || 0) >= 5) topGenres.add(g);
    for (const m of movies) for (const g of (m.Genres || [])) if (topGenres.has(g)) add(`${g} Movies`, m.Id);
    for (const [name, ids] of [...buckets]) if (ids.size < 5) buckets.delete(name);
    // Poster source per collection: its highest-rated member's poster (set below when a
    // collection has no Primary image, so they don't sit as generic blue folders).
    const byId = new Map(movies.map((m) => [m.Id, m]));
    const posterPick = (want) => [...want].map((x) => byId.get(x)).filter(Boolean)
      .sort((a, b) => (b.CommunityRating || 0) - (a.CommunityRating || 0))[0];
    const setPoster = async (setId, memberId) => {
      const ir = await tfetch(`${HOST.jellyfin}/Items/${memberId}/Images/Primary?maxWidth=600&quality=90`, {}, 15000);
      if (!ir.ok) return false;
      const b64 = Buffer.from(await ir.arrayBuffer()).toString('base64');
      const ur = await tfetch(`${HOST.jellyfin}/Items/${setId}/Images/Primary`, { method: 'POST', headers: { ...h, 'Content-Type': ir.headers.get('content-type') || 'image/jpeg' }, body: b64 }, 20000);
      return ur.ok;
    };
    const bq = new URLSearchParams({ IncludeItemTypes: 'BoxSet', Recursive: 'true', Limit: '1000' });
    const sets = ((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${bq}`, { headers: h }, 15000)).json()).Items) || [];
    const byName = new Map(sets.map((s) => [s.Name, s.Id]));
    const noPoster = new Set(sets.filter((s) => !(s.ImageTags && s.ImageTags.Primary)).map((s) => s.Id));
    let created = 0, updated = 0, postered = 0;
    for (const [name, want] of buckets) {
      let setId = byName.get(name);
      if (!setId) {
        const r = await tfetch(`${HOST.jellyfin}/Collections?${new URLSearchParams({ Name: name, Ids: [...want].join(',') })}`, { method: 'POST', headers: h }, 20000);
        if (r.ok) {
          created++;
          try { setId = (await r.json()).Id; } catch { setId = null; }
          const pick = posterPick(want);
          if (setId && pick && await setPoster(setId, pick.Id).catch(() => false)) postered++;
        }
        continue;
      }
      if (noPoster.has(setId)) {
        const pick = posterPick(want);
        if (pick && await setPoster(setId, pick.Id).catch(() => false)) postered++;
      }
      const cq = new URLSearchParams({ ParentId: setId, Limit: '5000' });
      const have = new Set((((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${cq}`, { headers: h }, 15000)).json()).Items) || []).map((i) => i.Id));
      const toAdd = [...want].filter((x) => !have.has(x));
      const toDel = [...have].filter((x) => !want.has(x));
      if (toAdd.length) await tfetch(`${HOST.jellyfin}/Collections/${setId}/Items?Ids=${toAdd.join(',')}`, { method: 'POST', headers: h }, 20000);
      if (toDel.length) await tfetch(`${HOST.jellyfin}/Collections/${setId}/Items?Ids=${toDel.join(',')}`, { method: 'DELETE', headers: h }, 20000);
      if (toAdd.length || toDel.length) updated++;
    }
    if (created || updated || postered) console.log(`collectionsSweep: ${created} created, ${updated} refreshed, ${postered} poster(s) set (${buckets.size} auto-collections maintained)`);
  } catch (e) { console.log(`collectionsSweep: failed — ${e.message || e}`); }
  finally { collSweepBusy = false; }
}
setInterval(collectionsSweep, 6 * 3600000);   // twice a day keeps them fresh
setTimeout(collectionsSweep, 90000);

// Video format labelling and GPU-compatibility tier.
function videoLabel(mi) {
  if (!mi) return '';
  const c = (mi.videoCodec || '').toLowerCase();
  let codec = '';
  if (c.includes('x265') || c.includes('hevc')) codec = 'HEVC';
  else if (c.includes('av1')) codec = 'AV1';
  else if (c.includes('x264') || c.includes('h264') || c.includes('avc')) codec = 'H.264';
  else if (c.includes('vp9')) codec = 'VP9';
  else codec = c.toUpperCase() || '';
  const d = mi.videoBitDepth ? mi.videoBitDepth + 'bit' : '';
  const dr = mi.videoDynamicRange || '';
  const drt = (mi.videoDynamicRangeType || '').toUpperCase();
  let hdr = '';
  if (drt.includes('DV')) hdr = 'DV';
  else if (drt.includes('HDR10')) hdr = 'HDR10+';
  else if (dr && dr !== 'SDR') hdr = dr;
  return [codec, d, hdr].filter(Boolean).join(' ');
}
function gpuTier(mi) {
  if (!mi) return '';
  const c = (mi.videoCodec || '').toLowerCase();
  const d = mi.videoBitDepth || 8;
  const dr = mi.videoDynamicRange || '';
  const drt = (mi.videoDynamicRangeType || '').toUpperCase();
  // Tuned for this NUC's i5-6260U (Skylake Iris 540):
  //   HW decode: H.264 8-bit, HEVC 8-bit only (10-bit is software).
  //   HW encode: H.264, H.265 8-bit only.
  //   VP9 decode, no AV1, no DoVi.
  if (c.includes('av1')) return 'bad';
  if (c.includes('vp9')) return 'bad';   // VP9 HW decode is not enabled in this Jellyfin config → CPU
  if (drt.includes('DV')) return 'bad';
  if (d >= 10) return 'warn';
  if (drt.includes('HDR') || dr === 'HDR') return 'warn';
  return 'ok';
}

// Library — titles to clean up, biggest first.
app.get('/api/library', async (req, res) => {
  const a = req.query.app === 'sonarr' ? 'sonarr' : 'radarr';
  try {
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
    res.json({ app: a, items });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

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
  masterPaused = true; persistState();
  await qbitSetAddStopped(true);                       // grabs during Movie Mode stay stopped
  let ok = false;
  try { ok = (await qbitPauseResume('all', false)).ok; } catch { /* qbit down — flag still set, sweeps paused */ }
  console.log('master-pause: Movie Mode ON — torrents stopped, all sweeps paused');
  bustDownloadsCache();
  res.json({ ok: true, paused: true, qbit: ok });
});
app.post('/api/master-resume', async (_req, res) => {
  masterPaused = false; persistState();
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
    searchKeyClear(a, Number(id));  // a manual retry overrides the sweep cooldown + negative cache
    persistState();
    if (a === 'radarr') await arrPost(a, '/command', { name: 'MoviesSearch', movieIds: [Number(id)] }, 5000);
    else await arrPost(a, '/command', { name: 'SeriesSearch', seriesId: Number(id) }, 5000);
    console.log(`retry: triggered search for ${a} id=${id}`);
    bustDownloadsCache();
    res.json({ ok: true });
  } catch (e) { console.log(`retry: failed for ${a} id=${id} — ${e.message || e}`); res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Disk gate: decline a download that can't fit under the 20 GB cap ----
// Single-admin Jellyseerr auto-approves the owner's OWN requests, so there's no
// "pending" window to gate at the request stage. Instead we intercept at the download
// stage: once a torrent's real size is known (from metadata, within seconds — before it
// has pulled anything meaningful), if completing it would push /data past the cap we tear
// the title down everywhere (the same recipe as a manual delete, so no Radarr re-grab
// loop and the Jellyseerr mark is cleared) and remember WHY — the Downloads view then
// shows "Declined — not enough disk space" instead of a stuck ENOSPC half-download.
const declined = new Map(); // hash -> { title, neededBytes, freeBytes, ts, source }
// These two are also restored by loadState() below, so they MUST be declared before it runs —
// a `const` referenced before its line is a ReferenceError (TDZ) that loadState's catch would
// swallow, silently losing the persisted state across reboots.
const blocked = new Map();  // `app:id:seasons` -> { title, neededBytes, freeBytes, ts, lastCheck }
// movieId -> {ts, done} for GPU-compat re-grabs (gpuVerifySweep) — once per movie EVER,
// persisted, so the verifier can never loop on a title whose only releases are 10-bit.
const gpuSwapped = new Map();
// movieId -> {oldHashes, ts, title, tmdbId}: an in-flight ZERO-GAP swap. The better H.264
// copy has been grabbed but the OLD FILE STAYS PLAYABLE until the download completes; only
// then (and only if nobody is mid-watch) is the old copy removed and the new one imported.
const gpuPending = new Map();
// Per-item *arr search state, persisted so it survives a controller restart (an in-memory-only
// version, wiped on every reboot, is what let a restart re-trigger the full search/grab storm).
// Key `app:id` -> { ts: last auto-search ms, fails: consecutive fruitless searches, blockedUntil }.
const searchState = new Map();
// "Movie Mode" master switch: when true, ALL background work (downloads + every sweep) is paused so
// the NUC's CPU + the single USB disk are free for smooth Jellyfin playback. Persisted so it stays
// off/on across a controller restart — only an explicit resume turns it back on.
let masterPaused = false;

// Persist declined + blocked tombstones across restarts so the "Declined" rows
// survive a controller reboot.
function persistState() {
  clearTimeout(persistState._timer);
  persistState._timer = setTimeout(() => {
    try {
      const obj = { declined: {}, blocked: {}, searchState: {}, gpuSwapped: {}, gpuPending: {}, masterPaused };
      for (const [k, v] of declined) obj.declined[k] = v;
      for (const [k, v] of blocked) obj.blocked[k] = v;
      for (const [k, v] of searchState) obj.searchState[k] = v;
      for (const [k, v] of gpuSwapped) obj.gpuSwapped[k] = v;
      for (const [k, v] of gpuPending) obj.gpuPending[k] = v;
      fs.writeFileSync('/config/state.json', JSON.stringify(obj));
    } catch { /* */ }
  }, 500);
}
function loadState() {
  try {
    const obj = JSON.parse(fs.readFileSync('/config/state.json', 'utf8'));
    if (obj.declined) for (const [k, v] of Object.entries(obj.declined)) declined.set(k, v);
    if (obj.blocked) for (const [k, v] of Object.entries(obj.blocked)) blocked.set(k, v);
    if (obj.searchState) for (const [k, v] of Object.entries(obj.searchState)) searchState.set(k, v);
    if (obj.gpuSwapped) for (const [k, v] of Object.entries(obj.gpuSwapped)) gpuSwapped.set(Number(k), v);
    if (obj.gpuPending) for (const [k, v] of Object.entries(obj.gpuPending)) gpuPending.set(Number(k), v);
    if (typeof obj.masterPaused === 'boolean') masterPaused = obj.masterPaused;
  } catch { /* */ }
}
loadState();

async function arrIdForHash(app, hash) {
  const r = (await getQueueMap(app)).get(hash);
  if (r) return app === 'radarr' ? r.movieId : r.seriesId;
  const hi = (await getHistoryIndex(app)).get(hash);
  return hi ? hi.id : null;
}

let gateBusy = false;
async function diskGate() {
  if (masterPaused) return;                               // Movie Mode — torrents are stopped, nothing to gate
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
setInterval(diskGate, 8000); // cheap (qbit info + statfs); catches a new torrent before it fills /data
setTimeout(diskGate, 6000);

// ---- Orphan sweep: tear down *arr torrents whose series/movie has been deleted ----
// When a TV show or movie is deleted from the library some per-episode torrents may
// still be waiting in the qBittorrent queue (or are added asynchronously by *arr in a
// race with deletion). These orphans have an *arr category but belong to an item that
// no longer exists — they'll keep downloading forever with no parent row to delete
// them from. This sweep finds and removes them.
let orphanBusy = false;
async function orphanSweep() {
  if (masterPaused) return;                               // Movie Mode — no cleanup churn
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
        } catch (e) { console.log(`orphanSweep: teardown failed — ${String(e.message || e)}`); }
      }
      if (zombies.length) {
        try {
          const body = new URLSearchParams({ hashes: zombies.join('|'), deleteFiles: 'false' });
          await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
          console.log(`orphanSweep: removed ${zombies.length} zombie missingFiles torrent(s) from ${app} (entries only — no files on disk)`);
        } catch (e) { console.log(`orphanSweep: zombie cleanup failed — ${String(e.message || e)}`); }
      }
    }
  } finally { orphanBusy = false; }
}
setInterval(orphanSweep, 60000);
setTimeout(orphanSweep, 15000);

// ---- Seerr orphan sweep: remove media entries whose *arr counterpart is gone ----
let seerrSweepBusy = false;
async function seerrSweep() {
  if (masterPaused || seerrSweepBusy || !cfg.SEERR_KEY) return;     // Movie Mode — no request processing
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
setInterval(seerrSweep, 300000); // every 5 min
setTimeout(seerrSweep, 30000);   // first run after 30s

// ---- *arr sweep: auto-recover stuck queue items + trigger search for missing monitored items ----
let arrSweepBusy = false;
// searchState is declared up by `declined` (must exist before loadState() runs). Tuning knobs:
const SEARCH_COOLDOWN_MS = 6 * 3600000;        // 6h between recovery re-searches of the same item
const SEARCH_FAIL_LIMIT = 4;                   // after this many fruitless searches → negative-cache it
const SEARCH_BLOCK_MS = 7 * 24 * 3600 * 1000;  // ...for a week (a manual /api/retry clears it sooner)
const SWEEP_MAX_ACTIVE_DL = 10;                // capacity guard: no new searches while this many download
// The sweep is RECOVERY, not the first responder: Radarr/Sonarr already auto-search on request
// (Jellyseerr sets searchForMovie). The sweep must NOT re-search a freshly-requested item while
// that initial search is still resolving — that's what caused duplicate grabs AND the "Not found →
// found seconds later" flip-flop. So we track when an item was FIRST seen missing and only let the
// sweep act after RECOVERY_GRACE. The UI shows "Searching…" (not the alarming "Not found") until
// NOTFOUND_GRACE, covering normal grab latency.
const RECOVERY_GRACE_MS = 2 * 3600000;         // 2h: leave a missing item to *arr's own search first
const NOTFOUND_GRACE_MS = 20 * 60000;          // 20min: show "Searching…" before "Not found" in the UI
// firstMissing bookkeeping shared by buildDownloads (UI) and arrSweep (recovery). Starts the clock
// the first time an item is seen missing; cleared once it has a file / queue / torrent again.
function noteMissing(app, id) {
  const k = `${app}:${id}`; const st = searchState.get(k) || {};
  if (!st.firstMissing) { st.firstMissing = Date.now(); searchState.set(k, st); }
  return st.firstMissing;
}
function noteResolved(app, id) {  // item now has file/queue/torrent → reset the missing clock
  const k = `${app}:${id}`; const st = searchState.get(k);
  if (st && st.firstMissing) { st.firstMissing = 0; searchState.set(k, st); }
}
const DL_STATES = new Set(['downloading', 'stalledDL', 'metaDL', 'forcedDL', 'queuedDL', 'checkingDL', 'allocating']);
const searchKeyClear = (app, id) => searchState.delete(`${app}:${id}`); // manual retry overrides cooldown+block
// The specific episodes of a Sonarr series that still need a file: monitored, aired (or with no
// known air date), and not already on disk. This is what we hand to EpisodeSearch so a season with
// no pack fills in episode-by-episode. Returns [] on any error (skip this series this pass).
async function missingEpisodeIds(seriesId) {
  let eps;
  try { eps = await arrGet('sonarr', `/episode?seriesId=${seriesId}`, 8000); }
  catch { return []; }
  const now = Date.now();
  return (Array.isArray(eps) ? eps : [])
    .filter((e) => !e.hasFile && e.monitored && (!e.airDateUtc || new Date(e.airDateUtc).getTime() <= now))
    .map((e) => e.id);
}
async function arrSweep() {
  if (masterPaused || arrSweepBusy) return;               // Movie Mode — no searches/grabs/recovery
  arrSweepBusy = true;
  try {
    for (const app of ['radarr', 'sonarr']) {
      let queue = [];
      try { const qr = await arrGet(app, '/queue?pageSize=200&includeUnknownMovieItems=true', 8000); queue = qr.records || []; }
      catch { continue; }

      const stuckIds = [];
      const stalledHashes = [];
      for (const qe of queue) {
        const id = qe.movieId || qe.seriesId;
        if (qe.trackedDownloadState === 'importBlocked' && qe.errorMessage && /missing file/i.test(qe.errorMessage)) {
          stuckIds.push({ id, queueId: qe.id, blocklist: false });   // good release, import glitch — don't blocklist
        }
        if ((qe.status === 'queued' || qe.status === 'paused') && qe.size === 0 && qe.sizeleft === 0 && qe.errorMessage && /metadata/i.test(qe.errorMessage)) {
          // Dead magnet: couldn't even fetch metadata (0 seeds). Blocklist it so *arr grabs a DIFFERENT
          // release next search instead of re-grabbing the same corpse (that loop = the "Not found" churn).
          stuckIds.push({ id, queueId: qe.id, blocklist: true });
          if (qe.downloadId) stalledHashes.push(qe.downloadId);
        }
        // Terminal import rejections: a COMPLETED download *arr refuses to import ("Not an
        // upgrade…", "Sample") will never improve — it sits in the queue wasting disk and a
        // slot forever (audit found 4 wedged for days). Remove + blocklist so it's never
        // re-grabbed. Transient states (still downloading, missing-file glitch) don't match.
        const doneDl = (qe.status || '').toLowerCase() === 'completed'
          || (qe.trackedDownloadState === 'importPending' || qe.trackedDownloadState === 'importBlocked');
        // EXEMPT in-flight gpuVerify zero-gap swaps: their replacement will briefly sit at
        // "not an upgrade" (old file still on disk by design) until Phase 1 clears the old
        // copy — cleaning it up here would kill the upgrade mid-swap.
        const isPendingSwap = app === 'radarr' && qe.movieId != null && gpuPending.has(qe.movieId);
        if (doneDl && !isPendingSwap && (qe.trackedDownloadStatus || '').toLowerCase() === 'warning') {
          const msgs = ((qe.statusMessages || []).flatMap((m) => m.messages || []).join(' ') + ' ' + (qe.errorMessage || '')).toLowerCase();
          if (/not an upgrade|not a custom format upgrade|\bsample\b/.test(msgs)) {
            stuckIds.push({ id, queueId: qe.id, blocklist: true });
          }
        }
      }

      for (const s of stuckIds) {
        try {
          await arrDelete(app, `/queue/${s.queueId}?removeFromClient=true&blocklist=${s.blocklist}`);
          console.log(`arrSweep: removed stuck queue item id=${s.id} from ${app}${s.blocklist ? ' (blocklisted dead release)' : ''}`);
        } catch (e) { console.log(`arrSweep: failed to remove queue item id=${s.id} from ${app} — ${e.message || e}`); }
      }

      if (stalledHashes.length) {
        try {
          const body = new URLSearchParams({ hashes: stalledHashes.join('|'), deleteFiles: 'true' });
          await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
          console.log(`arrSweep: removed ${stalledHashes.length} stalled torrent(s) from qBittorrent`);
        } catch (e) { console.log(`arrSweep: failed to remove stalled torrents — ${e.message || e}`); }
      }

      // Map this app's qBittorrent torrents to their *arr item id (via queue + history download
      // hashes). This is the dedup / already-downloading guard the old sweep lacked: it decided
      // what to search from the *arr QUEUE alone, which can list fewer items than qBittorrent
      // actually holds — so it re-searched titles that were already downloading, and Radarr then
      // grabbed a second, different release. That, plus the (formerly in-memory) cooldown being
      // wiped on every restart, is what produced the duplicate-download storm.
      let torrents = [];
      try { torrents = await getQbitTorrents(); } catch { /* qbit down — skip dedup + guard this pass */ }
      const hashToId = new Map();
      for (const q of queue) if (q.downloadId) hashToId.set(q.downloadId.toLowerCase(), q.movieId || q.seriesId);
      try {
        for (const r of ((await arrGet(app, '/history?pageSize=500&sortKey=date&sortDirection=descending')).records || [])) {
          const h = (r.downloadId || '').toLowerCase();
          if (h && (r.movieId || r.seriesId) != null && !hashToId.has(h)) hashToId.set(h, r.movieId || r.seriesId);
        }
      } catch { /* history optional */ }

      let activeDl = 0;
      const inflightById = new Map();   // movieId -> [in-flight torrents] (dedup candidates, radarr only)
      const completedById = new Map();  // movieId -> [completed/seeding torrents] (supersede cleanup, radarr only)
      const hasTorrentIds = new Set();  // arrId -> a real (non-orphan) torrent exists → don't re-search
      for (const t of torrents) {
        const state = t.state || '';
        const inflight = DL_STATES.has(state);
        if (inflight) activeDl++;                                // global active-download count
        if (torrentApp(t) !== app) continue;
        const id = hashToId.get((t.hash || '').toLowerCase());
        if (id == null) continue;
        if (state !== 'missingFiles') hasTorrentIds.add(id);     // present/downloading/seeding — already handled
        if (inflight) {
          if (!inflightById.has(id)) inflightById.set(id, []);
          inflightById.get(id).push(t);
        } else if ((t.progress || 0) >= 1 && state !== 'missingFiles') {
          if (!completedById.has(id)) completedById.set(id, []);
          completedById.get(id).push(t);
        }
      }

      // Duplicate resolution — MOVIES ONLY, and only among IN-FLIGHT (downloading) torrents.
      //   • A Sonarr series legitimately holds many torrents (one per season/episode), so grouping
      //     by seriesId would wrongly flag whole seasons as "duplicates" — never dedup TV here.
      //   • Completed/seeding library torrents and orphaned missingFiles are never touched, so we
      //     can't delete real media. Only a genuine concurrent download race (≥2 in-flight torrents
      //     for the same movie) is resolved: keep the most-progressed, delete the rest (partial data).
      if (app === 'radarr') {
        for (const [id, ts] of inflightById) {
          if (ts.length < 2) continue;
          const sorted = ts.slice().sort((a, b) => (b.progress || 0) - (a.progress || 0) || (a.size || 0) - (b.size || 0));
          const losers = sorted.slice(1).map((t) => t.hash).filter(Boolean);
          if (!losers.length) continue;
          try {
            await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ hashes: losers.join('|'), deleteFiles: 'true' }) });
            console.log(`arrSweep: radarr id=${id} had ${ts.length} in-flight torrents — kept "${sorted[0].name}", removed ${losers.length} duplicate download(s)`);
          } catch (e) { console.log(`arrSweep: duplicate cleanup failed for radarr id=${id} — ${e.message || e}`); }
        }
        // Superseded copies: a movie with >1 COMPLETED torrent (old pre-upgrade/redownload copy still
        // seeding + the current one). Keep the newest, delete the rest. Safe: the library file is a
        // separate/hard-linked copy, so removing the torrent's copy never deletes the movie from Jellyfin.
        for (const [id, ts] of completedById) {
          if (ts.length < 2) continue;
          const sorted = ts.slice().sort((a, b) => (b.completion_on || 0) - (a.completion_on || 0));  // newest first
          const losers = sorted.slice(1).map((t) => t.hash).filter(Boolean);
          if (!losers.length) continue;
          try {
            await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ hashes: losers.join('|'), deleteFiles: 'true' }) });
            console.log(`arrSweep: radarr id=${id} had ${ts.length} completed torrents — kept newest "${sorted[0].name}", removed ${losers.length} superseded copy(ies)`);
          } catch (e) { console.log(`arrSweep: superseded cleanup failed for radarr id=${id} — ${e.message || e}`); }
        }
      }
      const downloadingIds = hasTorrentIds;

      // Trigger search for monitored items with no file, not already queued, not already
      // downloading in qBittorrent, not within cooldown, and not negative-cached.
      let items = [];
      try {
        if (app === 'radarr') items = await arrGet('radarr', '/movie', 8000);
        else items = await arrGet('sonarr', '/series', 8000);
      } catch { continue; }

      const now = Date.now();
      const qIds = new Set(queue.map((q) => q.movieId || q.seriesId));
      const needSearch = items.filter((i) => {
        // Sonarr: a series is "complete" only when every monitored, aired episode has a file.
        // The old `!!episodeFileCount` treated a series holding ANY file as done, so a partially
        // filled series (e.g. S1 present, S2–S4 missing) was cleared and NEVER recovered.
        const ss = app === 'sonarr' && i.statistics;
        const hasContent = app === 'radarr'
          ? !!i.hasFile
          : !!(ss && ss.episodeCount > 0 && ss.episodeFileCount >= ss.episodeCount);
        if (hasContent) { searchKeyClear(app, i.id); return false; }             // got it — clear all state
        if (i.monitored === false) return false;
        if (qIds.has(i.id) || downloadingIds.has(i.id)) { noteResolved(app, i.id); return false; } // in flight — reset clock
        const firstMissing = noteMissing(app, i.id);                            // start/read the missing clock
        const st = searchState.get(`${app}:${i.id}`);
        if (st && st.blockedUntil && st.blockedUntil > now) return false;        // negative-cached (no content)
        if (now - firstMissing < RECOVERY_GRACE_MS) return false;               // still *arr's own job — don't interfere
        if (st && st.ts && now - st.ts < SEARCH_COOLDOWN_MS) return false;       // already recovered recently
        return true;
      });

      if (needSearch.length) {
        // Up to 8 recovery searches per 5-min sweep — gentle on indexers, and it does NOT gate on
        // how many are already downloading: qBittorrent's own max_active_downloads caps real
        // concurrency (extra grabs just queue), so a full missing-library backlog steadily fills in
        // instead of being starved whenever a handful of downloads are active (which stranded a pile
        // of requested movies at "Not found"). A grab storm is prevented by compact sizes + dedup +
        // the qBittorrent cap, not by refusing to search.
        const batch = needSearch.slice(0, 8);
        if (activeDl >= SWEEP_MAX_ACTIVE_DL) console.log(`arrSweep: ${activeDl} downloading; still searching ${batch.length} missing ${app} item(s) (qBittorrent caps concurrency)`);
        for (const item of batch) {
          const key = `${app}:${item.id}`;
          // Sonarr: resolve exactly which episodes still need grabbing BEFORE touching the fail
          // counter — if nothing is searchable (all missing episodes are unaired) we skip without
          // burning a "fail", so an airing show never gets negative-cached for episodes that
          // simply haven't come out yet.
          let episodeIds = null;
          if (app === 'sonarr') {
            episodeIds = await missingEpisodeIds(item.id);
            if (!episodeIds.length) continue;
          }
          const st = searchState.get(key) || { ts: 0, fails: 0, blockedUntil: 0 };
          if (st.ts) st.fails = (st.fails || 0) + 1;   // a prior search left it with no content → it failed
          st.ts = now;
          if (st.fails >= SEARCH_FAIL_LIMIT) {
            st.blockedUntil = now + SEARCH_BLOCK_MS;
            console.log(`arrSweep: ${app} "${item.title}" (${item.id}) searched ${st.fails}× with no grab — negative-caching 7d (manual retry clears)`);
          }
          searchState.set(key, st);
          try {
            if (app === 'radarr') {
              await arrPost(app, '/command', { name: 'MoviesSearch', movieIds: [item.id] }, 5000);
              console.log(`arrSweep: triggered search for radarr "${item.title}" (${item.id})`);
            } else {
              // EpisodeSearch (NOT SeriesSearch): SeriesSearch/SeasonSearch only look for whole-season
              // PACKS, which airing shows usually lack — so those searches find nothing and the season
              // never fills in. EpisodeSearch with explicit episode IDs makes Sonarr grab the
              // individual-episode releases that actually exist, one per missing episode.
              await arrPost(app, '/command', { name: 'EpisodeSearch', episodeIds }, 8000);
              console.log(`arrSweep: triggered EpisodeSearch for sonarr "${item.title}" (${item.id}) — ${episodeIds.length} missing episode(s)`);
            }
          } catch (e) { console.log(`arrSweep: search trigger failed for ${item.id} — ${e.message || e}`); }
        }
        persistState();
      }
    }
  } catch (e) { console.log(`arrSweep: sweep failed — ${e.message || e}`); }
  finally { arrSweepBusy = false; }
}
setInterval(arrSweep, 300000); // every 5 min
setTimeout(arrSweep, 30000);    // first run after 30s

// ---- Request gate: surface a request that Radarr/Sonarr REJECTED for disk space ----
// The *arrs enforce the 20 GB cap themselves ("…will exceed available disk space") and
// drop the release at SEARCH time — so nothing ever reaches qBittorrent and the disk gate
// above never sees it; Jellyseerr just shows "request successful" forever. We close that
// gap: for a request stuck in "processing" with no download, we reproduce the *arr's own
// rejections via an interactive search. If the only thing standing between us and a grab is
// space (a release rejected SOLELY for disk space exists), we flag it Declined with the
// real numbers. Non-disk stalls ("no release found yet") are transient — left alone.
// (`blocked` is declared up by `declined` so loadState() can restore it before this point.)
const DISK_REJ = /exceed available disk space/i;

async function freeUnderCap() {
  const s = await fs.promises.statfs('/data');
  const total = s.blocks * s.bsize;
  const cap = total > 0 ? total : 0;
  return Math.max(0, cap - (total - s.bavail * s.bsize));
}
async function arrTitle(app, id, seasons) {
  try {
    const it = await arrGet(app, app === 'radarr' ? `/movie/${id}` : `/series/${id}`);
    let t = it.title + (it.year ? ` (${it.year})` : '');
    if (app === 'sonarr' && seasons.length) t += seasons.length === 1 ? ` — Season ${seasons[0]}` : ` — Seasons ${seasons.join(', ')}`;
    return t;
  } catch { return 'Requested title'; }
}
// True if the *arr is already doing something about this id (queued / grabbed / has a file) —
// i.e. it's NOT stuck, so there's nothing to explain.
async function arrHasActivity(app, id) {
  try { if (((await arrGet(app, '/queue?pageSize=200')).records || []).some((r) => (app === 'radarr' ? r.movieId : r.seriesId) === id)) return true; } catch { /* arr down */ }
  try {
    if (app === 'radarr') { if ((await arrGet('radarr', `/movie/${id}`)).hasFile) return true; }
    else if (((await arrGet('sonarr', `/series/${id}`)).statistics || {}).episodeFileCount > 0) return true;
  } catch { /* arr down */ }
  try {
    const h = await arrGet(app, app === 'radarr' ? `/history/movie?movieId=${id}` : `/history/series?seriesId=${id}`);
    if ((Array.isArray(h) ? h : h.records || []).some((r) => (r.eventType || '').toLowerCase() === 'grabbed')) return true;
  } catch { /* no history */ }
  return false;
}
// Smallest release whose ONLY rejection is disk space = "the one we'd grab if it fit".
function diskOnlyBlocker(releases) {
  let best = null;
  for (const r of releases) {
    const rej = r.rejections || [];
    if (!rej.length) return null;                       // a grabbable release exists → not a disk wall
    if (rej.every((x) => DISK_REJ.test(x)) && (r.size || 0) > 0 && (!best || r.size < best.size)) best = r;
  }
  return best;                                          // null = stuck for some OTHER reason
}
async function diagnose(app, id, seasons) {
  const rels = [];
  try {
    if (app === 'radarr') rels.push(...await arrGet('radarr', `/release?movieId=${id}`, 90000));
    else for (const sn of (seasons.length ? seasons : [1])) { try { rels.push(...await arrGet('sonarr', `/release?seriesId=${id}&seasonNumber=${sn}`, 90000)); } catch { /* indexer hiccup */ } }
  } catch { return null; }
  return diskOnlyBlocker(rels);
}

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
      } else blocked.delete(key);                       // stuck for a non-disk reason → don't flag
    }
  } finally { reqBusy = false; persistState(); }
}
setInterval(requestGate, 60000);
setTimeout(requestGate, 15000);

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
// Periodic safety-net scan + startup catch-up.
// If no scan has succeeded in 10 minutes, fire one. This catches media that
// *arr imported while the controller was down or the notification missed.
setInterval(() => {
  if (!cfg.JELLYFIN_KEY) return;
  if (Date.now() - _lastScan > 600000) { console.log('jfScan: 10 min overdue — triggering refresh'); triggerJellyfinScan(); }
}, 120000);
// On controller start, wait for Jellyfin to be ready then do a catch-up scan
// so media imported during downtime gets discovered.
setTimeout(() => { if (cfg.JELLYFIN_KEY) { console.log('jfScan: startup catch-up scan'); triggerJellyfinScan(); } }, 45000);



app.listen(PORT, () => console.log(`controller listening on :${PORT} (NUC_IP=${NUC_IP}, keys ${cfg.RADARR_KEY ? 'loaded' : 'NOT provisioned'})`));
