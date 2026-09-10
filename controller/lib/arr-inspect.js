'use strict';
// Read-only *arr inspection helpers: media-file GPU labelling (videoLabel/
// gpuTier for this NUC's Skylake Iris 540), disk headroom, item titles,
// activity checks, and the disk-only-rejection diagnoser used by requestGate.
// No owned state, no timers.

const fs = require('fs');
const { arrGet } = require('./clients');

// Video format labelling and GPU-compatibility tier.
function videoLabel(mi) {
  if (!mi) return '';
  const c = (mi.videoCodec || '').toLowerCase();
  let codec = '';
  if (c.includes('x265') || c.includes('hevc')) codec = 'HEVC';
  else if (c.includes('av1')) codec = 'AV1';
  else if (c.includes('x264') || c.includes('h264') || c.includes('avc')) codec = 'H.264';
  else if (c.includes('vp9')) codec = 'VP9';
  else codec = c.toUpperCase() || '';
  const d = mi.videoBitDepth ? mi.videoBitDepth + 'bit' : '';
  const dr = mi.videoDynamicRange || '';
  const drt = (mi.videoDynamicRangeType || '').toUpperCase();
  let hdr = '';
  if (drt.includes('DV')) hdr = 'DV';
  else if (drt.includes('HDR10')) hdr = 'HDR10+';
  else if (dr && dr !== 'SDR') hdr = dr;
  return [codec, d, hdr].filter(Boolean).join(' ');
}
function gpuTier(mi) {
  if (!mi) return '';
  const c = (mi.videoCodec || '').toLowerCase();
  const d = mi.videoBitDepth || 8;
  const dr = mi.videoDynamicRange || '';
  const drt = (mi.videoDynamicRangeType || '').toUpperCase();
  // Tuned for this NUC's i5-6260U (Skylake Iris 540):
  //   HW decode: H.264 8-bit, HEVC 8-bit only (10-bit is software).
  //   HW encode: H.264, H.265 8-bit only.
  //   VP9 decode, no AV1, no DoVi.
  if (c.includes('av1')) return 'bad';
  if (c.includes('vp9')) return 'bad';   // VP9 HW decode is not enabled in this Jellyfin config → CPU
  if (drt.includes('DV')) return 'bad';
  // 10-bit is 'bad', not 'warn'. It used to be amber here while devicesFor() in
  // web/js/audit.js painted the NUC pill RED for the same file, so one file read as two
  // different severities inside one app. Measured 2026-08-01 on a true 1920x1080 Main10
  // sample: software decode sustains 1.29x realtime while downloads run (2.1x idle), and
  // that single transcode took system load from 4.1 to 14.3. That is not a caution, it is
  // the failure mode. See docs/audit-2026-07-31/raw/playback-tests-2026-08-01.md.
  if (d >= 10) return 'bad';
  if (drt.includes('HDR') || dr === 'HDR') return 'warn';
  return 'ok';
}

// ---- BITS PER PIXEL PER FRAME ───────────────────────────────────────────────────────────────
// THE unit for "how good does this file look", and the single definition of it. Raw Mbps is not
// comparable between files here and the audit proved it three ways (2026-08-01):
//   * RESOLUTION — only 171 of 860 movies are a full 1920x1080. The rest are letterboxed to
//     heights from 528 to 1076, so a 1920x800 scope film spends the same Mbps on 26% fewer
//     pixels than a flat one and looks correspondingly better.
//   * FRAME RATE — 24 vs 30 fps is a 25% difference in bits per frame at identical Mbps.
//   * CODEC — HEVC needs roughly 55% of H.264's bits for the same picture. audit.js already
//     knew this (X265_EFFICIENCY) but the Library badge did not.
// Dividing by width*height*fps and normalising HEVC to its H.264 equivalent collapses all three
// into one number that can be compared across the whole library.
//
// Measured library distribution: p10 0.042, median 0.072, p75 0.137, p90 0.224.
//
// 1.6, not 1.8, since 2026-08-01. The honest published range for HEVC-vs-H.264 at equal quality is
// 35-50% fewer bits, so 1.8 sat at the generous end of it — and being generous here is not
// neutral: the files that benefit most from a large multiplier are low-effort HEVC re-encodes of
// already-lossy sources, which are exactly the files we least want flattered. See
// docs/audit-2026-07-31/raw/RESEARCH-quality-metrics-2026-08-01.md.
const X265_EFFICIENCY = 1.6;

