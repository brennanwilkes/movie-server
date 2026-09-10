/* IS THE RE-WEIGHTED DIRECTION REAL, OR OVERFITTED CONTENT? — the two checks that decide it.
 *
 * WHAT PROMPTED THIS. scripts/direction-separability.mjs solved the generalized eigenproblem
 *     maximise  w' Sigma_signal w / w' Sigma_noise w
 * in the shipped z-space and found a direction with SNR 1.599 against the pre-registered
 * direction's 0.466 — reliability at 4 clips 0.651 -> 0.865. That would fix the per-film ordering
 * outright. It is also EXACTLY the kind of result this project has repeatedly had to retract, for
 * two specific reasons that must be tested rather than argued:
 *
 *   1. OVERFITTING. A 4x4 generalized eigenproblem on n=54 films will find SOME direction that
 *      looks good in-sample. The top eigenvector is fitted to this sample's noise as well as its
 *      signal. Cross-validation is the only honest check: fit the direction on one half of the
 *      films, evaluate its reliability on the OTHER half, repeat.
 *
 *   2. *** IT MAXIMISES THE WRONG THING, AND THIS IS THE DEEPER OBJECTION. *** The eigenproblem
 *      maximises between-film signal over within-film noise. "Between-film signal" is whatever
 *      varies most reliably between films AFTER bits, complexity and codec are removed — and there
 *      is no guarantee that is PROVENANCE. It could be residual content the surface failed to
 *      capture. A direction can be perfectly reliable and measure the wrong thing. Reliability is
 *      not validity.
 *
 * THE TEST FOR (2), and it uses ground truth already paid for. data/end-to-end-generation.json holds
 * 24 films where ONE GENERATION separates gen0 from gen1 by construction — same clips, same bitrate,
 * same codec, so content is held exactly fixed and only provenance moves. Project both directions
 * onto that contrast:
 *     dP_gen(w) = w . (z(gen1) - z(gen0))
 * A direction that is genuinely a provenance direction MUST respond to a real generation. One that
 * is maximising residual content will not, or will respond weakly and inconsistently.
 *
 * *** PRE-REGISTERED, before running. ***
 *   optimal responds >= pre-registered, and cross-validates    the re-weighting is real. Adopt it,
 *                                                              and the ordering blocker is solved.
 *   optimal cross-validates but does NOT respond to generation the direction is reliable and INVALID
 *                                                              — it measures content. Reject it, and
 *                                                              say plainly that reliability was
 *                                                              never the binding constraint.
 *   optimal fails cross-validation                             it was overfitting. Reject.
 * The pre-registered direction's own generation response is the benchmark; it is known to be real
 * (sign 23/23 in the end-to-end test), so it is the right thing to beat.
 *
 * READ-ONLY. Uses data/clip-reliability.json and data/end-to-end-generation.json.
 * USAGE: node scripts/direction-validate.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = [1, 1, 1, -1];
const K = 12;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const matmul = (A, B) => A.map((r) => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0)));
const transpose = (A) => A[0].map((_, j) => A.map((r) => r[j]));
function jacobiEig(Min) {
  const n = Min.length; const A = Min.map((r) => r.slice());
  const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep += 1) {
    let off = 0;
    for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) off += A[i][j] ** 2;
    if (off < 1e-18) break;
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        if (Math.abs(A[p][q]) < 1e-20) continue;
        const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1); const s = t * c;
        for (let k = 0; k < n; k += 1) { const a = A[k][p]; const b = A[k][q]; A[k][p] = c * a - s * b; A[k][q] = s * a + c * b; }
        for (let k = 0; k < n; k += 1) { const a = A[p][k]; const b = A[q][k]; A[p][k] = c * a - s * b; A[q][k] = s * a + c * b; }
        for (let k = 0; k < n; k += 1) { const a = V[k][p]; const b = V[k][q]; V[k][p] = c * a - s * b; V[k][q] = s * a + c * b; }
      }
    }
  }
  const vals = A.map((r, i) => r[i]);
  const ord = vals.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  return { vals: ord.map(([v]) => v), vecs: ord.map(([, i]) => V.map((r) => r[i])) };
}
function invSqrt(M) {
  const { vals, vecs } = jacobiEig(M);
  const D = vals.map((v) => 1 / Math.sqrt(Math.max(v, 1e-12)));
  const V = transpose(vecs);
  return matmul(V.map((r) => r.map((v, j) => v * D[j])), transpose(V));
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
  for (const r of rows) for (let a = 0; a < p; a += 1) for (let b = 0; b < p; b += 1) C[a][b] += (r[a] - m[a]) * (r[b] - m[b]);
  return C.map((r) => r.map((v) => v / Math.max(1, n - 1)));
};
const quad = (w, M) => w.reduce((s, wi, i) => s + wi * w.reduce((t, wj, j) => t + M[i][j] * wj, 0), 0);
const norm = (w) => { const n = Math.sqrt(w.reduce((s, x) => s + x * x, 0)); return w.map((x) => x / n); };

/* detector scales from the shipped provenance.json — the z denominator */
const pv = JSON.parse(fs.readFileSync('bpp-lab/public/provenance.json', 'utf8'));
const zs = Object.values(pv.units).filter((u) => u.z && DET.every((d) => Number.isFinite(u.z[d]) && u[d] > 0));
const RSD = {};
for (const d of DET) {
  const lv = zs.map((u) => Math.log(u[d])); const zv = zs.map((u) => u.z[d]);
  RSD[d] = sd(lv) / sd(zv);
}
const Z = (m) => DET.map((d) => Math.log(m[d]) / RSD[d]);

