/* WHAT THE SHIPPED RULE ACTUALLY DOES — the offline twin of the Blend tab's provenance mode.
 *
 * The browser can only be judged by looking at it, and looking at it is Brennan's time. This runs the
 * SAME arithmetic against the same exported file so the distribution, the external-bound check and the
 * named movers can be read here first. If these numbers and the page ever disagree, the page is wrong.
 *
 * THE RULE:
 *     lambda = ln(1 + anchor%) / gap          gap = measured mean P(WEB) - mean P(Bluray)
 *     adj    = BPP+ * exp(-strength * reliability * lambda * P / 2)
 * The /2 is the sqrt, because BPP+ = 100*sqrt(bpp/target) so a bitrate multiplier enters halved.
 *
 * THE CHECK THAT MATTERS. 11.21 died because an implied 4.64x BD-rate was accepted on a tight error
 * bar while contradicting published values threefold. So the FIRST thing tested here is whether the
 * spread of adjustments is consistent with what encoders can actually differ by — before anything
 * about significance.
 *
 * USAGE: node scripts/prov-rule-check.mjs [anchorPct] [strength]
 */
import fs from 'fs';

const anchorPct = Number(process.argv[2] ?? 15);
const strength = Number(process.argv[3] ?? 1);

const P = JSON.parse(fs.readFileSync('bpp-lab/public/provenance.json', 'utf8'));
const back = JSON.parse(fs.readFileSync('data/artifact-backfill.json', 'utf8')).units;

const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const q = (a, f) => a.slice().sort((x, y) => x - y)[Math.floor(f * (a.length - 1))];

/* dP per GENERATION is the denominator, not the gap — 11.39. The gap route assumes the WEB-vs-Bluray
 * difference is one generation; it is about two. */
const denom = P.dPdGen || P.anchor.gap;
const lambda = Math.log(1 + anchorPct / 100) / denom;
/* THE PROVENANCE SHARE, not the split-half reliability — BPP-PLUS 11.37. Reliability measures how
 * much of P is a common factor, which includes shooting style, grade and mastering house; none of
 * those are fixed by a download. Using it implied the library spans +-27 generations from master. */
const rel = P.shrink?.floor ?? P.reliability;
console.log(`\n  anchor ${anchorPct}%  strength ${strength}  dPdGen ${denom.toFixed(4)} (gap ${P.anchor.gap.toFixed(3)} = ${(P.anchor.gap / denom).toFixed(2)} gens)  `
  + `provShare ${rel.toFixed(3)} (reliability ${P.reliability.toFixed(3)} REJECTED)  ->  lambda ${lambda.toFixed(3)}\n`);

const rows = [];
for (const [key, u] of Object.entries(P.units)) {
  const b = back[key];
  const bppPlus = b?.bppPlus;
  if (!(bppPlus > 0)) continue;
  const mult = Math.exp((-strength * rel * lambda * u.P) / 2);
  rows.push({ key, title: b.title, source: u.source, codec: u.codec, bppPlus,
    P: u.P, mult, adj: bppPlus * mult, pct: (mult - 1) * 100 });
}
const pcts = rows.map((r) => r.pct);

console.log(`  ${rows.length} units scoreable\n`);
console.log('  ADJUSTMENT DISTRIBUTION (% change to BPP+)');
console.log(`    p01 ${q(pcts, 0.01).toFixed(1)}   p05 ${q(pcts, 0.05).toFixed(1)}   p25 ${q(pcts, 0.25).toFixed(1)}`
  + `   median ${med(pcts).toFixed(1)}   p75 ${q(pcts, 0.75).toFixed(1)}   p95 ${q(pcts, 0.95).toFixed(1)}   p99 ${q(pcts, 0.99).toFixed(1)}`);
console.log(`    full range ${Math.min(...pcts).toFixed(1)} .. ${Math.max(...pcts).toFixed(1)}`);

/* THE EXTERNAL BOUND, checked before anything else. Published BD-rate puts a whole x264 preset step
 * at 1.3-1.5x and x265-vs-x264 at 1.4-2.0x. The very worst real-world provenance gap is therefore
 * about 2x in bitrate, which is 1.41x in score, i.e. +-41% as an absolute ceiling; the 5-95 band of a
 * whole library should sit well inside that. */
