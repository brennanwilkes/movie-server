#!/usr/bin/env node
// THE STARVATION EXPERIMENT — does a CRF ladder's slope measure source exhaustion?
//
//   node scripts/starve-experiment.js --plan     pick the films, run nothing
//   node scripts/starve-experiment.js --run      measure (SLOW, ~15 min/film)
//   node scripts/starve-experiment.js --report   analyse what has been measured
//
// WHY. The 20-film pilot found slope tracks supply at rho -0.750, which is consistent with "a starved
// source has no detail left to buy, so lowering CRF stops helping". But in the library supply and
// content are tangled, so that correlation cannot distinguish the story from a dozen others.
//
// THE DESIGN. Hold content EXACTLY constant and vary only starvation. Each film is measured at
// several starvation levels; level 1.0 is the untouched control. If the slope shallows monotonically
// as the copy is starved, starvation caused it, because nothing else differed.
//
// WHY WELL-SUPPLIED FILMS ONLY. The subject has to start UNSTARVED or there is no headroom to remove.
// Films at R >= 1.2 are exactly the ones the model already trusts (no pinning correction applied), so
// they are the honest starting point.
//
// PREDICTION, stated before the run so it cannot be fitted afterwards:
//   slope(1.0) steeper than slope(0.5) steeper than slope(0.25)
// A flat or non-monotonic result falsifies the exhaustion story and the finding should be withdrawn.

const fs = require('fs');
const { execFileSync } = require('child_process');

const API = process.env.CONTROLLER || 'http://localhost:8088';
const OUT = process.env.STARVE_OUT || `${__dirname}/../data/starve-experiment.json`;
const CRFS = process.env.STARVE_CRFS || '16 20 24 28';
const LEVELS = process.env.STARVE_LEVELS || '1.0 0.5 0.25';
const SAMPLES = process.env.STARVE_SAMPLES || '3';
const N_FILMS = Number(process.env.STARVE_FILMS || 8);
const R_TRUST = 1.2;
// WHICH ENCODER MAKES THE STARVED COPY. Default x265, which MATCHES the probe — and that match is
// the confound the whole x264 arm exists to measure. Must be forwarded explicitly: `docker exec`
// does NOT inherit the host's environment, so setting STARVE_ENC here and hoping probe-starve.sh
// picks it up would silently produce a SECOND x265 run wearing an x264 label.
const ENC = process.env.STARVE_ENC || 'libx265';
// PIN THE FILM SET. select() re-picks from the live dataset every run, by R >= R_TRUST spread across
// complexity — so the set MOVES whenever R does, and R moved on 2026-08-20 when audio came out of it.
// A second arm that measures a different 8 films answers nothing: the comparison is per-film, same
// content, encoder as the only difference. Pass the first arm's keys to hold the set fixed.
const KEYS = (process.env.STARVE_KEYS || '').split(',').map((x) => x.trim()).filter(Boolean);

const mode = process.argv.find((a) => a.startsWith('--'))?.slice(2) || 'plan';

// RETRY TRANSIENT DOCKER FAILURES ONLY — never a measurement error.
//
// Measured the hard way 2026-08-20: a run that overlapped a controller redeploy lost 7 of 8 films to
// "container is not running". Each film failed instantly, was banked as a failure, and the run
// reported success with ONE data point. A restart takes seconds; a film takes ~20 minutes, so waiting
// is obviously right. What matters is the distinction: a docker-level failure means "the box is
// briefly unavailable", while probe-starve.sh failing on a file is a REAL result that must not be
// retried into looking fine.
const TRANSIENT = /is not running|No such container|Cannot connect to the Docker daemon|daemon/i;
function withRetry(fn, tries = 12, waitMs = 20000) {
  let last;
  for (let k = 0; k < tries; k += 1) {
    try { return fn(); } catch (e) {
      last = e;
      if (!TRANSIENT.test(String((e && e.message) || e))) throw e;
      const secs = Math.round((waitMs * (k + 1)) / 1000);
      process.stdout.write(`\n    container unavailable (attempt ${k + 1}/${tries}), waiting ${secs}s ... `);
      try { execFileSync('sleep', [String(secs)]); } catch { /* nothing to do */ }
    }
  }
  throw last;
}
const get = async (p) => {
  const r = await fetch(`${API}${p}`);
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};
const load = () => {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { return { v: 1, films: {} }; }
};
const save = (d) => fs.writeFileSync(OUT, JSON.stringify(d, null, 1));

