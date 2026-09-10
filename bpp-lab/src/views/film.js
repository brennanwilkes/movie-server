import { state, fmt, bandColor, samplesLabel, ARTIFACTS } from '../data.js';
import { mean, stdev } from '../stats.js';
import { el, plot, linear, attachTip, kv, esc } from '../chart.js';
import { panel, stats, table, h, flag, select } from '../ui.js';
import { WHY_ARTIFACT, FLAG_ARTIFACT } from '../artifact-copy.js';

// ONE TITLE, ALL THE WAY DOWN. `sampleCx` holds the per-sample readings the denominator is the mean
// of — everything else in the model is downstream of those few numbers, so a suspicious score can be
// traced to the samples that produced it.

export default function film(host) {
  const pool = state.filtered.length ? state.filtered : state.rows;
  const pick = sessionStorage.getItem('bpp-lab.film');
  const row = pool.find((r) => r.key === pick) || pickDefault(pool);
  const bar = chooser(host, pool, row);
  if (bar) host.appendChild(bar);
  if (!row) return;
  // Headline and artifacts SIDE BY SIDE. Stacked, they were two full-width bands of small numbers
  // and you had to scroll past the first to reach the second — but they are read together ("this
  // film scores 47; why?"), so they belong on one screen.
  const top = h('div', 'grid2 film-top');
  top.append(headline(row, pool), artifactPanel(row));
  host.appendChild(top);
  const g = h('div', 'grid2');
  // The chart's summary numbers render into the RIGHT panel, under a rule. Under the plot they hung
  // off a variable-height svg, drifted from it, and pushed the page into scroll; Nearest by has the
  // spare vertical room. Shared node, so they still follow the series selector.
  const chartFoot = h('div');
  g.append(samplesPanel(row, chartFoot), contextPanel(row, pool, host, chartFoot));
  host.appendChild(g);
  if ((row.priors || []).length) host.appendChild(priorsPanel(row));
}

