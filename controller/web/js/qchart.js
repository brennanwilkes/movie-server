'use strict';
// Part 7d/11 — the control-points chart. Responsive by MEASUREMENT, not by scaling: the lab's
// fixed 620x280 viewBox scaled to a 390px screen renders its 10px labels at ~6px.

// Coverage decides the default, not preference: sampleCambi covers ~100% of units and sampleCx
// only 40%, so the lab's complexity default is empty for most films.
const QC_SERIES = [
  { id: 'cambi', label: 'banding', pos: 'sampleCambiPos', arr: 'sampleCambi', T: 2.817, sqrt: true },
  { id: 'cx', label: 'complexity', pos: 'samplePos', arr: 'sampleCx', ref: 'cxEff', sqrt: false },
  { id: 'blur', label: 'blur', pos: 'sampleDetPos', arr: 'sampleBlur', T: 8.026, sqrt: true },
  { id: 'block', label: 'blocking', pos: 'sampleDetPos', arr: 'sampleBlock', T: 3.710, sqrt: true },
];
const qcUi = { series: null, sorted: true, sel: -1 };

const qcHas = (deep, s) => Array.isArray(deep[s.arr]) && deep[s.arr].length > 0;
const qcPick = (deep) => QC_SERIES.find((s) => s.id === qcUi.series && qcHas(deep, s))
  || QC_SERIES.find((s) => qcHas(deep, s)) || null;

