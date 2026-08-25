#!/usr/bin/env node
/* IS CAMBI AN INDEPENDENT AXIS, OR ANOTHER gShare?
 *
 * gShare was killed because it turned out to be a restatement of DARKNESS (r = -0.885 against mean
 * luma) rather than a measure of grain. CAMBI can fail the same way, and the point of this script is
 * to give it every chance to. The tests and their thresholds are fixed here BEFORE the numbers are
 * read, so a marginal result cannot be talked into being a finding.
 *
 * PRE-REGISTERED DECISION RULES
 *   D1 GRAIN DEGENERACY.  |r(cambi, complexity)| > 0.6  => CAMBI is a grain detector wearing a new
 *                         name. Grain dithers gradients and suppresses banding, so a strong negative
 *                         correlation is the expected shape of this failure.
 *   D2 DARKNESS DEGENERACY. |r(cambi, luma)| > 0.6  => it is gShare again. This is the one the smoke
 *                         test already hinted at (Rocky, luma 37, cambi 8.24 against ~0.5 for the
 *                         bright films).
 *   D3 REDUNDANCY.        |r(cambi, bppPlus)| > 0.6  => it tells us what BPP+ already told us, so it
 *                         adds no information even if it is real.
 *   PASS = all three below 0.6, i.e. banding is a genuinely separate failure mode. Anything in
 *   0.4-0.6 is reported as partial dependence, never rounded down to "independent".
 *
 * AND ONE POSITIVE TEST, because passing three negatives only shows CAMBI measures SOMETHING else:
 *   P1 It should find banding where banding physically comes from — low bitrate on smooth content.
 *      Among films with LOW complexity (smooth, few gradients broken up by detail), the starved ones
 *      should band more than the well-supplied ones. If CAMBI is noise, that gradient is absent.
 *
 * Spearman is used alongside Pearson throughout: cambi is heavily right-skewed (one film at 8, most
 * below 1), and Pearson on that is a report about the outlier.
 *
 * USAGE: node scripts/cambi-analyse.js [--in data/cambi.json]
 */
const fs = require('fs');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const IN = val('--in', `${__dirname}/../data/cambi.json`);

const films = JSON.parse(fs.readFileSync(IN, 'utf8')).films.filter((f) => f.cambiMean != null);
if (films.length < 8) { console.log(`only ${films.length} films measured — too few`); process.exit(0); }

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => Math.sqrt(a.reduce((s, v) => s + (v - mean(a)) ** 2, 0) / (a.length - 1));
const med = (a) => { const v = [...a].sort((x, y) => x - y); return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2; };
function pearson(xs, ys) {
  const mx = mean(xs); const my = mean(ys);
  return xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0)
    / Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
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

const C = films.map((f) => f.cambiMean);
console.log(`CAMBI over ${films.length} films\n`);
const q = (a, p) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];
console.log(`  distribution: min ${Math.min(...C).toFixed(3)}  p25 ${q(C, 0.25).toFixed(3)}  `
  + `median ${med(C).toFixed(3)}  p75 ${q(C, 0.75).toFixed(3)}  max ${Math.max(...C).toFixed(3)}`);
console.log(`  mean ${mean(C).toFixed(3)}  sd ${sd(C).toFixed(3)}  `
  + `(right-skewed: ${C.filter((v) => v > med(C) * 3).length} films above 3x the median)\n`);

