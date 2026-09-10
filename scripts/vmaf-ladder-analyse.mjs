/* THE EXPONENT FROM OUR OWN VMAF LADDER — and the first MEASURED value of the denominator that
 * 9.0n's headline divides by.
 *
 * THREE OUTPUTS, IN DESCENDING ORDER OF HOW MUCH THEY CAN BE TRUSTED.
 *
 * 1. *** gamma_V = dVMAF/dlog(bitrate), MEASURED WITHIN SEQUENCE. *** This is the one number here
 *    that carries NO cross-content assumption whatsoever — each film is its own control, and the
 *    slope is identified entirely inside it. 9.0n's a = 1.012 +- 0.049 divides by 16.42, taken from
 *    the jnd-table.js chain that its own header calls "BORROWED, AND THE WEAK LINK" (~6 VMAF per
 *    JND x ~2.5 CRF per JND x -13.6% bitrate per CRF). If the measured gamma_V differs materially,
 *    9.0n's headline moves and must be restated.
 *    NOTE THE ASYMMETRY: gamma_V enters `a` as a DENOMINATOR, so a SMALLER gamma_V makes the
 *    correction to 1 LARGER. The borrowed value being too big would have flattered a = 1.
 *
 * 2. THE DERIVATIVE EXPONENT, no cut-off anywhere: VMAF = alpha + gamma log R + delta log c, then
 *    a = -delta/gamma. Unlike 9.0l's MOS version this needs no cross-content COMPARABILITY
 *    assumption, because VMAF is full-reference — every score is already relative to that content's
 *    own master. That was the confound that killed the MOS estimator; it does not arise here.
 *
 * 3. THE THRESHOLD EXPONENT, swept over criteria because a threshold IS a cut-off and 9.0k measured
 *    a cut-off moving the answer by 0.28 across the sweep. Reported for agreement, not as headline.
 *
 * *** PRE-REGISTERED, BEFORE THE LADDER FINISHES. ***
 *   - gamma_V within 30% of 16.42        the borrowed denominator was adequate; 9.0n stands as
 *                                        stated.
 *   - gamma_V outside that               9.0n's a MUST be restated with the measured value. This is
 *                                        a restatement, not a retraction — the numerator was always
 *                                        ours.
 *   - derivative and threshold agree     the exponent is a property of the content, not of the
 *     within their SEs                   estimator, and the VMAF route has converged.
 *   - they disagree                      report BOTH and the bracket stands. Do not average two
 *                                        estimators that disagree; 9.0m already showed what that
 *                                        hides.
 * AND THE STANDING CAVEAT THAT NO AMOUNT OF n REMOVES: VMAF is a MODEL of human opinion. Task 106
 * (vmaf-mos-analyse.mjs) is what prices its bias against real labels. If phi there is significantly
 * negative, EVERY exponent below needs correcting by phi/gamma_MOS before it is quoted.
 *
 * READ-ONLY. USAGE: node vmaf-ladder-analyse.mjs [--metric vmaf|neg] [--min-seq 30]
 */
import fs from 'fs';

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const METRIC = arg('--metric', 'vmaf');
const MIN_SEQ = Number(arg('--min-seq', 30));
const BORROWED = 16.42;
const A_PREFLIGHT = 1.012;

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
function fit(x, y) {
  const n = x.length; const mx = mean(x); const my = mean(y);
  let sxy = 0; let sxx = 0;
  for (let i = 0; i < n; i += 1) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
  const b = sxy / sxx; const a = my - b * mx;
  let ss = 0; let tt = 0;
  for (let i = 0; i < n; i += 1) { ss += (y[i] - (a + b * x[i])) ** 2; tt += (y[i] - my) ** 2; }
  return { a, b, se: n > 2 ? Math.sqrt((ss / (n - 2)) / sxx) : NaN, r2: 1 - ss / tt, n };
}
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
  for (let i = 0; i < X.length; i += 1) { const f = X[i].reduce((s, z, j) => s + z * be[j], 0); ss += (y[i] - f) ** 2; }
  const s2 = ss / (X.length - p);
  return { be, se: be.map((_, i) => Math.sqrt(s2 * inv[i][i])) };
}

let J;
try { J = JSON.parse(fs.readFileSync('data/vmaf-ladder.json', 'utf8')); }
catch { console.log('\n  data/vmaf-ladder.json not present — the ladder has not run yet.\n'); process.exit(0); }
const key = METRIC === 'neg' ? 'vmafNeg' : 'vmaf';
const rows = Object.values(J.units).filter((u) => u.bits > 0 && Number.isFinite(u[key]) && u.cx > 0);
const bySeq = new Map();
for (const r of rows) { if (!bySeq.has(r.seq)) bySeq.set(r.seq, []); bySeq.get(r.seq).push(r); }
const full = [...bySeq.entries()].filter(([, v]) => v.length >= 3);
console.log(`\n  ${rows.length} ladder rungs over ${bySeq.size} sequences (${full.length} with >=3 rungs)`
  + `   metric: ${key}\n`);
