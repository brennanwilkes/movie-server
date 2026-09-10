/* THE PAYOFF CURVE: RELIABILITY AGAINST CLIP COUNT — analysis for scripts/clip-reliability.js.
 *
 * THE MEASUREMENT. Every unit was read at 12 independent 2-second positions and EVERY clip was kept.
 * Splitting those 12 into two disjoint groups of k gives two independent k-clip estimates of the same
 * unit, so correlating them across units IS the reliability of a k-clip measurement — measured, not
 * modelled. Sweeping k traces the whole payoff curve from one run.
 *
 * WHY IT MATTERS. 11.41 found cambi's per-read noise is sd(log) = 1.68, so the 4-clip mean the library
 * was built on carries SE 0.84 against a residual spread of ~1.3. If that is right, extra clips are
 * the only lever that makes the EXISTING signal bigger instead of reinterpreting it — and the curve
 * says how many are worth buying before the ~46-hour full re-measure is committed to.
 *
 * WHAT WOULD FALSIFY IT: reliability already flat by k=4. Then extra clips buy nothing, the residual
 * spread is not sampling-noise-dominated, and the modest effect sizes have some other cause. That
 * outcome is more useful than confirmation and must be reported as loudly.
 *
 * TWO ESTIMATOR DETAILS THAT MATTER:
 *   - MANY SPLITS, NOT ONE. A single arbitrary split of 12 clips into two groups of k is itself
 *     noisy. Every reported value is the median over many random disjoint splits, so the curve is
 *     about clip count rather than about which split was drawn.
 *   - CORRELATE IN LOGS. 11.41 established the noise is multiplicative, so log is the
 *     variance-stabilising transform. Correlating raw values would let a few huge-banding units set
 *     the whole correlation.
 *
 * SPEARMAN-BROWN IS USED ONLY TO PROJECT, NEVER TO REPLACE A MEASURED POINT. The measured curve runs
 * to k=6 (half of 12); 12 and 26 are projections and are labelled as such.
 *
 * USAGE: node scripts/clip-reliability-analyse.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const corr = (a, b) => {
  const ma = mean(a); const mb = mean(b);
  let n = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i += 1) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
};
/* Seeded, so the curve is reproducible and cannot be re-rolled until it looks better. */
let seed = 20260827;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

const data = JSON.parse(fs.readFileSync('data/clip-reliability.json', 'utf8')).units;
const units = Object.entries(data).map(([key, u]) => ({ key, ...u }));
const nClips = Math.min(...units.map((u) => u.clips.length));
console.log(`\n  ${units.length} units, at least ${nClips} clips each\n`);
if (units.length < 20) {
  console.log('  Fewer than 20 units — the correlations would be too noisy to read. Wait for more.\n');
  process.exit(0);
}

const SPLITS = 60;
const KMAX = Math.floor(nClips / 2);
console.log('  RELIABILITY OF A k-CLIP MEAN — median over 60 random disjoint splits, correlated in logs\n');
console.log(`  ${'k'.padStart(3)} ${DET.map((d) => d.padStart(9)).join(' ')}   <- reliability of ONE k-clip reading`);
const curve = {};
for (const d of DET) curve[d] = {};
for (let k = 1; k <= KMAX; k += 1) {
  const row = [];
  for (const d of DET) {
    const rs = [];
    for (let s = 0; s < SPLITS; s += 1) {
      const A = []; const B = [];
      for (const u of units) {
        const idx = shuffle(u.clips.map((_, i) => i));
        const va = idx.slice(0, k).map((i) => u.clips[i][d]).filter((x) => x > 0);
        const vb = idx.slice(k, 2 * k).map((i) => u.clips[i][d]).filter((x) => x > 0);
        if (va.length < k || vb.length < k) continue;
        A.push(Math.log(mean(va))); B.push(Math.log(mean(vb)));
      }
      if (A.length >= 20) rs.push(corr(A, B));
    }
    const r = rs.length ? med(rs) : NaN;
    curve[d][k] = r;
    row.push((Number.isFinite(r) ? r.toFixed(3) : '—').padStart(9));
  }
  console.log(`  ${String(k).padStart(3)} ${row.join(' ')}`);
}

/* Spearman-Brown from the best-measured point, to project beyond what was measured. */
console.log('\n  PROJECTED with Spearman-Brown from the k=' + KMAX + ' measurement (projections, not measurements)\n');
console.log(`  ${'clips'.padStart(6)} ${DET.map((d) => d.padStart(9)).join(' ')}`);
const sb = (r, m) => (m * r) / (1 + (m - 1) * r);
for (const target of [4, 8, 12, 16, 26, 40]) {
  const row = DET.map((d) => {
    const r0 = curve[d][KMAX];
    if (!Number.isFinite(r0) || r0 <= 0) return '—'.padStart(9);
    return sb(r0, target / KMAX).toFixed(3).padStart(9);
  });
  console.log(`  ${String(target).padStart(6)} ${row.join(' ')}${target === 4 ? '   <- what the library has now' : ''}`);
}

/* The decision. What does buying clips actually deliver? */
console.log('\n  WHAT MORE CLIPS WOULD BUY\n');
for (const d of DET) {
  const r0 = curve[d][KMAX];
  if (!Number.isFinite(r0) || r0 <= 0) { console.log(`  ${d.padEnd(8)} unusable`); continue; }
  const at4 = sb(r0, 4 / KMAX); const at12 = sb(r0, 12 / KMAX); const at26 = sb(r0, 26 / KMAX);
  /* Reliability is the signal fraction, so noise variance falls as (1-rel). The provenance fraction
   * has TOTAL variance in its denominator, so it scales as the ratio of signal fractions. */
  console.log(`  ${d.padEnd(8)} reliability 4 clips ${at4.toFixed(3)} -> 12 clips ${at12.toFixed(3)} `
    + `-> 26 clips ${at26.toFixed(3)}   provenance fraction would scale x${(at12 / at4).toFixed(2)} / x${(at26 / at4).toFixed(2)}`);
}

const c4 = sb(curve.cambi[KMAX], 4 / KMAX);
const c12 = sb(curve.cambi[KMAX], 12 / KMAX);
console.log('\n  VERDICT\n');
if (!Number.isFinite(c4)) {
  console.log('  cambi reliability unmeasurable at this n.');
} else if (c4 > 0.85) {
  console.log(`  FALSIFIED: cambi is already ${c4.toFixed(2)} reliable at 4 clips. Extra clips buy almost`);
  console.log('  nothing, the residual spread is NOT sampling-noise-dominated, and 11.41\'s explanation');
  console.log('  for the small effect sizes is wrong. Find the real cause before measuring anything.');
} else if (c12 - c4 > 0.1) {
  console.log(`  CONFIRMED: cambi reliability goes ${c4.toFixed(2)} at 4 clips to ${c12.toFixed(2)} at 12.`);
  console.log('  Sampling noise is a real and fixable limit. The full re-measure is worth its hours —');
  console.log('  but check the curve above for where it flattens before choosing the clip count.');
} else {
  console.log(`  MARGINAL: 4 clips ${c4.toFixed(2)} -> 12 clips ${c12.toFixed(2)}. Extra sampling helps less`);
  console.log('  than 11.41 predicted. Report the honest number and do not spend 46 hours on it.');
}
console.log('');
