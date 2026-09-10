/* IS THE RESIDUAL SURFACE MISFITTING THE TAILS? — the second mechanism, and it needs no new data.
 *
 * THE LOOSE END. 11.41 explained most of the failed structural check by scene-sampling noise, but one
 * thing did not fit: |z_cambi| is 1.196 in the bottom cambi quartile against 0.494 in the middle, even
 * though sd(log cambi) is LEVEL-INDEPENDENT. Constant measurement noise cannot produce a residual that
 * is twice as large at one end. Something else is inflating residuals at the extremes.
 *
 * THE CANDIDATE. P is built on residuals from a surface that is QUADRATIC in log bpp and log
 * complexity plus one interaction — six terms. A low-order polynomial fits the bulk of a distribution
 * well and its tails badly, and 11.31 predicted exactly this trouble when the 266 missing units turned
 * out to be the HIGH-BITRATE END of the library. Misfit at the tails lands in the residual, is not
 * provenance, and dilutes everything downstream.
 *
 * THE TEST. Refit at increasing flexibility and watch two different things:
 *   1. Does the heteroscedasticity flatten — does |z| stop depending on the detector's own level?
 *   2. Do the DOWNSTREAM statistics improve — split-half, the WEB-vs-Bluray gap, the provenance
 *      fraction, and the 720p negative control staying silent?
 *
 * WHY BOTH, AND WHY THE SECOND IS THE REAL TEST. Adding terms ALWAYS reduces in-sample residuals; that
 * is arithmetic, not evidence, so (1) alone proves nothing. The downstream statistics are not
 * automatically improved by a better fit — a surface flexible enough to absorb genuine provenance
 * would make the gap SMALLER while making the residuals tidier. That divergence is the thing to watch
 * for, and it is why the gap is reported alongside the fit quality rather than after it.
 *
 * NO STEP FUNCTIONS. Fitting per-decile offsets would flatten the heteroscedasticity beautifully and
 * would also introduce a cut-off at every decile boundary, which 11.6 spent real effort removing. Only
 * smooth bases are tried here.
 *
 * PRE-REGISTERED READING:
 *   heteroscedasticity flattens AND gap holds or grows  -> adopt the more flexible surface
 *   heteroscedasticity flattens BUT gap shrinks         -> the extra terms are eating provenance; keep
 *                                                          the current surface and say why
 *   neither moves                                       -> misfit is not the second mechanism, and the
 *                                                          |z| pattern needs another explanation
 *
 * USAGE: node scripts/surface-flexibility.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = { cambi: +1, block: +1, blur: +1, grain: -1 };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
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
  /* Tiny ridge on the diagonal: the higher-order bases below are strongly collinear and a plain
   * solve goes singular. 1e-8 is far below any signal and only stabilises the inversion. */
  for (let c = 0; c < p; c += 1) A[c][c] += 1e-8;
  for (let c = 0; c < p; c += 1) {
    let piv = c;
    for (let r = c + 1; r < p; r += 1) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    if (Math.abs(A[c][c]) < 1e-14) return null;
    for (let r = 0; r < p; r += 1) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let cc = c; cc < p; cc += 1) A[r][cc] -= f * A[c][cc];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

const rows = [];
const seen = new Set();
for (const f of ['data/artifact-backfill.json', 'data/provenance-wild.json']) {
  let d; try { d = JSON.parse(fs.readFileSync(f, 'utf8')).units; } catch { continue; }
  for (const [key, u] of Object.entries(d)) {
    if (!seen.has(key) && u.bpp > 0 && u.cxEff > 0 && DET.every((k) => u[k] > 0)) { rows.push({ key, ...u }); seen.add(key); }
  }
}
/* Centre and scale the predictors before raising them to powers — cubing an uncentred log makes the
 * basis wildly collinear and the fit becomes about the ridge rather than the data. */
const lbRaw = rows.map((u) => Math.log(u.bpp));
const lcRaw = rows.map((u) => Math.log(u.cxEff));
const mb = mean(lbRaw); const sb = sd(lbRaw);
const mc = mean(lcRaw); const sc = sd(lcRaw);
const lb = lbRaw.map((v) => (v - mb) / sb);
const lc = lcRaw.map((v) => (v - mc) / sc);
const hev = rows.map((u) => (u.codec === 'hevc' ? 1 : 0));

const BASES = {
  'quadratic (shipped)': (i) => [1, lb[i], lb[i] ** 2, lc[i], lc[i] ** 2, lb[i] * lc[i], hev[i], hev[i] * lb[i]],
  cubic: (i) => [1, lb[i], lb[i] ** 2, lb[i] ** 3, lc[i], lc[i] ** 2, lc[i] ** 3,
    lb[i] * lc[i], lb[i] ** 2 * lc[i], lb[i] * lc[i] ** 2, hev[i], hev[i] * lb[i]],
  quartic: (i) => [1, lb[i], lb[i] ** 2, lb[i] ** 3, lb[i] ** 4, lc[i], lc[i] ** 2, lc[i] ** 3, lc[i] ** 4,
    lb[i] * lc[i], lb[i] ** 2 * lc[i], lb[i] * lc[i] ** 2, lb[i] ** 2 * lc[i] ** 2, hev[i], hev[i] * lb[i]],
};

