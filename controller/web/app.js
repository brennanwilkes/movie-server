'use strict';
// Served from the NUC (controller container) over HTTP, so the API is same-origin
// (relative). If the backend is ever unreachable, the UI degrades to a deep-link
// launcher + a "not on your home network" banner.
const NUC_BASE = 'http://192.168.1.74';
const API = '';

// The two everyday actions are the big buttons on Home (set once — deep-links work
// in both live and launcher modes). Jellyfin = Watch, Jellyseerr = Request.
const WATCH_URL = `${NUC_BASE}:8096`;
const REQUEST_URL = `${NUC_BASE}:5055`;

// Deep-link helper — opens Jellyfin web UI in a new tab.
function openJellyfin(path = '') {
  window.open(`${WATCH_URL}/web/${path}`, '_blank');
}

// Static fallback so the launcher renders the "Tools" without the backend (matches /api/status).
const CATALOG = [
  { id: 'qbittorrent', name: 'Torrents', brand: 'qBittorrent', port: 8080 },
  { id: 'radarr', name: 'Movies', brand: 'Radarr', port: 7878 },
  { id: 'sonarr', name: 'TV Shows', brand: 'Sonarr', port: 8989 },
  { id: 'prowlarr', name: 'Sources', brand: 'Prowlarr', port: 9696 },
  { id: 'bazarr', name: 'Subtitles', brand: 'Bazarr', port: 6767 },
];

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
// Real HTML escaping — every esc() call site interpolates into innerHTML or a quoted
// attribute (data-hash/data-title/aria-label). Torrent/release names are untrusted input:
// a `"` broke attribute parsing (dead buttons), `<`/`>` mangled rows, and markup executed.
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function fmtBytes(b) {
  if (!b) return '0 GB';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i < 2 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
function fmtEta(s) {
  if (!s || s <= 0) return '';
  if (s < 90) return '1 min';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}
// "Not found" rows: say when the next recovery search will actually fire, so it doesn't just
// sit there looking abandoned. d.recoveryNext is an absolute ms timestamp from the server.
function fmtRecovery(d) {
  if (d.recoveryBlocked) return `gave up after ${d.recoveryFails} tries, will retry ${fmtWhen(d.recoveryNext)}`;
  if (!d.recoveryNext) return 'retrying soon';
  const ms = d.recoveryNext - Date.now();
  if (ms <= 0) return 'retrying now';
  return `next retry in ${fmtDur(ms / 1000)}`;
}
// "Stalled" rows: say when the give-up (blocklist + re-search) clock fires.
function fmtGiveUp(giveUpAt) {
  const ms = giveUpAt - Date.now();
  if (ms <= 0) return 'giving up now';
  return `giving up in ${fmtDur(ms / 1000)}`;
}
function fmtWhen(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
// Coarser, two-part duration for the batch estimate (e.g. "2d 4h", "9h 30m", "12 min").
function fmtDur(s) {
  if (!s || s <= 0) return '';
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.round((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `${Math.max(1, Math.round(s / 60))} min`;
}

async function getJSON(path, timeoutMs = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);          // never hang forever on a busy server
  try {
    const r = await fetch(API + path, { headers: { Accept: 'application/json' }, signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function postJSON(path, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ── Offline banner (status poll is the authority) ──
let offline = false;
function setOffline(v) {
  if (v === offline) return;
  offline = v;
  $('#offline').hidden = !v;
}

// ── Tabs ──
const TITLES = { home: 'Home', downloads: 'Downloads', library: 'Library' };
function showTab(name) {
  $$('.tab').forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('#page-title').textContent = TITLES[name];
  try { localStorage.setItem('tab', name); } catch { /* ignore */ } // survive refresh
  if (name === 'library') loadLibrary();
}
$$('.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ── Home: status + disk ──
function renderServices(list, { showStatus = true } = {}) {
  $('#services').innerHTML = list.map((s) => {
    const dotCls = s.dotClass || (s.up ? 'up' : '');
    const sub = s.sub ? `<div class="sub ${s.subClass || ''}">${esc(s.sub)}</div>`
      : (showStatus && !s.up ? '<div class="sub">Not responding</div>' : '');
    const inner = `
      ${showStatus ? `<span class="dot ${dotCls}"></span>` : ''}
      <span class="grow"><span class="title">${esc(s.name)}</span>${sub}</span>
      <span class="brand">${esc(s.brand || '')}</span>
      ${s.url ? '<span class="chev">›</span>' : ''}`;
    return s.url
      ? `<a class="row" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
      : `<div class="row">${inner}</div>`;
  }).join('');
}
// Fold VPN state into the Services list: annotate the qBittorrent (Torrents) row and
// insert a dedicated VPN/tunnel row right after it. Red = torrents are NOT protected.
function withVPN(status, vpn) {
  const rows = status.map((s) => ({ ...s }));
  if (!vpn) return rows;
  const qb = rows.find((r) => r.id === 'qbittorrent');
  const vpnRow = { id: 'vpn', name: 'VPN', brand: 'ProtonVPN' };
  if (!vpn.enabled) {
    if (qb && qb.up) { qb.sub = 'VPN off, using your real IP'; qb.subClass = 'danger'; }
    vpnRow.up = false; vpnRow.dotClass = 'down';
    vpnRow.sub = 'Not connected, torrents are not protected'; vpnRow.subClass = 'danger';
  } else if (vpn.connected) {
    const loc = [vpn.city, vpn.country].filter(Boolean).join(', ');
    if (qb && qb.up) { qb.sub = 'Protected via ProtonVPN' + (loc ? ', ' + loc : ''); qb.subClass = ''; }
    vpnRow.up = true; vpnRow.dotClass = 'up';
    vpnRow.sub = [loc, vpn.public_ip, vpn.port ? 'port ' + vpn.port : 'no forwarded port'].filter(Boolean).join(', ');
    vpnRow.subClass = vpn.port ? '' : 'warn';
  } else {
    if (qb && qb.up) { qb.sub = 'VPN tunnel down, downloads paused'; qb.subClass = 'warn'; }
    vpnRow.up = false; vpnRow.dotClass = 'warn';
    vpnRow.sub = 'Tunnel down, reconnecting'; vpnRow.subClass = 'warn';
  }
  const idx = rows.findIndex((r) => r.id === 'qbittorrent');
  rows.splice(idx >= 0 ? idx + 1 : rows.length, 0, vpnRow);
  return rows;
}
// Deep-link launcher shown when the backend is unreachable (off the home network).
function renderLauncher() {
  const list = CATALOG.map((c) => ({ ...c, url: `${NUC_BASE}:${c.port}` }));
  renderServices(list, { showStatus: false });
  const ss = $('#sysstats'); if (ss) ss.hidden = true; // host stats need the backend
  if (location.protocol === 'https:') { const b = $('#live-btn'); b.href = API; b.hidden = false; }
}
// Projected bytes the in-progress + queued downloads will add to disk once finished — set by the
// downloads poll, drawn as a second segment on the disk meter so it's clear how much is incoming.
let projectedIncoming = 0, lastDisk = null;
function renderDisk(d) {
  const used = d.used_bytes, cap = d.cap_bytes, free = d.free_bytes;
  const usedPct = Math.min(100, d.used_pct || 0);
  const tb = (b) => (b / 1024 ** 4).toFixed(1);
  const fill = $('#disk-fill');
  fill.style.width = usedPct + '%';
  fill.classList.toggle('warn', usedPct >= 80 && usedPct < 92);
  fill.classList.toggle('full', usedPct >= 92);
  const inc = projectedIncoming || 0;
  const incEl = $('#disk-incoming');
  if (incEl) {
    const incPct = cap ? Math.min(Math.max(0, 100 - usedPct), inc / cap * 100) : 0;
    incEl.style.left = usedPct + '%';
    incEl.style.width = incPct + '%';
    incEl.classList.toggle('over', inc > free);                 // queue exceeds free space
  }
  $('#disk-text').textContent = `${tb(used)} / ${tb(cap)} TB`;     // current / max; the bar shows incoming
}
// Color-coded so it's obvious at a glance when the NUC is struggling — the meter always
// carries a health colour (green/amber/red), and the value turns amber/red once it's high,
// so you don't need to know what a "bad" number is.
function renderSystem(s) {
  const el = $('#sysstats'); if (!el) return;
  if (!s || (s.cpuPct == null && s.memPct == null && s.tempC == null)) { el.hidden = true; return; }
  el.hidden = false;
  const lvl = (v, warn, bad) => (v == null ? 'ok' : v >= bad ? 'bad' : v >= warn ? 'warn' : 'ok');
  const clamp = (n) => Math.max(4, Math.min(100, n));
  const cell = (label, val, status, width) =>
    `<div class="stat ${status}"><div class="stat-top"><span class="stat-label">${label}</span><span class="stat-val">${val}</span></div><div class="stat-meter"><div style="width:${width}%"></div></div></div>`;
  el.innerHTML = [
    cell('CPU', s.cpuPct == null ? 'N/A' : s.cpuPct + '%', lvl(s.cpuPct, 70, 90), s.cpuPct == null ? 0 : clamp(s.cpuPct)),
    cell('RAM', s.memPct == null ? 'N/A' : s.memPct + '%', lvl(s.memPct, 75, 90), s.memPct == null ? 0 : clamp(s.memPct)),
    // temperature has no fixed max — map ~30–95 °C onto the meter so the bar tracks severity
    cell('Temp', s.tempC == null ? 'N/A' : s.tempC + '°', lvl(s.tempC, 70, 85), s.tempC == null ? 0 : clamp((s.tempC - 30) / 65 * 100)),
  ].join('');
}
async function pollHome() {
  try {
    const [status, disk, sys, vpn] = await Promise.all([getJSON('/api/status'), getJSON('/api/disk'), getJSON('/api/system').catch(() => null), getJSON('/api/vpn').catch(() => null)]);
    setOffline(false);
    $('#live-btn').hidden = true;
    renderServices(withVPN(status, vpn));
    lastDisk = disk;
    renderDisk(disk);
    renderSystem(sys);
  } catch { setOffline(true); renderLauncher(); }
}

// ── Downloads ──
function renderDownloads(items) {
  $('#downloads-empty').hidden = items.length > 0;
  // Red is reserved for "a human needs to look at this" (Needs attention, Error, Declined, and a
  // Not found that's been negative-cached). Blue is anything actively progressing on its own —
  // including the post-download steps (subtitles/import/processing), not just live byte transfer.
  // Orange is everything else mid-recovery: stalled, still searching/retrying, not yet resolved.
  const COLOR = { Declined: 'var(--danger)', 'Needs attention': 'var(--danger)', Error: 'var(--danger)', 'Ready': 'var(--ok)', Done: 'var(--ok)', Importing: 'var(--accent)', 'Getting subtitles': 'var(--accent)', Processing: 'var(--accent)', Stalled: 'var(--warn)', 'Not found': 'var(--warn)' };
  $('#downloads').innerHTML = items.map((d) => {
    const eta = d.state === 'Downloading' ? fmtEta(d.etaSeconds) : '';
    // Show the % on anything mid-transfer (not just "Downloading") — a partially-grabbed torrent
    // that's currently Queued/Stalled has real progress, and the bar floats it near the top, so
    // the label must explain why ("Queued · 25% · 8.5 GB") instead of looking like it hasn't started.
    const pctShown = d.progress > 0 && d.progress < 100 ? d.progress + '%' : '';
    const leftMeta = d.state === 'Declined'
      ? `Declined · Not enough disk space, needs ${fmtBytes(d.neededBytes)}, only ${fmtBytes(d.freeBytes)} free`
      : d.state === 'Not found'
      ? `Not found · ${fmtRecovery(d)}`
      : d.state === 'Stalled' && d.stallGiveUpAt
      ? `Stalled · ${fmtGiveUp(d.stallGiveUpAt)}`
      : [d.state, pctShown, d.sizeBytes > 0 ? fmtBytes(d.sizeBytes) : '', d.note].filter(Boolean).join(' · ');
    const color = COLOR[d.state] || '';
    const seedsShown = typeof d.seeds === 'number' ? `Seeds: ${d.seeds}` : '';
    const barW = (d.state === 'Declined' || d.attention) ? 100 : Math.min(100, d.progress);
    const isDone = d.state === 'Ready' || d.state === 'Done';
    const canDelete = d.hash && d.state !== 'Ready' && d.state !== 'Done';
    const isMissing = d.state === 'Not found';
    // Pause/resume: only for a real torrent that's actively in flight (not a "missing:" pseudo-row,
    // not a finished/importing item). Paused rows offer Resume; the rest offer Pause.
    const realHash = d.hash && !String(d.hash).startsWith('missing:');
    const pausable = realHash && ['Downloading', 'Stalled', 'Queued', 'Starting', 'Paused'].includes(d.state);
    const isPaused = d.state === 'Paused';
    let cleanTitle = '';
    if (isDone) {
      const mt = d.title.match(/^(.+?)[. _-]+(?:S\d{2,}|Season\s*\d+|19\d{2}|20\d{2}|Full|COMPLETE)/i);
      if (mt) cleanTitle = mt[1].replace(/[._]/g, ' ').trim();
      else {
        const mt2 = d.title.match(/^(.+?)[. _-]+(?:1080p|720p|2160p|480p|REMUX|BLURAY|WEB-?DL|WEBRIP|HDTV)/i);
        cleanTitle = mt2 ? mt2[1].replace(/[._]/g, ' ').trim() : d.title.replace(/-[A-Za-z0-9]+$/, '').replace(/[._]/g, ' ').trim();
      }
    }
    return `<li class="row dl${(d.attention || d.state === 'Declined') ? ' attn' : ''}${isDone ? ' done' : ''}" data-hash="${esc(d.hash || '')}" data-state="${esc(d.state)}" data-title="${esc(cleanTitle)}" data-source="${esc(d.source)}"${d._id ? ` data-app="${esc(d.source)}" data-id="${esc(d._id)}"` : ''}>
      <div class="dl-title-row">
        <span class="title">${esc(d.title)}</span>
        <span class="dl-actions">${isMissing ? `<button class="dl-retry" aria-label="Retry search"><svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg></button>` : ''}${pausable ? `<button class="dl-pause" aria-label="${isPaused ? 'Resume' : 'Pause'} download">${isPaused ? '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M9 5v14M15 5v14"/></svg>'}</button>` : ''}${canDelete ? `<button class="dl-stop" aria-label="Delete torrent & files"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m1 0v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7"/></svg></button>` : ''}</span>
      </div>
      <div class="mini-bar"><div style="width:${barW}%${color ? `;background:${color}` : ''}"></div></div>
      <div class="sub dl-meta"><span>${esc(leftMeta)}</span><span class="dl-meta-right">${[eta, seedsShown].filter(Boolean).map(esc).join(' · ')}</span></div>
    </li>`;
  }).join('');
  // Event delegation on the parent list (survives 4s DOM replacement from poll)
  const dl = $('#downloads');
  if (!dl._listener) {
    dl._listener = true;
    dl.addEventListener('click', async (e) => {
      const btn = e.target.closest('.dl-stop');
      const rbtn = e.target.closest('.dl-retry');
      const pbtn = e.target.closest('.dl-pause');
      const li = e.target.closest('li.dl.done');
      if (pbtn) {
        const bli = pbtn.closest('li');
        const hash = bli && bli.dataset.hash;
        if (!hash) return;
        const paused = bli.dataset.state === 'Paused';
        pbtn.disabled = true;
        try {
          await postJSON(paused ? '/api/torrent/resume' : '/api/torrent/pause', { hash });
          toast(paused ? 'Resumed' : 'Paused');
          pollDownloads();                       // refresh so the icon flips to its new state
        } catch { pbtn.disabled = false; toast(paused ? 'Resume failed' : 'Pause failed'); }
      } else if (rbtn) {
        const bli = rbtn.closest('li');
        const app = bli && bli.dataset.app;
        const id = bli && bli.dataset.id;
        if (!app || !id) return;
        rbtn.disabled = true;
        try {
          await postJSON('/api/retry', { app, id: Number(id) });
          rbtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>';
          toast('Search triggered · check back soon');
        } catch { rbtn.disabled = false; toast('Retry failed'); }
      } else if (btn) {
        const bli = btn.closest('li');
        const hash = bli && bli.dataset.hash;
        if (!hash) return;
        const state = bli && bli.dataset.state;
        if (state === 'Declined') {
          try {
            await postJSON('/api/declined/dismiss', { hash });
            btn.disabled = true;
            btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>';
          } catch { toast('Failed to dismiss'); }
        } else {
          const t = bli.querySelector('.title');
          openSheet({ hash, source: bli.dataset.source, title: t ? t.textContent : 'this download' });
        }
      } else if (li) {
        const title = li.dataset.title;
        const w = window.open(`${WATCH_URL}/web/`, '_blank');
        let path = `#/search?query=${encodeURIComponent(title)}`;
        try {
          const qs = new URLSearchParams({ title, hash: li.dataset.hash || '', source: li.dataset.source || '' });
          const { id, serverId } = await getJSON(`/api/jellyfin/resolve?${qs}`);
          if (id) path = `#/details?id=${id}${serverId ? `&serverId=${serverId}` : ''}`;
        } catch { /* keep the search fallback */ }
        if (w) w.location.href = `${WATCH_URL}/web/${path}`;
      }
    });
  }
}
// Batch estimate — "how long to clear the backlog": remaining bytes ÷ current speed. Hidden
// unless there's actually pending work, so a settled queue shows nothing.
function renderDlSummary(s) {
  const el = $('#dl-summary'); if (!el) return;
  projectedIncoming = (s && s.remainingBytes) || 0;             // feed the disk meter's incoming segment
  if (lastDisk) renderDisk(lastDisk);                           // reflect it without waiting for the 10s home poll
  const c = s && s.counts;
  if (!c || (c.inProgress + c.queued + c.attention + c.blocked) < 1) { el.hidden = true; return; }
  const b = s.bytes, total = (b.completed + b.inProgress + b.queued + b.attention + b.blocked) || 1;
  const pct = (x) => (x / total * 100).toFixed(2);
  const speed = s.speedBytes ? `${fmtBytes(s.speedBytes)}/s` : null;
  // Hero line is JUST the time estimate — no status commentary, no filler when there isn't one yet.
  const head = s.etaSeconds ? `${fmtDur(s.etaSeconds)} left` : s.remainingBytes ? `${fmtBytes(s.remainingBytes)} to go` : '';
  const sub = [
    s.etaSeconds && s.remainingBytes ? fmtBytes(s.remainingBytes) : '',
    speed,
    s.sizing ? `${s.sizing} sizing` : '',
  ].filter(Boolean).join(' · ');
  el.hidden = false;
  el.innerHTML = `
    <div class="dls-head"><span class="dls-eta">${esc(head)}</span>${sub ? `<span class="dls-rate">${esc(sub)}</span>` : ''}</div>
    <div class="dls-bar">
      <span class="seg done" style="width:${pct(b.completed)}%"></span>
      <span class="seg prog" style="width:${pct(b.inProgress)}%"></span>
      <span class="seg queue" style="width:${pct(b.queued)}%"></span>
      <span class="seg attn" style="width:${pct(b.attention)}%"></span>
      <span class="seg blocked" style="width:${pct(b.blocked)}%"></span>
    </div>
    <div class="dls-legend">
      <span class="done">${c.completed} done</span>
      <span class="prog">${c.inProgress} resolving</span>
      <span class="queue">${c.queued} pending</span>
      ${c.attention ? `<span class="attn">${c.attention} needs attention</span>` : ''}
      ${c.blocked ? `<span class="blocked">${c.blocked} waiting</span>` : ''}
    </div>`;
}

// Show a spinner ONLY until the first successful load (the library lookups make the first
// fetch slow); the 4s background refreshes then update in place with no flicker.
let dlLoaded = false, dlInflight = false, dlLastUpdate = 0;
function setDlLoading(v) { const el = $('#downloads-loading'); if (el) el.hidden = !v; }
function updateDlStale() {
  const el = $('#dl-summary');
  if (!el) return;
  el.classList.toggle('stale', dlLastUpdate > 0 && Date.now() - dlLastUpdate > 10000);
}
// Movie Mode (master pause) — one tap frees the NUC's CPU + disk for smooth Jellyfin playback.
const mmBtn = $('#movie-mode-btn');
let mmBusy = false;
function renderMovieMode(paused) {
  if (!mmBtn) return;
  mmBtn.classList.toggle('on', !!paused);
  mmBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
  const label = mmBtn.querySelector('.mm-label');
  if (label) label.textContent = paused ? 'Paused for streaming · tap to resume everything' : 'Movie Mode · pause everything for streaming';
  const path = mmBtn.querySelector('svg path');
  if (path) path.setAttribute('d', paused ? 'M7 5l12 7-12 7z' : 'M9 5v14M15 5v14');   // play triangle when paused, pause bars otherwise
}
if (mmBtn) mmBtn.addEventListener('click', async () => {
  if (mmBusy) return;
  const pausing = !mmBtn.classList.contains('on');
  mmBusy = true; mmBtn.disabled = true;
  renderMovieMode(pausing);                                   // optimistic flip
  try {
    const out = await postJSON(pausing ? '/api/master-pause' : '/api/master-resume', {});
    if (out && out.qbit === false) toast(pausing ? 'Sweeps paused — but qBittorrent didn’t confirm, torrents may still run' : 'Sweeps resumed — but qBittorrent didn’t confirm');
    else toast(pausing ? 'Movie Mode on · everything paused' : 'Resumed · downloads back on');
    pollDownloads();
  } catch { renderMovieMode(!pausing); toast('Could not reach the server'); }
  finally { mmBusy = false; mmBtn.disabled = false; }
});

async function pollDownloads() {
  if (offline) { setDlLoading(false); return; }
  updateDlStale();
  if (dlInflight) return;                                     // a poll is still running — don't stack another
  if (!dlLoaded) setDlLoading(true);
  dlInflight = true;
  try {
    const data = await getJSON('/api/downloads');
    if (!data.ts) return;   // snapshot not built yet (controller warming up) — keep the spinner,
                            // don't render a confident "Nothing downloading right now" from ts:0
    dlLastUpdate = data.ts;
    dlLoaded = true;
    setDlLoading(false);
    renderDownloads(data.items || []);
    renderDlSummary(data.summary);
    renderMovieMode(data.masterPaused);
    updateDlStale();                                          // clear stale indicator
  } catch { if (dlLoaded) setDlLoading(false); /* else keep spinner; it retries next tick */ }
  finally { dlInflight = false; }
}

// ── Library + delete ──
let libApp = 'radarr';
let libItems = [];
let libSeq = 0;   // request sequence — a slow older response must never clobber a newer one
$('#lib-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  $$('#lib-toggle button').forEach((x) => x.classList.toggle('active', x === b));
  libApp = b.dataset.app;
  // Clear immediately: until the new list arrives, the OLD app's rows were still rendered and
  // actionable — a movie id could be handed to a sonarr delete/redownload (wrong-title action).
  libItems = [];
  renderLibrary();
  loadLibrary();
});
$('#lib-search').addEventListener('input', renderLibrary);

function renderLibrary() {
  const q = $('#lib-search').value.trim().toLowerCase();
  const items = q ? libItems.filter((m) => m.title.toLowerCase().includes(q)) : libItems;
  $('#library-empty').hidden = items.length > 0;
  $('#library-empty').textContent = libItems.length ? 'No matches.' : 'Nothing here yet.';
  $('#library').innerHTML = items.map((m) => {
    let rate = '', rateCls = '';
    if (m.hasFile && m.sizeBytes && m.runtimeMinutes > 0) {
      const mbpm = m.sizeBytes / (1024 * 1024) / m.runtimeMinutes;
      rate = `${mbpm.toFixed(1)} MB/min`;
      rateCls = mbpm < 40 ? 'rate-ok' : mbpm < 80 ? 'rate-warn' : 'rate-bad';
    }
    const fmt = m.videoLabel || '';
    const compat = m.gpuCompat || '';
    const fmtCls = compat === 'ok' ? 'ok' : compat === 'warn' ? 'warn' : compat === 'bad' ? 'bad' : '';
    // Missing titles: show the server's live pipeline status ("Downloading (45%)", "Import
    // blocked", …) instead of a flat "Not downloaded" — the API computed it all along.
    const status = !m.hasFile && m.downloadDetail
      ? `<span class="dl-status ds-${esc(m.downloadStatus || 'missing')}">${esc(m.downloadDetail)}</span>`
      : `<span class="sub-size">${m.hasFile ? fmtBytes(m.sizeBytes) + ' on disk' : 'Not downloaded'}</span>`;
    return `<li class="row">
      <span class="grow">
        <span class="title">${esc(m.title)}${m.year ? ` <span class="muted">(${m.year})</span>` : ''}</span>
        <div class="sub">${status}${rate ? `<span class="rate ${rateCls}">${rate}</span>` : ''}${fmt ? `<span class="format ${fmtCls}">${esc(fmt)}</span>` : ''}</div>
      </span>
      ${m._app === 'radarr' ? `<button class="redl" data-id="${m.id}" aria-label="Redownload ${esc(m.title)}">
        <svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7M21 3v5h-5"/></svg>
      </button>` : ''}
      <button class="trash" data-id="${m.id}" aria-label="Remove ${esc(m.title)}">
        <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m1 0v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7"/></svg>
      </button>
    </li>`;
  }).join('');
  // Actions carry the ITEM's own app (stamped at load), never the global toggle — pairing the
  // current toggle with a stale list's numeric id was a wrong-title delete waiting to happen.
  $$('#library .trash').forEach((btn) => btn.addEventListener('click', () => {
    const it = libItems.find((m) => m.id === +btn.dataset.id);
    if (it) openSheet({ app: it._app, id: it.id });
  }));
  $$('#library .redl').forEach((btn) => btn.addEventListener('click', () => {
    const it = libItems.find((m) => m.id === +btn.dataset.id);
    if (it && it._app === 'radarr') openRedl(it.id);
  }));
}
async function loadLibrary() {
  if (offline) { $('#library').innerHTML = ''; $('#library-empty').hidden = false; $('#library-empty').textContent = 'Connect to your home network to manage your library.'; return; }
  const seq = ++libSeq;
  try {
    const data = await getJSON(`/api/library?app=${libApp}`);
    if (seq !== libSeq) return;                                  // a newer request superseded this one
    libItems = (data.items || []).map((m) => ({ ...m, _app: data.app }));
    const el = $(`#lib-count-${data.app}`);
    if (el) el.textContent = libItems.length ? `(${libItems.length})` : '';
    renderLibrary();
  }
  catch {
    if (seq !== libSeq) return;
    libItems = [];                                               // stale rows must not stay actionable
    $('#library').innerHTML = '';
    $('#library-empty').hidden = false;
    $('#library-empty').textContent = 'Could not load the library — will retry when you switch tabs.';
  }
}

// Delete confirm sheet
let pending = null;
function closeSheet() { $('#sheet-backdrop').hidden = true; pending = null; }
$('#sheet-cancel').addEventListener('click', closeSheet);
$('#sheet-backdrop').addEventListener('click', (e) => { if (e.target === $('#sheet-backdrop')) closeSheet(); });

// target: {app, id} (Library) | {hash, source, title} (Downloads). Both hit /api/delete,
// which resolves a download's hash to its *arr item for the same layered teardown.
async function openSheet(target) {
  const isDl = target.id == null;
  const body = isDl ? { hash: target.hash, source: target.source } : { app: target.app, id: target.id };
  const titleText = target.title || (libItems.find((m) => m.id === target.id) || {}).title || 'this title';
  pending = { isDl, body, id: target.id };
  $('#sheet-title').textContent = `Remove “${titleText}” everywhere?`;
  $('#sheet-sub').textContent = 'Checking what will be cleaned up…';
  $('#sheet-plan').innerHTML = '';
  $('#sheet-confirm').disabled = true;
  $('#sheet-backdrop').hidden = false;
  try {
    const plan = await postJSON('/api/delete', { ...body, dryRun: true });
    pending.freed = plan.freedBytes;
    $('#sheet-sub').textContent = plan.freedBytes ? `Frees about ${fmtBytes(plan.freedBytes)}.` : 'Removes it from every app.';
    $('#sheet-plan').innerHTML = plan.plan.map((p) => `
      <li class="${p.willRun ? 'run' : 'skip'}">
        <span class="badge">${p.willRun ? p.layer : '–'}</span>
        <span><span class="app">${esc(p.app)}</span> · ${esc(p.action)}</span>
      </li>`).join('');
    $('#sheet-confirm').disabled = false;
  } catch {
    $('#sheet-sub').textContent = 'Could not reach the server. Try again at home.';
  }
}

$('#sheet-confirm').addEventListener('click', async () => {
  if (!pending) return;
  const { body, isDl, id, freed } = pending;
  $('#sheet-confirm').disabled = true;
  $('#sheet-confirm').textContent = 'Removing…';
  try {
    const out = await postJSON('/api/delete', { ...body, dryRun: false });
    // The server returns 200 with per-layer results — a layer can still have failed
    // (Radarr down, qBittorrent down). Don't toast "Freed X GB" over a failed delete.
    const errs = (out.results || []).filter((r) => r.status === 'error');
    if (errs.length) {
      toast(`Remove incomplete — ${errs.map((r) => r.app).join(', ')} failed`);
      if (!isDl) loadLibrary();                          // re-fetch the truth instead of guessing
    } else {
      if (!isDl) { libItems = libItems.filter((m) => m.id !== id); renderLibrary(); }
      toast(freed ? `Freed ${fmtBytes(freed)}` : 'Removed');
    }
    pollHome();
    if (isDl) pollDownloads();
  } catch { toast('Something went wrong'); }
  finally { $('#sheet-confirm').textContent = 'Remove'; closeSheet(); }
});

// Redownload sheet (movies only) — deep-delete + re-request at a chosen quality tier.
let redlPending = null, redlTier = 'normal';
function closeRedl() { $('#redl-backdrop').hidden = true; redlPending = null; }
$('#redl-cancel').addEventListener('click', closeRedl);
$('#redl-backdrop').addEventListener('click', (e) => { if (e.target === $('#redl-backdrop')) closeRedl(); });
$('#redl-tiers').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  redlTier = b.dataset.tier;
  $$('#redl-tiers button').forEach((x) => x.classList.toggle('active', x === b));
});
function openRedl(id) {
  const m = libItems.find((x) => x.id === id) || {};
  redlPending = { id, title: m.title };
  redlTier = 'normal';
  $$('#redl-tiers button').forEach((x) => x.classList.toggle('active', x.dataset.tier === 'normal'));
  $('#redl-title').textContent = `Redownload “${m.title || 'this movie'}”?`;
  $('#redl-sub').textContent = m.hasFile
    ? `Deletes the current file${m.sizeBytes ? ` (${fmtBytes(m.sizeBytes)})` : ''} and re-fetches at the quality you pick.`
    : 'Fetches this movie at the quality you pick.';
  $('#redl-confirm').disabled = false;
  $('#redl-backdrop').hidden = false;
}
$('#redl-confirm').addEventListener('click', async () => {
  if (!redlPending) return;
  const { id, title } = redlPending;
  $('#redl-confirm').disabled = true;
  $('#redl-confirm').textContent = 'Starting…';
  try {
    await postJSON('/api/redownload', { app: 'radarr', id, tier: redlTier });
    toast(`Redownloading “${title}” · ${redlTier}`);
    pollDownloads();
    loadLibrary();
  } catch { toast('Redownload failed'); }
  finally { $('#redl-confirm').textContent = 'Redownload'; closeRedl(); }
});

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ── Home action buttons ──
$('#request-btn').href = REQUEST_URL;
$('#watch-btn').addEventListener('click', (e) => { e.preventDefault(); openJellyfin(); });

// ── Polling ──
// Skip work while the tab is hidden (backgrounded/screen off) — there's nothing to repaint
// and no point hammering the services. Snap back to fresh data the instant the tab is shown.
function poll(fn, ms) { const tick = () => { if (!document.hidden) fn(); }; tick(); return setInterval(tick, ms); }
poll(pollHome, 10000);
poll(pollDownloads, 4000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollHome(); pollDownloads(); } });
let startTab; try { startTab = localStorage.getItem('tab'); } catch { /* ignore */ }
showTab(['home', 'downloads', 'library'].includes(startTab) ? startTab : 'home');
