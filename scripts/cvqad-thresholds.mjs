/* DERIVE VISIBILITY THRESHOLDS FOR BLOCKING, BLUR AND GRAIN FROM REAL SUBJECTIVE LABELS.
 *
 * This is the payoff of the CVQAD run and it was missing — cvqad-calibrate.js was extended to MEASURE
 * blockdetect/blurdetect/grain on all 248 clips but its analysis section still only tested the banding
 * residual, so the thresholds the whole exercise exists for were never extracted.
 *
 * WHY WE NEED THEM. m_a = (T_a / L_a)^(1/S_a) cannot be computed without T_a. Banding has one — CAMBI's
 * published 2.817 — and it is the ONLY artifact we can currently convert into bitrate units. Blocking
 * is our most reliable detector (split-half 0.922) and is unreadable for want of a number.
 *
 * THE CONSTRUCTION, which introduces no new arbitrary choice. Rather than inventing an "acceptable"
 * subjective level, anchor to the one threshold we already trust:
 *
 *   1. Fit label ~ log(cambi) with SEQUENCE FIXED EFFECTS. Read off the label offset a viewer suffers
 *      when banding sits exactly at 2.817 — call it L*, the subjective cost of just-visible banding.
 *   2. Fit label ~ log(block) with the same fixed effects, and invert it at L*.
 *      T_block is then "the blocking level that costs a viewer as much as just-visible banding does".
 *
 * Same footing, same corpus, same labels, and the only constant that enters is 2.817, which is
 * Netflix's, not ours.
 *
 * FIXED EFFECTS ARE NOT OPTIONAL. Pooled correlations on this corpus are dominated by between-sequence
 * content differences and that confound has invalidated two earlier tests in this project. Every fit
 * here is within-sequence.
 *
 * BRADLEY-TERRY IS PRIMARY. It comes from forced-choice pairs, so it measures a difference. Unpaired
 * MOS is reported as a cross-check only — it is the design that invalidated the 2026-08-13 blind test.
 *
 * USAGE: node scripts/cvqad-thresholds.mjs
 */
import fs from 'fs';

const D = JSON.parse(fs.readFileSync('/data/research/cvqad/measured.json', 'utf8'));
const rows = Object.values(D).filter((r) => r.bpp > 0 && r.seq);
const num = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '   -');

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function demean(vals, keys) {
  const acc = new Map();
  vals.forEach((v, i) => {
    const a = acc.get(keys[i]) || { s: 0, n: 0 };
    a.s += v; a.n += 1; acc.set(keys[i], a);
  });
  return { out: vals.map((v, i) => v - acc.get(keys[i]).s / acc.get(keys[i]).n), acc };
}
const pearson = (a, b) => {
  const n = a.length; const ma = mean(a); const mb = mean(b);
  let sa = 0; let sb = 0; let s = 0;
  for (let i = 0; i < n; i += 1) { sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; s += (a[i] - ma) * (b[i] - mb); }
  return sa && sb ? s / Math.sqrt(sa * sb) : NaN;
};
// Slope through demeaned data == the within-sequence (fixed-effects) slope.
const slope = (x, y) => {
  const mx = mean(x); const my = mean(y);
  let sxx = 0; let sxy = 0;
  for (let i = 0; i < x.length; i += 1) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  return sxx ? sxy / sxx : NaN;
};

const DETECTORS = ['cambi', 'block', 'blur', 'grain'];
const LABELS = [['Bradley-Terry', 'bt'], ['MOS', 'mos']];

for (const [labName, labKey] of LABELS) {
  const set = rows.filter((r) => r[labKey] != null);
  console.log(`\n=== ${labName} — within-sequence, n=${set.length}, ${new Set(set.map((r) => r.seq)).size} sequences ===\n`);
  console.log(`  ${'detector'.padEnd(9)} ${'n'.padStart(4)} ${'within r'.padStart(9)} ${'d(label)/d(log X)'.padStart(18)}   interpretation`);

  const fits = {};
  for (const det of DETECTORS) {
    const use = set.filter((r) => r[det] > 0);
    if (use.length < 30) { console.log(`  ${det.padEnd(9)} ${String(use.length).padStart(4)}   too few`); continue; }
    const keys = use.map((r) => r.seq);
    const x = demean(use.map((r) => Math.log(r[det])), keys).out;
    const y = demean(use.map((r) => r[labKey]), keys).out;
    const r = pearson(x, y);
    const b = slope(x, y);
    fits[det] = { b, r, n: use.length, use };
    const note = det === 'grain'
      ? (b > 0 ? 'more grain kept = better, as expected' : 'WRONG SIGN — more grain reads as worse')
      : (b < 0 ? 'more artifact = worse, as expected' : 'WRONG SIGN');
    console.log(`  ${det.padEnd(9)} ${String(use.length).padStart(4)} ${num(r).padStart(9)} ${num(b, 4).padStart(18)}   ${note}`);
  }

  /* THE ANCHOR. How much label does just-visible banding cost? Within a sequence the fit is
   * label = b_c * (log cambi - mean log cambi), so the offset at cambi = 2.817 is measured relative
   * to that sequence's own mean — averaged over sequences to get one number. */
  if (!fits.cambi) continue;
  const cUse = fits.cambi.use;
  const cAcc = demean(cUse.map((r) => Math.log(r.cambi)), cUse.map((r) => r.seq)).acc;
  const offsets = [...cAcc.values()].map((a) => Math.log(2.817) - a.s / a.n);
  const Lstar = fits.cambi.b * mean(offsets);
  console.log(`\n  banding at its 2.817 threshold costs  ${num(Lstar)} of ${labName} score`);

  for (const det of ['block', 'blur', 'grain']) {
    if (!fits[det]) continue;
    const f = fits[det];
    const acc = demean(f.use.map((r) => Math.log(r[det])), f.use.map((r) => r.seq)).acc;
    const meanLog = mean([...acc.values()].map((a) => a.s / a.n));
    // Invert: what value of this detector costs the same L* ?
    const T = Math.exp(meanLog + Lstar / f.b);
    const span = f.use.map((r) => r[det]).sort((p, q) => p - q);
    const inRange = T >= span[0] && T <= span[span.length - 1];
    console.log(`  => T_${det.padEnd(6)} = ${num(T).padStart(9)}   `
      + `(corpus spans ${num(span[0])} .. ${num(span[span.length - 1])})`
      + `${inRange ? '' : '   EXTRAPOLATED — outside the measured range, do not ship'}`
      + `${Math.abs(f.r) < 0.15 ? '   AND the detector barely predicts the label' : ''}`);
  }
}

/* SANITY: our library's own blocking readings, so a threshold can be judged against what films
 * actually read rather than against nothing. A T_block below everything or above everything is not
 * a threshold, it is a constant that would move every film or none. */
try {
  const lads = JSON.parse(fs.readFileSync('bpp-lab/public/ladders.json', 'utf8')).films;
  const at1 = lads.map((f) => f.blockAt1).filter((v) => v > 0).sort((a, b) => a - b);
  console.log(`\n\nOUR LIBRARY, blockMean at level 1.0 across ${at1.length} ladder films:`);
  console.log(`  p05 ${num(at1[Math.floor(at1.length * 0.05)])}  p25 ${num(at1[Math.floor(at1.length * 0.25)])}  `
    + `median ${num(at1[Math.floor(at1.length / 2)])}  p75 ${num(at1[Math.floor(at1.length * 0.75)])}  `
    + `p95 ${num(at1[Math.floor(at1.length * 0.95)])}  max ${num(at1[at1.length - 1])}`);
} catch { /* lab file optional */ }
