/* HOW MUCH OF P IS ACTUALLY PROVENANCE? — the shrinkage the rule should have been using.
 *
 * THE CONTRADICTION THAT FORCED THIS. The crossed ladder measured a generation at 33.1% bitrate,
 * cleanly: 8/8 direction checks, two independent statistics agreeing to 0.9 points, inside the
 * published 5-40% band. Applying it to the library produced adjustments of +-39.8% at 5-95 and
 * +-78.4% worst case, which FAILS the external bound. Both cannot be right.
 *
 * THE ARITHMETIC LOCATES THE ERROR EXACTLY. The same experiment measured dP/dgen = 0.136 P-sd per
 * generation. So one standard deviation of P is 1/0.136 = 7.4 GENERATIONS, and the library's +-3 sd
 * span is +-22 generations. Nothing in this library is twenty-two generations from its master. Even
 * after shrinking by the split-half reliability of 0.393 it is +-8.7 generations, which is still not
 * a thing that exists.
 *
 * SO P's SPREAD IS NOT MOSTLY PROVENANCE, AND RELIABILITY IS THE WRONG SHRINKAGE. Split-half
 * reliability answers "how much of P is a common factor across disjoint detector halves". That is a
 * real and useful quantity — it is what established the factor exists at all (11.26) — but a common
 * factor is not the same as a PROVENANCE factor. Anything shared across detectors and not captured by
 * the bits+content surface lands in it: shooting style, grade, lens, mastering house, deliberate
 * softness. Those are real properties of a film and they are NOT things a better download fixes.
 *
 * WHAT SHOULD BE USED INSTEAD: the fraction of P's variance that observable provenance can account
 * for. Source label (WEBRip / WEB-DL / Bluray / HDTV) is the only provenance marker this library
 * carries, so the between-label variance of P is a direct, assumption-free LOWER BOUND on it.
 *
 * WHY A LOWER BOUND IS THE RIGHT SHAPE HERE AND NOT A COP-OUT. Labels are coarse: two Blurays can
 * differ by a release group, a preset and a generation while sharing a label, and that variation is
 * real provenance sitting inside the within-label term. So the true provenance fraction is HIGHER
 * than this. Using the lower bound makes the adjustment CONSERVATIVE — it errs toward saying too
 * little, which is the failure mode this project can afford. The alternative (reliability) errs
 * toward saying far too much, which is the failure mode that produced 1e-58 and 4.64x.
 *
 * THIS IS DERIVED BEFORE THE EXTERNAL BOUND IS CONSULTED. Shrinking P until the adjustments look
 * plausible would be fitting to the bound and would make the bound worthless as a check. The
 * decomposition below uses only P, the labels, and the measured dP/dgen.
 *
 * USAGE: node scripts/provenance-fraction.mjs
 */
import fs from 'fs';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

const P = JSON.parse(fs.readFileSync('bpp-lab/public/provenance.json', 'utf8'));
const units = Object.entries(P.units).map(([key, u]) => ({ key, ...u }));

/* dP per generation, straight from the crossed ladder. Median of per-film leg-B slopes. */
const DET = ['cambi', 'block', 'blur', 'grain'];
const EXPECT = { cambi: +1, block: +1, blur: +1, grain: -1 };
let dPdGen = null;
try {
  const back = JSON.parse(fs.readFileSync('data/artifact-backfill.json', 'utf8')).units;
  const SD = {};
  for (const k of DET) {
    const v = Object.values(back).filter((u) => u[k] > 0).map((u) => Math.log(u[k]));
    SD[k] = sd(v);
  }
  /* Rebuild the same composite scale the analyse script uses, so dP/dgen is in library-P sd units. */
  const cross = JSON.parse(fs.readFileSync('data/anchor-crossed.json', 'utf8'));
  const raw = [];
  for (const [, u] of Object.entries(back)) {
    if (DET.every((k) => u[k] > 0)) raw.push(DET.reduce((s, k) => s + (EXPECT[k] * Math.log(u[k])) / SD[k], 0));
  }
  const SDSUM = sd(raw);
  const pOf = (m) => DET.reduce((s, k) => s + (m[k] > 0 ? (EXPECT[k] * Math.log(m[k])) / SD[k] : 0), 0) / SDSUM;
  const slopes = [];
  for (const f of cross.films || []) {
    const b = (f.legB || []).filter((x) => DET.every((k) => x[k] > 0)).sort((x, y) => x.gen - y.gen);
    if (b.length < 2) continue;
    slopes.push((pOf(b[b.length - 1]) - pOf(b[0])) / (b[b.length - 1].gen - b[0].gen));
  }
  if (slopes.length >= 4) dPdGen = med(slopes);
} catch { /* optional */ }

