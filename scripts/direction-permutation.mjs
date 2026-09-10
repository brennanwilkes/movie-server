/* DOES THE DIRECTION ACTUALLY MATTER? — the placebo test for the provenance factor.
 *
 * THE CLAIM UNDER TEST. P is built by summing four residuals in the PRE-REGISTERED re-encode
 * direction (+cambi +block +blur -grain), and the WEB-vs-Bluray gap of 0.271 is offered as evidence
 * that P measures provenance. But a gap between two groups of films can appear for many reasons. If
 * an ARBITRARY direction through the same four residuals produces the same size of gap just as often,
 * then the pre-registered direction is doing no work and the "re-encode signature" story is empty
 * decoration on a result that would have happened anyway.
 *
 * THE NULL. Draw random unit directions in the 4-dimensional residual space and compute the same
 * WEB-vs-Bluray gap for each. This holds the data, the groups, the residualisation and the group sizes
 * all fixed, and varies ONLY the thing being tested. Two nulls are run because they answer different
 * questions:
 *   SIGN FLIPS       the same four detectors with the same weights, only the signs permuted (16 of
 *                    them, exhaustive). Asks: is it the ORIENTATION that matters?
 *   RANDOM DIRECTIONS arbitrary weights anywhere on the unit sphere. Asks: is it this direction at
 *                    all, or would any combination of these residuals do?
 *
 * WHY THIS IS THE RIGHT ADVERSARIAL TEST AND A LABEL SHUFFLE IS NOT. Shuffling the WEB/Bluray labels
 * would test whether the gap is bigger than chance — but the gap already has a t of 2.58, so that
 * answer is known and it is not the interesting question. The interesting question is whether the
 * PHYSICS story earns its place, and only varying the direction can answer it.
 *
 * PRE-REGISTERED READING:
 *   pre-registered direction in the top ~10% of random directions -> the signature is doing real work
 *   somewhere in the middle                                       -> the story is decoration; the gap
 *                                                                    is a property of the residuals,
 *                                                                    not of the re-encode direction
 *   the best sign flip being a DIFFERENT one                      -> we have the physics backwards
 *
 * USAGE: node scripts/direction-permutation.mjs [nRandom]
 */
import fs from 'fs';

const N_RANDOM = Number(process.argv[2] ?? 20000);
const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = [+1, +1, +1, -1];

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };

const P = JSON.parse(fs.readFileSync('bpp-lab/public/provenance.json', 'utf8'));
const rows = Object.values(P.units);
const Z = DET.map((d) => rows.map((u) => u.z[d]));
const isWeb = rows.map((u) => /WEB/i.test(u.source || ''));
const isBlu = rows.map((u) => /Bluray/i.test(u.source || ''));
const iW = rows.map((_, i) => i).filter((i) => isWeb[i]);
const iB = rows.map((_, i) => i).filter((i) => isBlu[i]);
console.log(`\n  ${rows.length} units   WEB ${iW.length}   Bluray ${iB.length}\n`);

/* Gap in sd units of the score that direction w produces, so directions of different scale are
 * comparable. This is exactly the anchor quantity the lab uses. */
function gapOf(w) {
  const s = rows.map((_, i) => DET.reduce((acc, _d, j) => acc + w[j] * Z[j][i], 0));
  const m = mean(s); const sdv = sd(s);
  if (!(sdv > 0)) return 0;
  const norm = s.map((v) => (v - m) / sdv);
  return mean(iW.map((i) => norm[i])) - mean(iB.map((i) => norm[i]));
}

const observed = gapOf(EXPECT);
console.log(`  pre-registered direction (+cambi +block +blur -grain): gap = ${observed.toFixed(4)}\n`);

/* ---- NULL 1: all 16 sign assignments, exhaustive ---- */
console.log('  NULL 1 — all 16 sign flips of the same four detectors\n');
const flips = [];
for (let m = 0; m < 16; m += 1) {
  const w = [0, 1, 2, 3].map((j) => ((m >> j) & 1 ? 1 : -1));
  flips.push({ w, gap: gapOf(w) });
}
flips.sort((a, b) => b.gap - a.gap);
console.log(`  ${'rank'.padStart(4)} ${'direction'.padEnd(30)} ${'gap'.padStart(8)}`);
flips.forEach((f, i) => {
  const label = DET.map((d, j) => `${f.w[j] > 0 ? '+' : '-'}${d}`).join(' ');
  const isOurs = f.w.every((v, j) => v === EXPECT[j]);
  console.log(`  ${String(i + 1).padStart(4)} ${label.padEnd(30)} ${f.gap.toFixed(4).padStart(8)}${isOurs ? '   <- PRE-REGISTERED' : ''}`);
});
const ourRank = flips.findIndex((f) => f.w.every((v, j) => v === EXPECT[j])) + 1;
/* Sign flips come in exact negative pairs, so 8 of the 16 are just the mirror of the other 8 and
 * only the top half is informative. Rank 1 of 16 therefore means "best of 8 genuinely distinct
 * orientations", which is the honest way to state it. */
