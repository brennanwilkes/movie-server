#!/usr/bin/env node
/* Is a VERSION bump safe? Two questions, and they have different answers.
 *
 * WHY THIS EXISTS. artifacts.js claims its ffmpeg passes are "copied EXACTLY from
 * scripts/artifact-backfill.js so the numbers are comparable with the 1048 units already measured
 * there". The CHAINS are. The SAMPLING GRID IS NOT, and nothing said so:
 *
 *     backfill   start = floor(dur*0.10), span = floor(dur*0.80)  ->  10%  30%  50%  70%
 *     live job   start = dur*0.05,        span = dur*0.90         ->   5% 27.5% 50% 72.5%
 *
 * Only the 50% clip is shared. Three of every four clips come from different parts of the film,
 * and clip-to-clip spread is enormous — All the President's Men reads cambi [0.013, 2.914, 0.059,
 * 0.166] across four clips, an 18x range within one title. The two paths are not measuring the
 * same thing, and 1045 of 1048 cached entries came from the backfill grid.
 *
 * That is the whole risk in a VERSION bump. P is standardised across the library, so re-measuring
 * it over several nights means standardising across a MIXTURE of two grids, and every film's score
 * drifts for reasons unrelated to its file until the sweep finishes.
 *
 * SO THIS SCRIPT RUNS BOTH GRIDS ON THE SAME FILE and separates the two effects:
 *
 *   LEG A  backfill grid, current chain, vs the imported number.
 *          Isolates the PIPELINE. Must match to ~2% on cambi/block/blur — those three are
 *          bit-depth invariant (verified 2026-08-31: forcing yuv420p moves them by exactly 0 on
 *          both an 8-bit and a 10-bit clip), so the format fix cannot explain any drift here.
 *          A failure means the two code paths genuinely differ and the comment is wrong twice.
 *
 *   LEG B  live grid vs backfill grid, same chain, same file.
 *          Isolates the GRID. This is the real size of the mid-sweep drift, and it is a
 *          measurement, not a guess. Small -> bump VERSION and let it sweep. Large -> re-measure
 *          on the BACKFILL grid, or accept a known drift window, or sweep in one sitting.
 *
 * GRAIN IS EXPECTED TO DIFFER ON 10-BIT FILES and only there: the chain now pins yuv420p, so a
 * 10-bit unit should read ~4.012x LOWER than its imported value. That is the fix landing, not a
 * failure, and the script scores it separately. The default sample is all 8-bit so that leg A
 * tests the pipeline without that confound.
 *
 * Run inside the controller (needs /data and /tools):
 *   docker exec controller node /app/scripts/artifact-validate.js
 *   docker exec controller node /app/scripts/artifact-validate.js tv:100:1 mv:45
 *
 * NO LEASE IS TAKEN. Do not run it while a probe session is live — the box throttles at 100C and
 * two concurrent measurements have been recorded at 93C.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const FFMPEG = process.env.ARTIFACT_FFMPEG
  || '/tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg';
const FFPROBE = FFMPEG.replace(/ffmpeg$/, 'ffprobe');
const BACKFILL = process.env.ARTIFACT_BACKFILL || '/app/data/artifact-backfill.json';
const PROBE_CACHE = process.env.PROBE_CACHE || '/config/probe-cache.json';
const SAMPLES = 4;
const SECLEN = 2;
const THREADS = 2;
const TOL = 0.02;                 // 2% on a mean of 4 clips from identical frames
const TEN_BIT_RATIO = 1 / 4.012;  // 255/1023 — the expected grain drop once yuv420p is pinned

// Unchanged since the backfill AND 8-bit, so leg A tests the pipeline with nothing else moving.
const DEFAULT_KEYS = ['tv:100:1', 'tv:107:1', 'tv:120:1', 'tv:122:1'];
const DET = ['cambi', 'block', 'blur', 'grain'];
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

// Byte-for-byte the chain in artifacts.js runClip(), including the format=yuv420p that pins the
// grain units. A copy rather than an import on purpose: importing artifacts.js would boot the job.
function runClip(file, t) {
  return new Promise((resolve) => {
    const log = path.join('/tmp', `artval-${process.pid}-${Math.abs(t) | 0}.csv`);
    const a = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'info',
      '-ss', String(t), '-t', String(SECLEN), '-i', file,
      '-ss', String(t), '-t', String(SECLEN), '-i', file,
      '-lavfi', `[0:v]blockdetect,blurdetect[d];[d][1:v]libvmaf=feature=name=cambi:`
        + `n_threads=${THREADS}:log_path=${log}:log_fmt=csv`,
      '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    a.stderr.on('data', (d) => { err += d; });
    a.on('close', () => {
      const grab = (re) => { const m = re.exec(err); return m ? Number(m[1]) : null; };
      let cambi = null;
      try {
        const L = fs.readFileSync(log, 'utf8').trim().split('\n');
        const col = L[0].split(',').indexOf('cambi');
        const v = L.slice(1).map((r) => Number(r.split(',')[col])).filter(Number.isFinite);
        cambi = v.length ? mean(v) : null;
      } catch { /* libvmaf wrote nothing */ }
      try { fs.unlinkSync(log); } catch { /* */ }
      const b = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error',
        '-ss', String(t), '-t', String(SECLEN), '-i', file, '-an', '-sn', '-vf',
        'format=yuv420p,split[a][b];[a]hqdn3d=4:3:6:4[d];[b][d]blend=all_mode=difference,'
          + 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
        '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      b.stdout.on('data', (d) => { out += d; });
      b.on('close', () => {
        const gv = out.split('\n').map((l) => /YAVG=([\d.]+)/.exec(l)).filter(Boolean)
          .map((m) => Number(m[1]));
        const use = gv.length > 2 ? gv.slice(1) : gv;   // hqdn3d has no history on frame 1
        resolve({
          cambi,
          block: grab(/block mean: ([0-9.]+)/),
          blur: grab(/blur mean: ([0-9.]+)/),
          grain: use.length ? mean(use) : null,
        });
      });
      b.on('error', () => resolve({}));
    });
    a.on('error', () => resolve({}));
  });
}

