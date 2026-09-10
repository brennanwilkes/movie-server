#!/usr/bin/env node
/* IS THE gen0->gen1 STEP A GENERATION, OR A RATE-CONTROL DOWNGRADE WEARING ONE'S CLOTHES?
 *
 * THE PROBLEM THIS EXISTS TO SETTLE. anchor-e2e measured both legs on identical clips, both direction
 * checks passed 24/24, and the answer came out at
 *     anchor = exp(B/A) - 1 = 210%      against a published BD-rate bound of 5-40%
 * That is 5.3x outside an external bound, so something in the construction is wrong rather than the
 * world being surprising. 11.39 already refused a 69.7% version of this number; 210% is worse.
 *
 * THE SUSPECT, and it is specific. gen0 is a segment of a file that was encoded AS PART OF A WHOLE
 * FILM, with 2-pass rate control and full lookahead — and the encoder fingerprint scan measured that
 * 721 of 803 library files are rc=2pass, so this is the normal case, not an edge one. gen1 is a
 * TWO-SECOND CLIP encoded with 1-pass ABR and forced to hit the FILM'S AVERAGE bitrate, on a segment
 * whose own complexity may sit well above or below that average. So the gen0->gen1 contrast is
 *     one generation  +  2-pass -> 1-pass  +  film-average bits imposed on a specific segment
 * and only the first of those is a generation. Leg A compares clip encodes against clip encodes at
 * 0.7x/1.0x/1.4x, so every one of those nuisances CANCELS there. The contamination lands entirely in
 * B, and B/A is the anchor. That is exactly the asymmetry needed to inflate it.
 *
 * THE TEST. Measure the NEXT step, gen1 -> gen2, where both sides are 2-second clip encodes produced
 * by the identical recipe at the identical bitrate. Every nuisance above is present in both and
 * cancels. What remains is a pure generation.
 *
 * *** PRE-REGISTERED, AND THE TWO OUTCOMES SEPARATE CLEANLY. *** 11.49 measured generation loss
 * saturating at 0.62 per step (8/8 films). So if gen0->gen1 were a clean generation, the next step
 * should land at
 *     0.62 * 0.4886 = 0.303
 *   B2 near 0.30    the step is clean, saturation explains the ladder disagreement, and the 210%
 *                   anchor stands as a real measurement that the published bound must accommodate.
 *   B2 well below   gen0->gen1 is contaminated by encoding conditions, the anchor derived from it is
 *   0.15            inflated, and the honest anchor is exp((B2/0.62)/A)-1 instead.
 *   B2 above 0.45   saturation is wrong and something else is going on; do not patch, re-think.
 * The 0.62 saturation constant is itself only 8 films and is flagged, not trusted blindly.
 *
 * WHY THIS IS THE RIGHT NEXT JOB. The anchor sets lambda, lambda scales every shipped adjustment, and
 * the project has now produced FOUR different values for it (5-40% published, 35.6% crossed ladder,
 * 113% mixed-population, 210% same-clip). They cannot all be right and the differences are not noise.
 *
 * READ-ONLY on media. Encodes into a temp dir it removes on exit.
 * THERMAL: 3 encode threads, strictly one film at a time. Two heavy jobs measured 93C against 100C.
 * USAGE: node scripts/generation-step2.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', 'http://localhost:8088');
const THREADS = val('--threads', '3');
const E2E = `${__dirname}/../data/end-to-end-generation.json`;
const OUT = val('--out', `${__dirname}/../data/generation-step2.json`);
const FF = `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`;
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gen2-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const sh = (b, a) => execFileSync(b, a, { encoding: 'utf8', timeout: 30 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/* Identical to artifact-backfill.js / end-to-end-generation.js. Must not drift: the whole design
 * depends on every generation being read by the same instrument. */
