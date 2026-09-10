/* THE SCENE FRACTION IS A CUT-OFF. IS IT COSTING US? — and the design rule says it should be.
 *
 * THE LIVE DESIGN RULE. The final output must be a WEIGHTED NUMBER, never flags, and there are to be
 * NO CUT-OFFS — a max is a cut-off and so is a hinge. The blend rule already obeys this. THE THRESHOLD
 * TRACK DOES NOT. "Fraction of scenes above 2.817" applies a hard per-scene cut-off and then counts,
 * and counting is what a flag does. Every scene at 2.80 and every scene at 28.0 is treated identically
 * on its own side of the line.
 *
 * *** BUT THE THRESHOLD IS ALSO THE ONLY EXTERNAL CALIBRATION IN THE PROJECT, so it cannot simply be
 * deleted. *** 2.817 is Netflix's published banding visibility point; it owes nothing to this library,
 * and that is exactly why the threshold track can answer "where does 100 sit" when P cannot. The move
 * is therefore NOT to drop T but to DEMOTE IT FROM A GATE TO A UNIT: measure each scene's level in
 * multiples of T and average smoothly, so T sets the SCALE while nothing is ever thresholded.
 *
 * THE THREE CANDIDATES, all anchored on the same external T:
 *   frac   fraction of clips past T.        CUT-OFF. What is shipped and what E.9 measured.
 *   logEx  mean of log(L/T) over clips.     SMOOTH. T is the unit; magnitude is never discarded.
 *   p95    95th percentile of log(L/T).     Brennan's criterion. Not a cut-off, but an ORDER
 *          statistic, so it still throws away magnitude — included to see which property matters.
 * Grain is inverted throughout (damage runs BELOW its threshold), so it uses log(T/L).
 *
 * THE PREDICTION, REGISTERED BEFORE RUNNING. A fraction should be markedly noisier at small k than a
 * smooth mean, because it discards magnitude and is maximally unstable for films sitting near T —
 * exactly the films a decision is hardest for. If that is right, E.9.6's "24 clips is the operating
 * point" is a conclusion about the CUT-OFF STATISTIC rather than about sampling, and a smooth
 * statistic might reach the same stability at far fewer clips. That would be a direct prod saving.
 * If instead all three behave alike, the cut-off costs nothing measurable and the design objection to
 * it is aesthetic rather than practical — which is a legitimate answer and must be reported as one.
 *
 * *** WHY THIS IS SAFE ON A PARTIAL RUN, WHICH IS OTHERWISE THE PROJECT'S MOST EXPENSIVE MISTAKE. ***
 * visibility-60clip.js walks the BPP+ bands IN ORDER, so a partial file is band-restricted and ANY
 * cross-film absolute is biased. Reliability IS a cross-film quantity, so the absolute numbers below
 * ARE affected — restriction of range depresses all of them. But the object here is the COMPARISON
 * between three statistics computed on THE SAME FILMS with THE SAME clips, and a shared restriction
 * of range moves all three together. Report the ordering and the ratios; do not quote the absolutes
 * as the library's reliabilities until the run finishes.
 *
 * METHOD. Split each film's clips into two DISJOINT halves of k, compute the statistic on each, and
 * correlate across films. Both halves are k clips, so that correlation IS the reliability of a single
 * k-clip read — no Spearman-Brown, which would answer a different question. Averaged over many random
 * splits, because a single split is itself a coin flip.
 *
 * READ-ONLY. Uses data/visibility-60clip.json, whatever it holds so far.
 * USAGE: node scripts/threshold-vs-smooth.mjs
 */
import fs from 'fs';

const THRESH = { cambi: 2.817, block: 3.710, blur: 8.026, grain: 0.905 };
const DIR = { cambi: +1, block: +1, blur: +1, grain: -1 };
const DET = ['cambi', 'block', 'blur', 'grain'];
const KS = [4, 8, 12, 24, 30];
const NSPLIT = 300;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const corr = (a, b) => {
  const ma = mean(a); const mb = mean(b);
  let n = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i += 1) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
};
const quant = (a, f) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))]; };

