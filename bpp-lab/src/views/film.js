import { state, fmt, bandColor, samplesLabel } from '../data.js';
import { quantile, asc, mean, stdev } from '../stats.js';
import { el, plot, linear, attachTip, kv, esc } from '../chart.js';
import { panel, stats, table, h } from '../ui.js';

// ONE TITLE, ALL THE WAY DOWN. `sampleCx` holds the per-sample readings the denominator is the mean
// of — everything else in the model is downstream of those few numbers, so a suspicious score can be
// traced to the samples that produced it.

export default function film(host) {
  const pool = state.filtered.length ? state.filtered : state.rows;
  const pick = sessionStorage.getItem('bpp-lab.film');
  const row = pool.find((r) => r.key === pick) || pickDefault(pool);
  host.appendChild(chooser(host, pool, row));
  if (!row) return;
  host.appendChild(headline(row));
  const g = h('div', 'grid2');
  g.append(samplesPanel(row), contextPanel(row, pool));
  host.appendChild(g);
  if ((row.priors || []).length) host.appendChild(priorsPanel(row));
}

const pickDefault = (rows) => rows.find((r) => Array.isArray(r.sampleCx) && r.sampleCx.length) || rows[0];

function chooser(host, rows, current) {
  const p = panel('Title');
  const sel = document.createElement('select');
  sel.style.minWidth = '340px';
  for (const r of [...rows].sort((a, b) => a.title.localeCompare(b.title))) {
    const o = h('option', null, `${r.title}${r.bppPlus != null ? `  —  BPP+ ${r.bppPlus}` : ''}${
      Array.isArray(r.sampleCx) ? '  ●' : ''}`);
    o.value = r.key;
    o.selected = current && r.key === current.key;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    sessionStorage.setItem('bpp-lab.film', sel.value);
    host.replaceChildren();
    film(host);
  };
  const bar = h('div', 'bar-row');
  bar.append(sel, h('span', 'cap', '● = has per-sample detail'));
  p.body.appendChild(bar);
  return p;
}

function headline(r) {
  const p = panel(r.title, {
    caption: `${esc(r.source || 'unknown')} · ${esc(r.codec || '?')} · ${r.probeW || '?'}×${r.probeH || '?'} @ ${fmt.n(r.fps, 3)} fps · ${fmt.gb(r.gb)}`,
  });
  p.body.appendChild(stats([
    [fmt.int(r.bppPlus), 'BPP+ live', bandColor(r.bppPlus)],
    [fmt.int(r.bppPlusFlat), 'at flat 0.13'],
    [fmt.n(r.cxEff, 4), 'complexity used'],
    [fmt.n(r.complexity, 4), 'raw measured'],
    [`×${fmt.n(r.biasFactor, 3)}`, 'pinning'],
    // Banding sits beside BPP+, never inside it. A dash means NOT MEASURED — the banding probe is
    // still backfilling the library and "no reading" is not "no banding".
    [r.cambi == null ? '—' : fmt.n(r.cambi, 2), r.cambi == null ? 'banding (unmeasured)'
      : (r.bands ? 'banding — VISIBLE' : 'banding — clean')],
    [fmt.n(r.R, 2), 'R'],
    [fmt.mbps(r.srcMbps), 'source'],
    [fmt.mbps(r.probeMbps), 'CRF-20 costs'],
    [samplesLabel(r), 'samples', r.sampleState === 'detailed' ? null : 'var(--dim)'],
    [r.cxRSE != null ? fmt.pct(r.cxRSE / 2, 1) : 'n/k', 'BPP+ error',
      r.cxRSE != null ? null : 'var(--dim)'],
  ]));

  const notes = [];
  if (r.biasFactor > 1) {
    notes.push(`starved-copy correction −${fmt.int(r.bppPlus / r.biasOnScore - r.bppPlus)} pts`);
  }
  if (!r.audioBps) notes.push('no measured audio');
  if (notes.length) p.body.appendChild(h('div', 'cap', notes.join(' · ')));
  return p;
}

