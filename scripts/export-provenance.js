/* EXPORT THE PROVENANCE FACTOR FOR THE LAB — bpp-lab/public/provenance.json
 *
 * The lab draws everything else from /api/probe/dataset so it can never drift from the controller.
 * This file is the exception, for the same reason ladders.json is: the four-artifact measurements come
 * from an offline backfill, not from the nightly probe, so there is nothing live to read. Regenerate
 * whenever data/artifact-backfill.json changes.
 *
 * WHAT IS IN IT, and why each piece is here rather than computed in the browser:
 *   P            the provenance factor per unit, with bits, content AND CODEC removed. Computed here
 *                because it needs a regression over the whole library at once — a per-row view cannot
 *                produce it, and a browser that tried would silently use whatever subset is filtered
 *                in, so the number would change when you changed the filter.
 *   z_*          the four standardised residuals, so the lab can show WHICH artifact drove a film.
 *   reliability  split-half across detector halves, Spearman-Brown corrected. This is the shrinkage
 *                factor and it is MEASURED, not chosen.
 *   anchor       the measured WEB-vs-Bluray gap in P units. The lab turns this into a score
 *                adjustment by pairing it with an external bitrate-efficiency belief.
 *
 * THE CODEC REMOVAL IS NOT OPTIONAL. BPP+ already carries a codec term (R includes a x1.6 codec
 * factor), so a factor that still read codec would double-count it. factor-codec-control.mjs showed
 * hevc sitting a full sigma below h264 before the control and at 0.000 after.
 *
 * USAGE: node scripts/export-provenance.js
 */
const fs = require('fs');
const { execFileSync } = require('child_process');

const DET = ['cambi', 'block', 'blur', 'grain'];
/* The re-encode signature: a further generation ADDS banding, blocking and blur and DESTROYS grain.
 * Pre-registered from what a re-encode physically does, never fitted. PC1 of the residual correlation
 * matrix independently lands on this same pattern 4/4 and correlates 0.951 with it, which is the
 * check that the data agrees rather than the direction being imposed.
 *
 * READ THAT LAST SENTENCE WITH E.9.7 IN HAND. PC1 does agree with the direction (cos 0.947 measured
 * independently), but PC1 is WEAK: lambda1 = 1.399 where independence gives 1.000, so it carries 35%
 * of the variance against a floor of 25%. The agreement is real and it is not strong corroboration.
 * P is a composite damage INDEX in a pre-registered direction, not an estimate of a latent factor. */
const EXPECT = { cambi: +1, block: +1, blur: +1, grain: -1 };

/* ---- SOURCE block/blur FROM THE NIGHTLY PROBE INSTEAD OF THE BACKFILL (task 97, E.11) ----
 * The backfill reads all four detectors from THE SAME 4 clips x 2s. The probe has been measuring
 * block and blur all along at 8 samples x 4s on all 1048 units. Two reasons to prefer it:
 *   PRECISION   blur is the worst-sampled detector in P — backfill 0.404 vs probe 0.664.
 *   STRUCTURE   and this matters more. The probe samples DIFFERENT POSITIONS, so sourcing block/blur
 *               from it means the four detectors no longer share one clip draw. E.9.4's 52%
 *               contamination exists BECAUSE the sampling is common; splitting it across two
 *               independent draws attacks that directly rather than averaging harder at it.
 * E.9.7 adds a third: blur is orthogonal to the rest of P (mean r 0.045) and 55.5% of its
 * between-film variance is scene sampling. Three independent indictments, one fix.
 *
 * *** PRE-REGISTERED ADOPTION RULE, WRITTEN BEFORE THE NUMBERS EXIST. *** The swap is adopted only if
 * scripts/structural-recheck.mjs STILL PASSES (joint <= 100/20000 AND the physics direction still
 * ranks 1-2 of the 16 sign flips). It currently passes by 4% (96 vs 100), so it can easily break.
 * A reliability gain does NOT buy adoption on its own — that is exactly the mistake local-variance
 * standardisation made (four statistics improved, the arbiter check got worse, and it was rejected).
 * THE RECHECK IS THE ARBITER.
 *
 * Fetched with curl rather than fetch() so this build script stays synchronous — making it async
 * would restructure 200 lines of straight-line code for no benefit. It FAILS HARD if the controller
 * is unreachable: a silent fallback would make P depend on whether a daemon happened to be up. */