// THE FOUR DETECTORS FOR THIS FILM, against the thresholds at which each becomes visible, plus what
// they do to the score. Merged here when the Blend tab was deleted: the old tab could only show a
// library-wide scatter and a top-40 movers table, so the one question a person actually asks —
// "why did THIS film move?" — was the one it could not answer.
function artifactPanel(row) {
  const p = panel('Artifacts and provenance', {
    // NO PROSE CAPTION. Every number it used to restate (P, its sign, BPP+0) is a tile below.
    caption: row.artState === 'none' ? 'not measured' : '',
    // Both essays live behind the why button. They are important and they are long, and a wall of
    // prose under a six-number stat row buries the numbers the panel exists to show.
    // The bars' own rules live here rather than as a caption under them. They are reference
    // material — true every time, read once — and a paragraph restating them on every film is the
    // slop this panel just had removed.
    why: `<b>Reading the bars.</b> 100% (the tick at the middle of each track) is the level at which
      that artifact becomes VISIBLE, from CVQAD — not a maximum. A bar can and does run past it;
      beyond 200% the bar is clipped but the number is not. Green under 80%, amber approaching,
      red at or over.<br><br>
      <b>Grain is inverted, deliberately.</b> Three detectors are "more is worse". Grain is "more is
      BETTER" — grain that survives the encode is evidence the master was not denoised — so its bar
      fills as grain is REMOVED. Without the flip it would fill up as the film got cleaner, the same
      sign error the residual direction (+1,+1,+1,&minus;1) exists to handle.<br><br>
      <b>Level is not residual.</b> The bar asks "is this visible at all". The residual (in each
      row's tooltip) asks the different question of whether the bits and content explain it. A film
      can be clean in absolute terms and still carry a positive residual; that is not a
      contradiction.<hr>${WHY_ARTIFACT}<hr>${FLAG_ARTIFACT(state.prov)}`,
  });
  if (row.artState === 'none') {
    p.body.appendChild(h('p', 'empty', 'This unit has no artifact reading yet, so no provenance '
      + 'adjustment is applied and the score shown elsewhere is the unadjusted one. Not measured is '
      + 'not the same as clean.'));
    return p;
  }
  if (row.artState === 'stale') {
    p.body.appendChild(flag('<b>⚠ Stale.</b> The file on disk has a different bitrate from the one '
      + 'these artifacts were measured on, so this reading describes a copy we no longer hold. It is '
      + 'shown for reference and is NOT applied to the score.'));
  }
  const tiles = [
    // BPP+ ITSELF IS NOT HERE — the headline tile owns it. This panel owns the DECOMPOSITION.
    //
    // AND NEITHER ARE provenance, adequacy, elbow c OR provenance P. The first two became the
    // full-width rows below, where the bar has room to mean something; a tile AND a row for the same
    // number is the duplication this page has been shedding all along. The other two are INPUTS to
    // those rows (c drives adequacy, P drives provenance) — worth having, not worth a tile each when
    // the outputs they feed are right there. Both on hover.
    [fmt.int(row.bppPlus0), 'BPP+₀', bandColor(row.bppPlus0)],
    // PINNING AND STARVED-COPY MOVED HERE FROM THE HEADLINE, and it is a better home than an even
    // split: this panel is where the score gets ADJUSTED, and the starved-copy correction is the
    // third adjustment beside provenance and adequacy. The headline is left saying what the file IS
    // — bits, size, samples — which is a cleaner division than "everything that did not fit".
    // Naming tension worth admitting: pinning is not an artifact, and this panel is called
    // "Artifacts and provenance". It sits here because it is a CORRECTION, not because it is one.
    [`×${fmt.n(row.biasFactor, 3)}`, 'pinning', row.biasFactor > 1 ? 'var(--warn)' : null],
    [row.biasFactor > 1 ? `−${fmt.int(row.bppPlus / row.biasOnScore - row.bppPlus)}` : '0',
      'starved-copy', row.biasFactor > 1 ? 'var(--bad)' : 'var(--dim)'],
    [`×${fmt.n(row.artBits, 3)}`, 'effective bits'],
    [row.drives || '—', 'dominant'],
  ];
  // `change` was provenance + adequacy, two tiles to its left. `elbow target` was 100*exp(k*c), a
  // function of `elbow c` beside it. Both were arithmetic the panel did out loud. The cap still
  // matters for reading a ZERO adequacy, so it rides on hover rather than vanishing.
  const agrid = balanced(stats(tiles), tiles.length);
  agrid.title = `change ${row.artDelta > 0 ? '+' : ''}${fmt.n(row.artDelta, 1)}`
    + ` · provenance P ${fmt.n(row.P, 2)}`
    + (row.adqC != null ? ` · elbow c ${fmt.n(row.adqC, 2)} over ${row.adqClips} clips` : '')
    + (row.adqTarget != null ? ` · adequacy pulls toward ${fmt.int(row.adqTarget)}` : '');
  p.body.appendChild(agrid);
  // THE TWO TERMS THAT MOVE THE SCORE, full width, on ONE shared +/-25 scale so they are comparable
  // to each other. They were mini bars inside their tiles; at ~60px they read as clutter beside the
  // number rather than as information. Nothing else in this panel gets a bar: `elbow c`, `P` and
  // `effective bits` are inputs to these two, and drawing five bars would bury the two that matter.
  p.body.appendChild(barRows([
    ['provenance', `${row.provDelta > 0 ? '+' : ''}${fmt.n(row.provDelta, 1)}`,
      { div: +fmt.n(row.provDelta, 1), max: 25, dead: 0.5, note: 'pts' }],
    ...(row.adqDelta == null ? [] : [['adequacy',
      `${row.adqDelta > 0 ? '+' : ''}${fmt.n(row.adqDelta, 1)}`,
      { div: +fmt.n(row.adqDelta, 1), max: 25, dead: 0.5, note: 'pts' }]]),
  ]));
  // Level vs VISIBILITY THRESHOLD per detector, and the standardised residual beside it. Both are
  // needed and they say different things: the level answers "is this visible at all", the residual
  // answers "is it worse than this bitrate explains". A film can be clean in absolute terms and
  // still carry a positive residual, and that is not a contradiction.
  // ---- THE BUDGET BARS -------------------------------------------------------------------------
  // A table of levels against thresholds is arithmetic the reader has to do. "banding 5.507, visible
  // at 2.817" and "blur 7.004, visible at 8.026" look alike in a column and are not alike at all:
  // one is nearly DOUBLE its threshold, the other is just under. The bar does that division.
  //
  // ONE SCALE FOR ALL FOUR, and grain has to be inverted to get there. Three detectors are "more is
  // worse"; grain is "more is BETTER" (grain that survives the encode was not denoised away), so its
  // fraction is T/level rather than level/T. Without the flip the grain bar would fill up as the
  // film got cleaner, which is the same sign error the residual direction (+1,+1,+1,-1) exists for.
  //
  // 100% is the VISIBILITY threshold, not the maximum — a bar can and does go past it, so the track
  // shows 0-200% with the threshold marked, and anything beyond 200% is clipped with the real figure
  // still printed. Clipping the BAR is fine; clipping the NUMBER would be the cut-off this project
  // removes everywhere else.
  const bars = ARTIFACTS.map((a) => {
    const lv = row[`art${a.key[0].toUpperCase()}${a.key.slice(1)}`];
    const z = row[`z${a.key[0].toUpperCase()}${a.key.slice(1)}`];
    const frac = (lv == null || !(lv > 0)) ? null : (a.worseIsHigh ? lv / a.T : a.T / lv);
    return { a, lv, z, frac };
  });
  const sev = (f) => (f == null ? 'var(--dim)'
    : f >= 1 ? 'var(--bad)' : f >= 0.8 ? 'var(--warn)' : 'var(--ok)');
  const wrap = h('div', 'artbars');
  for (const b of bars) {
    const rowEl = h('div', 'artbar');
    rowEl.appendChild(h('span', 'ab-label', b.a.label));
    // RAW NUMBERS STAY ON THE ROW. The bar answers "how bad" at a glance; the measured level and its
    // threshold are the actual evidence and must not retreat into a tooltip to make room for it.
    const raw = h('span', 'ab-raw');
    raw.innerHTML = b.lv == null ? '—'
      : `${fmt.n(b.lv, 3)}<i>/${fmt.n(b.a.T, 3)}</i>`;
    rowEl.appendChild(raw);
    const track = h('span', 'ab-track');
    const fill = h('span', 'ab-fill');
    const pct = b.frac == null ? 0 : Math.min(b.frac, 2) / 2 * 100;
    fill.style.width = `${pct}%`;
    fill.style.background = sev(b.frac);
    track.appendChild(fill);
    track.appendChild(h('span', 'ab-mark'));          // the 100% line, at the halfway point
    rowEl.appendChild(track);
    rowEl.appendChild(h('span', `ab-pct${b.frac >= 1 ? ' over' : ''}`,
      b.frac == null ? '—' : `${Math.round(b.frac * 100)}%`));
    // The absolute numbers stay, in the tooltip — the bar answers "how bad", these answer "how bad
    // exactly", and the residual answers the different question of whether the bits explain it.
    rowEl.title = b.lv == null ? 'not measured'
      : `${b.a.label}: measured ${fmt.n(b.lv, 3)}, ${b.a.worseIsHigh ? 'visible at' : 'wanted above'} `
        + `${fmt.n(b.a.T, 3)}\nresidual z ${b.z == null ? '—' : fmt.n(b.z, 2)} `
        + `(${b.z > 0 ? 'more' : 'less'} than its bitrate and content predict)`;
    wrap.appendChild(rowEl);
  }
  p.body.appendChild(wrap);

  return p;
}


