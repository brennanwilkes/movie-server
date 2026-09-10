/* WHAT IS P'S PER-FILM RELIABILITY, ACTUALLY? — measured directly, no model, no Spearman-Brown.
 *
 * WHY THIS EXISTS. The project's own documentation states that the per-film ordering is dominated by
 * scene-sampling noise, and quotes 0.106 as the evidence. That number is REAL but it is NOT P'S
 * RELIABILITY. It came from a split-half taken across DISJOINT DETECTOR PAIRS on disjoint clips —
 * i.e. {cambi, block} on one set of clips against {blur, grain} on another. That statistic asks
 * "do the four detectors share a common factor?", which is a question about whether P measures ONE
 * THING. It is not the question "do two reads of the same file agree?", which is what governs
 * whether the movers table is actionable.
 *
 * The two have been conflated, and the conflation makes the blocker look worse than it is. A
 * variance model fitted to the same data predicts reliability ~0.65 at 4 clips, and an earlier
 * direct check reported corr(P) = 0.693 between two 4-clip reads. Those agree with each other and
 * disagree with 0.106 by a factor of six.
 *
 * THIS SCRIPT SETTLES IT WITH NO MODELLING AT ALL. Take the films with 12 clean clips. Split the
 * clips into two DISJOINT halves. Compute the FULL FOUR-DETECTOR P on each half, exactly as the
 * shipped pipeline does — library-fitted surface, shipped z scaling, pre-registered direction,
 * library standardisation. Correlate the two halves across films. That correlation IS the
 * reliability of a 6-clip P. Spearman-Brown down to 4 and up to 12 for the shipped and extended
 * cases.
 *
 * ALL 462 DISTINCT 6/6 SPLITS ARE AVERAGED. A single split is a coin flip — the probe-vs-backfill
 * work found split-half values ranging 0.328 to 0.679 across splits of the same data — so quoting
 * one would be quoting noise.
 *
 * *** WHAT EACH OUTCOME MEANS, WRITTEN BEFORE RUNNING. ***
 *   near 0.65    the documentation is WRONG and the blocker is much smaller than recorded. P is
 *                about as reliable per film as block (0.836) is per clip — not great, but usable,
 *                and the movers table's problem becomes VALIDITY rather than precision.
 *   near 0.10    the model and the earlier corr(P)=0.693 are both wrong, and the ordering really is
 *                noise. The blocker stands as documented.
 * Either way one of two well-established numbers in this project has to give, and that is worth
 * knowing regardless of which.
 *
 * READ-ONLY. Uses data/clip-reliability.json and the shipped bpp-lab/public/provenance.json.
 * USAGE: node scripts/P-reliability-direct.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = { cambi: 1, block: 1, blur: 1, grain: -1 };
const K = 12;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const rank = (a) => { const s = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length);
  s.forEach(([, i], k) => { r[i] = k; }); return r; };
function spearman(a, b) {
  const ra = rank(a); const rb = rank(b); const n = a.length;
  const ma = mean(ra); const mb = mean(rb);
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i += 1) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
function pearson(a, b) {
  const ma = mean(a); const mb = mean(b);
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i += 1) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
/* Spearman-Brown from a half-length reliability r to k times that half length */
const sb = (r, k) => (k * r) / (1 + (k - 1) * r);
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

/* ---- the shipped surface, fitted on the full library exactly as export-provenance.js does ---- */
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
const X = lib.map((u) => design(u.bpp, u.cxEff, u.codec));
const BETA = {}; const RSD = {};
for (const d of DET) {
  const y = lib.map((u) => Math.log(u[d]));
  BETA[d] = ols(X, y);
  RSD[d] = sd(y.map((v, i) => v - X[i].reduce((s, z, j) => s + z * BETA[d][j], 0)));
}
/* P for a set of per-clip readings, at the film's own surface row — the shipped construction */
const Pof = (clips, u) => {
  const row = design(u.bpp, u.cxEff, u.codec);
  return DET.reduce((s, d) => {
    const lv = mean(clips.map((c) => Math.log(c[d])));
    const fit = row.reduce((t, z, j) => t + z * BETA[d][j], 0);
    return s + EXPECT[d] * ((lv - fit) / RSD[d]);
  }, 0);
};

