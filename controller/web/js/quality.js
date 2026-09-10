'use strict';
// Part 7b/11 — Library (Quality) tab: the list.
//
// ONE RENDERER AT EVERY WIDTH. This began as cards below 700px and a grid above, and the cards
// were wrong: two rows of text per film reads as a wall on a phone and nothing lines up. So the
// table is the table everywhere — the title column is pinned left and the numbers scroll sideways
// under it, which is how a wide table is read on a small screen. One markup cache, one header, and
// no width at which the layout changes shape.

const Q_FADE_W = 30;                      // must match .qgrid-wrap::after in style.css
const Q_CHUNK = 150;                      // rows appended per frame after the first paint
const Q_FIRST = 60;                       // rows painted synchronously
const qMarkup = new Map();                // `${colsVersion}|${key}` -> row HTML
let qRaf = 0;
let qGridSync = null;

const qVisibleCols = () => {
  const chosen = qState.colsUserSet ? qState.cols
    : (window.innerWidth >= 700 ? Q_DEFAULT_COLS_WIDE : Q_DEFAULT_COLS);
  return [qCol('bppPlus'), ...chosen.map(qCol).filter((c) => c && c.id !== 'bppPlus' && !c.sortOnly)];
};

// ---- row markup ──────────────────────────────────────────────────────────────────────────────
// Exception-only: Bluray is 83% of sources and h264 89% of codecs, so printing them on every row
// is a thousand renders of "normal".
function qFlags(r) {
  const out = [];
  if (r.gpuCompat === 'bad') out.push(`<span class="flg hv" title="${esc(r.videoLabel || '')} — software transcode on this box">${esc((r.videoLabel || '').split(' ')[0])}</span>`);
  if (/remux/i.test(r.source || '')) out.push('<span class="flg gd">REMUX</span>');
  else if (/webrip|hdtv|sdtv|dvd|\bcam\b/i.test(r.source || '')) out.push(`<span class="flg bd">${esc(r.tier)}</span>`);
  if (r.artState === 'stale') out.push('<span class="flg bd" title="the file changed since its artifacts were measured">STALE</span>');
  if (r.top100) out.push(`<span class="flg t1" title="rank ${r.top100} in the Top 100 playlist">#${r.top100}</span>`);
  return out.join('');
}

// The year/season sits LAST and right-aligned, so it forms a column of its own however long the
// title is and whatever flags a row happens to carry.
function qRowHtml(r, cols) {
  const k = `${qState.colsVersion}|${r.key}`;
  let h = qMarkup.get(k);
  if (h != null) return h;
  const tail = r.season != null ? `S${String(r.season).padStart(2, '0')}` : (r.year || '');
  h = `<div class="qg-row q-${r.bppBand || 'off'}" data-k="${esc(r.key)}" role="row" tabindex="0">`
    + '<span class="qg-t" role="cell">'
      + `<b class="nm">${esc(r.name)}</b>`
      + `<span class="qg-flags">${qFlags(r)}</span>`
      + `<i class="qg-yr">${esc(String(tail))}</i>`
    + '</span>'
    + cols.map((c) => `<span class="qg-c" role="cell">${c.fmt(r)}</span>`).join('')
  + '</div>';
  qMarkup.set(k, h);
  return h;
}

function qRenderHead(cols) {
  const arrow = qState.dir > 0 ? 'ascending' : 'descending';
  $('#q-grid-head').innerHTML = '<div class="qg-row qg-head" role="row">'
    + `<span class="qg-t${qState.sort === 'title' ? ' on' : ''}" role="columnheader" data-col="title"`
      + `${qState.sort === 'title' ? ` aria-sort="${arrow}"` : ''}><b class="nm">TITLE</b></span>`
    + cols.map((c) => `<span class="qg-c${c.id === qState.sort ? ' on' : ''}" role="columnheader"`
      + ` data-col="${c.id}"${c.id === qState.sort ? ` aria-sort="${arrow}"` : ''} title="${esc(c.label)}">${esc(c.short)}</span>`).join('')
    + '</div>';
}

