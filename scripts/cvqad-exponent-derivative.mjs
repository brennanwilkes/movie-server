/* TASK 100, SECOND AND BETTER ESTIMATOR — THE EXPONENT WITH NO CRITERION AND NO CUT-OFF.
 *
 * WHY A SECOND ESTIMATOR AT ALL. 9.0k fitted `a` from THRESHOLD bitrates and the answer moved with
 * the criterion in 3/3 codecs (a falls monotonically as q rises). A threshold is a cut-off, the
 * design forbids cut-offs, and the measured criterion-dependence is the cut-off making itself felt.
 * So the threshold route can corroborate but should not be the primary.
 *
 * THE ESTIMATOR ALREADY EXISTS IN THE DOCS AND WAS FILED AS BLOCKED. E.10.2 kept it after the
 * bracket attempt failed: "a* = -b_cx/b_bpp from damage ~ b0 + b_bpp*log bpp + b_cx*log cx. It is
 * identified, sign-invariant and needs no sweep — it will work the moment a CONTENT-FREE DAMAGE
 * MEASURE exists, which is what task 93 supplies."
 * *** TASK 93 IS NOT THE ONLY SOURCE OF ONE. CVQAD's MOS IS A CONTENT-FREE DAMAGE MEASURE — it is a
 * human quality score, not an artifact detector, so it does not confound content with damage the way
 * banding/blocking (complexity MASKS them) and perPoint (complexity SUPPLIES the detail) do. *** The
 * estimator is therefore unblocked NOW, without the projector.
 *
 * THE DERIVATION, so the sign and the ratio are checkable rather than asserted:
 *     MOS  =  alpha + gamma*log R + delta*log c        (R = bitrate, c = our complexity)
 *     hold quality fixed:   0 = gamma*dlogR + delta*dlogc
 *     =>  a  =  dlogR/dlogc |_fixed quality  =  -delta / gamma
 * a is a RATIO OF TWO SLOPES. No threshold is crossed, no criterion is chosen, nothing is counted,
 * and the units of MOS cancel — so an arbitrary monotone rescaling of the quality scale leaves `a`
 * unchanged to first order. That is precisely the property the threshold estimator lacks.
 *
 * *** PRE-REGISTERED, BEFORE THE NUMBERS. ***
 *  1. SIGNS FIRST, MAGNITUDE SECOND. gamma MUST be > 0 (more bits, better) and delta MUST be < 0
 *     (more complex at equal bits, worse). If either sign fails the model is misspecified and NO
 *     RATIO IS QUOTED — a ratio of two slopes is meaningless if either is pointing the wrong way.
 *  2. AGREEMENT WITH 9.0k IS THE TEST. The threshold route gave 0.48 (x264, q=0.75), in a criterion
 *     sweep spanning 0.31-0.59. If this criterion-free estimator lands in that band, two estimators
 *     with DIFFERENT failure modes agree and the finding is real. If it lands near 1.0, the 9.0k
 *     result was a cut-off artifact and the shipped a survives.
 *  3. MOS IS ONLY COMPARABLE WITHIN A COMPARISON GROUP, so group fixed effects are mandatory, as are
 *     codec fixed effects (codecs differ in efficiency at equal bitrate). SEQUENCE fixed effects are
 *     IMPOSSIBLE here and that is the honest limit: c is constant within a sequence, so sequence FE
 *     would absorb delta entirely. The identification is therefore CROSS-SEQUENCE and rests on MOS
 *     being comparable across sequences within a comparison group.
 *  4. THE 9.4 SIDE-TEST, which is now load-bearing (9.0k). Where real CRF ladders exist, regress MOS
 *     on log c AT FIXED CRF. If quality falls with complexity at fixed CRF, then FIXED CRF IS NOT
 *     FIXED QUALITY, and 9.0f's ladder-derived exponent of 0.90-1.00 is biased UPWARD — which would
 *     resolve the 9.0f-vs-9.0k conflict in favour of the human labels.
 *     EXTERNAL EXPECTATION, REGISTERED BEFORE THE FIT: NEGATIVE. CRF's adaptive quantisation is
 *     tuned on typical content and high-complexity/high-motion material is known to fare worse at
 *     equal CRF; 9.4 already records a published spread of ~10 VMAF at 3 sigma.
 *
 * READ-ONLY. GT complexity only (9.0i).
 * USAGE: node scripts/cvqad-exponent-derivative.mjs [--boot 2000]
 */
