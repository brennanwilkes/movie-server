/* IS THE PRE-REGISTERED DIRECTION SPECIAL ON THE CONTROLLED AXES? — the test the field cannot give.
 *
 * WHY THIS EXISTS. 11.40's one surviving failure is the field permutation test: 537 of 20000 random
 * directions now reach our WEB-vs-Bluray gap. 11.44 argued that is a property of the CONTRAST — that
 * contrast is generations-dominated, so a direction spending a quarter of itself on grain (the
 * preprocessing detector) looks less special on it. #82 recorded the underlying problem: FOUR
 * validated axes, only ONE observable field contrast to test them against.
 *
 * The controlled experiments have no such limitation. Provenance there is KNOWN and varied on purpose,
 * with bits and content held constant. So the same permutation logic can be run on them.
 *
 * THE TAUTOLOGY THIS MUST AVOID, and it is the whole design problem. On a SINGLE axis the best
 * direction is trivially that axis's own direction, and the pre-registered signature was chosen to
 * match what a re-encode does — so "the physics direction scores well on the generations axis" would
 * be close to circular and would prove nothing.
 *
 * THE NON-TAUTOLOGICAL QUESTION IS WHETHER ONE DIRECTION WORKS ON ALL THREE AT ONCE. That is the
 * actual covering-set claim: a single fixed projection that detects provenance whatever its cause.
 * A random direction can easily align with one axis; aligning with three at once is the hard part.
 * So the statistic is the WORST of the three axes, not the average — a direction that misses any one
 * of them scores badly, and averaging would let a strong showing on one hide a failure on another.
 *
 * WHAT WOULD FALSIFY THE COVERING-SET FRAMING: many random directions matching the pre-registered one
 * on the worst-axis statistic. That would mean the physics signature is not special at spanning
 * provenance, only at the one contrast it was checked on, and 11.28's evidence would need rereading.
 *
 * Seeded, so the null cannot be re-rolled until it agrees.
 *
 * USAGE: node scripts/controlled-permutation.mjs [nRandom]
 */
import fs from 'fs';

const N_RANDOM = Number(process.argv[2] ?? 20000);
const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = [+1, +1, +1, -1];

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const unit = (v) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return v.map((x) => x / n); };
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

/* Per-detector library residual sds — the noise scale directions are expressed in. Comparing raw
 * slopes instead would let cambi dominate every direction, which is the error 11.25 made. */
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
const SD = {};
for (const d of DET) {
  const y = rows.map((u) => Math.log(u[d]));
  const be = ols(X, y);
  SD[d] = sd(y.map((v, i) => v - X[i].reduce((s, z, j) => s + z * be[j], 0)));
}

/* For each controlled axis, the PER-FILM change in log-detector from best rung to worst, in noise
 * units. A direction's score on that axis is mean(projection) / sd(projection) across films — a
 * t-statistic, so axes with different step sizes are comparable. */
function axisDeltas(films, rowsOf, orderKey, flip) {
  const out = [];
  for (const f of films) {
    const rs = rowsOf(f);
    if (!rs || rs.length < 2) continue;
    const sorted = rs.slice().sort((a, b) => (orderKey(a) - orderKey(b)) * flip);
    const worst = sorted[sorted.length - 1]; const best = sorted[0];
    if (!DET.every((d) => worst[d] > 0 && best[d] > 0)) continue;
    out.push(DET.map((d) => (Math.log(worst[d]) - Math.log(best[d])) / SD[d]));
  }
  return out;
}

const AXES = [];
try {
  const gen = JSON.parse(fs.readFileSync('data/generation-test.json', 'utf8')).films;
  const d = axisDeltas(gen, (f) => (f.rows || []).filter((r) => DET.every((k) => r[k] > 0)),
    (r) => (r.gen ?? 0), +1);
  if (d.length >= 5) AXES.push({ name: 'generations', deltas: d });
} catch { /* */ }
try {
  const den = JSON.parse(fs.readFileSync('data/denoise-test.json', 'utf8')).films;
  /* rank 3 = none (best), rank 1 = heavy (worst), so order DESCENDING by rank to put best first. */
  const d = axisDeltas(den, (f) => (f.rows || []).filter((r) => DET.every((k) => r[k] > 0)),
    (r) => r.rank, -1);
  if (d.length >= 5) AXES.push({ name: 'preprocessing', deltas: d });
} catch { /* */ }
try {
  const enc = JSON.parse(fs.readFileSync('data/encoder-ladder-wide.json', 'utf8')).films;
  /* x264 presets only — including x265 mixes in a codec fingerprint (11.12). rank 1 = veryfast =
   * worst, so descending puts the best preset first. */
  const d = axisDeltas(enc, (f) => (f.rows || []).filter((r) => /x264/.test(r.name) && DET.every((k) => r[k] > 0)),
    (r) => r.rank, -1);
  if (d.length >= 5) AXES.push({ name: 'encoder', deltas: d });
} catch { /* */ }

