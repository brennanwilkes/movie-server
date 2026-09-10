/* THE ANCHOR, FROM BOTH LEGS ON THE SAME CLIPS — analysis for scripts/denoise-crossed.js.
 *
 * WHAT THIS SETTLES. 11.30 left the anchor with two answers 4.6x apart, because the measured one
 * divided a library-wide P gap by a ladder-measured P slope — two populations joined by an
 * unvalidated transfer assumption. The crossed ladder measures both legs on the same clips, so:
 *     anchor = exp( (dP/dstep) / |dP/dlog bpp| ) - 1
 * with no transfer at all. Whatever comes out is the exchange rate for our encoder on our content.
 *
 * THE RATIO IS THE STATISTIC, NOT THE SLOPES. Leg A's 1.0x rung and leg B's generation-1 row are the
 * same encode, so both legs are pinned to a common point and any per-film offset in P cancels. The
 * individual slopes are film-specific and not comparable across films; the ratio is.
 *
 * DIRECTION CHECKS COME FIRST, per film, and a film failing either is EXCLUDED rather than averaged
 * in. If P does not fall with bits or rise with generations on a given film, P is not tracking damage
 * there and its ratio is noise divided by noise.
 *
 * USAGE: node scripts/denoise-crossed-analyse.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = { cambi: +1, block: +1, blur: +1, grain: -1 };

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const q = (a, f) => a.slice().sort((x, y) => x - y)[Math.floor(f * (a.length - 1))];
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
function fit(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length < 3) return null;
  const mx = mean(pts.map((p) => p[0])); const my = mean(pts.map((p) => p[1]));
  let n = 0; let d = 0;
  for (const [x, y] of pts) { n += (x - mx) * (y - my); d += (x - mx) ** 2; }
  return d > 0 ? n / d : null;
}

/* The library's per-detector residual scales, so P here is in the SAME units as the shipped rule's P.
 * Recomputed rather than read from provenance.json because that file stores standardised values, not
 * the scales themselves. */
const rows = [];
const seen = new Set();
for (const f of ['data/artifact-backfill.json', 'data/provenance-wild.json']) {
  let d; try { d = JSON.parse(fs.readFileSync(f, 'utf8')).units; } catch { continue; }
  for (const [key, u] of Object.entries(d)) {
    if (!seen.has(key) && u.bpp > 0 && u.cxEff > 0 && DET.every((k) => u[k] > 0)) { rows.push({ key, ...u }); seen.add(key); }
  }
}
const lb = rows.map((u) => Math.log(u.bpp));
const lc = rows.map((u) => Math.log(u.cxEff));
const hev = rows.map((u) => (u.codec === 'hevc' ? 1 : 0));
const X = rows.map((u, i) => [1, lb[i], lb[i] ** 2, lc[i], lc[i] ** 2, lb[i] * lc[i], hev[i], hev[i] * lb[i]]);
const SD = {}; const Zc = {};
for (const d of DET) {
  const y = rows.map((u) => Math.log(u[d]));
  const be = ols(X, y);
  const r = y.map((v, i) => v - X[i].reduce((s, z, j) => s + z * be[j], 0));
  SD[d] = sd(r); Zc[d] = r.map((v) => v / SD[d]);
}
const SDSUM = sd(rows.map((_, i) => DET.reduce((s, d) => s + EXPECT[d] * Zc[d][i], 0)));
const pOf = (m) => DET.reduce((s, d) => s + (m[d] > 0 ? (EXPECT[d] * Math.log(m[d])) / SD[d] : 0), 0) / SDSUM;

const data = JSON.parse(fs.readFileSync('data/denoise-crossed.json', 'utf8'));
console.log(`\n  ${data.films.length} films, levels ${data.levels.join('/')}, denoise ${(data.denoise || []).join('/')}\n`);
console.log(`  ${'film'.padEnd(34)} ${'dP/dlogbpp'.padStart(11)} ${'dP/dstep'.padStart(9)} ${'anchor%'.padStart(9)}  status`);

const good = [];
for (const f of data.films) {
  const A = (f.legA || []).filter((r) => DET.every((d) => r[d] > 0));
  const B = (f.legB || []).filter((r) => DET.every((d) => r[d] > 0));
  if (A.length < 3 || B.length < 2) { console.log(`  ${f.title.slice(0, 33).padEnd(34)} ${'—'.padStart(11)} ${'—'.padStart(9)} ${'—'.padStart(9)}  too few rungs`); continue; }
  const sA = fit(A.map((r) => Math.log(r.level)), A.map((r) => pOf(r)));
  const sB = fit(B.map((r) => r.step), B.map((r) => pOf(r)));
  if (sA == null || sB == null) { console.log(`  ${f.title.slice(0, 33).padEnd(34)}  degenerate fit`); continue; }
  /* Direction checks. Fewer bits must make P worse (sA < 0); more generations must make P worse
   * (sB > 0). A film failing either is excluded, not averaged in. */
  const okA = sA < 0; const okB = sB > 0;
  const pct = okA && okB ? (Math.exp(sB / Math.abs(sA)) - 1) * 100 : NaN;
  const status = okA && okB ? 'ok' : `${okA ? '' : 'leg A wrong sign '}${okB ? '' : 'leg B wrong sign'}`.trim();
  if (okA && okB) good.push({ title: f.title, cxEff: f.cxEff, sA, sB, pct });
  console.log(`  ${f.title.slice(0, 33).padEnd(34)} ${sA.toFixed(3).padStart(11)} ${sB.toFixed(3).padStart(9)} `
    + `${(Number.isFinite(pct) ? pct.toFixed(1) : '—').padStart(9)}  ${status}`);
}

