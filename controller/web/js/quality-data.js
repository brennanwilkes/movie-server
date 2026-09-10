'use strict';
// Part 7a/11 — Library (Quality) tab: the data layer. Loads /api/probe/dataset?view=list once per
// tab session, decorates it, and owns the filter/sort/column state. No DOM.
//
// Every top-level name here is q/Q_ prefixed: these are classic scripts sharing one global lexical
// scope, and scripts/check-web-globals.js fails the deploy on a collision.

// ---- state ───────────────────────────────────────────────────────────────────────────────────
const Q_LS = { cols: 'ctl.quality.cols', sort: 'ctl.quality.sort', filters: 'ctl.quality.filters' };
const Q_TTL_MS = 10 * 60 * 1000;          // refetch on tab open only if older than this
// The cold path is a full Radarr+Sonarr enumeration behind a 1h cache; measured at up to 5.6s.
// getJSON's 12s default would abort it and throw the server's work away.
const Q_LOAD_MS = 30000;
const Q_FILM_MS = 20000;

const Q_DEFAULT_FILTERS = {
  kind: 'all', q: '', top100: false,
  tier: '', gbMin: null, gbMax: null, yearMin: null, yearMax: null, minSamples: 0,
};
// Chosen from the data, not taste: the worst-scoring films are uniformly explained by low R
// (starved copies) and high banding. cxRSE/sampleNEff are ~60% null, top100 ~90%.
const Q_DEFAULT_COLS = ['cx', 'R', 'gb', 'cambi'];
const Q_DEFAULT_COLS_WIDE = ['bppPlus0', 'cx', 'R', 'srcMbps', 'gb', 'cambi', 'P', 'adqDelta', 'source'];

const qState = {
  meta: null,
  rows: [],
  filtered: [],
  byKey: new Map(),
  deep: new Map(),                        // ?key= detail, kept OUT of the list rows
  loadedAt: 0,
  seq: 0,
  loading: false,
  error: null,
  view: 'list',
  filmKey: null,
  listScrollY: 0,
  sort: 'bppPlus',
  dir: -1,
  cols: Q_DEFAULT_COLS.slice(),
  // False until the user actually picks columns. Until then the DEFAULT is chosen per screen —
  // a phone row fits four numbers, a desktop grid fits nine — but an explicit choice is honoured
  // everywhere, because it is one preference with two renderings, not two preferences.
  colsUserSet: false,
  colsVersion: 0,
  filters: { ...Q_DEFAULT_FILTERS },
};

// ---- formatters ──────────────────────────────────────────────────────────────────────────────
// Precision is a property of the COLUMN, not the value: a fixed dp per column is what makes
// right-aligned tabular figures decimal-align.
const qNul = (tip) => `<span class="nul"${tip ? ` title="${esc(tip)}"` : ''}>—</span>`;
const qFmt = {
  int: (v) => (v == null ? qNul() : String(Math.round(v))),
  n: (v, d) => (v == null ? qNul() : v.toFixed(d)),
  pct: (v, d) => (v == null ? qNul() : `${(v * 100).toFixed(d == null ? 1 : d)}%`),
  signed: (v, d) => (v == null ? qNul() : `${v > 0 ? '+' : ''}${v.toFixed(d == null ? 2 : d)}`),
  gb: (v) => (v == null ? qNul() : v.toFixed(1)),
  when: (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : qNul()),
};

// ---- the column catalogue ────────────────────────────────────────────────────────────────────
// `get` drives sorting and CSV, `fmt` returns HTML. `short` is the phone/grid header, `help` is
// real UI (the lab hid load-bearing numbers in title= attributes, invisible on touch).
const Q_GROUPS = [
  ['score', 'Score'], ['content', 'Content'], ['precision', 'Precision'],
  ['banding', 'Banding'], ['prov', 'Provenance'], ['file', 'File'],
];

