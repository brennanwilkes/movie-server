'use strict';
// Part 7c/11 — Library (Quality) tab: one unit all the way down, plus the history that makes the
// phone's back gesture work. A sub-view of #tab-library, not a modal — there is far too much here
// for a sheet, and the app's sheets are bottom-anchored and capped at 80vh.

let qHistReady = false;

// ---- navigation ──────────────────────────────────────────────────────────────────────────────
// The URL carries the state so a reload and a shared link both work; a hash keeps express.static
// serving index.html. history.state is the single source of truth — never a private copy, or the
// view and the stack drift apart.
function qHistInit() {
  if (qHistReady) return;
  qHistReady = true;
  try { history.scrollRestoration = 'manual'; } catch { /* ignore */ }

  window.addEventListener('popstate', (e) => {
    const s = e.state || {};
    if (s.qfilm) {
      if (localStorage.getItem('tab') !== 'library') showTab('library');
      qShowFilm(s.qfilm);
    } else if (qState.view === 'film') {
      // Do NOT force a tab switch on the way out — the user may have left the tab entirely.
      qShowList();
    }
  });

  // A film restored from history or a link CANNOT be resolved until the list has loaded — byKey is
  // empty at boot, and looking up a season then reported "tv:88:2 is no longer in the library".
  const s0 = history.state || {};
  const want = s0.qfilm
    || (location.hash.startsWith('#film=') ? decodeURIComponent(location.hash.slice(6)) : '');
  if (!want) {
    if (location.hash) { try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ } }
    return;
  }
  showTab('library');
  (async () => { await qLoad(false); qRender(); qShowFilm(want); })();
}

function qGoFilm(key) {
  qState.listScrollY = window.scrollY;
  try { history.pushState({ tab: 'library', qfilm: key }, '', `#film=${encodeURIComponent(key)}`); }
  catch { /* ignore */ }
  qShowFilm(key);
}

// The BACK GESTURE pops, so the stack stays honest.
function qGoList() {
  if (history.state && history.state.qfilm) history.back();
  else qShowList();
}

// The TAB BAR does not: tapping Library is "show me the table", not "go back one". It drops the
// film entry rather than replaying it, so a second tap can never walk further back.
function qResetToList() {
  if (history.state && history.state.qfilm) {
    try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
  }
  qShowList();
}

function qShowList() {
  qState.view = 'list';
  qState.filmKey = null;
  $('#q-film').hidden = true;
  $('#q-list').hidden = false;
  // After relayout, or the restore lands against a collapsed document height.
  requestAnimationFrame(() => window.scrollTo(0, qState.listScrollY || 0));
}

async function qShowFilm(key) {
  qState.view = 'film';
  qState.filmKey = key;
  $('#q-list').hidden = true;
  const host = $('#q-film');
  host.hidden = false;
  window.scrollTo(0, 0);

  const row = qState.byKey.get(key);
  host.innerHTML = qFilmShell(row, key);
  qFilmWire(key);
  if (!row) return;

  // The deep row (per-clip arrays, per-detector levels and z) is a separate ~3 KB fetch.
  try {
    const deep = await qLoadFilm(key);
    if (qState.filmKey !== key) return;                  // navigated away mid-fetch
    host.innerHTML = qFilmShell(row, key, deep);
    $('#qf-deep').innerHTML = qFilmDeep(row, deep);
    qFilmWire(key, deep);
  } catch {
    if (qState.filmKey !== key) return;
    const w = $('#qf-deep');
    if (w) w.innerHTML = '<p class="empty">Could not load the detailed measurements.</p>';
  }
}

