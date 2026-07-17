'use strict';
// Part 8/9 — modal sheets: layered delete confirm (dry-run plan), redownload
// tier picker (movies), and the force-grab release picker.

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

// ── Force-grab sheet ──
let forceGrabResults = [];
let forceGrabApp = null;
let forceGrabId = null;
let forceGrabSeries = null;

// Parse resolution + source from a release title, return coloured badge info.
function parseReleaseMeta(title) {
  const resMatch = title.match(/[.\s[(_-](\d{3,4})p[.\s[)\])\/-]/i);
  let resolution = '', resCls = '';
  if (resMatch) {
    resolution = `${resMatch[1]}p`;
    const r = parseInt(resMatch[1]);
    resCls = r >= 2160 ? 'bad' : 'ok';
  }
  const srcMatch = title.match(/[.\s[(_-](WEB-DL|WEBRip|BluRay|BDRip|HDTV|REMUX|DVDRip|HDRip|SATRip)[.\s[)\])\/-]/i);
  let source = '', srcCls = '';
  if (srcMatch) {
    source = srcMatch[1];
    const s = source.toUpperCase();
    if (s === 'REMUX' || s === 'BDRIP' || s === 'DVDRIP') srcCls = 'bad';
    else if (s === 'WEB-DL' || s === 'BLURAY') srcCls = 'ok';
    else srcCls = 'warn';
  }
  const fmtParts = [resolution, source].filter(Boolean);
  const fmtLabel = fmtParts.join(' ');
  const fmtCls = resCls || srcCls || '';
  return { fmtLabel, fmtCls };
}

function closeForceGrab() { $('#force-backdrop').hidden = true; forceGrabResults = []; }

async function openForceGrabSheet(app, id) {
  forceGrabResults = [];
  forceGrabApp = app;
  forceGrabId = id;
  const backdrop = $('#force-backdrop');
  $('#force-title').textContent = 'Manual Grab';
  $('#force-series').textContent = 'Loading series info…';
  $('#force-sub').textContent = 'Searching for releases…';
  $('#force-results').innerHTML = '<p class="force-loading"><span class="pulse">Searching for releases…</span></p>';
  backdrop.hidden = false;
  try {
    const data = await postJSON('/api/force-grab/search', { app, id });
    // Series info
    if (data.series) {
      const s = data.series;
      const seasonInfo = s.monitoredSeasonCount
        ? `${s.monitoredSeasonCount} season${s.monitoredSeasonCount > 1 ? 's' : ''} monitored`
        : '<span class="warn-text">No monitored seasons</span>';
      const tvdb = s.tvdbId ? ` · TVDB ${s.tvdbId}` : '';
      const eps = s.episodeCount ? ` · ${s.episodeCount} eps` : '';
      $('#force-series').innerHTML = `${esc(s.title)} (${s.year})${tvdb}${eps} · ${seasonInfo}`;
    } else {
      $('#force-series').innerHTML = '<span class="muted">Series info unavailable</span>';
    }
    // Results
    if (!data.results || !data.results.length) {
      $('#force-sub').textContent = 'No grabbable releases found';
      $('#force-results').innerHTML = '';
      return;
    }
    $('#force-sub').textContent = `${data.results.length} release${data.results.length > 1 ? 's' : ''} available`;
    forceGrabResults = data.results;
    forceGrabSeries = data.series || null;
    $('#force-results').innerHTML = data.results.map((r, i) => {
      const { fmtLabel, fmtCls } = parseReleaseMeta(r.title || '');
      const fmtBadge = fmtLabel ? `<span class="format ${fmtCls}">${esc(fmtLabel)}</span>` : '';
      return `<div class="result-row">
        <div class="result-info">
          <div class="result-title">${esc(r.title)}</div>
          <div class="result-meta">${fmtBadge}${r.seeders} seeders · ${fmtBytes(r.size)} · ${esc(r.indexer || 'unknown')}</div>
        </div>
        <button class="result-grab" data-idx="${i}">Grab</button>
      </div>`;
    }).join('');
  } catch (err) {
    $('#force-series').innerHTML = '';
    $('#force-sub').textContent = 'Search failed';
    $('#force-results').innerHTML = `<p class="force-error">${esc(err.message || 'Unknown error')}</p>`;
  }
}
$('#force-close').addEventListener('click', closeForceGrab);
$('#force-backdrop').addEventListener('click', (e) => { if (e.target === $('#force-backdrop')) closeForceGrab(); });
$('#force-results').addEventListener('click', async (e) => {
  const btn = e.target.closest('.result-grab');
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  const rel = forceGrabResults[idx];
  if (!rel) return;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    await postJSON('/api/force-grab', { app: forceGrabApp, id: forceGrabId, release: rel });
    toast(`Grabbing: ${esc(rel.title || 'release')}`);
    closeForceGrab();
    pollDownloads();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Grab';
    toast(`Grab failed: ${err.message || ''}`);
  }
});
