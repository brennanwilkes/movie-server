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

// Static fallback so the launcher renders the "Tools" without the backend (matches /api/status).
const CATALOG = [
  { id: 'qbittorrent', name: 'Downloads', brand: 'qBittorrent', port: 8080 },
  { id: 'radarr', name: 'Movies', brand: 'Radarr', port: 7878 },
  { id: 'sonarr', name: 'TV Shows', brand: 'Sonarr', port: 8989 },
  { id: 'prowlarr', name: 'Torrents', brand: 'Prowlarr', port: 9696 },
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

async function getJSON(path) {
  const r = await fetch(API + path, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
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
  if (location.protocol === 'https:') { const b = $('#live-btn'); b.href = API; b.hidden = false; }
}
function renderDisk(d) {
  const used = d.used_bytes, cap = d.cap_bytes;
  const pct = Math.min(100, d.used_pct || 0);
  const toGB = b => (b / (1024 ** 3)).toFixed(1);
  $('#disk-text').textContent = `${toGB(used)}/${toGB(cap)} GB`;
  const fill = $('#disk-fill');
  fill.style.width = pct + '%';
  fill.classList.toggle('warn', pct >= 80 && pct < 92);
  fill.classList.toggle('full', pct >= 92);
}
async function pollHome() {
  try {
    const [status, disk] = await Promise.all([getJSON('/api/status'), getJSON('/api/disk')]);
    setOffline(false);
    $('#live-btn').hidden = true;
    renderServices(status);
    renderDisk(disk);
  } catch { setOffline(true); renderLauncher(); }
}

// ── Downloads ──
function renderDownloads(items) {
  $('#downloads-empty').hidden = items.length > 0;
  const COLOR = { 'Needs attention': 'var(--danger)', 'In library': 'var(--ok)', Done: 'var(--ok)', Importing: 'var(--warn)' };
  $('#downloads').innerHTML = items.map((d) => {
    const eta = d.state === 'Downloading' ? fmtEta(d.etaSeconds) : '';
    const meta = [d.state, d.state === 'Downloading' && d.progress ? d.progress + '%' : '', fmtBytes(d.sizeBytes), eta].filter(Boolean).join(' · ');
    const color = COLOR[d.state] || '';
    return `<li class="row dl${d.attention ? ' attn' : ''}">
      <span class="title">${esc(d.title)}</span>
      <div class="mini-bar"><div style="width:${Math.min(100, d.progress)}%${color ? `;background:${color}` : ''}"></div></div>
      <div class="sub">${esc(meta)}</div>
    </li>`;
  }).join('');
}
async function pollDownloads() {
  if (offline) return;
  try { renderDownloads((await getJSON('/api/downloads')).items || []); } catch { /* home poll owns the banner */ }
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
  $$('#library .trash').forEach((btn) => btn.addEventListener('click', () => openSheet(+btn.dataset.id)));
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

async function openSheet(id) {
  const item = libItems.find((m) => m.id === id);
  pending = { app: libApp, id };
  $('#sheet-title').textContent = `Remove “${item ? item.title : 'this title'}” everywhere?`;
  $('#sheet-sub').textContent = 'Checking what will be cleaned up…';
  $('#sheet-plan').innerHTML = '';
  $('#sheet-confirm').disabled = true;
  $('#sheet-backdrop').hidden = false;
  try {
    const plan = await postJSON('/api/delete', { app: libApp, id, dryRun: true });
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
  const { app, id, freed } = pending;
  $('#sheet-confirm').disabled = true;
  $('#sheet-confirm').textContent = 'Removing…';
  try {
    await postJSON('/api/delete', { app, id, dryRun: false });
    libItems = libItems.filter((m) => m.id !== id);
    renderLibrary();
    toast(freed ? `Freed ${fmtBytes(freed)}` : 'Removed');
    pollHome();
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

// ── Home action buttons (static deep-links) ──
$('#request-btn').href = REQUEST_URL;
$('#watch-btn').href = WATCH_URL;

// ── Polling ──
function poll(fn, ms) { fn(); return setInterval(fn, ms); }
poll(pollHome, 10000);
poll(pollDownloads, 4000);
let startTab; try { startTab = localStorage.getItem('tab'); } catch { /* ignore */ }
showTab(['home', 'downloads', 'library'].includes(startTab) ? startTab : 'home');
