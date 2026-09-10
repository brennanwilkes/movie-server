/* WHY DOES THE IMPLIED SCORE EXPLODE? — a diagnosis, not a patch.
 *
 * Brennan, 2026-08-25: "do we really understand WHY the number explodes with the godfather? Does it
 * do that under other circumstances? I really do feel like this is a math problem."
 *
 * The tab had three hand-set guards bolted on after watching it misbehave, which is the shape of a
 * bug that was never diagnosed. This runs the arithmetic over the whole library and asks what the
 * explosive films actually have in common.
 *
 * THE SENSITIVITY, algebraically, before looking at any data:
 *
 *     m = (T/L)^(1/S)     and     BPP+_implied = BPP+ / sqrt(m) = BPP+ * (L/T)^(1/(2S))
 *
 * So the implied score is a POWER of the measured level, with exponent 1/(2S). That exponent is the
 * whole story: at S = -1 it is -0.5 and a 2x error in L moves the score 1.4x; at S = -0.25 it is -2
 * and the same error moves it 4x. Nothing here is numerically unstable — it is a power law behaving
 * exactly as a power law does, applied far outside where its exponent was measured.
 *
 * USAGE: node scripts/blend-check.mjs
 */
import fs from 'fs';
import {
  fitLine, slopeFromLadder, anchorLevel, shiftOf, shrinkage, weightOf, levelNoise, predictorNoise,
} from '../bpp-lab/src/blend-math.js';

const T = 2.817;
const PRED_A = 0.394; const PRED_B = -0.542;
const predictS = (L) => -(PRED_A * (Math.max(L, 1e-4) ** PRED_B));

const lads = JSON.parse(fs.readFileSync('bpp-lab/public/ladders.json', 'utf8')).films;
const ladByKey = new Map(lads.map((f) => [f.key, f]));
const ds = await (await fetch('http://localhost:8088/api/probe/dataset')).json();
const rows = ds.rows.filter((r) => r.bppPlus != null && r.cambi > 0);

const line = (s) => console.log(s);
const pad = (s, n) => String(s).slice(0, n).padEnd(n);
const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '   -');

line(`\n${rows.length} units with a banding reading and a BPP+; ${ladByKey.size} have a ladder\n`);

// ── 1. IS THE ANCHOR EVEN PHYSICAL? ──────────────────────────────────────────────────────────────
// A film cannot band less than its own lossless extract. Where the nightly reading does, one of the
// two is sampling scenes the other never saw, and the lower number is not a quality fact.
line('1. ANCHOR COHERENCE — nightly reading vs the film\'s own lossless rung');
let viol = 0;
const ratios = [];
for (const f of lads) {
  const r = rows.find((x) => x.key === f.key);
  if (!r || f.lossless == null) continue;
  ratios.push(r.cambi / f.lossless);
  if (r.cambi < f.lossless) {
    viol += 1;
    if (r.cambi / f.lossless < 0.6) {
      line(`   ${pad(f.title, 34)} nightly ${num(r.cambi, 3)} < lossless ${num(f.lossless, 3)}`
        + `   (${num(f.lossless / r.cambi, 1)}x apart — impossible)`);
    }
  }
}
ratios.sort((a, b) => a - b);
line(`   ${viol} of ${ratios.length} ladder films read BELOW their own lossless floor.`);
line(`   ratio nightly/lossless: p10 ${num(ratios[Math.floor(ratios.length * 0.1)])} `
  + `median ${num(ratios[Math.floor(ratios.length / 2)])} p90 ${num(ratios[Math.floor(ratios.length * 0.9)])}`);

