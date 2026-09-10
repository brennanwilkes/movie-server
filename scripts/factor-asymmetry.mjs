/* IS P AS TRUSTWORTHY UPWARD AS DOWNWARD? — measuring the asymmetry instead of imposing it.
 *
 * THE QUESTION. The shipped rule treats P symmetrically: a film at P = -2 gets the same size of boost
 * that P = +2 gets as a penalty. But the two are not the same KIND of evidence.
 *     DOWNWARD (P high)  the detectors positively SAW damage. Direct evidence.
 *     UPWARD   (P low)   the detectors saw LESS damage than predicted. That is absence of evidence
 *                        for four specific failure modes, and a file can still be bad in ways none of
 *                        these four can see — ringing, chroma bleed, bad frame-rate conversion.
 * 11.23 made the same point for the direct rule and bounded it at 28%. The honest question here is
 * whether it applies to P, and by how much.
 *
 * WHY THIS MUST BE MEASURED AND NOT ASSUMED. Adding a hand-set upward weight would be exactly the
 * kind of constant Brennan ruled out. But a DIRECTION-DEPENDENT RELIABILITY is not a constant — it is
 * a measurement, and it is one the data can supply.
 *
 * THE STATISTICAL TRAP, AND THE FIX. The obvious test — split films by P, then compute split-half
 * reliability within each group — is WRONG. P is built from both halves, so conditioning on it and
 * then correlating the halves is conditioning on a collider: range restriction alone will distort the
 * correlations, in a direction that has nothing to do with the question.
 *
 * The fix uses a standard result: selection on the PREDICTOR does not bias the regression of the
 * outcome on it. So instead of correlations, regress one detector half on the other and compare
 * SLOPES either side of zero. Selecting on half A is then harmless for the slope of B on A.
 *     b_high = slope of z_B on z_A among films with z_A > 0     (agreement about damage)
 *     b_low  = slope of z_B on z_A among films with z_A < 0     (agreement about cleanliness)
 * If b_high > b_low, the detectors corroborate each other more about damage than about cleanliness,
 * and the upward direction genuinely deserves less weight.
 *
 * Both orderings (A on B and B on A) and all three disjoint pairings are run, because a single
 * pairing could be a fluke of which detectors landed together, and reporting the most favourable one
 * would be the same sin as reporting the best detector.
 *
 * PRE-REGISTERED:
 *   b_high > b_low consistently across pairings  -> a measured asymmetry; use it as a
 *                                                   direction-dependent reliability
 *   no consistent difference                     -> the symmetric rule is correct as shipped, and
 *                                                   11.23's bound does NOT carry over to P
 *   b_low > b_high                               -> would be surprising and worth chasing before
 *                                                   anything is changed
 *
 * USAGE: node scripts/factor-asymmetry.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = { cambi: +1, block: +1, blur: +1, grain: -1 };

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
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
/* Simple slope of y on x with its standard error, so a difference between two slopes can be judged
 * rather than eyeballed. */
function slopeSE(xs, ys) {
  const n = xs.length;
  if (n < 15) return null;
  const mx = mean(xs); const my = mean(ys);
  let sxy = 0; let sxx = 0;
  for (let i = 0; i < n; i += 1) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  if (!(sxx > 0)) return null;
  const b = sxy / sxx;
  let sse = 0;
  for (let i = 0; i < n; i += 1) sse += (ys[i] - (my + b * (xs[i] - mx))) ** 2;
  return { b, se: Math.sqrt(sse / (n - 2) / sxx), n };
}