// ONE template, on the scroller, inherited by the header strip and every row.
//
// Numeric tracks get their declared width plus an equal share of any slack, so a short column set
// fills the panel instead of huddling left with a field of dead space beside it. A set long enough
// to overflow has no slack, and the declared widths stand.
function qApplyTemplate(cols) {
  const sc = $('#q-grid');
  const strip = $('#q-grid-head');
  const avail = sc.clientWidth || 0;
  const fixed = cols.reduce((a, c) => a + (c.w || 56), 0);
  let tw;
  let add = 0;
  if (avail && avail < 700) {
    // ON A PHONE THE FIRST SCREENFUL IS THE TITLE AND THE SCORE, and everything else is a scroll
    // away — but the title is CAPPED AT HALF THE WIDTH. Letting it take everything left over gave
    // it 73% and squeezed the numbers into a crunched strip; half leaves room for a column or two
    // beyond the score before any scrolling.
    const room = avail - (cols[0] ? cols[0].w || 56 : 58) - Q_FADE_W;
    tw = Math.max(130, Math.min(Math.floor(avail * 0.5), room));
  } else {
    tw = parseInt(getComputedStyle(sc).getPropertyValue('--tw'), 10) || 200;
    // Numeric tracks take their declared width plus an equal share of any slack, so a short column
    // set fills the panel instead of huddling left beside a field of dead space.
    const slack = Math.max(0, avail - tw - fixed);
    add = cols.length ? Math.floor(slack / cols.length) : 0;
  }
  const tpl = `${tw}px ${cols.map((c) => `${(c.w || 56) + add}px`).join(' ')}`;
  sc.style.setProperty('--qgc', tpl);
  strip.style.setProperty('--qgc', tpl);
}

// ---- render ──────────────────────────────────────────────────────────────────────────────────
function qRender() {
  const cols = qVisibleCols();
  const rows = qState.filtered;
  const host = $('#q-grid');

  qRenderChrome();                        // sets visibility, so clientWidth below is real
  qRenderHead(cols);
  qApplyTemplate(cols);
  if (qRaf) { cancelAnimationFrame(qRaf); qRaf = 0; }
  host.innerHTML = rows.slice(0, Q_FIRST).map((r) => qRowHtml(r, cols)).join('');

  // 1054 rows is ~12,600 elements: 280-670ms of parse + style recalc on a mid-range phone. The
  // cache removes the formatter runs but not the parse, so the tail arrives in rAF chunks.
  let i = Q_FIRST;
  const step = () => {
    if (i >= rows.length) { qRaf = 0; if (qGridSync) qGridSync(); return; }
    const end = Math.min(i + Q_CHUNK, rows.length);
    host.insertAdjacentHTML('beforeend', rows.slice(i, end).map((r) => qRowHtml(r, cols)).join(''));
    i = end;
    qRaf = requestAnimationFrame(step);
  };
  if (rows.length > Q_FIRST) qRaf = requestAnimationFrame(step);
  if (qGridSync) qGridSync();
}

function qRenderChrome() {
  const n = qState.filtered.length;
  const total = qState.rows.length;
  const active = qActiveFilters();
  const searching = !!qState.filters.q.trim();

  $('#q-loading').hidden = !qState.loading;
  $('#q-error').hidden = !qState.error;
  if (qState.error) $('#q-error-text').textContent = qState.error;
  $('#q-grid-wrap').hidden = !!(qState.loading || qState.error || !n);

  const empty = $('#q-empty');
  empty.hidden = !!(n || qState.loading || qState.error);
  if (!n && !qState.loading && !qState.error) {
    empty.innerHTML = (active.length || searching)
      ? `Nothing matches${searching ? ` “${esc(qState.filters.q.trim())}”` : ''}${active.length ? ` · ${active.map((a) => esc(a.label)).join(' · ')}` : ''}`
        + ' <button class="audit-btn" id="q-clear">Clear</button>'
      : 'Nothing measured yet — the nightly probe fills this in.';
    const c = $('#q-clear');
    if (c) c.addEventListener('click', () => { $('#q-search').value = ''; qResetFilters(); qRender(); });
  }

  $('#q-foot').hidden = !n;
  $('#q-count').textContent = n === total ? `${total} units` : `${n} of ${total} units`;

  const hidden = qHiddenFilterCount();
  const fc = $('#q-fcount');
  fc.hidden = !hidden;
  fc.textContent = String(hidden);
  qRenderChips(active);
}