console.log(`\n  pre-registered direction ranks ${ourRank} of 16 (8 distinct orientations plus their mirrors)`);

/* ---- NULL 2: random unit directions ---- */
/* Deterministic generator, seeded, so this test gives the same answer every run and cannot be
 * re-rolled until it agrees. */
let seed = 20260827;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => {
  const u = Math.max(rnd(), 1e-12); const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
let ge = 0; let geAbs = 0;
const sample = [];
for (let t = 0; t < N_RANDOM; t += 1) {
  const w = [gauss(), gauss(), gauss(), gauss()];
  const n = Math.sqrt(w.reduce((s, x) => s + x * x, 0)) || 1;
  const g = gapOf(w.map((x) => x / n));
  sample.push(g);
  if (g >= observed) ge += 1;
  if (Math.abs(g) >= Math.abs(observed)) geAbs += 1;
}
sample.sort((a, b) => a - b);
const pct = (f) => sample[Math.floor(f * (sample.length - 1))];
console.log(`\n  NULL 2 — ${N_RANDOM} random unit directions in the same 4-d residual space\n`);
console.log(`  random-direction gaps: p05 ${pct(0.05).toFixed(3)}  median ${pct(0.5).toFixed(3)}  `
  + `p95 ${pct(0.95).toFixed(3)}  max ${sample[sample.length - 1].toFixed(3)}`);
console.log(`  directions with a gap at least as large as ours: ${ge} of ${N_RANDOM} `
  + `(${((ge / N_RANDOM) * 100).toFixed(2)}%)`);
console.log(`  ... in absolute value:                            ${geAbs} of ${N_RANDOM} `
  + `(${((geAbs / N_RANDOM) * 100).toFixed(2)}%)`);

const frac = ge / N_RANDOM;
console.log('\n  VERDICT');
if (frac < 0.10) {
  console.log(`  The pre-registered direction beats ${((1 - frac) * 100).toFixed(1)}% of arbitrary directions.`);
  console.log('  The re-encode signature is doing real work — the gap is a property of THIS direction,');
  console.log('  not of the residual space in general.');
} else if (frac < 0.35) {
  console.log(`  Middling: ${((1 - frac) * 100).toFixed(1)}% of arbitrary directions are beaten. The direction`);
  console.log('  helps but is not special; state it that way and do not lean on the physics story.');
} else {
  console.log(`  DECORATION: ${((1 - frac) * 100).toFixed(1)}% beaten. Any combination of these residuals`);
  console.log('  separates the groups about as well, so the re-encode signature claim is not supported');
  console.log('  and the direction should be described as arbitrary-but-fixed.');
}

/* The best direction the data itself would choose, for comparison. If it is far from the
 * pre-registered one, the physics story and the data disagree about what separates the groups — worth
 * knowing even though FITTING this direction would be circular and must not be shipped. */
let best = null;
for (let t = 0; t < N_RANDOM; t += 1) {
  const w = [gauss(), gauss(), gauss(), gauss()];
  const n = Math.sqrt(w.reduce((s, x) => s + x * x, 0)) || 1;
  const u = w.map((x) => x / n);
  const g = gapOf(u);
  if (!best || g > best.gap) best = { w: u, gap: g };
}
const cosBest = best.w.reduce((s, x, j) => s + x * (EXPECT[j] / 2), 0);
console.log(`\n  best direction found by search: ${DET.map((d, j) => `${best.w[j].toFixed(2)} ${d}`).join('  ')}`);
console.log(`  its gap ${best.gap.toFixed(3)} vs our ${observed.toFixed(3)};  cos with pre-registered = ${cosBest.toFixed(3)}`);
console.log('  (reported for diagnosis only — fitting this direction to the same groups would be');
console.log('   circular, and it is NOT what the lab ships.)\n');
