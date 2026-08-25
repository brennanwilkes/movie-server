import { state, fmt, BANDS, bandColor } from '../data.js';
import { summary, quantile, asc } from '../stats.js';
import { el, plot, linear, log, attachTip, kv, path, errBar } from '../chart.js';
import { panel, stats, legend, h } from '../ui.js';

// Orientation: what the library looks like today, as four one-quarter squares. Descriptive only —
// no fitting, no clustering. Layout is the 2026-08-18 redesign: (1) where the library sits + the
// precision of those numbers, (2) BPP+ distribution, (3) complexity vs bitrate, (4) source tier.

export default function overview(host) {
  const rows = state.filtered;
  const plus = rows.map((r) => r.bppPlus).filter(Number.isFinite);

  const g = h('div', 'grid2 overview');
  g.append(wherePanel(rows, plus), histPanel(plus));
  g.append(scatterPanel(rows), sourcePanel(rows));
  host.appendChild(g);
}

const bandCounts = (vals) => BANDS.map((b, i) => {
  const hi = i > 0 ? BANDS[i - 1].lo : Infinity;
  return vals.filter((v) => v >= b.lo && v < hi).length;
});

function bandBar(counts) {
  const bar = h('div', 'bandbar');
  BANDS.forEach((b, i) => {
    if (!counts[i]) return;
    const seg = h('div');
    seg.style.cssText = `flex:${counts[i]};background:${b.color}`;
    seg.title = `${b.label}: ${counts[i]}`;
    bar.appendChild(seg);
  });
  return bar;
}

// HOW MUCH OF THE LIBRARY IS ACTUALLY MEASURED FOR PRECISION. Separate from "is it measured at all",
// which is ~100%. This is the gap that matters for trusting any error bar.
const SPREAD_WIDE = 6;                            // mirrors probe.js
const RSE_GOOD = 0.12;
const POOL_MAX = 64;
const inRefineQueue = (r) => {
  if ((r.sampleN || 0) >= POOL_MAX) return false;
  if (r.cxRSE != null) return r.cxRSE > RSE_GOOD;
  return (r.spreadRatio || 0) > SPREAD_WIDE;
};

function wherePanel(rows, plus) {
  const s = summary(plus) || {};
  const cx = summary(rows.map((r) => r.cxEff).filter(Number.isFinite)) || {};
  const R = summary(rows.map((r) => r.R).filter(Number.isFinite)) || {};
  const bytes = rows.reduce((a, r) => a + (r.bytes || 0), 0);
  const counts = bandCounts(plus);

  const all = state.rows;
  const withSamples = all.filter((r) => r.sampleN != null);
  const queued = all.filter((r) => r.sampleN == null && inRefineQueue(r));
  const stranded = all.filter((r) => r.sampleN == null && !inRefineQueue(r));

  const p = panel('Where the library sits', {
    caption: `${rows.length} units · ${(bytes / 1e12).toFixed(2)} TB`,
    why: `The median is <b>${fmt.int(s.median)}</b>, not 100. Either the library really is mostly `
      + 'below CRF-20-transparent, or headroom 1.0 sets the bar above the real knee. Read the '
      + 'ranking, not the absolute number, until watched-film verdicts settle it.<br><br>'
      + `<b>How much of that median is actually measured.</b> ${withSamples.length} of ${all.length} `
      + 'units retain per-sample readings; the rest kept only their mean (measured before '
      + `2026-08-14). The refine queue should convert ${queued.length} of them; ${stranded.length} are `
      + 'never scheduled and will never earn a real error bar.',
  });

  const hero = h('div', 'hero');
  const num = h('b', null, fmt.int(s.median));
  num.style.color = bandColor(s.median);
  hero.append(num, h('span', null, 'median BPP+'));
  p.body.appendChild(hero);

  const sub = h('div', 'subline');
  sub.textContent = `IQR ${fmt.int(s.p25)}–${fmt.int(s.p75)} · complexity ${fmt.n(cx.median, 4)} `
    + `(spread ${fmt.n((cx.max || 0) / (cx.min || 1), 0)}×) · R ${fmt.n(R.median, 2)}`;
  p.body.appendChild(sub);

  p.body.appendChild(bandBar(counts));
  p.body.appendChild(legend(BANDS.map((b, i) => [b.color,
    `${b.label} — ${counts[i]} (${((100 * counts[i]) / (plus.length || 1)).toFixed(0)}%)`])));

  const prec = stats([
    [String(all.length), 'units measured'],
    [String(withSamples.length), 'per-sample', 'var(--ok)'],
    [String(queued.length), 'queued to gain it', 'var(--accent)'],
    [String(stranded.length), 'never scheduled', 'var(--warn)'],
  ]);
  prec.classList.add('prec');
  p.body.appendChild(prec);
  return p;
}

