import { state, fmt, bandColor, BANDS } from '../data.js';
import { el, plot, log, linear, path, attachTip, kv, errBar } from '../chart.js';
import { panel, field, select, legend, whyButton, h, switchToggle } from '../ui.js';

// THE LIBRARY, PLOTTED ON THE AXIS EVERYTHING ELSE IS DERIVED FROM.
//
// The Y axis is BPP+; the X axis is a choice of the three physical quantities that feed it:
//   supply   = bitrate / what the film needs   (the ratio every other number is built from)
//   bpp      = H.264-equivalent bits per pixel per frame   (the signal before normalisation)
//   complexity = what a CRF-20 encode of this film costs (the denominator)
// The default is supply, because on it BPP+ ≈ 100·√supply minus corrections — a real law. On bpp the
// same relation is a power law (BPP+ = 100·√(bpp/cxEff)); on complexity the relation is inverse-√,
// so it reads as a cloud unless bpp is also visible — it is the weakest axis, kept for completeness.
// MEASURED 2026-08-18: the bpp axis is deliberately the H.264-equivalent number, not a rawer one —
// bits-per-frame and raw(file-derived) bpp show the SAME within-bin spread (~14 pts) as bpp does,
// because on this plot the height of the cloud is complexity, not resolution/codec. Raw adds noise,
// not structure.
//
// THE OVERLAYS STACK, they do not overlap. Each subtraction from face value to the score shown owns a
// vertical slice, so turning several on gives adjacent regions rather than paint-on-paint:
//   face value  (blue dashed line)  = 100·√supply, the container bitrate believed as-is
//   audio       (green band)        = face value down to the VIDEO-only measurement
//   correction  (orange band)       = raw measurement down to the score shown  (the starved-copy cut)
// naive >= raw >= shown always, so the stack is well-ordered: blue line on top, green under it,
// orange under that. Two toggles draw the data's own summary on top, independent of the model:
//   trendline  (default on)   = local-fit line + ±2 SE band   — how well the trend is PINNED
//   spread     (default off)  = ±1 sd of the library around it — how much the dots SPREAD
// They answer different questions; the trend's band is small by design (hundreds of dots in every
// window), while the spread is huge and only opt-in because the dots already show it.

// Blue -> yellow. Monotone in lightness on a dark ground, and safe for the common colour-blindness
// types, which a red-green ramp would not be.
function ramp(t) {
  const u = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const a = [56, 96, 178]; const b = [232, 200, 90];
  return `rgb(${a.map((c, i) => Math.round(c + (b[i] - c) * u)).join(',')})`;
}
const pctScale = (rows, f) => {
  const v = rows.map(f).filter(Number.isFinite).sort((x, y) => x - y);
  return { lo: v[Math.floor(v.length * 0.05)], hi: v[Math.floor(v.length * 0.95)] };
};
// Full-range domain with a 10% pad each side, like the overview scatter: every point is inside the
// box, nothing clamps onto an edge. A percentile cut would pin the top outliers onto the right edge
// and read as a bunch (this exact bug on the bpp/complexity axes).
const fullDomain = (rows, f) => {
  const v = rows.map(f).filter((x) => Number.isFinite(x) && x > 0).sort((x, y) => x - y);
  if (!v.length) return [0.01, 1];
  return [v[0] * 0.9, v[v.length - 1] * 1.1];
};

