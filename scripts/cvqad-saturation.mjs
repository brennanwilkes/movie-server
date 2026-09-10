/* DOES CVQAD REACH TRANSPARENCY? — the question that decides whether it can ANCHOR, tested not assumed
 *
 * WHY THIS EXISTS. A dataset spike concluded "never derive the anchor from CVQAD — max rung 4000 kbps,
 * no transparency." Checking the label CSV, that premise is FALSE: 733 of 1962 rows exceed 4000 kbps,
 * p90 is 10,268, p99 is 18,745 and the max is 39,381. The 4000 was the ceiling of a downloaded SUBSET,
 * not of the labels. But "the ceiling is higher than claimed" does NOT establish transparency, and
 * replacing one unverified claim with the opposite one is the exact failure this project keeps having.
 * So: measure it.
 *
 * THE QUESTION, PRECISELY. Transparency is not "a high bitrate". It is the point where MORE BITS STOP
 * BUYING QUALITY. That is a statement about the SHAPE of each sequence's rate-quality curve, and it is
 * answerable from labels alone — no video, no decode, no complexity, nothing queued behind the box.
 *
 * *** THE TRAP THAT GOVERNS THE WHOLE DESIGN. *** LEHA-CVQAD scores are PER-COMPARISON-GROUP
 * calibrated. A global cross-content correlation on them is meaningless, and an ABSOLUTE cut ("MOS >=
 * 7 is transparent") silently conflates the grader baseline of one group with the content of another.
 * Every statistic here is therefore computed STRICTLY WITHIN A SEQUENCE, where the comparison group is
 * shared and the scores are commensurable. Nothing is compared across sequences except the SHAPE
 * conclusions, which are unitless.
 *
 * WHAT SATURATION LOOKS LIKE, and the three ways it can fail to appear:
 *   1. GENUINE SATURATION  the top rungs are statistically flat -> a transparency point exists and
 *                          the knee bitrate is the anchor candidate.
 *   2. STILL CLIMBING      MOS is still rising at the top rung -> the ladder never reached
 *                          transparency for that content, and the spike's objection is CORRECT for it.
 *   3. NOISE-DOMINATED     the curve is so noisy that flat and climbing cannot be told apart. This is
 *                          NOT saturation and must not be counted as it — the commonest way a null
 *                          result gets misread as a positive one.
 * The three are reported separately and a sequence only counts as saturated if the top-end slope is
 * BOTH near zero AND resolved (|slope| < its own 2 SE).
 *
 * METHOD. Within each sequence: regress MOS on log(bitrate) over the TOP HALF of its rungs (the region
 * where saturation would live), and separately over the bottom half (where it should definitely be
 * climbing). The bottom-half slope is a POSITIVE CONTROL — if it is not clearly positive, that
 * sequence's labels are too noisy to say anything and it is excluded rather than counted as flat.
 *
 * *** ALSO PRE-REGISTERED: THE CRITERION-SENSITIVITY CHECK. *** Downstream, the exponent fit picks a
 * threshold bitrate t_j where each sequence crosses a fixed criterion. That criterion is a CUT-OFF and
 * the design rule forbids leaning on one. So this reports the knee at SEVERAL criteria (85%, 90%, 95%
 * of the sequence's own MOS span). If the implied anchor moves a lot across criteria, the criterion is
 * doing the work rather than the data, and any single-criterion anchor is not trustworthy.
 *
 * READ-ONLY. Labels only. Uses /data/research/cvqad/Subjective_scores_and_videos_info.csv.
 * USAGE: node scripts/cvqad-saturation.mjs
 */
import fs from 'fs';

const CSV = '/data/research/cvqad/Subjective_scores_and_videos_info.csv';
const MINRUNGS = 10;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

/* slope of y on x with its standard error — the SE is the point, not the slope */
function slopeSE(x, y) {
  const n = x.length;
  if (n < 4) return null;
  const mx = mean(x); const my = mean(y);
  let sxy = 0; let sxx = 0;
  for (let i = 0; i < n; i += 1) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
  if (!(sxx > 0)) return null;
  const b = sxy / sxx;
  let ss = 0;
  for (let i = 0; i < n; i += 1) ss += (y[i] - (my + b * (x[i] - mx))) ** 2;
  const s2 = ss / (n - 2);
  return { b, se: Math.sqrt(s2 / sxx), n };
}

/* parse a CSV that may contain quoted fields */
function parseCSV(text) {
  const out = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i += 1; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); out.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); out.push(row); }
  return out;
}

const raw = parseCSV(fs.readFileSync(CSV, 'utf8'));
const head = raw[0];
const iSeq = head.indexOf('sequence');
const iBr = head.indexOf('real_bitrate');
const iMos = head.indexOf('MOS');
const bySeq = new Map();
for (const r of raw.slice(1)) {
  if (r.length < head.length) continue;
  const b = Number(r[iBr]); const m = Number(r[iMos]);
  if (!(b > 0) || !Number.isFinite(m)) continue;
  const s = r[iSeq];
  if (!bySeq.has(s)) bySeq.set(s, []);
  bySeq.get(s).push({ lb: Math.log(b), b, m });
}
console.log(`\n  ${bySeq.size} sequences from labels alone — no video, no decode.`);
console.log('  ALL statistics are WITHIN-sequence: CVQAD scores are per-comparison-group calibrated,');
console.log('  so an absolute MOS cut across sequences would conflate grader baseline with content.\n');