const data = JSON.parse(fs.readFileSync('data/clip-reliability.json', 'utf8'));
const units = Object.values(data.units).filter((u) => Array.isArray(u.clips) && u.clips.length >= K
  && u.bpp > 0 && u.cxEff > 0 && u.clips.slice(0, K).every((c) => DET.every((d) => c[d] > 0)));

/* fit the optimal direction on a given subset of films */
function fitDirection(subset) {
  const devs = [];
  for (const u of subset) {
    const L = u.clips.slice(0, K).map(Z);
    const m = DET.map((_, j) => mean(L.map((r) => r[j])));
    for (const r of L) devs.push(r.map((v, j) => v - m[j]));
  }
  const Sn = cov(devs);
  const means = subset.map((u) => {
    const L = u.clips.slice(0, K).map(Z);
    return DET.map((_, j) => mean(L.map((r) => r[j])));
  });
  /* Drop the codec dummy when a subset happens to contain only one codec — otherwise the design
   * matrix is singular and OLS returns null. This bites during cross-validation, where a random
   * half of 54 films can easily hold no hevc at all. */
  const hasBoth = new Set(subset.map((u) => (u.codec === 'hevc' ? 1 : 0))).size > 1;
  const X = subset.map((u) => (hasBoth
    ? [1, Math.log(u.bpp), Math.log(u.cxEff), u.codec === 'hevc' ? 1 : 0]
    : [1, Math.log(u.bpp), Math.log(u.cxEff)]));
  const res = means.map((r) => r.slice());
  for (let j = 0; j < DET.length; j += 1) {
    const y = means.map((r) => r[j]); const b = ols(X, y);
    for (let i = 0; i < res.length; i += 1) res[i][j] = y[i] - X[i].reduce((s, z, k) => s + z * b[k], 0);
  }
  const St = cov(res);
  const Ss = St.map((r, i) => r.map((v, j) => v - Sn[i][j] / K));
  const W = invSqrt(Sn);
  const eg = jacobiEig(matmul(matmul(W, Ss), W));
  const w = norm(W.map((r) => r.reduce((s, v, j) => s + v * eg.vecs[0][j], 0)));
  return { w, Sn, Ss };
}
const relOn = (w, Sn, Ss, k) => { const S = quad(w, Ss); const N = quad(w, Sn); return S <= 0 ? 0 : S / (S + N / k); };

const full = fitDirection(units);
const uSig = norm(EXPECT);
console.log(`\n  ${units.length} films.  IN-SAMPLE fit`);
console.log(`    optimal        ${DET.map((d, i) => `${d} ${full.w[i].toFixed(3)}`).join('  ')}`);
console.log(`    reliability@4  pre-registered ${relOn(uSig, full.Sn, full.Ss, 4).toFixed(3)}   `
  + `optimal ${relOn(full.w, full.Sn, full.Ss, 4).toFixed(3)}`);

