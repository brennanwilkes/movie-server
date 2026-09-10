/* A PREDICTION ABOUT WHAT THE CROSSED LADDER WILL FIND — registered before it finishes.
 *
 * WHY BOTHER. 11.30 estimated the anchor at 69.7% by dividing the library-wide WEB-vs-Bluray gap in P
 * (0.271) by P's ladder slope (median -0.513). scripts/anchor-crossed.js is running now and measures
 * the same quantity with both legs on the same clips, so no transfer assumption operates. When it
 * lands there will be a number, and the temptation will be to explain whatever gap appears AFTER
 * seeing it. Explaining a result you already know is worth almost nothing. So: predict first.
 *
 * THE MECHANISM BEING TESTED. 11.35 established that blocking's bitrate slope is REGIME-DEPENDENT —
 * roughly 2.5x steeper on films where blocking is visible than on films where it sits at its floor,
 * and the library median is therefore the wrong number for the films that matter. If P's slope is
 * regime-dependent in the same way, then the median -0.513 was measured on the wrong population and
 * the 69.7% inherits that error in a KNOWABLE DIRECTION:
 *     ladder films SHALLOWER than the anchor's target population -> 69.7% is TOO HIGH
 *     ladder films STEEPER  than the anchor's target population -> 69.7% is TOO LOW
 *
 * TWO SEPARATE WAYS THE SLOPE CAN BE THE WRONG ONE, both checked:
 *   1. LEVEL DEPENDENCE — does |slope| vary with the film's own P, the way blocking's varies with
 *      blocking level?
 *   2. SELECTION — are the laddered films representative of the library at all? They were chosen for
 *      several different experiments over weeks, several of them deliberately picking EXTREME films
 *      (the flagged shortlist, the blind-spot set). That is a population, not a sample.
 *
 * THE PREDICTION IS WRITTEN TO stdout AND SHOULD BE PASTED INTO BPP-PLUS BEFORE day4 REPORTS.
 *
 * USAGE: node scripts/p-slope-regime.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = { cambi: +1, block: +1, blur: +1, grain: -1 };
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
  if (pts.length < 5) return null;
  const mx = mean(pts.map((p) => p[0])); const my = mean(pts.map((p) => p[1]));
  let n = 0; let d = 0;
  for (const [x, y] of pts) { n += (x - mx) * (y - my); d += (x - mx) ** 2; }
  if (!(d > 0)) return null;
  const s = n / d;
  const sse = pts.reduce((a, [x, y]) => a + (y - (my + s * (x - mx))) ** 2, 0);
  const tot = pts.reduce((a, [, y]) => a + (y - my) ** 2, 0);
  return { slope: s, r2: tot > 0 ? 1 - sse / tot : 0 };
}

/* Library scales, so ladder rungs can be read in the same P units the anchor uses. */
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
const rawP = rows.map((_, i) => DET.reduce((s, d) => s + EXPECT[d] * Zc[d][i], 0));
const MP = mean(rawP); const SDSUM = sd(rawP);
const libP = new Map(rows.map((u, i) => [u.key, (rawP[i] - MP) / SDSUM]));

/* A LADDER RUNG HAS NO RESIDUAL, so this is NOT library P and must never be printed as if it were.
 * Library P subtracts a bits+content prediction; a ladder rung is deliberately sweeping bits, so
 * there is nothing to subtract. What this returns is the same weighted log-composite in the same
 * per-detector units, WITHOUT the residual centring — a raw damage index on an arbitrary origin.
 *   VALID:   its SLOPE against log(level). A constant offset differentiates away, so d/dlog(level)
 *            is identical to what library-P units would give.
 *   INVALID: its LEVEL. Comparing it to library P's mean of 0 is meaningless, and an earlier version
 *            of this script did exactly that and printed rung values of 4-7 against a standardised
 *            library, which is how the error was caught.
 *
 *   THE SCALE STILL APPLIES, THE OFFSET DOES NOT. Dividing by SDSUM is required — the gap (0.271) is
 *   in library-P units, so a slope used to divide it must be too. Dropping SDSUM while keeping the
 *   gap silently mixes two scales and inflated the implied anchor by a factor of 2.4; that happened
 *   once here already, in the same edit that fixed the offset. Subtracting MP, by contrast, would be
 *   meaningless for a rung — there is no residual to centre. */
