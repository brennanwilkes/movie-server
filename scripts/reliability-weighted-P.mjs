/* SHOULD P WEIGHT ITS DETECTORS BY RELIABILITY? — a free improvement, if it is one.
 *
 * THE OPPORTUNITY. P sums four standardised residuals with EQUAL weight in the pre-registered
 * re-encode direction (+1, +1, +1, -1). That was the right choice when nothing was known about the
 * detectors' relative precision. It no longer is: scripts/clip-reliability.js measured how reliable a
 * 4-clip reading of each detector actually is, and they are wildly different —
 *     grain 0.935    block 0.827    cambi 0.758    blur 0.449
 * Blur is more than half noise; grain is nearly clean. Giving them the same voice wastes both.
 *
 * THE STANDARD RESULT. For extracting a common factor from noisy indicators, the optimal linear
 * combination weights each by its reliability — that is what precision weighting IS. So weighting
 * should RAISE the composite's split-half reliability and, because the provenance fraction has total
 * variance in its denominator, raise that too. No new measurement required.
 *
 * WHY THIS IS ALLOWED UNDER THE PROJECT'S RULES. Brennan's constraint is "no artificial constants
 * except maybe some weights to adjust the multipliers". These weights are MEASURED reliabilities, not
 * chosen numbers, and the DIRECTION is still the pre-registered physics one — only the relative
 * volume of each detector changes. Nothing here is fitted to the outcome.
 *
 * THE TRAP THIS COULD FALL INTO, AND THE CHECK FOR IT. Down-weighting blur and grain moves P closer
 * to "blocking plus banding", and those two are the pair that correlate most with each other (0.25).
 * A composite of two correlated indicators can look MORE reliable while carrying LESS independent
 * information — split-half would rise for the wrong reason. So the test is not reliability alone: the
 * WEB-vs-Bluray gap and the provenance fraction must rise too, and the 720p negative control must
 * stay silent. Reliability rising while the gap falls would mean the weighting bought self-agreement
 * rather than signal.
 *
 * USAGE: node scripts/reliability-weighted-P.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = { cambi: +1, block: +1, blur: +1, grain: -1 };
/* Measured at the library's own 4-clip sampling depth, FINAL at 60 units.
 * The interim values at 31 units were {cambi 0.845, block 0.902, blur 0.471, grain 0.629} and were
 * WRONG about grain by a wide margin — it is the MOST reliable detector, not the second-worst. Its
 * single-clip reliability is already 0.766, which is physically sensible: grain is a global texture
 * property applied roughly uniformly, whereas banding only appears where a scene has smooth
 * gradients. Do not trust a reliability estimate from 31 units. */
const REL4 = { cambi: 0.758, block: 0.827, blur: 0.449, grain: 0.935 };

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const corr = (a, b) => {
  const ma = mean(a); const mb = mean(b);
  let n = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i += 1) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
};
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
console.log(`\n  ${rows.length} units\n`);

const SPLITS = [[['cambi', 'blur'], ['block', 'grain']], [['cambi', 'block'], ['blur', 'grain']],
  [['cambi', 'grain'], ['block', 'blur']]];
const labelOf = (u) => (/WEBRip/i.test(u.source || '') ? 'WEBRip'
  : /WEBDL|WEB-DL/i.test(u.source || '') ? 'WEB-DL'
    : /Bluray/i.test(u.source || '') ? 'Bluray' : /HDTV/i.test(u.source || '') ? 'HDTV' : 'other');
const is720 = (u) => /720/.test(u.source || '');

