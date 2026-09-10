/* IS THE COMMON FACTOR JUST A CODEC FINGERPRINT? — the control that decides whether it can touch BPP+.
 *
 * WHY THIS IS THE DANGEROUS ONE. provenance-factor.mjs found a real common factor with the right sign
 * pattern, and then showed mean P of -0.968 for hevc against +0.128 for h264. That is a one-sigma gap
 * and it admits two readings:
 *   REAL      hevc at the same bpp genuinely IS less damaged, and capturing that is the whole point
 *   ARTEFACT  blockdetect reads hevc's 32x32 transforms and stronger in-loop deblocking as "clean"
 *             regardless of actual quality — a fingerprint, not a measurement
 * 11.12 already found both effects exist on the encoder ladder, which is why that experiment was run
 * x264-presets-only.
 *
 * AND THERE IS A SECOND, WORSE PROBLEM EVEN IF IT IS REAL. BPP+ ALREADY carries a codec term: R
 * includes a x1.6 codec factor. A score adjustment that re-reads codec DOUBLE-COUNTS it. So even a
 * genuine codec effect must be removed here before the factor can be allowed near the score.
 *
 * THE TEST. Redo everything WITHIN h264 only (688 units, so power is barely reduced). If the
 * split-half factor, the sign pattern and the WEBRip > WEB-DL > Bluray ordering all survive with
 * codec held constant, the factor is provenance. If they collapse, the earlier result was codec
 * composition and must be withdrawn.
 *
 * PRE-REGISTERED: the ordering surviving within h264 is the pass condition. Anything else and the
 * group means in provenance-factor.mjs get struck.
 *
 * USAGE: node scripts/factor-codec-control.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = { cambi: +1, block: +1, blur: +1, grain: -1 };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
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

const units = JSON.parse(fs.readFileSync('data/artifact-backfill.json', 'utf8')).units;
const base = Object.entries(units).map(([key, u]) => ({ key, ...u }))
  .filter((u) => u.bpp > 0 && u.cxEff > 0 && DET.every((d) => u[d] > 0));
try {
  const w = JSON.parse(fs.readFileSync('data/provenance-wild.json', 'utf8')).units;
  const seen = new Set(base.map((u) => u.key));
  for (const [key, u] of Object.entries(w)) {
    if (!seen.has(key) && u.bpp > 0 && u.cxEff > 0 && DET.every((d) => u[d] > 0)) { base.push({ key, ...u }); seen.add(key); }
  }
} catch { /* optional */ }

/* Build the factor on an arbitrary subset, so the same code runs on "everything" and on "h264 only"
 * and the two are directly comparable. */
function analyse(label, rows) {
  const lb = rows.map((u) => Math.log(u.bpp));
  const lc = rows.map((u) => Math.log(u.cxEff));
  const X = rows.map((u, i) => [1, lb[i], lb[i] ** 2, lc[i], lc[i] ** 2, lb[i] * lc[i]]);
  const Z = {};
  for (const d of DET) {
    const y = rows.map((u) => Math.log(u[d]));
    const be = ols(X, y);
    const r = y.map((v, i) => v - X[i].reduce((s, z, j) => s + z * be[j], 0));
    const s = sd(r);
    Z[d] = r.map((v) => v / s);
  }
  const SPLITS = [[['cambi', 'blur'], ['block', 'grain']], [['cambi', 'block'], ['blur', 'grain']],
    [['cambi', 'grain'], ['block', 'blur']]];
  const rs = SPLITS.map(([A, B]) => corr(
    rows.map((_, i) => A.reduce((s, d) => s + EXPECT[d] * Z[d][i], 0)),
    rows.map((_, i) => B.reduce((s, d) => s + EXPECT[d] * Z[d][i], 0)),
  ));
  const medR = rs.slice().sort((a, b) => a - b)[1];
  const P0 = rows.map((_, i) => DET.reduce((s, d) => s + EXPECT[d] * Z[d][i], 0));
  const P = P0.map((x) => (x - mean(P0)) / sd(P0));

  console.log(`\n  ${'='.repeat(68)}\n  ${label}   n=${rows.length}`);
  console.log(`  split-half r: ${rs.map((r) => r.toFixed(3)).join('  ')}   median ${medR.toFixed(3)}`);
  console.log(`\n  ${'group'.padEnd(20)} ${'n'.padStart(5)} ${'mean P'.padStart(8)} ${'SE'.padStart(7)}`);
  const G = [['WEBRip', /WEBRip/i], ['WEB-DL', /WEBDL|WEB-DL/i], ['Bluray', /Bluray/i]];
  const out = {};
  for (const [nm, re] of G) {
    const g = rows.map((u, i) => i).filter((i) => re.test(rows[i].source || ''));
    if (g.length < 10) { console.log(`  ${nm.padEnd(20)} ${String(g.length).padStart(5)}   too few`); continue; }
    const vals = g.map((i) => P[i]);
    out[nm] = mean(vals);
    console.log(`  ${nm.padEnd(20)} ${String(g.length).padStart(5)} ${mean(vals).toFixed(3).padStart(8)} ${(sd(vals) / Math.sqrt(vals.length)).toFixed(3).padStart(7)}`);
  }
  const ordered = out.WEBRip !== undefined && out['WEB-DL'] !== undefined && out.Bluray !== undefined
    && out.WEBRip > out['WEB-DL'] && out['WEB-DL'] > out.Bluray;
  console.log(`  generation ordering WEBRip > WEB-DL > Bluray: ${ordered ? 'HOLDS' : 'does NOT hold'}`);
  return { medR, P, rows, ordered, out };
}

