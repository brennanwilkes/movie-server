#!/usr/bin/env node
/* WHERE DOES A CAMBI READING STOP CARRYING INFORMATION? — measuring the instrument floor.
 *
 * WHY THIS IS SUDDENLY LOAD-BEARING. The full-coverage recheck (11.40) failed a pre-registered
 * structural check. The cause is that P uses log(cambi), and 7.1% of the library reads below 0.05
 * where the log of a near-zero number is dominated by instrument noise:
 *     lowest 25% of cambi readings   mean |z_cambi| 1.196
 *     middle 50%                     mean |z_cambi| 0.494
 * The 266 units added by the backfill are 20% near-floor, so they injected that noise wholesale —
 * inflating P's variance, halving the provenance fraction and diluting the WEB-vs-Bluray gap.
 *
 * THE FIX IS A SOFT OFFSET, log(L + c), which is smooth everywhere and has no kink — it is NOT a
 * cut-off, and that distinction matters because 11.6 removed two hidden cut-offs and a hinge is one.
 * But c has to be MEASURED, not chosen, or it becomes exactly the kind of arbitrary constant that is
 * banned here.
 *
 * WHAT c IS. The level at which repeat measurements of the SAME FILM stop agreeing — below it, the
 * number is telling you about the sampler, not the film. Measured directly: read cambi at many
 * independent positions in one file and look at the spread as a function of the level.
 *     where sd(readings) << level   the reading is real
 *     where sd(readings) ~ level    the reading is noise
 * The crossover is the floor, and it is a property of the detector plus the 2-second sampling window,
 * which is exactly the configuration the library was measured with.
 *
 * DELIBERATELY SPANS THE RANGE. Films are chosen across the cambi distribution rather than only at
 * the bottom, because a floor claimed from low readings alone could not be distinguished from "these
 * particular films are uniform". Seeing sd track level at the bottom and NOT at the top is the
 * discriminating pattern.
 *
 * READ-ONLY on media: decodes, never writes to the library.
 * USAGE: node scripts/cambi-floor.js [--films 12] [--reads 8]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', 'http://localhost:8088');
const N = Number(val('--films', 12));
const READS = Number(val('--reads', 8));
const SECLEN = Number(val('--seclen', 2));
const OUT = val('--out', `${__dirname}/../data/cambi-floor.json`);
const FF = `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`;
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cfloor-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const sh = (b, a) => execFileSync(b, a, { encoding: 'utf8', timeout: 30 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

/* Same recipe as artifact-backfill.js — same filter, same window, same libvmaf invocation — so the
 * floor measured here is the floor of the numbers actually in the library, not of some other setup. */
function cambiAt(file, t) {
  const log = path.join(TMP, 'c.csv');
  try { fs.unlinkSync(log); } catch { /* */ }
  const p = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-t', String(SECLEN),
    '-i', file, '-ss', String(t), '-t', String(SECLEN), '-i', file, '-lavfi',
    `[0:v][1:v]libvmaf=feature=name=cambi:n_threads=2:log_path=${log}:log_fmt=csv`,
    '-f', 'null', '-'], { encoding: 'utf8', timeout: 30 * 60000 });
  if (p.status !== 0) return null;
  try {
    const L = fs.readFileSync(log, 'utf8').trim().split('\n');
    const c = L[0].split(',').indexOf('cambi');
    const v = L.slice(1).map((x) => Number(x.split(',')[c])).filter(Number.isFinite);
    return v.length ? mean(v) : null;
  } catch { return null; }
}

