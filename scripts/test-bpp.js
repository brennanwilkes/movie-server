'use strict';
// Bits per pixel per frame — the unit the whole quality model rests on, added 2026-08-01 to
// replace raw Mbps in the Library badge, the Audit rows and the candidate cards.
//
// Worth its own suite because bppOf() is now the single input to four separate decisions: the
// colour of every quality badge, which titles the Disk section lists, which candidates
// candidateBandOk() refuses, and how the Upgrade tab sorts. A silent drift here moves all four at
// once, and two of the bugs below were found by running the model against the live library rather
// than by reading the code.
const {
  bppOf, bppBand, bppSource, bppIndex, bppBasis, dimsOf, BPP_TARGET, BPP_RANK, X265_EFFICIENCY,
  setComplexityResolver,
} = require('../controller/lib/arr-inspect');

let pass = 0; let fail = 0;
const ok = (c, why) => { if (c) pass++; else { fail++; console.log(`FAIL  ${why}`); } };
const near = (a, b, why, tol = 0.002) => ok(a != null && Math.abs(a - b) < tol, `${why} (got ${a}, want ~${b})`);

// ---- dimension parsing ----------------------------------------------------------------------
ok(String(dimsOf({ resolution: '1920x800' })) === '1920,800', 'parses WxH');
ok(dimsOf({ resolution: '' }) === null, 'empty resolution is null, never a guess');
ok(dimsOf({}) === null, 'missing resolution is null');
ok(dimsOf(null) === null, 'null mediaInfo does not throw');

// ---- the core arithmetic --------------------------------------------------------------------
// 10 Mbps at 1920x1080p24 is the CRF-18 "visually lossless" anchor the purple band is set from.
near(bppOf({ resolution: '1920x1080', videoFps: 24, videoBitrate: 10e6, videoCodec: 'x264' }),
  0.2009, 'the CRF-18 anchor lands on 0.20');
// RESOLUTION MATTERS — the whole reason Mbps was wrong. Same bitrate, scope frame, higher bpp.
const flat = bppOf({ resolution: '1920x1080', videoFps: 24, videoBitrate: 5e6, videoCodec: 'x264' });
const scope = bppOf({ resolution: '1920x800', videoFps: 24, videoBitrate: 5e6, videoCodec: 'x264' });
ok(scope > flat * 1.3, 'a scope frame at the same Mbps scores materially higher than a flat one');
// FRAME RATE MATTERS.
const f24 = bppOf({ resolution: '1920x1080', videoFps: 24, videoBitrate: 6e6, videoCodec: 'x264' });
const f30 = bppOf({ resolution: '1920x1080', videoFps: 30, videoBitrate: 6e6, videoCodec: 'x264' });
ok(f24 > f30, '24 fps scores above 30 fps at the same bitrate');
// CODEC MATTERS — HEVC is normalised to its H.264 equivalent.
const h264 = bppOf({ resolution: '1920x1080', videoFps: 24, videoBitrate: 5e6, videoCodec: 'x264' });
const hevc = bppOf({ resolution: '1920x1080', videoFps: 24, videoBitrate: 5e6, videoCodec: 'x265' });
near(hevc / h264, X265_EFFICIENCY, 'HEVC is scaled by exactly X265_EFFICIENCY');
ok(bppOf({ resolution: '1920x1080', videoFps: 24, videoBitrate: 5e6, videoCodec: 'hevc' }) === hevc,
  '"hevc" and "x265" are treated identically');

// ---- missing inputs are null, never a guess --------------------------------------------------
ok(bppOf({ resolution: '1920x1080', videoFps: 0, videoBitrate: 5e6 }) === null, 'no fps -> null');
ok(bppOf({ resolution: '', videoFps: 24, videoBitrate: 5e6 }) === null, 'no resolution -> null');
ok(bppOf({ resolution: '1920x1080', videoFps: 24, videoBitrate: 0 }) === null, 'no bitrate and no fallback -> null');
ok(bppOf(null) === null, 'null mediaInfo -> null');
ok(bppBand(null) === '', 'an unknown bpp has no band, so nothing gets coloured on a guess');

// ---- the size-derived fallback ---------------------------------------------------------------
// mediaInfo.videoBitrate is absent on 154 of 859 movies (18%), measured 2026-08-01.
const noVb = { resolution: '1920x1080', videoFps: 24, videoBitrate: 0, videoCodec: 'x264' };
near(bppOf(noVb, 5e6), 0.1005, 'falls back to the size-derived total when videoBitrate is absent');
ok(bppSource(noVb, 5e6) === 'total', 'bppSource reports the fallback was used');