// Spread across complexity so a result cannot be an artefact of one content type. Grain matters most
// here: if starvation shallows the slope everywhere EXCEPT on grainy film stock, that is itself a
// finding, and it is invisible unless grainy titles are in the sample.
function select(rows) {
  const ok = rows.filter((r) => r.kind === 'movie' && r.R >= R_TRUST && r.cxEff > 0 && r.path);
  const byCx = [...ok].sort((a, b) => a.cxEff - b.cxEff);
  const picked = [];
  for (let i = 0; i < N_FILMS && byCx.length; i += 1) {
    const idx = Math.floor(((i + 0.5) * byCx.length) / N_FILMS);
    const r = byCx[Math.min(idx, byCx.length - 1)];
    if (!picked.some((q) => q.key === r.key)) picked.push(r);
  }
  return picked;
}

// Slope of log(bitrate) on CRF, per starvation level.
function fitByLevel(points) {
  const levels = [...new Set(points.map((p) => p.level))].sort((a, b) => b - a);
  const out = [];
  for (const lv of levels) {
    const p = points.filter((x) => x.level === lv && x.probeBitrate > 0).sort((a, b) => a.crf - b.crf);
    if (p.length < 3) continue;
    const xs = p.map((x) => x.crf);
    const ys = p.map((x) => Math.log(x.probeBitrate));
    const n = xs.length;
    const mx = xs.reduce((s, x) => s + x, 0) / n;
    const my = ys.reduce((s, y) => s + y, 0) / n;
    let num = 0; let den = 0;
    for (let i = 0; i < n; i += 1) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    const b = num / den;
    const ss = ys.reduce((s, y) => s + (y - my) ** 2, 0);
    const rs = ys.reduce((s, y, i) => s + (y - (my + b * (xs[i] - mx))) ** 2, 0);
    out.push({
      level: lv,
      perPoint: +(Math.exp(b) - 1).toFixed(4),
      r2: +(ss ? 1 - rs / ss : 0).toFixed(4),
      // Complexity as the probe would report it for this level: CRF-20 bitrate is the measurement.
      cx20: p.find((x) => x.crf === 20)?.probeBitrate ?? null,
    });
  }
  return out;
}

