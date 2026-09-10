/* IF THE perPoint RESIDUAL IS REAL BUT NOT STARVATION, WHAT CONTENT IS IT?
 *
 * WHERE THIS SITS. Three facts now hold simultaneously and they force a specific conclusion:
 *   1. perPoint's 6-clip reliability is 0.945 (better than grain 0.935, far better than blur 0.404).
 *      The content-line residual is therefore ~86% real signal at 3 clips, NOT noise.
 *   2. 67% of that residual is information BPP+ does not already have (adj R2 0.333 on bpp + cxEff).
 *   3. Converting it through the within-film starvation slope implies a p10-p90 spread of ~7x in
 *      source starvation, which no real library contains.
 * A real, reliable, non-redundant quantity whose starvation interpretation is impossible means THE
 * MEASUREMENT IS SOUND AND THE CONVERSION IS WRONG. The residual is genuine between-film variation
 * in perPoint that is mostly NOT damage.
 *
 * THE HYPOTHESIS. perPoint = d log(bitrate)/d CRF is a rate-response slope, and content changes it
 * for reasons that have nothing to do with provenance. The leading suspect is GRAIN: a large
 * high-frequency tail is exactly what raising QP harvests, so grainy films should show a steeper
 * perPoint whatever their history. Grain is CONTENT, not damage. If that is what the residual holds,
 * then cx20 alone is an insufficient content control and the content "line" needs a second covariate.
 *
 * WHY THIS MATTERS RATHER THAN BEING A CURIOSITY. E.8.3's whole claim is that perPoint separates
 * content from damage because its content and starvation DIRECTIONS differ. That was measured along
 * ONE content axis — complexity. If a second content axis (grain) moves perPoint along a direction
 * closer to the starvation direction, the separation is weaker than advertised and the residual is
 * partly content masquerading as damage. This is the same failure that killed gridRatio, and the
 * bar is the same: a candidate must move DIFFERENTLY under content and under damage, on EVERY
 * content axis, not just the one it was first tested on.
 *
 * *** PRE-REGISTERED. *** For each content covariate, correlate it with the residual:
 *   |rho| < 2 SE            that axis is not in the residual; the content control is adequate for it
 *   |rho| large, grain      the residual is substantially GRAIN. perPoint needs grain as a second
 *                           content term before any damage reading is taken from it, and E.8.3's
 *                           separation must be re-measured along the grain axis.
 * A STRONG GRAIN RESULT IS NOT A REFUTATION OF perPoint — it is a specification error in the content
 * line, which is fixable by adding the covariate. Say which of the two it is.
 *
 * THE TRAP: grain and complexity are themselves correlated, so a raw grain correlation may be cxEff
 * arriving by another route. The residual is ALREADY orthogonal to log(cx20) by construction, which
 * handles most of it, but the partial against cxEff is reported too.
 *
 * READ-ONLY analysis of data already on disk.
 * USAGE: node scripts/perpoint-residual-content.mjs
 */
import fs from 'fs';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const rank = (a) => { const s = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length);
  s.forEach(([, i], k) => { r[i] = k; }); return r; };
function spearman(a, b) {
  const ra = rank(a); const rb = rank(b); const n = a.length;
  const ma = mean(ra); const mb = mean(rb);
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i += 1) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
const partial = (xy, xz, yz) => (xy - xz * yz) / Math.sqrt((1 - xz ** 2) * (1 - yz ** 2));
function lin(xs, ys) {
  const mx = mean(xs); const my = mean(ys); const n = xs.length;
  let num = 0; let den = 0;
  for (let i = 0; i < n; i += 1) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const b = num / den; return { b, a: my - b * mx };
}

const raw = JSON.parse(fs.readFileSync('data/perpoint-content-line.json', 'utf8'));
const ds = await (await fetch('http://localhost:8088/api/probe/dataset')).json();
const byKey = new Map(ds.rows.map((r) => [r.key, r]));
const art = {};
for (const f of ['data/artifact-backfill.json', 'data/provenance-wild.json']) {
  try { Object.assign(art, JSON.parse(fs.readFileSync(f, 'utf8')).units); } catch { /* */ }
}
let flat = {};
try { flat = JSON.parse(fs.readFileSync('data/flat-area.json', 'utf8')).units || {}; } catch { /* */ }

const rows = [];
for (const [key, u] of Object.entries(raw.units)) {
  const arm = u.arms[0] ?? u.arms['0'];
  const r = byKey.get(key);
  if (!arm || !(arm.cx20 > 0) || !Number.isFinite(arm.perPoint) || !r) continue;
  rows.push({ key, t: u.title, pp: arm.perPoint, lcx: Math.log(arm.cx20), cxEff: u.cxEff, bpp: u.bpp,
    a: art[key] || {}, flat: flat[key], probeH: r.probeH, fps: r.fps, year: r.year });
}
const F = lin(rows.map((x) => x.lcx), rows.map((x) => x.pp));
for (const x of rows) x.resid = x.pp - (F.a + F.b * x.lcx);
console.log(`\n  ${rows.length} films with perPoint;  content line slope ${F.b.toFixed(4)}\n`);

