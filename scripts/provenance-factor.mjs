/* IS THERE A COMMON PROVENANCE FACTOR IN THE FIELD? — the cleanest test available, and the one that
 * decides whether a blended NUMBER is possible at all.
 *
 * THE ARGUMENT. After bits and content are regressed out, each detector's residual is some mixture of
 *     provenance  +  that detector's own model error  +  measurement noise
 * The second and third terms are SPECIFIC to a detector. The first is SHARED. So: split the four
 * detectors into two halves that share no detector, build a score from each half, and correlate them
 * across films. Detector-specific error cannot produce that correlation. Only a common factor can.
 *
 * WHY THIS IS STRONGER THAN ANY CONTRAST TEST. The WEBRip and WEB-vs-Bluray contrasts depend on the
 * source LABEL being accurate, on the groups being comparable, and on n=53/150. This test uses all
 * 782 units, needs no labels at all, and asks the question the covering-set concept actually makes:
 * do independent measurements of different artifacts agree about which films are unusual?
 *
 * THE ONE ALTERNATIVE EXPLANATION, and it is serious: SHARED MODEL ERROR. If the bits+content surface
 * is misspecified in a way that misses some content property, EVERY detector's residual inherits that
 * miss and the halves correlate for a reason that has nothing to do with provenance. Three things are
 * done about it below:
 *   - the surface is flexible (quadratic in both, plus interaction), so simple curvature is absorbed
 *   - the recovered factor is correlated against content descriptors it should NOT track
 *   - the sign pattern is checked against the pre-registered re-encode signature (+,+,+,-). Shared
 *     content error has no reason to produce THAT pattern; provenance does.
 * The last point is the discriminating one. A common factor is not enough; it has to be the RIGHT
 * common factor.
 *
 * PRE-REGISTERED:
 *   split-half r > 0.3 AND PC1 signs match (+,+,+,-)  -> a real, correctly-oriented common factor
 *   r > 0.3 but signs do not match                    -> a common factor that is NOT provenance
 *                                                        (most likely shared content error)
 *   r < 0.15                                          -> no common factor; the residuals are four
 *                                                        separate model errors and no blend can work
 *
 * USAGE: node scripts/provenance-factor.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = { cambi: +1, block: +1, blur: +1, grain: -1 };

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const corr = (a, b) => {
  const ma = mean(a); const mb = mean(b);
  let n = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i += 1) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
};
const rankOf = (v) => {
  const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(v.length);
  idx.forEach(([, i], k) => { r[i] = k; });
  return r;
};
const spearman = (a, b) => corr(rankOf(a), rankOf(b));
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

/* ---------- data ---------- */
const units = JSON.parse(fs.readFileSync('data/artifact-backfill.json', 'utf8')).units;
const all = Object.entries(units).map(([key, u]) => ({ key, ...u }))
  .filter((u) => u.bpp > 0 && u.cxEff > 0 && DET.every((d) => u[d] > 0));
try {
  const w = JSON.parse(fs.readFileSync('data/provenance-wild.json', 'utf8')).units;
  const seen = new Set(all.map((u) => u.key));
  for (const [key, u] of Object.entries(w)) {
    if (!seen.has(key) && u.bpp > 0 && u.cxEff > 0 && DET.every((d) => u[d] > 0)) { all.push({ key, ...u }); seen.add(key); }
  }
} catch { /* optional */ }

const lb = all.map((u) => Math.log(u.bpp));
const lc = all.map((u) => Math.log(u.cxEff));
const X = all.map((u, i) => [1, lb[i], lb[i] ** 2, lc[i], lc[i] ** 2, lb[i] * lc[i]]);
const Z = {};   // standardised residual per detector
for (const d of DET) {
  const y = all.map((u) => Math.log(u[d]));
  const be = ols(X, y);
  const r = y.map((v, i) => v - X[i].reduce((s, z, j) => s + z * be[j], 0));
  const s = sd(r);
  Z[d] = r.map((v) => v / s);
}
const n = all.length;
console.log(`\n  ${n} units, bits+content removed, each residual standardised to unit sd\n`);

