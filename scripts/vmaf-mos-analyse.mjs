/* TASK 106 — DOES VMAF FLATTER COMPLEX CONTENT? The co-tuning arbiter, and the exponent correction.
 *
 * WHY. The 9.0n pre-flight put a = 1.012 +- 0.049 and showed a = 0.47 would need 5.3x more quality
 * drift than exists. But cxEff IS the CRF-20 bitrate, so that result leans on CRF holding VMAF
 * constant — and x265's AQ/psy-rd overlap VMAF's own features. "CRF holds VMAF constant" may be
 * METRIC-ENCODER ALIGNMENT rather than human vision. Humans are not co-tuned with x265, so CVQAD's
 * MOS labels on the IDENTICAL encodes are the control.
 *
 *     MOS = alpha + beta*VMAF + phi*log(cx) + group FE + codec FE
 *
 * phi is the whole test. VMAF is supposed to be a sufficient statistic for human opinion; if it is,
 * complexity adds nothing once VMAF is known and phi = 0. If phi < 0, VMAF FLATTERS complex content.
 *
 * *** phi PRICES THE BIAS IN THE UNITS OF THE DISPUTED PARAMETER, WHICH IS THE POINT. ***
 *     a_true = a_VMAF + phi / gamma_MOS,   gamma_MOS = dMOS/dlog(bitrate) = 1.5088 (9.0l)
 * So this does not merely flag a problem, it converts it into an exponent correction.
 *
 * *** PRE-REGISTERED, WRITTEN BEFORE THE DATA IS COMPLETE. ***
 *   |phi| < 1 SE          VMAF unbiased along complexity here; the VMAF route stands and the
 *                         exponent closes near a = 1.
 *   phi < 0, |t| > 2      VMAF flatters complex content. Report a_true, corrected. Bracket narrows.
 *   phi > 0, |t| > 2      VMAF PENALISES complex content -> a_true ABOVE 1, contradicting the
 *                         literature prior AND every CVQAD fit. Treat as a RED FLAG on the whole
 *                         VMAF route, not as a result.
 * AND THE INFORMATIVENESS GUARD, because a null here is only meaningful if the design could have
 * detected something: report the SE of phi in exponent units. If SE/gamma_MOS is itself larger than
 * the 0.47-0.94 bracket, "phi = 0" is not evidence of no bias, it is an underpowered test. That
 * distinction has been blurred before in this project and is made explicit here.
 *
 * SECONDARY — the grain leg #73 has been waiting for. VMAF's documented weakness is film grain, so
 * if the bias is real it should concentrate in grainy content. Grain per sequence is taken from
 * measured.json's TOP-BITRATE rung, which is the closest available stand-in for source grain (the
 * complexity probe never measured grain on the GT masters -> that is a gap, stated not hidden).
 *
 * READ-ONLY. USAGE: node scripts/vmaf-mos-analyse.mjs [--min-rungs 40]
 */
import fs from 'fs';

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const MIN = Number(arg('--min-rungs', 40));
const GAMMA_MOS = 1.5088;
const BRACKET = [0.47, 0.94];
const A_VMAF = 1.012;

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function ols(X, y) {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i += 1) {
    for (let a = 0; a < p; a += 1) { b[a] += X[i][a] * y[i]; for (let c = 0; c < p; c += 1) A[a][c] += X[i][a] * X[i][c]; }
  }
  const n = p;
  const M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c += 1) {
    let piv = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) M[c][c] = 1e-12;
    const d = M[c][c];
    for (let k = 0; k < 2 * n; k += 1) M[c][k] /= d;
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r][c];
      for (let k = 0; k < 2 * n; k += 1) M[r][k] -= f * M[c][k];
    }
  }
  const inv = M.map((r) => r.slice(n));
  const be = inv.map((r) => r.reduce((s, v, j) => s + v * b[j], 0));
  let ss = 0; let tt = 0; const my = mean(y);
  for (let i = 0; i < X.length; i += 1) {
    const f = X[i].reduce((s, z, j) => s + z * be[j], 0); ss += (y[i] - f) ** 2; tt += (y[i] - my) ** 2;
  }
  const s2 = ss / (X.length - p);
  return { be, se: be.map((_, i) => Math.sqrt(s2 * inv[i][i])), r2: 1 - ss / tt, n: X.length };
}

