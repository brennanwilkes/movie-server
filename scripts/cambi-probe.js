#!/usr/bin/env node
/* CAMBI — measuring the one artifact BPP+ is structurally blind to, and testing whether it is real.
 *
 * WHY BANDING. BPP+ answers "does this file have enough bits for its own content". Banding is a
 * different failure: flat gradients quantised into visible steps. It is not a bitrate shortfall the
 * score can see, because a file can be perfectly adequate on average and still band in the sky.
 * CAMBI (Netflix, 2021) is the industry's detector for it.
 *
 * WHY IT IS USABLE HERE, WHICH WAS THE BLOCKER. CAMBI is genuinely NO-REFERENCE — it keys on flat
 * regions in the distorted frame alone. Only libvmaf's *plumbing* insists on two inputs, so both are
 * pointed at the same file. That distinction matters: it means banding can be measured in production
 * forever, with no master, unlike VMAF proper which is calibration-only here.
 *
 * *** THE ffmpeg USED HERE IS NOT THE PROBE'S, AND MUST NEVER BE. *** tools/ffmpeg-n8.1... is a
 * pinned static GPL build, fetched only because no ffmpeg on this box has libvmaf (controller 5.1,
 * jellyfin 7.1.4 has vmafmotion only, host 4.2). The controller's x265 produced all 1044 complexity
 * measurements and it is the ONLY ruler for those — mixing builds would compare measurements taken
 * with different rulers. This build is for CAMBI and nothing else. Never point it at complexity.
 *
 * THE HYPOTHESIS THIS IS DESIGNED TO KILL, not to confirm. gShare died because it turned out to be a
 * restatement of DARKNESS (r = -0.885 against mean luma). CAMBI could fail the same two ways, and
 * both are checked here rather than assumed away:
 *   DEGENERACY 1 — it just measures grain. Grain acts as dithering and SUPPRESSES banding, so CAMBI
 *                  would anti-correlate with complexity and be a grain detector wearing a new name.
 *                  Casablanca (complexity 0.279, heavy grain) reads cambi 0.0012 in the smoke test,
 *                  which is exactly what that failure would look like.
 *   DEGENERACY 2 — it just measures darkness. Banding is most visible in dark gradients, so YAVG is
 *                  captured per clip in the same pass and correlated.
 * If either correlation is strong, CAMBI is not a new axis and this stops here. The decision rule is
 * stated before the run: |r| > 0.6 against complexity or luma = not an independent signal.
 *
 * SAMPLING matches probe-film.sh's grid (T = start + span*i/N over the middle 90%) so a CAMBI number
 * and a complexity number for the same film describe the same scenes.
 *
 * SAFETY: reads media read-only, writes clips to /tmp and removes them. Never touches /data.
 *
 * USAGE
 *   node scripts/cambi-probe.js --films 40 [--clips 4] [--seclen 2] [--out PATH]
 *   node scripts/cambi-probe.js --min-bppplus 75 --exclude data/cambi.json --films 50
 *
 * `--min-bppplus` targets the BLIND SPOT rather than sampling the library. The first run established
 * that CAMBI is independent (40 films, all degeneracy tests passed) but left prevalence open: only 2
 * of 40 were films BPP+ called acceptable that banded anyway. Sampling films the score already
 * condemns cannot measure that — a film at BPP+ 47 is going to be replaced regardless of banding.
 * Restricting to BPP+ >= 75 estimates the rate directly, which is many times cheaper per CPU-second
 * than widening a random sample until enough of them happen to be acceptable.
 * `--exclude` skips keys already measured in a previous output file, so runs accumulate.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = process.env.CONTROLLER || 'http://localhost:8088';
const N_FILMS = Number(val('--films', 40));
const CLIPS = Number(val('--clips', 4));
const SECLEN = Number(val('--seclen', 2));
const OUT = val('--out', `${__dirname}/../data/cambi.json`);
const MIN_PLUS = val('--min-bppplus', null) != null ? Number(val('--min-bppplus', 0)) : null;
const EXCLUDE = val('--exclude', null);
const FF = val('--ffmpeg',
  `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`);

if (!fs.existsSync(FF)) {
  console.error(`no libvmaf-capable ffmpeg at ${FF}\nrun scripts/setup-vmaf-tool.sh first`);
  process.exit(2);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cambi-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const sh = (bin, a) => execFileSync(bin, a, { encoding: 'utf8', timeout: 20 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });

// STRATIFIED BY COMPLEXITY *AND* R. A sample drawn on complexity alone would confound the two
// degeneracy checks with each other: grainy films are also the starved ones in this library (all 26
// at complexity >= 0.30 sit at R <= 1.07), so complexity-only sampling would make grain and supply
// inseparable and neither correlation would mean anything.
function select(rows) {
  let skip = new Set();
  if (EXCLUDE) {
    try {
      skip = new Set(JSON.parse(fs.readFileSync(EXCLUDE, 'utf8')).films.map((f) => f.key));
      console.log(`excluding ${skip.size} already-measured film(s) from ${EXCLUDE}`);
    } catch (e) { console.log(`could not read --exclude ${EXCLUDE}: ${e.message}`); }
  }
  const ok = rows.filter((r) => r.kind === 'movie' && r.path && r.complexity > 0 && r.R > 0
    && r.bppPlus != null && !skip.has(r.key)
    && (MIN_PLUS == null || r.bppPlus >= MIN_PLUS));
  if (MIN_PLUS != null) console.log(`restricted to BPP+ >= ${MIN_PLUS}: ${ok.length} eligible`);
  const byCx = [...ok].sort((a, b) => a.complexity - b.complexity);
  const nCx = 5; const per = Math.max(1, Math.round(N_FILMS / nCx));
  const picked = []; const seen = new Set();
  for (let b = 0; b < nCx; b += 1) {
    const lo = Math.floor((b * byCx.length) / nCx);
    const hi = Math.floor(((b + 1) * byCx.length) / nCx);
    const band = byCx.slice(lo, hi).sort((a, x) => a.R - x.R);
    for (let j = 0; j < per && band.length; j += 1) {
      const idx = Math.floor(((j + 0.5) * band.length) / per);
      const r = band[Math.min(idx, band.length - 1)];
      if (r && !seen.has(r.key)) { seen.add(r.key); picked.push(r); }
    }
  }
  return picked;
}

function probeDur(file) {
  try {
    const o = sh(FF.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries',
      'format=duration', '-of', 'default=nw=1:nk=1', file]);
    return Math.floor(Number(String(o).trim()) || 0);
  } catch { return 0; }
}

// CAMBI + YAVG for one clip. Two passes over a 2s clip because signalstats cannot ride inside the
// libvmaf graph (libvmaf consumes both inputs), and a 2s decode is cheap next to CAMBI itself.
function measure(clip) {
  const log = path.join(TMP, 'c.json');
  try { fs.unlinkSync(log); } catch { /* */ }
  sh(FF, ['-hide_banner', '-loglevel', 'error', '-i', clip, '-i', clip,
    '-lavfi', `[0:v][1:v]libvmaf=feature=name=cambi:n_threads=${Math.max(2, os.cpus().length - 1)}:log_path=${log}:log_fmt=json`,
    '-f', 'null', '-']);
  const j = JSON.parse(fs.readFileSync(log, 'utf8'));
  const pm = j.pooled_metrics || {};
  const frames = (j.frames || []).map((f) => (f.metrics || {}).cambi).filter((v) => v != null);
  let yavg = null;
  try {
    const o = sh(FF, ['-hide_banner', '-loglevel', 'error', '-i', clip,
      '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-']);
    const vs = String(o).split('\n').map((l) => /YAVG=([\d.]+)/.exec(l)).filter(Boolean)
      .map((m) => Number(m[1]));
    if (vs.length) yavg = +(vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(2);
  } catch { /* luma optional */ }
  return {
    cambiMean: pm.cambi ? +pm.cambi.mean.toFixed(5) : null,
    cambiMax: pm.cambi ? +pm.cambi.max.toFixed(5) : null,
    cambiP95: frames.length ? +[...frames].sort((a, b) => a - b)[Math.floor(frames.length * 0.95)].toFixed(5) : null,
    yavg,
  };
}

