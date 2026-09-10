/* HOW MUCH COMPLEXITY NORMALISATION DOES THE ARTIFACT EVIDENCE ACTUALLY SUPPORT?
 *
 * THE QUESTION, in Brennan's words: "what if the artifacts we're measuring genuinely tell us that we
 * don't need as many bits as we thought we did for essentially most films." E.10 produced the first
 * evidence bearing on it, and it is uncomfortable: raw bitrate predicts the fraction of a film's
 * SCENES that cross an absolute visibility threshold BETTER than BPP+ does, on all four artifacts.
 * Once raw bpp is known, BPP+ adds nothing.
 *
 * THE GENERALISATION THAT TESTS IT PROPERLY. BPP+ sets target proportional to complexity, i.e. it
 * scores on log(bpp) - a*log(cxEff) with a = 1, fixed by assumption and never fitted. Raw bitrate is
 * the same family at a = 0. So sweep a and ask which value best predicts visible-artifact
 * prevalence. This is strictly more informative than the two-point comparison in E.10 because it says
 * WHERE the optimum is, not merely which of two guesses is better.
 *
 * THE MECHANISM UNDER TEST. Complexity does two opposing things. It RAISES the bits a film needs —
 * which is why a > 0 — but it also MASKS artifacts, since grain hides banding and blocking. BPP+
 * credits the first and never debits the second, so it should over-normalise, and the artifact-optimal
 * exponent should sit BELOW 1. That is a directional prediction, made before the sweep.
 *
 * *** WHAT WOULD MAKE THIS UNINTERPRETABLE, and it is the thing to check first. *** With n=60 and one
 * free parameter, the argmax of a noisy curve is not a measurement. So:
 *   - the whole CURVE is printed, not just its peak — a flat curve means the data cannot locate a
 *     and no value should be quoted;
 *   - a BOOTSTRAP over films gives an interval for the optimum, and if that interval spans both 0
 *     and 1 then this analysis does not distinguish raw bitrate from BPP+ at all;
 *   - the a = 0 and a = 1 endpoints are reported explicitly, because those are the two positions
 *     anyone would actually ship.
 *
 * AND A SCOPE LIMIT THAT MUST TRAVEL WITH THE RESULT. E.8.1 showed blur and grain are pure
 * log(bits x content) functions, orthogonal to the adequacy axis BY CONSTRUCTION. Their rows here
 * cannot carry adequacy information whatever the exponent, so they are printed but must not be
 * pooled into a headline. CAMBI is the row to trust: it is the only detector with a genuinely
 * external threshold (Netflix's published CAMBI point) AND real adequacy loading (9.3 SE from a pure
 * sum function).
 *
 * USAGE: node scripts/complexity-exponent.mjs
 */
import fs from 'fs';

const THRESH = { cambi: 2.817, block: 3.710, blur: 8.026, grain: 0.905 };
const DIR = { cambi: +1, block: +1, blur: +1, grain: -1 };
const DET = ['cambi', 'block', 'blur', 'grain'];
const NBOOT = 2000;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const over = (d, v) => (DIR[d] > 0 ? v > THRESH[d] : v < THRESH[d]);
const rank = (a) => { const s = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length);
  s.forEach(([, i], k) => { r[i] = k; }); return r; };
function spearman(a, b) {
  const ra = rank(a); const rb = rank(b); const n = a.length;
  const ma = mean(ra); const mb = mean(rb);
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i += 1) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

const data = JSON.parse(fs.readFileSync('data/clip-reliability.json', 'utf8'));
const units = Object.values(data.units).filter((u) => Array.isArray(u.clips) && u.clips.length >= 4
  && u.bpp > 0 && u.cxEff > 0);
console.log(`\n  ${units.length} films, median ${units[0].clips.length} clips each\n`);

/* scene fraction per film per detector */
const FRAC = {};
for (const d of DET) {
  FRAC[d] = units.map((u) => {
    const v = u.clips.map((c) => c[d]).filter((x) => Number.isFinite(x) && x > 0);
    return v.length ? v.filter((x) => over(d, x)).length / v.length : null;
  });
}
const lb = units.map((u) => Math.log(u.bpp));
const lc = units.map((u) => Math.log(u.cxEff));
const score = (a) => lb.map((v, i) => v - a * lc[i]);

