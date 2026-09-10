/* CAN THE PER-FILM ORDERING BE FIXED BY RE-WEIGHTING THE DETECTORS? — the decisive analysis.
 *
 * THE BLOCKER. P is built from four detectors measured ON THE SAME 2-SECOND CLIPS, so "which scenes
 * got sampled" is a nuisance shared by all four, and it points along the signal: the within-file
 * sampling direction is (+0.633 banding, +0.528 blocking, +0.296 blur, -0.483 grain), which is the
 * same (+,+,+,-) signature an extra generation produces. With split-half halves sharing no clips,
 * 52% of the correlation disappears (0.118 -> 0.056 raw, 0.211 -> 0.106 Spearman-Brown). Two reads
 * of the same file give corr(P) = 0.693 and disagree on the adjustment by up to 13.3%, against a
 * rule whose whole span is +-10%. THE MOVERS TABLE IS NOT ACTIONABLE.
 *
 * ROUTE 1 IS ALREADY DEAD, ON ARITHMETIC. More clips: Spearman-Brown from reliability 0.106 at 12
 * clips needs k solving k*0.106/(1+(k-1)*0.106) = 0.7, i.e. k ~ 20, i.e. ~240 CLIPS PER FILM. At 2s
 * each that is 8 minutes of decode x 4 detectors x 1048 units — months. Not a route.
 *
 * ROUTE 2 IS THE ONLY LIVE ONE: find a DIRECTION in detector space that responds to provenance but
 * NOT to scene sampling. That is not a hunch, it is a generalized eigenvalue problem:
 *     maximise   w' Sigma_signal w  /  w' Sigma_noise w
 * The top generalized eigenvalue IS the best achievable signal-to-noise over all linear
 * re-weightings, and the top eigenvector is the direction that achieves it. If that eigenvalue is
 * small, NO re-weighting fixes the ordering and the answer is that P cannot be made per-film usable
 * from these four detectors — which is a real, publishable answer.
 *
 * *** THE NUMBER THAT DECIDES IT, AND IT WAS NEVER RESOLVED. *** The angle between the signal and
 * nuisance directions was reported as cos = 0.970 by one analysis and cos = 0.694 by another, the
 * difference being whitening. That was left open and it is exactly what governs separability: at
 * 0.97 the nuisance sits 14 degrees off the signal and nothing linear separates them; at 0.69 there
 * is real room. THIS SCRIPT SETTLES IT BY COMPUTING BOTH METRICS EXPLICITLY, because "the angle"
 * is not well defined without saying in which inner product.
 *
 * THE VARIANCE MODEL, stated so it can be checked:
 *   Sigma_noise   within-film, across-clip covariance of log-detector deviations. This IS the
 *                 scene-sampling nuisance, measured directly, with no assumption about its shape.
 *   Sigma_total   between-film covariance of the per-film mean log-detector values, AFTER
 *                 residualising on log bpp, log cxEff and codec — because P is a residual, so the
 *                 signal of interest is the between-film RESIDUAL covariance, not raw spread.
 *   Sigma_signal  Sigma_total - Sigma_noise/k   (removing the sampling noise carried in each film's
 *                 own k-clip mean). If this is not positive definite, there is no between-film
 *                 signal left after sampling noise is accounted for, and that is the answer.
 *
 * Reliability of a k-clip mean along direction w is then
 *     rel(w,k) = S / (S + N/k)   with S = w' Sigma_signal w, N = w' Sigma_noise w
 * which is reported for the pre-registered direction and for the optimal one, at several k.
 *
 * READ-ONLY. Uses data/clip-reliability.json (60 films x 12 clips, per-clip detector values).
 * USAGE: node scripts/direction-separability.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = [1, 1, 1, -1];                 /* the pre-registered re-encode direction */
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/* ---- small dense linear algebra, 4x4 ---- */
const matmul = (A, B) => A.map((r) => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0)));
const transpose = (A) => A[0].map((_, j) => A.map((r) => r[j]));
function jacobiEig(Min) {
  const n = Min.length;
  const A = Min.map((r) => r.slice());
  let V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep += 1) {
    let off = 0;
    for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) off += A[i][j] ** 2;
    if (off < 1e-18) break;
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        if (Math.abs(A[p][q]) < 1e-20) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1); const s = t * c;
        for (let k = 0; k < n; k += 1) {
          const akp = A[k][p]; const akq = A[k][q];
          A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k += 1) {
          const apk = A[p][k]; const aqk = A[q][k];
          A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k += 1) {
          const vkp = V[k][p]; const vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const vals = A.map((r, i) => r[i]);
  const order = vals.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  return { vals: order.map(([v]) => v), vecs: order.map(([, i]) => V.map((r) => r[i])) };
}
/* inverse square root of a symmetric positive definite matrix */
function invSqrt(M) {
  const { vals, vecs } = jacobiEig(M);
  const D = vals.map((v) => 1 / Math.sqrt(Math.max(v, 1e-12)));
  const V = transpose(vecs);                    /* columns are eigenvectors */
  const VD = V.map((r) => r.map((v, j) => v * D[j]));
  return matmul(VD, transpose(V));
}
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
const cov = (rows) => {
  const n = rows.length; const p = rows[0].length;
  const m = Array.from({ length: p }, (_, j) => mean(rows.map((r) => r[j])));
  const C = Array.from({ length: p }, () => new Array(p).fill(0));
  for (const r of rows) {
    for (let a = 0; a < p; a += 1) for (let b = 0; b < p; b += 1) C[a][b] += (r[a] - m[a]) * (r[b] - m[b]);
  }
  return C.map((r) => r.map((v) => v / Math.max(1, n - 1)));
};
const quad = (w, M) => w.reduce((s, wi, i) => s + wi * w.reduce((t, wj, j) => t + M[i][j] * wj, 0), 0);
const norm = (w) => { const n = Math.sqrt(w.reduce((s, x) => s + x * x, 0)); return w.map((x) => x / n); };

