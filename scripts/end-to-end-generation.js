#!/usr/bin/env node
/* THE TEST NOTHING IN THIS PROJECT HAS EVER RUN: the SHIPPED rule, end to end, on known ground truth.
 *
 * WHY IT IS THE DECISIVE ONE. Four provenance axes are validated (encoder 19/20, generations 10/10,
 * preprocessing 9/10, bits) — but every one of those was measured with a HAND-ROLLED per-rung
 * composite that skips the residual surface, the standardisation, the shrinkage and lambda entirely.
 * THEY VALIDATE DETECTORS, NOT THE RULE. Between the detectors and the score sit four more steps, and
 * the transfer from "ladder-clip response" to "field between-film residual" has been open and
 * explicitly unvalidated since 11.18 and has never been closed.
 *
 * THE DESIGN. Take N library units. For each, extract the clips the backfill would sample, at the
 * SAME positions, and re-encode each at the film's own bitrate — exactly one extra generation, at
 * matched bits, matched content, matched codec. Then push BOTH copies through the PRODUCTION PATH:
 * the library-fitted surface, the shipped standardisation, the shipped direction, the shipped
 * shrinkage and lambda. Ask what the Blend rule does to a file known to be one generation down.
 *
 * *** THE PREDICTION, PRE-REGISTERED AND ARITHMETIC. *** The rule asserts a generation is worth
 *     shrink * lambda * dPdGen / 2  =  0.075 * 1.533 * 0.2005 / 2  =  1.15% in score.
 * There is no wiggle room in that number: it is three shipped constants multiplied together.
 *   lands near 1.15%   the calibration is right, and the honest headline becomes "the adjustment is
 *                      real and worth about one percent per generation" — a far more defensible thing
 *                      to ship than +-10%.
 *   lands near 15%     the shrinkage is an order of magnitude too small, and the estimator argument
 *                      against the current constant is answered in the framework's favour.
 *   lands near 0, or   the chain between the detectors and the score does not transmit the signal the
 *   the wrong sign     detectors demonstrably see. That falsifies the shipped rule, not the panel.
 *
 * *** WHAT THIS TEST DOES NOT DO, AND IT MATTERS. *** Both copies are measured on THE SAME CLIPS, so
 * scene-sampling noise cancels exactly. That is deliberate — it isolates the CALIBRATION — but it
 * means this test says nothing about the per-film ORDERING, which the clip-disjoint split-half just
 * showed is roughly half scene sampling. Two different failures; this addresses one of them. Do not
 * quote a pass here as evidence the ordering is sound.
 *
 * A SECOND ARM, nearly free once the harness exists: the same films with hqdn3d applied before the
 * re-encode. That is the PREPROCESSING-dominated contrast 11.44 says the library does not contain,
 * manufactured on real files with ground truth.
 *
 * READ-ONLY on media. Encodes into a temp dir it removes.
 * USAGE: node scripts/end-to-end-generation.js [--films 24] [--clips 4]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', 'http://localhost:8088');
const N = Number(val('--films', 24));
const CLIPS = Number(val('--clips', 4));
const SECLEN = Number(val('--seclen', 2));
const THREADS = val('--threads', '3');
const OUT = val('--out', `${__dirname}/../data/end-to-end-generation.json`);
const FF = `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`;
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const sh = (b, a) => execFileSync(b, a, { encoding: 'utf8', timeout: 30 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/* Identical recipe to artifact-backfill.js, because the whole point is to run the PRODUCTION path. */
function measure(file, t) {
  const log = path.join(TMP, 'c.csv');
  try { fs.unlinkSync(log); } catch { /* */ }
  const ss = t == null ? [] : ['-ss', String(t), '-t', String(SECLEN)];
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
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  const pool = ds.rows.filter((r) => r.path && r.bpp > 0 && r.cxEff > 0 && r.probeW > 0)
    .sort((a, b) => a.cxEff - b.cxEff);
  /* Spread across complexity so a null cannot be blamed on drawing only smooth or only grainy films. */
  const picks = [];
  for (let i = 0; i < N; i += 1) picks.push(pool[Math.floor(((pool.length - 1) * i) / (N - 1))]);

  let done = {};
  try { done = JSON.parse(fs.readFileSync(OUT, 'utf8')).units || {}; } catch { /* first run */ }
  const todo = picks.filter((r) => !done[r.key]);
  console.log(`${todo.length} units, ${CLIPS} clips each, gen0 vs gen1 vs gen1+denoise\n`);

  for (const r of todo) {
    const dur = Math.floor(Number(sh(FP, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0);
    if (!dur) continue;
    /* SAME positions the backfill uses, so the comparison is against the shipped sampling. */
    const start = Math.floor(dur * 0.1); const span = Math.floor(dur * 0.8);
    const pos = [];
    for (let k = 0; k < CLIPS; k += 1) pos.push(start + Math.floor((span * k) / CLIPS));

    /* The film's OWN bitrate: one generation at matched bits, which is the whole design. */
    const kbps = Math.round((r.bpp * r.probeW * r.probeH * (r.fps || 24)) / 1000) || 2000;
    const acc = { gen0: [], gen1: [], den1: [] };
    for (const t of pos) {
      const m0 = measure(r.path, t);
      if (!m0) continue;
      acc.gen0.push(m0);
      const src = path.join(TMP, 'c.mkv');
      if (spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-t', String(SECLEN),
        '-i', r.path, '-c:v', 'ffv1', '-an', '-sn', '-y', src], { timeout: 30 * 60000 }).status !== 0) continue;
      for (const [tag, vf] of [['gen1', null], ['den1', 'hqdn3d=2:1:3:2']]) {
        const o = path.join(TMP, `${tag}.mkv`);
        if (spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', src,
          ...(vf ? ['-vf', vf] : []), '-c:v', 'libx264', '-preset', 'medium', '-b:v', `${kbps}k`,
          '-threads', THREADS, '-an', '-sn', '-y', o], { timeout: 30 * 60000 }).status !== 0) continue;
        const m = measure(o, null);
        if (m) acc[tag].push(m);
      }
    }
    if (acc.gen0.length < 2 || acc.gen1.length < 2) continue;
    done[r.key] = { title: r.title, bpp: r.bpp, cxEff: r.cxEff, codec: r.codec, bppPlus: r.bppPlus,
      kbps, gen0: avg(acc.gen0), gen1: avg(acc.gen1), den1: acc.den1.length >= 2 ? avg(acc.den1) : null };
    fs.writeFileSync(OUT, JSON.stringify({ generated: Date.now(), clips: CLIPS, units: done }, null, 1));
    const d = done[r.key];
    console.log(`  ${Object.keys(done).length}/${picks.length} ${r.title.slice(0, 30).padEnd(32)} `
      + `cambi ${d.gen0.cambi.toFixed(3)} -> ${d.gen1.cambi.toFixed(3)}   `
      + `block ${d.gen0.block.toFixed(2)} -> ${d.gen1.block.toFixed(2)}`);
  }
  console.log(`\nwrote ${OUT}`);
  console.log('Analyse with: node scripts/end-to-end-generation-analyse.mjs');
})();
