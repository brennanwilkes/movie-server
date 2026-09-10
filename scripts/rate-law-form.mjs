/* IS THE RATE-COMPLEXITY LAW A POWER LAW OR ADDITIVE? — the question upstream of the exponent
 *
 * WHY THIS IS THE MOST CONSEQUENTIAL OPEN ITEM. BPP+ writes target ~ cxEff^a and ships a = 1, fixed by
 * assumption. A literature spike returned an external bound of a <= 1 with a "central value ~0.6",
 * which invites the conclusion "lower the exponent". THAT CONCLUSION MAY BE AN ARTIFACT OF THE
 * FUNCTIONAL FORM, and this script is the test.
 *
 * THE ALGEBRA THAT MAKES IT MATTER. Gaussian rate-distortion gives R(D) = 0.5*log2(sigma^2/D) bits per
 * sample, so at a fixed quality D the required rate is ADDITIVE in log-variance. Our complexity IS a
 * probe bitrate (the CRF-20 render), i.e. it already lives in that log-variance-like coordinate. So RD
 * theory predicts
 *       R_k  =  R_20 + delta_k          (ADDITIVE, in bitrate units; delta depends only on the CRF)
 * whereas the shipped model implies
 *       R_k  =  beta_k * R_20           (PROPORTIONAL / power law)
 * These are different claims and they are distinguishable. Crucially, fitting a POWER law to data that
 * is really ADDITIVE returns d log R_k / d log R_20 = R_20/(R_20 + delta), which is ALWAYS in (0,1)
 * regardless of the truth. *** So an apparent exponent below 1 is exactly what an additive law looks
 * like through a power-law lens, and cannot by itself be read as "we over-normalise for complexity". ***
 *
 * WHY THIS IS NOT CIRCULAR, which is the obvious objection. cxEff is DEFINED from the CRF-20 probe, so
 * regressing R_20 on cxEff would be tautological. This regresses R_k on R_20 for k != 20 — how the
 * rate-CRF curves of different-complexity films relate to one another, which is not built in anywhere.
 * *** THE k = 20 ROW IS THE BUILT-IN CONTROL: it MUST return slope 1.000 and intercept 0. If it does
 * not, the harness is wrong and nothing else on the page means anything. ***
 *
 * WHAT SEPARATES THE TWO MODELS:
 *   ADDITIVE      the affine fit returns beta ~ 1 with a large non-zero intercept
 *   PROPORTIONAL  the affine fit returns intercept ~ 0 with beta < 1
 *   and the log-log slope `a` is reported alongside, because that is the number the exponent debate is
 *   actually about. Under a genuinely additive law `a` will drift with CRF; under a power law it will
 *   not. THE DRIFT IS THE DIAGNOSTIC, more than any single value of a.
 *
 * MODEL COMPARISON is by AIC on the same data in the same units, plus adjusted R2. Both models are fit
 * in LINEAR bitrate units so the comparison is fair; a log-space fit would silently favour the
 * multiplicative form by construction, which is precisely the bias this test exists to avoid.
 *
 * PRE-REGISTERED READING, before the numbers exist:
 *   - if ADDITIVE wins at every CRF and `a` drifts downward with CRF, then the shipped a = 1 is not
 *     refuted by any fitted a < 1, and task 100 must fit c + delta rather than c^a.
 *   - if PROPORTIONAL wins, the power form is right and a fitted exponent means what it says.
 *   - if they are indistinguishable over this bitrate range, say so; that is the honest answer for a
 *     101-film ladder and it means the external datasets have to settle it.
 *
 * READ-ONLY. Uses data/ladder-pilot.json.
 * USAGE: node scripts/rate-law-form.mjs
 */
import fs from 'fs';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/* affine y = a + b x, and proportional y = b x, with AIC for each */
function fits(x, y) {
  const n = x.length;
  const mx = mean(x); const my = mean(y);
  let sxy = 0; let sxx = 0;
  for (let i = 0; i < n; i += 1) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
  const b1 = sxy / sxx; const a1 = my - b1 * mx;
  let ssAff = 0;
  for (let i = 0; i < n; i += 1) ssAff += (y[i] - (a1 + b1 * x[i])) ** 2;
  /* SE of the slope */
  const seB = Math.sqrt((ssAff / (n - 2)) / sxx);

  let sxy0 = 0; let sxx0 = 0;
  for (let i = 0; i < n; i += 1) { sxy0 += x[i] * y[i]; sxx0 += x[i] * x[i]; }
  const b0 = sxy0 / sxx0;
  let ssPro = 0;
  for (let i = 0; i < n; i += 1) ssPro += (y[i] - b0 * x[i]) ** 2;

  let tt = 0;
  for (let i = 0; i < n; i += 1) tt += (y[i] - my) ** 2;
  const aic = (ss, k) => n * Math.log(ss / n) + 2 * k;
  return {
    aff: { a: a1, b: b1, seB, ss: ssAff, aic: aic(ssAff, 3), r2: 1 - ssAff / tt },
    pro: { b: b0, ss: ssPro, aic: aic(ssPro, 2), r2: 1 - ssPro / tt },
  };
}
function logSlope(x, y) {
  const lx = x.map(Math.log); const ly = y.map(Math.log);
  const mx = mean(lx); const my = mean(ly);
  let sxy = 0; let sxx = 0;
  for (let i = 0; i < lx.length; i += 1) { sxy += (lx[i] - mx) * (ly[i] - my); sxx += (lx[i] - mx) ** 2; }
  return sxy / sxx;
}

