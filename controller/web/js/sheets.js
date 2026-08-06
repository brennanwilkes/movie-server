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
//
// EXCEPT for an in-flight Audit replacement (target.swap), which must NOT go anywhere near that
// teardown. A swap is zero-gap: the copy being replaced is still on disk and still playable, and the
// replacement torrent resolves to the SAME library id — so the layered plan would delete the film
// the user is trying to keep. That row asks a different question entirely and calls
// /api/torrent/delete, which only removes the torrent. The server refuses the other path too, so a
// stale tab cannot get through (see /api/delete).
async function openSheet(target) {
  if (target.swap) return openSwapCancelSheet(target);
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

// Cancel an Audit replacement download. Deliberately NOT a dry-run of /api/delete: there is nothing
// to enumerate, because exactly one thing happens — the replacement torrent goes away. Saying so
// plainly, and naming what is kept, is the whole point. Wording matters here: the old sheet asked
// "Remove <release> everywhere?" for this row, which is the opposite of what the user wanted.
function openSwapCancelSheet(target) {
  pending = { isDl: true, swap: true, body: { hash: target.hash } };
  const keeping = (target.swap && target.swap.title) || 'the copy you already have';
  $('#sheet-title').textContent = 'Cancel this replacement download?';
  $('#sheet-sub').textContent = `Your current copy of ${keeping} stays exactly as it is — nothing in the library is deleted.`;
  $('#sheet-plan').innerHTML = `
    <li class="run"><span class="badge">1</span><span><span class="app">qbittorrent</span> · remove the replacement download</span></li>
    <li class="skip"><span class="badge">–</span><span><span class="app">library</span> · your existing file is kept</span></li>
    <li class="skip"><span class="badge">–</span><span><span class="app">audit</span> · the upgrade can be offered again later</span></li>`;
  $('#sheet-confirm').disabled = false;
  $('#sheet-backdrop').hidden = false;
}

$('#sheet-confirm').addEventListener('click', async () => {
  if (!pending) return;
  if (pending.swap) {
    const { body } = pending;
    $('#sheet-confirm').disabled = true;
    $('#sheet-confirm').textContent = 'Cancelling…';
    try {
      await postJSON('/api/torrent/delete', body);
      toast('Replacement cancelled — your copy is untouched');
      pollDownloads();
    } catch { toast('Could not cancel the download'); }
    finally { $('#sheet-confirm').textContent = 'Remove'; closeSheet(); }
    return;
  }
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

// Badges for one release. The SERVER now derives every signal (res/codec/audio/source/scope/
// coverage) with the same shared rules the Audit tab uses, so this only decides colour and wording —
// it no longer re-parses the title, which is how the two surfaces used to disagree about the
// same release.
function relPill(text, cls) { return text ? `<span class="format${cls ? ` ${cls}` : ''}">${esc(text)}</span>` : ''; }
function releasePills(r) {
  const out = [];
  // COVERAGE FIRST — the single most decision-relevant fact. For The Wire, four of the top five
  // releases were packs of seasons already complete; that is now stated rather than implied.
  // `wanted` is the season of the row that was clicked — stated intent, so it is said first and
  // said plainly. Null when the picker was opened without a release to point at.
  if (r.wanted === true) out.push(relPill('this season', 'ok'));
  else if (r.wanted === false) out.push(relPill('different season', 'warn'));
  if (r.coverage === 'gap') out.push(relPill('fills your gap', 'ok'));
  else if (r.coverage === 'complete') out.push(relPill('already have these', 'bad'));
  // Scope: an episode vs a season pack vs a 5-season 138 GB pack is a very different commitment.
  if (r.scopeLabel) {
    const label = r.scope === 'episode' && r.episode != null && r.seasons
      ? `S${String(r.seasons[0]).padStart(2, '0')}E${String(r.episode).padStart(2, '0')}`
      : r.scope === 'season' && r.seasons ? `Season ${r.seasons[0]}`
      : r.scope === 'multi' && r.seasons ? `Seasons ${r.seasons[0]}–${r.seasons[r.seasons.length - 1]}`
      : r.scope === 'multi' ? 'Complete series'
      : r.scopeLabel;
    out.push(relPill(label, r.scope === 'unknown' ? 'warn' : ''));
  }
  if (r.res) out.push(relPill(`${r.res}p`, r.res >= 1080 ? 'ok' : r.res >= 720 ? 'warn' : 'bad'));
  // Source tier: srcRank comes from the shared SRC_RANK table (Remux 5 … DVD 1).
  if (r.source) out.push(relPill(r.source, r.srcRank >= 4 ? 'ok' : r.srcRank >= 3 ? 'warn' : 'bad'));
  if (r.reenc) out.push(relPill('re-encode', 'warn'));
  if (r.codec) out.push(relPill(r.codec, ''));
  // 10-bit HEVC software-decodes on this NUC — worth flagging, not worth refusing.
  if (r.tenbit) out.push(relPill('10-bit', 'warn'));
  if (r.audio) out.push(relPill(r.audio, ''));
  return out.join('');
}
// Same seed bands as the Audit card's seedPill (web/js/audit.js) — below 3 is RED, because at 0-2
// seeders the honest statement is "this will probably never finish", and this picker exists precisely
// for rescuing a dead swarm, so it is the LAST place that risk should read as mere caution.
// `.format.warn` / `.format.bad` already carry the amber/red treatment inside .result-meta.
const seedClass = (n) => (n < 3 ? 'bad' : (n < 5 ? 'warn' : ''));
function releaseCard(r, i) {
  return `<div class="result-row">
    <div class="result-info">
      <div class="result-title">${esc(r.title)}</div>
      <div class="result-meta">${releasePills(r)}</div>
      <div class="result-meta result-sub"><span class="format ${seedClass(r.seeders)}">${r.seeders} seeders</span> · ${fmtBytes(r.size)} · ${esc(r.indexer || 'unknown')}</div>
    </div>
    <button class="result-grab" data-idx="${i}">Grab</button>
  </div>`;
}

function closeForceGrab() { $('#force-backdrop').hidden = true; forceGrabResults = []; }

async function openForceGrabSheet(app, id, want) {
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
    const data = await postJSON('/api/force-grab/search', { app, id, want: want || undefined });
    // Item info — a series shows monitored seasons/TVDB/episode count; a movie shows year + runtime.
    if (data.movie || data.series) {
      const s = data.movie || data.series;
      const isMovie = !!data.movie;
      let detail;
      if (isMovie) {
        detail = s.runtime ? ` · ${s.runtime} min` : '';
      } else if (s.monitoredSeasonCount) {
        detail = `${s.tvdbId ? ` · TVDB ${s.tvdbId}` : ''}${s.episodeCount ? ` · ${s.episodeCount} eps` : ''} · ${s.monitoredSeasonCount} season${s.monitoredSeasonCount > 1 ? 's' : ''} monitored`;
      } else {
        detail = `${s.tvdbId ? ` · TVDB ${s.tvdbId}` : ''}${s.episodeCount ? ` · ${s.episodeCount} eps` : ''}<span class="warn-text"> · No monitored seasons</span>`;
      }
      $('#force-series').innerHTML = `${esc(s.title)} (${s.year})${detail}`;
    } else {
      $('#force-series').innerHTML = '<span class="muted">Info unavailable</span>';
    }
    // Results. `results` are the ones worth offering; `weak` are below the resolution floor and are
    // kept behind a disclosure rather than dropped — this picker exists precisely for the case where
    // nothing good is seeded, so hiding the last resort outright would defeat it.
    const good = data.results || [], weak = data.weak || [];
    // ONE array backs the Grab handler, so data-idx stays valid across both lists.
    forceGrabResults = good.concat(weak);
    forceGrabSeries = data.series || null;
    if (!forceGrabResults.length) {
      // Say WHY nothing is offered. A bare "none found" reads as "this show does not exist"
      // when the truth is usually "17 existed and every one was a dub".
      const c = data.counts;
      const unit = data.movie ? 'for this film' : 'for this series';
      const why = (data.refused || []).map((x) => `${x.n} ${x.reason}`).join(', ');
      $('#force-sub').textContent = c && c.raw
        ? `No usable releases — ${c.raw} found, ${c.series} for this title${why ? `, refused: ${why}` : ''}`
        : 'No grabbable releases found';
      $('#force-results').innerHTML = '';
      return;
    }
    // What we are actually missing, so the "fills your gap" pills have a stated meaning.
    const gapNote = data.gapLabel ? ` · missing ${esc(data.gapLabel)}` : '';
    $('#force-sub').innerHTML = `${good.length} release${good.length === 1 ? '' : 's'} offered${gapNote}`;
    let html = good.map((r, i) => releaseCard(r, i)).join('');
    if (weak.length) {
      html += `<details class="force-weak"><summary>${weak.length} lower-quality option${weak.length === 1 ? '' : 's'} (below 720p)</summary>`
        + weak.map((r, i) => releaseCard(r, good.length + i)).join('') + '</details>';
    }
    // Honest accounting of what was filtered out, so a short list is never mistaken for a dead show.
    if (data.counts && data.counts.raw > forceGrabResults.length) {
      const why = (data.refused || []).map((x) => `${x.n} ${x.reason}`).join(', ');
      html += `<p class="force-filtered">${data.counts.raw} found · ${data.counts.series} for this ${data.movie ? 'film' : 'series'}`
        + `${why ? ` · refused ${esc(why)}` : ''}</p>`;
    }
    $('#force-results').innerHTML = html;
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