const withLuma = films.filter((f) => f.yavg != null);
const TESTS = [
  ['D1 grain', films.map((f) => f.complexity), C, 'complexity'],
  ['D2 darkness', withLuma.map((f) => f.yavg), withLuma.map((f) => f.cambiMean), 'mean luma'],
  ['D3 redundancy', films.map((f) => f.bppPlus), C, 'BPP+'],
];
console.log('DEGENERACY TESTS (threshold |r| > 0.6 = fails, CAMBI is not a new axis)');
let failed = 0; let partial = 0;
for (const [name, xs, ys, lab] of TESTS) {
  const p = pearson(xs, ys); const s = spearman(xs, ys);
  const worst = Math.max(Math.abs(p), Math.abs(s));
  const verdict = worst > 0.6 ? 'FAILS' : worst > 0.4 ? 'partial' : 'passes';
  if (worst > 0.6) failed += 1; else if (worst > 0.4) partial += 1;
  console.log(`  ${name.padEnd(16)} vs ${lab.padEnd(11)} pearson ${p >= 0 ? ' ' : ''}${p.toFixed(3)}  `
    + `spearman ${s >= 0 ? ' ' : ''}${s.toFixed(3)}   ${verdict}`);
}
// R is worth reporting even though it is not a pre-registered test: it is what a banding gate would
// most plausibly be confounded with, since starved files are where banding is expected.
{
  const p = pearson(films.map((f) => f.R), C); const s = spearman(films.map((f) => f.R), C);
  console.log(`  ${'(context)'.padEnd(16)} vs ${'supply R'.padEnd(11)} pearson ${p >= 0 ? ' ' : ''}${p.toFixed(3)}  spearman ${s >= 0 ? ' ' : ''}${s.toFixed(3)}`);
}

console.log('\nP1 POSITIVE TEST — among SMOOTH films (low complexity), do starved copies band more?');
const smooth = [...films].sort((a, b) => a.complexity - b.complexity).slice(0, Math.max(6, Math.floor(films.length / 2)));
const byR = [...smooth].sort((a, b) => a.R - b.R);
const half = Math.floor(byR.length / 2);
const lowR = byR.slice(0, half); const hiR = byR.slice(-half);
console.log(`  smooth half (n=${smooth.length}), split on supply:`);
console.log(`    starved (med R ${med(lowR.map((f) => f.R)).toFixed(2)}): median cambi ${med(lowR.map((f) => f.cambiMean)).toFixed(3)}`);
console.log(`    supplied (med R ${med(hiR.map((f) => f.R)).toFixed(2)}): median cambi ${med(hiR.map((f) => f.cambiMean)).toFixed(3)}`);
const ratio = med(lowR.map((f) => f.cambiMean)) / (med(hiR.map((f) => f.cambiMean)) || 1e-9);
console.log(`    starved/supplied ratio ${ratio.toFixed(2)}x  `
  + `${ratio > 1.5 ? '-> banding tracks starvation on smooth content, as predicted' : ratio < 0.67 ? '-> BACKWARDS: starved files band LESS, which the model cannot explain' : '-> no gradient; CAMBI is not detecting bitrate-driven banding here'}`);

console.log('\nWORST 10 BY CAMBI (the films a banding gate would flag):');
for (const f of [...films].sort((a, b) => b.cambiMean - a.cambiMean).slice(0, 10)) {
  console.log(`  ${f.cambiMean.toFixed(3).padStart(8)}  luma ${String(f.yavg).padStart(6)}  `
    + `cx ${f.complexity.toFixed(3)}  R ${f.R.toFixed(2)}  BPP+ ${String(f.bppPlus).padStart(3)}  `
    + `${(f.source || '').padEnd(14)} ${f.title}`);
}
console.log('\nCLEANEST 5:');
for (const f of [...films].sort((a, b) => a.cambiMean - b.cambiMean).slice(0, 5)) {
  console.log(`  ${f.cambiMean.toFixed(3).padStart(8)}  luma ${String(f.yavg).padStart(6)}  `
    + `cx ${f.complexity.toFixed(3)}  R ${f.R.toFixed(2)}  BPP+ ${String(f.bppPlus).padStart(3)}  ${f.title}`);
}

console.log(`\nVERDICT: ${failed ? `${failed} degeneracy test(s) FAILED — CAMBI is not an independent axis as measured here.`
  : partial ? `no outright failure, ${partial} partial dependence — treat as promising, not proven.`
    : 'all three degeneracy tests pass — banding looks like a genuinely separate failure mode.'}`);
console.log('NOTE: none of this is validated against anything Brennan has seen. It establishes whether');
console.log('CAMBI carries INFORMATION the score lacks, not whether that information matters to him.');