const d = JSON.parse(fs.readFileSync('data/ladder-pilot.json', 'utf8'));
const films = Object.values(d.films);
/* index each film's rungs by crf */
const byCrf = new Map();
for (const f of films) {
  for (const p of f.points || []) {
    if (!(p.probeBitrate > 0) || !Number.isFinite(p.crf)) continue;
    if (!byCrf.has(p.crf)) byCrf.set(p.crf, new Map());
    byCrf.get(p.crf).set(f.key, p.probeBitrate);
  }
}
const REF = 20;
const ref = byCrf.get(REF);
if (!ref) { console.log('\n  no CRF-20 rung — this harness assumes one\n'); process.exit(1); }
console.log(`\n  ${films.length} ladder films;  reference rung CRF ${REF}  (n=${ref.size})`);
console.log('  Fitted in LINEAR bitrate units so neither model is favoured by the coordinate.\n');
console.log(`  ${'CRF'.padStart(4)}  ${'n'.padStart(4)}  ${'AFFINE b'.padStart(9)} ${'+-SE'.padStart(6)}`
  + `  ${'intercept kbps'.padStart(15)}  ${'AIC aff'.padStart(9)} ${'AIC prop'.padStart(9)}  ${'winner'.padEnd(12)} ${'log-log a'.padStart(9)}`);

const crfs = [...byCrf.keys()].sort((a, b) => a - b);
const rows = [];
for (const k of crfs) {
  const m = byCrf.get(k);
  const keys = [...ref.keys()].filter((key) => m.has(key));
  if (keys.length < 12) continue;
  const x = keys.map((key) => ref.get(key));
  const y = keys.map((key) => m.get(key));
  const F = fits(x, y);
  const a = logSlope(x, y);
  const win = F.aff.aic < F.pro.aic - 2 ? 'AFFINE' : F.pro.aic < F.aff.aic - 2 ? 'proportional' : 'tie';
  rows.push({ k, n: keys.length, F, a, win });
  console.log(`  ${String(k).padStart(4)}  ${String(keys.length).padStart(4)}  ${F.aff.b.toFixed(3).padStart(9)}`
    + ` ${F.aff.seB.toFixed(3).padStart(6)}  ${(F.aff.a / 1000).toFixed(0).padStart(15)}`
    + `  ${F.aff.aic.toFixed(0).padStart(9)} ${F.pro.aic.toFixed(0).padStart(9)}  ${win.padEnd(12)} ${a.toFixed(3).padStart(9)}`);
}

const ctrl = rows.find((r) => r.k === REF);
console.log('\n  CONTROL — the CRF-20 row must read slope 1.000, intercept 0, or the harness is wrong.');
if (ctrl) {
  const ok = Math.abs(ctrl.F.aff.b - 1) < 1e-6 && Math.abs(ctrl.F.aff.a) < 1;
  console.log(`    slope ${ctrl.F.aff.b.toFixed(6)}  intercept ${ctrl.F.aff.a.toFixed(3)}  -> ${ok ? 'PASSES' : '*** FAILS — STOP ***'}`);
}

const off = rows.filter((r) => r.k !== REF);
const nAff = off.filter((r) => r.win === 'AFFINE').length;
const nPro = off.filter((r) => r.win === 'proportional').length;
console.log('\n  VERDICT\n');
console.log(`    off-reference rungs: ${off.length}   AFFINE wins ${nAff}   proportional wins ${nPro}`
  + `   tie ${off.length - nAff - nPro}`);
const aLo = off.filter((r) => r.k > REF).map((r) => r.a);
const aHi = off.filter((r) => r.k < REF).map((r) => r.a);
if (aLo.length && aHi.length) {
  console.log(`    log-log a:  below CRF ${REF} mean ${mean(aHi).toFixed(3)}   above CRF ${REF} mean ${mean(aLo).toFixed(3)}`);
}
/* INFORMATIVE FIRST, then a winner — trap 24. A 1-vs-0 win with two ties is not evidence, and an
 * earlier version of this file declared ADDITIVE on exactly that. Require a clear majority AND at
 * least one decisive rung. */
const decisive = nAff + nPro;
if (decisive < Math.ceil(off.length / 2) || Math.abs(nAff - nPro) < 2) {
  console.log(`\n    INDISTINGUISHABLE over this range — ${nAff} affine, ${nPro} proportional,`);
  console.log(`    ${off.length - decisive} ties out of ${off.length} off-reference rungs. Do NOT pick a winner from`);
  console.log('    this. What IS usable is the log-log exponent above, which is a direct check on the');
  console.log('    external "a ~ 0.6" prior — but read the assumption note below before quoting it.');
} else if (nAff > nPro) {
  console.log('\n    *** ADDITIVE. *** The affine model wins, which means required rate is roughly');
  console.log('    complexity PLUS an offset, not complexity TIMES a factor. CONSEQUENCE: a fitted');
  console.log('    power-law exponent below 1 is what this law looks like through the wrong lens, and');
  console.log('    is NOT evidence that BPP+ over-normalises for complexity. Task 100 must fit');
  console.log('    c + delta and AIC-compare before quoting any exponent.');
} else if (nPro > nAff) {
  console.log('\n    PROPORTIONAL. The power form is the right shape, so a fitted exponent means what');
  console.log('    it says and the external "a ~ 0.6" prior is directly comparable to our a = 1.');
} else {
  console.log('\n    NO CLEAR WINNER. Report that rather than picking one.');
}
console.log('\n  *** THE ASSUMPTION THIS ALL RESTS ON, AND IT IS OPEN QUESTION 9.4. *** The reference and');
console.log('  target rungs are both CRF probes of the SAME film, so this measures whether the rate-CRF');
console.log('  curves are PARALLEL in log space. Reading it as the perceptual rate-vs-complexity law');
console.log('  requires FIXED CRF = FIXED QUALITY, which 9.4 records as unverified (published spread');
console.log('  ~3-sigma 10 VMAF). State that whenever this exponent is quoted.');
console.log('');