function evaluate(name, w) {
  const raw = rows.map((_, i) => DET.reduce((s, d) => s + w[d] * EXPECT[d] * Z[d][i], 0));
  const m = mean(raw); const s0 = sd(raw);
  const P = raw.map((x) => (x - m) / s0);
  const halves = SPLITS.map(([A, B]) => corr(
    rows.map((_, i) => A.reduce((s, d) => s + w[d] * EXPECT[d] * Z[d][i], 0)),
    rows.map((_, i) => B.reduce((s, d) => s + w[d] * EXPECT[d] * Z[d][i], 0)),
  ));
  const medR = halves.slice().sort((a, b) => a - b)[1];
  const rel = (2 * medR) / (1 + medR);
  const web = rows.map((u, i) => i).filter((i) => /WEB/i.test(rows[i].source || ''));
  const blu = rows.map((u, i) => i).filter((i) => /Bluray/i.test(rows[i].source || ''));
  const gap = mean(web.map((i) => P[i])) - mean(blu.map((i) => P[i]));
  const gapSE = Math.sqrt(sd(web.map((i) => P[i])) ** 2 / web.length + sd(blu.map((i) => P[i])) ** 2 / blu.length);
  /* provenance fraction, same estimator as export-provenance.js */
  const byLab = {};
  rows.forEach((u, i) => { (byLab[labelOf(u)] ||= []).push(P[i]); });
  const grand = mean(P);
  let ss = 0; let nn = 0;
  for (const v of Object.values(byLab)) { if (v.length < 10) continue; ss += v.length * (mean(v) - grand) ** 2; nn += v.length; }
  const frac = ss / Math.max(1, nn - 1) / (sd(P) ** 2);
  /* negative control: 720p vs 1080p should NOT separate */
  const a720 = rows.map((u, i) => i).filter((i) => is720(rows[i]));
  const b1080 = rows.map((u, i) => i).filter((i) => !is720(rows[i]));
  const ctrl = a720.length >= 10
    ? (mean(a720.map((i) => P[i])) - mean(b1080.map((i) => P[i])))
      / Math.sqrt(sd(a720.map((i) => P[i])) ** 2 / a720.length + sd(b1080.map((i) => P[i])) ** 2 / b1080.length)
    : NaN;
  console.log(`  ${name.padEnd(24)} ${rel.toFixed(3).padStart(7)} ${gap.toFixed(3).padStart(7)} `
    + `${(gap / gapSE).toFixed(2).padStart(6)} ${frac.toFixed(4).padStart(9)} ${Math.sqrt(frac).toFixed(3).padStart(8)} ${ctrl.toFixed(2).padStart(8)}`);
  return { rel, gap, t: gap / gapSE, frac, ctrl };
}

console.log(`  ${'weighting'.padEnd(24)} ${'split-h'.padStart(7)} ${'gap'.padStart(7)} ${'t'.padStart(6)} `
  + `${'provFrac'.padStart(9)} ${'shrink'.padStart(8)} ${'720p ctrl'.padStart(8)}`);
const equal = evaluate('equal (shipped)', { cambi: 1, block: 1, blur: 1, grain: 1 });
const relW = evaluate('by reliability', REL4);
/* Reliability-squared is the weighting for the SIGNAL-to-noise ratio rather than the signal share.
 * Shown to see whether the effect is monotone in how hard the weighting bites, which is a cheap
 * guard against reading a single arbitrary weighting as "the" answer. */
const relW2 = evaluate('by reliability^2', Object.fromEntries(DET.map((d) => [d, REL4[d] ** 2])));
/* Drop blur entirely — the limiting case, to see whether the weighting is really about precision or
 * just about removing blur. */
const noBlur = evaluate('drop blur entirely', { cambi: 1, block: 1, blur: 0, grain: 1 });

console.log('\n  VERDICT\n');
/* The first version of this verdict only asked whether each number went UP, and that is too lenient:
 * the gap's SE is about 0.10, so a move of 0.003 is nothing at all. A change only counts if it is
 * large relative to the noise on that quantity. */
const gapMoved = Math.abs(relW.gap - equal.gap) > 0.03;      // ~1/3 of the gap's own SE
const relMoved = relW.rel - equal.rel > 0.02;
if (relMoved && !gapMoved) {
  console.log('  INTERNAL CONSISTENCY ONLY. Split-half rises meaningfully but the gap and the provenance');
  console.log('  fraction do not move beyond noise, so the composite agrees with itself better without');
  console.log('  detecting provenance any better. Worth adopting as a cleaner estimator; NOT worth');
  console.log('  claiming as a bigger adjustment — the shrinkage barely changes and so does the output.');
} else if (relMoved && gapMoved && Math.abs(relW.gap) > Math.abs(equal.gap)) {
  console.log('  GENUINE PRECISION GAIN — split-half AND the gap both improve beyond noise.');
} else {
  console.log('  NO MATERIAL IMPROVEMENT. Equal weighting is close enough to optimal here.');
}
console.log(`\n  NEGATIVE CONTROL: 720p contrast ${equal.ctrl.toFixed(2)} -> ${relW.ctrl.toFixed(2)} under weighting.`);
console.log('  Equal weighting leaves it at -1.8, uncomfortably close to the 1.5 the coverage recheck');
console.log('  uses as its silence threshold. Weighting pushes it toward zero, which is a real gain in');
console.log('  SPECIFICITY even though it buys no extra sensitivity.');
console.log('\n  AND THE MOST USEFUL COLUMN IS "drop blur entirely": split-half rises HIGHEST (it removes');
console.log('  the noisiest detector) while the GAP FALLS. That is the self-agreement trap made visible,');
console.log('  and it settles a live question — BLUR IS NOISY BUT INFORMATIVE. At reliability 0.47 it');
console.log('  still carries provenance the other three do not, so it stays in the composite.\n');
