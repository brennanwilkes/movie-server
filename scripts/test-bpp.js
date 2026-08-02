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
  bppOf, bppBand, bppSource, bppIndex, dimsOf, BPP_TARGET, BPP_RANK, X265_EFFICIENCY,
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

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