import fs from 'fs';

const CSV = '/data/research/cvqad/Subjective_scores_and_videos_info.csv';
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const NBOOT = Number(arg('--boot', 2000));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function ols(X, y) {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i += 1) {
    for (let a = 0; a < p; a += 1) { b[a] += X[i][a] * y[i]; for (let c = 0; c < p; c += 1) A[a][c] += X[i][a] * X[i][c]; }
  }
  const n = p;
  const M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c += 1) {
    let piv = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) M[c][c] = 1e-12;
    const d = M[c][c];
    for (let k = 0; k < 2 * n; k += 1) M[c][k] /= d;
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r][c];
      for (let k = 0; k < 2 * n; k += 1) M[r][k] -= f * M[c][k];
    }
  }
  const inv = M.map((r) => r.slice(n));
  const be = inv.map((r) => r.reduce((s, v, j) => s + v * b[j], 0));
  let ss = 0;
  for (let i = 0; i < X.length; i += 1) {
    const f = X[i].reduce((s, z, j) => s + z * be[j], 0); ss += (y[i] - f) ** 2;
  }
  const s2 = ss / (X.length - p);
  return { be, se: be.map((_, i) => Math.sqrt(s2 * inv[i][i])) };
}

const cxRaw = JSON.parse(fs.readFileSync('data/cvqad-complexity.json', 'utf8')).units;
const CX = new Map();
for (const u of Object.values(cxRaw)) if (u.kind === 'gt') CX.set(u.seq, u.cx);

const lines = fs.readFileSync(CSV, 'utf8').trim().split('\n');
const H = lines[0].split(',');
const I = (n) => H.indexOf(n);
const rows = [];
for (const l of lines.slice(1)) {
  const c = l.split(',');
  const seq = c[I('sequence')]; const cx = CX.get(seq);
  const R = Number(c[I('real_bitrate')]); const mos = Number(c[I('MOS')]);
  if (!(cx > 0) || !(R > 0) || !Number.isFinite(mos)) continue;
  rows.push({ seq, cx, R, mos, grp: c[I('comparison')], codec: c[I('codec')], crf: Number(c[I('crf')]) });
}
const GRPS = [...new Set(rows.map((r) => r.grp))].sort();
const CODECS = [...new Set(rows.map((r) => r.codec))].sort();
console.log(`\n  ${rows.length} labelled encodes over ${CX.size} GT-measured sequences,`
  + ` ${GRPS.length} comparison groups, ${CODECS.length} codecs\n`);

/* design: [1, log R, log cx, group dummies, codec dummies] */
const design = (rs) => rs.map((r) => [1, Math.log(r.R), Math.log(r.cx),
  ...GRPS.slice(1).map((g) => (r.grp === g ? 1 : 0)),
  ...CODECS.slice(1).map((c) => (r.codec === c ? 1 : 0))]);

const F = ols(design(rows), rows.map((r) => r.mos));
const gamma = F.be[1]; const delta = F.be[2];
console.log('  THE TWO SLOPES  (comparison-group and codec fixed effects absorbed)\n');
console.log(`    gamma = dMOS / dlog(bitrate)     ${gamma.toFixed(4)} +- ${F.se[1].toFixed(4)}   ${gamma > 0 ? 'POSITIVE, as required' : '*** WRONG SIGN ***'}`);
console.log(`    delta = dMOS / dlog(complexity)  ${delta.toFixed(4)} +- ${F.se[2].toFixed(4)}   ${delta < 0 ? 'NEGATIVE, as required' : '*** WRONG SIGN ***'}`);

if (!(gamma > 0) || !(delta < 0)) {
  console.log('\n  *** A SIGN FAILED. The pre-registration forbids quoting the ratio: a ratio of two');
  console.log('  slopes is meaningless when one points the wrong way. Model is misspecified. ***\n');
  process.exit(0);
}

