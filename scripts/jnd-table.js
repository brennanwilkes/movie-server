#!/usr/bin/env node
/* BPP+ → JND — give the scale a unit instead of another measurement.
 *
 * THE PROBLEM THIS DISSOLVES. "Where does 100 sit?" has been open since the anchor was chosen, and
 * every plan to close it has been a plan to measure a person. But the scale is already monotone and
 * already anchored to a physical encode (CRF 20); what it lacks is a UNIT. Give distances on it a
 * perceptual reading and the human's job shrinks from calibrating a scale to choosing an origin.
 *
 * THE CHAIN, with each link's evidence stated plainly — two are ours, two are borrowed:
 *
 *   1. BPP+ -> bitrate ratio.        EXACT, by definition. BPP+ = 100*sqrt(bpp/target), so
 *                                    ratio = (BPP+/100)^2. No error.
 *   2. bitrate ratio -> dCRF.        MEASURED HERE. The 20-film ladder pilot found a median
 *                                    -13.6% of bitrate per CRF point (per-film range -9.9% to
 *                                    -19.4%, R^2 >= 0.977, no knees). dCRF = ln(ratio)/ln(1-0.136).
 *                                    The per-film spread is carried through as the band below.
 *   3. dCRF -> JND.                  BORROWED, AND THE WEAK LINK. JND-aware per-title ladder work
 *                                    spaces rungs about 6 VMAF apart and calls that one JND, which
 *                                    lands at roughly 2-3 CRF points in the near-transparent
 *                                    region. Taken as 1 JND = 2.5 CRF points, bracketed 2 to 3.
 *   4. sanity anchor.                VMAF 100 is DEFINED at 1080p x264 CRF 22, and community
 *                                    mappings put x265 CRF 20 in the x264 CRF 17-23 range, so our
 *                                    anchor sits within roughly +/-1 JND of the industry's own
 *                                    perceptual-lossless definition. That is a CHECK on the origin,
 *                                    not part of the arithmetic.
 *
 * SO THE OUTPUT IS [DIRECTION], NOT [SOLID]. Links 3 and 4 are literature, and their combined
 * mapping error (+/-2-3 CRF points) is honestly LARGER than one person's judgment precision. That is
 * the point rather than a defect: it means the remaining question is genuinely "which JND level does
 * Brennan call perfect", a single offset, and no amount of further arithmetic answers it.
 *
 * WHAT IT MUST NOT BE USED FOR. Not a score input. Not a new term. Nothing here changes a single
 * number in the app — it is a reading aid for a scale that already exists.
 *
 * USAGE: node scripts/jnd-table.js [--slope 0.136] [--md]
 */
const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d; };
const MD = args.includes('--md');

const SLOPE = val('--slope', 0.136);        // median bitrate fraction lost per CRF point
const SLOPE_LO = val('--slope-lo', 0.099);  // steepest film measured (bits fall fastest)
const SLOPE_HI = val('--slope-hi', 0.194);  // shallowest
const JND_CRF = val('--jnd-crf', 2.5);      // CRF points per JND
const JND_LO = 2.0; const JND_HI = 3.0;

const dCRF = (ratio, slope) => Math.log(ratio) / Math.log(1 - slope);

const POINTS = [30, 40, 50, 60, 70, 75, 90, 100, 110, 125, 150, 200, 231];
const LABELS = {
  30: 'library minimum',
  60: 'LIBRARY MEDIAN (movies)',
  75: 'bad / warn edge',
  79: 'library median (TV)',
  100: 'THE ANCHOR — CRF 20, transparent',
  125: 'ok / wow edge',
  231: 'library maximum',
};

