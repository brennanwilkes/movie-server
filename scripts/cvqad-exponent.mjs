/* TASK 100 — FIT THE COMPLEXITY EXPONENT `a` FROM EXTERNAL HUMAN LABELS.
 *
 * WHAT IS BEING FITTED AND WHY IT MATTERS MORE THAN ANYTHING ELSE STILL OPEN. BPP+ divides bits by
 * complexity raised to a power: target = complexity^a * bias * headroom, with a = 1 shipped and never
 * measured. Everything about a film's score above or below the median flows through it. Measured
 * size of the gap: BPP+ moves by 0.5*(1-a)*log(cxEff), which at a = 0.8 is -8.1%/+9.1% at p5-p95 and
 * +-23% worst-film — AND IT RE-RANKS, which no other open item does.
 *
 * THE IDENTIFYING IDEA. CVQAD gives human quality labels across a bitrate ladder for 60 source
 * sequences. For each sequence the labels say where quality reaches a criterion; call that bitrate
 * t_j. If a more complex source needs proportionally more bits, then t_j = K * c_j^a, so
 *     log t_j = log K + a * log c_j
 * and `a` is a slope over CONTENTS rather than over bitrates. c_j is OUR complexity, measured by
 * scripts/cvqad-complexity.js with the live probe recipe, so the fitted a is the one BPP+ ships.
 *
 * *** GT ONLY. THIS IS ENFORCED IN CODE, NOT LEFT TO DISCIPLINE. *** Core 9.0i measured that
 * compressed-rung proxies do not merely understate complexity, they COMPRESS THE COMPLEXITY AXIS:
 * log(proxy) = k + 0.757*log(GT), 2.21 SE below the harmless slope of 1. Fitting on proxies scales a
 * by 1/0.757 = 1.32, turning a true 0.80 into 1.06 — i.e. it manufactures agreement with the shipped
 * a = 1. That is the most seductive possible wrong answer, so the script REFUSES to fit on proxies.
 *
 * *** PRE-REGISTERED, WRITTEN BEFORE ANY NUMBER EXISTS. ***
 *  1. THE FORM IS TESTED BEFORE THE EXPONENT IS QUOTED. 9.0d warns that a fitted a < 1 can be an
 *     artifact of forcing a power law onto an additive one. Both are fitted IN LINEAR t UNITS so the
 *     AIC comparison is legitimate (fitting log t and fitting t are not AIC-comparable without a
 *     Jacobian correction — doing it in one response space avoids that entirely).
 *     If neither form wins by dAIC >= 2, NO EXPONENT IS QUOTED AS SETTLED.
 *  2. STABILITY ACROSS THE CRITERION IS A PASS CONDITION, NOT A ROBUSTNESS FOOTNOTE. 9.0c measured
 *     that CVQAD mostly does not saturate and that the criterion RE-RANKS contents (rank corr 0.324
 *     between 75% and 95%). So a is reported at q = 0.50 / 0.60 / 0.75 / 0.90 of each sequence's own
 *     label range. If a moves by more than its own bootstrap SE across that sweep, the estimate is a
 *     property of the criterion and not of the content, and it must not be adopted.
 *  3. CODEC IS A CONTROL, NOT A CHOICE. The primary fit is x264 (45 matched sequences, and ~80% of
 *     the library is h264). x265-ref (34) and svt-hevc (30) are fitted separately. `a` is a claim
 *     about CONTENT; if it swings with the encoder it is not that claim.
 *  4. ADOPTION BAR, stated now: a is adopted over the shipped a = 1 only if the power form wins on
 *     AIC, a is stable across the criterion sweep, the three codecs agree within their SEs, and the
 *     bootstrap CI on the pooled a EXCLUDES 1. Anything less is reported and not shipped.
 *
 * HONEST LIMIT THAT NO AMOUNT OF n FIXES. CVQAD clips are 10-15s of mostly UGC and sports at 1080p;
 * the library is feature films. The exponent is a claim about how bit-need scales with complexity,
 * which is a codec-and-content property rather than a genre one, but the transfer is an assumption
 * and is recorded as such rather than tested here.
 *
 * READ-ONLY. USAGE: node scripts/cvqad-exponent.mjs [--codec x264] [--boot 2000]
 */