(async () => {
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  const pool = ds.rows.filter((r) => r.path && r.cambi != null && r.cambi >= 0)
    .sort((a, b) => a.cambi - b.cambi);
  if (pool.length < N) { console.error('not enough units'); process.exit(1); }
  /* Even spread across the cambi distribution, so the floor is read from a curve rather than asserted
   * from the bottom of it. */
  const picks = [];
  for (let i = 0; i < N; i += 1) picks.push(pool[Math.floor(((pool.length - 1) * i) / (N - 1))]);

  const out = { generated: Date.now(), reads: READS, seclen: SECLEN, films: [] };
  console.log(`${N} films across the cambi range, ${READS} independent reads each\n`);
  console.log(`${'film'.padEnd(34)} ${'nightly'.padStart(8)} ${'mean'.padStart(8)} ${'sd'.padStart(8)} ${'sd/mean'.padStart(8)}`);
  for (const r of picks) {
    const dur = Math.floor(Number(sh(FP, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0);
    if (!dur) continue;
    const start = Math.floor(dur * 0.08); const span = Math.floor(dur * 0.84);
    const reads = [];
    for (let k = 0; k < READS; k += 1) {
      const v = cambiAt(r.path, start + Math.floor((span * k) / READS));
      if (v != null) reads.push(v);
    }
    if (reads.length < 4) continue;
    const m = mean(reads); const s = sd(reads);
    out.films.push({ key: r.key, title: r.title, nightly: r.cambi, reads, mean: m, sd: s });
    console.log(`${r.title.slice(0, 33).padEnd(34)} ${r.cambi.toFixed(4).padStart(8)} `
      + `${m.toFixed(4).padStart(8)} ${s.toFixed(4).padStart(8)} ${(s / Math.max(m, 1e-9)).toFixed(2).padStart(8)}`);
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  }

  console.log('\nWHERE DOES sd STOP BEING SMALL RELATIVE TO THE LEVEL?\n');
  const f = out.films.filter((x) => x.mean > 0).sort((a, b) => a.mean - b.mean);
  console.log(`${'level band'.padEnd(16)} ${'n'.padStart(3)} ${'med level'.padStart(10)} ${'med sd'.padStart(9)} ${'med sd/level'.padStart(13)}`);
  const t = Math.max(1, Math.floor(f.length / 3));
  for (const [nm, g] of [['low', f.slice(0, t)], ['mid', f.slice(t, 2 * t)], ['high', f.slice(2 * t)]]) {
    if (!g.length) continue;
    console.log(`${nm.padEnd(16)} ${String(g.length).padStart(3)} ${med(g.map((x) => x.mean)).toFixed(4).padStart(10)} `
      + `${med(g.map((x) => x.sd)).toFixed(4).padStart(9)} ${med(g.map((x) => x.sd / x.mean)).toFixed(2).padStart(13)}`);
  }
  /* The floor as a single number: the level at which sd equals the level itself, i.e. sd/level = 1.
   * Read off by interpolating the sd-vs-level relationship rather than by picking a percentile, so it
   * is a measurement rather than a convention. */
  const noisy = f.filter((x) => x.sd / x.mean >= 1);
  const clean = f.filter((x) => x.sd / x.mean < 1);
  console.log(`\n${noisy.length} films read as pure noise (sd >= level), ${clean.length} do not`);
  if (noisy.length && clean.length) {
    const c = Math.sqrt(Math.max(...noisy.map((x) => x.mean)) * Math.min(...clean.map((x) => x.mean)));
    console.log(`crossover sits between ${Math.max(...noisy.map((x) => x.mean)).toFixed(4)} and `
      + `${Math.min(...clean.map((x) => x.mean)).toFixed(4)}  ->  geometric midpoint c = ${c.toFixed(4)}`);
    console.log(`\nUSE log(cambi + ${c.toFixed(4)}) IN THE RESIDUAL MODEL. Smooth everywhere, no kink,`);
    console.log('and c is measured repeatability rather than a chosen constant.');
  } else if (!noisy.length) {
    console.log('No film reads as pure noise — the floor is below the range sampled. Widen the sample.');
  } else {
    console.log('Every film reads as pure noise — sampling window may be too short to be informative.');
  }
  console.log(`\nwrote ${OUT}`);
})();