const COLOURS = {
  band: { key: 'band', label: 'BPP+ band', of: (r) => bandColor(r.bppPlus) },
  complexity: {
    key: 'complexity', label: 'complexity',
    scale: (rows) => pctScale(rows, (r) => Math.log(r.cxEff)),
    of: (r, ex) => ramp((Math.log(r.cxEff) - ex.lo) / (ex.hi - ex.lo)),
    legend: (ex) => [`cheap · ${fmt.n(Math.exp(ex.lo), 3)}`, `expensive · ${fmt.n(Math.exp(ex.hi), 3)}`],
  },
  // BANDING as a colour: the second axis laid over the first, so a banding gradient across the
  // supply curve is visible as structure rather than having to be read off a table. UNMEASURED rows
  // are drawn grey and are NOT placed on the ramp — colouring them as "0" would paint ~90% of the
  // library as banding-free, which is the one thing this data must never imply.
  banding: {
    key: 'banding', label: 'banding',
    scale: (rows) => pctScale(rows.filter((r) => r.cambi != null), (r) => Math.log(Math.max(r.cambi, 0.01))),
    of: (r, ex) => (r.cambi == null ? '#3a4048'
      : ramp((Math.log(Math.max(r.cambi, 0.01)) - ex.lo) / (ex.hi - ex.lo))),
    legend: (ex) => [`clean · ${fmt.n(Math.exp(ex.lo), 2)}`, `bands · ${fmt.n(Math.exp(ex.hi), 2)}`,
      'grey = not measured yet'],
  },
  size: {
    key: 'size', label: 'file size',
    scale: (rows) => pctScale(rows, (r) => Math.log(Math.max(0.1, r.gb || 0.1))),
    of: (r, ex) => ramp((Math.log(Math.max(0.1, r.gb || 0.1)) - ex.lo) / (ex.hi - ex.lo)),
    legend: (ex) => [`small · ${fmt.n(Math.exp(ex.lo), 1)} GB`, `large · ${fmt.n(Math.exp(ex.hi), 1)} GB`],
  },
};

const XAXES = {
  supply: {
    label: 'supply', get: (r) => r.R,
    domain: () => [0.1, 6.5], axisLabel: 'supply — bits the file gives ÷ bits a CRF-20 encode needs (100% = transparent)',
    fmt: (v) => `${Math.round(v * 100)}%`,
  },
  bpp: {
    label: 'bpp', get: (r) => r.bpp,
    domain: (rows) => fullDomain(rows, (r) => r.bpp),
    axisLabel: 'bpp — H.264-equiv bits per pixel per frame (log)',
    fmt: (v) => fmt.n(v, 3),
  },
  complexity: {
    label: 'complexity', get: (r) => r.cxEff,
    domain: (rows) => fullDomain(rows, (r) => r.cxEff), axisLabel: 'complexity — the CRF-20 cost of this film (log)',
    fmt: (v) => fmt.n(v, 3),
  },
  // BANDING as the x axis: BPP+ against the second axis directly, which is the view that shows
  // whether the two agree. MEASURED 2026-08-21 on 85 films they largely do not — among films at
  // similar BPP+ banding still spreads 25-100x — so expect a cloud, and that cloud IS the finding.
  // Only measured rows can be placed, so the film count in the toolbar drops when this is selected.
  banding: {
    label: 'banding', get: (r) => r.cambi,
    // A row with no reading has no place on this axis. WITHOUT this, Math.max(xdom[0], null)
    // coerces null to 0 and every unmeasured film piles up on the left edge — ~90% of the library
    // rendered as "least banding of all", which is the exact false claim this data must never make.
    has: (r) => r.cambi != null && r.cambi > 0,
    domain: (rows) => fullDomain(rows.filter((r) => r.cambi != null), (r) => r.cambi),
    axisLabel: 'banding — CAMBI over 4 sampled clips (log) · higher = more visible stepping',
    fmt: (v) => fmt.n(v, 2),
  },
};

// The three overlays, in the order they stack on the chart (top to bottom).
const OVERLAYS = [
  { key: 'showFace', label: 'face value', color: 'var(--accent)' },
  { key: 'showAudio', label: 'audio', color: 'var(--ok)' },
  { key: 'showCut', label: 'correction', color: 'var(--warn)' },
];

const ui = { colour: 'band', xAxis: 'supply', showFace: true, showAudio: true, showCut: true, showTrend: true, showSpread: false };

export default function curve(host) {
  host.appendChild(chartPanel(host));
}

// FACE VALUE uses `rawR` — the supply ratio as MEASURED, with audio still counted as picture on the
// container-path rows. It has to: this chart's whole subject is what gets subtracted on the way from
// face value to the score, and audio is the first subtraction. `R` in the dataset is already
// audio-corrected as of 2026-08-20, so reading face value off it collapses the audio band to nothing
// (which is exactly what happened the day that shipped).
const naiveOf = (r) => 100 * Math.sqrt(r.rawR != null ? r.rawR : r.R);
// The same supply ratio with audio removed — the bottom of the audio band and the top of the rest.
const videoOf = (r) => 100 * Math.sqrt(r.R);
const rawOf = (r) => (r.biasOnScore ? r.bppPlus / r.biasOnScore : r.bppPlus);

