/* DOES P MEASURE ONE THING, OR IS IT AN INDEX OF FOUR SEPARATE THINGS? (task 95)
 *
 * THE QUESTION, AND WHY IT IS THE LAST OPEN ONE ABOUT P. P is the sum of four standardised residuals
 * in a pre-registered direction (+cambi +block +blur -grain). Everything the project says ABOUT P —
 * that it has a reliability, that it has a direction, that re-weighting it is meaningful — quietly
 * assumes the four detectors are noisy readings OF A COMMON QUANTITY. If they are instead four
 * unrelated facts that we chose to add up, P is still a legitimate composite damage score, but it is
 * an INDEX rather than a MEASUREMENT, and several sentences in the docs are wrong.
 *
 * *** TWO EXISTING RESULTS ALREADY PREDICT "INDEX". STATED HERE BEFORE THE NUMBER EXISTS, so that
 * whichever way it lands it cannot be rationalised afterwards. ***
 *   1. P's reliability is only 0.674 at 4 clips. Four noisy readings of one quantity average well;
 *      four weakly-related quantities do not.
 *   2. Re-weighting is NOT IDENTIFIED (cos 0.549 between half-sample optima). If a dominant factor
 *      existed, the optimal weights would be pinned by it. Non-identification is what you get when
 *      the covariance is nearly spherical.
 *   3. Block fires on a MEDIAN OF 0% of scenes even at 60 clips, while carrying a quarter of the
 *      weight — a detector that is silent cannot be reading a shared factor.
 * If the spectrum instead says ONE THING, one of those three needs re-explaining, and that would be
 * the interesting outcome rather than a comfortable one.
 *
 * THE STATISTIC. Eigenvalue spectrum of the 4x4 correlation matrix of the z residuals, in the
 * SIGN-ALIGNED basis (grain flipped, so the pre-registered direction is (+,+,+,+) and a common factor
 * would show as a positive manifold). For 4 variables the independence spectrum is (1,1,1,1), so
 * lambda1 is directly readable as "how much more than nothing".
 *
 * *** THE TRAP, AND IT IS THE WHOLE REASON THIS NEEDS THE 60-CLIP DATA. *** The library z's are built
 * from FOUR CLIPS PER FILM, and all four detectors read THE SAME FOUR CLIPS. If a dark quiet scene
 * happens to raise cambi and grain together, that co-movement lands in the between-film covariance and
 * looks exactly like a shared provenance factor. So the observed matrix decomposes as
 *       C_obs  =  C_true  +  W4
 * where W4 is the sampling covariance of the 4-clip statistic — pure scene-sampling nuisance, nothing
 * to do with provenance. Reading the spectrum off C_obs would OVERSTATE coherence, in the direction
 * that flatters the project. W4 is estimated from the 60-clip films and subtracted.
 *
 * W4 IS SIMULATED, NOT DERIVED. The delta-method shortcut (Var(log mean) ~ Var(log)/k) is unusable
 * here: the minimum clip-level cambi in the sample is 1.7e-9, whose log is -20, so clip-level log
 * variance is dominated by near-zero readings that the MEAN never produces. Instead each film's own 60
 * clips are resampled into 4-clip draws and the covariance of log(mean of 4) is taken directly. That
 * is the exact statistic the exporter computes, so no approximation enters.
 *
 * SCALE. W4 comes out in log-detector units; the z's are residuals divided by resSd (now emitted by
 * export-provenance.js). Dividing W4[d][e] by resSd[d]*resSd[e] puts both on one scale. Note that
 * residualising is a BETWEEN-film operation and does not touch within-film clip scatter, so no
 * correction to W4 is needed for it.
 *
 * *** PRE-REGISTERED VERDICT, WRITTEN BEFORE RUNNING. ***
 *   ONE THING   lambda1 >= 2.0 (>=50% of variance) AND all four loadings share a sign AND
 *               cos(PC1, pre-registered) >= 0.8
 *   INDEX       lambda1 < 1.5 (barely above the independence value of 1)
 *   PARTIAL     anything between, which most likely means a 2-factor structure — report which
 *               detectors pair up rather than forcing a one-factor reading
 *
 * PARTIAL-DATA STATUS. W4 is a WITHIN-film quantity, so it is safe to estimate from a partial
 * 60-clip run (BPP-PLUS trap: the band gradient is not, because the run walks bands in order).
 * Homogeneity of W4 across films is reported so that assumption is checked rather than assumed.
 *
 * READ-ONLY. Uses bpp-lab/public/provenance.json and data/visibility-60clip.json.
 * USAGE: node scripts/P-one-thing.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const FLIP = { cambi: 1, block: 1, blur: 1, grain: -1 };   /* the pre-registered direction */
