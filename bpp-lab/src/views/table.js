import { state, fmt, bandColor, bandingColor } from '../data.js';
import { esc } from '../chart.js';
import { panel } from '../ui.js';

// The raw table. Every derived column the other views reason about, sortable, exportable — so a
// finding made visually here can be checked numerically, and taken elsewhere without re-deriving it.
//
// PERFORMANCE (885-1014 rows): the row <tr> element and its innerHTML are built ONCE per row and
// cached by key, so a sort just REORDERS existing nodes — it neither re-runs fmt() nor re-parses
// HTML. Combined with `content-visibility: auto` on tbody tr (style.css), offscreen rows are never
// painted, so scrolling the full table only renders the visible window.

const COLS = [
  { id: 'title', label: 'title', get: (r) => r.title, fmt: (r) => esc(r.title) },
  { id: 'year', label: 'year', num: true, get: (r) => r.year, fmt: (r) => r.year ?? '—' },
  { id: 'bppPlus', label: 'BPP+', num: true, get: (r) => r.bppPlus,
    fmt: (r) => `<span style="color:${bandColor(r.bppPlus)}">${fmt.int(r.bppPlus)}</span>` },
  { id: 'bppPlusFlat', label: 'BPP+ @0.13', num: true, get: (r) => r.bppPlusFlat, fmt: (r) => fmt.int(r.bppPlusFlat) },
  { id: 'cxEff', label: 'complexity', num: true, get: (r) => r.cxEff, fmt: (r) => fmt.n(r.cxEff, 4) },
  { id: 'complexity', label: 'raw cx', num: true, get: (r) => r.complexity, fmt: (r) => fmt.n(r.complexity, 4) },
  { id: 'biasFactor', label: 'pin ×', num: true, get: (r) => r.biasFactor, fmt: (r) => fmt.n(r.biasFactor, 3) },
  { id: 'R', label: 'R', num: true, get: (r) => r.R, fmt: (r) => fmt.n(r.R, 2) },
  { id: 'srcMbps', label: 'src Mb/s', num: true, get: (r) => r.srcMbps, fmt: (r) => fmt.n(r.srcMbps, 1) },
  { id: 'gb', label: 'GB', num: true, get: (r) => r.gb, fmt: (r) => fmt.n(r.gb, 1) },
  { id: 'plusPerGb', label: 'BPP+/GB', num: true, get: (r) => r.plusPerGb, fmt: (r) => fmt.n(r.plusPerGb, 1) },
  // Never an em-dash: every measured unit was sampled >= 8 times, only the detail may be missing.
  { id: 'sampleN', label: 'n', num: true, get: (r) => r.sampleN, fmt: (r) => (r.sampleState === 'detailed' ? String(r.sampleN) : '<span style="color:var(--dim)" title="sampled at least 8 times; readings not retained">\u22658</span>') },
  { id: 'cxRSE', label: 'cx RSE', num: true, get: (r) => r.cxRSE,
    fmt: (r) => (r.cxRSE == null ? '—' : `<span style="color:${r.cxRSE / 2 > 0.10 ? 'var(--warn)' : 'var(--dim)'}">${fmt.pct(r.cxRSE, 1)}</span>`) },
  { id: 'spreadRatio', label: 'spread', num: true, get: (r) => r.spreadRatio, fmt: (r) => fmt.n(r.spreadRatio, 1) },
  { id: 'disagree', label: 'disagree', num: true, get: (r) => r.disagree, fmt: (r) => fmt.n(r.disagree, 3) },
  { id: 'audioShare', label: 'audio %', num: true, get: (r) => r.audioShare, fmt: (r) => fmt.pct(r.audioShare, 1) },
  { id: 'pairs', label: 'pairs', num: true, get: (r) => r.pairs, fmt: (r) => r.pairs || '' },
  { id: 'source', label: 'tier', get: (r) => r.source || '', fmt: (r) => esc(r.source || '') },
  // BANDING — the second axis. An unmeasured row shows a dim dash, NEVER 0: the banding probe is
  // still backfilling and "no reading" must not read as "no banding".
  { id: 'cambi', label: 'banding', num: true, get: (r) => (r.cambi == null ? -1 : r.cambi),
    fmt: (r) => (r.cambi == null
      ? '<span style="color:var(--dim)" title="not measured yet">—</span>'
      : `<span style="color:${bandingColor(r)}">${fmt.n(r.cambi, 2)}</span>`) },
  { id: 'cambiLuma', label: 'luma', num: true, get: (r) => r.cambiLuma,
    fmt: (r) => (r.cambiLuma == null ? '—' : fmt.n(r.cambiLuma, 0)) },
];

