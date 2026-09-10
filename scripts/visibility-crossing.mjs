/* WHERE DOES 100 BELONG? — measured per film, per artifact, by reading the crossing off a ladder.
 *
 * THE QUESTION (Brennan, 2026-08-27). BPP+ 100 is defined as "as many bits as a CRF-20 encode of
 * this film would spend". That is a definition, not a measurement, and the library median of ~67 has
 * never been checked against anything absolute. The artifact thresholds ARE absolute — banding's
 * 2.817 is Netflix's published visibility point and owes nothing to this library — so they can answer
 * a question the provenance factor P structurally cannot:
 *
 *   P is a residual, standardised to mean zero across the library, so it is ZERO-SUM and cannot move
 *   the median however wrong the median is. It ranks films against each other. It says nothing about
 *   whether the library as a whole is over- or under-provisioned. THIS SCRIPT ANSWERS THE OTHER HALF.
 *
 * THE METHOD, AND WHY IT AVOIDS THE TRAP THAT KILLED SIX CONSTRUCTIONS. Each ladder film was measured
 * at eight bitrate rungs (2.5x down to 0.3x of its own rate) with all four detectors. So the level at
 * which an artifact crosses its visibility threshold can be READ OFF by interpolating BETWEEN
 * MEASURED RUNGS. It is never extrapolated and it never divides by a slope — the operation that
 * produced m = 1e-58 and a 4.64x implied BD-rate. A crossing outside the measured range is reported
 * as "outside", never estimated.
 *
 * Then, since BPP+ = 100*sqrt(bpp/target), a bitrate multiplier L maps to a score multiplier sqrt(L):
 *     crossingBPP = film's BPP+ * sqrt(L_cross)
 * which is "the BPP+ at which THIS film becomes visually clean on THIS artifact". The distribution of
 * those across films is the answer to where 100 belongs.
 *
 * THE DISAMBIGUATION THAT MAKES THIS HONEST, and it is the whole reason the naive version misleads.
 * Read the library table two ways:
 *   "at 50-74, 77% show no visible banding"      -> the scale is pessimistic, 100 is too high
 *   "at 100-124, 11% still show visible banding" -> the scale is optimistic, 100 is too low
 * Both are true of the same numbers. The disambiguator is WHETHER THAT BANDING RESPONDS TO BITS AT
 * ALL. Much of it does not: Severance S02 sits at 3x threshold with a slope of -0.034, and Mr. Robot
 * at r2 0.07 means bitrate explains essentially none of its banding across an 8.3x sweep. Banding
 * baked into the source is NOT evidence that more bits are needed, and counting it as such biases the
 * answer toward "more bits" for a reason bits cannot fix.
 *
 * So every film/artifact pair lands in exactly one bucket, and the counts matter as much as the
 * crossings:
 *     CLEAN ALREADY   below threshold even at the LOWEST rung. More bits buy nothing here.
 *     CROSSES         becomes clean somewhere inside the measured range. THE USABLE CASE.
 *     NEVER CLEAN     above threshold even at the HIGHEST rung. Baked in; bits are not the lever.
 * Only CROSSES contributes to the calibration. The other two are reported because their SIZE is the
 * evidence about whether bits are the right lever at all.
 *
 * ALL FOUR ARTIFACTS, not just banding, because each fails differently: banding saturates and can
 * reverse at low bitrate, blocking is caused by quantisation and responds where it is severe, blur
 * barely moves, and grain is inverted (damage is BELOW its threshold).
 *
 * USAGE: node scripts/visibility-crossing.mjs
 */
import fs from 'fs';

const ART = [
  { key: 'cambi', label: 'banding', T: 2.817, worseIsHigh: true },
  { key: 'block', label: 'blocking', T: 3.710, worseIsHigh: true },
  { key: 'blur', label: 'blur', T: 8.026, worseIsHigh: true },
  { key: 'grain', label: 'grain kept', T: 0.905, worseIsHigh: false },
];
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const q = (a, f) => a.slice().sort((x, y) => x - y)[Math.floor(f * (a.length - 1))];

const FILES = ['artifact-ladder-grain.json', 'artifact-ladder-v1.json', 'artifact-ladder-wideA.json',
  'artifact-ladder-grain2.json', 'artifact-ladder-blindspot.json', 'artifact-ladder-underscored.json',
  'artifact-ladder-flagged.json'];
const films = [];
const seen = new Set();
for (const fn of FILES) {
  let d; try { d = JSON.parse(fs.readFileSync(`data/${fn}`, 'utf8')); } catch { continue; }
  for (const f of d.films || []) if (!seen.has(f.key)) { films.push(f); seen.add(f.key); }
}
/* BPP+ for each laddered film, from the live table. Without it a crossing LEVEL cannot be turned
 * into a crossing SCORE, which is the only form the answer is useful in. */
const ds = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8'));
const plus = new Map((ds.rows || []).filter((r) => r.bppPlus != null).map((r) => [r.key, r.bppPlus]));

console.log(`\n  ${films.length} laddered films, ${plus.size} with a live BPP+\n`);

/* Interpolate the level at which log(artifact) crosses log(T), between the two bracketing rungs.
 * Log-log because the response is multiplicative (11.41) and because a straight line in logs is the
 * shape every ladder fit in this project has used. */