// BALANCE THE STAT GRID. `auto-fit` packs as many columns as fit and leaves the remainder on a
// short last row — 11 items became 8 + 3, which reads as a mistake. There is no CSS that balances
// rows, so the column count is computed: cap the row at MAX_PER_ROW, then divide the items as
// evenly as possible over the rows that implies. 11 -> 2 rows -> 6 columns -> 6 + 5.
const MAX_PER_ROW = 6;
function balanced(el, n) {
  const rows = Math.max(1, Math.ceil(n / MAX_PER_ROW));
  el.style.setProperty('--cols', String(Math.ceil(n / rows)));
  return el;
}

const pickDefault = (rows) => rows.find((r) => Array.isArray(r.sampleCx) && r.sampleCx.length) || rows[0];

// COMPACT BY DESIGN. This used to be a full panel with its own heading and caption, which spent a
// quarter of the first screen on a dropdown. It is a control, not a finding — one tight row.
// The picker lives in the FILTER BAR (main.js mounts an empty #film-pick there on this tab), so it
// costs no row of its own. Falling back to a local bar keeps the view renderable in isolation.
function chooser(host, rows, current) {
  const mounted = document.getElementById('film-pick');
  const bar = mounted ? null : h('div', 'film-pick');
  const sel = mounted || document.createElement('select');
  sel.replaceChildren();
  for (const r of [...rows].sort((a, b) => a.title.localeCompare(b.title))) {
    const o = h('option', null, `${r.title}${r.bppPlus != null ? `  —  BPP+ ${r.bppPlus}` : ''}${
      Array.isArray(r.sampleCx) ? '  \u25cf' : ''}`);
    o.value = r.key;
    o.selected = current && r.key === current.key;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    sessionStorage.setItem('bpp-lab.film', sel.value);
    host.replaceChildren();
    film(host);
  };
  sel.title = `${rows.length} in filter · ● = per-sample detail`;
  if (!bar) return null;
  bar.append(sel, h('span', 'cap', `${rows.length} in filter  \u00b7  \u25cf = per-sample detail`));
  return bar;
}

