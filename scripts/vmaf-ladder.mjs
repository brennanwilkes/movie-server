/* THE EXPONENT IN BPP+'s OWN COORDINATES — our encoder, our CRF, our geometry, against a pristine
 * master and a full-reference quality metric.
 *
 * WHY THIS AND NOT THE CVQAD RUNGS. The rung run (scripts/vmaf-vs-mos.mjs) uses CVQAD's OWN encodes:
 * fixed-bitrate, seventeen different encoders, none of them ours. That makes it the right CONTROL for
 * the co-tuning question, because it carries human MOS labels — but it does not measure the exponent
 * in the coordinate system BPP+ actually uses. This does: x265, preset medium, width 1920, the same
 * recipe cxEff is probed with, on the same 41 pristine masters whose cxEff is already measured.
 *
 * WHAT IT YIELDS, AND IT IS THREE THINGS THE PRE-FLIGHT COULD ONLY BORROW OR INFER:
 *   1. *** dVMAF/dlog(bitrate), MEASURED. *** 9.0n's a = 1.012 divides by 16.42 VMAF per log-unit,
 *      taken from the jnd-table.js chain that its own header calls "BORROWED, AND THE WEAK LINK".
 *      A ladder measures that slope directly, within sequence, where it is identified without any
 *      cross-content assumption at all.
 *   2. THE THRESHOLD EXPONENT in our coordinates: t_j = bitrate at VMAF 93 per sequence, then
 *      log t_j = log K + a log c_j. Criterion swept (88/93/95) because a threshold is a cut-off and
 *      9.0k measured a cut-off moving the answer.
 *   3. THE DERIVATIVE EXPONENT with no cut-off at all: a = -delta/gamma from
 *      VMAF = alpha + gamma log R + delta log c. VMAF is full-reference, so unlike MOS it needs no
 *      cross-content comparability assumption — which is the confound that killed 9.0l.
 *
 * *** THE REFERENCE IS THE ENCODE'S OWN SOURCE, WHICH REMOVES THE AMBIGUITY THAT BIT US. *** The
 * master is scaled to width 1920 ONCE, that scaled copy is what every rung is encoded FROM, and it is
 * also what every rung is compared TO. So there is no question of which geometry anything lives in
 * (trap 26) and no lossless-intermediate ambiguity (trap 27) — the intermediate IS the reference by
 * construction, not a stand-in for one. FFV1 so the reference is bit-exact.
 *
 * HONEST LIMIT, AND IT IS THE SAME ONE THE WHOLE VMAF ROUTE CARRIES. VMAF is a MODEL of human
 * opinion. This measures the exponent that VMAF implies, and vmaf-vs-mos.mjs is what tests whether
 * VMAF's implication matches what humans actually said about the same content. Neither replaces #93.
 *
 * ONE HEAVY JOB. Resumable, keyed `seq::crf`, writes after every rung.
 * READ-ONLY on the corpus; temp encodes go to /tmp and are deleted.
 * USAGE: node scripts/vmaf-ladder.mjs [--crfs 16,20,24,28,32]
 */
import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const CLIPS = '/data/research/cvqad/clips';
const FF = 'tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg';
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const OUT = 'data/vmaf-ladder.json';
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const CRFS = arg('--crfs', '16,20,24,28,32').split(',').map(Number);
const PRESET = 'medium'; const WIDTH = 1920;

const cx = JSON.parse(fs.readFileSync('data/cvqad-complexity.json', 'utf8')).units;
/* *** PROCESSING ORDER MUST SPREAD THE REGRESSOR, NOT SORT IT. *** The first version processed in
 * ascending cx. That is fine if the run completes and CATASTROPHIC if it does not: a truncated
 * ascending run covers only the least complex sequences, leaving almost no range in log(cx) — and
 * 9.0m measured exactly what happens then, an exponent attenuated toward zero and able to cross it
 * (the `ugc` group returned a = -0.135 on sd(log cx) 0.640). Any partial result would have been
 * worthless in the specific way this project already diagnosed.
 * Bisection order (median, then quartiles, then octiles) makes EVERY PREFIX a spread sample, so an
 * interrupted run still spans the full complexity range and still identifies a slope. */
const spread = (a) => {
  const out = []; const q = [[0, a.length - 1]];
  while (q.length) {
    const [lo, hi] = q.shift();
    if (lo > hi) continue;
    const m = (lo + hi) >> 1;
    out.push(a[m]); q.push([lo, m - 1]); q.push([m + 1, hi]);
  }
  return out;
};
const gt = spread(Object.values(cx).filter((u) => u.kind === 'gt' && u.cx > 0)
  .sort((a, b) => a.cx - b.cx));