// mediaInfo.resolution is "1920x800". Returns [w, h] or null.
function dimsOf(mi) {
  const m = /^(\d+)\s*x\s*(\d+)$/.exec(String((mi || {}).resolution || '').trim());
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  return (w > 0 && h > 0) ? [w, h] : null;
}
// H.264-equivalent bits per pixel per frame, or null when the inputs are not all present.
//
// `fallbackTotalBps` exists because mediaInfo.videoBitrate is 0 or absent on a real slice of the
// library, while every audit section already computes a size-derived TOTAL bitrate
// (size * 8 / runtime). Total includes audio, so it overstates the video rate by roughly
// 0.1-0.8 Mbps — acceptable as a fallback, wrong as a default. Video bitrate always wins when
// it is there, and `bppSource()` says which was used so the UI can hedge if it ever needs to.
// How much of a size-derived total is audio, as far as we can honestly tell. Returns 0 when we know
// nothing. Capped at 40% of the container: a believable audio share even for a 6-track remux, and a
// backstop against a bogus audioBitrate wiping out the video figure entirely.
const AUDIO_SHARE_CAP = 0.40;

// THE AUDIO RESOLVER, injected by probe.js at startup — same pattern and same cycle-avoidance reason
// as setComplexityResolver above. Contract: resolve(key) -> measured total audio bps, or null.
//
// The measurement sums packet sizes across EVERY audio stream (probe-film.sh), which is the only way
// to see tracks *arr omits: Lawrence of Arabia declares 448k of AC3 and reports NOTHING for its
// DTS-HD MA track, while the packets say 2.59 Mb/s in total. That missing 2.14 Mb/s of a 16.6 Mb/s
// container was being scored as picture.
let _resolveAudio = null;
function setAudioResolver(fn) { _resolveAudio = fn; }


