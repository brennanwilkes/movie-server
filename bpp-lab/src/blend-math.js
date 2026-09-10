/* BLEND MATH — the artifact-to-BPP+ shift and, more importantly, its standard error.
 *
 * WHY THIS FILE EXISTS SEPARATELY. Brennan, 2026-08-25, on the hardcoded upward cap:
 *
 *   "seems like a massive hole. We need a real number which adjusts and weights the formula, not
 *    some arbitrary cap. This is a math / analysis problem."
 *
 * He is right. The first cut of the Blend tab had THREE invented constants — L_FLOOR 0.25,
 * M_UP_FLOOR 0.5, FLAT 0.25 — each added after watching the tab produce a specific absurdity. Every
 * one of them was a symptom of the same missing quantity: we were computing a point estimate of the
 * shift and never computing how uncertain it was. Given the uncertainty, all three fall out of
 * standard statistics and none of them has to be chosen.
 *
 * This module is pure — no DOM, no imports — so scripts/blend-check.mjs can run the exact code the
 * lab runs. A number that only exists inside a chart cannot be checked against anything.
 *
 * ── THE ESTIMATE ─────────────────────────────────────────────────────────────────────────────────
 *     ln m = (ln T - ln L) / S            m = bitrate multiplier that brings the artifact to
 *                                             visibility threshold T
 *     BPP+_implied = BPP+ / sqrt(m)   =>  the shift in log space is  D = -0.5 * ln m
 *
 * ── THE UNCERTAINTY, which is the part that was missing ──────────────────────────────────────────
 * ln m depends on two measured quantities, each with its own error. By the delta method:
 *
 *     d(ln m)/d(ln L) = -1/S
 *     d(ln m)/dS      = -(ln m)/S
 *     Var(ln m) = [ Var(ln L) + (ln m)^2 * Var(S) ] / S^2
 *
 * Read what that expression does on its own, with nothing tuned:
 *
 *   - Flat slope        S -> 0, so Var blows up as 1/S^2. FLAT is no longer a cut-off, it is a
 *                       continuous loss of confidence. Swingers (S -0.22) dies on its own.
 *   - Far extrapolation the (ln m)^2 term grows QUADRATICALLY with how far the answer sits from the
 *                       data. This is precisely what M_UP_FLOOR was faking, and unlike a cap it is
 *                       per-film and scales with that film's own slope error.
 *   - Tiny level        L -> 0 makes |ln m| huge, which re-enters through the same quadratic term.
 *                       L_FLOOR was a blunt version of this.
 *
 * ── THE WEIGHT ───────────────────────────────────────────────────────────────────────────────────
 * Shrink each estimate toward "no change" in proportion to how much of its spread is real:
 *
 *     w = tau^2 / (tau^2 + sigma_i^2)      tau^2 = Var(D_hat) - mean(sigma^2)
 *
 * That is the standard empirical-Bayes / Kelley shrinkage the pinning work already uses, and tau^2
 * is estimated FROM THE FILMS, not chosen. If the observed spread of shifts is no bigger than the
 * measurement noise, tau^2 goes to zero and the whole correction switches itself off — which is the
 * honest outcome in that case, and the one no hand-set cap can express.
 */

export const RELIABILITY = 0.782;   // CAMBI split-half, Spearman-Brown corrected (BPP-PLUS.txt 9.5)