const Q_COLS = [
  { id: 'bppPlus', label: 'BPP+', short: 'BPP+', group: 'score', num: true, w: 68, locked: true,
    help: 'The score. 100 means this file spends exactly as many bits as a visually transparent '
      + 'encode of itself costs. Square-rooted, so 200 is about half the visible error of 100.',
    get: (r) => r.bppPlus,
    fmt: (r) => (r.bppPlus == null ? qNul() : `<b class="q-${r.bppBand}">${r.bppPlus}</b>`) },

  { id: 'bppPlus0', label: 'BPP+₀', short: 'BPP+₀', group: 'score', num: true, w: 58,
    help: 'The score at P = 0 — bits against this film\'s own transparent cost, with neither the '
      + 'provenance nor the adequacy adjustment. Italic when there is no artifact reading, because '
      + 'it then coincides with BPP+ by construction rather than being missing.',
    get: (r) => r.bppPlus0,
    fmt: (r) => (r.bppPlus0 == null ? qNul()
      : (r.artState === 'none'
        ? `<i class="nul" title="no artifact reading — BPP+ and BPP+₀ coincide">${r.bppPlus0}</i>`
        : `<span class="q-${r.bppBand0}">${r.bppPlus0}</span>`)) },

  { id: 'bppPlusFlat', label: 'at flat 0.13', short: 'FLAT', group: 'score', num: true, w: 58,
    help: 'What this file scored before the per-film complexity probe — against one library-wide '
      + 'target of 0.13 instead of its own measured cost.',
    get: (r) => r.bppPlusFlat, fmt: (r) => qFmt.int(r.bppPlusFlat) },

  { id: 'adqDelta', label: 'Δ adequacy', short: 'ΔADQ', group: 'score', num: true, w: 62,
    help: 'Points the adequacy term moved this score. The only term that can move the library '
      + 'median: it asks whether the artifacts are actually below the visibility threshold.',
    get: (r) => r.adqDelta,
    fmt: (r) => (r.adqDelta == null ? qNul('no per-clip banding') : qFmt.signed(r.adqDelta, 1)) },

  { id: 'artDelta', label: 'Δ both terms', short: 'ΔBOTH', group: 'score', num: true, w: 62,
    help: 'BPP+ minus BPP+₀ — the provenance and adequacy terms combined.',
    get: (r) => r.artDelta, fmt: (r) => (r.artDelta == null ? qNul() : qFmt.signed(r.artDelta, 1)) },

  { id: 'P', label: 'provenance P', short: 'P', group: 'score', num: true, w: 58,
    help: 'How much more (or less) damaged this copy is than its bitrate and content predict. '
      + 'Zero-sum across the library, so it ranks files against each other and says nothing about '
      + 'whether the library as a whole is well provisioned.',
    get: (r) => r.P,
    fmt: (r) => (r.P == null ? qNul('no artifact reading') : qFmt.signed(r.P, 2)) },

  { id: 'artBits', label: 'effective bits', short: 'BITS×', group: 'score', num: true, w: 58,
    help: 'The multiplier provenance applies to the scoring denominator. Above 1 means this copy '
      + 'is treated as needing more bits than its content alone implies.',
    get: (r) => r.artifactFactor, fmt: (r) => qFmt.n(r.artifactFactor, 3) },

  // --- content
  { id: 'cx', label: 'complexity ×1000', short: 'CX', group: 'content', num: true, w: 54,
    help: 'The effective, post-correction complexity that scoring divides by — the bits a '
      + 'transparent encode of this film costs, ×1000. Compare against this, never the raw value.',
    get: (r) => r.cxEff, fmt: (r) => (r.cxMilli == null ? qNul('not measured') : String(r.cxMilli)) },

  { id: 'cxRaw', label: 'complexity, raw', short: 'CX RAW', group: 'content', num: true, w: 62,
    help: 'The unmodelled measurement, before the starved-copy correction. Only meaningful when '
      + 'studying the correction itself.',
    get: (r) => r.complexity, fmt: (r) => (r.complexity == null ? qNul() : String(Math.round(r.complexity * 1000))) },

  { id: 'pin', label: 'starved-copy pin', short: 'PIN', group: 'content', num: true, w: 54,
    help: 'The correction applied because a starved copy measures as an easy film and flatters '
      + 'itself. 1.000 means none was needed.',
    get: (r) => r.biasFactor, fmt: (r) => qFmt.n(r.biasFactor, 3) },

  { id: 'R', label: 'supply R', short: 'R', group: 'content', num: true, w: 54,
    help: 'Source bitrate over what a transparent encode costs, video-only and codec-normalised. '
      + 'Below ~0.4 the file is a starved copy; the worst-scoring films in this library sit at '
      + '0.19–0.35.',
    get: (r) => r.R, fmt: (r) => qFmt.n(r.R, 2) },

  { id: 'srcMbps', label: 'source Mb/s', short: 'SRC', group: 'content', num: true, w: 62,
    help: 'Video bitrate of the file on disk.',
    get: (r) => r.srcMbps, fmt: (r) => qFmt.n(r.srcMbps, 1) },

  { id: 'adqC', label: 'elbow c', short: 'ELBOW', group: 'content', num: true, w: 58,
    help: 'Which side of the visibility elbow this film sits on, saturating at ±1. Positive means '
      + 'its artifacts read as below the threshold.',
    get: (r) => r.adequacyC, fmt: (r) => qFmt.n(r.adequacyC, 2) },

  // --- precision
  { id: 'sampleN', label: 'clips sampled', short: 'N', group: 'precision', num: true, w: 46,
    help: '≥8 does NOT mean unmeasured. Every unit was sampled at least 8 times; units measured '
      + 'before per-sample records shipped kept only the mean and the spread.',
    get: (r) => r.sampleN,
    fmt: (r) => (r.sampleState === 'detailed' ? String(r.sampleN)
      : '<span class="nul" title="sampled at least 8 times; the individual readings were not retained">≥8</span>') },

  { id: 'cxRSE', label: 'score error', short: 'RSE', group: 'precision', num: true, w: 54,
    help: 'Relative error of the SCORE (half the complexity error, because the index takes a '
      + 'square root). Past 10% the badge carries a * and should be treated as a hint.',
    get: (r) => r.bppRSE,
    fmt: (r) => (r.bppRSE == null ? qNul('no per-sample record')
      : `<span class="${r.bppRSE > BPP_RSE_LOOSE ? 'over' : ''}">${(r.bppRSE * 100).toFixed(1)}%</span>`) },

  { id: 'spread', label: 'sample spread', short: 'SPRD', group: 'precision', num: true, w: 54,
    help: 'Max ÷ min across this unit\'s clip readings — how much the film varies internally.',
    get: (r) => r.spreadRatio, fmt: (r) => qFmt.n(r.spreadRatio, 1) },

  { id: 'disagree', label: 'episode disagreement', short: 'DISAG', group: 'precision', num: true, w: 58,
    help: 'For a season, how much its episodes disagree about complexity.',
    get: (r) => r.disagree, fmt: (r) => qFmt.n(r.disagree, 3) },

  { id: 'pairs', label: 'upgrade pairs', short: 'PAIRS', group: 'precision', num: true, w: 54,
    help: 'Banked before/after measurements of this unit from a re-download or a swap. These are '
      + 'what the starved-copy correction was fitted from.',
    get: (r) => r.pairs, fmt: (r) => (r.pairs ? String(r.pairs) : '') },

  // --- banding
  { id: 'cambi', label: 'banding', short: 'BAND', group: 'banding', num: true, w: 62,
    help: 'CAMBI banding, as a percentage of the visibility threshold. Over 100% means the mean '
      + 'reading is above the level at which banding becomes visible. A dash means NOT MEASURED, '
      + 'which is not the same as clean.',
    get: (r) => (r.cambi == null ? -1 : r.cambi),
    fmt: (r) => (r.cambiPct == null ? qNul('banding not measured yet — this is not "clean"')
      : (r.cambiOver ? `<span class="over">${r.cambiPct}%</span>` : `${r.cambiPct}%`)) },

  { id: 'cambiMax', label: 'banding, worst clip', short: 'BAND MAX', group: 'banding', num: true, w: 74,
    help: 'The worst clip, not the average one. A film whose mean reads clean while one clip is '
      + 'over the threshold has a banded scene the mean averaged away.',
    get: (r) => r.cambiMax,
    fmt: (r) => (r.cambiMax == null ? qNul('no per-clip record')
      : `<span class="${r.cambiHidden ? 'over' : ''}"${r.cambiHidden ? ' title="the mean reads clean but one clip is over the threshold — a banded scene averaged away"' : ''}>${qFmt.n(r.cambiMax, 2)}</span>`) },

  { id: 'cambiLuma', label: 'average luma', short: 'LUMA', group: 'banding', num: true, w: 54,
    help: 'Mean brightness of the sampled clips. Banding is easier to see on smooth bright '
      + 'gradients, so this is context for the reading above.',
    get: (r) => r.cambiLuma, fmt: (r) => qFmt.int(r.cambiLuma) },

  // --- provenance
  { id: 'artState', label: 'artifact reading', short: 'ART', group: 'prov', w: 74,
    help: 'Whether the provenance measurement describes the file currently on disk. "stale" means '
      + 'the file changed since it was measured, so the score carries no adjustment.',
    get: (r) => r.artState,
    fmt: (r) => (r.artState === 'measured' ? ''
      : `<span class="over" title="${r.artState === 'stale' ? 'the file changed since the artifacts were measured' : 'not measured yet'}">${r.artState}</span>`) },

  // --- file
  { id: 'gb', label: 'size GB', short: 'GB', group: 'file', num: true, w: 56,
    help: 'Size on disk. For a season, the whole season.',
    get: (r) => r.gb, fmt: (r) => qFmt.gb(r.gb) },

  { id: 'plusPerGb', label: 'BPP+ per GB', short: '+/GB', group: 'file', num: true, w: 58,
    help: 'Score per gigabyte — how efficiently this file buys its picture.',
    get: (r) => r.plusPerGb, fmt: (r) => qFmt.n(r.plusPerGb, 1) },

  { id: 'source', label: 'source tier', short: 'TIER', group: 'file', w: 92,
    help: 'What the file was ripped from. BPP+ is blind to this by design — a tier is a ceiling '
      + 'bits cannot raise.',
    get: (r) => r.tier || '',
    fmt: (r) => (r.tier ? `<span class="src-${srcTierCls(r.source) || 'mid'}">${esc(r.tier)}</span>` : qNul()) },

  { id: 'codec', label: 'codec', short: 'CODEC', group: 'file', w: 82,
    help: 'Video format and bit depth. HEVC 10-bit is the one thing on this box that forces a '
      + 'software transcode.',
    get: (r) => r.videoLabel || '',
    fmt: (r) => (r.videoLabel ? `<span class="${r.gpuCompat === 'bad' ? 'over' : ''}">${esc(r.videoLabel)}</span>` : qNul()) },

  { id: 'year', label: 'year', short: 'YEAR', group: 'file', num: true, w: 50,
    help: 'Release year.', get: (r) => r.year, fmt: (r) => (r.year == null ? qNul() : String(r.year)) },

  { id: 'audioShare', label: 'audio share', short: 'AUD%', group: 'file', num: true, w: 58,
    help: 'Fraction of the container spent on audio. Never charged to video — a lossless remux '
      + 'and a stereo rip of the same film share a complexity and nothing about their audio.',
    get: (r) => r.audioShare, fmt: (r) => qFmt.pct(r.audioShare, 1) },

  { id: 'runtime', label: 'runtime', short: 'RUN', group: 'file', num: true, w: 58,
    help: 'Runtime of the measured file. For a season, its first sampled episode.',
    get: (r) => r.duration,
    fmt: (r) => (r.duration ? `${Math.floor(r.duration / 3600)}h${String(Math.round((r.duration % 3600) / 60)).padStart(2, '0')}` : qNul()) },

  { id: 'top100', label: 'Top 100 rank', short: '★', group: 'file', num: true, w: 46,
    help: 'ELo rank within the Top 100 playlist. TV seasons are never in it.',
    get: (r) => r.top100, fmt: (r) => (r.top100 ? `<span class="q-rank">★${r.top100}</span>` : '') },
];