const ui = { sort: 'bppPlus', dir: 1 };

// Cached row markup + element, keyed by unit key. Rows are immutable after load (decorate() ran
// once), so the cell HTML never goes stale — rebuilding a view is just reparenting cached nodes.
const rowMarkup = new Map();
const rowEls = new Map();

export default function table(host) {
  const withSamples = state.filtered.filter((r) => r.sampleState === 'detailed').length;
  const p = panel(`${state.filtered.length} units`, {
    caption: `${withSamples} retain per-sample readings · rest show \u22658`,
    why: '<b>complexity</b> is the effective (post-correction) value scoring divides by; <b>raw cx</b> '
      + 'is the unmodelled measurement — anything compared against BPP+ must use the former. '
      + '<b>cx RSE</b> is the error on the complexity <i>mean</i>; halve it for the error on BPP+, '
      + 'since the index takes a square root.<br><br>'
      + '<b>\u22658 does not mean "unmeasured".</b> Every unit was sampled at least 8 times — '
      + 'PROBE_SAMPLES is the floor, and a wide-spread unit gets 16. Units last measured before '
      + 'per-sample records shipped (2026-08-14) kept only the mean and the spread; the surviving '
      + 'proof the samples existed is <code>spreadRatio</code>, which is their max \u00f7 min.',
  });

  const dl = document.createElement('button');
  dl.className = 'act'; dl.textContent = 'Download CSV';
  dl.onclick = () => downloadCsv(sorted());
  p.body.appendChild(dl);

  const sc = document.createElement('div');
  sc.className = 'scroll';
  sc.style.maxHeight = '70vh';
  const t = document.createElement('table');

  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  for (const c of COLS) {
    const th = document.createElement('th');
    th.textContent = c.label + (ui.sort === c.id ? (ui.dir > 0 ? ' ▲' : ' ▼') : '');
    if (c.num) th.className = 'num';
    th.onclick = () => {
      if (ui.sort === c.id) ui.dir *= -1; else { ui.sort = c.id; ui.dir = c.num ? -1 : 1; }
      // No rebuild: reorder the existing <tr> nodes in place, then flip the header arrows.
      const els = [...tb.children];
      els.sort(cmp(c));
      tb.replaceChildren(...els);
      for (const head of t.querySelectorAll('th')) {
        const id = crossings.get(head);
        head.textContent = id === ui.sort ? label(id) + (ui.dir > 0 ? ' ▲' : ' ▼') : label(id);
      }
    };
    crossings.set(th, c.id);
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  t.appendChild(thead);

  const tb = document.createElement('tbody');
  t.appendChild(tb);
  sc.appendChild(t);
  p.body.appendChild(sc);
  host.appendChild(p);

  // Populate once per view render — nodes are reused from cache, so this is cheap.
  const frag = document.createDocumentFragment();
  for (const r of sorted()) frag.appendChild(rowEl(r));
  tb.appendChild(frag);
}

function label(id) { return (COLS.find((c) => c.id === id) || COLS[0]).label; }

const crossings = new Map();

function cmp(c) {
  return (a, b) => {
    const ar = a._row || a; const br = b._row || b;
    const av = c.get(ar); const bv = c.get(br);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;                       // nulls always last, whichever way it is sorted
    if (bv == null) return -1;
    if (typeof av === 'string') return ui.dir * av.localeCompare(bv);
    return ui.dir * (av - bv);
  };
}

function rowEl(r) {
  let el = rowEls.get(r.key);
  if (el) return el;
  el = document.createElement('tr');
  el._row = r;
  el.innerHTML = rowMarkupOf(r);
  el.style.cursor = 'pointer';
  el.onclick = () => { sessionStorage.setItem('bpp-lab.film', r.key); location.hash = 'film'; };
  rowEls.set(r.key, el);
  return el;
}

function rowMarkupOf(r) {
  let html = rowMarkup.get(r.key);
  if (html == null) {
    html = COLS.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.fmt(r)}</td>`).join('');
    rowMarkup.set(r.key, html);
  }
  return html;
}

function sorted() {
  const c = COLS.find((x) => x.id === ui.sort) || COLS[0];
  return [...state.filtered].sort(cmp(c));
}

function downloadCsv(rows) {
  const head = COLS.map((c) => c.id).join(',');
  const body = rows.map((r) => COLS.map((c) => {
    const v = c.get(r);
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  const blob = new Blob([`${head}\n${body}\n`], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bpp-lab-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}