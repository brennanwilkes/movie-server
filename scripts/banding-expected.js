#!/usr/bin/env node
/* BANDING EXCESS — Brennan's idea, tested. Is "more banding than this film's content explains" a
 * bitrate-deficiency signal, and can it be folded into BPP+?
 *
 * THE IDEA, and why it is structurally the right shape. Raw CAMBI is not directly actionable: smooth
 * content bands more no matter how many bits it has, and grain suppresses banding no matter how few.
 * So a high reading might mean "starved" or just "this is a smooth modern film". Brennan's proposal
 * is exactly the move BPP+ already makes for bitrate:
 *
 *      BPP+   = what the file HAS (bpp)     / what its content NEEDS (complexity)
 *      excess = banding MEASURED            / banding EXPECTED from its content
 *
 * If the ratio works, it isolates the part of banding that bitrate can fix from the part that is
 * simply what the film looks like — and only the first part belongs anywhere near a score.
 *
 * *** THE ONE RULE THAT MAKES OR BREAKS IT: THE EXPECTED MODEL MUST NOT SEE BITRATE. ***
 * If `expected` is predicted using bpp, R, or file size, then measured/expected has the bitrate
 * signal DIVIDED OUT — the ratio would go quiet exactly where it should shout, and it would look
 * like a clean null result rather than a circular one. So the predictors are content-only:
 *   cxEff  content cost (pinning-corrected, so mostly a property of the film not the copy)
 *   luma   mean brightness — banding lives in dark gradients
 *   year   a proxy for capture medium: film grain dithers, digital sensors do not
 * These correlate with supply only weakly (complexity vs R is -0.137 library-wide), so the ratio
 * keeps essentially all of its bitrate signal.
 *
 * FITTED IN LOG SPACE because cambi spans 0.002-7.2 with most mass under 1. A linear fit would be a
 * report about the three worst films.
 *
 * LEAVE-ONE-OUT. n is 85. Fitting and evaluating on the same rows would guarantee an impressive
 * number and prove nothing, so every film's `expected` is predicted by a model that never saw it.
 *
 * THE PRE-REGISTERED TEST: does excess correlate with supply MORE STRONGLY than raw cambi does?
 * Removing content variance should sharpen a bitrate signal if one is there. If |r| does not improve,
 * the decomposition bought nothing and the idea stops here.
 *
 * USAGE: node scripts/banding-expected.js [--api URL]
 */
const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', process.env.CONTROLLER || 'http://localhost:8088');

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const med = (a) => { const v = [...a].sort((x, y) => x - y); return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2; };
function pearson(xs, ys) {
  const mx = mean(xs); const my = mean(ys);
  const den = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
  return den ? xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / den : 0;
}
const ranks = (v) => {
  const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = [];
  for (let k = 0; k < idx.length;) {
    let m = k; while (m + 1 < idx.length && idx[m + 1][0] === idx[k][0]) m += 1;
    const avg = (k + m) / 2 + 1;
    for (let z = k; z <= m; z += 1) r[idx[z][1]] = avg;
    k = m + 1;
  }
  return r;
};
const spearman = (xs, ys) => pearson(ranks(xs), ranks(ys));