function samplesPanel(r) {
  const s = Array.isArray(r.sampleCx) ? r.sampleCx.filter(Number.isFinite) : [];
  const p = panel('Control points', {
    caption: s.length
      ? `${s.length} samples · 4s each · sorted by value`
      : `sampled ≥8× · readings not retained (pre 2026-08-14) · spread ${fmt.n(r.spreadRatio, 2)}×`,
    why: 'Scene complexity varies enormously <b>inside</b> a single film, which is why 8 samples is '
      + 'the floor and not a luxury, and why a wide spread earns 16 on the next visit rather than '
      + 'another 8 elsewhere. Samples pool across visits (cap 64) only while the file on disk is '
      + 'unchanged — a replaced copy starts clean, because a different encode of the same film is a '
      + 'genuinely different measurement. The shaded band is ±1 SE of the <b>mean</b>, which is what '
      + 'BPP+ divides by, not the spread of the samples themselves.<br><br>'
      + '<b>Why the x axis is not the sample number.</b> Pooling appends whole visits and every visit '
      + 're-measures the SAME offsets, so an index axis draws a sawtooth that reads as drift through '
      + 'the film when it is really several passes over the same few scenes. This is a <b>quantile '
      + 'plot</b> instead — values sorted ascending against cumulative proportion — the standard '
      + 'small-n way to show where a set of values lies without inventing an order, preferred over a '
      + 'box plot below about n=30 because a box plot hides n behind five summary numbers.',
  });
  if (!s.length) {
    // Say what IS known rather than leaving a blank. spreadRatio is max/min of the samples, so its
    // existence is proof they were taken — it is the one thing that survived.
    if (r.spreadRatio > 0) {
      p.body.appendChild(stats([
        ['≥8', 'samples taken', 'var(--dim)'],
        [fmt.n(r.spreadRatio, 2), 'spread (max ÷ min)'],
        [fmt.n(r.complexity, 5), 'their mean'],
      ]));
    }
    return p;
  }
  const m = mean(s); const sd = stdev(s) || 0;
  const se = sd / Math.sqrt(s.length);

  // ALWAYS A QUANTILE PLOT: values sorted ascending against cumulative proportion. The samples are
  // not a time series and any x-ordering that implies one misleads — pooling appends whole visits
  // and every visit re-measures the SAME offsets, so an index axis draws a sawtooth that reads as
  // drift through the film when it is really several passes over the same few scenes.
  //
  // Plotting against position in the runtime was considered and rejected as a DISPLAY: the model
  // never asks which scene was expensive, only what the mean is, and for a single-visit film it is
  // eight points at eight x-values showing the same spread less legibly. Positions earn their keep
  // as a STATISTIC instead — see the variance decomposition below.
  //
  // A quantile plot is the standard small-n way to show where a set of values lies: it shows spread,
  // skew and outliers without inventing an order, and below about n=30 it is preferred over a box
  // plot, which hides n behind five summary numbers.
  const pts = [...s].sort((a, b) => a - b)
    .map((v, i, arr) => ({ v, x: (i + 0.5) / arr.length, label: `${i + 1} of ${arr.length}` }));

  const c = plot({
    width: 620, height: 280,
    x: linear(0, 1), y: linear(0, Math.max(...s) * 1.15),
    xLabel: 'cumulative proportion of samples (sorted)',
    yLabel: 'complexity (bpp)',
  });
  c.g.appendChild(el('rect', {
    class: 'ci', x: c.box.x0, y: c.y(m + se),
    width: c.box.x1 - c.box.x0, height: Math.max(1, c.y(m - se) - c.y(m + se)),
  }));
  c.g.appendChild(el('line', {
    x1: c.box.x0, x2: c.box.x1, y1: c.y(m), y2: c.y(m), stroke: 'var(--accent)', 'stroke-width': 2,
  }));
  if (r.cxEff && Math.abs(r.cxEff - m) > 1e-5 && r.cxEff < Math.max(...s) * 1.15) {
    c.g.appendChild(el('line', {
      x1: c.box.x0, x2: c.box.x1, y1: c.y(r.cxEff), y2: c.y(r.cxEff),
      stroke: 'var(--warn)', 'stroke-width': 2, 'stroke-dasharray': '5 4',
    }));
  }
  pts.forEach((pt) => {
    const dot = el('circle', { class: 'dot ctl', cx: c.x(pt.x), cy: c.y(pt.v), r: 4.5 });
    attachTip(dot, () => kv(`Sample ${pt.label}`, [
      ['complexity', pt.v.toFixed(5)],
      ['vs mean', `${pt.v > m ? '+' : ''}${(((pt.v / m) - 1) * 100).toFixed(0)}%`],
    ]));
    c.g.appendChild(dot);
  });
  p.body.appendChild(c.svg);
  p.body.appendChild(h('div', 'cap', `mean ${m.toFixed(5)} · SE ${se.toFixed(5)} `
    + `(RSE ${fmt.pct(se / m, 1)}) · within-film spread ${(Math.max(...s) / Math.min(...s)).toFixed(1)}×`
    + (r.cxEff && Math.abs(r.cxEff - m) > 1e-5 ? ` · dashed = after pinning ${r.cxEff.toFixed(4)}` : '')));
  return p;
}

