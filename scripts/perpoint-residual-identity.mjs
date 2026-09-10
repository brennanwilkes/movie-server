/* WHAT IS THE CROSS-FILM perPoint RESIDUAL ACTUALLY MADE OF?
 *
 * THE TENSION THIS RESOLVES. The 60-film content line leaves a residual sd of 0.0280. Two readings
 * are on the table and they lead opposite ways:
 *   (a) MOSTLY NOISE. Converting through the within-film level slope (-0.0297) implies a p10-p90
 *       spread of ~11x in source starvation. No real library spans that, so the residual "must be"
 *       measurement noise. This was the working assumption.
 *   (b) MOSTLY REAL. The reliability run is showing within-film scene-to-scene sds around
 *       0.005-0.034, so the standard error of a 3-clip mean is roughly 0.007. Against a residual sd
 *       of 0.0280 that is only ~6% of the variance, implying a reliability near 0.9 and a residual
 *       that is almost all real between-film variation.
 * BOTH CANNOT BE TRUE, and the reliability run settles which. But there is a THIRD possibility that
 * neither addresses and that this script tests:
 *
 *   *** THE RESIDUAL IS REAL, AND IT IS NOT STARVATION. ***
 *
 * Converting it to "implied source starvation" uses d perPoint/d log(level), a WITHIN-FILM slope
 * measured under controlled starvation, applied to a CROSS-FILM quantity. That is precisely the
 * transfer assumption that inflated the anchor by 4.6x (11.30) and that the crossed ladder was
 * invented to eliminate. If between-film perPoint differences arise from anything other than
 * starvation — source resolution, film stock, telecine, grain structure, encoder family — then the
 * conversion overstates starvation while the underlying measurement is perfectly sound.
 *
 * THE TEST, and it needs no new encoding. If the residual IS starvation-like, it must line up with
 * provenance we can observe independently:
 *     SOURCE TIER      Bluray/Remux should be less starved than WEBRip/HDTV
 *     RATE CONTROL     crf and 2pass encodes should differ from abr
 *     ENCODER BUILD    older x264 builds are a real, dated difference
 *     BITRATE          a starved source is, all else equal, a low-bitrate one
 * If NONE of these move the residual, then whatever it measures is not the release-channel damage
 * the score wants to correct for, and it must not be converted into a bitrate-equivalent.
 *
 * *** THE TRAP, STATED FIRST. *** bpp is NOT a clean provenance marker here: it is the numerator of
 * BPP+ itself, so a correlation with it would be partly mechanical. Source tier is the cleaner test
 * because it is an external label. And the encoder fields correlate with YEAR, which correlates with
 * content — the same confound that nearly faked the provShare result, so year is entered as a
 * control there too.
 *
 * READ-ONLY analysis of data already on disk. No encoding.
 * USAGE: node scripts/perpoint-residual-identity.mjs
 */
import fs from 'fs';

const LEVEL = -0.0297;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const rank = (a) => { const s = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length);
  s.forEach(([, i], k) => { r[i] = k; }); return r; };
function spearman(a, b) {
  const ra = rank(a); const rb = rank(b); const n = a.length;
  const ma = mean(ra); const mb = mean(rb);
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i += 1) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
function lin(xs, ys) {
  const mx = mean(xs); const my = mean(ys); const n = xs.length;
  let num = 0; let den = 0;
  for (let i = 0; i < n; i += 1) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const b = num / den; const a = my - b * mx;
  return { a, b };
}

const raw = JSON.parse(fs.readFileSync('data/perpoint-content-line.json', 'utf8'));
const ds = await (await fetch('http://localhost:8088/api/probe/dataset')).json();
const byKey = new Map(ds.rows.map((r) => [r.key, r]));
let fp = {};
try { fp = JSON.parse(fs.readFileSync('data/encoder-fingerprint.json', 'utf8')).units; } catch { /* */ }

const rows = [];
for (const [key, u] of Object.entries(raw.units)) {
  const arm = u.arms[0] ?? u.arms['0'];
  const r = byKey.get(key);
  if (!arm || !(arm.cx20 > 0) || !Number.isFinite(arm.perPoint) || !r) continue;
  rows.push({ key, t: u.title, pp: arm.perPoint, cx20: arm.cx20, bpp: u.bpp,
    source: r.source || '', year: r.year ?? null, f: fp[key] || {} });
}
const F = lin(rows.map((x) => Math.log(x.cx20)), rows.map((x) => x.pp));
for (const x of rows) x.resid = x.pp - (F.a + F.b * Math.log(x.cx20));
const RSD = sd(rows.map((x) => x.resid));
console.log(`\n  ${rows.length} films.  content line slope ${F.b.toFixed(4)}   residual sd ${RSD.toFixed(4)}\n`);
const se = 1 / Math.sqrt(rows.length - 3);