function chartPanel(host) {
  const X0 = XAXES[ui.xAxis];
  const rows = state.filtered.filter((r) => r.R > 0 && r.bppPlus != null
    && (!X0.has || X0.has(r)));
  const p = panel('Your library', {});
  p.classList.add('curve-page');
  if (!rows.length) return p;
  p.body.appendChild(controls(host, rows, p));
  p.body.appendChild(scaleLegend(COLOURS[ui.colour], rows));

  const X = X0;
  const xdom = X.domain(rows);
  const maxY = Math.min(300, Math.ceil(Math.max(...rows.map(naiveOf)) / 20) * 20);
  const c = plot({
    width: 900, height: 480, pad: { t: 16, r: 18, b: 42, l: 52 },
    x: log(xdom[0], xdom[1]), y: linear(0, maxY),
    xLabel: X.axisLabel, yLabel: 'BPP+',
  });

  // BPP+ verdict thresholds as a backdrop, so a band crossing an edge is visibly a verdict change.
  for (const b of BANDS) {
    const i = BANDS.indexOf(b);
    const clamp = (v) => Math.min(c.box.y0, Math.max(c.box.y1, v));
    const yTop = clamp(c.y(i > 0 ? BANDS[i - 1].lo : maxY));
    const yBot = clamp(c.y(b.lo));
    if (yBot - yTop <= 0) continue;
    c.g.appendChild(el('rect', {
      x: c.box.x0, y: yTop, width: c.box.x1 - c.box.x0, height: yBot - yTop,
      fill: b.color, opacity: 0.05, 'pointer-events': 'none',
    }));
  }
  // 100% supply is the only reference worth drawing: it is where a file holds exactly the bits a
  // transparent encode of it would cost. It means nothing on the raw-bpp or complexity axes, so it
  // is drawn only on the supply one. (A second line marked the correction's hard cut-off at R 1.2
  // until 2026-08-18; that cut-off no longer exists, so the line went with it rather than staying
  // as an archaeological note.)
  if (ui.xAxis === 'supply') {
    c.g.appendChild(el('line', { class: 'ref', 'pointer-events': 'none', x1: c.x(1), x2: c.x(1), y1: c.box.y1, y2: c.box.y0 }));
  }

  const def = COLOURS[ui.colour];
  const ex = def.scale ? def.scale(rows) : null;
  for (const r of rows) {
    const x = c.x(Math.min(xdom[1], Math.max(xdom[0], X.get(r))));
    const y = c.y(Math.min(maxY, r.bppPlus));
    if (r.cxRSE != null) {
      c.g.appendChild(errBar(x, y, {
        dy: Math.abs(c.y(r.bppPlus * (1 - r.cxRSE / 2)) - y), cap: 2,
      }));
    }
    const dot = el('circle', { class: 'dot', cx: x, cy: y, r: 2.6, fill: def.of(r, ex), opacity: 0.55 });
    const tip = () => kv(r.title, [
      ['supply', `${Math.round(r.R * 100)}%`],
      ['face value', Math.round(naiveOf(r))],
      ['audio removed', Math.round(videoOf(r))],
      ['raw measurement', Math.round(rawOf(r))],
      ['score shown', r.bppPlus],
      ['banding', r.cambi == null ? 'not measured' : `${fmt.n(r.cambi, 2)}${r.bands ? ' — visible' : ''}`],
      ['starved-copy cut', r.biasFactor > 1 ? `+${Math.round((r.biasFactor - 1) * 100)}% harder` : 'none'],
      ['audio', r.audioShare != null ? fmt.pct(r.audioShare, 0) : '—'],
      ['complexity', fmt.n(r.cxEff, 4)],
    ]);
    const go = () => { sessionStorage.setItem('bpp-lab.film', r.key); location.hash = 'film'; };
    attachTip(dot, tip);
    dot.onclick = go;
    c.g.appendChild(dot);
    // The visible dot is a 5px target; give it a transparent 14px hit-area so hovering and clicking
    // don't demand pixel-perfect aim. It is the LAST child at this (x,y), so no overlay can sit above it.
    const hit = el('circle', { cx: x, cy: y, r: 7, fill: 'transparent', 'pointer-events': 'all' });
    hit.style.cursor = 'pointer';
    attachTip(hit, tip);
    hit.onclick = go;
    c.g.appendChild(hit);
  }

  drawOverlays(c, binned(rows, X.get, xdom), rows, X, xdom, maxY);
  c.svg.classList.add('chart');
  p.body.appendChild(c.svg);
  return p;
}