/* ---- join: VMAF rungs -> MOS labels ------------------------------------------------------- */
const V = JSON.parse(fs.readFileSync('data/vmaf-rungs.json', 'utf8')).units;
const lines = fs.readFileSync('/data/research/cvqad/Subjective_scores_and_videos_info.csv', 'utf8').trim().split('\n');
const H = lines[0].split(','); const I = (n) => H.indexOf(n);
const lab = new Map();
for (const l of lines.slice(1)) {
  const c = l.split(',');
  const k = `${c[I('sequence')]}|${c[I('preset')]}|${c[I('codec')]}|${Math.round(+c[I('crf')])}`;
  lab.set(k, { mos: +c[I('MOS')], grp: c[I('comparison')], codec: c[I('codec')], rate: +c[I('real_bitrate')] });
}
/* grain per sequence from the top-bitrate rung of measured.json — stand-in for source grain */
const grain = new Map();
try {
  const M = JSON.parse(fs.readFileSync('/data/research/cvqad/measured.json', 'utf8'));
  const arr = Array.isArray(M) ? M : Object.values(M.units || M);
  const best = new Map();
  for (const u of arr) {
    if (!u.seq || !(u.grain > 0)) continue;
    const cur = best.get(u.seq);
    if (!cur || (u.renderKbps || 0) > (cur.renderKbps || 0)) best.set(u.seq, u);
  }
  for (const [s, u] of best) grain.set(s, u.grain);
} catch { /* optional */ }

const rows = [];
for (const [file, u] of Object.entries(V)) {
  const m = /^(.+?)__(.+?)__(.+?)_(\d+)\.mp4$/.exec(file);
  if (!m) continue;
  const L = lab.get(`${m[1]}|${m[2]}|${m[3]}|${m[4]}`);
  if (!L || !Number.isFinite(L.mos) || !(u.cx > 0) || !(u.vmaf >= 0)) continue;
  rows.push({ seq: u.seq, cx: u.cx, vmaf: u.vmaf, neg: u.vmafNeg, mos: L.mos,
    grp: L.grp, codec: L.codec, rate: L.rate, grain: grain.get(u.seq) });
}
const seqs = [...new Set(rows.map((r) => r.seq))];
console.log(`\n  ${rows.length} rungs joined to a MOS label, over ${seqs.size || seqs.length} sequences`);
console.log(`  (${Object.keys(V).length} scored so far; grain available for ${rows.filter((r) => r.grain > 0).length})\n`);
/* *** THE GATE IS ON SEQUENCE COVERAGE, NOT ROW COUNT — the first version got this wrong. ***
 * phi is identified ACROSS sequences, so the risk in a partial run is that the covered sequences
 * are an unrepresentative slice of the complexity axis. Row count does not measure that: 81 rows
 * from 15 sequences is 15 independent draws on the regressor, not 81. The run processes sequences
 * in NAME ORDER, which is arbitrary with respect to complexity but not guaranteed representative,
 * so the coverage is reported and compared rather than trusted. */
const cxAll = Object.values(JSON.parse(fs.readFileSync('data/cvqad-complexity.json', 'utf8')).units)
  .filter((u) => u.kind === 'gt' && u.cx > 0);
const covered = new Set(rows.map((r) => r.seq));
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const lc = (u) => Math.log(u.cx);
const inS = cxAll.filter((u) => covered.has(u.seq)); const outS = cxAll.filter((u) => !covered.has(u.seq));
const frac = covered.size / cxAll.length;
console.log(`  SEQUENCE COVERAGE ${covered.size}/${cxAll.length} (${(100 * frac).toFixed(0)}%)`
  + `   sd(log cx) covered ${sd(inS.map(lc)).toFixed(3)}`
  + (outS.length ? ` vs remaining ${sd(outS.map(lc)).toFixed(3)}` : '')
  + `   mean log cx ${mean(inS.map(lc)).toFixed(3)}`
  + (outS.length ? ` vs ${mean(outS.map(lc)).toFixed(3)}` : '') + '\n');
if (frac < 0.8) {
  console.log(`  *** ONLY ${(100 * frac).toFixed(0)}% OF SEQUENCES COVERED — below the 80% floor. ***`);
  console.log('  Plumbing is exercised below, but TREAT EVERY COEFFICIENT AS PROVISIONAL. phi is a');
  console.log('  cross-sequence slope, so the effective n is the SEQUENCE count, not the row count.');
  console.log('  Compare the two sd(log cx) figures above: if they differ materially, the covered');
  console.log('  slice is not representative and the partial phi is not even indicative.\n');
}
if (rows.length < MIN) { console.log(`  only ${rows.length} rows — nothing to fit\n`); process.exit(0); }

const GR = [...new Set(rows.map((r) => r.grp))].sort();
const CO = [...new Set(rows.map((r) => r.codec))].sort();
const design = (rs, vkey) => rs.map((r) => [1, r[vkey], Math.log(r.cx),
  ...GR.slice(1).map((g) => (r.grp === g ? 1 : 0)),
  ...CO.slice(1).map((c) => (r.codec === c ? 1 : 0))]);

