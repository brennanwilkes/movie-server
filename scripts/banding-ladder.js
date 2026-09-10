#!/usr/bin/env node
/* BANDING vs BITRATE, PER FILM — measuring the slope the correction divides by.
 *
 * Brennan: "you can compare the ratios at different compressions too to see how it scales / curves,
 * to predict how much to shift bpp+ by — a HUGE swing or just a small one."
 *
 * That is the missing calibration and it is measurable. The shift arithmetic is
 *      shift = BPP+ * (exp(-REL*residual / (2*|S|)) - 1),      S = d log(cambi) / d log(bpp)
 * so S is the exchange rate between "how much artifact" and "how many bits". A cross-film S can be
 * fitted from the library (it is -1.78), but it assumes every film's banding responds to bitrate at
 * the same rate, and that is exactly the assumption worth testing:
 *
 *   FLAT RESPONDER      banding barely moves as bits are removed -> a given excess implies a LARGE
 *                       bitrate error -> BIG shift
 *   SENSITIVE RESPONDER banding climbs steeply -> the same excess implies a SMALL bitrate error ->
 *                       SMALL shift
 *
 * Same residual, opposite corrections. Only a per-film slope separates them.
 *
 * METHOD, deliberately the same shape as probe-starve.sh so the two are comparable: extract clips
 * once, losslessly; re-encode each to a series of bitrate fractions; measure CAMBI at every level.
 * Level 1.0 is the untouched clip and is the control.
 *
 * STARVED WITH x264, not x265, for the reason the codec-confound arm established: 831 of 898 movies
 * here are h264, so an h264-shaped starvation is the library-realistic one. Using x265 would measure
 * a codec-matching artefact instead of a bitrate effect.
 *
 * SAFETY: reads sources read-only, writes only into a /tmp scratch dir it removes on exit. Re-encodes
 * CLIPS, never media.
 *
 * USAGE: node scripts/banding-ladder.js [--films 4] [--clips 4] [--seclen 2] [--keys k1,k2]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', process.env.CONTROLLER || 'http://localhost:8088');
const N_FILMS = Number(val('--films', 4));
const CLIPS = Number(val('--clips', 4));
const SECLEN = Number(val('--seclen', 2));
// Spans ABOVE and BELOW the operating point, densely, because the local slope AT the operating point
// is the quantity that matters — it says whether this copy sits pre-knee (bits would help) or
// post-knee (they would not). The old 1.0/0.7/0.5/0.35/0.25 ladder spent four of its five points deep
// in starvation territory, where the answer is already obvious, and only one near the decision.
const LEVELS = val('--levels', '1.3 1.15 1.0 0.85 0.7').split(/\s+/).map(Number);
const KEYS = (val('--keys', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
const OUT = val('--out', `${__dirname}/../data/banding-ladder.json`);
const FF = val('--ffmpeg', `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`);
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const THREADS = Number(val('--threads', 3));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bladder-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const sh = (bin, a) => execFileSync(bin, a, { encoding: 'utf8', timeout: 30 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });

/* THREE ARTIFACTS OFF ONE DECODE (added 2026-08-25).
 *
 * Banding alone can say something actionable about ~5% of the library: of 247 films measured, 16%
 * band above the visibility threshold and the ladder suggests only about a third of those are
 * bitrate-responsive. It is a specialist instrument, not a quality axis, and the half of the library
 * it is blind to is the grainy half — which is exactly the half that broke the cross-film model.
 *
 * So the ladder now measures BLOCKING and BLUR at every rung as well. They come almost free:
 * `blockdetect` and `blurdetect` are pass-through analysis filters, so chaining them ahead of
 * libvmaf shares the single decode instead of doubling it — the same trick probe-film.sh uses to get
 * them alongside the complexity encode. The expensive part of a ladder is the starvation encode, and
 * that is already paid.
 *
 * WHY MEASURE THEM ON A LADDER AT ALL, when blockMean has been graded already: reliability says a
 * detector agrees with itself, not that it is measuring an ARTIFACT. blockMean grades at 0.922, but a
 * detector of frame structure would score just as well — films differ consistently in edge content.
 * The discriminating test is whether the reading MOVES when bits are taken away. An artifact detector
 * must rise under starvation; a content statistic will sit flat. That test needs a ladder and nothing
 * else provides it.
 */