// The stacked overlays. naive >= raw >= shown always, so face/audio/correction are adjacent vertical
// slices rather than paint-on-paint — turning two on shows them side by side, not doubled up.
function drawOverlays(c, bins, rows, X, xdom, maxY) {
  if (bins.length <= 1) return;
  const pts = (f) => bins.map((m) => [c.x(m.mid), c.y(Math.min(maxY, f(m)))]);
  const face = pts((m) => m.naive);
  const raw = pts((m) => m.raw);
  const shown = pts((m) => m.shown);

  // The face-value curve: 100*sqrt(supply). A line, not a band — it is the top edge of the stack.
  if (ui.showFace) {
    c.g.appendChild(el('path', {
      d: path(face), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.2,
      'stroke-dasharray': '4 4', opacity: 0.6, 'pointer-events': 'none',
    }));
  }

  const band = (top, bot, color) => {
    c.g.appendChild(el('path', {
      d: `${path(top)}L${bot.slice().reverse().map((q) => `${q[0].toFixed(2)},${q[1].toFixed(2)}`).join('L')}Z`,
      fill: color, opacity: 0.16, stroke: 'none', 'pointer-events': 'none',
    }));
    for (const edge of [top, bot]) {
      c.g.appendChild(el('path', {
        d: path(edge), fill: 'none', stroke: color, 'stroke-width': 1.5,
        'stroke-dasharray': '5 4', opacity: 0.9, 'pointer-events': 'none',
      }));
    }
  };

  // Audio: face value (audio counted as picture) down to the same supply ratio with audio removed.
  // Since 2026-08-20 this is EXACTLY the audio and nothing else — it is 100*sqrt(rawR) down to
  // 100*sqrt(R), one subtraction on one axis. It used to be measured against the video-only SCORE,
  // which quietly folded the R-vs-bpp/target discrepancy (trap 11, a ~0.79 factor) into a band
  // labelled "audio". Only the 470 container-path units contribute; the rest have rawR == R and sit
  // flat, which is the honest picture.
  if (ui.showAudio && bins.some((m) => m.naive - m.video > 0.5)) {
    const audioBot = pts((m) => Math.min(m.naive, m.video));
    band(audioBot, face, 'var(--ok)');
  }
  // Correction: raw measurement down to the score shown.
  if (ui.showCut) {
    band(shown, raw, 'var(--warn)');
    for (const m of bins) {
      const hit = el('circle', {
        class: 'dot', cx: c.x(m.mid), cy: c.y(Math.min(maxY, m.shown)), r: 3.5,
        fill: 'var(--warn)', opacity: 0.85,
      });
      attachTip(hit, () => kv(`${X.fmt(m.mid)}`, [
        ['films', m.n],
        ['raw measurement', Math.round(m.raw)],
        ['score shown', Math.round(m.shown)],
        ['cut', `${Math.round(m.raw - m.shown)} pts`],
      ]));
      c.g.appendChild(hit);
    }
  }

  // Trendline + spread: the DATA's own summary, independent of the model overlays above. A
  // tricube-weighted local-linear fit of BPP+ against log(x). The trendline's shading is ±2 SE of
  // the fit (how well the line is pinned — small, by design); the spread overlay is ±1 sd of the
  // dots around it (how much the library spreads — what the old huge grey band actually was).
  // Precision-weighting means a film with a wide cxRSE error bar counts less than a pinned one.
  if (ui.showTrend) drawTrend(c, rows, X, xdom, maxY);
  if (ui.showSpread) drawSpread(c, rows, X, xdom, maxY);
}

