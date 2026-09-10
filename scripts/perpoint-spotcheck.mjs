/* THE SPOT-CHECK LIST — per-film detail readings, for a human who knows these films.
 *
 * WHAT IS AND IS NOT BEING CLAIMED. perPoint's 6-clip reliability is 0.945, so the per-film NUMBERS
 * are trustworthy as measurements. What is NOT yet known is the EXCHANGE RATE — how much bitrate a
 * given residual is worth — because converting it uses a within-film slope applied to a cross-film
 * residual, which is the transfer assumption that inflated the anchor 4.6x. So:
 *     THE ORDERING IS CHECKABLE TODAY.   THE ADJUSTMENT IS NOT.
 * This list exists to be falsified by eye. If films Brennan knows to be soft, old, or badly sourced
 * do NOT cluster at the detail-poor end, the instrument is wrong regardless of its reliability.
 *
 * WHAT THE NUMBER MEANS, in plain terms. perPoint = d log(bitrate)/d CRF measures how much
 * DESTRUCTIBLE DETAIL a file still holds: on a detail-rich source, raising the quantiser harvests a
 * large high-frequency tail and the bitrate collapses fast (steep, very negative). On a file whose
 * detail has already been destroyed, that tail is gone and raising the quantiser saves less (flat).
 * The residual is the film's departure from what its own complexity predicts:
 *     residual < 0   STEEPER than expected  ->  detail-RICH for its complexity
 *     residual > 0   FLATTER than expected  ->  detail-POOR for its complexity
 *
 * THE HONEST CAVEAT TO CARRY WHILE READING IT. The residual correlates with height at -0.303, so
 * 720p files will tend to sit at the detail-poor end. That is physically correct — a 720p copy
 * genuinely holds less detail — but it means resolution is doing part of the work, and the list
 * should not be read as "these are badly encoded" when it may partly mean "these are 720p".
 *
 * USAGE: node scripts/perpoint-spotcheck.mjs
 */
import fs from 'fs';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function lin(xs, ys) {
  const mx = mean(xs); const my = mean(ys); const n = xs.length;
  let num = 0; let den = 0;
  for (let i = 0; i < n; i += 1) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const b = num / den; return { b, a: my - b * mx };
}

const raw = JSON.parse(fs.readFileSync('data/perpoint-content-line.json', 'utf8'));
const ds = await (await fetch('http://localhost:8088/api/probe/dataset')).json();
const byKey = new Map(ds.rows.map((r) => [r.key, r]));

const rows = [];
for (const [key, u] of Object.entries(raw.units)) {
  const arm = u.arms[0] ?? u.arms['0'];
  const r = byKey.get(key);
  if (!arm || !(arm.cx20 > 0) || !Number.isFinite(arm.perPoint) || !r) continue;
  rows.push({ t: u.title, pp: arm.perPoint, lcx: Math.log(arm.cx20),
    bppPlus: r.bppPlus, source: (r.source || '').replace(/-1080p|-720p/, ''),
    h: r.probeH, year: r.year });
}
const F = lin(rows.map((x) => x.lcx), rows.map((x) => x.pp));
for (const x of rows) x.resid = x.pp - (F.a + F.b * x.lcx);
rows.sort((a, b) => b.resid - a.resid);

const sd = Math.sqrt(rows.reduce((s, x) => s + x.resid ** 2, 0) / (rows.length - 2));
console.log(`\n  ${rows.length} films.  residual sd ${sd.toFixed(4)}.  perPoint reliability 0.945.`);
console.log('  Sorted DETAIL-POOR first. This ordering is checkable by eye; the adjustment is not.\n');
console.log(`  ${'film'.padEnd(34)} ${'BPP+'.padStart(5)} ${'res'.padStart(7)} ${'sd'.padStart(5)}  ${'h'.padStart(4)}  source`);

const show = (x) => console.log(`  ${x.t.slice(0, 33).padEnd(34)} ${String(x.bppPlus ?? '').padStart(5)} `
  + `${x.resid.toFixed(4).padStart(7)} ${(x.resid / sd).toFixed(1).padStart(5)}  ${String(x.h ?? '').padStart(4)}  ${x.source}`);

console.log('\n  --- DETAIL-POOR for their complexity (flatter perPoint than predicted) ---');
rows.slice(0, 12).forEach(show);
console.log('\n  --- DETAIL-RICH for their complexity (steeper than predicted) ---');
rows.slice(-12).forEach(show);

/* the resolution caveat, quantified rather than asserted */
const by720 = rows.filter((x) => x.h && x.h <= 800);
const by1080 = rows.filter((x) => x.h && x.h > 800);
if (by720.length >= 3 && by1080.length >= 3) {
  console.log(`\n  RESOLUTION CHECK (the residual correlates -0.303 with height, so read this first)`);
  console.log(`    <=800px  n ${String(by720.length).padStart(3)}   mean residual ${mean(by720.map((x) => x.resid)).toFixed(4)}`);
  console.log(`    > 800px  n ${String(by1080.length).padStart(3)}   mean residual ${mean(by1080.map((x) => x.resid)).toFixed(4)}`);
  console.log('    If the gap is large, part of the ordering above is "this is 720p" rather than');
  console.log('    "this is badly encoded". Both are real quality facts, but they are different ones.');
}
console.log('\n  HOW TO FALSIFY THIS BY EYE: if films you know to be soft, old-transfer or badly');
console.log('  sourced do NOT cluster at the detail-poor end, the instrument is wrong whatever its');
console.log('  reliability says. Reliability means it measures SOMETHING consistently; it does not');
console.log('  prove it measures DETAIL.');
console.log('');
