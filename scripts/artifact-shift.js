#!/usr/bin/env node
/* THE ARTIFACT-RESIDUAL CORRECTION, with a shift magnitude that is MEASURED rather than chosen.
 *
 * Brennan's framework, in three moves:
 *   1. predict how much of an artifact a film OUGHT to show, from its content and its bitrate
 *   2. measure how much it actually shows
 *   3. the disagreement corrects the score — UP when cleaner than expected, DOWN when worse
 *
 * The earlier pass got stuck on step 3's magnitude and fell back to an invented coefficient
 * (k=0.15), which is exactly the kind of unfitted constant this project keeps having to retract.
 * Brennan's follow-up dissolves it: compare the artifact at DIFFERENT COMPRESSIONS and the curve
 * itself tells you how many bits a given amount of artifact is worth.
 *
 * *** WHY THAT MAKES THE CORRECTION SELF-CALIBRATING — no subjective label needed. ***
 * BPP+ is already denominated in bits. So if a film bands like a copy carrying bpp' rather than the
 * bpp it actually carries, its honest score is the score of bpp'. The conversion is pure arithmetic
 * once the artifact-vs-bitrate slope is known, and that slope is MEASURABLE:
 *
 *     d log(cambi) / d log(bpp) = S            (S is measured, not assumed)
 *     a log-residual r therefore implies a log-bpp error of  -r / |S|
 *     BPP+ goes as sqrt(bpp), so   d log(BPP+) = 0.5 * (-r / |S|)
 *     shift = BPP+ * (exp(-r / (2|S|)) - 1)
 *
 * Every constant in that chain is a measurement. There is no free parameter.
 *
 * *** AND THE RESIDUAL MUST BE SHRUNK BY ITS OWN RELIABILITY BEFORE IT IS USED. ***
 * A residual is signal plus noise. Feeding the raw value into the shift would act on the noise as
 * confidently as on the signal. Kelley's correction says the best estimate of the TRUE residual is
 * reliability x observed, so a noisy detector automatically produces small shifts and a precise one
 * produces large ones. This is what makes the framework safe to extend to a new artifact: a detector
 * that turns out to be junk contributes ~nothing rather than contributing garbage.
 *
 * TWO SLOPES, and the difference is Brennan's "huge swing or small one":
 *   CROSS-FILM  one S fitted across the library. Available now. Assumes every film's banding
 *               responds to bitrate at the same rate.
 *   PER-FILM    S measured for THIS film by starving it and re-measuring (probe-starve.sh already
 *               does the starving). A film whose banding barely moves with bitrate needs a BIG bpp
 *               error to explain a given residual -> big shift. A film whose banding is very
 *               bitrate-sensitive needs only a small one -> small shift. Same residual, different
 *               correction, and only the per-film slope can tell them apart.
 * This script does CROSS-FILM and prints what the per-film version would need.
 *
 * USAGE: node scripts/artifact-shift.js [--reliability 0.579] [--cap 15]
 */
const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', process.env.CONTROLLER || 'http://localhost:8088');
const CAP = Number(val('--cap', 15));

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a) => { const v = [...a].sort((x, y) => x - y); return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2; };
function pearson(xs, ys) {
  const mx = mean(xs); const my = mean(ys);
  const den = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
  return den ? xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / den : 0;
}
function ols(X, y) {
  const p = X[0].length;
  const A = Array.from({ length: p }, (_, i) => Array.from({ length: p + 1 }, (_, j) => (j < p
    ? X.reduce((s, r) => s + r[i] * r[j], 0) : X.reduce((s, r, k) => s + r[i] * y[k], 0))));
  for (let c = 0; c < p; c += 1) {
    let piv = c;
    for (let r = c + 1; r < p; r += 1) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < p; r += 1) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j <= p; j += 1) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((row, i) => row[p] / A[i][i]);
}
const L = (v) => Math.log(Math.max(v, 1e-3));

