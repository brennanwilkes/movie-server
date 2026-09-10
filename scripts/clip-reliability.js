#!/usr/bin/env node
/* HOW MANY CLIPS DOES A DETECTOR READING NEED? — measuring reliability against sampling effort.
 *
 * THE QUESTION, AND WHY IT IS NOW THE MOST IMPORTANT ONE. 11.41 measured cambi's per-read noise at
 * sd(log) = 1.68, so the 4-clip mean the whole library was built on carries SE 0.84 against a residual
 * spread of only ~1.3 — about 42% of cambi's residual variance is scene-sampling noise. That single
 * fact explains the low split-half reliability, the small provenance fraction, the heavy shrinkage,
 * and therefore why every effect in this project has been modest.
 *
 * If that is right, MORE CLIPS IS THE ONLY LEVER THAT MAKES THE EXISTING SIGNAL BIGGER rather than
 * reinterpreting it. Before spending ~46 hours re-measuring 1048 units, the payoff curve should be
 * measured: what does reliability actually buy per clip, and where does it flatten?
 *
 * ── WHY THIS DESIGN AND NOT THE OBVIOUS ONE ─────────────────────────────────────────────────────
 * The first attempt re-ran artifact-backfill.js at 12 clips and compared against the 4-clip run. It
 * was killed after 4 units, for TWO reasons worth recording:
 *   1. TOO SLOW — 12.5 min/unit, because the stratified order put Bluray Remuxes first and decode
 *      cost scales with source bitrate. 300 units would have taken 60+ hours.
 *   2. IT COULD NOT ANSWER THE QUESTION ANYWAY. artifact-backfill.js averages its clips and DISCARDS
 *      the per-clip values, so a 12-clip run yields one number per unit. Comparing it to the 4-clip
 *      run gives a single noisy contrast, not a curve.
 *
 * THIS DESIGN IS WITHIN-UNIT, which is both cheaper and strictly more informative. Store every clip.
 * Then form TWO DISJOINT k-clip means from the same unit and correlate them across units: that IS the
 * reliability of a k-clip measurement, measured directly rather than modelled. Sweeping k gives the
 * whole payoff curve from one run, and Spearman-Brown projects it to any clip count without measuring
 * that count.
 *
 * WHAT WOULD FALSIFY THE 11.41 STORY: if reliability is already flat by k=4, then extra clips buy
 * nothing, the residual spread is NOT sampling-noise-dominated, and the small effects have some other
 * cause that must be found. That is a real possible outcome and it would be more useful than
 * confirmation.
 *
 * SAMPLING IS DETERMINISTIC AND UNSTRATIFIED. A seeded even stride across the library keeps the
 * source mix representative without front-loading Remuxes; stratifying by source label is what made
 * the first attempt start on the largest files in the library.
 *
 * READ-ONLY on media. Writes incrementally, so a partial run is still usable.
 * USAGE: node scripts/clip-reliability.js [--films 60] [--clips 12]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', 'http://localhost:8088');
const N = Number(val('--films', 60));
const CLIPS = Number(val('--clips', 12));
const SECLEN = Number(val('--seclen', 2));
const OUT = val('--out', `${__dirname}/../data/clip-reliability.json`);
const FF = `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`;
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clipr-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const sh = (b, a) => execFileSync(b, a, { encoding: 'utf8', timeout: 30 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/* Identical recipe to artifact-backfill.js — same filters, same window, same libvmaf call — so the
 * reliability measured here is the reliability of the numbers actually in the library. */
function measure(file, t) {
  const log = path.join(TMP, 'c.csv');
  try { fs.unlinkSync(log); } catch { /* */ }
  const p = spawnSync(FF, ['-hide_banner', '-loglevel', 'info', '-ss', String(t), '-t', String(SECLEN),
    '-i', file, '-ss', String(t), '-t', String(SECLEN), '-i', file, '-lavfi',
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
  const g = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-t', String(SECLEN),
    '-i', file, '-an', '-sn', '-vf',
    'split[a][b];[a]hqdn3d=4:3:6:4[d];[b][d]blend=all_mode=difference,signalstats,'
    + 'metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8', timeout: 30 * 60000 });
  const gv = String(g.stdout || '').split('\n').map((l) => /YAVG=([\d.]+)/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  return { cambi, block: grab(/block mean: ([0-9.]+)/), blur: grab(/blur mean: ([0-9.]+)/),
    grain: gv.length > 2 ? mean(gv.slice(1)) : null };
}

(async () => {
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  const pool = ds.rows.filter((r) => r.path && r.bpp > 0 && r.cxEff > 0)
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));   // deterministic order
  const picks = [];
  for (let i = 0; i < N && i < pool.length; i += 1) picks.push(pool[Math.floor((pool.length * i) / N)]);

  let done = {};
  try { done = JSON.parse(fs.readFileSync(OUT, 'utf8')).units || {}; } catch { /* first run */ }
  const todo = picks.filter((r) => !done[r.key]);
  console.log(`${todo.length} units to measure, ${CLIPS} clips each, storing EVERY clip\n`);

  let n = 0;
  const t0 = Date.now();
  for (const r of todo) {
    const dur = Math.floor(Number(sh(FP, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0);
    if (!dur) continue;
    const start = Math.floor(dur * 0.08); const span = Math.floor(dur * 0.84);
    const clips = [];
    for (let k = 0; k < CLIPS; k += 1) {
      let m = null;
      try { m = measure(r.path, start + Math.floor((span * k) / CLIPS)); } catch { /* */ }
      if (m) clips.push(m);
    }
    if (clips.length < 6) continue;      // need enough to split in half
    done[r.key] = { title: r.title, source: r.source, codec: r.codec, bpp: r.bpp,
      cxEff: r.cxEff, bppPlus: r.bppPlus, clips };
    fs.writeFileSync(OUT, JSON.stringify({ generated: Date.now(), seclen: SECLEN, units: done }, null, 1));
    n += 1;
    const cv = clips.map((c) => c.cambi).filter((x) => x != null);
    const rate = (Date.now() - t0) / 60000 / n;
    console.log(`  [${n}/${todo.length}] ${r.title.slice(0, 30).padEnd(32)} ${String(r.source).padEnd(14)} `
      + `cambi ${mean(cv).toFixed(3).padStart(8)}  spread ${Math.min(...cv).toFixed(2)}..${Math.max(...cv).toFixed(2)}`
      + `   ${rate.toFixed(1)} min/unit`);
  }
  console.log(`\nwrote ${OUT}`);
  console.log('Analyse with: node scripts/clip-reliability-analyse.mjs');
})();
