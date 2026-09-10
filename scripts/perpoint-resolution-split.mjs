/* DOES THE perPoint RESIDUAL SPLIT INTO A RESOLUTION PART AND A COMPRESSION PART?
 *
 * THE PUZZLE THIS ADDRESSES (E.8.10). The cross-film perPoint residual is real (reliability 0.945),
 * non-redundant with BPP+ (67%), and damage-like (banding +0.415). But BOTH candidate exchange rates
 * return an impossible library spread:
 *     via the starvation slope  -0.0297/log(level)   -> p10-p90 ~ 7x in source starvation
 *     via a real generation      0.0068/generation   -> p10-p90 ~ 10 generations, and that is a
 *                                                       LOWER bound (49% of the step is rate control)
 * When two INDEPENDENT units both return the impossible, the fault is not in either rate — it is in
 * assuming the residual is a COMPRESSION DEPTH at all.
 *
 * THE HYPOTHESIS. The residual correlates -0.303 with HEIGHT. A 720p file genuinely holds less
 * detail than a 1080p one, and that is neither starvation nor generations — it is SOURCE FORMAT. A
 * resolution axis would price sensibly in NEITHER compression unit, which is exactly the symptom.
 * It is also a legitimate quality fact: a 720p copy of a 1080p film IS compromised, just not by
 * compression, and BPP+ already normalises bitrate by resolution so it is blind to this by design.
 *
 * THE TEST. Add log(height) to the content line and ask what happens to the residual:
 *   - if the residual SHRINKS a lot, resolution was a large part of it, and only what remains is a
 *     candidate for a compression-unit conversion
 *   - if the REMAINING spread then prices plausibly (1-2 generations, or <2x starvation), the split
 *     is real and perPoint becomes usable as a term over the compression part alone
 *   - if the remaining spread is still impossible, resolution was not the explanation and the
 *     residual is something else again — say so rather than reaching for a third unit
 *
 * *** THE TRAP, AND IT IS THE REASON THIS IS NOT OBVIOUSLY CORRECT TO DO. *** Adding height to the
 * content line REMOVES a genuine quality difference from the reading. A 720p file really is worse,
 * and residualising it away means perPoint would stop reporting that. So this is NOT "cleaning up a
 * confound" — it is a DECISION about what perPoint is for. Two defensible positions:
 *     (a) perPoint should measure COMPRESSION damage only, because BPP+'s tier gates already handle
 *         resolution, and double-counting it would penalise 720p twice.
 *     (b) perPoint should measure DELIVERED DETAIL, in which case resolution belongs in it and the
 *         impossible exchange rate simply means it must not be converted into a bitrate-equivalent.
 * This script computes (a) and REPORTS what it would cost, so the choice is made with the number in
 * hand. It does not decide.
 *
 * READ-ONLY. Uses data/perpoint-content-line.json and the live probe dataset.
 * USAGE: node scripts/perpoint-resolution-split.mjs
 */
import fs from 'fs';

const LEVEL = -0.0297;       /* d perPoint / d log(level), within film, t = 14.1 */
const DGEN = 0.0068;         /* d perPoint / generation, interim n=11, an UPPER bound */
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const rank = (a) => { const s = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length);
  s.forEach(([, i], k) => { r[i] = k; }); return r; };
function spearman(a, b) {
  const ra = rank(a); const rb = rank(b); const n = a.length;
  const ma = mean(ra); const mb = mean(rb);
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i += 1) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
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
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < p; r += 1) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let cc = c; cc < p; cc += 1) A[r][cc] -= f * A[c][cc];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}
const fit = (X, y) => {
  const b = ols(X, y); const my = mean(y);
  const res = y.map((v, i) => v - X[i].reduce((s, z, j) => s + z * b[j], 0));
  let ss = 0; let tt = 0;
  for (let i = 0; i < y.length; i += 1) { ss += res[i] ** 2; tt += (y[i] - my) ** 2; }
  return { b, res, resSd: Math.sqrt(ss / (y.length - X[0].length)), r2: 1 - ss / tt };
};