/* ---- CHECK 1: cross-validation. Fit on half the films, evaluate on the other half. ---- */
let rng = 20260828;
const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
const cvOpt = []; const cvPre = []; const cosStab = [];
for (let rep = 0; rep < 200; rep += 1) {
  const idx = units.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const h = idx.length >> 1;
  const A = idx.slice(0, h).map((i) => units[i]); const B = idx.slice(h).map((i) => units[i]);
  const fa = fitDirection(A); const fb = fitDirection(B);
  cvOpt.push(relOn(fa.w, fb.Sn, fb.Ss, 4));
  cvPre.push(relOn(uSig, fb.Sn, fb.Ss, 4));
  cosStab.push(Math.abs(fa.w.reduce((s, v, i) => s + v * fb.w[i], 0)));
}
console.log(`\n  CHECK 1 — CROSS-VALIDATION (fit on half the films, score on the other half, 200 splits)\n`);
console.log(`    OUT-OF-SAMPLE reliability@4   optimal ${med(cvOpt).toFixed(3)}   pre-registered ${med(cvPre).toFixed(3)}`);
console.log(`    direction stability            cos between the two half-fits, median ${med(cosStab).toFixed(3)}`);
console.log(`    ${med(cosStab) > 0.8 ? 'The direction is STABLE across resamples.'
  : '*** THE DIRECTION IS NOT STABLE — it moves between halves, which is the signature of overfitting. ***'}`);

/* ---- CHECK 2: does it respond to a REAL generation? ---- */
const e2e = JSON.parse(fs.readFileSync('data/end-to-end-generation.json', 'utf8')).units;
const gens = Object.values(e2e).filter((u) => u.gen0 && u.gen1 && DET.every((d) => u.gen0[d] > 0 && u.gen1[d] > 0));
const proj = (w, u) => { const a = Z(u.gen0); const b = Z(u.gen1); return w.reduce((s, wi, i) => s + wi * (b[i] - a[i]), 0); };
const dOpt = gens.map((u) => proj(full.w, u));
const dPre = gens.map((u) => proj(uSig, u));
/* normalise by each direction's own noise sd so the two are comparable as SNR, not raw size */
const nOpt = Math.sqrt(quad(full.w, full.Sn)); const nPre = Math.sqrt(quad(uSig, full.Sn));
console.log(`\n  CHECK 2 — DOES IT RESPOND TO A REAL GENERATION? (n=${gens.length}, gen0 vs gen1 at matched bits)\n`);
console.log(`    ${'direction'.padEnd(16)} ${'dP/gen'.padStart(9)} ${'sign'.padStart(7)} ${'/noise sd'.padStart(11)}`);
console.log(`    ${'pre-registered'.padEnd(16)} ${mean(dPre).toFixed(4).padStart(9)} `
  + `${`${dPre.filter((x) => x > 0).length}/${dPre.length}`.padStart(7)} ${(mean(dPre) / nPre).toFixed(3).padStart(11)}`);
console.log(`    ${'optimal'.padEnd(16)} ${mean(dOpt).toFixed(4).padStart(9)} `
  + `${`${dOpt.filter((x) => x > 0).length}/${dOpt.length}`.padStart(7)} ${(mean(dOpt) / nOpt).toFixed(3).padStart(11)}`);
console.log('    Read the SIGN COUNT and the noise-normalised column. A genuine provenance direction');
console.log('    MUST move when a real generation is added; content directions need not.');

console.log('\n  VERDICT\n');
const stable = med(cosStab) > 0.8;
const cvWins = med(cvOpt) > med(cvPre) + 0.02;
const respFrac = dOpt.filter((x) => x > 0).length / dOpt.length;
if (!stable || !cvWins) {
  console.log('    REJECT THE RE-WEIGHTING — it does not survive cross-validation. The in-sample gain');
  console.log('    was the eigenproblem fitting this sample\'s noise. The pre-registered direction');
  console.log('    stands, and reliability is not improvable by re-weighting these four detectors.');
} else if (respFrac < 0.7 || mean(dOpt) / nOpt < mean(dPre) / nPre) {
  console.log('    *** RELIABLE BUT INVALID. *** The re-weighted direction cross-validates, so it is a');
  console.log('    genuinely better-measured quantity — but it does NOT respond to a known real');
  console.log('    generation as well as the pre-registered direction does. It is maximising residual');
  console.log('    CONTENT, not provenance. REJECT IT. And note what that implies: reliability was');
  console.log('    never the binding constraint on the ordering — VALIDITY is. More reliable');
  console.log('    measurement of the wrong quantity does not help.');
} else {
  console.log('    ADOPT. The re-weighted direction cross-validates AND responds to a real generation');
  console.log('    at least as well as the pre-registered one. That fixes the per-film ordering.');
}
console.log('');