const rows = POINTS.map((p) => {
  const ratio = (p / 100) ** 2;
  const d = dCRF(ratio, SLOPE);
  // Per-film slope spread. A shallower film needs MORE CRF movement for the same bitrate change.
  const dLo = dCRF(ratio, SLOPE_HI);
  const dHi = dCRF(ratio, SLOPE_LO);
  // TWO UNCERTAINTIES, DELIBERATELY NOT POOLED. They answer different questions and adding them
  // produces a band so wide it says nothing.
  //   jLo..jHi  — the TYPICAL film: median slope, only the JND-per-CRF bracket. This is the headline.
  //   jSpreadLo..jSpreadHi — how much the per-film slope spread moves it. A film-specific reading,
  //                          not extra error on the typical one.
  const jnd = d / JND_CRF;
  const jLo = d / JND_HI; const jHi = d / JND_LO;
  // Ordered by MAGNITUDE, not sign: above the anchor everything is negative, and printing the
  // raw min/max there reads backwards ("0.6-0.4").
  const sp = [Math.abs(Math.min(dLo, dHi) / JND_HI), Math.abs(Math.max(dLo, dHi) / JND_LO)]
    .sort((x, y) => x - y).map((v) => v * Math.sign(d || 1));
  const [jSpreadLo, jSpreadHi] = sp;
  return { p, ratio, dCRF: d, dCRFLo: Math.min(dLo, dHi), dCRFHi: Math.max(dLo, dHi),
    jnd, jLo, jHi, jSpreadLo, jSpreadHi };
});

const f = (v, n = 2) => (v >= 0 ? ' ' : '') + v.toFixed(n);
if (MD) {
  console.log('| BPP+ | bits vs target | CRF-equiv | JND from transparent (typical film) | across films | reading |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rows) {
    const sign = r.p === 100 ? '' : (r.p < 100 ? ' below' : ' above');
    const jnd = r.p === 100 ? '0' : `${Math.abs(r.jLo).toFixed(1)}–${Math.abs(r.jHi).toFixed(1)}${sign}`;
    const spr = r.p === 100 ? '—' : `${Math.abs(r.jSpreadLo).toFixed(1)}–${Math.abs(r.jSpreadHi).toFixed(1)}`;
    console.log(`| **${r.p}** | ${(r.ratio * 100).toFixed(0)}% | ${(20 + r.dCRF).toFixed(1)} `
      + `| ${jnd} | ${spr} | ${LABELS[r.p] || ''} |`);
  }
} else {
  console.log(`slope ${(SLOPE * 100).toFixed(1)}%/CRF (band ${(SLOPE_LO * 100).toFixed(1)}-${(SLOPE_HI * 100).toFixed(1)}%), `
    + `1 JND = ${JND_CRF} CRF (band ${JND_LO}-${JND_HI})\n`);
  console.log('BPP+   bits/target   CRF-equiv   JND (typical film)   JND (across films)   note');
  for (const r of rows) {
    console.log(`${String(r.p).padStart(4)}   ${(r.ratio * 100).toFixed(0).padStart(9)}%   `
      + `${(20 + r.dCRF).toFixed(1).padStart(9)}   `
      + `${`${f(r.jLo, 1)}..${f(r.jHi, 1)}`.padStart(18)}   `
      + `${`${f(r.jSpreadLo, 1)}..${f(r.jSpreadHi, 1)}`.padStart(18)}   ${LABELS[r.p] || ''}`);
  }
  console.log('\nCross-check against the one qualitative label we have:');
  const r70 = rows.find((x) => x.p === 70);
  console.log(`  BPP+ 100 -> 70 lands at ${Math.abs(r70.jLo).toFixed(1)}-${Math.abs(r70.jHi).toFixed(1)} JND for a typical film`);
  console.log(`  (${Math.abs(r70.jSpreadLo).toFixed(1)}-${Math.abs(r70.jSpreadHi).toFixed(1)} across the per-film slope spread).`);
  console.log('  Brennan, unprompted and before this arithmetic existed: "dropping from a 100 to a 70');
  console.log('  represents a significant drop". Several visible steps is exactly what 1.6-2.4 JND means,');
  console.log('  and the chain was not fitted to that judgment — it reproduces it.');
  const r60 = rows.find((x) => x.p === 60);
  console.log(`\n  The library median (60) sits ${Math.abs(r60.jLo).toFixed(1)}-${Math.abs(r60.jHi).toFixed(1)} JND below transparent.`);
  console.log('  That is a large, plainly visible deficit — consistent with Easy Rider at BPP+ 78 being');
  console.log('  full of visible grain-shimmer, and with open question 2 reading (a) rather than (b):');
  console.log('  the library really is starved, rather than the anchor being set too high.');
}
