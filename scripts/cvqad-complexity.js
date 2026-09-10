#!/usr/bin/env node
/* MEASURE OUR OWN COMPLEXITY ON THE CVQAD SEQUENCES — the one missing input for task 100.
 *
 * WHY THIS EXISTS. The exponent fit regresses log t_j = a*log c_j + k, where t_j is a perceptual
 * threshold bitrate (from CVQAD's human labels) and c_j is CONTENT COMPLEXITY. The labels are on disk.
 * c_j is not, and it must be OUR complexity — the same CRF-20 probe the library uses — or the fitted
 * `a` is somebody else's exponent, not the one BPP+ ships.
 *
 * THE RECIPE IS COPIED FROM THE LIVE PROBE AND MUST NOT DRIFT (controller/lib/probe.js):
 *     x265, CRF 20, preset medium, scaled to reference width 1920, 3 threads of 4
 *     complexity = (bitrate / (W * H * fps)) * X265_EFFICIENCY,  X265_EFFICIENCY = 1.6
 * A different CRF or preset produces a number that is not comparable to cxEff and silently poisons
 * the regression, so the constants are restated here rather than imported across a container boundary.
 *
 * ONE DELIBERATE DIFFERENCE, AND IT IS AN IMPROVEMENT. The live probe SAMPLES 8 x 4s because a feature
 * film is two hours long and scene complexity varies 8.2x within one title. CVQAD clips are 10-15
 * SECONDS. So the whole clip is encoded, which removes sampling noise entirely rather than estimating
 * around it. That makes these complexity values BETTER pinned than any library film's, not worse.
 *
 * *** THE PROXY PROBLEM, AND WHY THIS SCRIPT MEASURES IT RATHER THAN ASSUMING IT AWAY. *** Complexity
 * should be measured on the PRISTINE source. What is on disk is mostly COMPRESSED rungs; the 43 GT
 * (pristine) references are downloading separately. A compressed clip understates complexity, and it
 * understates it MOST for high-motion, grainy content — i.e. the bias runs along the very axis being
 * fitted, which steers `a` systematically rather than noisily. Measured: renderKbps varies 1.05x-5.05x
 * WITHIN a sequence, worst in basketball (5.05x) and football (4.95x), tight in wedding-party (1.05x).
 * SO: this script probes the TOP-BITRATE rung available per sequence AND, when the GT arrives, the GT
 * too. Both are stored. The comparison of the two is the exclude-flagged test — if `a` fitted on
 * proxies matches `a` fitted on GT, the proxy is adequate and the remaining GT downloads are optional.
 * If they differ by more than `a`'s own SE, only GT values may be used.
 *
 * RESUMABLE: writes after every clip and skips anything already measured. Kill and restart freely.
 * THERMAL: this is ONE HEAVY JOB. Do not run a second alongside it (two measured 93C against 100C).
 * READ-ONLY on the corpus; writes only its own JSON.
 * USAGE: node scripts/cvqad-complexity.js [--out data/cvqad-complexity.json]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const OUT = val('--out', 'data/cvqad-complexity.json');
const CLIPS = '/data/research/cvqad/clips';
const FF = `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`;
const FP = FF.replace(/ffmpeg$/, 'ffprobe');

/* MUST MATCH controller/lib/probe.js — see header */
const PROBE_CRF = 20;
const PROBE_PRESET = 'medium';
const PROBE_WIDTH = 1920;
const PROBE_THREADS = 3;
const X265_EFFICIENCY = 1.6;

const probeMeta = (f) => {
  const o = execFileSync(FP, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate', '-show_entries', 'format=duration',
    '-of', 'default=nw=1', f], { encoding: 'utf8', timeout: 60000 });
  const g = (k) => { const m = new RegExp(`${k}=([^\\n]+)`).exec(o); return m ? m[1].trim() : null; };
  const fr = (g('r_frame_rate') || '0/1').split('/');
  return { w: +g('width'), h: +g('height'), fps: (+fr[0]) / (+fr[1] || 1), dur: +g('duration') };
};

