#!/usr/bin/env node
/* CAN THE PANEL MEASURE A KNOWN BITRATE EQUIVALENCE? — the conclusive, label-free calibration.
 *
 * encoder-ladder.js asks whether the artifact panel RANKS encoders correctly. This asks the harder
 * and far more useful question: can it put a NUMBER on the difference, and is that number right?
 *
 * THE IDEA. x265 at a given bitrate is worth roughly 1.4-2x an x264 bitrate — the published BD-rate
 * literature has put x265 medium at 35-50% bitrate saving over x264 medium for a decade, and it is
 * about as settled as anything in video coding. So:
 *
 *   1. Encode the SAME clip with both codecs across a bitrate sweep.
 *   2. For each artifact, find the bitrate ratio at which x265 and x264 produce the SAME reading.
 *   3. That ratio is the panel's own estimate of the BD-rate saving.
 *
 * If our four detectors independently land near 1.4-2x, the panel is measuring real encode quality
 * on a real scale, and it is calibrated and validated in the same stroke — with no human labels
 * anywhere. If they land at 1.0x the panel cannot see encoder quality at all. If they scatter wildly
 * the panel is noise.
 *
 * WHY THIS IS THE TEST THAT MATTERS FOR BPP+. BPP+ divides bits by a content estimate and stops.
 * It scores an x265 file and an x264 file with the same bits and content IDENTICALLY, when one is
 * worth nearly twice the other. That is not a subtle correction — it is a systematic error of up to
 * 2x on part of the library, invisible to the current model by construction, and exactly the class
 * of error the artifact panel exists to catch.
 *
 * READ-ONLY on media; encodes 2s clips into a temp dir it removes.
 * USAGE: node scripts/bdrate-check.js [--films 6] [--clips 3]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', process.env.CONTROLLER || 'http://localhost:8088');
const N_FILMS = Number(val('--films', 6));
const CLIPS = Number(val('--clips', 3));
const SECLEN = 2;
const LEVELS = [0.4, 0.6, 0.85, 1.2, 1.7];
const OUT = val('--out', `${__dirname}/../data/bdrate-check.json`);
const FF = val('--ffmpeg', `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`);
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bdr-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const sh = (b, a) => execFileSync(b, a, { encoding: 'utf8', timeout: 30 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

const CODECS = [
  { name: 'x264', args: ['-c:v', 'libx264', '-preset', 'medium'] },
  { name: 'x265', args: ['-c:v', 'libx265', '-preset', 'medium'] },
];

function measureAll(clip) {
  const log = path.join(TMP, 'c.csv');
  try { fs.unlinkSync(log); } catch { /* */ }
  const p = spawnSync(FF, ['-hide_banner', '-loglevel', 'info', '-i', clip, '-i', clip,
    '-lavfi', `[0:v]blockdetect,blurdetect[d];[d][1:v]libvmaf=feature=name=cambi:n_threads=2:log_path=${log}:log_fmt=csv`,
    '-f', 'null', '-'], { encoding: 'utf8', timeout: 30 * 60000 });
  if (p.status !== 0) return null;
  const err = String(p.stderr || '');
  const grab = (re) => { const m = err.match(re); return m ? Number(m[1]) : null; };
  let cambi = null;
  try {
    const L = fs.readFileSync(log, 'utf8').trim().split('\n');
    const c = L[0].split(',').indexOf('cambi');
    const v = L.slice(1).map((x) => Number(x.split(',')[c])).filter(Number.isFinite);
    cambi = v.length ? mean(v) : null;
  } catch { /* */ }
  const g = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', clip, '-an', '-sn', '-vf',
    'split[a][b];[a]hqdn3d=4:3:6:4[d];[b][d]blend=all_mode=difference,'
      + 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'],
  { encoding: 'utf8', timeout: 30 * 60000 });
  const gv = String(g.stdout || '').split('\n').map((l) => /YAVG=([\d.]+)/.exec(l))
    .filter(Boolean).map((m) => Number(m[1]));
  return { cambi, block: grab(/block mean: ([0-9.]+)/), blur: grab(/blur mean: ([0-9.]+)/),
    grain: gv.length > 2 ? mean(gv.slice(1)) : null };
}

// log(artifact) = a + S*log(level), per codec per artifact. The horizontal gap between two such
// lines at equal artifact IS the bitrate ratio, and it needs no threshold to compute.
function fitLine(xs, ys) {
  const n = xs.length; if (n < 3) return null;
  const mx = mean(xs); const my = mean(ys);
  let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i += 1) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  if (!sxx) return null;
  const S = sxy / sxx;
  return { S, a: my - S * mx };
}

