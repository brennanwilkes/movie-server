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
const esc = (s) => String(s == null ? '' : s);

function fmtBytes(b) {
  if (!b) return '0 GB';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i < 2 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
function fmtEta(s) {
  if (!s || s <= 0) return '';
  if (s < 90) return '~1 min';
  if (s < 3600) return `~${Math.round(s / 60)} min`;
  if (s < 86400) return `~${Math.round(s / 3600)} h`;
  return `~${Math.round(s / 86400)} d`;
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
  $('#services').innerHTML = list.map((s) => `
    <a class="row" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">
      ${showStatus ? `<span class="dot ${s.up ? 'up' : ''}"></span>` : ''}
      <span class="grow"><span class="title">${esc(s.name)}</span>${showStatus && !s.up ? '<div class="sub">Not responding</div>' : ''}</span>
      <span class="brand">${esc(s.brand || '')}</span>
      <span class="chev">›</span>
    </a>`).join('');
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
    cell('CPU', s.cpuPct == null ? '—' : s.cpuPct + '%', lvl(s.cpuPct, 70, 90), s.cpuPct == null ? 0 : clamp(s.cpuPct)),
    cell('RAM', s.memPct == null ? '—' : s.memPct + '%', lvl(s.memPct, 75, 90), s.memPct == null ? 0 : clamp(s.memPct)),
    // temperature has no fixed max — map ~30–95 °C onto the meter so the bar tracks severity
    cell('Temp', s.tempC == null ? '—' : s.tempC + '°', lvl(s.tempC, 70, 85), s.tempC == null ? 0 : clamp((s.tempC - 30) / 65 * 100)),
  ].join('');
}
async function pollHome() {
  try {
    const [status, disk, sys] = await Promise.all([getJSON('/api/status'), getJSON('/api/disk'), getJSON('/api/system').catch(() => null)]);
    setOffline(false);
    $('#live-btn').hidden = true;
    renderServices(status);
    lastDisk = disk;
    renderDisk(disk);
    renderSystem(sys);
  } catch { setOffline(true); renderLauncher(); }
}

