/* IS VMAF's AGREEMENT WITH CRF A FACT ABOUT PERCEPTION, OR ABOUT CO-TUNING? — the one test that
 * decides whether the VMAF route can settle the exponent.
 *
 * *** THE CONFOUND, STATED PLAINLY. *** The pre-flight found that VMAF at fixed CRF 20 barely drifts
 * along complexity (-0.198 +- 0.798 VMAF per log-unit), which implies a = 1.012 +- 0.049 and would
 * rule out the low end of the 0.47-0.94 bracket outright. But x265 and VMAF may simply AGREE WITH
 * EACH OTHER BY CONSTRUCTION. x265's adaptive quantisation and psy-rd allocate bits on perceptual
 * grounds that overlap with VMAF's own features, and encoders are routinely tuned against exactly
 * these metrics. If so, "CRF holds VMAF constant" is a statement about metric-encoder alignment, not
 * about human vision — and a ~ 1 would be an artifact of that alignment.
 *
 * HUMANS ARE NOT CO-TUNED WITH x265. CVQAD's MOS labels are the control, and the corpus makes the
 * comparison unusually clean: the SAME compressed rungs that carry MOS labels are on disk, and their
 * pristine GT masters are too. So VMAF and MOS can be computed on IDENTICAL ENCODES and compared
 * directly, with no transfer, no re-encoding, and no matching assumption.
 *
 * THE QUESTION IN ONE LINE: does VMAF systematically over-score COMPLEX content relative to what
 * humans said about those very files?
 *     MOS = alpha + beta*VMAF + phi*log(cx) + group FE + codec FE
 * phi is the test. If phi = 0, VMAF already carries whatever complexity does to human opinion, and
 * the VMAF route is trustworthy for the exponent. If phi < 0, VMAF FLATTERS complex content — which
 * is the documented direction for grain and detail — and a_VMAF is biased UP toward 1.
 *
 * *** AND phi CONVERTS DIRECTLY INTO AN EXPONENT CORRECTION. *** a_true = a_VMAF + phi/gamma_MOS,
 * where gamma_MOS = dMOS/dlog(bitrate) is already measured at 1.5088 +- 0.0353 (9.0l). So this does
 * not merely flag a bias, it PRICES it in the units of the disputed parameter.
 *
 * *** PRE-REGISTERED, BEFORE THE NUMBERS. ***
 *   |phi| < 1 SE                 VMAF is unbiased along complexity here. The VMAF route stands and
 *                                the exponent question closes near a = 1.
 *   phi < 0, significant         VMAF flatters complex content. Correct a_VMAF by phi/gamma_MOS and
 *                                report the corrected value; the bracket narrows but does not close.
 *   phi > 0, significant         VMAF PENALISES complex content, which would push a_true ABOVE 1 and
 *                                contradict both the literature prior and every CVQAD fit. Treat as
 *                                a red flag on the whole VMAF route rather than as a result.
 * SECONDARY, and it is the grain leg #73 has been waiting for: split by measured grain and report
 * phi separately. VMAF's documented weakness is grain, so if the bias is real it should concentrate
 * there.
 *
 * COST NOTE: no encoding at all. Every file already exists — this only runs VMAF of each on-disk
 * compressed rung against its own GT master. Resumable, writes after every clip.
 * READ-ONLY on the corpus. USAGE: node scripts/vmaf-vs-mos.mjs [--limit 0]
 */
import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const CLIPS = '/data/research/cvqad/clips';
const FF = 'tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg';
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const OUT = 'data/vmaf-rungs.json';
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = Number(arg('--limit', 0));

const cx = JSON.parse(fs.readFileSync('data/cvqad-complexity.json', 'utf8')).units;
const GT = new Map();
for (const u of Object.values(cx)) if (u.kind === 'gt') GT.set(u.seq, u);

const files = fs.readdirSync(CLIPS).filter((f) => f.endsWith('.mp4') && !/__GT\.mp4$/.test(f));
const jobs = [];
for (const f of files) {
  const seq = f.split('__')[0];
  const g = GT.get(seq);
  if (!g) continue;                          /* no master measured -> cannot reference */
  jobs.push({ seq, file: f, gt: g.file, cx: g.cx });
}
const done = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')).units || {}; } catch { return {}; } })();
let todo = jobs.filter((j) => !done[j.file]);
if (LIMIT > 0) todo = todo.slice(0, LIMIT);
console.log(`\n  ${jobs.length} rungs have a measured GT master; ${todo.length} left to score\n`);

