/* THE TEST THAT DECIDES WHETHER THE PROVENANCE FACTOR IS REAL.
 *
 * WHAT IS BEING TESTED. 11.26 established the factor with a SPLIT-HALF across DISJOINT DETECTOR
 * PAIRS, arguing that detector-specific noise cannot produce a correlation between two halves that
 * share no detector. That argument is valid and it is beside the point, because of how the data is
 * collected:
 *
 *   artifact-backfill.js measures ALL FOUR DETECTORS ON THE SAME 2-SECOND CLIPS. So "which scenes
 *   got sampled" is a nuisance SHARED BY ALL FOUR. It is not detector-specific, and the split-half
 *   was built to exclude only the detector-specific kind.
 *
 * AND THAT NUISANCE POINTS ALONG THE SIGNAL. Measured within-file, across clips, on the 60 units
 * where every clip was retained — same file, same bits, same content, same codec, ONLY the sampled
 * scene differing:
 *       cambi/block +0.334   cambi/grain -0.387   block/blur +0.198   blur/grain +0.036
 *   PC1  +0.633 cambi  +0.528 block  +0.296 blur  -0.483 grain      explains 41.3%
 * THE SIGN PATTERN IS (+,+,+,-), FOUR OF FOUR — the same signature a further generation produces.
 * Sampling four smooth, flat, low-detail seconds gives more banding, more blocking, a blurrier
 * reading and less grain. So scene sampling is not just noise; it is noise disguised as the signal.
 *
 * THE FIX, AND IT IS THE ONLY CLEAN ONE. Make the two halves disjoint in CLIPS as well as DETECTORS.
 * Then no nuisance that lives in a clip can appear on both sides, and whatever correlation survives
 * has to come from the film itself.
 *
 * THE COMPARISON IS RUN ON THE SAME 60 UNITS BOTH WAYS, which matters: the library figure of 0.245
 * comes from 1048 units and cannot be compared directly to anything computed here. The contrast that
 * means something is SHARED-CLIP vs DISJOINT-CLIP on identical films.
 *
 * PRE-REGISTERED, before running:
 *   disjoint-clip r stays within ~0.05 of shared-clip r  -> the nuisance is not driving the factor;
 *                                                           11.26 stands and this attack fails
 *   disjoint-clip r falls by half or more                -> the factor is substantially scene
 *                                                           sampling, and the per-film ordering that
 *                                                           the Blend page ships is not established
 *   disjoint-clip r near zero                            -> there is no film-level common factor at
 *                                                           all and the rule must come off the page
 * A FALL IS THE EXPECTED OUTCOME. Note that some fall is guaranteed and is NOT evidence of the
 * mechanism: each half now uses 6 clips instead of 12, so both halves are noisier. The Spearman-Brown
 * correction below accounts for exactly that, and the corrected numbers are the ones to read.
 *
 * USAGE: node scripts/clip-disjoint-splithalf.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = { cambi: +1, block: +1, blur: +1, grain: -1 };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const corr = (a, b) => {
  const ma = mean(a); const mb = mean(b);
  let n = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i += 1) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
};
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

/* THE SURFACE IS FITTED ON THE FULL LIBRARY, not on these 60 units. Fitting a 6-term surface to 60
 * films would leave residuals dominated by the fit, and the question is about the SHIPPED pipeline,
 * which uses the library surface. So: fit on 1048, then apply to each half-clip reading. */
const lib = [];
const seen = new Set();
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

/* The 60 units with every clip retained. bpp/cx/codec come from the backfill row for the same key,
 * so the surface is evaluated at exactly the point the shipped pipeline would use. */
const back = JSON.parse(fs.readFileSync('data/artifact-backfill.json', 'utf8')).units;
const units = Object.entries(JSON.parse(fs.readFileSync('data/clip-reliability.json', 'utf8')).units)
  .map(([key, u]) => ({ key, ...u, row: back[key] }))
  .filter((u) => u.row && u.row.bpp > 0 && u.row.cxEff > 0
    && (u.clips || []).filter((c) => DET.every((d) => c[d] > 0)).length >= 12);
console.log(`\n  ${units.length} units with 12 clean clips and a library row\n`);
if (units.length < 30) { console.log('  too few to test\n'); process.exit(0); }

/* z for one detector from a chosen subset of a unit's clips: residual of log(mean of those clips)
 * against the library surface, divided by the library residual sd. Exactly the shipped operation,
 * just fed a subset. */
const zOf = (u, d, idx) => {
  const v = idx.map((i) => u.clips[i][d]).filter((x) => x > 0);
  if (!v.length) return null;
  const row = design(u.row.bpp, u.row.cxEff, u.row.codec);
  const fit = row.reduce((s, z, j) => s + z * BETA[d][j], 0);
  return (Math.log(mean(v)) - fit) / RSD[d];
};