const KCLIP = 4;                                            /* what the shipped backfill uses */
const NDRAW = 3000;
const NPERM = 2000;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

/* Jacobi eigendecomposition of a symmetric 4x4 — same routine used elsewhere in the project. */
function eigen(Min) {
  const n = Min.length;
  const A = Min.map((r) => r.slice());
  let V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep += 1) {
    let off = 0;
    for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) off += A[i][j] ** 2;
    if (off < 1e-14) break;
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        if (Math.abs(A[p][q]) < 1e-15) continue;
        const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
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
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => A[b][b] - A[a][a]);
  return { val: idx.map((i) => A[i][i]), vec: idx.map((i) => V.map((r) => r[i])) };
}
const cov2corr = (C) => C.map((r, i) => r.map((v, j) => v / Math.sqrt(C[i][i] * C[j][j])));

let rng = 20260828;
const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };

/* ---------- the observed between-film covariance, sign-aligned ---------- */
const pv = JSON.parse(fs.readFileSync('bpp-lab/public/provenance.json', 'utf8'));
const resSd = pv.resSd;
if (!resSd) { console.log('\n  provenance.json has no resSd — re-run scripts/export-provenance.js\n'); process.exit(1); }
const Zrows = [];
for (const u of Object.values(pv.units)) {
  if (!u.z || !DET.every((d) => Number.isFinite(u.z[d]))) continue;
  Zrows.push(DET.map((d) => FLIP[d] * u.z[d]));
}
const N = Zrows.length;
const Cobs = DET.map((_, i) => DET.map((__, j) =>
  Zrows.reduce((s, r) => s + r[i] * r[j], 0) / (N - 1)));

console.log(`\n  ${N} library units, 4 clips each; W4 estimated from the 60-clip films\n`);
console.log('  OBSERVED BETWEEN-FILM CORRELATION (sign-aligned; nuisance still in it)\n');
const Robs = cov2corr(Cobs);
console.log(`         ${DET.map((d) => d.padStart(7)).join('')}`);
DET.forEach((d, i) => console.log(`    ${d.padEnd(6)} ${Robs[i].map((v) => v.toFixed(3).padStart(7)).join('')}`));

/* ---------- W4: the scene-sampling nuisance, simulated ---------- */
let vis = null;
try { vis = JSON.parse(fs.readFileSync('data/visibility-60clip.json', 'utf8')); } catch { /* */ }
const films = vis ? Object.values(vis.units).filter((u) => Array.isArray(u.clips) && u.clips.length >= 50) : [];
if (films.length < 5) {
  console.log('\n  data/visibility-60clip.json has fewer than 5 finished films — cannot estimate the');
  console.log('  nuisance term. The observed spectrum below is an UPPER bound on coherence.\n');
}
const perFilm = [];
for (const f of films) {
  const V = DET.map((d) => f.clips.map((c) => c[d]));
  const n = V[0].length;
  const draws = DET.map(() => []);
  for (let t = 0; t < NDRAW; t += 1) {
    const pick = [];
    for (let i = 0; i < KCLIP; i += 1) pick.push(Math.floor(rand() * n));
    DET.forEach((d, di) => {
      const m = mean(pick.map((p) => V[di][p]));
      draws[di].push(Math.log(Math.max(m, 1e-12)));
    });
  }
  const mu = draws.map((a) => mean(a));
  const C = DET.map((_, i) => DET.map((__, j) =>
    draws[i].reduce((s, _v, t) => s + (draws[i][t] - mu[i]) * (draws[j][t] - mu[j]), 0) / (NDRAW - 1)));
  perFilm.push(C);
}
const W4log = DET.map((_, i) => DET.map((__, j) => (perFilm.length ? med(perFilm.map((C) => C[i][j])) : 0)));
/* into z units, and sign-aligned the same way as the z's */
const W4 = DET.map((_, i) => DET.map((__, j) =>
  (FLIP[DET[i]] * FLIP[DET[j]] * W4log[i][j]) / (resSd[DET[i]] * resSd[DET[j]])));

