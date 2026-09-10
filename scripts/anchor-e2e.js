#!/usr/bin/env node
/* THE BITS LEG, ON THE SAME CLIPS AS THE REAL FIRST GENERATION — closes the last transfer assumption.
 *
 * THE ALGEBRA NOBODY WROTE DOWN. The shipped rule uses lambda = ln(1+anchor)/dPdGen, and the anchor
 * itself came from the crossed ladder as exp(B/A)-1, where B = dP/dgen and A = |dP/dlog bpp|. So
 *     ln(1+anchor) = B/A     and     lambda = (B/A) / dPdGen
 * If the SAME generation step is used in both places, B and dPdGen cancel and
 *     *** lambda === 1 / |dP/dlog bpp| ***
 * Check: A = 0.6555 from the crossed ladder, 1/A = 1.526, shipped lambda = 1.519. It is an identity.
 * LAMBDA IS THE RECIPROCAL OF THE BITS-RESPONSE SLOPE. The generation step is not in it at all; it
 * enters, cancels, and leaves. This is why the end-to-end result must NOT be substituted into the
 * denominator on its own — doing so pairs a numerator measured on ladder generations with a
 * denominator measured on real first generations, which is precisely the cross-population transfer
 * 11.30 built the crossed ladder to eliminate.
 *
 * WHAT IS ACTUALLY OPEN. end-to-end-generation.js measured a REAL first generation (source -> one
 * re-encode at matched bits) at dP = 0.4971 +- 0.0459, sign 23/23, which is 2.48x the ladder's step.
 * The ladder's "generation 1" is already a re-encode, so its step averages 1->2 and 2->3 and saturates.
 * The real first generation is the field-relevant one. But carrying it through with the OLD A gives
 *     anchor = exp(0.4971 / 0.6555) - 1 = 113%
 * against a published BD-rate bound of 5-40%. That is far enough outside to refuse, and there is an
 * obvious suspect: A came from 8 crossed-ladder films, B from 23 different end-to-end films. Different
 * populations, different clips. The transfer assumption is back.
 *
 * THE FIX, AND THE WHOLE POINT: measure leg A ON THE E2E CLIPS THEMSELVES.
 *   leg B (already measured)  gen0 -> gen1 at 1.0x bitrate      -> dP per real first generation
 *   leg A (this script)       gen1 at 0.7x, 1.0x, 1.4x bitrate  -> dP / d(log bpp) on the same clips
 * The 1.0x rung of leg A IS the gen1 encode leg B already used, so the two legs are pinned to a common
 * encode and any per-film offset in P cancels in the ratio. Same film, same clip positions, same
 * encoder, same detectors, no transfer of any kind. Then
 *     anchor = exp(B/A) - 1     and     lambda = 1/A
 * both measured on the population the rule is actually applied to.
 *
 * PRE-REGISTERED, BEFORE RUNNING:
 *   - A must be clearly NEGATIVE on most films (fewer bits must make P worse) or the ratio is
 *     noise over noise and nothing here is usable. Reported per film, not just in aggregate.
 *   - If A on these clips is ~0.65, matching the crossed ladder, then the 113% stands and the
 *     published BD-rate bound is the thing that has to give.
 *   - If A on these clips is ~1.6, the 113% collapses to ~35% and the shipped anchor was right all
 *     along for the wrong reason.
 *   Both outcomes are informative. Neither is assumed.
 *
 * REUSES the exact films, clip positions and bitrates already in data/end-to-end-generation.json, so
 * leg B is not re-measured and only the two extra rungs cost anything.
 *
 * READ-ONLY on media. Encodes 2s clips into a temp dir it removes on exit.
 * THERMAL: 3 encode threads, strictly one film at a time. Two heavy jobs measured 93C against a 100C
 * limit on this box, and the controller runs its own probes on a schedule.
 *
 * USAGE: node scripts/anchor-e2e.js [--rungs 0.7,1.4]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = val('--api', 'http://localhost:8088');
const RUNGS = val('--rungs', '0.7,1.4').split(',').map(Number);
const THREADS = val('--threads', '3');
const E2E = `${__dirname}/../data/end-to-end-generation.json`;
const OUT = val('--out', `${__dirname}/../data/anchor-e2e.json`);
/* tools/ffmpeg-* is a SECOND ffmpeg, built for libvmaf/blockdetect which the host's 4.2 lacks. It is
 * for measurement only and must never be used for the controller's complexity probe. */
