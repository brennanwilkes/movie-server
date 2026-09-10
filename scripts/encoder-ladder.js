#!/usr/bin/env node
/* DO ARTIFACTS SEE QUALITY THAT BITS AND CONTENT CANNOT? — the decisive test, no labels needed.
 *
 * WHY THIS EXISTS. Brennan, 2026-08-26, refusing to let the covering-set idea be written off:
 * "Tell me through logical reasoning why it doesnt work. Not via data but by logic. If we cant
 * reason as to why it cant work, then it can, and we need to FIND the experiment."
 *
 * I could not, and the attempt exposed my own error. I had been reasoning "artifacts are caused by
 * bits and content, therefore they carry nothing beyond bits and content". That is false. The causal
 * chain is
 *      artifacts = f(bits, content, ENCODER, SETTINGS, MASTER, GENERATIONS, PREPROCESSING)
 * and BPP+ sees only the first two. Two files with identical bits and identical content differ
 * wildly in artifacts depending on the rest. A movie library varies enormously in exactly those
 * factors — Bluray vs WEB-DL vs WEBRip, a dozen release groups, twenty years of encoder practice.
 *
 * AND IT EXPLAINS THE CVQAD NULL. Every clip in a CVQAD sequence is THE SAME MASTER through THE SAME
 * ENCODER, varying only bitrate and one preset step. That corpus holds constant precisely the
 * variables that make artifacts informative, so it is structurally incapable of showing the effect.
 * The null there was a fact about its design, not about detectors, and treating it as the latter was
 * the mistake.
 *
 * THE DESIGN. Hold bits and content EXACTLY constant, vary only encoder quality, and use an ordering
 * nobody disputes because it is what presets ARE:
 *      x264 veryfast  <  x264 medium  <  x264 placebo  <  x265 medium
 * BPP+ scores all four identically — same bits, same content. If the artifact panel recovers the
 * ordering, it is measuring something BPP+ cannot see, and the concept is validated with no
 * subjective labels anywhere.
 *
 * WHY THE EARLIER PRESET TEST FAILED: CVQAD's fast-vs-slow pairs differ by a median of 0.243 on a
 * 0-7.4 scale. Nearly nothing. veryfast vs placebo across two codecs is a real gap.
 *
 * READ-ONLY on media; encodes 2s clips into a temp dir it removes.
 * USAGE: node scripts/encoder-ladder.js [--films 8] [--clips 3]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', process.env.CONTROLLER || 'http://localhost:8088');
const N_FILMS = Number(val('--films', 8));
const CLIPS = Number(val('--clips', 3));
const SECLEN = 2;
const OUT = val('--out', `${__dirname}/../data/encoder-ladder.json`);
const FF = val('--ffmpeg', `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`);
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'encl-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const sh = (bin, a) => execFileSync(bin, a, { encoding: 'utf8', timeout: 30 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/* `rank` is the known ordering, and it is the ONLY thing in this file that is asserted rather than
 * measured. It is safe to assert: a slower preset searches more of the same space and cannot do
 * worse at the same bitrate, and x265 at a given bitrate beats x264 at that bitrate on every public
 * comparison of the last decade. Two codecs are included deliberately — if the panel only ranks
 * presets within one encoder it may be reading encoder fingerprints rather than quality. */
const ENCODERS = [
  { name: 'x264 veryfast', rank: 1, args: ['-c:v', 'libx264', '-preset', 'veryfast'] },
  { name: 'x264 medium', rank: 2, args: ['-c:v', 'libx264', '-preset', 'medium'] },
  { name: 'x264 slower', rank: 3, args: ['-c:v', 'libx264', '-preset', 'slower'] },
  { name: 'x265 medium', rank: 4, args: ['-c:v', 'libx265', '-preset', 'medium'] },
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
      + 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-f', 'null', '-'], { encoding: 'utf8', timeout: 30 * 60000 });
  const gv = String(g.stdout || '').split('\n').map((l) => /YAVG=([\d.]+)/.exec(l))
    .filter(Boolean).map((m) => Number(m[1]));
  return { cambi, block: grab(/block mean: ([0-9.]+)/), blur: grab(/blur mean: ([0-9.]+)/),
    grain: gv.length > 2 ? mean(gv.slice(1)) : null };
}

