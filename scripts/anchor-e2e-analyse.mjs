/* LAMBDA AND THE ANCHOR, BOTH LEGS ON THE SAME CLIPS — analysis for scripts/anchor-e2e.js.
 *
 * THE IDENTITY THIS IS BUILT ON. lambda = ln(1+anchor)/dPdGen, and the anchor is itself exp(B/A)-1
 * with B = dP/dgen and A = |dP/dlog bpp|. The generation step therefore CANCELS:
 *     lambda = (B/A)/dPdGen = 1/A   whenever the same step is used in both places.
 * Check against shipped: A = 0.6555 from the crossed ladder gives 1/A = 1.526 vs lambda 1.519.
 * So lambda is the reciprocal of the BITS-RESPONSE SLOPE and nothing else. The consequence is that
 * the end-to-end generation result, however solid, must not be dropped into the denominator alone:
 * that would pair a ladder-measured numerator with a real-first-generation denominator.
 *
 * WHAT IS NEW HERE. Leg A is measured on the SAME CLIPS as leg B, so the ratio B/A involves no
 * transfer between populations at all. Leg A's 1.0x rung IS the gen1 encode leg B already used, which
 * pins both legs to a common encode so any per-film offset in P cancels in the ratio.
 *
 * *** THE SURFACE IS HELD FIXED AT THE FILM'S OWN ROW FOR EVERY RUNG. *** This is deliberate and it
 * is the one design choice that could silently invert the meaning of A. The shipped surface already
 * contains the library's average response to bits; if each rung were evaluated at its OWN bitrate the
 * surface would absorb most of the bits effect and A would measure only the DEPARTURE from the
 * library's average response, which is a different quantity and much smaller. Leg B was measured with
 * gen0 and gen1 sharing one surface row for exactly the same reason. Both legs must be read by the
 * same instrument or the ratio is meaningless.
 *
 * DIRECTION CHECKS FIRST, per film. A film whose P does not fall as bits rise is excluded rather than
 * averaged in: there P is not tracking damage and its ratio is noise over noise.
 *
 * THE RATIO OF MEDIANS is the headline, not the median of per-film ratios. Per-film A appears in a
 * denominator, so films with small |A| amplify without bound; pooling first avoids that 1/A blow-up.
 * Both are printed, and a large gap between them is itself the warning.
 *
 * USAGE: node scripts/anchor-e2e-analyse.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = { cambi: +1, block: +1, blur: +1, grain: -1 };
const PUBLISHED = [0.05, 0.40];   /* BD-rate range for a re-encode generation, the external bound */

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
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
/* slope of y on x, least squares */
const slope = (xs, ys) => {
  const mx = mean(xs); const my = mean(ys);
  let n = 0; let d = 0;
  for (let i = 0; i < xs.length; i += 1) { n += (xs[i] - mx) * (ys[i] - my); d += (xs[i] - mx) ** 2; }
  return d > 0 ? n / d : NaN;
};

/* ---- the shipped surface, fitted on the full library, identical to export-provenance.js ---- */
const lib = [];
const seen = new Set();
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
const X = lib.map((u) => design(u.bpp, u.cxEff, u.codec));
const BETA = {}; const RSD = {};
for (const d of DET) {
  const y = lib.map((u) => Math.log(u[d]));
  BETA[d] = ols(X, y);
  RSD[d] = sd(y.map((v, i) => v - X[i].reduce((s, z, j) => s + z * BETA[d][j], 0)));
}
const P0lib = lib.map((u) => {
  const row = design(u.bpp, u.cxEff, u.codec);
  return DET.reduce((s, d) => {
    const fit = row.reduce((t, z, j) => t + z * BETA[d][j], 0);
    return s + EXPECT[d] * ((Math.log(u[d]) - fit) / RSD[d]);
  }, 0);
});
const MP = mean(P0lib); const SDSUM = sd(P0lib);

/* P for an arbitrary artifact reading, evaluated at a FIXED surface row (see header). */
const Pof = (m, u) => {
  const row = design(u.bpp, u.cxEff, u.codec);
  let got = 0;
  const p0 = DET.reduce((s, d) => {
    if (!(m[d] > 0)) return s;
    got += 1;
    const fit = row.reduce((t, z, j) => t + z * BETA[d][j], 0);
    return s + EXPECT[d] * ((Math.log(m[d]) - fit) / RSD[d]);
  }, 0);
  return got === DET.length ? (p0 - MP) / SDSUM : null;
};

const e2e = JSON.parse(fs.readFileSync('data/end-to-end-generation.json', 'utf8')).units;
let legA;
try { legA = JSON.parse(fs.readFileSync('data/anchor-e2e.json', 'utf8')); } catch {
  console.log('\n  data/anchor-e2e.json not written yet — run scripts/anchor-e2e.js first\n'); process.exit(0);
}
const RUNGS = legA.rungs;