// Sort-only: the title is always on screen, so it is never a column, but it must be a sort key —
// and it needs a real entry or qCol() would fall through to BPP+ and sort by the wrong thing.
Q_COLS.push({
  id: 'title', label: 'title', short: 'TITLE', group: 'file', sortOnly: true, w: 0,
  help: 'Alphabetical by title.',
  get: (r) => r.name, fmt: (r) => esc(r.name),
});

const qCol = (id) => Q_COLS.find((c) => c.id === id) || Q_COLS[0];
// The columns a user may actually choose to display.
const qPickable = () => Q_COLS.filter((c) => !c.sortOnly && !c.locked);

// ---- decoration ──────────────────────────────────────────────────────────────────────────────
// Rows are immutable after this. ?key= detail goes into qState.deep, never merged back in, or the
// markup cache would go stale behind its own key.
function qDecorate(r, threshold) {
  const gb = r.bytes > 0 ? r.bytes / 1e9 : null;
  const season = /^tv:\d+:(\d+)$/.exec(r.key);
  const t = threshold > 0 ? threshold : null;
  return {
    ...r,
    // The bare title: the year and the season marker are their own columns/flags.
    name: String(r.title || '').replace(/\s*\(\d{4}\)\s*$/, '').replace(/\s+S\d{1,3}$/, ''),
    season: season ? +season[1] : null,
    needle: String(r.title || '').toLowerCase(),
    tier: String(r.source || '').replace(/-?(2160|1080|720|576|480)p/i, '').replace(/[-\s]+$/, ''),
    gb,
    plusPerGb: (r.bppPlus != null && gb > 0) ? r.bppPlus / gb : null,
    srcMbps: r.srcBitrate > 0 ? r.srcBitrate / 1e6 : null,
    audioShare: (r.audioBps > 0 && r.srcBitrate > 0) ? r.audioBps / r.srcBitrate : null,
    cxMilli: r.cxEff > 0 ? Math.round(r.cxEff * 1000) : null,
    // null is "not measured"; 0 is a real, measured, clean reading — exactly one row in the
    // library today, and rendering it as a dash would say the opposite of the truth.
    cambiPct: (r.cambi == null || !t) ? null : Math.round((r.cambi / t) * 100),
    cambiOver: r.cambi != null && t ? r.cambi >= t : false,
    cambiHidden: (r.cambi != null && r.cambiMax != null && t) ? (r.cambi < t && r.cambiMax >= t) : false,
    sampleState: r.sampleNEff != null || r.cxRSE != null ? 'detailed' : 'meanOnly',
    artState: r.P == null ? 'none' : (r.artifactStale ? 'stale' : 'measured'),
    adqDelta: r.adequacyDelta,
    // A season's runtime is ONE episode's (the first sampled), so the season total is derived.
    epRuntime: r.kind === 'season' ? r.duration : null,
    totalRuntime: r.kind === 'season' && r.episodes ? r.duration * r.episodes : r.duration,
    res: r.resW && r.resH ? `${r.resW}×${r.resH}` : null,
    resBadge: r.resH ? (r.resH >= 1000 ? '1080p' : (r.resH >= 700 ? '720p' : `${r.resH}p`)) : null,
    artDelta: (r.bppPlus != null && r.bppPlus0 != null) ? r.bppPlus - r.bppPlus0 : null,
    // Split, not combined: provenance is zero-sum, adequacy can move the median.
    provDelta: (r.bppPlus != null && r.bppPlus0 != null)
      ? r.bppPlus - r.bppPlus0 - (r.adequacyDelta || 0) : null,
  };
}