if (AXES.length < 2) { console.log('\n  need at least two controlled axes; found ' + AXES.length + '\n'); process.exit(0); }
console.log(`\n  ${AXES.map((a) => `${a.name} n=${a.deltas.length}`).join('   ')}\n`);

/* Score a direction on one axis: t = mean/sd of the projected per-film change. */
const tOn = (axis, w) => {
  const p = axis.deltas.map((v) => v.reduce((s, x, i) => s + x * w[i], 0));
  const s = sd(p);
  return s > 0 ? mean(p) / s : 0;
};
const scoreOf = (w) => Math.min(...AXES.map((a) => tOn(a, w)));   // WORST axis, deliberately

const ours = unit(EXPECT.map((e, i) => e / SD[DET[i]]));
console.log('  PRE-REGISTERED DIRECTION, per axis (t of the projected per-film change)\n');
console.log(`  ${'axis'.padEnd(16)} ${'t'.padStart(8)}`);
for (const a of AXES) console.log(`  ${a.name.padEnd(16)} ${tOn(a, ours).toFixed(2).padStart(8)}`);
const oursScore = scoreOf(ours);
console.log(`  ${'WORST AXIS'.padEnd(16)} ${oursScore.toFixed(2).padStart(8)}   <- the statistic`);

let seed = 20260827;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => { const u = Math.max(rnd(), 1e-12); const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
let beat = 0; let bestW = null; let bestS = -Infinity;
const sample = [];
for (let t = 0; t < N_RANDOM; t += 1) {
  const w = unit([gauss(), gauss(), gauss(), gauss()]);
  const s = scoreOf(w);
  sample.push(s);
  if (s >= oursScore) beat += 1;
  if (s > bestS) { bestS = s; bestW = w; }
}
sample.sort((a, b) => a - b);
const pct = (f) => sample[Math.floor(f * (sample.length - 1))];
console.log(`\n  NULL — ${N_RANDOM} random unit directions, same axes, same films\n`);
console.log(`  worst-axis t of random directions: p50 ${pct(0.5).toFixed(2)}  p95 ${pct(0.95).toFixed(2)}  max ${sample[sample.length - 1].toFixed(2)}`);
console.log(`  directions matching or beating ours: ${beat} of ${N_RANDOM} (${((beat / N_RANDOM) * 100).toFixed(2)}%)`);
console.log(`\n  best random direction: ${DET.map((d, i) => `${bestW[i].toFixed(2)} ${d}`).join('  ')}`);
console.log(`  its worst-axis t ${bestS.toFixed(2)} vs ours ${oursScore.toFixed(2)}`);

console.log('\n  VERDICT\n');
const frac = beat / N_RANDOM;
if (frac < 0.02) {
  console.log(`  THE DIRECTION IS SPECIAL AT SPANNING PROVENANCE. It beats ${((1 - frac) * 100).toFixed(1)}% of arbitrary`);
  console.log('  directions on the WORST of three controlled axes — the statistic that punishes a');
  console.log('  direction for missing any one of them. That is the covering-set claim tested where');
  console.log('  provenance is KNOWN, and it is evidence the single field contrast cannot provide.');
  console.log('  It does NOT rescue 11.40: that failure is about the field yardstick and stands.');
} else if (frac < 0.15) {
  console.log(`  MODERATELY SPECIAL — beats ${((1 - frac) * 100).toFixed(1)}% of random directions on the worst axis.`);
  console.log('  Supportive but not decisive; quote it with the number, not as a headline.');
} else {
  console.log(`  NOT SPECIAL — ${(frac * 100).toFixed(1)}% of arbitrary directions do as well on the worst axis.`);
  console.log('  The physics signature is not distinguished at spanning provenance, only at whatever');
  console.log('  contrast it has been checked against. 11.28 needs rereading in that light, and the');
  console.log('  equal-weight direction would need a better justification than it currently has.');
}
console.log('');
