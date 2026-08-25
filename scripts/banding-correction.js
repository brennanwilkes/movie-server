#!/usr/bin/env node
/* BANDING AS A CORRECTION TO BPP+ — Brennan's actual proposal, tested on its own terms.
 *
 * THE IDEA, restated so it is not misread again (it was once):
 *   Banding is an INDEPENDENT ESTIMATOR of how good a copy is. Given a film's score and its content,
 *   we can predict how much banding it OUGHT to show. Then:
 *     measured << expected  ->  "if this really were a 30, we would SEE stepping. We do not.
 *                                So the copy is better than the score says."   SHIFT BPP+ UP
 *     measured >> expected  ->  "this bands far more than a copy this good should."  SHIFT DOWN
 *
 * This is NOT the same as "banding reveals a bitrate deficiency to add to the denominator", which is
 * what an earlier pass tested and rejected. The difference matters, and it inverts a methodology
 * rule: that pass forbade the expected-model from seeing bitrate, because a ratio built on bitrate
 * would divide out the signal it was hunting. HERE, SEEING BITRATE IS THE WHOLE MECHANISM — the
 * quantity of interest is precisely the DISAGREEMENT between what the bits predict and what the eye
 * would see. So bpp is a predictor, and the strong bpp->banding relationship (-0.684, stronger than
 * BPP+'s own -0.416) is the asset rather than the problem.
 *
 * ── THE ONLY QUESTION THAT MATTERS: IS THE DISAGREEMENT SIGNAL OR NOISE? ─────────────────────────
 * A correction built on noise is strictly worse than no correction: it moves every score by a random
 * amount and looks like precision. So before any shift is proposed, two tests it must pass.
 *
 *   TEST 1 - SPLIT-HALF RELIABILITY. Each film has 4 independent clips. Compute the residual from
 *            clips {0,2} and again from clips {1,3}. If the film's disagreement is real, the two
 *            halves agree. If it is measurement noise, they do not. This is the decisive test and it
 *            needs no new encoding.
 *   TEST 2 - IS THE LOW END A FLOOR? Expected banding tends to ~0 at high bpp, so a "shift down"
 *            there rests on distinguishing cambi 0.32 from 0.02. If per-clip scatter at that level is
 *            the same size as the residual, the low end cannot support a correction and the shift
 *            must be one-sided or floored.
 *
 * Only if both pass does the shift arithmetic mean anything, so it is reported last and clearly
 * labelled as uncalibrated - the coefficient needs a subjective label, which this library lacks.
 *
 * USAGE: node scripts/banding-correction.js [--api URL]
 */
const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', process.env.CONTROLLER || 'http://localhost:8088');

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a) => { const v = [...a].sort((x, y) => x - y); return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2; };
function pearson(xs, ys) {
  const mx = mean(xs); const my = mean(ys);
  const den = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
  return den ? xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / den : 0;
}
function ols(X, y) {
  const p = X[0].length;
  const A = Array.from({ length: p }, (_, i) => Array.from({ length: p + 1 }, (_, j) => (j < p
    ? X.reduce((s, r) => s + r[i] * r[j], 0)
    : X.reduce((s, r, k) => s + r[i] * y[k], 0))));
  for (let c = 0; c < p; c += 1) {
    let piv = c;
    for (let r = c + 1; r < p; r += 1) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < p; r += 1) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j <= p; j += 1) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((row, i) => row[p] / A[i][i]);
}
const L = (v) => Math.log(Math.max(v, 1e-3));

