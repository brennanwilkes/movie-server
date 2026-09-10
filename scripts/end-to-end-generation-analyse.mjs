/* DOES THE SHIPPED RULE MOVE A FILE THAT IS KNOWN TO BE ONE GENERATION DOWN?
 *
 * THE PREDICTION IS ARITHMETIC AND PRE-REGISTERED. Three shipped constants multiplied:
 *     shrink * lambda * dPdGen / 2  =  0.075 * 1.533 * 0.2005 / 2  =  1.15% in score
 * There is no freedom in that number. If the rule is calibrated, a file re-encoded exactly once at
 * matched bits should lose about 1.15% of its BPP+ when pushed through the production path.
 *
 * WHY THIS HAS NEVER BEEN TESTED. Four provenance axes are validated — but every one was measured
 * with a hand-rolled per-rung composite that skips the residual surface, the standardisation, the
 * shrinkage and lambda. THEY VALIDATE DETECTORS, NOT THE RULE. Between the detectors and the score
 * sit four more steps and none of them has ever been checked end to end.
 *
 * THE PIPELINE IS REPRODUCED EXACTLY, not approximated:
 *   1. the surface is fitted on the FULL LIBRARY (1048 units), as export-provenance.js does
 *   2. z_d = (log L_d - surfaceFit) / library residual sd for that detector
 *   3. P0 = sum over detectors of EXPECT[d] * z_d, in the pre-registered direction
 *   4. P = (P0 - library mean) / library sd
 *   5. adj = BPP+ * exp(-shrink * lambda * P / 2)
 * gen0 and gen1 share bpp, cxEff and codec BY DESIGN (matched bits), so the surface term is
 * identical for both and the entire difference comes from the artifact readings. That is the point.
 *
 * *** WHAT THIS TEST DOES NOT ADDRESS. *** Both copies are measured on THE SAME CLIPS, so
 * scene-sampling noise cancels exactly. That isolates the CALIBRATION deliberately. It says nothing
 * about the per-film ORDERING, which 11.53 showed is roughly half scene sampling. A pass here must
 * not be quoted as evidence the ordering is sound; they are two different failures.
 *
 * THE DENOISE ARM is the preprocessing-dominated field contrast 11.44 says this library does not
 * contain, manufactured on real files with ground truth. It costs nothing extra once the harness
 * exists. Note it is NOT directly comparable to the generation arm in size — 11.47 measured that a
 * denoise step is not a fixed unit (dP/dstep correlates with bitrate at 0.946) — so read its SIGN
 * and its per-film consistency, not its magnitude.
 *
 * USAGE: node scripts/end-to-end-generation-analyse.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = { cambi: +1, block: +1, blur: +1, grain: -1 };
const ANCHOR = 0.356;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
function ols(X, y) {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i += 1) {
    for (let a = 0; a < p; a += 1) { b[a] += X[i][a] * y[i]; for (let c = 0; c < p; c += 1) A[a][c] += X[i][a] * X[i][c]; }
  }
  for (let c = 0; c < p; c += 1) {
    let piv = c;
    for (let r = c + 1; r < p; r += 1) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < p; r += 1) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let cc = c; cc < p; cc += 1) A[r][cc] -= f * A[c][cc];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

/* ---- the shipped surface, fitted on the full library ---- */
const lib = [];
const seen = new Set();
for (const f of ['data/artifact-backfill.json', 'data/provenance-wild.json']) {
  let d; try { d = JSON.parse(fs.readFileSync(f, 'utf8')).units; } catch { continue; }
  for (const [key, u] of Object.entries(d)) {
    if (!seen.has(key) && u.bpp > 0 && u.cxEff > 0 && DET.every((k) => u[k] > 0)) { lib.push({ key, ...u }); seen.add(key); }
  }
}
const design = (bpp, cx, codec) => {
  const lb = Math.log(bpp); const lc = Math.log(cx); const hv = codec === 'hevc' ? 1 : 0;
  return [1, lb, lb * lb, lc, lc * lc, lb * lc, hv, hv * lb];
};
const X = lib.map((u) => design(u.bpp, u.cxEff, u.codec));
const BETA = {}; const RSD = {};
for (const d of DET) {
  const y = lib.map((u) => Math.log(u[d]));
  BETA[d] = ols(X, y);
  RSD[d] = sd(y.map((v, i) => v - X[i].reduce((s, z, j) => s + z * BETA[d][j], 0)));
}
const P0lib = lib.map((u) => {
  const row = design(u.bpp, u.cxEff, u.codec);
  return DET.reduce((s, d) => {
    const fit = row.reduce((t, z, j) => t + z * BETA[d][j], 0);
    return s + EXPECT[d] * ((Math.log(u[d]) - fit) / RSD[d]);
  }, 0);
});
const MP = mean(P0lib); const SDSUM = sd(P0lib);

const prov = JSON.parse(fs.readFileSync('bpp-lab/public/provenance.json', 'utf8'));
const SHRINK = prov.shrink?.floor ?? 0.075;
const dPdGen = prov.dPdGen ?? 0.2005;
const LAMBDA = Math.log(1 + ANCHOR) / dPdGen;
const PREDICTED = (1 - Math.exp((-SHRINK * LAMBDA * dPdGen) / 2)) * 100;

/* P for an arbitrary artifact reading, at a given film's bits/content/codec. */
const Pof = (m, u) => {
  const row = design(u.bpp, u.cxEff, u.codec);
  const p0 = DET.reduce((s, d) => {
    if (!(m[d] > 0)) return s;
    const fit = row.reduce((t, z, j) => t + z * BETA[d][j], 0);
    return s + EXPECT[d] * ((Math.log(m[d]) - fit) / RSD[d]);
  }, 0);
  return (p0 - MP) / SDSUM;
};

