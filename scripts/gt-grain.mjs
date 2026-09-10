/* TASK 107 — GRAIN ON THE 41 PRISTINE MASTERS, AND A PRE-REGISTERED RULE FOR CLOSING IT EITHER WAY.
 *
 * WHY. 9.0q's grain stratification failed because the grain variable had almost no range: the proxy
 * (each sequence's TOP-BITRATE RUNG) spans only 0.84 to 1.19, a factor of 1.4 end to end. SE on the
 * continuous grain interaction was 0.828, i.e. 0.549 in exponent units — LARGER than the whole
 * disputed bracket. The test could not have seen a grain effect if one existed, so its null was not
 * evidence. The obvious suspect is the proxy: at high bitrate every content retains grain similarly.
 *
 * *** BUT THE PROXY MAY NOT BE THE PROBLEM, AND THE DOCS SAID SO FIRST. *** cvqad-calibrate.js,
 * written long before any of this, records: "EXPECT IT TO BE WEAK, and say so before looking. CVQAD
 * is 1080p UGC and broadcast, not photochemical film scans, so its grain dynamic range is probably
 * too narrow... A null here does not clear grain; it just means this corpus cannot answer."
 * So there are two live hypotheses and they have different consequences:
 *     (a) the PROXY compressed the range -> measuring masters fixes it, the grain leg reopens
 *     (b) the CORPUS has no grain range -> measuring masters changes nothing, and task 107 should
 *         CLOSE as "this corpus cannot answer" instead of being retried with a third variable
 *
 * *** PRE-REGISTERED DECISION RULE, WRITTEN BEFORE THE MEASUREMENT. ***
 *   GT grain range >= 2.0x   hypothesis (a). The proxy was the problem. Re-run the continuous grain
 *                            interaction in vmaf-mos-analyse.mjs against real source grain, and
 *                            report SE(phi1) in exponent units beside it so an underpowered null
 *                            cannot again be mistaken for a null.
 *   GT grain range < 2.0x    hypothesis (b). CLOSE task 107 and the CVQAD grain leg of task 73.
 *                            The corpus cannot answer, the pre-2026 note was right, and no further
 *                            grain work should be attempted on CVQAD. Grain needs a corpus with
 *                            photochemical scans in it.
 * Stating the closing condition in advance is the point: without it, a narrow range invites a fourth
 * variable and a fifth, which is how a dead end consumes a week.
 *
 * RECIPE IS COPIED EXACTLY FROM cvqad-calibrate.js so the numbers are comparable to measured.json:
 *     split -> hqdn3d=4:3:6:4 -> blend difference -> signalstats YAVG, frame 1 dropped
 * GEOMETRY: masters are scaled to width 1920 first, matching cxEff and the VMAF work (trap 26).
 * READ-ONLY, no encoding. Resumable. USAGE: node scripts/gt-grain.mjs
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const CLIPS = '/data/research/cvqad/clips';
const FF = 'tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg';
const OUT = 'data/gt-grain.json';
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

const cx = JSON.parse(fs.readFileSync('data/cvqad-complexity.json', 'utf8')).units;
const gt = Object.values(cx).filter((u) => u.kind === 'gt' && u.cx > 0);
const done = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')).units || {}; } catch { return {}; } })();
const todo = gt.filter((u) => !done[u.seq]);
console.log(`\n  ${gt.length} pristine masters; ${todo.length} to measure`);
console.log('  recipe copied from cvqad-calibrate.js; scaled to width 1920 (trap 26)\n');

for (const u of todo) {
  const f = path.join(CLIPS, u.file);
  if (!fs.existsSync(f)) { console.log(`  MISSING ${u.file}`); continue; }
  const t0 = Date.now();
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', f, '-an', '-sn', '-vf',
    'scale=1920:-2:flags=bicubic,split[a][b];[a]hqdn3d=4:3:6:4[d];[b][d]blend=all_mode=difference,'
      + 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-f', 'null', '-'], { encoding: 'utf8', timeout: 20 * 60000 });
  const gv = String(r.stdout || '').split('\n')
    .map((l) => /YAVG=([\d.]+)/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  const use = gv.length > 2 ? gv.slice(1) : gv;   /* hqdn3d has no temporal history on frame 1 */
  if (!use.length) { console.log(`  FAIL ${u.seq}`); continue; }
  const grain = +mean(use).toFixed(5);
  done[u.seq] = { seq: u.seq, cx: u.cx, grain, frames: use.length };
  fs.writeFileSync(OUT, JSON.stringify({ recipe: 'hqdn3d 4:3:6:4 difference YAVG @1920w', units: done }, null, 1));
  console.log(`  ${u.seq.padEnd(24)} cx ${u.cx.toFixed(4)}  grain ${grain.toFixed(4)}`
    + `  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

const U = Object.values(done);
if (U.length < 10) { console.log('\n  too few to decide\n'); process.exit(0); }
const g = U.map((x) => x.grain).sort((a, b) => a - b);
const range = g[g.length - 1] / g[0];
const proxyRange = 1.19 / 0.84;
console.log(`\n  GRAIN ON PRISTINE MASTERS, n=${U.length}\n`);
console.log(`    min ${g[0].toFixed(4)}   median ${g[Math.floor(g.length / 2)].toFixed(4)}   max ${g[g.length - 1].toFixed(4)}`);
console.log(`    RANGE ${range.toFixed(2)}x        (the top-rung PROXY spanned ${proxyRange.toFixed(2)}x)`);
console.log('\n  VERDICT AGAINST THE PRE-REGISTRATION\n');
if (range >= 2.0) {
  console.log(`    *** ${range.toFixed(2)}x >= 2.0x — HYPOTHESIS (a). The proxy was the problem. ***`);
  console.log('    Re-run the continuous grain interaction against these values, and report');
  console.log('    SE(phi1) in exponent units beside it. The grain leg of task 73 REOPENS.');
} else {
  console.log(`    *** ${range.toFixed(2)}x < 2.0x — HYPOTHESIS (b). THE CORPUS, NOT THE PROXY. ***`);
  console.log('    cvqad-calibrate.js predicted this before any of the 2026-08 work: CVQAD is');
  console.log('    1080p UGC and broadcast, not photochemical film scans. Measuring the masters');
  console.log('    changes nothing because the grain is not there to measure.');
  console.log('    CLOSE task 107 and the CVQAD grain leg of task 73. Do NOT try a third grain');
  console.log('    variable on this corpus — a dead end with no stated closing condition is how');
  console.log('    a week disappears. Grain needs a corpus containing photochemical scans.');
}
console.log('');
