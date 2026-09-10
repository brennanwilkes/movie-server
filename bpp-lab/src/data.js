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

// ---- THE ARTIFACT TERM ------------------------------------------------------------------------
// The provenance factor P and the score adjustment it drives. This used to live inside the Blend
// tab, which meant every OTHER view was blind to it and the one view that could see it had to
// re-fetch provenance.json mid-render and re-invoke itself when the fetch landed. Both problems go
// away by loading it with the dataset and decorating the rows once: P is now just another column,
// so it can be an axis, a colour, a filter or a table cell anywhere without special-casing.
//
// The four detectors, their VISIBILITY THRESHOLDS (derived from CVQAD, task 68 — not chosen), and
// which direction is worse. Grain is the odd one: it measures CONTENT, not damage, so it is kept
// as a RETENTION ratio and LOW is bad.
export const ARTIFACTS = [
  { key: 'cambi', label: 'banding', T: BANDING_HIGH, worseIsHigh: true },
  { key: 'block', label: 'blocking', T: 3.710, worseIsHigh: true },
  { key: 'blur', label: 'blur', T: 8.026, worseIsHigh: true },
  { key: 'grain', label: 'grain kept', T: 0.905, worseIsHigh: false },
];

// *** STRENGTH IS A CONSTANT, NOT A DIAL. Brennan decided it on 2026-08-29: 100%. ***
// It was a slider for as long as it was undecided — it is the exchange rate between "how much
// provenance evidence we have" and "how much the score should move", which is a preference and was
// never going to be measured. Shipping it as a dial invites someone to tune it; shipping it as a
// constant does not. THERE ARE NOW NO FREE PARAMETERS IN BPP+.
export const STRENGTH = 1.0;
// provShare, MEASURED 2026-08-28: adjusted R2 of P on the bitstream encoder fingerprint, 803 films,
// p=0.0025 against a 400-shuffle null, year-controlled. A LOWER bound. Overridden at load time by
// whatever provenance.json carries, so the export script stays the single source of truth.
export const PROV_SHARE_FALLBACK = 0.1089;
export const ANCHOR_PCT = 35.6;
export const DPDGEN_FALLBACK = 0.2;

