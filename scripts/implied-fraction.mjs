/* CAN WE KEEP BRENNAN'S "% OF SCENES" CRITERION WITHOUT BINARISING ANY SCENE?
 *
 * THE CONFLICT THIS RESOLVES, AND IT IS A REAL ONE BETWEEN TWO OF BRENNAN'S OWN RULES.
 *   THE CRITERION   "5% or less of visible artifacts is good enough" — intrinsically a COUNT of
 *                   scenes past a threshold.
 *   THE DESIGN RULE final output is a weighted NUMBER, never flags, and NO CUT-OFFS.
 * A per-scene threshold-and-count is a cut-off applied 60 times. threshold-vs-smooth.mjs measured what
 * that costs: at 4 clips the counted fraction reproduces itself at 0.44 (cambi) and 0.04 (block),
 * against 0.70 and 0.81 for a smooth mean of the same data. The cut-off is not an aesthetic problem,
 * it is throwing away most of the measurement.
 *
 * THE RESOLUTION. Do not count scenes; MODEL them. Each clip contributes a continuous log-excess
 * x = log(L/T) (sign-flipped for grain). Estimate that distribution's two moments — both of which use
 * every clip's magnitude — and read the scene fraction off the fitted distribution:
 *       impliedFrac = Phi( mean(x) / sd(x) )
 * No scene is ever thresholded, the external anchor T is retained exactly (it is where x = 0), and the
 * output is a smooth function of two well-estimated quantities. The criterion survives; the cut-off
 * does not.
 *
 * *** THE ASSUMPTION THIS RESTS ON, AND IT IS TESTED HERE RATHER THAN ASSUMED. *** Phi presumes the
 * per-clip log-excess is roughly normal within a film. If it is skewed or bimodal — and scene content
 * varies enormously within a film, so bimodal is entirely plausible — the plug-in will be biased even
 * though it is precise, which is a WORSE failure than being noisy. So this reports BOTH:
 *     BIAS       mean signed error against the film's own 60-clip counted fraction
 *     PRECISION  mean absolute error, against the 4-clip counted fraction as the incumbent
 * A method that is precise and biased must be rejected; the point of the smooth statistic is only won
 * if it is precise AND unbiased.
 *
 * THE COMPARISON IS WITHIN-FILM — each estimator is scored against THAT FILM'S 60-clip counted
 * fraction — so a band-restricted partial run does not bias it. That is the same reasoning that made
 * clip-count-stability.mjs safe to run early, and it is the only kind of reading this file permits.
 *
 * READ-ONLY. Uses data/visibility-60clip.json.
 * USAGE: node scripts/implied-fraction.mjs
 */
import fs from 'fs';

const THRESH = { cambi: 2.817, block: 3.710, blur: 8.026, grain: 0.905 };
const DIR = { cambi: +1, block: +1, blur: +1, grain: -1 };
const DET = ['cambi', 'block', 'blur', 'grain'];
const NDRAW = 400;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
/* Abramowitz-Stegun 7.1.26 erf, plenty for a probability we quote to a percent */
function Phi(z) {
  const s = z < 0 ? -1 : 1; const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + s * y);
}
const lex = (d, v) => DIR[d] * Math.log(Math.max(v, 1e-9) / THRESH[d]);
/* skewness, to say WHY the plug-in behaves as it does rather than only that it does */
const skew = (a) => { const m = mean(a); const s = sd(a); if (!(s > 0)) return 0;
  return mean(a.map((x) => ((x - m) / s) ** 3)); };

let raw;
try { raw = JSON.parse(fs.readFileSync('data/visibility-60clip.json', 'utf8')); } catch {
  console.log('\n  data/visibility-60clip.json not written yet\n'); process.exit(0);
}
const films = Object.values(raw.units).filter((u) => Array.isArray(u.clips) && u.clips.length >= 50);
console.log(`\n  ${films.length} films. Each estimator scored against THAT FILM'S OWN 60-clip counted`);
console.log('  fraction, so this is within-film and a partial band-restricted run does not bias it.\n');
if (films.length < 8) { console.log('  need 8+ films\n'); process.exit(0); }

let rng = 31337;
const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };

for (const d of DET) {
  const rows = [];
  const skews = [];
  for (const f of films) {
    const v = f.clips.map((c) => c[d]).filter((x) => Number.isFinite(x) && x > 0).map((x) => lex(d, x));
    if (v.length < 50) continue;
    const truth = v.filter((x) => x > 0).length / v.length;
    skews.push(skew(v));
    const errCount = []; const errImp = []; const sgnImp = [];
    for (let t = 0; t < NDRAW; t += 1) {
      const pick = [];
      const pool = v.slice();
      for (let i = 0; i < 4; i += 1) pick.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
      const c = pick.filter((x) => x > 0).length / 4;
      const s = sd(pick);
      const imp = s > 1e-9 ? Phi(mean(pick) / s) : (mean(pick) > 0 ? 1 : 0);
      errCount.push(Math.abs(c - truth)); errImp.push(Math.abs(imp - truth)); sgnImp.push(imp - truth);
    }
    rows.push({ truth, ec: mean(errCount), ei: mean(errImp), bias: mean(sgnImp) });
  }
  if (!rows.length) continue;
  const EC = med(rows.map((r) => r.ec)); const EI = med(rows.map((r) => r.ei));
  console.log(`  ${d.toUpperCase().padEnd(6)} 60-clip fraction ${(100 * med(rows.map((r) => r.truth))).toFixed(0)}% median`
    + `   per-clip log-excess skew ${med(skews).toFixed(2)}`);
  /* Both errors can be ~0 when the true fraction is 0 for nearly every film (block). A ratio is then
   * meaningless and printing one invites a false headline, so say what is actually happening. */
  const verdict = (EC < 1e-4 && EI < 1e-4)
    ? 'both ~0 — the fraction is 0 for almost every film, so neither estimator is being tested'
    : (EI < EC ? `${(EC / EI).toFixed(2)}x better` : `${(EI / EC).toFixed(2)}x WORSE`);
  console.log(`    from 4 clips:  counted |err| ${(100 * EC).toFixed(1)}%   implied |err| ${(100 * EI).toFixed(1)}%`
    + `   ${verdict}`);
  console.log(`    implied bias (signed, must be near 0)  ${(100 * med(rows.map((r) => r.bias))).toFixed(1)}pp`
    + `   worst film ${(100 * Math.max(...rows.map((r) => Math.abs(r.bias)))).toFixed(1)}pp`);
  console.log('');
}
console.log('  VERDICT RULE, stated before the numbers: the implied fraction is adopted only if it is');
console.log('  BOTH more precise AND near-unbiased. A precise but biased estimator is worse than a');
console.log('  noisy unbiased one, because its error does not average out across the library and it');
console.log('  would shift where 100 sits — the exact question this whole track exists to answer.\n');
