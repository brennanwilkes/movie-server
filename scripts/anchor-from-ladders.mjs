/* CAN THE ANCHOR BE MEASURED INSTEAD OF BELIEVED? — the last free constant in the shipped rule.
 *
 * WHERE THE ANCHOR SITS. The Blend tab's provenance rule is
 *     lambda = ln(1 + anchor%) / gap        adj = BPP+ * exp(-strength * rel * lambda * P / 2)
 * gap and reliability are measured. anchor% is an EXTERNAL BELIEF about how much bitrate efficiency a
 * streaming generation costs, defaulting to 15% from published BD-rate. It is the only thing in the
 * construction that is not measured on our own files, so measuring it is the highest-value analysis
 * left — and it needs no new encoding, only the 101 ladders already on disk.
 *
 * THE IDEA. On a ladder, bits are swept over 8.3x on ONE film with the encoder fixed. P responds to
 * that sweep. The slope dP/d(log bpp) is therefore an exchange rate between P units and bitrate,
 * measured on our own content and our own detectors:
 *     anchor% implied  =  exp( gap / slope ) - 1
 *
 * THE HONEST WARNING, STATED UP FRONT. This IS a division by a slope, which is the operation that
 * killed constructions one through six (11.21). The difference — and whether it is enough is exactly
 * what this script tests — is that P is a COMPOSITE dominated by cambi, whose bitrate slope is 0.585,
 * not blocking's 0.103. A slope five times steeper is amplified five times less. So the test is not
 * "does dividing work" but "is THIS slope steep enough and tight enough to divide by".
 *
 * PRE-REGISTERED, before running:
 *   implied anchor lands in 5-40%   -> CONSISTENT with published BD-rate; the belief is corroborated
 *                                      by our own data and can be quoted as measured-and-external
 *   implied anchor 40-100%          -> larger than literature; report both, keep the slider, do NOT
 *                                      silently adopt the bigger number
 *   implied anchor > 100% or slope  -> the same 1/S failure as 11.21, one level up. The anchor stays
 *     scatter swamping the median      a belief and this route is closed. Say so plainly.
 *
 * A SECOND, INDEPENDENT ESTIMATE is computed from the generation experiment, which varies generations
 * directly at matched final bitrate. If the two disagree wildly, neither should be trusted.
 *
 * USAGE: node scripts/anchor-from-ladders.mjs
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
  if (pts.length < 4) return null;
  const mx = mean(pts.map((p) => p[0])); const my = mean(pts.map((p) => p[1]));
  let n = 0; let d = 0;
  for (const [x, y] of pts) { n += (x - mx) * (y - my); d += (x - mx) ** 2; }
  if (!(d > 0)) return null;
  const s = n / d;
  const ss = pts.reduce((acc, [x, y]) => acc + (y - (my + s * (x - mx))) ** 2, 0);
  const tot = pts.reduce((acc, [, y]) => acc + (y - my) ** 2, 0);
  return { slope: s, r2: tot > 0 ? 1 - ss / tot : 0, n: pts.length };
}

/* ---- the exact linear map that builds P, recovered from the library ---- */
/* P is sum_d EXPECT[d] * (residual_d / sd_d), then standardised by the sd of that sum. To read P on a
 * LADDER we need the same per-detector scales, because a ladder rung has no residual of its own —
 * bits and content are being swept on purpose. So: recover sd_d and sdSum from the library, then
 * apply them to ladder log-changes. */
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
const sumP = rows.map((_, i) => DET.reduce((s, d) => s + EXPECT[d] * Zc[d][i], 0));
const SDSUM = sd(sumP);
console.log(`\n  library scales, n=${rows.length}`);
console.log(`  ${'detector'.padEnd(9)} ${'residual sd'.padStart(12)}`);
DET.forEach((d) => console.log(`  ${d.padEnd(9)} ${SD[d].toFixed(4).padStart(12)}`));
console.log(`  sd of the unstandardised sum = ${SDSUM.toFixed(4)}   (P = sum / this)`);

/* Read the P-direction score on an arbitrary set of measurements, in library P units. */
const pOf = (m) => DET.reduce((s, d) => s + (m[d] > 0 ? (EXPECT[d] * Math.log(m[d])) / SD[d] : 0), 0) / SDSUM;

/* ---- ESTIMATE 1: the bitrate ladders ---- */
const lad = JSON.parse(fs.readFileSync('bpp-lab/public/ladders.json', 'utf8')).films;
const slopes = [];
for (const f of lad) {
  const pts = (f.points || []).filter((p) => p.level > 0 && DET.every((d) => p[d] > 0));
  if (pts.length < 4) continue;
  const g = fit(pts.map((p) => Math.log(p.level)), pts.map((p) => pOf(p)));
  if (g && Number.isFinite(g.slope)) slopes.push({ key: f.key, title: f.title, ...g });
}
console.log(`\n  ESTIMATE 1 — dP/d(log bpp) from ${slopes.length} bitrate ladders\n`);
const sv = slopes.map((s) => s.slope);
console.log(`  slope   p10 ${q(sv, 0.1).toFixed(3)}   median ${med(sv).toFixed(3)}   p90 ${q(sv, 0.9).toFixed(3)}`);
console.log(`  sign agreement (slope < 0, i.e. fewer bits -> worse P): `
  + `${sv.filter((s) => s < 0).length}/${sv.length}`);