const SWAP = process.argv.includes('--probe-blockblur');
let probe = null;
if (SWAP) {
  const raw = execFileSync('curl', ['-sf', '--max-time', '30', 'http://localhost:8088/api/probe/dataset'],
    { encoding: 'utf8', maxBuffer: 64 << 20 });
  probe = new Map(JSON.parse(raw).rows.map((r) => [r.key, r]));
}

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

const rows = [];
const seen = new Set();
for (const f of ['data/artifact-backfill.json', 'data/provenance-wild.json']) {
  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')).units; } catch { continue; }
  for (const [key, u] of Object.entries(d)) {
    if (seen.has(key)) continue;
    if (u.bpp > 0 && u.cxEff > 0 && DET.every((k) => u[k] > 0)) { rows.push({ key, ...u }); seen.add(key); }
  }
}
if (SWAP) {
  /* Overwrite block/blur with the probe's better-sampled means. A unit the probe has not measured is
   * DROPPED rather than left on backfill values: a P built from two different samplings on some rows
   * and one on others is not a single quantity, and the mixture would be invisible downstream. */
  const before = rows.length;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const p = probe.get(rows[i].key);
    if (p && p.blockMean > 0 && p.blurMean > 0) { rows[i].block = p.blockMean; rows[i].blur = p.blurMean; }
    else rows.splice(i, 1);
  }
  console.log(`  SWAP: block/blur sourced from the nightly probe; ${before} -> ${rows.length} units`);
}
if (rows.length < 50) { console.error(`only ${rows.length} usable units — refusing to write`); process.exit(1); }

const lb = rows.map((u) => Math.log(u.bpp));
const lc = rows.map((u) => Math.log(u.cxEff));
const hev = rows.map((u) => (u.codec === 'hevc' ? 1 : 0));
/* Codec enters as both a level shift and an interaction with bits, because a codec's advantage is not
 * constant across the bitrate range — it is largest where bits are scarce. */
const X = rows.map((u, i) => [1, lb[i], lb[i] ** 2, lc[i], lc[i] ** 2, lb[i] * lc[i], hev[i], hev[i] * lb[i]]);

/* GLOBAL SD, DELIBERATELY — local-variance standardisation was TRIED AND REJECTED (BPP-PLUS 11.43).
 *
 * The residuals really are heteroscedastic: cambi's |z| correlates -0.312 with the FITTED level and
 * grain's +0.753. Standardising by a smooth local sd instead of one pooled sd fixes that almost
 * completely (hetero 0.326 -> 0.024) and improves split-half 0.377 -> 0.401, the gap 0.209 -> 0.214
 * and its t 2.01 -> 2.15.
 *
 * AND IT STILL FAILS THE PRE-REGISTERED RECHECK, WORSE THAN BEFORE. Random directions reaching our gap
 * went 537 -> 1076 of 20000, and the pre-registered direction fell from rank 1 to rank 2 of the 16 sign
 * flips — a NEW failure. Equalising the variance across the range makes the four detectors more
 * INTERCHANGEABLE, so more arbitrary directions reach the same gap. It improved four statistics while
 * destroying the one that distinguishes the physics direction from an arbitrary one.
 *
 * THE LESSON, WHICH COST A ROUND TRIP: a change was tested against the numbers being looked at rather
 * than against the check that was actually failing. The recheck is the arbiter. */