const a = -delta / gamma;
/* bootstrap over SEQUENCES — the unit of independence, since all rungs of one sequence share c */
const seqs = [...new Set(rows.map((r) => r.seq))];
const bySeq = new Map(seqs.map((s) => [s, rows.filter((r) => r.seq === s)]));
let rng = 20260828;
const rnd = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
const bs = [];
for (let b = 0; b < NBOOT; b += 1) {
  const samp = [];
  for (let i = 0; i < seqs.length; i += 1) samp.push(...bySeq.get(seqs[Math.floor(rnd() * seqs.length)]));
  try {
    const f = ols(design(samp), samp.map((r) => r.mos));
    if (f.be[1] > 0) bs.push(-f.be[2] / f.be[1]);
  } catch { /* singular resample */ }
}
bs.sort((x, y) => x - y);
const lo = bs[Math.floor(0.025 * bs.length)]; const hi = bs[Math.floor(0.975 * bs.length)];
console.log(`\n  *** a = -delta/gamma = ${a.toFixed(3)}   95% CI [${lo.toFixed(3)}, ${hi.toFixed(3)}]`
  + `  (${bs.length} sequence-bootstrap resamples) ***`);
console.log('\n    NO THRESHOLD, NO CRITERION, NO COUNTED FRACTION. The MOS units cancel in the ratio,');
console.log('    so a monotone rescaling of the quality scale leaves this unchanged to first order.');

console.log('\n  AGAINST THE OTHER ESTIMATES\n');
const band = (x, l, h) => (x >= l && x <= h);
console.log(`    threshold route (9.0k, x264 q=0.75)   0.481   sweep spanned 0.31 - 0.59`);
console.log(`    our own CRF ladder (9.0f)             0.90 - 1.00`);
console.log(`    published prior (9.0d)                ~0.6`);
console.log(`    SHIPPED                               1.00`);
console.log(`    this estimator                        ${a.toFixed(3)}  [${lo.toFixed(2)}, ${hi.toFixed(2)}]`);
console.log(`\n    agrees with the 9.0k sweep band .... ${band(a, 0.31, 0.59) ? 'YES — two estimators with different failure modes agree' : 'no'}`);
console.log(`    CI excludes the shipped a = 1 ...... ${hi < 1 || lo > 1 ? 'YES' : 'no'}`);

/* ---- 9.4: is fixed CRF fixed quality? ------------------------------------------------------ */
console.log('\n  OPEN QUESTION 9.4 — IS FIXED CRF FIXED QUALITY? (now load-bearing, per 9.0k)\n');
const crfRows = rows.filter((r) => r.crf >= 10 && r.crf <= 40);
const crfCodecs = [...new Set(crfRows.map((r) => r.codec))]
  .filter((c) => new Set(crfRows.filter((r) => r.codec === c).map((r) => r.seq)).size >= 8);
console.log(`    ${crfRows.length} encodes carry a genuine CRF value; ${crfCodecs.length} codecs have >= 8 sequences\n`);
let anyNeg = false;
for (const codec of crfCodecs) {
  const rs = crfRows.filter((r) => r.codec === codec);
  const G = [...new Set(rs.map((r) => r.grp))].sort();
  const X = rs.map((r) => [1, r.crf, Math.log(r.cx), ...G.slice(1).map((g) => (r.grp === g ? 1 : 0))]);
  if (rs.length < X[0].length + 3) continue;
  const f = ols(X, rs.map((r) => r.mos));
  const t = f.be[2] / f.se[2];
  if (f.be[2] < 0 && t < -2) anyNeg = true;
  console.log(`    ${codec.padEnd(10)} n ${String(rs.length).padStart(3)}  dMOS/dlog(cx) at fixed CRF `
    + `${f.be[2].toFixed(3).padStart(7)} +- ${f.se[2].toFixed(3)}  t ${t.toFixed(2).padStart(6)}`
    + `   ${t < -2 ? 'QUALITY FALLS WITH COMPLEXITY' : t > 2 ? 'rises' : 'flat'}`);
}
console.log('');
if (anyNeg) {
  console.log('    *** FIXED CRF IS NOT FIXED QUALITY. *** At equal CRF, more complex content scores');
  console.log('    WORSE with humans. That is the assumption 9.0f needs in order to read its ladder');
  console.log('    exponent (0.90-1.00) as the perceptual rate-vs-complexity law, and it FAILS. The');
  console.log('    ladder understates how many bits complex content needs, so its exponent is biased');
  console.log('    UPWARD — which resolves the 9.0f vs 9.0k conflict in favour of the human labels.');
} else {
  console.log('    Fixed CRF looks close to fixed quality on this evidence, which LEAVES 9.0f STANDING');
  console.log('    and DEEPENS the conflict with 9.0k rather than resolving it. Do not pick a winner.');
}
console.log('');