(async () => {
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  // Spread across complexity so a result cannot be a property of one kind of content.
  const pool = ds.rows.filter((r) => r.path && r.cxEff > 0 && r.bpp > 0)
    .sort((a, b) => a.cxEff - b.cxEff);
  const picks = [];
  for (let i = 0; i < N_FILMS; i += 1) picks.push(pool[Math.floor((pool.length - 1) * i / (N_FILMS - 1))]);

  const out = { generated: Date.now(), encoders: ENCODERS.map((e) => e.name), films: [] };
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
    // Deliberately BELOW the film's own bitrate: at its native rate a good encoder produces no
    // artifacts at all and every row reads clean, which measures nothing. 0.6x puts all four
    // encoders in a regime where they must make visible compromises.
    const kbps = Math.round((r.bpp * r.probeW * r.probeH * (r.fps || 24)) / 1000 * 0.6) || 2000;

    console.log(`\n${r.title}   cx ${r.cxEff.toFixed(3)}   ${kbps} kbps for every row`);
    console.log(`  ${'encoder'.padEnd(15)} ${'cambi'.padStart(9)} ${'block'.padStart(9)} ${'blur'.padStart(9)} ${'grain'.padStart(9)}`);
    const rows = [];
    for (const enc of ENCODERS) {
      const acc = [];
      for (let k = 0; k < srcs.length; k += 1) {
        const o = path.join(TMP, `e${k}.mkv`);
        const p = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', srcs[k],
          ...enc.args, '-b:v', `${kbps}k`, '-threads', '3', '-an', '-sn', '-y', o],
        { encoding: 'utf8', timeout: 30 * 60000 });
        if (p.status !== 0) continue;
        const m = measureAll(o);
        if (m) acc.push(m);
      }
      if (!acc.length) continue;
      const avg = {};
      for (const k of ['cambi', 'block', 'blur', 'grain']) {
        const v = acc.map((x) => x[k]).filter((x) => x != null && x > 0);
        avg[k] = v.length ? mean(v) : null;
      }
      rows.push({ ...enc, ...avg });
      console.log(`  ${enc.name.padEnd(15)} `
        + ['cambi', 'block', 'blur', 'grain'].map((k) => (avg[k] == null ? '  n/a' : avg[k].toFixed(4)).padStart(9)).join(' '));
    }
    out.films.push({ key: r.key, title: r.title, cxEff: r.cxEff, kbps, rows });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  }

  /* THE VERDICT. Spearman between the known encoder rank and each detector, pooled over films but
   * computed WITHIN each film, because only within a film are bits and content held constant. A
   * detector that recovers the ordering is seeing what BPP+ cannot. */
  console.log('\n\nDOES THE PANEL RECOVER THE KNOWN ORDERING?');
  console.log('  (within each film: bits identical, content identical, only encoder quality varies —');
  console.log('   so BPP+ scores every row the same and cannot distinguish them at all)\n');
  console.log(`  ${'detector'.padEnd(9)} ${'films'.padStart(6)} ${'mean rank corr'.padStart(15)}   reading`);
  for (const k of ['cambi', 'block', 'blur', 'grain']) {
    const cs = [];
    for (const f of out.films) {
      const v = f.rows.filter((x) => x[k] != null && x[k] > 0);
      if (v.length < 3) continue;
      // better encoder should mean LESS artifact, except grain where MORE retained is better.
      const sgn = k === 'grain' ? 1 : -1;
      const rk = v.map((x) => x.rank);
      const av = v.map((x) => sgn * x[k]);
      const rank = (a) => { const s = a.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
        const o = new Array(a.length); s.forEach(([, i], j) => { o[i] = j + 1; }); return o; };
      const A = rank(rk); const B = rank(av);
      const n = A.length; const ma = mean(A); const mb = mean(B);
      let sa = 0; let sb = 0; let s = 0;
      for (let i = 0; i < n; i += 1) { sa += (A[i] - ma) ** 2; sb += (B[i] - mb) ** 2; s += (A[i] - ma) * (B[i] - mb); }
      if (sa && sb) cs.push(s / Math.sqrt(sa * sb));
    }
    const m = cs.length ? mean(cs) : NaN;
    const read = !Number.isFinite(m) ? '-'
      : m > 0.5 ? 'RECOVERS the ordering — sees what BPP+ cannot'
        : m > 0.2 ? 'partial' : m < -0.2 ? 'INVERTED — reads better encoders as worse' : 'no ordering — coin flip';
    console.log(`  ${k.padEnd(9)} ${String(cs.length).padStart(6)} ${(Number.isFinite(m) ? m.toFixed(3) : ' - ').padStart(15)}   ${read}`);
  }
  console.log(`\nwrote ${OUT}`);
})();