let seed = 20260827;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const shuffle = (a) => { const x = a.slice();
  for (let i = x.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; }
  return x; };

const SPLITS = [[['cambi', 'blur'], ['block', 'grain']], [['cambi', 'block'], ['blur', 'grain']],
  [['cambi', 'grain'], ['block', 'blur']]];
const REPS = 200;

/* shared = both halves read the SAME 6 clips (the shipped situation, where all detectors see one
 * clip set). disjoint = half A reads 6 clips, half B reads the OTHER 6. Clip COUNT is 6 in both, so
 * the only difference between the two columns is whether the scene nuisance is shared. */
function splitHalf(disjoint) {
  const out = {};
  for (const [A, B] of SPLITS) {
    const rs = [];
    for (let rep = 0; rep < REPS; rep += 1) {
      const a = []; const b = [];
      for (const u of units) {
        const n = u.clips.length;
        const idx = shuffle(Array.from({ length: n }, (_, i) => i));
        const ia = idx.slice(0, 6);
        const ib = disjoint ? idx.slice(6, 12) : ia;
        const va = A.map((d) => EXPECT[d] * zOf(u, d, ia));
        const vb = B.map((d) => EXPECT[d] * zOf(u, d, ib));
        if (va.some((x) => x == null) || vb.some((x) => x == null)) continue;
        a.push(va.reduce((s, x) => s + x, 0));
        b.push(vb.reduce((s, x) => s + x, 0));
      }
      if (a.length >= 30) rs.push(corr(a, b));
    }
    out[`${A.join('+')} | ${B.join('+')}`] = rs.length ? med(rs) : NaN;
  }
  return out;
}

const shared = splitHalf(false);
const disjoint = splitHalf(true);
const sb = (r) => (2 * r) / (1 + r);

console.log('  SPLIT-HALF ACROSS DISJOINT DETECTOR PAIRS, 6 clips per half, median of 200 draws\n');
console.log(`  ${'detector split'.padEnd(30)} ${'same clips'.padStart(11)} ${'DISJOINT clips'.padStart(15)} ${'drop'.padStart(8)}`);
for (const k of Object.keys(shared)) {
  const s = shared[k]; const d = disjoint[k];
  console.log(`  ${k.padEnd(30)} ${s.toFixed(3).padStart(11)} ${d.toFixed(3).padStart(15)} `
    + `${(s !== 0 ? `${(100 * (d - s) / Math.abs(s)).toFixed(0)}%` : '—').padStart(8)}`);
}
const ms = med(Object.values(shared)); const mdj = med(Object.values(disjoint));
console.log(`\n  median          same clips ${ms.toFixed(3)}   disjoint clips ${mdj.toFixed(3)}`);
console.log(`  Spearman-Brown  same clips ${sb(ms).toFixed(3)}   disjoint clips ${sb(mdj).toFixed(3)}`);
console.log(`  library figure quoted in 11.26 (1048 units, 4 shared clips): 0.245 raw, 0.377 S-B`);

console.log('\n  VERDICT AGAINST THE PRE-REGISTRATION\n');
const drop = (ms - mdj) / Math.abs(ms || 1);
if (mdj < 0.05) {
  console.log('  NO FILM-LEVEL COMMON FACTOR SURVIVES. Once the halves share no clips, the correlation');
  console.log('  is gone. The factor 11.26 established was scene sampling, and the per-film ordering');
  console.log('  the Blend page ships is not a measurement of the film. TAKE THE RULE OFF THE PAGE.');
} else if (drop > 0.5) {
  console.log(`  THE FACTOR IS SUBSTANTIALLY SCENE SAMPLING. ${(100 * drop).toFixed(0)}% of the split-half`);
  console.log('  correlation disappears when the halves stop sharing clips. Something real remains, but');
  console.log('  11.26 overstates it by roughly that factor and the per-film ordering is NOT established');
  console.log('  at the strength the doc claims. The shrinkage should be re-derived from the disjoint');
  console.log('  figure, and the Blend page should say so.');
} else if (drop > 0.2) {
  console.log(`  A REAL BUT PARTIAL CONTAMINATION: ${(100 * drop).toFixed(0)}% of the correlation is shared-clip.`);
  console.log('  The factor survives. Re-derive the shrinkage from the disjoint figure and move on.');
} else {
  console.log('  THE ATTACK FAILS. Disjoint-clip and shared-clip split-half agree, so the common factor');
  console.log('  is a property of the film and not of which scenes were sampled. 11.26 stands as');
  console.log('  written, and the scene-sampling mechanism — though real within a file — is not what');
  console.log('  the library-level statistic is measuring.');
}
console.log('\n  NOTE both columns use 6 clips per half, so the comparison is like for like. The library');
console.log('  ships 4 clips TOTAL per unit, which is noisier than either column here.\n');
