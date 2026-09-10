#!/usr/bin/env node
/* CALIBRATE THE ARTIFACT-RESIDUAL CORRECTION AGAINST REAL SUBJECTIVE LABELS.
 *
 * THE QUESTION NOTHING INTERNAL CAN ANSWER. Split-half reliability showed the banding residual is
 * REPEATABLE (0.58). It cannot show that the residual is QUALITY, because a systematically
 * misspecified model produces repeatable errors too. Those two stories predict identical internal
 * statistics, and this library has no labels to separate them. Adding the best content predictor I
 * could think of (flat-area fraction) barely moved the model — R^2 0.477 -> 0.499 — so the ambiguity
 * is not going away by measuring harder.
 *
 * WHAT THIS DATASET GIVES US. MSU's CVQAD: 1080p clips, x264 at 9 bitrates per sequence
 * (433-39,381 kbps), with SUBJECTIVE SCORES from pairwise comparison (Bradley-Terry) plus MOS. So for
 * the first time there is a quality label that is external, reproducible, and NOT one person's
 * opinion — which is exactly what Brennan asked for over another A/B session.
 *
 * THE DECISIVE TEST, stated before the data finished downloading:
 *   1. Fit expected banding from bits + content, exactly as the live model does.
 *   2. Take the residual.
 *   3. Ask whether the residual predicts SUBJECTIVE score AFTER bits are already accounted for.
 *
 *   residual predicts subjective quality beyond bits  -> the framework is REAL, and the regression
 *                                                        coefficient IS the calibration constant we
 *                                                        have been unable to derive
 *   residual predicts nothing                         -> it was model misspecification all along, and
 *                                                        the correction must not ship
 *
 * WHY THIS IS THE RIGHT DATASET AND NOT KonViD/LIVE-VQC: those carry unpaired absolute MOS, which is
 * the same confound that invalidated the 2026-08-13 in-house blind test. CVQAD's Bradley-Terry scores
 * come from forced-choice pairs, so they measure a DIFFERENCE, which is what a correction needs.
 *
 * CAVEAT TO CARRY INTO ANY CONCLUSION: these are 1080p UGC/broadcast sources, not photochemical film
 * scans. The grainy half of Brennan's library is still uncertified by any public dataset — that limit
 * was established in the research round and this does not lift it.
 *
 * USAGE: node scripts/cvqad-calibrate.js [--dir data/cvqad] [--min 20]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DIR = val('--dir', `${__dirname}/../data/cvqad`);
const MIN = Number(val('--min', 20));
const FF = val('--ffmpeg', `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`);
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const CACHE = path.join(DIR, 'measured.json');

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)); };
function pearson(xs, ys) {
  const mx = mean(xs); const my = mean(ys);
  const den = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
  return den ? xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / den : 0;
}
const ranks = (v) => {
  const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = [];
  for (let k = 0; k < idx.length;) {
    let m = k; while (m + 1 < idx.length && idx[m + 1][0] === idx[k][0]) m += 1;
    const avg = (k + m) / 2 + 1;
    for (let z = k; z <= m; z += 1) r[idx[z][1]] = avg;
    k = m + 1;
  }
  return r;
};
const spearman = (xs, ys) => pearson(ranks(xs), ranks(ys));
function ols(X, y) {
  const p = X[0].length;
  const A = Array.from({ length: p }, (_, i) => Array.from({ length: p + 1 }, (_, j) => (j < p
    ? X.reduce((s, r) => s + r[i] * r[j], 0) : X.reduce((s, r, k) => s + r[i] * y[k], 0))));
  for (let c = 0; c < p; c += 1) {
    let piv = c;
    for (let r = c + 1; r < p; r += 1) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < p; r += 1) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j <= p; j += 1) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((row, i) => row[p] / A[i][i]);
}
const L = (v) => Math.log(Math.max(v, 1e-4));
const sh = (bin, a) => execFileSync(bin, a, { encoding: 'utf8', timeout: 20 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });

// TRAP — THE DISTRIBUTED FILES ARE NOT THE COMPRESSED FILES. Verified 2026-08-25 by ffprobe: every
// clip in the corpus is an HEVC RE-ENCODE at 10-49 Mbps of the x264-compressed video, not the x264
// bitstream itself. `basketball-2021/fast/x264_100` has a container bitrate of 10,524 kbps; the CSV's
// `real_bitrate` for that clip is 90 kbps. That is a factor of 117. The artifacts are baked in (which
// is what we measure), but the CONTAINER BITRATE IS MEANINGLESS as a compression level.
//
// So bits must come from the CSV (`real_bitrate`, carried into subset.json as `kbps`) and the pixel
// rate from the CSV's `fps` — never from ffprobe. The first version of this script merged
// `{...meta, ...measured}`, which let the render's bitrate clobber the true one, and would have run
// the decisive test on a bpp axis that was 100x wrong and only loosely monotonic in real bitrate.
// `renderKbps` is kept for diagnostics only and must never enter a model.
//
// Everything else the live probe measures — CAMBI, flat-area, luma — is read off the pixels and is
// unaffected. Caveat to carry: the HEVC pass could itself smooth a little banding, which would bias
// the test TOWARD "no signal"; a positive result is therefore conservative, a null one is not proof.
// `have` is the previous record for this clip, if any. Flat-area and luma are read off the pixels
// and cannot change between runs, so a re-measure that exists only to add blocking and blur reuses
// them and skips two of the three decodes — the difference between one overnight and two.
function measure(file, have = null) {
  const w = Number(sh(FP, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width',
    '-of', 'default=nw=1:nk=1', file]).trim()) || 0;
  const h = Number(sh(FP, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height',
    '-of', 'default=nw=1:nk=1', file]).trim()) || 0;
  const fpsRaw = sh(FP, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate',
    '-of', 'default=nw=1:nk=1', file]).trim();
  const [a, b] = fpsRaw.split('/').map(Number);
  const fps = b ? a / b : a;
  const renderKbps = Number(sh(FP, ['-v', 'error', '-show_entries', 'format=bit_rate',
    '-of', 'default=nw=1:nk=1', file]).trim()) / 1000 || 0;

  // CAMBI, same-file reference — identical to probe-banding.sh. blockdetect and blurdetect ride the
  // SAME decode, exactly as banding-ladder.js chains them: they are pure analysis filters, so the
  // third and fourth artifacts cost no extra pass. They report as a summary line on stderr at
  // loglevel info rather than through the metadata sink, hence spawnSync instead of sh().
  const log = path.join('/tmp', `cq-${process.pid}.csv`);
  try { fs.unlinkSync(log); } catch { /* */ }
  const cp = spawnSync(FF, ['-hide_banner', '-loglevel', 'info', '-i', file, '-i', file,
    '-lavfi', `[0:v]blockdetect,blurdetect[d];[d][1:v]libvmaf=feature=name=cambi:n_threads=3:log_path=${log}:log_fmt=csv`,
    '-f', 'null', '-'], { encoding: 'utf8', timeout: 20 * 60000 });
  if (cp.status !== 0) throw new Error(`ffmpeg exit ${cp.status}: ${String(cp.stderr).slice(-200)}`);
  const grab = (re) => { const m = re.exec(String(cp.stderr)); return m ? +Number(m[1]).toFixed(5) : null; };
  const block = grab(/block mean: ([0-9.]+)/);
  const blur = grab(/blur mean: ([0-9.]+)/);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  const col = lines[0].split(',').indexOf('cambi');
  const cvals = lines.slice(1).map((l) => Number(l.split(',')[col])).filter(Number.isFinite);
  try { fs.unlinkSync(log); } catch { /* */ }

  // Flat-area fraction and luma, same recipe as scripts/flat-area.js.
  let flat = have && have.flat != null ? have.flat : null;
  let luma = have && have.luma != null ? have.luma : null;
  if (flat == null) {
    const flatOut = sh(FF, ['-hide_banner', '-loglevel', 'error', '-i', file, '-an', '-sn',
      '-vf', "scale=960:-2,sobel,lutyuv=y='if(lt(val,12),255,0)',signalstats,"
        + 'metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-']);
    const fvals = String(flatOut).split('\n').map((l) => /YAVG=([\d.]+)/.exec(l)).filter(Boolean)
      .map((m) => Number(m[1]) / 255);
    flat = fvals.length ? +mean(fvals).toFixed(5) : null;
  }
  if (luma == null) {
    const lumaOut = sh(FF, ['-hide_banner', '-loglevel', 'error', '-i', file, '-an', '-sn',
      '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-']);
    const lvals = String(lumaOut).split('\n').map((l) => /YAVG=([\d.]+)/.exec(l)).filter(Boolean)
      .map((m) => Number(m[1]));
    luma = lvals.length ? +mean(lvals).toFixed(2) : null;
  }

  /* GRAIN RETENTION on the labelled corpus. Same recipe as banding-ladder.js grainOf(). It is here
   * because the grain THRESHOLD is now the largest unknown in the model — sweeping it from 0.85 to
   * 0.97 moves the median library multiplier from x2.26 to x0.88 — and this corpus is the only
   * external source of subjective labels we have. Cheap to add: one more decode on clips we are
   * already opening.
   *
   * EXPECT IT TO BE WEAK, and say so before looking. CVQAD is 1080p UGC and broadcast, not
   * photochemical film scans, so its grain dynamic range is probably too narrow to place a threshold
   * that has to serve The Big Sleep. A null here does not clear grain; it just means this corpus
   * cannot answer, which is what the research round already concluded about the grainy half. */
  const gp = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', file, '-an', '-sn', '-vf',
    'split[a][b];[a]hqdn3d=4:3:6:4[d];[b][d]blend=all_mode=difference,'
      + 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-f', 'null', '-'], { encoding: 'utf8', timeout: 20 * 60000 });
  const gv = String(gp.stdout || '').split('\n')
    .map((l) => /YAVG=([\d.]+)/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  const guse = gv.length > 2 ? gv.slice(1) : gv;      // hqdn3d's temporal term has no history on frame 1
  const grain = guse.length ? +mean(guse).toFixed(5) : null;

  return {
    w, h, renderFps: fps, renderKbps, block, blur, flat, luma, grain,
    cambi: cvals.length ? +mean(cvals).toFixed(5) : null,
  };
}