if (perFilm.length) {
  console.log(`\n  SCENE-SAMPLING NUISANCE W4, from ${perFilm.length} films (median across films, z units)\n`);
  console.log(`         ${DET.map((d) => d.padStart(7)).join('')}`);
  DET.forEach((d, i) => console.log(`    ${d.padEnd(6)} ${W4[i].map((v) => v.toFixed(3).padStart(7)).join('')}`));
  console.log('\n    share of each detector\'s observed between-film variance that is NOT provenance:');
  DET.forEach((d, i) => {
    const sh = W4[i][i] / Cobs[i][i];
    console.log(`      ${d.padEnd(6)} ${(100 * sh).toFixed(1).padStart(5)}%  `
      + `${sh > 0.5 ? '<- MORE THAN HALF OF IT IS SCENE SAMPLING' : ''}`);
  });
  /* homogeneity: is one W4 defensible for the whole library? */
  console.log('\n    homogeneity across films (variance term, ratio p90/p10):');
  DET.forEach((d, i) => {
    const v = perFilm.map((C) => C[i][i]).sort((a, b) => a - b);
    const lo = v[Math.floor(0.1 * (v.length - 1))]; const hi = v[Math.floor(0.9 * (v.length - 1))];
    console.log(`      ${d.padEnd(6)} ${(hi / Math.max(lo, 1e-12)).toFixed(1)}x`);
  });
}

/* ---------- spectra ---------- */
function report(C, label) {
  const R = cov2corr(C);
  const e = eigen(R);
  const tot = e.val.reduce((s, v) => s + v, 0);
  console.log(`\n  ${label}\n`);
  console.log(`    eigenvalues  ${e.val.map((v) => v.toFixed(3).padStart(6)).join('')}`);
  console.log(`    % variance   ${e.val.map((v) => (100 * v / tot).toFixed(1).padStart(6)).join('')}`);
  const pc1 = e.vec[0];
  const sgn = pc1.reduce((s, v) => s + v, 0) < 0 ? -1 : 1;
  const L = pc1.map((v) => v * sgn);
  console.log(`    PC1 loadings ${L.map((v) => v.toFixed(3).padStart(6)).join('')}   (${DET.join(' ')})`);
  const pre = DET.map(() => 0.5);            /* (+,+,+,+) normalised, in the sign-aligned basis */
  const cos = L.reduce((s, v, i) => s + v * pre[i], 0)
    / Math.sqrt(L.reduce((s, v) => s + v * v, 0) * pre.reduce((s, v) => s + v * v, 0));
  console.log(`    cos(PC1, pre-registered direction)  ${cos.toFixed(3)}`);
  console.log(`    communality (var of each detector explained by PC1):`);
  DET.forEach((d, i) => console.log(`      ${d.padEnd(6)} ${(100 * L[i] ** 2 * e.val[0]).toFixed(1).padStart(5)}%`));
  return { val: e.val, L, cos, tot };
}
const obs = report(Robs, 'SPECTRUM AS OBSERVED (nuisance included — an UPPER bound on coherence)');

let tru = null;
if (perFilm.length >= 5) {
  const Ctrue = DET.map((_, i) => DET.map((__, j) => Cobs[i][j] - W4[i][j]));
  const bad = DET.some((_, i) => !(Ctrue[i][i] > 0));
  if (bad) {
    console.log('\n  NUISANCE-CORRECTED MATRIX IS NOT POSITIVE ON THE DIAGONAL — W4 exceeds the observed');
    console.log('  variance for at least one detector. That is itself a finding: the between-film');
    console.log('  spread of that detector is entirely scene sampling. Not decomposed further here.');
    DET.forEach((d, i) => console.log(`      ${d.padEnd(6)} Cobs ${Cobs[i][i].toFixed(3)}  W4 ${W4[i][i].toFixed(3)}`));
  } else {
    tru = report(Ctrue, 'SPECTRUM WITH SCENE SAMPLING REMOVED  *** THIS IS THE ONE THAT ANSWERS THE QUESTION ***');
  }
}

/* ---------- HOW SENSITIVE IS THE VERDICT TO W4? ----------
 * W4 is estimated from 19 band-restricted films and its per-film spread is 4-14x, so it is the
 * weakest input here. Rather than caveating that in prose, the correction is simply rescaled and the
 * verdict re-read. If the answer survives 0x to 2x, the imprecision does not matter. */