/* TWO MEASURED ERROR CONSTANTS. Both come from scripts/, neither is chosen, and both are the honest
 * replacement for a guard that used to be a number someone picked.
 *
 * LEVEL_LOGSD — how well do we know a film's banding level? 21 films carry two INDEPENDENT readings
 * of it: the nightly probe (8 clips) and the ladder's lossless rung (4 different clips, same file).
 * Regressing their squared difference on the squared level (scripts/cambi-noise-floor.mjs) gives
 *
 *     eps (additive floor)   0.0000     k (proportional)   0.242
 *
 * THE ADDITIVE FLOOR IS ZERO, and that falsified the fix I expected to make. The hypothesis was that
 * a reading of 0.003 must be "below the instrument", which would make Var(ln L) diverge near zero and
 * dissolve L_FLOOR for free. It does not: CAMBI agrees with itself to ~24% RELATIVE across three
 * orders of magnitude — The Big Sleep reads 0.0032 and 0.0017, a difference of 0.0014. The detector
 * is scale-free and there is no floor to find. Note this makes the numbers slightly MORE extreme, not
 * less: the old reliability-derived Var(ln L) was 0.612, the measured one is 0.059.
 *
 * MODEL_ERR_PER_LN — the fitted power law is LOCAL, and this is how fast it goes wrong. Fitting only
 * on 0.7-1.3 and scoring the wide rungs (measured 2026-08-25 across 5 films, 20 extrapolated rungs):
 *
 *     distance 0.0-0.4 ln   mean resid -0.023   sd 0.059
 *     distance 0.4-0.8      mean resid -0.015   sd 0.198
 *     distance 0.8-1.5      mean resid -0.206   sd 0.219      <- banding saturating
 *
 * rms 0.306 per ln-unit outside the fitted window, ZERO inside it. So extrapolation is penalised
 * continuously by how far it actually goes, using each film's own rungs as the window — which is what
 * a validity cut-off was crudely approximating. Refresh both when the 75-film run lands. */
export const LEVEL_LOGSD = 0.242;
export const MODEL_ERR_PER_LN = 0.306;

/* Ordinary least squares of y on x, returning the slope AND what the slope is worth: its variance,
 * the residual scale, and the leverage denominator. Var(S) = s^2 / Sxx is the textbook result and is
 * the input the delta method needs. */
export function fitLine(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i += 1) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  if (sxx <= 0) return null;
  const S = sxy / sxx;
  const a = my - S * mx;
  let sse = 0;
  for (let i = 0; i < n; i += 1) sse += (ys[i] - (a + S * xs[i])) ** 2;
  const s2 = n > 2 ? sse / (n - 2) : 0;               // residual variance
  return { S, a, n, sxx, s2, varS: s2 / sxx, xMean: mx };
}

/* A ladder's slope and its variance, from the film's own rungs. Falls back to the exported r^2 when
 * a ladder predates the points being carried, so an old run degrades rather than disappearing. */
export function slopeFromLadder(lad) {
  if (!lad) return null;
  const pts = (lad.points || []).filter((p) => p.level > 0 && p.cambi > 0);
  const fit = fitLine(pts.map((p) => Math.log(p.level)), pts.map((p) => Math.log(p.cambi)));
  if (fit) return { S: fit.S, varS: fit.varS, n: fit.n, measured: true };
  if (lad.S == null) return null;
  return { S: lad.S, varS: (lad.S * 0.25) ** 2, n: lad.n || 0, measured: true };
}

/* THE ANCHOR, and the one place a physical constraint beats a measurement. A film cannot band less
 * than its own LOSSLESS extract — that extract is the same pixels with no compression added, so it
 * is the curve's asymptote as bits -> infinity. When the nightly reading falls below it the two are
 * sampling different scenes, and taking the lower one invents headroom that cannot exist. The
 * Godfather is the case that exposed it: nightly 0.104, lossless 0.391, a factor of 3.8 that alone
 * accounted for most of the 110 -> 782 absurdity. */
export function anchorLevel(cambi, lad) {
  const ll = lad && lad.lossless != null ? lad.lossless : null;
  return ll != null && ll > cambi ? ll : cambi;
}

/* One film -> the shift and its standard error, both in log-BPP+ space. Returns null only when the
 * arithmetic has no answer at all (zero slope, non-positive level), never as a policy judgement. */
