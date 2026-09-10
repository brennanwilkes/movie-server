#!/usr/bin/env node
/* THE GENERATION AXIS — a second provenance dimension BPP+ is blind to.
 *
 * The encoder ladder established that the panel sees ENCODER COMPETENCE at fixed bits and content
 * (20 films, 19/20 perfect on cambi/block/blur). This tests a different axis with the same logic and
 * an equally undisputed ordering: a file encoded ONCE is better than the same file encoded twice,
 * which is better than three times, all delivered at the SAME final bitrate.
 *
 * WHY IT MATTERS FOR THIS LIBRARY. A WEBRip is a re-encode of a WEB-DL. A scene x265 release is a
 * re-encode of a Bluray. Generation count is real, common, and invisible to BPP+ — which sees only
 * the final bitrate and the content, both identical across these rows by construction.
 *
 * The known ordering is physical: each generation quantises what the previous one already quantised,
 * so error accumulates and can never decrease. There is no preset or codec subtlety here.
 *
 * READ-ONLY on media; encodes 2s clips in a temp dir it removes.
 * USAGE: node scripts/generation-test.js [--films 10] [--clips 3]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', 'http://localhost:8088');
const N = Number(val('--films', 10));
const CLIPS = Number(val('--clips', 3));
const OUT = val('--out', `${__dirname}/../data/generation-test.json`);
const FF = `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`;
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const sh = (b, a) => execFileSync(b, a, { encoding: 'utf8', timeout: 30 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

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
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  const pool = ds.rows.filter((r) => r.path && r.cxEff > 0 && r.bpp > 0).sort((a, b) => a.cxEff - b.cxEff);
  const picks = [];
  for (let i = 0; i < N; i += 1) picks.push(pool[Math.floor((pool.length - 1) * i / (N - 1))]);
  const out = { generated: Date.now(), films: [] };

  for (const r of picks) {
    const dur = Math.floor(Number(sh(FP, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0);
    if (!dur) continue;
    const st = Math.floor(dur * 0.15); const sp = Math.floor(dur * 0.7);
    const srcs = [];
    for (let k = 0; k < CLIPS; k += 1) {
      const s = path.join(TMP, `s${k}.mkv`);
      const p = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(st + Math.floor((sp * k) / CLIPS)),
        '-t', '2', '-i', r.path, '-c:v', 'ffv1', '-an', '-sn', '-y', s], { encoding: 'utf8', timeout: 30 * 60000 });
      if (p.status === 0) srcs.push(s);
    }
    if (!srcs.length) continue;
    // 0.6x, same reason as the encoder ladder: at the film's own rate a good encode shows nothing.
    const kbps = Math.round((r.bpp * r.probeW * r.probeH * (r.fps || 24)) / 1000 * 0.6) || 2000;
    console.log(`\n${r.title}   cx ${r.cxEff.toFixed(3)}   ${kbps} kbps final, every generation`);
    console.log(`  ${'generations'.padEnd(13)} ${'cambi'.padStart(9)} ${'block'.padStart(9)} ${'blur'.padStart(9)} ${'grain'.padStart(9)}`);
    const rows = [];
    for (const gen of [1, 2, 3]) {
      const acc = [];
      for (let k = 0; k < srcs.length; k += 1) {
        let cur = srcs[k];
        // Every generation is encoded at the SAME bitrate, so the final file's bits are identical
        // regardless of how many passes preceded it. Only accumulated quantisation differs.
        for (let g = 0; g < gen; g += 1) {
          const o = path.join(TMP, `g${k}_${g}.mkv`);
          const p = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', cur, '-c:v', 'libx264',
            '-preset', 'medium', '-b:v', `${kbps}k`, '-threads', '3', '-an', '-sn', '-y', o],
          { encoding: 'utf8', timeout: 30 * 60000 });
          if (p.status !== 0) { cur = null; break; }
          cur = o;
        }
        if (!cur) continue;
        const m = measure(cur); if (m) acc.push(m);
      }
      if (!acc.length) continue;
      const av = { gen, rank: 4 - gen };          // fewer generations = better = higher rank
      for (const k of ['cambi', 'block', 'blur', 'grain']) {
        const v = acc.map((x) => x[k]).filter((x) => x != null && x > 0);
        av[k] = v.length ? mean(v) : null;
      }
      rows.push(av);
      console.log(`  ${String(gen).padEnd(13)} ` + ['cambi', 'block', 'blur', 'grain']
        .map((k) => (av[k] == null ? '  n/a' : av[k].toFixed(4)).padStart(9)).join(' '));
    }
    out.films.push({ key: r.key, title: r.title, cxEff: r.cxEff, kbps, rows });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  }

  console.log('\n\nDOES THE PANEL RECOVER THE GENERATION ORDERING?');
  console.log('  (same final bitrate, same content — BPP+ scores all three identically)\n');
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
      let sa = 0; let sb = 0; let s = 0;
      for (let i = 0; i < A.length; i += 1) { sa += (A[i] - ma) ** 2; sb += (B[i] - mb) ** 2; s += (A[i] - ma) * (B[i] - mb); }
      if (sa && sb) { const c = s / Math.sqrt(sa * sb); cs.push(c); if (c > 0.999) perfect += 1; }
    }
    console.log(`  ${k.padEnd(9)} ${String(cs.length).padStart(6)} ${(cs.length ? mean(cs) : NaN).toFixed(3).padStart(15)} ${String(perfect + '/' + cs.length).padStart(9)}`);
  }
  console.log(`\nwrote ${OUT}`);
})();
