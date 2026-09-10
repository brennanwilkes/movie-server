/* THE DIRECT (T/L)^k RULE, OFFLINE — the twin of the Blend tab's second mode.
 *
 * WHY CHECK A RULE THAT IS NOT THE DEFAULT. It is on the page as a comparison, so it will be looked
 * at, and a comparison mode that is quietly broken is worse than no comparison at all. Its documented
 * behaviour is "well-behaved downward, runs away upward" and that claim should be verified rather
 * than repeated.
 *
 * THE RULE:
 *     score_a = 100 * (T_a / L_a)^k        (inverted for grain, where the damage is reading BELOW T)
 *     log(final) = [ log(BPP+) + SUM_a w_a * log(score_a) ] / (1 + SUM_a w_a)
 *     w_a = fired ? 1 : P(fire | this content)
 * At L = T the artifact is exactly at visibility and score_a is exactly 100, which is what BPP+ = 100
 * already means — so the two scales meet with no conversion and no slope division anywhere.
 *
 * THE FIRING RATES ARE MEASURED, not written in: the relevance gate is a CLIFF, not a gradient
 * (11.23), so a silent detector on grainy content is weighted by how rarely it fires there rather
 * than gated out. Terciles of complexity, recomputed here from the same data the lab uses.
 *
 * USAGE: node scripts/direct-rule-check.mjs [k]
 */
import fs from 'fs';

const k = Number(process.argv[2] ?? 0.25);
const ARTIFACTS = [
  { key: 'cambi', label: 'banding', T: 2.817, worseIsHigh: true },
  { key: 'block', label: 'blocking', T: 3.710, worseIsHigh: true },
  { key: 'blur', label: 'blur', T: 8.026, worseIsHigh: true },
  { key: 'grain', label: 'grain loss', T: 0.905, worseIsHigh: false },
];

const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const q = (a, f) => a.slice().sort((x, y) => x - y)[Math.floor(f * (a.length - 1))];

const P = JSON.parse(fs.readFileSync('bpp-lab/public/provenance.json', 'utf8'));
const back = JSON.parse(fs.readFileSync('data/artifact-backfill.json', 'utf8')).units;
const rows = [];
for (const [key, u] of Object.entries(P.units)) {
  const b = back[key];
  if (b?.bppPlus > 0 && b.cxEff > 0) rows.push({ key, ...u, bppPlus: b.bppPlus, cxEff: b.cxEff, title: b.title });
}
const cx = rows.map((r) => r.cxEff).sort((a, b) => a - b);
const lo = cx[Math.floor(cx.length / 3)]; const hi = cx[Math.floor((2 * cx.length) / 3)];
const bandOf = (v) => (v < lo ? 0 : v > hi ? 2 : 1);

const fire = {};
for (const a of ARTIFACTS) {
  const n = [0, 0, 0]; const f = [0, 0, 0];
  for (const r of rows) {
    if (!(r[a.key] > 0)) continue;
    const b = bandOf(r.cxEff);
    n[b] += 1;
    if (a.worseIsHigh ? r[a.key] >= a.T : r[a.key] <= a.T) f[b] += 1;
  }
  fire[a.key] = n.map((c, i) => (c > 0 ? f[i] / c : 0));
}
console.log(`\n  k = ${k}   n = ${rows.length}   complexity cut points ${lo.toFixed(3)} / ${hi.toFixed(3)}\n`);
console.log('  MEASURED FIRING RATES (the weight a SILENT detector gets)');
console.log(`  ${'artifact'.padEnd(12)} ${'smooth'.padStart(8)} ${'mid'.padStart(8)} ${'grainy'.padStart(8)}`);
for (const a of ARTIFACTS) {
  console.log(`  ${a.label.padEnd(12)} ${fire[a.key].map((v) => `${(v * 100).toFixed(1)}%`.padStart(8)).join(' ')}`);
}

const out = [];
for (const r of rows) {
  const b = bandOf(r.cxEff);
  let wsum = 1; let lsum = Math.log(r.bppPlus);
  for (const a of ARTIFACTS) {
    const L = r[a.key];
    if (!(L > 0)) continue;
    const ratio = a.worseIsHigh ? a.T / L : L / a.T;
    const fired = a.worseIsHigh ? L >= a.T : L <= a.T;
    const w = fired ? 1 : fire[a.key][b];
    wsum += w; lsum += w * Math.log(100 * (ratio ** k));
  }
  const adj = Math.exp(lsum / wsum);
  out.push({ ...r, adj, pct: (adj / r.bppPlus - 1) * 100 });
}
const pcts = out.map((r) => r.pct);
console.log('\n  ADJUSTMENT DISTRIBUTION (% change to BPP+)');
console.log(`    p05 ${q(pcts, 0.05).toFixed(1)}   p25 ${q(pcts, 0.25).toFixed(1)}   median ${med(pcts).toFixed(1)}`
  + `   p75 ${q(pcts, 0.75).toFixed(1)}   p95 ${q(pcts, 0.95).toFixed(1)}   p99 ${q(pcts, 0.99).toFixed(1)}`);
console.log(`    full range ${Math.min(...pcts).toFixed(1)} .. ${Math.max(...pcts).toFixed(1)}`);
console.log(`\n  library median BPP+ ${med(out.map((r) => r.bppPlus)).toFixed(0)} -> ${med(out.map((r) => r.adj)).toFixed(0)}`);

/* The documented claim, checked rather than repeated: well-behaved downward, runaway upward. */
const worstDown = Math.abs(Math.min(...pcts));
const worstUp = Math.max(...pcts);
console.log('\n  THE DOCUMENTED CLAIM — "well-behaved downward, runs away upward"');
console.log(`    worst downward move  -${worstDown.toFixed(1)}%`);
console.log(`    worst upward move    +${worstUp.toFixed(1)}%`);
console.log(`    ratio up/down        ${(worstUp / Math.max(worstDown, 1e-9)).toFixed(1)}x  `
  + `-> ${worstUp > 3 * worstDown ? 'CONFIRMED, the asymmetry is real' : 'NOT confirmed at this k — update the tab copy'}`);
console.log(`    library median moves ${(med(out.map((r) => r.adj)) / med(out.map((r) => r.bppPlus)) - 1 > 0 ? '+' : '')}`
  + `${((med(out.map((r) => r.adj)) / med(out.map((r) => r.bppPlus)) - 1) * 100).toFixed(1)}%  `
  + `(the provenance rule moves it +1.6%; a big number here means this rule re-bases the whole library)`);

out.sort((a, b) => b.pct - a.pct);
console.log('\n  TOP 10 UPWARD — the tail the tab warns about');
out.slice(0, 10).forEach((r) => console.log(`    ${String(r.bppPlus).padStart(4)} -> ${r.adj.toFixed(0).padStart(5)} `
  + `${r.pct.toFixed(0).padStart(6)}%   banding ${r.cambi.toFixed(3).padStart(7)}   ${r.title}`));
console.log('\n  TOP 10 DOWNWARD');
out.slice(-10).reverse().forEach((r) => console.log(`    ${String(r.bppPlus).padStart(4)} -> ${r.adj.toFixed(0).padStart(5)} `
  + `${r.pct.toFixed(0).padStart(6)}%   banding ${r.cambi.toFixed(3).padStart(7)}   ${r.title}`));
console.log('');
