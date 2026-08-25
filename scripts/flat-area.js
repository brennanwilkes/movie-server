#!/usr/bin/env node
/* FLAT-AREA FRACTION — the predictor the expected-banding model is missing.
 *
 * WHY. The artifact-residual correction (docs/DESIGN-ARTIFACT-RESIDUAL.md) is blocked on one thing:
 * its expected-banding model only reaches R^2 0.488, so a large part of the residual it corrects
 * scores with is MODEL FAILURE rather than quality. That is why 2001: A Space Odyssey — cambi 0.32,
 * BELOW the library median — took the maximum penalty. Reliability shrinkage handles noise; it cannot
 * handle misspecification.
 *
 * The current content predictors are proxies: `year` stands in for capture medium, `luma` for "dark
 * scenes band more". Neither captures the thing that physically decides whether a film CAN band:
 * HOW MUCH OF THE FRAME IS A LARGE SMOOTH GRADIENT. A film that is 40% sky bands where one that is
 * all texture cannot, at any bitrate.
 *
 * HOW IT IS MEASURED. Sobel edge magnitude, thresholded, then averaged: the mean of a binary
 * "this pixel sits in a flat neighbourhood" mask IS the flat-area fraction. Downscaled to 960 wide
 * first so grain does not register as edge detail — grain is exactly what we want to see THROUGH
 * here, since the question is about the underlying gradient, and a grainy sky is still a sky.
 *
 * *** READ FROM THE SOURCE, NOT A LOSSLESS INTERMEDIATE, AND THAT IS DELIBERATE. *** CAMBI needs a
 * lossless extract because it measures the compression's own damage. Flat-area fraction measures the
 * CONTENT, so the source is the right input and it is ~7x faster (3s per clip against 20s), because
 * decoding h264 beats decoding a 1480x1080 ffv1 intermediate.
 *
 * WHY NOT `siti`. SI is one number for the whole frame — the standard deviation of its Sobel image.
 * A frame with heavy texture in one corner and a big flat sky in the other has HIGH SI and still
 * bands. Fraction-of-area is the quantity the physics cares about; SI is a summary that averages it
 * away. `siti` is in this build and was tested; it is the weaker measure and it is 7x slower.
 *
 * SAFETY: reads sources read-only, writes nothing but its own output JSON.
 *
 * USAGE: node scripts/flat-area.js [--clips 4] [--seclen 2] [--threshold 12] [--only-banding]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', process.env.CONTROLLER || 'http://localhost:8088');
const CLIPS = Number(val('--clips', 4));
const SECLEN = Number(val('--seclen', 2));
// Sobel magnitude below this counts as "flat". 12 of 255 is a gentle gradient — not a hard edge, not
// pure noise. Round number on purpose: a fitted threshold would be false precision when the thing it
// feeds is itself being vetted.
const TH = Number(val('--threshold', 12));
const WIDTH = Number(val('--width', 960));
const OUT = val('--out', `${__dirname}/../data/flat-area.json`);
const FF = val('--ffmpeg', `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`);
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const ONLY_BANDING = has('--only-banding');

const sh = (bin, a) => execFileSync(bin, a, { encoding: 'utf8', timeout: 10 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });

function flatOf(file, t) {
  // One pass: scale -> sobel -> threshold to a binary mask -> mean of the mask. YAVG/255 is then the
  // fraction of pixels in a flat neighbourhood, straight out of signalstats.
  const out = sh(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-t', String(SECLEN),
    '-i', file, '-an', '-sn',
    '-vf', `scale=${WIDTH}:-2,sobel,lutyuv=y='if(lt(val,${TH}),255,0)',signalstats,`
      + 'metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-f', 'null', '-']);
  const vs = String(out).split('\n').map((l) => /YAVG=([\d.]+)/.exec(l)).filter(Boolean)
    .map((m) => Number(m[1]) / 255);
  if (!vs.length) return null;
  return {
    flat: +(vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(5),
    // Frame-to-frame variability of the flat fraction. A film that alternates between wide skies and
    // dense interiors is differently banding-prone from one uniformly smooth throughout, and the
    // mean alone cannot tell them apart.
    flatSd: +Math.sqrt(vs.reduce((s, v) => s + (v - vs.reduce((a, b) => a + b, 0) / vs.length) ** 2, 0)
      / Math.max(1, vs.length - 1)).toFixed(5),
    frames: vs.length,
  };
}

(async () => {
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  let rows = ds.rows.filter((r) => r.path && r.complexity > 0);
  if (ONLY_BANDING) rows = rows.filter((r) => r.cambi != null);
  console.log(`${rows.length} units, ${CLIPS} clips x ${SECLEN}s, sobel<${TH} at ${WIDTH}px wide\n`);

  const out = { generated: Date.now(), clips: CLIPS, seclen: SECLEN, threshold: TH, width: WIDTH, rows: [] };
  let i = 0;
  for (const r of rows) {
    i += 1;
    const dur = Math.floor(Number(sh(FP, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0);
    if (!dur) { console.log(`[${i}/${rows.length}] ${r.title} — no duration`); continue; }
    const start = Math.floor(dur * 0.05); const span = Math.floor(dur * 0.90);
    const per = [];
    for (let k = 0; k < CLIPS; k += 1) {
      const t = start + Math.floor((span * k) / CLIPS);
      try { const f = flatOf(r.path, t); if (f) per.push(f); } catch { /* skip clip */ }
    }
    if (!per.length) { console.log(`[${i}/${rows.length}] ${r.title} — all clips failed`); continue; }
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const rec = {
      key: r.key, title: r.title, kind: r.kind,
      flat: +mean(per.map((p) => p.flat)).toFixed(5),
      flatSd: +mean(per.map((p) => p.flatSd)).toFixed(5),
      // Between-clip spread of the flat fraction: does the film change character scene to scene?
      flatBetween: +Math.sqrt(per.reduce((s, p) => s + (p.flat - mean(per.map((q) => q.flat))) ** 2, 0)
        / Math.max(1, per.length - 1)).toFixed(5),
      clips: per.length,
    };
    out.rows.push(rec);
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(`[${i}/${rows.length}] ${r.title.slice(0, 36).padEnd(38)} flat ${rec.flat.toFixed(3)}  `
      + `within-clip sd ${rec.flatSd.toFixed(3)}  between-clip sd ${rec.flatBetween.toFixed(3)}`);
  }
  console.log(`\nwrote ${OUT} (${out.rows.length} units)`);
})();
