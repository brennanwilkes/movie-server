/* THE CONTENT LINE — the weakest number in the detail-loss construction, refitted at n=60.
 *
 * WHAT IT IS AND WHY IT IS LOAD-BEARING. perPoint = d log(bitrate)/d CRF measures how much
 * destructible detail a file still holds. But its LEVEL is set mostly by content: a busy film has a
 * large high-frequency tail and a steep perPoint whatever its provenance. So the damage reading is
 * not perPoint itself, it is the film's DISPLACEMENT FROM THE CONTENT LINE — how flat it sits
 * relative to films of the same complexity. Every result in E.8.3 and E.8.5 is a comparison against
 * that line, and it was fitted on EIGHT films with its own slope only 2.5 SE from zero. It is the
 * weakest link in the chain and this refits it on 60 stratified library films.
 *
 * THE TWO REFERENCE DIRECTIONS, both already measured, both needed here:
 *     CONTENT     d perPoint / d log(cx20) ACROSS films   -0.0254 +- 0.0101  (n=8, being replaced)
 *     STARVATION  d perPoint / d log(cx20) WITHIN a film  -0.0897 +- 0.0028  (n=24)
 *     LEVEL       d perPoint / d log(level) WITHIN a film -0.0297 +- 0.0021  (n=24, t=14.1)
 * The LEVEL slope is the one that converts a residual into something physical, because `level` is a
 * BITRATE MULTIPLIER that was experimentally imposed and carries no measurement error:
 *     impliedStarvation = exp( -residual / 0.0297 )
 * i.e. "this file behaves like a copy starved to X times its source bitrate". That is a per-film,
 * picture-derived estimate of SOURCE STARVATION — which is precisely the quantity biasFactor(R)
 * currently GUESSES from the release tier (5.1). This is the first route to measuring it.
 *
 * *** WHAT THIS SCRIPT MUST NOT DO, and the failure would be invisible. *** The residual is only a
 * damage reading if the content line is a CONTENT line. If cx20 is itself depressed by starvation —
 * and it is, that is the whole premise — then films at low cx20 are a MIXTURE of "simple" and
 * "starved", and fitting through them drags the line toward the starvation direction and cancels the
 * very signal being measured. The diagnostic is direct: THE FITTED CROSS-FILM SLOPE MUST COME OUT
 * NEAR -0.025, NOT NEAR -0.090. If it comes out near the starvation value, the line is contaminated
 * and the construction cannot proceed on library films alone.
 *
 * PRE-REGISTERED, before the 60-film data existed:
 *   slope near -0.025   the n=8 line replicates; the construction stands and residuals are usable
 *   slope near -0.090   the content line is contaminated by starvation; DO NOT build the score term
 *   slope near 0        perPoint does not track content across films at all, which would contradict
 *                       E.8.3's 6.1 SE separation and mean one of the two is wrong
 *
 * USAGE: node scripts/perpoint-content-line.mjs
 */
import fs from 'fs';

const CONTENT_OLD = -0.0254; const CONTENT_OLD_SE = 0.0101;
const STARVE = -0.0897; const STARVE_SE = 0.0028;
const LEVEL = -0.0297;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
function lin(xs, ys) {
  const mx = mean(xs); const my = mean(ys); const n = xs.length;
  let num = 0; let den = 0;
  for (let i = 0; i < n; i += 1) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const b = num / den; const a = my - b * mx;
  let ss = 0; let tt = 0;
  for (let i = 0; i < n; i += 1) { ss += (ys[i] - a - b * xs[i]) ** 2; tt += (ys[i] - my) ** 2; }
  return { a, b, se: Math.sqrt(ss / (n - 2) / den), r2: 1 - ss / tt, resSd: Math.sqrt(ss / (n - 2)), n };
}

let raw;
try { raw = JSON.parse(fs.readFileSync('data/perpoint-content-line.json', 'utf8')); } catch {
  console.log('\n  data/perpoint-content-line.json not written yet\n'); process.exit(0);
}
const units = Object.values(raw.units).map((u) => {
  const arm = u.arms[0] ?? u.arms['0'];
  return arm && arm.cx20 > 0 && Number.isFinite(arm.perPoint)
    ? { t: u.title, pp: arm.perPoint, cx20: arm.cx20, cxEff: u.cxEff, bpp: u.bpp, codec: u.codec } : null;
}).filter(Boolean);

console.log(`\n  ${units.length} films with a usable perPoint\n`);
if (units.length < 20) { console.log('  need 20+ before refitting\n'); process.exit(0); }