/* ---- data ---- */
const data = JSON.parse(fs.readFileSync('data/clip-reliability.json', 'utf8'));
const units = Object.values(data.units).filter((u) => Array.isArray(u.clips) && u.clips.length >= 12
  && u.bpp > 0 && u.cxEff > 0
  && u.clips.slice(0, 12).every((c) => DET.every((d) => Number.isFinite(c[d]) && c[d] > 0)));
const K = 12;
console.log(`\n  ${units.length} films x ${K} clips, 4 detectors\n`);
if (units.length < 20) { console.log('  too few\n'); process.exit(0); }

/* *** EVERYTHING BELOW IS IN THE SHIPPED z-SPACE, NOT RAW LOG SPACE. *** P is a sum of z-scores,
 * each detector's log residual divided by that detector's LIBRARY residual sd. Working in raw logs
 * gives a different geometry and a different angle — which is precisely why two incompatible values
 * (0.970 and 0.694) for the signal/nuisance angle have been floating around. An angle is not defined
 * without an inner product, and the only one that means anything here is the space P is computed in.
 * RSD is taken from the shipped provenance.json where available, else from the library fit. */
const SCALE = (() => {
  try {
    const pv = JSON.parse(fs.readFileSync('bpp-lab/public/provenance.json', 'utf8'));
    const zs = Object.values(pv.units).filter((u) => u.z && DET.every((d) => Number.isFinite(u.z[d])));
    if (zs.length > 100) {
      /* recover RSD as sd(log detector) / sd(z) per detector, using the shipped z alongside raw */
      const out = {};
      for (const d of DET) {
        const lv = zs.map((u) => Math.log(u[d])).filter(Number.isFinite);
        const zv = zs.map((u) => u.z[d]);
        const sdl = Math.sqrt(lv.reduce((s, x) => s + (x - mean(lv)) ** 2, 0) / (lv.length - 1));
        const sdz = Math.sqrt(zv.reduce((s, x) => s + (x - mean(zv)) ** 2, 0) / (zv.length - 1));
        out[d] = sdz > 0 ? sdl / sdz : 1;
      }
      return out;
    }
  } catch { /* fall through */ }
  return null;
})();
const RSD = SCALE || Object.fromEntries(DET.map((d) => [d, 1]));
console.log(`  detector scales (library residual sd, the z denominator):`);
console.log(`    ${DET.map((d) => `${d} ${RSD[d].toFixed(3)}`).join('   ')}`);
console.log(`    ${SCALE ? '(recovered from the shipped provenance.json)' : '*** NOT FOUND — using 1.0, results are in RAW LOG space and NOT comparable ***'}\n`);
const Z = (c) => DET.map((d) => Math.log(c[d]) / RSD[d]);

/* Sigma_noise: within-film across-clip deviations. This IS the scene-sampling nuisance. */
const devs = [];
for (const u of units) {
  const L = u.clips.slice(0, K).map((c) => Z(c));
  const m = DET.map((_, j) => mean(L.map((r) => r[j])));
  for (const r of L) devs.push(r.map((v, j) => v - m[j]));
}
const Snoise = cov(devs);

/* Sigma_total: between-film covariance of per-film means, RESIDUALISED on bits/content/codec,
 * because P is a residual and the signal of interest is what is left after those. */
const means = units.map((u) => {
  const L = u.clips.slice(0, K).map((c) => Z(c));
  return DET.map((_, j) => mean(L.map((r) => r[j])));
});
const X = units.map((u) => [1, Math.log(u.bpp), Math.log(u.cxEff), u.codec === 'hevc' ? 1 : 0]);
const resid = means.map((r) => r.slice());
for (let j = 0; j < DET.length; j += 1) {
  const y = means.map((r) => r[j]);
  const b = ols(X, y);
  for (let i = 0; i < resid.length; i += 1) resid[i][j] = y[i] - X[i].reduce((s, z, k) => s + z * b[k], 0);
}
const Stotal = cov(resid);
const Ssignal = Stotal.map((r, i) => r.map((v, j) => v - Snoise[i][j] / K));