const Z = {};
const sdOf = {};
for (const d of DET) {
  const y = rows.map((u) => Math.log(u[d]));
  const be = ols(X, y);
  const r = y.map((v, i) => v - X[i].reduce((s, z, j) => s + z * be[j], 0));
  const s = sd(r);
  sdOf[d] = s;
  Z[d] = r.map((v) => v / s);
}

const P0 = rows.map((_, i) => DET.reduce((s, d) => s + EXPECT[d] * Z[d][i], 0));
const mP = mean(P0); const sP = sd(P0);
const P = P0.map((x) => (x - mP) / sP);

/* Reliability: median over the three ways of splitting four detectors into two disjoint pairs, then
 * Spearman-Brown to get the reliability of the full four-detector score. Reporting the best split
 * would be the same sin as reporting the best detector, so the median is used. */
const SPLITS = [[['cambi', 'blur'], ['block', 'grain']], [['cambi', 'block'], ['blur', 'grain']],
  [['cambi', 'grain'], ['block', 'blur']]];
const halves = SPLITS.map(([A, B]) => corr(
  rows.map((_, i) => A.reduce((s, d) => s + EXPECT[d] * Z[d][i], 0)),
  rows.map((_, i) => B.reduce((s, d) => s + EXPECT[d] * Z[d][i], 0)),
));
const medR = halves.slice().sort((a, b) => a - b)[1];
const reliability = (2 * medR) / (1 + medR);

/* The anchor: the measured gap in P between WEB-sourced and Bluray-sourced units. This is the
 * quantity the lab pairs with an external bitrate belief to get a scale. A GROUP MEAN is used
 * deliberately — it is far less noisy than any per-film reading, which is what makes the resulting
 * scale stable where every per-film exchange rate exploded (11.21). */
const idxWeb = rows.map((u, i) => i).filter((i) => /WEB/i.test(rows[i].source || ''));
const idxBlu = rows.map((u, i) => i).filter((i) => /Bluray/i.test(rows[i].source || ''));
const anchorGap = mean(idxWeb.map((i) => P[i])) - mean(idxBlu.map((i) => P[i]));
const anchorSE = Math.sqrt(sd(idxWeb.map((i) => P[i])) ** 2 / idxWeb.length
  + sd(idxBlu.map((i) => P[i])) ** 2 / idxBlu.length);

/* THE SHRINKAGE, and it is NOT the reliability — see BPP-PLUS 11.37.
 *
 * Split-half reliability answers "how much of P is a common factor across disjoint detector halves".
 * That is what proved the factor exists, but a common factor is not a PROVENANCE factor: shooting
 * style, grade, lens, mastering house and deliberate softness all land in it, and no download fixes
 * any of them. Using 0.393 implied the library spans +-27 generations from master, which is absurd.
 *
 * The fraction of P's variance that observable provenance accounts for is the right quantity, and
 * source label is the only provenance marker this library carries. Between-label variance is a
 * LOWER bound because labels are coarse — two Blurays can differ by group, preset and generation
 * while sharing a label — so this errs toward saying too little, which is the affordable direction. */
const labelOf = (u) => (/WEBRip/i.test(u.source || '') ? 'WEBRip'
  : /WEBDL|WEB-DL/i.test(u.source || '') ? 'WEB-DL'
    : /Bluray/i.test(u.source || '') ? 'Bluray'
      : /HDTV/i.test(u.source || '') ? 'HDTV' : 'other');
const byLabel = {};
rows.forEach((u, i) => { (byLabel[labelOf(u)] ||= []).push(P[i]); });
const grand = mean(P);
let betweenSS = 0; let nLab = 0;
for (const v of Object.values(byLabel)) {
  if (v.length < 10) continue;
  betweenSS += v.length * (mean(v) - grand) ** 2;
  nLab += v.length;
}
const provFraction = betweenSS / Math.max(1, nLab - 1) / (sd(P) ** 2);
const shrinkLegacy = Math.sqrt(provFraction);