const dims = (f) => {
  const o = execFileSync(FP, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height', '-of', 'default=nw=1', f], { encoding: 'utf8' });
  const g = (k) => { const m = new RegExp(`${k}=([^\\n]+)`).exec(o); return m ? +m[1] : 0; };
  return { w: g('width'), h: g('height') };
};

/* *** BOTH SIDES ARE NORMALISED TO WIDTH 1920, AND THAT IS A CORRECTNESS REQUIREMENT, NOT A
 * SPEEDUP. *** Three reasons, found the hard way after an initial version compared at native
 * geometry and produced numbers that were quietly in the wrong coordinate system:
 *   1. cxEff IS MEASURED AT WIDTH 1920 (cvqad-complexity.js scales to the probe reference). An
 *      exponent relates t to cx, so t must live in the same geometry cx does or the two axes are
 *      not commensurable.
 *   2. CVQAD's sources are MIXED RESOLUTION — 1920x1080, 3840x1620, 2048x1152, 1440x1080 all
 *      appear. Comparing at native geometry would make the exponent partly a resolution effect.
 *   3. vmaf_v0.6.1 IS TRAINED FOR 1080p viewed at 3H. At 3840x1620 it is outside its regime.
 * MEASURED COST OF GETTING THIS WRONG: bike-show-2023 at 6000k scored 91.52 at native 4K and
 * 97.794 at 1920 — a 6.3 point gap, LARGER THAN THE ENTIRE 6.86-POINT CROSS-CONTENT SPREAD the
 * exponent argument rests on. Geometry is not a detail here, it is the measurement.
 * The GT/rung aspect ratios were checked and match 10/10, so no letterbox correction is needed. */
function vmaf(ref, dis, model) {
  const log = `/tmp/vmafr-${process.pid}.json`;
  const lav = `[0:v]scale=1920:-2:flags=bicubic,setpts=PTS-STARTPTS[d];[1:v]setpts=PTS-STARTPTS[r];`
    + `[d][r]libvmaf=model=version=${model}:log_path=${log}:log_fmt=json:n_threads=4`;
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', dis, '-i', ref,
    '-lavfi', lav, '-f', 'null', '-'], { encoding: 'utf8', timeout: 30 * 60000 });
  if (r.status !== 0) { try { fs.unlinkSync(log); } catch { /* */ } return null; }
  let v = null;
  try { v = JSON.parse(fs.readFileSync(log, 'utf8')).pooled_metrics.vmaf.mean; } catch { /* */ }
  try { fs.unlinkSync(log); } catch { /* */ }
  return v;
}

/* *** NEVER TOUCH THE REFERENCE UNLESS GEOMETRY FORCES IT. *** The masters run up to 430 Mbps 4K
 * HEVC and were being re-decoded once per rung, so an ffv1 intermediate was introduced to decode
 * each one only once. FFV1 is lossless and the intermediate was verified to carry identical
 * pix_fmt/range/dimensions — and yet basketball-2021 at 100k moved 11.78 -> 11.01 across the
 * change, on a sequence where the rescale is a NO-OP. An unexplained shift in the reference path
 * is not acceptable in the one signal the exponent is read from, and the shift would be a
 * PER-SEQUENCE OFFSET correlated with source resolution — exactly the shape that biases a
 * cross-sequence slope.
 * So: sequences already at width 1920 are compared against the ORIGINAL master with no
 * intermediate at all. An intermediate is built only where a rescale was going to happen anyway,
 * which is also where the decode saving is largest (the 4K masters). Cause of the 0.77 shift is
 * NOT diagnosed — it is avoided, and that distinction is recorded rather than glossed. */
function makeRef(gtPath, tag, srcW) {
  if (srcW === 1920) return { path: gtPath, temp: false };
  const out = `/tmp/vref-${process.pid}-${tag}.mkv`;
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', gtPath, '-an', '-sn',
    '-vf', 'scale=1920:-2:flags=bicubic', '-c:v', 'ffv1', '-level', '3', '-threads', '4',
    '-y', out], { encoding: 'utf8', timeout: 30 * 60000 });
  return r.status === 0 ? { path: out, temp: true } : null;
}

/* process SEQUENCE BY SEQUENCE so the scaled reference is built once and reused */
const bySeq = new Map();
for (const j of todo) {
  if (!bySeq.has(j.seq)) bySeq.set(j.seq, []);
  bySeq.get(j.seq).push(j);
}
let n = 0;
for (const [seq, list] of bySeq) {
  const gtPath = path.join(CLIPS, list[0].gt);
  if (!fs.existsSync(gtPath)) { console.log(`  MISSING master for ${seq}`); continue; }
  const t0 = Date.now();
  let src;
  try { src = dims(gtPath); } catch { console.log(`  SKIP ${seq} — unreadable master`); continue; }
  const refInfo = makeRef(gtPath, seq.replace(/[^a-z0-9]/gi, ''), src.w);
  if (!refInfo) { console.log(`  FAIL building reference for ${seq}`); continue; }
  const ref = refInfo.path;
  console.log(`  [${seq}] ${src.w}x${src.h} — ${refInfo.temp
    ? `rescaled reference built (${((Date.now() - t0) / 1000).toFixed(0)}s)`
    : 'ORIGINAL master used, no intermediate'}, ${list.length} rungs`);
  for (const j of list) {
    n += 1;
    const dis = path.join(CLIPS, j.file);
    if (!fs.existsSync(dis)) { console.log(`    MISSING ${j.file}`); continue; }
    const t1 = Date.now();
    const std = vmaf(ref, dis, 'vmaf_v0.6.1');
    if (std == null) { console.log(`    FAIL ${j.file}`); continue; }
    const neg = vmaf(ref, dis, 'vmaf_v0.6.1neg');
    done[j.file] = { seq: j.seq, file: j.file, cx: j.cx, srcW: src.w, srcH: src.h, vmaf: std, vmafNeg: neg };
    fs.writeFileSync(OUT, JSON.stringify({ generated: 'vmaf-vs-mos', geometry: 'both scaled to width 1920', units: done }, null, 1));
    console.log(`    ${n}/${todo.length} ${j.file.slice(0, 44).padEnd(44)} VMAF ${std.toFixed(2).padStart(6)}`
      + `  NEG ${neg == null ? '  n/a' : neg.toFixed(2).padStart(6)}  (${((Date.now() - t1) / 1000).toFixed(0)}s)`);
  }
  if (refInfo.temp) { try { fs.unlinkSync(ref); } catch { /* */ } }
}
console.log(`\nwrote ${OUT} — ${Object.keys(done).length} rungs scored\n`);