export function shiftOf({ bppPlus, cambi, lad, T, varLnL, predVarLnS, predictS }) {
  if (bppPlus == null || !(cambi > 0)) return null;
  const L = anchorLevel(cambi, lad);
  const sl = slopeFromLadder(lad);
  const S = sl ? sl.S : predictS(L);
  if (!Number.isFinite(S) || S === 0) return null;

  const lnM = (Math.log(T) - Math.log(L)) / S;
  if (!Number.isFinite(lnM)) return null;

  // A predicted slope carries the scatter of the level->slope law; a measured one carries its own
  // regression variance. Keeping these in the SAME units (variance of S) is what lets one weight
  // cover both, instead of the old hand-set 0.363 stand-in.
  const varS = sl ? sl.varS : (S ** 2) * predVarLnS;

  /* MODEL ERROR, and it must be SMOOTH — the first version was a hard cut-off in a variance costume.
   *
   * It used to measure distance from the EDGE of the film's rungs, max(0, loEdge - lnM, lnM - hiEdge),
   * which is exactly zero inside the ladder and then switches on. Divided by S^2 that hinge is
   * amplified enormously — for The Big Lebowski, S_grain 0.025 means a 1548x multiplier — so a
   * kink became a cliff, and the tab jumped discontinuously as the grain slider crossed it. Brennan
   * objected to arbitrary cut-offs repeatedly and this was one I had not recognised as one.
   *
   * The textbook quantity is smooth everywhere and needs no window: the OLS prediction variance grows
   * with squared distance from the CENTROID of the data, continuously, from a minimum at the centre.
   * Model misspecification is added on the same footing — the fitted shape is most trustworthy where
   * the rungs are and degrades smoothly away from them, which is the true statement. A deviation of d
   * in log-artifact units displaces the crossing by d/|S| in log-level, hence the shared 1/S^2. */
  const rungs = (lad && lad.points ? lad.points.map((p) => p.level) : []).filter((v) => v > 0);
  const lx = rungs.length ? rungs.map((v) => Math.log(v)) : [Math.log(0.7), Math.log(1.3)];
  const xBar = lx.reduce((a, b) => a + b, 0) / lx.length;
  const dist = Math.abs(lnM - xBar);
  const varModel = ((MODEL_ERR_PER_LN * dist) ** 2) / (S ** 2);

  const varLnM = (varLnL + (lnM ** 2) * varS) / (S ** 2) + varModel;

  const D = -0.5 * lnM;                       // shift in log-BPP+ space
  return { L, S, measured: !!sl, m: Math.exp(lnM), lnM, D, sigma: 0.5 * Math.sqrt(varLnM),
    varS, dist, implied: bppPlus * Math.exp(D) };
}

/* THE GRAIN AXIS, which anchors differently from every other artifact and must not be copy-pasted
 * from banding.
 *
 * Banding measures DAMAGE: a level of 4.99 is bad on any film. Grain measures CONTENT: a raw residual
 * of 1.02 means "this film has a lot of grain", which says nothing about whether any was destroyed.
 * A grainless CGI film and a ruined 35mm scan can read the same number. So the grain axis is only
 * meaningful as a RATIO to the film's own ungraded grain:
 *
 *     retention(level) = grain(level) / grain(lossless)
 *
 * which is 1.0 for the file we actually hold, by construction, and falls as bits come off. T_grain is
 * then "how much of its grain may a film lose before that is visible" — a fraction, comparable across
 * films, and the thing the lab's slider sets.
 *
 * WHY THE SLIDER RATHER THAN A NUMBER. Sweeping T from 0.85 to 0.97 moves the median library
 * multiplier from x2.26 to x0.88 and Full Metal Jacket from 171 to 64. That is not a detail to be
 * defaulted, and grain's shallow slope is why: 1/S runs from 10 to 50, so T enters as a very large
 * exponent. Until an experiment pins it, the honest interface is one you can drag. The published
 * starting point is Lisson (RIT/Kodak), 6-7% granularity change = 1 JND, i.e. T ~ 0.93. */
export function grainShift({ bppPlus, lad, T }) {
  if (!lad || !(lad.grainLossless > 0) || bppPlus == null) return null;
  const pts = (lad.points || []).filter((p) => p.level > 0 && p.grain > 0);
  const f = fitLine(pts.map((p) => Math.log(p.level)), pts.map((p) => Math.log(p.grain)));
  if (!f || !f.S) return null;

  const lnM = (Math.log(T * lad.grainLossless) - f.a) / f.S;
  if (!Number.isFinite(lnM)) return null;

  // Same delta method as banding. The curve's own residual variance stands in for "how well do we
  // know the level here" — for grain there is no second independent reading to measure it from, so
  // the scatter of the film's own rungs is the best available estimate and it is at least honest
  // about a noisy curve.
  // Smooth distance from the centroid, not a hinge at the ladder's edge — see the note in shiftOf.
  // This axis needed it most: grain slopes run as shallow as 0.019, so the 1/S^2 amplification of a
  // kink is in the thousands.
  const lx = pts.map((p) => Math.log(p.level));
  const xBar = lx.reduce((a, b) => a + b, 0) / lx.length;
  const dist = Math.abs(lnM - xBar);
  const varLnM = (f.s2 + (lnM ** 2) * f.varS) / (f.S ** 2)
    + ((MODEL_ERR_PER_LN * dist) ** 2) / (f.S ** 2);

  const D = -0.5 * lnM;
  return { artifact: 'grain', L: 1, S: f.S, measured: true, m: Math.exp(lnM), lnM, D,
    sigma: 0.5 * Math.sqrt(varLnM), dist, implied: bppPlus * Math.exp(D) };
}

