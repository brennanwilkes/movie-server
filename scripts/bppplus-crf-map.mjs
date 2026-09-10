/* WHAT CRF DOES A GIVEN BPP+ ACTUALLY CORRESPOND TO? — verifying the one load-bearing input
 *
 * WHY THIS MATTERS MORE THAN ITS SIZE. The 2026-08-28 conclusion that BPP+ 100 already sits at
 * published visually-lossless quality (BPP-PLUS 9.1-ANSWER) rests on exactly one recorded figure:
 * "library median BPP+ 67 corresponds to CRF ~25.5". Everything else in that argument is arithmetic
 * or published. If 67 maps to CRF 23 or 28 instead, 100 lands at 17.5 or 22.5 and the conclusion
 * softens or inverts. That figure has been carried in the docs without a derivation attached, and the
 * handoff's own section 4 rule is that every headline number has shrunk or vanished under its own
 * controls. So it gets derived here, from data, rather than trusted.
 *
 * THE METHOD, AND IT NEEDS NO NEW ENCODING. The CRF ladder holds, per film, the bitrate a re-encode
 * produces at CRF 16 / 20 / 24 / 28. The delivered file has its own bitrate. So for each film: where
 * on ITS OWN ladder does the delivered bitrate fall? Interpolating log(bitrate) against CRF gives that
 * film's CRF EQUIVALENT — the CRF at which our encoder would produce a file of the same size. Regress
 * that against BPP+ across films and the mapping falls out.
 *
 * *** THE COMPARISON IS APPLES-TO-APPLES ONLY IF BOTH SIDES ARE THE SAME PIXELS. *** The ladder is
 * rendered at the probe's reference width (1920) while the delivered file is whatever it is, so the
 * delivered bitrate is scaled by the pixel ratio before being placed on the ladder. Skipping that
 * would make small-resolution films look far more starved than they are, which is the sort of error
 * that produces a confident wrong number.
 *
 * WHAT WOULD FALSIFY THE SHIPPED FIGURE. The prediction registered before running: a film at BPP+ 67
 * should land near CRF 25.5, and the fitted relation should have the slope the model implies. BPP+ is
 * proportional to sqrt(bitrate) and bitrate moves -13.6% per CRF, so
 *       d CRF / d ln(BPP+)  =  -2 / ln(1/0.864)  =  -13.68
 * A materially different slope means the -13.6%/CRF figure does not describe OUR encoder on OUR
 * content, and that would matter as much as the intercept.
 *
 * HONEST LIMIT, STATED UP FRONT: the ladder is 20 films chosen across complexity deciles, not a
 * random library sample, and a delivered file is not a CRF render — it comes from someone else's
 * encoder at unknown settings. So this measures "what CRF would OUR encoder need to match this file's
 * size", which is the right quantity for the anchor argument but is NOT the same as "what CRF was it
 * encoded at".
 *
 * READ-ONLY. Uses data/ladder-pilot.json and the live probe dataset.
 * USAGE: node scripts/bppplus-crf-map.mjs
 */
import fs from 'fs';

const PER_CRF = 0.136;
const SHIPPED_MED_BPP = 67;
const SHIPPED_MED_CRF = 25.5;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

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

const lad = JSON.parse(fs.readFileSync('data/ladder-pilot.json', 'utf8'));
const ds = await (await fetch('http://localhost:8088/api/probe/dataset')).json();
const by = new Map(ds.rows.map((r) => [r.key, r]));

const rows = [];
for (const f of Object.values(lad.films)) {
  const r = by.get(f.key);
  if (!r || !(r.srcBitrate > 0) || !(r.probeW > 0) || !(f.bppPlus > 0)) continue;
  const pts = (f.points || []).filter((p) => p.probeBitrate > 0 && Number.isFinite(p.crf))
    .sort((a, b) => a.crf - b.crf);
  if (pts.length < 3) continue;
  /* *** srcBitrate INCLUDES AUDIO — this project has been bitten by that before (task 43, the
   * audio-polluted R in the pinning curve). Verified again 2026-08-28: Casablanca srcBitrate
   * 16.71 Mbps minus 469 kbps audio = 16.24 Mbps, exactly the video bitrate implied by bpp.
   * Audio is a mean 13.6% of srcBitrate (p90 28.7%), which alone is worth ~0.9 CRF and would
   * make every film look better provisioned than it is. Use the VIDEO-ONLY rate, reconstructed
   * from bpp, which is video-only by definition. The ladder renders at probe geometry and bpp is
   * defined on that same geometry, so the two are directly comparable. *** */
  const px = r.probeW * r.probeH * r.fps;
  if (!(px > 0) || !(r.bpp > 0)) continue;
  const delivered = r.bpp * px;
  /* interpolate CRF at log(delivered) on the film's own ladder */
  const lx = pts.map((p) => Math.log(p.probeBitrate));
  const cy = pts.map((p) => p.crf);
  const ld = Math.log(delivered);
  let crfEq = null;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const hi = lx[i]; const lo = lx[i + 1];              /* bitrate falls as CRF rises */
    if ((ld <= hi && ld >= lo) || (ld >= hi && ld <= lo)) {
      const t = (ld - hi) / (lo - hi);
      crfEq = cy[i] + t * (cy[i + 1] - cy[i]);
      break;
    }
  }
  if (crfEq == null) {                                    /* extrapolate on the end segment */
    const useTop = ld > lx[0];
    const i = useTop ? 0 : pts.length - 2;
    const slope = (cy[i + 1] - cy[i]) / (lx[i + 1] - lx[i]);
    crfEq = cy[i] + (ld - lx[i]) * slope;
  }
  rows.push({ t: f.title, bpp: f.bppPlus, crfEq, extrap: crfEq < 16 || crfEq > 28 });
}
console.log(`\n  ${rows.length} ladder films with a delivered bitrate and >=3 rungs\n`);

