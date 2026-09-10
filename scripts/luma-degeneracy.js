#!/usr/bin/env node
/* DOES blockdetect READ BLOCKING, OR JUST BRIGHTNESS? — the degeneracy check on a load-bearing detector.
 *
 * WHY IT MATTERS MORE NOW THAN WHEN IT WAS FILED. Blocking is the ENCODER-axis detector (11.13: one
 * preset step moves it as much as an 8.3x bitrate change), it is the second most reliable of the four
 * (0.849 at the library's four clips, 11.42), and it carries a quarter of P. If its reading is partly a
 * function of how BRIGHT a scene is rather than how blocky it is, that confound propagates into the
 * encoder axis, into P, and into every adjustment the Blend page makes.
 *
 * THE DESIGN. Take a real clip and shift its LUMA without touching its structure, then encode each
 * shifted version identically and measure. Edges, textures, motion and bitrate are held constant by
 * construction; only brightness moves. Any systematic response of blockMean to that is degeneracy,
 * because a brightness offset cannot change how blocky an image is.
 *
 * WHY NOT A SYNTHETIC FLAT FIELD, which is the obvious test. A flat field has no edges at all, so
 * blockdetect reads its floor at every luma and the test would pass trivially while telling us nothing
 * about real content. The question is whether the detector is luma-sensitive ON THE KIND OF TEXTURED
 * MATERIAL IT IS ACTUALLY USED ON.
 *
 * THE SHIFT IS APPLIED BEFORE THE ENCODE, deliberately. Shifting after would test only the detector;
 * shifting before also captures whether the ENCODER allocates differently at different brightness,
 * which is the real-world path by which a luma confound could enter. If the effect appears, a
 * follow-up should separate those two — this run cannot.
 *
 * ALL FOUR DETECTORS ARE MEASURED, not just blocking, because a luma response in cambi or grain would
 * matter just as much and costs nothing extra to look for.
 *
 * PRE-REGISTERED: |corr(brightness offset, log blockMean)| below about 0.3 across films means no
 * material degeneracy. Above that, blocking's contribution to P needs re-examining before the next
 * time anyone quotes the encoder axis.
 *
 * READ-ONLY on media. Encodes 2s clips in a temp dir it removes.
 * USAGE: node scripts/luma-degeneracy.js [--films 10] [--clips 2]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', 'http://localhost:8088');
const N = Number(val('--films', 10));
const CLIPS = Number(val('--clips', 2));
const THREADS = val('--threads', '3');
const OUT = val('--out', `${__dirname}/../data/luma-degeneracy.json`);
const FF = `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`;
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const sh = (b, a) => execFileSync(b, a, { encoding: 'utf8', timeout: 30 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/* Offsets are a FRACTION OF EACH FILM'S OWN HEADROOM, not fixed eq units.
 *
 * The first version used fixed +-0.25 and +-0.125, which is about +-64 and +-32 luma levels. The films
 * here have base luma around 51-86, so -0.25 CRUSHED THEM TO BLACK: Mr. Robot came out at luma 2.6 and
 * its grain reading collapsed from ~1.0 to 0.14. That is not a brightness shift with structure
 * preserved, it is clipping — and clipping changes structure, which destroys the premise of the test.
 *
 * So each film's shift is scaled to min(base, 255-base), the distance to whichever limit is nearer,
 * and kept well short of it. Every film then gets the same RELATIVE excursion with no clipping, which
 * is what makes the per-film correlations comparable in the first place. */
const HEADROOM_FRACTIONS = [-0.6, -0.3, 0, 0.3, 0.6];

function measure(clip) {
  const log = path.join(TMP, 'c.csv');
  try { fs.unlinkSync(log); } catch { /* */ }
  const p = spawnSync(FF, ['-hide_banner', '-loglevel', 'info', '-i', clip, '-i', clip, '-lavfi',
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
  const g = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', clip, '-an', '-sn', '-vf',
    'split[a][b];[a]hqdn3d=4:3:6:4[d];[b][d]blend=all_mode=difference,signalstats,'
    + 'metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8', timeout: 30 * 60000 });
  const gv = String(g.stdout || '').split('\n').map((l) => /YAVG=([\d.]+)/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  /* Actual mean luma of the encoded clip, so the analysis can regress against what the pixels really
   * are rather than against the offset we asked for. */
  const l = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', clip, '-an', '-sn', '-vf',
    'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8', timeout: 30 * 60000 });
  const lv = String(l.stdout || '').split('\n').map((x) => /YAVG=([\d.]+)/.exec(x)).filter(Boolean).map((m) => Number(m[1]));
  return { cambi, block: grab(/block mean: ([0-9.]+)/), blur: grab(/blur mean: ([0-9.]+)/),
    grain: gv.length > 2 ? mean(gv.slice(1)) : null, luma: lv.length ? mean(lv) : null };
}

