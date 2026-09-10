/* TASK 105 — DOES BLUR BELONG IN P? ASKED AS A WEIGHT, NOT AS A FLAG.
 *
 * WHY THIS WAS NEVER ASKED. blur carries a quarter of P's weight purely because the pre-registered
 * direction was written as (+cambi +block +blur -grain) on physics grounds and nobody went back to
 * check. Since then blur has looked worse and worse: orthogonal to the other three (mean r 0.045,
 * PC1 communality 5.5%), 0.3% of the adequacy blend (9.0h), orthogonal to the adequacy axis BY
 * CONSTRUCTION (E.8.1), reliability 0.404 — the worst of the four — and 55.5% of its between-film
 * variance is scene sampling. Every one of those is a reason to suspect the weight; none of them is
 * a test of it.
 *
 * *** THE DIMENSION TRAP, AND WHY THIS IS NOT "RUN THE ARBITER ON THREE DETECTORS". *** The obvious
 * test is to rebuild P from cambi/block/grain and re-run structural-recheck. That comparison is
 * INVALID. The arbiter's null is random directions in the detector space, and the geometry of a
 * random direction in 3-space is not the geometry of one in 4-space — the counts are not on the same
 * scale, so "3-detector scored better" would be partly an artifact of the sphere it was drawn on.
 *
 * SO THE QUESTION IS ASKED INSIDE ONE FIXED SPACE. Hold (+cambi +block -grain) and sweep blur's
 * weight continuously through w in [-1, +1], evaluating the SAME joint statistic against the SAME
 * 4-dimensional null. This also matches the standing design rule: the output is a WEIGHT, and no
 * value of w is excluded by a cut-off. w = 0 is simply one point on a continuum, not a special case.
 *
 * *** PRE-REGISTERED READING, WRITTEN BEFORE THE NUMBERS EXIST. ***
 *   w_opt >= 0.50            blur belongs at roughly its shipped weight; task 105 closes, no change.
 *   0.25 <= w_opt < 0.50     blur belongs but is OVER-weighted; P should be re-weighted, not cut.
 *   |w_opt| < 0.25           blur contributes nothing; P is a 3-detector construct.
 *   w_opt <= -0.25           blur is ACTIVELY WRONG-SIGNED — it would contradict the physics that
 *                            put it in the direction, and that is a finding about P, not about blur.
 * Secondary, and it decides whether a null result is real: the permutation count at w_opt against
 * the count at the shipped w = 1. A weight change that does not improve the count is not a finding.
 *
 * *** THE ATTENUATION CORRECTION IS MANDATORY BEFORE ANY "BLUR IS NOISE" CONCLUSION. *** blur's
 * reliability is 0.404, so a weight fitted on the OBSERVED blur is attenuated toward zero relative
 * to the weight the true construct deserves: w_true ~ w_obs / r. A measured w_opt of 0.2 is
 * w_true 0.50 — which lands in "belongs, at its shipped weight". So the low-reliability detector
 * CANNOT be dismissed on a raw optimum, and the raw and corrected numbers are both reported.
 *
 * READ-ONLY. Uses bpp-lab/public/provenance.json and data/encoder-fingerprint.json, exactly as
 * scripts/structural-recheck.mjs does, so the statistic is the arbiter's and not a new one.
 * USAGE: node scripts/blur-weight-profile.mjs [--n 20000]
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const BLUR = 2;
const SHIPPED = [1, 1, 1, -1];
const R_BLUR = 0.404;                       /* E.11 / task 81 — the worst-sampled of the four */
const NPERM = Number((process.argv.find((a, i) => process.argv[i - 1] === '--n')) || 20000);

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
    if (Math.abs(A[c][c]) < 1e-10) A[c][c] = 1e-10;
    for (let r = 0; r < p; r += 1) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let cc = c; cc < p; cc += 1) A[r][cc] -= f * A[c][cc];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}