// GRACEFUL DEGRADATION IS THE WHOLE CONTRACT HERE. Three tiers, best available always wins, and a
// missing tier is never an error — it just means a slightly more conservative number:
//   1. MEASURED  every track, from packets. Exact. Only exists for probed units.
//   2. *arr      one track. A ceiling, because the tracks it omits stay charged to video.
//   3. nothing   subtract nothing, which is exactly the pre-2026-08-13 behaviour.
// The 40% cap stays on ALL of them: it is a backstop against a bogus figure wiping out the video
// rate entirely, and a measurement can be bogus too (a mis-muxed file, a packet interval landing in
// a silent passage).
function audioToSubtract(mi, totalBps, key) {
  if (!(totalBps > 0)) return 0;
  let ab = 0;
  if (key && _resolveAudio) {
    try { ab = Number(_resolveAudio(key)) || 0; } catch { ab = 0; }
  }
  if (ab <= 0) ab = Number((mi || {}).audioBitrate) || 0;
  if (ab <= 0) return 0;
  return Math.min(ab, totalBps * AUDIO_SHARE_CAP);
}
// Did we use a real measurement, or *arr's single-track claim? Drives bppSource()'s reporting so the
// UI can say whether a bpp is exact or a ceiling.
function audioIsMeasured(key) {
  if (!key || !_resolveAudio) return false;
  try { return (Number(_resolveAudio(key)) || 0) > 0; } catch { return false; }
}
function bppOf(mi, fallbackTotalBps = null, key = null) {
  const d = dimsOf(mi);
  const fps = Number((mi || {}).videoFps) || 0;
  if (!d || !fps) return null;
  const vb = Number((mi || {}).videoBitrate) || 0;
  const total = Number(fallbackTotalBps) || 0;
  // SANITY-CHECK videoBitrate AGAINST THE FILE ITSELF. *arr's MediaInfo reports a nominal or peak
  // rate rather than the average for some HEVC files, and it is wildly wrong when it does:
  // Challengers is 4.5 GB over 2:11:11 (4.6 Mbps all-in) and Radarr claims videoBitrate
  // 30,317,898 — a 6.5x overstatement. Left unchecked that painted it purple and put it in the
  // Disk section as bloat. The video track cannot out-rate the whole container, so anything above
  // the size-derived total is not believable; 1.05 allows for container-overhead rounding only.
  const trustVb = vb > 0 && (total <= 0 || vb <= total * 1.05);
  // AUDIO MUST NOT BE CHARGED TO VIDEO. bpp is bits per pixel of VIDEO, so when we fall back to the
  // size-derived total (videoBitrate is 0 on ~18% of the library) every audio track inflates it.
  // The old comment below put this at "0.1-0.8 Mbps"; that is true only for lossy stereo. Measured on
  // Lawrence of Arabia (2026-08-13): AC3 448k + DTS-HD MA 2.18 Mb/s = 2.63 Mb/s of a 16.61 Mb/s
  // container, i.e. bpp overstated ~19% and BPP+ ~9% (134 -> ~123).
  //
  // The bias runs the WRONG WAY for our purposes: it flatters multi-dub and lossless-audio releases
  // most, which is exactly the class of release we do not want to be flattered.
  //
  // WHAT WE CAN AND CANNOT SUBTRACT: *arr reports `audioBitrate` for ONE track (the default), not the
  // sum — Lawrence has audioStreamCount 2 and reports only the 448k AC3. So this subtracts what is
  // KNOWN and never guesses the rest: with more than one track the result is still a ceiling, which
  // bppSource() reports as 'total-minus-audio-partial' so callers can tell. Under-subtracting keeps
  // bpp slightly high, the same direction it has always erred; over-subtracting would invent quality.
  const bps = trustVb ? vb : Math.max(0, total - audioToSubtract(mi, total, key));
  if (bps <= 0) return null;
  const c = String((mi || {}).videoCodec || '').toLowerCase();
  const hevc = c.includes('x265') || c.includes('hevc') || c.includes('h265');
  const raw = bps / (d[0] * d[1] * fps);
  return +(hevc ? raw * X265_EFFICIENCY : raw).toFixed(5);
}
// Which figure bppOf() actually used, mirroring the trust rule above. Three outcomes now:
//   'video'                      — mediaInfo.videoBitrate, believable, exact.
//   'total-minus-audio'          — size-derived, with the single reported audio track removed. Exact
//                                  as far as audio goes when audioStreamCount <= 1.
//   'total-minus-audio-partial'  — same, but there are MORE audio tracks than *arr gave bitrates for,
//                                  so some audio is still charged to video and bpp remains a CEILING.
//   'total'                      — no audio figure at all; the whole container counts as video.
function bppSource(mi, fallbackTotalBps = null, key = null) {
  const vb = Number((mi || {}).videoBitrate) || 0;
  const total = Number(fallbackTotalBps) || 0;
  if (vb > 0 && (total <= 0 || vb <= total * 1.05)) return 'video';
  if (audioToSubtract(mi, total, key) <= 0) return 'total';
  // A measurement covers EVERY track, so unlike the *arr path it is not a ceiling — it is the only
  // fallback state that is exact.
  if (audioIsMeasured(key)) return 'total-minus-audio-measured';
  return (Number((mi || {}).audioStreamCount) || 1) > 1
    ? 'total-minus-audio-partial'
    : 'total-minus-audio';
}