// Tricube-weighted local-linear fit of BPP+ on log(x), evaluated at `n` evenly-spaced log-x points.
//
// TWO WIDTHS COME BACK, because they answer different questions and conflating them is exactly the
// "why is the grey band huge" confusion:
//   sd  — the weighted residual s.d. of the dots around the fit: how much the LIBRARY spreads at
//         that x. Large by construction (complexity genuinely varies the score ±50-100), and it is
//         what the dots themselves already show, so it is opt-in, not the trend's error.
//   se  — the standard error of the fitted line: how WELL PINNED the trend is. Shrinks with n, so
//         it is tiny. THIS is the band a "trendline with error shading" should draw.
//
// Each dot is weighted by tricube distance AND by its own measurement precision: a point's y
// uncertainty is cxRSE/2 (BPP+ ∝ cxEff^-1/2), so a film with a wide error bar counts less than a
// pinned one. Today ~11 films have a cxRSE, so precision-weighting is near-inert; when every film
// gains an error bar in the next backfill it becomes the whole point.
function localFit(rows, get, xdom, bw = 0.8, n = 48) {
  const pts = rows
    .map((r) => [Math.log(get(r)), r.bppPlus, r.cxRSE != null ? (r.bppPlus * r.cxRSE / 2) ** 2 : 0])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const lo = Math.log(xdom[0]); const hi = Math.log(xdom[1]);
  const span = hi - lo;
  const out = [];
  for (let i = 0; i <= n; i += 1) {
    const x = lo + (span * i) / n;
    let wsum = 0; let wx = 0; let wy = 0; let wxx = 0; let wxy = 0;
    for (const [px, py, v] of pts) {
      const u = Math.abs(px - x) / (bw * span);
      if (u >= 1) continue;
      // Distance weight times inverse-variance: a fuzzier measurement is a less reliable vote.
      const w = Math.pow(1 - u * u * u, 3) / Math.max(v, 1e-9);
      wsum += w; wx += w * px; wy += w * py; wxx += w * px * px; wxy += w * px * py;
    }
    if (wsum < 5) continue;
    // local-linear slope/intercept from the weighted moments.
    const den = wsum * wxx - wx * wx;
    const b = den ? (wsum * wxy - wx * wy) / den : 0;
    const a = (wy - b * wx) / wsum;
    const fit = a + b * x;
    // Residual variance: population spread plus each point's own measurement noise.
    let s2 = 0; let nEff = 0;
    for (const [px, py, v] of pts) {
      const u = Math.abs(px - x) / (bw * span);
      if (u >= 1) continue;
      const w = Math.pow(1 - u * u * u, 3);
      s2 += w * ((py - fit) ** 2 + v);
      nEff += w;
    }
    // Effective sample size for a weighted mean: (Σw)²/Σw².
    let w2 = 0;
    for (const [px] of pts) {
      const u = Math.abs(px - x) / (bw * span);
      if (u >= 1) continue;
      const w = Math.pow(1 - u * u * u, 3);
      w2 += w * w;
    }
    out.push({
      x, y: fit,
      sd: Math.sqrt(s2 / nEff),                     // library spread (the dots' own width)
      se: Math.sqrt(s2 / (nEff * (nEff * nEff / w2))),  // SE of the fitted line: sd/sqrt(nEff)
    });
  }
  return out;
}