console.log(`  median r2 of the per-film fit: ${med(slopes.map((s) => s.r2)).toFixed(3)}`);
console.log(`  scatter/median = ${(sd(sv) / Math.abs(med(sv))).toFixed(2)}   `
  + `(11.21 died at this ratio being large; below ~0.5 the division is survivable)`);

const P = JSON.parse(fs.readFileSync('bpp-lab/public/provenance.json', 'utf8'));
const gap = P.anchor.gap;
const slopeMed = med(sv);
const impliedLnBits = gap / Math.abs(slopeMed);
const impliedPct = (Math.exp(impliedLnBits) - 1) * 100;
console.log(`\n  measured gap WEB-Bluray = ${gap.toFixed(3)} P units`);
console.log(`  implied bitrate equivalence = exp(${gap.toFixed(3)} / ${Math.abs(slopeMed).toFixed(3)}) `
  + `= ${Math.exp(impliedLnBits).toFixed(3)}x  ->  anchor ${impliedPct.toFixed(1)}%`);

/* Propagate the slope uncertainty honestly — a ratio's error bar is what 11.21 never checked against
 * an external bound. Use the p10/p90 of the slope distribution as a plain interval rather than a
 * parametric SE, because the slope distribution is not symmetric. */
const loPct = (Math.exp(gap / Math.abs(q(sv, 0.9))) - 1) * 100;
const hiPct = (Math.exp(gap / Math.abs(q(sv, 0.1))) - 1) * 100;
console.log(`  across the p10-p90 spread of film slopes: ${Math.min(loPct, hiPct).toFixed(1)}% .. ${Math.max(loPct, hiPct).toFixed(1)}%`);

/* ---- ESTIMATE 2: the generation experiment, independent ---- */
console.log('\n  ESTIMATE 2 — the generation experiment (generations varied at matched final bitrate)\n');
try {
  const gen = JSON.parse(fs.readFileSync('data/generation-test.json', 'utf8')).films;
  const deltas = [];
  for (const f of gen) {
    const rowsG = (f.rows || []).filter((r) => DET.every((d) => r[d] > 0));
    if (rowsG.length < 2) continue;
    const byGen = rowsG.slice().sort((a, b) => (a.gen ?? a.rank ?? 0) - (b.gen ?? b.rank ?? 0));
    const first = byGen[0]; const last = byGen[byGen.length - 1];
    const nStep = (last.gen ?? last.rank ?? byGen.length) - (first.gen ?? first.rank ?? 1);
    if (!(nStep > 0)) continue;
    deltas.push({ title: f.title, perGen: (pOf(last) - pOf(first)) / nStep });
  }
  if (deltas.length >= 5) {
    const dv = deltas.map((d) => d.perGen);
    console.log(`  ${deltas.length} films   dP per generation: median ${med(dv).toFixed(3)}  `
      + `p10 ${q(dv, 0.1).toFixed(3)}  p90 ${q(dv, 0.9).toFixed(3)}`);
    console.log(`  sign agreement (a further generation makes P worse): ${dv.filter((v) => v > 0).length}/${dv.length}`);
    const genPct = (Math.exp(med(dv) / Math.abs(slopeMed)) - 1) * 100;
    console.log(`\n  ONE GENERATION is worth ${genPct.toFixed(1)}% bitrate on this scale.`);
    console.log(`  The WEB-vs-Bluray gap of ${gap.toFixed(3)} P units is `
      + `${(gap / med(dv)).toFixed(2)} generations' worth.`);
    console.log('  That second number is the useful cross-check: a streaming delivery being roughly');
    console.log('  one generation from a disc is the premise the whole contrast rests on, so a value');
    console.log('  near 1 corroborates it and a value near 5 would mean the groups differ by more');
    console.log('  than generations and the anchor is measuring something else.');
  } else {
    console.log(`  only ${deltas.length} usable films — generation-test.json lacks four-detector coverage`);
  }
} catch (e) {
  console.log(`  unavailable (${e.message})`);
}

console.log('\n  VERDICT AGAINST THE PRE-REGISTRATION');
const ratio = sd(sv) / Math.abs(slopeMed);
if (!(Math.abs(slopeMed) > 0) || ratio > 1) {
  console.log('  CLOSED — the slope is too noisy to divide by. The anchor stays a belief (11.21 again).');
} else if (impliedPct >= 5 && impliedPct <= 40) {
  console.log(`  CONSISTENT — ${impliedPct.toFixed(1)}% lands inside the 5-40% published BD-rate range.`);
  console.log('  Our own data and the literature agree, from completely different evidence. The anchor');
  console.log('  default can be quoted as corroborated rather than assumed.');
} else if (impliedPct <= 100) {
  console.log(`  LARGER THAN LITERATURE — ${impliedPct.toFixed(1)}% against a published 5-40%. Report both,`);
  console.log('  keep the slider, do NOT silently adopt the bigger number.');
} else {
  console.log(`  THE 1/S FAILURE AGAIN, one level up — ${impliedPct.toFixed(0)}% is not credible.`);
  console.log('  The anchor stays a belief and this route is closed. Record it and move on.');
}
console.log('');