// Ordinary least squares via Gaussian elimination on the normal equations. Three predictors plus an
// intercept — small enough that a dependency would be silly and an ill-conditioned system would be
// obvious in the residuals.
function ols(X, y) {
  const p = X[0].length;
  const A = Array.from({ length: p }, (_, i) => Array.from({ length: p + 1 }, (_, j) => (j < p
    ? X.reduce((s, r, k) => s + r[i] * r[j], 0)
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
  return A.map((row, i) => row[p] / row[i][i] || row[p] / A[i][i]);
}

const L = (v) => Math.log(Math.max(v, 1e-4));

(async () => {
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  const rows = ds.rows.filter((r) => r.cambi != null && r.cxEff > 0 && r.R > 0
    && r.bpp > 0 && r.bppPlus != null && r.cambiLuma != null && r.year);
  console.log(`${rows.length} films with banding + full content context\n`);
  if (rows.length < 30) { console.log('too few to fit'); return; }

  // CONTENT-ONLY design matrix. Nothing here is a function of how many bits the file carries.
  const design = (r) => [1, L(r.cxEff), r.cambiLuma / 100, (r.year - 2000) / 25];
  const y = rows.map((r) => L(r.cambi));

  const full = ols(rows.map(design), y);
  if (!full) { console.log('singular design matrix'); return; }
  console.log('EXPECTED-BANDING MODEL (content only, fitted on all rows for reporting):');
  const names = ['intercept', 'log cxEff', 'luma/100', '(year-2000)/25'];
  full.forEach((b, i) => console.log(`   ${names[i].padEnd(16)} ${b >= 0 ? ' ' : ''}${b.toFixed(4)}`));
  const fitted = rows.map((r) => design(r).reduce((s, v, i) => s + v * full[i], 0));
  const ssTot = y.reduce((s, v) => s + (v - mean(y)) ** 2, 0);
  const ssRes = y.reduce((s, v, i) => s + (v - fitted[i]) ** 2, 0);
  console.log(`   R^2 ${(1 - ssRes / ssTot).toFixed(3)} — content explains this much of log-banding\n`);

  // LEAVE-ONE-OUT expected, so no film's own reading informs its own expectation.
  const excess = [];
  for (let i = 0; i < rows.length; i += 1) {
    const Xi = rows.filter((_, k) => k !== i).map(design);
    const yi = y.filter((_, k) => k !== i);
    const b = ols(Xi, yi);
    if (!b) { excess.push(null); continue; }
    const pred = design(rows[i]).reduce((s, v, j) => s + v * b[j], 0);
    excess.push(y[i] - pred);           // log(measured/expected)
  }
  const ok = rows.map((r, i) => ({ r, ex: excess[i] })).filter((x) => x.ex != null);
  console.log(`leave-one-out excess computed for ${ok.length} films\n`);

  // ---- THE TEST -------------------------------------------------------------------------------
  console.log('THE PRE-REGISTERED TEST — does excess track supply BETTER than raw banding does?');
  console.log(`  ${'against'.padEnd(14)} ${'raw log(cambi)'.padStart(16)} ${'EXCESS'.padStart(16)}   verdict`);
  let better = 0; let worse = 0;
  for (const [name, get] of [['supply R', (r) => L(r.R)], ['bpp', (r) => L(r.bpp)], ['BPP+', (r) => r.bppPlus]]) {
    const xs = ok.map((x) => get(x.r));
    const raw = pearson(xs, ok.map((x) => L(x.r.cambi)));
    const exc = pearson(xs, ok.map((x) => x.ex));
    const rs = spearman(xs, ok.map((x) => L(x.r.cambi)));
    const es = spearman(xs, ok.map((x) => x.ex));
    const gain = Math.abs(exc) - Math.abs(raw);
    if (gain > 0.03) better += 1; else if (gain < -0.03) worse += 1;
    console.log(`  ${name.padEnd(14)} ${`${raw.toFixed(3)} / ${rs.toFixed(3)}`.padStart(16)} `
      + `${`${exc.toFixed(3)} / ${es.toFixed(3)}`.padStart(16)}   ${gain > 0.03 ? `SHARPER by ${gain.toFixed(3)}` : gain < -0.03 ? `weaker by ${(-gain).toFixed(3)}` : 'no change'}`);
  }
  console.log('  (pearson / spearman)');

  // Sanity: excess must be roughly INDEPENDENT of the content it was regressed out of, or the fit
  // failed to do its job and the "excess" still carries content.
  console.log('\nRESIDUAL CHECK — excess should be ~free of the content it was regressed out of:');
  for (const [name, get] of [['cxEff', (r) => L(r.cxEff)], ['luma', (r) => r.cambiLuma], ['year', (r) => r.year]]) {
    console.log(`  vs ${name.padEnd(8)} ${pearson(ok.map((x) => get(x.r)), ok.map((x) => x.ex)).toFixed(3)}`);
  }

  // ---- what it would look like as an adjustment ------------------------------------------------
  // Excess is in log space. exp(excess) is the multiplicative "bands N times more than its content
  // explains" factor, which is the number a human can read and the one a denominator would use.
  const ratios = ok.map((x) => ({ ...x, ratio: Math.exp(x.ex) }));
  const rs = ratios.map((x) => x.ratio).sort((a, b) => a - b);
  console.log(`\nEXCESS AS A RATIO (measured / expected):`);
  console.log(`  p10 ${rs[Math.floor(rs.length * 0.1)].toFixed(2)}x  median ${med(rs).toFixed(2)}x  `
    + `p90 ${rs[Math.floor(rs.length * 0.9)].toFixed(2)}x  max ${rs[rs.length - 1].toFixed(2)}x`);
  console.log('\n  WORST 12 — bands most in excess of what its content explains:');
  for (const x of [...ratios].sort((a, b) => b.ratio - a.ratio).slice(0, 12)) {
    console.log(`   ${x.ratio.toFixed(2)}x  cambi ${x.r.cambi.toFixed(2).padStart(5)}  `
      + `BPP+ ${String(x.r.bppPlus).padStart(3)}  R ${x.r.R.toFixed(2)}  cx ${x.r.cxEff.toFixed(3)}  `
      + `${String(x.r.year)}  ${x.r.title}`);
  }
  console.log('\n  BEST 6 — bands far less than its content would predict:');
  for (const x of [...ratios].sort((a, b) => a.ratio - b.ratio).slice(0, 6)) {
    console.log(`   ${x.ratio.toFixed(2)}x  cambi ${x.r.cambi.toFixed(2).padStart(5)}  `
      + `BPP+ ${String(x.r.bppPlus).padStart(3)}  R ${x.r.R.toFixed(2)}  cx ${x.r.cxEff.toFixed(3)}  ${x.r.title}`);
  }

  // ---- MODEL 2, and it is the one that answers the actual question ----------------------------
  // Model 1 asked "does this film band more than its CONTENT explains" and the answer sharpened
  // against R but WEAKENED against bpp — because bpp is the single best predictor of banding there
  // is (-0.684), better than BPP+ itself (-0.416). That asymmetry is the finding, and it reframes
  // the goal: for an ADJUSTMENT TO THE DENOMINATOR the question is not "more than its content
  // explains" but "more than its content AND its bitrate together explain". A film that still bands
  // after both are accounted for is a film whose measured complexity UNDERSTATES how hard it is to
  // encode cleanly — which is exactly a denominator error, and exactly what an adjustment fixes.
  //
  // This is not circular. bpp is a predictor here, not the thing being predicted: the residual is
  // used to correct the TARGET, never to re-derive the bitrate.
  console.log('\n================ MODEL 2: content + bits ================');
  const design2 = (r) => [1, L(r.cxEff), r.cambiLuma / 100, (r.year - 2000) / 25, L(r.bpp)];
  const full2 = ols(rows.map(design2), y);
  const names2 = ['intercept', 'log cxEff', 'luma/100', '(year-2000)/25', 'log bpp'];
  full2.forEach((b2, i) => console.log(`   ${names2[i].padEnd(16)} ${b2 >= 0 ? ' ' : ''}${b2.toFixed(4)}`));
  const fit2 = rows.map((r) => design2(r).reduce((s, v, i) => s + v * full2[i], 0));
  const ssRes2 = y.reduce((s, v, i) => s + (v - fit2[i]) ** 2, 0);
  console.log(`   R^2 ${(1 - ssRes2 / ssTot).toFixed(3)}  (content alone was ${(1 - ssRes / ssTot).toFixed(3)})`);

  const res2 = [];
  for (let i = 0; i < rows.length; i += 1) {
    const b2 = ols(rows.filter((_, k) => k !== i).map(design2), y.filter((_, k) => k !== i));
    res2.push(b2 ? y[i] - design2(rows[i]).reduce((s, v, j) => s + v * b2[j], 0) : null);
  }
  const ok2 = rows.map((r, i) => ({ r, ex: res2[i] })).filter((x) => x.ex != null);
  const sdr = sd(ok2.map((x) => x.ex));
  console.log(`\n   residual sd ${sdr.toFixed(3)} in log space = a typical film sits within `
    + `x${Math.exp(sdr).toFixed(2)} of its prediction`);

  // THE EQUALISATION TEST. A denominator's whole job is to make scores comparable ACROSS films. So:
  // among films at similar BPP+, does banding still vary? If it does, BPP+ is not capturing
  // everything and there is room for an adjustment. If it does not, there is nothing to fix.
  console.log('\n   EQUALISATION TEST — among films at SIMILAR BPP+, does banding still vary?');
  const bands = [[0, 60], [60, 75], [75, 95], [95, 250]];
  for (const [lo, hi] of bands) {
    const g = ok2.filter((x) => x.r.bppPlus >= lo && x.r.bppPlus < hi);
    if (g.length < 6) continue;
    const cs = g.map((x) => x.r.cambi).sort((a, b) => a - b);
    console.log(`     BPP+ ${String(lo).padStart(3)}-${String(hi).padEnd(3)} n=${String(g.length).padStart(2)}  `
      + `cambi p10 ${cs[Math.floor(cs.length * 0.1)].toFixed(2)}  med ${med(cs).toFixed(2)}  `
      + `p90 ${cs[Math.floor(cs.length * 0.9)].toFixed(2)}   spread ${(cs[Math.floor(cs.length * 0.9)] / Math.max(cs[Math.floor(cs.length * 0.1)], 0.01)).toFixed(0)}x`);
  }

  console.log('\n   FILMS WHOSE DENOMINATOR LOOKS TOO LOW (band despite their content AND their bits):');
  for (const x of [...ok2].sort((a, b) => b.ex - a.ex).slice(0, 10)) {
    const adj = Math.min(1.6, Math.exp(0.35 * Math.max(0, x.ex)));
    const newPlus = Math.round(x.r.bppPlus / Math.sqrt(adj));
    console.log(`     x${Math.exp(x.ex).toFixed(1).padStart(5)} excess  cambi ${x.r.cambi.toFixed(2).padStart(5)}  `
      + `BPP+ ${String(x.r.bppPlus).padStart(3)} -> ${String(newPlus).padStart(3)} at adj x${adj.toFixed(2)}  ${x.r.title}`);
  }
  console.log('\n   (the adjustment shown is ILLUSTRATIVE: exp(0.35*excess) capped at 1.6 on the');
  console.log('    DENOMINATOR. 0.35 is not fitted to anything — calibrating it needs a subjective');
  console.log('    label, which this library still does not have.)');
})();
