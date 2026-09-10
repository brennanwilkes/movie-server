/* MUTUAL VALIDATION ON DISJOINT DETECTORS — does P agree with a measurement built from other data?
 *
 * TWO INDEPENDENT FIELD MEASUREMENTS OF THE SAME THING EXIST, and until now they have never been
 * compared:
 *   P    from the LIBRARY. The delivered file's four artifacts, residualised against bits, content
 *        and codec, summed in the re-encode direction. Uses only what the file already is.
 *   eq   from the LADDERS. blocking(our x264-medium re-encode at the file's own bitrate) divided by
 *        blocking(the delivered file). 11.20's reading: a GOOD original has little blocking so our
 *        re-encode adds a lot -> HIGH eq; a BAD original is already blocky so there is little left to
 *        degrade -> LOW eq.
 * Different data, different construction. If they agree, each corroborates the other in a way neither
 * can do alone.
 *
 * THE TRAP THAT MAKES THE NAIVE VERSION WORTHLESS, and it has already cost this project one headline
 * number (11.19). eq's DENOMINATOR is the delivered file's blocking. P's third term is the delivered
 * file's blocking. Correlating them would be partly correlating a quantity with its own reciprocal —
 * the correlation would be forced arithmetically and would prove nothing. 11.19's -0.697 was exactly
 * this, and it decayed to -0.188 once the shared term was removed.
 *
 * THE FIX: DISJOINT DETECTORS. Build P from {cambi, blur, grain} only and take eq from {blocking}
 * only. No reading appears on both sides. Any agreement then has to come from the films themselves.
 *
 * AND CONTROL eq FOR WHAT IT IS KNOWN TO CARRY. 11.20's correction measured corr(eq, log bpp) = -0.536
 * and corr(eq, complexity) = -0.407 — at low bitrate our re-encode adds proportionally more blocking,
 * so part of eq is just "this film has few bits", which BPP+ already knows. P is orthogonal to both by
 * construction, so leaving eq uncontrolled would only attenuate the result, not fake it — but it is
 * controlled anyway so the number means what it says.
 *
 * PRE-REGISTERED DIRECTION: high eq means a good original, and high P means a damaged one, so
 *     corr(P_noblock, eq_residual) should be NEGATIVE.
 * A positive correlation would mean one of the two measurements has its sign backwards, which would
 * be a serious finding about whichever it is.
 *
 * USAGE: node scripts/factor-vs-eq.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = { cambi: +1, block: +1, blur: +1, grain: -1 };
const SUBSET = ['cambi', 'blur', 'grain'];        // deliberately excludes blocking — see above

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const corr = (a, b) => {
  const ma = mean(a); const mb = mean(b);
  let n = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i += 1) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
};
const rankOf = (v) => { const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(v.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
const spearman = (a, b) => corr(rankOf(a), rankOf(b));
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

/* ---------- P, rebuilt here so the detector subset can be varied ---------- */
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
const Z = {};
for (const d of DET) {
  const y = rows.map((u) => Math.log(u[d]));
  const be = ols(X, y);
  const r = y.map((v, i) => v - X[i].reduce((s, z, j) => s + z * be[j], 0));
  Z[d] = r.map((v) => v / sd(r));
}
const buildP = (dets) => {
  const raw = rows.map((_, i) => dets.reduce((s, d) => s + EXPECT[d] * Z[d][i], 0));
  const m = mean(raw); const s = sd(raw);
  return raw.map((v) => (v - m) / s);
};
const byKey = new Map(rows.map((u, i) => [u.key, i]));

/* ---------- eq, from the ladders ---------- */
/* The lossless rung is the file AS THE RELEASE GROUP MADE IT; the level-1.0 rung is OUR x264 medium
 * re-encode at that same bitrate. Both are measured on the same clips of the same film, so the
 * bitrate DIFFERENCE between the two files is absent by construction — which is not the same as eq
 * being free of bitrate, as 11.20's correction records. */
/* Read the RAW ladder runs, not bpp-lab/public/ladders.json. The exported file keeps only the fitted
 * slopes and the banding level at the lossless rung, dropping that rung's per-detector readings — so
 * the blocking eq cannot be rebuilt from it at all. The raw runs carry a full lossless row. */
const LADDER_FILES = ['artifact-ladder-grain.json', 'artifact-ladder-v1.json', 'artifact-ladder-wideA.json',
  'artifact-ladder-grain2.json', 'artifact-ladder-blindspot.json', 'artifact-ladder-underscored.json',
  'artifact-ladder-flagged.json'];