const FF = `${__dirname}/../tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg`;
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-e2e-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const sh = (b, a) => execFileSync(b, a, { encoding: 'utf8', timeout: 30 * 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/* Identical recipe to artifact-backfill.js and end-to-end-generation.js. The whole design depends on
 * leg A and leg B being read by the same instrument, so this must not drift from that file. */
function measure(file, t, seclen) {
  const log = path.join(TMP, 'c.csv');
  try { fs.unlinkSync(log); } catch { /* */ }
  const ss = t == null ? [] : ['-ss', String(t), '-t', String(seclen)];
  const p = spawnSync(FF, ['-hide_banner', '-loglevel', 'info', ...ss, '-i', file, ...ss, '-i', file,
    '-lavfi', `[0:v]blockdetect,blurdetect[d];[d][1:v]libvmaf=feature=name=cambi:n_threads=2:log_path=${log}:log_fmt=csv`,
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
  const g = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', ...ss, '-i', file, '-an', '-sn', '-vf',
    'split[a][b];[a]hqdn3d=4:3:6:4[d];[b][d]blend=all_mode=difference,signalstats,'
    + 'metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8', timeout: 30 * 60000 });
  const gv = String(g.stdout || '').split('\n').map((l) => /YAVG=([\d.]+)/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  return { cambi, block: grab(/block mean: ([0-9.]+)/), blur: grab(/blur mean: ([0-9.]+)/),
    grain: gv.length > 2 ? mean(gv.slice(1)) : null };
}
const avg = (acc) => {
  const o = {};
  for (const k of ['cambi', 'block', 'blur', 'grain']) {
    const v = acc.map((x) => x[k]).filter((x) => x != null && x > 0);
    o[k] = v.length ? mean(v) : null;
  }
  return o;
};

(async () => {
  const e2e = JSON.parse(fs.readFileSync(E2E, 'utf8'));
  const CLIPS = e2e.clips || 4;
  const SECLEN = 2;
  const ds = await (await fetch(`${API}/api/probe/dataset`)).json();
  const byKey = new Map(ds.rows.map((r) => [r.key, r]));

  let done = {};
  try { done = JSON.parse(fs.readFileSync(OUT, 'utf8')).units || {}; } catch { /* first run */ }
  const todo = Object.entries(e2e.units).filter(([k]) => !done[k] && byKey.has(k));
  console.log(`${todo.length} units, ${CLIPS} clips each, leg A rungs ${RUNGS.join('x, ')}x `
    + `(1.0x is the gen1 encode leg B already used)\n`);

  for (const [key, u] of todo) {
    const r = byKey.get(key);
    if (!r?.path) continue;
    const dur = Math.floor(Number(sh(FP, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', r.path]).trim()) || 0);
    if (!dur) continue;
    /* THE SAME POSITIONS end-to-end-generation.js used. This is what makes the legs comparable, so
     * the arithmetic here must stay identical to that file's. */
    const start = Math.floor(dur * 0.1); const span = Math.floor(dur * 0.8);
    const pos = [];
    for (let k = 0; k < CLIPS; k += 1) pos.push(start + Math.floor((span * k) / CLIPS));

    const acc = {}; for (const m of RUNGS) acc[m] = [];
    for (const t of pos) {
      const src = path.join(TMP, 'c.mkv');
      if (spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-t', String(SECLEN),
        '-i', r.path, '-c:v', 'ffv1', '-an', '-sn', '-y', src], { timeout: 30 * 60000 }).status !== 0) continue;
      for (const m of RUNGS) {
        const o = path.join(TMP, `r${m}.mkv`);
        const kb = Math.max(1, Math.round(u.kbps * m));
        if (spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', src, '-c:v', 'libx264',
          '-preset', 'medium', '-b:v', `${kb}k`, '-threads', THREADS, '-an', '-sn', '-y', o],
        { timeout: 30 * 60000 }).status !== 0) continue;
        const mm = measure(o, null, SECLEN);
        if (mm) acc[m].push(mm);
      }
    }
    if (RUNGS.some((m) => acc[m].length < 2)) continue;
    const rungs = {};
    for (const m of RUNGS) rungs[m] = { kbps: Math.round(u.kbps * m), ...avg(acc[m]) };
    done[key] = { title: u.title, bpp: u.bpp, cxEff: u.cxEff, codec: u.codec, kbps: u.kbps, rungs };
    fs.writeFileSync(OUT, JSON.stringify({ generated: Date.now(), clips: CLIPS, rungs: RUNGS, units: done }, null, 1));
    console.log(`  ${Object.keys(done).length}/${Object.keys(e2e.units).length} `
      + `${u.title.slice(0, 30).padEnd(32)} `
      + RUNGS.map((m) => `${m}x cambi ${(rungs[m].cambi ?? 0).toFixed(3)}`).join('   '));
  }
  console.log(`\nwrote ${OUT}`);
  console.log('Analyse with: node scripts/anchor-e2e-analyse.mjs');
})();
