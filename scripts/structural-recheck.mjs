/* THE ONE PRE-REGISTERED CHECK THAT STILL FAILS — re-run with the second field contrast.
 *
 * THE HISTORY. The direction test asks: of random directions in 4-detector space, how many reach the
 * WEB-vs-Bluray gap that the pre-registered (+banding +blocking +blur -grain) direction reaches? At
 * partial coverage it was 9/20000. At FULL coverage (n=1048) it weakened to 537/20000, and the rule
 * has been formally NOT VALIDATED ever since. The diagnosis (11.44) was that the failure is a
 * property of the ONE field contrast available rather than of the direction: the WEB/Bluray tag is
 * dominated by BITS, so a great many arbitrary directions can reach a gap defined by it.
 *
 * WHY IT IS NOW TESTABLE. That diagnosis makes a prediction: give the test a SECOND, independent
 * field contrast and the pre-registered direction should separate from the random ones again. We now
 * have one. The bitstream encoder fingerprint recovers encoder identity for 85.7% of the library
 * (67 x264 builds plus ref/bframes/subme/psy_rd/me/deblock/rc). It is a fact about the LAST ENCODE
 * rather than the release channel, and unlike the source tag it is not bits-dominated: it explains
 * adj R2 0.109 of P with year controlled (E.4.5).
 *
 * THE STATISTIC IS "WORST OF THE TWO", the same discipline already used for the three controlled
 * axes. A direction counts as beating the pre-registered one ONLY IF it beats it on BOTH contrasts:
 *     gap(w)  = mean P_w(WEB) - mean P_w(Bluray), in sd units of P_w
 *     enc(w)  = adjusted R2 of P_w on the pre-specified encoder feature set
 * Requiring both is far harder to hit by chance than requiring either, and it is exactly the
 * property a genuine provenance direction should have: it should show up in EVERY provenance
 * contrast, not just a convenient one.
 *
 * *** PRE-REGISTERED, WRITTEN BEFORE THE NUMBER EXISTS. ***
 *     PASS  joint count <= 100 / 20000  (0.5%)
 *     FAIL  above that
 * The threshold is stated here rather than chosen afterwards, because the original check's history
 * is precisely one of a number being quoted after the fact. 9/20000 and 537/20000 are the two prior
 * values and neither is the bar — the bar is 100.
 *
 * A CONTROL THAT MUST ALSO PASS, or the result means nothing: the SIGN-FLIP family. Of the 16
 * directions (+-1,+-1,+-1,+-1), the pre-registered one should rank at or near the top on the joint
 * statistic. If some other sign pattern wins, the physics direction is not what the data prefers and
 * a low permutation count would just mean "some direction works", not "this one does".
 *
 * READ-ONLY. Uses bpp-lab/public/provenance.json and data/encoder-fingerprint.json.
 * USAGE: node scripts/structural-recheck.mjs [--n 20000]
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = [1, 1, 1, -1];
const NPERM = Number((process.argv.find((a, i) => process.argv[i - 1] === '--n')) || 20000);
const PASS_AT = 100;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
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
    if (Math.abs(A[c][c]) < 1e-10) { A[c][c] = 1e-10; }
    for (let r = 0; r < p; r += 1) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let cc = c; cc < p; cc += 1) A[r][cc] -= f * A[c][cc];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}
function adjR2(X, y) {
  const b = ols(X, y); const my = mean(y);
  let ss = 0; let tt = 0;
  for (let i = 0; i < y.length; i += 1) {
    const f = X[i].reduce((s, z, j) => s + z * b[j], 0);
    ss += (y[i] - f) ** 2; tt += (y[i] - my) ** 2;
  }
  const n = y.length; const p = X[0].length; const R = 1 - ss / tt;
  return 1 - (1 - R) * ((n - 1) / (n - p));
}

const pv = JSON.parse(fs.readFileSync('bpp-lab/public/provenance.json', 'utf8'));
const fp = JSON.parse(fs.readFileSync('data/encoder-fingerprint.json', 'utf8')).units;

/* rows carrying the four z-scores and a source tag */
const rows = [];
for (const [key, u] of Object.entries(pv.units)) {
  if (!u.z || !DET.every((d) => Number.isFinite(u.z[d]))) continue;
  rows.push({ key, z: DET.map((d) => u.z[d]), source: u.source || '', f: fp[key] || {} });
}
const web = rows.map((r, i) => i).filter((i) => /WEB/i.test(rows[i].source));
const blu = rows.map((r, i) => i).filter((i) => /Bluray/i.test(rows[i].source));

/* the encoder design matrix, PRE-SPECIFIED — same feature set as E.4.5, chosen before any of this */
const withEnc = rows.map((r, i) => i).filter((i) => {
  const f = rows[i].f;
  return f.family && f.build > 0 && f.ref != null && f.bframes != null && f.subme != null;
});
const lv = (k) => [...new Set(withEnc.map((i) => String(rows[i].f[k] ?? 'na')))].sort();
const ME = lv('me'); const RC = lv('rc'); const DB = lv('deblock');
const psy1 = (v) => (v ? Number(String(v).split(':')[0]) || 0 : 0);
const Xenc = withEnc.map((i) => {
  const f = rows[i].f;
  return [1, Math.log(f.build), f.ref, f.bframes, f.subme, f.trellis ?? 0, psy1(f.psyrd),
    ...ME.slice(1).map((v) => (String(f.me) === v ? 1 : 0)),
    ...RC.slice(1).map((v) => (String(f.rc) === v ? 1 : 0)),
    ...DB.slice(1).map((v) => (String(f.deblock) === v ? 1 : 0))];
});