// ---- render ──────────────────────────────────────────────────────────────────────────────────
function qFilmShell(r, key, deep) {
  if (!r) {
    return '<div class="card qf-gone">'
      + qfBackBtn()
      + '<h3>This title is no longer in the library</h3>'
      + `<p class="muted">${esc(key)} was removed, or the measurement list has been refreshed since.</p>`
      + '</div>';
  }
  const band = r.bppBand || 'off';
  const conf = [];
  if (bppEstimated(r.cxBasis)) conf.push('estimated');
  if (r.sampleState === 'detailed' && r.sampleN) conf.push(`${r.sampleN} clips`);
  else conf.push('≥8 clips');
  if (r.bppRSE != null) conf.push(`±${Math.round(r.bppRSE * 100)}%`);
  if (r.artState === 'stale') conf.push('artifacts stale');

  const hhmm = (sec) => (sec ? `${Math.floor(sec / 3600)}h ${String(Math.round((sec % 3600) / 60)).padStart(2, '0')}m` : '—');
  const mins = (sec) => (sec ? `${Math.round(sec / 60)}` : '—');
  const tv = r.kind === 'season';
  // The two adjustment terms, in POINTS of BPP+ — the before/after the removed panel showed, now
  // stated as a number. Provenance is zero-sum across the library; adequacy can move the median.
  const pts = (v) => (v == null ? ['—', ''] : [`${v > 0 ? '+' : ''}${v.toFixed(0)}`,
    Math.abs(v) < 0.5 ? 'mute' : (v > 0 ? 'up' : 'down')]);
  const [provTxt, provCls] = pts(r.provDelta);
  const [adqTxt, adqCls] = pts(r.adqDelta);
  const termTiles = [
    ['provenance', provTxt, 'pts', `term ${provCls}`],
    ['adequacy', adqTxt, 'pts', `term ${adqCls}`],
  ];

  // PLAIN FACTS. The model's own numbers — complexity, R, the pinning factor — belong on the
  // distribution rows below, where they come with a scale; up here they were both duplicated and
  // the least useful thing to lead with.
  const tiles = tv
    ? [
      ['episodes', r.episodes || '—', ''],
      ['per episode', mins(r.epRuntime), 'min'],
      ['season runtime', hhmm(r.totalRuntime), ''],
      ['season size', r.gb == null ? '—' : r.gb.toFixed(1), 'GB'],
      ['resolution', r.res || '—', ''],
      ['frame rate', deep && deep.fps ? deep.fps.toFixed(2) : '—', ''],
      ['codec', r.videoLabel || '—', ''],
      ['source', r.tier || '—', '', `src-${srcTierCls(r.source) || 'mid'}`],
      ...termTiles,
    ]
    : [
      ['runtime', hhmm(r.totalRuntime), ''],
      ['size', r.gb == null ? '—' : r.gb.toFixed(1), 'GB'],
      ['resolution', r.res || '—', ''],
      ['frame rate', deep && deep.fps ? deep.fps.toFixed(2) : '—', ''],
      ['codec', r.videoLabel || '—', ''],
      ['source', r.tier || '—', '', `src-${srcTierCls(r.source) || 'mid'}`],
      // A TV season is keyed by tvdbId and is never in the (movie) playlist, so it reads "–"
      // rather than claiming an absence of rank.
      ['top 100', r.top100 ? `#${r.top100}` : '–', '', r.top100 ? 'rank' : ''],
      ['audio', r.audioShare == null ? '—' : Math.round(r.audioShare * 100), '% of file'],
      ...termTiles,
    ];

  // Resolution, source, codec and the Top 100 rank are all TILES below, so the hero carries only
  // what the tiles cannot: which season this is, and how well measured the score is.
  const badges = tv ? [`<span class="flg s">S${String(r.season).padStart(2, '0')}</span>`] : [];

  return '<div class="card">'
    // .ftop stacks on a phone and becomes ONE inline row from 700px: back, title, score, band.
    + '<div class="ftop">'
    + '<div class="fhead">'
      + qfBackBtn()
      + '<div class="fhead-t">'
        + `<div class="ftitle">${esc(r.name)}${r.year ? ` <span class="muted">${r.year}</span>` : ''}</div>`
      + '</div>'
    + '</div>'
    + `<div class="fhero q-${band}">`
      + `<div class="fplus">${r.bppPlus == null ? '—' : r.bppPlus}</div>`
      + '<div class="fhero-r">'
        + `<div class="fband-row"><span class="fband" title="${esc(qBandWord(r.bppPlus)[1])}">${esc(qBandWord(r.bppPlus)[0])}</span>`
          + `${badges.join('')}<span class="fconf">${esc(conf.join(' · '))}</span></div>`
      + '</div>'
    + '</div>'
    + '</div>'
    + `<div class="qstats">${tiles.map(([l, v, u, cls]) => '<div class="stat">'
      + `<div class="stat-label">${esc(l)}</div>`
      + `<div class="stat-val${cls ? ` ${cls}` : ''}">${esc(String(v))}${u ? `<small>${esc(u)}</small>` : ''}</div></div>`).join('')}</div>`
    + '</div>'
    + `<div id="qf-deep">${deep ? '' : '<div class="loading"><span class="spinner sm"></span>Loading measurements…</div>'}</div>`
    + qFilmActions(r);
}

