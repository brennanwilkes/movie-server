// THE ARTIFACT / PROVENANCE FACTOR, IN PRODUCTION.
//
// WHAT IT IS. BPP+ judges a file by its bits and its content. But
//     artifacts = f(bits, content, ENCODER, SETTINGS, MASTER, GENERATIONS, PREPROCESSING)
// and BPP+ sees only the first two. Two files with identical bits and identical content can differ
// in quality by a factor of two. So: measure four artifacts, predict what each SHOULD be from bits
// and content, and read the difference. That difference is P.
//
//     P > 0   more damaged than its bitrate and content explain
//     P < 0   cleaner than they explain
//
// The score adjustment is a multiplier on the DENOMINATOR, which is what makes it inherit correctly
// everywhere (see complexityForKey in probe.js):
//     target *= exp(strength * provShare * lambda * P)
// BPP+ takes a square root of the target, so this lands as exp(-0.5*...) on the score itself —
// exactly the shipped rule, and the sqrt halves any misread. banding.js predicted this shape in
// 2026-08 before it existed: "if it is ever folded in, it multiplies the DENOMINATOR".
//
// *** WHY THIS JOB EXISTS AT ALL, RATHER THAN READING WHAT THE CONTROLLER ALREADY HAS. ***
// The controller already stores banding (banding-cache.json, 422 units) and blockMean/blurMean (the
// probe cache, ~1048 units). It would be cheap to build P out of those and WRONG. Task 97 tested
// exactly that swap — sourcing block/blur from the nightly probe instead of from the same clips as
// the other detectors — and it FAILED its pre-registered arbiter at 355/20000 against a bar of 100.
// P is only valid when all four detectors read THE SAME CLIPS, because the residualisation cannot
// separate a detector difference from a scene difference. Grain, meanwhile, the controller has never
// measured at all. Hence one job that measures all four together.
//
// NO PROBE_VERSION BUMP. This job has its own cache and its own VERSION. It adds a read-time factor
// derived from stored fields; it does not change how complexity is measured. Bumping PROBE_VERSION
// would discard 1044 complexity measurements to change a multiplication.
//
// CONSTANTS ARE MEASURED OR DECIDED, NEVER TUNED. See docs/BPP-PLUS-FORMULA.md §3.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('./config');
const app = require('./app');
const jobs = require('./jobs');
const metrics = require('../metrics');
const probe = require('./probe');
const { isMasterPaused } = require('./movie-mode');

// ---- CONSTANTS ────────────────────────────────────────────────────────────────────────────────
// *** STRENGTH IS A DECISION, NOT A DIAL. Brennan, 2026-08-29: 100%. ***
// It is the exchange rate between "how much provenance evidence we have" and "how much the score
// should move" — a preference, not a quantity, and nothing was ever going to measure it. Shipping it
// as a constant rather than a setting is deliberate: a default invites tuning, a decision does not.
const STRENGTH = Number(cfg.ARTIFACT_STRENGTH || 1.0);
// provShare: the fraction of observed P's variance attributable to provenance. MEASURED 2026-08-28
// as the adjusted R2 of P on the bitstream encoder fingerprint — 803 films, p=0.0025 against a
// 400-shuffle null, year-controlled (year alone explains 2.1%; encoder adds 10.7 points on top).
// A LOWER bound: unobserved provenance can only add.
// DO NOT additionally shrink by P's reliability (0.674). 0.1089 is already the fraction of the
// OBSERVED, noisy, 4-clip P that is provenance, so sampling noise is netted out. Applying both
// double-counts. The shrinkage is provShare, not sqrt(provShare) — that is a choice of objective
// (MSE-optimal per film), and this score is consumed per film.
const PROV_SHARE = Number(cfg.ARTIFACT_PROV_SHARE || 0.1089);
// lambda = ln(1 + anchor) / dPdGen. NOT a free constant: the anchor was itself DERIVED from dPdGen
// via the crossed ladder, so the generation step cancels and lambda = 1/|dP/dlog bpp| = 1.519.
// Anyone "improving" dPdGen alone moves lambda by arithmetic accident, not by a finding.
const ANCHOR_PCT = 35.6;
const DPDGEN = 0.2005;
const LAMBDA = Math.log(1 + ANCHOR_PCT / 100) / DPDGEN;
// A CORRUPTION BACKSTOP, AND IT MUST NEVER BIND ON REAL DATA.
//
// *** THIS SHIPPED WRONG ONCE. *** It was 1.35, justified in this comment as needing "|P| ~ 3.7 sd,
// which no real unit reaches". That arithmetic was wrong by a factor of two: the exponent is
// strength*provShare*lambda = 0.16541, so 1.35 is reached at |P| = ln(1.35)/0.16541 = 1.81 sd, not
// 3.7. Measured on the live library the moment it deployed: P spans -3.01 to +3.68 and **71 of 1048
// units (6.8%) were being clamped**. That is not a backstop, it is a CUT-OFF quietly flattening both
// tails — the exact thing this project has removed everywhere else (a max is a cut-off, and so is a
// hinge; docs/BPP-PLUS-FORMULA.md section 4).
//
// 3.0 needs |P| = 6.6 sd. A standardised index over ~1000 units cannot reach that without the
// standardisation itself having failed, which is precisely the corruption this is here to catch.
// The real uncapped factor range on the current library is 0.608 to 1.838, comfortably inside.
//
// IF YOU EVER SEE THIS BIND, DO NOT RAISE IT — something upstream is broken.
const FACTOR_MAX = Number(cfg.ARTIFACT_FACTOR_MAX || 3.0);

