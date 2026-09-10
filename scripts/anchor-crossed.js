#!/usr/bin/env node
/* THE CROSSED LADDER — the experiment that settles the anchor, the last free constant in the score.
 *
 * THE PROBLEM (11.30). The shipped provenance rule needs one number: how much bitrate a generation is
 * worth. Two answers exist and they disagree by 4.6x:
 *     published BD-rate                 5 - 40%
 *     our ladders, gap / slope          69.7%   (p10-p90 39% - 191%)
 * The measured figure is suspect for a specific reason. It divides a P difference measured ACROSS THE
 * LIBRARY (between WEB and Bluray files) by a P slope measured ON LADDERS (within one film, sweeping
 * bits). Two different populations, two different kinds of variation, joined by an assumption that
 * equal dP means equal damage whatever caused it. That assumption is unvalidated and is the most
 * likely source of the inflation.
 *
 * THE FIX, AND IT IS THE WHOLE POINT OF THIS SCRIPT: measure BOTH LEGS ON THE SAME CLIPS.
 *     LEG A  one generation, four bitrates          -> dP / d(log bpp)   on this content
 *     LEG B  one bitrate, three generation counts   -> dP / d(generation) on this content
 *     anchor = exp( (dP/dgen) / (dP/dlog bpp) ) - 1
 * Same film, same clips, same encoder, same detectors. Nothing is transferred between populations, so
 * the assumption that inflates the library estimate cannot operate here. Whatever this returns IS the
 * exchange rate for our encoder on our content.
 *
 * WHY IT SHARES A RUNG ON PURPOSE. Leg A's 1.0x rung and Leg B's generation-1 row are THE SAME
 * ENCODE, so the two legs are pinned to a common point and any per-film offset cancels in the ratio.
 * That is also why the ratio is the right statistic and the individual slopes are not.
 *
 * WHAT WOULD MAKE THE RESULT UNUSABLE, decided before running:
 *   - Leg A's slope not clearly negative on most films (fewer bits must make P worse), or
 *   - Leg B's step not clearly positive on most films (more generations must make P worse).
 *   Either would mean P is not tracking damage on this content and the ratio is meaningless. Both
 *   directions are checked and reported per film, not just in aggregate.
 *
 * READ-ONLY on media. Encodes 2s clips in a temp dir it removes on exit.
 * THERMAL: 3 encode threads, strictly one film at a time. Two heavy jobs measured 93C against a
 * 100C limit on this box, and the controller runs its own probes on a schedule.
 *
 * USAGE: node scripts/anchor-crossed.js [--films 8] [--clips 3]
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
const OUT = val('--out', `${__dirname}/../data/anchor-crossed.json`);
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
const GENS = [1, 2, 3];

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

const enc = (src, dst, kbps) => spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', src,
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

  const out = { generated: Date.now(), levels: LEVELS, gens: GENS, clips: CLIPS, films: [] };
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
        if (!enc(srcs[k], o, kbps)) continue;
        const m = measure(o); if (m) acc.push(m);
      }
      if (!acc.length) continue;
      const row = { level: lv, kbps, ...avg(acc) };
      legA.push(row);
      console.log(`  ${String(lv).padEnd(10)} ` + ['cambi', 'block', 'blur', 'grain']
        .map((k) => (row[k] == null ? '  n/a' : row[k].toFixed(4)).padStart(9)).join(' '));
    }

    // ---- LEG B: generations, all at the base bitrate ----
    // gen 1 IS leg A's 1.0x rung by construction; it is re-measured rather than reused so that any
    // per-run drift in the measurement shows up as a discrepancy instead of being hidden.
    console.log(`  LEG B  generations at ${base} kbps`);
    console.log(`  ${'gens'.padEnd(10)} ${'cambi'.padStart(9)} ${'block'.padStart(9)} ${'blur'.padStart(9)} ${'grain'.padStart(9)}`);
    const legB = [];
    for (const gen of GENS) {
      const acc = [];
      for (let k = 0; k < srcs.length; k += 1) {
        let cur = srcs[k];
        let ok = true;
        for (let g = 0; g < gen; g += 1) {
          const o = path.join(TMP, `b${k}_${g}.mkv`);
          if (!enc(cur, o, base)) { ok = false; break; }
          cur = o;
        }
        if (!ok) continue;
        const m = measure(cur); if (m) acc.push(m);
      }
      if (!acc.length) continue;
      const row = { gen, ...avg(acc) };
      legB.push(row);
      console.log(`  ${String(gen).padEnd(10)} ` + ['cambi', 'block', 'blur', 'grain']
        .map((k) => (row[k] == null ? '  n/a' : row[k].toFixed(4)).padStart(9)).join(' '));
    }

    out.films.push({ key: r.key, title: r.title, cxEff: r.cxEff, bpp: r.bpp, bppPlus: r.bppPlus,
      baseKbps: base, legA, legB });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  }
  console.log(`\nwrote ${OUT}`);
  console.log('Analyse with: node scripts/anchor-crossed-analyse.mjs');
})();
