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
  { id: 'bppPlusFlat', label: 'flat', num: true, get: (r) => r.bppPlusFlat, fmt: (r) => fmt.int(r.bppPlusFlat) },
  { id: 'cxEff', label: 'cx', num: true, get: (r) => r.cxEff, fmt: (r) => fmt.n(r.cxEff, 4) },
  { id: 'complexity', label: 'cx raw', num: true, get: (r) => r.complexity, fmt: (r) => fmt.n(r.complexity, 4) },
  { id: 'biasFactor', label: 'pin', num: true, get: (r) => r.biasFactor, fmt: (r) => fmt.n(r.biasFactor, 3) },
  { id: 'R', label: 'R', num: true, get: (r) => r.R, fmt: (r) => fmt.n(r.R, 2) },
  { id: 'srcMbps', label: 'src Mb/s', num: true, get: (r) => r.srcMbps, fmt: (r) => fmt.n(r.srcMbps, 1) },
  { id: 'gb', label: 'GB', num: true, get: (r) => r.gb, fmt: (r) => fmt.n(r.gb, 1) },
  { id: 'plusPerGb', label: '+/GB', num: true, get: (r) => r.plusPerGb, fmt: (r) => fmt.n(r.plusPerGb, 1) },
  // Never an em-dash: every measured unit was sampled >= 8 times, only the detail may be missing.
  { id: 'sampleN', label: 'n', num: true, get: (r) => r.sampleN, fmt: (r) => (r.sampleState === 'detailed' ? String(r.sampleN) : '<span style="color:var(--dim)" title="sampled at least 8 times; readings not retained">\u22658</span>') },
  { id: 'cxRSE', label: 'RSE', num: true, get: (r) => r.cxRSE,
    fmt: (r) => (r.cxRSE == null ? '—' : `<span style="color:${r.cxRSE / 2 > 0.10 ? 'var(--warn)' : 'var(--dim)'}">${fmt.pct(r.cxRSE, 1)}</span>`) },
  { id: 'spreadRatio', label: 'sprd', num: true, get: (r) => r.spreadRatio, fmt: (r) => fmt.n(r.spreadRatio, 1) },
  { id: 'disagree', label: 'disag', num: true, get: (r) => r.disagree, fmt: (r) => fmt.n(r.disagree, 3) },
  { id: 'audioShare', label: 'aud%', num: true, get: (r) => r.audioShare, fmt: (r) => fmt.pct(r.audioShare, 1) },
  { id: 'pairs', label: 'pairs', num: true, get: (r) => r.pairs, fmt: (r) => r.pairs || '' },
  { id: 'source', label: 'tier', get: (r) => r.source || '', fmt: (r) => esc(r.source || '') },
  // BANDING — the second axis. An unmeasured row shows a dim dash, NEVER 0: the banding probe is
  // still backfilling and "no reading" must not read as "no banding".
  { id: 'cambi', label: 'band', num: true, get: (r) => (r.cambiAny == null ? -1 : r.cambiAny),
    fmt: (r) => (r.cambiAny == null
      ? '<span style="color:var(--dim)" title="not measured yet">—</span>'
      : `<span style="color:${r.cambiSrc === 'artifact' ? 'var(--dim)' : bandingColor(r)}" title="${r.cambiSrc === 'artifact' ? '4-clip artifact reading; the nightly 8-clip banding job has not reached this unit' : 'nightly 8-clip banding job'}">${fmt.n(r.cambiAny, 2)}</span>`) },
  // Worst clip beside the mean. A film where these disagree across the threshold is the one case
  // the mean actively misleads about — flagged in red rather than left for the reader to spot.
  { id: 'cambiMax', label: 'band max', num: true, get: (r) => r.cambiMax,
    fmt: (r) => (r.cambiMax == null ? '<span style="color:var(--dim)" title="no per-clip record">—</span>'
      : `<span style="color:${r.cambiHidden ? 'var(--bad)' : 'var(--dim)'}"${r.cambiHidden ? ' title="the MEAN reads clean but one clip is over the visibility threshold — a banded scene averaged away"' : ''}>${fmt.n(r.cambiMax, 2)}</span>`) },
  { id: 'cambiLuma', label: 'luma', num: true, get: (r) => r.cambiLuma,
    fmt: (r) => (r.cambiLuma == null ? '—' : fmt.n(r.cambiLuma, 0)) },
  // ---- THE ARTIFACT TERM, merged in when the Blend tab was deleted --------------------------
  // Sorting on P is the single most useful thing the old tab offered and it never had it: the
  // movers list was capped at 40 rows, so the library-wide ordering was not inspectable.
  { id: 'P', label: 'P', num: true, get: (r) => r.P,
    fmt: (r) => (r.P == null ? '<span style="color:var(--dim)" title="no artifact measurement">—</span>'
      : `<span style="color:${r.P > 0 ? 'var(--bad)' : 'var(--ok)'}">${fmt.n(r.P, 2)}</span>`) },
  // BPP+ (the column above) is the FULL score and includes provenance. This is the same score
  // evaluated at P = 0 — the subscript is the value of P, not a version number.
  { id: 'bppPlus0', label: 'BPP+₀', num: true, get: (r) => r.bppPlus0,
    // An unmeasured unit's BPP+ and BPP+₀ are the SAME number by construction, so it renders
    // italic to say "these coincide because nothing was measured", not "this is missing".
    fmt: (r) => (r.artState === 'none'
      ? `<span style="color:var(--dim);font-style:italic" title="no artifact reading — BPP+ and BPP+₀ coincide">${fmt.int(r.bppPlus0)}</span>`
      : `<span style="color:${bandColor(r.bppPlus0)}">${fmt.int(r.bppPlus0)}</span>`) },
  // Split, not combined: provenance is zero-sum, adequacy can move the median. See data.js.
  { id: 'adqDelta', label: 'Δ adq', num: true, get: (r) => r.adqDelta,
    fmt: (r) => (r.adqDelta == null ? '<span style="color:var(--dim)" title="no per-clip banding yet">—</span>'
      : `<span style="color:${r.adqDelta <= -0.5 ? 'var(--bad)' : r.adqDelta >= 0.5 ? 'var(--accent)' : 'var(--dim)'}">${r.adqDelta > 0 ? '+' : ''}${fmt.n(r.adqDelta, 1)}</span>`) },
  { id: 'adqC', label: 'elbow c', num: true, get: (r) => r.adqC, fmt: (r) => fmt.n(r.adqC, 2) },
  { id: 'artDelta', label: 'Δ both', num: true, get: (r) => r.artDelta,
    fmt: (r) => (r.artDelta == null ? '—'
      : `<span style="color:${r.artDelta <= -1 ? 'var(--bad)' : r.artDelta >= 1 ? 'var(--accent)' : 'var(--dim)'}">${r.artDelta > 0 ? '+' : ''}${fmt.n(r.artDelta, 1)}</span>`) },
  { id: 'artBits', label: 'bits×', num: true, get: (r) => r.artBits, fmt: (r) => fmt.n(r.artBits, 3) },
  { id: 'drives', label: 'drives', get: (r) => r.drives || '', fmt: (r) => esc(r.drives || '') },
  { id: 'zCambi', label: 'zBand', num: true, get: (r) => r.zCambi, fmt: (r) => fmt.n(r.zCambi, 2) },
  { id: 'zBlock', label: 'zBlk', num: true, get: (r) => r.zBlock, fmt: (r) => fmt.n(r.zBlock, 2) },
  { id: 'zBlur', label: 'zBlur', num: true, get: (r) => r.zBlur, fmt: (r) => fmt.n(r.zBlur, 2) },
  { id: 'zGrain', label: 'zGrn', num: true, get: (r) => r.zGrain, fmt: (r) => fmt.n(r.zGrain, 2) },
  { id: 'artState', label: 'art', get: (r) => r.artState || '',
    fmt: (r) => (r.artState === 'measured' ? '' : `<span style="color:var(--warn)" title="stale = the file changed since the artifacts were measured">${esc(r.artState)}</span>`) },
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
  // NO inline max-height. It used to be 70vh, which pinned a 900-row table inside a window and gave
  // the page two scrollbars. The page itself scrolls now — see .tbl-scroll in style.css.
  sc.className = 'scroll tbl-scroll';
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