// ── 2. THE POWER LAW IS PROVABLY WRONG AT THE HIGH-BITS END ──────────────────────────────────────
// The lossless rung is the curve's asymptote: bits -> infinity. A fitted power law goes to ZERO
// instead, so somewhere it crosses the asymptote and predicts less banding than is physically
// possible. That crossing level is a measured per-film ceiling on how far the fit can be trusted.
line('\n2. WHERE THE FITTED LAW CROSSES ITS OWN ASYMPTOTE (bits multiplier)');
line(`   ${pad('film', 34)} ${'S'.padStart(6)} ${'@1.0'.padStart(7)} ${'lossless'.padStart(9)} ${'vSat'.padStart(8)}`);
const sats = [];
for (const f of lads) {
  const sl = slopeFromLadder(f);
  if (!sl || f.lossless == null || !(f.levelAt1 > 0)) continue;
  // fitted cambi(v) = levelAt1 * v^S ; solve for v where that equals the lossless floor
  const vSat = (f.lossless / f.levelAt1) ** (1 / sl.S);
  sats.push(vSat);
  line(`   ${pad(f.title, 34)} ${num(sl.S).padStart(6)} ${num(f.levelAt1, 3).padStart(7)} `
    + `${num(f.lossless, 3).padStart(9)} ${num(vSat).padStart(8)}`);
}
sats.sort((a, b) => a - b);
line(`   median vSat ${num(sats[Math.floor(sats.length / 2)])}x — beyond this the fit predicts`);
line('   LESS banding than the lossless source has, which cannot happen. The law is local.');

// ── 3. WHICH FILMS EXPLODE, AND WHAT DO THEY SHARE? ──────────────────────────────────────────────
line('\n3. THE EXPLOSION, decomposed over the whole library');
const varLnL = levelNoise(rows.map((r) => r.cambi));
const predVarLnS = predictorNoise(lads, predictS);
line(`   Var(ln L) from CAMBI reliability 0.782 = ${num(varLnL, 4)}  (sd ${num(Math.sqrt(varLnL), 3)} in log)`);
line(`   Var(ln|S|) of the level->slope law     = ${num(predVarLnS, 4)}  (sd ${num(Math.sqrt(predVarLnS), 3)})`);

const shifts = [];
for (const r of rows) {
  const z = shiftOf({ bppPlus: r.bppPlus, cambi: r.cambi, lad: ladByKey.get(r.key),
    T, varLnL, predVarLnS, predictS });
  if (z) shifts.push({ r, z });
}
const mults = shifts.map((s) => s.z.implied / s.r.bppPlus).sort((a, b) => a - b);
const q = (p) => num(mults[Math.floor(mults.length * p)]);
line(`\n   raw implied/current multiplier, UNSHRUNK, n=${mults.length}:`);
line(`     p05 ${q(0.05)}  p25 ${q(0.25)}  median ${q(0.5)}  p75 ${q(0.75)}  p95 ${q(0.95)}  max ${num(mults[mults.length - 1])}`);

// Split by the two candidate causes and see which one actually separates the explosive tail.
const wild = shifts.filter((s) => s.z.implied / s.r.bppPlus > 3);
const calm = shifts.filter((s) => s.z.implied / s.r.bppPlus <= 3);
const medOf = (a) => (a.length ? a.slice().sort((u, v) => u - v)[Math.floor(a.length / 2)] : NaN);
line(`\n   ${wild.length} films blow up past 3x.  Median profile of the two groups:`);
line(`     ${'group'.padEnd(10)} ${'level L'.padStart(9)} ${'|S|'.padStart(7)} ${'|ln m|'.padStart(8)} ${'measured?'.padStart(10)}`);
for (const [name, g] of [['exploding', wild], ['calm', calm]]) {
  line(`     ${name.padEnd(10)} ${num(medOf(g.map((s) => s.z.L)), 3).padStart(9)} `
    + `${num(medOf(g.map((s) => Math.abs(s.z.S)))).padStart(7)} `
    + `${num(medOf(g.map((s) => Math.abs(s.z.lnM)))).padStart(8)} `
    + `${String(g.filter((s) => s.z.measured).length).padStart(10)}`);
}

