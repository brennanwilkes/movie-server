#!/usr/bin/env node
/* THE CROSSED DENOISE LADDER — the bitrate cost of a preprocessing step, measured the same way.
 *
 * WHY THIS EXISTS (11.45). The shipped rule converts P into bitrate through the GENERATION rate:
 *     lambda = ln(1 + 33.1%) / dPdGen
 * That assumes a film's P is generation-like. But P turns out to be 2.42x MORE sensitive to a denoise
 * step than to a generation (0.335 vs 0.139 P-sd, sign agreement 9/10), and THE BITRATE COST OF A
 * DENOISE STEP HAS NEVER BEEN MEASURED — the crossed generation ladder varied generations only. So a
 * preprocessing-dominated film is currently scaled by a rate measured on a different axis, and the
 * direction of that error is unknown.
 *
 * THE DESIGN IS THE SAME ONE THAT WORKED, deliberately. anchor-crossed.js measured both legs on the
 * SAME CLIPS so no transfer assumption could operate, and it is the only calibration in this project
 * that survived its controls. Here:
 *     LEG A  four bitrates, NO denoising        -> dP / d(log bpp)   on this content
 *     LEG B  three denoise levels, ONE bitrate  -> dP / d(denoise step) on this content
 *     denoise anchor = exp( (dP/dstep) / |dP/dlogbpp| ) - 1
 * Leg A's 1.0x rung and leg B's "none" row are THE SAME ENCODE, which pins both legs to a common
 * point so any per-film offset cancels in the ratio.
 *
 * THE STATISTIC IS THE RATIO OF MEDIAN SLOPES, not the median of per-film ratios. The generation run
 * showed exactly why: one film's leg-A slope came out at -0.055 and its per-film ratio exploded to
 * 368%, dragging the mean to 76% with sd 119. Pooling first and dividing once is 11.35's lesson.
 *
 * DENOISE LEVELS match scripts/denoise-test.js so the two experiments are comparable:
 *     none / hqdn3d=2:1:3:2 (light) / hqdn3d=6:4:9:6 (heavy)
 * Applied BEFORE the encode, which is what a release group doing this would do.
 *
 * WHAT WOULD MAKE THE RESULT UNUSABLE, decided before running: leg A's slope not clearly negative on
 * most films, or leg B's step not clearly positive. Either means P is not tracking damage on this
 * content and the ratio is noise over noise. Both are checked per film and failures are EXCLUDED, not
 * averaged in.
 *
 * READ-ONLY on media. THERMAL: 3 encode threads, one film at a time.
 * USAGE: node scripts/denoise-crossed.js [--films 8] [--clips 3]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', 'http://localhost:8088');
const N = Number(val('--films', 8));
const CLIPS = Number(val('--clips', 3));
const THREADS = val('--threads', '3');
const OUT = val('--out', `${__dirname}/../data/denoise-crossed.json`);
/* tools/ffmpeg-* is a SECOND ffmpeg, built for libvmaf/blockdetect which the host's 4.2 lacks. It is
 * for measurement only and must never be used for the controller's complexity probe. */
const FF = `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`;
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const sh = (b, a) => execFileSync(b, a, { encoding: 'utf8', timeout: 30 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/* Bitrate rungs for leg A. Kept modest in span (2x total) rather than the ladders' 8.3x, because the
 * exchange rate only needs a LOCAL slope around the operating point, and a wide sweep would drag in
 * the saturation region where banding reverses (11.x: Knocked Up 5.475 @0.85x -> 4.989 @0.30x). */
const LEVELS = [1.4, 1.0, 0.7, 0.5];
/* Matches scripts/denoise-test.js exactly, so the two experiments measure the same axis. step 0 is
 * no filter, which is also leg A's 1.0x rung. */
const DENOISE = [
  { step: 0, name: 'none', vf: null },
  { step: 1, name: 'light', vf: 'hqdn3d=2:1:3:2' },
  { step: 2, name: 'heavy', vf: 'hqdn3d=6:4:9:6' },
];

function measure(clip) {
  const log = path.join(TMP, 'c.csv');
  try { fs.unlinkSync(log); } catch { /* */ }
  const p = spawnSync(FF, ['-hide_banner', '-loglevel', 'info', '-i', clip, '-i', clip, '-lavfi',
    `[0:v]blockdetect,blurdetect[d];[d][1:v]libvmaf=feature=name=cambi:n_threads=2:log_path=${log}:log_fmt=csv`,
    '-f', 'null', '-'], { encoding: 'utf8', timeout: 30 * 60000 });
  if (p.status !== 0) return null;
  const e = String(p.stderr || '');
  const grab = (re) => { const m = e.match(re); return m ? Number(m[1]) : null; };
  let cambi = null;
  try {
    const L = fs.readFileSync(log, 'utf8').trim().split('\n');
    const c = L[0].split(',').indexOf('cambi');
    const v = L.slice(1).map((x) => Number(x.split(',')[c])).filter(Number.isFinite);
    cambi = v.length ? mean(v) : null;
  } catch { /* */ }
  /* Grain as the hqdn3d residual. Frame 1 is dropped because the denoiser has no history yet and its
   * residual is systematically wrong — the same correction banding-ladder.js carries. */
  const g = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', clip, '-an', '-sn', '-vf',
    'split[a][b];[a]hqdn3d=4:3:6:4[d];[b][d]blend=all_mode=difference,signalstats,'
    + 'metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8', timeout: 30 * 60000 });
  const gv = String(g.stdout || '').split('\n').map((l) => /YAVG=([\d.]+)/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  return { cambi, block: grab(/block mean: ([0-9.]+)/), blur: grab(/blur mean: ([0-9.]+)/),
    grain: gv.length > 2 ? mean(gv.slice(1)) : null };
}

const enc = (src, dst, kbps, vf) => spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', src,
  ...(vf ? ['-vf', vf] : []),
  '-c:v', 'libx264', '-preset', 'medium', '-b:v', `${kbps}k`, '-threads', THREADS,
  '-an', '-sn', '-y', dst], { encoding: 'utf8', timeout: 30 * 60000 }).status === 0;