function measureOf(clip) {
  const log = path.join(TMP, 'c.csv');
  try { fs.unlinkSync(log); } catch { /* */ }
  // loglevel `info` because blockdetect/blurdetect report their means on stderr at that level, and
  // spawnSync rather than the execFileSync helper because stderr is where the answer is.
  const p = spawnSync(FF, ['-hide_banner', '-loglevel', 'info', '-i', clip, '-i', clip,
    '-lavfi', `[0:v]blockdetect,blurdetect[d];[d][1:v]libvmaf=feature=name=cambi:n_threads=${THREADS}:log_path=${log}:log_fmt=csv`,
    '-f', 'null', '-'], { encoding: 'utf8', timeout: 30 * 60000 });
  if (p.status !== 0) throw new Error(`ffmpeg failed: ${String(p.stderr).slice(-200)}`);
  const err = String(p.stderr || '');
  const grab = (re) => { const m = err.match(re); return m ? Number(m[1]) : null; };
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  const col = lines[0].split(',').indexOf('cambi');
  const vals = col < 0 ? []
    : lines.slice(1).map((l) => Number(l.split(',')[col])).filter(Number.isFinite);
  return {
    cambi: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
    block: grab(/block mean: ([0-9.]+)/),
    blur: grab(/blur mean: ([0-9.]+)/),
    grain: grainOf(clip),
  };
}

/* GRAIN RETENTION — the fourth artifact, and the one the panel was missing.
 *
 * WHY IT HAD TO BE ADDED (measured 2026-08-25). Under max-over-artifacts the binding constraint is
 * whichever artifact appears first as bits come off. That works on smooth films — Dune's blocking
 * binds and lands it at x0.49 with no guard of any kind. It fails completely on grainy ones, because
 * BOTH detectors we had go quiet there:
 *
 *     corr(|S_block|, complexity) = -0.459      blocking stops responding as grain rises
 *
 * The Godfather's blocking slope is -0.03, Ocean's Eleven -0.03, The Big Sleep -0.06 — inert. So the
 * max was taken over a set that had nothing to say, and banding's leftover headroom won by default:
 * 110 -> 782. That is not a numerical defect to be capped, it is a hole in the covering set, exactly
 * where Brennan predicted it would be.
 *
 * WHAT IS MEASURED. Mean |frame - denoised(frame)|: the texture energy an encoder has to pay for and
 * is tempted to throw away. As bits come off, the encoder smooths grain, so this FALLS — the opposite
 * direction to banding and blocking, which is why it catches what they miss.
 *
 * WHY THE OLD OBJECTION DOES NOT APPLY. probe-grain.sh records that an atadenoise-residual detector
 * was tried and rejected: it read MOTION, r=+0.988 across three similarly-paced films and collapsing
 * to -0.050 when Raiders was added. That was fatal for a CROSS-FILM absolute. Here every rung is the
 * same scenes of the same film at a different bitrate, so motion is identical in all of them and
 * cancels in the ratio — the same argument that makes probe-grain.sh's own two-pass ratio valid.
 *
 * It is a second decode rather than another branch of the libvmaf graph: ~40% more time per rung,
 * against the risk of a six-input filtergraph failing silently overnight. */
