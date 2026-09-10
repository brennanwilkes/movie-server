/* PRE-FLIGHT FOR THE VMAF EXPONENT RUN — one question, and it decides whether the 4-hour run happens.
 *
 * *** THE CIRCULARITY THAT MAKES THIS NECESSARY. *** cxEff IS "bitrate at CRF 20 per pixel x 1.6".
 * The exponent experiment asks how the bitrate needed for FIXED QUALITY scales with cx. If CRF 20
 * already delivered constant quality across contents, then "bitrate at fixed quality" and "bitrate at
 * fixed CRF" would be the same number, cx would equal t, and a = 1 WOULD FALL OUT BY CONSTRUCTION
 * with r2 near 1. A precise, high-r2 answer would then be a tautology wearing a confidence interval.
 *
 * SO THE INFORMATIVENESS OF THE WHOLE EXPERIMENT IS A MEASURABLE QUANTITY: how much does VMAF vary
 * across contents at fixed CRF 20? That variation IS the signal the exponent is fitted from. Measure
 * it on 8 clips before spending the box on 41.
 *
 * *** PRE-REGISTERED DECISION RULE, WRITTEN BEFORE THE NUMBERS. ***
 *   sd(VMAF @ CRF20) >= 3.0 points   GO. There is real cross-content quality drift at fixed CRF, so
 *                                    the exponent is identified by something other than arithmetic.
 *   1.5 - 3.0                        GO, BUT the run must report a alongside this sd, because the
 *                                    estimate is only as informative as the drift it is fitted from.
 *   < 1.5                            NO-GO. CRF is holding quality nearly constant, a = 1 is close to
 *                                    definitional in our coordinates, and the 4-hour run would buy a
 *                                    tight CI around a foregone conclusion. That would itself be a
 *                                    RESULT worth writing down — it would mean the shipped a = 1 is
 *                                    correct BY THE DEFINITION OF OUR OWN DENOMINATOR — but it does
 *                                    not need 41 clips to establish.
 *
 * SECOND QUESTION, FREE ONCE THE ENCODES EXIST: does VMAF at fixed CRF fall with complexity? That is
 * open question 9.4 measured directly on pristine masters rather than inferred from CVQAD's MOS.
 * REGISTERED EXPECTATION: negative. And note the tension this must resolve — a negative slope implies
 * complex content needs bits BEYOND its CRF-20 allocation, i.e. a > 1, while every CVQAD fit returned
 * a < 1. Those cannot both be right, and this measurement is the cleanest arbiter available.
 *
 * WHY PRISTINE GT CLIPS AND NOT LIBRARY FILMS. A library file is an already-compressed delivery, so
 * VMAF against it measures GENERATION LOSS, not absolute quality: a damaged file has less detail left
 * to lose and scores better, while also probing LOWER complexity. The bias would run along the fitted
 * axis — the identical shape 9.0i measured for compressed-rung proxies (B = 0.757). The GT clips are
 * true masters and their cx is already measured with the same probe.
 *
 * BOTH VMAF MODELS. vmaf_v0.6.1 rewards sharpening/enhancement; vmaf_v0.6.1neg removes that gain. For
 * "how many bits does this content need" NEG is arguably the honest one. If the two disagree, that is
 * a finding about the instrument and must be reported, not averaged away.
 *
 * READ-ONLY on the corpus; writes temp encodes into /tmp and deletes them.
 * ONE HEAVY JOB. USAGE: node scripts/vmaf-preflight.mjs [--n 8]
 */
import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const CLIPS = '/data/research/cvqad/clips';
const FF = 'tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg';
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const OUT = 'data/vmaf-preflight.json';
const CRF = 20; const PRESET = 'medium'; const WIDTH = 1920;
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const N = Number(arg('--n', 8));

const cx = JSON.parse(fs.readFileSync('data/cvqad-complexity.json', 'utf8')).units;
const gt = Object.values(cx).filter((u) => u.kind === 'gt' && u.cx > 0)
  .sort((a, b) => a.cx - b.cx);
if (gt.length < N) { console.log(`only ${gt.length} GT measured — need ${N}`); process.exit(1); }
/* spread the sample EVENLY over the complexity range rather than taking the first N, so the
 * pre-flight sees the same range the real run will fit on */
const pick = [];
for (let i = 0; i < N; i += 1) pick.push(gt[Math.round((i * (gt.length - 1)) / (N - 1))]);

const done = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')).units || {}; } catch { return {}; } })();

function vmaf(ref, dis, model) {
  const log = `/tmp/vmaf-${process.pid}.json`;
  const f = `libvmaf=model=version=${model}:log_path=${log}:log_fmt=json:n_threads=3`;
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', dis, '-i', ref,
    '-lavfi', `[0:v]setpts=PTS-STARTPTS[d];[1:v]setpts=PTS-STARTPTS[r];[d][r]${f}`,
    '-f', 'null', '-'], { encoding: 'utf8', timeout: 30 * 60000 });
  if (r.status !== 0) { try { fs.unlinkSync(log); } catch { /* */ } return null; }
  let v = null;
  try { v = JSON.parse(fs.readFileSync(log, 'utf8')).pooled_metrics.vmaf.mean; } catch { /* */ }
  try { fs.unlinkSync(log); } catch { /* */ }
  return v;
}

console.log(`\n  ${N} clips spread evenly over cx ${pick[0].cx.toFixed(4)} - ${pick[N - 1].cx.toFixed(3)}`);
console.log(`  encoding each at CRF ${CRF} preset ${PRESET} @${WIDTH}w, then VMAF vs its own master\n`);