function measure(file, t, seclen) {
  const log = path.join(TMP, 'c.csv');
  try { fs.unlinkSync(log); } catch { /* */ }
  const ss = t == null ? [] : ['-ss', String(t), '-t', String(seclen)];
  const p = spawnSync(FF, ['-hide_banner', '-loglevel', 'info', ...ss, '-i', file, ...ss, '-i', file,
    '-lavfi', `[0:v]blockdetect,blurdetect[d];[d][1:v]libvmaf=feature=name=cambi:n_threads=2:log_path=${log}:log_fmt=csv`,
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
  const g = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', ...ss, '-i', file, '-an', '-sn', '-vf',
    'split[a][b];[a]hqdn3d=4:3:6:4[d];[b][d]blend=all_mode=difference,signalstats,'
    + 'metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8', timeout: 30 * 60000 });
  const gv = String(g.stdout || '').split('\n').map((l) => /YAVG=([\d.]+)/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  return { cambi, block: grab(/block mean: ([0-9.]+)/), blur: grab(/blur mean: ([0-9.]+)/),
    grain: gv.length > 2 ? mean(gv.slice(1)) : null };
}
const avg = (acc) => {
  const o = {};
  for (const k of ['cambi', 'block', 'blur', 'grain']) {
    const v = acc.map((x) => x[k]).filter((x) => x != null && x > 0);
    o[k] = v.length ? mean(v) : null;
  }
  return o;
};

(async () => {
  const e2e = JSON.parse(fs.readFileSync(E2E, 'utf8'));
  const CLIPS = e2e.clips || 4;
  const SECLEN = 2;
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  const byKey = new Map(ds.rows.map((r) => [r.key, r]));

  let done = {};
  try { done = JSON.parse(fs.readFileSync(OUT, 'utf8')).units || {}; } catch { /* first run */ }
  const todo = Object.entries(e2e.units).filter(([k]) => !done[k] && byKey.has(k));
  console.log(`${todo.length} units, ${CLIPS} clips each, gen1 -> gen2 (both clip encodes, identical recipe)\n`);

  for (const [key, u] of todo) {
    const r = byKey.get(key);
    if (!r?.path) continue;
    const dur = Math.floor(Number(sh(FP, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0);
    if (!dur) continue;
    /* THE SAME POSITIONS the other two scripts use. */
    const start = Math.floor(dur * 0.1); const span = Math.floor(dur * 0.8);
    const pos = [];
    for (let k = 0; k < CLIPS; k += 1) pos.push(start + Math.floor((span * k) / CLIPS));

    const acc = { gen1: [], gen2: [] };
    for (const t of pos) {
      const src = path.join(TMP, 'c.mkv');
      if (spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-t', String(SECLEN),
        '-i', r.path, '-c:v', 'ffv1', '-an', '-sn', '-y', src], { timeout: 30 * 60000 }).status !== 0) continue;
      /* gen1: exactly what end-to-end-generation.js produced */
      const g1 = path.join(TMP, 'g1.mkv');
      if (spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', src, '-c:v', 'libx264',
        '-preset', 'medium', '-b:v', `${u.kbps}k`, '-threads', THREADS, '-an', '-sn', '-y', g1],
      { timeout: 30 * 60000 }).status !== 0) continue;
      const m1 = measure(g1, null, SECLEN);
      if (!m1) continue;
      /* gen2: the SAME recipe applied to gen1. Every encoding-condition nuisance is now on both
       * sides and cancels; what is left is one generation and nothing else. */
      const g1raw = path.join(TMP, 'g1raw.mkv');
      if (spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', g1, '-c:v', 'ffv1',
        '-an', '-sn', '-y', g1raw], { timeout: 30 * 60000 }).status !== 0) continue;
      const g2 = path.join(TMP, 'g2.mkv');
      if (spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', g1raw, '-c:v', 'libx264',
        '-preset', 'medium', '-b:v', `${u.kbps}k`, '-threads', THREADS, '-an', '-sn', '-y', g2],
      { timeout: 30 * 60000 }).status !== 0) continue;
      const m2 = measure(g2, null, SECLEN);
      if (!m2) continue;
      acc.gen1.push(m1); acc.gen2.push(m2);
    }
    if (acc.gen1.length < 2 || acc.gen2.length < 2) continue;
    done[key] = { title: u.title, bpp: u.bpp, cxEff: u.cxEff, codec: u.codec, kbps: u.kbps,
      gen1: avg(acc.gen1), gen2: avg(acc.gen2) };
    fs.writeFileSync(OUT, JSON.stringify({ generated: Date.now(), clips: CLIPS, units: done }, null, 1));
    const d = done[key];
    console.log(`  ${Object.keys(done).length}/${Object.keys(e2e.units).length} ${u.title.slice(0, 30).padEnd(32)} `
      + `cambi ${d.gen1.cambi.toFixed(3)} -> ${d.gen2.cambi.toFixed(3)}`);
  }
  console.log(`\nwrote ${OUT}`);
  console.log('Analyse with: node scripts/generation-step2-analyse.mjs');
})();