const dmgIndex = (m) => DET.reduce((s, d) => s + (m[d] > 0 ? (EXPECT[d] * Math.log(m[d])) / SD[d] : 0), 0);
const pOf = (m) => dmgIndex(m) / SDSUM;

const FILES = ['artifact-ladder-grain.json', 'artifact-ladder-v1.json', 'artifact-ladder-wideA.json',
  'artifact-ladder-grain2.json', 'artifact-ladder-blindspot.json', 'artifact-ladder-underscored.json',
  'artifact-ladder-flagged.json'];
const films = [];
const fseen = new Set();
for (const fn of FILES) {
  let d; try { d = JSON.parse(fs.readFileSync(`data/${fn}`, 'utf8')); } catch { continue; }
  for (const f of d.films || []) if (!fseen.has(f.key)) { films.push({ ...f, run: fn }); fseen.add(f.key); }
}

const recs = [];
for (const f of films) {
  const pts = (f.points || []).filter((p) => p.level > 0 && DET.every((d) => p[d] > 0));
  if (pts.length < 5) continue;
  const g = fit(pts.map((p) => Math.log(p.level)), pts.map((p) => pOf(p)));
  if (!g) continue;
  const one = pts.find((p) => Math.abs(p.level - 1) < 1e-6);
  if (!one) continue;
  recs.push({ key: f.key, title: f.title, run: f.run, slope: g.slope, r2: g.r2, pAtOne: pOf(one) });
}
console.log(`\n  ${recs.length} laddered films with a P slope   library n=${rows.length}\n`);
console.log(`  P slope: median ${med(recs.map((r) => r.slope)).toFixed(3)}   `
  + `p10 ${recs.map((r) => r.slope).sort((a, b) => a - b)[Math.floor(0.1 * recs.length)].toFixed(3)}   `
  + `p90 ${recs.map((r) => r.slope).sort((a, b) => a - b)[Math.floor(0.9 * recs.length)].toFixed(3)}`);

/* ---- 1. LEVEL DEPENDENCE ---- */
console.log('\n  1. IS P\'s SLOPE REGIME-DEPENDENT, the way blocking\'s is?\n');
const c = corr(recs.map((r) => r.pAtOne), recs.map((r) => Math.abs(r.slope)));
console.log(`  corr(P at 1.0x, |P slope|) = ${c.toFixed(3)}`);
const srt = recs.slice().sort((a, b) => a.pAtOne - b.pAtOne);
const t = Math.floor(srt.length / 3);
for (const [nm, g] of [['low P (clean)', srt.slice(0, t)], ['mid', srt.slice(t, 2 * t)], ['high P (damaged)', srt.slice(2 * t)]]) {
  console.log(`    ${nm.padEnd(18)} n=${String(g.length).padStart(3)}  median dmgIdx ${med(g.map((x) => x.pAtOne)).toFixed(2).padStart(6)}  `
    + `median |slope| ${med(g.map((x) => Math.abs(x.slope))).toFixed(3)}`);
}

/* ---- 2. SELECTION ---- */
console.log('\n  2. ARE THE LADDERED FILMS REPRESENTATIVE OF THE LIBRARY?\n');
const inLib = recs.filter((r) => libP.has(r.key));
console.log(`  ${inLib.length} of ${recs.length} laddered films also have a library P`);
if (inLib.length >= 10) {
  console.log(`    median library P, laddered films   ${med(inLib.map((r) => libP.get(r.key))).toFixed(3)}`);
  console.log(`    median library P, whole library    ${med([...libP.values()]).toFixed(3)}`);
}
console.log('  by run (several of these deliberately selected EXTREME films):');
const byRun = {};
for (const r of recs) (byRun[r.run] ||= []).push(r);
for (const [run, g] of Object.entries(byRun)) {
  console.log(`    ${run.replace('artifact-ladder-', '').replace('.json', '').padEnd(14)} n=${String(g.length).padStart(3)}  `
    + `median |slope| ${med(g.map((x) => Math.abs(x.slope))).toFixed(3)}  median P@1.0x ${med(g.map((x) => x.pAtOne)).toFixed(2)}`);
}

