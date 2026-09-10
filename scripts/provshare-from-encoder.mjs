/* provShare, MEASURED — how much of P is provenance rather than content?
 *
 * WHAT IS AT STAKE. provShare = 0.075 multiplies every shipped provenance adjustment, and it has
 * always been an ESTIMATE. It is meant to be the fraction of P's variance attributable to how a file
 * was made rather than to what is in it. Until now there was nothing to measure it against, because
 * the only observable field contrast was the WEB/Bluray source tag and 11.44 showed that contrast is
 * dominated by bits.
 *
 * WHAT CHANGED. scripts/encoder-fingerprint.js recovers the encoder identity straight off the
 * bitstream for 85.7% of the library (898/1048): 67 distinct x264 builds, plus ref, bframes, subme,
 * trellis, psy_rd, me, deblock and the rate-control mode. That is a DIRECT observation of provenance,
 * independent of the release channel, and it corrects 11.50's claim that no finer marker exists.
 *
 * THE MEASUREMENT. P is ALREADY residualised against bits, complexity and codec by construction, so
 * any variance in P that encoder identity explains is provenance variance by definition. Therefore
 *     provShare >= adjusted R^2 of P on the encoder features
 * It is a LOWER bound, and that direction matters: unobserved provenance — how many generations, what
 * the source was, what the encoder before this one did — is not in these features and can only add.
 *
 * *** THE TRAP, AND IT IS SEVERE. *** Encoder build number correlates with YEAR, and year correlates
 * with content, grain, resolution and bitrate. A raw R^2 is therefore NOT evidence of provenance. Two
 * defences, both applied:
 *   1. YEAR IS ENTERED AS A CONTROL and the incremental R^2 over year alone is reported separately.
 *      The honest number is what encoder identity adds ON TOP OF year, not what it explains alone.
 *   2. A PERMUTATION NULL. With ~17 parameters on ~800 films, R^2 is biased upward by construction.
 *      Shuffling the encoder assignment and refitting gives the R^2 this design produces from pure
 *      noise, and the measured value must clear that distribution, not zero. This is the check that
 *      the matched filter skipped, at a cost of three named mistakes.
 *
 * FEATURES ARE PRE-SPECIFIED, not selected. Using all 67 builds as dummies would overfit ~800 rows;
 * build enters as log(build) plus a small fixed set. No feature is added or dropped after seeing a
 * result, because that would turn the permutation null into decoration.
 *
 * USAGE: node scripts/provshare-from-encoder.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = { cambi: +1, block: +1, blur: +1, grain: -1 };
const NPERM = 400;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
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
    if (Math.abs(A[c][c]) < 1e-9) { A[c][c] = 1e-9; }
    for (let r = 0; r < p; r += 1) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let cc = c; cc < p; cc += 1) A[r][cc] -= f * A[c][cc];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}
/* R^2 and the adjusted version. Adjusted is the one reported: it penalises the parameter count, which
 * is the whole reason a raw R^2 would mislead here. */
function r2(X, y) {
  const b = ols(X, y);
  if (!b) return { r2: NaN, adj: NaN };
  const my = mean(y);
  let ss = 0; let tt = 0;
  for (let i = 0; i < y.length; i += 1) {
    const f = X[i].reduce((s, z, j) => s + z * b[j], 0);
    ss += (y[i] - f) ** 2; tt += (y[i] - my) ** 2;
  }
  const R = 1 - ss / tt;
  const n = y.length; const p = X[0].length;
  return { r2: R, adj: 1 - (1 - R) * ((n - 1) / (n - p)) };
}

/* ---- the shipped P, built exactly as export-provenance.js does ---- */
const lib = []; const seen = new Set();
for (const f of ['data/artifact-backfill.json', 'data/provenance-wild.json']) {
  let d; try { d = JSON.parse(fs.readFileSync(f, 'utf8')).units; } catch { continue; }
  for (const [key, u] of Object.entries(d)) {
    if (!seen.has(key) && u.bpp > 0 && u.cxEff > 0 && DET.every((k) => u[k] > 0)) { lib.push({ key, ...u }); seen.add(key); }
  }
}
const design = (bpp, cx, codec) => {
  const lb = Math.log(bpp); const lc = Math.log(cx); const hv = codec === 'hevc' ? 1 : 0;
  return [1, lb, lb * lb, lc, lc * lc, lb * lc, hv, hv * lb];
};
const X0 = lib.map((u) => design(u.bpp, u.cxEff, u.codec));
const BETA = {}; const RSD = {};
for (const d of DET) {
  const y = lib.map((u) => Math.log(u[d]));
  BETA[d] = ols(X0, y);
  RSD[d] = sd(y.map((v, i) => v - X0[i].reduce((s, z, j) => s + z * BETA[d][j], 0)));
}
const P0 = lib.map((u, i) => DET.reduce((s, d) => {
  const fit = X0[i].reduce((t, z, j) => t + z * BETA[d][j], 0);
  return s + EXPECT[d] * ((Math.log(u[d]) - fit) / RSD[d]);
}, 0));
const MP = mean(P0); const SP = sd(P0);
const Pby = new Map(lib.map((u, i) => [u.key, (P0[i] - MP) / SP]));

