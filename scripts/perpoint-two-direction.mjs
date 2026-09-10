/* VERIFY THE ONLY CANDIDATE THAT PASSES THE TWO-DIRECTION TEST — the CRF slope as a detail measure.
 *
 * THE PROBLEM IT ADDRESSES. The covering set has a hole at DETAIL LOSS, and it is the one hole that
 * could invalidate the whole "clean artifacts => good enough" premise, because detail loss is SMOOTH
 * degradation with no artifact signature: nothing appears, things quietly stop being there. Every
 * detector we have is a "something appeared" detector. And blur, the only detail proxy, has just been
 * shown to be a pure log(bits x content) function — orthogonal to the adequacy axis BY CONSTRUCTION.
 *
 * THE GENERAL BAR, which is the useful part regardless of this candidate. For any candidate D:
 *     CONTENT direction     dD/d log(complexity) ACROSS films at their own operating points
 *     STARVATION direction  dD/d log(complexity) WITHIN one film under controlled starvation
 * D can separate "shot soft" from "detail destroyed" IF AND ONLY IF those two directions differ. If
 * they coincide, the confound is PARALLEL to the signal and no residualisation, normalisation or
 * extra sampling can recover the distinction. This is the degeneracy bar that killed gridRatio,
 * sharpened: not "does D correlate with grain" but "does D move DIFFERENTLY under content and damage".
 * blurdetect fails it: content -0.0565 +- 0.0324 vs causal -0.0371 +- 0.0009, 0.6 SE apart.
 *
 * THE CANDIDATE. perPoint = d log(probeBitrate)/d CRF, already sitting unexamined in
 * data/starve-experiment.json, collected for biasFactor. Mechanism: on a rich source, raising QP
 * harvests a large high-frequency tail so rate collapses fast; on a starved source that tail is
 * already gone so raising QP saves less. It is a BITRATE-domain measurement of how much destructible
 * detail remains — no detector, no threshold, no log of a near-zero quantity.
 *
 * WHY A RESPONSE STATISTIC AND NOT A LEVEL. Every level statistic is content-dominated by
 * construction: content sets the level over decades while damage moves it by a few percent. The
 * discriminating information is in how the file RESPONDS to a perturbation, not in what it READS. A
 * response is also a within-clip-set differential, so scene-sampling noise — 52% of the split-half,
 * per 11.53 — largely cancels.
 *
 * THIS SCRIPT VERIFIES, it does not assume: the monotonicity, the two directions and their
 * separation, and the external bound on bitrate-per-CRF. Any of them can fail here.
 *
 * USAGE: node scripts/perpoint-two-direction.mjs
 */
import fs from 'fs';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const slope = (xs, ys) => {
  const mx = mean(xs); const my = mean(ys);
  let n = 0; let d = 0;
  for (let i = 0; i < xs.length; i += 1) { n += (xs[i] - mx) * (ys[i] - my); d += (xs[i] - mx) ** 2; }
  return d > 0 ? n / d : NaN;
};
/* slope with a proper SE, since the whole claim is about a DIFFERENCE of two slopes */
function lin(xs, ys) {
  const b = slope(xs, ys); const mx = mean(xs); const my = mean(ys);
  const a = my - b * mx;
  const n = xs.length;
  let ss = 0; let sxx = 0;
  for (let i = 0; i < n; i += 1) { ss += (ys[i] - a - b * xs[i]) ** 2; sxx += (xs[i] - mx) ** 2; }
  return { b, se: Math.sqrt(ss / Math.max(1, n - 2) / sxx), n };
}