// ---- load ────────────────────────────────────────────────────────────────────────────────────
async function qLoad(force) {
  if (!force && qState.rows.length && Date.now() - qState.loadedAt < Q_TTL_MS) return true;
  const seq = ++qState.seq;
  qState.loading = true;
  qState.error = null;
  try {
    const data = await getJSON('/api/probe/dataset?view=list', Q_LOAD_MS);
    if (seq !== qState.seq) return false;                 // a newer request superseded this one
    const t = data.bandingThreshold;
    qState.meta = data;
    qState.rows = (data.rows || []).map((r) => qDecorate(r, t));
    qState.byKey = new Map(qState.rows.map((r) => [r.key, r]));
    qState.loadedAt = Date.now();
    qState.loading = false;
    qApplyFilters();
    return true;
  } catch (e) {
    if (seq !== qState.seq) return false;
    qState.loading = false;
    // A 30s abort here means the server was rebuilding its 1h unit cache, not that it is down.
    qState.error = /abort/i.test(e.message || '')
      ? 'The server is rebuilding its library index — this takes a few seconds on the first open.'
      : 'Could not load the quality data.';
    return false;
  }
}

// One full row for the film page. Cached in qState.deep so revisiting is free.
async function qLoadFilm(key) {
  if (qState.deep.has(key)) return qState.deep.get(key);
  const data = await getJSON(`/api/probe/dataset?key=${encodeURIComponent(key)}`, Q_FILM_MS);
  const row = (data.rows || [])[0];
  if (!row) throw new Error('no measurement');
  const deep = qDecorate(row, data.bandingThreshold);
  qState.deep.set(key, deep);
  return deep;
}