const lad = [];
const ladSeen = new Set();
for (const fn of LADDER_FILES) {
  let d; try { d = JSON.parse(fs.readFileSync(`data/${fn}`, 'utf8')); } catch { continue; }
  for (const f of d.films || []) { if (!ladSeen.has(f.key)) { lad.push(f); ladSeen.add(f.key); } }
}
const pairs = [];
for (const f of lad) {
  const one = (f.points || []).find((p) => Math.abs((p.level ?? 0) - 1) < 1e-6);
  const loss = (f.points || []).find((p) => p.lossless);
  const i = byKey.get(f.key);
  if (i === undefined || !one || !loss) continue;
  if (!(one.block > 0) || !(loss.block > 0)) continue;
  pairs.push({ key: f.key, title: f.title, i, eq: one.block / loss.block });
}
console.log(`\n  ${rows.length} library units   ${lad.length} ladder films   ${pairs.length} with a usable blocking eq pair\n`);
if (pairs.length < 30) {
  console.log('  TOO FEW PAIRS to say anything. ladders.json does not carry per-detector lossless rows');
  console.log('  for enough films; the blocking eq of 11.20 was computed from a run that did. Re-export');
  console.log('  ladders with the lossless rung included before repeating this test.\n');
  process.exit(0);
}

const lnEq = pairs.map((p) => Math.log(p.eq));
const pb = pairs.map((p) => lb[p.i]);
const pc = pairs.map((p) => lc[p.i]);
console.log('  eq AS 11.20 LEFT IT — and what it is known to carry');
console.log(`    n ${pairs.length}   median eq ${Math.exp(lnEq.slice().sort((a, b) => a - b)[lnEq.length >> 1]).toFixed(3)}`);
console.log(`    corr(eq, log bpp)  ${corr(lnEq, pb).toFixed(3)}   (11.20 measured -0.536)`);
console.log(`    corr(eq, log cx)   ${corr(lnEq, pc).toFixed(3)}   (11.20 measured -0.407)`);

/* Residualise eq against bits and content so the comparison is like for like with P. */
const Xe = pairs.map((_, i) => [1, pb[i], pb[i] ** 2, pc[i], pc[i] ** 2, pb[i] * pc[i]]);
const bee = ols(Xe, lnEq);
const eqR = lnEq.map((v, i) => v - Xe[i].reduce((s, z, j) => s + z * bee[j], 0));

console.log('\n  THE TEST — P against eq, on DISJOINT detectors\n');
console.log(`  ${'P built from'.padEnd(26)} ${'pearson'.padStart(8)} ${'spearman'.padStart(9)} ${'shares a detector?'.padStart(19)}`);
const variants = [
  ['cambi+blur+grain', SUBSET, 'no — the valid test'],
  ['all four', DET, 'YES — blocking on both sides'],
  ['blocking only', ['block'], 'YES — the 11.19 trap, shown for scale'],
];
let headline = null;
for (const [label, dets, share] of variants) {
  const Pv = buildP(dets);
  const a = pairs.map((p) => Pv[p.i]);
  const r = corr(a, eqR);
  if (label === 'cambi+blur+grain') headline = r;
  console.log(`  ${label.padEnd(26)} ${r.toFixed(3).padStart(8)} ${spearman(a, eqR).toFixed(3).padStart(9)} ${share.padStart(19)}`);
}

const se = 1 / Math.sqrt(pairs.length - 3);
console.log(`\n  SE of a correlation at n=${pairs.length} is about ${se.toFixed(3)}`);
console.log('\n  VERDICT');
if (headline < -2 * se) {
  console.log(`  AGREEMENT, in the pre-registered direction (${headline.toFixed(3)}). Two field measurements`);
  console.log('  built from different data and sharing no detector reading say the same thing about which');
  console.log('  films are well encoded. Neither could establish that alone.');
} else if (headline > 2 * se) {
  console.log(`  OPPOSITE SIGN (${headline.toFixed(3)}). One of the two has its direction backwards, and that`);
  console.log('  is a real finding — do not paper over it. Check eq\'s numerator/denominator order first.');
} else {
  console.log(`  NULL (${headline.toFixed(3)}, within ~2 SE of zero). The two measurements do not corroborate`);
  console.log('  each other. That is NOT evidence against P — eq is itself weak (11.20 was downgraded to');
  console.log('  WEAK for good reason) and 77% of its spread has unknown cause. It means this particular');
  console.log('  cross-check cannot carry weight, in either direction.');
}
console.log('');
