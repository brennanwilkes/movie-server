/* IS THE SHIPPED RULE UNDER-CALIBRATED? — two routes from P to bitrate, and they disagree by 2.2x.
 *
 * THE SHIPPED RULE uses    lambda = ln(1 + anchor%) / gap
 * where gap is the measured mean P(WEB) - mean P(Bluray). Read literally, that says "a WEB-vs-Bluray
 * sized difference in P is worth one anchor, i.e. 33.1% bitrate". THAT IS ONLY TRUE IF THE GAP IS
 * EXACTLY ONE GENERATION, and it is not: the crossed ladder measured dP/dgen = 0.112 P-sd while the
 * gap is ~0.248, so the gap is about 2.2 GENERATIONS. The rule therefore understates by that factor.
 *
 * THE DIRECT ROUTE needs no assumption about how many generations separate WEB from Bluray, because
 * the crossed ladder measured BOTH legs on the same clips:
 *     one generation costs   ln(1 + 0.331) log-bitrate      (leg B / leg A)
 *     one generation moves   0.112 P-sd                     (leg B)
 *     => lambda = ln(1 + anchor%) / dPdGen                  log-bitrate per P-sd
 *
 * AND IT IS ALGEBRAICALLY THE SAME AS 1/|dP/dlogbpp|, which is worth stating because it looks like the
 * 1/S division that killed six constructions:
 *     anchor = exp(sB / |sA|) - 1   =>   ln(1+anchor) / sB  =  1 / |sA|
 * The reason it is NOT the 11.21 failure is that sA here is P's slope, not a single detector's.
 * P is a composite dominated by cambi, so |sA| is ~0.42 rather than blocking's 0.103 — 11.35's
 * lesson, build the composite first and divide second. Both routes are computed below and must agree;
 * if they do not, one of the two legs is being read wrong.
 *
 * WHY THIS MATTERS AND WHY IT IS DANGEROUS. The correction roughly DOUBLES every adjustment, which
 * moves back toward the external bound that 11.37 was fixing. So it must be checked against that
 * bound BEFORE adoption, exactly as 11.37 was — and if it fails, the correct response is to say the
 * two routes disagree and stop, not to pick whichever number is comfortable.
 *
 * A SECOND CHECK, INDEPENDENT OF THE BOUND: with lambda corrected, does the implied generation count
 * for the library's extremes stay plausible? That is the test that decided 11.37 and it does not use
 * the bound at all. Shrinkage is unchanged here, so it should still pass — but it is checked rather
 * than assumed, because the whole point of 11.37 was that an unchecked scale produced +-27
 * generations.
 *
 * USAGE: node scripts/lambda-route.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = { cambi: +1, block: +1, blur: +1, grain: -1 };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const q = (a, f) => a.slice().sort((x, y) => x - y)[Math.floor(f * (a.length - 1))];
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
function fit(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length < 3) return null;
  const mx = mean(pts.map((p) => p[0])); const my = mean(pts.map((p) => p[1]));
  let n = 0; let d = 0;
  for (const [x, y] of pts) { n += (x - mx) * (y - my); d += (x - mx) ** 2; }
  return d > 0 ? n / d : null;
}

const P = JSON.parse(fs.readFileSync('bpp-lab/public/provenance.json', 'utf8'));
const back = JSON.parse(fs.readFileSync('data/artifact-backfill.json', 'utf8')).units;
const cross = JSON.parse(fs.readFileSync('data/anchor-crossed.json', 'utf8'));

/* Per-detector library scales, so the crossed ladder can be read in library-P units. The OFFSET does
 * not apply to a rung (no residual to centre) but the SCALE does — getting that wrong inflated a
 * number by 2.4x once already (11.36). */
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
const SD = {}; const Zc = {};
for (const d of DET) {
  const y = rows.map((u) => Math.log(u[d]));
  const be = ols(X, y);
  const r = y.map((v, i) => v - X[i].reduce((s, z, j) => s + z * be[j], 0));
  SD[d] = sd(r); Zc[d] = r.map((v) => v / SD[d]);
}
const SDSUM = sd(rows.map((_, i) => DET.reduce((s, d) => s + EXPECT[d] * Zc[d][i], 0)));
const pOf = (m) => DET.reduce((s, d) => s + (m[d] > 0 ? (EXPECT[d] * Math.log(m[d])) / SD[d] : 0), 0) / SDSUM;