const labelOf = (u) => (/WEBRip/i.test(u.source || '') ? 'WEBRip'
  : /WEBDL|WEB-DL/i.test(u.source || '') ? 'WEB-DL'
    : /Bluray/i.test(u.source || '') ? 'Bluray' : /HDTV/i.test(u.source || '') ? 'HDTV' : 'other');
const SPLITS = [[['cambi', 'blur'], ['block', 'grain']], [['cambi', 'block'], ['blur', 'grain']],
  [['cambi', 'grain'], ['block', 'blur']]];

console.log(`\n  ${rows.length} units\n`);
console.log(`  ${'surface'.padEnd(20)} ${'terms'.padStart(5)} ${'hetero'.padStart(8)} ${'split-h'.padStart(8)} `
  + `${'gap'.padStart(7)} ${'t'.padStart(6)} ${'provFrac'.padStart(9)} ${'720p'.padStart(7)}`);

for (const [name, basis] of Object.entries(BASES)) {
  const X = rows.map((_, i) => basis(i));
  const Z = {};
  let hetero = 0;
  for (const d of DET) {
    const y = rows.map((u) => Math.log(u[d]));
    const be = ols(X, y);
    if (!be) { console.log(`  ${name.padEnd(20)} singular`); break; }
    const r = y.map((v, i) => v - X[i].reduce((s, z, j) => s + z * be[j], 0));
    Z[d] = r.map((v) => v / sd(r));
  }
  if (Object.keys(Z).length < DET.length) continue;
  /* Heteroscedasticity: how much does |z| depend on the detector's own LEVEL? Averaged over the four
   * detectors. Zero means residual size is unrelated to level, which is what a well-fitting surface
   * with level-independent noise should give. */
  for (const d of DET) {
    const lvl = rows.map((u) => Math.log(u[d]));
    hetero += Math.abs(corr(lvl, Z[d].map(Math.abs)));
  }
  hetero /= DET.length;

  const raw = rows.map((_, i) => DET.reduce((s, d) => s + EXPECT[d] * Z[d][i], 0));
  const P = raw.map((x) => (x - mean(raw)) / sd(raw));
  const halves = SPLITS.map(([A, B]) => corr(
    rows.map((_, i) => A.reduce((s, d) => s + EXPECT[d] * Z[d][i], 0)),
    rows.map((_, i) => B.reduce((s, d) => s + EXPECT[d] * Z[d][i], 0)),
  ));
  const medR = halves.slice().sort((a, b) => a - b)[1];
  const rel = (2 * medR) / (1 + medR);
  const web = rows.map((u, i) => i).filter((i) => /WEB/i.test(rows[i].source || ''));
  const blu = rows.map((u, i) => i).filter((i) => /Bluray/i.test(rows[i].source || ''));
  const gap = mean(web.map((i) => P[i])) - mean(blu.map((i) => P[i]));
  const gapSE = Math.sqrt(sd(web.map((i) => P[i])) ** 2 / web.length + sd(blu.map((i) => P[i])) ** 2 / blu.length);
  const byLab = {};
  rows.forEach((u, i) => { (byLab[labelOf(u)] ||= []).push(P[i]); });
  const grand = mean(P);
  let ss = 0; let nn = 0;
  for (const v of Object.values(byLab)) { if (v.length < 10) continue; ss += v.length * (mean(v) - grand) ** 2; nn += v.length; }
  const frac = ss / Math.max(1, nn - 1) / (sd(P) ** 2);
  const a7 = rows.map((u, i) => i).filter((i) => /720/.test(rows[i].source || ''));
  const b1 = rows.map((u, i) => i).filter((i) => !/720/.test(rows[i].source || ''));
  const ctrl = (mean(a7.map((i) => P[i])) - mean(b1.map((i) => P[i])))
    / Math.sqrt(sd(a7.map((i) => P[i])) ** 2 / a7.length + sd(b1.map((i) => P[i])) ** 2 / b1.length);

  console.log(`  ${name.padEnd(20)} ${String(X[0].length).padStart(5)} ${hetero.toFixed(3).padStart(8)} `
    + `${rel.toFixed(3).padStart(8)} ${gap.toFixed(3).padStart(7)} ${(gap / gapSE).toFixed(2).padStart(6)} `
    + `${frac.toFixed(4).padStart(9)} ${ctrl.toFixed(2).padStart(7)}`);
}

console.log('\n  hetero = mean |corr(log level, |z|)| over the four detectors. Lower is a better fit.');
console.log('  Adding terms ALWAYS improves in-sample fit, so hetero falling is not evidence on its own.');
console.log('  THE TEST IS WHETHER THE GAP HOLDS. A surface flexible enough to absorb provenance would');
console.log('  tidy the residuals and shrink the gap at the same time — watch for that divergence.\n');
