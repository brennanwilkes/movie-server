#!/usr/bin/env node
/* THE x264 CONFOUND CHECK — is the x1.06 "codec matching" floor real?
 *
 * THE OPEN QUESTION (BPP-PLUS.txt 5.2, open question 1; the last load-bearing unvalidated parameter
 * in the shipped model). The starvation experiment made its starved copies with x265 and the probe
 * also encodes x265. Re-encoding an x265 file with x265 is EASIER than re-encoding an h264 one,
 * because the artefacts are already x265-shaped and compress well. So some of the measured
 * "understatement" could be codec matching rather than starvation. A floor of x1.06 was subtracted
 * for this, estimated from ONE film (Blade Runner 2049 at level 0.5, barely starved at R > 5, where
 * almost nothing should be attributable to starvation). If the true floor is larger, the live curve
 * OVER-corrects 994 films.
 *
 * WHY THE x264 ARM SETTLES IT. Starve the same clips with libx264 instead. Now the starved copy's
 * artefacts are h264-shaped while the probe still encodes x265, so there is NO codec match. Whatever
 * understatement remains is starvation alone. The ratio between the arms IS the codec-matching
 * factor, measured on 8 films x 2 levels instead of inferred from one point.
 *
 * WHY THIS COMPARISON NEEDS NO R AXIS, WHICH MATTERS. `under` = cx20(untouched) / cx20(starved) is a
 * ratio of two measurements of the SAME clips, so it is independent of R, of the codec-efficiency
 * normalisation, and of the anchoring step. Every known source of trouble on the x-axis drops out.
 * The floor estimate is therefore cleaner than the curve it corrects.
 *
 * PRE-REGISTERED DECISION RULE, written before the x264 arm finished:
 *   ratio = under_x265 / under_x264, pooled as a median over the 16 matched points.
 *     ratio ~= 1.06  -> the assumed floor is right; the live curve stands.
 *     ratio  > 1.10  -> the floor is LARGER than assumed; the live curve OVER-corrects and PIN_A
 *                       must come down. Report by how much.
 *     ratio  < 1.02  -> there is no codec-matching effect worth subtracting; the x1.06 subtraction
 *                       was unnecessary and the curve slightly UNDER-corrects.
 *   Anything in between is reported as inconclusive-but-bounded rather than forced into a verdict.
 *
 * VALIDITY CHECK THAT MUST PASS FIRST. Level 1.0 is the untouched clip in BOTH arms — it is copied,
 * never re-encoded (probe-starve.sh). So cx20 at level 1.0 must be IDENTICAL between the arms. If it
 * is not, the two runs did not measure the same material and nothing else in the file means anything.
 *
 * USAGE: node scripts/starve-compare.js [--x265 PATH] [--x264 PATH]
 */
const fs = require('fs');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const A265 = val('--x265', `${__dirname}/../data/starve-experiment.json`);
const A264 = val('--x264', `${__dirname}/../data/starve-experiment-x264.json`);