function adjR2(X, y) {
  const b = ols(X, y); const my = mean(y);
  let ss = 0; let tt = 0;
  for (let i = 0; i < y.length; i += 1) {
    const f = X[i].reduce((s, z, j) => s + z * b[j], 0);
    ss += (y[i] - f) ** 2; tt += (y[i] - my) ** 2;
  }
  const n = y.length; const p = X[0].length; const R = 1 - ss / tt;
  return 1 - (1 - R) * ((n - 1) / (n - p));
}

const pv = JSON.parse(fs.readFileSync('bpp-lab/public/provenance.json', 'utf8'));
const fp = JSON.parse(fs.readFileSync('data/encoder-fingerprint.json', 'utf8')).units;

const rows = [];
for (const [key, u] of Object.entries(pv.units)) {
  if (!u.z || !DET.every((d) => Number.isFinite(u.z[d]))) continue;
  rows.push({ key, z: DET.map((d) => u.z[d]), source: u.source || '', f: fp[key] || {} });
}
const web = rows.map((_, i) => i).filter((i) => /WEB/i.test(rows[i].source));
const blu = rows.map((_, i) => i).filter((i) => /Bluray/i.test(rows[i].source));
const withEnc = rows.map((_, i) => i).filter((i) => {
  const f = rows[i].f;
  return f.family && f.build > 0 && f.ref != null && f.bframes != null && f.subme != null;
});
const lv = (k) => [...new Set(withEnc.map((i) => String(rows[i].f[k] ?? 'na')))].sort();
const ME = lv('me'); const RC = lv('rc'); const DB = lv('deblock');
const psy1 = (v) => (v ? Number(String(v).split(':')[0]) || 0 : 0);
const Xenc = withEnc.map((i) => {
  const f = rows[i].f;
  return [1, Math.log(f.build), f.ref, f.bframes, f.subme, f.trellis ?? 0, psy1(f.psyrd),
    ...ME.slice(1).map((v) => (String(f.me) === v ? 1 : 0)),
    ...RC.slice(1).map((v) => (String(f.rc) === v ? 1 : 0)),
    ...DB.slice(1).map((v) => (String(f.deblock) === v ? 1 : 0))];
});

function stats(w) {
  const P = rows.map((r) => r.z.reduce((s, v, i) => s + w[i] * v, 0));
  const s = sd(P);
  if (!(s > 0)) return { gap: -1e9, enc: -1e9 };
  return {
    gap: (mean(web.map((i) => P[i])) - mean(blu.map((i) => P[i]))) / s,
    enc: adjR2(Xenc, withEnc.map((i) => P[i] / s)),
  };
}

console.log(`\n  ${rows.length} units;  ${web.length} WEB, ${blu.length} Bluray;  ${withEnc.length} with encoder identity\n`);

/* One shared null, drawn ONCE, so every w on the profile is scored against identical draws.
 * Re-drawing per w would let sampling noise masquerade as curvature in the profile. */
