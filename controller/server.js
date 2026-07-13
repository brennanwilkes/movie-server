'use strict';
// Movie-server controller — serves the mobile dashboard (web/) and a same-origin
// API that aggregates the stack and runs the one-click "delete everywhere" recipe.
// Upstreams are reached by container name on the compose network; per-service auth
// is injected here from /config/keys.env so keys never reach the browser.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');
const metrics = require('./metrics');

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

const oscarWinners = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'oscar-winners.json'), 'utf8')); } catch { return {}; } })();
const intlLanguages = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'intl-languages.json'), 'utf8')); } catch { return {}; } })();

const PORT = Number(cfg.CONTROLLER_PORT || 8088);
const NUC_IP = cfg.NUC_IP || '192.168.1.74';
// The $DATA loopback image IS the hard cap, so its live filesystem size (from statfs
// below) is the real number — no hardcoded constant to drift out of sync on resize.

// Internal (container-network) bases + external ports for browser deep-links.
const HOST = {
  jellyfin: `http://${NUC_IP}:8096`,   // Jellyfin runs on host networking (for PS4 DLNA), so reach it
                                        // via the NUC's IP, not the container DNS name 'jellyfin'.
  // QBIT_HOST is 'qbittorrent' normally, or 'gluetun' when qBittorrent is routed
  // through the VPN overlay (make vpn-up) — where it shares gluetun's namespace and
  // has no DNS name of its own. Browser deep-links still use NUC_IP:8080 (below).
  qbittorrent: `http://${cfg.QBIT_HOST || 'qbittorrent'}:8080`,
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
// Like tfetch but signal stays active during body read (covers headers + body).
async function tfetchJson(url, opts = {}, ms = 3000) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  return await r.json();
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

// VPN status — read gluetun's control server (http://gluetun:8000). Three states the
// UI renders distinctly (see web/app.js renderVPN):
//   • enabled + connected → PROTECTED (qBittorrent exits via the VPN; shows exit IP/geo/port)
//   • enabled + !connected → TUNNEL DOWN (gluetun crashed/reconnecting; killswitch means
//                             qBittorrent is BLOCKED, not leaking — downloads paused, safe)
//   • !enabled            → VPN OFF (running direct via `make vpn-off` → real IP exposed!)
// 'enabled' = qBittorrent is wired through gluetun (QBIT_HOST=gluetun), the always-on default.
const GLUETUN = 'http://gluetun:8000';
app.get('/api/vpn', async (_req, res) => {
  const enabled = (cfg.QBIT_HOST === 'gluetun');
  const out = { enabled, connected: false, status: null, public_ip: null, country: null, city: null, region: null, org: null, port: null };
  if (enabled) {
    // Newer gluetun routes; all made public (auth=none) via scripts/gluetun/auth-config.toml.
    const [st, ip, pf] = await Promise.all([
      tfetchJson(`${GLUETUN}/v1/vpn/status`, {}, 4000).catch(() => null),
      tfetchJson(`${GLUETUN}/v1/publicip/ip`, {}, 4000).catch(() => null),
      tfetchJson(`${GLUETUN}/v1/portforward`, {}, 4000).catch(() => null),
    ]);
    if (st) out.status = st.status || null;
    if (ip) { out.public_ip = ip.public_ip || null; out.country = ip.country || null; out.city = ip.city || null; out.region = ip.region || null; out.org = ip.organization || null; }
    if (pf) out.port = pf.port || null;
    // Connected = gluetun answered with an exit IP and (if it reports status) it's running.
    out.connected = !!(out.public_ip && (out.status ? out.status === 'running' : true));
  }
  res.json(out);
});

// Tailscale mesh status — the tailscale-status sidecar writes `tailscale status --json` here every
// ~20s (see docker-compose.yml). We just read + summarise the file; no daemon access from here.
// States the UI renders (see web/app.js withTailscale):
//   • up + connected → on the family mesh (BackendState=Running); shows this node's 100.x IP
//   • up + !connected → daemon is running but not authed/connected yet (starting / key expired)
//   • !up            → sidecar file missing or stale (>90s) → treat the tile as offline
const TS_STATUS_FILE = '/config/tailscale-status.json';
app.get('/api/tailscale', async (_req, res) => {
  const out = { up: false, connected: false, ip: null, peers: null, peers_online: null };
  try {
    const st = await fs.promises.stat(TS_STATUS_FILE);
    // Stale file = the writer died; don't report a frozen "connected" state.
    if (Date.now() - st.mtimeMs > 90000) { res.json(out); return; }
    const j = JSON.parse(await fs.promises.readFile(TS_STATUS_FILE, 'utf8'));
    if (j && j.BackendState) {
      out.up = true;
      out.connected = j.BackendState === 'Running';
      const ips = (j.Self && j.Self.TailscaleIPs) || [];
      out.ip = ips.find((a) => a.includes('.')) || ips[0] || null;   // prefer the IPv4 100.x
      const peers = j.Peer ? Object.values(j.Peer) : [];
      out.peers = peers.length;
      out.peers_online = peers.filter((p) => p && p.Online).length;
    }
  } catch { /* missing/unparseable → down */ }
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
// Reports each indexer's enable/disable state, recent failures, and an approximate
// degradation percentage weighted by query volume, so a high-value indexer down (TPB,
// Knaben) shows more degradation than a niche one (YTS). Degradation detected via
// Prowlarr's recent query history (failed queries in the last 10 min).
app.get('/api/indexers', async (_req, res) => {
  try { res.json(await getIndexerSnapshot()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
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
  if (s === 'error' || s === 'missingFiles') return 'Error';
  // Completion is checked BEFORE paused/stopped: our share limits (ratio 2.0 / 7 days, act=stop)
  // auto-STOP a torrent the moment it's done seeding, landing it in stoppedUP/pausedUP. That's a
  // finished download, not a user pause — treat it as complete so it doesn't masquerade as "Paused"
  // at 100%. A genuine user pause is on an INCOMPLETE torrent, handled below.
  if ((t.progress || 0) >= 1) return 'Seeding';
  if (s.startsWith('paused') || s.startsWith('stopped')) return 'Paused';   // qBittorrent v5 renamed paused* → stopped*
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
const forceGrabImport = new Map(); // infoHash -> { app, id, seriesTitle, folder: null } — post-force-grab import guarantee
const completedForceGrabs = new Map(); // infoHash -> { id } — force-grabs the watchdog has fully imported; lets buildDownloads render them Ready (their ManualImport carries no downloadId, so *arr history isn't keyed to the hash)
const knownInLibrary = new Set(); // torrent hash -> tracked for event-driven scan
const _knownDownloads = new Map(); // hash -> { title, app, prog, imported, ts } — download transition tracking for metrics
const _emittedEvents = new Set();  // `${event}:${hash}` dedup for metrics events

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

// Is this queue item for an episode/movie whose release/air date hasn't arrived yet?
// When true, a stuck/failed import isn't a real error — it's a premature grab of a
// future release. The UI shows it as "Unreleased" (grey, queued-like) instead of red.
function isFutureRelease(app, qrec) {
  if (!qrec) return false;
  const now = Date.now();
  if (app === 'sonarr') {
    const airDate = qrec.episode && (qrec.episode.airDateUtc || qrec.episode.airDate);
    if (airDate) return new Date(airDate).getTime() > now;
  }
  if (app === 'radarr') {
    const movie = qrec.movie;
    if (movie) {
      const dates = [movie.inCinemas, movie.physicalRelease, movie.digitalRelease].filter(Boolean);
      for (const d of dates) {
        if (new Date(d).getTime() > now + 86400000) return true;
      }
    }
  }
  return false;
}

async function buildDownloads() {
  const now = Math.floor(Date.now() / 1000), DAY = 86400;
  _parseBudget = 12;                          // cap cold /parse round-trips this pass (backlog warms over the next few)
  const torrents = await getQbitTorrents();
  const queues = { radarr: await getQueueMap('radarr'), sonarr: await getQueueMap('sonarr') };
  let indexerSnapshot = { degradedNames: [] };
  try {
    indexerSnapshot = await cachedFetch('indexers:snapshot', 60000, getIndexerSnapshot, { degradedNames: [] });
  } catch { /* best-effort */ }
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
    let hi = app && hist[app] && hist[app].get(h);
    // Force-grabs import via a downloadId-less ManualImport, so *arr history isn't keyed to this
    // hash and `hi` stays null. Once the watchdog confirms every episode landed it records the
    // series in completedForceGrabs — synthesize the history entry so the row resolves to Ready
    // (and never falls into the recover/"Importing"-forever path below).
    if (!hi && app === 'sonarr' && completedForceGrabs.has(h)) hi = { id: completedForceGrabs.get(h).id, imported: true, size: 0 };
    // Has *arr actually imported THIS torrent? `hi.imported` is per-downloadId (an import event
    // referenced this exact hash) and is authoritative for both apps. The hasFile fallback (for a
    // cold history cache after restart) is RADARR-ONLY: a movie's hasFile is 1:1 with its torrent,
    // but a Sonarr series' hasFile is true if it holds ANY episode — so using it here flagged every
    // still-downloading episode of a partially-present series as "imported → Ready", hiding the
    // live download from the UI. For Sonarr we trust the per-hash import event alone.
    const imported = !!(hi && (hi.imported || (app === 'radarr' && hi.id != null && hasFile[app] && hasFile[app].get(hi.id) === true)));
    const _arrId = (qrec && (qrec.movieId || qrec.seriesId)) ?? (hi && hi.id);
    let state, attention = false, recover = null, attnNote = null;
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
      const owned = !hi ? await arrOwns(app, t.name, hasFile[app], nameIds[app]) : null;
      if (owned) state = await resolveLibraryState(app, { id: owned.id, imported: true, size: 0 }, t);
      else if (app && isFutureRelease(app, qrec)) { state = 'Unreleased'; }
      else { state = 'Needs attention'; attention = true; }
    } else if (qrec) {                              // *arr is actively tracking it
      // *arr's queue exposes BOTH its own view (trackedDownloadState/Status) and the underlying
      // torrent (t.state). Surface real trouble from EITHER source — a stalled or errored
      // download that *arr still lists must never masquerade as "Downloading".
      const tds = (qrec.trackedDownloadState || '').toLowerCase();      // downloading|importPending|importing|imported|failedPending|failed
      const tdStatus = (qrec.trackedDownloadStatus || '').toLowerCase(); // ok|warning|error
      const ts = friendlyTorrentState(t);                               // Paused|Error|Seeding|Starting|Queued|Stalled|Downloading
      if (prog < 100 && ((qrec.status || '').toLowerCase() === 'paused' || ts === 'Paused')) state = 'Paused';
      else if (tds === 'failed' || tds === 'failedpending' || tdStatus === 'error') { if (isFutureRelease(app, qrec)) { state = 'Unreleased'; } else { state = 'Needs attention'; attention = true; } } // download/import failed in *arr
      else if (tds.includes('import')) {
        // *arr parked the import (e.g. importBlocked: "matched by ID — manual import required",
        // or a release for an unaired/nonexistent episode it can't match). Hand it to the recovery
        // sweep so it runs a Manual Import automatically. But DON'T let a genuinely-blocked import
        // masquerade as active "Importing" forever: a plain importPending resolves in seconds, so
        // only the first IMPORT_GRACE after completion is really "importing" — past that, a
        // still-warning item is stuck and gets surfaced for attention (amber, honest) rather than
        // looking like progress. tdStatus 'ok' importPending stays "Importing" regardless (*arr
        // just hasn't gotten to it yet).
        if (tdStatus === 'warning' && t.content_path) recover = { app, folder: t.content_path, id: app === 'radarr' ? qrec.movieId : qrec.seriesId, hash: h };
        const IMPORT_GRACE = 15 * 60;   // seconds a warning import may sit before we call it blocked
        const stuck = tdStatus === 'warning' && (t.completion_on || 0) > 0 && (now - t.completion_on) > IMPORT_GRACE;
        if (stuck) {
          if (isFutureRelease(app, qrec)) { state = 'Unreleased'; recover = null; }
          else { state = 'Needs attention'; attention = true; }
        }
        else state = 'Importing';
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
        // Authoritative check first: is the library already holding this release's content? (cold
        // history cache after restart / aged-out window would otherwise flag imported titles.)
        const owned = await arrOwns(app, t.name, hasFile[app], nameIds[app]);
        if (owned) state = await resolveLibraryState(app, { id: owned.id, imported: true, size: 0 }, t);
        else {
          // Fresh completions (≤1 day old) may still be picked up by the import watchdog →
          // keep them as "Importing". Older completions with no queue entry and no confirmed
          // import are almost certainly fine — the history window aged out the import event.
          if (forceGrabImport.has(h) || (t.category || '').toLowerCase() === 'sonarr-force') {
            // Force-grabs are owned EXCLUSIVELY by the watchdog pre-pass (importViaGrab, which knows
            // the user-chosen series). NEVER emit a recover for a sonarr-force torrent: the generic
            // recover runs importViaManual with no expectedId, and on an unparseable release its
            // "Unknown Series" branch DELETES the folder with deleteFiles:true — this is what wiped
            // Cosmos 1980. Gating on the CATEGORY (not just the hash map) keeps this safe even if the
            // bookkeeping entry is briefly missing (e.g. right after a restart, before recover runs).
            state = 'Importing';
          } else if ((t.completion_on || 0) > 0 && now - t.completion_on > DAY) {
            state = 'Likely imported';
          } else {
            recover = { app, folder: t.content_path, id: hi && hi.id, hash: h };
            const reason = (importState.get(t.content_path) || {}).reason;
            if (reason) { state = 'Needs attention'; attention = true; }
            else state = 'Importing';             // the watchdog will import it shortly
          }
        }
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
      if (attnNote) item.note = attnNote;
      if (finished && app === 'radarr' && _arrId != null) {
        const key = `radarr:${_arrId}`, comp = t.completion_on || 0, prev = completedByMovie.get(key);
        if (prev && comp <= prev.completion) continue;                 // older/equal duplicate of a movie we already show — drop it
        if (prev) { const i = items.indexOf(prev.item); if (i >= 0) items.splice(i, 1); }  // newer copy wins — remove the stale row
        completedByMovie.set(key, { completion: comp, item });
      }
      if (app && _arrId != null) shownIds[app].add(_arrId);   // this title has a live download → don't also list it as missing
      items.push(item);
    }
  }
  // Surface missing items: monitored, no file, no queue, no torrent — as warnings.
  // appIdsInQueue, norm, catTorNames, and beingFetched are defined at this scope so the
  // unreleased-episode surfacing below can reuse them without recomputing.
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
    return catTorNames[app].some((n) => {
      if ((n === tn || n.startsWith(tn + ' ')) && (!yr || n.includes(yr))) return true;
      // Match title appearing anywhere as a word sequence (force-grabbed releases often
      // prepend the uploader name or add suffixes before the title, e.g. "Carl Sagans Cosmos 1980...")
      const idx = n.indexOf(tn);
      if (idx >= 0) {
        const before = idx === 0 || n[idx - 1] === ' ';
        const after = idx + tn.length >= n.length || n[idx + tn.length] === ' ';
        if (before && after && (!yr || n.includes(yr))) return true;
      }
      return false;
    });
  };
  try {
    for (const app of ['radarr', 'sonarr']) {
      let list = [];
      try { list = await arrGet(app, app === 'radarr' ? '/movie' : '/series', 8000); } catch { continue; }
      for (const it of list) {
        const id = it.id;
        const hasF = app === 'radarr' ? !!it.hasFile : !!(it.statistics && it.statistics.episodeCount > 0 && it.statistics.episodeFileCount >= it.statistics.episodeCount);
        if (hasF || it.monitored === false) { noteResolved(app, id); continue; }
        if (appIdsInQueue[app].has(id) || shownIds[app].has(id) || beingFetched(app, it)) { noteResolved(app, id); continue; }   // in queue / linked / freshly-grabbed torrent → not missing
        // Future release: movie hasn't been released yet → show Unreleased, don't mark missing.
        if (app === 'radarr') {
          const dates = [it.inCinemas, it.physicalRelease, it.digitalRelease].filter(Boolean);
          if (dates.length && dates.some(d => new Date(d).getTime() > Date.now() + 86400000)) {
            items.push({ title: it.title + (it.year ? ` (${it.year})` : ''), progress: 0, state: 'Unreleased', etaSeconds: null, sizeBytes: 0, source: app, attention: false, hash: `missing:${app}:${id}`, _id: id, recoveryNext: 0, recoveryFails: 0, recoveryBlocked: false });
            continue;
          }
        }
        // A freshly-requested item briefly has no file/queue while *arr's own search resolves. Show
        // "Searching…" (not the alarming "Not found") until NOTFOUND_GRACE — this is what stops the
        // "Not found → found seconds later" flip-flop. Only after the grace do we call it "Not found".
        const firstMissing = noteMissing(app, id);
        const now2 = Date.now();
        const st = searchState.get(`${app}:${id}`) || {};
        const manualRetryAt = st.manualRetryAt || 0;
        const manualRetryRecent = manualRetryAt && now2 - manualRetryAt < 10 * 60 * 1000;
        const outcomeKind = st.lastOutcomeKind || '';
        const outcomeVisible = ['found', 'partial', 'pending'].includes(outcomeKind);
        const manualRetryVisible = manualRetryRecent && !['empty', 'error'].includes(outcomeKind);
        const searching = manualRetryVisible || outcomeVisible || (!outcomeKind && now2 - firstMissing < NOTFOUND_GRACE_MS);
        const title = it.title + (it.year ? ` (${it.year})` : '');
        // Mirror arrSweep's own scheduling logic so the UI can say when the NEXT recovery search
        // will actually fire, instead of leaving "Not found" with no indication of what happens next.
        const searchHint = [];
        const dec = st.lastOutcomeDecision;
        if (st.lastSearchGap && st.lastSearchGap.best) {
          // Most actionable: a healthy release exists but structured search can't reach it.
          const g = st.lastSearchGap;
          const b = g.best;
          const shortTitle = String(b.title || '').replace(/ *\[.*?\]/g, '').replace(/ *\(.*?\)/g, '').trim().slice(0, 36);
          const why = g.reasonClass === 'no-season-marker' ? 'no S01 marker' : 'not a candidate';
          searchHint.push(clampHint(`"${shortTitle}" (${b.seeders} seeders) — ${why}`));
        } else if (dec && dec.rejectedCount && !dec.acceptedCount) {
          const reasons = String(dec.reasons || '').split(';').map(shortReason)
            .filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 2).join(', ');
          searchHint.push(`all ${dec.rejectedCount} rejected${reasons ? `: ${reasons}` : ''}`);
        } else if (st.lastOutcomeSummary) {
          searchHint.push(clampHint(st.lastOutcomeSummary));
        }
        if (st.lastOutcomeDetails && Array.isArray(st.lastOutcomeDetails.indexerErrors) && st.lastOutcomeDetails.indexerErrors.length) {
          const errs = st.lastOutcomeDetails.indexerErrors.slice(0, 2).map((e) => e.indexer).join(', ');
          if (errs) searchHint.push(`indexer error: ${errs}`);
        }
        if (!st.lastOutcomeSummary || outcomeKind === 'pending') {
          if (manualRetryRecent && !st.lastOutcomeSummary) searchHint.push('manual retry in progress');
          if (st.lastReason === 'blocked' && st.lastError) searchHint.push(`last search blocked: ${st.lastError}`);
          else if (st.lastReason === 'blocked') searchHint.push('last search blocked');
          else if (st.lastReason === 'grace') searchHint.push('waiting on the original search to settle');
          else if (st.lastReason === 'cooldown') searchHint.push('waiting for cooldown');
          else if (st.lastReason === 'manual_retry' && !st.lastOutcomeSummary) searchHint.push('manual retry in progress');
          else if (st.lastReason === 'no_searchable_episodes') searchHint.push('no aired episodes were searchable yet');
          else if (st.lastReason === 'trigger_failed' && st.lastError) searchHint.push(`search trigger failed: ${st.lastError}`);
        }
        if (!searchHint.length && indexerSnapshot.degradedNames && indexerSnapshot.degradedNames.length) {
          searchHint.push(`sources degraded: ${indexerSnapshot.degradedNames.slice(0, 2).join(', ')}`);
        }
        const recoveryBlocked = !!(st.blockedUntil && st.blockedUntil > now2);
        let recoveryNext;
        if (manualRetryRecent) recoveryNext = now2;
        else if (recoveryBlocked) recoveryNext = st.blockedUntil;
        else if (now2 - firstMissing < RECOVERY_GRACE_MS) recoveryNext = firstMissing + RECOVERY_GRACE_MS;
        else if (st.ts) recoveryNext = st.ts + SEARCH_COOLDOWN_MS;
        else recoveryNext = now2; // sweep hasn't tried yet — due on its next 5-min tick
        // attention (→ red) is reserved for items automation has actually given up on
        // (negative-cached). A "Not found" that's still going to retry on its own is orange, not
        // red — red should mean "a human needs to look at this," not "still working on it."
        items.push({ title, progress: 0, state: searching ? 'Searching…' : 'Not found',
          etaSeconds: null, sizeBytes: 0, source: app, attention: recoveryBlocked,
          hash: `missing:${app}:${id}`, _id: id,
          recoveryNext, recoveryFails: st.fails || 0, recoveryBlocked,
          searchHint: searchHint.join(' · '), searchReason: outcomeKind || st.lastReason || null });
      }
    }
  } catch { /* missing scan best-effort */ }

  // Surface unreleased Sonarr episodes: monitored, no file, future air date, no torrent/queue.
  // Unlike the missing-items scan above (which checks series-level episodeFileCount), this checks
  // episode-level air dates so a series with past-season files still surfaces future episodes.
  // Uses Sonarr's /calendar endpoint (single call, upcoming-only) instead of per-series episode
  // fetches, cached for 5 min since air dates are slow-moving.
  try {
    const unreleased = await cachedFetch('sonarr:unreleased', 300000, async () => {
      const now = new Date();
      const start = now.toISOString().slice(0, 10);
      const end90 = new Date(now.getTime() + 90 * 86400000).toISOString().slice(0, 10);
      let eps;
      try { eps = await arrGet('sonarr', `/calendar?start=${start}&end=${end90}&includeSeries=true`, 8000); } catch { return []; }
      if (!Array.isArray(eps)) return [];
      // Build a series-id→title map from the calendar entries (no separate series list needed)
      const sidTitle = {};
      for (const e of eps) { if (e.series) sidTitle[e.seriesId] = e.series.title; }
      const seen = new Set(); // one row per series
      const out = [];
      for (const e of eps) {
        if (e.hasFile || !e.monitored) continue;
        if (!e.airDateUtc) continue;
        if (new Date(e.airDateUtc).getTime() <= now.getTime()) continue;
        const title = sidTitle[e.seriesId] || '';
        if (!title || seen.has(e.seriesId)) continue;
        seen.add(e.seriesId);
        out.push({ seriesId: e.seriesId, episodeId: e.id, title, seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber, airDateUtc: e.airDateUtc });
      }
      return out;
    }, []);
    for (const u of unreleased) {
      if (appIdsInQueue.sonarr.has(u.seriesId) || shownIds.sonarr.has(u.seriesId)) continue;

      const label = `${u.title} S${String(u.seasonNumber).padStart(2, '0')}E${String(u.episodeNumber).padStart(2, '0')}`;
      items.push({ title: label, progress: 0, state: 'Unreleased', etaSeconds: null, sizeBytes: 0, source: 'sonarr', attention: false, hash: `unreleased:sonarr:${u.seriesId}:${u.episodeId}` });
    }
  } catch (eu) { console.log('unreleased scan:', eu.message || eu); }

  // Sort tiers: any problem to the very top, then anything actively transferring (partial
  // progress, whatever its label), then the rest in progress, then recently-finished (Ready/Done
  // only ever survive the 24h `show` window above), and finally the long Queued backlog at the
  // bottom. Within a tier, the closer to done floats higher.
  const rank = (it) => {
    const s = it.state, p = it.progress || 0;
    if (s === 'Needs attention' || s === 'Error' || s === 'Not found') return 0;    // errors of any kind first
    if (p > 0 && p < 100) return 1;                            // mid-transfer → near the top regardless of status
    if (s === 'Queued' || s === 'Unreleased') return 4;        // backlog or waiting to air → bottom
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
// Smoothed max individual ETA from qBit — exponential moving average to dampen the
// short-window noise in per-torrent ETAs (a 2-seed torrent might momentarily blip from
// 30 min to 4h after a tracker timeout, then recover). 0.25 weight = 4-cycle (20s) half-life.
const _MAX_EMA_ALPHA = 0.25;
let _smoothedMaxDlEta = 0;
// The same for the per-poll speed — qBit's dl_info_speed is instantaneous and noisy.
let _smoothedSpeedEta = 0;
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

    // Download transition events (grab / dl_done / import_ok)
    const nowSec = Date.now() / 1000;
    for (const it of raw) {
      if (!it.hash || !it.source) continue;
      const h = it.hash;
      const prev = _knownDownloads.get(h);
      const ek = (ev) => `${ev}:${h}`;
      if (prev) {
        if (it.progress >= 100 && (prev.prog == null || prev.prog < 100) && !_emittedEvents.has(ek('dl_done'))) {
          _emittedEvents.add(ek('dl_done'));
          metrics.emitEvent('dl_done', { ti: it.title, ap: it.source, dur: Math.round(nowSec - prev.ts) });
        }
        if ((it.state === 'Ready' || it.state === 'Done') && prev.state !== 'Ready' && prev.state !== 'Done' && !_emittedEvents.has(ek('import_ok'))) {
          _emittedEvents.add(ek('import_ok'));
          metrics.emitEvent('import_ok', { ti: it.title, ap: it.source });
        }
      } else if (it.state === 'Downloading' && !_emittedEvents.has(ek('grab'))) {
        _emittedEvents.add(ek('grab'));
        metrics.emitEvent('grab', { ti: it.title, ap: it.source, sB: it.sizeBytes || 0 });
      }
      _knownDownloads.set(h, { prog: it.progress, state: it.state, ts: prev ? prev.ts : nowSec, title: it.title, app: it.source });
    }
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

  // Per-torrent ETAs from qBittorrent for actively downloading items.
  // These run in PARALLEL, so wall-clock time to finish the current batch is the MAX
  // of their individual ETAs — not total_remaining / total_speed (which assumes a
  // serial pipeline). Use the max as a floor so the summary never says "18 min left"
  // when a 1-seed torrent still has 4h to go.
  const dlEtas = inProg
    .filter((i) => i.state === 'Downloading' && i.etaSeconds != null && i.etaSeconds > 0)
    .map((i) => i.etaSeconds);
  // qBit's per-torrent ETA uses a short averaging window and can spike momentarily after
  // a tracker blip. EMA-smooth it so real trends still track but noise doesn't jitter the
  // summary. Let drops through instantly (torrent finished) but smooth upward spikes.
  const rawMaxDlEta = dlEtas.length > 0 ? Math.max(...dlEtas) : 0;
  if (rawMaxDlEta <= 0) _smoothedMaxDlEta = 0;
  else if (_smoothedMaxDlEta <= 0) _smoothedMaxDlEta = rawMaxDlEta;
  else if (rawMaxDlEta >= _smoothedMaxDlEta) _smoothedMaxDlEta = Math.round(rawMaxDlEta * _MAX_EMA_ALPHA + _smoothedMaxDlEta * (1 - _MAX_EMA_ALPHA));
  else _smoothedMaxDlEta = rawMaxDlEta; // drops pass through immediately (a torrent finished)
  const maxDlEta = _smoothedMaxDlEta;

  // Queue items can't fully overlap with the current batch — they wait for a free slot
  // and may have different (likely worse) peer characteristics. Add their estimated
  // serial time on top rather than absorbing them into the maxDlEta window, since
  // throughput after fast torrents finish and slow queued ones replace them is uncertain.
  const queuedRemaining = queued.reduce((a, i) => a + sizeOf(i) * (1 - Math.min(100, i.progress || 0) / 100), 0);
  const queueEta = speedBytes > 0 ? queuedRemaining / speedBytes : 0;
  const fastEta = speedBytes > 0 ? remainingBytes / speedBytes : 0;
  const slowEta = maxDlEta + queueEta;

  // Blend between them based on the gap. When the slowest torrent's ETA ≈ pipeline
  // (gap ≤ 1.5×), speeds are uniform and the pipeline is right (common — most torrents
  // in the same quality tier have similar peer counts). When the slowest is ≥ 5× the
  // pipeline, it's a clear parallel bottleneck and slowEta dominates. In between,
  // interpolate — the truth is somewhere on the continuum.
  let etaSeconds = null;
  if (speedBytes > 0 && remainingBytes > 0) {
    const gap = slowEta / Math.max(1, fastEta);
    if (gap <= 1.5) {
      etaSeconds = Math.round(fastEta);
    } else if (gap >= 5) {
      etaSeconds = Math.round(slowEta);
    } else {
      const t = (gap - 1.5) / (5 - 1.5);
      etaSeconds = Math.round(fastEta * (1 - t) + slowEta * t);
    }
  }

  return {
    counts: { completed: done.length, inProgress: inProg.length, queued: queued.length, attention: attention.length, blocked: blocked.length },
    bytes,
    remainingBytes,
    speedBytes,
    liveSpeedBytes: liveSpeed,
    histSpeedBytes: histSpeed ? Math.round(histSpeed) : null,
    etaSeconds,
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

// ── Elo Tuner: Top 100 playlist reading + reordering ───────────────────────────────────────
function corsOk(res) { res.header('Access-Control-Allow-Origin', '*'); res.header('Access-Control-Allow-Headers', 'Content-Type'); return res; }
app.get('/api/elo/top100', async (_req, res) => {
  corsOk(res);
  try {
    const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' };
    const uid = await jellyfinUserId();
    const playlists = ((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${new URLSearchParams({ IncludeItemTypes: 'Playlist', Recursive: 'true', Limit: '20' })}`, { headers: h }, 15000)).json()).Items) || [];
    const playlist = playlists.find(p => p.Name === 'Top 100');
    if (!playlist) return res.status(404).json({ error: 'Top 100 playlist not found' });
    const items = ((await (await tfetch(`${HOST.jellyfin}/Playlists/${playlist.Id}/Items?${new URLSearchParams({ UserId: uid, Fields: 'ProductionYear,Genres,CommunityRating,RunTimeTicks,ProviderIds,People,Studios,Path,ImageTags,Overview' })}`, { headers: h }, 60000)).json()).Items) || [];
    res.json({ playlistId: playlist.Id, items: items.map((it, i) => ({ ...it, _eloRank: i + 1, _playlistItemId: it.PlaylistItemId })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/elo/top100/reorder', async (req, res) => {
  corsOk(res);
  try {
    const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' };
    const { playlistId, itemIds } = req.body; // itemIds = array of Jellyfin itemIds in new order
    if (!playlistId || !Array.isArray(itemIds)) return res.status(400).json({ error: 'playlistId and itemIds required' });
    // NOTE: Playlists/{id}/Items/{itemId}/Move/{newIndex} looks right per the Jellyfin API but
    // is broken for API-key auth — MoveItem resolves the calling user from the request's auth
    // context to look up the playlist, and an API key isn't bound to a user session, so Jellyfin
    // gets an empty user GUID and 400s on every single call ("Guid can't be empty (Parameter
    // 'id')" in PlaylistManager.GetPlaylists). It was failing silently — reorder always reported
    // ok:true while every per-item move errored. Add/remove both accept an explicit userId, so
    // reorder instead by clearing the playlist and re-adding items in the desired order.
    const uid = await jellyfinUserId();
    const current = ((await (await tfetch(`${HOST.jellyfin}/Playlists/${playlistId}/Items?${new URLSearchParams({ UserId: uid })}`, { headers: h }, 10000)).json()).Items) || [];
    const currentIds = new Set(current.map(it => it.Id));
    const orderedIds = itemIds.filter(id => {
      if (!currentIds.has(id)) { console.log(`elo/reorder: item ${id} not in current playlist`); return false; }
      return true;
    });
    if (!orderedIds.length) return res.json({ ok: true });

    const entryIds = current.map(it => it.PlaylistItemId);
    const delR = await tfetch(`${HOST.jellyfin}/Playlists/${playlistId}/Items?${new URLSearchParams({ entryIds: entryIds.join(',') })}`, { method: 'DELETE', headers: h }, 10000);
    if (!delR.ok) throw new Error(`clearing playlist failed: HTTP ${delR.status}`);

    const addR = await tfetch(`${HOST.jellyfin}/Playlists/${playlistId}/Items?${new URLSearchParams({ ids: orderedIds.join(','), userId: uid })}`, { method: 'POST', headers: h }, 15000);
    if (!addR.ok) throw new Error(`re-adding items failed: HTTP ${addR.status}`);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/elo/config', async (_req, res) => {
  corsOk(res);
  try {
    const uid = await jellyfinUserId();
    res.json({ nucIp: NUC_IP, userId: uid, jellyfinBase: HOST.jellyfin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── HSS custom sections: rotating collection SHELVES as home rows ───────────────────────────
// Three rows registered with the Home Screen Sections plugin, each titled with the ACTUAL
// collection it's showing ("Mob Classics", "90s Movies", …). The registration's displayText
// is the row title and additionalData carries the collection id back to our endpoint, so the
// controller re-registers every 10 min with the current hour's picks — titles and contents
// rotate together. Contents come back as native Jellyfin dtos (already shuffled by the
// collections sweep). NOTE: the plugin POSTs its payload to resultsEndpoint — a GET-only
// route returns Express HTML that breaks its JSON parser, hence app.all.
const SHELF_IDS = ['ShelfA', 'ShelfB', 'ShelfC', 'ShelfD', 'ShelfE', 'ShelfF', 'ShelfG', 'ShelfH', 'ShelfI', 'ShelfJ', 'ShelfK', 'ShelfL', 'ShelfM', 'ShelfN', 'ShelfO', 'ShelfP', 'ShelfQ', 'ShelfR', 'ShelfS', 'ShelfT'];   // 20 rotating shelf rows (grow: add ids here + rows in jellyfin.sh)
async function shelfCatalog() {
  const uid = await jellyfinUserId();
  const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' };
  const bq = new URLSearchParams({ IncludeItemTypes: 'BoxSet', Recursive: 'true', Limit: '100' });
  const sets = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${bq}`, { headers: h }, 25000)).Items) || [];
  return sets.filter((s) => !/Collection$/.test(s.Name));   // ours, not TMDb franchise sets
}
function shelfPicks(autos) {   // fresh set every registration (10 min), spread across the catalog
  if (!autos.length) return [];
  const n = autos.length, base = Math.floor(Date.now() / 600000);
  const step = Math.max(1, Math.floor(n / SHELF_IDS.length));
  let picks = SHELF_IDS.map((_, i) => autos[((base * 7) + (i * step)) % n]);
  picks = [...new Map(picks.map((p) => [p.Id, p])).values()];
  for (let i = picks.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [picks[i], picks[j]] = [picks[j], picks[i]]; }
  return picks;
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

app.all('/api/hss/shelf', async (req, res) => {
  try {
    const uid = (req.body && (req.body.UserId || req.body.userId)) || req.query.userId || await jellyfinUserId();
    const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' };
    let setId = (req.body && (req.body.AdditionalData || req.body.additionalData)) || req.query.setId || '';
    if (!setId) {
      const p = shelfPicks(await shelfCatalog())[0];
      if (!p) return res.json({ Items: [], TotalRecordCount: 0 });
      setId = p.Id;
    }
    const cq = new URLSearchParams({ ParentId: setId, Limit: '24' });
    const items = ((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${cq}`, { headers: h }, 20000)).json()).Items) || [];
    // Look up collection name to decide sort: Oscar = newest-first, everything else = random
    try {
      const meta = await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items/${setId}`, { headers: h }, 5000)).json();
      if (meta.Name && /^Oscar:/i.test(meta.Name)) {
        items.sort((a, b) => (b.ProductionYear || 0) - (a.ProductionYear || 0));
      } else {
        shuffle(items);
      }
    } catch (_) { shuffle(items); }
    res.json({ Items: items, TotalRecordCount: items.length });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
async function registerHssShelf() {
  if (!cfg.JELLYFIN_KEY) return;
  try {
    const picks = shelfPicks(await shelfCatalog());
    for (let i = 0; i < picks.length; i++) {
      await tfetch(`${HOST.jellyfin}/HomeScreen/RegisterSection`, {
        method: 'POST',
        headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: SHELF_IDS[i], displayText: picks[i].Name, limit: 10, additionalData: picks[i].Id, resultsEndpoint: `http://${NUC_IP}:8088/api/hss/shelf` }),
      }, 20000);
    }
    if (picks.length && registerHssShelf._last !== picks.map((p) => p.Id).join()) {
      registerHssShelf._last = picks.map((p) => p.Id).join();
      console.log(`hssShelf: shelf rows registered — ${picks.map((p) => p.Name).join(' · ')}`);
    }
  } catch (e) { console.log(`hssShelf: registration failed — ${e?.message || e}`); }
}
setInterval(registerHssShelf, 1800000);   // every 30 min: survives Jellyfin restarts, tracks hourly rotation (was 10min; shelf doesn't churn that fast)
// Boot self-heal: on a cold start the box sets don't exist yet, so a bare shelf registration has
// nothing to show. Wait for Jellyfin to answer, build the collections FIRST, then register shelves
// off the fresh sets — no 3-min gap where the home page is empty. bootSequence() is defined below
// (after collectionsSweep) and scheduled there so both functions are in scope.

// ---- Auto-import watchdog (backend, container-to-container; NOT driven by the UI) ----
// The happy path is event-driven: qBittorrent finishes → *arr imports → *arr pushes a
// "library updated" notification to Jellyfin. But when *arr DROPS a completed download
// without importing (the delete→re-download race), there's no event to react to — so a
// periodic sweep is the only way to catch the *absence* of an import. It runs the same
// Manual Import the *arr UI offers, and retries with backoff until the file lands.
async function importViaManual(app, folder, expectedId) {
  const { base, key } = arrOf(app);
  const r = await tfetch(`${base}/manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=true`, { headers: { 'X-Api-Key': key } }, 90000);
  if (!r.ok) return { ok: false, reason: `manualimport HTTP ${r.status}` };
  const files = []; let reason = 'no importable file found yet';
  for (const c of await r.json()) {
    if (!c.path) continue;
    if (c.rejections && c.rejections.length) {
      const rsn = c.rejections[0].reason || '';
      if (/unknown movie/i.test(rsn) && expectedId) { /* trust the grab link despite unparseable filename */ }
      else { reason = rsn || 'rejected'; continue; }
    }
    const f = { path: c.path, quality: c.quality, languages: c.languages || [], releaseGroup: c.releaseGroup || '' };
    // Fall back to the grab-history movie id (expectedId) when the FILE NAME doesn't parse to a
    // movie — e.g. a release titled "Monty Python Life of Brian" for the library entry "Life of
    // Brian". *arr blocks auto-import on an ID-only match; we trust the grab link and import anyway.
    if (app === 'radarr') { const mid = (c.movie && c.movie.id) || expectedId; if (!mid) { reason = 'no matching movie'; continue; } f.movieId = mid; }
    else { if (!c.series) { reason = 'no matching series'; continue; } f.seriesId = c.series.id; f.episodeIds = (c.episodes || []).map((e) => e.id); if (!f.episodeIds.length) { reason = 'no matching episode'; continue; } }
    files.push(f);
  }
  if (!files.length) return { ok: false, reason };
  const cmd = await tfetch(`${base}/command`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ManualImport', importMode: 'auto', files }) }, 90000);
  return { ok: cmd.ok, count: files.length, reason: cmd.ok ? null : `command HTTP ${cmd.status}` };
}

// Season-alias rescue (Sonarr only, rare). Some TVDB series merge two differently-numbered shows
// into one entry — e.g. "Cosmos (2014)" = S01 "A Spacetime Odyssey" (2014) + S02 "Possible Worlds"
// (2020). A "Possible Worlds" release numbers its files in its OWN season 1 (Cosmos.S01E01…), but
// Sonarr grabbed them as the parent series' season 2. At import Sonarr blocks every file:
// "Episode 1x01 was unexpected considering the …Possible.Worlds.S01… folder name". This remaps
// each file to the exact episode Sonarr ITSELF grabbed this download for, matched by episode
// NUMBER — so we never guess a season. The target comes from Sonarr HISTORY (the grabbed events for
// this downloadId), which is DURABLE: it survives the queue being cleared once Sonarr stops tracking
// the blocked import (the queue empties, so it can't be the source). Returns {ok:false} and no-ops
// if history has no grab or nothing matches. Only ever called as a fallback AFTER the normal import
// already failed with the season-mismatch rejection, so the happy path is untouched.
async function importViaSeasonRemap(folder, seriesIdHint, hash) {
  const { base, key } = arrOf('sonarr');
  // 1. Episodes Sonarr GRABBED this exact download for, from history (durable). Per-episode grab
  //    records carry episodeId + seriesId but not the episode NUMBER — resolve those below. The
  //    seriesId also comes from here (once the queue is gone, the caller's rec.id can be null).
  let grabbedEids = [], seriesId = seriesIdHint != null ? seriesIdHint : null;
  try {
    const hr = await arrGet('sonarr', `/history?pageSize=500&sortKey=date&sortDirection=descending&downloadId=${String(hash).toUpperCase()}`, 15000);
    for (const r of (hr.records || [])) {
      if ((r.eventType || '').toLowerCase() !== 'grabbed') continue;
      if (r.episodeId) grabbedEids.push(r.episodeId);
      if (r.seriesId != null) seriesId = r.seriesId;
    }
  } catch { return { ok: false, reason: 'season-remap: history unavailable' }; }
  grabbedEids = [...new Set(grabbedEids)];
  if (!grabbedEids.length || seriesId == null) return { ok: false, reason: 'season-remap: no grabbed episodes in history' };
  // 2. Resolve grabbed episodeIds → episodeNumber, keyed for lookup by the files' embedded numbers.
  const target = new Map();
  try {
    const eps = await arrGet('sonarr', `/episode?seriesId=${seriesId}`, 30000);
    const want = new Set(grabbedEids);
    for (const e of (eps || [])) if (want.has(e.id) && e.episodeNumber != null) target.set(e.episodeNumber, e.id);
  } catch { return { ok: false, reason: 'season-remap: episode table unavailable' }; }
  if (!target.size) return { ok: false, reason: 'season-remap: grabbed episodes not resolved' };
  const r = await tfetch(`${base}/manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=true`, { headers: { 'X-Api-Key': key } }, 90000);
  if (!r.ok) return { ok: false, reason: `season-remap: manualimport HTTP ${r.status}` };
  const files = [];
  for (const c of await r.json()) {
    if (!c.path) continue;
    // Embedded episode number: prefer Sonarr's own parse, else pull E## / S##E## from the filename.
    const emb = (c.episodes || [])[0];
    let epNum = emb && emb.episodeNumber != null ? emb.episodeNumber : null;
    if (epNum == null) { const m = path.basename(c.path).match(/[ ._-]S\d+E(\d+)[ ._-]/i) || path.basename(c.path).match(/[ ._-]E(\d+)[ ._-]/i); if (m) epNum = parseInt(m[1], 10); }
    if (epNum == null) continue;
    const tid = target.get(epNum);
    if (tid == null) continue;
    files.push({ path: c.path, quality: c.quality, languages: c.languages || [], releaseGroup: c.releaseGroup || '', seriesId, episodeIds: [tid], downloadId: String(hash).toUpperCase() });
  }
  if (!files.length) return { ok: false, reason: 'season-remap: no files matched grabbed episode numbers' };
  const cmd = await tfetch(`${base}/command`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ManualImport', importMode: 'auto', files }) }, 90000);
  return { ok: cmd.ok, count: files.length, reason: cmd.ok ? null : `season-remap: command HTTP ${cmd.status}` };
}

// Maximum-aggression force-grab import for Sonarr. Gap releases reachable only via text search
// are, by definition, the ones Sonarr's structured parser can't handle. Their filenames are
// unreliable — no S01E##, wrong series name, year-suffixed, dot-separated nothingburgers.
// This function tries 4 strategies in order, falling through on emptiness:
//
//   1. Sonarr /manualimport — handles releases that parse fine despite the text-search detour
//   2. Episode-number extraction — regex patterns (S01E03, E03, 03, scene-numbered) against
//      the filename, looked up in the series' full episode table
//   3. Episode-title fuzzy match — strip the series name, match remaining words against Sonarr's
//      episode titles (handles "Planet Earth 03 Fresh Water" → "Fresh Water" → S01E03)
//   4. Sequential fill — sort video files by name, assign to first missing monitored episodes in
//      order (last resort; works for season packs whose filenames have no recognizable pattern
//      at all but are known to be a contiguous season)
async function importViaGrab(app, folder, expectedId) {
  const { base, key } = arrOf(app);

  // ── Scan video files directly so we have ground truth ──
  let onDiskVideos = [];
  try {
    const entries = await fs.promises.readdir(folder);
    for (const e of entries) {
      const ext = path.extname(e).toLowerCase();
      if (VIDEO_EXT.has(ext)) onDiskVideos.push(path.join(folder, e));
    }
  } catch {}
  onDiskVideos.sort();

  // ── Fetch full episode table for this series ──
  let allEps = [], episodeCount = 0, episodeFileCount = 0;
  if (expectedId) {
    try {
      const sr = await tfetch(`${base}/episode?seriesId=${expectedId}`, { headers: { 'X-Api-Key': key } }, 30000);
      if (sr.ok) {
        allEps = await sr.json();
        const statsR = await tfetch(`${base}/series/${expectedId}`, { headers: { 'X-Api-Key': key } }, 8000);
        if (statsR.ok) {
          const s = await statsR.json();
          if (s.statistics) { episodeCount = s.statistics.episodeCount || 0; episodeFileCount = s.statistics.episodeFileCount || 0; }
        }
      }
    } catch {}
  }

  // Maps for fast lookup: key = "season:episode" → episode object, key = "season:episode" → id
  const epByKey = new Map();
  const epByTitle = new Map(); // lowercase title → episode id (for fuzzy match)
  for (const ep of allEps) {
    const k = `${ep.seasonNumber}:${ep.episodeNumber}`;
    epByKey.set(k, ep);
    if (ep.title) epByTitle.set(ep.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim(), ep.id);
  }

  // Helper: extract episode id from a filename using regex + episode table
  function resolveEpisode(filename) {
    // Patterns ordered most → least specific
    const patterns = [
      /[ ._-]S(\d+)E(\d+)[ ._-]/i,
      /[ ._-]S(\d+)[ ._-]+E(\d+)[ ._-]/i,
      /[ ._-]E(\d+)[ ._-]/i,
      /[ ._-]0*(\d+)[ ._-][vV]\d+/,
      /[ ._-](\d{2})[ ._-]/,
      /[ ._-](\d)[ ._-]/,
    ];
    for (const pat of patterns) {
      const m = filename.match(pat);
      if (!m) continue;
      if (m[2] !== undefined) {
        const eid = epByKey.get(`${parseInt(m[1],10)}:${parseInt(m[2],10)}`);
        if (eid) return eid.id;
      } else if (m[1] !== undefined) {
        const num = parseInt(m[1], 10);
        if (num >= 1 && num <= 50) {
          const eid = epByKey.get(`1:${num}`);
          if (eid) return eid.id;
        }
      }
    }
    // Episode-title fuzzy match: strip common noise, check remaining words
    const cleaned = filename
      .replace(path.extname(filename), '')
      .replace(/[._()\[\]{}\-]/g, ' ')
      .replace(/\d{3,}p/g, '')           // 1080p, 720p
      .replace(/\bx265\b|\bx264\b|\bh265\b|\bh264\b|\bhevc\b|\bavc\b|\bav1\b|\bvp9\b/gi, '')
      .replace(/\b\d{4}\b/g, '')          // years
      .replace(/\b\d+x\d+\b/g, '')        // resolutions
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const words = cleaned.split(/\s+/).filter(w => w.length > 2);
    for (const [title, epId] of epByTitle) {
      const titleWords = title.split(/\s+/);
      const matchCount = titleWords.filter(tw => words.includes(tw)).length;
      if (matchCount >= Math.min(titleWords.length, 2) && matchCount / titleWords.length >= 0.5) {
        return epId;
      }
    }
    return null;
  }

  // Detect a MULTI-EPISODE file — one video that spans an episode range (e.g. Cosmos 1980's
  // "Carl Sagan's Cosmos - Chapter 5 to 8" = episodes 5,6,7,8 in a single file, or "E05-E08").
  // Returns [episodeId,…] so Sonarr records it as a multi-episode file (all covered episodes get
  // marked present); null when there's no range. Must be tried BEFORE resolveEpisode, which would
  // otherwise match just the first number ("5") and strand the rest as missing.
  function resolveEpisodeRange(filename) {
    const b = filename.replace(path.extname(filename), '');
    let season = 1, a = null, z = null, m;
    if ((m = b.match(/[ ._-]S(\d+)[ ._-]*E(\d+)[ ._-]*(?:-|–|to|thru|through)[ ._-]*E?(\d+)\b/i))) {
      season = parseInt(m[1], 10); a = parseInt(m[2], 10); z = parseInt(m[3], 10);
    } else if ((m = b.match(/[ ._-]E(\d+)[ ._-]*(?:-|–|to|thru|through)[ ._-]*E?(\d+)\b/i))) {
      a = parseInt(m[1], 10); z = parseInt(m[2], 10);
    } else if ((m = b.match(/\b(?:chapters?|ch|episodes?|ep|parts?)[ ._-]*(\d{1,2})[ ._-]*(?:to|thru|through|-|–)[ ._-]*(\d{1,2})\b/i))) {
      a = parseInt(m[1], 10); z = parseInt(m[2], 10);
    } else if ((m = b.match(/[ ._-](\d{1,2})[ ._-]*(?:to|thru|through)[ ._-]*(\d{1,2})[ ._-]/i))) {
      a = parseInt(m[1], 10); z = parseInt(m[2], 10);
    }
    if (a == null || !(a >= 1 && z > a && z - a <= 40)) return null;
    const ids = [];
    for (let n = a; n <= z; n++) { const e = epByKey.get(`${season}:${n}`); if (e) ids.push(e.id); }
    return ids.length >= 2 ? ids : null;
  }

  // ── Strategy 1: Try Sonarr's /manualimport ──
  const mr = await tfetch(`${base}/manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=true`, { headers: { 'X-Api-Key': key } }, 90000);
  if (mr.ok) {
    const manualItems = await mr.json();
    const importable = [];

    for (const c of manualItems) {
      if (!c.path || !onDiskVideos.includes(c.path)) continue;
      const rejected = c.rejections && c.rejections.length;
      const rsn = rejected ? c.rejections[0].reason : '';
      const hasSeries = !!c.series;
      const hasEpisodes = c.episodes && c.episodes.length > 0;

      // Only trust Sonarr's own parse when it agrees with the series the user force-grabbed for.
      // A gap release reachable only via text search often mis-parses (e.g. "Carl Sagan's Cosmos
      // 1980…" → Cosmos 2014); c.series/c.episodes would then point at the WRONG series. When it
      // disagrees (or expectedId is unknown), fall through to our own resolver, which keys off the
      // correct series' episode table below.
      if (hasSeries && hasEpisodes && (!expectedId || c.series.id === expectedId)) {
        // Clean match — Sonarr parsed everything, and it's the series we intended
        importable.push({ path: c.path, quality: c.quality, languages: c.languages || [], releaseGroup: c.releaseGroup || '', seriesId: c.series.id, episodeIds: c.episodes.map(e => e.id) });
        continue;
      }

      // Multi-episode file first (a single video spanning a range, e.g. "Chapter 5 to 8").
      const rangeIds = resolveEpisodeRange(path.basename(c.path));
      if (rangeIds) {
        importable.push({ path: c.path, quality: c.quality, languages: c.languages || [], releaseGroup: c.releaseGroup || '', seriesId: expectedId || (c.series && c.series.id), episodeIds: rangeIds });
        console.log(`importViaGrab: multi-episode file "${path.basename(c.path)}" → ${rangeIds.length} episodes`);
        continue;
      }
      // Attempt our own resolution
      const epId = resolveEpisode(path.basename(c.path));
      if (epId != null) {
        importable.push({ path: c.path, quality: c.quality, languages: c.languages || [], releaseGroup: c.releaseGroup || '', seriesId: expectedId || (c.series && c.series.id), episodeIds: [epId] });
        continue;
      }

      // Last-ditch: if this is a series match with rejections but we know expectedId,
      // try by file order vs missing episodes
      if (hasSeries && expectedId) {
        // We'll handle these in strategy 4 below
      }
    }

    if (importable.length) {
      const cmd = await tfetch(`${base}/command`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ManualImport', importMode: 'auto', files: importable }) }, 90000);
      return { ok: cmd.ok, count: importable.length, reason: cmd.ok ? null : `command HTTP ${cmd.status}` };
    }
  }

  // ── Strategy 2+3: Direct file scan with episode resolution ──
  let resolved = [];
  for (const fp of onDiskVideos) {
    const rangeIds = resolveEpisodeRange(path.basename(fp));
    if (rangeIds) { resolved.push({ path: fp, seriesId: expectedId, episodeIds: rangeIds }); continue; }
    const epId = resolveEpisode(path.basename(fp));
    if (epId != null) {
      resolved.push({ path: fp, seriesId: expectedId, episodeIds: [epId] });
    }
  }

  if (resolved.length) {
    const cmd = await tfetch(`${base}/command`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ManualImport', importMode: 'auto', files: resolved }) }, 90000);
    return { ok: cmd.ok, count: resolved.length, reason: cmd.ok ? null : `command HTTP ${cmd.status}` };
  }

  // ── Strategy 4: Sequential fill — sort files, assign to first missing monitored episodes ──
  if (expectedId && onDiskVideos.length > 0) {
    const missingEps = allEps
      .filter(e => e.monitored && !e.hasFile)
      .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
    if (missingEps.length >= onDiskVideos.length) {
      const sequential = onDiskVideos.map((fp, i) => ({
        path: fp,
        seriesId: expectedId,
        episodeIds: [missingEps[i].id],
      }));
      const cmd = await tfetch(`${base}/command`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ManualImport', importMode: 'auto', files: sequential }) }, 90000);
      return { ok: cmd.ok, count: sequential.length, reason: cmd.ok ? null : `command HTTP ${cmd.status}` };
    }
  }

  return { ok: false, reason: onDiskVideos.length ? 'could not match any video file to an episode' : 'no video files found in folder' };
}

// ── Force-grab post-import verification & telemetry ──────────────────────────────────────────
// Force-grabs bypass Sonarr's own quality/parse gates, so a bad one can look "imported" while
// actually landing in the wrong series, scattering into phantom Jellyfin seasons, doubling, or
// importing only partially. This cross-checks Sonarr AND Jellyfin after import and emits a loud
// `fg_verify` event (make metrics a='events --type fg_verify') the moment anything is off — the
// safety net behind the rename+NFO+range fixes. A few minutes' delay lets Jellyfin finish scanning.
const forceGrabVerify = new Map(); // seriesId -> { hash, dueAt, tries }
function scheduleForceGrabVerify(seriesId, hash) {
  if (seriesId == null) return;
  forceGrabVerify.set(Number(seriesId), { hash: String(hash || '').toLowerCase(), dueAt: Math.floor(Date.now() / 1000) + 150, tries: 0 });
}
async function jellyfinSeriesByPath(mappedPath) {
  if (!cfg.JELLYFIN_KEY || !mappedPath) return [];
  const uid = await jellyfinUserId();
  const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };
  const q = new URLSearchParams({ recursive: 'true', includeItemTypes: 'Series', fields: 'Path,ProviderIds', limit: '2000' });
  const items = ((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 8000)).json()).Items) || [];
  const norm = (p) => String(p || '').replace(/\/+$/, '');
  return items.filter((i) => norm(i.Path) === norm(mappedPath));
}
async function jellyfinSeasonCounts(seriesItemId) {
  const uid = await jellyfinUserId();
  const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };
  const q = new URLSearchParams({ parentId: seriesItemId, recursive: 'true', includeItemTypes: 'Episode', fields: 'ParentIndexNumber', limit: '5000' });
  const eps = ((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 10000)).json()).Items) || [];
  const bySeason = {};
  for (const e of eps) { const s = e.ParentIndexNumber == null ? 'unknown' : String(e.ParentIndexNumber); bySeason[s] = (bySeason[s] || 0) + 1; }
  return { total: eps.length, bySeason };
}
// Compute (do not emit) the verification result for a force-grabbed Sonarr series.
async function computeForceGrabVerify(seriesId) {
  const issues = [];
  let series;
  try { series = await arrGet('sonarr', `/series/${seriesId}`, 8000); }
  catch (e) { return { ok: false, transient: true, issues: ['sonarr_unreachable'], payload: { id: seriesId, error: String(e.message || e) } }; }
  const st = series.statistics || {};
  const title = `${series.title}${series.year ? ` (${series.year})` : ''}`;
  const tvdb = series.tvdbId || null;
  const sonarrSeasons = {};
  for (const sn of (series.seasons || [])) if (sn.seasonNumber > 0) { const ss = sn.statistics || {}; sonarrSeasons[String(sn.seasonNumber)] = ss.episodeFileCount || 0; }
  if (!(st.episodeCount > 0 && st.episodeFileCount >= st.episodeCount)) issues.push(`sonarr_incomplete:${st.episodeFileCount || 0}/${st.episodeCount || 0}`);
  let jf = null, transient = false;
  try {
    const mapped = (series.path || '').replace('/data/media', '/media');
    const jseries = await jellyfinSeriesByPath(mapped);
    if (!jseries.length) { issues.push('jellyfin_missing'); transient = true; }
    else {
      if (jseries.length > 1) issues.push(`jellyfin_duplicate:${jseries.length}`);
      const s0 = jseries[0];
      const jtvdb = s0.ProviderIds && (s0.ProviderIds.Tvdb || s0.ProviderIds.tvdb);
      if (tvdb && jtvdb && String(jtvdb) !== String(tvdb)) issues.push(`jellyfin_wrong_tvdb:${jtvdb}!=${tvdb}`);
      const counts = await jellyfinSeasonCounts(s0.Id);
      jf = { tvdb: jtvdb || null, total: counts.total, seasons: counts.bySeason };
      const real = new Set(Object.keys(sonarrSeasons));
      for (const s of Object.keys(counts.bySeason)) if (s === 'unknown' || !real.has(s)) issues.push(`jellyfin_phantom_season:${s}`);
      if (st.episodeFileCount && counts.total > st.episodeFileCount) issues.push(`jellyfin_extra_episodes:${counts.total}>${st.episodeFileCount}`);
    }
  } catch { issues.push('jellyfin_check_error'); transient = true; }
  return {
    ok: issues.length === 0,
    transient,
    issues,
    payload: { id: Number(seriesId), ti: title, tvdb, ok: issues.length === 0, issues, sonarr: { files: st.episodeFileCount || 0, eps: st.episodeCount || 0, seasons: sonarrSeasons }, jellyfin: jf },
  };
}
let fgVerifyBusy = false;
async function forceGrabVerifySweep() {
  if (masterPaused || fgVerifyBusy || !forceGrabVerify.size) return;
  fgVerifyBusy = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    for (const [sid, v] of forceGrabVerify) {
      if (now < v.dueAt) continue;
      v.tries++;
      const r = await computeForceGrabVerify(sid).catch((e) => ({ ok: false, transient: false, issues: ['verify_error'], payload: { id: sid, error: String(e.message || e) } }));
      // Only transient issues (Jellyfin still scanning) and tries left → wait and retry, don't cry wolf.
      if (!r.ok && r.transient && v.tries < 4) { v.dueAt = now + 180; continue; }
      metrics.emitEvent('fg_verify', r.payload);
      console.log(`fg-verify: ${r.ok ? 'PASS' : 'FAIL'} "${r.payload.ti || sid}" (tvdb ${r.payload.tvdb || '?'})${r.ok ? '' : ' — ' + r.issues.join(', ')}`);
      forceGrabVerify.delete(sid);
    }
  } finally { fgVerifyBusy = false; }
}
setInterval(forceGrabVerifySweep, 60000);

// A download can fail to import forever when the "release" is a fake — e.g. a .scr Windows
// executable padded to episode size. *arr rejects it every sweep ("Unable to determine if file
// is a sample") and, with no retry cap, the watchdog retries it every 120s indefinitely while the
// item sits in "Needs attention" until a human deletes it by hand. IMPORT_MAX_FAILS bounds the
// retries; hasVideoContent() then confirms there is genuinely no video before we discard, so a
// real file that fails to import for other reasons is never thrown away.
const IMPORT_MAX_FAILS = 5;                                         // consecutive failed imports (~10 min at 120s backoff) before garbage check
const VIDEO_EXT = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.flv', '.ts', '.m2ts', '.mpg', '.mpeg', '.webm', '.vob', '.divx', '.3gp', '.ogv', '.mts', '.iso']);
// Check if a file actually has a video stream, not just a matching extension.
// Runs ffprobe with a tight probesize so even multi-GB files return fast.
// On error/failure returns false (not video) UNLESS ffprobe itself isn't found,
// in which case we trust the extension check (fail-safe: never delete on uncertainty).
function hasVideoStream(fp) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      '-analyzeduration', '100k',
      '-probesize', '100k',
      fp
    ], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        if (err.code === 'ENOENT') resolve(true);                 // ffprobe not found → trust extension
        else resolve(false);                                        // ffprobe says not a video
        return;
      }
      resolve(stdout.trim() === 'video');
    });
  });
}
async function hasVideoContent(p) {
  try {
    const st = await fs.promises.stat(p);
    if (st.isFile()) {
      if (!VIDEO_EXT.has(path.extname(p).toLowerCase())) return false;
      return await hasVideoStream(p);
    }
    const stack = [p];                                             // directory: any video file anywhere inside counts
    while (stack.length) {
      const dir = stack.pop();
      for (const ent of await fs.promises.readdir(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) stack.push(path.join(dir, ent.name));
        else if (VIDEO_EXT.has(path.extname(ent.name).toLowerCase())) {
          if (await hasVideoStream(path.join(dir, ent.name))) return true;
        }
      }
    }
    return false;
  } catch { return true; }                                         // can't tell → assume video (fail-safe: never delete on uncertainty)
}
// Discard a confirmed-garbage download: blocklist the release so *arr won't re-grab this exact
// fake, remove the torrent + its file from qBittorrent, and re-search for a real copy. Mirrors
// stallRecovery's dual path — prefer the queue record (removeFromClient+blocklist in one call),
// fall back to history/failed when *arr no longer tracks the download.
async function discardGarbage(rec) {
  const { base, key } = arrOf(rec.app);
  let blocklisted = false;
  try {
    const qrec = rec.hash && (await getQueueMap(rec.app)).get(rec.hash.toLowerCase());
    if (qrec && qrec.id != null) {
      await tfetch(`${base}/queue/${qrec.id}?removeFromClient=true&blocklist=true`, { method: 'DELETE', headers: { 'X-Api-Key': key } }, 20000);
      blocklisted = true;
    }
  } catch { /* fall through to history-based blocklist */ }
  if (!blocklisted && rec.hash) {
    try {
      const hr = await arrGet(rec.app, `/history?pageSize=20&sortKey=date&sortDirection=descending&downloadId=${rec.hash.toUpperCase()}`);
      const grab = (hr.records || []).find((r) => (r.eventType || '').toLowerCase() === 'grabbed');
      if (grab) { await tfetch(`${base}/history/failed/${grab.id}`, { method: 'POST', headers: { 'X-Api-Key': key } }, 15000); blocklisted = true; }
    } catch { /* best-effort */ }
  }
  if (rec.hash) {                                                  // ensure the fake file is gone even if there was no queue record
    try { await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ hashes: rec.hash, deleteFiles: 'true' }) }); } catch { /* qbit hiccup — retried */ }
  }
  if (rec.id != null) {                                            // re-search for a real copy of the missing item
    const cmd = rec.app === 'radarr' ? { name: 'MoviesSearch', movieIds: [rec.id] } : { name: 'SeriesSearch', seriesId: rec.id };
    try { await tfetch(`${base}/command`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) }, 20000); } catch { /* search kick best-effort */ }
  }
  return blocklisted;
}

