/* DOES THE BITS-RESPONSE SLOPE FLATTEN AS A FILE GETS MORE DAMAGED?
 *
 * WHY THIS DECIDES THE WHOLE ANCHOR QUESTION. lambda = 1/|A| and the anchor never enters it (E.6), so
 * the shipped rule changes only if A changes. Two values are in play:
 *     crossed ladder,  8 films, ladders built from the ORIGINAL files      A = 0.6555  -> lambda 1.526
 *     same clips,     24 films, rungs built from gen1 CLIP RE-ENCODES      A = 0.4313  -> lambda 2.319
 * The shipped lambda is 1.519, so the first choice means NO CHANGE and the second means a 1.53x
 * increase to every provenance adjustment. Nothing else in the anchor work matters to the rule.
 *
 * THE HYPOTHESIS. The same-clip A is measured on files that are ALREADY one generation down, because
 * leg A's rungs are re-encodes. 11.72 measured that banding SATURATES and can even reverse below
 * ~0.5x bits, so a slope measured at an already-degraded operating point should be FLATTER than the
 * slope at the original file's operating point. 0.4313 < 0.6555 is the right direction, but direction
 * alone proves nothing — it is one comparison between two different film sets and two different
 * methods, which is exactly the kind of thing that has evaporated repeatedly in this project.
 *
 * THE TEST, using only data already collected. Within the 24 same-clip films, each has its OWN |A| and
 * its own P at gen1. If the flattening mechanism is real, films sitting at HIGHER P — more damaged —
 * should show FLATTER slopes. That is a within-dataset prediction with 24 points, and it needs no new
 * encoding.
 *
 * *** THE CONFOUND, AND IT IS FATAL IF IGNORED. *** P and A are both computed from the SAME artifact
 * readings on the SAME clips, so measurement noise in the gen1 rung enters both. The 1.0x rung is one
 * of three points in the slope fit, and it is also the point P is read at. Correlating them naively
 * would manufacture exactly the relationship being looked for. TWO DEFENCES:
 *   1. Use P measured at gen0 — the ORIGINAL file — as the damage proxy. It shares no encode with
 *      leg A's rungs at all. This is the primary test.
 *   2. Report the naive gen1 version alongside, purely so the size of the artifact is visible.
 * If the gen0 version holds and the gen1 version is much stronger, the difference is the artifact.
 *
 * A SECOND, INDEPENDENT PREDICTION. If saturation drives this, the flattening should also show up
 * against CONTENT complexity: grainy films mask artifacts and sit lower on the response curve. That
 * is a different mechanism from damage-saturation and should NOT be conflated with it, so it is
 * reported separately rather than pooled.
 *
 * USAGE: node scripts/bits-slope-flattening.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = { cambi: +1, block: +1, blur: +1, grain: -1 };

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
const slope = (xs, ys) => {
  const mx = mean(xs); const my = mean(ys);
  let n = 0; let d = 0;
  for (let i = 0; i < xs.length; i += 1) { n += (xs[i] - mx) * (ys[i] - my); d += (xs[i] - mx) ** 2; }
  return d > 0 ? n / d : NaN;
};

/* shipped surface */
const lib = []; const seen = new Set();
for (const f of ['data/artifact-backfill.json', 'data/provenance-wild.json']) {
  let d; try { d = JSON.parse(fs.readFileSync(f, 'utf8')).units; } catch { continue; }
  for (const [key, u] of Object.entries(d)) {
    if (!seen.has(key) && u.bpp > 0 && u.cxEff > 0 && DET.every((k) => u[k] > 0)) { lib.push({ key, ...u }); seen.add(key); }
  }
}
const design = (bpp, cx, codec) => {
  const lb = Math.log(bpp); const lc = Math.log(cx); const hv = codec === 'hevc' ? 1 : 0;
  return [1, lb, lb * lb, lc, lc * lc, lb * lc, hv, hv * lb];
};
const X = lib.map((u) => design(u.bpp, u.cxEff, u.codec));
const BETA = {}; const RSD = {};
for (const d of DET) {
  const y = lib.map((u) => Math.log(u[d]));
  BETA[d] = ols(X, y);
  RSD[d] = sd(y.map((v, i) => v - X[i].reduce((s, z, j) => s + z * BETA[d][j], 0)));
}
const P0lib = lib.map((u, i) => DET.reduce((s, d) => {
  const fit = X[i].reduce((t, z, j) => t + z * BETA[d][j], 0);
  return s + EXPECT[d] * ((Math.log(u[d]) - fit) / RSD[d]);
}, 0));
const MP = mean(P0lib); const SDSUM = sd(P0lib);
const Pof = (m, u) => {
  const row = design(u.bpp, u.cxEff, u.codec);
  let got = 0;
  const p0 = DET.reduce((s, d) => {
    if (!(m[d] > 0)) return s;
    got += 1;
    const fit = row.reduce((t, z, j) => t + z * BETA[d][j], 0);
    return s + EXPECT[d] * ((Math.log(m[d]) - fit) / RSD[d]);
  }, 0);
  return got === DET.length ? (p0 - MP) / SDSUM : null;
};