console.log('  MOS = alpha + beta*VMAF + phi*log(cx) + group FE + codec FE\n');
const out = {};
for (const vkey of ['vmaf', 'neg']) {
  const rs = rows.filter((r) => Number.isFinite(r[vkey]));
  if (rs.length < MIN) continue;
  const f = ols(design(rs, vkey), rs.map((r) => r.mos));
  const phi = f.be[2]; const se = f.se[2];
  out[vkey] = { phi, se, t: phi / se, beta: f.be[1], r2: f.r2, n: rs.length };
  console.log(`    ${vkey === 'vmaf' ? 'VMAF v0.6.1' : 'VMAF NEG   '}  n ${String(rs.length).padStart(4)}`
    + `  beta ${f.be[1].toFixed(4)}  phi ${phi.toFixed(4)} +- ${se.toFixed(4)}  t ${(phi / se).toFixed(2).padStart(6)}`
    + `  r2 ${f.r2.toFixed(3)}`);
}

console.log('\n  THE INFORMATIVENESS GUARD — a null only counts if the design could have seen something\n');
for (const [k, v] of Object.entries(out)) {
  const seA = Math.abs(v.se / GAMMA_MOS);
  const span = BRACKET[1] - BRACKET[0];
  console.log(`    ${k.padEnd(5)} SE(phi) in exponent units = ${seA.toFixed(3)}`
    + `   vs the disputed bracket width ${span.toFixed(2)}`
    + `   ${seA < span / 2 ? 'POWERED' : '*** UNDERPOWERED — a null here is not evidence of no bias ***'}`);
}

console.log('\n  VERDICT AGAINST THE PRE-REGISTRATION\n');
for (const [k, v] of Object.entries(out)) {
  const aTrue = A_VMAF + v.phi / GAMMA_MOS;
  const aSe = Math.abs(v.se / GAMMA_MOS);
  let verdict;
  if (Math.abs(v.t) < 1) verdict = 'phi indistinguishable from 0 -> VMAF unbiased along complexity';
  else if (Math.abs(v.t) < 2) verdict = 'phi not significant at |t|>2 -> no correction claimed';
  else if (v.phi < 0) verdict = 'VMAF FLATTERS complex content -> correct a downward';
  else verdict = '*** phi > 0: a_true ABOVE 1, contradicting literature AND every CVQAD fit — RED FLAG on the VMAF route ***';
  console.log(`    ${k.padEnd(5)} ${verdict}`);
  console.log(`          a_VMAF ${A_VMAF.toFixed(3)}  ->  a_true ${aTrue.toFixed(3)} +- ${aSe.toFixed(3)}`
    + `   (correction ${(v.phi / GAMMA_MOS >= 0 ? '+' : '')}${(v.phi / GAMMA_MOS).toFixed(3)})`);
}

/* ---- grain leg -------------------------------------------------------------------------- */
const withG = rows.filter((r) => r.grain > 0);
if (withG.length >= MIN) {
  const med = [...withG.map((r) => r.grain)].sort((a, b) => a - b)[Math.floor(withG.length / 2)];
  console.log(`\n  GRAIN LEG (task 73) — split at median source-proxy grain ${med.toFixed(3)}\n`);
  for (const [name, sub] of [['grainy', withG.filter((r) => r.grain >= med)], ['clean', withG.filter((r) => r.grain < med)]]) {
    if (sub.length < 20) { console.log(`    ${name.padEnd(7)} n ${sub.length} — too few`); continue; }
    const G2 = [...new Set(sub.map((r) => r.grp))].sort(); const C2 = [...new Set(sub.map((r) => r.codec))].sort();
    const X = sub.map((r) => [1, r.vmaf, Math.log(r.cx),
      ...G2.slice(1).map((g) => (r.grp === g ? 1 : 0)), ...C2.slice(1).map((c) => (r.codec === c ? 1 : 0))]);
    if (sub.length < X[0].length + 5) { console.log(`    ${name.padEnd(7)} n ${sub.length} — too few for the design`); continue; }
    const f = ols(X, sub.map((r) => r.mos));
    console.log(`    ${name.padEnd(7)} n ${String(sub.length).padStart(4)}  phi ${f.be[2].toFixed(4)} +- ${f.se[2].toFixed(4)}`
      + `  t ${(f.be[2] / f.se[2]).toFixed(2)}`);
  }
  console.log('\n    If the bias is real it should concentrate in GRAINY content — that is VMAF\'s');
  console.log('    documented weakness. If phi is the same in both strata, the mechanism is not grain.');
}
console.log('');
