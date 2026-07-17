'use strict';
// Part 7/9 — Library tab: Radarr/Sonarr toggle, search filter, per-title
// size/bitrate/GPU-format badges, delete/redownload buttons (sheets.js).

// ── Library + delete ──
let libApp = 'radarr';
let libItems = [];
let libSeq = 0;   // request sequence — a slow older response must never clobber a newer one
let libLoading = false;
function setLibLoading(v) { libLoading = v; const el = $('#library-loading'); if (el) el.hidden = !v; }
$('#lib-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.app === libApp) return;                      // already on this tab — nothing to reload
  $$('#lib-toggle button').forEach((x) => x.classList.toggle('active', x === b));
  libApp = b.dataset.app;
  // Clear immediately: until the new list arrives, the OLD app's rows were still rendered and
  // actionable — a movie id could be handed to a sonarr delete/redownload (wrong-title action).
  libItems = [];
  renderLibrary();
  loadLibrary();
});
$('#lib-search').addEventListener('input', renderLibrary);

function renderLibrary() {
  const q = $('#lib-search').value.trim().toLowerCase();
  const items = q ? libItems.filter((m) => m.title.toLowerCase().includes(q)) : libItems;
  // While a fetch is in flight the list is intentionally empty — show the spinner, not a
  // premature "Nothing here yet." (the bug where flicking tabs looked like an empty library).
  $('#library-empty').hidden = items.length > 0 || libLoading;
  $('#library-empty').textContent = libItems.length ? 'No matches.' : 'Nothing here yet.';
  $('#library').innerHTML = items.map((m) => {
    let rate = '', rateCls = '';
    if (m.hasFile && m.sizeBytes && m.runtimeMinutes > 0) {
      const mbpm = m.sizeBytes / (1024 * 1024) / m.runtimeMinutes;
      rate = `${mbpm.toFixed(1)} MB/min`;
      rateCls = mbpm < 40 ? 'rate-ok' : mbpm < 80 ? 'rate-warn' : 'rate-bad';
    }
    const fmt = m.videoLabel || '';
    const compat = m.gpuCompat || '';
    const fmtCls = compat === 'ok' ? 'ok' : compat === 'warn' ? 'warn' : compat === 'bad' ? 'bad' : '';
    // Missing titles: show the server's live pipeline status ("Downloading (45%)", "Import
    // blocked", …) instead of a flat "Not downloaded" — the API computed it all along.
    const status = !m.hasFile && m.downloadDetail
      ? `<span class="dl-status ds-${esc(m.downloadStatus || 'missing')}">${esc(m.downloadDetail)}</span>`
      : `<span class="sub-size">${m.hasFile ? fmtBytes(m.sizeBytes) + ' on disk' : 'Not downloaded'}</span>`;
    return `<li class="row">
      <span class="grow">
        <span class="title">${esc(m.title)}${m.year ? ` <span class="muted">(${m.year})</span>` : ''}</span>
        <div class="sub">${status}${rate ? `<span class="rate ${rateCls}">${rate}</span>` : ''}${fmt ? `<span class="format ${fmtCls}">${esc(fmt)}</span>` : ''}</div>
      </span>
      ${m._app === 'radarr' ? `<button class="redl" data-id="${m.id}" aria-label="Redownload ${esc(m.title)}">
        <svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7M21 3v5h-5"/></svg>
      </button>` : ''}
      <button class="trash" data-id="${m.id}" aria-label="Remove ${esc(m.title)}">
        <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m1 0v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7"/></svg>
      </button>
    </li>`;
  }).join('');
  // Actions carry the ITEM's own app (stamped at load), never the global toggle — pairing the
  // current toggle with a stale list's numeric id was a wrong-title delete waiting to happen.
  $$('#library .trash').forEach((btn) => btn.addEventListener('click', () => {
    const it = libItems.find((m) => m.id === +btn.dataset.id);
    if (it) openSheet({ app: it._app, id: it.id });
  }));
  $$('#library .redl').forEach((btn) => btn.addEventListener('click', () => {
    const it = libItems.find((m) => m.id === +btn.dataset.id);
    if (it && it._app === 'radarr') openRedl(it.id);
  }));
}
async function loadLibrary() {
  if (offline) { setLibLoading(false); $('#library').innerHTML = ''; $('#library-empty').hidden = false; $('#library-empty').textContent = 'Connect to your home network to manage your library.'; return; }
  const seq = ++libSeq;
  setLibLoading(true);
  renderLibrary();                                               // hide the empty message behind the spinner right away
  try {
    const data = await getJSON(`/api/library?app=${libApp}`);
    if (seq !== libSeq) return;                                  // a newer request superseded this one
    libItems = (data.items || []).map((m) => ({ ...m, _app: data.app }));
    const el = $(`#lib-count-${data.app}`);
    if (el) el.textContent = libItems.length ? `(${libItems.length})` : '';
    setLibLoading(false);
    renderLibrary();
  }
  catch {
    if (seq !== libSeq) return;
    setLibLoading(false);
    libItems = [];                                               // stale rows must not stay actionable
    $('#library').innerHTML = '';
    $('#library-empty').hidden = false;
    $('#library-empty').textContent = 'Could not load the library — will retry when you switch tabs.';
  }
}
