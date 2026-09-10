/* MEASURE CAMBI'S NOISE FLOOR — so the error model has no chosen constant in it.
 *
 * THE DEFECT THIS FIXES. blend-math.js estimated Var(ln L) as one library-wide number from CAMBI's
 * split-half reliability, i.e. CONSTANT in log space. That says a reading of 0.003 is as informative
 * as a reading of 4.99, which is false: near zero the detector's absolute error is roughly fixed, so
 * the LOG error diverges. The consequence was visible in the Blend tab — The Big Sleep, banding 0.003,
 * came out at 96% confidence and +256 BPP+, the highest confidence in the table, because a steep
 * slope (-2.82) then divides the understated variance by S^2 = 7.95.
 *
 * THE MEASUREMENT. 21 films carry TWO INDEPENDENT readings of the same quantity — their own banding:
 *   - the nightly probe, 8 clips chosen by the nightly sampler
 *   - the ladder's LOSSLESS rung, 4 different clips, no compression added
 * Same file, same artifact, different scene samples. Their disagreement IS the measurement error, and
 * it needs no labels and no assumptions about which is right.
 *
 * THE MODEL, the standard two-component one for a detector with a floor:
 *
 *     sd(L) = sqrt( eps^2 + (k*L)^2 )        eps = absolute floor, k = proportional term
 *     Var(ln L) = (eps/L)^2 + k^2
 *
 * As L -> 0 that diverges on its own, which is what a floor constant was faking. For a difference of
 * two independent readings, E[d^2] = 2*eps^2 + 2*k^2*B^2, so regressing d^2 on B^2 recovers both.
 *
 * USAGE: node scripts/cambi-noise-floor.mjs
 */
import fs from 'fs';

const lads = JSON.parse(fs.readFileSync('bpp-lab/public/ladders.json', 'utf8')).films;
const ds = await (await fetch('http://localhost:8088/api/probe/dataset')).json();
const rows = new Map(ds.rows.filter((r) => r.cambi != null).map((r) => [r.key, r]));

const pairs = [];
for (const f of lads) {
  const r = rows.get(f.key);
  if (!r || f.lossless == null) continue;
  pairs.push({ title: f.title, a: r.cambi, b: f.lossless });
}
console.log(`\n${pairs.length} films with two independent banding readings\n`);
console.log(`${'film'.padEnd(34)} ${'nightly'.padStart(8)} ${'lossless'.padStart(9)} ${'diff'.padStart(8)}`);
for (const p of pairs.sort((x, y) => (x.a + x.b) - (y.a + y.b))) {
  console.log(`${p.title.slice(0, 33).padEnd(34)} ${p.a.toFixed(4).padStart(8)} `
    + `${p.b.toFixed(4).padStart(9)} ${(p.a - p.b).toFixed(4).padStart(8)}`);
}

// Regress d^2 on B^2 through both parameters. B is the best estimate of the true level, the mean of
// the two readings — using either one alone would correlate the regressor with its own error.
const X = pairs.map((p) => ((p.a + p.b) / 2) ** 2);
const Y = pairs.map((p) => (p.a - p.b) ** 2);
const n = X.length;
const mx = X.reduce((s, v) => s + v, 0) / n;
const my = Y.reduce((s, v) => s + v, 0) / n;
let sxx = 0; let sxy = 0;
for (let i = 0; i < n; i += 1) { sxx += (X[i] - mx) ** 2; sxy += (X[i] - mx) * (Y[i] - my); }
const slope = sxy / sxx;
const inter = my - slope * mx;

const eps = Math.sqrt(Math.max(inter, 0) / 2);
const k = Math.sqrt(Math.max(slope, 0) / 2);
console.log(`\nregression of d^2 on B^2:  slope ${slope.toFixed(5)}  intercept ${inter.toFixed(5)}`);
console.log(`  eps (absolute floor)      = ${eps.toFixed(4)} CAMBI units`);
console.log(`  k   (proportional error)  = ${k.toFixed(4)}  (${(k * 100).toFixed(0)}%)`);

console.log('\nwhat that does to Var(ln L), which is what the shift\'s standard error divides by:\n');
console.log(`  ${'banding L'.padStart(10)} ${'Var(ln L)'.padStart(10)} ${'sd(ln L)'.padStart(9)} `
  + `${'level known to'.padStart(15)}`);
for (const L of [0.003, 0.01, 0.1, 0.3, 1, 2.817, 5]) {
  const v = (eps / L) ** 2 + k ** 2;
  console.log(`  ${L.toFixed(3).padStart(10)} ${v.toFixed(3).padStart(10)} ${Math.sqrt(v).toFixed(3).padStart(9)} `
    + `${(`x${Math.exp(Math.sqrt(v)).toFixed(2)}`).padStart(15)}`);
}
console.log('\n  The Big Sleep sits at the top row. Its banding is not "0.003", it is "somewhere');
console.log('  under the detector\'s resolution", and the error model now says so by itself.');