const e2e = JSON.parse(fs.readFileSync('data/end-to-end-generation.json', 'utf8')).units;
const legA = JSON.parse(fs.readFileSync('data/anchor-e2e.json', 'utf8'));
const RUNGS = legA.rungs;

const rows = [];
for (const [key, a] of Object.entries(legA.units)) {
  const u = e2e[key];
  if (!u?.gen0 || !u?.gen1) continue;
  const p0 = Pof(u.gen0, u); const p1 = Pof(u.gen1, u);
  if (p0 == null || p1 == null) continue;
  const xs = [Math.log(1.0)]; const ys = [p1];
  for (const m of RUNGS) {
    const p = Pof(a.rungs[m] || a.rungs[String(m)] || {}, u);
    if (p != null) { xs.push(Math.log(m)); ys.push(p); }
  }
  if (xs.length < 3) continue;
  const A = slope(xs, ys);
  if (!(A < 0)) continue;
  rows.push({ t: u.title, A: -A, p0, p1, cx: u.cxEff, bpp: u.bpp });
}
console.log(`\n  ${rows.length} films with a usable |A| and both generations\n`);
if (rows.length < 10) { console.log('  too few\n'); process.exit(0); }

console.log(`  ${'film'.padEnd(30)} ${'|A|'.padStart(7)} ${'P gen0'.padStart(8)} ${'P gen1'.padStart(8)}`);
for (const r of rows.slice().sort((x, y) => x.p0 - y.p0)) {
  console.log(`  ${r.t.slice(0, 29).padEnd(30)} ${r.A.toFixed(3).padStart(7)} ${r.p0.toFixed(3).padStart(8)} `
    + `${r.p1.toFixed(3).padStart(8)}`);
}

const As = rows.map((r) => r.A);
const se = 1 / Math.sqrt(rows.length - 3);
const rP0 = spearman(As, rows.map((r) => r.p0));
const rP1 = spearman(As, rows.map((r) => r.p1));
const rCx = spearman(As, rows.map((r) => Math.log(r.cx)));

console.log(`\n  *** THE TEST: does |A| shrink as the file gets more damaged? ***\n`);
console.log(`    |A| vs P at gen0 (ORIGINAL file — shares no encode with leg A)   rho ${rP0.toFixed(3)}  +- ${se.toFixed(3)}`);
console.log(`    |A| vs P at gen1 (same encode as leg A's 1.0x rung — CIRCULAR)   rho ${rP1.toFixed(3)}`);
console.log(`    difference between them is the size of the shared-encode artifact: `
  + `${(rP1 - rP0).toFixed(3)}`);
console.log(`\n    |A| vs log complexity (a DIFFERENT mechanism — masking, not saturation)  rho ${rCx.toFixed(3)}`);

console.log('\n  VERDICT\n');
if (rP0 < -2 * se) {
  console.log('    CONFIRMED on the clean version. More damaged files DO show flatter bits-response.');
  console.log('    That means the same-clip A = 0.4313 is measured at an already-degraded operating');
  console.log('    point and UNDERSTATES the field slope, so the crossed-ladder A = 0.6555 is the');
  console.log('    better estimate for library files and lambda should stay near 1.52 — i.e. NO CHANGE');
  console.log('    to the shipped rule, arrived at by measurement rather than by inertia.');
} else if (rP0 > 2 * se) {
  console.log('    REVERSED. More damaged files show STEEPER response, which contradicts saturation.');
  console.log('    The same-clip A is then not obviously biased and the case for lambda = 2.319 is');
  console.log('    stronger than assumed. Do not adopt either way without understanding why.');
} else {
  console.log('    NOT CONFIRMED — indistinguishable from zero on the clean version. The flattening');
  console.log('    story is UNSUPPORTED, and the choice between A = 0.4313 and A = 0.6555 cannot be');
  console.log('    settled by this argument. It must then rest on which population is more like the');
  console.log('    library, which is a judgement, and it should be labelled as one rather than');
  console.log('    dressed up as a measurement.');
}
console.log('');