for (const u of pick) {
  if (done[u.seq]) { console.log(`  skip ${u.seq} (done)`); continue; }
  const src = path.join(CLIPS, u.file);
  if (!fs.existsSync(src)) { console.log(`  MISSING ${u.file}`); continue; }
  const meta = (() => {
    const o = execFileSync(FP, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=width,height', '-of', 'default=nw=1', src], { encoding: 'utf8' });
    const g = (k) => { const m = new RegExp(`${k}=([^\\n]+)`).exec(o); return m ? +m[1] : 0; };
    return { w: g('width'), h: g('height') };
  })();
  /* the REFERENCE must be the same geometry as the encode, or VMAF is scoring a rescale */
  const ref = `/tmp/vref-${process.pid}.mkv`;
  const enc = `/tmp/venc-${process.pid}.mkv`;
  const vf = meta.w === WIDTH ? [] : ['-vf', `scale=${WIDTH}:-2:flags=bicubic`];
  const t0 = Date.now();
  let r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', src, '-an', '-sn', ...vf,
    '-c:v', 'ffv1', '-y', ref], { encoding: 'utf8', timeout: 30 * 60000 });
  if (r.status !== 0) { console.log(`  FAIL ref ${u.seq}`); continue; }
  r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', ref, '-an', '-sn',
    '-c:v', 'libx265', '-preset', PRESET, '-crf', String(CRF),
    '-x265-params', 'log-level=none:frame-threads=3', '-y', enc], { encoding: 'utf8', timeout: 30 * 60000 });
  if (r.status !== 0) { console.log(`  FAIL enc ${u.seq}`); fs.unlinkSync(ref); continue; }
  const std = vmaf(ref, enc, 'vmaf_v0.6.1');
  const neg = vmaf(ref, enc, 'vmaf_v0.6.1neg');
  const bits = (fs.statSync(enc).size * 8) / (u.dur || 10);
  for (const f of [ref, enc]) { try { fs.unlinkSync(f); } catch { /* */ } }
  done[u.seq] = { seq: u.seq, cx: u.cx, vmaf: std, vmafNeg: neg, encBits: Math.round(bits) };
  fs.writeFileSync(OUT, JSON.stringify({ crf: CRF, preset: PRESET, width: WIDTH, units: done }, null, 1));
  console.log(`  ${u.seq.padEnd(24)} cx ${u.cx.toFixed(4)}  VMAF ${std == null ? 'FAIL' : std.toFixed(2)}`
    + `  NEG ${neg == null ? 'FAIL' : neg.toFixed(2)}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

/* ---- the decision ---------------------------------------------------------------------- */
const U = Object.values(done).filter((u) => u.vmaf != null);
if (U.length < 4) { console.log('\n  too few results to decide\n'); process.exit(0); }
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const V = U.map((u) => u.vmaf); const NG = U.map((u) => u.vmafNeg).filter((x) => x != null);
console.log(`\n  VMAF AT FIXED CRF ${CRF}, ACROSS ${U.length} CONTENTS\n`);
console.log(`    standard  mean ${mean(V).toFixed(2)}  sd ${sd(V).toFixed(2)}  range ${Math.min(...V).toFixed(2)} - ${Math.max(...V).toFixed(2)}`);
if (NG.length > 2) console.log(`    NEG       mean ${mean(NG).toFixed(2)}  sd ${sd(NG).toFixed(2)}  range ${Math.min(...NG).toFixed(2)} - ${Math.max(...NG).toFixed(2)}`);

/* 9.4, measured directly: does quality at fixed CRF fall with complexity? */
const lx = U.map((u) => Math.log(u.cx)); const my = mean(V); const mx = mean(lx);
let sxy = 0; let sxx = 0;
for (let i = 0; i < U.length; i += 1) { sxy += (lx[i] - mx) * (V[i] - my); sxx += (lx[i] - mx) ** 2; }
const b = sxy / sxx;
let ss = 0;
for (let i = 0; i < U.length; i += 1) ss += (V[i] - (my + b * (lx[i] - mx))) ** 2;
const seB = Math.sqrt((ss / (U.length - 2)) / sxx);
console.log(`\n  OPEN QUESTION 9.4, MEASURED ON PRISTINE MASTERS\n`);
console.log(`    dVMAF / dlog(cx) at fixed CRF = ${b.toFixed(3)} +- ${seB.toFixed(3)}   t ${(b / seB).toFixed(2)}`);
console.log(`    registered expectation: NEGATIVE. ${Math.abs(b / seB) < 2 ? 'NOT RESOLVED at this n.' : (b < 0 ? 'CONFIRMED — and it implies a > 1, which CONTRADICTS every CVQAD fit.' : 'POSITIVE — the opposite of the expectation.')}`);

console.log('\n  DECISION AGAINST THE PRE-REGISTERED RULE\n');
const s = sd(V);
if (s >= 3.0) console.log(`    sd ${s.toFixed(2)} >= 3.0  ->  *** GO. *** Real cross-content quality drift exists at fixed CRF,\n    so the exponent is identified by something other than the definition of cxEff.`);
else if (s >= 1.5) console.log(`    sd ${s.toFixed(2)} in [1.5, 3.0)  ->  GO, BUT the full run must quote this sd beside the exponent.`);
else {
  console.log(`    sd ${s.toFixed(2)} < 1.5  ->  *** NO-GO, AND THAT IS ITSELF THE RESULT. ***`);
  console.log('    CRF holds quality nearly constant across contents, so in OUR coordinates —');
  console.log('    where cxEff IS the CRF-20 bitrate — a = 1 is close to definitional. The shipped');
  console.log('    exponent would be correct by construction rather than by luck, and no 41-clip');
  console.log('    run is needed to say so.');
}
console.log('');