function headline(r, pool) {
  const p = panel(r.title, {
    caption: `${esc(r.source || 'unknown')} · ${esc(r.codec || '?')} · ${r.probeW || '?'}×${r.probeH || '?'} @ ${fmt.n(r.fps, 3)} fps · ${fmt.gb(r.gb)}`,
  });
  // Percentiles come from the same pool the old "Where it sits" table used, and now ride on the tile
  // they describe instead of being restated in a table below.
  const peers = (pool || []).filter((x) => x.kind === r.kind && x.cxEff > 0);
  const pctOf = (get, v) => {
    if (!Number.isFinite(v) || !peers.length) return null;
    const arr = peers.map(get).filter(Number.isFinite);
    return arr.length ? arr.filter((a) => a <= v).length / arr.length : null;
  };
  // BANDING IS NOT HERE ANY MORE. It was a tile whose one number the artifact panel now draws as a
  // bar against its threshold, three inches to the right — and the bar says strictly more.
  const tiles = [
    [fmt.int(r.bppPlus), 'BPP+', bandColor(r.bppPlus)],
    [fmt.int(r.bppPlusFlat), 'at flat 0.13'],
    [fmt.n(r.cxEff, 4), 'complexity used'],
    [fmt.n(r.R, 2), 'R'],
    [fmt.mbps(r.srcMbps), 'source'],
    [fmt.gb(r.gb), 'size'],
    [samplesLabel(r), 'samples', r.sampleState === 'detailed' ? null : 'var(--dim)'],
    [r.audioBps ? fmt.mbps(r.audioBps / 1e6) : '—', 'audio', r.audioBps ? null : 'var(--dim)'],
  ];
  const grid = balanced(stats(tiles), tiles.length);
  // DROPPED AS DERIVABLE, not unimportant. Each is one division from a tile still on screen
  // (raw measured = complexity used / pinning; CRF-20 costs = source / R) or already shown larger in
  // Control points (spread, BPP+ error). Kept on hover: the page loses density, not information.
  grid.title = `raw measured ${fmt.n(r.complexity, 4)} · CRF-20 costs ${fmt.mbps(r.probeMbps)}`
    + ` · spread ${fmt.n(r.spreadRatio, 1)}×`
    + (r.cxRSE != null ? ` · BPP+ error ${fmt.pct(r.cxRSE / 2, 1)}` : '');
  p.body.appendChild(grid);
  // CONTEXT BARS ARE FULL-WIDTH ROWS, not tile decorations. Crushed into a tile they get ~60px and
  // read as clutter beside the number; at panel width they read the way the artifact bars do, which
  // is the one bar treatment on this page that works.
  p.body.appendChild(barRows([
    ['BPP+', fmt.int(r.bppPlus), pctOf((x) => x.bppPlus, r.bppPlus), bandColor(r.bppPlus),
      { pos: pctOf((x) => x.bppPlus, 100), note: 'BPP+ 100 (transparency)' }],
    ['complexity', fmt.n(r.cxEff, 4), pctOf((x) => x.cxEff, r.cxEff)],
    ['R', fmt.n(r.R, 2), pctOf((x) => x.R, r.R), null,
      { pos: pctOf((x) => x.R, 1), note: 'R 1.0 (source = CRF-20 cost)' }],
    ['source', fmt.mbps(r.srcMbps), pctOf((x) => x.srcMbps, r.srcMbps)],
  ]));
  return p;
}