/* *** provShare, ADOPTED 2026-08-28 FROM A DIRECT MEASUREMENT. *** -> E.4.5
 * The legacy value above is sqrt(between-source-label variance fraction) — an ESTIMATE built on the
 * ONE field contrast available (the WEB/Bluray source tag), which 11.44 showed is dominated by bits.
 * It shipped at 0.0748 and was long described as "measured", which it was not.
 *
 * It is now measured properly. P is ALREADY residualised against bits, complexity and codec, so any
 * variance an OBSERVED provenance marker explains is provenance BY CONSTRUCTION. The bitstream
 * encoder fingerprint recovers the encoder identity for 85.7% of the library (67 distinct x264
 * builds, plus ref/bframes/subme/psy_rd/me/deblock/rc) — a marker 11.50 wrongly said did not exist.
 * On the 803 films carrying both a P and an identity, with a pre-specified 19-parameter feature set:
 *     encoder identity alone        adjusted R2  0.1089
 *     year alone                    adjusted R2  0.0210
 *     encoder OVER AND ABOVE year         dAdjR2  0.1074
 *     permutation null, 400 shuffles   p95 0.0147,  p = 0.0025
 * The year confound is the one that could have faked it — build number tracks year, year tracks
 * content — and it does not: year explains 2.1%, encoder adds 10.7 points on top.
 *
 * IT IS A LOWER BOUND. Unobserved provenance — generation count, what the source was, what the
 * previous encoder did — is not in these features and can only add.
 *
 * NO DOUBLE-COUNTING WITH MEASUREMENT NOISE. 0.1089 is the fraction of the OBSERVED (4-clip, noisy)
 * P's variance that encoder identity explains, so it is already net of sampling noise and is the
 * correct multiplier for the observed P. Do not additionally shrink by P's reliability (0.674). */
const PROV_SHARE_MEASURED = 0.1089;
const shrinkFloor = PROV_SHARE_MEASURED;

/* dP per generation, from data/anchor-crossed.json, expressed in the SAME library-P units used above.
 * The offset does not apply to a ladder rung (there is no residual to centre) but the SCALE does. */
let dPdGen = null;
try {
  const cross = JSON.parse(fs.readFileSync('data/anchor-crossed.json', 'utf8'));
  const pRung = (m) => DET.reduce((s, d) => s + (m[d] > 0 ? (EXPECT[d] * Math.log(m[d])) / sdOf[d] : 0), 0) / sP;
  const per = [];
  for (const f of cross.films || []) {
    const b = (f.legB || []).filter((r) => DET.every((d) => r[d] > 0)).sort((x, y) => x.gen - y.gen);
    if (b.length < 2) continue;
    const s = (pRung(b[b.length - 1]) - pRung(b[0])) / (b[b.length - 1].gen - b[0].gen);
    if (s > 0) per.push(s);
  }
  if (per.length >= 4) dPdGen = per.sort((a, b) => a - b)[per.length >> 1];
} catch { /* optional until the crossed ladder has run */ }