const raw = JSON.parse(fs.readFileSync('data/perpoint-content-line.json', 'utf8'));
const ds = await (await fetch('http://localhost:8088/api/probe/dataset')).json();
const byKey = new Map(ds.rows.map((r) => [r.key, r]));
const rows = [];
for (const [key, u] of Object.entries(raw.units)) {
  const arm = u.arms[0] ?? u.arms['0'];
  const r = byKey.get(key);
  if (!arm || !(arm.cx20 > 0) || !Number.isFinite(arm.perPoint) || !r || !(r.probeH > 0)) continue;
  rows.push({ t: u.title, pp: arm.perPoint, lcx: Math.log(arm.cx20), lh: Math.log(r.probeH), h: r.probeH });
}
console.log(`\n  ${rows.length} films with perPoint and a probe height\n`);

const y = rows.map((r) => r.pp);
const A = fit(rows.map((r) => [1, r.lcx]), y);
const B = fit(rows.map((r) => [1, r.lcx, r.lh]), y);
console.log('  THE CONTENT LINE, WITH AND WITHOUT RESOLUTION\n');
console.log(`    perPoint ~ log cx20                 slope ${A.b[1].toFixed(4)}   residual sd ${A.resSd.toFixed(4)}   r2 ${A.r2.toFixed(3)}`);
console.log(`    perPoint ~ log cx20 + log height    slope ${B.b[1].toFixed(4)}   residual sd ${B.resSd.toFixed(4)}   r2 ${B.r2.toFixed(3)}`);
console.log(`    height coefficient                  ${B.b[2].toFixed(4)}`);
console.log(`    residual sd change                  ${A.resSd.toFixed(4)} -> ${B.resSd.toFixed(4)}   `
  + `(${(100 * (1 - B.resSd / A.resSd)).toFixed(1)}% of the spread removed)`);

console.log('\n  WHAT THE REMAINING SPREAD WOULD PRICE AT\n');
const price = (s, lbl) => {
  const st = Math.exp((2 * 1.2816 * s) / Math.abs(LEVEL));
  const gen = (2 * 1.2816 * s) / DGEN;
  console.log(`    ${lbl.padEnd(28)} sd ${s.toFixed(4)}   p10-p90 = ${st.toFixed(1)}x starvation, `
    + `${gen.toFixed(1)} generations`);
  return { st, gen };
};
const p0 = price(A.resSd, 'before removing height');
const p1 = price(B.resSd, 'after removing height');
console.log('    (generations is a LOWER bound: 49% of the measured step is rate control, E.7.4)');

/* is what remains still tracking resolution? it should not be */
const rH = spearman(B.res, rows.map((r) => r.lh));
console.log(`\n    remaining residual vs log height   rho ${rH.toFixed(3)}   (should be ~0 by construction)`);

console.log('\n  VERDICT\n');
if (B.resSd / A.resSd > 0.9) {
  console.log(`    RESOLUTION IS NOT THE EXPLANATION. It removes only ${(100 * (1 - B.resSd / A.resSd)).toFixed(0)}% of the spread, and what`);
  console.log(`    remains still prices at ${p1.st.toFixed(1)}x starvation / ${p1.gen.toFixed(0)} generations — still impossible.`);
  console.log('    The residual is real, reliable and damage-like, and it is NOT a compression depth');
  console.log('    and NOT resolution. Do not reach for a fourth unit; the honest position is that');
  console.log('    perPoint measures something well that we cannot yet name, and it must stay a');
  console.log('    DIAGNOSTIC until a human label says what it corresponds to.');
} else if (p1.st < 2.5 || p1.gen < 3) {
  console.log(`    THE SPLIT IS REAL. Removing height takes ${(100 * (1 - B.resSd / A.resSd)).toFixed(0)}% of the spread out and what`);
  console.log(`    remains prices plausibly (${p1.st.toFixed(1)}x starvation / ${p1.gen.toFixed(1)} generations). perPoint can become a`);
  console.log('    term over the COMPRESSION part alone — but read the trap in this file\'s header');
  console.log('    first: removing height also removes a genuine quality difference, and that is a');
  console.log('    DECISION about what perPoint is for, not a confound cleanup.');
} else {
  console.log(`    PARTIAL. Height removes ${(100 * (1 - B.resSd / A.resSd)).toFixed(0)}% of the spread but what remains still prices at`);
  console.log(`    ${p1.st.toFixed(1)}x starvation / ${p1.gen.toFixed(1)} generations, which is better but still not plausible.`);
  console.log('    Resolution is PART of the story and not all of it. Do not convert yet.');
}
console.log('');
