/* DO THE FOUR PROVENANCE AXES SHARE ONE SIGNATURE? — the assumption P is built on, never tested.
 *
 * WHAT FORCED THIS. YIFY is the most aggressive re-encoder in common circulation and its releases are
 * labelled Bluray, so it is the sharpest within-label provenance contrast available. P says nothing:
 * -0.013 +- 0.083, t = -0.16, at n = 94 against 569. That is a well-powered null on the one case that
 * should have lit up brightest, and it demands an explanation rather than a shrug.
 *
 * THE CANDIDATE EXPLANATION, and it is a real defect if true. P sums the four residuals in ONE fixed
 * direction, the re-encode signature (+cambi +block +blur -grain), justified by what an extra
 * GENERATION does. But 2.1 lists FOUR provenance axes, and there is no reason they share a signature:
 *     GENERATIONS   quantising already-quantised pixels ADDS banding, blocking, blur; grain decays
 *     ENCODER       a faster preset ADDS all three and retains less grain     -> same shape
 *     PREPROCESSING a denoiser DESTROYS grain, but it also SMOOTHS the image, which should LOWER
 *                   measured banding and blocking rather than raise them     -> a DIFFERENT shape
 * If preprocessing runs (-,-,-,-) rather than (+,+,+,-), then for a preprocessing-dominated release
 * the terms CANCEL: grain pushes P up while banding and blocking pull it down. YIFY is exactly a
 * preprocessing-dominated release. The null would then be a predictable artifact of using one
 * direction for four different physical processes.
 *
 * THIS IS TESTABLE ON DATA ALREADY MEASURED. Each axis has its own controlled experiment where bits
 * and content are held constant and only that axis varies. So each axis has an OBSERVABLE direction,
 * and the question "do they share a signature" is just the angle between them.
 *
 * WHAT EACH OUTCOME MEANS:
 *   all axes closely aligned      P's single direction is right and the YIFY null needs another
 *                                 explanation. Look at whether YIFY is preprocessing-dominated at all.
 *   preprocessing points elsewhere  P is structurally blind to that axis by cancellation, and the fix
 *                                 is more than one projection — which is a real design change, not a
 *                                 tuning change.
 * Either way this is a fact about the construction, not about the library.
 *
 * NOTE ON SCALE. Directions are compared in NOISE-NORMALISED units (each detector divided by its
 * library residual sd), because a raw-unit comparison is dominated by cambi, whose slope is largest
 * for every axis — that would make everything look parallel regardless of the physics. This is the
 * same error that made direction-angle.mjs read cos = 0.909 (11.25, defect 2).
 *
 * USAGE: node scripts/axis-signatures.mjs
 */
import fs from 'fs';

const DET = ['cambi', 'block', 'blur', 'grain'];
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
const unit = (v) => { const n = norm(v) || 1; return v.map((x) => x / n); };
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
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
function slope(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length < 3) return null;
  const mx = mean(pts.map((p) => p[0])); const my = mean(pts.map((p) => p[1]));
  let n = 0; let d = 0;
  for (const [x, y] of pts) { n += (x - mx) * (y - my); d += (x - mx) ** 2; }
  return d > 0 ? n / d : null;
}

/* Library residual sds — the noise scale each direction is expressed in. */
const rows = [];
const seen = new Set();
for (const f of ['data/artifact-backfill.json', 'data/provenance-wild.json']) {
  let d; try { d = JSON.parse(fs.readFileSync(f, 'utf8')).units; } catch { continue; }
  for (const [key, u] of Object.entries(d)) {
    if (!seen.has(key) && u.bpp > 0 && u.cxEff > 0 && DET.every((k) => u[k] > 0)) { rows.push({ key, ...u }); seen.add(key); }
  }
}
const lb = rows.map((u) => Math.log(u.bpp));
const lc = rows.map((u) => Math.log(u.cxEff));
const hev = rows.map((u) => (u.codec === 'hevc' ? 1 : 0));
const X = rows.map((u, i) => [1, lb[i], lb[i] ** 2, lc[i], lc[i] ** 2, lb[i] * lc[i], hev[i], hev[i] * lb[i]]);
const SD = {};
for (const d of DET) {
  const y = rows.map((u) => Math.log(u[d]));
  const be = ols(X, y);
  SD[d] = sd(y.map((v, i) => v - X[i].reduce((s, z, j) => s + z * be[j], 0)));
}

/* Each axis: per-film slope of log(detector) against that axis's own variable, oriented so the
 * direction points toward WORSE PROVENANCE (more generations, faster preset, more denoising, fewer
 * bits). Median across films so one film cannot set a direction. */
function axisDirection(films, rowsOf, xOf, flip) {
  const per = { cambi: [], block: [], blur: [], grain: [] };
  let n = 0;
  for (const f of films) {
    const rs = rowsOf(f);
    if (!rs || rs.length < 3) continue;
    const xs = rs.map(xOf);
    let any = false;
    for (const d of DET) {
      const s = slope(xs, rs.map((r) => (r[d] > 0 ? Math.log(r[d]) : NaN)));
      if (s != null && Number.isFinite(s)) { per[d].push(s); any = true; }
    }
    if (any) n += 1;
  }
  if (DET.some((d) => per[d].length < 3)) return null;
  const raw = DET.map((d) => flip * med(per[d]));
  return { raw, whitened: unit(DET.map((d, i) => raw[i] / SD[d])), n };
}