const rows = [];
const seen = new Set();
for (const f of ['data/artifact-backfill.json', 'data/provenance-wild.json']) {
  let d; try { d = JSON.parse(fs.readFileSync(f, 'utf8')).units; } catch { continue; }
  for (const [key, u] of Object.entries(d)) {
    if (!seen.has(key) && u.bpp > 0 && u.cxEff > 0 && DET.every((k) => u[k] > 0)) { rows.push({ key, ...u }); seen.add(key); }
  }
}
const lb = rows.map((u) => Math.log(u.bpp));
const lc = rows.map((u) => Math.log(u.cxEff));
const hev = rows.map((u) => (u.codec === 'hevc' ? 1 : 0));
const X = rows.map((u, i) => [1, lb[i], lb[i] ** 2, lc[i], lc[i] ** 2, lb[i] * lc[i], hev[i], hev[i] * lb[i]]);
const Z = {};
for (const d of DET) {
  const y = rows.map((u) => Math.log(u[d]));
  const be = ols(X, y);
  const r = y.map((v, i) => v - X[i].reduce((s, z, j) => s + z * be[j], 0));
  Z[d] = r.map((v) => v / sd(r));
}
console.log(`\n  ${rows.length} units, bits/content/codec removed, residuals standardised\n`);
console.log('  Slope of one detector half on the other, either side of zero.');
console.log('  Selection is on the PREDICTOR, so the slope is unbiased where a correlation would not be.\n');
console.log(`  ${'predictor'.padEnd(17)} ${'outcome'.padEnd(17)} ${'b(damage)'.padStart(10)} ${'b(clean)'.padStart(9)} `
  + `${'diff'.padStart(8)} ${'SE'.padStart(7)} ${'t'.padStart(6)}`);

const SPLITS = [
  [['cambi', 'blur'], ['block', 'grain']],
  [['cambi', 'block'], ['blur', 'grain']],
  [['cambi', 'grain'], ['block', 'blur']],
];
const diffs = [];
for (const pair of SPLITS) {
  for (const flip of [0, 1]) {
    const A = pair[flip]; const B = pair[1 - flip];
    const a = rows.map((_, i) => A.reduce((s, d) => s + EXPECT[d] * Z[d][i], 0) / Math.sqrt(A.length));
    const b = rows.map((_, i) => B.reduce((s, d) => s + EXPECT[d] * Z[d][i], 0) / Math.sqrt(B.length));
    const hi = rows.map((_, i) => i).filter((i) => a[i] > 0);
    const lo = rows.map((_, i) => i).filter((i) => a[i] < 0);
    const sHi = slopeSE(hi.map((i) => a[i]), hi.map((i) => b[i]));
    const sLo = slopeSE(lo.map((i) => a[i]), lo.map((i) => b[i]));
    if (!sHi || !sLo) continue;
    const diff = sHi.b - sLo.b;
    const se = Math.sqrt(sHi.se ** 2 + sLo.se ** 2);
    diffs.push(diff / se);
    console.log(`  ${A.join('+').padEnd(17)} ${B.join('+').padEnd(17)} ${sHi.b.toFixed(3).padStart(10)} `
      + `${sLo.b.toFixed(3).padStart(9)} ${diff.toFixed(3).padStart(8)} ${se.toFixed(3).padStart(7)} ${(diff / se).toFixed(2).padStart(6)}`);
  }
}

const pos = diffs.filter((t) => t > 0).length;
console.log(`\n  ${pos} of ${diffs.length} comparisons find the detectors agreeing MORE about damage than about cleanliness`);
console.log(`  median t = ${diffs.slice().sort((x, y) => x - y)[diffs.length >> 1].toFixed(2)}`);

console.log('\n  VERDICT');
const medT = diffs.slice().sort((x, y) => x - y)[diffs.length >> 1];
if (pos >= diffs.length - 1 && medT > 1.5) {
  console.log('  MEASURED ASYMMETRY. The detectors corroborate each other more about damage than about');
  console.log('  cleanliness, so the upward direction deserves less weight — and the amount is measured,');
  console.log('  not chosen. Implement as a direction-dependent reliability, NOT as a cap or a gate:');
  console.log('    rel_up = rel * (b_clean / b_damage)   applied smoothly, no cut-off at P = 0.');
  console.log('  NOTE the ratio is continuous but its APPLICATION has a kink at P = 0 unless it is');
  console.log('  blended; a kink is a cut-off, and 11.6 removed two of those already. Blend it.');
} else if (pos <= 1 && medT < -1.5) {
  console.log('  REVERSED — agreement is stronger about cleanliness. Surprising; chase it before acting.');
} else {
  console.log('  NO CONSISTENT ASYMMETRY at this sample size. The symmetric rule as shipped is correct,');
  console.log('  and 11.23\'s 28% upward bound does NOT carry over to P. That is a real difference');
  console.log('  between P and the direct (T/L)^k rule: the direct rule reads ABSENCE of an artifact,');
  console.log('  while P reads a file being BETTER THAN PREDICTED, which is positive evidence and not');
  console.log('  the same thing. Do not import the bound by analogy.');
}
console.log('');
