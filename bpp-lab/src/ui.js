// Shared shell for every panel.
//
// The reasoning behind each chart is worth keeping — it is most of what makes a number trustworthy —
// but it is reference material, not something to read on every visit. So it lives behind a "why?"
// button opening a modal: nothing on the page by default, the full explanation one click away.

import Swal from 'sweetalert2';
import 'sweetalert2/dist/sweetalert2.min.css';

export const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// panel(title, { why, caption }) -> element with .body to append into.
export function panel(title, { why = '', caption = '' } = {}) {
  const p = h('div', 'panel');
  const head = h('div', 'phead');
  const t = h('h2', null, title);
  head.appendChild(t);
  if (why) head.appendChild(whyButton(title, why));
  p.appendChild(head);
  if (caption) {
    const c = h('div', 'cap');
    c.innerHTML = caption;
    p.appendChild(c);
  }
  const body = h('div', 'pbody');
  p.appendChild(body);
  p.body = body;
  return p;
}

// The why? modal button, standalone so a view can place it anywhere (e.g. in a toolbar) rather than
// only beside the panel title.
export function whyButton(title, why) {
  const btn = h('button', 'why', 'why?');
  btn.onclick = () => Swal.fire({
    title,
    html: `<div class="whybox">${why}</div>`,
    width: 760,
    padding: '18px 22px',
    showConfirmButton: false,
    showCloseButton: true,
    customClass: { popup: 'swal-dark' },
  });
  return btn;
}

// A row of big numbers. `items` is [value, label, color?].
export function stats(items) {
  const box = h('div', 'stat');
  for (const [v, label, color] of items) {
    const d = h('div');
    const b = h('b', null, String(v));
    if (color) b.style.color = color;
    d.append(b, h('span', null, label));
    box.appendChild(d);
  }
  return box;
}

export function table(cols, rows, { onRow = null, scroll = false, maxHeight = '' } = {}) {
  const t = h('table');
  const thead = h('thead');
  const tr = h('tr');
  for (const c of cols) {
    const th = h('th', c.num ? 'num' : null, c.label);
    if (c.onSort) { th.style.cursor = 'pointer'; th.onclick = c.onSort; }
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  t.appendChild(thead);
  const tb = h('tbody');
  for (const r of rows) {
    const row = h('tr');
    row.innerHTML = cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.cell(r)}</td>`).join('');
    if (onRow) { row.style.cursor = 'pointer'; row.onclick = () => onRow(r); }
    tb.appendChild(row);
  }
  t.appendChild(tb);
  if (!scroll) return t;
  const sc = h('div', 'scroll');
  if (maxHeight) sc.style.maxHeight = maxHeight;
  sc.appendChild(t);
  return sc;
}

// A labelled form control for the control bars.
export function field(label, node) {
  const l = h('label', 'field');
  l.append(h('span', null, label), node);
  return l;
}

export function select(opts, value, onChange) {
  const s = h('select');
  for (const [v, t] of opts) {
    const o = h('option', null, t);
    o.value = v; o.selected = v === value;
    s.appendChild(o);
  }
  s.onchange = () => onChange(s.value);
  return s;
}

export function button(label, onClick, cls = 'act') {
  const b = h('button', cls, label);
  b.onclick = onClick;
  return b;
}

// The switch-style checkbox used by every toggle in the app (curve overlays + filter bar). The
// checkbox itself is visually hidden; a .track pill with a sliding dot carries the state, and an
// accent var (`--sw`) recolours it per-use. One implementation so the filter bar and the chart
// can never drift apart.
export function switchToggle(label, on, { color = null, title = '', onChange } = {}) {
  const lab = h('label', 'switch');
  const cb = h('input');
  cb.type = 'checkbox'; cb.checked = on;
  cb.onchange = () => onChange && onChange(cb.checked);
  const track = h('span', 'track');
  if (color) track.style.setProperty('--sw', color);
  const txt = h('span', null, label);
  if (title) txt.title = title;
  lab.append(cb, track, txt);
  return lab;
}

// A two-thumb range slider: min AND max handles on one rail. Native <input type=range> only has one
// thumb, so this overlays two of them on a shared rail. Crossing a thumb past the other swaps their
// values (the standard two-thumb behaviour); both fire `onChange(lo, hi)`.
// opts: { min, max, step, lo, hi, onChange }
export function dualRange(opts) {
  const wrap = h('div', 'dual');
  wrap.appendChild(h('div', 'drail'));
  const fill = h('div', 'dfill');
  wrap.appendChild(fill);

  const mk = (thumb) => {
    const i = h('input');
    i.type = 'range';
    i.min = opts.min; i.max = opts.max; i.step = opts.step;
    i.dataset.thumb = thumb;
    wrap.appendChild(i);
    return i;
  };
  const lo = mk('lo'); lo.value = opts.lo;
  const hi = mk('hi'); hi.value = opts.hi;

  const paint = () => {
    const span = opts.max - opts.min || 1;
    const l = (+lo.value - opts.min) / span * 100;
    const r = (+hi.value - opts.min) / span * 100;
    fill.style.left = `${l}%`;
    fill.style.right = `${100 - r}%`;
  };
  const emit = () => { paint(); opts.onChange && opts.onChange(+lo.value, +hi.value); };
  // Crossing a thumb swaps which input holds which end; whichever is being dragged sits on top
  // (higher z-index) so it stays grabbable right up to the point of crossing.
  lo.oninput = () => { if (+lo.value > +hi.value) { const t = lo.value; lo.value = hi.value; hi.value = t; } emit(); };
  hi.oninput = () => { if (+hi.value < +lo.value) { const t = hi.value; hi.value = lo.value; lo.value = t; } emit(); };
  lo.onpointerdown = () => { lo.style.zIndex = 2; hi.style.zIndex = 1; };
  hi.onpointerdown = () => { hi.style.zIndex = 2; lo.style.zIndex = 1; };
  paint();
  return wrap;
}

// The one place a caveat is loud enough to interrupt. Used sparingly — a warning on every panel is
// a warning on none.
export function flag(html) {
  const w = h('div', 'warnbox');
  w.innerHTML = html;
  return w;
}

export function legend(items) {
  const l = h('div', 'legend');
  l.innerHTML = items.map(([color, text]) => `<span><i style="background:${color}"></i>${text}</span>`).join('');
  return l;
}
