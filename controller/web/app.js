'use strict';
// Served by the controller over HTTP → relative API (same-origin) works fully.
// Served by GitHub Pages over HTTPS → point at the NUC; those calls are blocked
// (mixed content) and we degrade gracefully to the "not home" banner + deep-links.
const API = location.protocol === 'https:' ? 'http://192.168.1.74:8088' : '';

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
  try { history.replaceState(null, '', '?tab=' + name); } catch { /* ignore */ } // survive refresh
  if (name === 'library') loadLibrary();
}
$$('.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ── Home: status + disk ──
function renderServices(list) {
  const seerr = list.find((s) => s.id === 'jellyseerr');
  if (seerr) $('#request-btn').href = seerr.url;
  $('#services').innerHTML = list.map((s) => `
    <a class="row" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">
      <span class="dot ${s.up ? 'up' : ''}"></span>
      <span class="grow"><span class="title">${esc(s.name)}</span>${s.up ? '' : '<div class="sub">Not responding</div>'}</span>
      <span class="brand">${esc(s.brand || '')}</span>
      <span class="chev">›</span>
    </a>`).join('');
}
function renderDisk(d) {
  const used = d.used_bytes, cap = d.cap_bytes;
  const pct = Math.min(100, d.used_pct || 0);
  $('#disk-text').textContent = `${fmtBytes(used)} of ${fmtBytes(cap)} used`;
  const fill = $('#disk-fill');
  fill.style.width = pct + '%';
  fill.classList.toggle('warn', pct >= 80 && pct < 92);
  fill.classList.toggle('full', pct >= 92);
}
async function pollHome() {
  try {
    const [status, disk] = await Promise.all([getJSON('/api/status'), getJSON('/api/disk')]);
    setOffline(false);
    renderServices(status);
    renderDisk(disk);
  } catch { setOffline(true); }
}

// ── Downloads ──
function renderDownloads(items) {
  $('#downloads-empty').hidden = items.length > 0;
  $('#downloads').innerHTML = items.map((d) => {
    const eta = d.state === 'Downloading' ? fmtEta(d.etaSeconds) : '';
    const meta = [d.state, d.progress < 100 && d.state !== 'Seeding' ? d.progress + '%' : '', eta].filter(Boolean).join(' · ');
    return `<li class="row dl">
      <div class="line"><span class="title">${esc(d.title)}</span><span class="muted">${esc(fmtBytes(d.sizeBytes))}</span></div>
      <div class="mini-bar"><div style="width:${Math.min(100, d.progress)}%${d.state === 'Done' ? ';background:var(--ok)' : ''}"></div></div>
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

// ── Polling ──
function poll(fn, ms) { fn(); return setInterval(fn, ms); }
poll(pollHome, 10000);
poll(pollDownloads, 4000);
const startTab = new URLSearchParams(location.search).get('tab');
showTab(['home', 'downloads', 'library'].includes(startTab) ? startTab : 'home');