// A manualimport that throws (AbortController timeout, socket reset, HTTP 5xx) is *arr being slow
// or briefly down — NOT the release being unimportable. Timeouts must never paint a row red or
// count toward the garbage cap: on a loaded NUC that turned every genuinely-importable download
// into a permanent, self-reinforcing "Needs attention" (each retry fired another heavy 90s probe
// that pushed the box slower). Transient errors only extend the per-folder backoff.
const isTransientErr = (e) => { const m = (e && e.message || String(e || '')).toLowerCase(); return m.includes('abort') || m.includes('timeout') || m.includes('timed out') || m.includes('network') || m.includes('fetch failed') || m.includes('econn') || /http 5\d\d/.test(m); };
const IMPORT_BACKOFF_MIN = 120, IMPORT_BACKOFF_MAX = 1800; // s — grows 120→240→…→1800 on repeated failure
const WATCHDOG_BATCH = 3;                                  // heavy manualimport calls per sweep — cap the added load
let watchdogBusy = false;                                  // reentrancy guard: a slow sweep must not overlap the next tick
async function importWatchdog() {
  if (masterPaused || watchdogBusy) return;                         // Movie Mode / already running
  const snap = _dl.raw;                                             // reuse the background snapshot — no extra buildDownloads
  if (!snap || !snap.length) return;
  watchdogBusy = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    let handled = 0;
    // Pre-pass: resolve force-grabbed torrents whose content is on disk but Sonarr hasn't
    // fully imported. These don't appear in `snap` (torrent may be gone from qBittorrent
    // while the download folder still holds orphaned episode files). Try Manual Import for
    // any watched hash whose folder is known (either from the live torrent or from disk).
    const fgTorrents = forceGrabImport.size ? await getQbitTorrents().catch(() => []) : [];
    const fgByHash = new Map();
    for (const t of fgTorrents) fgByHash.set((t.hash || '').toLowerCase(), t);
    const CAT_PATH = '/data/torrents/complete/sonarr-force';
    for (const [infoHash, fg] of forceGrabImport) {
      if (handled >= WATCHDOG_BATCH) break;
      const liveTorrent = fgByHash.get(infoHash);
      if (liveTorrent) {
        // Import ONLY once the torrent is complete. Importing mid-download hardlinks preallocated/
        // half-written files into the library — Sonarr then marks them imported and never replaces
        // them with the finished data, and Jellyfin probes partial media. qBit's content_path also
        // points into the incomplete/ tree until completion. Wait for the next sweep.
        if ((liveTorrent.progress || 0) < 1) { fg.folder = null; continue; }
        if (liveTorrent.content_path) fg.folder = liveTorrent.content_path;
      } else if (!fg.folder) {
        // Torrent gone from qBittorrent but may still have files on disk.
        // Scan the sonarr category folder for a directory matching the series title.
        try {
          const entries = await fs.promises.readdir(CAT_PATH).catch(() => []);
          const seriesNorm = norm(fg.seriesTitle);
          for (const entry of entries) {
            if (norm(entry).includes(seriesNorm)) {
              const fp = path.join(CAT_PATH, entry);
              const st = await fs.promises.stat(fp).catch(() => null);
              if (st && st.isDirectory()) { fg.folder = fp; break; }
            }
          }
        } catch { /* best-effort */ }
      }
      if (!fg.folder) continue; // not ready yet, retry next sweep
      if (fg.folder.includes('/torrents/incomplete/')) continue; // defense: never import from the incomplete tree
      // Already fully imported (by a prior sweep, or the standard path) → finalize and stop retrying.
      // Without this, importViaGrab finds nothing new to import (all files present) and would keep
      // counting "failures" against a series that's actually complete.
      try {
        const s0 = await arrGet('sonarr', `/series/${fg.id}`, 6000);
        const ss = s0 && s0.statistics;
        if (ss && ss.episodeCount > 0 && ss.episodeFileCount >= ss.episodeCount) {
          forceGrabImport.delete(infoHash);
          completedForceGrabs.set(infoHash, { id: fg.id });
          importState.delete(fg.folder);
          persistState();
          metrics.emitEvent('fg_import', { id: fg.id, ti: fg.seriesTitle, files: ss.episodeFileCount, eps: ss.episodeCount, done: true, via: 'precomplete', infoHash });
          scheduleForceGrabVerify(fg.id, infoHash);
          console.log(`watchdog: force-grab complete (${ss.episodeFileCount}/${ss.episodeCount}) — "${fg.seriesTitle}"`);
          continue;
        }
      } catch { /* stats unavailable — fall through and let importViaGrab try */ }
      const st = importState.get(fg.folder) || { lastTry: 0, reason: null, fails: 0, backoff: IMPORT_BACKOFF_MIN };
      if (now - st.lastTry < (st.backoff || IMPORT_BACKOFF_MIN)) continue;
      st.lastTry = now; handled++;
      let res;
      try { res = await importViaGrab('sonarr', fg.folder, fg.id); }
      catch (e) { res = { ok: false, reason: e.message || 'error' }; }
      if (res && res.ok) {
        importState.set(fg.folder, { lastTry: now, reason: null, fails: 0, backoff: IMPORT_BACKOFF_MIN });
        triggerJellyfinScan();
        console.log(`watchdog: force-grab imported ${res.count} file(s) from "${fg.folder}"`);
        // Check if ALL episodes are now in the library — partial imports keep retrying.
        let allDone = false, stats = null;
        try {
          const seriesData = await arrGet('sonarr', `/series/${fg.id}`, 6000);
          stats = seriesData && seriesData.statistics;
          if (stats && stats.episodeCount > 0 && stats.episodeFileCount != null) {
            allDone = stats.episodeFileCount >= stats.episodeCount;
          }
        } catch { /* best-effort — retry next sweep */ }
        metrics.emitEvent('fg_import', { id: fg.id, ti: fg.seriesTitle, imported: res.count, files: stats && stats.episodeFileCount, eps: stats && stats.episodeCount, done: allDone, via: 'watchdog', infoHash });
        if (allDone) {
          forceGrabImport.delete(infoHash);
          completedForceGrabs.set(infoHash, { id: fg.id }); // remember the series so buildDownloads renders this Ready (no downloadId-keyed *arr history)
          persistState();
          scheduleForceGrabVerify(fg.id, infoHash);
        }
      } else if (res && (/no matching (series|episode)/i.test(res.reason || '') || (st.fails || 0) >= IMPORT_MAX_FAILS)) {
        // Can't match: folder was removed or Sonarr truly can't parse these files. Give up.
        console.log(`watchdog: force-grab gave up on "${fg.folder}" — ${res.reason || 'max fails'}`);
        metrics.emitEvent('fg_giveup', { id: fg.id, ti: fg.seriesTitle, folder: fg.folder, reason: res ? res.reason : 'max fails', infoHash });
        forceGrabImport.delete(infoHash);
        importState.delete(fg.folder);
        persistState();
      } else {
        st.fails = (st.fails || 0) + 1;
        st.backoff = Math.min((st.backoff || IMPORT_BACKOFF_MIN) * 2, IMPORT_BACKOFF_MAX);
        st.reason = res ? res.reason : 'error';
        importState.set(fg.folder, st);
      }
    }
    for (const it of snap) {
      if (handled >= WATCHDOG_BATCH) break;                         // spread the backlog across sweeps, don't pile onto the CPU
      const rec = it._recover; if (!rec) continue;                  // only completed-but-not-imported / import-blocked
      const st = importState.get(rec.folder) || { lastTry: 0, reason: null, fails: 0, backoff: IMPORT_BACKOFF_MIN };
      if (now - st.lastTry < (st.backoff || IMPORT_BACKOFF_MIN)) continue; // per-folder (exponential) backoff
      try { await fs.promises.stat(rec.folder); } catch { importState.delete(rec.folder); continue; } // content gone → nothing to import
      // (manualimport accepts a single file path OR a folder, so we no longer skip single-file torrents —
      //  import-blocked single files like "matched by ID, manual import required" must be rescued too.)
      st.lastTry = now; handled++;
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
            if (et === 'grabbed') break;                            // reached the grab first → not imported this cycle
          }
          if (alreadyImported) { importState.delete(rec.folder); continue; }
        } catch { /* history unavailable — fall through to the existing rescue path */ }
      }
      let res;
      try { res = await importViaManual(rec.app, rec.folder, rec.id); }
      catch (e) {
        if (isTransientErr(e)) {                                    // *arr slow/down — retry later, never flag or count
          st.backoff = Math.min((st.backoff || IMPORT_BACKOFF_MIN) * 2, IMPORT_BACKOFF_MAX);
          importState.set(rec.folder, st);                          // note: st.reason left untouched → row stays "Importing", not red
          console.log(`watchdog: transient import error for "${rec.folder}" — ${e.message || e}; retry in ${st.backoff}s`);
          metrics.emitEvent('import_err', { ti: rec.folder, ap: rec.app, reason: 'transient', backoff: st.backoff });
          continue;
        }
        res = { ok: false, reason: e.message || 'error' };          // a real, non-transient throw is treated as a rejection below
      }
      // Season-alias fallback: only when the normal import was blocked because the files' embedded
      // season differs from the season Sonarr grabbed the release for (merged TVDB series like
      // Cosmos 2014's "Possible Worlds" S02). Scoped tightly — Sonarr only, needs the download hash,
      // and only this exact rejection class — so the standard import path is never affected.
      if (!res.ok && rec.app === 'sonarr' && rec.hash &&
          /unexpected considering the .* folder name|not found in the grabbed release/i.test(res.reason || '')) {
        try {
          const remap = await importViaSeasonRemap(rec.folder, rec.id, rec.hash);
          if (remap.ok) { res = remap; console.log(`watchdog: season-alias remap imported ${remap.count} file(s) from "${rec.folder}"`); metrics.emitEvent('season_remap', { id: rec.id, ti: rec.folder, count: remap.count, hash: rec.hash }); }
        } catch { /* fall through to normal failure handling */ }
      }
      if (res.ok) {
        importState.set(rec.folder, { lastTry: now, reason: null, fails: 0, backoff: IMPORT_BACKOFF_MIN }); // cleared on success
        triggerJellyfinScan();
        console.log(`watchdog: imported ${res.count} file(s) from "${rec.folder}"`);
        metrics.emitEvent('import_ok', { ti: rec.folder, ap: rec.app, count: res.count });
        continue;
      }
      // ORPHAN: *arr no longer tracks this series/movie (removed from the library, or a release for
      // content that isn't in *arr). It can NEVER import — remove the torrent so it stops recurring
      // and quits consuming disk/seed slots. Not garbage, so don't blocklist (the content may be re-added).
      if (/no matching (series|movie)|unknown (series|movie)/i.test(res.reason || '')) {
        // Defense-in-depth: never orphan-delete a manual force-grab. Its release name frequently
        // doesn't parse to any series (that's WHY it was force-grabbed), which would otherwise trip
        // this branch and wipe the files with deleteFiles:true. The pre-pass owns these folders.
        if ((rec.folder || '').includes('/complete/sonarr-force/')) { importState.delete(rec.folder); continue; }
        try { if (rec.hash) await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ hashes: rec.hash, deleteFiles: 'true' }) }); } catch { /* qbit hiccup — retried next sweep */ }
        importState.delete(rec.folder);
        console.log(`watchdog: orphan removed (not tracked by ${rec.app}): "${rec.folder}" — ${res.reason}`);
        metrics.emitEvent('orphan', { ti: rec.folder, ap: rec.app, reason: res.reason, source: 'watchdog' });
        continue;
      }
      st.reason = res.reason;
      st.fails = (st.fails || 0) + 1;
      st.backoff = Math.min((st.backoff || IMPORT_BACKOFF_MIN) * 2, IMPORT_BACKOFF_MAX); // back off real rejections too, don't thrash
      importState.set(rec.folder, st);
      // Bounded retries + a video check: a download that fails to import N times AND has no real
      // video file is a fake release (e.g. a .scr executable padded to episode size). Discard it —
      // blocklist, delete from qBittorrent, re-search — instead of retrying forever.
      if (st.fails >= IMPORT_MAX_FAILS && !(await hasVideoContent(rec.folder))) {
        try {
          const blk = await discardGarbage(rec);
          importState.delete(rec.folder);
          console.log(`watchdog: garbage file, deleted and re-searching (${st.fails} failed imports, no video, blocklisted=${blk}): "${rec.folder}" — ${res.reason}`);
          metrics.emitEvent('garbage', { ti: rec.folder, ap: rec.app, fails: st.fails, blocklisted: blk });
        } catch (e) { console.log(`watchdog: garbage discard failed for "${rec.folder}": ${e.message || e}`); }
        continue;
      }
      console.log(`watchdog: "${rec.folder}" not importable yet — ${res.reason} (fail ${st.fails}/${IMPORT_MAX_FAILS}, retry ${st.backoff}s)`);
    }
  } finally { watchdogBusy = false; }
}
setInterval(importWatchdog, 60000); // sweep every 60s (was 30s); imports take minutes, per-folder exponential backoff + batch cap bound real attempts
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
      // Force-grabbed torrents are user-approved and may not have an *arr queue record
      // yet (or ever, if the release name doesn't parse). Don't delete them — the import
      // watchdog will retry Manual Import on the download folder until files land.
      if (forceGrabImport.has(h) || (t.category || '').toLowerCase() === 'sonarr-force') { _stallSince.delete(h); continue; }
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
        metrics.emitEvent('abandon', { ti: t.name, ap: app, reason: 'orphan_no_queue' });
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
        metrics.emitEvent('re_search', { ti: t.name, ap: app, attempt: cnt + 1 });
      } else {
        // Tried enough — this title is genuinely rare. Drop the dead copy, grab the single
        // best-seeded release available, and ACCEPT it: never abandon again, let it sit until a
        // seed shows up. (Sonarr: just stop churning and let the current copy ride.)
        await tfetch(`${arrOf(app).base}/queue/${qrec.id}?removeFromClient=true&blocklist=true`, { method: 'DELETE', headers: { 'X-Api-Key': arrOf(app).key } }, 20000);
        const seeders = await grabBestSeeded(app, itemId);
        _accepted.add(key);
        console.log(`recovery: "${t.name}" is rare after ${MAX_RESEARCH} tries — grabbed best available (${seeders == null ? 'left as-is' : seeders + ' seeds'}) and letting it sit`);
        metrics.emitEvent('accepted_rare', { ti: t.name, ap: app });
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
          metrics.emitEvent('swap_abandon', { ti: p.title, reason: '48h_timeout' });
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
              metrics.emitEvent('swap_defer', { ti: p.title, reason: 'mid_watch' });
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
        metrics.emitEvent('swap_done', { ti: p.title });
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
          metrics.emitEvent('swap_none', { ti: m.title, label, score: fileScore });
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
        if (!gr.ok) { console.log(`gpuVerify: "${m.title}" replacement grab failed (HTTP ${gr.status}) — leaving file in place`); metrics.emitEvent('swap_fail', { ti: m.title, status: gr.status }); continue; }
        // ZERO-GAP: the old file is NOT touched now. Register the pending swap — Phase 1
        // removes the old copy only after the replacement finishes downloading (and nobody
        // is watching). The Downloads UI labels this download as an auto-upgrade.
        gpuPending.set(m.id, { oldHashes, ts: now, title: m.title, tmdbId: m.tmdbId });
        persistState();
        console.log(`gpuVerify: "${m.title}" is ${label} (file score ${fileScore}) — grabbed better H.264 "${(best.title || '').slice(0, 60)}" (score ${best.customFormatScore}, ${best.seeders} seeds); old copy stays until it completes`);
        metrics.emitEvent('swap_start', { ti: m.title, label, oldScore: fileScore, newScore: best.customFormatScore, seeds: best.seeders });
      } catch (e) { console.log(`gpuVerify: failed for "${m.title}" — ${e.message || e}`); }
    }
  } finally { gpuVerifyBusy = false; }
}
setInterval(gpuVerifySweep, 900000); // every 15 min (was 10min); well within the 48h swap window; per-cycle cap + once-per-movie guard bound the work
setTimeout(gpuVerifySweep, 60000);