// FILTERS SURVIVE A RELOAD. Narrowing to "Bluray-1080p, 6-12 GB, 1970-1989" is several deliberate
// actions, and losing it to a refresh — or to the Film tab's reset of kind/q — meant redoing that
// work every time. sessionStorage, not localStorage: scoped to the tab, so a second window can hold
// a different view of the library without the two fighting over one key.
//
// MERGED OVER THE DEFAULTS, never used as the whole object. A stored blob from an older build would
// otherwise omit any filter added since and leave it `undefined`, which reads as neither set nor
// unset and silently changes what applyFilters() does.
const FILTER_KEY = 'bpp-lab.filters';
export const DEFAULT_FILTERS = {
  kind: 'movie', minSamples: 0, q: '', measuredOnly: true,
  top100: false, tier: '', sizeMin: null, sizeMax: null, yearMin: null, yearMax: null,
};
function storedFilters() {
  try {
    const raw = sessionStorage.getItem(FILTER_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch { return {}; }        // corrupt or unavailable storage must never block the app booting
}
export function saveFilters() {
  try { sessionStorage.setItem(FILTER_KEY, JSON.stringify(state.filters)); } catch { /* private mode */ }
}

export const state = {
  meta: null,
  prov: null,        // the whole provenance.json header (reliability, anchor, shrink, dPdGen)
  rows: [],
  filtered: [],
  filters: { ...DEFAULT_FILTERS, ...storedFilters() },
};

export async function load() {
  // Both in flight at once. provenance.json is OPTIONAL: it is generated offline by
  // scripts/export-provenance.js, so a lab checkout without it must still work — every view falls
  // back to artState 'none' and shows the unadjusted score rather than erroring.
  const [res, provRes] = await Promise.all([
    fetch('/api/probe/dataset'),
    fetch('provenance.json').catch(() => null),
  ]);
  if (!res.ok) throw new Error(`/api/probe/dataset -> ${res.status} ${res.statusText}`);
  const json = await res.json();
  state.prov = (provRes && provRes.ok) ? await provRes.json().catch(() => null) : null;
  state.meta = {
    generated: json.generated, crf: json.crf,
    headroomTarget: json.headroomTarget, headroomLive: json.headroomLive,
    flatFallback: json.flatFallback, biasFit: json.biasFit, n: json.n,
    provGenerated: state.prov ? state.prov.generated : null,
    reliability: state.prov ? state.prov.reliability : null,
  };
  state.rows = json.rows.map(decorate);
  applyFilters();
  return state;
}

// lambda = ln(1 + anchor) / dPdGen. NOT a free constant: 6.2 of BPP-PLUS.txt shows the anchor was
// itself derived from dPdGen, so the generation step cancels and lambda = 1/|dP/dlog bpp|. Anyone
// "improving" dPdGen alone moves lambda by arithmetic accident rather than by a finding.
export function lambdaOf(prov) {
  const d = (prov && prov.dPdGen > 0) ? prov.dPdGen : DPDGEN_FALLBACK;
  return Math.log(1 + ANCHOR_PCT / 100) / d;
}
export const provShareOf = (prov) => ((prov && prov.shrink && prov.shrink.floor > 0)
  ? prov.shrink.floor : PROV_SHARE_FALLBACK);

// *** THE LAB DOES NOT COMPUTE THE ADJUSTMENT. THE CONTROLLER DOES. ***
//
// It used to. Until 2026-08-29 the artifact term was lab-only, so this file applied it to the
// controller's unadjusted bppPlus. The controller now applies it itself and `bppPlus` ARRIVES
// ADJUSTED — so continuing to multiply here would DOUBLE-COUNT it. The dataset therefore carries
// `bppPlus0` (the score at P=0), `P`, `artifactFactor` and `artifactStale`, and artCols() below
// just reads them.
//
// This is the rule the whole /api/probe/dataset endpoint exists for: a lab that re-implements a
// derived number drifts from the controller silently, and then every finding is about the lab
// rather than about the library. The one deliberate exception is score() below, which is a what-if
// and is always shown beside the live number.

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
    ...artCols(r),
  };
}

