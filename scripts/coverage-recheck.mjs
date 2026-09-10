/* DID CLOSING THE COVERAGE HOLE CHANGE ANY CONCLUSION? — written BEFORE the answer is available.
 *
 * WHY IT IS WRITTEN NOW. 11.31 found that the artifact backfill had silently excluded 266 units, all
 * of them Bluray movies, with systematically higher bitrate and complexity than the measured set.
 * day4.sh is measuring them. When it finishes there will be a new set of numbers, and the temptation
 * will be to look at them and decide afterwards whether they are "close enough". That is how a
 * moving goalpost happens. So the BASELINE and the TOLERANCES are fixed here, in advance.
 *
 * THE BASELINE is the n=782 run recorded in BPP-PLUS 11.26-11.29 — the numbers the shipped rule and
 * the whole argument currently rest on.
 *
 * THE LOGIC OF THE TOLERANCES, which is not "whatever looks close":
 *   MUST NOT CHANGE — these are structural claims. If any of them breaks, the coverage hole was
 *   hiding something and THE SHIPPED RULE COMES OFF THE PAGE until it is understood.
 *       PC1 sign pattern stays 4/4 matching the re-encode signature
 *       split-half r stays clearly positive on all three disjoint pairings
 *       the codec control still shows the generation ordering within h264
 *       the 720p negative control still does NOT fire
 *       the pre-registered direction still beats the overwhelming majority of random directions
 *   MAY LEGITIMATELY MOVE — these are population quantities, and the population just changed by 25%
 *   in a non-random way. Movement here is expected and is not evidence of a problem.
 *       the WEB-vs-Bluray gap (the Bluray group grew by ~40%)
 *       the provenance fraction and therefore the shrinkage floor
 *       the resulting adjustment percentiles
 *
 * THE ASYMMETRY IS THE POINT. Structural claims are about whether the factor is real; population
 * quantities are about how big it is. A 25% non-random change in the sample can honestly move the
 * second without touching the first. If it moves the FIRST, the factor was partly an artifact of
 * which units happened to be measured.
 *
 * USAGE: node scripts/coverage-recheck.mjs
 */
import fs from 'fs';
import { execFileSync } from 'child_process';

/* ---- BASELINE, n=782, from BPP-PLUS 11.26-11.29. Do not edit to match a later run. ---- */
const BASE = {
  n: 782,
  splitHalf: [0.186, 0.289, 0.295],
  reliability: 0.448,
  pc1: { cambi: +0.523, block: +0.628, blur: +0.148, grain: -0.557 },
  pc1CorrWithSignature: 0.951,
  gap: 0.271,
  gapT: 2.58,
  provFraction: 0.0115,
  shrinkFloor: 0.107,
  h264Ordering: 'WEBRip +0.325 > WEB-DL +0.016 > Bluray -0.035',
  negControlZ: -0.71,
  permutationBeats: 19991,        // of 20000
};

const run = (script, args = []) => {
  try { return execFileSync('node', [`scripts/${script}`, ...args], { encoding: 'utf8', timeout: 15 * 60000 }); }
  catch (e) { return `FAILED: ${e.message}`; }
};
const num = (txt, re) => { const m = txt.match(re); return m ? Number(m[1]) : null; };

console.log('\n  COVERAGE RECHECK — baseline n=782 vs full coverage\n');
console.log('  Tolerances were fixed before this run. See the header.\n');

const prov = JSON.parse(fs.readFileSync('bpp-lab/public/provenance.json', 'utf8'));
console.log(`  n: ${BASE.n} -> ${prov.n}   (+${prov.n - BASE.n}, +${(((prov.n - BASE.n) / BASE.n) * 100).toFixed(0)}%)\n`);