// Percentile rows in the artifact-bar shape, with the MEDIAN marked at the midpoint — the same
// position the artifact bars use for their threshold, so "the tick is the reference" reads the same
// way on both. Left of the tick is below the library median, right is above.
//
// COLOUR ONLY WHERE A VERDICT EXISTS. BPP+ has published bands (75 / 100 / 125) used on every other
// surface, so it takes bandColor. NOTHING ELSE HERE DOES: complexity, R and source have no threshold
// at which they become good or bad — a complex film is expensive, not worse — and colouring them by
// percentile would invent a verdict the model does not hold and would clash with the real bands
// beside it. They stay neutral, which is itself the honest signal not to read one in.
function barRows(items) {
  const wrap = h('div', 'artbars');
  for (const [label, val, q, band, anchor] of items) {
    if (!Number.isFinite(q) && !(q && Number.isFinite(q.div))) continue;
    const row = h('div', 'artbar');
    row.appendChild(h('span', 'ab-label', label));
    const raw = h('span', 'ab-raw'); raw.textContent = val; row.appendChild(raw);
    const track = h('span', 'ab-track');
    const fill = h('span', 'ab-fill');
    // DIVERGING: a signed delta grows from the centre, left for negative. Same track, same tick —
    // the tick just means zero here instead of the median.
    if (q && Number.isFinite(q.div)) {
      // DIRECTION IS FLIPPED SO RIGHTWARD ALWAYS MEANS WORSE, matching the artifact bars directly
      // below — those fill left-to-right as damage rises, and two bar groups an inch apart pointing
      // opposite ways is the page teaching two rules at once. So a score-REDUCING delta (negative
      // points) grows RIGHT in red, and a score-RAISING one grows LEFT. Hence the negation: the
      // number keeps its true sign, only the drawing is mirrored.
      const f = Math.max(-1, Math.min(1, -q.div / q.max));
      fill.style.left = f < 0 ? `${50 + f * 50}%` : '50%';
      fill.style.width = `${Math.abs(f) * 50}%`;
      fill.style.background = Math.abs(q.div) < (q.dead || 0) ? 'var(--dim)'
        : q.div < 0 ? 'var(--bad)' : 'var(--ok)';
      track.appendChild(fill);
      track.appendChild(h('span', 'ab-mark'));
      row.appendChild(track);
      row.appendChild(h('span', 'ab-pct', q.note || ''));
      row.title = `${q.div > 0 ? '+' : ''}${q.div} on a ±${q.max} scale`;
      wrap.appendChild(row);
      continue;
    }
    fill.style.width = `${Math.max(0, Math.min(1, q)) * 100}%`;
    if (band) {
      // BPP+ IS COLOURED BY ITS OWN BAND (75 / 100 / 125), not by its rank. Those two disagree: at
      // 89 this film is 78th percentile but squarely in the amber band, and a purple bar under an
      // amber tile is the page contradicting itself. The bar shows RANK, the colour shows VERDICT,
      // and the verdict is the same one every other surface uses.
      fill.style.background = band;
    } else {
      fill.style.background = 'var(--accent)';
      fill.style.opacity = '.5';
    }
    track.appendChild(fill);
    // THE TICK IS A REFERENCE VALUE WHERE ONE EXISTS, and the library median only where one does not.
    // BPP+ has 100 (transparency) and R has 1.0 (the source carries exactly what CRF 20 costs) —
    // both are real lines in the model, and both are far more useful than "half the library is left
    // of here". Complexity and source Mb/s have no such value: a complexity of 0.13 is a fallback
    // for UNMEASURED units, not a threshold, and no bitrate is inherently right. Those keep the
    // median, which is the honest thing to show when there is nothing better.
    const mark = h('span', 'ab-mark');
    if (anchor && Number.isFinite(anchor.pos)) mark.style.left = `${anchor.pos * 100}%`;
    track.appendChild(mark);
    row.appendChild(track);
    const pc = h('span', 'ab-pct', `${Math.round(q * 100)}th`);
    row.appendChild(pc);
    row.title = `${Math.round(q * 100)}th percentile · tick = `
      + (anchor && anchor.note ? anchor.note : 'library median');
    wrap.appendChild(row);
  }
  return wrap;
}

// THE PER-CLIP SERIES this panel can plot. Each is a distribution over the SAME film measured at
// clip level, so they belong on one axis switch rather than in four panels.
//
// They do NOT share a grid, and pretending they did would be the bug here. The probe samples N x 4s
// (N = the unit's locked sampleGrid) and pools across visits; banding samples 8 x 2s on its own
// phase; the detectors are this-visit-only. So every series carries its OWN positions, supplied by
// the server (sampleDetPos, sampleCambiPos) rather than inferred here.
const SERIES = [
  { key: 'cx', label: 'complexity', unit: 'bpp', d: 5,
    vals: (r) => r.sampleCx, pos: (r) => r.samplePos,
    ref: (r) => r.cxEff, refLabel: 'after pinning' },
  { key: 'cambi', label: 'banding (CAMBI)', unit: '', d: 3,
    vals: (r) => r.sampleCambi, pos: (r) => r.sampleCambiPos,
    ref: () => 2.817, refLabel: 'visible-banding threshold' },
  { key: 'blur', label: 'blur', unit: '', d: 3,
    vals: (r) => r.sampleBlur, pos: (r) => r.sampleDetPos,
    ref: () => 8.026, refLabel: 'threshold' },
  { key: 'block', label: 'blocking', unit: '', d: 3,
    vals: (r) => r.sampleBlock, pos: (r) => r.sampleDetPos,
    ref: () => 3.710, refLabel: 'threshold' },
];