if (full.length < MIN_SEQ) {
  console.log(`  *** ONLY ${full.length} SEQUENCES WITH A USABLE LADDER — below the floor of ${MIN_SEQ}.`);
  console.log('  The exponent is a CROSS-SEQUENCE slope, so the effective n is the sequence count.');
  console.log('  Plumbing is exercised below; treat every coefficient as provisional. ***\n');
}

/* ---- 1. gamma_V, WITHIN SEQUENCE — the assumption-free number ------------------------------ */
console.log('  1. dVMAF/dlog(bitrate), MEASURED WITHIN EACH SEQUENCE (no cross-content assumption)\n');
const gammas = [];
for (const [seq, v] of full) {
  const f = fit(v.map((x) => Math.log(x.bits)), v.map((x) => x[key]));
  if (Number.isFinite(f.b)) gammas.push({ seq, g: f.b, r2: f.r2, cx: v[0].cx });
}
if (gammas.length) {
  const gs = gammas.map((x) => x.g);
  const gMed = [...gs].sort((a, b) => a - b)[Math.floor(gs.length / 2)];
  console.log(`     n ${gammas.length} sequences   median ${gMed.toFixed(2)}   mean ${mean(gs).toFixed(2)}`
    + `   sd ${sd(gs).toFixed(2)}   range ${Math.min(...gs).toFixed(1)} - ${Math.max(...gs).toFixed(1)}`);
  console.log(`     BORROWED value used by 9.0n: ${BORROWED}`);
  const ratio = gMed / BORROWED;
  console.log(`     measured / borrowed = ${ratio.toFixed(3)}`
    + `   ${Math.abs(ratio - 1) <= 0.30 ? 'WITHIN 30% — the borrowed denominator was adequate'
      : '*** OUTSIDE 30% — 9.0n MUST BE RESTATED with the measured value ***'}`);
  /* restate 9.0n: a = 1 - numerator/gamma, numerator = -0.198 +- 0.798 (9.0n) */
  const NUM = -0.198; const NUMSE = 0.798;
  console.log(`\n     9.0n RESTATED with the measured denominator:`);
  console.log(`       a = 1 - (${NUM}) / ${gMed.toFixed(2)} = ${(1 - NUM / gMed).toFixed(3)}`
    + ` +- ${(NUMSE / gMed).toFixed(3)}   (was ${A_PREFLIGHT.toFixed(3)} +- ${(NUMSE / BORROWED).toFixed(3)})`);
  console.log('     REMINDER: gamma_V is a DENOMINATOR, so a SMALLER gamma_V means a LARGER departure');
  console.log('     from 1. A borrowed value that was too large would have flattered a = 1.');
}

/* ---- 2. THE PRIMARY ESTIMATOR: two-stage, no selection and no collinearity ------------------
 * ADDED 2026-08-29 09:35 after both original estimators below were discredited overnight (9.0u,
 * 9.0v). Stage 1 fits gamma_i WITHIN each sequence, where cx is constant so nothing is collinear.
 * Stage 2 inverts that sequence's OWN line at a reference VMAF and includes EVERY sequence,
 * whether or not its ladder brackets the criterion — so there is no inclusion rule and therefore
 * no selection on the outcome. CRF 24 is dropped because it was MEASURED saturated (5/25 above
 * VMAF 98 vs 0/25 at CRF 28); excluding on CRF excludes on a DESIGN variable, not on the outcome. */
console.log('\n  2. *** PRIMARY *** TWO-STAGE EXPONENT — no selection, no collinearity, CRF 28/32\n');
{
  const res = [];
  for (const T of [88, 93, 95]) {
    const pts = [];
    for (const [, v0] of full) {
      const v = v0.filter((r) => r.crf !== 24);
      if (v.length < 2) continue;
      const f = fit(v.map((x) => Math.log(x.bits)), v.map((x) => x[key]));
      if (!(f.b > 0)) continue;
      pts.push({ lc: Math.log(v[0].cx), lt: (T - f.a) / f.b });
    }
    if (pts.length < 6) { console.log(`     VMAF ${T}: only ${pts.length} sequences`); continue; }
    const F = fit(pts.map((p) => p.lc), pts.map((p) => p.lt));
    res.push(F.b);
    console.log(`     VMAF ${T}:  a = ${F.b.toFixed(3)} +- ${F.se.toFixed(3)}   r2 ${F.r2.toFixed(3)}`
      + `   n ${F.n} (ALL sequences, no bracketing requirement)`);
  }
  if (res.length > 1) {
    const spread = Math.max(...res) - Math.min(...res);
    console.log(`\n     spread across criteria ${spread.toFixed(3)}`
      + `   ${spread < 0.15 ? '— criterion-insensitive, as a real exponent should be'
        : '*** still criterion-sensitive — something is still selecting ***'}`);
  }
}