const sA = []; const sB = [];
for (const f of cross.films || []) {
  const A = (f.legA || []).filter((r) => DET.every((d) => r[d] > 0));
  const B = (f.legB || []).filter((r) => DET.every((d) => r[d] > 0)).sort((x, y) => x.gen - y.gen);
  const a = A.length >= 3 ? fit(A.map((r) => Math.log(r.level)), A.map((r) => pOf(r))) : null;
  if (a != null && a < 0) sA.push(Math.abs(a));
  if (B.length >= 2) {
    const s = (pOf(B[B.length - 1]) - pOf(B[0])) / (B[B.length - 1].gen - B[0].gen);
    if (s > 0) sB.push(s);
  }
}
const ANCHOR = 0.331;
const dPdGen = med(sB);
const slopeA = med(sA);
const gap = P.anchor.gap;
const shrink = P.shrink?.floor ?? 0.10;

console.log(`\n  from the crossed ladder:  dP/dgen ${dPdGen.toFixed(4)} P-sd   |dP/dlogbpp| ${slopeA.toFixed(4)}`);
console.log(`  from the library:         WEB-vs-Bluray gap ${gap.toFixed(4)} P-sd  =  ${(gap / dPdGen).toFixed(2)} generations`);
console.log(`  shrinkage (provenance share) ${shrink.toFixed(4)}\n`);

const lamGap = Math.log(1 + ANCHOR) / gap;
const lamGen = Math.log(1 + ANCHOR) / dPdGen;
const lamSlope = 1 / slopeA;
console.log('  THREE WAYS TO GET lambda (log-bitrate per P-sd)\n');
console.log(`  ${'route'.padEnd(34)} ${'lambda'.padStart(8)}   note`);
console.log(`  ${'SHIPPED: ln(1+anchor)/gap'.padEnd(34)} ${lamGap.toFixed(3).padStart(8)}   assumes the gap is ONE generation`);
console.log(`  ${'DIRECT: ln(1+anchor)/dPdGen'.padEnd(34)} ${lamGen.toFixed(3).padStart(8)}   no assumption about the gap`);
console.log(`  ${'EQUIVALENT: 1/|dP/dlogbpp|'.padEnd(34)} ${lamSlope.toFixed(3).padStart(8)}   must match the line above`);
const agree = Math.abs(lamGen - lamSlope) / lamGen < 0.15;
console.log(`\n  the two direct routes ${agree ? 'AGREE' : '**DISAGREE**'} `
  + `(${((Math.abs(lamGen - lamSlope) / lamGen) * 100).toFixed(0)}% apart) — they are algebraically identical, so a`);
console.log(`  large gap would mean one leg is being read wrong.`);
console.log(`  shipped route understates the direct route by ${(lamGen / lamGap).toFixed(2)}x`);

/* ---- what each does to the library ---- */
const units = [];
for (const [key, u] of Object.entries(P.units)) {
  const b = back[key];
  if (b?.bppPlus > 0) units.push({ title: b.title, bppPlus: b.bppPlus, P: u.P, source: u.source });
}
console.log(`\n  EFFECT ON ${units.length} UNITS\n`);
console.log(`  ${'lambda route'.padEnd(16)} ${'p05'.padStart(8)} ${'median'.padStart(8)} ${'p95'.padStart(8)} `
  + `${'worst'.padStart(8)}   bound`);
for (const [nm, lam] of [['shipped (gap)', lamGap], ['direct (gen)', lamGen]]) {
  const pct = units.map((u) => (Math.exp((-shrink * lam * u.P) / 2) - 1) * 100);
  const band = Math.max(Math.abs(q(pct, 0.05)), Math.abs(q(pct, 0.95)));
  const worst = Math.max(...pct.map(Math.abs));
  const pass = band < 25 && worst < 41;
  console.log(`  ${nm.padEnd(16)} ${q(pct, 0.05).toFixed(1).padStart(8)} ${med(pct).toFixed(1).padStart(8)} `
    + `${q(pct, 0.95).toFixed(1).padStart(8)} ${worst.toFixed(1).padStart(8)}   ${pass ? 'PASS' : '**FAIL**'}`);
}

/* ---- the check that decided 11.37, repeated, and it does NOT use the bound ---- */
console.log('\n  GENERATION-PLAUSIBILITY CHECK (independent of the external bound)\n');
const pAbs = units.map((u) => Math.abs(u.P));
const p99 = q(pAbs, 0.99);
console.log(`  a film at the 99th percentile of |P| (${p99.toFixed(2)} sd), after shrinkage, sits`);
console.log(`    ${((p99 * shrink) / dPdGen).toFixed(1)} generations from a typical file.`);
console.log('  A real library spans maybe 0-4 generations from master. Shrinkage is unchanged by this');
console.log('  correction, so this number is the same either way — lambda scales the OUTPUT, not the');
console.log('  implied provenance. That is why the correction is admissible where 11.37\'s was not.');
console.log('');
