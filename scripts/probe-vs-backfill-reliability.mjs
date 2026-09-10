/* IS THE NIGHTLY PROBE'S block/blur BETTER SAMPLED THAN THE ONE P ACTUALLY USES?
 *
 * THE CLAIM. P reads block and blur from artifact-backfill.js at 4 clips x 2s = 8 decoded seconds.
 * The nightly CRF probe has been measuring the same two detectors all along at 8 samples x 4s = 32
 * decoded seconds — four times the material, on every unit, already on disk. If the probe's readings
 * are more reliable, swapping them into P is free accuracy.
 *
 * THE SECOND, LARGER REASON TO WANT IT. 11.53 showed the per-film ordering is ~52% scene-sampling
 * noise, and the mechanism is that ALL FOUR detectors read THE SAME CLIPS, so the nuisance is shared
 * across detectors and points along the signal. The probe samples DIFFERENT positions from the
 * backfill. So sourcing block/blur from the probe and cambi/grain from the backfill means the four
 * detectors no longer share one sampling — the nuisance is split across two independent draws and can
 * no longer be fully common. That is a structural fix, not just a precision one.
 *
 * WHAT IS MEASURED HERE, and the comparison is deliberately apples-to-apples. Reliability is
 * estimated by splitting each unit's samples into two halves and correlating the half-means ACROSS
 * units, then Spearman-Brown to the full length. The probe's halves are 4 samples each, so the raw
 * split-half is directly comparable to the backfill's published 4-clip figure (blur 0.404, the worst
 * of the four detectors).
 *
 * *** A CEILING WORTH STATING BEFORE READING ANY RESULT. *** 11.x measured corr^2 = 0.398 between the
 * probe's blur and the backfill's, against the backfill's own reliability of 0.404. Two instruments
 * cannot agree more than the noisier one's reliability allows, so the two are already agreeing at
 * essentially the ceiling. That means the probe's blur is close to noiseless RELATIVE TO the
 * backfill's — and it also means this test cannot show a large gain in agreement, only in stability.
 *
 * SCOPE. E.8.1 showed blur is a pure log(bits x content) function and therefore orthogonal to the
 * ADEQUACY axis by construction. That does NOT disqualify it from P: P is a residual with bits and
 * content already removed, so blur's residual can still carry provenance. Better sampling of it is
 * still worth having. But do not read a reliability gain here as rehabilitating blur for calibration.
 *
 * USAGE: node scripts/probe-vs-backfill-reliability.mjs
 */
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
const sb = (r, k) => (k * r) / (1 + (k - 1) * r);   /* Spearman-Brown to k times the half length */

const ds = await (await fetch('http://localhost:8088/api/probe/dataset')).json();

for (const det of ['sampleBlur', 'sampleBlock']) {
  const rows = ds.rows.filter((r) => Array.isArray(r[det]) && r[det].length >= 8
    && r[det].every((v) => Number.isFinite(v) && v > 0));
  if (rows.length < 20) { console.log(`\n  ${det}: only ${rows.length} usable units — too few\n`); continue; }
  console.log(`\n  ${det}  —  ${rows.length} units with 8 clean samples\n`);

  /* Average over the 35 distinct 4/4 splits rather than one arbitrary one: a single split is itself
   * a coin flip and would give a number that moves when re-run. */
  const idx = [0, 1, 2, 3, 4, 5, 6, 7];
  const combos = [];
  for (let a = 1; a < 256; a += 1) {
    const on = idx.filter((i) => (a >> i) & 1);
    if (on.length === 4 && on[0] === 0) combos.push(on);
  }
  const rs = [];
  for (const on of combos) {
    const off = idx.filter((i) => !on.includes(i));
    const A = rows.map((r) => mean(on.map((i) => Math.log(r[det][i]))));
    const B = rows.map((r) => mean(off.map((i) => Math.log(r[det][i]))));
    rs.push(spearman(A, B));
  }
  rs.sort((a, b) => a - b);
  const half = mean(rs);
  console.log(`    split-half over ${combos.length} distinct 4/4 splits`);
  console.log(`      mean ${half.toFixed(3)}   median ${rs[rs.length >> 1].toFixed(3)}   `
    + `range ${rs[0].toFixed(3)} to ${rs[rs.length - 1].toFixed(3)}`);
  console.log(`    reliability of a 4-sample mean   ${half.toFixed(3)}`);
  console.log(`    reliability of the 8-sample mean ${sb(half, 2).toFixed(3)}   (Spearman-Brown)`);
  if (det === 'sampleBlur') {
    console.log(`\n    BACKFILL COMPARISON: blur's 4-clip reliability is 0.404, on 2s clips.`);
    console.log(`    The probe's 4-sample figure is ${half.toFixed(3)} on 4s samples — `
      + `${half > 0.404 ? 'BETTER' : 'NOT better'}, and its full`);
    console.log(`    8-sample mean is ${sb(half, 2).toFixed(3)}, which is what swapping it in would buy.`);
  }
}
console.log('\n  NOTE THE LIMIT: only units where the probe stored per-sample arrays are usable, so');
console.log('  this is a subset, not the library. The swap itself would use blockMean/blurMean, which');
console.log('  are present on all 1048 units.');
console.log('');
