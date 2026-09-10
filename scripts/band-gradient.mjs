/* THE BAND GRADIENT — where does 100 sit? (task 96, the 40-film 60-clip run)
 *
 * THE OLDEST QUESTION IN THE PROJECT. The library median is ~67 and Brennan has long suspected that is
 * too low. P cannot answer it: P is standardised to mean zero across the library, so it is zero-sum by
 * construction and CANNOT MOVE THE MEDIAN, ever. The absolute artifact thresholds can, because they
 * owe nothing to this library — banding's 2.817 is Netflix's published visibility point.
 *
 * THE DATA. 40 films x 60 clips, stratified 8 per BPP+ band (0-50, 50-75, 75-100, 100-125, 125+), with
 * PER-CLIP values stored. That stratification is the whole point: a random draw from an 80%-Bluray
 * library concentrates in one place and cannot show a gradient at all.
 *
 * *** TWO STATISTICS, AND THE SMOOTH ONE IS THE HEADLINE (E.9.8). ***
 *   frac    fraction of clips past T.  A CUT-OFF — thresholds every scene and then counts, so a scene
 *           at 2.80 and one at 28.0 are identical. Reliability of ONE 4-clip read: 0.441 banding,
 *           0.041 blocking. Reported for continuity with everything measured before.
 *   logEx   mean of log(L/T) over clips. SMOOTH, no cut-off, and T is retained EXACTLY as the unit
 *           (it sits at logEx = 0). Reliability 0.695 / 0.809 on the same data. This is the one to
 *           read, and the design rule (a weighted number, never flags) says so independently.
 *
 * *** THE ANCHOR THIS MAKES POSSIBLE, WHICH IS NEW. *** Because T is a unit rather than a gate,
 * logEx = 0 has a direct meaning: THE AVERAGE SCENE SITS EXACTLY AT THE VISIBILITY THRESHOLD. So the
 * BPP+ at which logEx crosses zero is a principled, cut-off-free candidate for where 100 belongs —
 * "the score at which a typical scene is marginally visible". No criterion is chosen; the crossing is
 * read off the fitted line.
 *
 * *** CHECK THE EXTERNAL BOUND BEFORE THE STANDARD ERROR (handoff section 4). *** Every headline
 * number in this project has shrunk or vanished under its own controls, so the discipline is to ask
 * "is this even admissible?" before "is it significant?". The bound: median 67 is CRF-equivalent
 * ~25.5, so moving the median to 100 asserts CRF 25.5 is transparent, against published x265
 * visually-lossless practice of CRF 18-20. MEDIAN-AT-100 FAILS BEFORE ANY OF THIS DATA IS CONSULTED.
 * A median of 75-85 (CRF 21.5-23.3) sits inside the published range. Any crossing this script reports
 * OUTSIDE 75-85 needs an explanation, not an adoption.
 *
 * LEAD WITH BANDING. It is the only detector with a genuinely external threshold (Netflix's 2.817) AND
 * real loading on the adequacy axis. Blocking, blur and grain thresholds are CVQAD-derived and blur is
 * orthogonal to adequacy by construction (E.8.1), so they are reported as corroboration, not evidence.
 *
 * READ-ONLY. Uses data/visibility-60clip.json.
 * USAGE: node scripts/band-gradient.mjs
 */
import fs from 'fs';

const THRESH = { cambi: 2.817, block: 3.710, blur: 8.026, grain: 0.905 };
const DIR = { cambi: +1, block: +1, blur: +1, grain: -1 };
const DET = ['cambi', 'block', 'blur', 'grain'];
const BANDS = [[0, 50], [50, 75], [75, 100], [100, 125], [125, 1e9]];

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const lex = (d, v) => DIR[d] * Math.log(Math.max(v, 1e-9) / THRESH[d]);

function fit(x, y) {
  const n = x.length;
  const mx = mean(x); const my = mean(y);
  let sxy = 0; let sxx = 0;
  for (let i = 0; i < n; i += 1) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
  const b = sxy / sxx; const a = my - b * mx;
  let ss = 0;
  for (let i = 0; i < n; i += 1) ss += (y[i] - (a + b * x[i])) ** 2;
  const s2 = ss / (n - 2);
  let tt = 0;
  for (let i = 0; i < n; i += 1) tt += (y[i] - my) ** 2;
  return { a, b, seB: Math.sqrt(s2 / sxx), r2: 1 - ss / tt, n, s2, mx, sxx };
}
/* where the fitted line crosses zero, with a delta-method SE */
function crossing(F) {
  const x0 = -F.a / F.b;
  const se = Math.sqrt(F.s2 / (F.b ** 2) * (1 / F.n + ((x0 - F.mx) ** 2) / F.sxx));
  return { x0, se };
}

const raw = JSON.parse(fs.readFileSync('data/visibility-60clip.json', 'utf8'));
const films = Object.values(raw.units).filter((u) => Array.isArray(u.clips) && u.clips.length >= 50);
console.log(`\n  ${films.length} films, ${films.reduce((s, f) => s + f.clips.length, 0)} clips\n`);