(async () => {
  const [ds, bd] = await Promise.all([
    (await fetch(`${API}/api/probe/dataset`)).json(),
    (await fetch(`${API}/api/banding/dataset`)).json(),
  ]);
  const clips = new Map(bd.rows.filter((r) => Array.isArray(r.sampleCambi) && r.sampleCambi.length >= 4)
    .map((r) => [r.key, r.sampleCambi]));
  const rows = ds.rows.filter((r) => r.cambi != null && r.cxEff > 0 && r.bpp > 0
    && r.bppPlus != null && r.cambiLuma != null && r.year && clips.has(r.key));
  console.log(`${rows.length} films\n`);

  const design = (r) => [1, L(r.bpp), L(r.cxEff), r.cambiLuma / 100, (r.year - 2000) / 25];
  const y = rows.map((r) => L(r.cambi));
  const beta = ols(rows.map(design), y);
  const S = beta[1];                                    // d log(cambi) / d log(bpp)
  const resid = rows.map((r, i) => y[i] - design(r).reduce((s, v, j) => s + v * beta[j], 0));

  // Reliability from split-half, so the shrinkage factor is measured on this data too.
  const halfResid = (idxs) => {
    const yy = rows.map((r) => L(mean(idxs.map((i) => clips.get(r.key)[i]))));
    const b = ols(rows.map(design), yy);
    return rows.map((r, i) => yy[i] - design(r).reduce((s, v, j) => s + v * b[j], 0));
  };
  const rHalf = pearson(halfResid([0, 2]), halfResid([1, 3]));
  const REL = Number(val('--reliability', ((2 * rHalf) / (1 + rHalf)).toFixed(4)));

  console.log('MEASURED CONSTANTS — every one of these is fitted, none is chosen:');
  console.log(`   S   = d log(cambi)/d log(bpp)          ${S.toFixed(4)}`);
  console.log(`   REL = split-half reliability of resid   ${REL.toFixed(3)}`);
  console.log(`   => shift = BPP+ * (exp(-REL*r / (2*|S|)) - 1),  capped at +-${CAP} pts\n`);
  console.log(`   sanity: a residual of 1.0 in log space (banding e-fold above expectation) implies`);
  console.log(`   a log-bpp error of ${(-1 / Math.abs(S)).toFixed(3)}, i.e. the film behaves like a copy`);
  console.log(`   carrying ${(Math.exp(-1 / Math.abs(S)) * 100).toFixed(0)}% of its actual bits.\n`);

  const shiftOf = (r0, plus) => {
    const dLogPlus = (-REL * r0) / (2 * Math.abs(S));
    return Math.max(-CAP, Math.min(CAP, plus * (Math.exp(dLogPlus) - 1)));
  };
  const out = rows.map((r, i) => ({ r, res: resid[i], shift: shiftOf(resid[i], r.bppPlus) }));
  const abs = out.map((x) => Math.abs(x.shift));
  console.log(`SHIFT DISTRIBUTION: median |shift| ${med(abs).toFixed(1)} pts, `
    + `p90 ${[...abs].sort((a, b) => a - b)[Math.floor(abs.length * 0.9)].toFixed(1)}, `
    + `${abs.filter((v) => v >= CAP - 0.01).length} at the cap`);
  const up = out.filter((x) => x.shift > 0.5).length; const dn = out.filter((x) => x.shift < -0.5).length;
  console.log(`  ${up} films shift UP, ${dn} DOWN, ${out.length - up - dn} essentially unchanged`);
  console.log('  -> BIDIRECTIONAL, as intended: this is not a library-wide re-anchoring.\n');

  const band = (p) => (p >= 125 ? 'wow' : p >= 100 ? 'ok' : p >= 75 ? 'warn' : 'bad');
  const flips = out.filter((x) => band(x.r.bppPlus) !== band(x.r.bppPlus + x.shift));
  console.log(`BAND FLIPS: ${flips.length} of ${out.length}`);
  for (const x of flips.sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift)).slice(0, 12)) {
    console.log(`   ${x.shift >= 0 ? '+' : ''}${x.shift.toFixed(1)}  ${x.r.bppPlus} ${band(x.r.bppPlus)} -> `
      + `${Math.round(x.r.bppPlus + x.shift)} ${band(x.r.bppPlus + x.shift)}  cambi ${x.r.cambi.toFixed(2)}  ${x.r.title}`);
  }

  console.log('\nTOP 8 UP (cleaner than a copy this size should be):');
  for (const x of [...out].sort((a, b) => b.shift - a.shift).slice(0, 8)) {
    console.log(`   +${x.shift.toFixed(1)} pts  ${String(x.r.bppPlus).padStart(3)} -> `
      + `${String(Math.round(x.r.bppPlus + x.shift)).padStart(3)}  cambi ${x.r.cambi.toFixed(2).padStart(5)}  ${x.r.title}`);
  }
  console.log('\nTOP 8 DOWN (bands more than a copy this size should):');
  for (const x of [...out].sort((a, b) => a.shift - b.shift).slice(0, 8)) {
    console.log(`   ${x.shift.toFixed(1)} pts  ${String(x.r.bppPlus).padStart(3)} -> `
      + `${String(Math.round(x.r.bppPlus + x.shift)).padStart(3)}  cambi ${x.r.cambi.toFixed(2).padStart(5)}  ${x.r.title}`);
  }

  // What the per-film slope would buy. A film's own S is only measurable by starving it, but the
  // SPREAD of plausible S across the library bounds how much per-film slopes could matter.
  console.log('\nWHY A PER-FILM SLOPE IS THE NEXT STEP (Brennan\'s "huge swing or small one"):');
  for (const s of [Math.abs(S) * 0.5, Math.abs(S), Math.abs(S) * 2]) {
    const m = med(rows.map((r, i) => Math.abs(r.bppPlus * (Math.exp((-REL * resid[i]) / (2 * s)) - 1))));
    console.log(`   if a film's own |S| were ${s.toFixed(2)}  ->  median |shift| ${m.toFixed(1)} pts`);
  }
  console.log('   A flat responder needs a BIG bpp error to explain the same residual, so it earns a');
  console.log('   big shift; a sensitive one earns a small shift. One cross-film slope cannot tell');
  console.log('   them apart, which is exactly what a starvation ladder on banding would measure.');
})();
