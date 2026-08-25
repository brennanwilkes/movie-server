// Data loading and the shared model. Everything the lab draws comes from /api/probe/dataset, the
// read-only per-unit measurement table added to controller/lib/probe.js for exactly this purpose.
//
// WHY NOT READ probe-cache.json DIRECTLY: the cache holds the raw measurement but not the DERIVED
// numbers — the bias factor, the effective target, the score — because those live in code. A lab
// that re-implemented them would drift from the controller silently, and then every finding here
// would be about the lab rather than about the library.

export const BANDS = [
  { key: 'wow', lo: 125, label: '>= 125 wow', css: 'band-wow', color: '#b18cf0' },
  { key: 'ok', lo: 100, label: '100-124 ok', css: 'band-ok', color: '#4ec98a' },
  { key: 'warn', lo: 75, label: '75-99 warn', css: 'band-warn', color: '#e8a33d' },
  { key: 'bad', lo: 0, label: '< 75 bad', css: 'band-bad', color: '#e0575b' },
];
export const bandOf = (plus) => (plus == null ? null : BANDS.find((b) => plus >= b.lo).key);
export const bandColor = (plus) => {
  const k = bandOf(plus);
  return k ? BANDS.find((b) => b.key === k).color : '#8b97a8';
};

// The source tiers from release-rules.js, mirrored so rows can be grouped by master quality. Kept
// as data rather than re-parsing quality names: BPP+ is deliberately blind to tier (it is a
// CEILING bits cannot raise), so any view that mixes them must say which it is showing.
// Each tier carries `key` (what the filter stores), `label`, a numeric `rank` for coarse ordering,
// and the `re` that maps a raw source string onto it. Blu-ray and Web-DL share rank 4 (the
// Disc/WEB-DL family) but keep separate keys so the filter can tell them apart.
export const TIERS = [
  { key: 'remux', label: 'Remux', rank: 5, re: /remux/i },
  { key: 'bluray', label: 'Blu-ray', rank: 4, re: /bluray|blu-?ray|brrip|bdrip/i },
  { key: 'webdl', label: 'Web-DL', rank: 4, re: /web-?dl/i },
  { key: 'webrip', label: 'WEBRip', rank: 3, re: /webrip/i },
  { key: 'hdtv', label: 'HDTV', rank: 2, re: /hdtv/i },
  { key: 'dvd', label: 'DVD', rank: 1, re: /dvd/i },
  { key: 'sdcam', label: 'SD/CAM', rank: 0, re: /sdtv|\bcam\b|telesync/i },
];
export const tierOf = (s) => {
  for (const t of TIERS) if (t.re.test(s || '')) return t;
  return null;
};
// The tier filter's choices: the individual tiers PLUS a combined Disc/WEB-DL that matches either
// Blu-ray or Web-DL (the coarse rank-4 family), so the dropdown can ask both questions.
export const TIER_OPTIONS = [
  { key: '', label: 'any' },
  { key: 'remux', label: 'Remux' },
  { key: 'bluray', label: 'Blu-ray' },
  { key: 'webdl', label: 'Web-DL' },
  { key: 'disc', label: 'Disc/WEB-DL' },
  { key: 'webrip', label: 'WEBRip' },
  { key: 'hdtv', label: 'HDTV' },
  { key: 'dvd', label: 'DVD' },
  { key: 'sdcam', label: 'SD/CAM' },
];
export const tierMatches = (r, key) => {
  if (!key) return true;
  if (key === 'disc') return r.tier === 'bluray' || r.tier === 'webdl';
  return r.tier === key;
};

// Matches BANDING_HIGH in controller/lib/banding.js — p75 of the 40-film library sample. Fixed
// rather than recomputed from whatever rows happen to be loaded, so the lab and the server always
// draw the same line.
export const BANDING_HIGH = 2.817;
export const bandingColor = (r) => (r.bandingState === 'bands' ? '#e0575b'
  : r.bandingState === 'clean' ? '#4ec98a' : '#8b97a8');

export const state = {
  meta: null,
  rows: [],
  filtered: [],
  filters: {
    kind: 'movie', minSamples: 0, q: '', measuredOnly: true,
    top100: false, tier: '', sizeMin: null, sizeMax: null, yearMin: null, yearMax: null,
  },
};

export async function load() {
  const res = await fetch('/api/probe/dataset');
  if (!res.ok) throw new Error(`/api/probe/dataset -> ${res.status} ${res.statusText}`);
  const json = await res.json();
  state.meta = {
    generated: json.generated, crf: json.crf,
    headroomTarget: json.headroomTarget, headroomLive: json.headroomLive,
    flatFallback: json.flatFallback, biasFit: json.biasFit, n: json.n,
  };
  state.rows = json.rows.map(decorate);
  applyFilters();
  return state;
}