const qfBackBtn = () => '<button class="fback" id="qf-back" aria-label="Back to the library">'
  + '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>';

// The band as ONE WORD. Colour is the identity channel and cannot carry the ordering (the four
// hues are not a scale — L* is non-monotone), so the rung is named. Compromised < Diminished <
// Ideal < Surplus reads as an ordered set on its own; the sentence lives in the tooltip.
const Q_BAND_WORD = [
  [125, 'Surplus', 'More bits than this house can resolve — it starts to pay off only after a display upgrade.'],
  [100, 'Ideal', 'Spends about what a visually transparent encode of this film costs.'],
  [75, 'Diminished', 'Fewer bits than this film needs. May still look fine — that is the human call.'],
  [0, 'Compromised', 'Well short of what this film needs.'],
];
function qBandWord(plus) {
  if (plus == null) return ['Not scored', ''];
  for (const [lo, word, help] of Q_BAND_WORD) if (plus >= lo) return [word, help];
  return ['Compromised', ''];
}

// The actions the old flat Library tab carried. AGENTS.md documents "dashboard Library tab →
// Redownload" as the fix for a 10-bit file the GPU sweep missed, so this must not be lost.
// Replacements live on the Audit tab now, so this is a delete path and nothing else.
function qFilmActions() {
  return '<div class="card qf-act">'
    + '<div class="qf-act-row"><button class="btn-danger" id="qf-del">Remove</button></div>'
    + '</div>';
}

function qFilmWire(key, deep) {
  const back = $('#qf-back');
  if (back) back.addEventListener('click', qGoList);
  const r = qState.byKey.get(key);
  if (!r) return;
  if (deep) {
    qcDraw(r, deep);
    qcWire(r, deep);
    // Sibling seasons navigate.
    $$('#qf-deep [data-k]').forEach((el) => {
      el.addEventListener('click', () => qGoFilm(el.dataset.k));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); qGoFilm(el.dataset.k); } });
    });
  }
  // Per-panel help: only that panel's paragraph, never artifact-copy.js's two 5KB essays in one
  // modal — that is a wall of text on a phone.
  $$('#q-film .qhelp').forEach((b) => b.addEventListener('click', () => {
    $('#qf-help-text').textContent = b.dataset.help;
    $('#qf-help-title').textContent = (b.closest('.panel-head') || {}).querySelector
      ? b.closest('.panel-head').querySelector('h3').textContent : 'About';
    $('#qf-help-backdrop').hidden = false;
  }));
  const del = $('#qf-del');
  if (del) {
    del.addEventListener('click', () => openSheet({ app: qAppOf(key), id: qArrId(key), title: r.name }));
  }

}

// ---- panels ──────────────────────────────────────────────────────────────────────────────────
// Everything below renders into #qf-deep once the ?key= row lands.
function qFilmDeep(r, deep) {
  return qfSeasons(r) + qfPercentiles(r) + qfArtifacts(r, deep)
    + qfChart(r, deep) + qfPriors(deep);
}