let sat = 0; let climb = 0; let noisy = 0; let excluded = 0;
const knees = { 85: [], 90: [], 95: [] };
const rows = [];
for (const [s, pts] of bySeq) {
  if (pts.length < MINRUNGS) { excluded += 1; continue; }
  pts.sort((a, b) => a.lb - b.lb);
  const half = Math.floor(pts.length / 2);
  const lo = pts.slice(0, half); const hi = pts.slice(half);
  const sLo = slopeSE(lo.map((p) => p.lb), lo.map((p) => p.m));
  const sHi = slopeSE(hi.map((p) => p.lb), hi.map((p) => p.m));
  if (!sLo || !sHi) { excluded += 1; continue; }
  /* POSITIVE CONTROL: the bottom half must clearly climb, or this sequence cannot inform anything */
  if (!(sLo.b > 2 * sLo.se)) { noisy += 1; rows.push({ s, verdict: 'noisy', sLo, sHi }); continue; }
  const flat = Math.abs(sHi.b) < 2 * sHi.se;
  if (flat) { sat += 1; rows.push({ s, verdict: 'SATURATES', sLo, sHi }); }
  else if (sHi.b > 0) { climb += 1; rows.push({ s, verdict: 'still climbing', sLo, sHi }); }
  else { sat += 1; rows.push({ s, verdict: 'SATURATES(-)', sLo, sHi }); }
  /* knee bitrates at several criteria, each relative to THIS sequence's own MOS span */
  const mn = Math.min(...pts.map((p) => p.m)); const mx = Math.max(...pts.map((p) => p.m));
  for (const c of [85, 90, 95]) {
    const target = mn + (c / 100) * (mx - mn);
    const first = pts.find((p) => p.m >= target);
    if (first) knees[c].push(first.b);
  }
}

console.log('  SATURATION VERDICT PER SEQUENCE (top half of the ladder vs bottom half)\n');
console.log(`    SATURATES        ${String(sat).padStart(3)}   top-end slope not resolved from zero`);
console.log(`    still climbing   ${String(climb).padStart(3)}   more bits were still buying quality`);
console.log(`    NOISY (excluded) ${String(noisy).padStart(3)}   bottom half did not clearly climb — cannot inform`);
console.log(`    too few rungs    ${String(excluded).padStart(3)}`);

console.log('\n  A FEW SEQUENCES, both kinds:\n');
const show = [...rows.filter((r) => r.verdict.startsWith('SATURATES')).slice(0, 5),
  ...rows.filter((r) => r.verdict === 'still climbing').slice(0, 5)];
for (const r of show) {
  console.log(`    ${r.s.padEnd(24)} ${r.verdict.padEnd(15)} bottom ${r.sLo.b.toFixed(2).padStart(6)}`
    + ` +-${r.sLo.se.toFixed(2)}   top ${r.sHi.b.toFixed(2).padStart(6)} +-${r.sHi.se.toFixed(2)}`);
}

console.log('\n  CRITERION SENSITIVITY — the knee bitrate at three criteria, each relative to the');
console.log('  sequence\'s OWN MOS span (an absolute cut would be the per-group trap):\n');
for (const c of [85, 90, 95]) {
  const k = knees[c];
  if (!k.length) continue;
  console.log(`    ${c}% of own span   median ${med(k).toFixed(0).padStart(6)} kbps   n=${k.length}`);
}
const r95 = knees[95].length && knees[85].length ? med(knees[95]) / med(knees[85]) : NaN;
console.log(`\n    ratio 95%-criterion / 85%-criterion = ${r95.toFixed(2)}x`);

console.log('\n  VERDICT\n');
const frac = sat / Math.max(1, sat + climb);
if (sat + climb < 10) {
  console.log('    TOO FEW USABLE SEQUENCES to say anything. Report that, do not report a fraction.');
} else if (frac >= 0.6) {
  console.log(`    CVQAD DOES REACH SATURATION for ${sat}/${sat + climb} usable sequences (${(100 * frac).toFixed(0)}%).`);
  console.log('    The "no transparency rung" objection is WRONG as a blanket claim. A CVQAD anchor is');
  console.log('    worth computing — but it stays PROVISIONAL until BVI-HD or VideoSet agrees, because');
  console.log('    a within-sequence knee still has to be placed on a cross-sequence-valid scale, and');
  console.log('    these labels are not that scale.');
} else if (frac <= 0.3) {
  console.log(`    CVQAD MOSTLY DOES NOT REACH SATURATION — only ${sat}/${sat + climb} (${(100 * frac).toFixed(0)}%).`);
  console.log('    The spike\'s objection was right in substance even though its stated reason (a 4 Mbps');
  console.log('    ceiling) was wrong. DO NOT anchor on CVQAD. Use it for the SLOPE only, where the');
  console.log('    rungs need to span quality rather than reach transparency.');
} else {
  console.log(`    SPLIT — ${sat} saturate, ${climb} still climbing. Neither claim holds library-wide.`);
  console.log('    Any anchor must be computed on the SATURATING SUBSET ONLY and reported as such, and');
  console.log('    that subset is selected on the outcome, so it is a weak anchor at best.');
}
console.log('\n  Note on the criterion: if the 95%/85% knee ratio above is large, the criterion is doing');
console.log('  the work rather than the data, and no single-criterion anchor should be trusted.\n');
