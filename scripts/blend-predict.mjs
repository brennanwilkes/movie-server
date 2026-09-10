/* WHAT SURVIVES THE VALIDITY-DOMAIN FIX — the predicted table, film by film.
 *
 * The rule, with every edge measured from the film's own ladder rather than chosen:
 *
 *   GATE 1 — is banding even a bitrate problem for this film?
 *     The lossless rung is the film's banding with no compression added by us. If THAT already sits
 *     above the visibility threshold, no bitrate this encode could have carried would put it below.
 *     Bits are not the lever, and the film must not be moved down for banding.
 *
 *   GATE 2 — does the answer lie where the law is valid?
 *     The fitted power law crosses its own lossless asymptote at vSat and predicts the impossible
 *     beyond it; below the lowest rung actually encoded it is unmeasured extrapolation. So the
 *     multiplier m is only meaningful inside [lowest rung, vSat]. Outside, we have no evidence —
 *     which is different from having evidence of no change, and is reported as such.
 *
 *   GATE 3 — shrink what is left by its own standard error (blend-math.js).
 *
 * USAGE: node scripts/blend-predict.mjs
 */
import fs from 'fs';
import { slopeFromLadder, anchorLevel, shiftOf, shrinkage, weightOf, levelNoise, predictorNoise }
  from '../bpp-lab/src/blend-math.js';

const T = 2.817;
const predictS = (L) => -(0.394 * (Math.max(L, 1e-4) ** -0.542));
const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '   -');
const pad = (s, n) => String(s).slice(0, n).padEnd(n);

const lads = JSON.parse(fs.readFileSync('bpp-lab/public/ladders.json', 'utf8')).films;
const ds = await (await fetch('http://localhost:8088/api/probe/dataset')).json();
const rows = ds.rows.filter((r) => r.bppPlus != null && r.cambi > 0);
const varLnL = levelNoise(rows.map((r) => r.cambi));
const predVarLnS = predictorNoise(lads, predictS);

const cand = [];
for (const f of lads) {
  const r = rows.find((x) => x.key === f.key);
  if (!r) continue;
  const sl = slopeFromLadder(f);
  const z = shiftOf({ bppPlus: r.bppPlus, cambi: r.cambi, lad: f, T, varLnL, predVarLnS, predictS });
  if (!sl || !z || f.lossless == null) continue;
  const rungs = (f.points || []).map((p) => p.level).filter((v) => v > 0);
  const lowRung = Math.min(...rungs);
  const hiRung = Math.max(...rungs);
  const vSat = (f.lossless / f.levelAt1) ** (1 / sl.S);
  const bakedIn = f.lossless >= T;
  const inDomain = z.m >= lowRung && z.m <= Math.max(vSat, hiRung);
  cand.push({ r, f, z, sl, lowRung, hiRung, vSat, bakedIn, inDomain });
}

const live = cand.filter((c) => !c.bakedIn && c.inDomain && Number.isFinite(c.z.D));
const sh = shrinkage(live.map((c) => c.z));

console.log(`\nτ² estimated on the ${live.length} films that clear both gates: ${num(sh.tau2, 3)}\n`);
console.log(`${pad('film', 32)} ${'now'.padStart(4)} ${'L'.padStart(6)} ${'loss'.padStart(6)} `
  + `${'S'.padStart(6)} ${'m'.padStart(7)} ${'domain'.padStart(12)} ${'w'.padStart(5)} `
  + `${'after'.padStart(6)}  verdict`);

const out = [];
for (const c of cand.sort((a, b) => a.z.m - b.z.m)) {
  let after = c.r.bppPlus; let w = 0; let verdict;
  if (c.bakedIn) {
    verdict = `banding ${num(c.f.lossless)} is in the source (>T) — bits are not the lever`;
  } else if (!Number.isFinite(c.z.D)) {
    verdict = 'slope ~0, no answer';
  } else if (!c.inDomain) {
    verdict = c.z.m < c.lowRung ? `m below lowest rung ${num(c.lowRung)} — never measured there`
      : `m above vSat ${num(c.vSat)} — fit predicts less banding than lossless has`;
  } else {
    w = weightOf(c.z.sigma, sh.tau2);
    after = c.r.bppPlus * Math.exp(w * c.z.D);
    verdict = `MOVES — ${c.z.m < 1 ? 'headroom' : 'short of bits'}, inside its measured range`;
  }
  out.push({ ...c, after, w });
  console.log(`${pad(c.r.title, 32)} ${String(c.r.bppPlus).padStart(4)} ${num(c.z.L, 3).padStart(6)} `
    + `${num(c.f.lossless, 3).padStart(6)} ${num(c.sl.S).padStart(6)} ${num(c.z.m, 3).padStart(7)} `
    + `${(`${num(c.lowRung, 1)}-${num(Math.max(c.vSat, c.hiRung), 1)}`).padStart(12)} `
    + `${num(w, 2).padStart(5)} ${num(after, 0).padStart(6)}  ${verdict}`);
}

const movers = out.filter((c) => c.w > 0 && Math.abs(c.after - c.r.bppPlus) >= 1);
console.log(`\n${movers.length} of ${cand.length} ladder films move at all.`);
console.log(`  baked into the source (lossless >= T): ${cand.filter((c) => c.bakedIn).length}`);
console.log(`  answer outside the law's valid range:  ${cand.filter((c) => !c.bakedIn && !c.inDomain).length}`);

// What the WIDE rungs now running would unlock: same films, domain widened to 0.3-2.5.
const wide = cand.filter((c) => !c.bakedIn && Number.isFinite(c.z.D)
  && c.z.m >= 0.3 && c.z.m <= 2.5 && !c.inDomain);
console.log(`\nfilms that would come INTO range once the 0.3-2.5 rungs exist: ${wide.length}`);
for (const c of wide) {
  console.log(`  ${pad(c.r.title, 32)} m ${num(c.z.m, 3)}  raw implied ${num(c.z.implied, 0)}`);
}