const AXES = [];
try {
  const gen = JSON.parse(fs.readFileSync('data/generation-test.json', 'utf8')).films;
  const a = axisDirection(gen, (f) => (f.rows || []).filter((r) => DET.every((d) => r[d] > 0)),
    (r) => (r.gen ?? r.rank ?? 0), +1);
  if (a) AXES.push({ name: 'generations', ...a });
} catch { /* */ }
try {
  const enc = JSON.parse(fs.readFileSync('data/encoder-ladder-wide.json', 'utf8')).films;
  /* rank 1 = veryfast = worst, so rank rises toward BETTER; flip to point at WORSE. x264 only, to
   * keep a codec fingerprint out of it (11.12). */
  const a = axisDirection(enc, (f) => (f.rows || []).filter((r) => /x264/.test(r.name) && DET.every((d) => r[d] > 0)),
    (r) => r.rank, -1);
  if (a) AXES.push({ name: 'encoder preset', ...a });
} catch { /* */ }
try {
  const den = JSON.parse(fs.readFileSync('data/denoise-test.json', 'utf8')).films;
  /* denoise-test.js assigns rank 3 = none (best), rank 1 = heavy (worst), so rank DECREASES as
   * denoising increases — the same convention as the encoder ladder. flip = -1 to point at WORSE.
   * Getting this backwards on the first run inverted the whole conclusion and produced a physically
   * impossible grain component (denoising appearing to ADD grain), which is what caught it. */
  const a = axisDirection(den, (f) => (f.rows || []).filter((r) => DET.every((d) => r[d] > 0)),
    (r, i) => (r.rank !== undefined ? r.rank : i), -1);
  if (a) AXES.push({ name: 'preprocessing', ...a });
} catch { /* */ }
try {
  const lad = JSON.parse(fs.readFileSync('bpp-lab/public/ladders.json', 'utf8')).films;
  /* Level rises with bits, so fewer bits is worse -> flip. */
  const a = axisDirection(lad, (f) => (f.points || []).filter((p) => p.level > 0 && DET.every((d) => p[d] > 0)),
    (p) => Math.log(p.level), -1);
  if (a) AXES.push({ name: 'bits', ...a });
} catch { /* */ }

const SIGNATURE = unit(DET.map((d, i) => ({ cambi: 1, block: 1, blur: 1, grain: -1 }[d]) / SD[d]));

console.log(`\n  Directions in NOISE-NORMALISED units, all oriented toward WORSE PROVENANCE\n`);
console.log(`  ${'axis'.padEnd(16)} ${'films'.padStart(5)} ${DET.map((d) => d.padStart(8)).join(' ')}   cos with P's direction`);
console.log(`  ${'P direction'.padEnd(16)} ${'—'.padStart(5)} ${SIGNATURE.map((v) => v.toFixed(3).padStart(8)).join(' ')}   1.000`);
for (const a of AXES) {
  console.log(`  ${a.name.padEnd(16)} ${String(a.n).padStart(5)} ${a.whitened.map((v) => v.toFixed(3).padStart(8)).join(' ')}   ${dot(a.whitened, SIGNATURE).toFixed(3)}`);
}

console.log('\n  PAIRWISE ANGLES BETWEEN AXES\n');
console.log(`  ${''.padEnd(16)} ${AXES.map((a) => a.name.slice(0, 8).padStart(9)).join('')}`);
for (const a of AXES) {
  console.log(`  ${a.name.padEnd(16)} ${AXES.map((b) => dot(a.whitened, b.whitened).toFixed(2).padStart(9)).join('')}`);
}

const pre = AXES.find((a) => a.name === 'preprocessing');
console.log('\n  VERDICT\n');
if (!pre) {
  console.log('  preprocessing axis unavailable — cannot test the cancellation hypothesis');
} else {
  const c = dot(pre.whitened, SIGNATURE);
  if (c < 0.3) {
    console.log(`  PREPROCESSING POINTS SOMEWHERE ELSE (cos ${c.toFixed(3)} with P's direction).`);
    console.log('  P is therefore STRUCTURALLY BLIND to preprocessing-dominated provenance: the terms');
    console.log('  partially cancel, so an aggressively denoised release reads near zero however bad it');
    console.log('  is. That explains the YIFY null exactly, and it is a DESIGN limit, not a tuning one —');
    console.log('  a single projection cannot span provenance that moves in more than one direction.');
    console.log('  THE FIX IS MORE THAN ONE PROJECTION, and it should be reasoned about before it is built.');
  } else {
    console.log(`  Preprocessing is broadly aligned with P's direction (cos ${c.toFixed(3)}), so the`);
    console.log('  cancellation hypothesis is NOT supported and the YIFY null needs another explanation.');
    console.log('  Next question: is YIFY actually preprocessing-dominated in this library, or is its');
    console.log('  reputation ahead of what it does to these particular files?');
  }
}
console.log('');
