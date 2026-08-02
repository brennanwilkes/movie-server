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
function bppOf(mi, fallbackTotalBps = null) {
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
  const bps = trustVb ? vb : total;
  if (bps <= 0) return null;
  const c = String((mi || {}).videoCodec || '').toLowerCase();
  const hevc = c.includes('x265') || c.includes('hevc') || c.includes('h265');
  const raw = bps / (d[0] * d[1] * fps);
  return +(hevc ? raw * X265_EFFICIENCY : raw).toFixed(5);
}
// Which figure bppOf() actually used, mirroring the trust rule above. 'total' means either the
// file reported no videoBitrate (~18% of movies) or the one it reported was not believable.
function bppSource(mi, fallbackTotalBps = null) {
  const vb = Number((mi || {}).videoBitrate) || 0;
  const total = Number(fallbackTotalBps) || 0;
  return (vb > 0 && (total <= 0 || vb <= total * 1.05)) ? 'video' : 'total';
}

// ---- BPP+ : the number a human actually reads ────────────────────────────────────────────────
// Raw bpp is correct but illegible — the whole library lives between 0.02 and 0.44, so the
// interesting differences are in the third decimal place. Brennan, 2026-08-01: index it the way
// baseball indexes OPS+, where 100 is the reference and everything is a percentage of it.
//
//   BPP+ = round(100 * sqrt(bpp / BPP_TARGET))
//
// 100 IS NOT "AVERAGE", IT IS "CORRECT". BPP_TARGET is the green threshold: the point where a
// film looks its best on the hardware we actually own (native-720p projector, measured
// 2026-08-01), while using no more disk than that needs.
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
// KNOWN CONSERVATISM, DELIBERATELY NOT PATCHED: BPP_TARGET is anchored to CRF-18 transparency on a
// 1080p display, but the projector is a native 1280x720 panel that discards 2.25x the pixels we
// are charging files for. The real target is therefore somewhere below 0.13 and the whole library
// should probably score higher than it does. 2.25x is an upper bound on that credit, not the right
// credit, and no measurement we can currently make resolves it — SSIM is confounded by grain in
// exactly this regime. Inventing a partial credit would be a guess wearing a decimal point. The
// per-title CRF probe (docs/TODO-quality.md) replaces this constant with a measured value and is
// the actual fix. Until then: read red as "compromised relative to a 1080p ideal".
const BPP_TARGET = 0.13;
const bppIndex = (bpp) => (bpp == null ? null : Math.round(100 * Math.sqrt(bpp / BPP_TARGET)));
const BPP_INDEX_BANDS = [[125, 'wow'], [100, 'ok'], [75, 'warn'], [0, 'bad']];
const BPP_RANK = { wow: 0, ok: 1, warn: 2, bad: 3 };
function bppBand(bpp) {
  const i = bppIndex(bpp);
  if (i == null) return '';
  for (const [lo, cls] of BPP_INDEX_BANDS) if (i >= lo) return cls;
  return 'bad';
}
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

module.exports = { videoLabel, gpuTier, dimsOf, bppOf, bppSource, bppBand, bppIndex,
  BPP_TARGET, BPP_INDEX_BANDS, BPP_RANK, X265_EFFICIENCY, freeUnderCap, arrTitle, arrHasActivity, diskOnlyBlocker, diagnose };
