/* CAN THE COMPLEXITY EXPONENT BE IDENTIFIED WITHOUT HUMAN LABELS? — NO, AND HERE IS WHY (task 99)
 *
 * *** THIS SCRIPT RECORDS A FAILED ATTEMPT. It is kept because the attempt is the obvious one, it
 * looked like it worked, and it took two separate errors of mine to see that it does not. ***
 *
 * THE HOPE. E.10.1 swept the exponent a in target ~ cxEff^a against artifact prevalence, found every
 * detector prefers a < 1, and argued the sweep is BIASED: complexity both RAISES the bits a film needs
 * and MASKS artifacts, every artifact we can measure is a masked one, so every one pushes a downward.
 * The missing counterweight is DETAIL RETENTION, which complexity aggravates. The conclusion drawn was
 * that a counterweight is needed, perPoint is the only candidate, and perPoint cannot serve until its
 * referent is named — which routes through human labels (task 93).
 * The hope was that BRACKETING needs no exchange rate: if masked artifacts prefer a < 1 and detail
 * retention prefers a > 1, then a = 1 sits inside and is defensible with no pricing at all.
 *
 * THE RIGHT ESTIMATOR, which is worth keeping even though the application fails. Maximising a
 * correlation is the WRONG procedure and E.10.1 half-noticed this ("a and HEADROOM_TARGET are not
 * separately identified"). Any damage proxy that responds strongly to bits will "prefer" a = 0,
 * because that is the score most correlated with bits. The identified question is not "which a
 * correlates best" but "which a makes films of EQUAL SCORE equally damaged":
 *       damage ~ b0 + b_bpp*log(bpp) + b_cx*log(cx)
 *       iso-damage contour   log bpp = -(b_cx/b_bpp)*log cx + const
 *       score iso-contour    log bpp =        a       *log cx + const
 *   =>  a* = -b_cx / b_bpp
 * One regression, no sweep, no search boundary, and — usefully, given the error below — INVARIANT TO
 * THE SIGN of the damage variable, because both coefficients flip together.
 *
 * MEASURED, n=60:  b_bpp -0.0319   b_cx -0.0024   a* = -0.075   95% CI [-0.47, 0.19]   P(a*>1) = 0.0%
 *
 * *** AND THAT NUMBER MUST NOT BE BELIEVED, FOR A REASON THAT KILLS THE WHOLE APPROACH. *** The
 * estimator is valid only if the damage measure is CONTENT-FREE. perPoint is not. It is
 * d log(bitrate)/d CRF — DESTRUCTIBLE DETAIL REMAINING IN ABSOLUTE TERMS — so at a fixed bitrate a
 * complex film has MORE of it simply because it started with more. So b_cx is a SUM of two effects
 * pointing opposite ways:
 *       content   more complex -> more absolute detail -> b_cx NEGATIVE, nothing to do with adequacy
 *       adequacy  more complex -> more starved at fixed bpp -> b_cx POSITIVE
 * b_cx measured -0.0024, indistinguishable from zero, which is exactly what a cancellation looks
 * like. THE ESTIMATOR CANNOT DECOMPOSE THEM, so a* is uninterpretable rather than small.
 *
 * THE GENERAL STATEMENT, WHICH IS SHARPER THAN E.10.1'S. It is not that we lack a counterweight. It is
 * that EVERY available damage measure confounds content with damage, in the same structural way and
 * in whichever direction that measure happens to run:
 *       banding/blocking   complexity MASKS them          -> pushes a down
 *       perPoint           complexity SUPPLIES the detail -> cancels, sign unknown
 * So a is not identified by ANY instrument this project owns, and no combination of them fixes it —
 * combining two contaminated measures gives a third contaminated measure. What breaks the deadlock is
 * a judgement that is content-aware BY NATURE, which is what a person watching a film supplies for
 * free: "does this look bad FOR WHAT IT IS". That is task 93, and this failure is the strongest
 * argument yet that 93 is not one item among several but the identification strategy itself.
 *
 * TWO ERRORS OF MINE ON THE WAY, recorded so the next reader does not repeat them:
 *   1. THE SIGN. This file originally asserted "HIGH perPoint is GOOD" and maximised rho. It is the
 *      OPPOSITE: starving RAISES perPoint (E.8.10, -0.0297/log level) and a generation RAISES it
 *      (+0.0068), so HIGH = LESS DETAIL = WORSE. The sweep was being read upside down. This is why
 *      the a* estimator above is stated in a sign-invariant form.
 *   2. THE VERDICT BRANCH ORDER. The original printed "BRACKETED" on argmax a = 2 while the bootstrap
 *      CI was [-0.5, 2] — the entire search range. The uninformative check sat BELOW the bracket
 *      check in the if-chain, so a result that was pure noise announced a pass. A verdict function
 *      must test "is this informative at all" FIRST.
 *
 * READ-ONLY. Uses data/perpoint-content-line.json and the live probe dataset.
 * USAGE: node scripts/exponent-bracket.mjs
 */
import fs from 'fs';

const NBOOT = 4000;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
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

const raw = JSON.parse(fs.readFileSync('data/perpoint-content-line.json', 'utf8'));
const ds = await (await fetch('http://localhost:8088/api/probe/dataset')).json();
const byKey = new Map(ds.rows.map((r) => [r.key, r]));
const rows = [];
for (const [key, u] of Object.entries(raw.units)) {
  const arm = u.arms[0] ?? u.arms['0'];
  const r = byKey.get(key);
  if (!arm || !Number.isFinite(arm.perPoint) || !r || !(r.bpp > 0) || !(r.cxEff > 0)) continue;
  rows.push({ pp: arm.perPoint, lbpp: Math.log(r.bpp), lcx: Math.log(r.cxEff) });
}
const X = rows.map((r) => [1, r.lbpp, r.lcx]);
const y = rows.map((r) => r.pp);
const b = ols(X, y);
console.log(`\n  n = ${rows.length}\n`);
console.log('  THE IDENTIFIED ESTIMATOR   a* = -b_cx / b_bpp   (sign-invariant)\n');
console.log(`    b_bpp ${b[1].toFixed(4)}    b_cx ${b[2].toFixed(4)}    a* = ${(-b[2] / b[1]).toFixed(3)}`);

let rng = 777;
const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
const bs = [];
for (let t = 0; t < NBOOT; t += 1) {
  const idx = rows.map(() => Math.floor(rand() * rows.length));
  const bb = ols(idx.map((i) => X[i]), idx.map((i) => y[i]));
  if (bb && Math.abs(bb[1]) > 1e-6) bs.push(-bb[2] / bb[1]);
}
bs.sort((x, z) => x - z);
console.log(`    bootstrap 95% CI [${bs[Math.floor(0.025 * bs.length)].toFixed(2)}, ${bs[Math.floor(0.975 * bs.length)].toFixed(2)}]`
  + `   P(a* > 1) = ${(100 * bs.filter((v) => v > 1).length / bs.length).toFixed(1)}%`);

console.log('\n  *** DO NOT REPORT a* AS AN ESTIMATE OF THE EXPONENT. *** perPoint is not content-free:');
console.log('  at fixed bitrate a complex film has more absolute destructible detail simply because it');
console.log('  started with more. So b_cx is a SUM of a negative content term and a positive adequacy');
console.log('  term, and measuring it near zero is what a CANCELLATION looks like, not a small effect.');
console.log('  The estimator cannot decompose them. See this file\'s header for the general statement:');
console.log('  every damage measure this project owns confounds content with damage, so the exponent is');
console.log('  not identified by any of them, and combining contaminated measures does not help.\n');
