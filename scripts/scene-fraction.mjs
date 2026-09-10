/* THE SCENE-FRACTION VISIBILITY STATISTIC — Brennan's p95 idea, and what it would actually take.
 *
 * THE IDEA, in his words: "if we had a perfect covering set of artifacts, measuring a sort of P95 of
 * 0, or like hey we're at 5% or less of visible artifacts sort of thing, that's sort of good enough
 * to be considered close to 100." That logic is sound and it is a better target than a mean, for a
 * reason the data makes obvious: artifacts are a SCENE property, not a film property. One film in
 * this set reads cambi 0.109 on one clip and 5.881 on another against a threshold of 2.817. The MEAN
 * of those is below threshold and the film looks clean; a quarter of its scenes are not.
 *
 * WHY THE SHIPPED HEADLINE IS WRONG BY ~3x. The band table counts the 4-clip MEAN against 2.817, but
 * 2.817 is a SCENE-LEVEL threshold taken from Netflix's published CAMBI work. Mean-above-threshold
 * and any-scene-above-threshold are different questions and the shipped text answers the wrong one:
 *     mean > T      20%
 *     ANY clip > T  67%
 * This script computes the whole distribution rather than either endpoint.
 *
 * *** THE STATISTICAL WALL, AND IT IS THE REAL ANSWER. *** A scene fraction estimated from n clips
 * has a binomial error that swamps the target. By the rule of three, observing ZERO exceedances in n
 * clips only bounds the true rate below about 3/n at 95% confidence:
 *     n = 4 clips   ->  true rate could be up to 75%
 *     n = 8 clips   ->  up to 37%
 *     n = 60 clips  ->  up to 5%
 * So "5% or less of scenes show a visible artifact" is NOT MEASURABLE AT ALL with 4 clips, or 8. A
 * clean read at n=4 is consistent with three quarters of the film being visibly damaged. The idea is
 * right; the sampling is three orders of magnitude short of it. That is a data-collection answer, not
 * a modelling one, and it is cheap: ~60 x 2s clips is two minutes of video per film.
 *
 * GRAIN RUNS THE OTHER WAY. Grain is a RETENTION measure with direction -1 in the factor: low grain
 * means texture was destroyed. Its exceedance test is grain < 0.905, not grain > 0.905. Getting this
 * backwards is the same error that inverted the denoise axis, so it is written out explicitly here.
 *
 * READ-ONLY analysis of data/clip-reliability.json (60 films, per-clip readings already on disk).
 * USAGE: node scripts/scene-fraction.mjs
 */
import fs from 'fs';

/* Absolute, externally anchored. Banding is Netflix's published CAMBI JND point; the other three
 * were derived from 245 CVQAD labels by anchoring to it. These are SCENE-level numbers. */
const THRESH = { cambi: 2.817, block: 3.710, blur: 8.026, grain: 0.905 };
const DIR = { cambi: +1, block: +1, blur: +1, grain: -1 };   /* +1: exceed above. -1: exceed BELOW. */
const DET = ['cambi', 'block', 'blur', 'grain'];

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const q = (a, f) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(f * (s.length - 1))))]; };
const over = (d, v) => (DIR[d] > 0 ? v > THRESH[d] : v < THRESH[d]);

const data = JSON.parse(fs.readFileSync('data/clip-reliability.json', 'utf8'));
const units = Object.values(data.units).filter((u) => Array.isArray(u.clips) && u.clips.length >= 4);
const NC = med(units.map((u) => u.clips.length));
console.log(`\n  ${units.length} films, median ${NC} clips each, ${data.seclen ?? '?'}s per clip\n`);

/* ---- 1. mean-above vs any-above, the headline correction ---- */
console.log('  THE HEADLINE DEPENDS ENTIRELY ON WHICH QUESTION IS ASKED\n');
console.log(`  ${'artifact'.padEnd(9)} ${'thresh'.padStart(7)} ${'mean>T'.padStart(8)} ${'any clip'.padStart(9)} `
  + `${'med frac'.padStart(9)} ${'p90 frac'.padStart(9)}`);