import fs from 'fs';

const CSV = '/data/research/cvqad/Subjective_scores_and_videos_info.csv';
const CXF = 'data/cvqad-complexity.json';
const QS = [0.50, 0.60, 0.75, 0.90];
const CODECS = ['x264', 'x265-ref', 'svt-hevc'];
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const NBOOT = Number(arg('--boot', 2000));

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function fit(x, y) {
  const n = x.length; const mx = mean(x); const my = mean(y);
  let sxy = 0; let sxx = 0;
  for (let i = 0; i < n; i += 1) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
  const b = sxy / sxx; const a = my - b * mx;
  let ss = 0; let tt = 0;
  for (let i = 0; i < n; i += 1) { ss += (y[i] - (a + b * x[i])) ** 2; tt += (y[i] - my) ** 2; }
  return { a, b, se: Math.sqrt((ss / (n - 2)) / sxx), r2: 1 - ss / tt, n, ss };
}
const aic = (ss, n, p) => n * Math.log(ss / n) + 2 * p;

/* ---- complexity, GT ONLY (9.0i) ---------------------------------------------------------- */
const cxRaw = JSON.parse(fs.readFileSync(CXF, 'utf8')).units;
const CX = new Map();
let nProxyDropped = 0;
for (const u of Object.values(cxRaw)) {
  if (u.kind === 'gt') CX.set(u.seq, u.cx);
  else nProxyDropped += 1;
}

/* ---- labels ------------------------------------------------------------------------------ */
const lines = fs.readFileSync(CSV, 'utf8').trim().split('\n');
const H = lines[0].split(',');
const iSeq = H.indexOf('sequence'); const iCodec = H.indexOf('codec');
const iRate = H.indexOf('real_bitrate'); const iMos = H.indexOf('MOS');
const lab = new Map();                                     /* `${seq}|${codec}` -> [{r, mos}] */
for (const l of lines.slice(1)) {
  const c = l.split(',');
  const r = Number(c[iRate]); const m = Number(c[iMos]);
  if (!(r > 0) || !Number.isFinite(m)) continue;
  const k = `${c[iSeq]}|${c[iCodec]}`;
  if (!lab.has(k)) lab.set(k, []);
  lab.get(k).push({ r, mos: m });
}

/* Threshold bitrate at criterion q, as a fraction of THIS sequence's own label range. An absolute
 * MOS cut is unusable because 9.0c measured that most sequences never reach transparency, and MOS is
 * not comparable across contents anyway. Linear interpolation in log(bitrate) at the FIRST upward
 * crossing — no functional form is imposed on the rate-quality curve here. */
function threshold(pts, q) {
  const p = [...pts].sort((a, b) => a.r - b.r);
  if (p.length < 3) return null;
  const lo = Math.min(...p.map((x) => x.mos)); const hi = Math.max(...p.map((x) => x.mos));
  if (!(hi > lo)) return null;
  const tgt = lo + q * (hi - lo);
  for (let i = 0; i < p.length - 1; i += 1) {
    if (p[i].mos <= tgt && p[i + 1].mos >= tgt) {
      const f = (tgt - p[i].mos) / (p[i + 1].mos - p[i].mos || 1e-9);
      return Math.exp(Math.log(p[i].r) + f * (Math.log(p[i + 1].r) - Math.log(p[i].r)));
    }
  }
  return null;
}

console.log(`\n  ${CX.size} sequences with GT complexity  (${nProxyDropped} proxy measurements DROPPED — 9.0i)\n`);
if (CX.size < 20) {
  console.log('  *** TOO FEW GT MEASUREMENTS TO FIT. Run scripts/cvqad-complexity.js to completion first.');
  console.log('  Refusing to fall back to proxies: 9.0i measured that they bias `a` toward the shipped');
  console.log('  value of 1, which is the one wrong answer that would look like a confirmation. ***\n');
  process.exit(0);
}