// ---- BPP+ : the number a human actually reads ────────────────────────────────────────────────
// Raw bpp is correct but illegible — the whole library lives between 0.02 and 0.44, so the
// interesting differences are in the third decimal place. Brennan, 2026-08-01: index it the way
// baseball indexes OPS+, where 100 is the reference and everything is a percentage of it.
//
//   BPP+ = round(100 * sqrt(bpp / target))       target = this film's measured complexity,
//                                                         or BPP_TARGET if it has not been probed
//
// 100 IS NOT "AVERAGE", IT IS "CORRECT" — and since 2026-08-06 it is correct PER FILM. The target is
// the point where a film looks its best while using no more disk than that needs, and what that costs
// is a property of the content: Casablanca's grain needs 4x the bits of Blade Runner 2049 to reach the
// same quality. The nightly CRF probe measures it per title (lib/probe.js); BPP_TARGET remains only
// as the fallback for films not yet probed. See bppTargetFor() below.
//
// WHY THE SQUARE ROOT (added 2026-08-01, was a straight ratio before).
// The old index was linear in bitrate, so "200" meant "twice the bits" — a statement about disk,
// not about picture. Bits and picture are not proportional. Measured on this library's own
// content (raw/bitrate-plateau-2026-08-01.md), visible error falls as roughly bitrate^-0.5:
// quadrupling the bitrate halves the distortion. Taking the square root inverts that, so the index
// is proportional to 1/error and the ratios finally mean something:
//
//     200 = half as much visible error as 100        (and 4x the bits)
//      50 = twice as much visible error as 100       (and 1/4 the bits)
//
// That is the property Brennan asked for: "200 is in some ways double as good as 100". It is an
// interpretation, not a law of nature — the exponent is fitted from OUR content and is the weakest
// link in the whole model. It is also monotonic, so it re-labels every file without re-ranking any
// of them: band membership was 5.0/2.9/15.3/76.7% before and 4.8/2.8/16.2/76.3% after.
//
//   >= 125   purple  ~20%+ less error than the display can resolve. Not waste — this is the band
//                    that starts to pay off after a projector upgrade — but it IS disk spent on
//                    something invisible today.
//   100-124  green   the target. Looks its best on current hardware.
//    75-99   orange  diminished even today. May still be fine; that is the human's call.
//     < 75   red     compromised. The YTS family (41% of the movie library) sits around 63.
//
// The cutoffs are the old 150/100/60 carried through the same square root (sqrt(1.5)=1.22,
// sqrt(0.6)=0.77), then rounded to the human numbers 125/100/75. The rounding is not quite free:
// 77 -> 75 moves 8 of 860 movies from red to orange. Everything else is a pure relabel.
//
// BPP_TARGET IS NOW ONLY THE FALLBACK. Until 2026-08-06 it was the denominator for every file in
// the library — one constant standing in for "how many bits does this content need". The nightly
// CRF probe (lib/probe.js) measures that per film, and the first night's 69 measurements settled
// the question of whether one constant could ever have worked: complexity ranges 0.0436 (Dune,
// clean digital capture) to 0.3511 (Schindler's List, B&W with heavy grain) — an 8.1x spread. The
// flat value was wrong by roughly 2x in BOTH directions, and systematically: it overrated grainy
// film-stock transfers (whose bits buy grain reproduction, not detail) and underrated clean modern
// digital ones.
//
// Notably the measured MEDIAN is 0.1237 — so 0.13 was a good library-wide average and a poor
// per-film answer, which is exactly the failure mode you cannot see without measuring.
//
// It survives as the denominator for a film with no probe data at all (a brand-new arrival before
// its first pass, or a call site with no unit key). That path is the pre-probe behaviour, unchanged.
const BPP_TARGET = 0.13;

// THE DENOMINATOR RESOLVER, injected by probe.js at startup (see setComplexityResolver there).
// Injected rather than required because probe.js already requires bppOf/bppIndex from THIS module,
// so requiring it back would be a cycle. The upside is that this module remains the single owner of
// the scoring math and knows nothing about how complexity is measured.
//
// Contract: resolve(key) -> { target, basis } | null
//   target  the effective per-film bpp denominator (that film's measured complexity x the headroom
//           anchor). Already includes the anchor, so this module never learns about CRF or headroom.
//   basis   where the number came from: 'measured' (this film), 'measured:stale' (this film, from a
//           copy since replaced — content is the same, so still valid), or 'estimated:*' (inferred
//           from other films via probe.js's shrinkage ladder).
// Null / absent resolver / a throw all mean "no usable probe data" -> flat BPP_TARGET.
let _resolveTarget = null;
function setComplexityResolver(fn) { _resolveTarget = fn; }

// The denominator for one title, and where it came from. `key` is the unit key — 'mv:<radarrId>' or
// 'tv:<sonarrId>:<season>' — which is the same key probe.js caches by. That agreement is not a
// coincidence to be maintained by hand: audit.js builds row.key in exactly this form and probe.js
// builds unit.key the same way, both from the *arr ids, so a row and its measurement cannot drift.
function bppTargetFor(key) {
  if (key && _resolveTarget) {
    try {
      const r = _resolveTarget(key);
      if (r && r.target > 0) return { target: r.target, basis: r.basis || 'measured' };
    } catch { /* a broken resolver must never take the whole Audit tab down with it */ }
  }
  return { target: BPP_TARGET, basis: 'flat' };
}