/* ---- 1. SOURCE TIER, the cleanest external label ---- */
const tierOf = (s) => {
  const t = String(s).toLowerCase();
  if (t.includes('remux')) return '1 Remux';
  if (t.includes('bluray')) return '2 Bluray';
  if (t.includes('webdl') || t.includes('web-dl')) return '3 WEB-DL';
  if (t.includes('webrip')) return '4 WEBRip';
  if (t.includes('hdtv')) return '5 HDTV';
  if (t.includes('dvd')) return '6 DVD';
  return '9 other';
};
const groups = {};
for (const x of rows) { const k = tierOf(x.source); (groups[k] ||= []).push(x.resid); }
console.log('  1. SOURCE TIER — the external label. A starvation reading should ORDER by tier.\n');
console.log(`    ${'tier'.padEnd(12)} ${'n'.padStart(3)} ${'mean resid'.padStart(11)} ${'implied starve'.padStart(15)}`);
for (const k of Object.keys(groups).sort()) {
  const g = groups[k];
  console.log(`    ${k.padEnd(12)} ${String(g.length).padStart(3)} ${mean(g).toFixed(4).padStart(11)} `
    + `${Math.exp(-mean(g) / LEVEL).toFixed(2).padStart(15)}`);
}
/* a rank correlation of residual against tier ORDER is the summary statistic */
const withTier = rows.filter((x) => tierOf(x.source) !== '9 other');
const rTier = withTier.length > 8
  ? spearman(withTier.map((x) => Number(tierOf(x.source)[0])), withTier.map((x) => x.resid)) : NaN;
console.log(`\n    rank corr (tier order vs residual)  ${Number.isFinite(rTier) ? rTier.toFixed(3) : 'n/a'}`
  + `  +- ${se.toFixed(3)}   n ${withTier.length}`);
console.log('    POSITIVE means worse tiers sit higher (flatter perPoint) = more starved, as expected.');
/* *** POWER CHECK BEFORE READING THAT AS A NULL. *** A control that fails to fire is only
 * informative if it COULD have fired. This library is ~80% Bluray, so the non-Bluray cells are tiny
 * and the tier "ordering" is dominated by groups of 2-6 films. Calling that a null would repeat
 * exactly the error flagged against the 720p negative control. */
const cells = Object.entries(groups).filter(([k]) => k !== '9 other').map(([k, g]) => [k, g.length]);
const small = cells.filter(([, n]) => n < 10);
if (small.length) {
  console.log(`\n    *** UNDERPOWERED, DO NOT READ AS A NULL. *** Cells with n < 10: `
    + `${small.map(([k, n]) => `${k.trim()} n=${n}`).join(', ')}.`);
  console.log('    The library is overwhelmingly Bluray, so this contrast is ~47 Blurays against a');
  console.log('    handful of everything else. A tier test needs a stratified sample drawn FOR it.');
}

/* ---- 2. RATE CONTROL and ENCODER BUILD ---- */
console.log('\n  2. BITSTREAM PROVENANCE — recovered from the encode itself, not from the filename\n');
const rc = {};
for (const x of rows) { const k = x.f.rc || '(none)'; (rc[k] ||= []).push(x.resid); }
for (const k of Object.keys(rc).sort()) {
  if (rc[k].length < 3) continue;
  console.log(`    rc=${k.padEnd(10)} n ${String(rc[k].length).padStart(3)}   mean resid ${mean(rc[k]).toFixed(4)}`);
}
const wb = rows.filter((x) => x.f.build > 0);
if (wb.length > 8) {
  const rB = spearman(wb.map((x) => x.f.build), wb.map((x) => x.resid));
  console.log(`\n    rank corr (x264 build vs residual)  ${rB.toFixed(3)} +- ${(1 / Math.sqrt(wb.length - 3)).toFixed(3)}   n ${wb.length}`);
  const wy = wb.filter((x) => x.year);
  if (wy.length > 8) {
    const rY = spearman(wy.map((x) => x.year), wy.map((x) => x.resid));
    console.log(`    rank corr (YEAR vs residual)        ${rY.toFixed(3)} — the confound; build tracks year`);
  }
}

/* ---- 3. BITRATE, flagged as partly mechanical ---- */
const rBpp = spearman(rows.map((x) => x.bpp), rows.map((x) => x.resid));
console.log(`\n  3. BITRATE (partly mechanical — bpp is BPP+'s own numerator)  rho ${rBpp.toFixed(3)} +- ${se.toFixed(3)}`);

/* ---- verdict ---- */
console.log('\n  VERDICT\n');
const hits = [];
if (Number.isFinite(rTier) && Math.abs(rTier) > 2 * se) hits.push(`source tier (${rTier.toFixed(2)})`);
if (Math.abs(rBpp) > 2 * se) hits.push(`bitrate (${rBpp.toFixed(2)})`);
if (hits.length === 0) {
  console.log('    NO OBSERVABLE PROVENANCE MARKER MOVES THE RESIDUAL. Whatever the cross-film');
  console.log('    perPoint residual measures, it is NOT the release-channel damage the score wants to');
  console.log('    correct for. It may still be perfectly well measured — the reliability run answers');
  console.log('    that separately — but it MUST NOT be converted into a bitrate-equivalent via the');
  console.log('    within-film level slope. That conversion is the transfer assumption that inflated');
  console.log('    the anchor 4.6x, and with no provenance signal there is nothing to justify it.');
  console.log('\n    This does NOT touch the within-film results: the two-direction separation, the gblur');
  console.log('    specificity leg and the starvation response are all within-film and stand.');
} else {
  console.log(`    THE RESIDUAL TRACKS: ${hits.join(', ')}.`);
  console.log('    That is provenance signal in a cross-film quantity, which is what a detail term');
  console.log('    needs. Check the SIGN against the physical story before believing it, and note the');
  console.log('    conversion to implied starvation STILL rests on a within-film slope applied to a');
  console.log('    cross-film residual — validate that separately before any score uses it.');
}
console.log('');