function histPanel(plus) {
  const p = panel('BPP+ distribution');
  if (!plus.length) return p;
  const hi = Math.max(220, Math.ceil(Math.max(...plus) / 10) * 10);
  const step = 5;
  const bins = new Map();
  for (const v of plus) bins.set(Math.floor(v / step) * step, (bins.get(Math.floor(v / step) * step) || 0) + 1);
  const maxN = Math.max(...bins.values());

  const c = plot({
    width: 620, height: 280,
    x: linear(0, hi), y: linear(0, maxN * 1.08),
    xLabel: 'BPP+', yLabel: 'films',
  });
  for (const [b, n] of [...bins].sort((a, z) => a[0] - z[0])) {
    const x0 = c.x(b); const x1 = c.x(b + step);
    c.g.appendChild(el('rect', {
      x: x0, y: c.y(n), width: Math.max(1, x1 - x0 - 1),
      height: Math.max(0, c.y(0) - c.y(n)), fill: bandColor(b), opacity: 0.85,
    }));
  }
  for (const b of BANDS) {
    if (!b.lo) continue;
    c.g.appendChild(el('line', { class: 'ref', x1: c.x(b.lo), x2: c.x(b.lo), y1: c.box.y1, y2: c.box.y0 }));
  }
  p.body.appendChild(c.svg);
  return p;
}

function scatterPanel(rows) {
  const p = panel('Complexity vs bitrate', {
    why: 'Both axes are log — complexity spans ~30× and collapses on a linear axis. The dashed line '
      + 'is where a file\'s bitrate exactly equals what CRF 20 costs for its content: BPP+ 100 drawn '
      + 'in the space the measurement lives in. It uses the <b>median</b> pixel rate, so individual '
      + 'films sit slightly off it — it orients, it does not adjudicate.',
  });
  const pts = rows.filter((r) => r.cxEff > 0 && r.srcMbps > 0);
  if (!pts.length) return p;
  const c = plot({
    width: 620, height: 280,
    x: log(Math.min(...pts.map((r) => r.cxEff)) * 0.9, Math.max(...pts.map((r) => r.cxEff)) * 1.1),
    y: log(Math.max(0.3, Math.min(...pts.map((r) => r.srcMbps))) * 0.9, Math.max(...pts.map((r) => r.srcMbps)) * 1.1),
    xLabel: 'complexity (bpp, log)', yLabel: 'source Mb/s (log)',
  });
  const px = (r) => (r.probeW || 1920) * (r.probeH || 1080) * (r.fps || 24);
  const medPx = quantile(pts.map(px).sort(asc), 0.5);
  const line = [];
  for (let i = 0; i <= 40; i += 1) {
    const v = c.x.domain[0] * ((c.x.domain[1] / c.x.domain[0]) ** (i / 40));
    line.push([c.x(v), c.y((v * medPx) / 1e6)]);
  }
  c.g.appendChild(el('path', { class: 'ref', d: path(line), fill: 'none' }));
  for (const r of pts) {
    // The error lives on the X axis here: complexity is the measured quantity, source bitrate is
    // read off the file and is exact.
    if (r.cxRSE != null) {
      const lo = c.x(r.cxEff * (1 - r.cxRSE)); const hi = c.x(r.cxEff * (1 + r.cxRSE));
      c.g.appendChild(errBar(c.x(r.cxEff), c.y(r.srcMbps), { dx: (hi - lo) / 2, cap: 2.5 }));
    }
    const dot = el('circle', {
      class: 'dot', cx: c.x(r.cxEff), cy: c.y(r.srcMbps), r: 3,
      fill: bandColor(r.bppPlus), opacity: 0.72,
    });
    attachTip(dot, () => kv(r.title, [
      ['BPP+', r.bppPlus], ['complexity', fmt.n(r.cxEff, 4)], ['R', fmt.n(r.R, 2)],
      ['source', `${r.srcMbps.toFixed(1)} Mb/s`], ['tier', r.source], ['size', fmt.gb(r.gb)],
    ]));
    dot.style.cursor = 'pointer';
    dot.onclick = () => { sessionStorage.setItem('bpp-lab.film', r.key); location.hash = 'film'; };
    c.g.appendChild(dot);
  }
  p.body.appendChild(c.svg);
  return p;
}