console.log('  THE SCENE-SAMPLING DIRECTION (top eigenvector of Sigma_noise)\n');
const en = jacobiEig(Snoise);
const uNoise = norm(en.vecs[0].map((v) => v * Math.sign(en.vecs[0][0] || 1)));
console.log(`    ${DET.map((d, i) => `${d} ${uNoise[i].toFixed(3)}`).join('   ')}`);
console.log(`    explains ${(100 * en.vals[0] / en.vals.reduce((a, b) => a + b, 0)).toFixed(1)}% of within-film variance`);

const uSig = norm(EXPECT);
const dot = uSig.reduce((s, v, i) => s + v * uNoise[i], 0);
console.log(`\n  *** THE ANGLE, SETTLED — IT DEPENDS ON THE METRIC, WHICH IS WHY TWO VALUES EXISTED ***\n`);
console.log(`    cos in RAW z-space                    ${Math.abs(dot).toFixed(3)}   (${(180 * Math.acos(Math.min(1, Math.abs(dot))) / Math.PI).toFixed(1)} deg)`);
const W = invSqrt(Snoise);
const wS = norm(W.map((r) => r.reduce((s, v, j) => s + v * uSig[j], 0)));
const wN = norm(W.map((r) => r.reduce((s, v, j) => s + v * uNoise[j], 0)));
const dotW = wS.reduce((s, v, i) => s + v * wN[i], 0);
console.log(`    cos WHITENED by the noise covariance  ${Math.abs(dotW).toFixed(3)}   (${(180 * Math.acos(Math.min(1, Math.abs(dotW))) / Math.PI).toFixed(1)} deg)`);
console.log('    The whitened one is the one that matters: separability is governed by the angle in');
console.log('    the metric the noise defines, not in raw detector space.');

/* ---- the generalized eigenproblem: best achievable SNR over all re-weightings ---- */
const M = matmul(matmul(W, Ssignal), W);
const eg = jacobiEig(M);
const wOptWhite = eg.vecs[0];
const wOpt = norm(W.map((r) => r.reduce((s, v, j) => s + v * wOptWhite[j], 0)));

const rel = (w, k) => {
  const S = quad(w, Ssignal); const N = quad(w, Snoise);
  return S <= 0 ? 0 : S / (S + N / k);
};
console.log(`\n  BEST ACHIEVABLE OVER ALL LINEAR RE-WEIGHTINGS (top generalized eigenvalue)\n`);
console.log(`    optimal direction   ${DET.map((d, i) => `${d} ${wOpt[i].toFixed(3)}`).join('   ')}`);
console.log(`    pre-registered      ${DET.map((d, i) => `${d} ${uSig[i].toFixed(3)}`).join('   ')}`);
const cosOpt = Math.abs(wOpt.reduce((s, v, i) => s + v * uSig[i], 0));
console.log(`    cos(optimal, pre-registered) ${cosOpt.toFixed(3)}`);
console.log(`\n    SNR (signal/noise variance ratio)   optimal ${eg.vals[0].toFixed(4)}   `
  + `pre-registered ${(quad(uSig, Ssignal) / quad(uSig, Snoise)).toFixed(4)}`);

console.log(`\n  RELIABILITY OF A k-CLIP P, by direction\n`);
console.log(`    ${'k'.padStart(5)}  ${'pre-registered'.padStart(15)}  ${'optimal'.padStart(9)}`);
for (const k of [4, 6, 12, 24, 48]) {
  console.log(`    ${String(k).padStart(5)}  ${rel(uSig, k).toFixed(3).padStart(15)}  ${rel(wOpt, k).toFixed(3).padStart(9)}`);
}

console.log('\n  VERDICT\n');
const sigOK = quad(uSig, Ssignal) > 0;
if (!sigOK || eg.vals[0] <= 0) {
  console.log('    *** NO BETWEEN-FILM SIGNAL SURVIVES. *** Sigma_signal is not positive along any');
  console.log('    direction, meaning the between-film residual spread is entirely accounted for by');
  console.log('    scene-sampling noise carried in each film\'s own clip mean. No re-weighting, and no');
  console.log('    number of clips, recovers a per-film ordering from these four detectors. That is a');
  console.log('    real answer and it should be stated rather than worked around.');
} else {
  const r4o = rel(wOpt, 4); const r4p = rel(uSig, 4);
  console.log(`    A re-weighting exists and it buys ${(r4o / Math.max(r4p, 1e-9)).toFixed(2)}x the reliability at 4 clips`);
  console.log(`    (${r4p.toFixed(3)} -> ${r4o.toFixed(3)}). Whether that is ENOUGH depends on the target:`);
  console.log('    a per-film adjustment needs ~0.7 to be worth shipping.');
  let need = null;
  for (const k of [4, 6, 12, 24, 48, 96, 192, 384]) if (need === null && rel(wOpt, k) >= 0.7) need = k;
  console.log(`    clips needed to reach 0.7 on the OPTIMAL direction: ${need ?? '>384'}`);
  console.log('    CHECK cos(optimal, pre-registered) ABOVE. If it is near 1, the optimum is the');
  console.log('    direction we already ship and re-weighting buys nothing — the gain then has to');
  console.log('    come from breaking the shared sampling, not from new weights.');
}
console.log('');