// ── Downloads ──
function renderDownloads(items) {
  $('#downloads-empty').hidden = items.length > 0;
  const COLOR = { Declined: 'var(--danger)', 'Needs attention': 'var(--danger)', Error: 'var(--danger)', 'Ready': 'var(--ok)', Done: 'var(--ok)', Importing: 'var(--warn)', 'Getting subtitles': 'var(--warn)', Processing: 'var(--warn)', Stalled: 'var(--warn)' };
  $('#downloads').innerHTML = items.map((d) => {
    const eta = d.state === 'Downloading' ? fmtEta(d.etaSeconds) : '';
    // Show the % on anything mid-transfer (not just "Downloading") — a partially-grabbed torrent
    // that's currently Queued/Stalled has real progress, and the bar floats it near the top, so
    // the label must explain why ("Queued · 25% · 8.5 GB") instead of looking like it hasn't started.
    const pctShown = d.progress > 0 && d.progress < 100 ? d.progress + '%' : '';
    const leftMeta = d.state === 'Declined'
      ? `Declined · Not enough disk space — needs ${fmtBytes(d.neededBytes)}, only ${fmtBytes(d.freeBytes)} free`
      : [d.state, pctShown, fmtBytes(d.sizeBytes)].filter(Boolean).join(' · ');
    const color = COLOR[d.state] || '';
    const barW = d.state === 'Declined' ? 100 : Math.min(100, d.progress);
    const isDone = d.state === 'Ready' || d.state === 'Done';
    const canDelete = d.hash && d.state !== 'Ready' && d.state !== 'Done';
    let cleanTitle = '';
    if (isDone) {
      const mt = d.title.match(/^(.+?)[. _-]+(?:S\d{2,}|Season\s*\d+|19\d{2}|20\d{2}|Full|COMPLETE)/i);
      if (mt) cleanTitle = mt[1].replace(/[._]/g, ' ').trim();
      else {
        const mt2 = d.title.match(/^(.+?)[. _-]+(?:1080p|720p|2160p|480p|REMUX|BLURAY|WEB-?DL|WEBRIP|HDTV)/i);
        cleanTitle = mt2 ? mt2[1].replace(/[._]/g, ' ').trim() : d.title.replace(/-[A-Za-z0-9]+$/, '').replace(/[._]/g, ' ').trim();
      }
    }
    return `<li class="row dl${(d.attention || d.state === 'Declined') ? ' attn' : ''}${isDone ? ' done' : ''}" data-hash="${esc(d.hash || '')}" data-state="${esc(d.state)}" data-title="${esc(cleanTitle)}" data-source="${esc(d.source)}">
      <div class="dl-title-row">
        <span class="title">${esc(d.title)}</span>
        ${canDelete ? `<button class="dl-stop" aria-label="Delete torrent & files"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m1 0v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7"/></svg></button>` : ''}
      </div>
      <div class="mini-bar"><div style="width:${barW}%${color ? `;background:${color}` : ''}"></div></div>
      <div class="sub dl-meta"><span>${esc(leftMeta)}</span>${eta ? `<span>${esc(eta)}</span>` : ''}</div>
    </li>`;
  }).join('');
  // Event delegation on the parent list (survives 4s DOM replacement from poll)
  const dl = $('#downloads');
  dl._listener = dl._listener || dl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.dl-stop');
    const li = e.target.closest('li.dl.done');
    if (btn) {
      const bli = btn.closest('li');
      const hash = bli && bli.dataset.hash;
      if (!hash) return;
      const state = bli && bli.dataset.state;
      if (state === 'Declined') {
        // A declined row is just a tombstone (already torn down everywhere) — dismiss inline.
        try {
          await postJSON('/api/declined/dismiss', { hash });
          btn.disabled = true;
          btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>';
        } catch { toast('Failed to dismiss'); }
      } else {
        // Same deep, layered teardown + confirmation sheet as the Library tab.
        const t = bli.querySelector('.title');
        openSheet({ hash, source: bli.dataset.source, title: t ? t.textContent : 'this download' });
      }
    } else if (li) {
      // Open the tab synchronously (inside the click gesture, so it isn't popup-blocked),
      // then deep-link to the exact item once resolved — falling back to a search.
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
// Batch estimate — "how long to clear the backlog": remaining bytes ÷ current speed. Hidden
// unless there's actually pending work, so a settled queue shows nothing.
function renderDlSummary(s) {
  const el = $('#dl-summary'); if (!el) return;
  projectedIncoming = (s && s.remainingBytes) || 0;             // feed the disk meter's incoming segment
  if (lastDisk) renderDisk(lastDisk);                           // reflect it without waiting for the 10s home poll
  const c = s && s.counts;
  if (!c || (c.inProgress + c.queued) < 1) { el.hidden = true; return; }       // nothing pending → hide
  const b = s.bytes, total = (b.completed + b.inProgress + b.queued) || 1;
  const pct = (x) => (x / total * 100).toFixed(2);
  const speed = s.speedBytes ? `${fmtBytes(s.speedBytes)}/s` : null;
  // Hero line = the ETA; everything else folds into one muted sub-line so it stays clean on a phone.
  const head = s.etaSeconds ? `≈ ${fmtDur(s.etaSeconds)} left`
    : s.remainingBytes ? `≈ ${fmtBytes(s.remainingBytes)} to go` : 'Working…';
  const sub = [
    s.etaSeconds && s.remainingBytes ? fmtBytes(s.remainingBytes) : '',
    speed,
    s.sizing ? `${s.sizing} sizing` : '',
  ].filter(Boolean).join(' · ');
  el.hidden = false;
  el.innerHTML = `
    <div class="dls-head"><span class="dls-eta">${esc(head)}</span><span class="dls-rate">${esc(sub)}</span></div>
    <div class="dls-bar">
      <span class="seg done" style="width:${pct(b.completed)}%"></span>
      <span class="seg prog" style="width:${pct(b.inProgress)}%"></span>
      <span class="seg queue" style="width:${pct(b.queued)}%"></span>
    </div>
    <div class="dls-legend">
      <span class="done">${c.completed} done</span>
      <span class="prog">${c.inProgress} downloading</span>
      <span class="queue">${c.queued} queued</span>
    </div>`;
}

// Show a spinner ONLY until the first successful load (the library lookups make the first
// fetch slow); the 4s background refreshes then update in place with no flicker.
let dlLoaded = false, dlInflight = false;
function setDlLoading(v) { const el = $('#downloads-loading'); if (el) el.hidden = !v; }
async function pollDownloads() {
  if (offline) { setDlLoading(false); return; }
  if (dlInflight) return;                                     // a poll is still running — don't stack another
  if (!dlLoaded) setDlLoading(true);
  dlInflight = true;
  try {
    const data = await getJSON('/api/downloads');
    dlLoaded = true;
    setDlLoading(false);
    renderDownloads(data.items || []);
    renderDlSummary(data.summary);
  } catch { if (dlLoaded) setDlLoading(false); /* else keep spinner; it retries next tick */ }
  finally { dlInflight = false; }
}

// ── Library + delete ──
let libApp = 'radarr';
let libItems = [];
$('#lib-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  $$('#lib-toggle button').forEach((x) => x.classList.toggle('active', x === b));
  libApp = b.dataset.app;
  loadLibrary();
});
$('#lib-search').addEventListener('input', renderLibrary);

function renderLibrary() {
  const q = $('#lib-search').value.trim().toLowerCase();
  const items = q ? libItems.filter((m) => m.title.toLowerCase().includes(q)) : libItems;
  $('#library-empty').hidden = items.length > 0;
  $('#library-empty').textContent = libItems.length ? 'No matches.' : 'Nothing here yet.';
  $('#library').innerHTML = items.map((m) => `
    <li class="row">
      <span class="grow">
        <span class="title">${esc(m.title)}${m.year ? ` <span class="muted">(${m.year})</span>` : ''}</span>
        <div class="sub">${m.hasFile ? fmtBytes(m.sizeBytes) + ' on disk' : 'Not downloaded'}</div>
      </span>
      <button class="trash" data-id="${m.id}" aria-label="Remove ${esc(m.title)}">
        <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m1 0v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7"/></svg>
      </button>
    </li>`).join('');
  $$('#library .trash').forEach((btn) => btn.addEventListener('click', () => openSheet({ app: libApp, id: +btn.dataset.id })));
}
async function loadLibrary() {
  if (offline) { $('#library').innerHTML = ''; $('#library-empty').hidden = false; $('#library-empty').textContent = 'Connect to your home network to manage your library.'; return; }
  try { libItems = (await getJSON(`/api/library?app=${libApp}`)).items || []; renderLibrary(); }
  catch { $('#library').innerHTML = ''; $('#library-empty').hidden = false; }
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
        <span><span class="app">${esc(p.app)}</span> — ${esc(p.action)}</span>
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
    await postJSON('/api/delete', { ...body, dryRun: false });
    if (!isDl) { libItems = libItems.filter((m) => m.id !== id); renderLibrary(); }
    toast(freed ? `Freed ${fmtBytes(freed)}` : 'Removed');
    pollHome();
    if (isDl) pollDownloads();
  } catch { toast('Something went wrong'); }
  finally { $('#sheet-confirm').textContent = 'Remove'; closeSheet(); }
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