// ── 4. IS IT THE LEVEL OR THE SLOPE? Variance decomposition. ─────────────────────────────────────
// Var(ln m) = [ Var(ln L) + (ln m)^2 Var(S) ] / S^2. The two terms answer "is the level noisy" vs
// "is the slope being extrapolated too far", and their ratio says which fix would actually help.
line('\n4. VARIANCE DECOMPOSITION — level noise vs slope extrapolation');
const share = shifts.map((s) => {
  const a = varLnL;
  const b = (s.z.lnM ** 2) * s.z.varS;
  return { s, frac: b / (a + b) };
});
const fl = share.map((x) => x.frac).sort((a, b) => a - b);
line(`   fraction of Var(ln m) coming from SLOPE extrapolation, not level noise:`);
line(`     p25 ${num(fl[Math.floor(fl.length * 0.25)], 3)}  median ${num(fl[Math.floor(fl.length / 2)], 3)}  `
  + `p90 ${num(fl[Math.floor(fl.length * 0.9)], 3)}`);

// ── 5. DOES THE SHRINKAGE ACTUALLY TAME IT? ──────────────────────────────────────────────────────
line('\n5. AFTER EMPIRICAL-BAYES SHRINKAGE');
const sh = shrinkage(shifts.map((s) => s.z));
line(`   observed spread of shifts Var(D) = ${num(sh.obsVar, 4)}`);
line(`   mean sampling variance           = ${num(sh.meanSigma2, 4)}`);
line(`   => tau^2 = ${num(sh.tau2, 4)}  (0 would switch the whole correction off)`);
const after = shifts.map((s) => {
  const w = weightOf(s.z.sigma, sh.tau2);
  return { ...s, w, adj: s.r.bppPlus * Math.exp(w * s.z.D) };
});
const am = after.map((x) => x.adj / x.r.bppPlus).sort((a, b) => a - b);
const aq = (p) => num(am[Math.floor(am.length * p)]);
line(`   shrunk multiplier: p05 ${aq(0.05)}  median ${aq(0.5)}  p95 ${aq(0.95)}  max ${num(am[am.length - 1])}`);

line('\n   the films that were worst, before and after:');
line(`   ${pad('film', 32)} ${'BPP+'.padStart(5)} ${'L'.padStart(7)} ${'S'.padStart(6)} `
  + `${'m'.padStart(8)} ${'raw'.padStart(6)} ${'sigma'.padStart(6)} ${'w'.padStart(5)} ${'final'.padStart(6)}`);
for (const x of after.slice().sort((a, b) => b.z.implied - a.z.implied).slice(0, 12)) {
  line(`   ${pad(x.r.title, 32)} ${String(x.r.bppPlus).padStart(5)} ${num(x.z.L, 3).padStart(7)} `
    + `${num(x.z.S).padStart(6)} ${num(x.z.m, 3).padStart(8)} ${num(x.z.implied, 0).padStart(6)} `
    + `${num(x.z.sigma).padStart(6)} ${num(x.w, 2).padStart(5)} ${num(x.adj, 0).padStart(6)}`);
}

// ── 6. THE HYPOTHESIS THE ARITHMETIC CANNOT TEST BY ITSELF ───────────────────────────────────────
// If m << 1, the claim is "this film could lose most of its bits before BANDING appears". That can
// be true and still useless, because some other artifact fails first. Blocking is measured on the
// same rungs, so we can at least ask how much IT would move over the same interval.
line('\n6. WOULD BANDING EVEN BE THE FIRST THING TO BREAK?');
line(`   ${pad('film', 32)} ${'m(band)'.padStart(8)} ${'S_block'.padStart(8)} ${'block x'.padStart(9)}`);
for (const f of lads) {
  const r = rows.find((x) => x.key === f.key);
  if (!r || f.sBlock == null) continue;
  const z = shiftOf({ bppPlus: r.bppPlus, cambi: r.cambi, lad: f, T, varLnL, predVarLnS, predictS });
  if (!z || z.m >= 1) continue;
  // How much blocking grows if bits are cut to the level banding says is affordable.
  const blockGrowth = z.m ** f.sBlock;
  line(`   ${pad(f.title, 32)} ${num(z.m, 3).padStart(8)} ${num(f.sBlock).padStart(8)} `
    + `${num(blockGrowth, 1).padStart(8)}x`);
}
line('\n   A large "block x" means banding is NOT the binding constraint: cutting to the bitrate');
line('   banding allows would multiply blocking by that factor first. Without a blocking threshold');
line('   we cannot convert that into a bound — which is exactly what CVQAD would give us.');
