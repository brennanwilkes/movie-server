/* HOW MUCH OF A PER-FILM perPoint IS SIGNAL? — analysis for scripts/perpoint-reliability.js.
 *
 * THE QUESTION. The 60-film content line is FLAT, so a film's damage reading is simply how flat its
 * perPoint sits relative to the library constant. But that residual has an sd of 0.0239, which
 * divided by the measured level slope of 0.0297 implies a p10-to-p90 spread of ~7.9x in source
 * starvation. No real library spans that. So most of the residual is noise — and the actual noise
 * floor has never been measured, which means there is currently no way to know how much of a
 * per-film residual to believe, and therefore no way to weight it.
 *
 * THE MEASUREMENT. perPoint is fitted separately on every clip, then reliability is the correlation
 * between two DISJOINT 3-clip halves, Spearman-Brown corrected to the full six. Same procedure that
 * graded the artifact detectors (blur 0.404, grain 0.935), so the number lands on a familiar scale.
 *
 * ALL 10 DISTINCT 3/3 SPLITS ARE AVERAGED, not one arbitrary split. A single split is itself a coin
 * flip: the probe-vs-backfill run showed split-half values ranging 0.328 to 0.679 across splits of
 * the same data, so quoting one would be quoting noise.
 *
 * *** PRE-REGISTERED, from E.8.6, before this data existed. ***
 *   >= 0.7      per-film readings usable; a score term can be built with the residual shrunk by
 *               the reliability in the usual way.
 *   0.3 - 0.7   aggregate direction real, per-film mostly noise. The honest output is a
 *               LIBRARY-LEVEL statement, and more clips per film is the only route to more.
 *   < 0.3       the instrument is real and the application is not. Say so; do not ship a term
 *               whose spread is noise.
 * A LOW VALUE DOES NOT RETRACT E.8.3 OR E.8.5. Those are aggregate results, and zero-mean per-film
 * noise adds variance to a group comparison without biasing it. This bounds what can be built on
 * top of them, nothing more.
 *
 * SECOND OUTPUT, free: the within-film scene-to-scene spread of perPoint, which is the same
 * scene-sampling nuisance that turned out to be 52% of the provenance factor (E.9.4). If perPoint's
 * scene spread dominates, more clips is the fix rather than a different statistic — and the
 * variance decomposition below says exactly how many.
 *
 * USAGE: node scripts/perpoint-reliability-analyse.mjs
 */
import fs from 'fs';

const LEVEL = -0.0297;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const rank = (a) => { const s = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length);
  s.forEach(([, i], k) => { r[i] = k; }); return r; };
function spearman(a, b) {
  const ra = rank(a); const rb = rank(b); const n = a.length;
  const ma = mean(ra); const mb = mean(rb);
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i += 1) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
const sb = (r, k) => (k * r) / (1 + (k - 1) * r);

let raw;
try { raw = JSON.parse(fs.readFileSync('data/perpoint-reliability.json', 'utf8')); } catch {
  console.log('\n  data/perpoint-reliability.json not written yet\n'); process.exit(0);
}
const units = Object.values(raw.units).filter((u) => Array.isArray(u.clips) && u.clips.length >= 6
  && u.clips.every((c) => Number.isFinite(c.perPoint)));
console.log(`\n  ${units.length} films with 6 clean per-clip perPoints\n`);
if (units.length < 8) { console.log('  need 8+ films\n'); process.exit(0); }

/* ---- variance decomposition: between films vs within film (scene to scene) ---- */
const filmMeans = units.map((u) => mean(u.clips.slice(0, 6).map((c) => c.perPoint)));
const withinSds = units.map((u) => sd(u.clips.slice(0, 6).map((c) => c.perPoint)));
const between = sd(filmMeans);
const within = mean(withinSds);
console.log('  VARIANCE DECOMPOSITION\n');
console.log(`    between-film sd of the 6-clip mean   ${between.toFixed(4)}`);
console.log(`    within-film (scene-to-scene) sd      ${within.toFixed(4)}`);
console.log(`    se of a 6-clip mean                  ${(within / Math.sqrt(6)).toFixed(4)}`);
const trueVar = between ** 2 - (within ** 2) / 6;
console.log(`    implied TRUE between-film sd         ${(trueVar > 0 ? Math.sqrt(trueVar) : 0).toFixed(4)}`
  + `${trueVar <= 0 ? '   <- ZERO: no real between-film variation survives' : ''}`);

/* ---- split-half over all 10 distinct 3/3 splits ---- */
const idx = [0, 1, 2, 3, 4, 5];
const combos = [];
for (let m = 1; m < 64; m += 1) {
  const on = idx.filter((i) => (m >> i) & 1);
  if (on.length === 3 && on[0] === 0) combos.push(on);
}
const rs = [];
for (const on of combos) {
  const off = idx.filter((i) => !on.includes(i));
  const A = units.map((u) => mean(on.map((i) => u.clips[i].perPoint)));
  const B = units.map((u) => mean(off.map((i) => u.clips[i].perPoint)));
  rs.push(spearman(A, B));
}
rs.sort((a, b) => a - b);
const half = mean(rs);
const rel6 = sb(half, 2);
console.log(`\n  SPLIT-HALF, averaged over all ${combos.length} distinct 3/3 splits\n`);
console.log(`    3-clip half   mean ${half.toFixed(3)}   median ${rs[rs.length >> 1].toFixed(3)}   `
  + `range ${rs[0].toFixed(3)} to ${rs[rs.length - 1].toFixed(3)}`);
console.log(`    *** RELIABILITY OF THE 6-CLIP perPoint  ${rel6.toFixed(3)} ***   (Spearman-Brown)`);
console.log(`\n    for scale: blur 0.404, block 0.836, grain 0.935 at comparable sampling`);

console.log('\n  VERDICT AGAINST THE PRE-REGISTRATION\n');
if (rel6 >= 0.7) {
  console.log(`    USABLE PER FILM. A detail term can be built, with the residual shrunk by ${rel6.toFixed(2)}.`);
  console.log(`    Of the 0.0239 residual sd in the content-line fit, roughly ${(100 * rel6).toFixed(0)}% is real signal,`);
  console.log(`    implying a p10-p90 source-starvation spread of about `
    + `${Math.exp((2 * 1.2816 * 0.0239 * Math.sqrt(rel6)) / Math.abs(LEVEL)).toFixed(1)}x — sanity-check THAT`);
  console.log('    against what the library plausibly contains before shipping anything.');
} else if (rel6 >= 0.3) {
  console.log(`    AGGREGATE ONLY. At ${rel6.toFixed(2)}, a per-film reading is mostly noise and must not be`);
  console.log('    scored. The instrument is real — E.8.3 and E.8.5 are untouched, because zero-mean');
  console.log('    per-film noise does not bias a group comparison — but the honest output is a');
  console.log('    LIBRARY-LEVEL statement about detail loss, not a per-title adjustment.');
  const need = Math.ceil((6 * 0.7 * (1 - rel6)) / (rel6 * (1 - 0.7)));
  console.log(`    To reach 0.7 by Spearman-Brown would take about ${need} clips per film.`);
} else {
  console.log(`    NOT USABLE PER FILM at ${rel6.toFixed(2)}. The instrument is real and the application is not.`);
  console.log('    Do not ship a term whose spread is noise. State the blindness instead.');
}
console.log('\n  Note what this does NOT touch: the two-direction separation, the gblur specificity');
console.log('  result, and the flat content line are all AGGREGATE findings and survive any value here.');
console.log('');