// ---- REGRESSION: *arr reports a nominal/peak videoBitrate on some HEVC files ------------------
// Challengers, live data 2026-08-01: 4.5 GB over 2:11:11 = 4.6 Mbps all-in, yet Radarr reports
// videoBitrate 30,317,898 — a 6.5x overstatement. 18 of 859 movies are affected. Unchecked, this
// painted the file PURPLE and put it in the Disk section as bloat. A video track cannot out-rate
// its own container, so anything above the size-derived total is not believable.
const bogus = { resolution: '1920x1080', videoFps: 23.976, videoBitrate: 30317898, videoCodec: 'x265' };
const realTotal = 4.5e9 * 8 / (2 * 3600 + 11 * 60 + 11);
const fixed = bppOf(bogus, realTotal);
ok(fixed < 0.195, 'a videoBitrate above the container total is rejected, not trusted');
ok(bppBand(fixed) !== 'wow', 'Challengers no longer renders purple on a bogus bitrate');
ok(bppSource(bogus, realTotal) === 'total', 'bppSource flags the untrusted value');
// ...but a believable videoBitrate is still preferred over the size-derived total, because total
// includes audio and overstates the video rate.
const sane = { resolution: '1920x1080', videoFps: 24, videoBitrate: 4.6e6, videoCodec: 'x264' };
ok(bppSource(sane, 5e6) === 'video', 'a believable videoBitrate is still used');
ok(bppOf(sane, 5e6) < bppOf({ ...sane, videoBitrate: 0 }, 5e6), 'video rate is below the all-in total');

// ---- BPP+ index and band boundaries ----------------------------------------------------------
// Bands are defined on the INDEX now, not on raw bpp, because the index is what gets read.
// 100 = BPP_TARGET = the green threshold = "exactly what this hardware needs".
ok(bppIndex(BPP_TARGET) === 100, 'the target indexes to exactly 100');
ok(bppIndex(null) === null, 'an unknown bpp has no index');
// THE RATIO PROPERTY, which is the entire point of the square root (2026-08-01). The index is
// proportional to 1/visible-error, not to bitrate, because measured distortion falls as
// bitrate^-0.5. So "twice as good" costs FOUR times the bits, and the number says so.
ok(bppIndex(BPP_TARGET * 4) === 200, 'FOUR times the bits reads as 200 — twice as good, not 4x');
ok(bppIndex(BPP_TARGET / 4) === 50, 'a quarter of the bits reads as 50 — half as good');
ok(bppIndex(BPP_TARGET * 2) === 141, 'twice the bits is only ~1.41x the index');
// ...and the old linear reading must be gone, or every doc and tooltip is lying.
ok(bppIndex(BPP_TARGET * 2) !== 200, 'the index is NOT linear in bitrate any more');
ok(bppBand(BPP_TARGET * 1.5625) === 'wow', '125 is purple');           // sqrt(1.5625) = 1.25
ok(bppBand(BPP_TARGET * 1.55) === 'ok', 'just under 125 is green, not purple');
ok(bppBand(BPP_TARGET) === 'ok', '100 is green');
ok(bppBand(BPP_TARGET * 0.99) === 'warn', 'just under 100 is orange');
ok(bppBand(BPP_TARGET * 0.5625) === 'warn', '75 is orange');           // sqrt(0.5625) = 0.75
ok(bppBand(BPP_TARGET * 0.55) === 'bad', 'just under 75 is red');
ok(bppBand(0) === 'bad', 'zero is red');
// The cutoffs are the pre-square-root 150/100/60 carried through the same transform, so the SET of
// files in each colour is unchanged — only the number beside them moved. If these drift apart the
// recalibration has silently become a re-banding, which is a different (and unreviewed) change.
near(BPP_TARGET * (1.25 ** 2), 0.20, 'the purple cutoff still sits on CRF-18 (bpp 0.20)', 0.006);
// The orange cutoff is the one place rounding to a human number cost real precision: the exact
// carry-through of the old 60 is 77, and 75 puts the boundary at bpp 0.073 against a CRF-23/24
// anchor of 0.08 — 8.6% low, where every other cutoff is inside 3%. Measured cost on the live
// library: 8 of 860 movies move from red to orange. Judged worth it for a round number, but it IS
// a re-band, not a pure relabel, so the tolerance says 10% and does not pretend otherwise.
near(BPP_TARGET * (0.75 ** 2), 0.08, 'the orange cutoff is within 10% of CRF-23/24 (bpp 0.08)', 0.008);
// Real values from the live library, as a human would read them.
ok(bppIndex(0.033) === 50, 'Gladiator (0.033 bpp) reads as 50 — half as good as it should be');
ok(bppIndex(0.330) === 159, 'Lawrence of Arabia (0.330 bpp) reads as 159, not the old 254');
// The YTS family, which is 41% of the movie library, must land red — that is the finding the
// whole scale exists to make visible.
near(bppOf({ resolution: '1920x800', videoFps: 23.976, videoBitrate: 2e6, videoCodec: 'x264' }), 0.0543,
  'a 2 Mbps YTS scope encode sits around 0.054');
ok(bppBand(0.0543) === 'bad', '...and that is red');
ok(bppIndex(0.0543) === 65, '...reading as 65 — roughly 1.5x the visible error of the target');
// Ordering must match the rank map every consumer sorts by.
ok(BPP_RANK.wow < BPP_RANK.ok && BPP_RANK.ok < BPP_RANK.warn && BPP_RANK.warn < BPP_RANK.bad,
  'BPP_RANK orders best-to-worst, which is what the Upgrade sort and the band floor assume');