// Movies/TV/All has its own segmented control; this row carries Top 100 plus one removable chip
// per ranged filter, so nothing is ever silently on.
function qRenderChips(active) {
  const host = $('#q-chips');
  $$('.chip', host).forEach((c) => c.remove());
  const frag = document.createDocumentFragment();
  for (const a of active.filter((x) => x.id !== 'top100')) {
    const b = document.createElement('button');
    b.className = 'chip on rm';
    b.innerHTML = `${esc(a.label)}<em aria-hidden="true">×</em>`;
    b.setAttribute('aria-label', `Remove filter ${a.label}`);
    b.addEventListener('click', () => { qClearFilter(a.id); qRender(); });
    frag.appendChild(b);
  }
  const on = !!qState.filters.top100;
  const t = document.createElement('button');
  t.className = `chip${on ? ' on' : ''}`;
  t.textContent = 'Top 100';
  t.setAttribute('aria-pressed', on ? 'true' : 'false');
  t.addEventListener('click', () => { qState.filters.top100 = !on; qApplyFilters(); qRender(); });
  frag.appendChild(t);
  host.appendChild(frag);
}

function qClearFilter(id) {
  const f = qState.filters;
  if (id === 'gb') { f.gbMin = null; f.gbMax = null; }
  else if (id === 'year') { f.yearMin = null; f.yearMax = null; }
  else if (id === 'tier') f.tier = '';
  else if (id === 'minSamples') f.minSamples = 0;
  else f[id] = false;
  qApplyFilters();
}

// ---- actions ─────────────────────────────────────────────────────────────────────────────────
const qAppOf = (key) => (key.startsWith('tv:') ? 'sonarr' : 'radarr');
const qArrId = (key) => +key.split(':')[1];

function qDropRow(app, id) {
  const prefix = app === 'sonarr' ? `tv:${id}:` : `mv:${id}`;
  const gone = qState.rows.filter((r) => (app === 'sonarr' ? r.key.startsWith(prefix) : r.key === prefix));
  if (!gone.length) return;
  const dead = new Set(gone.map((r) => r.key));
  for (const k of dead) { qState.byKey.delete(k); qState.deep.delete(k); }
  qState.rows = qState.rows.filter((r) => !dead.has(r.key));
  for (const k of [...qMarkup.keys()]) if (dead.has(k.slice(k.indexOf('|') + 1))) qMarkup.delete(k);
  if (qState.view === 'film' && dead.has(qState.filmKey)) qGoList();
  qApplyFilters();
  qRender();
}

async function qReload() {
  qMarkup.clear();
  await qLoad(true);
  qRender();
}

// ---- wiring ──────────────────────────────────────────────────────────────────────────────────
function qSortBy(id) {
  if (qState.sort === id) qState.dir *= -1;
  else { qState.sort = id; qState.dir = qCol(id).num ? -1 : 1; }
  $('#q-sort').value = qState.sort;
  $('#q-dir').textContent = qState.dir > 0 ? '↑' : '↓';
  qSaveSort(); qSort(); qRender();
}

function qInit() {
  const sel = $('#q-sort');
  sel.innerHTML = '<optgroup label="Identity"><option value="title">title</option></optgroup>'
    + Q_GROUPS.map(([g, gl]) => {
      const cols = Q_COLS.filter((c) => c.group === g && !c.sortOnly);
      if (!cols.length) return '';
      return `<optgroup label="${esc(gl)}">${cols.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('')}</optgroup>`;
    }).join('');
  sel.value = qState.sort;
  sel.addEventListener('change', () => {
    qState.sort = sel.value;
    qState.dir = qCol(qState.sort).num ? -1 : 1;
    $('#q-dir').textContent = qState.dir > 0 ? '↑' : '↓';
    qSaveSort(); qSort(); qRender();
  });

  $('#q-dir').addEventListener('click', () => {
    qState.dir *= -1;
    $('#q-dir').textContent = qState.dir > 0 ? '↑' : '↓';
    qSaveSort(); qSort(); qRender();
  });
  $('#q-dir').textContent = qState.dir > 0 ? '↑' : '↓';

  $('#q-kind').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    qState.filters.kind = b.dataset.kind;
    $$('#q-kind button').forEach((x) => x.classList.toggle('active', x === b));
    qApplyFilters(); qRender();
  });
  $$('#q-kind button').forEach((b) => b.classList.toggle('active', b.dataset.kind === qState.filters.kind));

  let dq = 0;
  $('#q-search').addEventListener('input', () => {
    clearTimeout(dq);
    dq = setTimeout(() => { qState.filters.q = $('#q-search').value; qApplyFilters(); qRender(); }, 150);
  });

  $('#q-retry').addEventListener('click', () => qReload());
  $('#q-gear').addEventListener('click', qOpenSheet);

  const host = $('#q-grid');
  host.addEventListener('click', (e) => {
    const row = e.target.closest('[data-k]');
    if (row) qGoFilm(row.dataset.k);
  });
  host.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('[data-k]');
    if (!row) return;
    e.preventDefault();
    qGoFilm(row.dataset.k);
  });
  $('#q-grid-head').addEventListener('click', (e) => {
    const th = e.target.closest('[data-col]');
    if (th) qSortBy(th.dataset.col);
  });

  qSyncGridScroll();
  qSheetInit();
  $('#qf-help-close').addEventListener('click', () => { $('#qf-help-backdrop').hidden = true; });
  $('#qf-help-backdrop').addEventListener('click', (e) => {
    if (e.target === $('#qf-help-backdrop')) $('#qf-help-backdrop').hidden = true;
  });
}