console.log(`\n  ${good.length} of ${data.films.length} films pass both direction checks`);
if (good.length < 3) {
  console.log('\n  NOT ENOUGH USABLE FILMS. P is not tracking damage on this content, and no ratio');
  console.log('  computed from it means anything. Do NOT quote an anchor from this run.\n');
  process.exit(0);
}
const pcts = good.map((g) => g.pct);
console.log(`\n  ANCHOR — one generation, in bitrate terms, measured on identical clips\n`);
console.log(`    p10 ${q(pcts, 0.1).toFixed(1)}%   median ${med(pcts).toFixed(1)}%   p90 ${q(pcts, 0.9).toFixed(1)}%`);
console.log(`    mean of per-film ratios ${mean(pcts).toFixed(1)}%   sd ${sd(pcts).toFixed(1)}`);

/* THE HEADLINE IS THE RATIO OF MEDIAN SLOPES, NOT THE MEDIAN OF PER-FILM RATIOS.
 *
 * This choice was made after seeing interim data on 4 films, and that is stated plainly rather than
 * hidden — but it follows from a principle established BEFORE this run, in 11.35: build the composite
 * first and divide second, because dividing per-film by a shallow slope amplifies that film's noise
 * by 1/S. The interim run showed exactly the predicted failure: The Creator's leg-A slope came out at
 * -0.056 and its per-film ratio exploded to 362%, dragging the MEAN of ratios to 118% with an sd of
 * 163 while the median sat at 42.6%.
 *
 * A ratio of medians never divides by any single film's shallow slope — it pools both legs first and
 * divides once. The per-film ratios remain in the table above so the spread is visible, and the
 * diagnostic line below fires when the two disagree, which is the signal that a few films dominate. */
const pooled = (Math.exp(med(good.map((g) => g.sB)) / Math.abs(med(good.map((g) => g.sA)))) - 1) * 100;
const medRatio = med(pcts);
console.log(`\n    RATIO OF MEDIAN SLOPES  ${pooled.toFixed(1)}%   <- the headline; pools first, divides once`);
console.log(`    median of per-film ratios ${medRatio.toFixed(1)}%   `
  + `${Math.abs(pooled - medRatio) > 0.3 * Math.max(pooled, medRatio) ? '(DISAGREES — a few films dominate the per-film view)' : '(agrees)'}`);
/* Films whose leg-A slope is too shallow to divide by are named, because they are the ones that make
 * a per-film exchange rate untrustworthy and the reader should see which they were. */
const fragile = good.filter((g) => Math.abs(g.sA) < 0.15);
if (fragile.length) {
  console.log(`    fragile (|leg-A slope| < 0.15, so 1/S > 6.7): `
    + fragile.map((g) => `${g.title} ${g.sA.toFixed(3)} -> ${g.pct.toFixed(0)}%`).join('; '));
}

console.log('\n  AGAINST THE TWO STANDING ANSWERS');
console.log(`    one GENERATION (measured)     33.1%`);
console.log(`    P moves 2.42x more per denoise step than per generation (11.45)`);
console.log(`    A DENOISE STEP, no transfer    ${pooled.toFixed(1)}%`);
const m = pooled;
console.log('\n  WHAT THIS SETTLES (11.45)\n');
console.log('  The shipped rule converts P to bitrate through the GENERATION rate. P is 2.42x more');
console.log('  sensitive to a denoise step than to a generation, so a preprocessing-dominated film is');
console.log('  currently scaled by a rate measured on a different axis. This run gives the missing');
console.log('  number: what a denoise step is worth in bitrate, with no transfer assumption.');
console.log('');
if (m >= 5 && m <= 60) {
  console.log(`  A denoise step is worth ${m.toFixed(1)}% bitrate against a generation's 33.1%.`);
  console.log('  The two axes can now be scaled separately, and the calibration can stop assuming');
  console.log('  every film\'s P is generation-like.');
} else if (m > 60) {
  console.log(`  ${m.toFixed(1)}% — a denoise step costs far more bitrate-equivalent than a generation.`);
  console.log('  Check it against an external bound before adopting: heavy hqdn3d is a large filter and');
  console.log('  a big number may be real, but this project has been wrong about a big number before.');
} else {
  console.log(`  ${m.toFixed(1)}% — implausibly small. Check leg B actually moved before believing it.`);
}
console.log('');
