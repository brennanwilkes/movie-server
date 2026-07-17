'use strict';
// Part 5/9 — Home tab: services list with VPN/Tailscale/indexer-health rows
// folded in, deep-link launcher fallback, disk meter, host stats, pollHome().

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
      ? `<a class="row" href="${esc(sameHost(s.url))}" target="_blank" rel="noopener noreferrer">${inner}</a>`
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
    if (qb && qb.up) { qb.sub = 'Protected' + (loc ? ' via ' + loc : ''); qb.subClass = ''; }
    vpnRow.up = true; vpnRow.dotClass = 'up';
    vpnRow.sub = 'Connected ' + vpn.public_ip + (vpn.port ? ':' + vpn.port : '');
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
// Append a "Mesh" row for the Tailscale link to the family network. Green = on the mesh (shows this
// box's 100.x IP so you can hand it to family); amber = daemon up but not connected yet; red = off.
// Kept terse (IP / "Connecting…" / "Offline") so it never wraps on a phone.
function withTailscale(rows, ts) {
  if (!ts) return rows;
  const r = { id: 'tailscale', name: 'Mesh', brand: 'Tailscale' };
  if (ts.connected) {
    r.up = true; r.dotClass = 'up'; r.sub = ts.ip || 'Connected';
  } else if (ts.up) {
    r.up = false; r.dotClass = 'warn'; r.sub = 'Connecting…'; r.subClass = 'warn';
  } else {
    r.up = false; r.dotClass = 'down'; r.sub = 'Offline'; r.subClass = 'danger';
  }
  return [...rows, r];
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
    const [status, disk, sys, vpn, ts, ix] = await Promise.all([getJSON('/api/status'), getJSON('/api/disk'), getJSON('/api/system').catch(() => null), getJSON('/api/vpn').catch(() => null), getJSON('/api/tailscale').catch(() => null), getJSON('/api/indexers').catch(() => null)]);
    setOffline(false);
    $('#live-btn').hidden = true;
    renderServices(withIndexerHealth(withTailscale(withVPN(status, vpn), ts), ix));
    lastDisk = disk;
    renderDisk(disk);
    renderSystem(sys);
  } catch { setOffline(true); renderLauncher(); }
}

// Show indexer health as a subtitle on the Prowlarr row ("Sources").
// Green = all OK; amber = some indexers failing (shows count + names).
function withIndexerHealth(rows, ix) {
  if (!ix || !ix.indexers) return rows;
  const r = rows.find((x) => x.id === 'prowlarr');
  if (!r) return rows;
  if (ix.degraded === 0) {
    r.sub = 'All ' + ix.enabled + ' OK';
    r.subClass = '';
    r.dotClass = 'up';
  } else {
    const names = ix.indexers.filter((x) => x.enabled && !x.healthy).map((x) => x.name).join(', ');
    r.sub = ix.degradedPct + '% degraded (' + names + ')';
    r.subClass = 'warn';
    r.dotClass = 'warn';
  }
  return rows;
}