// The header CANNOT be sticky inside the horizontal scroller: overflow-x:auto computes
// overflow-y:auto, so the scroller's vertical range is 0 and top:0 resolves against it — measured
// scrolling off to -415px. It is a separate strip, sticky against the PAGE, with scrollLeft synced.
function qSyncGridScroll() {
  const sc = $('#q-grid');
  const strip = $('#q-grid-head');
  const wrap = $('#q-grid-wrap');
  const upd = () => {
    strip.scrollLeft = sc.scrollLeft;
    const max = sc.scrollWidth - sc.clientWidth;
    wrap.classList.toggle('can-r', max > 1 && sc.scrollLeft < max - 1);
    wrap.classList.toggle('scrolled', sc.scrollLeft > 0);
  };
  sc.addEventListener('scroll', upd, { passive: true });
  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { qApplyTemplate(qVisibleCols()); upd(); }, 150);
  });
  qGridSync = upd;
  upd();
}

// ---- entry point ─────────────────────────────────────────────────────────────────────────────
async function qShow() {
  if (offline) {
    qState.error = 'Connect to your home network to see quality data.';
    qRenderChrome();
    return;
  }
  if (qState.rows.length) {
    qRender();
    if (Date.now() - qState.loadedAt > Q_TTL_MS) { await qLoad(false); qRender(); }
    return;
  }
  $('#q-loading-text').textContent = 'Loading quality data…';
  qState.loading = true;
  qRenderChrome();
  const slow = setTimeout(() => { $('#q-loading-text').textContent = 'Building the library index…'; }, 2500);
  await qLoad(false);
  clearTimeout(slow);
  qRender();
}

// ---- Columns + Filters sheet ─────────────────────────────────────────────────────────────────
let qPane = 'cols';
const Q_CHEV_UP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
const Q_CHEV_DN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const Q_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const qModeCols = () => (window.innerWidth >= 700 ? Q_DEFAULT_COLS_WIDE : Q_DEFAULT_COLS);

function qOpenSheet() { qRenderPanes(); $('#q-sheet-backdrop').hidden = false; }
function qCloseSheet() { $('#q-sheet-backdrop').hidden = true; }