const fracs = {};
for (const d of DET) {
  const f = units.map((u) => {
    const v = u.clips.map((c) => c[d]).filter((x) => Number.isFinite(x) && x > 0);
    return v.length ? v.filter((x) => over(d, x)).length / v.length : null;
  }).filter((x) => x != null);
  fracs[d] = f;
  const meanOver = units.filter((u) => {
    const v = u.clips.map((c) => c[d]).filter((x) => Number.isFinite(x) && x > 0);
    return v.length && over(d, mean(v));
  }).length;
  console.log(`  ${d.padEnd(9)} ${(DIR[d] > 0 ? '>' : '<') + THRESH[d]} `.padEnd(18)
    + `${(100 * meanOver / units.length).toFixed(0).padStart(6)}% `
    + `${(100 * f.filter((x) => x > 0).length / f.length).toFixed(0).padStart(8)}% `
    + `${(100 * med(f)).toFixed(0).padStart(8)}% ${(100 * q(f, 0.9)).toFixed(0).padStart(8)}%`);
}
console.log('\n  "mean>T" is what the shipped band table reports. "any clip" is what a scene-level');
console.log('  threshold actually asks. They differ by about 3x and the second one is the right one.');

/* ---- 2. the covering-set question: how many films are clean on ALL FOUR at once ---- */
console.log('\n\n  BRENNAN\'S QUESTION: how many films are already "good enough" on every artifact?\n');
for (const tol of [0, 0.05, 0.10, 0.25]) {
  let clean = 0;
  for (const u of units) {
    let ok = true;
    for (const d of DET) {
      const v = u.clips.map((c) => c[d]).filter((x) => Number.isFinite(x) && x > 0);
      if (!v.length) continue;
      if (v.filter((x) => over(d, x)).length / v.length > tol) { ok = false; break; }
    }
    if (ok) clean += 1;
  }
  console.log(`    <= ${(100 * tol).toFixed(0).padStart(2)}% of scenes visible on all four   `
    + `${clean}/${units.length}  ${(100 * clean / units.length).toFixed(0)}%`);
}

/* ---- 3. THE WALL. what n buys, by the rule of three ---- */
console.log('\n\n  *** WHAT THE SAMPLING CAN ACTUALLY RESOLVE (rule of three, 95%) ***\n');
console.log(`    ${'clips/film'.padStart(11)}   ${'0 exceedances bounds the true rate below'.padEnd(42)}`);
for (const n of [4, 8, 12, 20, 60, 100]) {
  const b = 3 / n;
  console.log(`    ${String(n).padStart(11)}   ${(100 * b).toFixed(1).padStart(5)}%   `
    + `${b <= 0.05 ? '<- resolves the 5% target' : ''}`);
}
console.log(`\n    The shipped backfill uses 4 clips. A film reading zero visible artifacts there is`);
console.log('    consistent with up to 75% of its scenes being visibly damaged. The 5% target is not');
console.log(`    a modelling problem — it needs ~60 clips per film, which is ~2 minutes of video.`);
console.log(`    This set has a median of ${NC}, so even here the honest bound is ${(300 / NC).toFixed(0)}%.`);

/* ---- 4. does the scene fraction relate to the score at all? ---- */
console.log('\n\n  DOES ANY OF IT TRACK BPP+?\n');
const rank = (a) => { const s = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length);
  s.forEach(([, i], k) => { r[i] = k; }); return r; };
const corr = (a, b) => {
  const ra = rank(a); const rb = rank(b); const n = a.length;
  const ma = mean(ra); const mb = mean(rb);
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i += 1) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return num / Math.sqrt(da * db);
};
const bp = units.map((u) => u.bppPlus).filter(Number.isFinite);
for (const d of DET) {
  const pairs = units.map((u) => {
    const v = u.clips.map((c) => c[d]).filter((x) => Number.isFinite(x) && x > 0);
    return v.length && Number.isFinite(u.bppPlus) ? [v.filter((x) => over(d, x)).length / v.length, u.bppPlus] : null;
  }).filter(Boolean);
  const r = corr(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
  const se = 1 / Math.sqrt(pairs.length - 3);
  console.log(`    scene fraction ${d.padEnd(6)} vs BPP+   rho ${r.toFixed(3).padStart(7)} +- ${se.toFixed(3)}  `
    + `${Math.abs(r) < 2 * se ? '(indistinguishable from zero)' : ''}`);
}
console.log(`\n    n = ${bp.length}. A negative rho would mean lower-scored films really do show more visible`);
console.log('    scenes, which is the premise the whole score rests on. Read the sign first, and read');
console.log('    it against the standard error, not against zero.');
console.log('');