// ---- THE ADEQUACY TERM ────────────────────────────────────────────────────────────────────────
// THE THIRD TERM, and the only one that CAN move the library median. The other two cannot: BPP+0 is
// bits vs cost, and P is centred on the library so it is zero-sum by construction.
//
// WHAT IT IS. 100 is defined qualitatively -- the ELBOW of the rate-distortion curve, where more
// bits give diminishing returns and fewer fall away steeply. CRF 20 is ONE estimator of that elbow
// (the probe's). "Artifacts below their visibility threshold" is a SECOND, INDEPENDENT estimator of
// the SAME elbow, using different physics and a different instrument. This pools them. Where they
// agree nothing moves; where they disagree, that disagreement is information about the film.
//
// *** THE ESTIMATOR GIVES A BOUND, NOT A POINT. *** Clean means "at LEAST the elbow"; dirty means
// "at MOST the elbow". It can never say how far. Everything below follows from that asymmetry, and
// three earlier formulations died by ignoring it:
//   1. A logistic of banding on "is BPP+ >= 100" was CIRCULAR -- BPP+ >= 100 is the OTHER
//      estimator's answer, so it measured agreement between estimators, not the physics. It also
//      gave grainless clean films 19% less credit than grainy clean ones, which is precisely the
//      "don't punish modern films for having no grain" failure.
//   2. A lognormal prediction interval on the clip readings was the WRONG SHAPE for a detector that
//      reads exactly 0 on most clips and spikes on one. Empire Strikes Back scored +0.88 "clean"
//      with a visibly banded scene in it.
//   3. Pulling dirty films TOWARD 100 is wrong: a dirty film sitting AT 100 has nowhere to fall,
//      yet dirty means "below the elbow". Office Space (banding 5.36, nearly 2x threshold) moved
//      -0.2 points. The dirty side needs a target BELOW 100.
//
// THE FORM THAT SURVIVES. Per clip, a smooth saturating vote; then the mean; then an evidence
// shrink so 8 clips and 32 clips differ:
//     c_i = 2*Phi((ln T - ln L_i)/LEVEL_LOGSD) - 1        smooth, saturating, per clip
//     c   = mean(c_i) * n/(n + CLIP_PRIOR)                 in (-1, +1)
// SATURATION IS THE POINT: banding 0.01 and 0.09 both give c_i = 1.0, so a grainless clean film
// gets exactly the credit a grainy clean film does. Grain is irrelevant BY CONSTRUCTION rather than
// by control -- MEASURED: grainy films band 6.9x less, so any non-saturating form becomes a grain
// bonus (task 28's failure mode).
// It is NOT a counted scene fraction -- that is a cut-off (98). Each clip votes on a continuum.
const ADQ_T = Number(cfg.ADEQUACY_THRESHOLD || 2.817);   // BANDING_HIGH, matches banding.js
const ADQ_SD = Number(cfg.ADEQUACY_LEVEL_LOGSD || 0.242); // MEASURED, 21 paired readings
const ADQ_FLOOR = 1e-3;          // CAMBI reports exact 0; a numeric floor, not a verdict boundary
const CLIP_PRIOR = 4;            // evidence shrink: 8 clips -> cap 0.67, 16 -> 0.80, 32 -> 0.89
// w: the split-half reliability of c at 8 clips, MEASURED over 422 films x 70 disjoint 4/4 splits
// (r=0.5994, Spearman-Brown to 8). Independently corroborated: banding.js derives 0.73 at 8 clips
// by a different route. NOT a chosen dial.
const ADQ_W = Number(cfg.ADEQUACY_W || 0.7496);
// How far below the elbow a confidently-dirty film sits. A DECISION, like strength: the estimator
// establishes WHICH SIDE of the elbow a film is on, never how far, so this bounds the claim.
// ln 2 => a fully dirty film targets half the elbow.
const ADQ_KAPPA = Number(cfg.ADEQUACY_KAPPA || Math.LN2);

const _phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
function erf(x) {                       // Abramowitz-Stegun 7.1.26, |err| < 1.5e-7
  const s = x < 0 ? -1 : 1; const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
// softplus, computed stably. Used instead of max(0, .) so the bound has NO HINGE -- a hinge is a
// cut-off in disguise, and this project has removed every other one.
const softplus = (x) => Math.log1p(Math.exp(-Math.abs(x))) + Math.max(x, 0);

// c for one unit, from its per-clip banding readings. null when there are none.
function adequacyC(clips) {
  if (!Array.isArray(clips) || !clips.length) return null;
  let sum = 0;
  for (const v of clips) {
    sum += 2 * _phi((Math.log(ADQ_T) - Math.log(Math.max(Number(v) || 0, ADQ_FLOOR))) / ADQ_SD) - 1;
  }
  const n = clips.length;
  return (sum / n) * (n / (n + CLIP_PRIOR));
}
// The score shift. Clean pulls UP toward 100 and saturates above it; dirty pulls DOWN toward a
// target strictly BELOW 100, so a dirty film sitting at 100 can still fall.
function adequacyDelta(bppPlus, c) {
  if (c == null || !(bppPlus > 0)) return 0;
  if (c > 0) return ADQ_W * c * softplus(100 - bppPlus);
  return ADQ_W * c * softplus(bppPlus - 100 * Math.exp(ADQ_KAPPA * c));
}

// The four detectors and the direction a further re-encode physically pushes each. PRE-REGISTERED
// from the physics, never fitted: another generation ADDS banding, blocking and blur and DESTROYS
// grain. PC1 of the residual correlation matrix independently lands on the same pattern (cos 0.947),
// which is corroboration that the data agrees, not the source of the direction.
const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = { cambi: +1, block: +1, blur: +1, grain: -1 };

const VERSION = 1;
const CACHE = cfg.ARTIFACT_CACHE || '/config/artifact-cache.json';
const FFMPEG = cfg.ARTIFACT_FFMPEG || '/tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg';
// Same build as FFMPEG, deliberately: probeFile() reports the codec and duration that THIS
// binary will see when it decodes the clips, which is the only thing the grid may depend on.
const FFPROBE = cfg.ARTIFACT_FFPROBE || FFMPEG.replace(/ffmpeg$/, 'ffprobe');
// 4 clips x 2s, matching data/artifact-backfill.json EXACTLY. This is not a tunable: every measured
// constant downstream (provShare, the reliability figures, the arbiter pass) was computed on a
// 4-clip P, and a P measured at a different clip count is a different quantity.
const SAMPLES = Number(cfg.ARTIFACT_SAMPLES || 4);
const SECLEN = Number(cfg.ARTIFACT_SECLEN || 2);
const THREADS = Number(cfg.ARTIFACT_THREADS || 2);
const TICK_MS = Number(cfg.ARTIFACT_TICK_MS || 60 * 1000);
const RETRY_MS = 7 * 24 * 3600 * 1000;

let cache = new Map();
let _dirty = false;
let _tickLock = false;
let _busy = false;
let _child = null;
let _units = [];
let _unitByKey = new Map();
let _unitsAt = 0;
let _session = null;
let _fit = null;          // the P model, rebuilt when the cache changes

const toolReady = () => { try { return fs.existsSync(FFMPEG); } catch { return false; } };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1));
};
// Same file identity the probe and the banding job use. A measurement belongs to a FILE, not to a
// title: replace the copy and the reading describes something we no longer hold.
const fileId = (f) => (f ? `${f.path}|${f.size}|${f.mtime}` : '');
const firstFile = (u) => (u && u.files && u.files.length ? u.files[0] : null);