/* ---- the criterion sweep, per codec ------------------------------------------------------ */
const table = [];
for (const codec of CODECS) {
  for (const q of QS) {
    const pts = [];
    for (const [seq, c] of CX) {
      const t = threshold(lab.get(`${seq}|${codec}`) || [], q);
      if (t > 0) pts.push({ seq, c, t });
    }
    if (pts.length < 8) { table.push({ codec, q, n: pts.length, skip: true }); continue; }
    const F = fit(pts.map((p) => Math.log(p.c)), pts.map((p) => Math.log(p.t)));
    /* bootstrap over SEQUENCES, which is the unit of independence here */
    let rng = 987654321;
    const rnd = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    const bs = [];
    for (let b = 0; b < NBOOT; b += 1) {
      const s = Array.from({ length: pts.length }, () => pts[Math.floor(rnd() * pts.length)]);
      const f = fit(s.map((p) => Math.log(p.c)), s.map((p) => Math.log(p.t)));
      if (Number.isFinite(f.b)) bs.push(f.b);
    }
    bs.sort((x, y) => x - y);
    table.push({ codec, q, n: pts.length, a: F.b, se: F.se, r2: F.r2,
      lo: bs[Math.floor(0.025 * bs.length)], hi: bs[Math.floor(0.975 * bs.length)], pts });
  }
}

console.log('  CRITERION SWEEP — `a` per codec per criterion  (q = fraction of each sequence\'s own MOS range)\n');
console.log(`    ${'codec'.padEnd(10)} ${'q'.padStart(5)} ${'n'.padStart(4)} ${'a'.padStart(8)} ${'SE'.padStart(7)} ${'95% CI'.padStart(16)} ${'r2'.padStart(6)}`);
for (const r of table) {
  if (r.skip) { console.log(`    ${r.codec.padEnd(10)} ${r.q.toFixed(2).padStart(5)} ${String(r.n).padStart(4)}   too few sequences`); continue; }
  console.log(`    ${r.codec.padEnd(10)} ${r.q.toFixed(2).padStart(5)} ${String(r.n).padStart(4)} ${r.a.toFixed(3).padStart(8)}`
    + ` ${r.se.toFixed(3).padStart(7)} ${`[${r.lo.toFixed(2)}, ${r.hi.toFixed(2)}]`.padStart(16)} ${r.r2.toFixed(3).padStart(6)}`);
}

/* ---- PRE-REGISTRATION 1: the FORM, before the exponent -------------------------------------- */
console.log('\n  MODEL FORM — power vs additive, BOTH IN LINEAR t SO THE AIC IS LEGITIMATE\n');
const formRows = [];
for (const r of table.filter((x) => !x.skip && x.q === 0.75)) {
  const c = r.pts.map((p) => p.c); const t = r.pts.map((p) => p.t);
  /* additive: t = k + m*c, ordinary least squares */
  const A = fit(c, t);
  /* power: t = K * c^a. Fit in log space then evaluate SS in LINEAR t, so both models are scored
   * on the same response. This costs the power model some fit and is the conservative direction. */
  const L = fit(c.map(Math.log), t.map(Math.log));
  let ssP = 0;
  for (let i = 0; i < c.length; i += 1) ssP += (t[i] - Math.exp(L.a + L.b * Math.log(c[i]))) ** 2;
  const aicA = aic(A.ss, c.length, 2); const aicP = aic(ssP, c.length, 2);
  const d = aicA - aicP;
  formRows.push({ codec: r.codec, d });
  console.log(`    ${r.codec.padEnd(10)} AIC additive ${aicA.toFixed(1).padStart(9)}   AIC power ${aicP.toFixed(1).padStart(9)}   `
    + `dAIC ${d.toFixed(1).padStart(7)}  ${Math.abs(d) < 2 ? 'TIE — no form wins' : (d > 0 ? 'POWER wins' : 'ADDITIVE wins')}`);
}
const formVerdict = formRows.every((r) => r.d >= 2) ? 'POWER'
  : formRows.every((r) => r.d <= -2) ? 'ADDITIVE' : 'UNDECIDED';
