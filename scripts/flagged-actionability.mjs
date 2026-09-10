/* IS THE DETECTOR EVEN LIVE ON THIS CONTENT? — the per-film relevance question.
 *
 * ── READ THIS FIRST: THE OBVIOUS VERSION OF THIS SCRIPT IS VACUOUS ──────────────────────────────
 * The first version asked what looked like the useful question: "for a film we flag as damaged, would
 * a bigger download fix it?" It compared the delivered file's artifact against our re-encode at 2.5x
 * the bitrate and reported how much of the excess the extra bits removed. It returned
 * "BITS DO NOT HELP" for 18 of 18 flagged artifacts.
 *
 * THAT UNANIMITY WAS THE TELL, AND THE CONSTRUCTION FORCES IT. Every ladder rung is re-encoded FROM
 * THE DELIVERED FILE. An artifact already baked into the delivered pixels is inherited by every rung,
 * including 2.5x. You cannot un-band pixels that arrive already banded, so re-encoding them at any
 * bitrate reproduces the banding. The test could only ever return one answer, and it did.
 *
 * ANSWERING THE ORIGINAL QUESTION WOULD REQUIRE A HIGHER-QUALITY SOURCE THAN THE DELIVERED FILE, which
 * is precisely what this library never has (handoff 4.4). Do not rebuild that test on ladder data. It
 * is not a sample-size problem or a threshold problem; it is unanswerable from re-encodes of the file
 * being judged.
 *
 * ── WHAT THIS DATA *CAN* ANSWER ────────────────────────────────────────────────────────────────
 * Whether the artifact responds to bitrate ON THIS CONTENT AT ALL. That needs no better source — only
 * the response function, which the ladder measures directly by starving the file down to 0.3x. It is
 * the per-film version of the relevance gate (11.23), which until now existed only as a population
 * statistic ("grain blinds the detectors, 28.4% / 26.6% / 9.0%").
 *
 * WHY IT MATTERS FOR THE SCORE. A detector that does not move when bits are cut by 3x is not measuring
 * bit starvation on that film. Whatever it is reading — the master, the grade, the source encoder — is
 * not something BPP+ can act on, and a per-film reading of that is worth more than a population rate.
 *
 * AND ONE GENUINE OBSERVATION SURVIVED THE VACUOUS VERSION, worth keeping: on several flagged films
 * OUR x264-medium re-encode at the SAME bitrate carries MORE banding than the delivered file
 * (I Swear 5.184 vs 3.163; Beginners 4.951 vs 4.064). The delivered encoder beat our reference. That
 * is the eq quantity of 11.20 — already known to be confounded with bitrate at -0.536 — so it is
 * reported below as an observation and NOT built on.
 *
 * USAGE: node scripts/flagged-actionability.mjs
 */
import fs from 'fs';

const ART = [
  { key: 'cambi', label: 'banding', T: 2.817, worseIsHigh: true },
  { key: 'block', label: 'blocking', T: 3.710, worseIsHigh: true },
  { key: 'blur', label: 'blur', T: 8.026, worseIsHigh: true },
  { key: 'grain', label: 'grain', T: 0.905, worseIsHigh: false },
];
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function fit(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length < 4) return null;
  const mx = mean(pts.map((p) => p[0])); const my = mean(pts.map((p) => p[1]));
  let n = 0; let d = 0;
  for (const [x, y] of pts) { n += (x - mx) * (y - my); d += (x - mx) ** 2; }
  if (!(d > 0)) return null;
  const s = n / d;
  const sse = pts.reduce((a, [x, y]) => a + (y - (my + s * (x - mx))) ** 2, 0);
  const tot = pts.reduce((a, [, y]) => a + (y - my) ** 2, 0);
  return { slope: s, r2: tot > 0 ? 1 - sse / tot : 0, n: pts.length };
}

const data = JSON.parse(fs.readFileSync('data/artifact-ladder-flagged.json', 'utf8'));
let prov = { units: {} };
try { prov = JSON.parse(fs.readFileSync('bpp-lab/public/provenance.json', 'utf8')); } catch { /* optional */ }