const CANDS = [
  ['grain (retention)', (x) => x.a.grain, 'THE LEADING SUSPECT — grain is a high-frequency tail'],
  ['cambi (banding)', (x) => x.a.cambi, ''],
  ['block', (x) => x.a.block, ''],
  ['blur', (x) => x.a.blur, 'blur = log(bits x content), so this is a content probe'],
  ['flat-area frac', (x) => x.flat?.flat ?? x.flat?.flatFrac ?? null, 'a clean content measure'],
  ['log cxEff', (x) => (x.cxEff > 0 ? Math.log(x.cxEff) : null), 'should be near zero: resid is orthogonal to cx20'],
  ['height', (x) => x.probeH, ''],
  ['fps', (x) => x.fps, ''],
  ['year', (x) => x.year, ''],
];

console.log(`  ${'covariate'.padEnd(20)} ${'n'.padStart(4)} ${'rho'.padStart(8)} ${'2SE'.padStart(7)}  note`);
const hits = [];
for (const [name, get, note] of CANDS) {
  const pairs = rows.map((x) => [get(x), x.resid]).filter(([v]) => Number.isFinite(v) && v !== null);
  if (pairs.length < 12) { console.log(`  ${name.padEnd(20)} ${String(pairs.length).padStart(4)}      --   too few`); continue; }
  const rho = spearman(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
  const se2 = 2 / Math.sqrt(pairs.length - 3);
  const sig = Math.abs(rho) > se2;
  if (sig) hits.push([name, rho, pairs.length]);
  console.log(`  ${name.padEnd(20)} ${String(pairs.length).padStart(4)} ${rho.toFixed(3).padStart(8)} `
    + `${se2.toFixed(3).padStart(7)}  ${sig ? '<< SIGNIFICANT  ' : ''}${note}`);
}

/* grain deserves the partial against complexity, since the two are correlated */
const gp = rows.map((x) => [x.a.grain, x.resid, x.cxEff]).filter(([g, , c]) => g > 0 && c > 0);
if (gp.length > 12) {
  const rg = spearman(gp.map((p) => p[0]), gp.map((p) => p[1]));
  const rgc = spearman(gp.map((p) => p[0]), gp.map((p) => Math.log(p[2])));
  const rrc = spearman(gp.map((p) => p[1]), gp.map((p) => Math.log(p[2])));
  console.log(`\n  GRAIN, controlling for complexity (they are correlated, so this matters)\n`);
  console.log(`    grain ~ residual            ${rg.toFixed(3)}`);
  console.log(`    grain ~ log cxEff           ${rgc.toFixed(3)}`);
  console.log(`    residual ~ log cxEff        ${rrc.toFixed(3)}`);
  console.log(`    PARTIAL grain~residual | cx ${partial(rg, rgc, rrc).toFixed(3)}   n ${gp.length}`);
}

console.log('\n  VERDICT\n');
const grainHit = hits.find(([n]) => n.startsWith('grain'));
if (grainHit) {
  console.log(`    THE RESIDUAL CONTAINS GRAIN (rho ${grainHit[1].toFixed(3)}, n ${grainHit[2]}).`);
  console.log('    That is a SPECIFICATION ERROR IN THE CONTENT LINE, not a refutation of perPoint:');
  console.log('    cx20 alone does not capture content, and grain must enter as a second covariate');
  console.log('    before any damage reading is taken from the residual.');
  console.log('    IT ALSO MEANS E.8.3 IS INCOMPLETE. The two-direction separation was measured along');
  console.log('    ONE content axis (complexity). It must be re-measured along the GRAIN axis, because');
  console.log('    a candidate has to move differently under content and damage on EVERY content axis,');
  console.log('    not just the first one tried. That is the bar gridRatio failed.');
} else if (hits.length) {
  console.log(`    THE RESIDUAL CONTAINS: ${hits.map(([n, r]) => `${n} (${r.toFixed(2)})`).join(', ')}.`);
  console.log('    Add these as content covariates before reading the residual as damage.');
} else {
  console.log('    NO CONTENT COVARIATE TESTED EXPLAINS THE RESIDUAL. Combined with reliability 0.945');
  console.log('    and 67% non-redundancy with BPP+, that leaves a real, well-measured quantity whose');
  console.log('    identity is UNKNOWN — which is not the same as it being damage. Do not convert it');
  console.log('    with the starvation slope until something identifies it.');
}
console.log('');
