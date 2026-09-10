#!/usr/bin/env node
/* MEAN LUMA FOR EVERY UNIT — so brightness can be controlled instead of merely noted.
 *
 * WHY (11.51). The luma-degeneracy test found grain responds to brightness at 23.5% of its own
 * residual sd per 50 luma levels, and the library spans roughly 85 luma. Grain carries weight -1 in P,
 * so that is a real contaminant in the composite. It does NOT currently bias the calibration — WEB and
 * Bluray differ by only -5.2 +- 3.4 luma, contributing under 3% of the WEB-vs-Bluray gap — but that
 * check rests on the 330 of 1048 units that happen to carry a luma reading, with just 22 on the WEB
 * side. Both problems have the same fix: measure luma on everything.
 *
 * WHAT IT UNLOCKS:
 *   1. The weak -5.2 +- 3.4 check becomes a real one at full n.
 *   2. Luma can enter the residual surface as a regressor, which would strip a 23.5% contaminant out
 *      of grain's residual. Cleaner residual -> less noise in P -> a larger provenance fraction, which
 *      11.50 identified as the binding constraint on how much the rule is allowed to say.
 *
 * WHY IT IS CHEAP, AND WHY THAT MATTERS. This runs signalstats ONLY — no libvmaf, no blockdetect, no
 * denoise pass. The full artifact backfill costs about 10s per clip; this is a fraction of that. 11.42
 * costed a 12-clip artifact re-measure at ~33 hours for roughly 10% more shrinkage and judged it a poor
 * trade. This buys a different improvement for a small fraction of that time, which is the only reason
 * it is worth doing at all.
 *
 * SAME SAMPLING RECIPE AS THE ARTIFACT BACKFILL — same clip count, same 2s window, same positions — so
 * the luma column lines up with the artifact columns unit for unit. A luma measured on different
 * frames than the artifacts would be a different quantity wearing the same name.
 *
 * READ-ONLY on media. Writes incrementally and skips units already done, so it is safe to interrupt.
 * USAGE: node scripts/luma-backfill.js [--limit 1200] [--samples 4]
 */
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', 'http://localhost:8088');
const LIMIT = Number(val('--limit', 1200));
const SAMPLES = Number(val('--samples', 4));
const SECLEN = Number(val('--seclen', 2));
const OUT = val('--out', `${__dirname}/../data/luma-backfill.json`);
const FF = `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`;
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const sh = (b, a) => execFileSync(b, a, { encoding: 'utf8', timeout: 30 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/* YAVG is the mean luma of the decoded frames. Also captured: YLOW/YHIGH percentiles, because a film
 * can share a mean with another while being far more contrasty, and if luma ever turns out to matter
 * the shape may matter too. Cheap to take now, expensive to come back for. */
function lumaAt(file, t) {
  const p = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-t', String(SECLEN),
    '-i', file, '-an', '-sn', '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'],
  { encoding: 'utf8', timeout: 30 * 60000 });
  if (p.status !== 0) return null;
  const txt = String(p.stdout || '');
  const grab = (key) => {
    const v = [...txt.matchAll(new RegExp(`lavfi\\.signalstats\\.${key}=([-\\d.]+)`, 'g'))]
      .map((m) => Number(m[1])).filter(Number.isFinite);
    return v.length ? mean(v) : null;
  };
  const y = grab('YAVG');
  return y == null ? null : { yavg: y, ylow: grab('YLOW'), yhigh: grab('YHIGH') };
}

(async () => {
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  const want = ds.rows.filter((r) => r.path && r.bpp > 0);
  let done = {};
  try { done = JSON.parse(fs.readFileSync(OUT, 'utf8')).units || {}; } catch { /* first run */ }
  const todo = want.filter((r) => !done[r.key]).slice(0, LIMIT);
  console.log(`${want.length} units, ${Object.keys(done).length} already done, measuring ${todo.length}\n`);

  let n = 0;
  const t0 = Date.now();
  for (const r of todo) {
    const dur = Math.floor(Number(sh(FP, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0);
    if (!dur) continue;
    const start = Math.floor(dur * 0.1); const span = Math.floor(dur * 0.8);
    const acc = [];
    for (let k = 0; k < SAMPLES; k += 1) {
      let m = null;
      try { m = lumaAt(r.path, start + Math.floor((span * k) / SAMPLES)); } catch { /* */ }
      if (m) acc.push(m);
    }
    if (!acc.length) continue;
    done[r.key] = {
      title: r.title, source: r.source,
      yavg: +mean(acc.map((x) => x.yavg)).toFixed(3),
      ylow: +mean(acc.map((x) => x.ylow).filter((v) => v != null)).toFixed(3),
      yhigh: +mean(acc.map((x) => x.yhigh).filter((v) => v != null)).toFixed(3),
      n: acc.length,
    };
    fs.writeFileSync(OUT, JSON.stringify({ generated: Date.now(), units: done }, null, 1));
    n += 1;
    if (n % 25 === 0 || n <= 3) {
      const rate = (Date.now() - t0) / 1000 / n;
      console.log(`  [${n}/${todo.length}] ${r.title.slice(0, 34).padEnd(36)} yavg ${done[r.key].yavg.toFixed(1).padStart(6)}`
        + `   ${rate.toFixed(1)} s/unit   eta ${(((todo.length - n) * rate) / 60).toFixed(0)} min`);
    }
  }
  const all = Object.values(done);
  const ys = all.map((u) => u.yavg).filter((v) => v > 0).sort((a, b) => a - b);
  console.log(`\n${all.length} units with luma`);
  console.log(`  yavg  p10 ${ys[Math.floor(0.1 * ys.length)].toFixed(1)}  median ${ys[Math.floor(0.5 * ys.length)].toFixed(1)}`
    + `  p90 ${ys[Math.floor(0.9 * ys.length)].toFixed(1)}  range ${ys[0].toFixed(1)}..${ys[ys.length - 1].toFixed(1)}`);
  console.log(`\nwrote ${OUT}`);
})();