const rows = [];
for (const [key, a] of Object.entries(legA.units)) {
  const u = e2e[key];
  if (!u?.gen0 || !u?.gen1) continue;
  const p0 = Pof(u.gen0, u); const p1 = Pof(u.gen1, u);
  if (p0 == null || p1 == null) continue;
  /* leg A: the 1.0x rung IS gen1, which is what pins the two legs together */
  const xs = [Math.log(1.0)]; const ys = [p1];
  for (const m of RUNGS) {
    const p = Pof(a.rungs[m] || a.rungs[String(m)] || {}, u);
    if (p != null) { xs.push(Math.log(m)); ys.push(p); }
  }
  if (xs.length < 3) continue;
  const A = slope(xs, ys);
  rows.push({ t: u.title, A, B: p1 - p0, p0, p1 });
}

if (rows.length < 6) {
  console.log(`\n  only ${rows.length} units so far — need 6+ before reading anything\n`); process.exit(0);
}

console.log(`\n  ${rows.length} units, both legs on identical clips\n`);
console.log(`  ${'film'.padEnd(30)} ${'A dP/dlnb'.padStart(10)} ${'B dP/dgen'.padStart(10)} ${'B/A'.padStart(8)}`);
for (const r of rows) {
  console.log(`  ${r.t.slice(0, 29).padEnd(30)} ${r.A.toFixed(3).padStart(10)} ${r.B.toFixed(3).padStart(10)} `
    + `${(r.A < 0 ? (r.B / -r.A).toFixed(3) : '  --').padStart(8)}`);
}

/* ---- direction checks, before any ratio ---- */
const okA = rows.filter((r) => r.A < 0);
const okB = rows.filter((r) => r.B > 0);
console.log(`\n  DIRECTION CHECKS (pre-registered)\n`);
console.log(`    leg A  dP/dlog bpp < 0   ${okA.length}/${rows.length}   (more bits must make P better)`);
console.log(`    leg B  dP/dgen     > 0   ${okB.length}/${rows.length}   (a generation must make P worse)`);
const good = rows.filter((r) => r.A < 0 && r.B > 0);
if (good.length < rows.length * 0.6) {
  console.log('\n  *** DIRECTION FAILS on too many films. P is not tracking damage on these clips and');
  console.log('  the ratio is noise over noise. Nothing below is usable. ***\n');
  process.exit(0);
}

const As = good.map((r) => -r.A);
const Bs = good.map((r) => r.B);
const Apool = med(As); const Bpool = med(Bs);
const ratioOfMed = Bpool / Apool;
const medOfRatio = med(good.map((r) => r.B / -r.A));
const LAM = 1 / Apool;
const anchor = Math.exp(ratioOfMed) - 1;

console.log(`\n  MEASURED, ${good.length} films passing both direction checks\n`);
console.log(`    leg A  |dP/dlog bpp|   median ${Apool.toFixed(4)}   sd ${sd(As).toFixed(4)}`);
console.log(`    leg B  dP/dgen         median ${Bpool.toFixed(4)}   sd ${sd(Bs).toFixed(4)}`);
console.log(`    ratio of medians       ${ratioOfMed.toFixed(4)}`);
console.log(`    median of ratios       ${medOfRatio.toFixed(4)}   ${
  Math.abs(medOfRatio - ratioOfMed) > 0.5 * ratioOfMed ? '<< THEY DISAGREE — 1/A blow-up, trust the pooled one' : '(consistent)'}`);
console.log(`\n    *** lambda = 1/|A| = ${LAM.toFixed(3)} ***   shipped 1.519`);
console.log(`    *** anchor = exp(B/A)-1 = ${(anchor * 100).toFixed(1)}% ***   shipped 35.6%`);

console.log(`\n  AGAINST THE EXTERNAL BOUND (published BD-rate for a generation, ${PUBLISHED[0] * 100}-${PUBLISHED[1] * 100}%)\n`);
if (anchor >= PUBLISHED[0] && anchor <= PUBLISHED[1]) {
  console.log('    INSIDE the published range. The anchor is externally corroborated for the first time,');
  console.log('    and lambda can be updated to 1/|A| with the generation step never entering it.');
} else if (anchor > PUBLISHED[1]) {
  console.log(`    ABOVE the published range by ${(anchor / PUBLISHED[1]).toFixed(1)}x. Two readings, and this does`);
  console.log('    not decide between them: either our re-encode generation is genuinely harsher than a');
  console.log('    published BD-rate comparison (ours is a transcode of an already-compressed source at');
  console.log('    matched bits, which is not what BD-rate measures), or P over-responds to generations');
  console.log('    relative to bits. DO NOT ADOPT on this alone.');
} else {
  console.log('    BELOW the published range. P under-responds to generations relative to bits.');
}

const shift = LAM / 1.519;
console.log(`\n  WHAT ADOPTING lambda = ${LAM.toFixed(3)} WOULD DO\n`);
console.log(`    lambda x${shift.toFixed(2)}, so every provenance adjustment scales by the same factor.`);
console.log(`    shipped band +-9.9%  ->  +-${(9.9 * shift).toFixed(1)}%`);
console.log('    Nothing about the per-film ORDERING changes — that is a separate failure (11.53) and');
console.log('    a change of scale here neither fixes nor worsens it.');
console.log('');