(async () => {
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  const pool = ds.rows.filter((r) => r.path && r.bpp > 0 && r.cxEff > 0)
    .sort((a, b) => a.cxEff - b.cxEff);
  const picks = [];
  for (let i = 0; i < N; i += 1) picks.push(pool[Math.floor(((pool.length - 1) * i) / (N - 1))]);

  const out = { generated: Date.now(), headroomFractions: HEADROOM_FRACTIONS, films: [] };
  for (const r of picks) {
    const dur = Math.floor(Number(sh(FP, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0);
    if (!dur) continue;
    const st = Math.floor(dur * 0.2); const sp = Math.floor(dur * 0.6);
    const srcs = [];
    for (let k = 0; k < CLIPS; k += 1) {
      const s = path.join(TMP, `s${k}.mkv`);
      const p = spawnSync(FF, ['-hide_banner', '-loglevel', 'error',
        '-ss', String(st + Math.floor((sp * k) / CLIPS)), '-t', '2', '-i', r.path,
        '-c:v', 'ffv1', '-an', '-sn', '-y', s], { encoding: 'utf8', timeout: 30 * 60000 });
      if (p.status === 0) srcs.push(s);
    }
    if (!srcs.length) continue;
    // 0.6x the film's own rate, as everywhere else here, so the encoder must make visible compromises.
    const kbps = Math.round(((r.bpp * r.probeW * r.probeH * (r.fps || 24)) / 1000) * 0.6) || 2000;
    /* Base luma of the unmodified clip, so the shifts can be sized to this film's own headroom. */
    const baseM = measure(srcs[0]);
    const baseLuma = baseM && baseM.luma > 0 ? baseM.luma : 128;
    const headroom = Math.max(8, Math.min(baseLuma, 255 - baseLuma));
    const OFFSETS = HEADROOM_FRACTIONS.map((f) => (f * headroom) / 255);
    console.log(`\n${r.title}   cx ${r.cxEff.toFixed(3)}   ${kbps} kbps   base luma ${baseLuma.toFixed(1)}   headroom ${headroom.toFixed(0)}`);
    console.log(`  ${'offset'.padEnd(8)} ${'luma'.padStart(8)} ${'cambi'.padStart(9)} ${'block'.padStart(9)} ${'blur'.padStart(9)} ${'grain'.padStart(9)}`);
    const rows = [];
    for (const off of OFFSETS) {
      const acc = [];
      for (let k = 0; k < srcs.length; k += 1) {
        const o = path.join(TMP, `o${k}.mkv`);
        const vf = off === 0 ? null : `eq=brightness=${off}`;
        const p = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', srcs[k],
          ...(vf ? ['-vf', vf] : []),
          '-c:v', 'libx264', '-preset', 'medium', '-b:v', `${kbps}k`, '-threads', THREADS,
          '-an', '-sn', '-y', o], { encoding: 'utf8', timeout: 30 * 60000 });
        if (p.status !== 0) continue;
        const m = measure(o); if (m) acc.push(m);
      }
      if (!acc.length) continue;
      const av = { offset: off };
      for (const k of ['cambi', 'block', 'blur', 'grain', 'luma']) {
        const v = acc.map((x) => x[k]).filter((x) => x != null && x > 0);
        av[k] = v.length ? mean(v) : null;
      }
      rows.push(av);
      console.log(`  ${off.toFixed(3).padEnd(8)} ${(av.luma ?? 0).toFixed(1).padStart(8)} `
        + ['cambi', 'block', 'blur', 'grain'].map((k) => (av[k] == null ? '  n/a' : av[k].toFixed(4)).padStart(9)).join(' '));
    }
    out.films.push({ key: r.key, title: r.title, cxEff: r.cxEff, kbps, rows });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  }

  /* Per-film correlation between actual mean luma and each log detector. Per-film, because a
   * cross-film correlation would be dominated by films simply differing in brightness AND in
   * blockiness for unrelated reasons — the whole point is that within a film only luma changed. */
  console.log('\n\nDEGENERACY: does a detector track LUMA when nothing else changed?\n');
  const corr = (a, b) => {
    const ma = mean(a); const mb = mean(b);
    let n = 0; let da = 0; let db = 0;
    for (let i = 0; i < a.length; i += 1) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
  };
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
  /* A rung that still landed near a limit is EXCLUDED. Clipping is not a luma shift — it changes
   * structure — so regressing such a point as if it were one is exactly the error the headroom
   * scaling exists to prevent, and the guard stays even though the scaling should make it rare. */
  const SAFE = (x) => x.luma > 12 && x.luma < 243;
  console.log(`  ${'detector'.padEnd(9)} ${'median corr'.padStart(12)} ${'films'.padStart(6)}   reading`);
  for (const k of ['cambi', 'block', 'blur', 'grain']) {
    const cs = [];
    for (const f of out.films) {
      const v = f.rows.filter((x) => x[k] > 0 && x.luma > 0 && SAFE(x));
      if (v.length < 4) continue;
      cs.push(corr(v.map((x) => x.luma), v.map((x) => Math.log(x[k]))));
    }
    if (!cs.length) { console.log(`  ${k.padEnd(9)} no data`); continue; }
    const m = med(cs);
    console.log(`  ${k.padEnd(9)} ${m.toFixed(3).padStart(12)} ${String(cs.length).padStart(6)}   `
      + `${Math.abs(m) < 0.3 ? 'no material luma degeneracy' : 'TRACKS LUMA — confound, investigate'}`);
  }
  console.log(`\nwrote ${OUT}`);
})();
