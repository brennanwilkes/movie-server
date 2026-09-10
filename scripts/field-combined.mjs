/* THE FIRST HONEST FIELD TEST — combine four near-independent detectors instead of picking the best.
 *
 * WHY THIS AND NOT ANOTHER SINGLE-DETECTOR TEST. Every field test so far asked one detector one
 * question and got t ~ 1-2, which is unpublishable on its own, and then the temptation was to report
 * whichever detector happened to look best. That is exactly how 11.19's -0.697 and 11.20's "clean eq"
 * happened. The disciplined version asks all four at once and pays the price for their correlation.
 *
 * THE CONTRAST. A WEBRip IS a re-encode of a WEB-DL — that is what the label means. So at matched
 * bits and content it must carry MORE damage. Directions are pre-registered from physics, not fitted:
 *     cambi +   block +   blur +   grain -      (a re-encode adds damage and destroys grain)
 * Bits and content are removed by regression from BOTH groups first, so this is not the matched-bpp
 * subsetting that ran out of sample in 11.18.
 *
 * WHY COMBINING IS LEGITIMATE HERE AND NOT DOUBLE-COUNTING. 2.2 measured the residual correlations
 * between detectors and they are small (0.21, 0.06, -0.05, -0.02, -0.24, 0.22). Four weak, nearly
 * independent agreements are strong evidence where one weak agreement is nothing. Stouffer's method
 * combines them, and the correlation correction below inflates the variance by the measured
 * off-diagonal sum so the dependence is PAID FOR rather than assumed away.
 *
 * THE TRAP THIS AVOIDS. Reporting max(t) over four detectors and calling it the result. With four
 * tries at alpha=0.05 the chance of one spurious hit is 19%. Stouffer uses all four including the
 * ones that disagree, so a detector pointing the wrong way COSTS evidence instead of being dropped.
 *
 * PRE-REGISTERED, written before running:
 *   combined |z| > 2.5 with correct sign  -> first field-level support for the covering set
 *   1.5 - 2.5                             -> suggestive, needs the second contrast to agree
 *   < 1.5, or wrong sign                  -> the field signal is not detectable at this sample size
 * A NULL IS INFORMATIVE HERE in a way 11.18's was not, because combining recovers the power that the
 * matched-bpp subsetting threw away.
 *
 * USAGE: node scripts/field-combined.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
/* Pre-registered from what a re-encode physically does. NOT fitted, NOT chosen after looking. */
const EXPECT = { cambi: +1, block: +1, blur: +1, grain: -1 };

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const corr = (a, b) => {
  const ma = mean(a); const mb = mean(b);
  let n = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i += 1) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
};
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
/* Normal tail, Abramowitz & Stegun 26.2.17 — good to 7 decimals, plenty for a p-value we will round. */
function pnorm(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? p : 1 - p;
}

const units = JSON.parse(fs.readFileSync('data/artifact-backfill.json', 'utf8')).units;
let all = Object.entries(units).map(([key, u]) => ({ key, ...u }))
  .filter((u) => u.bpp > 0 && u.cxEff > 0 && DET.every((d) => u[d] > 0));
/* provenance-wild.json was collected specifically to enrich the WEBRip side; merge it in, keyed so a
 * unit measured twice is not counted twice. */
try {
  const w = JSON.parse(fs.readFileSync('data/provenance-wild.json', 'utf8')).units;
  const seen = new Set(all.map((u) => u.key));
  for (const [key, u] of Object.entries(w)) {
    if (seen.has(key)) continue;
    if (u.bpp > 0 && u.cxEff > 0 && DET.every((d) => u[d] > 0)) { all.push({ key, ...u }); seen.add(key); }
  }
} catch { /* optional */ }

/* Residualise every detector against a flexible bits+content surface. Note for anyone reading a
 * downstream correlation: these residuals are orthogonal to log bpp and log cx BY ARITHMETIC, so
 * "corr(residual, bpp) = 0" is not a finding and must never be reported as one. */
const lb = all.map((u) => Math.log(u.bpp));
const lc = all.map((u) => Math.log(u.cxEff));
const X = all.map((u, i) => [1, lb[i], lb[i] ** 2, lc[i], lc[i] ** 2, lb[i] * lc[i]]);
const R = {};
for (const d of DET) {
  const y = all.map((u) => Math.log(u[d]));
  const be = ols(X, y);
  R[d] = y.map((v, i) => v - X[i].reduce((s, z, j) => s + z * be[j], 0));
}

console.log(`\n  ${all.length} units, all four detectors, bits+content removed\n`);
console.log('  RESIDUAL CORRELATION BETWEEN DETECTORS (the price paid below)');
const rho = {};
for (let i = 0; i < DET.length; i += 1) {
  for (let j = i + 1; j < DET.length; j += 1) {
    rho[`${DET[i]}/${DET[j]}`] = corr(R[DET[i]], R[DET[j]]);
  }
}
console.log(`  ${Object.entries(rho).map(([k, v]) => `${k} ${v.toFixed(2)}`).join('   ')}`);