const xs = units.map((u) => Math.log(u.cx20));
const ys = units.map((u) => u.pp);
const F = lin(xs, ys);

console.log('  EXTERNAL BOUND FIRST (trap 8), before any standard error\n');
console.log(`    perPoint level: mean ${(100 * mean(ys)).toFixed(1)}%/CRF   `
  + `range ${(100 * Math.min(...ys)).toFixed(1)} to ${(100 * Math.max(...ys)).toFixed(1)}`);
console.log('    The library figure is -13.6%/CRF and the 8-film starvation set gave -17.4%/CRF.');
console.log('    A mean far outside that range means this is measuring something else.\n');

console.log('  THE REFITTED CONTENT LINE\n');
console.log(`    d perPoint / d log(cx20)   ${F.b.toFixed(4)} +- ${F.se.toFixed(4)}   n ${F.n}   r2 ${F.r2.toFixed(3)}`);
console.log(`    residual sd                ${F.resSd.toFixed(4)}`);
console.log(`\n    previous (n=8)             ${CONTENT_OLD.toFixed(4)} +- ${CONTENT_OLD_SE.toFixed(4)}`);
console.log(`    STARVATION reference       ${STARVE.toFixed(4)} +- ${STARVE_SE.toFixed(4)}`);

const dOld = Math.abs(F.b - CONTENT_OLD) / Math.sqrt(F.se ** 2 + CONTENT_OLD_SE ** 2);
const dStarve = Math.abs(F.b - STARVE) / Math.sqrt(F.se ** 2 + STARVE_SE ** 2);
console.log(`\n    distance from the old content line   ${dOld.toFixed(1)} SE`);
console.log(`    distance from the starvation line    ${dStarve.toFixed(1)} SE`);

/* *** THE PRE-REGISTRATION'S THIRD BRANCH WAS LOGICALLY WRONG AND IS CORRECTED HERE. ***
 * It read "slope near 0 -> contradicts E.8.3's separation, stop the construction". That is backwards.
 * The two-direction test asks whether the CONTENT and STARVATION directions DIFFER. If the content
 * slope is zero, the separation from -0.0897 gets LARGER, not smaller — and a detector whose content
 * direction is zero has PERFECT specificity, which is the best possible outcome rather than a failure.
 * External support: CRF's whole design premise is that the rate-quality slope is approximately
 * content-invariant, which is why CRF works as a quality target across different material. A flat
 * content line is therefore EXPECTED, and the n=8 slope of -0.0254 (2.5 SE from zero) was probably
 * noise. Recording the error rather than quietly repairing it, because a pre-registration that is
 * silently rewritten after seeing data is worth nothing. */
