#!/usr/bin/env node
/* LEG C — THE SPECIFICITY TEST. Can perPoint tell SOFT CONTENT from DESTROYED DETAIL?
 *
 * WHY THIS IS THE EXPERIMENT EVERYTHING NOW DEPENDS ON. The covering set has a hole at detail loss,
 * and E.10.1 showed that hole BIASES every calibration this project runs: complexity both demands
 * bits and MASKS artifacts, so every detector we own pushes the complexity exponent down, while the
 * one effect that would push it up — detail retention — has no instrument. Until detail loss is
 * measurable, "the artifacts say we need fewer bits" is a statement that would be produced whether or
 * not it were true.
 *
 * perPoint = d log(probeBitrate)/d CRF is the only candidate that passes the two-direction test
 * (E.8.3): starvation moves it 3.5x more steeply than content does, 6.1 SE apart, 8/8 monotone,
 * 7/8 codec-crossed, and the circularity was ruled out against the experimentally controlled
 * variable (t = 14.1). But EVERY ONE of those results contrasts starvation against films that merely
 * DIFFER in content. None of them tests the case that actually matters:
 *
 *     *** A FILM THAT IS GENUINELY SOFT, AT FULL BITRATE, WITH NOTHING DESTROYED. ***
 *
 * If perPoint cannot separate that from a starved copy, it is not a detail-loss detector — it is a
 * softness detector, and it would mark every Super-8 pastiche and every soft-focus romance as damaged.
 * That is the failure mode 9.6 already flags as unhandled.
 *
 * THE DESIGN. Take clips at their own bitrate and apply a LINEAR low-pass before encoding:
 *     arm 0   no filter                    the reference
 *     arm 1   gblur sigma 0.6              mildly soft
 *     arm 2   gblur sigma 1.2              clearly soft
 * Measure perPoint on each by encoding at CRF 16/20/24/28 and fitting d log(bitrate)/d CRF.
 *
 * *** gblur AND NOT hqdn3d, AND THIS IS THE WHOLE POINT. *** hqdn3d is amplitude-thresholded — it
 * removes small-amplitude detail and keeps large — which is EXACTLY the shape of a quantiser deadzone.
 * Using it would confound softness with starvation BY CONSTRUCTION, and E.8's own axis table shows
 * why: denoise and bits are already inseparable in the (blur, grain) plane. A Gaussian blur is a
 * linear low-pass with no amplitude threshold at all, which is the correct model of optical softness,
 * a soft lens, or a weak transfer.
 *
 * *** PRE-REGISTERED, BEFORE ANY DATA EXISTS. *** Both softening and starvation reduce complexity, so
 * the test is NOT whether perPoint moves — it will. The test is WHICH DIRECTION it moves along, per
 * unit of complexity actually removed:
 *     STARVATION direction   -0.0897 +- 0.0028   (measured, within-film, n=24)
 *     CONTENT direction      -0.0254 +- 0.0101   (measured, across films, n=8)
 * So compute d perPoint / d log(cx20) for the gblur arms and compare:
 *     near -0.025   gblur moves perPoint along the CONTENT line. perPoint SEPARATES soft from
 *                   starved, and the detail-loss instrument is real.
 *     near -0.090   gblur is indistinguishable from starvation. perPoint is a SOFTNESS detector and
 *                   the covering set stays permanently incomplete. This kills it.
 *     >= 70% of the starvation slope  -> DEAD, per the pre-registration in task 83.
 * Reporting the ratio to BOTH reference directions is the whole output; the absolute value is not.
 *
 * WHAT WOULD MAKE THE RUN UNUSABLE, decided in advance: if gblur does not measurably reduce cx20 on
 * most films, there is no complexity drop to normalise by and the ratio is noise over noise. Checked
 * and reported per film before any direction is computed.
 *
 * READ-ONLY on media. Encodes 2s clips into a temp dir it removes on exit.
 * THERMAL: 3 encode threads, strictly one film at a time. Two heavy jobs measured 93C against 100C.
 * USAGE: node scripts/perpoint-specificity.js [--films 10] [--clips 3]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', 'http://localhost:8088');
const N = Number(val('--films', 10));
const CLIPS = Number(val('--clips', 3));
const SECLEN = Number(val('--seclen', 2));
const THREADS = val('--threads', '3');
const CRFS = val('--crfs', '16,20,24,28').split(',').map(Number);
const SIGMAS = val('--sigmas', '0,0.6,1.2').split(',').map(Number);
const OUT = val('--out', `${__dirname}/../data/perpoint-specificity.json`);
const FF = `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`;
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const sh = (b, a) => execFileSync(b, a, { encoding: 'utf8', timeout: 30 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const slope = (xs, ys) => {
  const mx = mean(xs); const my = mean(ys);
  let n = 0; let d = 0;
  for (let i = 0; i < xs.length; i += 1) { n += (xs[i] - mx) * (ys[i] - my); d += (xs[i] - mx) ** 2; }
  return d > 0 ? n / d : NaN;
};

/* bitrate of an encode of `src` at a given CRF, with an optional pre-filter */
function rateAt(src, crf, sigma) {
  const o = path.join(TMP, `e${crf}_${sigma}.mkv`);
  const vf = sigma > 0 ? ['-vf', `gblur=sigma=${sigma}`] : [];
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', src, ...vf,
    '-c:v', 'libx265', '-preset', 'medium', '-crf', String(crf), '-x265-params', 'log-level=none',
    '-threads', THREADS, '-an', '-sn', '-y', o], { timeout: 30 * 60000 });
  if (r.status !== 0) return null;
  try {
    const bytes = fs.statSync(o).size;
    fs.unlinkSync(o);
    return (bytes * 8) / SECLEN;
  } catch { return null; }
}