const done = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')).units || {}; } catch { return {}; } })();

const meta = (f) => {
  const o = execFileSync(FP, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height', '-show_entries', 'format=duration', '-of', 'default=nw=1', f], { encoding: 'utf8' });
  const g = (k) => { const m = new RegExp(`${k}=([^\\n]+)`).exec(o); return m ? +m[1] : 0; };
  return { w: g('width'), h: g('height'), dur: g('duration') };
};

function vmaf(ref, dis, model) {
  const log = `/tmp/vl-${process.pid}.json`;
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', dis, '-i', ref,
    '-lavfi', `[0:v]setpts=PTS-STARTPTS[d];[1:v]setpts=PTS-STARTPTS[r];[d][r]`
      + `libvmaf=model=version=${model}:log_path=${log}:log_fmt=json:n_threads=4`,
    '-f', 'null', '-'], { encoding: 'utf8', timeout: 30 * 60000 });
  if (r.status !== 0) { try { fs.unlinkSync(log); } catch { /* */ } return null; }
  let v = null;
  try { v = JSON.parse(fs.readFileSync(log, 'utf8')).pooled_metrics.vmaf.mean; } catch { /* */ }
  try { fs.unlinkSync(log); } catch { /* */ }
  return v;
}

const pending = gt.filter((u) => CRFS.some((c) => !done[`${u.seq}::${c}`]));
console.log(`\n  ${gt.length} pristine masters; ${pending.length} with rungs outstanding`);
console.log(`  x265 preset ${PRESET} @${WIDTH}w, CRF ${CRFS.join('/')}, VMAF vs the encode's own source\n`);

for (const u of pending) {
  const src = path.join(CLIPS, u.file);
  if (!fs.existsSync(src)) { console.log(`  MISSING ${u.file}`); continue; }
  let m;
  try { m = meta(src); } catch { console.log(`  SKIP ${u.seq}`); continue; }
  const ref = `/tmp/vlref-${process.pid}.mkv`;
  const t0 = Date.now();
  const vf = m.w === WIDTH ? [] : ['-vf', `scale=${WIDTH}:-2:flags=bicubic`];
  let r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', src, '-an', '-sn', ...vf,
    '-c:v', 'ffv1', '-level', '3', '-threads', '4', '-y', ref], { encoding: 'utf8', timeout: 30 * 60000 });
  if (r.status !== 0) { console.log(`  FAIL ref ${u.seq}`); continue; }
  console.log(`  [${u.seq}] cx ${u.cx.toFixed(4)}  src ${m.w}x${m.h} -> reference at ${WIDTH}w (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  for (const crf of CRFS) {
    const key = `${u.seq}::${crf}`;
    if (done[key]) continue;
    const enc = `/tmp/vlenc-${process.pid}.mkv`;
    const t1 = Date.now();
    r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', ref, '-an', '-sn',
      '-c:v', 'libx265', '-preset', PRESET, '-crf', String(crf),
      '-x265-params', 'log-level=none:frame-threads=3', '-y', enc], { encoding: 'utf8', timeout: 30 * 60000 });
    if (r.status !== 0) { console.log(`    FAIL enc CRF ${crf}`); continue; }
    const bits = (fs.statSync(enc).size * 8) / (m.dur || 10);
    const std = vmaf(ref, enc, 'vmaf_v0.6.1');
    const neg = vmaf(ref, enc, 'vmaf_v0.6.1neg');
    try { fs.unlinkSync(enc); } catch { /* */ }
    if (std == null) { console.log(`    FAIL vmaf CRF ${crf}`); continue; }
    done[key] = { seq: u.seq, cx: u.cx, crf, bits: Math.round(bits), vmaf: std, vmafNeg: neg,
      srcW: m.w, srcH: m.h, dur: m.dur };
    fs.writeFileSync(OUT, JSON.stringify({ preset: PRESET, width: WIDTH, crfs: CRFS, units: done }, null, 1));
    console.log(`    CRF ${String(crf).padStart(2)}  ${(bits / 1000).toFixed(0).padStart(6)} kbps`
      + `  VMAF ${std.toFixed(2).padStart(6)}  NEG ${neg == null ? '  n/a' : neg.toFixed(2).padStart(6)}`
      + `  (${((Date.now() - t1) / 1000).toFixed(0)}s)`);
  }
  try { fs.unlinkSync(ref); } catch { /* */ }
}
console.log(`\nwrote ${OUT} — ${Object.keys(done).length} rungs\n`);