// ---- filter + sort ───────────────────────────────────────────────────────────────────────────
// Everything currently narrowing the list, chips included.
function qActiveFilters() {
  const f = qState.filters;
  const out = [];
  if (f.top100) out.push({ id: 'top100', label: 'Top 100' });
  if (f.tier) out.push({ id: 'tier', label: f.tier });
  if (f.gbMin != null || f.gbMax != null) {
    out.push({ id: 'gb', label: `${f.gbMin != null ? f.gbMin : '0'}–${f.gbMax != null ? f.gbMax : '∞'} GB` });
  }
  if (f.yearMin != null || f.yearMax != null) {
    out.push({ id: 'year', label: `${f.yearMin != null ? f.yearMin : '…'}–${f.yearMax != null ? f.yearMax : '…'}` });
  }
  if (f.minSamples > 0) out.push({ id: 'minSamples', label: `≥${f.minSamples} clips` });
  return out;
}
// Only the ones that live inside the sheet — the badge's job is "there are filters you cannot see".
const qHiddenFilterCount = () => qActiveFilters().filter((a) => a.id !== 'top100').length;

function qApplyFilters() {
  const f = qState.filters;
  qSaveFilters();
  const q = f.q.trim().toLowerCase();
  qState.filtered = qState.rows.filter((r) => {
    if (f.kind === 'movie' && r.kind !== 'movie') return false;
    if (f.kind === 'tv' && r.kind !== 'season') return false;
    if (f.top100 && !r.top100) return false;
    if (f.tier && r.tier !== f.tier) return false;
    if (f.gbMin != null && !(r.gb >= f.gbMin)) return false;
    if (f.gbMax != null && !(r.gb <= f.gbMax)) return false;
    if (f.yearMin != null && !(r.year >= f.yearMin)) return false;
    if (f.yearMax != null && !(r.year <= f.yearMax)) return false;
    if (f.minSamples > 0 && !(r.sampleN >= f.minSamples)) return false;
    if (q && !r.needle.includes(q)) return false;
    return true;
  });
  qSort();
}