(async () => {
  const ds = await get('/api/probe/dataset');
  let chosen;
  if (KEYS.length) {
    const byKey = new Map(ds.rows.map((r) => [r.key, r]));
    chosen = KEYS.map((k) => byKey.get(k)).filter(Boolean);
    const missing = KEYS.filter((k) => !byKey.has(k));
    if (missing.length) console.log(`WARNING: ${missing.length} pinned key(s) not in the dataset: ${missing.join(' ')}`);
    const noPath = chosen.filter((r) => !r.path).map((r) => r.title);
    if (noPath.length) console.log(`WARNING: no path for ${noPath.join(', ')} — cannot measure`);
    chosen = chosen.filter((r) => r.path);
    console.log(`film set PINNED to ${chosen.length} key(s) from STARVE_KEYS; encoder ${ENC}\n`);
  } else {
    chosen = select(ds.rows);
  }

  if (mode === 'plan') {
    console.log(`${chosen.length} films, levels [${LEVELS}], CRFs [${CRFS}], ${SAMPLES} samples`);
    console.log(`~${chosen.length * 15} min total\n`);
    for (const r of chosen) {
      console.log(`  ${r.title.padEnd(42)} supply ${String(Math.round(r.R * 100)).padStart(4)}%  cx ${r.cxEff}`);
    }
    return;
  }

  if (mode === 'report') return report();

  if (mode !== 'run') { console.log('use --plan, --run or --report'); return; }

  const probe = await get('/api/probe');
  if (probe.session && !process.env.STARVE_FORCE) {
    console.log('Refusing: a probe session is active. Stop it first (4 cores, two encode jobs make');
    console.log('both slower), or set STARVE_FORCE=1.');
    process.exit(1);
  }

  const data = load();
  let i = 0;
  for (const r of chosen) {
    i += 1;
    if (data.films[r.key]?.levels?.length) continue;
    process.stdout.write(`[${i}/${chosen.length}] ${r.title} … `);
    try {
      const raw = withRetry(() => execFileSync('docker', ['exec', 'controller',
        '/app/scripts/probe-starve.sh',
        r.path, '--json', '--crfs', CRFS, '--levels', LEVELS, '--samples', SAMPLES,
        '--enc', ENC],
      { encoding: 'utf8', timeout: 60 * 60000 }));
      const j = JSON.parse(raw.trim().split('\n').pop());
      const levels = fitByLevel(j.points);
      data.films[r.key] = {
        key: r.key, title: r.title, cxEff: r.cxEff, R: r.R, year: r.year,
        srcBitrate: j.srcBitrate, points: j.points, levels, ts: Date.now(),
        // WHICH ENCODER STARVED IT. Recorded per film, and echoed back from the script rather than
        // assumed from this process's own env, so a mislabelled arm is impossible to produce.
        enc: j.enc || ENC,
      };
      save(data);
      console.log(levels.map((l) => `${l.level}:${(l.perPoint * 100).toFixed(1)}%`).join('  '));
    } catch (e) {
      console.log(`FAILED — ${e.message.split('\n')[0]}`);
    }
  }
  console.log(`\nWrote ${OUT}`);
  report();
})().catch((e) => { console.error(e.message); process.exit(1); });

// THE ANALYSIS THAT MATTERS, and it is not the slope one.
//
// `cx20` at each level IS the complexity the probe would report for that copy, so this experiment
// measures the PINNING UNDERSTATEMENT directly: cx20(untouched) / cx20(starved). That is the exact
// quantity biasFactor estimates, and until now it had only ever been inferred from banked upgrade
// pairs — observational, selection-biased, weak (rho -0.33).
//
// R here is the R the LIBRARY would see, not the true supply: (srcBitrate x level) / (cx20 x eff).
// It has the pinned measurement in its own denominator, which is the whole reason the slope looked
// like a better instrument. Codec normalisation is applied because the probe always encodes x265 and
// an h264 source needs ~1.6x the bits for the same quality; omitting it inflates every R by 1.6 and
// makes heavily starved copies look well supplied.
const LIVE_BUCKETS = [[0, 0.3, 1.562], [0.3, 0.4, 1.562], [0.4, 0.5, 1.458],
  [0.5, 0.7, 1.414], [0.7, 1.0, 1.179], [1.0, 1.2, 1.051]];
const liveFactor = (R) => {
  if (R >= 1.2) return 1;
  const b = LIVE_BUCKETS.find((x) => R >= x[0] && R < x[1]);
  return b ? b[2] : 1;
};

function spearman(xs, ys) {
  const n = xs.length;
  const rank = (v) => {
    const idx = v.map((x, j) => [x, j]).sort((a, b) => a[0] - b[0]);
    const r = [];
    for (let k = 0; k < idx.length;) {
      let m = k;
      while (m + 1 < idx.length && idx[m + 1][0] === idx[k][0]) m += 1;
      const avg = (k + m) / 2 + 1;
      for (let z = k; z <= m; z += 1) r[idx[z][1]] = avg;
      k = m + 1;
    }
    return r;
  };
  const a = rank(xs); const b = rank(ys);
  const ma = a.reduce((s, x) => s + x, 0) / n; const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i += 1) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * db);
}