// Peers are ALWAYS same-kind, whatever the list filter says: a movie is never ranked against TV
// seasons.
const qfPeers = (r) => qState.rows.filter((x) => x.kind === r.kind && x.cxEff > 0);

// A percentile against a reference is TWO POSITIONS, so it is drawn as two positions. The faint
// peer histogram makes "78th" self-evident instead of asserted.
//
// THE AXIS STOPS AT THE 98th PERCENTILE. A handful of outliers — one 1206 complexity against a
// median of 104, one 50 GB remux — stretched the domain so far that the entire library bunched
// into the left eighth of every track. Anything past the cap is drawn pinned at the end and the
// domain label says "+", which is honest and legible; a true axis was neither.
function qfRow(label, vals, val, txt, ref, refTxt, band, bandBins, ghost) {
  const a = vals.filter((v) => v != null).sort((x, y) => x - y);
  if (!a.length || val == null) return '';
  const lo = a[0];
  const p98 = a[Math.min(a.length - 1, Math.floor(a.length * 0.98))];
  const hi = p98 > lo ? p98 : a[a.length - 1];
  if (!(hi > lo)) return '';
  const clamped = Math.min(val, hi);
  const beyond = a.filter((v) => v > hi).length;
  const pct = Math.round((a.filter((v) => v < val).length / a.length) * 100);
  const at = (v) => ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * 100;
  const N = 40;
  const bins = new Array(N).fill(0);
  for (const v of a) bins[Math.min(N - 1, Math.floor(((Math.min(v, hi) - lo) / (hi - lo)) * N))]++;
  const mx = Math.max(...bins);
  // Coloured bins put the thresholds INTO the distribution rather than leaving them to a tick:
  // 'bpp' shades by the 75/100/125 bands, 'pct' by the same green/amber/red the artifact bars use
  // (under half the visibility threshold, approaching it, past it).
  const binCls = (i) => {
    if (!bandBins) return '';
    const v = lo + ((i + 0.5) / N) * (hi - lo);
    if (bandBins === 'pct') return ` b-${v >= 100 ? 'bad' : v >= 50 ? 'warn' : 'ok'}`;
    return ` b-${v >= 125 ? 'wow' : v >= 100 ? 'ok' : v >= 75 ? 'warn' : 'bad'}`;
  };
  const bars = bins.map((n, i) => `<span class="${binCls(i).trim()}" style="left:${(i / N) * 100}%;width:${100 / N}%;height:${Math.max(2, (n / mx) * 100)}%"></span>`).join('');
  const med = a[a.length >> 1];
  const useRef = ref != null && ref > lo && ref < hi;
  const tick = useRef ? ref : med;
  const tickTxt = useRef ? refTxt : `med ${qfNum(med)}`;
  const tx = at(tick);
  return `<div class="pr">
    <div class="pr-top"><span class="pr-l">${esc(label)}</span>
      <span class="pr-v${band ? ` q-${band}` : ''}">${esc(txt)}</span>
      <span class="pr-p">${pct}<sup>th</sup></span></div>
    <div class="pr-track${bandBins ? ' banded' : ''}">
      <div class="pr-hist">${bars}</div>
      <i class="pr-ref${useRef ? '' : ' med'}" style="left:${tx.toFixed(2)}%"></i>
      ${ghost != null && ghost !== val ? (() => {
        const gx = at(Math.min(ghost, hi)); const dx = at(clamped);
        // Both past the 98th-percentile cap clamp to the same x, which would stack two rings and
        // draw a zero-length line. The points tiles still state the change, so drop the marker.
        if (Math.abs(dx - gx) < 1.5) return '';
        return `<i class="pr-join" style="left:${Math.min(gx, dx).toFixed(2)}%;width:${Math.abs(dx - gx).toFixed(2)}%"></i>`
          + `<b class="pr-ghost" style="--x:${gx.toFixed(2)}" title="${esc(`BPP+₀ ${Math.round(ghost)} — before the provenance and adequacy terms`)}"></b>`;
      })() : ''}
      <b class="pr-dot${band ? ` q-${band}` : ''}${val > hi ? ' pinned' : ''}" style="--x:${at(clamped).toFixed(2)}"></b>
    </div>
    <div class="pr-ends"><span>${qfNum(lo)}</span>
      ${tx > 14 && tx < 86 ? `<span class="pr-reflbl" style="left:${tx.toFixed(2)}%">${esc(tickTxt)}</span>` : ''}
      <span>${qfNum(hi)}${beyond ? '+' : ''}</span></div>
  </div>`;
}
const qfNum = (v) => (v == null ? '—' : (Math.abs(v) >= 100 ? String(Math.round(v)) : (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2))));