(async () => {
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  const chosen = select(ds.rows);
  console.log(`${chosen.length} films, ${CLIPS} clips x ${SECLEN}s each, ffmpeg ${path.basename(path.dirname(path.dirname(FF)))}`);

  const out = { generated: Date.now(), clips: CLIPS, seclen: SECLEN, films: [] };
  let i = 0;
  for (const r of chosen) {
    i += 1;
    const dur = probeDur(r.path);
    if (!dur) { console.log(`[${i}/${chosen.length}] ${r.title} — no duration, skipped`); continue; }
    const start = Math.floor(dur * 0.05); const span = Math.floor(dur * 0.90);
    const per = [];
    for (let k = 0; k < CLIPS; k += 1) {
      const t = start + Math.floor((span * k) / CLIPS);
      const clip = path.join(TMP, `c${k}.mkv`);
      try {
        // ffv1 = lossless, so CAMBI sees the SOURCE's banding and not the extraction's.
        sh(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-t', String(SECLEN),
          '-i', r.path, '-an', '-sn', '-c:v', 'ffv1', '-y', clip]);
        per.push({ t, pos: +(t / dur).toFixed(4), ...measure(clip) });
      } catch (e) {
        per.push({ t, error: String(e.message || e).split('\n')[0].slice(0, 120) });
      }
      try { fs.unlinkSync(clip); } catch { /* */ }
    }
    const good = per.filter((p) => p.cambiMean != null);
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const rec = {
      key: r.key, title: r.title, year: r.year, source: r.source, codec: r.codec,
      complexity: r.complexity, R: r.R, bppPlus: r.bppPlus, bpp: r.bpp,
      cambiMean: good.length ? +mean(good.map((p) => p.cambiMean)).toFixed(5) : null,
      cambiP95: good.length ? +mean(good.map((p) => p.cambiP95)).toFixed(5) : null,
      cambiMax: good.length ? Math.max(...good.map((p) => p.cambiMax)) : null,
      yavg: good.length ? +mean(good.filter((p) => p.yavg != null).map((p) => p.yavg)).toFixed(2) : null,
      clips: per,
    };
    out.films.push(rec);
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(`[${i}/${chosen.length}] ${r.title.slice(0, 34).padEnd(36)} `
      + `cambi ${String(rec.cambiMean).padStart(8)}  p95 ${String(rec.cambiP95).padStart(8)}  `
      + `luma ${String(rec.yavg).padStart(6)}  cx ${r.complexity.toFixed(3)}  R ${r.R.toFixed(2)}  BPP+ ${r.bppPlus}`);
  }
  console.log(`\nwrote ${OUT} (${out.films.length} films)`);
})();