/* ---------- 1. SPLIT-HALF ACROSS DETECTORS ---------- */
/* All three ways of splitting four detectors into two pairs. Reporting only the best would be the
 * same sin as reporting max(t) over detectors, so all three are shown and the MEDIAN is the headline. */
const SPLITS = [
  [['cambi', 'blur'], ['block', 'grain']],
  [['cambi', 'block'], ['blur', 'grain']],
  [['cambi', 'grain'], ['block', 'blur']],
];
console.log('  1. SPLIT-HALF ACROSS DETECTORS — detector-specific error cannot create this correlation\n');
console.log(`  ${'half A'.padEnd(16)} ${'half B'.padEnd(16)} ${'pearson'.padStart(8)} ${'spearman'.padStart(9)} ${'S-B rel.'.padStart(9)}`);
const halfR = [];
for (const [A, B] of SPLITS) {
  /* Oriented so every detector points the same way before summing; otherwise grain cancels the rest. */
  const pa = all.map((_, i) => A.reduce((s, d) => s + EXPECT[d] * Z[d][i], 0));
  const pb = all.map((_, i) => B.reduce((s, d) => s + EXPECT[d] * Z[d][i], 0));
  const r = corr(pa, pb);
  const rs = spearman(pa, pb);
  const sb = (2 * r) / (1 + r);     // Spearman-Brown: reliability of the FULL 4-detector score
  halfR.push(r);
  console.log(`  ${A.join('+').padEnd(16)} ${B.join('+').padEnd(16)} ${r.toFixed(3).padStart(8)} ${rs.toFixed(3).padStart(9)} ${sb.toFixed(3).padStart(9)}`);
}
const medR = halfR.slice().sort((a, b) => a - b)[1];
const se = 1 / Math.sqrt(n - 3);
console.log(`\n  median split-half r = ${medR.toFixed(3)}   (SE of a correlation at n=${n} is about ${se.toFixed(3)})`);
console.log(`  implied reliability of the full 4-detector score = ${((2 * medR) / (1 + medR)).toFixed(3)}`);

/* ---------- 2. THE FACTOR ITSELF ---------- */
/* PC1 of the 4x4 correlation matrix, by power iteration. The LOADINGS are the test: a provenance
 * factor must load (+,+,+,-) on (cambi, block, blur, grain), because that is what a re-encode does. */
const C = DET.map((a) => DET.map((b) => corr(Z[a], Z[b])));
let v = [1, 1, 1, -1].map((x) => x / 2);
for (let it = 0; it < 500; it += 1) {
  const nv = C.map((row) => row.reduce((s, c, j) => s + c * v[j], 0));
  const m = Math.sqrt(nv.reduce((s, x) => s + x * x, 0));
  v = nv.map((x) => x / m);
}
const lambda = v.reduce((s, x, i) => s + x * C[i].reduce((t, c, j) => t + c * v[j], 0), 0);
console.log('\n  2. THE COMMON FACTOR (PC1 of the residual correlation matrix)\n');
console.log(`  ${'detector'.padEnd(9)} ${'loading'.padStart(8)} ${'expected'.padStart(9)}  matches?`);
let signsMatch = 0;
DET.forEach((d, i) => {
  const ok = Math.sign(v[i]) === Math.sign(EXPECT[d]);
  if (ok) signsMatch += 1;
  console.log(`  ${d.padEnd(9)} ${v[i].toFixed(3).padStart(8)} ${(EXPECT[d] > 0 ? '+' : '-').padStart(9)}  ${ok ? 'yes' : 'NO'}`);
});
console.log(`\n  eigenvalue ${lambda.toFixed(3)} of 4  ->  PC1 explains ${((lambda / 4) * 100).toFixed(1)}% `
  + `(25% would be pure noise)`);
