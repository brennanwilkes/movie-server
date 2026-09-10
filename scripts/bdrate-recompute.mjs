/* RECOMPUTE THE x265 ADVANTAGE FROM SAVED CURVES — with the answer confined to the measured sweep.
 *
 * bdrate-check.js writes every curve to JSON, so the ratio can be re-derived with no re-encoding.
 * That matters because the first two attempts both failed on the same defect in different places:
 *   attempt 1  divided by x265's slope, which is nearly flat for banding -> 4.80x, 0.43x, 0.25x
 *   attempt 2  divided by x264's slope with a |S| < 0.02 guard, far too permissive -> block 4.34x
 * At S = 0.05 the multiplier 1/S is 20, so a small vertical gap becomes an enormous ratio. This is
 * the same divide-by-a-shallow-slope error that produced m = 1e-58 in the blend.
 *
 * THE CONSTRAINT THAT IS NOT A CUT-OFF: the sweep runs 0.4x to 1.7x, a span of 4.25x. If the level
 * at which x264 matches x265's artifact lies outside that span, the answer is extrapolation and the
 * honest report is "not measured here" rather than a number. Same principle as bounding a ladder to
 * its own rungs.
 */
import fs from 'fs';
const d = JSON.parse(fs.readFileSync('data/bdrate-check.json', 'utf8'));
const LEVELS = d.levels;
const lo = Math.log(Math.min(...LEVELS)), hi = Math.log(Math.max(...LEVELS));
const mean = a => a.reduce((x,y)=>x+y,0)/a.length;
function fit(xs, ys) {
  const n = xs.length; if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let sxx=0, sxy=0;
  for (let i=0;i<n;i++){ sxx += (xs[i]-mx)**2; sxy += (xs[i]-mx)*(ys[i]-my); }
  if (!sxx) return null;
  const S = sxy/sxx;
  let sse=0; const a = my - S*mx;
  for (let i=0;i<n;i++) sse += (ys[i]-(a+S*xs[i]))**2;
  return { S, a, r2: 1 - sse/ys.reduce((s,v)=>s+(v-my)**2,0) };
}
const ratios = {cambi:[], block:[], blur:[], grain:[]};
const skips = {crossed:0, outside:0, flat:0, ok:0};
console.log(`${d.films.length} films, sweep ${Math.min(...LEVELS)}x .. ${Math.max(...LEVELS)}x\n`);
console.log(`  ${'film'.padEnd(26)} ${'artifact'.padEnd(7)} ${'ratio'.padStart(7)}  status`);
for (const f of d.films) {
  for (const k of ['cambi','block','blur','grain']) {
    const p4 = (f.curves.x264||[]).filter(p=>p[k]>0), p5 = (f.curves.x265||[]).filter(p=>p[k]>0);
    const f4 = fit(p4.map(p=>Math.log(p.level)), p4.map(p=>Math.log(p[k])));
    const f5 = fit(p5.map(p=>Math.log(p.level)), p5.map(p=>Math.log(p[k])));
    if (!f4 || !f5) continue;
    const dLo = (f4.a+f4.S*lo)-(f5.a+f5.S*lo), dHi = (f4.a+f4.S*hi)-(f5.a+f5.S*hi);
    if (dLo*dHi < 0) { skips.crossed++; continue; }
    const y5 = f5.a + f5.S*0;
    const x4 = (y5 - f4.a)/f4.S;
    if (!Number.isFinite(x4)) { skips.flat++; continue; }
    if (x4 < lo || x4 > hi) {                      // the match lies off the end of the data
      skips.outside++;
      console.log(`  ${f.title.slice(0,25).padEnd(26)} ${k.padEnd(7)} ${Math.exp(x4).toFixed(2).padStart(7)}  OUTSIDE the sweep — not measured`);
      continue;
    }
    skips.ok++;
    ratios[k].push(Math.exp(x4));
    console.log(`  ${f.title.slice(0,25).padEnd(26)} ${k.padEnd(7)} ${Math.exp(x4).toFixed(2).padStart(7)}  in range`);
  }
}
console.log(`\n  usable ${skips.ok}   curves crossed ${skips.crossed}   answer outside the sweep ${skips.outside}   degenerate ${skips.flat}`);
console.log('\nPANEL ESTIMATE OF THE x265 BITRATE ADVANTAGE (published: 1.4-2.0x)\n');
const med = a => a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)];
for (const k of ['cambi','block','blur','grain']) {
  if (!ratios[k].length) { console.log(`  ${k.padEnd(7)} no usable films`); continue; }
  const m = med(ratios[k]);
  const v = m>=1.3&&m<=2.2 ? 'MATCHES published' : m>1.05 ? 'right direction, low' : m<0.95 ? 'INVERTED' : 'no difference';
  console.log(`  ${k.padEnd(7)} n=${String(ratios[k].length).padStart(2)}  median ${m.toFixed(2)}   ${v}`);
}