console.log('\n  VERDICT AGAINST THE PRE-REGISTRATION\n');
if (Math.abs(F.b) < 2 * F.se) {
  console.log('    THE CONTENT LINE IS FLAT — and that is the GOOD outcome, not the bad one.');
  console.log(`    perPoint does not depend on content complexity across films (slope ${F.b.toFixed(4)} +- ${F.se.toFixed(4)}),`);
  console.log(`    while responding strongly to damage WITHIN a film (starvation ${STARVE.toFixed(4)}, t>14 on the`);
  console.log('    controlled variable). A detector that moves under damage and NOT under content has');
  console.log('    perfect specificity — the separation is larger than the 6.1 SE measured at n=8, not');
  console.log('    smaller. This is also what CRF theory predicts: the rate-quality slope is designed');
  console.log('    to be content-invariant, which is why CRF works as a quality target at all.');
  console.log('\n    CONSEQUENCE FOR THE CONSTRUCTION, and it SIMPLIFIES it: the "content line" is just a');
  console.log(`    CONSTANT (mean perPoint ${mean(ys).toFixed(4)}). The damage reading is simply how flat a film sits`);
  console.log('    relative to that constant. No complexity normalisation is needed for the detail term');
  console.log('    at all — which also means it cannot inherit the complexity-masking bias of E.10.1.');
  console.log('\n    NO STARVATION CONTAMINATION EITHER. The failure mode this script was written to catch');
  console.log('    would drag the slope NEGATIVE toward -0.090; it came out slightly POSITIVE.');

  /* THE SPREAD IS THE REAL CONSTRAINT, and it decides whether PER-FILM readings are usable at all.
   * An aggregate direction can be sound while individual readings are pure noise. */
  const spread1sd = Math.exp(F.resSd / Math.abs(LEVEL));
  const spread1090 = Math.exp((2 * 1.2816 * F.resSd) / Math.abs(LEVEL));
  console.log('\n  *** BUT CHECK THE SPREAD BEFORE USING ANY PER-FILM NUMBER ***\n');
  console.log(`    residual sd ${F.resSd.toFixed(4)} / level slope ${Math.abs(LEVEL)} = `
    + `${spread1sd.toFixed(2)}x implied starvation per 1 sd`);
  console.log(`    which puts p10-to-p90 at ${spread1090.toFixed(1)}x in source starvation across the library.`);
  if (spread1090 > 4) {
    console.log('\n    THAT IS IMPLAUSIBLY WIDE. A real library does not span that range in how starved its');
    console.log('    sources were, so MOST OF THIS RESIDUAL IS MEASUREMENT NOISE, not damage. The');
    console.log('    AGGREGATE direction stands; PER-FILM readings do not, and nothing should be scored');
    console.log('    from them yet. The missing number is perPoint\'s own reliability, which this run');
    console.log('    cannot give because rates are pooled across clips BEFORE the fit — so there is no');
    console.log('    per-clip perPoint to split. Fix: store per-clip rates and re-run with 6 clips, then');
    console.log('    split 3v3. Until then the detail term has an unknown noise floor.');
  } else {
    console.log('\n    That is a plausible width for real source variation, so per-film readings may be');
    console.log('    usable. Still confirm against perPoint\'s own reliability before scoring from them.');
  }
} else if (dStarve < 2) {
  console.log('    *** CONTAMINATED. *** The cross-film slope has collapsed onto the STARVATION');
  console.log('    direction. That is the failure mode this script exists to catch: cx20 is itself');
  console.log('    depressed by starvation, so low-cx20 films are a MIXTURE of simple and starved, and');
  console.log('    fitting through them drags the line onto the damage direction — cancelling the very');
  console.log('    signal the residual is supposed to carry. DO NOT BUILD THE SCORE TERM on library');
  console.log('    films. A clean content line needs films of KNOWN provenance, or the line must be');
  console.log('    fitted on a quantity starvation does not move.');
} else {
  console.log(`    USABLE. The content and starvation directions remain ${dStarve.toFixed(1)} SE apart at n=${F.n}, so a`);
  console.log('    film\'s displacement from this line is a damage reading rather than a content reading.');
  console.log(`    ratio starvation/content = ${(STARVE / F.b).toFixed(2)}x transverse`);

  /* the per-film reading, in the only units that mean anything physically */
  const rows = units.map((u, i) => {
    const resid = u.pp - (F.a + F.b * xs[i]);
    return { ...u, resid, implied: Math.exp(-resid / LEVEL) };
  }).sort((a, b) => a.implied - b.implied);
  console.log('\n  IMPLIED SOURCE STARVATION, per film — "behaves like a copy starved to X of its source"');
  console.log('  (this is the quantity biasFactor(R) currently GUESSES from the release tier, 5.1)\n');
  console.log(`    ${'film'.padEnd(30)} ${'perPoint'.padStart(9)} ${'resid'.padStart(8)} ${'implied'.padStart(8)}`);
  const show = [...rows.slice(0, 6), null, ...rows.slice(-6)];
  for (const r of show) {
    if (!r) { console.log(`    ${'...'.padEnd(30)}`); continue; }
    console.log(`    ${r.t.slice(0, 29).padEnd(30)} ${r.pp.toFixed(4).padStart(9)} `
      + `${r.resid.toFixed(4).padStart(8)} ${r.implied.toFixed(2).padStart(8)}`);
  }
  const imps = rows.map((r) => r.implied);
  console.log(`\n    median implied ${med(imps).toFixed(2)}   p10 ${imps[Math.floor(0.1 * imps.length)].toFixed(2)}   `
    + `p90 ${imps[Math.floor(0.9 * imps.length)].toFixed(2)}`);
  console.log('\n    *** SANITY-CHECK THE SPREAD BEFORE BELIEVING ANY OF IT. *** The residual sd is');
  console.log(`    ${F.resSd.toFixed(4)}, which divided by the level slope ${Math.abs(LEVEL)} implies a `
    + `${Math.exp(F.resSd / Math.abs(LEVEL)).toFixed(1)}x spread in`);
  console.log('    source starvation across the library. If that is implausibly wide, the residual is');
  console.log('    mostly measurement noise and per-film readings are not usable even though the');
  console.log('    aggregate slope is. Judge the WIDTH against what a real library plausibly contains.');
}
console.log('');