console.log(`\n    FORM VERDICT: ${formVerdict}`);

/* ---- PRE-REGISTRATION 2: stability across the criterion ------------------------------------- */
console.log('\n  CRITERION STABILITY — is `a` a property of the content or of the cut?\n');
let stable = true;
for (const codec of CODECS) {
  const rs = table.filter((r) => r.codec === codec && !r.skip);
  if (rs.length < 2) continue;
  const as = rs.map((r) => r.a); const spread = Math.max(...as) - Math.min(...as);
  const typSE = mean(rs.map((r) => r.se));
  const ok = spread <= typSE;
  if (!ok) stable = false;
  console.log(`    ${codec.padEnd(10)} a ranges ${Math.min(...as).toFixed(3)} to ${Math.max(...as).toFixed(3)}`
    + `  spread ${spread.toFixed(3)}  vs typical SE ${typSE.toFixed(3)}   ${ok ? 'STABLE' : '*** CRITERION-DEPENDENT ***'}`);
}

/* ---- PRE-REGISTRATION 3: codec agreement ---------------------------------------------------- */
console.log('\n  CODEC AGREEMENT at q = 0.75 — `a` is a claim about CONTENT, not about the encoder\n');
const at75 = table.filter((r) => !r.skip && r.q === 0.75);
for (const r of at75) console.log(`    ${r.codec.padEnd(10)} a ${r.a.toFixed(3)} +- ${r.se.toFixed(3)}   n ${r.n}`);
let agree = true;
for (let i = 0; i < at75.length; i += 1) {
  for (let j = i + 1; j < at75.length; j += 1) {
    const t = Math.abs(at75[i].a - at75[j].a) / Math.sqrt(at75[i].se ** 2 + at75[j].se ** 2);
    if (t > 2) { agree = false; console.log(`    *** ${at75[i].codec} vs ${at75[j].codec} differ by ${t.toFixed(1)} SE ***`); }
  }
}
if (agree) console.log('    all pairs agree within 2 SE');

/* ---- PRE-REGISTRATION 4: the adoption bar --------------------------------------------------- */
console.log('\n  VERDICT AGAINST THE ADOPTION BAR\n');
const prim = at75.find((r) => r.codec === 'x264');
const excludes1 = prim && (prim.lo > 1 || prim.hi < 1);
console.log(`    primary (x264, q=0.75):  a = ${prim ? prim.a.toFixed(3) : 'n/a'}`
  + `${prim ? ` +- ${prim.se.toFixed(3)}, 95% CI [${prim.lo.toFixed(2)}, ${prim.hi.toFixed(2)}]` : ''}`);
console.log(`    form is POWER ................. ${formVerdict === 'POWER' ? 'yes' : `NO (${formVerdict})`}`);
console.log(`    stable across the criterion ... ${stable ? 'yes' : 'NO'}`);
console.log(`    codecs agree .................. ${agree ? 'yes' : 'NO'}`);
console.log(`    CI excludes the shipped a = 1 . ${excludes1 ? 'yes' : 'NO'}`);
if (formVerdict === 'POWER' && stable && agree && excludes1) {
  console.log(`\n    *** ALL FOUR CONDITIONS MET. a = ${prim.a.toFixed(3)} is ADOPTABLE over the shipped 1. ***`);
  const shift = (b) => 0.5 * (1 - prim.a) * Math.log(b);
  console.log(`    Score impact: BPP+ multiplies by exp(0.5*(1-a)*log cxEff).`);
  console.log(`      cxEff 0.05 -> x${Math.exp(shift(0.05)).toFixed(3)}     cxEff 0.50 -> x${Math.exp(shift(0.50)).toFixed(3)}`);
} else {
  console.log('\n    *** NOT ADOPTABLE. Report the number, do NOT ship it. The shipped a = 1 stands');
  console.log('    until every condition above is met — this is the same bar that has already');
  console.log('    retracted three headline numbers in this project. ***');
}
console.log('');