console.log(`  sign pattern matches the pre-registered re-encode signature on ${signsMatch}/4 detectors`);

/* The score. Uses the PRE-REGISTERED direction, not PC1, so nothing is fitted to the library. PC1 is
 * reported above purely as a check that the data agrees about where the factor points. */
const P0 = all.map((_, i) => DET.reduce((s, d) => s + EXPECT[d] * Z[d][i], 0));
const P = P0.map((x) => (x - mean(P0)) / sd(P0));
console.log(`  corr(pre-registered score, PC1 score) = ${corr(P, all.map((_, i) => DET.reduce((s, d, j) => s + v[j] * Z[d][i], 0))).toFixed(3)}`);

/* ---------- 3. IS THE FACTOR PROVENANCE, OR SHARED CONTENT ERROR? ---------- */
console.log('\n  3. WHAT ELSE DOES THE FACTOR TRACK? (it should track provenance labels, not content)\n');
console.log(`  corr(P, log bpp)   ${corr(P, lb).toFixed(3).padStart(7)}   zero BY ARITHMETIC, carries no evidence`);
console.log(`  corr(P, log cx)    ${corr(P, lc).toFixed(3).padStart(7)}   zero BY ARITHMETIC, carries no evidence`);
const yr = all.map((u) => u.year || 0);
const haveYr = all.map((u, i) => i).filter((i) => yr[i] > 1900);
if (haveYr.length > 100) {
  console.log(`  corr(P, year)      ${corr(haveYr.map((i) => P[i]), haveYr.map((i) => yr[i])).toFixed(3).padStart(7)}   n=${haveYr.length}`);
}
const codecs = [...new Set(all.map((u) => u.codec).filter(Boolean))];
console.log(`\n  ${'group'.padEnd(18)} ${'n'.padStart(5)} ${'mean P'.padStart(8)}   (higher = more re-encode damage)`);
const groups = [
  ['WEBRip', (u) => /WEBRip/i.test(u.source || '')],
  ['WEB-DL', (u) => /WEBDL|WEB-DL/i.test(u.source || '')],
  ['Bluray', (u) => /Bluray|BluRay/i.test(u.source || '')],
  ...codecs.map((c) => [`codec ${c}`, (u) => u.codec === c]),
];
for (const [nm, f] of groups) {
  const g = all.map((u, i) => i).filter((i) => f(all[i]));
  if (g.length < 15) continue;
  console.log(`  ${nm.padEnd(18)} ${String(g.length).padStart(5)} ${mean(g.map((i) => P[i])).toFixed(3).padStart(8)}`);
}

/* ---------- 4. VERDICT ---------- */
console.log('\n  4. VERDICT AGAINST THE PRE-REGISTRATION\n');
const strong = medR > 0.3;
const oriented = signsMatch === 4;
let verdict;
if (medR < 0.15) verdict = 'NO COMMON FACTOR — the residuals are four separate model errors, no blend can work';
else if (strong && oriented) verdict = 'REAL, CORRECTLY-ORIENTED COMMON FACTOR — a blended number is justified';
else if (strong && !oriented) verdict = 'A COMMON FACTOR, BUT NOT THE PROVENANCE ONE — most likely shared content error';
else verdict = `WEAK (r=${medR.toFixed(2)}) — a common factor exists but explains little; any blend must be shrunk hard`;
console.log(`  ${verdict}`);

fs.writeFileSync('data/provenance-factor.json', JSON.stringify({
  generated: Date.now(), n, splitHalfR: halfR, medianR: medR,
  reliability: (2 * medR) / (1 + medR), pc1: Object.fromEntries(DET.map((d, i) => [d, v[i]])),
  eigenvalue: lambda, signsMatch,
  units: all.map((u, i) => ({ key: u.key, title: u.title, source: u.source, bppPlus: u.bppPlus, P: P[i] })),
}, null, 1));
console.log('\n  wrote data/provenance-factor.json\n');
