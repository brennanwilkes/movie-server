#!/usr/bin/env node
/* THE NOISE FLOOR OF perPoint — the number that decides whether a PER-FILM detail reading exists.
 *
 * WHERE THIS SITS. perPoint passed the two-direction test (E.8.3), passed the specificity leg against
 * gblur at 19% of the starvation slope (E.8.5), and the 60-film content line came out FLAT — meaning
 * it responds to damage and not to content, which is perfect specificity and exactly what CRF theory
 * predicts. All of that concerns the AGGREGATE direction, and all of it stands.
 *
 * *** WHAT DOES NOT STAND IS THE PER-FILM READING. *** The content-line fit leaves a residual sd of
 * 0.0239. Divided by the measured level slope of 0.0297 that implies a 2.24x spread in source
 * starvation per standard deviation, i.e. p10-to-p90 of about 7.9x across the library. NO REAL
 * LIBRARY SPANS THAT RANGE in how starved its sources were. So most of that residual must be
 * measurement noise rather than damage — but "must be" is an inference, and the actual noise floor
 * has never been measured. Without it there is no way to know how much of a per-film residual is
 * signal, and therefore no way to weight it in a score.
 *
 * WHY THE EXISTING RUNS CANNOT ANSWER IT. perpoint-specificity.js pools the encoded RATES across
 * clips and then fits one slope per film. That is the right estimator for a level, but it destroys
 * the within-film variation needed for a split-half: there is no per-clip perPoint to split.
 *
 * THE DESIGN. 20 films, SIX clips each, and perPoint fitted SEPARATELY ON EVERY CLIP. Then reliability
 * is the correlation between two disjoint 3-clip halves, corrected by Spearman-Brown to the full six.
 * That is the same procedure used to grade the artifact detectors (blur 0.404, grain 0.935), so the
 * result lands on a scale this project can already read.
 *
 * *** WHAT THE ANSWER MEANS, WRITTEN DOWN BEFORE IT EXISTS. ***
 *   reliability >= 0.7   per-film detail readings are usable and a score term can be built, with the
 *                        residual shrunk by the reliability in the usual way.
 *   0.3 - 0.7            the aggregate direction is real but per-film readings are mostly noise. The
 *                        detail term would need many more clips per film to be worth anything, and
 *                        the honest interim output is a LIBRARY-LEVEL statement, not a per-film one.
 *   < 0.3                perPoint cannot be measured well enough per film at this sampling. The
 *                        instrument is real and the application is not — say so plainly rather than
 *                        shipping a term whose spread is noise.
 * Note the asymmetry that makes this worth doing: a LOW reliability does not retract E.8.3 or E.8.5,
 * because those are aggregate results and a zero-mean per-film noise adds variance to a group
 * comparison without biasing it. It only bounds what can be built ON TOP of them.
 *
 * A SECOND FREE OUTPUT. Fitting per clip also gives the WITHIN-FILM scene-to-scene spread of perPoint
 * directly, which is the same scene-sampling nuisance that turned out to be 52% of the provenance
 * factor (E.9.4). If perPoint's scene spread is large, that is the mechanism, and more clips is the
 * fix rather than a different statistic.
 *
 * READ-ONLY on media. Encodes 2s clips into a temp dir it removes on exit.
 * THERMAL: 3 encode threads, strictly one film at a time. Two heavy jobs measured 93C against 100C.
 * USAGE: node scripts/perpoint-reliability.js [--films 20] [--clips 6]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', 'http://localhost:8088');
const N = Number(val('--films', 20));
const CLIPS = Number(val('--clips', 6));
const SECLEN = Number(val('--seclen', 2));
const THREADS = val('--threads', '3');
const CRFS = val('--crfs', '16,20,24,28').split(',').map(Number);
const OUT = val('--out', `${__dirname}/../data/perpoint-reliability.json`);
const FF = `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`;
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ppr-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const sh = (b, a) => execFileSync(b, a, { encoding: 'utf8', timeout: 30 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const slope = (xs, ys) => {
  const mx = mean(xs); const my = mean(ys);
  let n = 0; let d = 0;
  for (let i = 0; i < xs.length; i += 1) { n += (xs[i] - mx) * (ys[i] - my); d += (xs[i] - mx) ** 2; }
  return d > 0 ? n / d : NaN;
};

function rateAt(src, crf) {
  const o = path.join(TMP, `e${crf}.mkv`);
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', src,
    '-c:v', 'libx265', '-preset', 'medium', '-crf', String(crf), '-x265-params', 'log-level=none',
    '-threads', THREADS, '-an', '-sn', '-y', o], { timeout: 30 * 60000 });
  if (r.status !== 0) return null;
  try { const b = fs.statSync(o).size; fs.unlinkSync(o); return (b * 8) / SECLEN; } catch { return null; }
}

(async () => {
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  const pool = ds.rows.filter((r) => r.path && r.bpp > 0 && r.cxEff > 0).sort((a, b) => a.cxEff - b.cxEff);
  const picks = [];
  for (let i = 0; i < N; i += 1) picks.push(pool[Math.floor(((pool.length - 1) * i) / (N - 1))]);

  let done = {};
  try { done = JSON.parse(fs.readFileSync(OUT, 'utf8')).units || {}; } catch { /* first run */ }
  const todo = picks.filter((r) => !done[r.key]);
  console.log(`${todo.length} films, ${CLIPS} clips each, perPoint fitted PER CLIP, CRFs ${CRFS.join('/')}\n`);

  for (const r of todo) {
    const dur = Math.floor(Number(sh(FP, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0);
    if (!dur) continue;
    const start = Math.floor(dur * 0.1); const span = Math.floor(dur * 0.8);
    const pos = [];
    for (let k = 0; k < CLIPS; k += 1) pos.push(start + Math.floor((span * k) / CLIPS));

    /* THE WHOLE POINT: one independent perPoint per clip, never pooled before the fit. */
    const clips = [];
    for (const t of pos) {
      const src = path.join(TMP, 'c.mkv');
      if (spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-t', String(SECLEN),
        '-i', r.path, '-c:v', 'ffv1', '-an', '-sn', '-y', src], { timeout: 30 * 60000 }).status !== 0) continue;
      const xs = []; const ys = [];
      for (const c of CRFS) {
        const b = rateAt(src, c);
        if (b > 0) { xs.push(c); ys.push(Math.log(b)); }
      }
      if (xs.length < CRFS.length) continue;
      clips.push({ t, perPoint: slope(xs, ys), cx20: Math.exp(ys[CRFS.indexOf(20)]) });
    }
    if (clips.length < 4) continue;
    done[r.key] = { title: r.title, bpp: r.bpp, cxEff: r.cxEff, codec: r.codec, clips };
    fs.writeFileSync(OUT, JSON.stringify({ generated: Date.now(), clips: CLIPS, crfs: CRFS, units: done }, null, 1));
    const pps = clips.map((c) => c.perPoint);
    const m = mean(pps);
    const s = Math.sqrt(pps.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, pps.length - 1));
    console.log(`  ${Object.keys(done).length}/${picks.length} ${r.title.slice(0, 28).padEnd(30)} `
      + `pp ${m.toFixed(4)}  within-film sd ${s.toFixed(4)}  (${clips.length} clips)`);
  }
  console.log(`\nwrote ${OUT}`);
  console.log('Analyse with: node scripts/perpoint-reliability-analyse.mjs');
})();