const sh = (bin, args) => new Promise((resolve) => {
  const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let o = '';
  p.stdout.on('data', (d) => { o += d; });
  p.on('close', () => resolve(o.trim()));
  p.on('error', () => resolve(''));
});

// Aggregation copied from the job, x > 0 and all. That the filter drops genuine zeros is a
// separate known defect (banding keeps them, this does not) — do NOT correct it here, or the
// comparison stops being like-for-like with the 1045 imported rows it is checking against.
const agg = (got, d) => {
  const v = got.map((g) => g[d]).filter((x) => Number.isFinite(x) && x > 0);
  return v.length ? mean(v) : null;
};

async function measureGrid(file, dur, kind) {
  // backfill: floor(dur*0.1) + floor(span*k/4) over span floor(dur*0.8)
  // live:     floor(dur*0.05 + dur*0.9*k/4)
  // NOTE the live job takes dur from *arr runtimeSec, not the container. Using the container
  // duration for both isolates the grid; a runtimeSec/container mismatch is a smaller effect
  // stacked on top, and it cannot be reproduced without *arr.
  const got = [];
  for (let k = 0; k < SAMPLES; k += 1) {
    const t = kind === 'backfill'
      ? Math.floor(dur * 0.1) + Math.floor((Math.floor(dur * 0.8) * k) / SAMPLES)
      : Math.floor(dur * 0.05 + (dur * 0.9 * k) / SAMPLES);
    /* eslint-disable no-await-in-loop */
    const m = await runClip(file, t);
    if (m && DET.some((d) => m[d] > 0)) got.push(m);
  }
  return got;
}

async function main() {
  const keys = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_KEYS;
  const back = JSON.parse(fs.readFileSync(BACKFILL, 'utf8')).units;
  const probe = JSON.parse(fs.readFileSync(PROBE_CACHE, 'utf8')).entries;
  let worstPipe = 0;
  const gridDrift = [];

  for (const key of keys) {
    const b = back[key];
    const p = probe[key];
    if (!b) { console.log(`${key}: no backfill row — skipped`); continue; }
    if (!p || !p.measuredFrom) { console.log(`${key}: no probe entry — skipped`); continue; }
    const file = p.measuredFrom.split('|')[0];
    if (!fs.existsSync(file)) { console.log(`${key}: file missing — skipped`); continue; }

    const dur = Math.floor(Number(await sh(FFPROBE, ['-v', 'error', '-show_entries',
      'format=duration', '-of', 'default=nw=1:nk=1', file])) || 0);
    if (!dur) { console.log(`${key}: no duration — skipped`); continue; }
    const fmt = (await sh(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=pix_fmt', '-of', 'default=nk=1:nw=1', file])).split('\n')[0];
    const ten = /10le|10be|p010/.test(fmt);

    const gB = await measureGrid(file, dur, 'backfill');
    const gL = await measureGrid(file, dur, 'live');
    console.log(`\n=== ${b.title}  [${key}]  ${fmt}  ${dur}s`);
    console.log('  det      imported   backfillGrid   liveGrid    A:pipeline   B:grid');
    for (const d of DET) {
      const imp = b[d];
      const nB = agg(gB, d);
      const nL = agg(gL, d);
      // Leg A: the format fix is expected to move grain on a 10-bit file and nothing else.
      const want = (d === 'grain' && ten) ? TEN_BIT_RATIO : 1;
      const a = (imp && nB) ? Math.abs((nB / imp) / want - 1) : null;
      const bDrift = (nB && nL) ? Math.abs(nL / nB - 1) : null;
      if (a != null && !(d === 'grain' && ten)) worstPipe = Math.max(worstPipe, a);
      if (bDrift != null) gridDrift.push(bDrift);
      console.log(`  ${d.padEnd(7)}${String(imp).padStart(11)}`
        + `${(nB == null ? '-' : nB.toFixed(5)).padStart(15)}`
        + `${(nL == null ? '-' : nL.toFixed(5)).padStart(11)}`
        + `${(a == null ? '-' : `${(a * 100).toFixed(1)}%`).padStart(13)}`
        + `${(bDrift == null ? '-' : `${(bDrift * 100).toFixed(1)}%`).padStart(9)}`
        + (a != null && a > TOL && !(d === 'grain' && ten) ? '  <-- PIPELINE DRIFT' : ''));
    }
  }

  const medGrid = gridDrift.length
    ? gridDrift.sort((x, y) => x - y)[Math.floor(gridDrift.length / 2)] : null;
  console.log(`\nLEG A  worst pipeline drift (cambi/block/blur, 8-bit grain): ${(worstPipe * 100).toFixed(2)}%`);
  console.log(worstPipe <= TOL
    ? '       PASS — the live chain reproduces the backfill on identical frames.'
    : '       FAIL — the two code paths are not the same measurement. Fix that before anything else.');
  console.log(`LEG B  median grid-induced drift: ${medGrid == null ? '-' : `${(medGrid * 100).toFixed(1)}%`}`);
  console.log('       This is how far a re-measured unit moves for grid alone. Compare it against');
  console.log('       the detector spreads P is built on before deciding to sweep — if it is large,');
  console.log('       a VERSION bump silently re-scores the library over the nights it runs.');
}

main().catch((e) => { console.error(e); process.exit(1); });