console.log(`\n  ${data.films.length} flagged films laddered  (levels ${(data.levels || []).join(' ')})\n`);
console.log('  RESPONSE TO BITRATE, per film per artifact. |slope| is d(log artifact)/d(log bits) across');
console.log('  the whole ladder. Near zero means the detector is INERT on this content — whatever it is');
console.log('  reading, bits are not the lever.\n');
console.log(`  ${'film'.padEnd(28)} ${'artifact'.padEnd(9)} ${'live'.padStart(8)} ${'over T?'.padStart(8)} `
  + `${'slope'.padStart(8)} ${'r2'.padStart(6)}  reads as`);

const rows = [];
for (const f of data.films) {
  const pts = (f.points || []).filter((p) => p.level > 0);
  const loss = (f.points || []).find((p) => p.lossless);
  if (pts.length < 4) continue;
  const lx = pts.map((p) => Math.log(p.level));
  for (const a of ART) {
    const g = fit(lx, pts.map((p) => (p[a.key] > 0 ? Math.log(p[a.key]) : NaN)));
    if (!g) continue;
    const live = loss && loss[a.key] > 0 ? loss[a.key] : null;
    const over = live != null && (a.worseIsHigh ? live > a.T : live < a.T);
    /* Sign convention: for the three "high is bad" detectors the slope should be NEGATIVE (more bits,
     * less artifact). Grain is inverted — more bits retain MORE grain, so positive is the healthy
     * direction. Orient so "responds correctly" is always a negative oriented slope. */
    const oriented = a.worseIsHigh ? g.slope : -g.slope;
    const inert = Math.abs(oriented) < 0.05;
    rows.push({ title: f.title, key: f.key, artifact: a.label, live, over, oriented, r2: g.r2, inert });
    console.log(`  ${f.title.slice(0, 27).padEnd(28)} ${a.label.padEnd(9)} `
      + `${(live != null ? live.toFixed(3) : '—').padStart(8)} ${(over ? 'YES' : 'no').padStart(8)} `
      + `${oriented.toFixed(3).padStart(8)} ${g.r2.toFixed(2).padStart(6)}  `
      + `${inert ? 'INERT — bits are not the lever' : oriented < 0 ? 'responds to bits' : 'WRONG SIGN'}`);
  }
}

const flagged = rows.filter((r) => r.over);
console.log(`\n  ${flagged.length} artifact/film pairs are above visibility on the delivered file`);
if (flagged.length) {
  const inert = flagged.filter((r) => r.inert);
  const wrong = flagged.filter((r) => !r.inert && r.oriented > 0);
  console.log(`    of those, INERT to bitrate on their own content   ${inert.length}`);
  console.log(`    responding in the WRONG direction                 ${wrong.length}`);
  console.log(`    responding normally                              ${flagged.length - inert.length - wrong.length}`);
  console.log('\n  A flagged artifact that is INERT is the interesting case: the damage is real and visible,');
  console.log('  and it is demonstrably not about how many bits this file has. That is the situation where');
  console.log('  BPP+ alone gives actively misleading advice, because it reads low and the obvious');
  console.log('  response is to go find more bits.');
}

/* The eq observation, reported and not built on — see the header. */
console.log('\n  OBSERVATION (NOT A RESULT): our x264-medium re-encode vs the delivered file, same bitrate');
console.log(`  ${'film'.padEnd(28)} ${'artifact'.padEnd(9)} ${'delivered'.padStart(10)} ${'ours@1.0x'.padStart(10)} ${'ratio'.padStart(7)}`);
for (const f of data.films) {
  const one = (f.points || []).find((p) => Math.abs((p.level ?? -1) - 1) < 1e-6);
  const loss = (f.points || []).find((p) => p.lossless);
  if (!one || !loss) continue;
  for (const a of ART) {
    if (!(one[a.key] > 0) || !(loss[a.key] > 0)) continue;
    if (a.key !== 'cambi' && a.key !== 'block') continue;      // the two with real dynamic range
    console.log(`  ${f.title.slice(0, 27).padEnd(28)} ${a.label.padEnd(9)} ${loss[a.key].toFixed(3).padStart(10)} `
      + `${one[a.key].toFixed(3).padStart(10)} ${(one[a.key] / loss[a.key]).toFixed(2).padStart(7)}`);
  }
}
console.log('\n  A ratio above 1 means the release encoder BEAT our reference at the same bitrate. This is');
console.log('  11.20\'s eq, which is confounded with bitrate at -0.536 and was downgraded to WEAK. It is');
console.log('  printed for orientation only — do not build on it.\n');