/* log excess in multiples of T, signed so that MORE DAMAGE IS ALWAYS MORE POSITIVE */
const lex = (d, v) => DIR[d] * Math.log(Math.max(v, 1e-9) / THRESH[d]);

const STAT = {
  frac: (d, v) => v.filter((x) => lex(d, x) > 0).length / v.length,
  logEx: (d, v) => mean(v.map((x) => lex(d, x))),
  p95: (d, v) => quant(v.map((x) => lex(d, x)), 0.95),
};
const NAMES = Object.keys(STAT);

let raw;
try { raw = JSON.parse(fs.readFileSync('data/visibility-60clip.json', 'utf8')); } catch {
  console.log('\n  data/visibility-60clip.json not written yet\n'); process.exit(0);
}
const films = Object.values(raw.units).filter((u) => Array.isArray(u.clips) && u.clips.length >= 50);
console.log(`\n  ${films.length} films with 50+ clips, BPP+ ${Math.min(...films.map((f) => f.bppPlus))}-`
  + `${Math.max(...films.map((f) => f.bppPlus))}`);
console.log('  RUN IN PROGRESS — read the COMPARISON between statistics, not the absolute reliabilities.');
console.log('  Band restriction depresses all three together; it does not reorder them.\n');
if (films.length < 8) { console.log('  need 8+ films\n'); process.exit(0); }

let rng = 5150;
const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };

for (const d of DET) {
  const vals = films.map((f) => f.clips.map((c) => c[d]).filter((x) => Number.isFinite(x) && x > 0));
  const full = Object.fromEntries(NAMES.map((n) => [n, vals.map((v) => STAT[n](d, v))]));
  console.log(`  ${d.toUpperCase()}   T = ${THRESH[d]}${DIR[d] < 0 ? '  (damage runs BELOW T)' : ''}`);
  console.log(`    60-clip spread   frac ${(100 * mean(full.frac)).toFixed(0)}% mean, sd ${(100 * sd(full.frac)).toFixed(0)}pp`
    + `   logEx mean ${mean(full.logEx).toFixed(2)}, sd ${sd(full.logEx).toFixed(2)}`);
  console.log(`    ${'k'.padStart(5)}  ${NAMES.map((n) => n.padStart(9)).join('')}     ratio logEx/frac`);
  for (const k of KS) {
    const usable = vals.filter((v) => v.length >= 2 * k);
    if (usable.length < 8) continue;
    const acc = Object.fromEntries(NAMES.map((n) => [n, []]));
    for (let t = 0; t < NSPLIT; t += 1) {
      const A = Object.fromEntries(NAMES.map((n) => [n, []]));
      const B = Object.fromEntries(NAMES.map((n) => [n, []]));
      for (const v of usable) {
        const idx = v.map((_, i) => i);
        for (let i = idx.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
        const a = idx.slice(0, k).map((i) => v[i]);
        const b = idx.slice(k, 2 * k).map((i) => v[i]);
        for (const n of NAMES) { A[n].push(STAT[n](d, a)); B[n].push(STAT[n](d, b)); }
      }
      for (const n of NAMES) acc[n].push(corr(A[n], B[n]));
    }
    const r = Object.fromEntries(NAMES.map((n) => [n, mean(acc[n])]));
    console.log(`    ${String(k).padStart(5)}  ${NAMES.map((n) => r[n].toFixed(3).padStart(9)).join('')}`
      + `     ${(r.logEx / Math.max(r.frac, 1e-6)).toFixed(2)}x`);
  }
  console.log('');
}
console.log('  HOW TO READ THIS. The right-hand ratio is the whole point: how much reliability the');
console.log('  SMOOTH statistic buys over the CUT-OFF one at the same clip count. A ratio near 1.0');
console.log('  means the cut-off costs nothing and the objection to it is aesthetic. A ratio well');
console.log('  above 1.0 at k=4 means E.9.6\'s "24 clips is the operating point" is a fact about the');
console.log('  STATISTIC rather than about sampling, and the cheaper fix is to stop thresholding.\n');
console.log('  p95 is included to separate two different sins: thresholding, and discarding magnitude.');
console.log('  If p95 tracks frac rather than logEx, the damage comes from discarding magnitude.\n');