(async () => {
  const [ds, bd] = await Promise.all([
    (await fetch(`${API}/api/probe/dataset`)).json(),
    (await fetch(`${API}/api/banding/dataset`)).json(),
  ]);
  const clips = new Map(bd.rows.filter((r) => Array.isArray(r.sampleCambi) && r.sampleCambi.length >= 4)
    .map((r) => [r.key, r.sampleCambi]));
  const rows = ds.rows.filter((r) => r.cambi != null && r.cxEff > 0 && r.bpp > 0
    && r.bppPlus != null && r.cambiLuma != null && r.year && clips.has(r.key));
  console.log(`${rows.length} films with a score, content context and >=4 per-clip readings\n`);
  if (rows.length < 30) { console.log('too few'); return; }

  // The EXPECTED model for this formulation: what banding should a copy this good, of this content,
  // show? bpp is in deliberately — the disagreement with it is the signal.
  const design = (r) => [1, L(r.bpp), L(r.cxEff), r.cambiLuma / 100, (r.year - 2000) / 25];
  const names = ['intercept', 'log bpp', 'log cxEff', 'luma/100', '(year-2000)/25'];
  const y = rows.map((r) => L(r.cambi));
  const beta = ols(rows.map(design), y);
  const fit = rows.map((r) => design(r).reduce((s, v, i) => s + v * beta[i], 0));
  const ssTot = y.reduce((s, v) => s + (v - mean(y)) ** 2, 0);
  console.log('EXPECTED-BANDING MODEL (bpp included — the disagreement with it IS the signal):');
  beta.forEach((b, i) => console.log(`   ${names[i].padEnd(16)} ${b >= 0 ? ' ' : ''}${b.toFixed(4)}`));
  console.log(`   R^2 ${(1 - y.reduce((s, v, i) => s + (v - fit[i]) ** 2, 0) / ssTot).toFixed(3)}`);
  const resid = rows.map((r, i) => y[i] - fit[i]);
  console.log(`   residual sd ${sd(resid).toFixed(3)} (log space)\n`);

  // ---- TEST 1: SPLIT-HALF RELIABILITY --------------------------------------------------------
  // Refit the model on each half's own readings so the halves are genuinely independent estimates
  // of the same underlying quantity, then correlate the two residual vectors.
  console.log('TEST 1 — SPLIT-HALF RELIABILITY (clips {0,2} vs clips {1,3})');
  const halfY = (idxs) => rows.map((r) => L(mean(idxs.map((i) => clips.get(r.key)[i]))));
  const halfResid = (idxs) => {
    const yy = halfY(idxs);
    const b = ols(rows.map(design), yy);
    return rows.map((r, i) => yy[i] - design(r).reduce((s, v, j) => s + v * b[j], 0));
  };
  const rA = halfResid([0, 2]); const rB = halfResid([1, 3]);
  const rel = pearson(rA, rB);
  // Spearman-Brown: reliability of the FULL 4-clip measure, given the half-half correlation.
  const full = (2 * rel) / (1 + rel);
  console.log(`   r(halfA, halfB) = ${rel.toFixed(3)}`);
  console.log(`   Spearman-Brown reliability of the full 4-clip residual = ${full.toFixed(3)}`);
  console.log(`   => ${(full * 100).toFixed(0)}% of the residual's variance is REAL, `
    + `${((1 - full) * 100).toFixed(0)}% is measurement noise`);
  const verdict1 = full >= 0.7 ? 'PASS — reliable enough to correct with'
    : full >= 0.5 ? 'MARGINAL — real signal, but a third of it is noise'
      : 'FAIL — the disagreement is mostly noise; a correction built on it would be random';
  console.log(`   ${verdict1}\n`);

  // ---- TEST 2: IS THE LOW END A FLOOR? -------------------------------------------------------
  console.log('TEST 2 — PRECISION BY BANDING LEVEL, and how many clips a correction needs');
  // The residual is computed from the MEAN of 4 clips, so the noise on it is the STANDARD ERROR of
  // that mean (sd/sqrt(n)) — NOT the scatter of individual clips. Comparing the residual against
  // single-clip sd overstates the noise fourfold in variance terms and makes a usable signal look
  // hopeless; an earlier version of this script did exactly that.
  const levels = [[0, 0.25], [0.25, 1], [1, 3], [3, 99]];
  for (const [lo, hi] of levels) {
    const g = rows.filter((r) => r.cambi >= lo && r.cambi < hi);
    if (g.length < 5) continue;
    const withinSd = med(g.map((r) => sd(clips.get(r.key).map(L))));
    const se = withinSd / Math.sqrt(4);
    const between = sd(g.map((r) => resid[rows.indexOf(r)]));
    console.log(`     cambi ${String(lo).padStart(4)}-${String(hi).padEnd(4)} n=${String(g.length).padStart(2)}  `
      + `clip sd ${withinSd.toFixed(2)}  SE of the 4-clip mean ${se.toFixed(2)}  residual sd ${between.toFixed(2)}  `
      + `-> signal/noise ${(between / se).toFixed(2)}x`);
  }

  // HOW MANY CLIPS WOULD MAKE THIS USABLE. Spearman-Brown, inverted: back out the reliability of a
  // SINGLE clip from the observed 4-clip reliability, then solve for the k that reaches a target.
  // This is the actionable output — the idea does not need a better metric, it needs more samples.
  const r1 = rel > 0 ? (full / (4 - 3 * full)) : 0;
  const clipsFor = (target) => (r1 > 0 && target < 1
    ? Math.ceil((target * (1 - r1)) / (r1 * (1 - target))) : Infinity);
  console.log(`\n   single-clip reliability implied: ${r1.toFixed(3)}`);
  for (const t of [0.7, 0.8, 0.9]) {
    const k = clipsFor(t);
    console.log(`   clips needed for reliability ${t.toFixed(2)}: ${Number.isFinite(k) ? k : 'unreachable'}`
      + `${Number.isFinite(k) ? `  (~${(k * 11).toFixed(0)}s of measurement per film)` : ''}`);
  }
  console.log(`   currently measuring 4 -> reliability ${full.toFixed(2)}`);

  // ---- THE CORRECTION, if the tests allow ----------------------------------------------------
  console.log('\nTHE PROPOSED SHIFT (uncalibrated — the coefficient needs a subjective label)');
  console.log('   less banding than expected -> score UP;  more -> score DOWN.  Capped both ways.');
  const K = Number(val('--k', 0.15));       // points of BPP+ per unit of log residual
  const CAP = Number(val('--cap', 12));      // maximum shift, points
  const shiftOf = (res) => Math.max(-CAP, Math.min(CAP, -K * res * 100 / Math.E));
  const withShift = rows.map((r, i) => ({ r, res: resid[i], shift: shiftOf(resid[i]) }));
  const shifts = withShift.map((x) => x.shift);
  console.log(`   k=${K}, cap +-${CAP} pts  ->  median |shift| ${med(shifts.map(Math.abs)).toFixed(1)} pts, `
    + `${shifts.filter((s) => Math.abs(s) >= CAP - 0.01).length} films at the cap`);
  console.log('\n   BIGGEST UPWARD (cleaner than its score implies — Brennan\'s example case):');
  for (const x of [...withShift].sort((a, b) => b.shift - a.shift).slice(0, 8)) {
    console.log(`     ${x.shift >= 0 ? '+' : ''}${x.shift.toFixed(1)} pts  BPP+ ${String(x.r.bppPlus).padStart(3)} -> `
      + `${String(Math.round(x.r.bppPlus + x.shift)).padStart(3)}  cambi ${x.r.cambi.toFixed(2).padStart(5)}  `
      + `bpp ${x.r.bpp.toFixed(3)}  ${x.r.title}`);
  }
  console.log('\n   BIGGEST DOWNWARD (bands more than a copy this good should):');
  for (const x of [...withShift].sort((a, b) => a.shift - b.shift).slice(0, 8)) {
    console.log(`     ${x.shift.toFixed(1)} pts  BPP+ ${String(x.r.bppPlus).padStart(3)} -> `
      + `${String(Math.round(x.r.bppPlus + x.shift)).padStart(3)}  cambi ${x.r.cambi.toFixed(2).padStart(5)}  `
      + `bpp ${x.r.bpp.toFixed(3)}  ${x.r.title}`);
  }
})();
