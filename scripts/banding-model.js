#!/usr/bin/env node
/* THE EXPECTED-BANDING MODEL — content-measured predictors only, no metadata.
 *
 * Brennan's constraint, and it is the right one: "I dont want to use subjective things like film year
 * or genre in these calculations, ever. I only want to use quantifiable data points which we can mine
 * from the content itself."
 *
 * That rules out `year`, which the first version leaned on as a proxy for capture medium. It was
 * exactly the wrong kind of predictor — metadata standing in for a physical property, unverifiable,
 * sometimes wrong, and never actually measured. Everything below is read off the pixels:
 *
 *   log(bpp)   bits per pixel per frame, from the file             ← the thing being disagreed with
 *   log(cxEff) CRF-20 content cost, from the probe
 *   luma       mean brightness of the sampled frames
 *   flat       FRACTION OF FRAME AREA in a flat neighbourhood      ← the new one
 *   flatSd     within-clip variability of that fraction
 *   flatBtw    between-clip variability of that fraction
 *
 * `flat` is the physically right predictor for banding and the reason this refit exists. Banding
 * happens in large smooth gradients, so what decides whether a film CAN band is how much of the frame
 * is such a gradient — not how old it is. Measured by sobel-then-threshold, so it is a direct
 * geometric property of the image.
 *
 * WHY IT MATTERS THAT R^2 GOES UP: the artifact-residual correction scores with the RESIDUAL, so
 * every bit of variance the model fails to explain becomes a spurious correction. That is why 2001: A
 * Space Odyssey (cambi 0.32, below the library median) took the maximum penalty under the old model.
 * A better model does not make the correction stronger — it makes it GENTLER and better targeted.
 *
 * Leave-one-out throughout, and models are compared on LOO error rather than in-sample R^2, because
 * adding predictors always raises the latter.
 *
 * USAGE: node scripts/banding-model.js
 */
const fs = require('fs');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', process.env.CONTROLLER || 'http://localhost:8088');
const FLAT = val('--flat', `${__dirname}/../data/flat-area.json`);

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)); };
function pearson(xs, ys) {
  const mx = mean(xs); const my = mean(ys);
  const den = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
  return den ? xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / den : 0;
}
function ols(X, y) {
  const p = X[0].length;
  const A = Array.from({ length: p }, (_, i) => Array.from({ length: p + 1 }, (_, j) => (j < p
    ? X.reduce((s, r) => s + r[i] * r[j], 0) : X.reduce((s, r, k) => s + r[i] * y[k], 0))));
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

// LOO root-mean-square error — the honest comparator. In-sample R^2 can only rise as predictors are
// added, so choosing a model on it guarantees the most complex one wins regardless of merit.
function looRmse(rows, design, y) {
  let ss = 0; let n = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const b = ols(rows.filter((_, k) => k !== i).map(design), y.filter((_, k) => k !== i));
    if (!b) continue;
    const pred = design(rows[i]).reduce((s, v, j) => s + v * b[j], 0);
    ss += (y[i] - pred) ** 2; n += 1;
  }
  return n ? Math.sqrt(ss / n) : null;
}
const r2Of = (rows, design, y) => {
  const b = ols(rows.map(design), y);
  if (!b) return null;
  const fit = rows.map((r) => design(r).reduce((s, v, i) => s + v * b[i], 0));
  const my = mean(y);
  return 1 - y.reduce((s, v, i) => s + (v - fit[i]) ** 2, 0) / y.reduce((s, v) => s + (v - my) ** 2, 0);
};