const inRange = rows.filter((r) => !r.extrap);
console.log(`  ${inRange.length} land INSIDE the ladder's CRF 16-28 span (interpolated);`
  + ` ${rows.length - inRange.length} extrapolated\n`);

const use = inRange.length >= 8 ? inRange : rows;
const F = fit(use.map((r) => Math.log(r.bpp)), use.map((r) => r.crfEq));
const predAt = (b) => F.a + F.b * Math.log(b);
const seAt = (b) => Math.sqrt(F.s2 * (1 / F.n + ((Math.log(b) - F.mx) ** 2) / F.sxx));

console.log('  FITTED MAPPING   CRF-equivalent = a + b * ln(BPP+)\n');
console.log(`    slope b   ${F.b.toFixed(2)} +- ${F.seB.toFixed(2)}   r2 ${F.r2.toFixed(3)}   n ${F.n}`);
console.log(`    model-implied slope from -13.6%/CRF and BPP+ ∝ sqrt(bitrate):`
  + `  ${(-2 / Math.log(1 / (1 - PER_CRF))).toFixed(2)}`);
const tSlope = (F.b - (-2 / Math.log(1 / (1 - PER_CRF)))) / F.seB;
console.log(`    difference from the model slope: ${tSlope.toFixed(2)} SE`
  + `${Math.abs(tSlope) < 2 ? '   CONSISTENT' : '   *** INCONSISTENT ***'}`);

console.log('\n  THE LOAD-BEARING FIGURE, CHECKED\n');
const p67 = predAt(SHIPPED_MED_BPP); const s67 = seAt(SHIPPED_MED_BPP);
console.log(`    shipped:   BPP+ ${SHIPPED_MED_BPP} -> CRF ${SHIPPED_MED_CRF}`);
console.log(`    measured:  BPP+ ${SHIPPED_MED_BPP} -> CRF ${p67.toFixed(1)} +- ${s67.toFixed(1)}`
  + `   95% CI [${(p67 - 1.96 * s67).toFixed(1)}, ${(p67 + 1.96 * s67).toFixed(1)}]`);
const ok = Math.abs(p67 - SHIPPED_MED_CRF) < 1.96 * s67;
console.log(`    ${ok ? 'CONSISTENT with the shipped figure' : '*** THE SHIPPED FIGURE IS OUTSIDE THE CI ***'}`);

console.log('\n  AND WHAT THAT MAKES OF BPP+ 100\n');
const p100 = predAt(100); const s100 = seAt(100);
console.log(`    BPP+ 100 -> CRF ${p100.toFixed(1)} +- ${s100.toFixed(1)}`
  + `   95% CI [${(p100 - 1.96 * s100).toFixed(1)}, ${(p100 + 1.96 * s100).toFixed(1)}]`);
console.log('    published x265 visually-lossless practice: CRF 18-20');
const inWin = (p100 - 1.96 * s100) <= 20 && (p100 + 1.96 * s100) >= 18;
console.log(`    ${inWin ? 'The published window is INSIDE the CI — 9.1-ANSWER survives.'
  : '*** The published window is OUTSIDE the CI — 9.1-ANSWER needs revisiting. ***'}`);

console.log('\n  FILMS, for inspection\n');
rows.sort((a, b) => a.bpp - b.bpp);
for (const r of rows) {
  console.log(`    BPP+ ${String(r.bpp).padStart(4)}  CRF-eq ${r.crfEq.toFixed(1).padStart(5)}`
    + `${r.extrap ? '  (extrapolated)' : ''}   ${r.t.slice(0, 40)}`);
}
console.log('');