const FILES = ['data/starve-experiment.json', 'data/starve-experiment-x264.json'];
for (const path_ of FILES) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path_, 'utf8')); } catch { console.log(`\n  ${path_} missing\n`); continue; }
  const films = Object.values(raw.films || {});
  const ok = films.filter((f) => Array.isArray(f.levels) && f.levels.length >= 3
    && f.levels.every((l) => Number.isFinite(l.perPoint) && Number.isFinite(l.cx20)));
  console.log(`\n${'='.repeat(78)}\n  ${path_}   ${ok.length}/${films.length} films with 3 usable levels\n`);
  if (ok.length < 4) { console.log('  too few\n'); continue; }

  /* ---- 1. MONOTONICITY. Does |perPoint| shrink as the source is starved? ---- */
  console.log(`  ${'film'.padEnd(28)} ${'pp@1'.padStart(9)} ${'pp@0.5'.padStart(9)} ${'pp@0.25'.padStart(9)}   mono`);
  let mono = 0; const drops = [];
  for (const f of ok) {
    const by = new Map(f.levels.map((l) => [l.level, l]));
    const a = by.get(1)?.perPoint; const b = by.get(0.5)?.perPoint; const c = by.get(0.25)?.perPoint;
    if (![a, b, c].every(Number.isFinite)) continue;
    /* perPoint is NEGATIVE; "flattening" means moving TOWARD zero, so compare magnitudes. */
    const m = Math.abs(a) > Math.abs(b) && Math.abs(b) > Math.abs(c);
    if (m) mono += 1;
    drops.push(Math.abs(a) - Math.abs(c));
    console.log(`  ${f.title.slice(0, 27).padEnd(28)} ${a.toFixed(4).padStart(9)} ${b.toFixed(4).padStart(9)} `
      + `${c.toFixed(4).padStart(9)}   ${m ? 'MONO' : '--'}`);
  }
  const seD = sd(drops) / Math.sqrt(drops.length);
  console.log(`\n    monotone ${mono}/${drops.length}    |pp@1| - |pp@0.25| = ${mean(drops).toFixed(4)} +- ${seD.toFixed(4)}`
    + `   t = ${(mean(drops) / seD).toFixed(2)}`);

  /* ---- 2. EXTERNAL BOUND FIRST, before any standard error (trap 8). ---- */
  const pp1 = ok.map((f) => f.levels.find((l) => l.level === 1)?.perPoint).filter(Number.isFinite);
  console.log(`\n    bitrate per CRF at level 1: mean ${(100 * mean(pp1)).toFixed(1)}%/CRF   `
    + `range ${(100 * Math.min(...pp1)).toFixed(1)} to ${(100 * Math.max(...pp1)).toFixed(1)}`);
  console.log('    EXTERNAL BOUND: the library figure is -13.6%/CRF (2.3). Ours must sit near it or');
  console.log('    the measurement is of something else.');

  /* ---- 3. THE TWO DIRECTIONS. This is the whole test. ---- */
  const cxs = []; const pps = [];          /* CONTENT: across films, at level 1 only */
  for (const f of ok) {
    const l = f.levels.find((x) => x.level === 1);
    if (l && l.cx20 > 0) { cxs.push(Math.log(l.cx20)); pps.push(l.perPoint); }
  }
  const content = lin(cxs, pps);
  /* STARVATION: within film, pooled as deviations from each film's own mean so that between-film
   * level differences cannot leak into the slope. This is the same pooling discipline the anchor
   * uses, and skipping it would let content masquerade as starvation. */
  const wx = []; const wy = [];
  for (const f of ok) {
    const ls = f.levels.filter((l) => l.cx20 > 0);
    if (ls.length < 3) continue;
    const mx = mean(ls.map((l) => Math.log(l.cx20))); const my = mean(ls.map((l) => l.perPoint));
    for (const l of ls) { wx.push(Math.log(l.cx20) - mx); wy.push(l.perPoint - my); }
  }
  const starve = lin(wx, wy);
  const diff = content.b - starve.b;
  const seDiff = Math.sqrt(content.se ** 2 + starve.se ** 2);
  console.log(`\n  *** THE TWO-DIRECTION TEST ***\n`);
  console.log(`    CONTENT    d perPoint / d log cx20, across films  ${content.b.toFixed(4)} +- ${content.se.toFixed(4)}  (n ${content.n})`);
  console.log(`    STARVATION d perPoint / d log cx20, within film   ${starve.b.toFixed(4)} +- ${starve.se.toFixed(4)}  (n ${starve.n})`);
  console.log(`    difference ${diff.toFixed(4)} +- ${seDiff.toFixed(4)}   ${(Math.abs(diff) / seDiff).toFixed(1)} SE   `
    + `ratio ${(starve.b / content.b).toFixed(2)}x`);
  if (Math.abs(diff) / seDiff > 2) {
    console.log('\n    THE DIRECTIONS DIFFER. A film\'s displacement from the content line is therefore a');
    console.log('    starvation reading, and "shot soft" vs "detail destroyed" is answerable in principle.');
    console.log('    Compare blurdetect, which fails the same test at 0.6 SE.');
  } else {
    console.log('\n    THE DIRECTIONS COINCIDE. The confound is parallel to the signal and no amount of');
    console.log('    residualisation recovers the distinction. Same verdict as blurdetect.');
  }
  /* ---- 4. CIRCULARITY CHECK, and it is not optional. cx20 and perPoint are computed from THE SAME
   * four probe points, so a shared measurement error moves both. For rungs at CRF 16/20/24/28 the
   * OLS slope weights are proportional to (x - xbar) = (-6,-2,+2,+6), so an error e in the CRF-20
   * point shifts perPoint by -0.025e while raising log cx20 — inducing a NEGATIVE apparent slope,
   * exactly the sign measured. The clean test regresses on log(LEVEL) instead: level is the
   * experimentally controlled variable and carries no measurement error whatsoever. ---- */
  const lx = []; const ly = [];
  for (const f of ok) {
    const ls = f.levels.filter((l) => l.level > 0);
    if (ls.length < 3) continue;
    const mx = mean(ls.map((l) => Math.log(l.level))); const my = mean(ls.map((l) => l.perPoint));
    for (const l of ls) { lx.push(Math.log(l.level) - mx); ly.push(l.perPoint - my); }
  }
  const lvl = lin(lx, ly);
  console.log(`\n  CIRCULARITY CHECK — regress on the CONTROLLED variable instead of the measured one\n`);
  console.log(`    d perPoint / d log(level), within film   ${lvl.b.toFixed(4)} +- ${lvl.se.toFixed(4)}   `
    + `t = ${(Math.abs(lvl.b) / lvl.se).toFixed(1)}   (n ${lvl.n})`);
  console.log('    level has NO measurement error, so this slope cannot be manufactured by shared');
  console.log(`    probe noise. Sign ${lvl.b < 0 ? 'MATCHES' : 'DISAGREES WITH'} the cx20 version, so the starvation response is`);
  console.log(`    ${lvl.b < 0 ? 'real and not an artifact of the two quantities sharing a denominator.'
    : 'NOT confirmed — treat the cx20 result as circular.'}`);

  console.log(`\n    HONEST LIMIT: the CONTENT line rests on n = ${content.n} films. The starvation direction is`);
  console.log('    solid; the content direction is the thin half and is what a first experiment must buy.');
}
console.log('');