const PIE_COLORS = ['#6ea8fe', '#4ec98a', '#e8a33d', '#e0575b', '#b18cf0', '#57c7d6',
  '#d49a3d', '#dd6b7f', '#7aa75f', '#9a8cf0'];

function sourcePanel(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = r.source || 'unknown';
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const data = [...by].sort((a, b) => b[1].length - a[1].length);
  const total = rows.length;

  const p = panel('By source tier', {
    caption: 'the only class shipped adequately supplied is web-DL — the lone median R ≥ 1; '
      + 'Bluray-1080p, most of the library, sits starved; Remux still doesn\'t sort on top',
    why: 'A perfectly-encoded HDTV capture can score BPP+ 120 and still be a worse master than a '
      + 'starved Bluray, so tier is a <b>ceiling bits cannot raise</b> and is kept as a separate gate, '
      + 'never folded into the score. That Remux does not sort to the top of this chart is the whole '
      + 'argument for keeping them apart.',
  });
  const box = h('div', 'pie');
  box.appendChild(donut(data, total));
  box.appendChild(legend(data.map(([k, v], i) => [
    PIE_COLORS[i % PIE_COLORS.length],
    `${k} ${v.length} (${((100 * v.length) / total).toFixed(0)}%)`,
  ])));
  p.body.appendChild(box);
  return p;
}

function donut(data, total) {
  const R = 92; const r = 58; const cx = 120; const cy = 120;
  const svg = el('svg', { viewBox: '0 0 240 240', width: 240, height: 240 });
  let a0 = -Math.PI / 2;
  data.forEach(([k, v], i) => {
    const frac = v.length / total;
    const a1 = a0 + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x0 = cx + R * Math.cos(a0); const y0 = cy + R * Math.sin(a0);
    const x1 = cx + R * Math.cos(a1); const y1 = cy + R * Math.sin(a1);
    const xi0 = cx + r * Math.cos(a1); const yi0 = cy + r * Math.sin(a1);
    const xi1 = cx + r * Math.cos(a0); const yi1 = cy + r * Math.sin(a0);
    const seg = el('path', {
      d: `M${x0.toFixed(2)},${y0.toFixed(2)} A${R},${R} 0 ${large},1 ${x1.toFixed(2)},${y1.toFixed(2)} `
        + `L${xi0.toFixed(2)},${yi0.toFixed(2)} A${r},${r} 0 ${large},0 ${xi1.toFixed(2)},${yi1.toFixed(2)} Z`,
      fill: PIE_COLORS[i % PIE_COLORS.length],
    });
    attachTip(seg, () => kv(k, [
      ['units', v.length],
      ['share', fmt.pct(v.length / total, 1)],
      ['median BPP+', fmt.int(quantile(v.map((x) => x.bppPlus).filter(Number.isFinite).sort(asc), 0.5))],
    ]));
    svg.appendChild(seg);
    a0 = a1;
  });
  svg.appendChild(el('text', {
    x: cx, y: cy + 6, 'text-anchor': 'middle', fill: 'var(--fg)',
    'font-size': 22, 'font-weight': 600,
  }, String(total)));
  svg.appendChild(el('text', {
    x: cx, y: cy + 22, 'text-anchor': 'middle', fill: 'var(--dim)', 'font-size': 10,
  }, 'units'));
  return svg;
}