const band = Math.max(Math.abs(q(pcts, 0.05)), Math.abs(q(pcts, 0.95)));
const worst = Math.max(...pcts.map(Math.abs));
console.log(`\n  EXTERNAL BOUND CHECK`);
console.log(`    5-95 band  +-${band.toFixed(1)}%   ${band < 25 ? 'PASS (inside the +-25% a generation can plausibly be worth)' : 'FAIL'}`);
console.log(`    worst film +-${worst.toFixed(1)}%   ${worst < 41 ? 'PASS (inside the +-41% that a 2x bitrate gap implies)' : 'FAIL'}`);

const movedBand = rows.filter((r) => (r.bppPlus >= 100) !== (r.adj >= 100));
console.log(`\n  library median BPP+ ${med(rows.map((r) => r.bppPlus)).toFixed(0)} -> ${med(rows.map((r) => r.adj)).toFixed(0)}`);
console.log(`  cross the 100 line: ${movedBand.length} of ${rows.length}`);

console.log('\n  GROUP MEANS — the ordering that justifies the whole thing');
for (const [nm, re] of [['WEBRip', /WEBRip/i], ['WEB-DL', /WEBDL|WEB-DL/i], ['Bluray', /Bluray/i]]) {
  const g = rows.filter((r) => re.test(r.source || ''));
  if (g.length < 10) continue;
  console.log(`    ${nm.padEnd(8)} n=${String(g.length).padStart(4)}  mean P ${(g.reduce((s, r) => s + r.P, 0) / g.length).toFixed(3).padStart(7)}`
    + `  median adjustment ${med(g.map((r) => r.pct)).toFixed(1).padStart(6)}%`);
}

rows.sort((a, b) => a.pct - b.pct);
console.log('\n  MOVED DOWN MOST — the panel says these are worse than their bitrate suggests');
rows.slice(0, 15).forEach((r) => console.log(`    ${String(r.bppPlus).padStart(4)} -> ${r.adj.toFixed(0).padStart(4)} `
  + `${r.pct.toFixed(1).padStart(6)}%  P ${r.P.toFixed(2).padStart(6)}  ${(r.source || '').padEnd(14)} ${r.title}`));
console.log('\n  MOVED UP MOST — better than their bitrate suggests');
rows.slice(-15).reverse().forEach((r) => console.log(`    ${String(r.bppPlus).padStart(4)} -> ${r.adj.toFixed(0).padStart(4)} `
  + `${r.pct.toFixed(1).padStart(6)}%  P ${r.P.toFixed(2).padStart(6)}  ${(r.source || '').padEnd(14)} ${r.title}`));

/* The last adversarial check, and the one 11.19 taught: does the OUTPUT re-derive an input? The
 * residuals are orthogonal to bits and content by arithmetic, so P must be too — but the ADJUSTMENT
 * is P scaled by a constant, and the ADJUSTED SCORE is not, because it multiplies BPP+. If the
 * adjusted score correlates with bpp more strongly than BPP+ already does, the rule has smuggled
 * bits back in. */
const corr = (a, b) => {
  const ma = a.reduce((s, x) => s + x, 0) / a.length; const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let n = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i += 1) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db);
};
const lb = rows.map((r) => Math.log(back[r.key].bpp));
const lc = rows.map((r) => Math.log(back[r.key].cxEff));
console.log('\n  DID THE RULE SMUGGLE BITS BACK IN?');
console.log(`    corr(BPP+, log bpp)      ${corr(rows.map((r) => r.bppPlus), lb).toFixed(3)}`);
console.log(`    corr(adjusted, log bpp)  ${corr(rows.map((r) => r.adj), lb).toFixed(3)}   (should not exceed the line above)`);
console.log(`    corr(BPP+, log cx)       ${corr(rows.map((r) => r.bppPlus), lc).toFixed(3)}`);
console.log(`    corr(adjusted, log cx)   ${corr(rows.map((r) => r.adj), lc).toFixed(3)}\n`);