(async () => {
  const [ds, bd] = await Promise.all([
    (await fetch(`${API}/api/probe/dataset`)).json(),
    (await fetch(`${API}/api/banding/dataset`)).json(),
  ]);
  const flat = new Map(JSON.parse(fs.readFileSync(FLAT, 'utf8')).rows.map((r) => [r.key, r]));
  const clips = new Map(bd.rows.filter((r) => Array.isArray(r.sampleCambi) && r.sampleCambi.length >= 4)
    .map((r) => [r.key, r.sampleCambi]));
  const rows = ds.rows.filter((r) => r.cambi != null && r.cxEff > 0 && r.bpp > 0
    && r.cambiLuma != null && flat.has(r.key)).map((r) => ({ ...r, ...flat.get(r.key) }));
  console.log(`${rows.length} films with banding + flat-area\n`);

  const y = rows.map((r) => L(r.cambi));

  console.log('IS FLAT-AREA EVEN RELATED TO BANDING? (raw correlations against log cambi)');
  for (const [n, g] of [['flat fraction', (r) => r.flat], ['flat within-clip sd', (r) => r.flatSd],
    ['flat between-clip sd', (r) => r.flatBetween], ['luma', (r) => r.cambiLuma],
    ['log bpp', (r) => L(r.bpp)], ['log cxEff', (r) => L(r.cxEff)]]) {
    console.log(`   ${n.padEnd(22)} ${pearson(rows.map(g), y) >= 0 ? ' ' : ''}${pearson(rows.map(g), y).toFixed(3)}`);
  }

  // Candidate models. Every predictor is measured off the pixels; `year` is deliberately absent.
  const MODELS = [
    ['bits only', (r) => [1, L(r.bpp)]],
    ['bits + cx', (r) => [1, L(r.bpp), L(r.cxEff)]],
    ['bits + cx + luma', (r) => [1, L(r.bpp), L(r.cxEff), r.cambiLuma / 100]],
    ['OLD (with year)', (r) => [1, L(r.bpp), L(r.cxEff), r.cambiLuma / 100, (r.year - 2000) / 25]],
    ['+ flat', (r) => [1, L(r.bpp), L(r.cxEff), r.cambiLuma / 100, r.flat]],
    ['+ flat + sds', (r) => [1, L(r.bpp), L(r.cxEff), r.cambiLuma / 100, r.flat, r.flatSd, r.flatBetween]],
    ['+ flat, no luma', (r) => [1, L(r.bpp), L(r.cxEff), r.flat]],
    ['+ flat + flat^2', (r) => [1, L(r.bpp), L(r.cxEff), r.cambiLuma / 100, r.flat, r.flat * r.flat]],
  ];
  console.log('\nMODEL COMPARISON — chosen on LOO error, not in-sample R^2');
  console.log(`  ${'model'.padEnd(20)} ${'R2'.padStart(6)} ${'LOO rmse'.padStart(9)}   (lower rmse is better)`);
  let best = null;
  for (const [name, design] of MODELS) {
    const r2 = r2Of(rows, design, y); const rmse = looRmse(rows, design, y);
    if (r2 == null || rmse == null) { console.log(`  ${name.padEnd(20)} singular`); continue; }
    if (!best || rmse < best.rmse) best = { name, design, rmse, r2 };
    const tag = name === 'OLD (with year)' ? '  <- metadata, now disallowed' : '';
    console.log(`  ${name.padEnd(20)} ${r2.toFixed(3).padStart(6)} ${rmse.toFixed(4).padStart(9)}${tag}`);
  }
  console.log(`\n  BEST: ${best.name}  (R2 ${best.r2.toFixed(3)}, LOO rmse ${best.rmse.toFixed(4)})`);

  const b = ols(rows.map(best.design), y);
  console.log('\n  coefficients:');
  b.forEach((v, i) => console.log(`     [${i}] ${v >= 0 ? ' ' : ''}${v.toFixed(4)}`));

  // What the improvement buys the CORRECTION: a smaller residual means smaller, better-aimed shifts.
  const resid = [];
  for (let i = 0; i < rows.length; i += 1) {
    const bb = ols(rows.filter((_, k) => k !== i).map(best.design), y.filter((_, k) => k !== i));
    resid.push(bb ? y[i] - best.design(rows[i]).reduce((s, v, j) => s + v * bb[j], 0) : null);
  }
  const ok = rows.map((r, i) => ({ r, e: resid[i] })).filter((x) => x.e != null);
  console.log(`\n  residual sd ${sd(ok.map((x) => x.e)).toFixed(3)} (was 1.215 under the old model)`);

  console.log('\n  DID THE ABSURD PENALTIES GO AWAY? (films with LOW banding that were punished hardest)');
  for (const t of ['2001: A Space Odyssey', 'Gladiator', 'Kill Bill: Vol. 1', 'E.T. the Extra']) {
    const x = ok.find((z) => z.r.title.startsWith(t));
    if (!x) continue;
    console.log(`     ${t.slice(0, 24).padEnd(26)} cambi ${x.r.cambi.toFixed(2).padStart(5)}  `
      + `flat ${x.r.flat.toFixed(3)}  residual ${x.e >= 0 ? '+' : ''}${x.e.toFixed(2)}  `
      + `${Math.abs(x.e) < 0.7 ? 'now modest' : 'STILL LARGE'}`);
  }
})();