function drawTrend(c, rows, X, xdom, maxY) {
  const fit = localFit(rows, X.get, xdom);
  if (fit.length < 3) return;
  const line = fit.map((p) => [c.x(Math.exp(p.x)), c.y(Math.min(maxY, p.y))]);
  // ±2 SE ≈ the fit's ~95% confidence band — small, because the trend with hundreds of dots in every
  // window is very well pinned. This is the trend's OWN uncertainty, the honest thing to shade.
  const seTop = fit.map((p) => [c.x(Math.exp(p.x)), c.y(Math.min(maxY, p.y + 2 * p.se))]);
  const seBot = fit.map((p) => [c.x(Math.exp(p.x)), c.y(Math.min(maxY, Math.max(0, p.y - 2 * p.se)))]);
  c.g.appendChild(el('path', {
    d: `${path(seTop)}L${seBot.slice().reverse().map((q) => `${q[0].toFixed(2)},${q[1].toFixed(2)}`).join('L')}Z`,
    fill: 'var(--dim)', opacity: 0.10, stroke: 'none', 'pointer-events': 'none',
  }));
  c.g.appendChild(el('path', {
    d: path(line), fill: 'none', stroke: 'var(--fg)', 'stroke-width': 1.6, opacity: 0.85, 'pointer-events': 'none',
  }));
}

// The population spread as its own opt-in overlay: ±1 sd of the dots around the trend at each x.
// Deliberately separate from the trendline's own SE band — huge by construction and redundant with
// the dots, so it defaults OFF and is labelled as spread, not uncertainty.
function drawSpread(c, rows, X, xdom, maxY) {
  const fit = localFit(rows, X.get, xdom);
  if (fit.length < 3) return;
  const top = fit.map((p) => [c.x(Math.exp(p.x)), c.y(Math.min(maxY, p.y + p.sd))]);
  const bot = fit.map((p) => [c.x(Math.exp(p.x)), c.y(Math.min(maxY, Math.max(0, p.y - p.sd)))]);
  c.g.appendChild(el('path', {
    d: `${path(top)}L${bot.slice().reverse().map((q) => `${q[0].toFixed(2)},${q[1].toFixed(2)}`).join('L')}Z`,
    fill: 'var(--dim)', opacity: 0.13, stroke: 'none', 'pointer-events': 'none',
  }));
}

// The refined input row: colour mode, x-axis, the three stacked overlays + trendline, the count, and the legend.
function controls(host, rows, p) {
  const bar = h('div', 'toolbar');
  bar.appendChild(field('colour by', select(
    Object.entries(COLOURS).map(([k, v]) => [k, v.label]),
    ui.colour,
    (v) => { ui.colour = v; host.replaceChildren(); curve(host); },
  )));
  bar.appendChild(field('x axis', select(
    Object.entries(XAXES).map(([k, v]) => [k, v.label]),
    ui.xAxis,
    (v) => { ui.xAxis = v; host.replaceChildren(); curve(host); },
  )));
  for (const o of OVERLAYS) {
    bar.appendChild(switchToggle(o.label, ui[o.key], { color: o.color, onChange: (on) => { ui[o.key] = on; host.replaceChildren(); curve(host); } }));
  }
  bar.appendChild(switchToggle('trendline', ui.showTrend, { color: 'var(--fg)', onChange: (on) => { ui.showTrend = on; host.replaceChildren(); curve(host); } }));
  bar.appendChild(switchToggle('spread', ui.showSpread, { color: 'var(--dim)', onChange: (on) => { ui.showSpread = on; host.replaceChildren(); curve(host); } }));
  const sp = h('div', 'spacer');
  bar.appendChild(sp);
  bar.appendChild(h('span', 'meta', XAXES[ui.xAxis].has
    ? `${rows.length} films with a reading on this axis`
    : `${rows.length} films`));
  bar.appendChild(whyButton('Your library', WHY));
  return bar;
}