const avg = (acc) => {
  const o = {};
  for (const k of ['cambi', 'block', 'blur', 'grain']) {
    const v = acc.map((x) => x[k]).filter((x) => x != null && x > 0);
    o[k] = v.length ? mean(v) : null;
  }
  return o;
};

(async () => {
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  const pool = ds.rows.filter((r) => r.path && r.cxEff > 0 && r.bpp > 0).sort((a, b) => a.cxEff - b.cxEff);
  /* Spread across the complexity range rather than sampling at random, so a null cannot be blamed on
   * having drawn only smooth films or only grainy ones. */
  const picks = [];
  for (let i = 0; i < N; i += 1) picks.push(pool[Math.floor(((pool.length - 1) * i) / (N - 1))]);

  const out = { generated: Date.now(), levels: LEVELS, denoise: DENOISE.map((d) => d.name), clips: CLIPS, films: [] };
  for (const r of picks) {
    const dur = Math.floor(Number(sh(FP, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0);
    if (!dur) continue;
    const st = Math.floor(dur * 0.15); const sp = Math.floor(dur * 0.7);
    const srcs = [];
    for (let k = 0; k < CLIPS; k += 1) {
      const s = path.join(TMP, `s${k}.mkv`);
      const p = spawnSync(FF, ['-hide_banner', '-loglevel', 'error',
        '-ss', String(st + Math.floor((sp * k) / CLIPS)), '-t', '2', '-i', r.path,
        '-c:v', 'ffv1', '-an', '-sn', '-y', s], { encoding: 'utf8', timeout: 30 * 60000 });
      if (p.status === 0) srcs.push(s);
    }
    if (!srcs.length) continue;

    // 0.6x the film's own rate, as in every other experiment here: at its native rate a competent
    // encode shows nothing and every detector reads its floor.
    const base = Math.round(((r.bpp * r.probeW * r.probeH * (r.fps || 24)) / 1000) * 0.6) || 2000;
    console.log(`\n${r.title}   cx ${r.cxEff.toFixed(3)}   base ${base} kbps`);

    // ---- LEG A: bitrate, one generation ----
    console.log(`  LEG A  bitrate at 1 generation`);
    console.log(`  ${'level'.padEnd(10)} ${'cambi'.padStart(9)} ${'block'.padStart(9)} ${'blur'.padStart(9)} ${'grain'.padStart(9)}`);
    const legA = [];
    for (const lv of LEVELS) {
      const kbps = Math.max(50, Math.round(base * lv));
      const acc = [];
      for (let k = 0; k < srcs.length; k += 1) {
        const o = path.join(TMP, `a${k}.mkv`);
        if (!enc(srcs[k], o, kbps, null)) continue;
        const m = measure(o); if (m) acc.push(m);
      }
      if (!acc.length) continue;
      const row = { level: lv, kbps, ...avg(acc) };
      legA.push(row);
      console.log(`  ${String(lv).padEnd(10)} ` + ['cambi', 'block', 'blur', 'grain']
        .map((k) => (row[k] == null ? '  n/a' : row[k].toFixed(4)).padStart(9)).join(' '));
    }

    // ---- LEG B: denoise level, all at the base bitrate ----
    // step 0 IS leg A's 1.0x rung by construction; it is re-measured rather than reused so any
    // per-run drift shows up as a discrepancy instead of being hidden.
    console.log(`  LEG B  denoise at ${base} kbps`);
    console.log(`  ${'level'.padEnd(10)} ${'cambi'.padStart(9)} ${'block'.padStart(9)} ${'blur'.padStart(9)} ${'grain'.padStart(9)}`);
    const legB = [];
    for (const d of DENOISE) {
      const acc = [];
      for (let k = 0; k < srcs.length; k += 1) {
        const o = path.join(TMP, `b${k}_${d.step}.mkv`);
        if (!enc(srcs[k], o, base, d.vf)) continue;
        const m = measure(o); if (m) acc.push(m);
      }
      if (!acc.length) continue;
      const row = { step: d.step, name: d.name, ...avg(acc) };
      legB.push(row);
      console.log(`  ${d.name.padEnd(10)} ` + ['cambi', 'block', 'blur', 'grain']
        .map((k) => (row[k] == null ? '  n/a' : row[k].toFixed(4)).padStart(9)).join(' '));
    }

    out.films.push({ key: r.key, title: r.title, cxEff: r.cxEff, bpp: r.bpp, bppPlus: r.bppPlus,
      baseKbps: base, legA, legB });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  }
  console.log(`\nwrote ${OUT}`);
  console.log('Analyse with: node scripts/denoise-crossed-analyse.mjs');
})();
