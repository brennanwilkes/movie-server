import { load, state, applyFilters, TIER_OPTIONS, tierMatches, DEFAULT_FILTERS } from './data.js';
import overview from './views/overview.js';
import curve from './views/curve.js';
import film from './views/film.js';
import table from './views/table.js';
import { h, dualRange, switchToggle } from './ui.js';

// The Blend tab was DELETED 2026-08-29 and its contents merged into the four views below. It was a
// separate tab because the artifact term was a separate experiment; now that the term is decided
// (strength 1.0, no free parameters) it is just another property of a film, and a property belongs
// beside every other property rather than on an island. P is now an axis, a colour, a table column
// and a film stat. A stale `#blend` bookmark falls back to Overview via the check below.
const VIEWS = [
  { id: 'overview', label: 'Overview', view: overview },
  { id: 'curve', label: 'Quality curve', view: curve },
  { id: 'film', label: 'Film', view: film },
  { id: 'table', label: 'Table', view: table },
];

let current = location.hash.slice(1) || 'overview';
if (!VIEWS.some((v) => v.id === current)) current = 'overview';

function renderTabs() {
  const nav = document.getElementById('tabs');
  nav.replaceChildren(...VIEWS.map((v) => {
    const b = document.createElement('button');
    b.textContent = v.label;
    b.className = v.id === current ? 'on' : '';
    b.onclick = () => { current = v.id; location.hash = v.id; renderAll(); };
    return b;
  }));
}

