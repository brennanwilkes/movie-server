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
  jellyfin: 'http://jellyfin:8096',
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
  cookie: null,
  async login() {
    const r = await tfetch(`${HOST.jellyseerr}/api/v1/auth/jellyfin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: cfg.JELLYFIN_ADMIN_USER, password: cfg.JELLYFIN_ADMIN_PASS }),
    }, 12000); // jellyfin-backed auth can be slow on a cold start
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    return this.cookie;
  },
  async fetch(p, opts = {}) {
    if (!this.cookie) await this.login();
    const go = () => tfetch(`${HOST.jellyseerr}${p}`, { ...opts, headers: { ...(opts.headers || {}), Cookie: this.cookie || '' } }, opts.ms || 10000);
    let r = await go();
    if (r.status === 401 || r.status === 403) { await this.login(); r = await go(); }
    return r;
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

// ── Jellyfin helpers (API-key auth) ──
async function jellyfinUserId() {
  const r = await tfetch(`${HOST.jellyfin}/Users`, { headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' } }, 5000);
  const u = await r.json();
  return (u.find((x) => x.Policy && x.Policy.IsAdministrator) || u[0] || {}).Id;
}
// Find the library item + whether its type-library would be empty after removal.
async function jellyfinResolve(type, title, tmdbId) {
  if (!cfg.JELLYFIN_KEY) return { itemId: null, libraryEmptyAfter: false };
  const uid = await jellyfinUserId();
  const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };
  const q1 = new URLSearchParams({ recursive: 'true', includeItemTypes: type, searchTerm: title, fields: 'ProviderIds,ProductionYear', limit: '50' });
  const items = ((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${q1}`, { headers: h }, 6000)).json()).Items) || [];
  // Confident match only: pin on the *arr tmdb id, else accept a lone unambiguous search hit.
  // (We explicitly DELETE this item below, so never fall through to a fuzzy items[0] guess.)
  const match = items.find((i) => tmdbId && i.ProviderIds && i.ProviderIds.Tmdb === String(tmdbId)) || (items.length === 1 ? items[0] : null);
  const q2 = new URLSearchParams({ recursive: 'true', includeItemTypes: type, limit: '0', enableTotalRecordCount: 'true' });
  const total = (await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${q2}`, { headers: h }, 6000)).json()).TotalRecordCount || 0;
  return { itemId: (match && match.Id) || null, libraryEmptyAfter: total <= 1 };
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
  const r = await seerr.fetch(`/api/v1/${kind}/${tmdbId}`);
  if (!r.ok) return null;
  const d = await r.json();
  return (d.mediaInfo && d.mediaInfo.id) || null;
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
  { id: 'qbittorrent', name: 'Downloads', brand: 'qBittorrent', url: `${HOST.qbittorrent}/api/v2/app/version`, text: true },
  { id: 'radarr', name: 'Movies', brand: 'Radarr', url: `${HOST.radarr}/api/v3/system/status`, headers: () => ({ 'X-Api-Key': cfg.RADARR_KEY || '' }), version: (j) => j.version },
  { id: 'sonarr', name: 'TV Shows', brand: 'Sonarr', url: `${HOST.sonarr}/api/v3/system/status`, headers: () => ({ 'X-Api-Key': cfg.SONARR_KEY || '' }), version: (j) => j.version },
  { id: 'prowlarr', name: 'Torrents', brand: 'Prowlarr', url: `${HOST.prowlarr}/api/v1/system/status`, headers: () => ({ 'X-Api-Key': cfg.PROWLARR_KEY || '' }), version: (j) => j.version },
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
  if (s.startsWith('paused')) return 'Paused';
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
async function getQbitTorrents() {
  try { const r = await qbit.fetch('/api/v2/torrents/info'); return r.ok ? await r.json() : []; } catch { return []; }
}
async function getQueueMap(app) {
  const m = new Map();
  try { for (const r of ((await arrGet(app, '/queue?pageSize=200')).records || [])) if (r.downloadId) m.set(r.downloadId.toLowerCase(), r); } catch { /* arr down */ }
  return m;
}
// downloadId(hash) -> { imported, id } from recent history (maps a torrent to its movie/series).
async function getHistoryIndex(app) {
  const idx = new Map();
  try {
    for (const r of ((await arrGet(app, '/history?pageSize=250&sortKey=date&sortDirection=descending')).records || [])) {
      const h = (r.downloadId || '').toLowerCase(); if (!h) continue;
      const cur = idx.get(h) || { imported: false, id: null };
      if ((r.eventType || '').toLowerCase().includes('import')) cur.imported = true;
      if (r.movieId) cur.id = r.movieId; if (r.seriesId) cur.id = r.seriesId;
      idx.set(h, cur);
    }
  } catch { /* arr down */ }
  return idx;
}
// id -> hasFile, the authoritative "in the library" flag.
async function getHasFileMap(app) {
  const m = new Map();
  try {
    if (app === 'radarr') for (const mv of await arrGet('radarr', '/movie')) m.set(mv.id, !!mv.hasFile);
    else for (const s of await arrGet('sonarr', '/series')) m.set(s.id, ((s.statistics && s.statistics.episodeFileCount) || 0) > 0);
  } catch { /* arr down */ }
  return m;
}
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

// Per-folder import-rescue state (NOT sticky): the watchdog retries with backoff, and
// a title flips to "Ready" the moment *arr reports hasFile — regardless of this.
const importState = new Map(); // folder -> { lastTry, reason }
const knownInLibrary = new Set(); // torrent hash -> tracked for event-driven scan

async function buildDownloads() {
  const now = Math.floor(Date.now() / 1000), DAY = 86400;
  const torrents = await getQbitTorrents();
  const queues = { radarr: await getQueueMap('radarr'), sonarr: await getQueueMap('sonarr') };
  // Only pay for history + library lookups if there's a completed, untracked torrent to classify.
  const need = new Set();
  for (const t of torrents) {
    const app = torrentApp(t); if (!app) continue;
    if (Math.round((t.progress || 0) * 100) >= 100 && !queues[app].has((t.hash || '').toLowerCase())) need.add(app);
  }
  const hist = {}, hasFile = {};
  for (const app of need) { hist[app] = await getHistoryIndex(app); hasFile[app] = await getHasFileMap(app); }

  const items = [];
  for (const t of torrents) {
    const h = (t.hash || '').toLowerCase();
    const app = torrentApp(t);
    const prog = Math.round((t.progress || 0) * 100);
    const eta = (t.eta && t.eta < 8640000) ? t.eta : null;
    const qrec = app ? queues[app].get(h) : null;
    let state, attention = false, recover = null;
    if (qrec) {                                    // *arr is actively tracking it
      const tds = (qrec.trackedDownloadState || '').toLowerCase();
      if ((qrec.status || '').toLowerCase() === 'paused') state = 'Paused';
      else if (tds.includes('import')) state = 'Importing';
      else if (prog < 100) state = 'Downloading';
      else state = 'Importing';
    } else if (prog < 100) {                        // still downloading
      state = friendlyTorrentState(t);
    } else if (app) {                               // complete, no longer in the *arr queue
      const hi = hist[app] && hist[app].get(h);
      const imported = !!(hi && (hi.imported || (hi.id != null && hasFile[app] && hasFile[app].get(hi.id) === true)));
      if (imported) {
        // *arr has the file, but don't go green until Bazarr has grabbed subs (or the grace
        // window lapses) — "Ready" is the only clickable/ready state, so it must mean
        // *fully* ready, subtitles included.
        if (await subsReady(app, hi && hi.id, t.completion_on)) {
          state = 'Ready';                     // imported AND subtitles settled — ready to watch
          if (!knownInLibrary.has(h)) { knownInLibrary.add(h); triggerJellyfinScan(); }
        } else {
          state = 'Getting subtitles';              // in the library, Bazarr still working on subs
        }
      } else {                                      // downloaded but *arr has NOT imported it
        recover = { app, folder: t.content_path };
        const reason = (importState.get(t.content_path) || {}).reason;
        if (reason) { state = 'Needs attention'; attention = true; }
        else state = 'Importing';                   // the watchdog will import it shortly
      }
    } else {
      state = 'Done';                               // a non-*arr torrent, just complete
    }
    const finished = state === 'Ready' || state === 'Done';
    const show = !finished || ((t.completion_on || 0) > 0 && now - t.completion_on <= DAY);
    if (show) items.push({ title: t.name, progress: (state === 'Importing' || state === 'Needs attention' || state === 'Getting subtitles') ? 100 : prog, state, etaSeconds: state === 'Downloading' ? eta : null, sizeBytes: t.size || 0, source: app || 'torrent', attention, _recover: recover, hash: t.hash });
  }
  const rank = (s) => s === 'Needs attention' ? 0 : (s === 'Ready' || s === 'Done') ? 2 : 1;
  items.sort((a, b) => rank(a.state) - rank(b.state));
  return items;
}

app.get('/api/downloads', async (_req, res) => {
  const now = Math.floor(Date.now() / 1000), DAY = 86400;
  const items = (await buildDownloads()).map(({ _recover, ...r }) => r);
  // Surface titles we declined for disk space — both the download-stage gate (`declined`,
  // keyed by torrent hash) and the request-stage gate (`blocked`, *arr-rejected before any
  // download). Both render as a terminal red "Declined" row at the top.
  const asRow = (hash, d) => ({ title: d.title, progress: 0, state: 'Declined', etaSeconds: null,
    sizeBytes: d.neededBytes, neededBytes: d.neededBytes, freeBytes: d.freeBytes, source: d.source || 'request', attention: false, hash });
  for (const [h, d] of declined) if (now - d.ts <= DAY) items.unshift(asRow(h, d));
  for (const [h, b] of blocked) if (now - b.ts <= DAY) items.unshift(asRow(h, b));
  res.json({ items });
});

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

// ---- Auto-import watchdog (backend, container-to-container; NOT driven by the UI) ----
// The happy path is event-driven: qBittorrent finishes → *arr imports → *arr pushes a
// "library updated" notification to Jellyfin. But when *arr DROPS a completed download
// without importing (the delete→re-download race), there's no event to react to — so a
// periodic sweep is the only way to catch the *absence* of an import. It runs the same
// Manual Import the *arr UI offers, and retries with backoff until the file lands.
async function importViaManual(app, folder) {
  const { base, key } = arrOf(app);
  const r = await tfetch(`${base}/manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=true`, { headers: { 'X-Api-Key': key } }, 20000);
  if (!r.ok) return { ok: false, reason: `manualimport HTTP ${r.status}` };
  const files = []; let reason = 'no importable file found yet';
  for (const c of await r.json()) {
    if (!c.path) continue;
    if (c.rejections && c.rejections.length) { reason = c.rejections[0].reason || 'rejected'; continue; }
    const f = { path: c.path, quality: c.quality, languages: c.languages || [], releaseGroup: c.releaseGroup || '' };
    if (app === 'radarr') { if (!c.movie) { reason = 'no matching movie'; continue; } f.movieId = c.movie.id; }
    else { if (!c.series) { reason = 'no matching series'; continue; } f.seriesId = c.series.id; f.episodeIds = (c.episodes || []).map((e) => e.id); if (!f.episodeIds.length) { reason = 'no matching episode'; continue; } }
    files.push(f);
  }
  if (!files.length) return { ok: false, reason };
  const cmd = await tfetch(`${base}/command`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ManualImport', importMode: 'auto', files }) }, 20000);
  return { ok: cmd.ok, count: files.length, reason: cmd.ok ? null : `command HTTP ${cmd.status}` };
}

async function importWatchdog() {
  let snap; try { snap = await buildDownloads(); } catch { return; }
  const now = Math.floor(Date.now() / 1000);
  for (const it of snap) {
    const rec = it._recover; if (!rec) continue;                    // only completed-but-not-imported
    let isDir = false; try { isDir = (await fs.promises.stat(rec.folder)).isDirectory(); } catch { /* gone */ }
    if (!isDir) continue;                                            // single-file torrents: leave to *arr
    const st = importState.get(rec.folder) || { lastTry: 0, reason: null };
    if (now - st.lastTry < 120) continue;                           // backoff between attempts
    st.lastTry = now;
    const res = await importViaManual(rec.app, rec.folder);
    st.reason = res.ok ? null : res.reason;                         // cleared on success; retried next sweep
    if (res.ok) triggerJellyfinScan();
    importState.set(rec.folder, st);
    console.log(res.ok ? `watchdog: imported ${res.count} file(s) from "${rec.folder}"` : `watchdog: "${rec.folder}" not importable yet — ${res.reason}`);
  }
}
setInterval(importWatchdog, 30000); // sweep often; per-folder 120s backoff caps real attempts
setTimeout(importWatchdog, 8000);

// Library — titles to clean up, biggest first.
app.get('/api/library', async (req, res) => {
  const a = req.query.app === 'sonarr' ? 'sonarr' : 'radarr';
  try {
    let items;
    if (a === 'radarr') {
      items = (await arrGet('radarr', '/movie')).map((m) => ({ id: m.id, title: m.title, year: m.year, hasFile: !!m.hasFile, sizeBytes: (m.movieFile && m.movieFile.size) || m.sizeOnDisk || 0, tmdbId: m.tmdbId }));
    } else {
      items = (await arrGet('sonarr', '/series')).map((s) => ({ id: s.id, title: s.title, year: s.year, hasFile: ((s.statistics && s.statistics.episodeFileCount) || 0) > 0, sizeBytes: (s.statistics && s.statistics.sizeOnDisk) || 0, tmdbId: s.tmdbId }));
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
  // Torrent hashes via *arr history → match existing qBittorrent torrents.
  let hashes = [];
  try {
    const hist = await arrGet(app, isMovie ? `/history/movie?movieId=${id}` : `/history/series?seriesId=${id}`);
    const recs = Array.isArray(hist) ? hist : (hist.records || []);
    hashes = [...new Set(recs.map((r) => r.downloadId).filter(Boolean).map((h) => h.toLowerCase()))];
  } catch { /* no history */ }
  let torrents = [];
  if (hashes.length) {
    try { const r = await qbit.fetch('/api/v2/torrents/info'); if (r.ok) torrents = (await r.json()).filter((t) => hashes.includes((t.hash || '').toLowerCase())); }
    catch { /* qbit down */ }
  }
  let jf = { itemId: null, libraryEmptyAfter: false };
  try { jf = await jellyfinResolve(isMovie ? 'Movie' : 'Series', item.title, item.tmdbId); } catch { /* jellyfin down */ }
  let seerrId = null;
  try { if (item.tmdbId) seerrId = await seerrMediaId(isMovie ? 'movie' : 'tv', item.tmdbId); } catch { /* seerr down */ }
  return { isMovie, id: Number(id), title, sizeBytes, torrents, jf, seerrId };
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
  return { isMovie: source !== 'sonarr', id: null, title: (t && t.name) || 'this download', sizeBytes: (t && t.size) || 0, torrents: t ? [t] : [], jf: { itemId: null, libraryEmptyAfter: false }, seerrId: null };
}

app.post('/api/delete', async (req, res) => {
  const { app: a, id, hash, source, dryRun = true } = req.body || {};
  const byHash = id == null && !!hash;
  if (!byHash && (!['radarr', 'sonarr'].includes(a) || id == null)) return res.status(400).json({ error: 'body must be {app,id} or {hash,source?}' });
  try {
    const p = byHash ? await buildDeletePlanFromHash(hash, source) : await buildDeletePlan(a, id);
    if (dryRun) return res.json({ dryRun: true, title: p.title, freedBytes: p.sizeBytes, plan: planItems(p) });
    const results = await executeDelete(p);
    triggerJellyfinScan(); // reconciling sweep AFTER files are gone (the explicit item delete already removed it)
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
    res.json({ ok: r.ok });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Dismiss a declined entry from the Downloads view (torrent already gone, just
// remove the tombstone so the row disappears).
app.post('/api/declined/dismiss', (req, res) => {
  const { hash } = req.body || {};
  if (!hash) return res.status(400).json({ error: 'hash is required' });
  declined.delete(hash);
  persistState();
  res.json({ ok: true });
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

// Persist declined + blocked tombstones across restarts so the "Declined" rows
// survive a controller reboot.
function persistState() {
  clearTimeout(persistState._timer);
  persistState._timer = setTimeout(() => {
    try {
      const obj = { declined: {}, blocked: {} };
      for (const [k, v] of declined) obj.declined[k] = v;
      for (const [k, v] of blocked) obj.blocked[k] = v;
      fs.writeFileSync('/config/state.json', JSON.stringify(obj));
    } catch { /* */ }
  }, 500);
}
function loadState() {
  try {
    const obj = JSON.parse(fs.readFileSync('/config/state.json', 'utf8'));
    if (obj.declined) for (const [k, v] of Object.entries(obj.declined)) declined.set(k, v);
    if (obj.blocked) for (const [k, v] of Object.entries(obj.blocked)) blocked.set(k, v);
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
      for (const t of arrTorrents) {
        const hash = (t.hash || '').toLowerCase();
        const arrId = idByHash.get(hash);
        // If we know the *arr item this torrent belongs to and that item is gone → orphan
        if (arrId != null && !knownIds.has(arrId)) toRemove.push(t.hash);
      }

      if (toRemove.length) {
        try {
          const body = new URLSearchParams({ hashes: toRemove.join('|'), deleteFiles: 'true' });
          await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
          console.log(`orphanSweep: removed ${toRemove.length} orphaned torrent(s) from ${app}`);
        } catch (e) { console.log(`orphanSweep: teardown failed — ${String(e.message || e)}`); }
      }
    }
  } finally { orphanBusy = false; }
}
setInterval(orphanSweep, 60000);
setTimeout(orphanSweep, 15000);

// ---- Request gate: surface a request that Radarr/Sonarr REJECTED for disk space ----
// The *arrs enforce the 20 GB cap themselves ("…will exceed available disk space") and
// drop the release at SEARCH time — so nothing ever reaches qBittorrent and the disk gate
// above never sees it; Jellyseerr just shows "request successful" forever. We close that
// gap: for a request stuck in "processing" with no download, we reproduce the *arr's own
// rejections via an interactive search. If the only thing standing between us and a grab is
// space (a release rejected SOLELY for disk space exists), we flag it Declined with the
// real numbers. Non-disk stalls ("no release found yet") are transient — left alone.
const blocked = new Map(); // `app:id:seasons` -> { title, neededBytes, freeBytes, ts, lastCheck }
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