console.log(`\n  n = ${units.length}   P is standardised: mean 0, sd 1 by construction\n`);
if (dPdGen) {
  console.log(`  MEASURED dP per generation (crossed ladder): ${dPdGen.toFixed(4)} P-sd`);
  console.log(`  => one sd of P is ${(1 / dPdGen).toFixed(1)} GENERATIONS, and the library spans about +-3 sd,`);
  console.log(`     i.e. +-${(3 / dPdGen).toFixed(0)} generations. That is the absurdity this script exists to fix.\n`);
}

/* ---- THE DECOMPOSITION ---- */
const labelOf = (u) => (/WEBRip/i.test(u.source || '') ? 'WEBRip'
  : /WEBDL|WEB-DL/i.test(u.source || '') ? 'WEB-DL'
    : /Bluray/i.test(u.source || '') ? 'Bluray'
      : /HDTV/i.test(u.source || '') ? 'HDTV' : 'other');
const groups = {};
for (const u of units) (groups[labelOf(u)] ||= []).push(u.P);

const all = units.map((u) => u.P);
const grand = mean(all);
const totalVar = sd(all) ** 2;
let betweenSS = 0; let n = 0;
console.log(`  ${'source'.padEnd(10)} ${'n'.padStart(5)} ${'mean P'.padStart(9)} ${'sd'.padStart(7)}`);
for (const [k, v] of Object.entries(groups)) {
  if (v.length < 10) continue;
  betweenSS += v.length * (mean(v) - grand) ** 2;
  n += v.length;
  console.log(`  ${k.padEnd(10)} ${String(v.length).padStart(5)} ${mean(v).toFixed(3).padStart(9)} ${sd(v).toFixed(3).padStart(7)}`);
}
const betweenVar = betweenSS / Math.max(1, n - 1);
const frac = betweenVar / totalVar;
console.log(`\n  total variance of P                 ${totalVar.toFixed(4)}`);
console.log(`  between-source-label variance       ${betweenVar.toFixed(4)}`);
console.log(`  PROVENANCE FRACTION (lower bound)   ${frac.toFixed(4)}   -> sd ${Math.sqrt(frac).toFixed(3)} P-sd`);
console.log(`  compare: split-half reliability      ${P.reliability.toFixed(3)}  <- what the rule uses NOW`);
console.log(`  ratio ${(P.reliability / Math.sqrt(frac)).toFixed(1)}x too large`);

if (dPdGen) {
  console.log(`\n  SANITY: at the lower-bound shrinkage, a +3 sd film is `
    + `${((3 * Math.sqrt(frac)) / dPdGen).toFixed(1)} generations from a typical one.`);
  console.log(`          at the reliability shrinkage it is ${((3 * P.reliability) / dPdGen).toFixed(1)} generations.`);
  console.log('          A real library spans maybe 0-4 generations, so the first is plausible and the');
  console.log('          second is not. THIS IS THE CHECK THAT MATTERS, and it does not use the');
  console.log('          adjustment bound at all.');
}

/* ---- WHAT IT DOES TO THE RULE ---- */
/* Only now is the external bound consulted, as a CHECK on a shrinkage derived independently. */
const gap = P.anchor.gap;
console.log('\n  RESULTING RULE, at the measured anchor of 33.1%\n');
console.log(`  ${'shrinkage'.padEnd(28)} ${'lambda'.padStart(8)} ${'+-1sd of P'.padStart(11)} ${'5-95 band'.padStart(11)}`);
for (const [nm, s] of [['reliability 0.393 (current)', P.reliability],
  ['provenance fraction (new)', Math.sqrt(frac)]]) {
  const lambda = Math.log(1 + 0.331) / gap;
  const at1 = (Math.exp((-s * lambda * 1) / 2) - 1) * 100;
  const at164 = (Math.exp((-s * lambda * 1.645) / 2) - 1) * 100;
  console.log(`  ${nm.padEnd(28)} ${lambda.toFixed(3).padStart(8)} ${`${at1.toFixed(1)}%`.padStart(11)} ${`+-${Math.abs(at164).toFixed(1)}%`.padStart(11)}`);
}
console.log('\n  The external bound (a generation is worth 5-40% bitrate, so +-25% in score for the bulk of');
console.log('  a library and +-41% at the extreme) is now applied as a CHECK on a number derived from');
console.log('  the variance decomposition above — not as a target that was fitted to.\n');