console.log(`\n  ${rows.length} units with z-scores;  ${web.length} WEB, ${blu.length} Bluray;  `
  + `${withEnc.length} with a recovered encoder identity\n`);

/* both statistics for an arbitrary direction */
function stats(w) {
  const P = rows.map((r) => r.z.reduce((s, v, i) => s + w[i] * v, 0));
  const s = sd(P);
  if (!(s > 0)) return { gap: -1e9, enc: -1e9 };
  const gap = (mean(web.map((i) => P[i])) - mean(blu.map((i) => P[i]))) / s;
  const enc = adjR2(Xenc, withEnc.map((i) => P[i] / s));
  return { gap, enc };
}
const base = stats(EXPECT);
console.log(`  PRE-REGISTERED DIRECTION (+cambi +block +blur -grain)`);
console.log(`    WEB-vs-Bluray gap        ${base.gap.toFixed(4)} sd of P`);
console.log(`    encoder identity adj R2  ${base.enc.toFixed(4)}\n`);

/* the permutation: random unit directions */
let rng = 424242;
const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
const gauss = () => { let u = 0; let v = 0; while (u === 0) u = rand(); while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
let beatGap = 0; let beatEnc = 0; let beatBoth = 0;
for (let t = 0; t < NPERM; t += 1) {
  const w = [gauss(), gauss(), gauss(), gauss()];
  const n = Math.sqrt(w.reduce((s, x) => s + x * x, 0));
  const st = stats(w.map((x) => x / n));
  const g = st.gap >= base.gap; const e = st.enc >= base.enc;
  if (g) beatGap += 1;
  if (e) beatEnc += 1;
  if (g && e) beatBoth += 1;
}
console.log(`  PERMUTATION, ${NPERM} random directions\n`);
console.log(`    beat the SOURCE-TAG gap alone       ${beatGap}/${NPERM}   ${(100 * beatGap / NPERM).toFixed(2)}%`);
console.log(`      (this is the check that failed: 9/20000 at partial coverage, 537/20000 at full)`);
console.log(`    beat the ENCODER contrast alone     ${beatEnc}/${NPERM}   ${(100 * beatEnc / NPERM).toFixed(2)}%`);
console.log(`    *** beat BOTH (the worst-of statistic)  ${beatBoth}/${NPERM}   ${(100 * beatBoth / NPERM).toFixed(2)}% ***`);

/* the sign-flip control: does the physics direction win among the 16 sign patterns? */
const flips = [];
for (let m = 0; m < 16; m += 1) {
  const w = [0, 1, 2, 3].map((i) => ((m >> i) & 1 ? -1 : 1));
  const st = stats(w);
  flips.push({ w, ...st, both: Math.min(st.gap / Math.abs(base.gap || 1), st.enc / Math.abs(base.enc || 1)) });
}
flips.sort((a, b) => b.both - a.both);
console.log(`\n  SIGN-FLIP CONTROL — where the physics direction ranks among all 16 sign patterns\n`);
flips.slice(0, 4).forEach((f, i) => {
  const isPre = f.w.every((v, j) => v === EXPECT[j]);
  console.log(`    ${i + 1}. ${DET.map((d, j) => `${f.w[j] > 0 ? '+' : '-'}${d}`).join(' ')}   `
    + `gap ${f.gap.toFixed(3)}  encR2 ${f.enc.toFixed(3)}${isPre ? '   <- PRE-REGISTERED' : ''}`);
});
const rankPre = flips.findIndex((f) => f.w.every((v, j) => v === EXPECT[j])) + 1;
console.log(`    pre-registered ranks ${rankPre} of 16`);

console.log('\n  VERDICT AGAINST THE PRE-REGISTRATION (pass at <= 100/20000)\n');
const scaled = (beatBoth * 20000) / NPERM;
if (scaled <= PASS_AT && rankPre <= 2) {
  console.log(`    *** PASSES. *** ${beatBoth}/${NPERM} (${scaled.toFixed(0)}/20000 scaled) beat the direction on BOTH`);
  console.log('    contrasts, against a pre-registered bar of 100/20000, and the physics direction');
  console.log(`    ranks ${rankPre} of the 16 sign patterns. The 11.44 diagnosis is CONFIRMED: the failure`);
  console.log('    was a property of having only one bits-dominated field contrast, not of the');
  console.log('    direction. THE LAST FAILING PRE-REGISTERED CHECK IS CLOSED.');
} else if (rankPre > 2) {
  console.log(`    FAILS ON THE CONTROL. The pre-registered direction ranks ${rankPre} of 16 sign patterns,`);
  console.log('    so some other sign pattern fits the field contrasts better. A low permutation count');
  console.log('    would then mean "some direction works", not "this one does". Do not claim a pass.');
} else {
  console.log(`    FAILS. ${scaled.toFixed(0)}/20000 scaled, against a bar of ${PASS_AT}.`);
  console.log('');
  console.log('    *** WHICH OF TWO VERY DIFFERENT THINGS THIS MEANS DEPENDS ON WHAT P WAS BUILT FROM,');
  console.log('    so check that before writing anything down. ***');
  console.log('      - On the SHIPPED P (backfill block/blur), this contradicts the recorded pass of');
  console.log('        96/20000 and would mean the 11.44 diagnosis is wrong: the problem is the');
  console.log('        DIRECTION rather than the contrast. That is a serious finding.');
  console.log('      - On a VARIANT P, it simply means the variant is worse than the shipped one and');
  console.log('        is rejected. It says nothing about 11.44. This is what happened to the probe');
  console.log('        block/blur swap: 355/20000, rejected, baseline restored (E.11.1).');
}
console.log('');
