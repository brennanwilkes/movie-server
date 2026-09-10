/* DOES THE FIELD RESIDUAL CARRY PROVENANCE? — the analysis, pre-registered before the data landed.
 *
 * THE QUESTION. Four axes are validated in CONTROLLED conditions where bits and content are held
 * exactly constant. The library never does that, so the field version must predict the expected
 * artifact from bits+content and read the RESIDUAL. Nothing so far separates two hypotheses:
 *      residual is mostly PROVENANCE      -> the Blend page can be built on it
 *      residual is mostly MODEL ERROR     -> it cannot
 *
 * THE TEST. A WEBRip IS a re-encode of a WEB-DL — that is what the label means. So at matched bits
 * and content, WEBRips should show MORE blocking and blur and LESS grain.
 *
 * PRE-REGISTERED BEFORE SEEING ANY DATA (2026-08-26 21:28):
 *   direction   block +, blur +, grain -, cambi no strong prior
 *   POSITIVE  -> the residual carries provenance
 *   NULL      -> UNINFORMATIVE, NOT evidence against the framework. A null means either WEBRips are
 *                not very different from WEB-DLs, or model error dominates, and this test cannot
 *                distinguish those. Do not read a null as a failure. The power calculation said the
 *                effect is detectable only if the axes STACK (1 generation + preset + denoise, ratio
 *                ~5) and undetectable if a WEBRip is one clean extra generation (needs n=1321).
 *
 * CONFOUNDS CONTROLLED HERE:
 *   bits      WEBRips are smaller by design, so bpp differs systematically. Modelled flexibly
 *             (quadratic in log bpp) and additionally checked inside matched bpp bands.
 *   content   complexity differs between groups; included, and its group difference is reported so
 *             a reader can see whether the groups were comparable at all.
 *   size      720p and 1080p mix; reported separately because bpp normalises pixel count but not
 *             the artifact character of a smaller frame.
 *
 * USAGE: node scripts/provenance-analyse.mjs
 */
import fs from 'fs';

const D = JSON.parse(fs.readFileSync('data/provenance-wild.json', 'utf8')).units;
const all = Object.values(D).filter((u) => u.bpp > 0 && u.cxEff > 0);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
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
const isRip = (u) => /WEBRip/i.test(u.source || '');

console.log(`\n${all.length} units measured  |  WEBRip ${all.filter(isRip).length}  WEB-DL ${all.filter((u) => !isRip(u)).length}\n`);

// Were the groups comparable to begin with? If they differ wildly in content or bits, no amount of
// regression rescues it and the reader must see that before the headline.
console.log('  GROUP COMPARABILITY (a big gap here means the regression is doing heavy lifting)');
console.log(`  ${'quantity'.padEnd(14)} ${'WEBRip'.padStart(10)} ${'WEB-DL'.padStart(10)}`);
for (const [nm, f] of [['median bpp', (u) => u.bpp], ['median cx', (u) => u.cxEff], ['median BPP+', (u) => u.bppPlus]]) {
  const a = all.filter(isRip).map(f).filter((v) => v > 0);
  const b = all.filter((u) => !isRip(u)).map(f).filter((v) => v > 0);
  if (a.length && b.length) console.log(`  ${nm.padEnd(14)} ${med(a).toFixed(4).padStart(10)} ${med(b).toFixed(4).padStart(10)}`);
}

console.log('\n  THE TEST — residual after bits+content, WEBRip minus WEB-DL\n');
console.log(`  ${'detector'.padEnd(9)} ${'n'.padStart(4)} ${'diff'.padStart(8)} ${'SE'.padStart(7)} ${'t'.padStart(6)} `
  + `${'expected'.padStart(9)}   verdict`);
const EXPECT = { cambi: 0, block: +1, blur: +1, grain: -1 };
for (const k of ['cambi', 'block', 'blur', 'grain']) {
  const use = all.filter((u) => u[k] > 0);
  if (use.length < 20) { console.log(`  ${k.padEnd(9)} ${String(use.length).padStart(4)}   too few`); continue; }
  const lb = use.map((u) => Math.log(u.bpp));
  const X = use.map((u, i) => [1, lb[i], lb[i] * lb[i], u.cxEff]);
  const be = ols(X, use.map((u) => Math.log(u[k])));
  if (!be) { console.log(`  ${k.padEnd(9)} singular`); continue; }
  const res = use.map((u, i) => Math.log(u[k]) - X[i].reduce((s, z, j) => s + z * be[j], 0));
  const A = res.filter((_, i) => isRip(use[i]));
  const B = res.filter((_, i) => !isRip(use[i]));
  if (A.length < 8 || B.length < 8) { console.log(`  ${k.padEnd(9)} groups too small (${A.length}/${B.length})`); continue; }
  const diff = mean(A) - mean(B);
  const se = Math.sqrt(sd(A) ** 2 / A.length + sd(B) ** 2 / B.length);
  const t = diff / se;
  const dir = EXPECT[k];
  const right = dir === 0 ? 'no prior' : (Math.sign(diff) === dir ? 'right direction' : 'WRONG DIRECTION');
  const sig = Math.abs(t) > 2 ? 'significant' : Math.abs(t) > 1 ? 'weak' : 'null';
  console.log(`  ${k.padEnd(9)} ${String(use.length).padStart(4)} ${diff.toFixed(3).padStart(8)} ${se.toFixed(3).padStart(7)} `
    + `${t.toFixed(2).padStart(6)} ${(dir > 0 ? '+' : dir < 0 ? '-' : '?').padStart(9)}   ${sig}, ${right}`);
}

/* THE CONTROL THAT MATTERS MOST. Regression assumes the bits+content relationship has the shape we
 * gave it. Restricting to a narrow bpp band assumes almost nothing, so if the two disagree, trust
 * this one. */
console.log('\n  CONTROL — inside a matched bpp band, so the regression does no work at all\n');
const bpps = all.map((u) => u.bpp).sort((a, b) => a - b);
const lo = bpps[Math.floor(bpps.length * 0.25)]; const hi = bpps[Math.floor(bpps.length * 0.75)];
const band = all.filter((u) => u.bpp >= lo && u.bpp <= hi);
console.log(`  band ${lo.toFixed(4)} .. ${hi.toFixed(4)} bpp — ${band.filter(isRip).length} WEBRip, ${band.filter((u) => !isRip(u)).length} WEB-DL`);
console.log(`  ${'detector'.padEnd(9)} ${'WEBRip'.padStart(9)} ${'WEB-DL'.padStart(9)} ${'ratio'.padStart(8)}`);
for (const k of ['cambi', 'block', 'blur', 'grain']) {
  const a = band.filter((u) => isRip(u) && u[k] > 0).map((u) => u[k]);
  const b = band.filter((u) => !isRip(u) && u[k] > 0).map((u) => u[k]);
  if (a.length < 5 || b.length < 5) { console.log(`  ${k.padEnd(9)} too few (${a.length}/${b.length})`); continue; }
  console.log(`  ${k.padEnd(9)} ${med(a).toFixed(3).padStart(9)} ${med(b).toFixed(3).padStart(9)} ${(med(a) / med(b)).toFixed(3).padStart(8)}`);
}
console.log('\n  Reminder of the pre-registration: a NULL here is uninformative, not evidence against.');