// ---- Auto-collections sweep: decade / genre / top-rated collections, maintained natively ──
// "Automatic playlists by decade and genre" with NO third-party plugin: the controller derives
// rule-based Jellyfin COLLECTIONS (box sets — poster tiles in Movies → Collections) from
// library metadata and reconciles membership every pass, so they grow with the library and
// survive Jellyfin upgrades. Distinct names ("90s Movies", "Comedy Movies") can't collide
// with TMDb franchise box sets ("James Bond Collection"). Thin buckets (<5 titles) skipped.
let collSweepBusy = false;
async function collectionsSweep() {
  if (masterPaused || collSweepBusy || !cfg.JELLYFIN_KEY) { console.log(`collectionsSweep: skipped (masterPaused=${masterPaused} busy=${collSweepBusy} key=${!!cfg.JELLYFIN_KEY})`); return; }
  collSweepBusy = true;
  console.log('collectionsSweep: starting');
  try {
    const uid = await jellyfinUserId();
    const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };
    const q = new URLSearchParams({ IncludeItemTypes: 'Movie', Recursive: 'true', Fields: 'ProductionYear,Genres,CommunityRating,RunTimeTicks,ProviderIds,People,Studios', Limit: '5000' });
    const movies = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 120000)).Items) || [];
    if (movies.length < 20) return;                       // tiny library — don't spam collections
    const buckets = new Map();                            // collection name -> { ids:Set, desc }
    const add = (name, desc, id) => { if (!buckets.has(name)) buckets.set(name, { ids: new Set(), desc }); buckets.get(name).ids.add(id); };
    const oscarBuckets = new Map();                        // collection name -> { items: Map<jfId, year>, desc }
    const OSCAR_DESC = {
      'Oscar: Best Picture (Winners)': 'The Academy Award for Best Picture — the year\'s finest film, as voted by the industry.',
      'Oscar: Best Picture (Nominees)': 'Every film nominated for Best Picture — the Academy\'s pick of the year\'s best.',
      'Oscar: Best Director (Winners)': 'Academy Award for Best Director — recognising outstanding directorial achievement.',
      'Oscar: Best Director (Nominees)': 'Every film whose director earned a nomination — the year\'s most acclaimed helmers.',
      'Oscar: Best Actor (Winners)': 'Academy Award for Best Actor — a leading performance that defined the year.',
      'Oscar: Best Actor (Nominees)': 'Every nominated lead performance — the year\'s most celebrated actors.',
      'Oscar: Best Actress (Winners)': 'Academy Award for Best Actress — a leading performance that defined the year.',
      'Oscar: Best Actress (Nominees)': 'Every nominated lead performance — the year\'s most celebrated actresses.',
      'Oscar: Best Supporting Actor (Winners)': 'Academy Award for Best Supporting Actor — scene-stealing in the best way.',
      'Oscar: Best Supporting Actor (Nominees)': 'Every nominated supporting performance — scene-stealers who nearly won.',
      'Oscar: Best Supporting Actress (Winners)': 'Academy Award for Best Supporting Actress — scene-stealing in the best way.',
      'Oscar: Best Supporting Actress (Nominees)': 'Every nominated supporting performance — scene-stealers who nearly won.',
      'Oscar: Best Film Editing (Winners)': 'Academy Award for Best Film Editing — the invisible art that shapes every great film.',
      'Oscar: Best Film Editing (Nominees)': 'Every nominated film for editing — the cuts that nearly took the prize.',
      'Oscar: Best Cinematography (Winners)': 'Academy Award for Best Cinematography — the year\'s most stunning visuals.',
      'Oscar: Best Cinematography (Nominees)': 'Every nominated film for cinematography — the year\'s most beautiful-looking films.',
    };
    const personBuckets = new Map();
    const pbAdd = (name, desc, id, year) => {
      if (!personBuckets.has(name)) personBuckets.set(name, { items: new Map(), desc });
      personBuckets.get(name).items.set(id, year || 0);
    };
    const ACTOR_MAP = new Map([
      ['robert de niro','Robert De Niro'],['al pacino','Al Pacino'],['marlon brando','Marlon Brando'],['jack nicholson','Jack Nicholson'],['daniel day-lewis','Daniel Day-Lewis'],['denzel washington','Denzel Washington'],['tom hanks','Tom Hanks'],['samuel l. jackson','Samuel L. Jackson'],['leonardo dicaprio','Leonardo DiCaprio'],['clint eastwood','Clint Eastwood'],['paul newman','Paul Newman'],['robert duvall','Robert Duvall'],['dustin hoffman','Dustin Hoffman'],['meryl streep','Meryl Streep'],['katharine hepburn','Katharine Hepburn'],['audrey hepburn','Audrey Hepburn'],['cary grant','Cary Grant'],['james stewart','James Stewart'],['humphrey bogart','Humphrey Bogart'],['judi dench','Judi Dench'],['helen mirren','Helen Mirren'],['ingrid bergman','Ingrid Bergman'],['joaquin phoenix','Joaquin Phoenix'],['brad pitt','Brad Pitt'],['julia roberts','Julia Roberts'],['spencer tracy','Spencer Tracy'],['sean penn','Sean Penn'],['robert redford','Robert Redford'],['jack lemmon','Jack Lemmon'],['peter o\'toole','Peter O\'Toole'],['john wayne','John Wayne'],['sean connery','Sean Connery'],['christopher walken','Christopher Walken'],['joe pesci','Joe Pesci'],['ralph fiennes','Ralph Fiennes'],['matthew mcconaughey','Matthew McConaughey'],['christian bale','Christian Bale'],['tom cruise','Tom Cruise'],['matt damon','Matt Damon'],['harrison ford','Harrison Ford'],['adam sandler','Adam Sandler'],['ben stiller','Ben Stiller'],['simon pegg','Simon Pegg'],['vince vaughn','Vince Vaughn'],['jennifer aniston','Jennifer Aniston'],['sacha baron cohen','Sacha Baron Cohen'],['laurence fishburne','Laurence Fishburne'],['jason sudeikis','Jason Sudeikis'],['jason bateman','Jason Bateman'],['bill hader','Bill Hader'],['mark wahlberg','Mark Wahlberg'],['ryan gosling','Ryan Gosling'],['ryan reynolds','Ryan Reynolds'],
    ]);
    const DIRECTOR_MAP = new Map([
      ['martin scorsese','Martin Scorsese'],['steven spielberg','Steven Spielberg'],['francis ford coppola','Francis Ford Coppola'],['billy wilder','Billy Wilder'],['quentin tarantino','Quentin Tarantino'],['stanley kubrick','Stanley Kubrick'],['alfred hitchcock','Alfred Hitchcock'],['akira kurosawa','Akira Kurosawa'],['david lean','David Lean'],['john ford','John Ford'],['orson welles','Orson Welles'],['christopher nolan','Christopher Nolan'],['ridley scott','Ridley Scott'],      ['sergio leone','Sergio Leone'],['charlie chaplin','Charlie Chaplin'],['frank capra','Frank Capra'],['ingmar bergman','Ingmar Bergman'],['bong joon ho','Bong Joon Ho'],
    ]);
    const COMPOSER_MAP = new Map([
      ['john williams','John Williams'],['hans zimmer','Hans Zimmer'],['ennio morricone','Ennio Morricone'],['howard shore','Howard Shore'],['bernard herrmann','Bernard Herrmann'],
    ]);
    const DIRECTOR_GROUPS = new Map([
      ['Coen Brothers', ['joel coen', 'ethan coen']],
    ]);
    const WRITER_MAP = new Map([
      ['aaron sorkin','Aaron Sorkin'],['david koepp','David Koepp'],['eric roth','Eric Roth'],['john logan','John Logan'],['william goldman','William Goldman'],
    ]);
    const STUDIO_ALIASES = new Map([['a24','A24'],['studio ghibli','Ghibli'],['ghibli','Ghibli'],['pixar','Pixar']]);
    const CINEMATOGRAPHERS = ['Roger Deakins','Vittorio Storaro','Emmanuel Lubezki','Robert Richardson','Gregg Toland'];
    const EDITORS = ['Thelma Schoonmaker','Michael Kahn','Walter Murch','Dede Allen','Sally Menke'];
    // VIBE COMBOS — short titles, flowery blurbs (→ the collection's Overview), and per-vibe
    // GENRE EXCLUSIONS so tones don't bleed (no cartoons in date night, no romance in the
    // action shelf). Thin results (<5 titles) auto-hide, so the list can be aspirational —
    // add a vibe as one entry: [name, blurb, test(m, year, minutes, rating)].
    const has = (m, g) => (m.Genres || []).includes(g);
    const none = (m, gs) => !gs.some((g) => has(m, g));
    const VIBES = [
      ['Mob Classics', 'Wiseguys, heists, and family business — crime cinema’s golden run through the ’80s and ’90s.',
        (m, y) => has(m, 'Crime') && y >= 1980 && y < 2000 && none(m, ['Animation', 'Documentary', 'Family', 'Romance'])],
      ['90s Action', 'Big explosions, bigger one-liners — pure ’90s adrenaline.',
        (m, y) => has(m, 'Action') && y >= 1990 && y < 2000 && none(m, ['Animation', 'Documentary', 'Romance', 'Family'])],
      ['80s Adventure', 'Whip-cracking, treasure-hunting, world-saving ’80s spirit.',
        (m, y, mins, r) => (has(m, 'Adventure') || has(m, 'Action')) && y >= 1980 && y < 1990 && r >= 6.5 && none(m, ['Animation', 'Documentary', 'Horror', 'Romance'])],
      ['Quick Action', 'All killer, no filler — action that wraps inside two hours.',
        (m, y, mins) => has(m, 'Action') && mins > 0 && mins <= 110 && none(m, ['Animation', 'Documentary', 'Romance', 'Family'])],
      ['Date Night: Classic', 'Old-school charm — romance and wit from Hollywood’s earlier eras.',
        (m, y, mins, r) => (has(m, 'Romance') || has(m, 'Comedy')) && y > 0 && y < 1980 && r >= 7 && none(m, ['Horror', 'Animation', 'Documentary', 'War'])],
      ['Date Night: Fun', 'Low-stakes laughs to share — nothing heavy, everything fun.',
        (m, y, mins, r) => has(m, 'Comedy') && (has(m, 'Romance') || has(m, 'Adventure') || has(m, 'Action')) && y >= 1995 && r >= 6.8 && mins > 0 && mins <= 130 && none(m, ['Horror', 'Animation', 'Documentary'])],
      ['Date Night: Romance', 'Love stories that earn the couch cuddle.',
        (m, y, mins, r) => has(m, 'Romance') && r >= 7 && mins > 0 && mins <= 145 && none(m, ['Horror', 'Animation', 'Documentary', 'Action', 'War'])],
      ['New Rom-Coms', 'Modern meet-cutes — 2010 and later.',
        (m, y) => has(m, 'Romance') && has(m, 'Comedy') && y >= 2010 && none(m, ['Horror', 'Animation', 'Documentary'])],
      ['2000s Rom-Coms', 'Frosted tips, flip phones, and falling in love — the 2000s way.',
        (m, y) => has(m, 'Romance') && has(m, 'Comedy') && y >= 2000 && y < 2010 && none(m, ['Horror', 'Animation', 'Documentary'])],
      ['Rom-Coms', 'Meet-cutes across the decades.',
        (m) => has(m, 'Romance') && has(m, 'Comedy') && none(m, ['Horror', 'Animation', 'Documentary'])],
      ['90s Comedies', 'Slackers, road trips, and endlessly quotable one-liners.',
        (m, y) => has(m, 'Comedy') && y >= 1990 && y < 2000 && none(m, ['Horror', 'Animation', 'Documentary'])],
      ['Feel-Good', 'Guaranteed mood-lifters — funny, warm, and easy to watch.',
        (m, y, mins, r) => has(m, 'Comedy') && r >= 7 && mins > 0 && mins <= 110 && none(m, ['Horror', 'Documentary', 'War'])],
      ['Nail-Biters', 'Tense, twisty, edge-of-the-seat.',
        (m, y, mins, r) => has(m, 'Thriller') && (has(m, 'Crime') || has(m, 'Mystery')) && r >= 6.8 && none(m, ['Animation', 'Documentary', 'Romance', 'Family'])],
      ['Mindbenders', 'Science fiction that rewires your brain on the way out.',
        (m, y, mins, r) => has(m, 'Science Fiction') && (has(m, 'Thriller') || has(m, 'Mystery') || has(m, 'Drama')) && r >= 7 && none(m, ['Animation', 'Documentary', 'Family'])],
      ['Space & Beyond', 'Strap in — voyages past the atmosphere.',
        (m) => has(m, 'Science Fiction') && has(m, 'Adventure') && none(m, ['Documentary'])],
      ['Family Night', 'Safe for the whole crew — animated favourites and family classics.',
        (m, y, mins, r) => (has(m, 'Family') || has(m, 'Animation')) && r >= 6.5 && none(m, ['Horror', 'Thriller'])],
      ['Horror Nights', 'Lights off. Volume up. Good luck.',
        (m, y, mins, r) => has(m, 'Horror') && r >= 6 && none(m, ['Documentary', 'Family'])],
      ['War Stories', 'From the trenches to the home front.',
        (m) => has(m, 'War') && none(m, ['Animation', 'Documentary'])],
      ['70s New Hollywood', 'The auteurs’ decade — gritty, personal, revolutionary.',
        (m, y, mins, r) => y >= 1970 && y < 1980 && r >= 7.2 && none(m, ['Animation', 'Documentary', 'Family'])],
      ['Old Hollywood', 'Black-and-white brilliance and technicolor dreams — pre-1970.',
        (m, y, mins, r) => y > 0 && y < 1970 && r >= 7 && none(m, ['Documentary'])],
      ['Masterpieces', 'Modern all-timers — the best-reviewed films since 2010.',
        (m, y, mins, r) => y >= 2010 && r >= 8.0 && none(m, ['Documentary'])],
      ['Animation Greats', 'Animated films that stand with the best of anything.',
        (m, y, mins, r) => has(m, 'Animation') && r >= 7.3],
      ['Fantasy Adventures', 'Dragons, quests, and enchanted lands — where imagination runs wild.',
        (m) => has(m, 'Fantasy') && has(m, 'Adventure') && none(m, ['Animation', 'Documentary', 'Family'])],
      ['True Stories', 'Based on real events — history brought to life through film.',
        (m, y, mins, r) => has(m, 'History') && has(m, 'Drama') && none(m, ['Fantasy', 'Animation', 'Documentary', 'Science Fiction'])],
      ['Western Roundup', 'Six-shooters, saloons, and vast landscapes — the American frontier on film.',
        (m, y, mins, r) => has(m, 'Western') && none(m, ['Documentary', 'Animation'])],
      ['Music & Musicals', 'Where music takes center stage — biopics, showstoppers, and rhythm-driven stories.',
        (m) => has(m, 'Music') && none(m, ['Documentary'])],
      ['Heists & Capers', 'The perfect plan, the big score, and the getaway — crime that thrills.',
        (m) => has(m, 'Crime') && has(m, 'Thriller') && none(m, ['Romance', 'Documentary', 'Animation', 'Fantasy'])],
      ['Mafia Epics', 'The families, the power, and the price — organized crime on the grandest scale.',
        (m, y, mins) => has(m, 'Crime') && has(m, 'Drama') && mins >= 140 && none(m, ['Comedy', 'War', 'Documentary'])],
      ['Cool Crime', 'Snappy dialogue, unforgettable characters, and style to burn — crime with a wink.',
        (m, y, mins) => has(m, 'Crime') && has(m, 'Comedy') && has(m, 'Drama') && mins <= 140 && none(m, ['Animation', 'Documentary', 'Horror'])],
      ['Caper Comedy', 'Witty cons, elaborate schemes, and the perfect payoff — crime that makes you laugh.',
        (m) => has(m, 'Comedy') && has(m, 'Crime') && none(m, ['Horror', 'Documentary', 'Animation', 'War'])],
      ['Noir Nights', 'Shadows, femmes fatales, and moral ambiguity — crime cinema at its darkest.',
        (m) => has(m, 'Crime') && has(m, 'Drama') && has(m, 'Mystery') && none(m, ['Animation', 'Documentary', 'Family'])],
      ['Buddy Action', 'Partners in crime-fighting — banter, explosions, and unlikely alliances.',
        (m) => has(m, 'Action') && has(m, 'Comedy') && none(m, ['Animation', 'Documentary', 'Family'])],
      ['Action Thrillers', 'Heart-pounding stakes and high-octane set-pieces — action that keeps you gripping the armrest.',
        (m) => has(m, 'Action') && has(m, 'Thriller') && none(m, ['Fantasy', 'Animation', 'Documentary'])],
      ['Spycraft', 'Secret agents, double-crosses, and global intrigue — the art of espionage.',
        (m) => has(m, 'Thriller') && has(m, 'Adventure') && none(m, ['Science Fiction', 'Fantasy', 'Animation', 'Documentary', 'Horror'])],
      ['Dystopian', 'Dark visions of what comes next — sci-fi that stares into the abyss.',
        (m) => has(m, 'Science Fiction') && (has(m, 'Thriller') || has(m, 'Drama')) && none(m, ['Animation', 'Documentary', 'Family'])],
      ['Slashers & Stalkers', 'Masked killers, body counts, and survival horror at its most visceral.',
        (m) => has(m, 'Horror') && has(m, 'Thriller') && none(m, ['Science Fiction', 'Fantasy', 'Documentary', 'Family', 'Animation', 'Adventure'])],
      ['Rip-Roaring Adventures', 'Thrills, chills, and non-stop entertainment — pure fun from start to finish.',
        (m) => has(m, 'Adventure') && has(m, 'Action') && none(m, ['Drama', 'Horror', 'Documentary', 'Animation', 'War'])],
      ['Fun Sci-Fi', 'Warp drives, time machines, and wisecracking robots — sci-fi that\'s pure fun.',
        (m, y, mins) => has(m, 'Science Fiction') && has(m, 'Adventure') && mins > 0 && mins <= 145 && none(m, ['Horror', 'Documentary', 'Family'])],
      ['Sweeping Romance', 'Grand love stories across turbulent times — epic romance at its most passionate.',
        (m, y, mins, r) => has(m, 'Romance') && has(m, 'Drama') && mins >= 120 && none(m, ['Comedy', 'Action', 'Horror', 'Animation'])],
      ['Top Docs', 'True stories, brilliantly told.',
        (m, y, mins, r) => has(m, 'Documentary') && r >= 7.5],
    ];
    for (const m of movies) {
      const y = m.ProductionYear || 0;
      const mins = m.RunTimeTicks ? Math.round(m.RunTimeTicks / 600000000) : 0;
      const r = m.CommunityRating || 0;
      if (y >= 1950) {
        const d = Math.floor(y / 10) * 10;
        const label = d >= 2000 ? `${d}s` : `${String(d).slice(2)}s`;
        add(`${label} Movies`, `The library’s ${label} time capsule — everything we have from the decade.`, m.Id);
      }
      if (r >= 7.5) add('Critically Loved', 'The highest-rated films on the shelf. No duds allowed.', m.Id);
      if (mins > 0 && mins <= 100) add('Short & Sweet', 'Ninety-odd minutes, zero commitment.', m.Id);
      if (mins >= 150) add('Epics', 'Settle in — sagas that take their time and earn it.', m.Id);
      for (const [name, desc, test] of VIBES) if (test(m, y, mins, r)) add(name, desc, m.Id);
      const tmdb = m.ProviderIds?.Tmdb;
      if (tmdb && oscarWinners) {
        for (const [colName, items] of Object.entries(oscarWinners)) {
          if (items.some(i => String(i.tmdb_id) === String(tmdb))) {
            if (!oscarBuckets.has(colName)) oscarBuckets.set(colName, { items: new Map(), desc: OSCAR_DESC[colName] || colName });
            oscarBuckets.get(colName).items.set(m.Id, m.ProductionYear || 0);
          }
        }
      }
      if (tmdb && intlLanguages && intlLanguages[tmdb] && !has(m, 'Animation')) {
        add('International Films', 'Stories from around the world — cinema beyond English.', m.Id);
      }
      // Individual person/studio collections
      for (const p of m.People || []) {
        const pn = (p.Name || '').toLowerCase();
        const an = ACTOR_MAP.get(pn);
        if (p.Type === 'Actor' && an) pbAdd(an, `${an} — one of cinema’s most celebrated actors.`, m.Id, y);
        const dn = DIRECTOR_MAP.get(pn);
        if (p.Type === 'Director' && dn) pbAdd(dn, `Directed by ${dn} — visionary filmmaking.`, m.Id, y);
        if (p.Type === 'Director') {
          for (const [groupName, members] of DIRECTOR_GROUPS) {
            if (members.includes(pn)) pbAdd(groupName, `${groupName} — the sum is greater than the parts.`, m.Id, y);
          }
        }
        const cn = COMPOSER_MAP.get(pn);
        if (p.Type === 'Composer' && cn) pbAdd(cn, `Music by ${cn} — unforgettable scores.`, m.Id, y);
        const wn = WRITER_MAP.get(pn);
        if (p.Type === 'Writer' && wn) pbAdd(wn, `Written by ${wn} — masterful storytelling.`, m.Id, y);
      }
      for (const s of m.Studios || []) {
        const sn = (s.Name || '').toLowerCase();
        const cn = STUDIO_ALIASES.get(sn);
        if (cn) pbAdd(cn, cn === 'A24' ? 'A24 — bold, distinctive storytelling.' : cn === 'Ghibli' ? 'Studio Ghibli — the magic of Miyazaki and beyond.' : 'Pixar — animated masterpieces from the house that Woody built.', m.Id, y);
      }
    }
    for (const [name, b] of [...buckets]) if (b.ids.size < 5) buckets.delete(name);
    // Per-person Jellyfin queries for cinematographers and editors (not in People field)
    for (const person of CINEMATOGRAPHERS) {
      try {
        const pq = new URLSearchParams({ IncludeItemTypes: 'Movie', Person: person, Limit: '200', Fields: 'ProductionYear' });
        const items = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${pq}`, { headers: h }, 30000)).Items) || [];
        if (items.length >= 5) personBuckets.set(person, { items: new Map(items.map((m) => [m.Id, m.ProductionYear || 0])), desc: `Shot by ${person} — stunning cinematography.` });
      } catch (e) { console.log(`personQuery: ${person} failed — ${e.message || e}`); }
    }
    for (const person of EDITORS) {
      try {
        const pq = new URLSearchParams({ IncludeItemTypes: 'Movie', Person: person, Limit: '200', Fields: 'ProductionYear' });
        const items = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${pq}`, { headers: h }, 30000)).Items) || [];
        if (items.length >= 5) personBuckets.set(person, { items: new Map(items.map((m) => [m.Id, m.ProductionYear || 0])), desc: `Edited by ${person} — masterful storytelling through cuts.` });
      } catch (e) { console.log(`personQuery: ${person} failed — ${e.message || e}`); }
    }
    // Poster per collection: a RANDOM pick from its five best-rated members, re-rolled every
    // sweep — shelves get fresh faces twice a day instead of a frozen thumbnail.
    const byId = new Map(movies.map((m) => [m.Id, m]));
    const posterPick = (want) => {
      const top = [...want].map((x) => byId.get(x)).filter(Boolean)
        .sort((a, b) => (b.CommunityRating || 0) - (a.CommunityRating || 0)).slice(0, 5);
      return top[Math.floor(Math.random() * top.length)];
    };
    const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    // DisplayOrder=Default makes Jellyfin honor STORED membership order (verified 2026-07-02)
    // — so re-writing membership shuffled = genuinely random browse order, refreshed each
    // sweep. Same dto update carries the flowery Overview.
    const ensureMeta = async (setId, desc, retries = 2) => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const dto = await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items/${setId}`, { headers: h }, 15000)).json();
          if (dto.DisplayOrder !== 'Default' || (desc && dto.Overview !== desc)) {
            dto.DisplayOrder = 'Default';
            if (desc) dto.Overview = desc;
            const r = await tfetch(`${HOST.jellyfin}/Items/${setId}`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(dto) }, 30000);
            if (r.ok || r.status === 204) break;
          } else break;
        } catch (e) { if (attempt === retries) console.log(`ensureMeta: failed after ${retries + 1} attempts — ${e.message || e}`); }
      }
    };
    const setPoster = async (setId, memberId) => {
      const ir = await tfetch(`${HOST.jellyfin}/Items/${memberId}/Images/Primary?maxWidth=600&quality=90`, {}, 15000);
      if (!ir.ok) return false;
      const b64 = Buffer.from(await ir.arrayBuffer()).toString('base64');
      const ur = await tfetch(`${HOST.jellyfin}/Items/${setId}/Images/Primary`, { method: 'POST', headers: { ...h, 'Content-Type': ir.headers.get('content-type') || 'image/jpeg' }, body: b64 }, 20000);
      return ur.ok;
    };
    const bq = new URLSearchParams({ IncludeItemTypes: 'BoxSet', Recursive: 'true', Limit: '500' });
    const sets = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${bq}`, { headers: h }, 45000)).Items) || [];
    const byName = new Map(sets.map((s) => [s.Name, s.Id]));
    // Retire the earlier plain-genre collections (redundant with the Genres tab). Explicit
    // name list so a TMDb franchise box set can never be caught by accident.
    const RETIRED = new Set([
      ...['Action', 'Adventure', 'Comedy', 'Crime', 'Drama', 'Romance', 'Science Fiction', 'Thriller', 'Horror', 'Animation', 'Family', 'Documentary', 'Fantasy', 'Mystery', 'War', 'Western', 'Music'].map((g) => `${g} Movies`),
      // superseded by the short-titled / era-dialed vibes
      'Date Night', 'Mob & Crime Classics (80s–90s)', '90s Action Blockbusters', 'Short Action Fix',
      'Old-School Date Night', 'Fun Date Night', 'Romantic Evening', 'Modern Rom-Coms (2010s+)',
      'Rom-Coms Through the Ages', 'Feel-Good Comedies', 'Edge-of-Seat Thrillers', 'Sci-Fi Mindbenders',
      'Family Movie Night', 'Old Hollywood (pre-70s)', 'Modern Masterpieces', '80s Adventure Classics',
      'Documentaries that Wow', 'Epic Runtimes',
      // Oscar collections renamed with (Winners)/(Nominees) suffixes
      'Oscar: Best Picture', 'Oscar: Best Director', 'Oscar: Best Actor', 'Oscar: Best Actress',
      'Oscar: Best Supporting Actor', 'Oscar: Best Supporting Actress',
      'Oscar: Best Film Editing', 'Oscar: Best Cinematography',
      // Grouped person collections → replaced by individual ones
      'Great Actors', 'Great Directors', 'Great Cinematographers', 'Great Editors',
      // Old aliased studio names → replaced by direct names
      'Studio: A24', 'Studio: Ghibli', 'Studio: Pixar',
      // Only 1 doc in the library, not worth its own shelf
      'Top Docs',
    ]);
    // Fix DisplayOrder for all existing collections first, regardless of load.
    for (const s of sets) {
      if (!RETIRED.has(s.Name)) await ensureMeta(s.Id).catch(() => {});
    }
    let removed = 0;
    for (const s of sets) {
      if (RETIRED.has(s.Name) && !buckets.has(s.Name)) {
        try { const r = await tfetch(`${HOST.jellyfin}/Items/${s.Id}`, { method: 'DELETE', headers: h }, 15000); if (r.ok || r.status === 204) removed++; } catch { /* */ }
      }
    }
    let created = 0, updated = 0, postered = 0;
    for (const [name, { ids: want, desc }] of buckets) {
      let setId = byName.get(name);
      if (!setId) {
        const r = await tfetch(`${HOST.jellyfin}/Collections?${new URLSearchParams({ Name: name, Ids: shuffle([...want]).join(',') })}`, { method: 'POST', headers: h }, 20000);
        if (!r.ok) continue;
        created++;
        try { setId = (await r.json()).Id; } catch { setId = null; }
        if (!setId) continue;
        await ensureMeta(setId, desc);
        const pick = posterPick(want);
        if (pick && await setPoster(setId, pick.Id).catch(() => false)) postered++;
        continue;
      }
      await ensureMeta(setId, desc);
      // Full rewrite in shuffled order: reconciles membership AND re-rolls the browse order.
      const cq = new URLSearchParams({ ParentId: setId, Limit: '5000' });
      const have = (((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${cq}`, { headers: h }, 15000)).json()).Items) || []).map((i) => i.Id);
      if (have.length) await tfetch(`${HOST.jellyfin}/Collections/${setId}/Items?Ids=${have.join(',')}`, { method: 'DELETE', headers: h }, 30000);
      await tfetch(`${HOST.jellyfin}/Collections/${setId}/Items?Ids=${shuffle([...want]).join(',')}`, { method: 'POST', headers: h }, 30000);
      updated++;
      const pick = posterPick(want);
      if (pick && await setPoster(setId, pick.Id).catch(() => false)) postered++;
    }
    // Oscar winner collections: year-descending order (newest first), never shuffled.
    for (const [colName, { items, desc }] of oscarBuckets) {
      const sorted = [...items.entries()].sort((a, b) => b[1] - a[1]);
      const want = new Set(sorted.map(([id]) => id));
      let setId = byName.get(colName);
      if (!setId) {
        const ids = [...want];
        // create collection with first chunk; add remaining chunks to it
        const first = ids.slice(0, 100);
        const r = await tfetch(`${HOST.jellyfin}/Collections?${new URLSearchParams({ Name: colName, Ids: first.join(',') })}`, { method: 'POST', headers: h }, 45000);
        if (!r.ok) continue;
        created++;
        try { setId = (await r.json()).Id; } catch { setId = null; }
        if (!setId) continue;
        for (let i = 100; i < ids.length; i += 100) {
          await tfetch(`${HOST.jellyfin}/Collections/${setId}/Items?Ids=${ids.slice(i, i + 100).join(',')}`, { method: 'POST', headers: h }, 45000);
        }
        await ensureMeta(setId, desc);
        const pick = posterPick(want);
        if (pick && await setPoster(setId, pick.Id).catch(() => false)) postered++;
        continue;
      }
      await ensureMeta(setId, desc);
      const cq = new URLSearchParams({ ParentId: setId, Limit: '5000' });
      const have = (((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${cq}`, { headers: h }, 30000)).json()).Items) || []).map((i) => i.Id);
      if (have.length) {
        for (let i = 0; i < have.length; i += 100) {
          await tfetch(`${HOST.jellyfin}/Collections/${setId}/Items?Ids=${have.slice(i, i + 100).join(',')}`, { method: 'DELETE', headers: h }, 45000);
        }
      }
      const ids = [...want];
      for (let i = 0; i < ids.length; i += 100) {
        await tfetch(`${HOST.jellyfin}/Collections/${setId}/Items?Ids=${ids.slice(i, i + 100).join(',')}`, { method: 'POST', headers: h }, 45000);
      }
      updated++;
      const pick = posterPick(want);
      if (pick && await setPoster(setId, pick.Id).catch(() => false)) postered++;
    }
    // Person/studio collections: shuffled order, min 5 items.
    for (const [colName, { items, desc }] of personBuckets) {
      const want = shuffle([...items.keys()]);
      if (want.length < 5) continue;
      let setId = byName.get(colName);
      if (!setId) {
        const first = want.slice(0, 100);
        const r = await tfetch(`${HOST.jellyfin}/Collections?${new URLSearchParams({ Name: colName, Ids: first.join(',') })}`, { method: 'POST', headers: h }, 45000);
        if (!r.ok) continue;
        created++;
        try { setId = (await r.json()).Id; } catch { setId = null; }
        if (!setId) continue;
        for (let i = 100; i < want.length; i += 100) {
          await tfetch(`${HOST.jellyfin}/Collections/${setId}/Items?Ids=${want.slice(i, i + 100).join(',')}`, { method: 'POST', headers: h }, 45000);
        }
        await ensureMeta(setId, desc);
        const pick = posterPick(new Set(want));
        if (pick && await setPoster(setId, pick.Id).catch(() => false)) postered++;
        continue;
      }
      await ensureMeta(setId, desc);
      const cq = new URLSearchParams({ ParentId: setId, Limit: '5000' });
      const have = (((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${cq}`, { headers: h }, 30000)).json()).Items) || []).map((i) => i.Id);
      if (have.length) {
        for (let i = 0; i < have.length; i += 100) {
          await tfetch(`${HOST.jellyfin}/Collections/${setId}/Items?Ids=${have.slice(i, i + 100).join(',')}`, { method: 'DELETE', headers: h }, 45000);
        }
      }
      for (let i = 0; i < want.length; i += 100) {
        await tfetch(`${HOST.jellyfin}/Collections/${setId}/Items?Ids=${want.slice(i, i + 100).join(',')}`, { method: 'POST', headers: h }, 45000);
      }
      updated++;
      const pick = posterPick(new Set(want));
      if (pick && await setPoster(setId, pick.Id).catch(() => false)) postered++;
    }
    if (created || updated || postered || removed) console.log(`collectionsSweep: ${created} created, ${updated} reshuffled, ${postered} poster(s) rotated, ${removed} retired (${buckets.size} auto-collections, ${oscarBuckets.size} Oscar, ${personBuckets.size} person/studio collections)`);
  } catch (e) { console.log(`collectionsSweep: failed — ${e.message || e}`); }
  finally { collSweepBusy = false; }
}
setInterval(collectionsSweep, 6 * 3600000);   // twice a day keeps them fresh

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
}
setTimeout(bootSequence, 15000);   // let the container settle, then self-heal the home page

// ── Metrics: system + disk + dl summary (no HTTP — lightweight) ──
// Sampled independently from service probes so CPU/temp readings aren't
// contaminated by the sweep's own HTTP load. First stab at 2s, offset
// from service probes by 5s.
function recordSystemMetrics() {
  metrics.recordSystem(_cpuPct, readMemPct(), readTempC());
  try {
    const s = fs.statfsSync('/data');
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const used = total - free;
    const pct = total > 0 ? Math.round((used / total) * 100) : 0;
    metrics.recordDisk(Math.round(total / (1024*1024*1024)), Math.round(used / (1024*1024*1024)), Math.round(free / (1024*1024*1024)), pct);
  } catch { /* disk check failed */ }
  if (_dl.summary) metrics.recordDlSummary(_dl.summary);
}
// Fire at 2s, then every 10s via a chained setInterval so the first
// callback and all subsequent repeats keep a consistent offset.
setTimeout(() => { recordSystemMetrics(); setInterval(recordSystemMetrics, 10000); }, 2000);

// ── Metrics: service uptime (HTTP probes, 5s STAGGERED from system) ──
// CPU readings are taken 5s apart from HTTP probes, so the metrics
// reflect real system load, not the cost of collecting them.
let _lastServiceStates = {};
async function recordServiceMetrics() {
  const curStates = {};
  for (const s of STATUS_SERVICES) {
    let up = false;
    try { const r = await tfetch(s.url, { headers: s.headers ? s.headers() : {} }, 4000); up = true; } catch { /* down */ }
    curStates[s.id] = up;
  }
  try { await tfetch(`${HOST.jellyfin}/System/Info`, {}, 4000); curStates.jellyfin = true; } catch { curStates.jellyfin = false; }
  try { await tfetch(`${HOST.jellyseerr}/api/v1/status`, {}, 4000); curStates.jellyseerr = true; } catch { curStates.jellyseerr = false; }
  metrics.recordServices(curStates);
  for (const [id, up] of Object.entries(curStates)) {
    const prev = _lastServiceStates[id];
    if (prev !== undefined && prev !== up) {
      metrics.emitEvent(up ? 'svc_up' : 'svc_down', { svc: id });
    }
  }
  _lastServiceStates = curStates;
}
// Fire at 7s (5s after system first fire), then every 10s.
setTimeout(() => { recordServiceMetrics(); setInterval(recordServiceMetrics, 30000); }, 7000);   // 30s (was 10s): service up/down is meaningful at 30s; cuts Jellyfin auth-challenge frequency ~67%

// Metrics query endpoint
app.get('/api/metrics', (req, res) => {
  const stream = req.query.stream;
  if (!stream) return res.json({ streams: metrics.listStreams() });
  const from = Number(req.query.from) || 0;
  const to = Number(req.query.to) || Infinity;
  const limit = Math.min(Number(req.query.limit) || 10000, 50000);
  const data = metrics.queryMetrics(stream, { from, to, limit });
  const info = metrics.listStreams()[stream] || {};
  res.json({ stream, data, info, count: data.length });
});

// Manual kick: build/refresh collections, then re-register the home shelves that read them.
// Handy right after a boot — the scheduled sweep is 3 min out and shelves need the box sets to
// exist first. POST (no body) → runs synchronously and reports; 409 if a sweep is already running.
app.post('/api/collections/build', async (_req, res) => {
  if (collSweepBusy) return res.status(409).json({ ok: false, error: 'sweep already running' });
  try {
    await collectionsSweep();
    await registerHssShelf();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

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
      const obj = { declined: {}, blocked: {}, searchState: {}, gpuSwapped: {}, gpuPending: {}, masterPaused, forceGrabImport: {}, completedForceGrabs: {} };
      for (const [k, v] of declined) obj.declined[k] = v;
      for (const [k, v] of blocked) obj.blocked[k] = v;
      for (const [k, v] of searchState) obj.searchState[k] = v;
      for (const [k, v] of gpuSwapped) obj.gpuSwapped[k] = v;
      for (const [k, v] of gpuPending) obj.gpuPending[k] = v;
      for (const [k, v] of forceGrabImport) obj.forceGrabImport[k] = v;
      for (const [k, v] of completedForceGrabs) obj.completedForceGrabs[k] = v;
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
    // Lowercase keys on load to migrate any pre-fix state written with an UPPERCASE infoHash.
    if (obj.forceGrabImport) for (const [k, v] of Object.entries(obj.forceGrabImport)) forceGrabImport.set(String(k).toLowerCase(), v);
    if (obj.completedForceGrabs) for (const [k, v] of Object.entries(obj.completedForceGrabs)) completedForceGrabs.set(String(k).toLowerCase(), v);
  } catch { /* */ }
}
loadState();

// Recover forceGrabImport from qBittorrent torrents tagged manual-force-grab.
// Runs early (before bootSequence / collectionsSweep) so the watchdog pre-pass
// can retry imports immediately after a controller restart.
async function recoverForceGrabImport() {
  try {
    const fgTorrents = await getQbitTorrents();
    for (const t of fgTorrents) {
      const tags = t.tags || '';
      if (!tags.includes('manual-force-grab')) continue;
      const h = (t.hash || '').toLowerCase();
      if (forceGrabImport.has(h) || completedForceGrabs.has(h)) continue; // already tracked or already fully imported
      let seriesTitle = null, seriesId = null;
      if (t.content_path) {
        const folderName = path.basename(t.content_path);
        const cleaned = folderName.replace(/\.\w+$/, '').replace(/[\(\)]/g, '').trim();
        seriesTitle = cleaned;
        try {
          const seriesList = await arrGet('sonarr', '/series', 8000);
          if (Array.isArray(seriesList)) {
            const n = (x) => String(x || '').toLowerCase().replace(/[._'’:()\-]/g, ' ').replace(/\s+/g, ' ').trim();
            // Title match is ambiguous when two series share a name (e.g. Cosmos 1980 vs Cosmos
            // 2014). Collect every title match, then disambiguate by a year token in the folder
            // name — a wrong bind here would import the whole pack into the wrong series.
            const cands = seriesList.filter((s) => n(cleaned).includes(n(s.title)) || n(s.title).includes(n(cleaned)));
            const years = (cleaned.match(/\b(19|20)\d{2}\b/g) || []).map(Number);
            const byYear = years.length ? cands.find((s) => s.year && years.includes(s.year)) : null;
            const pick = byYear || (cands.length === 1 ? cands[0] : null); // don't guess when ambiguous and no year to break the tie
            if (pick) { seriesTitle = pick.title; seriesId = pick.id; }
          }
        } catch { /* best-effort */ }
      }
      if (seriesId != null) {
        forceGrabImport.set(h, { app: 'sonarr', id: seriesId, seriesTitle: seriesTitle || 'Unknown', folder: t.content_path || null });
        console.log(`recover: force-grab → sonarr id=${seriesId} "${seriesTitle || '?'}" (${h.slice(0, 12)}…)`);
      }
    }
    // Prune completedForceGrabs whose torrent is gone from qBittorrent — the row can't render
    // anymore, so the entry is dead weight in state.json. (Force-grabs are rare; this just keeps
    // the persisted map from accreting hashes forever.)
    let pruned = false;
    const liveHashes = new Set(fgTorrents.map((t) => (t.hash || '').toLowerCase()));
    for (const h of completedForceGrabs.keys()) if (!liveHashes.has(h)) { completedForceGrabs.delete(h); pruned = true; }
    if (forceGrabImport.size || pruned) persistState();
  } catch (e) { console.log('recover: forceGrabImport error —', e.message || e); }
}
setTimeout(recoverForceGrabImport, 4000);  // after loadState, before 1st watchdog at ~6s

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
setInterval(diskGate, 30000); // 30s (was 8s); cheap (qbit info + statfs); 30s still catches a new torrent before it fills /data (3.7TB headroom)
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
setInterval(orphanSweep, 300000);   // every 5 min (was 60s); orphan torrents are harmless and don't trend in under 5 min
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
setInterval(seerrSweep, 900000); // every 15 min (was 5min); orphan cleanup doesn't need 5min resolution
setTimeout(seerrSweep, 30000);   // first run after 30s

// ---- *arr sweep: auto-recover stuck queue items + trigger search for missing monitored items ----
let arrSweepBusy = false;
// searchState is declared up by `declined` (must exist before loadState() runs). Tuning knobs:
const SEARCH_COOLDOWN_MS = 6 * 3600000;        // 6h between recovery re-searches of the same item
const SEARCH_FAIL_LIMIT = 4;                   // after this many fruitless searches → negative-cache it
const SEARCH_BLOCK_MS = 7 * 24 * 3600 * 1000;  // ...for a week (a manual /api/retry clears it sooner)
const SWEEP_MAX_ACTIVE_DL = 10;                // capacity guard: no new searches while this many download
const BLOCKLIST_TTL_MS = 12 * 3600 * 1000;    // 12h — blocklisted releases auto-cleared so a temporarily-dead swarm doesn't permanently poison the well
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
  if (!st.firstMissing) {
    st.firstMissing = Date.now();
    searchState.set(k, st);
    metrics.emitEvent('missing_start', { ap: app, id });
  }
  return st.firstMissing;
}
function noteResolved(app, id) {  // item now has file/queue/torrent → reset the missing clock
  const k = `${app}:${id}`; const st = searchState.get(k);
  if (st && st.firstMissing) {
    st.firstMissing = 0;
    searchState.set(k, st);
    metrics.emitEvent('missing_clear', { ap: app, id });
  }
}
function touchSearchState(app, id, patch) {
  const k = `${app}:${id}`;
  const st = searchState.get(k) || {};
  Object.assign(st, patch);
  searchState.set(k, st);
  return st;
}
const DL_STATES = new Set(['downloading', 'stalledDL', 'metaDL', 'forcedDL', 'queuedDL', 'checkingDL', 'allocating']);
const searchKeyClear = (app, id) => searchState.delete(`${app}:${id}`); // manual retry overrides cooldown+block
// The specific episodes of a Sonarr series that still need a file: monitored, aired (or with no
// known air date), and not already on disk. This is what we hand to EpisodeSearch so a season with
// no pack fills in episode-by-episode. Returns [] on any error (skip this series this pass).
async function missingEpisodes(seriesId) {
  let eps;
  try { eps = await arrGet('sonarr', `/episode?seriesId=${seriesId}`, 8000); }
  catch { return []; }
  const now = Date.now();
  return (Array.isArray(eps) ? eps : [])
    .filter((e) => !e.hasFile && e.monitored && (!e.airDateUtc || new Date(e.airDateUtc).getTime() <= now))
    .map((e) => ({
      id: e.id,
      seasonNumber: e.seasonNumber,
      episodeNumber: e.episodeNumber,
      title: e.title || '',
    }));
}
const SEARCH_PROBE_INITIAL_MS = 12000;
const SEARCH_PROBE_RETRY_MS = 15000;
const SEARCH_PROBE_MAX_AGE_MS = 120000;
const SEARCH_PROBE_MAX_ATTEMPTS = 5;
const searchProbeTimers = new Map();

const normSearchText = (s) => String(s || '').toLowerCase().replace(/['’]/g, '').replace(/[._:()\-]/g, ' ').replace(/\s+/g, ' ').trim();
const searchTokens = (s) => normSearchText(s).split(' ').filter((t) => t.length > 1);

function searchProbeMatchesTarget(probe, rec) {
  if (!probe || !rec || !rec.data) return false;
  const source = probe.app === 'radarr' ? 'Radarr' : 'Sonarr';
  if (String(rec.data.source || '') !== source) return false;
  const query = normSearchText(rec.data.query || '');
  if (!query) return false;
  const probeText = normSearchText(probe.query || probe.title || '');
  const tokens = probe.tokens || [];
  if (probe.mode === 'EpisodeSearch' && String(rec.data.queryType || '').toLowerCase() !== 'tvsearch') return false;
  if (probe.mode === 'MoviesSearch' && String(rec.data.queryType || '').toLowerCase() === 'tvsearch') return false;
  if (probeText && (query === probeText || query.includes(probeText) || probeText.includes(query))) return true;
  if (tokens.length && tokens.every((t) => query.includes(t))) return true;
  return false;
}

function summarizeSearchOutcome(probe, stats) {
  const { hits, queries, errors, hitIndexers, failedIndexers, zeroHitIndexers, topHitIndexers } = stats;
  const hitCount = topHitIndexers.length;
  const zeroCount = zeroHitIndexers.length;
  if (errors > 0 && hits > 0) {
    const good = hitIndexers.slice(0, 3).join(', ');
    const bad = failedIndexers.slice(0, 3).join(', ');
    return {
      kind: 'partial',
      summary: `upstream found ${hits} hit${hits === 1 ? '' : 's'} but ${errors} indexer${errors === 1 ? '' : 's'} errored${good ? ` (${good})` : ''}${bad ? `; errors: ${bad}` : ''}`,
    };
  }
  if (errors > 0) {
    const names = failedIndexers.slice(0, 3).join(', ');
    return {
      kind: 'error',
      summary: names ? `upstream error from ${names}` : 'upstream indexer error',
    };
  }
  if (hits > 0) {
    const names = hitIndexers.slice(0, 3).join(', ');
    return {
      kind: 'found',
      summary: `upstream found ${hits} hit${hits === 1 ? '' : 's'} across ${hitCount} indexer${hitCount === 1 ? '' : 's'}${names ? ` (${names})` : ''}`,
    };
  }
  if (queries > 0) {
    const names = zeroCount ? zeroHitIndexers.slice(0, 3).join(', ') : '';
    return {
      kind: 'empty',
      summary: `upstream returned 0 hits from ${queries} query${queries === 1 ? '' : 'ies'}${names ? ` (${names})` : ''}`,
    };
  }
  return { kind: 'pending', summary: 'search dispatched; waiting for Prowlarr history' };
}

function probeSearchSeasons(probe, st) {
  const seasons = new Set();
  const fromProbe = Array.isArray(probe && probe.seasons) ? probe.seasons : [];
  for (const s of fromProbe) {
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) seasons.add(n);
  }
  const episodeCodes = (st && st.lastSearchEpisodes) || [];
  for (const code of episodeCodes) {
    const m = String(code || '').match(/S(\d{2})E(\d{2})/i);
    if (m) seasons.add(Number(m[1]));
  }
  return [...seasons].sort((a, b) => a - b);
}

function summarizeReleaseDecision(rows) {
  const rels = Array.isArray(rows) ? rows : [];
  const rejected = [];
  const accepted = [];
  const reasonCounts = new Map();
  for (const r of rels) {
    const reasons = Array.isArray(r && r.rejections) && r.rejections.length
      ? r.rejections.map((x) => String(x || '').trim()).filter(Boolean)
      : (r && r.rejected ? ['rejected'] : []);
    if (r && r.rejected) {
      rejected.push(r);
      for (const reason of reasons) reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    } else if (r) {
      accepted.push(r);
    }
  }
  const sortByScore = (a, b) => (Number(b.customFormatScore) || 0) - (Number(a.customFormatScore) || 0)
    || (Number(b.seeders) || 0) - (Number(a.seeders) || 0)
    || String(a.title || a.sourceTitle || '').localeCompare(String(b.title || b.sourceTitle || ''));
  accepted.sort(sortByScore);
  rejected.sort(sortByScore);
  const reasonSummary = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([reason, count]) => `${reason} (${count})`)
    .join('; ');
  const bestAccepted = accepted[0] || null;
  const bestRejected = rejected[0] || null;
  if (accepted.length) {
    return {
      kind: 'accepted',
      summary: `Sonarr has ${accepted.length} acceptable release${accepted.length === 1 ? '' : 's'}${bestAccepted ? `; best is "${bestAccepted.title || bestAccepted.sourceTitle || 'candidate'}"` : ''}`,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      bestAccepted,
      bestRejected,
      reasons: reasonSummary,
    };
  }
  if (rejected.length) {
    const bestLabel = bestRejected ? (bestRejected.title || bestRejected.sourceTitle || 'candidate') : 'candidate';
    return {
      kind: 'rejected',
      summary: `Sonarr rejected all ${rejected.length} candidate${rejected.length === 1 ? '' : 's'}${reasonSummary ? `; top reasons: ${reasonSummary}` : ''}${bestRejected ? `; best rejected was "${bestLabel}"` : ''}`,
      acceptedCount: 0,
      rejectedCount: rejected.length,
      bestAccepted: null,
      bestRejected,
      reasons: reasonSummary,
    };
  }
  return {
    kind: 'none',
    summary: 'Sonarr returned no release candidates to evaluate',
    acceptedCount: 0,
    rejectedCount: 0,
    bestAccepted: null,
    bestRejected: null,
    reasons: '',
  };
}

// Clean a probe title ("Planet Earth (2006) — Seasons 1, 1, …") into a plain raw-search query
// ("planet earth 2006") and pull out the year for match-scoring.
function cleanSearchQuery(rawTitle) {
  const base = String(rawTitle || '').split(' — ')[0].trim();       // drop the " — Seasons …" suffix
  const ym = base.match(/(19|20)\d{2}/);
  const query = base.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  return { query, year: ym ? ym[0] : null };
}
const hasSeasonMarker = (t) => /s\d{1,2}e\d{1,3}|s\d{1,2}\b|season\s*\d+|\d+x\d+/i.test(String(t || ''));

// Mobile-first hint formatting: phones are the primary device, so row hints must be SHORT. Full
// detail stays in the event log / state for scripts. Collapse a verbose *arr rejection phrase to a
// couple of words.
function shortReason(r) {
  const s = String(r || '');
  if (/wrong series|unknown series|unable to identify/i.test(s)) return 'wrong/unknown series';
  if (/not enough seeders|no seeders/i.test(s)) return 'dead swarm';
  if (/meets cutoff|equal or higher preference/i.test(s)) return 'already have as good';
  if (/not wanted in profile/i.test(s)) return 'quality not allowed';
  if (/wasn.t requested|wrong season/i.test(s)) return 'season/episode mismatch';
  return s.replace(/\s*\(\d+\)\s*$/, '').replace(/:.*$/, '').trim().slice(0, 24);
}
// Truncate any free-text hint to a phone-friendly length.
const clampHint = (s, n = 68) => { const t = String(s || '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// THE SEARCH GAP: releases that are healthy upstream (raw Prowlarr text search) but never became
// Sonarr candidates — e.g. year-named full-series packs with no S01 marker, which structured
// tvsearch drops before the rejection list. `candidates` is Sonarr's /release set (to diff against).
async function probeSearchGap(rawTitle, candidates) {
  const { query, year } = cleanSearchQuery(rawTitle);
  if (!query) { console.log(`probeSearchGap: "${rawTitle}" → null (empty query)`); return null; }
  const titleTokens = searchTokens(query.replace(/(19|20)\d{2}/, '')); // series-name tokens, sans year
  let results = null;
  try {
    const url = `${HOST.prowlarr}/api/v1/search?query=${encodeURIComponent(query)}&type=search&limit=100`;
    results = await tfetchJson(url,
      { headers: { 'X-Api-Key': cfg.PROWLARR_KEY || '' } }, 25000).catch((e) => { console.log(`probeSearchGap: tfetchJson failed for "${query}": ${e?.message || e}`); return null; });
  } catch (e) { console.log(`probeSearchGap: catch for "${query}": ${e?.message || e}`); }
  if (!Array.isArray(results)) { console.log(`probeSearchGap: "${query}" → ${results ? 'non-array result' : 'null'} (candidates=${Array.isArray(candidates) ? candidates.length : 'N/A'})`); return null; }
  console.log(`probeSearchGap: "${query}" → ${results.length} raw results, candidates=${Array.isArray(candidates) ? candidates.length : 'N/A'}`);
  const candTitles = new Set((Array.isArray(candidates) ? candidates : [])
    .map((c) => normSearchText(c.title || c.sourceTitle || '')));
  const isTv = (r) => (r.categories || []).some((c) => { const n = Number(c && (c.id != null ? c.id : c)); return n >= 5000 && n < 6000; });
  const matchesSeries = (t) => { const nt = normSearchText(t); return titleTokens.every((tok) => nt.includes(tok)) && (!year || nt.includes(year)); };
  const filtered = results.filter((r) => Number(r.seeders) >= 1);
  const tvFiltered = filtered.filter((r) => isTv(r));
  const seriesFiltered = tvFiltered.filter((r) => matchesSeries(r.title));
  const misses = seriesFiltered.filter((r) => !candTitles.has(normSearchText(r.title)));
  console.log(`probeSearchGap: "${query}" → seeders>=1:${filtered.length} isTv:${tvFiltered.length} matchesSeries:${seriesFiltered.length} notInCandidates:${misses.length}`);
  if (!misses.length) { console.log(`probeSearchGap: "${query}" → null (no misses after all filters)`); return null; }
  misses.sort((a, b) => {
    // Grabbable releases (magnet guid or infoHash) sort above non-grabbable ones regardless of
    // seed count. A release with no magnet and no infoHash can only be grabbed via Prowlarr's
    // broken POST /api/v1/search path, so prefer the ones we can add to qBittorrent directly.
    const grabbable = (r) => String(r.guid || '').startsWith('magnet:') || !!r.infoHash;
    const ga = grabbable(a) ? 1 : 0, gb = grabbable(b) ? 1 : 0;
    if (ga !== gb) return gb - ga;
    const sa = Number(b.seeders) || 0, sb = Number(a.seeders) || 0;
    if (sa !== sb) return sa - sb;
    // Same seeder count: prefer releases with larger size (better quality).
    return (Number(b.size) || 0) - (Number(a.size) || 0);
  });
  const best = misses[0];
  const reasonClass = !hasSeasonMarker(best.title) ? 'no-season-marker' : 'not-a-candidate';
  return {
    query,
    upstreamHealthy: misses.length,
    reasonClass,
    best: {
      title: best.title,
      seeders: Number(best.seeders) || 0,
      indexer: best.indexer || null,
      guid: best.guid || null,
      indexerId: best.indexerId != null ? best.indexerId : null,
      magnetUrl: best.magnetUrl || null,
      infoHash: best.infoHash || null,
      size: best.size || null,
      downloadUrl: best.downloadUrl || null,
    },
    all: misses.map((r) => ({
      title: r.title,
      seeders: Number(r.seeders) || 0,
      size: r.size || 0,
      indexer: r.indexer || null,
      guid: r.guid || null,
      infoHash: r.infoHash || null,
      magnetUrl: r.magnetUrl || null,
      indexerId: r.indexerId != null ? r.indexerId : null,
      downloadUrl: r.downloadUrl || null,
    })),
    summary: `${misses.length} healthy release${misses.length === 1 ? '' : 's'} exist in raw search but were not season-search candidates (${reasonClass}); best: "${best.title}" (${Number(best.seeders) || 0} seeders)`,
  };
}

// Add a gap release straight to qBittorrent's queue. The release may come from any indexer;
// TPB results carry a magnet `guid`; for others we construct one from `infoHash`.
async function grabGapRelease(rel, category = 'sonarr') {
  let addUrl = null;
  let method = null;
  if (rel.guid && String(rel.guid).startsWith('magnet:')) {
    addUrl = rel.guid;
    method = 'magnet';
  } else if (rel.infoHash) {
    addUrl = `magnet:?xt=urn:btih:${String(rel.infoHash).toUpperCase()}&dn=${encodeURIComponent(String(rel.title || 'unknown'))}`;
    method = 'infohash';
  }
  if (!addUrl) throw new Error('gap release has no magnet guid or infoHash');
  const params = new URLSearchParams({ urls: addUrl, category, tags: 'manual-force-grab' });
  const r = await qbit.fetch('/api/v2/torrents/add', { method: 'POST', body: params }, 20000);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`qBittorrent add → HTTP ${r.status}${text ? ': ' + text.slice(0, 200) : ''}`);
  }
  // Lowercase ALWAYS: qBittorrent reports hashes lowercase and every consumer (buildDownloads,
  // watchdog, stall-recovery) looks up with t.hash.toLowerCase(). A release-supplied rel.infoHash
  // is often UPPERCASE — storing it as the forceGrabImport key uppercased meant every `.has(h)`
  // missed, so the guard/skip never engaged and the generic importer deleted the force-grab.
  const infoHash = String(rel.infoHash || (rel.guid || '').replace(/^magnet:\?xt=urn:btih:/i, '').split('&')[0]).toLowerCase();
  return { ok: true, method, addUrl, infoHash: infoHash || null };
}

function clearSearchProbe(key) {
  const t = searchProbeTimers.get(key);
  if (t) clearTimeout(t);
  searchProbeTimers.delete(key);
}

function trackSearchDispatch(app, item, meta = {}) {
  const key = `${app}:${item.id}`;
  clearSearchProbe(key);
  const now = meta.searchAt || Date.now();
  const st = searchState.get(key) || {};
  const probe = {
    id: (st.searchProbe && st.searchProbe.id || 0) + 1,
    at: now,
    title: item.title,
    query: meta.query || item.title || '',
    mode: meta.mode || (app === 'radarr' ? 'MoviesSearch' : 'EpisodeSearch'),
    manual: !!meta.manual,
    attempts: 0,
    tokens: searchTokens(meta.query || item.title || ''),
  };
  Object.assign(st, {
    lastReason: meta.manual ? 'manual_retry' : 'search',
    lastAt: now,
    lastMode: probe.mode,
    lastSearchTitle: item.title,
    lastSearchQuery: probe.query,
    lastOutcomeKind: meta.manual ? 'pending' : 'pending',
    lastOutcomeSummary: meta.manual ? 'manual retry in progress' : 'search in progress',
    lastOutcomeAt: now,
    searchProbe: probe,
  });
  if (meta.episodeCodes && meta.episodeCodes.length) st.lastSearchEpisodes = meta.episodeCodes;
  searchState.set(key, st);
  searchProbeTimers.set(key, setTimeout(() => probeSearchOutcome(app, item.id, probe.id), SEARCH_PROBE_INITIAL_MS));
  return st;
}

async function probeSearchOutcome(app, id, probeId) {
  const key = `${app}:${id}`;
  const st = searchState.get(key);
  if (!st || !st.searchProbe || st.searchProbe.id !== probeId) return;
  const probe = st.searchProbe;
  const age = Date.now() - probe.at;
  if (age > SEARCH_PROBE_MAX_AGE_MS) {
    // The probe never confirmed within its window (Prowlarr history never matched, or the
    // controller was restarted mid-probe and by the time we rehydrated it had aged out). Finalize
    // with an explicit terminal outcome so the row doesn't hang on "search in progress" forever.
    if (st.lastOutcomeKind === 'pending') {
      const summary = 'search dispatched; outcome unconfirmed (probe timed out)';
      Object.assign(st, { lastOutcomeKind: 'unknown', lastOutcomeSummary: summary, lastOutcomeAt: Date.now(), lastReason: 'search_unconfirmed' });
      searchState.set(key, st);
      persistState();
      metrics.emitEvent('search_outcome', { ap: app, id, ti: probe.title, mode: probe.mode, manual: probe.manual, kind: 'unknown', summary, attempt: probe.attempts || 0 });
    }
    clearSearchProbe(key);
    return;
  }
  let history = null;
  let indexers = null;
  try {
    [history, indexers] = await Promise.all([
      tfetchJson(`${HOST.prowlarr}/api/v1/history?pageSize=200&sortKey=date&sortDirection=descending`, { headers: { 'X-Api-Key': cfg.PROWLARR_KEY || '' } }, 8000).catch(() => null),
      cachedFetch('indexers:snapshot', 60000, getIndexerSnapshot, { degradedNames: [] }).catch(() => null),
    ]);
  } catch { /* best-effort */ }

  const rows = (history && history.records) || [];
  const idxById = new Map(((indexers && indexers.indexers) || []).map((ix) => [ix.id, ix.name]));
  const matched = rows.filter((r) => r.eventType === 'indexerQuery'
    && r.date
    && new Date(r.date).getTime() >= probe.at - 5000
    && new Date(r.date).getTime() <= Date.now() + 5000
    && searchProbeMatchesTarget(probe, r));

  if (!matched.length) {
    const nextAttempt = (probe.attempts || 0) + 1;
    probe.attempts = nextAttempt;
    st.searchProbe = probe;
    searchState.set(key, st);
    metrics.emitEvent('search_probe', { ap: app, id, ti: probe.title, mode: probe.mode, manual: probe.manual, attempt: nextAttempt, status: 'pending' });
    if (nextAttempt < SEARCH_PROBE_MAX_ATTEMPTS && age < SEARCH_PROBE_MAX_AGE_MS) {
      clearSearchProbe(key);
      searchProbeTimers.set(key, setTimeout(() => probeSearchOutcome(app, id, probeId), SEARCH_PROBE_RETRY_MS));
      return;
    }
    const summary = 'search dispatched; no matching Prowlarr history yet';
    Object.assign(st, { lastOutcomeKind: 'pending', lastOutcomeSummary: summary, lastOutcomeAt: Date.now() });
    searchState.set(key, st);
    persistState();
    metrics.emitEvent('search_outcome', { ap: app, id, ti: probe.title, mode: probe.mode, manual: probe.manual, kind: 'pending', summary, attempt: nextAttempt });
    clearSearchProbe(key);
    return;
  }

  const statsByIndexer = new Map();
  const indexerErrors = [];
  let hits = 0;
  let errors = 0;
  for (const r of matched) {
    const name = idxById.get(r.indexerId) || `indexer-${r.indexerId}`;
    const qRes = Number(r.data && r.data.queryResults) || 0;
    const cur = statsByIndexer.get(name) || { queries: 0, hits: 0, errors: 0, maxElapsed: 0 };
    cur.queries += 1;
    cur.hits += qRes;
    cur.errors += r.successful === false ? 1 : 0;
    cur.maxElapsed = Math.max(cur.maxElapsed, Number(r.data && r.data.elapsedTime) || 0);
    statsByIndexer.set(name, cur);
    hits += qRes;
    if (r.successful === false) {
      errors += 1;
      indexerErrors.push({
        indexer: name,
        query: r.data && r.data.query || null,
        reason: r.data && (r.data.errorMessage || r.data.message || r.data.error || r.data.exception || r.data.responseMessage) || 'indexer query failed',
        status: r.data && (r.data.statusCode || r.data.status || r.data.httpStatus) || null,
        url: r.data && r.data.url || null,
      });
    }
  }
  const hitIndexers = [];
  const failedIndexers = [];
  const zeroHitIndexers = [];
  const topHitIndexers = [];
  for (const [name, stat] of statsByIndexer) {
    if (stat.hits > 0) {
      hitIndexers.push(name);
      topHitIndexers.push(name);
    } else {
      zeroHitIndexers.push(name);
    }
    if (stat.errors > 0) failedIndexers.push(name);
  }
  const outcome = summarizeSearchOutcome(probe, { hits, queries: matched.length, errors, hitIndexers, failedIndexers, zeroHitIndexers, topHitIndexers });
  const details = {
    queries: matched.length,
    hits,
    errors,
    indexers: [...statsByIndexer.entries()].map(([name, stat]) => ({ name, ...stat })),
    indexerErrors,
  };
  let decision = null;
  let gap = null;
  if (app === 'sonarr' && outcome.kind !== 'pending') {
    let releases = [];
    try {
      const seasons = probeSearchSeasons(probe, st);
      for (const sn of seasons.length ? seasons : [1]) {
        try {
          const rows = await arrGet('sonarr', `/release?seriesId=${id}&seasonNumber=${sn}`, 30000);
          if (Array.isArray(rows)) releases.push(...rows);
        } catch { /* per-season query best-effort */ }
      }
      decision = summarizeReleaseDecision(releases);
    } catch { /* best-effort */ }
    // Nothing grabbable? Check whether healthy releases exist upstream that never became candidates.
    if (!decision || decision.acceptedCount === 0) {
      // The probe title may lack a year (Sonarr series title = "Planet Earth" not "Planet Earth (2006)").
      // A bare "Planet Earth" Prowlarr query is too broad and times out → gap probe fails silently.
      // Fetch the year from Sonarr and append it so the query is fast + targeted.
      let gapTitle = probe.title;
      if (app === 'sonarr' && !/(19|20)\d{2}/.test(gapTitle)) {
        try {
          const series = await arrGet(app, `/series/${id}`, 6000);
          if (series && series.year) gapTitle = `${gapTitle} ${series.year}`;
        } catch { /* best-effort */ }
      }
      try { gap = await probeSearchGap(gapTitle, releases); } catch (e) { console.log(`probeSearchOutcome: gap probe threw: ${e?.message || e}`); }
      if (gap) {
        console.log(`probeSearchOutcome: gap found for "${probe.title}" (${id}) — "${gap.best.title}" (${gap.best.seeders} seeders, ${gap.reasonClass})`);
      } else {
        console.log(`probeSearchOutcome: gap probe returned null for "${probe.title}" (${id}) — Prowlarr returned no matching releases (check indexers, query timeouts)`);
        // If gap is null, the correct releases may be IN the candidate set but were
        // rejected by Sonarr's parser (false negative, like "Carl Sagans Cosmos 1980...").
        // Retry with empty candidates (same as force-grab endpoint).
        if (app === 'sonarr') {
          console.log(`probeSearchOutcome: retrying with empty candidates (rejected-false-negative fallback) for "${probe.title}" (${id})`);
          try { gap = await probeSearchGap(gapTitle, []); } catch (e) { console.log(`probeSearchOutcome: fallback gap probe threw: ${e?.message || e}`); }
          if (gap) {
            gap.reasonClass = 'rejected-false-negative';
            gap.summary = gap.summary.replace(/not.*candidates/, 'correct release was rejected by Sonarr parser');
            console.log(`probeSearchOutcome: false-negative gap found for "${probe.title}" (${id}) — "${gap.best.title}" (${gap.best.seeders} seeders)`);
          } else {
            console.log(`probeSearchOutcome: false-negative fallback also returned null for "${probe.title}" (${id})`);
          }
        }
      }
    } else {
      console.log(`probeSearchOutcome: skipping gap probe for "${probe.title}" (${id}) — decision=${decision.kind} accepted=${decision.acceptedCount}`);
    }
  }
  Object.assign(st, {
    lastOutcomeKind: decision && decision.kind === 'rejected' ? 'rejected' : outcome.kind,
    lastOutcomeSummary: decision && decision.summary ? decision.summary : outcome.summary,
    lastOutcomeAt: Date.now(),
    lastOutcomeDetails: details,
    lastOutcomeDecision: decision,
    lastSearchGap: gap,
    lastReason: decision && decision.kind === 'rejected'
      ? 'search_rejected'
      : outcome.kind === 'error'
        ? 'search_failed'
        : outcome.kind === 'empty'
          ? 'search_empty'
          : 'search_found',
  });
  searchState.set(key, st);
  persistState();
  metrics.emitEvent('search_outcome', {
    ap: app,
    id,
    ti: probe.title,
    mode: probe.mode,
    manual: probe.manual,
    kind: outcome.kind,
      summary: outcome.summary,
      queries: matched.length,
      hits,
      errors,
      indexers: [...statsByIndexer.keys()],
      indexerErrors,
    });
  if (decision) {
    metrics.emitEvent('search_decision', {
      ap: app,
      id,
      ti: probe.title,
      mode: probe.mode,
      manual: probe.manual,
      kind: decision.kind,
      summary: decision.summary,
      accepted: decision.acceptedCount,
      rejected: decision.rejectedCount,
      reasons: decision.reasons || null,
      indexerErrors,
    });
    if (decision.kind === 'rejected') {
      metrics.emitEvent('search_reject', {
        ap: app,
        id,
        ti: probe.title,
        mode: probe.mode,
        manual: probe.manual,
        summary: decision.summary,
        reasons: decision.reasons || null,
        indexerErrors,
      });
    }
  }
  if (gap) {
    metrics.emitEvent('search_gap', {
      ap: app,
      id,
      ti: probe.title,
      query: gap.query,
      upstreamHealthy: gap.upstreamHealthy,
      reasonClass: gap.reasonClass,
      best: gap.best && gap.best.title,
      seeders: gap.best && gap.best.seeders,
      indexer: gap.best && gap.best.indexer,
    });
  }
  clearSearchProbe(key);
}

// Probe timers live only in memory (searchProbeTimers), but the probe object itself rides along in
// searchState → state.json. So a controller restart mid-search would leave st.searchProbe persisted
// with NO timer to resolve it — the row would show "search in progress" forever. On boot, walk the
// restored state and re-arm (or finalize) any probe that was still pending when we went down.
function rehydrateSearchProbes() {
  const now = Date.now();
  for (const [key, st] of searchState) {
    const probe = st && st.searchProbe;
    if (!probe || st.lastOutcomeKind !== 'pending') continue;
    const [app, idStr] = key.split(':');
    const id = Number(idStr);
    if (!app || !Number.isFinite(id)) continue;
    const age = now - (probe.at || 0);
    if (age > SEARCH_PROBE_MAX_AGE_MS || (probe.attempts || 0) >= SEARCH_PROBE_MAX_ATTEMPTS) {
      // Aged out while we were down — finalize so the UI doesn't hang on "pending".
      const summary = 'search dispatched; outcome unconfirmed (controller restarted mid-search)';
      Object.assign(st, { lastOutcomeKind: 'unknown', lastOutcomeSummary: summary, lastOutcomeAt: now, lastReason: 'search_unconfirmed' });
      searchState.set(key, st);
      metrics.emitEvent('search_outcome', { ap: app, id, ti: probe.title, mode: probe.mode, manual: probe.manual, kind: 'unknown', summary, attempt: probe.attempts || 0 });
      continue;
    }
    // Still within its window — re-arm the timer. Give the *arr/Prowlarr stack a moment to come up
    // after the restart before we poll history.
    clearSearchProbe(key);
    searchProbeTimers.set(key, setTimeout(() => probeSearchOutcome(app, id, probe.id), SEARCH_PROBE_INITIAL_MS));
  }
  persistState();
}
setTimeout(rehydrateSearchProbes, 8000);  // after loadState() + a brief settle for the *arr stack

async function sweepBlocklist() {
  for (const app of ['radarr', 'sonarr']) {
    try {
      const bl = await arrGet(app, '/blocklist?pageSize=200', 10000);
      const cutoff = Date.now() - BLOCKLIST_TTL_MS;
      const expired = (bl.records || []).filter((r) => new Date(r.date).getTime() < cutoff).map((r) => r.id);
      if (!expired.length) continue;
      await tfetch(`${arrOf(app).base}/blocklist/bulk`, { method: 'DELETE', headers: { 'X-Api-Key': arrOf(app).key, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: expired }) }, 15000);
      console.log(`sweepBlocklist: cleared ${expired.length} expired ${app} blocklist entry/entries (≥${Math.round(BLOCKLIST_TTL_MS / 3600000)}h old)`);
    } catch { /* best-effort */ }
  }
}
async function arrSweep() {
  if (masterPaused || arrSweepBusy) return;               // Movie Mode — no searches/grabs/recovery
  arrSweepBusy = true;
  try {
    await sweepBlocklist();                                // clear expired blocklist entries before processing queue
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
          if (/not an upgrade|not a custom format upgrade|\bsample\b|matched to movie by id|manual import required/i.test(msgs)) {
            stuckIds.push({ id, queueId: qe.id, blocklist: true });
          }
        }
      }

      for (const s of stuckIds) {
        try {
          await arrDelete(app, `/queue/${s.queueId}?removeFromClient=true&blocklist=${s.blocklist}`);
          console.log(`arrSweep: removed stuck queue item id=${s.id} from ${app}${s.blocklist ? ' (blocklisted dead release)' : ''}`);
          metrics.emitEvent('queue_clean', { ap: app, id: s.id, blocklisted: !!s.blocklist });
        } catch (e) { console.log(`arrSweep: failed to remove queue item id=${s.id} from ${app} — ${e.message || e}`); }
      }

      if (stalledHashes.length) {
        try {
          const body = new URLSearchParams({ hashes: stalledHashes.join('|'), deleteFiles: 'true' });
          await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
          console.log(`arrSweep: removed ${stalledHashes.length} stalled torrent(s) from qBittorrent`);
          metrics.emitEvent('stall_clean', { count: stalledHashes.length });
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
            metrics.emitEvent('dedup', { ap: 'radarr', id, kept: sorted[0].name, removed: losers.length });
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
            metrics.emitEvent('supersede', { ap: 'radarr', id, kept: sorted[0].name, removed: losers.length });
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
      const needSearch = [];
      for (const i of items) {
        // Sonarr: a series is "complete" only when every monitored, aired episode has a file.
        // The old `!!episodeFileCount` treated a series holding ANY file as done, so a partially
        // filled series (e.g. S1 present, S2–S4 missing) was cleared and NEVER recovered.
        const ss = app === 'sonarr' && i.statistics;
        const hasContent = app === 'radarr'
          ? !!i.hasFile
          : !!(ss && ss.episodeCount > 0 && ss.episodeFileCount >= ss.episodeCount);
        if (hasContent) { searchKeyClear(app, i.id); noteResolved(app, i.id); continue; }             // got it — clear all state
        if (i.monitored === false) continue;
        // Future release (Radarr): don't search for content that hasn't been released yet.
        if (app === 'radarr') {
          const fDates = [i.inCinemas, i.physicalRelease, i.digitalRelease].filter(Boolean);
          if (fDates.length && fDates.some(d => new Date(d).getTime() > now + 86400000)) continue;
        }
        if (qIds.has(i.id) || downloadingIds.has(i.id)) { noteResolved(app, i.id); continue; } // in flight — reset clock
        const firstMissing = noteMissing(app, i.id);                            // start/read the missing clock
        const st = searchState.get(`${app}:${i.id}`);
        if (st && st.blockedUntil && st.blockedUntil > now) {
          if (!st.lastOutcomeKind || st.lastOutcomeKind === 'pending') {
            touchSearchState(app, i.id, { lastReason: 'blocked', lastAt: now });
          }
          metrics.emitEvent('search_skip', { ti: i.title, ap: app, id: i.id, reason: 'blocked', fails: st.fails || 0, next: st.blockedUntil });
          continue;                                                               // negative-cached (no content)
        }
        if (now - firstMissing < RECOVERY_GRACE_MS) {
          // Grace applies to EVERY missing item, including never-searched ones. This is what makes
          // a controller restart safe: firstMissing resets to now on restart, so the whole missing
          // library sits in grace instead of triggering an immediate mass EpisodeSearch (which made
          // Sonarr re-grab everything — including wrong-language/duplicate releases — every restart).
          if (!st || !st.lastOutcomeKind || st.lastOutcomeKind === 'pending') {
            touchSearchState(app, i.id, { lastReason: 'grace', lastAt: now });
          }
          metrics.emitEvent('search_skip', { ti: i.title, ap: app, id: i.id, reason: 'grace', next: firstMissing + RECOVERY_GRACE_MS });
          continue;                                                               // still *arr's own job — don't interfere
        }
        if (st && st.ts && now - st.ts < SEARCH_COOLDOWN_MS) {
          if (!st.lastOutcomeKind || st.lastOutcomeKind === 'pending') {
            touchSearchState(app, i.id, { lastReason: 'cooldown', lastAt: now });
          }
          metrics.emitEvent('search_skip', { ti: i.title, ap: app, id: i.id, reason: 'cooldown', next: st.ts + SEARCH_COOLDOWN_MS, fails: st.fails || 0 });
          continue;                                                               // already recovered recently
        }
        needSearch.push(i);
      }

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
          let episodeRefs = null;
          if (app === 'sonarr') {
            episodeRefs = await missingEpisodes(item.id);
            if (!episodeRefs.length) {
              touchSearchState(app, item.id, { lastReason: 'no_searchable_episodes', lastAt: now });
              metrics.emitEvent('search_skip', { ti: item.title, ap: app, id: item.id, reason: 'no_searchable_episodes' });
              continue;
            }
          }
          const st = searchState.get(key) || { ts: 0, fails: 0, blockedUntil: 0 };
          if (st.ts) st.fails = (st.fails || 0) + 1;   // a prior search left it with no content → it failed
          if (st.fails >= SEARCH_FAIL_LIMIT) {
            st.blockedUntil = now + SEARCH_BLOCK_MS;
            console.log(`arrSweep: ${app} "${item.title}" (${item.id}) searched ${st.fails}× with no grab — negative-caching 7d (manual retry clears)`);
            metrics.emitEvent('block', { ti: item.title, ap: app, id: item.id, fails: st.fails });
          }
          try {
            if (app === 'radarr') {
              await arrPost(app, '/command', { name: 'MoviesSearch', movieIds: [item.id] }, 5000);
              st.ts = now;
              searchState.set(key, st);
              trackSearchDispatch(app, item, { searchAt: now, mode: 'MoviesSearch' });
              console.log(`arrSweep: triggered search for radarr "${item.title}" (${item.id})`);
              metrics.emitEvent('search', { ti: item.title, ap: app, id: item.id, mode: 'MoviesSearch', fails: st.fails || 0 });
            } else {
              // EpisodeSearch (NOT SeriesSearch): SeriesSearch/SeasonSearch only look for whole-season
              // PACKS, which airing shows usually lack — so those searches find nothing and the season
              // never fills in. EpisodeSearch with explicit episode IDs makes Sonarr grab the
              // individual-episode releases that actually exist, one per missing episode.
              const episodeIds = episodeRefs.map((e) => e.id);
              await arrPost(app, '/command', { name: 'EpisodeSearch', episodeIds }, 8000);
              const episodeCodes = episodeRefs.map((e) => `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}`);
              st.ts = now;
              searchState.set(key, st);
              trackSearchDispatch(app, item, { searchAt: now, mode: 'EpisodeSearch', episodeCodes });
              console.log(`arrSweep: triggered EpisodeSearch for sonarr "${item.title}" (${item.id}) — ${episodeIds.length} missing episode(s)`);
              metrics.emitEvent('search', { ti: item.title, ap: app, id: item.id, mode: 'EpisodeSearch', fails: st.fails || 0, eps: episodeCodes });
            }
          } catch (e) {
            touchSearchState(app, item.id, { lastReason: 'trigger_failed', lastError: String(e.message || e), lastAt: now });
            console.log(`arrSweep: search trigger failed for ${item.id} — ${e.message || e}`);
            metrics.emitEvent('search_skip', { ti: item.title, ap: app, id: item.id, reason: 'trigger_failed', error: String(e.message || e) });
          }
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
        metrics.emitEvent('req_blocked', { key, sB: hit.size, free });
      } else blocked.delete(key);                       // stuck for a non-disk reason → don't flag
    }
  } finally { reqBusy = false; persistState(); }
}
setInterval(requestGate, 300000);   // every 5 min (was 60s); stuck Jellyseerr requests stay stuck for hours, not seconds
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
// ---- Trickplay-aware scan gate ----
// If Jellyfin's "Generate Trickplay Images" task is running, skip the safety-net
// scan.  Each scan-completion triggers the next trickplay item, so feeding scans
// while trickplay is active creates a vicious cycle: trickplay takes >10 min per
// episode → watchdog fires → scan → next trickplay item → repeat for hours/days.
// When trickplay finishes, the next watchdog tick (≤2 min) will catch any real
// imports.  New imports still trigger scans directly via their own code paths.
let _lastTrickBusyCheck = 0;
async function isTrickplayBusy() {
  try {
    // Cache: don't hit the API more than once per 60s
    if (Date.now() - _lastTrickBusyCheck < 60000) return _trickBusyCache;
    const r = await tfetch(`${HOST.jellyfin}/ScheduledTasks`, { headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY } }, 8000);
    if (!r.ok) return (_trickBusyCache = false);
    const tasks = await r.json();
    _lastTrickBusyCheck = Date.now();
    _trickBusyCache = tasks.some(t => /trickplay/i.test(t.Name) && t.State === 'Running');
    return _trickBusyCache;
  } catch {
    _lastTrickBusyCheck = Date.now();
    return (_trickBusyCache = false);
  }
}
let _trickBusyCache = false;

// Periodic safety-net scan + startup catch-up.
// If no scan has succeeded in 10 minutes AND trickplay isn't running, fire one.
// This catches media that *arr imported while the controller was down or the
// notification missed.
setInterval(() => {
  if (!cfg.JELLYFIN_KEY) return;
  if (Date.now() - _lastScan > 600000) {
    isTrickplayBusy().then(busy => {
      if (busy) { console.log('jfScan: trickplay running — deferring scan'); return; }
      console.log('jfScan: 10 min overdue — triggering refresh');
      triggerJellyfinScan();
    });
  }
}, 300000);   // 5 min (was 120s); scans are heavy and this already defers while trickplay runs — less frequent is safer
// On controller start, wait for Jellyfin to be ready then do a catch-up scan
// so media imported during downtime gets discovered.
setTimeout(() => { if (cfg.JELLYFIN_KEY) { console.log('jfScan: startup catch-up scan'); triggerJellyfinScan(); } }, 45000);



app.listen(PORT, () => console.log(`controller listening on :${PORT} (NUC_IP=${NUC_IP}, keys ${cfg.RADARR_KEY ? 'loaded' : 'NOT provisioned'})`));