// BPP+ itself. `key` is OPTIONAL, and passing it is the entire cutover: with a key, a film that has
// been probed is scored against its OWN transparent bitrate instead of the library-wide guess.
// Without one — or for a film not yet probed — the result is bit-identical to the pre-probe value.
//
// This is why the signature was extended rather than replaced: there are 12 call sites, and a
// mistake at any of them should degrade to the old behaviour rather than to a wrong number.
// THE ADEQUACY TERM, injected like the complexity resolver so this module stays formula-pure.
// It is applied on the SCORE rather than the target because it is a shift, not a multiplier: the
// artifact estimator says which side of the elbow a film sits on, and 100 is the elbow.
let _resolveAdequacy = null;
function setAdequacyResolver(fn) { _resolveAdequacy = fn; }
function adequacyShift(plus, key) {
  if (!key || !_resolveAdequacy || plus == null) return 0;
  // A broken resolver must never take the whole Library and Audit tabs down with it.
  try { const d = _resolveAdequacy(key, plus); return Number.isFinite(d) ? d : 0; } catch { return 0; }
}
const bppIndex = (bpp, key) => {
  if (bpp == null) return null;
  const t = bppTargetFor(key).target;
  const raw = 100 * Math.sqrt(bpp / t);
  return Math.round(raw + adequacyShift(raw, key));
};
const BPP_INDEX_BANDS = [[125, 'wow'], [100, 'ok'], [75, 'warn'], [0, 'bad']];
const BPP_RANK = { wow: 0, ok: 1, warn: 2, bad: 3 };
function bppBand(bpp, key) {
  const i = bppIndex(bpp, key);
  if (i == null) return '';
  for (const [lo, cls] of BPP_INDEX_BANDS) if (i >= lo) return cls;
  return 'bad';
}
// The basis alone, for payloads that need to TELL the reader whether a score is measured or
// inferred. The design's rule (DESIGN-CRF-PROBE.md §6) is that an estimated value must be visibly
// marked, and that is enforced by carrying this onto every row rather than by hoping the UI guesses.
const bppBasis = (key) => bppTargetFor(key).basis;

// ---- HOW MUCH TO TRUST A BPP+ ────────────────────────────────────────────────────────────────
// BPP+ divides by a MEASURED complexity, and that measurement has a standard error. Until 2026-08-18
// nothing carried it, so a number pinned to +/-3% and one pinned to +/-40% were printed identically —
// and the Audit tab would act on either, flagging an upgrade off a denominator that was barely a
// guess.
//
// THE SQUARE ROOT HALVES THE ERROR. BPP+ = 100*sqrt(bpp/target), so a relative error `e` on the
// target becomes ~e/2 on the index: a complexity known only to +/-24% still yields a BPP+ good to
// about +/-12%. That is why the threshold here is looser than it first looks — the index is
// intrinsically more stable than the thing it is built from.
//
// Returns the RELATIVE error of the INDEX (already halved), or null when unknown. Null means "not
// measured" — a film scored against the flat fallback has no error bar at all, which bppBasis()
// already reports separately and more usefully.
const BPP_RSE_LOOSE = 0.10;                     // >10% on the index = show it as provisional
function bppRSE(key) {
  if (!key || !_resolveTarget) return null;
  try {
    const r = _resolveTarget(key);
    if (!r || !(r.target > 0) || r.rse == null) return null;
    return +(r.rse / 2).toFixed(4);             // sqrt() halves relative error
  } catch { return null; }
}
// Is this BPP+ solid enough to print bare? A null RSE is treated as CONFIDENT rather than doubtful:
// most of the library has no per-sample data yet, and marking 1000 films provisional would make the
// mark meaningless. The mark is for films we KNOW are loosely measured.
// Bitrate adequacy for a unit: srcBitrate / the bitrate a transparent encode of THIS FILE costs.
// >1 means the file spends more than reproducing itself takes. Null when unprobed.
// NOT A QUALITY MEASURE — see the OVER-SUPPLY block in audit.js for why the distinction matters.
// How badly the sampled episodes of a SEASON disagreed with each other (0 = identical). Meaningless
// for movies, which are one file. Null when unprobed.
function bppDisagree(key) {
  if (!key || !_resolveTarget) return null;
  try { const r = _resolveTarget(key); return r && r.disagree != null ? r.disagree : null; } catch { return null; }
}
function bppRatioR(key) {
  if (!key || !_resolveTarget) return null;
  try { const r = _resolveTarget(key); return r && r.R > 0 ? r.R : null; } catch { return null; }
}
// THE ARTIFACT FACTOR ALREADY BAKED INTO THIS UNIT'S TARGET, or null when the unit has no artifact
// measurement. Carried so the UI can say WHY a score is provisional: 'estimated complexity' and
// 'no artifact reading' are different gaps and a person chasing one should not be shown the other.
//
// A factor of exactly 1 with a reading present is NOT the same as null. 1 means "measured, and this
// copy is exactly as damaged as its bitrate predicts"; null means "we have not looked". Collapsing
// them would be the same null-means-clean error the banding contract exists to prevent.
function bppArtifact(key) {
  if (!key || !_resolveTarget) return null;
  try {
    const r = _resolveTarget(key);
    return r && r.artifactFactor != null ? r.artifactFactor : null;
  } catch { return null; }
}
const bppConfident = (key) => {
  const e = bppRSE(key);
  return e == null ? true : e <= BPP_RSE_LOOSE;
};
// The dot rendering lives in web/js/util.js, not here — it is presentation, and it takes the BAND
// (already computed and sent on the payload) rather than the raw value, so the browser never
// re-derives a threshold. This module owns the numbers; the client owns how they look.
const DISK_REJ = /exceed available disk space/i;

