/* VERIFY: is blurdetect's cross-sectional "null" a dead detector, or a COORDINATE MISMATCH?
 *
 * THE CLAIM UNDER TEST. 11.20 and the handoff record blurdetect as dead cross-sectionally: slope
 * -0.011 +- 0.016 against a within-film causal slope of -0.066, and the conclusion drawn was that
 * blur carries no between-film signal. A research pass proposed a sharper reading: blur is NOT dead
 * against BITS, only against the ADEQUACY AXIS, because
 *     blurdetect measures  log(bits x content)   — absolute detail delivered to the screen
 *     BPP+ measures        log(bits / content)   — adequacy
 * and those two axes are orthogonal by construction. If true, the projection of one onto the other is
 * zero as a matter of coordinates and no amount of data would ever change it.
 *
 * THE DISCRIMINATOR, and it is clean. Fit log(detector) on log bpp and log cxEff FREELY, then refit
 * forced onto each single axis:
 *   - if the detector is a SUM function, b_bpp == b_cx, and forcing onto log(bpp*cx) loses nothing
 *     while forcing onto log(bpp/cx) loses everything.
 *   - if the detector carries ADEQUACY signal, b_bpp and b_cx are opposite in sign and the reverse
 *     holds.
 * This is a stronger test than either coefficient alone because it is about the RATIO of the two.
 *
 * Standard errors are computed properly from (XtX)^-1 * s^2 rather than eyeballed, because the whole
 * claim rests on "b_bpp and b_cx are indistinguishable", which is a statement about a DIFFERENCE and
 * needs the covariance term, not two separate error bars.
 *
 * USAGE: node scripts/detail-coordinate-check.mjs
 */
import fs from 'fs';

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function inv(M) {
  const n = M.length;
  const A = M.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c += 1) {
    let piv = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    const d = A[c][c];
    for (let j = 0; j < 2 * n; j += 1) A[c][j] /= d;
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = A[r][c];
      for (let j = 0; j < 2 * n; j += 1) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((r) => r.slice(n));
}
function fit(X, y) {
  const p = X[0].length; const n = y.length;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let a = 0; a < p; a += 1) { Xty[a] += X[i][a] * y[i]; for (let c = 0; c < p; c += 1) XtX[a][c] += X[i][a] * X[i][c]; }
  }
  const V = inv(XtX);
  const b = V.map((row) => row.reduce((s, v, j) => s + v * Xty[j], 0));
  const my = mean(y);
  let ss = 0; let tt = 0;
  for (let i = 0; i < n; i += 1) {
    const f = X[i].reduce((s, z, j) => s + z * b[j], 0);
    ss += (y[i] - f) ** 2; tt += (y[i] - my) ** 2;
  }
  const s2 = ss / (n - p);
  return { b, r2: 1 - ss / tt, se: V.map((r, i) => Math.sqrt(s2 * r[i])), V, s2, n };
}

const U = []; const seen = new Set();
for (const f of ['data/artifact-backfill.json', 'data/provenance-wild.json']) {
  let d; try { d = JSON.parse(fs.readFileSync(f, 'utf8')).units; } catch { continue; }
  for (const [k, u] of Object.entries(d)) {
    if (!seen.has(k) && u.bpp > 0 && u.cxEff > 0 && ['cambi', 'block', 'blur', 'grain'].every((x) => u[x] > 0)) {
      U.push(u); seen.add(k);
    }
  }
}
console.log(`\n  n = ${U.length} units\n`);
console.log(`  ${'det'.padEnd(7)} ${'b_bpp'.padStart(9)} ${'b_cx'.padStart(9)} ${'b_bpp+b_cx'.padStart(11)} `
  + `${'SE(sum)'.padStart(8)} ${'SEs'.padStart(5)}   R2free  R2 log(b*c)  R2 log(b/c)`);
for (const det of ['blur', 'grain', 'cambi', 'block']) {
  const y = U.map((u) => Math.log(u[det]));
  const F = fit(U.map((u) => [1, Math.log(u.bpp), Math.log(u.cxEff)]), y);
  const S = fit(U.map((u) => [1, Math.log(u.bpp * u.cxEff)]), y);
  const D = fit(U.map((u) => [1, Math.log(u.bpp / u.cxEff)]), y);
  /* A SUM function has b_bpp == b_cx, i.e. their DIFFERENCE is zero. An ADEQUACY function has
   * b_bpp == -b_cx, i.e. their SUM is zero. Var of each needs the covariance term. */
  const vd = F.V[1][1] * F.s2 + F.V[2][2] * F.s2 - 2 * F.V[1][2] * F.s2;
  const vs = F.V[1][1] * F.s2 + F.V[2][2] * F.s2 + 2 * F.V[1][2] * F.s2;
  const diff = F.b[1] - F.b[2]; const sum = F.b[1] + F.b[2];
  console.log(`  ${det.padEnd(7)} ${F.b[1].toFixed(4).padStart(9)} ${F.b[2].toFixed(4).padStart(9)} `
    + `${sum.toFixed(4).padStart(11)} ${Math.sqrt(vs).toFixed(4).padStart(8)} `
    + `${(Math.abs(sum) / Math.sqrt(vs)).toFixed(1).padStart(5)}   `
    + `${F.r2.toFixed(4)}   ${S.r2.toFixed(4)}      ${D.r2.toFixed(4)}`);
  console.log(`  ${' '.repeat(7)} b_bpp - b_cx = ${diff.toFixed(4)} +- ${Math.sqrt(vd).toFixed(4)}  `
    + `(${(Math.abs(diff) / Math.sqrt(vd)).toFixed(1)} SE)   `
    + `${Math.abs(diff) / Math.sqrt(vd) < 2 ? '<- SUM function: measures bits x content, ORTHOGONAL to BPP+'
      : '<- not a pure sum function'}`);
}
console.log('\n  READ THE "SEs" COLUMN AS THE ADEQUACY TEST: it is |b_bpp + b_cx| in standard errors,');
console.log('  i.e. how far the detector is from being a pure ADEQUACY function. The line below each');
console.log('  row is the SUM test. A detector can fail both — that just means it is neither.');
console.log('');