function contextPanel(r, rows) {
  const p = panel('Where it sits');
  const pool = rows.filter((x) => x.kind === r.kind && x.cxEff > 0);
  const pct = (arr, v) => (arr.length ? arr.filter((a) => a <= v).length / arr.length : null);
  const col = (f) => pool.map(f).filter(Number.isFinite).sort(asc);
  const data = [
    { label: 'complexity', v: r.cxEff, arr: col((x) => x.cxEff), d: 4 },
    { label: 'BPP+', v: r.bppPlus, arr: col((x) => x.bppPlus), d: 0 },
    { label: 'R', v: r.R, arr: col((x) => x.R), d: 2 },
    { label: 'source Mb/s', v: r.srcMbps, arr: col((x) => x.srcMbps), d: 1 },
    { label: 'size GB', v: r.gb, arr: col((x) => x.gb), d: 1 },
    { label: 'spread', v: r.spreadRatio, arr: col((x) => x.spreadRatio), d: 1 },
  ];
  p.body.appendChild(table([
    { label: 'measure', cell: (x) => x.label },
    { label: 'this film', num: true, cell: (x) => fmt.n(x.v, x.d) },
    { label: 'median', num: true, cell: (x) => fmt.n(quantile(x.arr, 0.5), x.d) },
    { label: 'pctile', num: true, cell: (x) => { const q = pct(x.arr, x.v); return q == null ? '—' : `${(q * 100).toFixed(0)}th`; } },
  ], data));

  p.body.appendChild(h('h3', null, 'Nearest by complexity'));
  const near = pool.filter((x) => x.key !== r.key)
    .sort((a, b) => Math.abs(Math.log(a.cxEff / r.cxEff)) - Math.abs(Math.log(b.cxEff / r.cxEff)))
    .slice(0, 8);
  p.body.appendChild(table([
    { label: 'title', cell: (x) => esc(x.title) },
    { label: 'cx', num: true, cell: (x) => fmt.n(x.cxEff, 4) },
    { label: 'BPP+', num: true, cell: (x) => `<span style="color:${bandColor(x.bppPlus)}">${fmt.int(x.bppPlus)}</span>` },
    { label: 'Mb/s', num: true, cell: (x) => fmt.n(x.srcMbps, 1) },
  ], near, {
    onRow: (x) => { sessionStorage.setItem('bpp-lab.film', x.key); location.reload(); },
  }));
  return p;
}

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