async function freeUnderCap() {
  const s = await fs.promises.statfs('/data');
  const total = s.blocks * s.bsize;
  const cap = total > 0 ? total : 0;
  return Math.max(0, cap - (total - s.bavail * s.bsize));
}
async function arrTitle(app, id, seasons) {
  try {
    const it = await arrGet(app, app === 'radarr' ? `/movie/${id}` : `/series/${id}`);
    let t = it.title + (it.year ? ` (${it.year})` : '');
    if (app === 'sonarr' && seasons.length) t += seasons.length === 1 ? ` — Season ${seasons[0]}` : ` — Seasons ${seasons.join(', ')}`;
    return t;
  } catch { return 'Requested title'; }
}
// True if the *arr is already doing something about this id (queued / grabbed / has a file) —
// i.e. it's NOT stuck, so there's nothing to explain.
async function arrHasActivity(app, id) {
  try { if (((await arrGet(app, '/queue?pageSize=200')).records || []).some((r) => (app === 'radarr' ? r.movieId : r.seriesId) === id)) return true; } catch { /* arr down */ }
  try {
    if (app === 'radarr') { if ((await arrGet('radarr', `/movie/${id}`)).hasFile) return true; }
    else if (((await arrGet('sonarr', `/series/${id}`)).statistics || {}).episodeFileCount > 0) return true;
  } catch { /* arr down */ }
  try {
    const h = await arrGet(app, app === 'radarr' ? `/history/movie?movieId=${id}` : `/history/series?seriesId=${id}`);
    if ((Array.isArray(h) ? h : h.records || []).some((r) => (r.eventType || '').toLowerCase() === 'grabbed')) return true;
  } catch { /* no history */ }
  return false;
}
// Smallest release whose ONLY rejection is disk space = "the one we'd grab if it fit".
function diskOnlyBlocker(releases) {
  let best = null;
  for (const r of releases) {
    const rej = r.rejections || [];
    if (!rej.length) return null;                       // a grabbable release exists → not a disk wall
    if (rej.every((x) => DISK_REJ.test(x)) && (r.size || 0) > 0 && (!best || r.size < best.size)) best = r;
  }
  return best;                                          // null = stuck for some OTHER reason
}
async function diagnose(app, id, seasons) {
  const rels = [];
  try {
    if (app === 'radarr') rels.push(...await arrGet('radarr', `/release?movieId=${id}`, 90000));
    else for (const sn of (seasons.length ? seasons : [1])) { try { rels.push(...await arrGet('sonarr', `/release?seriesId=${id}&seasonNumber=${sn}`, 90000)); } catch { /* indexer hiccup */ } }
  } catch { return null; }
  return diskOnlyBlocker(rels);
}

module.exports = { videoLabel, gpuTier, dimsOf, bppOf, bppSource, bppBand, bppIndex, bppArtifact, setAdequacyResolver,
  bppBasis, bppRSE, bppConfident, bppRatioR, bppDisagree, BPP_RSE_LOOSE, bppTargetFor, setComplexityResolver, setAudioResolver,
  BPP_TARGET, BPP_INDEX_BANDS, BPP_RANK, X265_EFFICIENCY, freeUnderCap, arrTitle, arrHasActivity, diskOnlyBlocker, diagnose };
