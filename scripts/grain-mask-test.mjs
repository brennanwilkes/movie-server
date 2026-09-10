/* DOES FLAT-REGION MASKING CHANGE THE GRAIN SLOPE? — the decisive test on the research report.
 *
 * GRAIN-ARTIFACT-REPORT.md 2.1 says grainOf() is "fatally" flawed without flat-region masking, and
 * every published grain estimator agrees (Norkin AV1 2018, Style-FG TOMM 2025, FGA-NN ICIP 2025).
 * The report also concedes the ladder case: same scenes, same clips, only bitrate changes, so
 * contamination "cancels in the ratio — the slope may still be valid".
 *
 * THAT CONCESSION IS TOO GENEROUS AND IT MATTERS. Contamination cancels only if it is MULTIPLICATIVE.
 * Edge smearing is ADDITIVE:
 *
 *     residual = grain(bitrate) + edge_junk         edge_junk roughly constant with bitrate
 *
 * so the measured slope is DILUTED by whatever share of the residual is edge_junk, not cancelled.
 * That predicts exactly what the first ladder film showed: Full Metal Jacket, a famously grainy
 * title, moved only 5% across a 3x bitrate range (S +0.048). Either grain genuinely barely responds,
 * or most of what we are measuring is not grain.
 *
 * THE TEST. Same clips, same rungs, measured both ways:
 *   unmasked   mean |frame - hqdn3d(frame)|                      (what is running now)
 *   masked     the same, but only where the SOURCE is flat       (what the literature requires)
 *
 * The mask is built from the LOSSLESS SOURCE, never the encoded rung. Taking it from the encoded
 * frame would be a confound in its own direction: starvation smooths detail, so more of the frame
 * reads flat at low bitrate and the mask would widen exactly as grain disappears.
 *
 * READ-ONLY on media; encodes only 2s clips into a temp dir it removes.
 * USAGE: node scripts/grain-mask-test.mjs [--key mv:445] [--clips 3]
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const KEY = val('--key', '');
const CLIPS = Number(val('--clips', 3));
const SECLEN = 2;
const LEVELS = [1.5, 1.0, 0.7, 0.5, 0.3];
const FF = `${process.cwd()}/tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`;
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gmask-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const run = (a) => spawnSync(FF, a, { encoding: 'utf8', timeout: 20 * 60000 });
const yavg = (out) => String(out).split('\n').map((l) => /YAVG=([\d.]+)/.exec(l))
  .filter(Boolean).map((m) => Number(m[1]));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

function unmasked(clip) {
  const p = run(['-hide_banner', '-loglevel', 'error', '-i', clip, '-an', '-sn', '-vf',
    'split[a][b];[a]hqdn3d=4:3:6:4[d];[b][d]blend=all_mode=difference,'
    + 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-']);
  const v = yavg(p.stdout); return v.length > 2 ? mean(v.slice(1)) : mean(v);
}

/* Masked: the residual multiplied by a flat-region indicator taken from the source. blend=multiply
 * gives A*B/255, and the mask is 0 or 255, so the result is the residual inside flat regions and
 * zero outside. The mean therefore carries a constant factor of the flat-area fraction — which is
 * identical for every rung of a film because the mask comes from the same source clip, so it cannot
 * touch the slope. */
function masked(clip, src) {
  const p = run(['-hide_banner', '-loglevel', 'error', '-i', clip, '-i', src, '-an', '-sn',
    '-filter_complex',
    '[0:v]split[a][b];[a]hqdn3d=4:3:6:4[d];[b][d]blend=all_mode=difference[diff];'
    + "[1:v]sobel,lutyuv=y='if(lt(val,14),255,0)'[mask];"
    + '[diff][mask]blend=all_mode=multiply,signalstats,'
    + 'metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-']);
  const v = yavg(p.stdout); return v.length > 2 ? mean(v.slice(1)) : mean(v);
}

const fit = (xs, ys) => {
  const n = xs.length;
  const mx = mean(xs); const my = mean(ys);
  let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i += 1) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const S = sxy / sxx; const a = my - S * mx;
  let ss = 0; let tt = 0;
  for (let i = 0; i < n; i += 1) { ss += (ys[i] - (a + S * xs[i])) ** 2; tt += (ys[i] - my) ** 2; }
  return { S, r2: tt ? 1 - ss / tt : 0 };
};

const ds = await (await fetch('http://localhost:8088/api/probe/dataset')).json();
const picks = KEY ? [ds.rows.find((r) => r.key === KEY)]
  // Two grainy, two clean — the contrast is the point. If masking only changes the grainy ones,
  // the diluting term really is edge/texture rather than grain.
  : ['mv:490', 'mv:924', 'mv:577', 'mv:591'].map((k) => ds.rows.find((r) => r.key === k));

for (const r of picks.filter(Boolean)) {
  const dur = Math.floor(Number(spawnSync(FP, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', r.path], { encoding: 'utf8' }).stdout) || 0);
  if (!dur) continue;
  const start = Math.floor(dur * 0.15); const span = Math.floor(dur * 0.7);
  const srcs = [];
  for (let k = 0; k < CLIPS; k += 1) {
    const t = start + Math.floor((span * k) / CLIPS);
    const out = path.join(TMP, `s${k}.mkv`);
    const p = run(['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-t', String(SECLEN),
      '-i', r.path, '-c:v', 'ffv1', '-an', '-sn', '-y', out]);
    if (p.status === 0) srcs.push(out);
  }
  if (!srcs.length) continue;
  const kbps = Math.round((r.bpp * r.width * r.height * (r.fps || 24)) / 1000) || 3000;

  console.log(`\n${r.title}   cx ${r.cxEff?.toFixed(3)}   ~${kbps} kbps`);
  console.log(`  ${'level'.padStart(6)} ${'unmasked'.padStart(10)} ${'masked'.padStart(10)}`);
  const pts = [];
  for (const lv of LEVELS) {
    const um = []; const ma = [];
    for (let k = 0; k < srcs.length; k += 1) {
      const enc = path.join(TMP, `e${k}.mkv`);
      const p = run(['-hide_banner', '-loglevel', 'error', '-i', srcs[k], '-c:v', 'libx264',
        '-b:v', `${Math.round(kbps * lv)}k`, '-preset', 'medium', '-threads', '2',
        '-an', '-sn', '-y', enc]);
      if (p.status !== 0) continue;
      um.push(unmasked(enc)); ma.push(masked(enc, srcs[k]));
    }
    if (!um.length) continue;
    pts.push({ lv, u: mean(um), m: mean(ma) });
    console.log(`  ${String(lv).padStart(6)} ${mean(um).toFixed(4).padStart(10)} ${mean(ma).toFixed(4).padStart(10)}`);
  }
  if (pts.length >= 3) {
    const x = pts.map((p) => Math.log(p.lv));
    const fu = fit(x, pts.map((p) => Math.log(p.u)));
    const fm = fit(x, pts.map((p) => Math.log(p.m)));
    const swingU = Math.max(...pts.map((p) => p.u)) / Math.min(...pts.map((p) => p.u));
    const swingM = Math.max(...pts.map((p) => p.m)) / Math.min(...pts.map((p) => p.m));
    console.log(`  slope  unmasked ${fu.S.toFixed(3)} (r2 ${fu.r2.toFixed(3)}, swing ${swingU.toFixed(2)}x)`
      + `   masked ${fm.S.toFixed(3)} (r2 ${fm.r2.toFixed(3)}, swing ${swingM.toFixed(2)}x)`);
    console.log(`  => masking changes the slope by ${(fm.S / fu.S).toFixed(2)}x`);
  }
}
