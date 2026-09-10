#!/usr/bin/env node
/* THE TEST THAT DECIDES WHETHER ANY OF THIS SHIPS.
 *
 * Three axes are validated in CONTROLLED conditions — encoder (19/20 films), generations (10/10 on
 * block and blur), and denoise (running). All hold bits and content exactly constant. The library
 * never does that, so the field version must predict the expected artifact from bits+content and
 * read the RESIDUAL. The adversarial pass on 2026-08-26 found the crux:
 *
 *     detector   residual SD (log)   one-preset-step effect   ratio
 *     cambi           1.422                 0.373            0.26
 *     block           0.390                 0.233            0.60
 *
 * Read naively the model error swamps the signal. But that comparison is NOT valid: it sets the
 * TOTAL residual spread against a SINGLE preset step, and real files differ by far more than one
 * step — veryfast to placebo, one to three generations, denoised or not, a dozen groups. A residual
 * SD of 0.390 against 0.233 for one step is exactly what provenance-dominated residuals look like.
 *
 * SO THE RESIDUAL IS EITHER MOSTLY PROVENANCE (ship it) OR MOSTLY MODEL ERROR (do not), and nothing
 * measured so far separates those. Detector correlations do not help: the detectors live on
 * DIFFERENT axes, so a badly-encoded file shows a blocking residual without a banding one, and low
 * correlation is expected under both hypotheses.
 *
 * THE DISCRIMINATING TEST USES PROVENANCE WE ALREADY KNOW. A WEBRip IS a re-encode of a WEB-DL —
 * that is what the label means. The generation axis says blocking and blur must be worse on WEBRips
 * at matched bits and content. If the residual separates them, it is carrying provenance and the
 * Blend page can be built on it. If it does not, the residual is model error and this framework
 * stops here.
 *
 * WHY IT NEEDS ITS OWN RUN: only 6 WEBRips and 14 WEB-DLs currently carry a banding reading, against
 * 53 and 95 in the library. The nightly queue sorts by staleness with no source priority, and
 * changing that is a controller rebuild. This measures the targeted population directly instead —
 * the numbers are needed for one analysis, not for the controller's database.
 *
 * READ-ONLY: decodes source files, writes only its own JSON.
 * USAGE: node scripts/provenance-wild.js [--limit 160]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LIMIT = Number(val('--limit', 160));
const SAMPLES = Number(val('--samples', 4));
const SECLEN = Number(val('--seclen', 2));
const OUT = val('--out', `${__dirname}/../data/artifact-backfill.json`);
const FF = `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`;
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const sh = (b, a) => execFileSync(b, a, { encoding: 'utf8', timeout: 30 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/* All four artifacts on the DELIVERED file — no re-encoding. Same recipe as the ladder's rungs so
 * the numbers are comparable to everything else measured today. */
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
  const ds = await (await fetch('http://localhost:8088/api/probe/dataset')).json();
  /* SELECTION — and the default here caused a 25% coverage hole that went unnoticed until
   * 2026-08-27. `!r.cambi` picks units with NO banding reading, which was right when the goal was to
   * enrich the WEBRip/WEB-DL side. But it silently EXCLUDES every unit the nightly probe had already
   * given a cambi to, and those turned out to be 266 units — all of them Bluray movies, with higher
   * median bpp (0.075 vs 0.058) and complexity (0.166 vs 0.143) than the measured set.
   *
   * That matters because the provenance factor's anchor is mean P(WEB) - mean P(Bluray), so one side
   * of it was being computed on a non-random 70% of its own group. Pass --all to measure everything.
   *
   * NOTE the units are re-measured for ALL FOUR artifacts even where a nightly cambi exists. Reusing
   * the nightly reading would mix two recipes in one column, and ladder absolutes are already known
   * not to travel between runs. One recipe per column, always. */
  const ALL = args.includes('--all');
  /* --sources lets a run target specific source tiers. Added for the DEEP RESAMPLE (11.41): cambi's
   * scene-sampling noise is ~42% of its residual variance at 4 clips, and the fix is more clips —
   * but re-measuring all 1048 units at 16 clips is ~46 hours. Testing the prediction on a stratified
   * subset that keeps BOTH sides of the WEB-vs-Bluray gap is cheaper and is better science: it says
   * whether the full run is worth the time before the time is spent. */
  const SRC = val('--sources', '');
  const srcRe = SRC ? new RegExp(SRC.split(',').join('|'), 'i') : null;
  let want = ds.rows.filter((r) => r.path && r.bpp > 0 && r.cxEff > 0 && (ALL || !r.cambi)
    && (!srcRe || srcRe.test(r.source || '')));
  /* Deterministic stratified interleave so a --limit cut keeps the source mix rather than taking
   * whatever the dataset order happens to front-load. */
  if (args.includes('--stratify')) {
    const buckets = {};
    for (const r of want) (buckets[String(r.source || 'other')] ||= []).push(r);
    const keys = Object.keys(buckets).sort();
    const out2 = [];
    for (let i = 0; out2.length < want.length; i += 1) {
      let added = false;
      for (const k of keys) if (buckets[k][i]) { out2.push(buckets[k][i]); added = true; }
      if (!added) break;
    }
    want = out2;
  }
  let done = {};
  try { done = JSON.parse(fs.readFileSync(OUT, 'utf8')).units || {}; } catch { /* first run */ }
  const todo = want.filter((r) => !done[r.key]).slice(0, LIMIT);
  console.log(`${want.length} candidate units${ALL ? ' (--all: no banding filter)' : ' without a banding reading'}, `
    + `${Object.keys(done).length} already measured, doing ${todo.length}\n`);

  let n = 0;
  for (const r of todo) {
    const dur = Math.floor(Number(sh(FP, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0);
    if (!dur) continue;
    const start = Math.floor(dur * 0.1); const span = Math.floor(dur * 0.8);
    const acc = [];
    for (let k = 0; k < SAMPLES; k += 1) {
      let m = null;
      try { m = measure(r.path, start + Math.floor((span * k) / SAMPLES)); } catch { /* */ }
      if (m) acc.push(m);
    }
    if (!acc.length) continue;
    const av = { title: r.title, source: r.source, bpp: r.bpp, cxEff: r.cxEff, bppPlus: r.bppPlus,
      codec: r.codec, n: acc.length };
    for (const k of ['cambi', 'block', 'blur', 'grain']) {
      const v = acc.map((x) => x[k]).filter((x) => x != null && x > 0);
      av[k] = v.length ? +mean(v).toFixed(5) : null;
    }
    done[r.key] = av;
    fs.writeFileSync(OUT, JSON.stringify({ generated: Date.now(), units: done }, null, 1));
    n += 1;
    console.log(`  [${n}/${todo.length}] ${r.title.slice(0, 34).padEnd(36)} ${String(r.source).padEnd(13)} `
      + `cambi ${av.cambi != null ? av.cambi.toFixed(3).padStart(8) : '     n/a'}  block ${av.block != null ? av.block.toFixed(3) : 'n/a'}`);
  }
  const all = Object.values(done);
  console.log(`\n${all.length} units measured: `
    + `${all.filter((u) => /WEBRip/i.test(u.source)).length} WEBRip, `
    + `${all.filter((u) => /WEBDL/i.test(u.source)).length} WEB-DL`);
  console.log(`wrote ${OUT}`);
})();