function qRenderPanes() {
  $$('#q-sheet-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.pane === qPane));
  $('#q-pane-cols').hidden = qPane !== 'cols';
  $('#q-pane-filters').hidden = qPane !== 'filters';
  if (qPane === 'cols') qRenderColsPane(); else qRenderFiltersPane();
}

function qRenderColsPane() {
  const chosen = qState.colsUserSet ? qState.cols : qModeCols();
  $('#q-pane-cols').innerHTML = `
    <p class="q-sheet-note">${chosen.length} shown · BPP+ is always on</p>
    <ol class="q-chosen">${chosen.map((id, i) => {
      const c = qCol(id);
      return `<li><span class="q-ch-l">${esc(c.label)}</span>
        <span class="q-ch-mv">
          <button class="q-ch-b" data-mv="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(c.label)} up">${Q_CHEV_UP}</button>
          <button class="q-ch-b" data-mv="down" data-i="${i}" ${i === chosen.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(c.label)} down">${Q_CHEV_DN}</button>
        </span>
        <button class="q-ch-b rm" data-off="${esc(id)}" aria-label="Hide ${esc(c.label)}">${Q_X}</button></li>`;
    }).join('')}</ol>
    ${Q_GROUPS.map(([g, gl]) => {
      const cols = qPickable().filter((c) => c.group === g);
      if (!cols.length) return '';
      return `<h4 class="q-grp">${esc(gl)}</h4><div class="q-cat">${cols.map((c) => {
        const on = chosen.includes(c.id);
        return `<button class="chip${on ? ' on' : ''}" data-on="${esc(c.id)}" aria-pressed="${on}"
          title="${esc(c.help)}">${esc(c.label)}</button>`;
      }).join('')}</div>`;
    }).join('')}`;
}

function qRenderFiltersPane() {
  const f = qState.filters;
  const num = (id, v, ph) => `<input class="q-in" id="${id}" type="number" inputmode="numeric"
    value="${v == null ? '' : v}" placeholder="${ph}" autocomplete="off">`;
  $('#q-pane-filters').innerHTML = `
    <label class="q-fl">Source tier
      <select class="qsel wide" id="qf-tier">
        <option value="">any</option>
        ${qTierOptions().map(([t, n]) => `<option value="${esc(t)}"${f.tier === t ? ' selected' : ''}>${esc(t)} (${n})</option>`).join('')}
      </select></label>
    <label class="q-fl">Size GB<span class="q-pair">${num('qf-gbmin', f.gbMin, 'min')}<i>–</i>${num('qf-gbmax', f.gbMax, 'max')}</span></label>
    <label class="q-fl">Year<span class="q-pair">${num('qf-ymin', f.yearMin, 'from')}<i>–</i>${num('qf-ymax', f.yearMax, 'to')}</span></label>
    <label class="q-fl">Clips sampled, at least<span class="q-pair">${num('qf-ns', f.minSamples || null, '0')}</span></label>
    <p class="q-sheet-note">${qState.filtered.length} of ${qState.rows.length} units match.</p>`;
}

const qNumVal = (id) => { const el = $(id); const v = el && el.value.trim(); return v === '' || v == null ? null : Number(v); };

function qReadFiltersPane() {
  const f = qState.filters;
  const t = $('#qf-tier'); if (t) f.tier = t.value;
  f.gbMin = qNumVal('#qf-gbmin'); f.gbMax = qNumVal('#qf-gbmax');
  f.yearMin = qNumVal('#qf-ymin'); f.yearMax = qNumVal('#qf-ymax');
  f.minSamples = qNumVal('#qf-ns') || 0;
  qApplyFilters();
}

function qSheetInit() {
  $('#q-sheet-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (qPane === 'filters') qReadFiltersPane();
    qPane = b.dataset.pane;
    qRenderPanes();
  });

  $('#q-pane-cols').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    // First interaction promotes the mode default into an explicit choice, so the two never mix.
    if (!qState.colsUserSet) qState.cols = qModeCols().slice();
    if (b.dataset.on != null) {
      const id = b.dataset.on;
      const i = qState.cols.indexOf(id);
      if (i >= 0) qState.cols.splice(i, 1); else qState.cols.push(id);
    } else if (b.dataset.off != null) {
      const i = qState.cols.indexOf(b.dataset.off);
      if (i >= 0) qState.cols.splice(i, 1);
    } else if (b.dataset.mv) {
      const i = +b.dataset.i;
      const j = b.dataset.mv === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= qState.cols.length) return;
      [qState.cols[i], qState.cols[j]] = [qState.cols[j], qState.cols[i]];
    } else return;
    qSaveCols();
    qRenderColsPane();
    qRender();
  });

  $('#q-pane-filters').addEventListener('change', () => { qReadFiltersPane(); qRender(); qRenderFiltersPane(); });

  $('#q-sheet-done').addEventListener('click', () => {
    if (qPane === 'filters') qReadFiltersPane();
    qCloseSheet(); qRender();
  });
  $('#q-sheet-reset').addEventListener('click', () => {
    if (qPane === 'cols') {
      qState.cols = qModeCols().slice();
      qState.colsUserSet = false;
      qState.colsVersion++;
      try { localStorage.removeItem(Q_LS.cols); } catch { /* ignore */ }
    } else {
      qResetFilters();
      $('#q-search').value = '';
    }
    qRenderPanes(); qRender();
  });
  $('#q-sheet-backdrop').addEventListener('click', (e) => {
    if (e.target === $('#q-sheet-backdrop')) { if (qPane === 'filters') qReadFiltersPane(); qCloseSheet(); qRender(); }
  });
}