const AS = [];
for (let a = -0.25; a <= 1.751; a += 0.125) AS.push(Math.round(a * 1000) / 1000);

console.log('  RANK CORRELATION of scene-fraction against log(bpp) - a*log(cxEff)');
console.log('  (more negative = better prediction that fewer bits means more visible damage)\n');
console.log(`  ${'a'.padStart(6)}  ${DET.map((d) => d.padStart(8)).join('  ')}`);
for (const a of AS) {
  const s = score(a);
  const row = DET.map((d) => {
    const pairs = FRAC[d].map((f, i) => (f == null ? null : [f, s[i]])).filter(Boolean);
    return spearman(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
  });
  const mark = a === 0 ? '  <- raw bitrate' : a === 1 ? '  <- SHIPPED BPP+' : '';
  console.log(`  ${a.toFixed(3).padStart(6)}  ${row.map((v) => v.toFixed(3).padStart(8)).join('  ')}${mark}`);
}

/* ---- the optimum, with a bootstrap interval, per detector ---- */
console.log('\n\n  WHERE THE OPTIMUM SITS (bootstrap over films, 2000 draws)\n');
let rng = 987654321;
const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
const FINE = [];
for (let a = -0.5; a <= 2.001; a += 0.05) FINE.push(a);

for (const d of DET) {
  const idxAll = units.map((_, i) => i).filter((i) => FRAC[d][i] != null);
  const best = (idx) => {
    let ba = NaN; let bv = Infinity;
    for (const a of FINE) {
      const s = score(a);
      const r = spearman(idx.map((i) => FRAC[d][i]), idx.map((i) => s[i]));
      if (r < bv) { bv = r; ba = a; }
    }
    return { a: ba, r: bv };
  };
  const pt = best(idxAll);
  const boots = [];
  for (let b = 0; b < NBOOT; b += 1) {
    const idx = idxAll.map(() => idxAll[Math.floor(rand() * idxAll.length)]);
    boots.push(best(idx).a);
  }
  boots.sort((x, y) => x - y);
  const lo = boots[Math.floor(0.025 * NBOOT)]; const hi = boots[Math.floor(0.975 * NBOOT)];
  const spans01 = lo <= 0 && hi >= 1;
  const note = d === 'blur' || d === 'grain'
    ? 'ORTHOGONAL BY CONSTRUCTION (E.8.1) — cannot carry adequacy, ignore'
    : spans01 ? 'interval spans both 0 and 1: does NOT distinguish raw bitrate from BPP+'
      : hi < 1 ? 'OPTIMUM BELOW 1 — over-normalisation, as predicted' : 'optimum at or above 1';
  console.log(`  ${d.padEnd(7)} best a = ${pt.a.toFixed(2).padStart(5)}  rho ${pt.r.toFixed(3)}   `
    + `95% CI [${lo.toFixed(2)}, ${hi.toFixed(2)}]`);
  console.log(`  ${' '.repeat(7)} ${note}`);
}

console.log('\n  ENDPOINTS, which are the two positions anyone would actually ship\n');
for (const d of DET) {
  const idx = units.map((_, i) => i).filter((i) => FRAC[d][i] != null);
  const at = (a) => spearman(idx.map((i) => FRAC[d][i]), idx.map((i) => score(a)[i]));
  console.log(`  ${d.padEnd(7)} a=0 (raw bpp) ${at(0).toFixed(3).padStart(7)}    `
    + `a=1 (BPP+) ${at(1).toFixed(3).padStart(7)}    difference ${(at(1) - at(0)).toFixed(3)}`);
}
console.log('\n  Read CAMBI and largely disregard the rest: it is the only detector with both an');
console.log('  external threshold and real adequacy loading. n = 60 and these films were selected');
console.log('  for a reliability study, not sampled for representativeness — so this locates the');
console.log('  question, it does not settle it. DO NOT CHANGE THE SHIPPED DENOMINATOR ON THIS.');
console.log('');