function decorate(r) {
  const t = tierOf(r.source);
  const gb = r.bytes ? r.bytes / 1e9 : null;
  return {
    ...r,
    tier: t ? t.key : null,
    rank: t ? t.rank : null,
    rankName: t ? t.label : 'unknown',
    gb,
    // BPP+ per GB. A DISK metric, never a quality one: long runtimes and grainy negatives sit at
    // the bottom by construction, which is correct and not a defect.
    plusPerGb: (r.bppPlus != null && gb > 0) ? r.bppPlus / gb : null,
    band: bandOf(r.bppPlus),
    srcMbps: r.srcBitrate ? r.srcBitrate / 1e6 : null,
    probeMbps: r.probeBitrate ? r.probeBitrate / 1e6 : null,
    audioShare: (r.audioBps && r.srcBitrate) ? r.audioBps / r.srcBitrate : null,
    // EVERY MEASURED UNIT WAS SAMPLED AT LEAST 8 TIMES — PROBE_SAMPLES is the floor, and a unit
    // with a wide spread gets 16. What varies is whether the individual readings were KEPT: per-
    // sample records only began on 2026-08-14, so older entries retain the mean alone. Printing an
    // em-dash for those reads as "this film was never sampled", which is wrong and alarming. The
    // surviving proof is `spreadRatio` — max/min of the samples — which cannot exist without them.
    sampleState: Array.isArray(r.sampleCx) && r.sampleCx.length ? 'detailed'
      : (r.spreadRatio > 0 || r.complexity > 0) ? 'meanOnly' : 'none',
    // THE SECOND AXIS. null means NOT MEASURED, which is emphatically not "clean" — the banding
    // probe is backfilling ~1000 units and most rows have no reading yet. Anything that renders this
    // must distinguish the two, or the lab will assert every unmeasured film is banding-free.
    bandingState: r.cambi == null ? 'none' : (r.bands ? 'bands' : 'clean'),
    // The correction's own size, expressed where it is felt: on the score, not the denominator.
    // BPP+ goes as 1/sqrt(target), so a x1.56 factor is a x0.80 on the index.
    biasOnScore: r.biasFactor ? 1 / Math.sqrt(r.biasFactor) : null,
    pairs: (r.priors || []).length,
  };
}

export function applyFilters() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  state.filtered = state.rows.filter((r) => {
    if (f.kind !== 'all' && r.kind !== f.kind) return false;
    if (f.minSamples && (r.sampleN || 0) < f.minSamples) return false;
    if (f.measuredOnly && !(r.cxEff > 0)) return false;
    if (f.top100 && r.top100 == null) return false;
    if (!tierMatches(r, f.tier)) return false;
    if (f.sizeMin != null && (r.gb == null || r.gb < f.sizeMin)) return false;
    if (f.sizeMax != null && (r.gb == null || r.gb > f.sizeMax)) return false;
    if (f.yearMin != null && (r.year == null || r.year < f.yearMin)) return false;
    if (f.yearMax != null && (r.year == null || r.year > f.yearMax)) return false;
    if (q && !r.title.toLowerCase().includes(q)) return false;
    return true;
  });
  return state.filtered;
}

// ---- the model, re-implemented ONCE and only for what-if -------------------------------------
// The controller is the authority on the live score; this recomputes it so a slider can ask "what
// would the library look like at a different exponent or headroom". Any view showing a what-if
// MUST also show the live number beside it, or the lab becomes a way to fool yourself.
export function score(bpp, target, { exponent = 0.5, headroom = 1 } = {}) {
  if (!(bpp > 0) || !(target > 0)) return null;
  return Math.round(100 * ((bpp / (target * headroom)) ** exponent));
}

// What to print in a "samples" cell. Never an em-dash for a measured unit.
export const samplesLabel = (r) => (r.sampleState === 'detailed' ? String(r.sampleN) : '≥8');
export const samplesTitle = (r) => (r.sampleState === 'detailed'
  ? `${r.sampleN} readings retained`
  : 'sampled at least 8 times; individual readings not retained (measured before 2026-08-14)');

export const fmt = {
  n: (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d)),
  int: (v) => (v == null || !Number.isFinite(v) ? '—' : String(Math.round(v))),
  pct: (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(d)}%`),
  gb: (v) => (v == null ? '—' : `${v.toFixed(1)} GB`),
  mbps: (v) => (v == null ? '—' : `${v.toFixed(1)} Mb/s`),
  when: (ms) => (ms ? new Date(ms).toLocaleString() : '—'),
};