function qSort() {
  const c = qCol(qState.sort);
  const dir = qState.dir;
  qState.filtered.sort((a, b) => {
    const av = c.get(a); const bv = c.get(b);
    // Nulls last whichever way it is sorted — a missing value is not a small one.
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return dir * av.localeCompare(bv);
    return dir * (av - bv);
  });
}

// The tier list for the Filters sheet, with live counts, commonest first.
function qTierOptions() {
  const n = new Map();
  for (const r of qState.rows) if (r.tier) n.set(r.tier, (n.get(r.tier) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]);
}

// ---- persistence ─────────────────────────────────────────────────────────────────────────────
// Always merged over defaults, never used whole: a stored blob from an older column set must not
// resurrect a column that no longer exists.
function qLoadPrefs() {
  try {
    const cols = JSON.parse(localStorage.getItem(Q_LS.cols) || 'null');
    if (Array.isArray(cols)) {
      const keep = cols.filter((id) => Q_COLS.some((c) => c.id === id && !c.locked && !c.sortOnly));
      if (keep.length) { qState.cols = keep; qState.colsUserSet = true; }
    }
  } catch { /* ignore */ }
  try {
    const s = JSON.parse(localStorage.getItem(Q_LS.sort) || 'null');
    if (s && Q_COLS.some((c) => c.id === s.sort)) { qState.sort = s.sort; qState.dir = s.dir === 1 ? 1 : -1; }
  } catch { /* ignore */ }
  try {
    const f = JSON.parse(localStorage.getItem(Q_LS.filters) || 'null');
    if (f && typeof f === 'object') {
      // Keys are pruned to the current set, not merged wholesale: three filters were removed and a
      // blind merge kept them in the stored blob (and in the counts) indefinitely.
      const keep = {};
      for (const k of Object.keys(Q_DEFAULT_FILTERS)) if (k in f) keep[k] = f[k];
      qState.filters = { ...Q_DEFAULT_FILTERS, ...keep, q: '' };
    }
  } catch { /* ignore */ }
}
const qSaveCols = () => { qState.colsVersion++; qState.colsUserSet = true; try { localStorage.setItem(Q_LS.cols, JSON.stringify(qState.cols)); } catch { /* ignore */ } };
const qSaveSort = () => { try { localStorage.setItem(Q_LS.sort, JSON.stringify({ sort: qState.sort, dir: qState.dir })); } catch { /* ignore */ } };
// `q` is deliberately not persisted — a search term surviving a reload reads as a broken library.
const qSaveFilters = () => { try { localStorage.setItem(Q_LS.filters, JSON.stringify({ ...qState.filters, q: '' })); } catch { /* ignore */ } };

function qResetFilters() {
  qState.filters = { ...Q_DEFAULT_FILTERS };
  qApplyFilters();
}

// ---- CSV ─────────────────────────────────────────────────────────────────────────────────────
// Every column, not just the visible ones — an export that dropped what you had hidden would be a
// surprise the next time you opened the file.
function qCsv() {
  const cols = Q_COLS;
  const cell = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['key', 'title', ...cols.map((c) => c.id)].join(',');
  const body = qState.filtered
    .map((r) => [cell(r.key), cell(r.title), ...cols.map((c) => cell(c.get(r)))].join(','))
    .join('\n');
  return `${head}\n${body}\n`;
}

qLoadPrefs();
