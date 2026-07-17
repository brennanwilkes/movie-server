'use strict';
// HTTP clients for every upstream service: fetch-with-timeout primitives,
// the qBittorrent cookie-auth client (owns its session cookie), the Jellyseerr
// API-key client, and the Radarr/Sonarr REST helpers. No timers.

const { cfg, HOST } = require('./config');

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

module.exports = { tfetch, tfetchJson, qbit, seerr, arrOf, arrGet, arrDelete, arrPost, arrPut };