/* THE BINDING ARTIFACT, AS A MIXTURE RATHER THAN A SWITCH.
 *
 * THE BUG THIS REPLACES, found by Brennan playing with the slider: "at 0.91 big lebowski is +254 but
 * at 0.92 its +0". A hard max over POINT estimates ignores how well each is known. The Big Lebowski's
 * banding estimate is sharp (m 0.061, sigma ~0.1) and its grain estimate is useless (sigma ~8, because
 * S_grain is 0.025 and everything divides by S^2). At T=0.915 banding is larger and the film moves
 * +254 on a confident number; one step later grain edges ahead, wins the max, and freezes the film at
 * +0 on a number that means nothing. The physics is right — the first artifact to appear does bind —
 * but "which is largest" is the wrong question when one of the two is barely measured.
 *
 * THE FIX, with no constant and no branch. Treat each artifact as a distribution over ln m and ask
 * for the probability that each one IS the binding constraint:
 *
 *     p_a = P( ln m_a  >  every other ln m_b )
 *
 * then take the mixture. For two artifacts that is a closed form, p_1 = Phi((mu1-mu2)/sqrt(s1^2+s2^2));
 * above two it is a small Monte Carlo with a FIXED seed so the lab does not shimmer between redraws.
 * The mixture variance carries both the within-artifact spread and the disagreement between them, so
 * a film whose artifacts disagree is correctly reported as uncertain rather than confidently wrong.
 *
 * As the sigmas shrink this converges on the hard max — the physics is recovered exactly in the limit
 * where the measurements are good. It only softens where softening is honest. */
const PHI = (z) => 0.5 * (1 + Math.sign(z) * Math.sqrt(1 - Math.exp(-2 * z * z / Math.PI)));

