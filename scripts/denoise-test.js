#!/usr/bin/env node
/* THE PREPROCESSING AXIS — and the test that should rehabilitate the grain detector.
 *
 * Two axes are already validated at fixed bits and content: ENCODER (20 films, 19/20 perfect) and
 * GENERATIONS (10 films, block and blur 10/10). Both are invisible to BPP+. This is a third, and it
 * is the one aimed squarely at grain.
 *
 * WHY GRAIN NEEDS IT. Grain is our weakest detector: its whole dynamic range across a preset step is
 * 1.044x and across three generations 1.014x, so a 0.0004 wobble flips a rank (11.14). But those are
 * axes grain has no particular reason to be good at. DENOISING IS THE ONE THAT DESTROYS GRAIN
 * DIRECTLY — release groups denoise before encoding precisely because grain is expensive, and the
 * result looks waxy. If the grain detector cannot see hqdn3d applied to the source, it is not a grain
 * detector at all.
 *
 * THE ORDERING IS PHYSICAL, not conventional: none < light < heavy denoise removes monotonically more
 * texture. Every row is encoded at the SAME bitrate afterwards, so BPP+ scores them identically.
 *
 * NOTE THE EXPECTED TENSION: denoising makes the encoder's job EASIER, so banding and blocking may
 * IMPROVE while grain degrades. That is not a contradiction, it is the two axes disagreeing for a
 * real reason, and it is worth seeing whether the panel reports it that way.
 *
 * READ-ONLY on media. USAGE: node scripts/denoise-test.js [--films 10] [--clips 3]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const N = Number(val('--films', 10));
const CLIPS = Number(val('--clips', 3));
const OUT = val('--out', `${__dirname}/../data/denoise-test.json`);
const FF = `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`;
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const sh = (b, a) => execFileSync(b, a, { encoding: 'utf8', timeout: 30 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

// rank 3 = best (untouched). More denoise = worse for grain, by construction.
const STEPS = [
  { name: 'none', rank: 3, vf: null },
  { name: 'light', rank: 2, vf: 'hqdn3d=2:1:3:2' },
  { name: 'heavy', rank: 1, vf: 'hqdn3d=6:4:9:6' },
];

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
  return { cambi, block: grab(/block mean: ([0-9.]+)/), blur: grab(/blur mean: ([0-9.]+)/),
    grain: gv.length > 2 ? mean(gv.slice(1)) : null };
}

(async () => {
  const ds = await (await fetch('http://localhost:8088/api/probe/dataset')).json();
  // Bias toward GRAINY films — a denoise test on clean digital content has nothing to remove.
  const pool = ds.rows.filter((r) => r.path && r.cxEff > 0.10 && r.bpp > 0).sort((a, b) => b.cxEff - a.cxEff);
  const picks = pool.slice(0, N);
  const out = { generated: Date.now(), films: [] };

  for (const r of picks) {
    const dur = Math.floor(Number(sh(FP, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0);
    if (!dur) continue;
    const st = Math.floor(dur * 0.15); const sp2 = Math.floor(dur * 0.7);
    const srcs = [];
    for (let k = 0; k < CLIPS; k += 1) {
      const s = path.join(TMP, `s${k}.mkv`);
      const p = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(st + Math.floor((sp2 * k) / CLIPS)),
        '-t', '2', '-i', r.path, '-c:v', 'ffv1', '-an', '-sn', '-y', s], { encoding: 'utf8', timeout: 30 * 60000 });
      if (p.status === 0) srcs.push(s);
    }
    if (!srcs.length) continue;
    const kbps = Math.round((r.bpp * r.probeW * r.probeH * (r.fps || 24)) / 1000 * 0.6) || 2000;
    console.log(`\n${r.title}   cx ${r.cxEff.toFixed(3)}   ${kbps} kbps every row`);
    console.log(`  ${'denoise'.padEnd(9)} ${'cambi'.padStart(9)} ${'block'.padStart(9)} ${'blur'.padStart(9)} ${'grain'.padStart(9)}`);
    const rows = [];
    for (const s of STEPS) {
      const acc = [];
      for (let k = 0; k < srcs.length; k += 1) {
        const o = path.join(TMP, `o${k}.mkv`);
        const a = ['-hide_banner', '-loglevel', 'error', '-i', srcs[k]];
        if (s.vf) a.push('-vf', s.vf);
        a.push('-c:v', 'libx264', '-preset', 'medium', '-b:v', `${kbps}k`, '-threads', '3', '-an', '-sn', '-y', o);
        if (spawnSync(FF, a, { encoding: 'utf8', timeout: 30 * 60000 }).status !== 0) continue;
        const m = measure(o); if (m) acc.push(m);
      }
      if (!acc.length) continue;
      const av = { name: s.name, rank: s.rank };
      for (const k of ['cambi', 'block', 'blur', 'grain']) {
        const v = acc.map((x) => x[k]).filter((x) => x != null && x > 0);
        av[k] = v.length ? mean(v) : null;
      }
      rows.push(av);
      console.log(`  ${s.name.padEnd(9)} ` + ['cambi', 'block', 'blur', 'grain']
        .map((k) => (av[k] == null ? '  n/a' : av[k].toFixed(4)).padStart(9)).join(' '));
    }
    out.films.push({ key: r.key, title: r.title, cxEff: r.cxEff, kbps, rows });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  }

  console.log('\n\nDOES THE PANEL RECOVER THE DENOISE ORDERING?');
  console.log('  (same bitrate, same content — BPP+ scores all three identically)');
  console.log('  grain MUST see this. cambi/block may INVERT, because denoising makes encoding easier.\n');
  const rank = (a) => { const s = a.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
    const o = new Array(a.length); s.forEach(([, i], j) => { o[i] = j + 1; }); return o; };
  console.log(`  ${'detector'.padEnd(9)} ${'films'.padStart(6)} ${'mean rank corr'.padStart(15)} ${'perfect'.padStart(9)}`);
  for (const k of ['cambi', 'block', 'blur', 'grain']) {
    const cs = []; let perfect = 0;
    for (const f of out.films) {
      const v = f.rows.filter((x) => x[k] != null && x[k] > 0);
      if (v.length < 3) continue;
      const A = rank(v.map((x) => x.rank)); const B = rank(v.map((x) => (k === 'grain' ? 1 : -1) * x[k]));
      const ma = mean(A); const mb = mean(B);
      let sa = 0; let sb = 0; let s2 = 0;
      for (let i = 0; i < A.length; i += 1) { sa += (A[i] - ma) ** 2; sb += (B[i] - mb) ** 2; s2 += (A[i] - ma) * (B[i] - mb); }
      if (sa && sb) { const c = s2 / Math.sqrt(sa * sb); cs.push(c); if (c > 0.999) perfect += 1; }
    }
    console.log(`  ${k.padEnd(9)} ${String(cs.length).padStart(6)} ${(cs.length ? mean(cs) : NaN).toFixed(3).padStart(15)} ${String(perfect + '/' + cs.length).padStart(9)}`);
  }
  console.log(`\nwrote ${OUT}`);
})();
