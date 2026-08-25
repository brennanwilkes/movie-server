#!/usr/bin/env node
'use strict';
// analyze-noise-origin.js — the analyser behind probe-noise-origin.sh. See that file for the theory.
//
// Reads N consecutive raw gray8 luma planes and reports, restricted to BRIGHT pixels only:
//
//   iRatio    mean frame-diff ACROSS an I-frame  /  mean frame-diff on P/B frames.
//             ~1.0  -> the noise is renewed every frame regardless of coding => FILM GRAIN
//             >1.5  -> the noise is frozen between keyframes and re-rolled at each one
//                      => COMPRESSION. This is the primary discriminator.
//
//   pbFloor   the P/B frame-diff itself, in 8-bit levels. Grain in a 35mm scan is typically several
//             levels of change per pixel per frame; a value near zero means the picture is literally
//             not changing, i.e. whatever we see is static and cannot be grain.
//
//   gridRatio mean |difference| across an 8x8 block boundary / mean |difference| inside a block,
//             spatially. Coding error is generated per transform block so it steps at boundaries;
//             grain does not know the grid exists. ~1.00 grain, >1.15 coding.
//
// The two are independent — one is temporal, one spatial — so agreement between them is meaningful
// and disagreement is a reason to distrust the verdict rather than to pick the convenient half.
const fs = require('fs');
const [, , rawPath, wS, hS, nS, brightS, typesPath, label] = process.argv;
const W = +wS, H = +hS, N = +nS, BRIGHT = +brightS;
const buf = fs.readFileSync(rawPath);
const frameSize = W * H;
const have = Math.min(N, Math.floor(buf.length / frameSize));
if (have < 4) { console.log(`${label}: only ${have} frames decoded — cannot analyse`); process.exit(1); }
const types = fs.readFileSync(typesPath, 'utf8').trim().split('\n').map((s) => s.trim());

const frame = (i) => buf.subarray(i * frameSize, (i + 1) * frameSize);

// ── TEMPORAL ─────────────────────────────────────────────────────────────────────────────────────
// Only bright pixels, and only pixels that are bright in BOTH frames, so a moving bright edge does
// not masquerade as noise. Motion is the obvious confound here: a panning shot changes every pixel
// enormously and would swamp grain. Guarding on a low absolute difference ceiling (SKIP) drops
// genuine motion while keeping noise, which is small by construction.
const SKIP = 24;
// SCENE CUTS ARE THE TRAP IN THIS MEASUREMENT, and they cost me a wrong verdict before I caught it.
// Encoders place an I-frame AT a cut, so "difference across an I-frame" picks up the cut itself and
// reports compression on any clip containing one. Spirited Away — hand-drawn, no grain, judged clean
// by eye — scored iRatio 2.23 ("COMPRESSION") purely because its I-frames sat on cuts.
// So: measure each frame's UNMASKED global difference too, and drop any frame whose global change is
// large. That is a cut or a hard camera move, and it carries no information about noise either way.
const CUT = 12;
const perFrame = [];
for (let i = 1; i < have; i++) {
  const a = frame(i - 1), b = frame(i);
  let sum = 0, n = 0, gsum = 0, gn = 0;
  for (let p = 0; p < frameSize; p += 3) {           // stride 3: plenty of samples, 3x faster
    const va = a[p], vb = b[p];
    const d = Math.abs(va - vb);
    gsum += d; gn++;                                 // global, unmasked, unfiltered: the cut detector
    if (va < BRIGHT || vb < BRIGHT) continue;
    if (d > SKIP) continue;                          // real motion, not noise
    sum += d; n++;
  }
  const global = gn ? gsum / gn : 0;
  perFrame.push({ i, diff: n ? sum / n : null, n, global, cut: global > CUT, type: types[i] || '?' });
}
const cuts = perFrame.filter((f) => f.cut).length;
const usable = perFrame.filter((f) => f.diff != null && f.n > 2000 && !f.cut);
if (!usable.length) { console.log(`${label}: no bright static region found at this timestamp`); process.exit(1); }
const iFrames = usable.filter((f) => f.type === 'I');
const pbFrames = usable.filter((f) => f.type !== 'I');
const mean = (a) => a.reduce((s, x) => s + x.diff, 0) / a.length;
const pbMean = pbFrames.length ? mean(pbFrames) : null;
const iMean = iFrames.length ? mean(iFrames) : null;

// ── SPATIAL: the 8x8 grid ────────────────────────────────────────────────────────────────────────
// Compare horizontal neighbour differences that STRADDLE a block edge (x%8===7 -> x%8===0) with
// those safely INSIDE a block. Averaged over several frames so one atypical frame cannot decide it.
let across = 0, acrossN = 0, inside = 0, insideN = 0;
for (let i = 0; i < Math.min(have, 12); i++) {
  const f = frame(i);
  for (let y = 0; y < H; y += 2) {
    const row = y * W;
    for (let x = 1; x < W - 1; x++) {
      const v = f[row + x];
      if (v < BRIGHT) continue;
      const d = Math.abs(v - f[row + x + 1]);
      if (d > 40) continue;                          // an actual picture edge, not noise
      if (x % 8 === 7) { across += d; acrossN++; } else if (x % 8 !== 0) { inside += d; insideN++; }
    }
  }
}
const gridRatio = (acrossN && insideN && inside / insideN > 0) ? (across / acrossN) / (inside / insideN) : null;

console.log(`\n=== ${label} ===`);
console.log(`frames ${have}   bright thr ${BRIGHT}   samples/frame ~${Math.round(usable.reduce((s, f) => s + f.n, 0) / usable.length)}`
  + `   cuts/motion dropped ${cuts}   I-frames kept ${usable.filter((f) => f.type === 'I').length}`);
console.log(`  P/B frame-to-frame diff   ${pbMean != null ? pbMean.toFixed(3) : 'n/a'}  levels/pixel   (pbFloor)`);
console.log(`  I-frame diff              ${iMean != null ? iMean.toFixed(3) : 'no I-frame in window'}`);
if (iMean != null && pbMean) {
  const r = iMean / pbMean;
  console.log(`  iRatio                    ${r.toFixed(2)}   ${r < 1.25 ? '<= GRAIN (noise renewed every frame)'
    : r > 1.5 ? '<= COMPRESSION (noise frozen between keyframes)' : '(ambiguous)'}`);
}
console.log(`  gridRatio                 ${gridRatio != null ? gridRatio.toFixed(3) : 'n/a'}   ${
  gridRatio == null ? '' : gridRatio < 1.08 ? '<= GRAIN (no 8x8 structure)'
    : gridRatio > 1.15 ? '<= COMPRESSION (energy steps at block edges)' : '(ambiguous)'}`);
console.log('  per-frame trace:');
console.log('    ' + usable.slice(0, 40).map((f) => `${f.type}${f.diff.toFixed(1)}`).join(' '));