function renderFilters() {
  const host = document.getElementById('filters');
  host.replaceChildren();
  host.style.display = 'flex';
  host.classList.toggle('oneline', current === 'film');

  // ON THE FILM TAB, THE TITLE PICKER TAKES THE UNIT AND SEARCH SLOT. That tab shows exactly one
  // film, so a Unit selector and a title-contains box are two ways of narrowing a list the page
  // never displays — and the picker was costing a whole extra row of vertical space below the bar to
  // do the same job better. The remaining filters (Top 100, tier, size, year, samples) still matter:
  // they scope WHICH films the picker offers.
  //
  // Both are RESET on the way in rather than merely hidden. A hidden 'TV seasons' or a hidden search
  // string would silently shrink the picker's list with no visible cause — the exact class of bug
  // where a control you cannot see is still filtering what you can.
  if (current === 'film') {
    if (state.filters.kind !== 'all' || state.filters.q) {
      state.filters.kind = 'all';
      state.filters.q = '';
      applyFilters();
    }
    const pick = document.createElement('select');
    pick.id = 'film-pick';
    host.appendChild(label('Film', pick));
  } else {
    host.appendChild(label('Unit', select(
      [['movie', 'Movies'], ['season', 'TV seasons'], ['all', 'All']],
      state.filters.kind,
      (v) => { state.filters.kind = v; applyFilters(); renderBody(); },
    )));

    const inp = document.createElement('input');
    inp.type = 'search'; inp.placeholder = 'title contains…'; inp.value = state.filters.q;
    inp.oninput = debounce(() => { state.filters.q = inp.value; applyFilters(); renderBody(); }, 180);
    const qLabel = label('Search', inp);
    qLabel.classList.add('grow');
    host.appendChild(qLabel);
  }

  // Top 100: ELo-rank membership pulled from the controller's Top 100 playlist (dataset.top100).
  // A switch, like every other toggle in the app — one shared component (ui.js switchToggle) so the
  // filter bar and the chart's overlay toggles can never drift apart.
  host.appendChild(switchToggle('Top 100', state.filters.top100, {
    color: '#b18cf0',
    title: 'ELo-rank membership pulled from the controller\'s Top 100 playlist',
    onChange: (on) => { state.filters.top100 = on; applyFilters(); renderBody(); },
  }));

  // Source tier: the per-row tier key mapped from the raw source string. Blu-ray and Web-DL are
  // SEPARATE options (the model keeps distinct keys at the same rank) with an extra combined
  // Disc/WEB-DL that matches either, plus an (N) count of how many rows each would show.
  // Sorted by how many units each option matches ('any' always pinned on top).
  const base = state.rows.filter((r) => state.filters.kind === 'all' || r.kind === state.filters.kind);
  const tierCount = (key) => base.filter((r) => tierMatches(r, key)).length;
  const tierOpts = TIER_OPTIONS
    .map((o) => [o.key, o.label, tierCount(o.key)])
    .sort((a, b) => {
      if (a[0] === '') return -1;
      if (b[0] === '') return 1;
      return b[2] - a[2];
    });
  host.appendChild(label('Tier', select(
    tierOpts.map(([key, label, n]) => [key, label === 'any' ? 'any' : `${label} (${n})`]),
    state.filters.tier,
    (v) => { state.filters.tier = v; applyFilters(); renderBody(); },
  )));

  // File size (GB) as a dual-thumb slider over the live extent of the filtered rows' source data.
  const gbs = state.rows.map((r) => r.gb).filter((x) => x != null).sort((a, b) => a - b);
  const gbMin = Math.floor(gbs[0] || 0);
  const gbMax = Math.ceil(gbs[gbs.length - 1] || 10);
  const sizeOut = h('span', 'mono',
    `${state.filters.sizeMin == null ? gbMin : state.filters.sizeMin}–${state.filters.sizeMax == null ? gbMax : state.filters.sizeMax} GB`);
  const size = dualRange({
    min: gbMin, max: gbMax, step: 1,
    lo: state.filters.sizeMin == null ? gbMin : state.filters.sizeMin,
    hi: state.filters.sizeMax == null ? gbMax : state.filters.sizeMax,
    onChange: debounce((lo, hi) => {
      state.filters.sizeMin = lo > gbMin ? lo : null;
      state.filters.sizeMax = hi < gbMax ? hi : null;
      sizeOut.textContent = `${state.filters.sizeMin ?? gbMin}–${state.filters.sizeMax ?? gbMax} GB`;
      applyFilters(); renderBody();
    }, 180),
  });
  host.appendChild(label('Size', pack([size, sizeOut])));

  // Year as a dual-thumb slider over the measured years.
  const years = state.rows.map((r) => r.year).filter((x) => x != null).sort((a, b) => a - b);
  const yearMin = years[0] || 1900;
  const yearMax = years[years.length - 1] || new Date().getFullYear();
  const yearOut = h('span', 'mono',
    `${state.filters.yearMin == null ? yearMin : state.filters.yearMin}–${state.filters.yearMax == null ? yearMax : state.filters.yearMax}`);
  const yr = dualRange({
    min: yearMin, max: yearMax, step: 1,
    lo: state.filters.yearMin == null ? yearMin : state.filters.yearMin,
    hi: state.filters.yearMax == null ? yearMax : state.filters.yearMax,
    onChange: debounce((lo, hi) => {
      state.filters.yearMin = lo > yearMin ? lo : null;
      state.filters.yearMax = hi < yearMax ? hi : null;
      yearOut.textContent = `${state.filters.yearMin ?? yearMin}–${state.filters.yearMax ?? yearMax}`;
      applyFilters(); renderBody();
    }, 180),
  });
  host.appendChild(label('Year', pack([yr, yearOut])));

  const min = document.createElement('input');
  min.type = 'range'; min.min = '0'; min.max = '32'; min.step = '8';
  min.value = String(state.filters.minSamples);
  const out = document.createElement('span');
  out.className = 'mono';
  out.textContent = state.filters.minSamples ? `>= ${state.filters.minSamples}` : 'any';
  min.oninput = debounce(() => {
    state.filters.minSamples = +min.value;
    out.textContent = state.filters.minSamples ? `>= ${state.filters.minSamples}` : 'any';
    applyFilters(); renderBody();
  }, 80);
  const wrap = document.createElement('span');
  wrap.style.display = 'flex'; wrap.style.gap = '6px'; wrap.style.alignItems = 'center';
  wrap.append(min, out);
  host.appendChild(label('Samples', wrap));

  // Clear every filter back to defaults, then rebuild the bar so the controls and the state agree.
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'act clearfilters';
  clear.textContent = 'reset filters';
  clear.onclick = () => {
    // One source of truth for the defaults. Inline copies here and in data.js would drift the first
    // time a filter is added, and applyFilters() persists — so a stale reset would then WRITE the
    // wrong shape to storage rather than merely showing it.
    Object.assign(state.filters, DEFAULT_FILTERS);
    renderFilters();
    applyFilters();
    renderBody();
  };
  host.appendChild(clear);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function label(text, node) {
  const l = document.createElement('label');
  l.append(text, node);
  return l;
}
function pack(nodes) {
  const s = document.createElement('span');
  s.className = 'filter2';
  s.append(...nodes);
  return s;
}
function select(opts, value, onChange) {
  const s = document.createElement('select');
  for (const [v, t] of opts) {
    const o = document.createElement('option');
    o.value = v; o.textContent = t; o.selected = v === value;
    s.appendChild(o);
  }
  s.onchange = () => onChange(s.value);
  return s;
}

function renderBody() {
  const host = document.getElementById('view');
  host.replaceChildren();
  const def = VIEWS.find((v) => v.id === current);
  try {
    def.view(host, { rerender: renderBody });
  } catch (err) {
    const d = document.createElement('div');
    d.className = 'err';
    d.textContent = `${def.label} failed to render: ${err.message}`;
    host.appendChild(d);
    console.error(err);
  }
}

function renderAll() {
  renderTabs();
  renderFilters();
  renderBody();
}

async function boot() {
  const host = document.getElementById('view');
  host.innerHTML = '<div class="loading">Loading the measurement table…</div>';
  try {
    await load();
    renderAll();
  } catch (err) {
    host.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'err';
    d.innerHTML = `<b>Could not load data.</b><br>${err.message}<br><br>`
      + 'The lab proxies <code>/api</code> to the NUC (see vite.config.js). Check the controller is '
      + 'up and that <code>/api/probe/dataset</code> exists — it was added alongside this tool, so '
      + 'an older controller image will 404 here.';
    host.appendChild(d);
  }
}

window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  if (VIEWS.some((v) => v.id === h) && h !== current) { current = h; renderAll(); }
});

boot();