(async () => {
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  const pool = ds.rows.filter((r) => r.path && r.bpp > 0 && r.cxEff > 0)
    .sort((a, b) => a.cxEff - b.cxEff);
  /* spread across complexity so a null cannot be blamed on drawing only smooth or only grainy films */
  const picks = [];
  for (let i = 0; i < N; i += 1) picks.push(pool[Math.floor(((pool.length - 1) * i) / (N - 1))]);

  let done = {};
  try { done = JSON.parse(fs.readFileSync(OUT, 'utf8')).units || {}; } catch { /* first run */ }
  const todo = picks.filter((r) => !done[r.key]);
  console.log(`${todo.length} films, ${CLIPS} clips, sigmas ${SIGMAS.join('/')}, CRFs ${CRFS.join('/')}\n`);

  for (const r of todo) {
    const dur = Math.floor(Number(sh(FP, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0);
    if (!dur) continue;
    const start = Math.floor(dur * 0.1); const span = Math.floor(dur * 0.8);
    const pos = [];
    for (let k = 0; k < CLIPS; k += 1) pos.push(start + Math.floor((span * k) / CLIPS));

    /* rate[sigma][crf] accumulated across clips, so every arm sees exactly the same scenes */
    const acc = {};
    for (const s of SIGMAS) { acc[s] = {}; for (const c of CRFS) acc[s][c] = []; }
    for (const t of pos) {
      const src = path.join(TMP, 'c.mkv');
      if (spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-t', String(SECLEN),
        '-i', r.path, '-c:v', 'ffv1', '-an', '-sn', '-y', src], { timeout: 30 * 60000 }).status !== 0) continue;
      for (const s of SIGMAS) {
        for (const c of CRFS) {
          const b = rateAt(src, c, s);
          if (b > 0) acc[s][c].push(b);
        }
      }
    }
    const arms = {};
    let ok = true;
    for (const s of SIGMAS) {
      const xs = []; const ys = [];
      for (const c of CRFS) {
        if (acc[s][c].length < Math.max(1, CLIPS - 1)) { ok = false; break; }
        xs.push(c); ys.push(Math.log(mean(acc[s][c])));
      }
      if (!ok) break;
      /* cx20 proxy: the rate at CRF 20, the same reference the probe uses */
      arms[s] = { perPoint: slope(xs, ys), cx20: Math.exp(ys[CRFS.indexOf(20)]) };
    }
    if (!ok) continue;
    done[r.key] = { title: r.title, bpp: r.bpp, cxEff: r.cxEff, codec: r.codec, arms };
    fs.writeFileSync(OUT, JSON.stringify({ generated: Date.now(), clips: CLIPS, sigmas: SIGMAS,
      crfs: CRFS, units: done }, null, 1));
    const line = SIGMAS.map((s) => `s${s} pp ${arms[s].perPoint.toFixed(4)}`).join('  ');
    console.log(`  ${Object.keys(done).length}/${picks.length} ${r.title.slice(0, 26).padEnd(28)} ${line}`);
  }
  console.log(`\nwrote ${OUT}`);
  console.log('Analyse with: node scripts/perpoint-specificity-analyse.mjs');
})();
