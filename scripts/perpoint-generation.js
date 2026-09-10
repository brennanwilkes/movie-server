#!/usr/bin/env node
/* WHAT IS THE perPoint RESIDUAL WORTH, IN GENERATIONS? — the exchange rate, measured not assumed.
 *
 * THE PROBLEM THIS SOLVES. The cross-film perPoint residual is now known to be:
 *     REAL          6-clip reliability 0.945 (better than grain 0.935, blur 0.404)
 *     NON-REDUNDANT 67% of it is information BPP+ does not have (adj R2 0.333 on bpp + cxEff)
 *     DAMAGE-LIKE   correlates with banding +0.415 and with height -0.303, and NOT with grain
 *                   (+0.090), complexity (-0.043), blur, fps or year
 * Yet converting it through the within-film starvation slope implies a p10-p90 spread of ~7x in
 * source starvation, which no real library contains. A real, reliable, damage-like quantity with an
 * impossible interpretation means THE MEASUREMENT IS SOUND AND THE EXCHANGE RATE IS WRONG.
 *
 * WHY THE CURRENT RATE IS SUSPECT. d perPoint/d log(level) = -0.0297 is a WITHIN-FILM slope measured
 * under controlled starvation, and it is being applied to a CROSS-FILM residual. That is exactly the
 * transfer assumption that inflated the anchor by 4.6x (11.30) and that the crossed ladder was built
 * to eliminate. It has never been validated for perPoint.
 *
 * THE DESIGN, and it reuses ground truth this project already paid for. data/end-to-end-generation
 * .json holds 24 films where ONE GENERATION separates gen0 from gen1 by construction — same clips,
 * same bitrate, same codec. Measure perPoint on BOTH:
 *     perPoint(gen0)  the file as it sits on disk
 *     perPoint(gen1)  the same clips, one extra re-encode at matched bits
 *     dPP = perPoint(gen1) - perPoint(gen0)   <- the response to EXACTLY one generation
 * Then the library residual can be priced in a unit that means something:
 *     residual sd 0.0280  /  dPP  =  how many generations the library's spread covers
 *
 * *** THE PLAUSIBILITY TEST THAT DECIDES IT, PRE-REGISTERED. ***
 *   1 - 2 generations   the residual is an ordinary provenance spread and perPoint can be priced.
 *                       The 7x starvation figure was an artefact of the wrong exchange rate, and
 *                       this replaces it.
 *   5+ generations      the residual is too wide to be generations either. It is real and
 *                       damage-like but is NOT a provenance depth, and no bitrate-equivalent
 *                       conversion is justified — it would have to stay a diagnostic.
 *   dPP near zero or    perPoint does not respond to a real generation at all, which would
 *   wrong sign          contradict the starvation response and needs explaining before anything
 *                       else is built. Sign is reported per film, not just in aggregate.
 *
 * A SECOND FREE OUTPUT: this is also the first DIRECT check that perPoint responds to real
 * generation loss on real library files. Every existing result uses synthetic starvation (re-encodes
 * at reduced bitrate) or gblur. A generation at MATCHED bitrate is the field-relevant degradation and
 * has never been tested against perPoint.
 *
 * NOTE THE KNOWN CONTAMINATION. E.7.3/E.7.4 measured that ~49% of the gen0->gen1 step in that dataset
 * is NOT a generation — it is the 2-pass -> 1-pass rate-control downgrade plus film-average bits on a
 * specific segment. So dPP measured here is an UPPER bound on one generation's effect, and the
 * generation count derived from it is a LOWER bound. Stated here so the number is read correctly.
 *
 * READ-ONLY on media. Encodes into a temp dir it removes on exit.
 * THERMAL: 3 encode threads, one film at a time. Two heavy jobs measured 93C against 100C.
 * USAGE: node scripts/perpoint-generation.js [--clips 3]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', 'http://localhost:8088');
const CLIPS = Number(val('--clips', 3));
const SECLEN = Number(val('--seclen', 2));
const THREADS = val('--threads', '3');
const CRFS = val('--crfs', '16,20,24,28').split(',').map(Number);
const E2E = `${__dirname}/../data/end-to-end-generation.json`;
const OUT = val('--out', `${__dirname}/../data/perpoint-generation.json`);
const FF = `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`;
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ppg-'));
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
/* perPoint for one already-extracted lossless clip */
function ppOf(src) {
  const xs = []; const ys = [];
  for (const c of CRFS) {
    const b = rateAt(src, c);
    if (b > 0) { xs.push(c); ys.push(Math.log(b)); }
  }
  return xs.length === CRFS.length ? { perPoint: slope(xs, ys), cx20: Math.exp(ys[CRFS.indexOf(20)]) } : null;
}

