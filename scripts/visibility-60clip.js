#!/usr/bin/env node
/* THE 60-CLIP VISIBILITY SAMPLE — the data that settles WHERE 100 SITS.
 *
 * WHY THIS IS THE JOB WORTH HOURS. The oldest open question in the project is whether the library
 * median of ~67 is too low. The artifact THRESHOLDS can answer it, because they are absolute and owe
 * nothing to this library (banding's 2.817 is Netflix's published visibility point). P cannot: it is
 * standardised to mean zero and is zero-sum by construction.
 *
 * *** BUT THE CURRENT SAMPLING CANNOT RESOLVE THE QUESTION AT ALL, AND THAT IS THE WHOLE POINT. ***
 * By the rule of three, ZERO exceedances in n clips bounds the true scene rate below only 3/n:
 *     n=4  -> 75%      n=8 -> 37.5%      n=12 -> 25%      n=60 -> 5%
 * The shipped backfill uses FOUR clips. A film reading "clean" there is consistent with THREE
 * QUARTERS of its scenes being visibly damaged. Brennan's criterion — "5% or less of visible
 * artifacts is good enough" — is not a modelling problem, it is a SAMPLING problem, and it needs
 * ~60 clips per film. That is two minutes of video per title.
 *
 * TWO DESIGN CHOICES THAT THE EXISTING BACKFILL GOT WRONG:
 *   1. PER-CLIP VALUES ARE STORED, NOT JUST THE MEAN. The backfill averages 4 clips and throws the
 *      rest away, which is why the scene-fraction question could not be asked of it and why P's
 *      reliability had to be reconstructed from a 60-film side experiment. Every clip is kept here.
 *   2. THE SAMPLE IS STRATIFIED BY BPP+ BAND, not drawn at random. The question is how visibility
 *      varies ACROSS the score, so the bands must be populated deliberately. A random draw from an
 *      80%-Bluray library would put almost everything in one place — the same underpowering that
 *      made the source-tier test uninterpretable.
 *
 * WHAT IT WILL ANSWER, none of which is currently answerable:
 *   - the SCENE FRACTION above threshold per film, to +-5% rather than +-75%
 *   - therefore how many films actually meet the "5% of scenes" criterion (0/60 at 12 clips, but
 *     that was a bound, not a measurement)
 *   - therefore, from the BPP+ at which the fraction crosses an acceptable rate, WHERE 100 BELONGS
 *   - as a free by-product, P's reliability at 60 clips and the scene-sampling nuisance direction
 *     measured properly rather than from a 12-clip side sample
 *
 * RESUMABLE BY DESIGN. Writes after every film and skips units already present, so it can be killed
 * and restarted without losing work. Expect many hours; that is expected and fine.
 *
 * READ-ONLY on media. THERMAL: this is ONE heavy job — do not run anything else alongside it.
 * Two heavy jobs measured 93C against a 100C limit.
 * USAGE: node scripts/visibility-60clip.js [--films 40] [--clips 60]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', 'http://localhost:8088');
const NFILMS = Number(val('--films', 40));
const CLIPS = Number(val('--clips', 60));
const SECLEN = Number(val('--seclen', 2));
const OUT = val('--out', `${__dirname}/../data/visibility-60clip.json`);
const FF = `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`;
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vis60-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const sh = (b, a) => execFileSync(b, a, { encoding: 'utf8', timeout: 30 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/* IDENTICAL recipe to artifact-backfill.js. It must not drift: the thresholds were derived against
 * these exact detector settings, so a changed filter chain silently invalidates them. */
function measure(file, t) {
  const log = path.join(TMP, 'c.csv');
  try { fs.unlinkSync(log); } catch { /* */ }
  const ss = ['-ss', String(t), '-t', String(SECLEN)];
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

(async () => {
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  const pool = ds.rows.filter((r) => r.path && r.bpp > 0 && r.cxEff > 0 && Number.isFinite(r.bppPlus));

  /* STRATIFY BY BPP+ BAND. The question is how visibility varies across the score, so the bands are
   * populated deliberately. A random draw from an 80%-Bluray library concentrates in one place. */
  const BANDS = [[0, 50], [50, 75], [75, 100], [100, 125], [125, 1e9]];
  const per = Math.max(1, Math.round(NFILMS / BANDS.length));
  const picks = [];
  for (const [lo, hi] of BANDS) {
    const inBand = pool.filter((r) => r.bppPlus >= lo && r.bppPlus < hi)
      .sort((a, b) => a.cxEff - b.cxEff);           /* spread across complexity within the band */
    for (let i = 0; i < Math.min(per, inBand.length); i += 1) {
      picks.push(inBand[Math.floor(((inBand.length - 1) * i) / Math.max(1, Math.min(per, inBand.length) - 1))]);
    }
  }
  const uniq = [...new Map(picks.map((r) => [r.key, r])).values()];

  let done = {};
  try { done = JSON.parse(fs.readFileSync(OUT, 'utf8')).units || {}; } catch { /* first run */ }
  const todo = uniq.filter((r) => !done[r.key]);
  console.log(`${todo.length} films to do (${uniq.length} picked, ${Object.keys(done).length} already), `
    + `${CLIPS} clips each at ${SECLEN}s\n`);

  for (const r of todo) {
    const dur = Math.floor(Number(sh(FP, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0);
    if (!dur) continue;
    /* Spread over the middle 80% of the runtime, as the backfill does, so credits and logos are
     * excluded and the sampling is comparable to everything already measured. */
    const start = Math.floor(dur * 0.1); const span = Math.floor(dur * 0.8);
    const clips = [];
    for (let k = 0; k < CLIPS; k += 1) {
      const t = start + Math.floor((span * k) / CLIPS);
      const m = measure(r.path, t);
      if (m && m.cambi != null && m.block != null && m.blur != null && m.grain != null) {
        clips.push({ t, ...m });
      }
    }
    if (clips.length < CLIPS * 0.6) { console.log(`  SKIP ${r.title} — only ${clips.length} clean clips`); continue; }
    done[r.key] = { title: r.title, source: r.source, codec: r.codec, bpp: r.bpp, cxEff: r.cxEff,
      bppPlus: r.bppPlus, probeH: r.probeH, year: r.year, clips };
    fs.writeFileSync(OUT, JSON.stringify({ generated: Date.now(), clips: CLIPS, seclen: SECLEN, units: done }, null, 1));
    const over = clips.filter((c) => c.cambi > 2.817).length;
    console.log(`  ${Object.keys(done).length}/${uniq.length} ${String(r.bppPlus).padStart(4)} `
      + `${r.title.slice(0, 34).padEnd(36)} ${clips.length} clips, ${over} banded (${(100 * over / clips.length).toFixed(0)}%)`);
  }
  console.log(`\nwrote ${OUT}`);
})();