// ---- THE PROBE CUTOVER (2026-08-06) ---------------------------------------------------------
// bppIndex(bpp, key) divides by the film's OWN measured complexity instead of the flat BPP_TARGET.
// Four properties matter and all four are load-bearing:
//   1. no key  -> bit-identical to the pre-probe value. 12 call sites were changed; a missed one
//                 must degrade to the old number, never to a wrong one.
//   2. a key with a measurement -> that film's denominator.
//   3. a key WITHOUT one, or a resolver that throws -> flat fallback. The probe must never be able
//                 to take the Audit tab down or blank a badge.
//   4. basis is reported, so an inferred number can be marked in the UI rather than passed off as
//                 measured (DESIGN-CRF-PROBE.md §6).
//
// The expected values are the real 2026-08-06 measurements, so this suite also pins the two films
// that motivated the whole probe. Casablanca and Blade Runner 2049 move in OPPOSITE directions —
// which is the property no single global constant can have.
const CX = {                    // measured complexity, H.264-equivalent bpp per pixel per frame
  'mv:casablanca': 0.27853,     // B&W, heavy grain — 2.1x more demanding than the flat 0.13
  'mv:br2049': 0.06700,         // clean modern digital — 1.9x less
};
setComplexityResolver((k) => (CX[k] ? { target: CX[k], basis: 'measured' } : null));

// 1. Unkeyed calls are untouched by the cutover.
ok(bppIndex(0.43593) === 183, 'no key: Casablanca still scores 183 against the flat target');
ok(bppIndex(0.0543) === 65, 'no key: the YTS figure above is unchanged');
ok(bppBasis(undefined) === 'flat', 'no key reports basis "flat", not a fake measurement');

// 2. A measured film is scored against its own content.
ok(bppIndex(0.43593, 'mv:casablanca') === 125,
  'Casablanca falls 183 -> 125: its bitrate buys grain, so it was never as over-provisioned as it looked');
ok(bppIndex(0.245, 'mv:br2049') === 191,
  'Blade Runner 2049 rises 137 -> 191: clean digital needs few bits, so its copy is genuinely lavish');
ok(bppBasis('mv:casablanca') === 'measured', 'a measured film says so');
// The direction of the correction is the point — opposite signs from one constant is impossible.
ok(bppIndex(0.43593, 'mv:casablanca') < bppIndex(0.43593)
  && bppIndex(0.245, 'mv:br2049') > bppIndex(0.245),
  'the probe moves grainy films DOWN and clean films UP — the systematic bias a flat target cannot fix');

// 3. Every failure path falls back rather than breaking.
ok(bppIndex(0.43593, 'mv:never-probed') === 183, 'an unmeasured key falls back to the flat target');
ok(bppBasis('mv:never-probed') === 'flat', '...and reports it as flat');
setComplexityResolver((k) => (k === 'mv:zero' ? { target: 0, basis: 'measured' } : null));
ok(bppIndex(0.43593, 'mv:zero') === 183, 'a zero/garbage target is rejected, not divided by');
setComplexityResolver(() => { throw new Error('probe exploded'); });
ok(bppIndex(0.43593, 'mv:casablanca') === 183, 'a THROWING resolver cannot break scoring');
ok(bppBand(0.43593, 'mv:casablanca') === 'wow', '...and cannot blank a band either');

// 4. Bands follow the keyed value, not the flat one. Schindler's List is the case that matters:
// the flat target scored it 94 — orange, "diminished but maybe fine" — when its content is the most
// demanding measured so far (0.3511, B&W with heavy grain). The honest figure is 57, deep red.
// Getting this wrong is what hid the library's best upgrade candidate behind a survivable colour.
setComplexityResolver((k) => (k === 'mv:schindler' ? { target: 0.35110, basis: 'measured' } : null));
ok(bppIndex(0.115, 'mv:schindler') === 57, "Schindler's List is 57, not 94");
ok(bppBand(0.115, 'mv:schindler') === 'bad' && bppBand(0.115) === 'warn',
  '...and its BAND flips orange -> red, which is what makes it visible as underserved');

// An estimated basis must be distinguishable from a measured one — the UI marks it with a ~.
setComplexityResolver(() => ({ target: 0.1237, basis: 'estimated:global' }));
ok(bppBasis('mv:anything') === 'estimated:global', 'an inferred denominator reports itself as estimated');
// The measured median (0.1237) is within 5% of the flat 0.13, which is why the cutover barely moved
// the 93% of the library that had no measurement yet. Verified live: median move was 2 points.
ok(Math.abs(bppIndex(0.13, 'mv:anything') - bppIndex(0.13)) <= 3,
  'an unmeasured film moves by at most a couple of points — the cutover was near-free for most titles');
setComplexityResolver(null);    // leave the module as we found it

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