const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8')).films;
const med = (a) => {
  const v = [...a].sort((x, y) => x - y);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

const underOf = (film) => {
  const ls = [...film.levels].sort((a, b) => b.level - a.level);
  const base = ls[0] && ls[0].level >= 1 ? ls[0].cx20 : null;
  const out = {};
  if (!base) return { base: null, out };
  for (const l of ls) {
    if (l.level >= 1 || !l.cx20) continue;
    out[l.level] = { under: base / l.cx20, cx20: l.cx20, slope: l.perPoint };
  }
  return { base, out };
};

const f265 = load(A265);
const f264 = load(A264);
const keys = Object.keys(f265).filter((k) => f264[k]);
console.log(`x265 arm: ${Object.keys(f265).length} films · x264 arm: ${Object.keys(f264).length} films `
  + `· matched: ${keys.length}\n`);
if (!keys.length) { console.log('nothing to compare yet'); process.exit(0); }

// ---- validity: the untouched control must agree ------------------------------------------------
console.log('VALIDITY — level 1.0 is copied, not re-encoded, so cx20 must match between arms:');
let bad = 0;
for (const k of keys) {
  const a = underOf(f265[k]).base; const b = underOf(f264[k]).base;
  const dev = (a && b) ? Math.abs(a - b) / a : null;
  const ok = dev != null && dev < 0.02;
  if (!ok) bad += 1;
  console.log(`  ${(f265[k].title || k).slice(0, 34).padEnd(36)} ${String(a).padStart(9)} vs ${String(b).padStart(9)}`
    + `  ${dev == null ? 'MISSING' : `${(dev * 100).toFixed(2)}%`} ${ok ? 'ok' : '<-- MISMATCH'}`);
}
console.log(bad ? `\n*** ${bad} control mismatch(es): treat everything below as suspect ***\n`
  : '\ncontrols agree — the two arms measured the same material.\n');

// ---- the floor --------------------------------------------------------------------------------
const rows = [];
for (const k of keys) {
  const u5 = underOf(f265[k]).out; const u4 = underOf(f264[k]).out;
  for (const lv of Object.keys(u5)) {
    if (!u4[lv]) continue;
    rows.push({
      title: f265[k].title || k, level: Number(lv),
      u265: u5[lv].under, u264: u4[lv].under, ratio: u5[lv].under / u4[lv].under,
      s265: u5[lv].slope, s264: u4[lv].slope,
    });
  }
}
console.log('UNDERSTATEMENT BY ARM — x265 starved (codec-matched) vs x264 starved (not matched):');
console.log(`  ${'film'.padEnd(30)} ${'lvl'.padStart(5)} ${'x265'.padStart(7)} ${'x264'.padStart(7)} ${'ratio'.padStart(7)}`);
for (const r of rows.sort((a, b) => b.ratio - a.ratio)) {
  console.log(`  ${r.title.slice(0, 28).padEnd(30)} ${String(r.level).padStart(5)} `
    + `${r.u265.toFixed(3).padStart(7)} ${r.u264.toFixed(3).padStart(7)} ${r.ratio.toFixed(3).padStart(7)}`);
}

const ratios = rows.map((r) => r.ratio);
const m = med(ratios); const mn = mean(ratios);
const lo = Math.min(...ratios); const hi = Math.max(...ratios);
// Bootstrap the median so the verdict carries an interval, not a bare point. SEEDED, so re-running
// the analysis on the same data gives the same interval — a CI that wobbles between runs invites
// re-rolling until it says something, which is the same failure as re-fitting until a result appears.
let seed = 20260820;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const boot = [];
for (let i = 0; i < 4000; i += 1) {
  boot.push(med(ratios.map(() => ratios[Math.floor(rnd() * ratios.length)])));
}
boot.sort((a, b) => a - b);
const ci = [boot[Math.floor(boot.length * 0.025)], boot[Math.floor(boot.length * 0.975)]];

// The floor this script was written to test, and the PIN_A that rested on it. Both are HISTORY as of
// the 2026-08-20 refit — the shipped curve is now 1.114 * R^-0.392 with no floor, fitted on the x264
// arm. Left as literals on purpose: re-running this script must reproduce the ORIGINAL finding, so it
// has to compare against what was actually shipped at the time, not against whatever is live now.
const ASSUMED = 1.06;
const PIN_A_AT_WRITING = 1.337;
console.log(`\nCODEC-MATCHING FLOOR, ${rows.length} matched points`);
console.log(`  median ${m.toFixed(4)}   mean ${mn.toFixed(4)}   range ${lo.toFixed(3)}-${hi.toFixed(3)}`);
console.log(`  bootstrap 95% CI on the median  ${ci[0].toFixed(3)} .. ${ci[1].toFixed(3)}`);
console.log(`  assumed in the live curve       ${ASSUMED}`);

let verdict;
if (m > 1.10) {
  const over = m / ASSUMED;
  verdict = `FLOOR IS LARGER THAN ASSUMED (${m.toFixed(3)} vs ${ASSUMED}). The live curve OVER-corrects: `
    + `understatement was credited x${over.toFixed(3)} too generously, so PIN_A ~${(PIN_A_AT_WRITING / over).toFixed(3)} `
    + `rather than ${PIN_A_AT_WRITING}, and BPP+ across the corrected library would be ~${((Math.sqrt(over) - 1) * 100).toFixed(1)}% too LOW.`;
} else if (m < 1.02) {
  verdict = `NO CODEC-MATCHING EFFECT WORTH SUBTRACTING (${m.toFixed(3)}). The x1.06 subtraction was `
    + 'unnecessary, so the live curve slightly UNDER-corrects — the safe direction, and the smaller error.';
} else if (Math.abs(m - ASSUMED) <= 0.04) {
  verdict = `THE ASSUMED x${ASSUMED} FLOOR IS CONFIRMED (${m.toFixed(3)}). The live curve stands as fitted, `
    + 'and the last load-bearing unvalidated parameter is now measured on 16 points rather than one.';
} else {
  verdict = `INCONCLUSIVE BUT BOUNDED: median ${m.toFixed(3)}, CI ${ci[0].toFixed(3)}-${ci[1].toFixed(3)}. `
    + 'Report the interval; do not move the constants on this alone.';
}
console.log(`\nVERDICT: ${verdict}`);

// Does the floor depend on how starved the copy is? If codec matching is a fixed artefact effect it
// should NOT: a constant floor is the model's own assumption, and a trend would falsify it.
for (const lv of [...new Set(rows.map((r) => r.level))].sort((a, b) => b - a)) {
  const g = rows.filter((r) => r.level === lv).map((r) => r.ratio);
  console.log(`  level ${lv}: median ratio ${med(g).toFixed(4)} (n=${g.length})`);
}
console.log('\nIf the two levels disagree materially, the floor is not a constant and subtracting one');
console.log('number was the wrong shape — that would be a finding in its own right.');

fs.writeFileSync(`${__dirname}/../data/starve-codec-floor.json`,
  JSON.stringify({ generated: Date.now(), assumed: ASSUMED, median: m, mean: mn, ci, rows }, null, 1));
console.log(`\nwrote data/starve-codec-floor.json`);