let rng = 424242;
const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
const gauss = () => { let u = 0; let v = 0; while (u === 0) u = rand(); while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const NULLS = [];
for (let t = 0; t < NPERM; t += 1) {
  const w = [gauss(), gauss(), gauss(), gauss()];
  const n = Math.sqrt(w.reduce((s, x) => s + x * x, 0));
  NULLS.push(stats(w.map((x) => x / n)));
}
const countBoth = (b) => NULLS.reduce((s, st) => s + ((st.gap >= b.gap && st.enc >= b.enc) ? 1 : 0), 0);

console.log('  BLUR WEIGHT PROFILE — (+cambi +block -grain) held, blur swept\n');
console.log(`    ${'w_blur'.padStart(7)} ${'gap'.padStart(8)} ${'encR2'.padStart(8)} ${'beat BOTH'.padStart(11)}`);
const prof = [];
for (let w = -1; w <= 1.0001; w += 0.05) {
  const ww = Math.round(w * 100) / 100;
  const dir = [1, 1, ww, -1];
  const st = stats(dir);
  const c = countBoth(st);
  prof.push({ w: ww, ...st, c });
  if (Math.abs(ww * 20 - Math.round(ww * 20)) < 1e-9 && Math.round(ww * 100) % 10 === 0) {
    console.log(`    ${ww.toFixed(2).padStart(7)} ${st.gap.toFixed(4).padStart(8)} ${st.enc.toFixed(4).padStart(8)}`
      + ` ${String(c).padStart(6)}/${NPERM}${ww === 1 ? '   <- SHIPPED' : ''}`);
  }
}

/* The optimum is the weight that MINIMISES how many random directions beat it. Ties broken toward
 * the shipped value, so a flat profile cannot manufacture a change. */
let best = prof[0];
for (const p of prof) if (p.c < best.c || (p.c === best.c && Math.abs(p.w - 1) < Math.abs(best.w - 1))) best = p;
const shipped = prof.find((p) => p.w === 1);

console.log('\n  RESULT\n');
console.log(`    shipped   w_blur = 1.00   ->  ${shipped.c}/${NPERM} beat it on both contrasts`);
console.log(`    optimum   w_blur = ${best.w.toFixed(2)}   ->  ${best.c}/${NPERM}`);
const flat = prof.filter((p) => p.c <= shipped.c);
console.log(`    weights at least as good as shipped: w in [${Math.min(...flat.map((p) => p.w)).toFixed(2)},`
  + ` ${Math.max(...flat.map((p) => p.w)).toFixed(2)}]  (${flat.length} of ${prof.length} grid points)`);

console.log('\n  ATTENUATION CORRECTION — mandatory before reading a low optimum as "blur is noise"\n');
const wTrue = best.w / R_BLUR;
console.log(`    blur reliability ${R_BLUR}  ->  w_true ~ w_obs / r = ${best.w.toFixed(2)} / ${R_BLUR} = ${wTrue.toFixed(2)}`);

console.log('\n  VERDICT AGAINST THE PRE-REGISTRATION\n');
const band = (w) => (w >= 0.5 ? 'BELONGS at its shipped weight — task 105 closes, no change'
  : w >= 0.25 ? 'BELONGS but is OVER-WEIGHTED — re-weight P, do not cut blur'
    : w > -0.25 ? 'CONTRIBUTES NOTHING — P is a 3-detector construct'
      : 'ACTIVELY WRONG-SIGNED — a finding about P, not about blur');
console.log(`    raw optimum       w = ${best.w.toFixed(2)}   ->  ${band(best.w)}`);
console.log(`    attenuation-corrected w = ${wTrue.toFixed(2)}   ->  ${band(wTrue)}`);
/* *** TRAP 24, COMMITTED HERE FOR THE THIRD TIME AND FIXED IN PLACE. *** The first version of this
 * block branched on `best.c < shipped.c` and printed "that is a real improvement" for a 17 -> 15
 * difference, which is 0.5 Poisson SE — indistinguishable from zero. The rule, already written down
 * twice (exponent-bracket.mjs, rate-law-form.mjs), is that "is this informative AT ALL" must be
 * tested BEFORE "which one won". Counts this small are Poisson; the difference of two counts has
 * SE ~ sqrt(a + b), and anything inside 2 of those is a tie no matter which number is lower. */
const dSE = Math.sqrt(Math.max(1, best.c + shipped.c));
const separated = Math.abs(shipped.c - best.c) >= 2 * dSE;
console.log(`\n    difference ${shipped.c} - ${best.c} = ${shipped.c - best.c}, against a Poisson SE of`
  + ` ${dSE.toFixed(1)} on the difference`);
if (!separated) {
  console.log('    *** NOT SEPARATED. The profile is FLAT across the top and the "optimum" is a tie,');
  console.log('    not a winner. No re-weighting is justified. NO CHANGE TO P. ***');
} else if (best.c >= shipped.c) {
  console.log('    *** The shipped weight beats the alternative. NO CHANGE TO P. ***');
} else {
  console.log(`    The optimum genuinely improves the joint count (${(Math.abs(shipped.c - best.c) / dSE).toFixed(1)} SE).`);
  console.log('    Re-weighting is on the table — subject to the attenuation reading above.');
}
console.log('');