if (perFilm.length >= 5) {
  console.log('\n  SENSITIVITY OF THE VERDICT TO W4 (its per-film spread is 4-14x, so this matters)\n');
  for (const k of [0, 0.5, 1, 1.5, 2]) {
    const C = DET.map((_, i) => DET.map((__, j) => Cobs[i][j] - k * W4[i][j]));
    if (DET.some((_, i) => !(C[i][i] > 0))) {
      const worst = DET[DET.findIndex((_, i) => !(C[i][i] > 0))];
      console.log(`    W4 x${k.toFixed(1)}   impossible — ${worst}'s between-film variance goes negative,`
        + ` so W4 cannot be this large`);
      continue;
    }
    const l = eigen(cov2corr(C)).val[0];
    console.log(`    W4 x${k.toFixed(1)}   lambda1 ${l.toFixed(3)}   `
      + `${l >= 2.0 ? 'ONE THING' : l < 1.5 ? 'INDEX' : 'PARTIAL'}`);
  }
}

/* ---------- the independence null, at this n ----------
 * Shuffling each column independently destroys every cross-detector relation while preserving the
 * marginals exactly. Column means are invariant under shuffling, so they are hoisted out and the
 * columns pre-centred — recomputing them inside the loop made this O(n^2) per shuffle. */
let hi = 0;
const target = (tru ? tru.val[0] : obs.val[0]);
const cen = DET.map((_, i) => { const c = Zrows.map((r) => r[i]); const m = mean(c); return c.map((v) => v - m); });
const scratch = cen.map((c) => c.slice());
for (let t = 0; t < NPERM; t += 1) {
  for (let i = 0; i < 4; i += 1) {
    const a = scratch[i];
    for (let k = 0; k < N; k += 1) a[k] = cen[i][k];
    for (let k = N - 1; k > 0; k -= 1) { const j = Math.floor(rand() * (k + 1)); const tmp = a[k]; a[k] = a[j]; a[j] = tmp; }
  }
  const C = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let k = 0; k < N; k += 1) {
    for (let i = 0; i < 4; i += 1) for (let j = i; j < 4; j += 1) C[i][j] += scratch[i][k] * scratch[j][k];
  }
  for (let i = 0; i < 4; i += 1) for (let j = i; j < 4; j += 1) { C[i][j] /= (N - 1); C[j][i] = C[i][j]; }
  if (eigen(cov2corr(C)).val[0] >= target) hi += 1;
}
console.log(`\n  INDEPENDENCE NULL — lambda1 from ${NPERM} column-shuffles at n=${N}`);
console.log(`    reached the observed lambda1 of ${target.toFixed(3)} in ${hi}/${NPERM} shuffles`);
console.log('    (this separates "weak but REAL" from "nothing" — a low count does NOT argue against');
console.log('    the INDEX verdict, which is about the SIZE of the factor, not its existence)');

/* ---------- verdict against the pre-registration ---------- */
const use = tru || obs;
const l1 = use.val[0];
const sameSign = use.L.every((v) => v > 0) || use.L.every((v) => v < 0);
console.log(`\n  VERDICT (pre-registered: ONE THING at lambda1>=2.0 + same sign + cos>=0.8; INDEX at <1.5)\n`);
console.log(`    lambda1 ${l1.toFixed(3)}   same-sign ${sameSign}   cos ${use.cos.toFixed(3)}`
  + `   ${tru ? '(nuisance-corrected)' : '(NOT nuisance-corrected — provisional)'}`);
if (l1 >= 2.0 && sameSign && use.cos >= 0.8) {
  console.log('\n    ONE THING. A dominant factor exists, all four detectors load on it with a common');
  console.log('    sign, and it points where the physics said it would. P is a MEASUREMENT of that');
  console.log('    factor. This CONTRADICTS the three predictions in this file\'s header — the low');
  console.log('    reliability, the unidentified re-weighting and block\'s silence now need another');
  console.log('    explanation. Do not let the pass paper over them.');
} else if (l1 < 1.5) {
  console.log('\n    INDEX, NOT A MEASUREMENT. There is no dominant factor: the four detectors are close');
  console.log('    to four separate facts that we chose to add up. This is NOT a failure — a composite');
  console.log('    damage score is legitimate and P still carries the field contrasts. But the docs');
  console.log('    must stop calling it "the provenance FACTOR" as though a latent quantity were being');
  console.log('    estimated, the 0.674 reliability is then EXPECTED rather than disappointing, and');
  console.log('    re-weighting is unidentifiable BY CONSTRUCTION rather than for want of data.');
} else {
  console.log('\n    PARTIAL — most likely a two-factor structure rather than one. Read the loadings and');
  console.log('    the second eigenvalue above and say WHICH detectors pair, rather than forcing a');
  console.log('    one-factor reading onto it.');
  console.log(`    lambda2 is ${use.val[1].toFixed(3)} (${(100 * use.val[1] / use.tot).toFixed(1)}% of variance).`);
}
console.log('');