function runContrast(label, isA, expectSign) {
  const A = []; const B = [];
  all.forEach((u, i) => (isA(u) ? A : B).push(i));
  console.log(`\n  ${'='.repeat(70)}\n  CONTRAST: ${label}`);
  console.log(`  group A ${A.length}  vs  group B ${B.length}   sign convention: A expected ${expectSign > 0 ? 'WORSE' : 'BETTER'}`);
  if (A.length < 10 || B.length < 10) { console.log('  groups too small — skipped'); return null; }
  console.log(`\n  ${'detector'.padEnd(9)} ${'diff'.padStart(8)} ${'SE'.padStart(7)} ${'t'.padStart(7)} ${'expected'.padStart(9)}  agrees?`);
  const zs = [];
  for (const d of DET) {
    const a = A.map((i) => R[d][i]); const b = B.map((i) => R[d][i]);
    const diff = mean(a) - mean(b);
    const se = Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length);
    const t = diff / se;
    /* Orient so positive always means "the pre-registered direction happened". */
    const z = t * EXPECT[d] * expectSign;
    zs.push(z);
    console.log(`  ${d.padEnd(9)} ${diff.toFixed(4).padStart(8)} ${se.toFixed(4).padStart(7)} ${t.toFixed(2).padStart(7)} `
      + `${(EXPECT[d] > 0 ? '+' : '-').padStart(9)}  ${z > 0 ? 'yes' : 'NO'}`);
  }
  /* Stouffer with a correlation correction: Var(sum z) = k + 2*sum_{i<j} rho_ij, where the rho are
   * the MEASURED residual correlations, sign-flipped to the oriented scale. */
  let offDiag = 0;
  for (let i = 0; i < DET.length; i += 1) {
    for (let j = i + 1; j < DET.length; j += 1) {
      const r = rho[`${DET[i]}/${DET[j]}`] * EXPECT[DET[i]] * EXPECT[DET[j]];
      offDiag += r;
    }
  }
  const varSum = DET.length + 2 * offDiag;
  const zc = zs.reduce((s, z) => s + z, 0) / Math.sqrt(Math.max(0.5, varSum));
  const agree = zs.filter((z) => z > 0).length;
  console.log(`\n  ${agree}/4 detectors agree with the pre-registered direction`);
  console.log(`  Stouffer z (variance inflated ${DET.length} -> ${varSum.toFixed(2)} for measured correlation) = ${zc.toFixed(2)}`);
  /* pnorm returns the UPPER tail, so the one-tailed p for "the pre-registered direction happened"
   * is pnorm(zc) directly. Writing pnorm(-zc) reports the complement and makes a hit look like a
   * miss — it did exactly that on the first run. */
  console.log(`  one-tailed p = ${pnorm(zc).toFixed(4)}`);
  const verdict = zc > 2.5 ? 'FIELD SUPPORT' : zc > 1.5 ? 'SUGGESTIVE — needs a second contrast to agree'
    : zc < -1.5 ? 'CONTRADICTED — points the wrong way' : 'NULL at this sample size';
  console.log(`  VERDICT: ${verdict}`);
  return { z: zc, agree, n: A.length };
}

/* Contrast 1, the pre-registered one. */
const c1 = runContrast('WEBRip vs everything else (a WEBRip IS a re-encode)',
  (u) => /WEBRip/i.test(u.source || ''), +1);

/* Contrast 2, INDEPENDENT of contrast 1 and pre-registered the same way. A Bluray remux or Bluray
 * encode is one generation from the disc; a WEB delivery has been through a streaming pipeline with
 * its own preprocessing. If contrast 1 is real, this should agree in the same direction. If contrast 1
 * was luck, this has no reason to. */
const c2 = runContrast('WEB (any) vs Bluray — a streaming pipeline adds a generation',
  (u) => /WEB/i.test(u.source || ''), +1);

/* Contrast 3, a NEGATIVE CONTROL. 720p vs 1080p is a resolution difference, not a provenance
 * difference. bpp already normalises pixel count, so after residualising there is no reason for the
 * pre-registered re-encode signature to appear. If it fires as strongly as the real contrasts, the
 * "signature" is not a signature and contrasts 1 and 2 mean nothing. */
const c3 = runContrast('NEGATIVE CONTROL: 720p vs 1080p (a resolution difference, not provenance)',
  (u) => /720/.test(u.source || ''), +1);

console.log(`\n  ${'='.repeat(70)}\n  SUMMARY`);
for (const [nm, c] of [['WEBRip', c1], ['WEB vs Bluray', c2], ['CONTROL 720p', c3]]) {
  if (c) console.log(`  ${nm.padEnd(16)} z ${c.z.toFixed(2).padStart(6)}   ${c.agree}/4 agree   nA=${c.n}`);
}
console.log('\n  READ IT THIS WAY: the two real contrasts should agree with each other and the negative');
console.log('  control should not fire. Any other pattern — including the control firing hardest —');
console.log('  means the residual signature is picking up something other than provenance.\n');