// The artifact term flattened onto the row, so every view can treat P exactly like any other
// column. artState is the honest three-way: 'measured' | 'stale' | 'none'. NEVER collapse 'none'
// into "clean" — the same mistake bandingState exists to prevent.
function artCols(r) {
  // The per-detector detail (z scores, raw levels) still comes from provenance.json — the dataset
  // carries only the composite P. THE SCORE, THOUGH, IS THE SERVER'S, and is never recomputed here.
  const u = state.prov && state.prov.units ? state.prov.units[r.key] : null;
  const P = r.P != null ? r.P : (u ? u.P : null);
  if (P == null || r.bppPlus == null) {
    // Unmeasured units report BPP+ and BPP+0 as the SAME number, which is not a placeholder — with
    // no provenance evidence the score IS the P=0 score, by construction.
    // cambiAny/cambiSrc MUST be set on this path too. A unit with no P can still have a banding
    // reading (the nightly job and the artifact backfill are independent), and leaving them
    // undefined here silently drops those units off the banding axis — the exact bug this pair of
    // fields was added to fix, reintroduced through the early return.
    return { artState: 'none', P: null, bppPlus0: r.bppPlus,
      artDelta: null, artBits: null, drives: null, drivesZ: null,
      cambiAny: r.cambi != null ? r.cambi : (u && u.cambi != null ? u.cambi : null),
      cambiSrc: r.cambi != null ? 'nightly' : (u && u.cambi != null ? 'artifact' : null) };
  }
  // Staleness is the SERVER's judgement when it has one — it knows the file identity (path|size|
  // mtime), which provenance.json does not. The bpp comparison below is only a fallback for a lab
  // running against a controller too old to report it.
  const stale = r.artifactStale != null ? r.artifactStale
    : !!(u && u.bpp > 0 && r.bpp > 0 && Math.abs(Math.log(r.bpp / u.bpp)) > 0.02);
  const z = (u && u.z) ? u.z : {};
  // WHICH detector dominates: the largest signed residual, sign flipped for grain so "worse" is
  // always positive. A LABEL for colouring and tooltips only — never an input to the score, which
  // always uses all four. Picking a winner would be the cut-off this project keeps removing.
  let drives = null; let best = 0;
  for (const a of ARTIFACTS) {
    const v = z[a.key] != null ? z[a.key] * (a.worseIsHigh ? 1 : -1) : null;
    if (v != null && Math.abs(v) > Math.abs(best)) { best = v; drives = a.label; }
  }
  const base = r.bppPlus0 != null ? r.bppPlus0 : r.bppPlus;
  return {
    artState: stale ? 'stale' : 'measured',
    P,
    bppPlus0: base,
    // THE SCORE NOW CARRIES TWO SEPARATE ADJUSTMENTS and they must be attributed separately:
    //   provenance  P, zero-sum, cannot move the library median
    //   adequacy    the elbow pool, NOT centred, CAN move the median
    // artDelta used to be the whole gap BPP+ - BPP+0, which silently became "both terms" the day
    // adequacy shipped. The server now sends the adequacy shift on its own, so provenance is the
    // remainder rather than a guess.
    adqDelta: r.adequacyDelta != null ? r.adequacyDelta : null,
    adqC: r.adequacyC != null ? r.adequacyC : null,
    // Where the adequacy term is pulling this film: 100 on the clean side, 100*exp(kappa*c) on the
    // dirty side. Computed by the CONTROLLER — kappa is a model constant and the lab holds no copy.
    adqTarget: r.adequacyTarget != null ? r.adequacyTarget : null,
    adqClips: r.adequacyClips != null ? r.adequacyClips : null,
    provDelta: r.adequacyDelta != null ? (r.bppPlus - base - r.adequacyDelta) : (r.bppPlus - base),
    artDelta: r.bppPlus - base,
    // The effective-bits multiplier. The server sends the factor it applied to the TARGET, and bits
    // move the opposite way from the target, hence the reciprocal.
    artBits: r.artifactFactor > 0 ? 1 / r.artifactFactor : null,
    zCambi: z.cambi ?? null,
    zBlock: z.block ?? null,
    zBlur: z.blur ?? null,
    zGrain: z.grain ?? null,
    artCambi: u ? u.cambi : null,
    /* *** TWO SEPARATE BANDING MEASUREMENTS EXIST, AND THE PAGE USED TO SHOW BOTH AS IF THEY WERE
     * ONE. *** `r.cambi` is the NIGHTLY BANDING JOB (banding-cache.json, 8 clips x 2s, 422 units).
     * `u.cambi` is the ARTIFACT BACKFILL (4 clips x 2s, all 1048 units). Same detector, same scale,
     * different sampling — and 626 units have the second but not the first.
     * 12 Angry Men is the case that exposed it: the headline said "banding (unmeasured)" while the
     * artifact panel below showed 0.016, and "Nearest by banding" refused to rank it. All three
     * were correct about different things, which is worse than one of them being wrong.
     * cambiAny is "the best banding reading we have", with cambiSrc naming which instrument. */
    cambiAny: r.cambi != null ? r.cambi : (u ? u.cambi : null),
    cambiSrc: r.cambi != null ? 'nightly' : (u && u.cambi != null ? 'artifact' : null),
    /* THE WORST CLIP, which a mean hides. The Empire Strikes Back reads mean 0.459 ("clean") from
     * clips [0, 3.47, 0.05, 0, 0, 0.13, 0, 0.02] — one banded scene averaged away. `bands` is the
     * server's own threshold verdict; cambiMax lets a reader see the spread behind the mean. */
    cambiMax: r.cambiMax != null ? r.cambiMax : null,
    cambiHidden: !!(r.cambiMax != null && r.cambi != null
      && r.cambi < BANDING_HIGH && r.cambiMax >= BANDING_HIGH),
    artBlock: u ? u.block : null,
    artBlur: u ? u.blur : null,
    artGrain: u ? u.grain : null,
    drives,
    drivesZ: best,
  };
}

export function applyFilters() {
  // Every filter change routes through here, so persisting from this one place cannot drift from
  // the state the views actually render.
  saveFilters();
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