const out = {
  generated: Date.now(),
  note: 'Provenance factor P: standardised, bits/content/codec removed. See scripts/provenance-factor.mjs',
  n: rows.length,
  direction: EXPECT,
  /* Per-detector residual sd, in LOG detector units — the divisor that turns a raw residual into a
   * z. Emitted because any analysis that wants to put a CLIP-LEVEL quantity on the same scale as the
   * z's needs it, and there is no way to recover it from the stored z's alone (the fitted part is not
   * stored). Used by scripts/P-one-thing.mjs to convert within-film clip variance into z units and so
   * subtract the scene-sampling nuisance from the between-film covariance. */
  resSd: sdOf,
  splitHalf: halves,
  reliability,
  /* The shipped shrinkage and its bracket. The ceiling comes from physics rather than from data:
   * requiring the library's +-3 sd span to be at most 4 generations gives 4 * dPdGen / 3. dPdGen is
   * the crossed ladder's measured 0.1121 P-sd per generation (scripts/anchor-crossed.js). */
  shrink: { floor: shrinkFloor, ceiling: (4 * 0.1121) / 3, provFraction, rejected: reliability,
    legacy: shrinkLegacy,
    what: 'MEASURED 2026-08-28: adjusted R2 of P on the bitstream encoder fingerprint, 803 films, '
      + 'p=0.0025 vs a 400-shuffle null, year-controlled. A LOWER bound. Was sqrt(between-source-'
      + 'label variance fraction) = ' + shrinkLegacy.toFixed(4) + ', an estimate, not a measurement.' },
  /* MEASURED, not believed: 16 films, both legs on the same clips, ratio of median slopes.
   * A near-independent replication of the original 8-film run (only 2 films overlap, the stride
   * changed): 33.1% -> 35.6%, with the spread 6.7x tighter (sd 118.6 -> 17.7), no fragile films,
   * and 16/16 passing both direction checks. The two shared films reproduced almost exactly
   * (Mr. Robot 40.8 -> 40.9, 12 Angry Men 55.7 -> 54.7).
   * STILL A FLOOR, because generation loss saturates (2nd step 0.62x the 1st) so a linear fit
   * through generations 1-3 understates the first one. */
  anchorPctMeasured: 35.6,
  /* dP per GENERATION, in library-P sd, read from the crossed ladder using the scales above.
   * THIS, NOT THE GAP, IS THE CALIBRATION DENOMINATOR — see BPP-PLUS 11.39. Using the gap assumes
   * the WEB-vs-Bluray difference is exactly one generation; measured, it is about two, so the gap
   * route understated every adjustment by that factor and disagreed with its own shrinkage about
   * how many generations the library's extremes sit from typical. */
  dPdGen,
  anchor: { gap: anchorGap, se: anchorSE, nWeb: idxWeb.length, nBluray: idxBlu.length,
    what: 'mean P(WEB) - mean P(Bluray), in sd units of P' },
  units: Object.fromEntries(rows.map((u, i) => [u.key, {
    P: Number(P[i].toFixed(4)),
    z: Object.fromEntries(DET.map((d) => [d, Number(Z[d][i].toFixed(3))])),
    cambi: u.cambi, block: u.block, blur: u.blur, grain: u.grain,
    codec: u.codec, source: u.source,
    /* THE FILE IDENTITY, and without it a consumer CANNOT TELL A STALE READING FROM A FRESH ONE.
     * These four detectors are measured offline on the file that was on disk at backfill time. When
     * a film is later replaced, the reading describes a file we no longer hold — and P would go on
     * adjusting the new file's score by the old file's damage, silently and in the wrong direction.
     * bpp is the identity available here (the backfill carries no path/size/mtime), and it is a good
     * one: a replacement that did not change the bitrate is not a replacement worth detecting.
     * cxEff rides along so a consumer can also spot a re-probe that moved the denominator. */
    bpp: u.bpp, cxEff: u.cxEff,
  }])),
};
fs.writeFileSync('bpp-lab/public/provenance.json', JSON.stringify(out));
console.log(`wrote bpp-lab/public/provenance.json — ${rows.length} units`);
console.log(`  split-half ${halves.map((h) => h.toFixed(3)).join(' ')}  median ${medR.toFixed(3)}  reliability ${reliability.toFixed(3)}`);
console.log(`  provShare ${shrinkFloor.toFixed(4)} MEASURED from the encoder fingerprint (was ${shrinkLegacy.toFixed(4)}, `
  + `a x${(shrinkFloor / shrinkLegacy).toFixed(2)} change to every adjustment)`);
console.log(`  anchor gap WEB-Bluray = ${anchorGap.toFixed(3)} +- ${anchorSE.toFixed(3)} sd of P (t=${(anchorGap / anchorSE).toFixed(2)})`);