const per = films.map((f) => {
  const o = { t: f.title, bpp: f.bppPlus, cx: f.cxEff };
  for (const d of DET) {
    const v = f.clips.map((c) => c[d]).filter((x) => Number.isFinite(x) && x > 0).map((x) => lex(d, x));
    o[`${d}_frac`] = v.filter((x) => x > 0).length / v.length;
    o[`${d}_lex`] = mean(v);
  }
  return o;
});

console.log('  BY BAND — counted fraction (the CUT-OFF statistic) and mean log-excess (SMOOTH)\n');
console.log(`    ${'band'.padEnd(10)} ${'n'.padStart(3)}  ${'banding frac'.padStart(12)} ${'banding logEx'.padStart(14)}`
  + `  ${'blur frac'.padStart(10)} ${'grain frac'.padStart(11)}`);
for (const [lo, hi] of BANDS) {
  const g = per.filter((p) => p.bpp >= lo && p.bpp < hi);
  if (!g.length) continue;
  const lbl = hi > 1000 ? `${lo}+` : `${lo}-${hi}`;
  console.log(`    ${lbl.padEnd(10)} ${String(g.length).padStart(3)}  `
    + `${(100 * mean(g.map((p) => p.cambi_frac))).toFixed(1).padStart(11)}% ${mean(g.map((p) => p.cambi_lex)).toFixed(3).padStart(14)}`
    + `  ${(100 * mean(g.map((p) => p.blur_frac))).toFixed(1).padStart(9)}% ${(100 * mean(g.map((p) => p.grain_frac))).toFixed(1).padStart(10)}%`);
}

console.log('\n  *** BANDING — the only detector with an external threshold AND adequacy loading ***\n');
const x = per.map((p) => Math.log(p.bpp));
const Ff = fit(x, per.map((p) => p.cambi_frac));
const Fl = fit(x, per.map((p) => p.cambi_lex));
console.log(`    fraction ~ log BPP+   slope ${Ff.b.toFixed(4)} +-${Ff.seB.toFixed(4)}   r2 ${Ff.r2.toFixed(3)}   t ${(Ff.b / Ff.seB).toFixed(2)}`);
console.log(`    logEx    ~ log BPP+   slope ${Fl.b.toFixed(4)} +-${Fl.seB.toFixed(4)}   r2 ${Fl.r2.toFixed(3)}   t ${(Fl.b / Fl.seB).toFixed(2)}`);

const cz = crossing(Fl);
const bppAt0 = Math.exp(cz.x0);
const lo95 = Math.exp(cz.x0 - 1.96 * cz.se); const hi95 = Math.exp(cz.x0 + 1.96 * cz.se);
console.log('\n  WHERE THE AVERAGE SCENE SITS EXACTLY AT THE VISIBILITY THRESHOLD (logEx = 0)\n');
console.log(`    BPP+ = ${bppAt0.toFixed(0)}   95% CI [${lo95.toFixed(0)}, ${hi95.toFixed(0)}]`);
console.log('    This is a cut-off-free anchor: T is the unit, and zero means "typical scene is');
console.log('    marginally visible". No criterion was chosen.');

console.log('\n  *** THE EXTERNAL BOUND, CONSULTED BEFORE THE SE (handoff section 4) ***\n');
console.log('    median 67 is CRF-equivalent ~25.5; median-at-100 asserts CRF 25.5 is transparent,');
console.log('    against published x265 visually-lossless practice of CRF 18-20. A median of 75-85');
console.log('    (CRF 21.5-23.3) sits INSIDE the published range.');
const admissible = bppAt0 >= 70 && bppAt0 <= 90;
console.log(`\n    crossing at ${bppAt0.toFixed(0)} is ${admissible ? 'INSIDE' : 'OUTSIDE'} the admissible 75-85 window`
  + `${admissible ? '' : ' -> needs an explanation, not an adoption'}`);

console.log('\n  CORROBORATION (weaker — CVQAD-derived thresholds; blur is orthogonal to adequacy)\n');
for (const d of ['block', 'blur', 'grain']) {
  const F = fit(x, per.map((p) => p[`${d}_lex`]));
  const c = crossing(F);
  console.log(`    ${d.padEnd(6)} logEx slope ${F.b.toFixed(4)} +-${F.seB.toFixed(4)}  t ${(F.b / F.seB).toFixed(2)}`
    + `   crosses 0 at BPP+ ${Number.isFinite(c.x0) ? Math.exp(c.x0).toFixed(0) : 'n/a'}`);
}

console.log('\n  MONOTONICITY CHECK — the gradient must be real, not a two-point artifact\n');
const bandMeans = BANDS.map(([lo, hi]) => {
  const g = per.filter((p) => p.bpp >= lo && p.bpp < hi);
  return g.length ? mean(g.map((p) => p.cambi_lex)) : NaN;
}).filter(Number.isFinite);
let mono = true;
for (let i = 1; i < bandMeans.length; i += 1) if (bandMeans[i] > bandMeans[i - 1]) mono = false;
console.log(`    banding logEx by band: ${bandMeans.map((v) => v.toFixed(2)).join('  ')}`);
console.log(`    monotone decreasing across all ${bandMeans.length} bands: ${mono ? 'YES' : 'NO'}`);
console.log('');