export function bindingShift(candidates) {
  const ok = candidates.filter((z) => z && Number.isFinite(z.m) && Number.isFinite(z.D)
    && Number.isFinite(z.sigma) && z.sigma > 0);
  if (!ok.length) return null;
  if (ok.length === 1) return { ...ok[0], p: 1, mixed: false };

  // sigma is carried in log-BPP+ units (D = -0.5 ln m), so ln m has twice the spread.
  const mu = ok.map((z) => z.lnM);
  const sd = ok.map((z) => 2 * z.sigma);

  let p;
  if (ok.length === 2) {
    const p0 = PHI((mu[0] - mu[1]) / Math.sqrt(sd[0] ** 2 + sd[1] ** 2));
    p = [p0, 1 - p0];
  } else {
    // Deterministic LCG: the same inputs must always give the same picture.
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const gauss = () => {
      const u = Math.max(rnd(), 1e-12); const v = rnd();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const wins = ok.map(() => 0);
    const N = 4000;
    for (let i = 0; i < N; i += 1) {
      let best = -Infinity; let bi = 0;
      for (let a = 0; a < ok.length; a += 1) {
        const draw = mu[a] + sd[a] * gauss();
        if (draw > best) { best = draw; bi = a; }
      }
      wins[bi] += 1;
    }
    p = wins.map((w) => w / N);
  }

  const lnM = ok.reduce((s, z, i) => s + p[i] * mu[i], 0);
  // Law of total variance: spread within each artifact, plus disagreement between them.
  const varMix = ok.reduce((s, z, i) => s + p[i] * (sd[i] ** 2 + (mu[i] - lnM) ** 2), 0);
  const lead = p.indexOf(Math.max(...p));

  return {
    artifact: ok[lead].artifact,
    p: p[lead],
    mixed: p[lead] < 0.9,
    parts: ok.map((z, i) => ({ artifact: z.artifact, m: z.m, p: p[i] })),
    L: ok[lead].L,
    S: ok[lead].S,
    measured: ok.every((z) => z.measured),
    m: Math.exp(lnM),
    lnM,
    D: -0.5 * lnM,
    sigma: 0.5 * Math.sqrt(varMix),
    implied: null,
  };
}

/* Empirical Bayes across the scored films: how much of the spread in implied shifts is REAL?
 *
 * THE ESTIMATOR HAS TO BE PRECISION-WEIGHTED, and getting this wrong the first time produced a false
 * verdict. A plain method of moments — observed variance minus mean sampling variance — is destroyed
 * by a single degenerate film: War of the Worlds fits S = 0.00, so its implied shift is 1e79 with a
 * standard error of 1105, and it alone drove the mean sampling variance to 58,198 against an observed
 * spread of 1,523. tau^2 pinned to zero and the tab reported "no film moves", which read like a
 * finding and was an artifact of one unusable row.
 *
 * The fix is the standard random-effects treatment. With D_i = theta_i + e_i, e_i ~ N(0, sigma_i^2)
 * and theta_i ~ N(0, tau^2), weighting by w_i = 1/sigma_i^2 gives E[sum w_i D_i^2] = tau^2 sum w_i + k,
 * hence
 *
 *     tau^2 = ( sum w_i D_i^2  -  k ) / sum w_i
 *
 * Uncentred on purpose: the prior is centred at NO CHANGE, not at the average change. Centring it on
 * the mean would quietly absorb a systematic offset — and the measured films do show one (mean shift
 * +0.68 in log space, i.e. the typical film looks like it has 2x banding headroom). That offset is
 * evidence that banding is not the binding artifact, so it must stay visible rather than be
 * calibrated away. A film with an enormous sigma now contributes almost nothing to the estimate
 * instead of dominating it. */
export function shrinkage(shifts) {
  const ok = shifts.filter((z) => Number.isFinite(z.D) && Number.isFinite(z.sigma) && z.sigma > 0);
  const k = ok.length;
  if (!k) return { tau2: 0, n: 0, sumW: 0 };
  let sumW = 0; let sumWD2 = 0;
  for (const z of ok) { const w = 1 / (z.sigma ** 2); sumW += w; sumWD2 += w * (z.D ** 2); }
  const tau2 = Math.max(0, (sumWD2 - k) / sumW);
  const ds = ok.map((z) => z.D);
  const md = ds.reduce((a, b) => a + b, 0) / k;
  return { tau2, n: k, sumW,
    obsVar: ds.reduce((s, d) => s + (d - md) ** 2, 0) / Math.max(1, k - 1),
    meanShift: md,
    meanSigma2: ok.reduce((s, z) => s + z.sigma ** 2, 0) / k };
}

export const weightOf = (sigma, tau2) => (tau2 <= 0 ? 0 : tau2 / (tau2 + sigma ** 2));

/* Measurement error of a single nightly banding reading, in log space.
 *
 * This used to be INFERRED — the library-wide spread of ln(cambi) times (1 - reliability) — which
 * gave 0.612. It is now MEASURED directly from 21 paired readings of the same films and gives 0.059,
 * a tenth of that. The inferred version was wrong because split-half reliability answers "how much of
 * the between-FILM spread is real", and this needs "how far does one reading sit from another of the
 * same film". Those are different questions and the second one is answerable, so it wins.
 *
 * The argument is kept rather than deleted because it is the reason the number moved by 10x, and a
 * future reader will otherwise re-derive the wrong one from the reliability figure in BPP-PLUS.txt. */
export function levelNoise() {
  return LEVEL_LOGSD ** 2;
}

/* Scatter of the level->slope law, for films with no ladder of their own. Same idea: the law's
 * residual variance in log space, taken from the films that have both. */
export function predictorNoise(ladders, predictS) {
  const rs = [];
  for (const lad of ladders) {
    if (!lad || lad.S == null || !(lad.levelAt1 > 0)) continue;
    const sl = slopeFromLadder(lad);
    const p = predictS(anchorLevel(lad.lossless ?? lad.levelAt1, lad));
    if (!sl || !Number.isFinite(p) || p === 0 || sl.S === 0) continue;
    rs.push(Math.log(Math.abs(sl.S)) - Math.log(Math.abs(p)));
  }
  if (rs.length < 3) return 0.5;
  const m = rs.reduce((a, b) => a + b, 0) / rs.length;
  return rs.reduce((s, x) => s + (x - m) ** 2, 0) / (rs.length - 1);
}