function qfPercentiles(r) {
  const peers = qfPeers(r);
  return '<div class="card">'
    + '<div class="panel-head"><h3>Where it sits</h3>'
    + qfHelp('Each row is this film as a dot against every other measured '
      + (r.kind === 'movie' ? 'movie' : 'season') + '. The faint shape behind it is how the '
      + 'library is distributed; the dashed line is the reference value, or the median where there '
      + 'is no reference.') + '</div>'
    // The hollow ring on this row is BPP+₀ — where the score sat before provenance and adequacy
    // moved it. It replaces a whole panel: the same before/after, in the one place that already
    // carries the scale it should be read against.
    + qfRow('BPP+', peers.map((x) => x.bppPlus), r.bppPlus, String(r.bppPlus), 100, '100',
      r.bppBand, 'bpp', r.bppPlus0)
    + qfRow('complexity ×1000', peers.map((x) => x.cxMilli), r.cxMilli, String(r.cxMilli), null, '')
    + qfRow('supply R', peers.map((x) => x.R), r.R, r.R == null ? '—' : r.R.toFixed(2), 1, '1.0')
    // Same green/amber/red scale as the artifact bars: under half the threshold, approaching, past.
    + qfRow('banding %', peers.map((x) => x.cambiPct), r.cambiPct,
      r.cambiPct == null ? '—' : `${r.cambiPct}%`, 100, '100',
      r.cambiPct == null ? null : (r.cambiPct >= 100 ? 'bad' : r.cambiPct >= 50 ? 'warn' : 'ok'), 'pct')
    + '</div>';
}