/* ---- STRUCTURAL: must not change ---- */
console.log('  ── STRUCTURAL CLAIMS — any break here takes the rule off the page ──\n');
const factor = run('provenance-factor.mjs');
const halves = [...factor.matchAll(/^\s+\S+\s+\S+\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*$/gm)];
const splitLine = factor.match(/median split-half r = ([\d.-]+)/);
const signsMatch = num(factor, /sign pattern matches the pre-registered re-encode signature on (\d)\/4/);
const pc1Corr = num(factor, /corr\(pre-registered score, PC1 score\) = ([\d.-]+)/);
const eig = num(factor, /eigenvalue ([\d.]+) of 4/);
let fail = 0;
const check = (label, ok, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? 'PASS' : '**FAIL**'}  ${label.padEnd(46)} ${detail}`);
};
check('PC1 sign pattern still 4/4', signsMatch === 4, `${signsMatch}/4 (baseline 4/4)`);
check('PC1 direction still ~= physics direction', pc1Corr !== null && pc1Corr > 0.85,
  `corr ${pc1Corr} (baseline ${BASE.pc1CorrWithSignature})`);
check('PC1 still explains > 25% (noise floor)', eig !== null && eig / 4 > 0.25,
  `${eig !== null ? ((eig / 4) * 100).toFixed(1) : '?'}% (baseline 37.7%)`);
const medSplit = splitLine ? Number(splitLine[1]) : null;
check('split-half still clearly positive', medSplit !== null && medSplit > 0.15,
  `median r ${medSplit} (baseline 0.289, SE ~0.036)`);

const codec = run('factor-codec-control.mjs');
const h264Holds = /generation ordering within h264: HOLDS/.test(codec);
check('generation ordering holds within h264', h264Holds, h264Holds ? 'HOLDS' : 'BROKEN');

const field = run('field-combined.mjs');
const zs = [...field.matchAll(/Stouffer z \(variance inflated [\d.]+ -> [\d.]+ for measured correlation\) = (-?[\d.]+)/g)]
  .map((m) => Number(m[1]));
const [zRip, zWeb, zCtrl] = zs;
check('negative control (720p) still does NOT fire', zCtrl !== undefined && zCtrl < 1.5,
  `z ${zCtrl} (baseline ${BASE.negControlZ}); real contrasts z ${zRip} / ${zWeb}`);

const perm = run('direction-permutation.mjs', ['20000']);
const beats = num(perm, /directions with a gap at least as large as ours: (\d+) of 20000/);
const rank = num(perm, /pre-registered direction ranks (\d+) of 16/);
check('direction still beats ~all random directions', beats !== null && beats < 400,
  `${beats} of 20000 reach it (baseline 9)`);
check('direction still ranks 1st of 16 sign flips', rank === 1, `rank ${rank}`);

/* ---- POPULATION: may legitimately move ---- */
console.log('\n  ── POPULATION QUANTITIES — movement here is expected, not a problem ──\n');
const row = (label, before, after, unit = '') => {
  const d = after !== null && before !== 0 ? `${(((after - before) / Math.abs(before)) * 100).toFixed(0)}%` : '—';
  console.log(`  ${label.padEnd(34)} ${String(before).padStart(9)} -> ${String(after === null ? '?' : after.toFixed ? after.toFixed(4) : after).padStart(9)}${unit}   ${d}`);
};
row('WEB-vs-Bluray gap (P sd)', BASE.gap, prov.anchor?.gap ?? null);
row('gap t-statistic', BASE.gapT, prov.anchor ? prov.anchor.gap / prov.anchor.se : null);
row('provenance fraction', BASE.provFraction, prov.shrink?.provFraction ?? null);
row('shrinkage floor (P sd)', BASE.shrinkFloor, prov.shrink?.floor ?? null);
row('reliability (REJECTED as shrinkage)', BASE.reliability, prov.reliability);

const rule = run('prov-rule-check.mjs', ['33', '1']);
const p05 = num(rule, /p05 (-?[\d.]+)/);
const p95 = num(rule, /p95 (-?[\d.]+)/);
const band = num(rule, /5-95 band\s+\+-([\d.]+)%/);
const worst = num(rule, /worst film \+-([\d.]+)%/);
const boundPass = /5-95 band\s+\+-[\d.]+%\s+PASS/.test(rule) && /worst film \+-[\d.]+%\s+PASS/.test(rule);
console.log(`\n  adjustment at anchor 33%, strength 1: p05 ${p05}%  p95 ${p95}%  band +-${band}%  worst +-${worst}%`);
console.log(`  EXTERNAL BOUND: ${boundPass ? 'PASS' : '**FAIL**'}`);
if (!boundPass) fail += 1;

console.log('\n  ── VERDICT ──\n');
if (fail === 0) {
  console.log('  Every structural claim survived the coverage fix, and the external bound still passes.');
  console.log('  The population quantities moved, which is expected — the sample grew 25% in a');
  console.log('  non-random direction. Update the numbers quoted in 11.26-11.29 and the handoff, and');
  console.log('  note that the CONCLUSIONS are unchanged.');
} else {
  console.log(`  ${fail} STRUCTURAL CHECK(S) FAILED. The coverage hole was hiding something.`);
  console.log('  TAKE THE PROVENANCE RULE OFF THE BLEND PAGE\'S DEFAULT until this is understood.');
  console.log('  Do not adjust the tolerances to make it pass — they were fixed before the run.');
}
console.log('');