function pinningReport(films, codecs) {
  const pts = [];
  for (const x of films) {
    const eff = /hevc|h265|x265/i.test(codecs.get(x.key) || '') ? 1.0 : 1.6;
    const ls = [...x.levels].sort((a, b) => b.level - a.level);
    const base = ls[0].cx20;
    for (const l of ls) {
      if (l.level >= 1 || !l.cx20 || !base) continue;
      pts.push({
        film: x.title, level: l.level, slope: l.perPoint,
        under: base / l.cx20,
        R: (x.srcBitrate * l.level) / (l.cx20 * eff),
      });
    }
  }
  if (pts.length < 4) return;
  console.log(`\nPINNING UNDERSTATEMENT — ${pts.length} controlled points\n`);
  console.log('  which predicts it?');
  console.log('    observed R  ', spearman(pts.map((p) => p.R), pts.map((p) => p.under)).toFixed(3));
  console.log('    ladder slope', spearman(pts.map((p) => p.slope), pts.map((p) => p.under)).toFixed(3));
  console.log('\n  film                      level     R    measured   live rule   ratio');
  for (const p of pts.sort((a, b) => a.R - b.R)) {
    const lv = liveFactor(p.R);
    console.log(`    ${p.film.slice(0, 22).padEnd(24)}${String(p.level).padStart(5)}  ${p.R.toFixed(2).padStart(5)}`
      + `    x${p.under.toFixed(3)}     x${lv.toFixed(3)}     x${(p.under / lv).toFixed(2)}`);
  }
  const above = pts.filter((p) => p.R >= 1.2);
  if (above.length) {
    console.log(`\n  ${above.length} point(s) sit ABOVE R_TRUST=1.2, where the live rule applies NOTHING,`);
    console.log(`  yet measure x${(above.reduce((s, p) => s + p.under, 0) / above.length).toFixed(3)} understatement on average.`);
  }
}

function report() {
  const d = load();
  const films = Object.values(d.films).filter((f) => f.levels?.length >= 2);
  if (!films.length) { console.log('Nothing measured yet.'); return; }
  console.log(`\n${films.length} films\n`);
  console.log('film                                      supply   slope by starvation level');
  let monotone = 0;
  for (const f of films) {
    const ls = [...f.levels].sort((a, b) => b.level - a.level);
    const ok = ls.every((l, i) => i === 0 || l.perPoint >= ls[i - 1].perPoint);
    if (ok) monotone += 1;
    console.log(`  ${f.title.slice(0, 38).padEnd(40)}${String(Math.round(f.R * 100)).padStart(5)}%   `
      + ls.map((l) => `${l.level}→${(l.perPoint * 100).toFixed(1)}%`).join('  ')
      + (ok ? '   ✓' : '   ✗'));
  }
  console.log(`\n${monotone}/${films.length} shallow monotonically as the copy is starved`);
  console.log('(the prediction: starving a source flattens its ladder, because there is less detail');
  console.log(' left for a lower CRF to buy)');
  const deltas = films.map((f) => {
    const ls = [...f.levels].sort((a, b) => b.level - a.level);
    return (ls[ls.length - 1].perPoint - ls[0].perPoint) * 100;
  });
  const mean = deltas.reduce((s, x) => s + x, 0) / deltas.length;
  console.log(`\nmean flattening from unstarved to most-starved: ${mean.toFixed(2)} points`);
  // Codecs come from the dataset because the codec normalisation depends on them and the experiment
  // file does not carry them.
  fetch(`${API}/api/probe/dataset`).then((r) => r.json()).then((ds) => {
    pinningReport(films, new Map(ds.rows.map((r) => [r.key, r.codec])));
  }).catch(() => console.log('\n(could not reach the controller for codecs — pinning report skipped)'));
}