const WHY = '<b>The overlays are the path from a file\'s bitrate to its score, and they stack.</b> '
  + 'Everything a dot could be is measured three times, each one after a subtraction:<br><br>'
  + '<b>face value</b> (blue dashed line) — the container bitrate believed as-is, with audio counted '
  + 'as if it were video. This is the reference: every real dot sits at or below it.<br><br>'
  + '<b>audio</b> (green band) — face value down to the same supply ratio with audio taken out. bpp is '
  + 'bits per pixel of <i>video</i>, so audio cannot be counted as picture. Only some files need it: '
  + 'ffprobe reports a per-stream video rate for 574 of 1044 units and those were always clean, while '
  + 'the other 470 fall back to the container total with every audio track inside it. So the band is '
  + 'flat wherever a bin is mostly clean files — that is the honest picture, not a gap. Median '
  + 'container audio share 9.8%, up to ~47% on a lossless multi-track release.<br><br>'
  + '<b>correction</b> (orange band) — raw measurement down to the score shown. This is the '
  + 'starved-copy cut, the same correction the old "Pinning bias" tab drew. We measure how hard a '
  + 'film is to encode by re-encoding <i>the copy we already own</i> — a starved file has thrown '
  + 'detail away, so its film measures easier than it is and then scores well against an easy bar. '
  + 'Proved on Paris, Texas: 6× the bitrate, and the same film measured 2.33× harder. There is no '
  + 'cut-off any more — the correction decays to nothing on its own, reaching zero by 132% supply. It '
  + 'is held flat below 42% supply, because the experiment never measured down there.<br><br>'
  + 'The three form one well-ordered stack (face value ≥ video-only ≥ shown), so turning several on '
  + 'shows adjacent slices instead of overlapping paint. The coloured backdrop is the BPP+ verdict '
  + 'thresholds, so a dot crossing an edge is visibly a change of verdict.<br><br>'
  + '<b>The x axis is a choice of the physical quantities feeding the score.</b> <b>supply</b> is the '
  + 'ratio every other number derives from, and on it the face-value curve is a real law. '
  + '<b>bpp</b> is the signal before normalisation (already H.264-equivalent, so HEVC files are '
  + 'comparable); the vertical spread at any bpp is exactly content difficulty. <b>complexity</b> is '
  + 'the denominator itself — the weakest axis, kept because it is cheap.<br><br>'
  + '<b>The trendline is the data\'s own summary.</b> A locally-weighted fit through the dots, '
  + 'precision-weighted so a film with a wide error bar counts less. Its shading is ±2 SE — how well '
  + 'the line is <i>pinned</i> — which is small by design, because hundreds of dots sit in every '
  + 'window. Where it runs below the face curve is the model, made visible rather than asserted. '
  + 'The separate <b>spread</b> toggle draws ±1 sd of the library around the trend: how much the dots '
  + 'actually spread at each x. It defaults off because it is redundant with the dots themselves, and '
  + 'labelled "spread", not "error" — the two are not the same thing.<br><br>'
  + 'Error bars are the measured uncertainty on complexity. Most films have none yet; that absence is '
  + 'honest rather than an omission.';

// The colour legend updates with the select: discrete BPP+ swatches, or a ramp with its real ends.
function scaleLegend(def, rows) {
  if (def.key === 'band') {
    return legend(BANDS.map((b) => [b.color, b.label]));
  }
  const ex = def.scale(rows);
  return cbar(`linear-gradient(to right, ${ramp(0)}, ${ramp(1)})`, ...def.legend(ex));
}

function cbar(bg, lo, hi) {
  const wrap = h('div', 'cwrap');
  const bar = h('div', 'cbar');
  bar.style.background = bg;
  const lab = h('div', 'clab');
  lab.append(h('span', null, lo), h('span', null, hi));
  wrap.append(bar, lab);
  return wrap;
}

// Binned medians along the log x axis. Bins under 4 films are dropped — a median of two is not a
// summary, and a jagged edge reads as structure that is not there.
function binned(rows, get, xdom) {
  const BINS = 16;
  const lo = Math.log(xdom[0]); const hi = Math.log(xdom[1]);
  const med = (a) => { const v = [...a].sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
  const out = [];
  for (let i = 0; i < BINS; i += 1) {
    const a = Math.exp(lo + ((hi - lo) * i) / BINS);
    const b = Math.exp(lo + ((hi - lo) * (i + 1)) / BINS);
    const inBin = rows.filter((r) => { const x = get(r); return x >= a && x < b; });
    if (inBin.length < 4) continue;
    out.push({
      mid: Math.exp((Math.log(a) + Math.log(b)) / 2),
      naive: med(inBin.map(naiveOf)),
      video: med(inBin.map(videoOf)),
      raw: med(inBin.map(rawOf)),
      shown: med(inBin.map((r) => r.bppPlus)),
      n: inBin.length,
    });
  }
  return out;
}
