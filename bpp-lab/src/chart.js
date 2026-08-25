// Hand-rolled SVG. No chart library on purpose: this tool exists to make the model's own numbers
// inspectable, and a library that "helpfully" bins, smooths or clips would put a layer between the
// reader and the measurement — which is the exact failure this lab is meant to catch.

const NS = 'http://www.w3.org/2000/svg';

export function el(tag, attrs = {}, kids = []) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    n.setAttribute(k, String(v));
  }
  for (const c of [].concat(kids)) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return n;
}

// Scales close over their output range, so a range can NEVER be changed by assigning to `.range` —
// doing that leaves the closure on the old range and every mapped value comes back in the wrong
// units. `to()` returns a NEW scale on the same domain instead, which is what plot() uses to bind a
// caller's placeholder range to real pixels.
export const linear = (d0, d1, r0 = 0, r1 = 1) => {
  const span = (d1 - d0) || 1;
  const f = (v) => r0 + ((v - d0) / span) * (r1 - r0);
  f.invert = (px) => d0 + ((px - r0) / ((r1 - r0) || 1)) * span;
  f.domain = [d0, d1]; f.range = [r0, r1];
  f.to = (a, b) => linear(d0, d1, a, b);
  return f;
};

// Log scale, for complexity and bitrate — both span ~30x, and on a linear axis the bottom two
// thirds of the library collapse into a smear against the left edge.
export const log = (d0, d1, r0 = 0, r1 = 1) => {
  const a = Math.log(Math.max(d0, 1e-9)); const b = Math.log(Math.max(d1, 1e-9));
  const span = (b - a) || 1;
  const f = (v) => r0 + ((Math.log(Math.max(v, 1e-9)) - a) / span) * (r1 - r0);
  f.invert = (px) => Math.exp(a + ((px - r0) / ((r1 - r0) || 1)) * span);
  f.domain = [d0, d1]; f.range = [r0, r1]; f.isLog = true;
  f.to = (p, q) => log(d0, d1, p, q);
  return f;
};