/* Encode the whole clip at the library's probe settings and return its bitrate in bits/s. */
function renderKbps(f, meta) {
  const tmp = path.join('/tmp', `cxprobe-${process.pid}.mkv`);
  try { fs.unlinkSync(tmp); } catch { /* */ }
  const vf = meta.w === PROBE_WIDTH ? [] : ['-vf', `scale=${PROBE_WIDTH}:-2:flags=bicubic`];
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', f, '-an', '-sn',
    ...vf, '-c:v', 'libx265', '-preset', PROBE_PRESET, '-crf', String(PROBE_CRF),
    '-x265-params', `log-level=none:frame-threads=${PROBE_THREADS}`, '-y', tmp],
  { encoding: 'utf8', timeout: 45 * 60000 });
  if (r.status !== 0) { try { fs.unlinkSync(tmp); } catch { /* */ } return null; }
  let out = null;
  try {
    const st = fs.statSync(tmp);
    const m = probeMeta(tmp);
    out = { bits: (st.size * 8) / (m.dur || meta.dur), w: m.w, h: m.h, fps: m.fps || meta.fps };
  } catch { /* */ }
  try { fs.unlinkSync(tmp); } catch { /* */ }
  return out;
}

const done = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')).units || {}; } catch { return {}; } })();

/* one entry per sequence: the top-bitrate compressed rung, and the GT if it has arrived */
const files = fs.readdirSync(CLIPS).filter((f) => f.endsWith('.mp4'));
const bySeq = new Map();
for (const f of files) {
  const seq = f.split('__')[0];
  if (!bySeq.has(seq)) bySeq.set(seq, { gt: null, rungs: [] });
  if (/__GT\.mp4$/.test(f)) bySeq.get(seq).gt = f;
  else {
    const m = /_(\d+)\.mp4$/.exec(f);
    bySeq.get(seq).rungs.push({ f, kbps: m ? +m[1] : 0 });
  }
}
const jobs = [];
for (const [seq, v] of bySeq) {
  v.rungs.sort((a, b) => b.kbps - a.kbps);
  if (v.rungs[0]) jobs.push({ seq, kind: 'proxy', file: v.rungs[0].f, tag: v.rungs[0].kbps });
  if (v.gt) jobs.push({ seq, kind: 'gt', file: v.gt, tag: 'GT' });
}
const todo = jobs.filter((j) => !done[`${j.seq}::${j.kind}`]);
console.log(`${bySeq.size} sequences; ${jobs.length} clips to measure (${todo.length} remaining), `
  + `x265 CRF ${PROBE_CRF} preset ${PROBE_PRESET} @${PROBE_WIDTH}w\n`);

(async () => {
  let n = 0;
  for (const j of todo) {
    n += 1;
    const full = path.join(CLIPS, j.file);
    let meta;
    try { meta = probeMeta(full); } catch { console.log(`  SKIP ${j.file} — unreadable`); continue; }
    if (!(meta.w > 0 && meta.fps > 0)) { console.log(`  SKIP ${j.file} — no video stream`); continue; }
    const t0 = Date.now();
    const r = renderKbps(full, meta);
    if (!r) { console.log(`  FAIL ${j.file}`); continue; }
    const cx = +((r.bits / (r.w * r.h * r.fps)) * X265_EFFICIENCY).toFixed(5);
    done[`${j.seq}::${j.kind}`] = { seq: j.seq, kind: j.kind, file: j.file, tag: j.tag,
      srcW: meta.w, srcH: meta.h, fps: r.fps, dur: meta.dur, renderBits: Math.round(r.bits), cx };
    fs.writeFileSync(OUT, JSON.stringify({ generated: Date.now(), crf: PROBE_CRF,
      preset: PROBE_PRESET, width: PROBE_WIDTH, x265Efficiency: X265_EFFICIENCY, units: done }, null, 1));
    console.log(`  ${n}/${todo.length} ${j.seq.padEnd(24)} ${String(j.tag).padStart(5)}  `
      + `cx ${cx.toFixed(5)}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  console.log(`\nwrote ${OUT} — ${Object.keys(done).length} measurements`);
})();