/* ---- THE PREDICTION ---- */
const slopeAll = Math.abs(med(recs.map((r) => r.slope)));
const gap = 0.271;
console.log('\n  THE PREDICTION FOR scripts/anchor-crossed.js\n');
console.log(`  11.30 used |slope| = 0.513 over the ladder set, giving exp(${gap}/0.513) - 1 = 69.7%.`);
console.log(`  Recomputed here on ${recs.length} films: |slope| = ${slopeAll.toFixed(3)} `
  + `-> ${((Math.exp(gap / slopeAll) - 1) * 100).toFixed(1)}%`);
const lowP = med(srt.slice(0, t).map((x) => Math.abs(x.slope)));
const hiP = med(srt.slice(2 * t).map((x) => Math.abs(x.slope)));
console.log(`  clean-film slope ${lowP.toFixed(3)} vs damaged-film slope ${hiP.toFixed(3)}`);
/* THE DIRECTION OF THE BIAS — and getting this backwards is easy, so it is spelled out.
 *   anchor = exp(gap / |slope|) - 1, so |slope| is in the DENOMINATOR.
 *   A slope measured too SHALLOW makes the anchor come out too HIGH.
 * Two effects compose, and they point the same way here:
 *   LEVEL DEPENDENCE  damaged films have shallower P slopes (corr below)
 *   SELECTION         the laddered set is skewed toward damaged films (part 2 above)
 * Together: the ladder set's slope is shallower than a representative one, so 69.7% is INFLATED. */
const repSlope = lowP;                       // clean-film slope, the closer stand-in for a representative set
const repAnchor = (Math.exp(gap / repSlope) - 1) * 100;
console.log('');
console.log(`  direction of the bias: |slope| is the DENOMINATOR, so a slope measured too shallow`);
console.log(`  makes the anchor come out too HIGH.`);
if (Math.abs(c) < 0.15 && Math.abs(med(inLib.map((r) => libP.get(r.key))) - med([...libP.values()])) < 0.3) {
  console.log('  PREDICT: neither level dependence nor selection is material, so the crossed ladder should');
  console.log('  land NEAR the transfer estimate, ~70%. If it comes back inside the published 5-40% band');
  console.log('  instead, the TRANSFER ASSUMPTION itself is what inflates 11.30, not the slope.');
} else if (c < 0) {
  console.log('  PREDICT: damaged films have SHALLOWER slopes AND the laddered set is damage-skewed, so');
  console.log(`  the 0.503 median is shallower than a representative sample would give. 69.7% is therefore`);
  console.log(`  INFLATED. Using the clean-film slope ${repSlope.toFixed(3)} instead gives ${repAnchor.toFixed(1)}%.`);
  console.log('  EXPECT THE CROSSED LADDER TO RETURN SOMETHING BELOW 69.7%, and note it samples across the');
  console.log('  complexity range rather than the damage range, which pushes the same way.');
  console.log('  If it comes back ABOVE 69.7%, this mechanism is wrong and the transfer assumption is not');
  console.log('  the inflation either — which would leave the 4.6x gap genuinely unexplained.');
} else {
  console.log('  PREDICT: damaged films have STEEPER slopes, so the damage-skewed ladder set over-states');
  console.log('  the slope and 69.7% is an UNDER-estimate. Expect the crossed ladder ABOVE it, and apply');
  console.log('  the external bound hard before adopting anything.');
}
console.log('\n  WRITE THIS INTO BPP-PLUS BEFORE day4 REPORTS. A prediction made after seeing the answer');
console.log('  is worth nothing, and this project has already had six numbers explained after the fact.\n');