/* ---- join to the fingerprint ---- */
const fp = JSON.parse(fs.readFileSync('data/encoder-fingerprint.json', 'utf8')).units;
const rows = [];
for (const [key, f] of Object.entries(fp)) {
  const P = Pby.get(key);
  if (P == null || !f.family || !f.build) continue;
  if (f.ref == null || f.bframes == null || f.subme == null) continue;
  rows.push({ P, f });
}
console.log(`\n  ${rows.length} films with BOTH a shipped P and a recovered encoder identity\n`);
if (rows.length < 100) { console.log('  too few to fit — stopping\n'); process.exit(0); }

const lv = (k) => [...new Set(rows.map((r) => String(r.f[k] ?? 'na')))].sort();
const ME = lv('me'); const RC = lv('rc'); const DB = lv('deblock');
const psy1 = (v) => (v ? Number(String(v).split(':')[0]) || 0 : 0);
/* PRE-SPECIFIED feature set. Nothing here is chosen after seeing a result. */
const featEnc = (f) => [
  Math.log(f.build), f.ref, f.bframes, f.subme, f.trellis ?? 0, psy1(f.psyrd),
  ...ME.slice(1).map((v) => (String(f.me) === v ? 1 : 0)),
  ...RC.slice(1).map((v) => (String(f.rc) === v ? 1 : 0)),
  ...DB.slice(1).map((v) => (String(f.deblock) === v ? 1 : 0)),
];
const yearOf = (f) => (f.year ? Number(f.year) : null);
const haveYear = rows.filter((r) => yearOf(r.f));
const y = rows.map((r) => r.P);

const Xenc = rows.map((r) => [1, ...featEnc(r.f)]);
const encOnly = r2(Xenc, y);
console.log(`  ENCODER IDENTITY ALONE      R2 ${encOnly.r2.toFixed(4)}   adjusted ${encOnly.adj.toFixed(4)}   `
  + `(${Xenc[0].length} params)`);

if (haveYear.length > 100) {
  const yy = haveYear.map((r) => r.P);
  const Xy = haveYear.map((r) => [1, yearOf(r.f), yearOf(r.f) ** 2]);
  const Xye = haveYear.map((r) => [1, yearOf(r.f), yearOf(r.f) ** 2, ...featEnc(r.f)]);
  const a = r2(Xy, yy); const b = r2(Xye, yy);
  console.log(`  YEAR ALONE                  R2 ${a.r2.toFixed(4)}   adjusted ${a.adj.toFixed(4)}   (n ${haveYear.length})`);
  console.log(`  YEAR + ENCODER              R2 ${b.r2.toFixed(4)}   adjusted ${b.adj.toFixed(4)}`);
  console.log(`  *** ENCODER OVER AND ABOVE YEAR   dAdjR2 ${(b.adj - a.adj).toFixed(4)} ***`);
  console.log('  That last number is the honest one: what the bitstream tells you that the release');
  console.log('  date does not. Build number tracks year, and year tracks content the surface misses.');
}

/* ---- the permutation null. R^2 is biased up by parameter count; this is the distribution that
 * bias produces on its own, and the measured value has to clear it. ---- */
let rng = 12345;
const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
const null_ = [];
for (let p = 0; p < NPERM; p += 1) {
  const idx = rows.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const Xp = idx.map((i) => [1, ...featEnc(rows[i].f)]);
  null_.push(r2(Xp, y).adj);
}
null_.sort((a, b) => a - b);
const p95 = null_[Math.floor(0.95 * NPERM)];
const beat = null_.filter((v) => v >= encOnly.adj).length;
console.log(`\n  PERMUTATION NULL (${NPERM} shuffles of the encoder assignment)\n`);
console.log(`    null adjusted R2   median ${null_[NPERM >> 1].toFixed(4)}   p95 ${p95.toFixed(4)}`);
console.log(`    measured           ${encOnly.adj.toFixed(4)}`);
console.log(`    p-value            ${((beat + 1) / (NPERM + 1)).toFixed(4)}`);

console.log('\n  VERDICT\n');
if (encOnly.adj > p95) {
  console.log(`    Encoder identity explains a REAL ${(100 * encOnly.adj).toFixed(1)}% of P's variance, clearing`);
  console.log('    the permutation null. Since P is already residualised against bits, complexity and');
  console.log('    codec, that variance is provenance by construction, and it is a LOWER bound on');
  console.log(`    provShare — unobserved provenance can only add.`);
  console.log(`\n    shipped provShare 0.075   measured lower bound ${encOnly.adj.toFixed(3)}`);
  if (encOnly.adj > 0.075) {
    console.log(`    The shipped value is BELOW the measured floor, so it understates the adjustment by`);
    console.log(`    at least ${(encOnly.adj / 0.075).toFixed(2)}x. Do not adopt from this alone — check it against the`);
    console.log('    year control above, which is the confound that would fake exactly this result.');
  } else {
    console.log('    The shipped value sits above the measured floor, which is consistent — the floor is');
    console.log('    a lower bound and unobserved provenance is not in it.');
  }
} else {
  console.log('    DOES NOT CLEAR THE NULL. Encoder identity explains no more of P than a shuffled');
  console.log('    assignment does with the same parameter count. On this evidence the bitstream');
  console.log('    fingerprint is not a usable provenance contrast, and provShare stays an estimate.');
}
console.log('');