function crossing(pts, a) {
  const rungs = pts.filter((p) => p.level > 0 && p[a.key] > 0).sort((x, y) => x.level - y.level);
  if (rungs.length < 3) return { kind: 'nodata' };
  const over = (p) => (a.worseIsHigh ? p[a.key] >= a.T : p[a.key] <= a.T);
  const lo = rungs[0]; const hi = rungs[rungs.length - 1];
  if (!over(lo)) return { kind: 'clean' };        // already fine at the LOWEST bitrate
  if (over(hi)) return { kind: 'never' };         // still bad at the HIGHEST bitrate
  /* Somewhere in between. Walk up and take the first bracket where it flips, so a saturating or
   * non-monotone curve (banding does both, 11.72) yields the FIRST level at which it is clean rather
   * than a fitted crossing that may not correspond to any measured point. */
  for (let i = 1; i < rungs.length; i += 1) {
    if (over(rungs[i - 1]) && !over(rungs[i])) {
      const x0 = Math.log(rungs[i - 1].level); const x1 = Math.log(rungs[i].level);
      const y0 = Math.log(rungs[i - 1][a.key]); const y1 = Math.log(rungs[i][a.key]);
      const yt = Math.log(a.T);
      const t = Math.abs(y1 - y0) < 1e-9 ? 0.5 : (yt - y0) / (y1 - y0);
      return { kind: 'cross', level: Math.exp(x0 + t * (x1 - x0)) };
    }
  }
  return { kind: 'messy' };                        // flips more than once — do not use
}

const out = {};
for (const a of ART) out[a.label] = { clean: 0, never: 0, messy: 0, nodata: 0, cross: [] };
for (const f of films) {
  const bp = plus.get(f.key);
  for (const a of ART) {
    const c = crossing(f.points || [], a);
    const bucket = out[a.label];
    if (c.kind === 'cross') {
      if (bp > 0) bucket.cross.push({ title: f.title, level: c.level, at: bp * Math.sqrt(c.level), bp });
      else bucket.nodata += 1;
    } else bucket[c.kind] += 1;
  }
}

console.log('  WHERE EACH FILM/ARTIFACT PAIR LANDS\n');
console.log(`  ${'artifact'.padEnd(12)} ${'clean at'.padStart(9)} ${'crosses'.padStart(8)} ${'never'.padStart(7)} `
  + `${'messy'.padStart(7)}   (clean at = already below T even at the LOWEST rung)`);
for (const a of ART) {
  const b = out[a.label];
  console.log(`  ${a.label.padEnd(12)} ${String(b.clean).padStart(9)} ${String(b.cross.length).padStart(8)} `
    + `${String(b.never).padStart(7)} ${String(b.messy).padStart(7)}`);
}

console.log('\n  THE CALIBRATION — BPP+ at which a film becomes visually clean, among films that CROSS\n');
console.log(`  ${'artifact'.padEnd(12)} ${'n'.padStart(4)} ${'p25'.padStart(7)} ${'median'.padStart(7)} `
  + `${'p75'.padStart(7)} ${'p90'.padStart(7)}   median crossing level`);
for (const a of ART) {
  const c = out[a.label].cross;
  if (c.length < 5) { console.log(`  ${a.label.padEnd(12)} ${String(c.length).padStart(4)}   too few`); continue; }
  const ats = c.map((x) => x.at);
  console.log(`  ${a.label.padEnd(12)} ${String(c.length).padStart(4)} ${q(ats, 0.25).toFixed(0).padStart(7)} `
    + `${med(ats).toFixed(0).padStart(7)} ${q(ats, 0.75).toFixed(0).padStart(7)} ${q(ats, 0.9).toFixed(0).padStart(7)}`
    + `   ${med(c.map((x) => x.level)).toFixed(2)}x`);
}

console.log('\n  HOW TO READ IT\n');
console.log('  The median crossing BPP+ is the score at which a typical film that CAN be fixed by bits');
console.log('  stops showing that artifact. If that number is well BELOW 100, then 100 is buying more');
console.log('  bits than visibility requires and the scale is pessimistic — the median belongs higher.');
console.log('  If it is ABOVE 100, then 100 does not reach transparency and the scale is optimistic.');
console.log('');
console.log('  THE COUNTS ARE NOT A FOOTNOTE. A large "never" column means the artifact is baked into');
console.log('  the sources and bits are not the lever, so its crossings describe only the minority of');
console.log('  films where they are. A large "clean at" column means the artifact is already invisible');
console.log('  at every bitrate we sampled, so it cannot calibrate anything at all.');

for (const a of ART) {
  const c = out[a.label].cross;
  if (c.length < 5) continue;
  c.sort((x, y) => x.at - y.at);
  console.log(`\n  ${a.label.toUpperCase()} — the films, lowest crossing first (5 lowest, 5 highest)`);
  const show = (x) => console.log(`    clean at BPP+ ${x.at.toFixed(0).padStart(4)}  (now ${String(x.bp).padStart(4)}, `
    + `needs ${x.level.toFixed(2)}x bits)  ${x.title.slice(0, 38)}`);
  c.slice(0, 5).forEach(show);
  if (c.length > 10) console.log('    ...');
  c.slice(-5).forEach(show);
}
console.log('');