const A = analyse('ALL CODECS (what provenance-factor.mjs reported)', base);
const h264 = base.filter((u) => u.codec === 'h264');
const B = analyse('h264 ONLY — codec held constant, the control that matters', h264);

/* The other direction: give the residual model the codec as a regressor, so ANY codec-linked level
 * difference is removed from all 782 units at once rather than by subsetting. Subsetting and
 * covarying should agree; if they do not, something is wrong with one of them. */
console.log(`\n  ${'='.repeat(68)}\n  CROSS-CHECK — codec as a regressor instead of a subset (all ${base.length} units)`);
{
  const rows = base;
  const lb = rows.map((u) => Math.log(u.bpp));
  const lc = rows.map((u) => Math.log(u.cxEff));
  const hev = rows.map((u) => (u.codec === 'hevc' ? 1 : 0));
  const X = rows.map((u, i) => [1, lb[i], lb[i] ** 2, lc[i], lc[i] ** 2, lb[i] * lc[i], hev[i], hev[i] * lb[i]]);
  const Z = {};
  for (const d of DET) {
    const y = rows.map((u) => Math.log(u[d]));
    const be = ols(X, y);
    const r = y.map((v, i) => v - X[i].reduce((s, z, j) => s + z * be[j], 0));
    Z[d] = r.map((v) => v / sd(r));
  }
  const P0 = rows.map((_, i) => DET.reduce((s, d) => s + EXPECT[d] * Z[d][i], 0));
  const P = P0.map((x) => (x - mean(P0)) / sd(P0));
  console.log(`  ${'group'.padEnd(20)} ${'n'.padStart(5)} ${'mean P'.padStart(8)} ${'SE'.padStart(7)}`);
  for (const [nm, re] of [['WEBRip', /WEBRip/i], ['WEB-DL', /WEBDL|WEB-DL/i], ['Bluray', /Bluray/i],
    ['hevc (should be ~0)', /.*/]]) {
    const g = rows.map((u, i) => i).filter((i) => (nm.startsWith('hevc') ? rows[i].codec === 'hevc' : re.test(rows[i].source || '')));
    if (g.length < 10) continue;
    const vals = g.map((i) => P[i]);
    console.log(`  ${nm.padEnd(20)} ${String(g.length).padStart(5)} ${mean(vals).toFixed(3).padStart(8)} ${(sd(vals) / Math.sqrt(vals.length)).toFixed(3).padStart(7)}`);
  }
  fs.writeFileSync('data/provenance-factor-controlled.json', JSON.stringify({
    generated: Date.now(), n: rows.length, note: 'P with bits, content and codec all removed',
    units: rows.map((u, i) => ({ key: u.key, title: u.title, source: u.source, codec: u.codec,
      bppPlus: u.bppPlus, bpp: u.bpp, cxEff: u.cxEff, P: P[i] })),
  }, null, 1));
  console.log('\n  wrote data/provenance-factor-controlled.json');
}

console.log(`\n  ${'='.repeat(68)}\n  VERDICT`);
console.log(`  split-half survives codec control: ${B.medR.toFixed(3)} vs ${A.medR.toFixed(3)} all-codec`);
console.log(`  generation ordering within h264: ${B.ordered ? 'HOLDS — the factor is provenance, not a codec fingerprint'
  : 'BROKEN — withdraw the group-means claim, it was codec composition'}\n`);