const data = JSON.parse(fs.readFileSync('data/clip-reliability.json', 'utf8'));
const units = Object.values(data.units).filter((u) => Array.isArray(u.clips) && u.clips.length >= K
  && u.bpp > 0 && u.cxEff > 0 && u.clips.slice(0, K).every((c) => DET.every((d) => c[d] > 0)));
console.log(`\n  ${units.length} films x ${K} clips. Full four-detector P, shipped construction.\n`);
if (units.length < 20) { console.log('  too few\n'); process.exit(0); }

/* every distinct 6/6 split */
const idx = [...Array(K).keys()];
const combos = [];
const rec = (start, cur) => {
  if (cur.length === K / 2) { if (cur[0] === 0) combos.push(cur.slice()); return; }
  for (let i = start; i < K; i += 1) { cur.push(i); rec(i + 1, cur); cur.pop(); }
};
rec(0, []);

const rsP = []; const rsS = [];
for (const on of combos) {
  const off = idx.filter((i) => !on.includes(i));
  const A = units.map((u) => Pof(on.map((i) => u.clips[i]), u));
  const B = units.map((u) => Pof(off.map((i) => u.clips[i]), u));
  rsP.push(pearson(A, B)); rsS.push(spearman(A, B));
}
rsP.sort((a, b) => a - b); rsS.sort((a, b) => a - b);
const half = mean(rsP);
console.log(`  SPLIT-HALF OF THE FULL P, over all ${combos.length} distinct 6/6 clip splits\n`);
console.log(`    Pearson    mean ${half.toFixed(3)}   median ${rsP[rsP.length >> 1].toFixed(3)}   `
  + `range ${rsP[0].toFixed(3)} to ${rsP[rsP.length - 1].toFixed(3)}`);
console.log(`    Spearman   mean ${mean(rsS).toFixed(3)}   median ${rsS[rsS.length >> 1].toFixed(3)}`);
console.log(`\n    *** RELIABILITY OF A 6-CLIP P   ${half.toFixed(3)} ***  (this IS the split-half)`);
console.log(`        reliability of a 12-clip P  ${sb(half, 2).toFixed(3)}   (Spearman-Brown up)`);
/* down to the shipped 4 clips: solve SB backwards from the 6-clip value */
const r1 = half / (6 - 5 * half);          /* single-clip reliability implied */
const rel = (k) => (k * r1) / (1 + (k - 1) * r1);
console.log(`        reliability of a  4-clip P  ${rel(4).toFixed(3)}   <- THE SHIPPED SAMPLING`);
console.log(`        implied single-clip         ${r1.toFixed(3)}`);

console.log(`\n  AGAINST WHAT THE DOCUMENTATION SAYS\n`);
console.log(`    documented "0.106"   — split-half across DISJOINT DETECTOR PAIRS on disjoint clips.`);
console.log(`                           Asks whether the four detectors share a common factor.`);
console.log(`    measured here        — split-half of the FULL P on disjoint clips.`);
console.log(`                           Asks whether two reads of the same file agree.`);
console.log(`    earlier direct check — corr(P) = 0.693 between two 4-clip reads.`);
console.log(`\n  VERDICT\n`);
if (rel(4) > 0.45) {
  console.log(`    THE DOCUMENTED BLOCKER IS OVERSTATED. A 4-clip P reproduces itself at ${rel(4).toFixed(2)},`);
  console.log('    consistent with the earlier corr(P) = 0.693 and with the variance model, and NOT');
  console.log('    with 0.106. The two statistics measure different things and have been conflated.');
  console.log('    WHAT ACTUALLY REMAINS WRONG is not precision but VALIDITY: the four detectors do');
  console.log('    not strongly share a common factor once clips are disjoint (that is what 0.106');
  console.log('    measures), so P is reproducible while it is unclear it measures ONE thing.');
  console.log('    Those need different fixes, and the project has been attacking the wrong one.');
} else {
  console.log(`    THE DOCUMENTED BLOCKER STANDS. A 4-clip P reproduces itself at only ${rel(4).toFixed(2)}, so`);
  console.log('    the movers table is not actionable and the earlier corr(P) = 0.693 needs explaining.');
}
console.log('');