function qfChart(r, deep) {
  if (!deep) return '';
  const s = qcPick(deep);
  if (!s) {
    return '<div class="card"><div class="panel-head"><h3>Control points</h3></div>'
      + '<p class="empty">The individual clip readings were not retained for this unit — only the '
      + 'mean and the spread. Every unit was sampled at least 8 times.</p></div>';
  }
  const avail = QC_SERIES.filter((x) => qcHas(deep, x));
  return '<div class="card qc-card">'
    + '<div class="panel-head"><h3>Control points</h3>'
      + '<div class="head-ctl">'
        + `<select class="qsel" id="qc-series">${avail.map((x) => `<option value="${x.id}"${x.id === s.id ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</select>`
        + `<button class="tog" id="qc-sort">${qcUi.sorted ? 'sorted' : 'by time'}</button>`
      + '</div>'
      + qfHelp('Every clip the probe measured, so you can see whether a reading is the whole film '
        + 'or one bad scene. The solid line is the mean and the band around it is its standard '
        + 'error; the dashed line is the level at which this artifact becomes visible. Tap or '
        + 'arrow-key to read a clip.') + '</div>'
    + `<div class="qc" id="qc-host" data-series="${s.id}"></div>`
    + '<div class="cp-read" id="qc-read"></div>'
    + '<details class="qc-vals"><summary>Values</summary><div id="qc-table"></div></details>'
    + '</div>';
}

// Draw at the container's real width; height includes the x-axis band so the labels are never
// clipped by a fixed box.
function qcDraw(r, deep) {
  const host = $('#qc-host');
  if (!host) return;
  const s = qcPick(deep);
  if (!s) return;
  const vals = deep[s.arr].slice();
  const pos = Array.isArray(deep[s.pos]) && deep[s.pos].length === vals.length ? deep[s.pos].slice() : null;
  const pts = vals.map((v, i) => ({ v, p: pos ? pos[i] : (i + 0.5) / vals.length, i }));
  if (qcUi.sorted) pts.sort((a, b) => a.v - b.v).forEach((pt, i) => { pt.x = (i + 0.5) / pts.length; });
  else pts.forEach((pt) => { pt.x = pt.p; });

  const W = Math.max(280, host.clientWidth || 320);
  // Taller once there is room: at 868px the old 0.55 ratio hit the 300px cap and the plot read as
  // a squashed strip. Desktop gets a shallower ratio and a higher ceiling.
  const H = W >= 700
    ? Math.round(Math.min(400, Math.max(280, W * 0.42)))
    : Math.round(Math.min(300, Math.max(200, W * 0.55)));
  const PL = 40; const PR = 12; const PT = 14; const PB = 30;
  const ref = s.T != null ? s.T : (s.ref ? r[s.ref] : null);
  const mean = pts.reduce((a, b) => a + b.v, 0) / pts.length;
  const sd = pts.length > 1
    ? Math.sqrt(pts.reduce((a, b) => a + (b.v - mean) ** 2, 0) / (pts.length - 1)) : 0;
  const se = sd / Math.sqrt(pts.length);
  const top = Math.max(ref != null ? ref * 1.25 : 0, ...vals) * 1.06 || 1;

  // sqrt for the artifact series: CAMBI spans 0-11.7 library-wide against a 2.817 threshold with a
  // ~1.08 median, so a linear axis anchored to the threshold plots every clean film flat on the
  // floor. sqrt handles an exact zero, which log does not.
  const f = s.sqrt ? Math.sqrt : (v) => v;
  const yv = (v) => PT + (1 - f(Math.max(0, v)) / f(top)) * (H - PT - PB);
  const xv = (x) => PL + x * (W - PL - PR);
  // The threshold line labels itself, so a y-tick at the same value is the same number twice.
  const want = ref != null ? [0, ref / 2] : [0, top / 2, top];
  const ticks = want.filter((v, i) => v <= top
    && (i === 0 || Math.abs(yv(v) - yv(want[i - 1])) > 14));
  const tfmt = (v) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2));
  const hhmmss = (fr) => {
    if (!r.duration) return `${Math.round(fr * 100)}%`;
    const t = Math.round(fr * r.duration);
    return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };

  const g = [];
  for (const v of ticks) {
    g.push(`<line class="cp-g" x1="${PL}" x2="${W - PR}" y1="${yv(v).toFixed(1)}" y2="${yv(v).toFixed(1)}"/>`);
    g.push(`<text class="cp-ax" x="${PL - 6}" y="${(yv(v) + 3.5).toFixed(1)}" text-anchor="end">${tfmt(v)}</text>`);
  }
  const seBand = '';
  const refLine = ref != null && ref <= top
    ? `<line class="cp-thr" x1="${PL}" x2="${W - PR}" y1="${yv(ref).toFixed(1)}" y2="${yv(ref).toFixed(1)}"/>`
      + `<text class="cp-thr-t" x="${W - PR}" y="${(yv(ref) - 5).toFixed(1)}" text-anchor="end">${s.T != null ? 'visible' : 'used'} ${tfmt(ref)}</text>` : '';
  // Invisible r=14 hit circles: 28px, over the 24px floor. The pointer only has to be CLOSEST.
  const dots = pts.map((pt, n) => `<circle class="cp-dot${n === qcUi.sel ? ' sel' : ''}" cx="${xv(pt.x).toFixed(1)}" cy="${yv(pt.v).toFixed(1)}" r="${n === qcUi.sel ? 7 : 4.5}"/>`).join('');
  const hits = pts.map((pt, n) => `<circle class="cp-hit" data-n="${n}" cx="${xv(pt.x).toFixed(1)}" cy="${yv(pt.v).toFixed(1)}" r="14"/>`).join('');
  const xt = [0, 0.25, 0.5, 0.75, 1].map((x, i) => `<text class="cp-ax" x="${xv(x).toFixed(1)}" y="${H - PB + 16}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}">${qcUi.sorted ? `${Math.round(x * 100)}%` : hhmmss(x)}</text>`).join('');

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" tabindex="0"
      aria-label="${esc(`${pts.length} clip readings for ${s.label}, mean ${tfmt(mean)}`)}">
    ${g.join('')}
    <line class="cp-mean" x1="${PL}" x2="${W - PR}" y1="${yv(mean).toFixed(1)}" y2="${yv(mean).toFixed(1)}"/>
    ${refLine}${dots}${hits}${xt}
  </svg>`;
  host._pts = pts; host._s = s; host._fmt = { tfmt, hhmmss, mean, se, ref, n: pts.length };
  qcRead();
  // The table-view twin: no value is reachable only by pointing at it.
  const tb = $('#qc-table');
  if (tb) {
    tb.innerHTML = `<ol class="qc-list">${pts.slice().sort((a, b) => a.p - b.p).map((pt) => `<li><span>${esc(hhmmss(pt.p))}</span><b>${pt.v.toFixed(3)}</b></li>`).join('')}</ol>`;
  }
}

function qcRead() {
  const host = $('#qc-host'); const out = $('#qc-read');
  if (!host || !out || !host._pts) return;
  const { tfmt, hhmmss, mean, se, ref, n } = host._fmt;
  if (qcUi.sel < 0 || qcUi.sel >= n) {
    out.innerHTML = `<b>${tfmt(mean)}</b><span>mean of ${n} clips`
      + `${se > 0 ? ` · ±${tfmt(se)}` : ''}${ref != null ? ` · threshold ${tfmt(ref)}` : ''}`
      + ' · tap a point</span>';
    return;
  }
  const pt = host._pts[qcUi.sel];
  const pctT = ref ? ` · ${Math.round((pt.v / ref) * 100)}% of threshold` : '';
  out.innerHTML = `<b>${pt.v.toFixed(3)}</b><span>at ${esc(hhmmss(pt.p))} · clip ${pt.i + 1} of ${n}${pctT}</span>`;
}

// Nearest-point selection: the pointer has to be closest, not dead-centre.
function qcWire(r, deep) {
  const host = $('#qc-host');
  if (!host) return;
  const sel = $('#qc-series');
  if (sel) sel.addEventListener('change', () => { qcUi.series = sel.value; qcUi.sel = -1; qcDraw(r, deep); });
  const tog = $('#qc-sort');
  if (tog) tog.addEventListener('click', () => { qcUi.sorted = !qcUi.sorted; tog.textContent = qcUi.sorted ? 'sorted' : 'by time'; qcUi.sel = -1; qcDraw(r, deep); });

  const pickAt = (ev) => {
    const svg = host.querySelector('svg');
    if (!svg || !host._pts) return;
    const b = svg.getBoundingClientRect();
    const sx = ((ev.clientX - b.left) / b.width) * svg.viewBox.baseVal.width;
    const sy = ((ev.clientY - b.top) / b.height) * svg.viewBox.baseVal.height;
    let best = -1; let bd = Infinity;
    host.querySelectorAll('.cp-hit').forEach((c) => {
      const d = (c.cx.baseVal.value - sx) ** 2 + (c.cy.baseVal.value - sy) ** 2;
      if (d < bd) { bd = d; best = +c.dataset.n; }
    });
    if (best >= 0 && best !== qcUi.sel) { qcUi.sel = best; qcDraw(r, deep); }
  };
  host.addEventListener('pointerdown', pickAt);
  host.addEventListener('pointermove', (e) => { if (e.buttons) pickAt(e); });
  host.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const n = host._pts.length;
    qcUi.sel = qcUi.sel < 0 ? 0 : (qcUi.sel + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
    qcDraw(r, deep);
  });

  // Re-measure on resize/rotate; the viewBox is built from the real width, not scaled to it.
  let t = 0;
  const ro = () => { clearTimeout(t); t = setTimeout(() => { if ($('#qc-host')) qcDraw(r, deep); }, 180); };
  window.addEventListener('resize', ro);
}