(async () => {
  const subset = JSON.parse(fs.readFileSync(path.join(DIR, 'subset.json'), 'utf8'));
  const byFile = new Map(subset.map((o) => [o.path.replace('Compressed_and_GT_videos/', '').replace(/\//g, '__'), o]));
  let done = {};
  try { done = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { /* first run */ }

  const clipDir = path.join(DIR, 'clips');
  const present = fs.existsSync(clipDir) ? fs.readdirSync(clipDir).filter((f) => f.endsWith('.mp4')) : [];
  console.log(`${present.length} clips on disk, ${Object.keys(done).length} already measured`);

  let n = 0;
  for (const f of present) {
    // Resume on CONTENT, not on presence. Clips measured before blockdetect/blurdetect joined the
    // chain carry no `block`, and skipping them would silently leave the two thresholds we actually
    // need unmeasured on two thirds of the corpus.
    if (done[f] && done[f].block !== undefined && done[f].grain !== undefined) continue;
    const meta = byFile.get(f);
    if (!meta) continue;
    const full = path.join(clipDir, f);
    // The download runs concurrently and deletes partial files on failure, so a name from readdir
    // can be gone by the time we stat it. Skip rather than crash — the run is resumable.
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.size < 100000) continue;                        // still downloading
    try {
      const m = measure(full, done[f] || null);
      // Bits and frame rate come from the CSV, geometry from the file. See the trap note above.
      const fps = Number(meta.fps) || m.renderFps;
      const px = m.w * m.h * fps;
      const bpp = px && meta.kbps > 0 ? +((meta.kbps * 1000) / px).toFixed(6) : null;
      done[f] = { ...m, ...meta, fps, bpp };
      fs.writeFileSync(CACHE, JSON.stringify(done, null, 1));
      n += 1;
      console.log(`  [${n}] ${meta.seq}/${meta.preset} ${meta.crf}  ${meta.kbps} kbps  bpp ${bpp}  `
        + `cambi ${m.cambi}  block ${m.block}  blur ${m.blur}  MOS ${meta.mos.toFixed(2)}`);
    } catch (e) { console.log(`  FAILED ${f}: ${String(e.message).slice(0, 80)}`); }
  }

  const rows = Object.values(done).filter((r) => r.cambi != null && r.bpp > 0 && r.mos != null
    && r.bt != null && r.flat != null);
  console.log(`\n${rows.length} measured clips with labels`);
  if (rows.length < MIN) { console.log(`need at least ${MIN} — re-run as more download`); return; }

  const seqs = [...new Set(rows.map((r) => r.seq))];
  console.log(`${seqs.length} distinct sequences, `
    + `${(rows.length / seqs.length).toFixed(1)} bitrate points each on average`);

  const y = rows.map((r) => L(r.cambi));
  const design = (r) => [1, L(r.bpp), r.flat, r.luma / 100];
  const beta = ols(rows.map(design), y);
  const fit = rows.map((r) => design(r).reduce((s, v, i) => s + v * beta[i], 0));
  const my = mean(y);
  console.log(`\nEXPECTED-BANDING MODEL on labelled data: R^2 `
    + `${(1 - y.reduce((s, v, i) => s + (v - fit[i]) ** 2, 0) / y.reduce((s, v) => s + (v - my) ** 2, 0)).toFixed(3)}`);
  const resid = rows.map((r, i) => y[i] - fit[i]);

  // Demean any vector within sequence. This is the fixed-effects trick, and it is what turns a
  // pooled correlation into a WITHIN-SEQUENCE one: after demeaning, all between-sequence level
  // differences are gone and only "how this clip compares to other encodes OF THE SAME SOURCE"
  // remains. That is the exact question the correction asks, and the pooled version cannot answer it
  // — it is the between-vs-within confound that has bitten this project twice already.
  const demean = (v) => {
    const acc = new Map();
    rows.forEach((r, i) => {
      const a = acc.get(r.seq) || { s: 0, n: 0 };
      a.s += v[i]; a.n += 1; acc.set(r.seq, a);
    });
    return v.map((x, i) => x - acc.get(rows[i].seq).s / acc.get(rows[i].seq).n);
  };

  // ---- THE DECISIVE TEST ----------------------------------------------------------------------
  // Run for both labels. Bradley-Terry is PRIMARY: it comes from forced-choice pairs, so it measures
  // a difference, which is what a correction needs. Unpaired MOS is the design that invalidated the
  // 2026-08-13 in-house test, so it is reported only as a cross-check.
  const LABELS = [['Bradley-Terry (primary)', (r) => r.bt], ['MOS (cross-check)', (r) => r.mos]];
  let calib = null;

  for (const [labelName, get] of LABELS) {
    const q = rows.map(get);
    console.log(`\n=== ${labelName} ===`);
    console.log(`  bits alone vs label        pearson ${pearson(rows.map((r) => L(r.bpp)), q).toFixed(3)}  `
      + `spearman ${spearman(rows.map((r) => L(r.bpp)), q).toFixed(3)}`);
    console.log(`  raw banding vs label       pearson ${pearson(y, q).toFixed(3)}  spearman ${spearman(y, q).toFixed(3)}`);

    // (a) POOLED — regress label on bits, ask whether the banding residual explains what is LEFT.
    const qb = ols(rows.map((r) => [1, L(r.bpp)]), q);
    const qResid = rows.map((r, i) => q[i] - (qb[0] + qb[1] * L(r.bpp)));
    console.log(`  POOLED  label-after-bits vs banding-residual   pearson ${pearson(resid, qResid).toFixed(3)}  `
      + `spearman ${spearman(resid, qResid).toFixed(3)}`);

    // (b) WITHIN-SEQUENCE — the honest form. Demean bits, banding and label within each sequence
    // first, so every comparison is between encodes of the SAME source.
    const wBits = demean(rows.map((r) => L(r.bpp)));
    const wBand = demean(y);
    const wQ = demean(q);
    const wb = ols(wBits.map((b) => [1, b]), wQ);
    const wQResid = wQ.map((v, i) => v - (wb[0] + wb[1] * wBits[i]));
    const bb = ols(wBits.map((b) => [1, b]), wBand);
    const wBandResid = wBand.map((v, i) => v - (bb[0] + bb[1] * wBits[i]));
    const rr = pearson(wBandResid, wQResid);
    console.log(`  WITHIN  label-after-bits vs banding-residual   pearson ${rr.toFixed(3)}  `
      + `spearman ${spearman(wBandResid, wQResid).toFixed(3)}   <- THE TEST`);
    console.log(`  ${Math.abs(rr) > 0.3 ? 'THE FRAMEWORK IS REAL — banding carries quality information bits do not.'
      : Math.abs(rr) > 0.15 ? 'WEAK but present — real, small, and the coefficient would be poorly determined.'
        : 'NO SIGNAL — the residual was model misspecification. Do NOT ship the correction.'}`);

    // The sign matters as much as the size. MORE banding than bits predict must cost quality, so the
    // correlation has to be NEGATIVE. A positive one falsifies the mechanism even if it is strong.
    if (rr > 0.15) console.log('  WARNING: sign is POSITIVE — more banding reading as BETTER quality falsifies the mechanism.');

    if (labelName.startsWith('Bradley') && rr < -0.15) {
      calib = { rr, cb: ols(wBandResid.map((v) => [1, v]), wQResid), bitSlope: wb[1] };
    }
  }

  if (calib) {
    // The regression slope IS the calibration constant: how much subjective score a unit of
    // log-residual is worth, both measured WITHIN sequence so the units are commensurable.
    console.log(`\nCALIBRATION (within-sequence, Bradley-Terry)`);
    console.log(`  d(score) / d(log banding residual) = ${calib.cb[1].toFixed(4)}`);
    console.log(`  d(score) / d(log bpp)             = ${calib.bitSlope.toFixed(4)}`);
    const bppEquiv = calib.cb[1] / calib.bitSlope;
    console.log(`  => 1.0 of log-residual is worth ${bppEquiv.toFixed(4)} of log-bpp`);
    console.log(`  => BPP+ shift = BPP+ * (exp(${(bppEquiv / 2).toFixed(4)} * REL * residual) - 1)`);
    console.log('  (the /2 is the sqrt in BPP+; REL is the reliability shrink, Kelley\'s correction)');
  }
})();