// The threshold sits at the MIDPOINT, not the end: "5.51 vs 2.82" and "7.00 vs 8.03" look alike in
// a column and are not. Neutral fill plus a 45° hatch past the tick — the one severity marker that
// survives every kind of colour blindness.
const QF_DETS = [
  { k: 'cambi', label: 'banding', T: 2.817, more: false },
  { k: 'block', label: 'blocking', T: 3.710, more: false },
  { k: 'blur', label: 'blur', T: 8.026, more: false },
  { k: 'grain', label: 'grain kept', T: 0.905, more: true },
];
function qfArtifacts(r, deep) {
  const lv = deep && deep.artLevels ? deep.artLevels : null;
  const z = deep && deep.artZ ? deep.artZ : null;
  if (!lv) {
    return '<div class="card"><div class="panel-head"><h3>Artifacts</h3></div>'
      + '<p class="empty">Not measured yet.</p></div>';
  }
  const rows = (want) => QF_DETS.filter((d) => d.more === want).map((d) => {
    const v = lv[d.k];
    if (v == null) return `<div class="ab"><span class="ab-l">${esc(d.label)}</span><span class="ab-r">—</span></div>`;
    // grain is inverted: frac = T/level, so a HIGH percentage means the grain was denoised away.
    const frac = d.more ? (v > 0 ? d.T / v : 2) : v / d.T;
    const over = frac >= 1;
    const w = (Math.min(frac, 2) / 2) * 100;
    const zt = z && z[d.k] != null ? ` · residual ${z[d.k] > 0 ? '+' : ''}${z[d.k].toFixed(2)}σ` : '';
    // LOW frac IS GOOD FOR ALL FOUR, grain included — its frac is threshold/level, so a
    // well-grained file lands low just as a clean one does. So one scale colours every bar:
    // green under half the threshold, amber approaching it, red past it.
    const lvl = over ? 'ab-over' : (frac >= 0.5 ? 'mid' : 'lo');
    return `<div class="ab">
      <span class="ab-l">${esc(d.label)}</span>
      <span class="ab-r">${v.toFixed(2)} <i>/ ${d.T.toFixed(2)}</i>
        <b class="pc-${over ? 'over' : lvl}">${Math.round(frac * 100)}%</b></span>
      <div class="ab-track ${lvl}${d.more ? ' rtl' : ''}" title="${esc(d.label)} ${v.toFixed(3)} against a visibility threshold of ${d.T}${zt}">
        <div class="ab-fill" style="width:${w.toFixed(1)}%"></div><i class="ab-tick"></i></div>
    </div>`;
  }).join('');
  return '<div class="card">'
    + '<div class="panel-head"><h3>Artifacts</h3>'
    + qfHelp('Each bar is a measured artifact against the level at which it becomes visible. The '
      + 'tick is that threshold, at the MIDDLE of the bar — so half full is half way to visible, '
      + 'and past the tick the fill is hatched. Grain is the one that runs the other way: grain is '
      + 'content, so keeping it is good and losing it to a denoiser is not.') + '</div>'
    + `<div class="abs">${rows(false)}</div>`
    + '<div class="abhint mt"><span>more is better</span></div>'
    + `<div class="abs">${rows(true)}</div>`
    + '</div>';
}

// Banked upgrade pairs — present on ~15% of units, and what the starved-copy correction was fitted
// from.
function qfPriors(deep) {
  const p = deep && Array.isArray(deep.priors) ? deep.priors : [];
  if (!p.length) return '';
  return '<div class="card"><div class="panel-head"><h3>Earlier copies</h3>'
    + qfHelp('This unit has been measured before, on a file we no longer hold. Each pair of '
      + 'readings is one point in the fit that corrects a starved copy for flattering itself.')
    + '</div><div class="qf-tbl"><div class="qf-tr qf-th"><span>measured</span><span>source</span>'
    + '<span class="n">cx</span><span class="n">R</span></div>'
    + p.slice().sort((a2, b2) => b2.ts - a2.ts).map((x) => `<div class="qf-tr">
        <span>${esc(fmtWhen(x.ts))}</span>
        <span class="qf-src">${esc(x.source || 'unknown')}</span>
        <span class="n">${Math.round((x.complexity || 0) * 1000)}</span>
        <span class="n">${x.R == null ? '—' : x.R.toFixed(2)}</span></div>`).join('')
    + '</div></div>';
}

// Sibling seasons: navigation, so it sits above the hero rather than buried in a panel.
function qfSeasons(r) {
  if (r.kind !== 'season') return '';
  const id = r.key.split(':')[1];
  const sibs = qState.rows.filter((x) => x.kind === 'season' && x.key.split(':')[1] === id)
    .sort((a, b) => a.season - b.season);
  if (sibs.length < 2) return '';
  return `<div class="card qf-seasons-card"><div class="seasons" role="tablist" aria-label="Seasons">${sibs.map((x) => `
    <button class="q-${x.bppBand || 'off'}${x.key === r.key ? ' on' : ''}" data-k="${esc(x.key)}"
      role="tab" aria-selected="${x.key === r.key}">
      <em>S${String(x.season).padStart(2, '0')}</em><b>${x.bppPlus == null ? '—' : x.bppPlus}</b></button>`).join('')}</div></div>`;
}

let qfHelpSeq = 0;
function qfHelp(text) {
  const id = `qfh${++qfHelpSeq}`;
  return `<button class="qhelp" data-help="${esc(text)}" id="${id}" aria-label="What this means">?</button>`;
}
