'use strict';
// Dashboard status routes: /api/status (service probes), /api/vpn (gluetun),
// /api/tailscale (sidecar status file), /api/disk, /api/system, /api/indexers.
// Owns: STATUS_SERVICES (also probed by metrics-recorders). No timers.

const fs = require('fs');
const app = require('./app');
const { cfg, HOST, linkFor } = require('./config');
const { tfetch, tfetchJson } = require('./clients');
const { getCpuPct, readMemPct, readTempC } = require('./system-stats');
const { getIndexerSnapshot } = require('./arr-data');

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
app.get('/api/system', (_req, res) => {
  res.json({ cpuPct: getCpuPct(), memPct: readMemPct(), tempC: readTempC() });
});
// Reports each indexer's enable/disable state, recent failures, and an approximate
// degradation percentage weighted by query volume, so a high-value indexer down (TPB,
// Knaben) shows more degradation than a niche one (YTS). Degradation detected via
// Prowlarr's recent query history (failed queries in the last 10 min).
app.get('/api/indexers', async (_req, res) => {
  try { res.json(await getIndexerSnapshot()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

module.exports = { STATUS_SERVICES };