const hhmmss = (sec) => {
  const t = Math.max(0, Math.round(sec));
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`
    + `:${String(t % 60).padStart(2, '0')}`;
};

function samplesPanel(r, foot) {
  const avail = SERIES.filter((sr) => {
    const v = sr.vals(r);
    return Array.isArray(v) && v.filter(Number.isFinite).length > 1;
  });
  const p = panel('Control points', {
    why: 'Scene complexity varies enormously <b>inside</b> a single film, which is why 8 samples is '
      + 'the floor and not a luxury. Samples pool across visits (cap 256) only while the file on '
      + 'disk is unchanged — a replaced copy starts clean, because a different encode of the same '
      + 'film is a genuinely different measurement. The shaded band is ±1 SE of the <b>mean</b>, '
      + 'which is what BPP+ divides by, not the spread of the samples themselves.<br><br>'
      + '<b>The two x axes answer different questions.</b> <i>Sorted</i> is a quantile plot — values '
      + 'ascending against cumulative proportion — the standard small-n way to show spread, skew and '
      + 'outliers without inventing an order, and preferred over a box plot below about n=30 because '
      + 'a box plot hides n behind five summary numbers. It is the right view for "how uncertain is '
      + 'this number". <i>Timestamp</i> plots each clip where it actually sits in the runtime, which '
      + 'is the only view that answers "which scene should I go and look at".<br><br>'
      + '<b>Why timestamp was not the default, historically.</b> Before per-clip positions were '
      + 'stored, an index axis drew a sawtooth — several passes over the same offsets reading as '
      + 'drift through the film. Real positions are stored now, so the axis is honest; it is still '
      + 'not the default because the model never asks which scene was expensive, only what the mean '
      + 'is.<br><br>'
      + '<b>The series do not share a grid.</b> Complexity is N×4s clips pooled across every visit; '
      + 'banding is 8×2s on its own phase; blur and blocking are the latest visit only. Each is '
      + 'plotted against its own positions, so switching the y axis changes the sample set, not just '
      + 'the numbers.',
  });

  if (!avail.length) {
    if (r.spreadRatio > 0) {
      p.body.appendChild(stats([
        ['≥8', 'samples taken', 'var(--dim)'],
        [fmt.n(r.spreadRatio, 2), 'spread (max ÷ min)'],
        [fmt.n(r.complexity, 5), 'their mean'],
      ]));
    } else {
      p.body.appendChild(h('div', 'cap', 'no per-clip readings retained for this unit'));
    }
    return p;
  }

  // Controls live in the panel HEAD so they cost no vertical space — same idiom as the other tabs.
  const ctl = h('div', 'head-ctl');
  let seriesKey = avail[0].key;
  let byTime = false;
  const draw = () => {
    body.textContent = '';
    body.appendChild(render());
  };
  ctl.appendChild(select(avail.map((sr) => [sr.key, sr.label]), seriesKey, (v) => {
    seriesKey = v; draw();
  }));
  const sortBtn = h('button', 'act', 'sorted');
  sortBtn.onclick = () => {
    byTime = !byTime;
    sortBtn.textContent = byTime ? 'timestamp' : 'sorted';
    draw();
  };
  ctl.appendChild(sortBtn);
  p.head.appendChild(ctl);

  const body = h('div');
  p.body.appendChild(body);

  function render() {
    const wrap = h('div');
    const sr = avail.find((x) => x.key === seriesKey) || avail[0];
    const raw = sr.vals(r) || [];
    const rawPos = sr.pos(r) || [];
    // Pair value with position BEFORE filtering, for the same reason sampleStats() does: filtering
    // two lists separately desynchronises them the moment one entry is unusable.
    const paired = raw.map((v, i) => [v, Number.isFinite(rawPos[i]) ? rawPos[i] : null])
      .filter(([v]) => Number.isFinite(v));
    const vals = paired.map(([v]) => v);
    const hasPos = paired.every(([, q]) => q != null) && paired.length > 0;
    const canTime = hasPos;
    sortBtn.disabled = !canTime;
    sortBtn.title = canTime ? 'switch the x axis' : 'no per-clip positions stored for this series';
    const timed = byTime && canTime;

    const m = mean(vals); const sd = stdev(vals) || 0;
    const se = sd / Math.sqrt(vals.length);
    const hi = Math.max(...vals); const lo = Math.min(...vals);
    const refV = sr.ref ? sr.ref(r) : null;
    const top = Math.max(hi, (refV != null && refV < hi * 3) ? refV : 0) * 1.15 || 1;
    const dur = r.duration > 0 ? r.duration : null;

    const pts = timed
      ? paired.map(([v, q]) => ({ v, x: q, at: dur ? hhmmss(q * dur) : `${(q * 100).toFixed(1)}%` }))
      : [...vals].sort((a, b) => a - b)
        .map((v, i, arr) => ({ v, x: (i + 0.5) / arr.length, at: `${i + 1} of ${arr.length}` }));

    const c = plot({
      width: 620, height: 280,
      x: linear(0, 1), y: linear(0, top),
      xLabel: timed
        ? (dur ? 'position in the film (0 = start, 1 = end)' : 'position in the film (fraction)')
        : 'cumulative proportion of samples (sorted)',
      yLabel: sr.unit ? `${sr.label} (${sr.unit})` : sr.label,
    });
    c.g.appendChild(el('rect', {
      class: 'ci', x: c.box.x0, y: c.y(m + se),
      width: c.box.x1 - c.box.x0, height: Math.max(1, c.y(m - se) - c.y(m + se)),
    }));
    c.g.appendChild(el('line', {
      x1: c.box.x0, x2: c.box.x1, y1: c.y(m), y2: c.y(m), stroke: 'var(--accent)', 'stroke-width': 2,
    }));
    if (refV != null && refV > 0 && refV < top && Math.abs(refV - m) > 1e-5) {
      c.g.appendChild(el('line', {
        x1: c.box.x0, x2: c.box.x1, y1: c.y(refV), y2: c.y(refV),
        stroke: 'var(--warn)', 'stroke-width': 2, 'stroke-dasharray': '5 4',
      }));
    }
    pts.forEach((pt) => {
      const dot = el('circle', { class: 'dot ctl', cx: c.x(pt.x), cy: c.y(pt.v), r: 4.5 });
      attachTip(dot, () => kv(timed ? `At ${pt.at}` : `Sample ${pt.at}`, [
        [sr.label, pt.v.toFixed(sr.d)],
        ['vs mean', `${pt.v > m ? '+' : ''}${(((pt.v / m) - 1) * 100).toFixed(0)}%`],
        ...(timed || !dur ? [] : [['position', pt.at]]),
      ]));
      c.g.appendChild(dot);
    });
    // These were one run-on sentence of numbers. They are numbers; they get tiles — ABOVE the
    // chart, because a summary row hanging off the bottom of a variable-height svg drifts away from
    // the plot it describes and pushes the panel taller than the one beside it.
    const head = stats([
      [vals.length, 'clips'],
      [m.toFixed(sr.d), 'mean'],
      [fmt.pct(se / m, 1), 'RSE', se / m > 0.12 ? 'var(--warn)' : 'var(--ok)'],
      [`${(hi / (lo || hi)).toFixed(1)}×`, 'spread'],
      ...(refV != null && refV > 0 && refV < top ? [[refV.toFixed(sr.d), sr.refLabel]] : []),
    ]);
    head.classList.add('plot-head');
    foot.replaceChildren(head, h('hr'));
    wrap.appendChild(c.svg);
    return wrap;
  }

  body.appendChild(render());
  return p;
}

// WAS "Where it sits" AND A PERCENTILE TABLE. That table restated six numbers already shown as
// tiles in the headline, purely to attach a percentile to each; the percentiles now ride on those
// tiles as hairlines and the table is gone. What is left is the one thing that was NOT a duplicate.
function contextPanel(r, rows, host, chartFoot) {
  const p = panel('Nearest by');
  // The chart's summary sits at the TOP of this panel, above its own content and separated by a
  // rule. It belongs to the plot on the left; putting it first keeps it near that plot's eye line
  // rather than stranding it under an unrelated table.
  if (chartFoot) p.body.appendChild(chartFoot);
  const pool = rows.filter((x) => x.kind === r.kind && x.cxEff > 0);
  // NEAREST BY <whatever you are asking about>. It was hardcoded to complexity, which answers only
  // "what else costs the same to encode". The useful question changes with what you are chasing:
  // nearest by P finds films with the same provenance damage, nearest by size finds what else is
  // eating the disk at this scale, nearest by year finds era-mates.
  const m = NEAR_BY[nearUi.by] || NEAR_BY.cxEff;
  const head = h('div', 'near-head');
  const sel = select(
    Object.entries(NEAR_BY).map(([k, v]) => [k, v.label]),
    nearUi.by,
    (v) => { nearUi.by = v; host.replaceChildren(); film(host); },
  );
  head.appendChild(sel);
  p.body.appendChild(head);

  const here = m.get(r);
  if (!Number.isFinite(here)) {
    p.body.appendChild(h('p', 'empty', `This film has no ${m.label} reading, so nothing can be `
      + 'ranked against it on that axis.'));
    return p;
  }
  // Films lacking the metric are DROPPED, never treated as zero — on a log axis a missing value
  // would otherwise sort to the very top as "infinitely close".
  const near = pool.filter((x) => x.key !== r.key && Number.isFinite(m.get(x)))
    .sort((a, b) => m.dist(m.get(a), here) - m.dist(m.get(b), here))
    .slice(0, 8);
  p.body.appendChild(table([
    { label: 'title', cell: (x) => esc(x.title) },
    { label: m.label, num: true, cell: (x) => fmt.n(m.get(x), m.d) },
    { label: 'BPP+', num: true, cell: (x) => `<span style="color:${bandColor(x.bppPlus)}">${fmt.int(x.bppPlus)}</span>` },
    { label: 'Mb/s', num: true, cell: (x) => fmt.n(x.srcMbps, 1) },
  ], near, {
    onRow: (x) => { sessionStorage.setItem('bpp-lab.film', x.key); host.replaceChildren(); film(host); },
  }));
  return p;
}

// Two distance kinds, and the choice is not cosmetic. RATIO distance (log) is right for anything
// spanning orders of magnitude — complexity, bitrate, size — where "twice as big" is the same step
// everywhere. ABSOLUTE distance is right for quantities already on a fixed scale: BPP+ is an index,
// P is in sd units, year is years. Using log on P would also be undefined, since P is signed.
const RATIO = (a, b) => Math.abs(Math.log(a / b));
const ABS = (a, b) => Math.abs(a - b);
const NEAR_BY = {
  cxEff: { label: 'complexity', get: (x) => x.cxEff, dist: RATIO, d: 4 },
  bppPlus: { label: 'BPP+', get: (x) => x.bppPlus, dist: ABS, d: 0 },
  R: { label: 'R', get: (x) => x.R, dist: RATIO, d: 2 },
  srcMbps: { label: 'source Mb/s', get: (x) => x.srcMbps, dist: RATIO, d: 1 },
  gb: { label: 'size GB', get: (x) => x.gb, dist: RATIO, d: 1 },
  P: { label: 'provenance P', get: (x) => x.P, dist: ABS, d: 2 },
  cambi: { label: 'banding', get: (x) => x.cambiAny, dist: RATIO, d: 2 },
  year: { label: 'year', get: (x) => x.year, dist: ABS, d: 0 },
};
const nearUi = { by: 'cxEff' };

function priorsPanel(r) {
  const p = panel('Banked upgrade pairs', {
    why: 'These are the raw material the source-pinning correction is fitted from — the ratio column '
      + 'is exactly what gets pooled into the R-bucket medians of the starved-copy cut on the '
      + 'Quality curve. A ratio above '
      + '1 means the better copy measured as <i>harder</i> content, which is the pinning effect itself.',
  });
  p.body.appendChild(table([
    { label: 'when', cell: (pr) => fmt.when(pr.ts) },
    { label: 'old cx', num: true, cell: (pr) => fmt.n(pr.complexity, 5) },
    { label: 'old R', num: true, cell: (pr) => fmt.n(pr.R, 2) },
    { label: 'now', num: true, cell: () => fmt.n(r.complexity, 5) },
    {
      label: 'ratio',
      num: true,
      cell: (pr) => {
        const ratio = pr.complexity > 0 ? r.complexity / pr.complexity : null;
        return ratio ? `<span style="color:${ratio > 1 ? 'var(--warn)' : 'var(--dim)'}">×${ratio.toFixed(2)}</span>` : '—';
      },
    },
  ], r.priors));
  return p;
}