function grainOf(clip) {
  const p = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', clip, '-an', '-sn',
    '-vf', 'split[a][b];[a]hqdn3d=4:3:6:4[d];[b][d]blend=all_mode=difference,'
      + 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-f', 'null', '-'], { encoding: 'utf8', timeout: 30 * 60000 });
  if (p.status !== 0) return null;
  const v = String(p.stdout || '').split('\n')
    .map((l) => /YAVG=([\d.]+)/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  // The first frame has no denoiser history, so hqdn3d's temporal term has not converged and the
  // residual reads near zero. Dropping it matters: at 4 clips of 2s that is 1 frame in ~48.
  const use = v.length > 2 ? v.slice(1) : v;
  return use.length ? +(use.reduce((a, b) => a + b, 0) / use.length).toFixed(5) : null;
}

// log-log least squares: log(cambi) = a + S*log(level). Because the starved bitrate is level*src,
// log(level) IS log(bpp) up to a constant, so the fitted slope is exactly d log(cambi)/d log(bpp).
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

function slope(pts, field = 'cambi') {
  const p = pts.filter((x) => x[field] > 0 && x.level > 0);
  if (p.length < 3) return null;
  const xs = p.map((x) => Math.log(x.level)); const ys = p.map((x) => Math.log(x[field]));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length; const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  if (!den) return null;
  const S = num / den;
  const pred = xs.map((x) => my + S * (x - mx));
  const ssT = ys.reduce((s, v) => s + (v - my) ** 2, 0);
  const ssR = ys.reduce((s, v, i) => s + (v - pred[i]) ** 2, 0);
  return { S, r2: ssT ? 1 - ssR / ssT : null, n: p.length };
}

(async () => {
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  let chosen;
  if (KEYS.length) {
    const by = new Map(ds.rows.map((r) => [r.key, r]));
    chosen = KEYS.map((k) => by.get(k)).filter((r) => r && r.path);
  } else {
    // Spread across complexity so a flat-vs-sensitive difference, if it exists, is visible. Prefer
    // films that already have a banding reading so the ladder can be tied to the live measurement.
    const ok = ds.rows.filter((r) => r.kind === 'movie' && r.path && r.cambi != null && r.cxEff > 0);
    const byCx = [...ok].sort((a, b) => a.cxEff - b.cxEff);
    chosen = Array.from({ length: N_FILMS }, (_, i) => byCx[Math.floor(((i + 0.5) * byCx.length) / N_FILMS)])
      .filter(Boolean);
  }
  console.log(`${chosen.length} films x ${LEVELS.length} levels x ${CLIPS} clips of ${SECLEN}s`);
  console.log(`levels ${LEVELS.join(' ')}  (starved with libx264 — the library-realistic codec)\n`);

  const out = { generated: Date.now(), levels: LEVELS, clips: CLIPS, seclen: SECLEN, films: [] };
  for (const r of chosen) {
    const dur = Math.floor(Number(sh(FP, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0);
    const vb = Number(sh(FP, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=bit_rate',
      '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0;
    const tb = Number(sh(FP, ['-v', 'error', '-show_entries', 'format=bit_rate',
      '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0;
    const src = (vb > 0 && (tb <= 0 || vb <= tb * 1.05)) ? vb : tb;
    if (!dur || !src) { console.log(`  ${r.title} — no duration/bitrate, skipped`); continue; }

    const start = Math.floor(dur * 0.05); const span = Math.floor(dur * 0.90);
    // Extract ONCE, lossless, so every level works from identical decoded material and the only
    // thing varying down the ladder is the starvation encode.
    const base = [];
    for (let k = 0; k < CLIPS; k += 1) {
      const t = start + Math.floor((span * k) / CLIPS);
      const f = path.join(TMP, `b${k}.mkv`);
      try {
        sh(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-t', String(SECLEN),
          '-i', r.path, '-an', '-sn', '-c:v', 'ffv1', '-threads', String(THREADS), '-y', f]);
        base.push(f);
      } catch { /* skip this clip */ }
    }
    if (base.length < 2) { console.log(`  ${r.title} — extraction failed`); continue; }

    const pts = [];
    // THE LOSSLESS ANCHOR, measured on THESE clips, in THIS run.
    //
    // WHY IT HAS TO BE IN-RUN: clip offsets are T = start + span*k/CLIPS, so changing the clip COUNT
    // changes which scenes are sampled — and banding is so scene-dependent that The Big Sleep read
    // 0.0859 at level 1.0 with 4 clips and 0.00716 with 3. Twelve times apart, same film, same level,
    // same encoder. So a ladder absolute can NEVER be compared against the banding job's absolute,
    // or against another ladder run. Only ratios WITHIN one run are meaningful, because there the
    // scene choice is identical at every level and cancels — exactly the property that made the
    // pinning experiment's understatement ratio clean while its absolute complexity was not.
    //
    // This point is the curve's asymptote: the extract is lossless, so it carries the file's own
    // banding and nothing added. It anchors the curve on the same scenes as every other point.
    try {
      const ms = base.map((b) => measureOf(b)).filter(Boolean);
      const pick = (f) => mean(ms.map((m) => m[f]).filter((v) => v != null));
      const anchor = pick('cambi');
      if (Number.isFinite(anchor)) {
        pts.push({ level: null, lossless: true, cambi: +anchor.toFixed(5),
          block: +pick('block').toFixed(5), blur: +pick('blur').toFixed(5),
          grain: +pick('grain').toFixed(5), n: ms.length });
        process.stdout.write(`  ${r.title.slice(0, 26).padEnd(28)} LOSSLESS  cambi ${anchor.toFixed(4)}  `
          + `block ${pick('block').toFixed(4)}  blur ${pick('blur').toFixed(4)}  `
          + `grain ${pick('grain').toFixed(4)}\n`);
      }
    } catch { /* anchor is optional; the slope does not depend on it */ }

    for (const lv of LEVELS) {
      const vals = [];
      for (const b of base) {
        let clip = b;
        // EVERY LEVEL IS RE-ENCODED, INCLUDING 1.0 AND ABOVE.
        //
        // The first version COPIED the clip at level 1.0 and re-encoded everywhere else, so the
        // control point sat on a different PROCESS from the treatments. That is the same class of
        // confound as starving x265 with x265 in the pinning work, and it was just as large:
        // measured 2026-08-21, The Big Sleep read 0.0017 copied and 0.1157 re-encoded at 92% of its
        // own bitrate — a 68x step that is generation loss, not a bitrate effect. Fitting through it
        // gave S -11.0 (R^2 0.58); excluding it gave -2.1. A 5x error in the single quantity the
        // whole framework rests on.
        //
        // LEVELS ABOVE 1.0 ARE THE INFORMATIVE ONES, and they cost nothing. Re-encoding at 1.3x the
        // source rate adds almost no banding of its own, so that point approximates the banding
        // already present in the source — the floor this measurement can actually see. The curve
        // from there downward is then a clean, process-consistent reading of "banding added by
        // encoding at rate b", and its knee is a real quantity.
        //
        // What this is NOT: a claim about the master. Encoding above the source rate can never
        // REMOVE banding the source already has (nothing can — 1.2c). It is the asymptote of the
        // re-encode process, not of the film.
        if (lv > 0) {
          clip = path.join(TMP, 'lv.mkv');
          const kbps = Math.max(50, Math.round((src * lv) / 1000));
          try {
            sh(FF, ['-hide_banner', '-loglevel', 'error', '-i', b, '-c:v', 'libx264',
              '-b:v', `${kbps}k`, '-preset', 'medium', '-threads', String(THREADS),
              '-an', '-sn', '-y', clip]);
          } catch { continue; }
        }
        try { const m = measureOf(clip); if (m.cambi != null) vals.push(m); } catch { /* */ }
      }
      if (!vals.length) continue;
      const pick = (f) => mean(vals.map((v) => v[f]).filter((x) => x != null));
      const m = pick('cambi');
      pts.push({ level: lv, cambi: +m.toFixed(5), block: +pick('block').toFixed(5),
        blur: +pick('blur').toFixed(5), grain: +pick('grain').toFixed(5), n: vals.length });
      process.stdout.write(`  ${r.title.slice(0, 26).padEnd(28)} lv ${String(lv).padEnd(5)} `
        + `cambi ${m.toFixed(4)}  block ${pick('block').toFixed(4)}  blur ${pick('blur').toFixed(4)}  `
        + `grain ${pick('grain').toFixed(4)}\n`);
    }
    const s = slope(pts);
    out.films.push({ key: r.key, title: r.title, year: r.year, cxEff: r.cxEff, bpp: r.bpp,
      bppPlus: r.bppPlus, liveCambi: r.cambi, srcBitrate: src, points: pts, fit: s,
      fitBlock: slope(pts, 'block'), fitBlur: slope(pts, 'blur'),
      fitGrain: slope(pts, 'grain') });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    if (s) console.log(`  ${' '.repeat(28)} => S ${s.S.toFixed(3)}  R^2 ${s.r2.toFixed(3)}\n`);
  }

  console.log('\n================ PER-FILM SLOPES, THREE ARTIFACTS ================');
  console.log('  S = d log(artifact) / d log(bitrate). It must be NEGATIVE: fewer bits, more artifact.');
  console.log(`  ${'film'.padEnd(30)} ${'S band'.padStart(8)} ${'S block'.padStart(8)} ${'S blur'.padStart(8)}  ${'cxEff'.padStart(7)}`);
  for (const f of out.films) {
    const g = (x) => (x ? x.S.toFixed(2).padStart(8) : '     n/a');
    console.log(`  ${f.title.slice(0, 28).padEnd(30)} ${g(f.fit)} ${g(f.fitBlock)} ${g(f.fitBlur)}  ${f.cxEff.toFixed(3).padStart(7)}`);
  }

  // THE DISCRIMINATING TEST. A detector that does not move when bits are removed is measuring the
  // content, not an artifact — no matter how reliable it is. blockMean grades 0.922 on split-half,
  // which proves only that it agrees with itself.
  console.log('\n  DOES EACH DETECTOR ACTUALLY RESPOND TO BITS?');
  for (const [name, key] of [['banding', 'fit'], ['blocking', 'fitBlock'], ['blur', 'fitBlur'],
    ['grain', 'fitGrain']]) {
    const ss = out.films.map((f) => f[key]).filter(Boolean);
    if (!ss.length) { console.log(`    ${name.padEnd(9)} no fits`); continue; }
    const neg = ss.filter((x) => x.S < 0).length;
    const med = ss.map((x) => x.S).sort((a, b) => a - b)[Math.floor(ss.length / 2)];
    const r2 = mean(ss.map((x) => x.r2));
    const verdict = neg === ss.length && Math.abs(med) > 0.15
      ? 'RESPONDS — behaves like an artifact'
      : neg <= ss.length / 2 ? 'NO / WRONG SIGN — looks like a content statistic, not an artifact'
        : 'MIXED — some films respond, some do not';
    console.log(`    ${name.padEnd(9)} median S ${med.toFixed(3).padStart(7)}  mean R^2 ${r2.toFixed(3)}  `
      + `${neg}/${ss.length} negative   ${verdict}`);
  }

  // BITS-EQUIVALENT — the blending proposal. Each artifact is converted into the one currency that
  // is commensurable across detectors AND with BPP+: how much bitrate would bring it to threshold.
  // Combining by MAX rather than by sum is what makes correlated detectors safe — if blocking and
  // banding both demand 1.4x, the answer is 1.4x, not 1.96x.
  const T = { cambi: 2.817, block: null, blur: null };   // only banding has a calibrated threshold
  console.log('\n  BITS-EQUIVALENT for banding, m = (T/L)^(1/S) at the operating point:');
  for (const f of out.films) {
    const at1 = f.points.find((p) => p.level === 1);
    if (!at1 || !f.fit) continue;
    const m = (T.cambi / at1.cambi) ** (1 / f.fit.S);
    const read = Math.abs(f.fit.S) < 0.25 ? 'slope too flat to extrapolate — treat as baked in'
      : m > 1.05 ? `needs ${m.toFixed(2)}x more bits`
        : m < 0.95 ? `could run at ${m.toFixed(2)}x — banding not binding` : 'at threshold';
    console.log(`    ${f.title.slice(0, 28).padEnd(30)} L ${at1.cambi.toFixed(3).padStart(7)}  S ${f.fit.S.toFixed(2).padStart(6)}  ${read}`);
  }
  console.log('\n  Thresholds for blocking and blur are NOT calibrated, so their bits-equivalents are');
  console.log('  not computed here. That calibration is what the external dataset is for.');
  console.log(`\nwrote ${OUT}`);
})();
