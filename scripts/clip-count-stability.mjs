/* HOW WRONG IS A 4-CLIP SCENE-FRACTION? — measured, not argued from the rule of three.
 *
 * WHY THIS IS SAFE TO RUN ON PARTIAL DATA, when the gradient is not. visibility-60clip.js walks the
 * BPP+ bands IN ORDER, so a partial run holds only the low bands and any cross-film gradient read
 * from it would be biased. This analysis is entirely WITHIN film: it subsamples each film's own 60
 * clips down to 4, 8, 12, 24 and asks how far the answer moves. Band composition cannot affect that.
 *
 * WHAT IT IS FOR. The case for re-measuring the library at more clips currently rests on the RULE OF
 * THREE — zero exceedances in n clips bounds the true rate below only 3/n, so 4 clips bounds it at
 * 75%. That is a correct but WORST-CASE bound, and worst-case bounds are easy to wave away ("surely
 * it is not that bad in practice"). This replaces the bound with the actual distribution: given a
 * film whose 60-clip fraction we now know, how far off is the 4-clip answer, typically and at worst?
 * That is the number that justifies — or does not justify — a very expensive re-measure.
 *
 * TWO STATISTICS, because they answer different questions:
 *   ABSOLUTE ERROR   how far the estimated scene fraction lands from the 60-clip value. Governs
 *                    whether a per-film number can be quoted at all.
 *   DECISION FLIPS   how often a 4-clip sample puts a film on the wrong side of a threshold it is
 *                    actually on the other side of. Governs whether the SORT is trustworthy, which
 *                    is what the audit tab actually uses. A large absolute error that never flips a
 *                    decision is harmless; a small one that flips often is not.
 *
 * The 60-clip value is treated as truth. It is not — it has its own error of about +-6% at p=0.5 —
 * but it is 15x better sampled, and using it as the reference understates the 4-clip error rather
 * than overstating it, so the conclusion is conservative in the right direction.
 *
 * READ-ONLY. Uses data/visibility-60clip.json, whatever it holds so far.
 * USAGE: node scripts/clip-count-stability.mjs
 */
import fs from 'fs';

const THRESH = { cambi: 2.817, block: 3.710, blur: 8.026, grain: 0.905 };
const DIR = { cambi: +1, block: +1, blur: +1, grain: -1 };   /* grain: damage is BELOW threshold */
const DET = ['cambi', 'block', 'blur', 'grain'];
const NDRAW = 400;
const over = (d, v) => (DIR[d] > 0 ? v > THRESH[d] : v < THRESH[d]);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const q = (a, f) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))]; };

let raw;
try { raw = JSON.parse(fs.readFileSync('data/visibility-60clip.json', 'utf8')); } catch {
  console.log('\n  data/visibility-60clip.json not written yet\n'); process.exit(0);
}
const units = Object.values(raw.units).filter((u) => Array.isArray(u.clips) && u.clips.length >= 50);
console.log(`\n  ${units.length} films with 50+ clean clips (run still in progress; this analysis is`);
console.log(`  WITHIN-film so partial band coverage does not bias it)\n`);
if (units.length < 5) { console.log('  need 5+ films\n'); process.exit(0); }

let rng = 987;
const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };

for (const d of DET) {
  const truth = units.map((u) => {
    const v = u.clips.map((c) => c[d]).filter((x) => Number.isFinite(x) && x > 0);
    return v.filter((x) => over(d, x)).length / v.length;
  });
  console.log(`  ${d.toUpperCase()}   60-clip fraction: median ${(100 * med(truth)).toFixed(0)}%   `
    + `range ${(100 * Math.min(...truth)).toFixed(0)}-${(100 * Math.max(...truth)).toFixed(0)}%`);
  console.log(`    ${'k'.padStart(4)}  ${'median |err|'.padStart(12)}  ${'p90 |err|'.padStart(10)}  `
    + `${'flip @5%'.padStart(9)}  ${'flip @25%'.padStart(10)}`);
  for (const k of [4, 8, 12, 24]) {
    const errs = []; let f5 = 0; let f25 = 0; let n = 0;
    units.forEach((u, ui) => {
      const v = u.clips.map((c) => c[d]).filter((x) => Number.isFinite(x) && x > 0);
      if (v.length < k) return;
      for (let t = 0; t < NDRAW; t += 1) {
        /* draw k clips without replacement */
        const pick = [];
        const pool = v.slice();
        for (let i = 0; i < k; i += 1) pick.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
        const est = pick.filter((x) => over(d, x)).length / k;
        errs.push(Math.abs(est - truth[ui]));
        if ((est <= 0.05) !== (truth[ui] <= 0.05)) f5 += 1;
        if ((est <= 0.25) !== (truth[ui] <= 0.25)) f25 += 1;
        n += 1;
      }
    });
    if (!n) continue;
    console.log(`    ${String(k).padStart(4)}  ${(100 * med(errs)).toFixed(1).padStart(11)}%  `
      + `${(100 * q(errs, 0.9)).toFixed(1).padStart(9)}%  ${(100 * f5 / n).toFixed(1).padStart(8)}%  `
      + `${(100 * f25 / n).toFixed(1).padStart(9)}%`);
  }
  console.log('');
}
console.log('  READ THE FLIP COLUMNS, NOT THE ERROR COLUMNS. A film is on the wrong side of the');
console.log('  criterion that often, at that clip count. The absolute error governs whether a number');
console.log('  can be quoted; the flip rate governs whether the SORT can be trusted, and the sort is');
console.log('  what the audit tab actually uses.');
console.log('\n  The 60-clip value is treated as truth. It is not — it carries about +-6% of its own at');
console.log('  p=0.5 — but it is 15x better sampled, so this UNDERSTATES the 4-clip error.');
console.log('');