(async () => {
  const e2e = JSON.parse(fs.readFileSync(E2E, 'utf8'));
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  const byKey = new Map(ds.rows.map((r) => [r.key, r]));

  let done = {};
  try { done = JSON.parse(fs.readFileSync(OUT, 'utf8')).units || {}; } catch { /* first run */ }
  const todo = Object.entries(e2e.units).filter(([k]) => !done[k] && byKey.has(k));
  console.log(`${todo.length} films, ${CLIPS} clips, perPoint on gen0 vs gen1 at matched bits\n`);

  for (const [key, u] of todo) {
    const r = byKey.get(key);
    if (!r?.path) continue;
    const dur = Math.floor(Number(sh(FP, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0);
    if (!dur) continue;
    /* SAME clip positions the e2e used, so this is the same ground truth */
    const start = Math.floor(dur * 0.1); const span = Math.floor(dur * 0.8);
    const pos = [];
    for (let k = 0; k < CLIPS; k += 1) pos.push(start + Math.floor((span * k) / CLIPS));

    const g0 = []; const g1 = [];
    for (const t of pos) {
      const src = path.join(TMP, 'c.mkv');
      if (spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-t', String(SECLEN),
        '-i', r.path, '-c:v', 'ffv1', '-an', '-sn', '-y', src], { timeout: 30 * 60000 }).status !== 0) continue;
      const a = ppOf(src);
      if (!a) continue;
      /* one generation at the film's OWN bitrate — identical recipe to end-to-end-generation.js */
      const gen = path.join(TMP, 'g1.mkv');
      if (spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', src, '-c:v', 'libx264',
        '-preset', 'medium', '-b:v', `${u.kbps}k`, '-threads', THREADS, '-an', '-sn', '-y', gen],
      { timeout: 30 * 60000 }).status !== 0) continue;
      const raw1 = path.join(TMP, 'g1raw.mkv');
      if (spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', gen, '-c:v', 'ffv1',
        '-an', '-sn', '-y', raw1], { timeout: 30 * 60000 }).status !== 0) continue;
      const b = ppOf(raw1);
      if (!b) continue;
      g0.push(a); g1.push(b);
    }
    if (g0.length < 2) continue;
    done[key] = { title: u.title, bpp: u.bpp, cxEff: u.cxEff, codec: u.codec, kbps: u.kbps,
      gen0: { perPoint: mean(g0.map((x) => x.perPoint)), cx20: mean(g0.map((x) => x.cx20)) },
      gen1: { perPoint: mean(g1.map((x) => x.perPoint)), cx20: mean(g1.map((x) => x.cx20)) },
      nClips: g0.length };
    fs.writeFileSync(OUT, JSON.stringify({ generated: Date.now(), clips: CLIPS, crfs: CRFS, units: done }, null, 1));
    const d = done[key];
    console.log(`  ${Object.keys(done).length}/${Object.keys(e2e.units).length} ${u.title.slice(0, 28).padEnd(30)} `
      + `pp ${d.gen0.perPoint.toFixed(4)} -> ${d.gen1.perPoint.toFixed(4)}  `
      + `d ${(d.gen1.perPoint - d.gen0.perPoint).toFixed(4)}`);
  }
  console.log(`\nwrote ${OUT}`);
})();
