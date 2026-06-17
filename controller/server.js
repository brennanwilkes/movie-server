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
const CAP_BYTES = 20 * 1024 * 1024 * 1024; // 20 GiB loopback cap

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
async function arrGet(app, p) {
  const { base, key } = arrOf(app);
  const r = await tfetch(`${base}${p}`, { headers: { 'X-Api-Key': key || '' } }, 8000);
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
  const match = items.find((i) => tmdbId && i.ProviderIds && i.ProviderIds.Tmdb === String(tmdbId)) || items[0];
  const q2 = new URLSearchParams({ recursive: 'true', includeItemTypes: type, limit: '0', enableTotalRecordCount: 'true' });
  const total = (await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${q2}`, { headers: h }, 6000)).json()).TotalRecordCount || 0;
  return { itemId: (match && match.Id) || null, libraryEmptyAfter: total <= 1 };
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
    const cap = total > 0 ? Math.min(CAP_BYTES, total) : CAP_BYTES;
    res.json({ path: '/data', used_bytes: used, total_bytes: total, free_bytes: free, cap_bytes: cap, used_pct: cap ? Math.round((used / cap) * 100) : 0 });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
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
// ---- Pipeline correlation: qBittorrent + *arr queue + filesystem hardlinks ----
async function getQbitTorrents() {
  try { const r = await qbit.fetch('/api/v2/torrents/info'); return r.ok ? await r.json() : []; } catch { return []; }
}
async function getQueueMap(app) {
  const m = new Map();
  try { for (const r of ((await arrGet(app, '/queue?pageSize=200')).records || [])) if (r.downloadId) m.set(r.downloadId.toLowerCase(), r); } catch { /* arr down */ }
  return m;
}
const torrentApp = (t) => { const c = (t.category || '').toLowerCase(); return (c === 'radarr' || c === 'sonarr') ? c : null; };
// Ground truth for "imported into the library": the media file is hardlinked, so the
// video file has link count >= 2 (one link under /torrents, one under /media).
async function maxNlink(p) {
  try {
    const st = await fs.promises.stat(p);
    if (st.isFile()) return st.nlink;
    if (st.isDirectory()) { let m = 0; for (const e of await fs.promises.readdir(p)) m = Math.max(m, await maxNlink(path.join(p, e))); return m; }
  } catch { /* missing */ }
  return 0;
}
const isImported = async (p) => (await maxNlink(p)) >= 2;

// Folders the watchdog tried but could NOT import (genuinely stuck → needs a human).
const stuckFolders = new Map(); // folder -> { reason, since }
const recentImport = new Map(); // folder -> ts (debounce repeated import commands)

// One accurate snapshot of the whole download→import→library pipeline. The bar state
// is derived from real signals (qBittorrent + *arr queue + the hardlink on disk) so it
// matches what's actually true — including the "dropped by *arr, never imported" case.
async function buildDownloads() {
  const now = Math.floor(Date.now() / 1000), DAY = 86400;
  const torrents = await getQbitTorrents();
  const queues = { radarr: await getQueueMap('radarr'), sonarr: await getQueueMap('sonarr') };
  const items = [];
  for (const t of torrents) {
    const h = (t.hash || '').toLowerCase();
    const app = torrentApp(t);
    const prog = Math.round((t.progress || 0) * 100);
    const eta = (t.eta && t.eta < 8640000) ? t.eta : null;
    const qrec = app ? queues[app].get(h) : null;
    let state, attention = false, recover = null;
    if (qrec) {                                   // *arr is actively tracking it
      const tds = (qrec.trackedDownloadState || '').toLowerCase();
      if ((qrec.status || '').toLowerCase() === 'paused') state = 'Paused';
      else if (tds.includes('import')) state = 'Importing';
      else if (prog < 100) state = 'Downloading';
      else state = 'Importing';
    } else if (prog < 100) {                       // still downloading
      state = friendlyTorrentState(t);
    } else if (app && await isImported(t.content_path)) {
      state = 'In library';                        // hardlink exists → really in the library
    } else if (app) {                              // complete, *arr not tracking, NOT hardlinked
      if (stuckFolders.has(t.content_path)) { state = 'Needs attention'; attention = true; }
      else { state = 'Importing'; recover = { app, folder: t.content_path }; } // watchdog will rescue
    } else {
      state = 'Done';                              // a non-*arr torrent, just complete
    }
    const finished = state === 'In library' || state === 'Done';
    const show = !finished || ((t.completion_on || 0) > 0 && now - t.completion_on <= DAY);
    if (show) items.push({ title: t.name, progress: state === 'Importing' ? 100 : prog, state, etaSeconds: state === 'Downloading' ? eta : null, sizeBytes: t.size || 0, source: app || 'torrent', attention, _recover: recover });
  }
  const rank = (s) => s === 'Needs attention' ? 0 : (s === 'In library' || s === 'Done') ? 2 : 1;
  items.sort((a, b) => rank(a.state) - rank(b.state));
  return items;
}

app.get('/api/downloads', async (_req, res) => {
  const items = (await buildDownloads()).map(({ _recover, ...r }) => r);
  res.json({ items });
});

// ---- Auto-import watchdog: rescue completed downloads that *arr dropped without
//      importing (the delete→re-download race). Runs the same Manual Import the
//      Radarr/Sonarr UI offers — only on candidates *arr itself accepts (no rejections).
async function importViaManual(app, folder) {
  const { base, key } = arrOf(app);
  const r = await tfetch(`${base}/manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=true`, { headers: { 'X-Api-Key': key } }, 20000);
  if (!r.ok) return { ok: false, reason: `manualimport HTTP ${r.status}` };
  const files = []; let reason = 'no importable file found';
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
    const rec = it._recover; if (!rec) continue;
    let isDir = false; try { isDir = (await fs.promises.stat(rec.folder)).isDirectory(); } catch { /* gone */ }
    if (!isDir) continue;                                  // single-file torrents: leave to *arr
    if ((recentImport.get(rec.folder) || 0) > now - 180) continue; // debounce
    recentImport.set(rec.folder, now);
    const res = await importViaManual(rec.app, rec.folder);
    if (res.ok) { stuckFolders.delete(rec.folder); console.log(`watchdog: imported ${res.count} file(s) from "${rec.folder}"`); }
    else { stuckFolders.set(rec.folder, { reason: res.reason, since: now }); console.log(`watchdog: cannot import "${rec.folder}" — ${res.reason}`); }
  }
}
setInterval(importWatchdog, 60000);
setTimeout(importWatchdog, 10000);

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
    { layer: 1, app: p.isMovie ? 'Radarr' : 'Sonarr', action: p.isMovie ? 'Delete the movie & its file' : 'Delete the series & its files', willRun: true },
    { layer: 2, app: 'qBittorrent', action: n ? `Stop seeding & remove ${n} download${n > 1 ? 's' : ''}` : 'No active download to remove', willRun: n > 0 },
    { layer: 3, app: 'Jellyfin', action: (p.jf.itemId && p.jf.libraryEmptyAfter) ? 'Remove from the library' : 'Clears automatically on scan', willRun: !!(p.jf.itemId && p.jf.libraryEmptyAfter) },
    { layer: 4, app: 'Jellyseerr', action: p.seerrId ? 'Clear the “Available” mark' : 'Not in requests', willRun: !!p.seerrId },
  ];
}

async function executeDelete(p) {
  const out = [];
  const arrName = p.isMovie ? 'Radarr' : 'Sonarr';
  // 1 — Radarr/Sonarr (file + Jellyfin auto-scan notification fires here).
  try {
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
  // 3 — Jellyfin (only when the library would otherwise go fully empty).
  if (p.jf.itemId && p.jf.libraryEmptyAfter) {
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

app.post('/api/delete', async (req, res) => {
  const { app: a, id, dryRun = true } = req.body || {};
  if (!['radarr', 'sonarr'].includes(a) || id == null) return res.status(400).json({ error: 'body must be {app:"radarr"|"sonarr", id, dryRun?}' });
  try {
    const p = await buildDeletePlan(a, id);
    if (dryRun) return res.json({ dryRun: true, title: p.title, freedBytes: p.sizeBytes, plan: planItems(p) });
    res.json({ dryRun: false, title: p.title, freedBytes: p.sizeBytes, results: await executeDelete(p) });
  } catch (e) {
    const msg = String(e.message || e);
    res.status(/HTTP 404/.test(msg) ? 404 : 500).json({ error: msg });
  }
});

app.listen(PORT, () => console.log(`controller listening on :${PORT} (NUC_IP=${NUC_IP}, keys ${cfg.RADARR_KEY ? 'loaded' : 'NOT provisioned'})`));