/* ---- 3. DISCREDITED: pooled derivative — COLLINEAR BY CONSTRUCTION (9.0v) --------------------
 * Kept only so the failure stays visible. cxEff IS the CRF-20 bitrate, so regressing VMAF on
 * log(bitrate) AND log(cx) asks the data to separate one measurement at two operating points:
 * corr 0.812, VIF 2.94, pooled gamma ~54% of the within-sequence median, and the exponent swings
 * 2x purely on which gamma is used. AS n GREW ITS CI STOPPED INCLUDING 1 — a collinear estimator
 * becoming PRECISE, which is worse than one staying vague because precision reads as authority.
 * DO NOT QUOTE THIS NUMBER. */
console.log('\n  3. DISCREDITED — pooled derivative, COLLINEAR BY CONSTRUCTION (9.0v). Do not quote.\n');
if (full.length >= 4) {
  const rs = full.flatMap(([, v]) => v);
  const f = ols(rs.map((r) => [1, Math.log(r.bits), Math.log(r.cx)]), rs.map((r) => r[key]));
  const g = f.be[1]; const d = f.be[2];
  console.log(`     gamma ${g.toFixed(4)} +- ${f.se[1].toFixed(4)}   delta ${d.toFixed(4)} +- ${f.se[2].toFixed(4)}`);
  if (!(g > 0)) console.log('     *** gamma <= 0: more bits should mean higher VMAF. Model misspecified, no ratio quoted. ***');
  else if (!(d < 0)) console.log('     *** delta >= 0: complex content should score WORSE at equal bits. No ratio quoted. ***');
  else {
    const a = -d / g;
    /* sequence bootstrap — the unit of independence */
    let rng = 20260829; const rnd = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    const bs = [];
    for (let b = 0; b < 2000; b += 1) {
      const s = [];
      for (let i = 0; i < full.length; i += 1) s.push(...full[Math.floor(rnd() * full.length)][1]);
      try {
        const ff = ols(s.map((r) => [1, Math.log(r.bits), Math.log(r.cx)]), s.map((r) => r[key]));
        if (ff.be[1] > 0) bs.push(-ff.be[2] / ff.be[1]);
      } catch { /* singular */ }
    }
    bs.sort((x, y) => x - y);
    console.log(`     *** a = ${a.toFixed(3)}   95% CI [${bs[Math.floor(0.025 * bs.length)].toFixed(3)}, `
      + `${bs[Math.floor(0.975 * bs.length)].toFixed(3)}]  (${bs.length} sequence bootstraps) ***`);
  }
}

/* ---- 4. DISCARDED: bracketing threshold — SELECTION ON THE OUTCOME (9.0u) --------------------
 * Kept only so the failure stays visible. This form includes a sequence ONLY IF its ladder brackets
 * the criterion, and that inclusion depends on the outcome: at VMAF 88 the included sequences had
 * mean log cx -0.979 vs -1.884 excluded (keeps the COMPLEX); at VMAF 95 it was -1.694 vs -0.808
 * (keeps the SIMPLE). The selection REVERSES between criteria and so does the estimate — the
 * 1.472 -> 0.897 gradient was the selection moving, not the exponent. r2 reached 0.936, which is
 * what a selected sample does. This is task #104's error, truncation on Y. DO NOT QUOTE. */
console.log('\n  4. DISCARDED — bracketing threshold, SELECTION ON THE OUTCOME (9.0u). Do not quote.\n');
for (const T of [88, 93, 95]) {
  const pts = [];
  for (const [, v] of full) {
    const p = [...v].sort((a, b) => a.bits - b.bits);
    let t = null;
    for (let i = 0; i < p.length - 1; i += 1) {
      if (p[i][key] <= T && p[i + 1][key] >= T) {
        const fr = (T - p[i][key]) / ((p[i + 1][key] - p[i][key]) || 1e-9);
        t = Math.exp(Math.log(p[i].bits) + fr * (Math.log(p[i + 1].bits) - Math.log(p[i].bits)));
        break;
      }
    }
    if (t > 0) pts.push({ cx: p[0].cx, t });
  }
  if (pts.length < 6) { console.log(`     VMAF ${T}:  only ${pts.length} sequences bracket this criterion`); continue; }
  const f = fit(pts.map((p) => Math.log(p.cx)), pts.map((p) => Math.log(p.t)));
  console.log(`     VMAF ${T}:  a = ${f.b.toFixed(3)} +- ${f.se.toFixed(3)}   r2 ${f.r2.toFixed(3)}   n ${f.n} sequences`);
}

console.log('\n  STANDING CAVEAT: VMAF is a MODEL of human opinion. If task 106 finds phi significantly');
console.log('  negative, every exponent above needs correcting by phi/gamma_MOS BEFORE it is quoted.\n');