// ---- CACHE ───────────────────────────────────────────────────────────────────────────────────
function load() {
  try {
    const obj = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (obj.v !== VERSION) {
      console.log(`artifacts: cache was written under v${obj.v}, this build is v${VERSION} — discarding`);
      return;
    }
    for (const [k, v] of Object.entries(obj.entries || {})) cache.set(k, v);
    console.log(`artifacts: loaded ${cache.size} measurements (v${VERSION})`);
  } catch { /* first boot */ }
}
function save() {
  if (!_dirty) return;
  try {
    const tmp = `${CACHE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      v: VERSION, ts: Date.now(), entries: Object.fromEntries(cache),
    }));
    fs.renameSync(tmp, CACHE);
    _dirty = false;
  } catch (e) { console.log(`artifacts: save failed — ${e.message}`); }
}

// ---- THE P MODEL ─────────────────────────────────────────────────────────────────────────────
// Each detector is regressed, in log space, on a surface carrying bits, content AND codec. What is
// left over is the part the bitrate does not explain.
//
// *** THE SURFACE MUST KEEP log(bpp) AND log(cx) AS SEPARATE BASIS VECTORS. *** Do not "simplify" it
// to take log(BPP+) as a single regressor. Carrying them separately is what makes P and lambda
// INVARIANT to the complexity exponent `a` — every possible BPP+ already lies in this column space,
// so changing `a` cannot move P. That invariance is a proof, not a measurement, and it is the reason
// there is no ordering hazard between this and any future exponent change.
//
// REMOVING CODEC IS NOT OPTIONAL: bpp already carries a x1.6 codec factor, so a P that still read
// codec would double-count it. Measured — hevc sat a full sigma below h264 before this control and
// at 0.000 after.
const basis = (lb, lc, hev) => [1, lb, lb * lb, lc, lc * lc, lb * lc, hev, hev * lb];

// Normal-equations OLS with partial pivoting. 8x8 over ~1000 rows — microseconds, and it runs only
// when the cache changes, never per request.
function ols(X, y) {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i += 1) {
    for (let a = 0; a < p; a += 1) {
      b[a] += X[i][a] * y[i];
      for (let c = 0; c < p; c += 1) A[a][c] += X[i][a] * X[i][c];
    }
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

// The minimum library on which a residual is meaningful. Below this the surface has 8 parameters and
// almost no data, so it would fit the noise and every P would be an artifact of the fit. Refusing to
// produce P at all is the correct answer — the factor falls back to 1.0 and every score is simply
// the unadjusted one.
const MIN_UNITS = Number(cfg.ARTIFACT_MIN_UNITS || 120);

// Rebuild the model from every usable measurement. Called on cache change, not per request.
function refit() {
  const rows = [];
  for (const [key, e] of cache) {
    if (!e || e.error) continue;
    if (!DET.every((d) => e[d] > 0)) continue;
    const cx = probe.complexityForKey(key);
    if (!cx || !(cx.complexity > 0) || !(e.bpp > 0)) continue;
    rows.push({ key, e, bpp: e.bpp, cx: cx.complexity });
  }
  if (rows.length < MIN_UNITS) {
    _fit = { n: rows.length, ready: false, P: new Map() };
    return _fit;
  }
  const lb = rows.map((r) => Math.log(r.bpp));
  const lc = rows.map((r) => Math.log(r.cx));
  const hev = rows.map((r) => (String(r.e.codec || '').toLowerCase().includes('hevc')
    || String(r.e.codec || '').toLowerCase().includes('265') ? 1 : 0));
  const X = rows.map((_, i) => basis(lb[i], lc[i], hev[i]));

  const Z = {};
  const resSd = {};
  for (const d of DET) {
    const y = rows.map((r) => Math.log(r.e[d]));
    const beta = ols(X, y);
    if (!beta) { _fit = { n: rows.length, ready: false, P: new Map() }; return _fit; }
    const res = y.map((v, i) => v - X[i].reduce((s, x, j) => s + x * beta[j], 0));
    const s = sd(res) || 1;
    resSd[d] = s;
    Z[d] = res.map((v) => v / s);
  }
  // Sum in the pre-registered direction, then standardise across the library. P is therefore
  // CENTRED ON THIS LIBRARY: the adjustment is zero-sum and cannot move the median. It ranks files
  // against each other and says nothing about whether the library as a whole is well provisioned.
  const raw = rows.map((_, i) => DET.reduce((s, d) => s + EXPECT[d] * Z[d][i], 0));
  const m = mean(raw);
  const s = sd(raw) || 1;
  const P = new Map();
  rows.forEach((r, i) => P.set(r.key, (raw[i] - m) / s));
  // KEEP THE PER-DETECTOR z, which this function used to compute and throw away. P is their signed
  // sum, so P alone cannot answer "which detector is driving this" — the question the film page's
  // artifact panel exists to answer. Z[d] is index-aligned with `rows`, so this is exact rather
  // than a re-derivation. ~1050 four-key objects, about 125 KB.
  const zByKey = new Map();
  rows.forEach((r, i) => {
    const z = {};
    for (const d of DET) z[d] = +Z[d][i].toFixed(4);
    zByKey.set(r.key, z);
  });
  _fit = { n: rows.length, ready: true, P, Z: zByKey, resSd, builtAt: Date.now() };
  console.log(`artifacts: P model rebuilt over ${rows.length} units`);
  return _fit;
}
const fit = () => (_fit || refit());
const invalidate = () => { _fit = null; };

// ---- THE READ ACCESSOR ───────────────────────────────────────────────────────────────────────
// *** RETURNS null WHEN UNMEASURED, AND null IS NOT "CLEAN". *** Callers must treat it as unknown
// and apply a factor of exactly 1.0. This is the same contract bandingFor() carries, and it exists
// because 0 and null mean very different things for a damage measure.
function artifactFor(key) {
  const f = fit();
  if (!f.ready) return null;
  const P = f.P.get(key);
  if (P == null) return null;
  const e = cache.get(key);
  // A reading taken on a file we no longer hold describes a different encode. Report it as stale and
  // do NOT let it move the score — a replaced copy's damage is not this copy's damage.
  //
  // `staleAgainst` ALONE DID NOT IMPLEMENT THAT. It is frozen at import time and asks only whether
  // the imported row's bpp matched the unit as it stood then; nothing recomputes it, so a file
  // replaced afterwards left the guard reading false forever. Measured 2026-08-30: Apocalypse Now
  // was still being docked 14 BPP+ by a reading of a 17.6 GB WEBDL that had been swapped for a
  // 50.7 GB remux that morning — the probe had already moved on, the artifact factor had not. So
  // ask the LIVE file identity too, which is the question the comment above always claimed to ask.
  const stale = !!(e && (e.staleAgainst || fileChanged(e, unitFor(key))));
  const factor = stale ? 1 : Math.min(FACTOR_MAX, Math.max(1 / FACTOR_MAX,
    Math.exp(STRENGTH * PROV_SHARE * LAMBDA * P)));
  return {
    P: +P.toFixed(4),
    factor: +factor.toFixed(5),
    stale,
    levels: e ? { cambi: e.cambi, block: e.block, blur: e.blur, grain: e.grain } : null,
    // The residualised z behind P, per detector, so a consumer can say WHICH detector moved the
    // score rather than only by how much. Guarded on f.Z: refit() has two early returns that build
    // a Z-less _fit, and although both set ready:false (so we never reach here), a future third one
    // must not turn this into a crash.
    z: (f.Z && f.Z.get(key)) || null,
    // The worst clip, not just the average one. null on imported/older entries, which is honest:
    // those units genuinely have no per-clip record and must not claim one.
    maxes: e ? { cambi: e.cambiMax ?? null, block: e.blockMax ?? null,
      blur: e.blurMax ?? null, grain: e.grainMax ?? null } : null,
    ts: e ? e.ts : null,
  };
}
// The denominator multiplier alone, which is all probe.js needs. 1.0 for anything unmeasured, so an
// unmeasured unit scores exactly as it does today.
function artifactFactor(key) {
  const a = artifactFor(key);
  return a ? a.factor : 1;
}

// ---- MEASUREMENT ─────────────────────────────────────────────────────────────────────────────
// Two ffmpeg passes per clip, copied EXACTLY from scripts/artifact-backfill.js so the numbers are
// comparable with the 1048 units already measured there:
//   1. blockdetect + blurdetect on the decoded frames, and CAMBI via libvmaf against the same clip
//      as its own reference (CAMBI needs no master — that is why it is usable here at all).
//   2. hqdn3d denoise, differenced against the original, mean luma of the difference = grain.
// GRAIN IS CONTENT, NOT DAMAGE. A raw grain figure says "this film has grain", not "grain was
// destroyed" — which is why it enters P with a NEGATIVE sign (less grain than predicted = a further
// generation) and why it is never read as an absolute defect.
function runClip(file, t) {
  return new Promise((resolve) => {
    const log = path.join('/tmp', `art-${process.pid}-${Math.abs(t) | 0}.csv`);
    const a = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'info',
      '-ss', String(t), '-t', String(SECLEN), '-i', file,
      '-ss', String(t), '-t', String(SECLEN), '-i', file,
      '-lavfi', `[0:v]blockdetect,blurdetect[d];[d][1:v]libvmaf=feature=name=cambi:`
        + `n_threads=${THREADS}:log_path=${log}:log_fmt=csv`,
      '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    _child = a;
    let err = '';
    a.stderr.on('data', (d) => { err += d; });
    a.on('close', () => {
      _child = null;
      const grab = (re) => { const m = re.exec(err); return m ? Number(m[1]) : null; };
      let cambi = null;
      try {
        const L = fs.readFileSync(log, 'utf8').trim().split('\n');
        const col = L[0].split(',').indexOf('cambi');
        const v = L.slice(1).map((r) => Number(r.split(',')[col])).filter(Number.isFinite);
        cambi = v.length ? mean(v) : null;
      } catch { /* libvmaf wrote nothing */ }
      try { fs.unlinkSync(log); } catch { /* */ }

      const b = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error',
        '-ss', String(t), '-t', String(SECLEN), '-i', file, '-an', '-sn', '-vf',
        // *** format=yuv420p IS LOAD-BEARING. IT IS THE UNIT OF THE GRAIN MEASUREMENT. ***
        // signalstats reports YAVG in NATIVE PIXEL UNITS: 0-255 for an 8-bit source, 0-1023 for a
        // 10-bit one. grain is the mean luma of a denoise difference, so without this line a 10-bit
        // file reports ~4x the grain of an identical 8-bit file — 1023/255 = 4.012.
        //
        // MEASURED 2026-08-31, and it was live in production. 49 of 1047 units are yuv420p10le.
        // Their median grain was 3.909 against 0.948 for the 998 8-bit units; divide by 4.012 and
        // they land at 0.974, i.e. the SAME population. Every one of the 49 read above 2.0 and not
        // one 8-bit unit reached 4.0. Causal A/B on one ROTK clip, this chain with and without the
        // format: 3.51505 -> 0.87097, a ratio of 4.036 against the 4.012 predicted by the ranges.
        //
        // GRAIN ENTERS P WITH A NEGATIVE SIGN, so the inflation READ AS A BONUS: those units were
        // being told they were unusually faithful transfers because their pixels were wider. It
        // also poisoned the model itself — the `hev` coefficient on log(grain) was 0.851 (e^0.851 =
        // 2.3x) purely because 10-bit correlates with HEVC here. Correct the scale and it collapses
        // to 0.131. The surface was fitting a bit depth and calling it a codec.
        //
        // SAFE FOR THE 998 UNITS ALREADY MEASURED: on 8-bit input this is a no-op, verified to five
        // decimals on a Two Towers clip (1.31186 both ways). Only the 49 need re-measuring.
        //
        // Converting rather than dividing by 4 is deliberate. hqdn3d's 4:3:6:4 are ALSO in native
        // units, so a 10-bit hqdn3d is a slightly different denoiser, not the same one scaled —
        // forcing the depth makes every unit the same measurement instead of a corrected one.
        'format=yuv420p,split[a][b];[a]hqdn3d=4:3:6:4[d];[b][d]blend=all_mode=difference,signalstats,'
          + 'metadata=print:key=lavfi.signalstats.YAVG:file=-',
        '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
      _child = b;
      let out = '';
      b.stdout.on('data', (d) => { out += d; });
      b.on('close', () => {
        _child = null;
        const gv = out.split('\n').map((l) => /YAVG=([\d.]+)/.exec(l)).filter(Boolean)
          .map((m) => Number(m[1]));
        // hqdn3d has no temporal history on frame 1, so its first reading is not comparable.
        const use = gv.length > 2 ? gv.slice(1) : gv;
        resolve({
          cambi,
          block: grab(/block mean: ([0-9.]+)/),
          blur: grab(/blur mean: ([0-9.]+)/),
          grain: use.length ? mean(use) : null,
        });
      });
      b.on('error', () => { _child = null; resolve({}); });
    });
    a.on('error', () => { _child = null; resolve({}); });
  });
}

// ---- ASK THE FILE, NOT THE UNIT ──────────────────────────────────────────────────────────────
// TWO PRODUCTION BUGS OF THE SAME SHAPE came from trusting a field the unit does not have:
//
//   u.codec       -> always undefined, so every native entry stored codec: null
//   u.runtimeSec  -> always undefined, so `dur` was always 0 and the clip grid silently fell back
//                    to 60/180/300/420s: THE FIRST SEVEN MINUTES OF EVERY UNIT
//
// buildUnits() in probe.js sets kind/id/key/title/tmdbId/source/bpp/dur and files[{path,size,mtime}]
// and nothing else. Neither name has ever existed. Both failures were silent because `|| null` and
// `|| 0` are legal, so nothing threw and the numbers looked plausible.
//
// PROVEN, not inferred: of the 3 units measured natively, Moneyball and All the President's Men
// reproduce their STORED values on the 60/180/300/420 grid to five decimals on all four detectors
// (measured 2026-09-01). They were read off opening credits.
//
// So this asks ffprobe about the actual file we are about to measure. One spawn against the eight
// this job already runs per unit, and it cannot silently disagree with reality the way a unit field
// can. It also returns pix_fmt, which is the evidence trail for the 10-bit grain bug.
function probeFile(file) {
  return new Promise((resolve) => {
    // KEYED OUTPUT (nk=0), not bare values. With `nk=1` the three fields arrive as three unlabelled
    // lines and have to be told apart by shape — but "yuv420p" is as alphanumeric as "h264", so the
    // codec would be recovered by POSITION, silently returning a pixel format as the codec if
    // ffprobe ever reordered the fields. Guessing an identity from a value's shape is the same
    // mistake as reading u.codec off a unit that never had one; ask for the name.
    const p = spawn(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,pix_fmt:format=duration',
      '-of', 'default=nw=1:nk=0', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    let o = '';
    p.stdout.on('data', (d) => { o += d; });
    p.on('close', () => {
      const kv = {};
      for (const line of o.trim().split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      const dur = Math.floor(Number(kv.duration) || 0);
      resolve({
        codec: kv.codec_name || null,
        pixFmt: kv.pix_fmt || null,
        // N/A and negative durations both land on 0, which routes to the reported fallback.
        dur: Number.isFinite(dur) && dur > 0 ? dur : 0,
      });
    });
    p.on('error', () => resolve({ codec: null, pixFmt: null, dur: 0 }));
  });
}

// Kill the whole process group. The image has no pkill, and `detached: true` + kill(-pid) is the
// only thing that reliably takes down an ffmpeg mid-encode; `init: true` in compose reaps orphans.
function kill(why = 'stopped') {
  if (!_child) return;
  try { process.kill(-_child.pid, 'SIGKILL'); } catch { /* */ }
  try { _child.kill('SIGKILL'); } catch { /* */ }
  console.log(`artifacts: killed — ${why}`);
}

// ---- QUEUE ───────────────────────────────────────────────────────────────────────────────────
async function refreshUnits(maxAgeMs = 0) {
  if (_units.length && maxAgeMs && Date.now() - _unitsAt < maxAgeMs) return _units;
  _units = await probe.getUnits().catch(() => []);
  // Keyed alongside the array because artifactFor() now needs the live unit and is called PER ROW
  // on an Audit render — thousands of times. A .find() there would be O(units) per lookup, the same
  // ~1M-operation render probe.js already had to memo its way out of.
  _unitByKey = new Map(_units.map((u) => [u.key, u]));
  _unitsAt = Date.now();
  return _units;
}
const unitFor = (key) => _unitByKey.get(key) || null;
const entryFor = (u) => cache.get(u.key);
function measured(u) {
  const e = entryFor(u);
  return !!(e && !e.error && e.measuredFrom === fileId(firstFile(u)));
}
// Does this reading describe a file we no longer hold? IDENTITY ONLY — deliberately not version or
// clip count. Two callers need exactly this question and no more: the queue, which re-measures it,
// and artifactFor(), which must refuse to score with it. Folding stale()'s precision clauses in here
// would make an under-sampled but CURRENT reading stop scoring, which is a different decision and
// the wrong one.
function fileChanged(e, u) {
  if (!e || !u) return false;
  // A null measuredFrom is an import whose file identity was never verifiable (see importBackfill).
  // Caller decides what that means; it is not evidence of a change.
  if (!e.measuredFrom) return false;
  // Seasons are two sampled episodes and this job reads only the first — see the same clause in
  // banding.js. Legacy entries carry no unitFrom and keep the single-file test until re-measured.
  if (e.unitFrom) return e.unitFrom !== probe.unitFingerprint(u);
  return e.measuredFrom !== fileId(firstFile(u));
}

function stale(u) {
  const e = entryFor(u);
  if (!e || e.error) return false;
  if (e.v < VERSION || e.samples < SAMPLES) return true;
  if (!e.measuredFrom) return true;          // unverifiable import — always worth a real measurement
  return fileChanged(e, u);
}
function retryable(u) {
  const e = entryFor(u);
  return !!(e && e.error && Date.now() - (e.ts || 0) > RETRY_MS);
}
const pending = () => _units.filter((u) => firstFile(u)
  && (!entryFor(u) || stale(u) || retryable(u)));

// ---- TWO POOLS, AND THE SPLIT IS LOAD-BEARING ────────────────────────────────────────────────
// pending() is FIRST READINGS ONLY and must stay that way, because pendingCount() is what the
// probe's reciprocal yield consults: probe refinement stands down while any unit here has never
// been measured at all. Folding "could use more clips" into pending() would make that yield fire
// forever — the probe would stop refining permanently to wait on work that is never finished by
// design. Same shape as the probe's own nextUnit() vs nextImprecise() split.
//
// POOL_TARGET is a stopping point, not an ambition. 4 clips is demonstrably too few — 56% of units
// move >20% on clip choice — but the returns fall off as 1/sqrt(n) and #81 measured that extra
// clips buy little detector reliability past the first handful. 16 gives a 2x tightening over 4
// and costs 3 more visits per unit; beyond that the night budget is better spent elsewhere.
const POOL_TARGET = Number(cfg.ARTIFACT_POOL_TARGET || 16);
function underSampled(u) {
  const e = entryFor(u);
  if (!e || e.error) return false;
  if (fileChanged(e, u)) return false;          // a replaced copy is pending()'s problem, not ours
  return (e.samples || 0) < POOL_TARGET;
}
const underSampledQueue = () => _units.filter((u) => firstFile(u) && underSampled(u));

// ---- THE TICK ────────────────────────────────────────────────────────────────────────────────
async function artifactTick() {
  if (_tickLock) return;
  _tickLock = true;
  try {
    if (!toolReady()) { report(); return; }
    const manual = !!(_session && !_session.stopping);
    await refreshUnits(60 * 1000);
    // Same gate as the probe and banding: window, night budget, Movie Mode, temperature, playback,
    // Jellyfin — PLUS the shared heavy lease. Our own name, so the lease reports honestly.
    const blocked = await probe.probeGate(manual, 'artifacts');
    if (blocked) { report({ detail: `${blocked} · ${pending().length} left` }); return; }
    // The probe outranks us whenever it has FRESH work: a unit that has never been measured at all
    // beats a second axis on a unit we already understand. Ask the probe rather than reimplementing
    // the predicate — a duplicated copy of it once made banding measure nothing for a whole night.
    if (!manual && probe.probeHasFreshWork()) {
      report({ detail: `yielding to the quality probe · ${pending().length} left` });
      return;
    }
    if (!_units.length) { report(); return; }
    let queue = pending();
    // Stale first: a reading of a file that no longer exists is actively misleading, unlike a
    // missing one, and it is currently suppressing that unit's adjustment entirely.
    queue.sort((a, b) => (stale(b) ? 1 : 0) - (stale(a) ? 1 : 0));
    // FIRST READINGS BEFORE EXTRA CLIPS, always. A unit with no reading at all falls back to a
    // factor of exactly 1.0 — it gets no provenance adjustment whatsoever — which is a far larger
    // error than a unit whose four clips could be eight. Only when nothing is unmeasured does the
    // budget go to pooling, and then LEAST-SAMPLED FIRST so the library rises evenly instead of
    // taking a handful of films to 16 while the rest sit at 4.
    let pooling = false;
    if (!queue.length) {
      queue = underSampledQueue()
        .sort((a, b) => ((entryFor(a).samples || 0) - (entryFor(b).samples || 0))
          || a.key.localeCompare(b.key));
      pooling = true;
    }
    if (!queue.length) { report(); return; }
    const u = queue[0];
    const f = firstFile(u);

    if (!probe.acquireHeavy('artifacts')) {
      report({ detail: `yielding to the ${probe.heavyHolder()} job · ${queue.length} left` });
      return;
    }
    _busy = true;
    report({ detail: pooling ? `${u.title} · clip ${(entryFor(u).samples || 0) + 1}-${(entryFor(u).samples || 0) + SAMPLES} of ${POOL_TARGET}` : `measuring ${u.title}` });
    const t0 = Date.now();

    // *** THE GRID MUST MATCH scripts/artifact-backfill.js EXACTLY — 10%/30%/50%/70%. ***
    // Not "the middle 90%", which is what the old code here intended and never achieved.
    //
    // 1045 of the 1048 cached entries came from the backfill. P is standardised ACROSS THE LIBRARY,
    // so a re-measured unit is only comparable with the corpus the model is fit on if it reads the
    // SAME FRAMES. Within-title spread makes that decisive rather than pedantic: All the President's
    // Men reads cambi [0.013, 2.914, 0.059, 0.166] across four clips — an 18x range inside one film.
    // A "better" grid would buy nothing and cost commensurability with every row we hold.
    //
    // So this is deliberately the backfill's arithmetic, floors and all, not a tidied version of it:
    //     start = floor(dur * 0.1)   span = floor(dur * 0.8)   t = start + floor(span * k / SAMPLES)
    //
    // A PHASE TERM IS THE ONLY ADDITION, and at phase 0 it is a no-op that reproduces the line above
    // character for character. Revisits pass phaseForVisit(visits) — the same van der Corput
    // sequence the probe and banding use — so visit 1 lands on 20/40/60/80%, visit 2 on 15/35/55/75%,
    // and so on, FILLING THE GAPS rather than re-reading the same four frames. Coverage past 70%
    // therefore arrives on its own as visits accumulate, up to 90% in the limit.
    //
    // THIS IS WHY THE GRID DOES NOT NEED A COORDINATED RE-MEASURE. I argued for one on the premise
    // that third acts are worse and a half-swept library would be two biased populations. Tested
    // against the banding cache (8 clips, 957 units): widening the window shifts the mean by a
    // median 0.987, and clips past 70% read a median 0.873 of the middle ones with only 46% higher.
    // There is no systematic bias to protect against — only variance, and 56% of units move >20%
    // on clip choice. Variance is cured by ADDING clips, not by replacing them in lockstep.
    //
    // dur COMES FROM probeFile(), NOT FROM THE UNIT. `Number(u.runtimeSec) || Number(f.runtimeSec)`
    // was always undefined on both sides (see probeFile), so dur was always 0 and every native
    // measurement silently used the `60 + k*120` fallback: 60/180/300/420s, the first seven minutes.
    // Verified 2026-09-01 — Moneyball and All the President's Men reproduce their stored values on
    // that fallback to five decimals across all four detectors. They were read off opening credits.
    const info = await probeFile(f.path);
    const dur = info.dur;
    const span = dur > 0 ? Math.floor(dur * 0.8) : 0;
    const start = dur > 0 ? Math.floor(dur * 0.1) : 0;
    // A POOL FROM A DIFFERENT FILE IS NOT A POOL, IT IS A MIXTURE. Pool onto the previous reading
    // only when it describes the file on disk right now; a replaced copy starts over at visit 0.
    const prevE = entryFor(u);
    // *** A MEAN IS NOT A POOL. *** The 1045 imported rows kept only their four averages; the
    // per-clip values were never retained and are gone for good. Pooling onto such a row CLAIMS its
    // four positions as covered — so they are never measured again — while having no values to
    // carry forward, leaving the unit with 4 readings and 8 positions marked done. Measured on the
    // first live run: Ocean's Eleven came out visits 2, samplePos 8, values 4. Strictly worse than
    // either starting fresh or leaving it alone, and permanent.
    //
    // So a row with no per-clip record does not count as a previous visit at all. It re-measures
    // phase 0 once — the same 10/30/50/70 frames, so its mean barely moves — and that visit is the
    // one that finally writes the clips down. Every visit after it pools properly. One extra visit
    // per legacy unit, which was already budgeted, in exchange for a pool that actually accumulates.
    const prevHasClips = !!(prevE && prevE.samplesPer
      && DET.some((d) => ((prevE.samplesPer || {})[d] || []).length));
    const prevOk = !!(prevE && !prevE.error && !fileChanged(prevE, u) && prevHasClips);
    const visits = prevOk ? (prevE.visits || 1) : 0;
    const phase = visits > 0 ? probe.phaseForVisit(visits) : 0;
    const got = [];
    const pos = [];
    for (let k = 0; k < SAMPLES; k += 1) {
      // The fallback is kept only for a file ffprobe cannot read a duration from, and it is now
      // REPORTED rather than silent — a unit measured on it is not comparable and we must know.
      const t = span > 0 ? start + Math.floor((span * (k + phase)) / SAMPLES) : (60 + k * 120);
      if (span <= 0 && k === 0) console.log(`artifacts: ${u.title} — NO DURATION, using the 60/180/300/420 fallback; this reading is not grid-comparable`);
      /* eslint-disable no-await-in-loop */
      const m = await runClip(f.path, t);
      // Positions are kept as FRACTIONS of the runtime, not seconds, so the dedupe below still works
      // if ffprobe ever reports a duration a second or two different. They are also what lets a
      // clip be named as a timestamp in the lab.
      if (m && DET.some((d) => m[d] > 0)) { got.push(m); pos.push(dur > 0 ? +(t / dur).toFixed(4) : null); }
      if (await probe.probeGate(manual, 'artifacts')) break;   // a gate can close mid-unit
    }
    const wallMs = Date.now() - t0;
    probe.releaseHeavy('artifacts');
    _busy = false;
    probe.billNight(wallMs);

    if (!got.length) {
      cache.set(u.key, { v: VERSION, ts: Date.now(), key: u.key, title: u.title,
        error: 'no clip produced a reading', measuredFrom: fileId(f) });
      _dirty = true; save();
      console.log(`artifacts: ${u.title} FAILED`);
      report();
      return;
    }
    // ---- POOL, DO NOT REPLACE ─────────────────────────────────────────────────────────────────
    // This job used to overwrite its previous reading. It was the only one of the three that did:
    // the probe pools sampleGrid across visits, banding phase-shifts on revisit, artifacts threw
    // the old clips away. So a second visit bought nothing, and four clips of a two-hour film was
    // as good as it ever got — which is the actual defect. MEASURED on the banding cache: 56% of
    // units move more than 20% depending purely on WHICH four clips are drawn. That is variance,
    // and the cure is more clips, not different ones.
    //
    // DEDUPE BY POSITION IS LOAD-BEARING, not hygiene. The probe lost 25% of its refinement budget
    // to exactly this: it pooled visits without deduping, re-encoded identical positions, and
    // counted them twice (16 of 64 samples duplicated). A phase-shifted grid should never collide,
    // but "should never" is what that bug also assumed, so check rather than trust. Legacy rows
    // carry no positions at all — they are all phase 0, i.e. 10/30/50/70%, which is reconstructed
    // here rather than guessed, and a null position never matches anything so it cannot drop a clip.
    const POS_EPS = 0.005;                                   // 0.5% of runtime ~ 30s on a 2h film
    const legacyPos = (n) => Array.from({ length: n }, (_, i) => +(0.1 + (0.8 * i) / SAMPLES).toFixed(4));
    // For a legacy row assume ALL FOUR phase-0 positions are covered, not however many its cambi
    // array happens to hold. A detector can drop a clip on its own (measured: cambi 1/224, blur
    // 1/224), so per-detector lengths do not tell you which frames were visited. Over-claiming
    // coverage can only skip a clip; under-claiming would double-count one, and double-counting is
    // the failure that cost the probe a quarter of its budget.
    const oldPos = prevOk
      ? (Array.isArray(prevE.samplePos) && prevE.samplePos.length ? prevE.samplePos : legacyPos(SAMPLES))
      : [];
    const keep = pos.map((p) => p == null || !oldPos.some((q) => q != null && Math.abs(q - p) < POS_EPS));
    const dropped = keep.filter((x) => !x).length;
    if (dropped) console.log(`artifacts: ${u.title} — ${dropped} clip(s) landed on positions already pooled, not counted twice`);

    const av = {};
    const per = {};
    for (const d of DET) {
      const fresh = got.map((g) => g[d]).filter((x, i) => keep[i] && Number.isFinite(x) && x > 0);
      const prior = prevOk ? ((prevE.samplesPer || {})[d] || []) : [];
      const v = [...prior, ...fresh];
      av[d] = v.length ? +mean(v).toFixed(5) : null;
      /* *** RETAIN THE PER-CLIP READINGS, NOT JUST THE MEAN. ***
       * A MEAN HIDES THE ONE SCENE THAT MATTERS. Measured on the nightly banding job, which does
       * keep them: The Empire Strikes Back reads mean 0.459 -- comfortably "clean" -- from clips
       * [0, 3.47, 0.05, 0, 0, 0.13, 0, 0.02]. One genuinely banded scene, averaged into "fine".
       * That is trap 17 (a scene-level threshold applied to a film-level mean answers the wrong
       * question) caught in the wild, and without the array it is undetectable.
       * URGENT rather than nice-to-have: every unit measured before this change keeps only its
       * mean, and the clips are gone for good. */
      per[d] = v.map((x) => +x.toFixed(5));
      av[`${d}Max`] = v.length ? +Math.max(...v).toFixed(5) : null;
    }
    const cx = probe.complexityForKey(u.key);
    cache.set(u.key, {
      v: VERSION, ts: Date.now(), key: u.key, title: u.title, unit: u.kind,
      ...av,
      samplesPer: per,
      // The union of positions ever pooled onto this file, as fractions of runtime. Deliberately
      // NOT per-detector: a detector can drop a clip on its own, so these arrays would not stay
      // aligned. This is the coverage record — what the dedupe consults and what lets a clip be
      // named as a timestamp — not a value index.
      samplePos: [...oldPos, ...pos.filter((p, i) => keep[i] && p != null)]
        .filter((p) => p != null).sort((a, b) => a - b),
      visits: visits + 1,
      // bpp and cx are stored WITH the reading, not looked up later, because the residual is only
      // meaningful against the bits the file had when the artifacts were measured.
      bpp: u.bpp, cxEff: cx ? cx.complexity : null,
      // *** NEVER `u.codec` ALONE — A UNIT HAS NO codec FIELD. *** buildUnits() in probe.js sets
      // kind/id/key/source/bpp/dur and nothing else, so `u.codec || null` was ALWAYS null, and every
      // natively-measured entry stored codec: null while the 1045 imported ones carried a real one.
      // Silent, because null is a legal value here and nothing downstream complains.
      //
      // refit() derives the `hev` basis column from e.codec, so a null reads as h264 and an HEVC
      // unit gets residualised against the wrong surface. Nothing has been damaged yet — only 3
      // native entries exist and none is HEVC — but it is a landmine under any re-measure sweep,
      // which would have re-measured all 113 HEVC units and wiped the column library-wide.
      //
      // Taken from probeFile() — the file THIS job measured — rather than the probe cache. The two
      // disagree in the real library: Lost S01 and S05 are labelled hevc by the backfill and h264
      // by the probe, because for a season the probe picks its own episodes and this job takes
      // firstFile(u). Reading the measured file removes the question instead of choosing a side.
      codec: info.codec || null,
      // Recorded because it is the axis a whole class of bug lives on: signalstats reports YAVG in
      // NATIVE pixel units, and grain went unnoticed at 4x on 10-bit files for exactly as long as
      // nothing wrote the depth down. Costs one string; the chain now pins yuv420p regardless.
      pixFmt: info.pixFmt || null,
      source: u.source || null,
      // POOLED clip count, not this visit's. stale() reads it as "has a full first reading", and
      // underSampled() as "how much evidence is behind this row", so it must count everything the
      // file has contributed — never just the last four.
      samples: Math.max(...DET.map((d) => per[d].length), 0),
      seclen: SECLEN, wallMs,
      measuredFrom: fileId(f), unitFrom: probe.unitFingerprint(u),
    });
    _dirty = true; save();
    invalidate();          // the library changed, so every P changes — refit lazily on next read
    metrics.emitEvent('artifact_unit', { key: u.key, title: u.title, ...av, wallMs });
    console.log(`artifacts: ${u.title} — cambi ${av.cambi} block ${av.block} `
      + `blur ${av.blur} grain ${av.grain} `
      + `(visit ${visits + 1}, ${Math.max(...DET.map((d) => per[d].length), 0)} clips pooled, `
      + `${Math.round(wallMs / 1000)}s)`);
    report();
  } catch (e) {
    console.log(`artifacts: tick error — ${e.message}`);
  } finally {
    // Unconditional: releaseHeavy ignores a call from a job that does not hold the lease, and a
    // leaked lease would stall every heavy job until the 30-minute expiry reaped it.
    probe.releaseHeavy('artifacts');
    _busy = false; _tickLock = false;
  }
}

// ---- JOBS TAB ────────────────────────────────────────────────────────────────────────────────
// MUST BE SYNCHRONOUS and return a string or null. An async stateFn stores a Promise and renders a
// blank card — a bug banding.js shipped once and documented.
function artifactState() {
  if (!toolReady()) return 'off';
  if (_busy) return 'running';
  if (_session && !_session.stopping) return 'waiting';
  return null;
}
// Called on EVERY early return, including the gated ones. The tick returns early for ~19h a day, so
// without this the card would freeze on whatever it last said and look finished or stuck.
// banding.js has always had this helper; this module inlined the same expression in three places and
// so had nothing for report() to call. Named here rather than inlined a fourth time.
const sessionLive = () => !!(_session && !_session.stopping);

function report(extra = {}) {
  const total = _units.length;
  const left = pending().length;
  const done = Math.max(0, total - left);
  // The POOLING PHASE MUST BE VISIBLE. Once every unit has a first reading this job used to report
  // "every unit measured" and sit at 100% forever, which would now be a lie in the same way the
  // probe's bar was before it learned to say "refining complexity": there is real work left and
  // real budget going into it, and a card pinned at 100% is how that work becomes unaccountable.
  const shallow = left ? 0 : underSampledQueue().length;
  let detail;
  // extra.detail FIRST — it names the unit being measured right now. It used to be outranked by
  // the "every unit measured" branch, which would have swallowed every pooling message.
  if (!toolReady()) detail = `ffmpeg with libvmaf not found at ${FFMPEG}`;
  else if (!total) detail = 'waiting for the library list';
  else if (extra.detail) detail = extra.detail;
  else if (left) detail = `${done}/${total} measured · ${left} left`;
  else if (shallow) detail = `every unit measured · deepening ${shallow} below ${POOL_TARGET} clips`;
  else detail = `every unit measured · ${POOL_TARGET} clips each`;
  jobs.report('artifacts', {
    detail,
    // In the pooling phase the bar tracks CLIP COVERAGE, not units: units-with-a-reading is already
    // 100% and would never move again.
    progress: total
      ? (left ? { done, total }
        : { done: total - shallow, total })
      : null,
    // See the same clause in banding.js: the action list is STATE. Declared once at define() time
    // it rendered Stop with no session to stop, so the button never acknowledged a click.
    actions: sessionLive() ? ['stop-artifacts'] : ['start-artifacts'],
  });
}

// ---- IMPORT ──────────────────────────────────────────────────────────────────────────────────
// 1048 units were already measured offline into data/artifact-backfill.json with THIS EXACT recipe.
// Re-measuring them would cost weeks of night budget to reproduce numbers we already hold, so they
// are imported instead — the same migration path /api/banding/import exists for.
//
// The import is deliberately strict about the file identity it cannot verify: the backfill carries
// no path/size/mtime, only the bpp it measured at. So an imported row is marked `staleAgainst` when
// the unit's CURRENT bpp differs by more than 2% in log space, and a stale row contributes to the P
// FIT (its residual is still a valid observation of some file) but its FACTOR is forced to 1.0. That
// asymmetry is the honest one: it keeps the model's sample size while refusing to move a score using
// a measurement of a file we no longer hold.
function importBackfill(units, opts = {}) {
  const now = Date.now();
  let added = 0; let skipped = 0; let stalemarked = 0;
  for (const [key, u] of Object.entries(units || {})) {
    if (!DET.every((d) => u[d] > 0)) { skipped += 1; continue; }
    if (cache.has(key) && !opts.overwrite) { skipped += 1; continue; }
    const live = _units.find((x) => x.key === key);
    const f = live ? firstFile(live) : null;
    const staleAgainst = !!(live && live.bpp > 0 && u.bpp > 0
      && Math.abs(Math.log(live.bpp / u.bpp)) > 0.02);
    if (staleAgainst) stalemarked += 1;
    cache.set(key, {
      v: VERSION, ts: now, key, title: u.title || (live ? live.title : key), unit: u.unit || null,
      cambi: u.cambi, block: u.block, blur: u.blur, grain: u.grain,
      bpp: u.bpp, cxEff: u.cxEff, codec: u.codec || null, source: u.source || null,
      samples: u.n || SAMPLES, seclen: SECLEN,
      // No measuredFrom means the nightly queue will re-measure it eventually and replace the
      // import with a reading whose file identity IS known. That is the intended end state.
      measuredFrom: f && !staleAgainst ? fileId(f) : null,
      staleAgainst: staleAgainst || undefined,
      imported: true,
    });
    added += 1;
  }
  _dirty = true; save(); invalidate();
  return { added, skipped, stale: stalemarked, total: cache.size };
}

// ---- HTTP ────────────────────────────────────────────────────────────────────────────────────
function routes() {
  app.get('/api/artifacts', async (req, res) => {
    await refreshUnits(60 * 1000);
    const f = fit();
    res.json({
      version: VERSION,
      constants: { strength: STRENGTH, provShare: PROV_SHARE, lambda: +LAMBDA.toFixed(4),
        anchorPct: ANCHOR_PCT, dPdGen: DPDGEN, factorMax: FACTOR_MAX, samples: SAMPLES, seclen: SECLEN },
      model: { ready: f.ready, n: f.n, minUnits: MIN_UNITS, builtAt: f.builtAt || null,
        resSd: f.resSd || null },
      measured: cache.size,
      units: _units.length,
      pending: pending().length,
      busy: _busy,
      session: _session,
      toolReady: toolReady(),
      blockedBy: await probe.probeGate(!!(_session && !_session.stopping), 'artifacts').catch(() => null),
    });
  });

  app.get('/api/artifacts/dataset', (req, res) => {
    const f = fit();
    const rows = [];
    for (const [key, e] of cache) {
      if (!e || e.error) continue;
      rows.push({ key, title: e.title, cambi: e.cambi, block: e.block, blur: e.blur,
        grain: e.grain, bpp: e.bpp, cxEff: e.cxEff, codec: e.codec, source: e.source,
        // Same question artifactFor() asks, so the lab cannot show a row as current while the
        // scorer is refusing to use it. Reporting `staleAgainst` alone made every post-import
        // replacement read as fresh in the lab.
        samples: e.samples, imported: !!e.imported,
        stale: !!(e.staleAgainst || fileChanged(e, unitFor(key))),
        cambiMax: e.cambiMax ?? null, samplesPer: e.samplesPer || null,
        P: f.ready && f.P.has(key) ? +f.P.get(key).toFixed(4) : null,
        factor: artifactFactor(key) });
    }
    res.json({ generated: Date.now(), n: rows.length, ready: f.ready, rows });
  });

  app.post('/api/artifacts/import', async (req, res) => {
    await refreshUnits(60 * 1000);
    const body = req.body || {};
    let units = body.units;
    if (!units) {
      // Read the repo file directly so the migration is a one-liner from the Jobs tab rather than a
      // 300KB POST body.
      try {
        units = JSON.parse(fs.readFileSync(body.file || '/app/data/artifact-backfill.json', 'utf8')).units;
      } catch (e) { return res.status(400).json({ error: `cannot read backfill — ${e.message}` }); }
    }
    const out = importBackfill(units, { overwrite: !!body.overwrite });
    console.log(`artifacts: imported ${out.added} units (${out.stale} marked stale, ${out.skipped} skipped)`);
    return res.json(out);
  });

  app.post('/api/artifacts/session/start', (req, res) => {
    _session = { started: Date.now(), stopping: false };
    console.log('artifacts: manual session started — schedule waived, safety gates still on');
    // REPORT BEFORE TICKING, and do not rely on the tick to do it. artifactTick() returns instantly
    // when `_tickLock` is held, which it is for the whole ~2 minutes of a unit — so a session opened
    // mid-measurement would leave the card showing the PREVIOUS action set until the measurement
    // finished. That is the same "the button ignored my click" symptom this fix is for, just with a
    // narrower window. The session flag is already set above, so this paints the truth immediately.
    report();
    artifactTick();
    res.json(_session);
  });
  app.post('/api/artifacts/session/stop', (req, res) => {
    if (_session) _session.stopping = true;
    kill('session stopped');
    const s = _session; _session = null;
    // Push the card now rather than at the next tick — a minute of stale buttons is
    // indistinguishable from a dropped click.
    report();
    res.json(s || {});
  });
}

function startArtifacts() {
  load();
  refreshUnits().catch(() => {});
  const tracked = jobs.define({
    id: 'artifacts', name: 'Audit · artifact probe', group: 'Audit', weight: 98,
    what: 'Measures banding, blocking, blur and grain — the provenance BPP+ cannot see',
    every: null,
    scheduleText: 'nightly, after the quality probe · shares its budget',
    pausedByMovieMode: true,
    actions: ['start-artifacts'],   // swapped by report() as the session opens and closes
  }, artifactTick);
  jobs.report('artifacts', { stateFn: artifactState });
  if (!toolReady()) {
    jobs.disable('artifacts', 'ffmpeg with libvmaf not installed — run scripts/setup-vmaf-tool.sh');
  }
  refreshUnits().then(() => report()).catch(() => {});
  setInterval(tracked, TICK_MS);
  setInterval(save, 5 * 60 * 1000);
  console.log(`artifacts: armed — ${SAMPLES} clips x ${SECLEN}s, strength ${STRENGTH}, `
    + `provShare ${PROV_SHARE}, lambda ${LAMBDA.toFixed(3)}`);
}

routes();

// How many units have never been measured from the file currently on disk. Read by probe.js to
// decide whether its own REFINEMENT may run — see backfillPending() there. Counts first
// measurements and replacements alike, because both are "this unit has no valid reading", which is
// the thing that outranks tightening an error bar on a reading we already have.
const pendingCount = () => pending().length;

module.exports = {
  startArtifacts, artifactTick, adequacyC, adequacyDelta, pendingCount,
  ADQ_W, ADQ_T, ADQ_KAPPA,
  artifactFor, artifactFactor, importBackfill,
  refit, VERSION, STRENGTH, PROV_SHARE, LAMBDA,
};