(async () => {
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  const pool = ds.rows.filter((r) => r.path && r.cxEff > 0 && r.bpp > 0).sort((a, b) => a.cxEff - b.cxEff);
  const picks = [];
  for (let i = 0; i < N_FILMS; i += 1) picks.push(pool[Math.floor((pool.length - 1) * i / (N_FILMS - 1))]);

  const out = { generated: Date.now(), levels: LEVELS, films: [] };
  const ratios = { cambi: [], block: [], blur: [], grain: [] };

  for (const r of picks) {
    const dur = Math.floor(Number(sh(FP, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0);
    if (!dur) continue;
    const start = Math.floor(dur * 0.15); const span = Math.floor(dur * 0.7);
    const srcs = [];
    for (let k = 0; k < CLIPS; k += 1) {
      const t = start + Math.floor((span * k) / CLIPS);
      const s = path.join(TMP, `s${k}.mkv`);
      const p = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-t', String(SECLEN),
        '-i', r.path, '-c:v', 'ffv1', '-an', '-sn', '-y', s], { encoding: 'utf8', timeout: 30 * 60000 });
      if (p.status === 0) srcs.push(s);
    }
    if (!srcs.length) continue;
    const base = Math.round((r.bpp * r.probeW * r.probeH * (r.fps || 24)) / 1000) || 3000;

    console.log(`\n${r.title}   cx ${r.cxEff.toFixed(3)}   base ${base} kbps`);
    const curves = {};
    for (const cd of CODECS) {
      const pts = [];
      for (const lv of LEVELS) {
        const acc = [];
        for (let k = 0; k < srcs.length; k += 1) {
          const o = path.join(TMP, `e${k}.mkv`);
          const p = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', srcs[k], ...cd.args,
            '-b:v', `${Math.round(base * lv)}k`, '-threads', '3', '-an', '-sn', '-y', o],
          { encoding: 'utf8', timeout: 30 * 60000 });
          if (p.status !== 0) continue;
          const m = measureAll(o); if (m) acc.push(m);
        }
        if (!acc.length) continue;
        const av = { level: lv };
        for (const k of ['cambi', 'block', 'blur', 'grain']) {
          const v = acc.map((x) => x[k]).filter((x) => x != null && x > 0);
          av[k] = v.length ? mean(v) : null;
        }
        pts.push(av);
      }
      curves[cd.name] = pts;
      console.log(`  ${cd.name}: ` + pts.map((p) => `${p.level}x cambi ${p.cambi != null ? p.cambi.toFixed(2) : '-'}`).join('  '));
    }

    // Horizontal offset between the two codecs' curves = ln(bitrate ratio).
    const row = { key: r.key, title: r.title, cxEff: r.cxEff, curves, ratio: {} };
    for (const k of ['cambi', 'block', 'blur', 'grain']) {
      const f4 = fitLine(curves.x264.filter((p) => p[k] > 0).map((p) => Math.log(p.level)),
        curves.x264.filter((p) => p[k] > 0).map((p) => Math.log(p[k])));
      const f5 = fitLine(curves.x265.filter((p) => p[k] > 0).map((p) => Math.log(p.level)),
        curves.x265.filter((p) => p[k] > 0).map((p) => Math.log(p[k])));
      if (!f4 || !f5 || !f4.S || Math.abs(f4.S) < 0.02) continue;
      /* DIVIDE ONLY BY THE STEEP SLOPE. The first version solved for where x265's own line reaches
       * x264's artifact level — x5 = (y - a5)/S5 — dividing by x265's slope, which is nearly FLAT
       * for banding: 12.04 -> 8.58 for x264 against 11.58 -> 10.42 for x265 on the same clip. That is
       * the same divide-by-a-shallow-slope error that produced m = 1e-58 in the blend, and it gave
       * cambi ratios of 4.80x, 0.43x and 0.25x on three consecutive films.
       *
       * Instead take x265's artifact AT THE CENTRE of the sweep and ask where x264's line reaches the
       * same value. Only x264's slope enters the denominator, and it is the steep, well-determined
       * one — guarded explicitly above rather than hoped for.
       *
       * CAVEAT NO ARITHMETIC FIXES: on some content the curves genuinely CROSS, because HEVC bands
       * MORE than x264 at high bitrate while blocking less. Where they cross no single ratio exists
       * and a number computed anyway would be meaningless, so it is detected and skipped. */
      const xc = 0;                            // centre of the log-level sweep
      const y5 = f5.a + f5.S * xc;             // x265's artifact there
      const x4 = (y5 - f4.a) / f4.S;           // where x264 reaches the same artifact
      const ratio = Math.exp(x4 - xc);         // >1 means x265 needs FEWER bits for the same artifact
      const lo = Math.log(Math.min(...LEVELS)); const hi = Math.log(Math.max(...LEVELS));
      const dLo = (f4.a + f4.S * lo) - (f5.a + f5.S * lo);
      const dHi = (f4.a + f4.S * hi) - (f5.a + f5.S * hi);
      if (dLo * dHi < 0) continue;             // curves cross — no consistent ratio to report
      if (Number.isFinite(ratio) && ratio > 0.2 && ratio < 8) { row.ratio[k] = ratio; ratios[k].push(ratio); }
    }
    console.log('  implied x265 advantage: ' + Object.entries(row.ratio).map(([k, v]) => `${k} ${v.toFixed(2)}x`).join('  '));
    out.films.push(row);
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  }

  console.log('\n\nTHE PANEL\'S OWN ESTIMATE OF THE x265 BITRATE ADVANTAGE');
  console.log('  published BD-rate for x265 medium vs x264 medium: roughly 1.4-2.0x\n');
  console.log(`  ${'detector'.padEnd(9)} ${'n'.padStart(4)} ${'median ratio'.padStart(13)}   verdict`);
  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  for (const k of ['cambi', 'block', 'blur', 'grain']) {
    if (!ratios[k].length) { console.log(`  ${k.padEnd(9)} ${'0'.padStart(4)}`); continue; }
    const m = med(ratios[k]);
    const v = m >= 1.3 && m <= 2.2 ? 'MATCHES the published range — the panel measures real encode quality'
      : m > 1.05 ? 'right direction, low magnitude'
        : m < 0.95 ? 'INVERTED' : 'sees no difference';
    console.log(`  ${k.padEnd(9)} ${String(ratios[k].length).padStart(4)} ${m.toFixed(2).padStart(13)}   ${v}`);
  }
  console.log(`\nwrote ${OUT}`);
})();