// "Nice" ticks. For log scales it walks 1-2-5 decades, which keeps a 30x axis to ~6 labels.
export function ticks(scale, count = 6) {
  const [d0, d1] = scale.domain;
  if (scale.isLog) {
    const out = [];
    const lo = Math.floor(Math.log10(Math.max(d0, 1e-9)));
    const hi = Math.ceil(Math.log10(Math.max(d1, 1e-9)));
    for (let e = lo; e <= hi; e += 1) {
      for (const m of [1, 2, 5]) {
        const v = m * (10 ** e);
        if (v >= d0 && v <= d1) out.push(v);
      }
    }
    return out;
  }
  const span = d1 - d0;
  if (!span) return [d0];
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || mag * 10;
  const out = [];
  for (let v = Math.ceil(d0 / step) * step; v <= d1 + 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

const fmtTick = (v) => {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000) return `${Math.round(v / 1000)}k`;
  if (a >= 10) return String(Math.round(v));
  if (a >= 1) return v.toFixed(1);
  if (a >= 0.01) return v.toFixed(2);
  return v.toFixed(3);
};

// A framed plot area with axes and gridlines. Returns the <svg>, the group to draw data into, and
// the two scales, so every view builds charts the same way.
export function plot({ width = 640, height = 340, pad = { t: 14, r: 14, b: 34, l: 46 },
  x, y, xLabel = '', yLabel = '', xTicks = 6, yTicks = 6 } = {}) {
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet' });
  const inner = el('g');
  const axes = el('g', { class: 'axis' });
  svg.appendChild(axes); svg.appendChild(inner);

  const x0 = pad.l; const x1 = width - pad.r;
  const y0 = height - pad.b; const y1 = pad.t;
  // Rebind to pixels. Callers pass scales with only a domain that matters; y is flipped here
  // (screen y grows downward) so y(min) lands on the bottom edge.
  x = x.to(x0, x1);
  y = y.to(y0, y1);

  for (const t of ticks(x, xTicks)) {
    const px = x(t);
    if (px < x0 - 1 || px > x1 + 1) continue;
    axes.appendChild(el('line', { class: 'gridline', x1: px, x2: px, y1, y2: y0 }));
    axes.appendChild(el('text', { x: px, y: y0 + 14, 'text-anchor': 'middle' }, fmtTick(t)));
  }
  for (const t of ticks(y, yTicks)) {
    const py = y(t);
    if (py < y1 - 1 || py > y0 + 1) continue;
    axes.appendChild(el('line', { class: 'gridline', x1: x0, x2: x1, y1: py, y2: py }));
    axes.appendChild(el('text', { x: x0 - 6, y: py + 3, 'text-anchor': 'end' }, fmtTick(t)));
  }
  axes.appendChild(el('line', { x1: x0, x2: x1, y1: y0, y2: y0 }));
  axes.appendChild(el('line', { x1: x0, x2: x0, y1: y1, y2: y0 }));
  if (xLabel) axes.appendChild(el('text', { x: (x0 + x1) / 2, y: height - 2, 'text-anchor': 'middle' }, xLabel));
  if (yLabel) {
    axes.appendChild(el('text', {
      x: 10, y: (y0 + y1) / 2, 'text-anchor': 'middle',
      transform: `rotate(-90 10 ${(y0 + y1) / 2})`,
    }, yLabel));
  }
  return { svg, g: inner, x, y, box: { x0, x1, y0, y1 } };
}

// A thin error bar through a point. Drawn in warn-orange and hairline-thin so it reads as an
// annotation on the datum rather than as data of its own.
//
// ONLY 11 OF 1031 UNITS CAN SHOW ONE TODAY, and that is the point of drawing them: a chart where
// almost every dot is bare is an honest picture of how little of this library has a measured error
// bar. Do not synthesise one from spreadRatio to fill the gaps — spreadRatio is max/min, so it says
// nothing about the precision of the MEAN, which is the quantity BPP+ divides by.
export function errBar(x, y, { dx = 0, dy = 0, cap = 3 } = {}) {
  const g = el('g', { class: 'errbar', 'pointer-events': 'none' });
  if (dx > 0) {
    g.appendChild(el('line', { x1: x - dx, x2: x + dx, y1: y, y2: y }));
    g.appendChild(el('line', { x1: x - dx, x2: x - dx, y1: y - cap, y2: y + cap }));
    g.appendChild(el('line', { x1: x + dx, x2: x + dx, y1: y - cap, y2: y + cap }));
  }
  if (dy > 0) {
    g.appendChild(el('line', { x1: x, x2: x, y1: y - dy, y2: y + dy }));
    g.appendChild(el('line', { x1: x - cap, x2: x + cap, y1: y - dy, y2: y - dy }));
    g.appendChild(el('line', { x1: x - cap, x2: x + cap, y1: y + dy, y2: y + dy }));
  }
  return g;
}

export function path(points) {
  return points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('');
}

// ---- tooltip ---------------------------------------------------------------------------------
const tipEl = () => document.getElementById('tip');

export function attachTip(node, render) {
  node.addEventListener('mouseenter', (ev) => {
    const t = tipEl();
    t.innerHTML = render();
    t.hidden = false;
    moveTip(ev);
  });
  node.addEventListener('mousemove', moveTip);
  node.addEventListener('mouseleave', () => { tipEl().hidden = true; });
}

function moveTip(ev) {
  const t = tipEl();
  const pad = 14;
  const w = t.offsetWidth; const h = t.offsetHeight;
  let x = ev.clientX + pad; let y = ev.clientY + pad;
  if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
  t.style.left = `${Math.max(4, x)}px`;
  t.style.top = `${Math.max(4, y)}px`;
}

export const kv = (title, pairs) => `<b>${esc(title)}</b><div class="kv">${
  pairs.filter((p) => p[1] != null && p[1] !== '')
    .map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v)}</span>`).join('')}</div>`;

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