const data = JSON.parse(fs.readFileSync('data/end-to-end-generation.json', 'utf8')).units;
const units = Object.values(data).filter((u) => u.gen0 && u.gen1 && DET.every((d) => u.gen0[d] > 0 && u.gen1[d] > 0));
console.log(`\n  ${units.length} units through the SHIPPED pipeline, gen0 vs gen1 at matched bits\n`);
console.log(`  shipped constants: shrink ${SHRINK.toFixed(4)}  lambda ${LAMBDA.toFixed(3)}  dPdGen ${dPdGen.toFixed(4)}`);
console.log(`  *** PRE-REGISTERED PREDICTION: one generation = ${PREDICTED.toFixed(2)}% drop in score ***\n`);
if (units.length < 8) { console.log('  too few units yet\n'); process.exit(0); }

console.log(`  ${'film'.padEnd(30)} ${'P gen0'.padStart(8)} ${'P gen1'.padStart(8)} ${'dP'.padStart(7)} ${'score %'.padStart(8)}`);
const rows = [];
for (const u of units) {
  const p0 = Pof(u.gen0, u); const p1 = Pof(u.gen1, u);
  const a0 = Math.exp((-SHRINK * LAMBDA * p0) / 2);
  const a1 = Math.exp((-SHRINK * LAMBDA * p1) / 2);
  const pct = (a1 / a0 - 1) * 100;
  rows.push({ t: u.title, p0, p1, dP: p1 - p0, pct, den: u.den1 ? Pof(u.den1, u) : null });
  console.log(`  ${u.title.slice(0, 29).padEnd(30)} ${p0.toFixed(3).padStart(8)} ${p1.toFixed(3).padStart(8)} `
    + `${(p1 - p0).toFixed(3).padStart(7)} ${pct.toFixed(2).padStart(8)}`);
}

const dPs = rows.map((r) => r.dP);
const pcts = rows.map((r) => r.pct);
const seMean = sd(dPs) / Math.sqrt(dPs.length);
console.log(`\n  MEASURED\n`);
console.log(`    dP per generation   mean ${mean(dPs).toFixed(4)} +- ${seMean.toFixed(4)}   median ${med(dPs).toFixed(4)}`);
console.log(`    correct sign (dP>0) ${dPs.filter((x) => x > 0).length}/${dPs.length}`);
console.log(`    score change        mean ${mean(pcts).toFixed(2)}%   median ${med(pcts).toFixed(2)}%`);
console.log(`    predicted                ${(-PREDICTED).toFixed(2)}%`);

/* The comparison that matters. dPdGen was measured on 2-second ladder clips with a hand-rolled
 * composite; this is the same quantity measured through the production path on whole-file
 * re-encodes. If they disagree, the transfer assumption open since 11.18 is the reason. */
console.log(`\n  dPdGen: ladder ${dPdGen.toFixed(4)}   end-to-end ${mean(dPs).toFixed(4)}   `
  + `ratio ${(mean(dPs) / dPdGen).toFixed(2)}x`);

console.log('\n  VERDICT AGAINST THE PRE-REGISTRATION\n');
const obs = -mean(pcts);
const ratio = obs / PREDICTED;
if (dPs.filter((x) => x > 0).length < dPs.length * 0.6) {
  console.log('  THE SIGN FAILS. A known extra generation does not reliably move P the predicted way');
  console.log('  through the production path. That falsifies the shipped rule — not the detectors,');
  console.log('  which pass on the same axis when measured directly. The chain between them is broken.');
} else if (ratio > 0.5 && ratio < 2) {
  console.log(`  CALIBRATED. Observed ${obs.toFixed(2)}% against a predicted ${PREDICTED.toFixed(2)}%.`);
  console.log('  The honest headline becomes "the adjustment is real and worth about one percent per');
  console.log('  generation" — far more defensible than +-10%, and it means the shrinkage is right and');
  console.log('  the SPREAD of the shipped rule comes from P\'s spread, not from its calibration.');
} else if (ratio >= 2) {
  console.log(`  UNDER-SHRUNK. Observed ${obs.toFixed(2)}% is ${ratio.toFixed(1)}x the predicted ${PREDICTED.toFixed(2)}%.`);
  console.log('  A real generation moves the score more than the rule says it should, so the shrinkage');
  console.log('  is too small and the estimator argument is answered in the framework\'s favour.');
  console.log('  CHECK THE EXTERNAL BOUND before adopting any larger constant.');
} else {
  console.log(`  OVER-SHRUNK or DEAD. Observed ${obs.toFixed(2)}% against predicted ${PREDICTED.toFixed(2)}%.`);
  console.log('  The signal survives the detectors but is largely lost in the chain to the score.');
}

const withDen = rows.filter((r) => r.den != null);
if (withDen.length >= 8) {
  const dd = withDen.map((r) => r.den - r.p0);
  console.log(`\n  DENOISE ARM — the preprocessing contrast the library does not naturally contain\n`);
  console.log(`    dP per denoise step  mean ${mean(dd).toFixed(4)}   median ${med(dd).toFixed(4)}`);
  console.log(`    correct sign         ${dd.filter((x) => x > 0).length}/${dd.length}`);
  console.log('    Read the SIGN and the consistency, not the size: 11.47 showed a denoise step is not');
  console.log('    a fixed unit (dP/dstep correlates with bitrate at 0.946).');
}
console.log('');
