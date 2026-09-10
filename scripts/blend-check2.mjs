/* FOLLOW-UP TO blend-check.mjs — two questions the first pass raised and could not answer.
 *
 * It found that empirical-Bayes shrinkage switches the ENTIRE correction off: mean sampling variance
 * 4951 against an observed spread of 129, so tau^2 pins to zero and no film moves. That is either a
 * real verdict or an artifact of pooling 226 guessed slopes with 21 measured ones. So:
 *
 *   Q1. Restricted to films with a MEASURED ladder, is there signal the shrinkage will keep?
 *   Q2. The nightly banding reading has reliability 0.782 on 8 clips, which is sd 0.78 in log — a
 *       factor of 2.2 on the anchor. How many clips would it take to make that good enough?
 *
 * USAGE: node scripts/blend-check2.mjs
 */
import fs from 'fs';
import { shiftOf, shrinkage, weightOf, levelNoise, predictorNoise } from '../bpp-lab/src/blend-math.js';

const T = 2.817;
const predictS = (L) => -(0.394 * (Math.max(L, 1e-4) ** -0.542));
const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '  -');
const pad = (s, n) => String(s).slice(0, n).padEnd(n);

const lads = JSON.parse(fs.readFileSync('bpp-lab/public/ladders.json', 'utf8')).films;
const ladByKey = new Map(lads.map((f) => [f.key, f]));
const ds = await (await fetch('http://localhost:8088/api/probe/dataset')).json();
const rows = ds.rows.filter((r) => r.bppPlus != null && r.cambi > 0);

const varLnL = levelNoise(rows.map((r) => r.cambi));
const predVarLnS = predictorNoise(lads, predictS);

// ── Q1 ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\nQ1. MEASURED LADDERS ONLY — is there anything for the shrinkage to keep?\n');
for (const [label, only] of [['measured ladders', true], ['whole library', false]]) {
  const set = rows.filter((r) => (only ? ladByKey.has(r.key) : true));
  const shifts = set.map((r) => ({ r, z: shiftOf({ bppPlus: r.bppPlus, cambi: r.cambi,
    lad: ladByKey.get(r.key), T, varLnL, predVarLnS, predictS }) })).filter((x) => x.z);
  const sh = shrinkage(shifts.map((x) => x.z));
  const sig = shifts.map((x) => x.z.sigma).sort((a, b) => a - b);
  console.log(`  ${pad(label, 18)} n=${String(shifts.length).padStart(3)}  `
    + `median sigma ${num(sig[Math.floor(sig.length / 2)])}  `
    + `Var(D) ${num(sh.obsVar, 2).padStart(8)}  mean sigma^2 ${num(sh.meanSigma2, 2).padStart(9)}  `
    + `tau^2 ${num(sh.tau2, 3)}`);
}

// The measured set, film by film — this is the only place the framework is on real data both ways.
const mset = rows.filter((r) => ladByKey.has(r.key));
const ms = mset.map((r) => ({ r, z: shiftOf({ bppPlus: r.bppPlus, cambi: r.cambi,
  lad: ladByKey.get(r.key), T, varLnL, predVarLnS, predictS }) })).filter((x) => x.z);
const msh = shrinkage(ms.map((x) => x.z));
console.log(`\n  ${pad('film', 32)} ${'BPP+'.padStart(5)} ${'L'.padStart(7)} ${'S'.padStart(6)} `
  + `${'m'.padStart(7)} ${'raw'.padStart(6)} ${'sigma'.padStart(6)} ${'w'.padStart(5)} ${'final'.padStart(6)}`);
for (const x of ms.sort((a, b) => a.z.m - b.z.m)) {
  const w = weightOf(x.z.sigma, msh.tau2);
  console.log(`  ${pad(x.r.title, 32)} ${String(x.r.bppPlus).padStart(5)} ${num(x.z.L, 3).padStart(7)} `
    + `${num(x.z.S).padStart(6)} ${num(x.z.m, 3).padStart(7)} ${num(x.z.implied, 0).padStart(6)} `
    + `${num(x.z.sigma).padStart(6)} ${num(w, 2).padStart(5)} `
    + `${num(x.r.bppPlus * Math.exp(w * x.z.D), 0).padStart(6)}`);
}

// ── Q2 ───────────────────────────────────────────────────────────────────────────────────────────
// Spearman-Brown, inverted. rho_n = n*rho_1 / (1 + (n-1)*rho_1) with rho_8 = 0.782 gives the
// single-clip reliability, and from that the clip count needed for any target.
console.log('\n\nQ2. HOW MANY CLIPS WOULD THE NIGHTLY BANDING PROBE NEED?\n');
const N0 = 8; const RHO_N = 0.782;
const rho1 = RHO_N / (N0 - (N0 - 1) * RHO_N);
console.log(`  single-clip reliability implied by 0.782 at ${N0} clips: ${num(rho1, 3)}`);
const sdTotal = Math.sqrt(levelNoise(rows.map((r) => r.cambi), 0));   // total observed sd of ln cambi
console.log(`  observed sd of ln(banding) across the library: ${num(sdTotal, 3)}\n`);
console.log(`  ${'clips'.padStart(6)} ${'reliability'.padStart(12)} ${'sd(ln L)'.padStart(10)} `
  + `${'anchor good to'.padStart(15)} ${'probe cost'.padStart(11)}`);
for (const n of [8, 16, 24, 32, 48, 64, 96]) {
  const rho = (n * rho1) / (1 + (n - 1) * rho1);
  const sd = sdTotal * Math.sqrt(1 - rho);
  console.log(`  ${String(n).padStart(6)} ${num(rho, 3).padStart(12)} ${num(sd, 3).padStart(10)} `
    + `${(`x${num(Math.exp(sd))}`).padStart(15)} ${(`${num(n / N0, 1)}x`).padStart(11)}`);
}

// What does halving the level noise actually buy in weight terms? Re-run the measured set with the
// error variance a target reliability would give, so the answer is in the units of the decision.
console.log('\n  effect on the measured set, holding slopes fixed:\n');
console.log(`  ${'clips'.padStart(6)} ${'median sigma'.padStart(13)} ${'tau^2'.padStart(8)} `
  + `${'films w>0.25'.padStart(13)} ${'median |move|'.padStart(14)}`);
for (const n of [8, 16, 32, 64, 96]) {
  const rho = (n * rho1) / (1 + (n - 1) * rho1);
  const v = (sdTotal ** 2) * (1 - rho);
  const zs = mset.map((r) => shiftOf({ bppPlus: r.bppPlus, cambi: r.cambi, lad: ladByKey.get(r.key),
    T, varLnL: v, predVarLnS, predictS })).filter(Boolean);
  const s = shrinkage(zs);
  const ws = zs.map((z) => weightOf(z.sigma, s.tau2));
  const moves = zs.map((z, i) => Math.abs(Math.expm1(ws[i] * z.D))).sort((a, b) => a - b);
  const sig = zs.map((z) => z.sigma).sort((a, b) => a - b);
  console.log(`  ${String(n).padStart(6)} ${num(sig[Math.floor(sig.length / 2)]).padStart(13)} `
    + `${num(s.tau2, 3).padStart(8)} ${String(ws.filter((w) => w > 0.25).length).padStart(13)} `
    + `${(`${num(100 * moves[Math.floor(moves.length / 2)], 0)}%`).padStart(14)}`);
}
