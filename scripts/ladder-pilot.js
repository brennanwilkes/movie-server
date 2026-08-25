#!/usr/bin/env node
// CRF LADDER PILOT — build real per-film rate curves for a stratified sample of the library.
//
//   node scripts/ladder-pilot.js --plan            print the selected films, run nothing
//   node scripts/ladder-pilot.js --run             measure them (SLOW: ~10 min/film)
//   node scripts/ladder-pilot.js --report          analyse whatever has been measured so far
//
// WHY A PILOT AND NOT THE LIBRARY. A ladder costs rungs x samples encodes per film. At the measured
// ~10 min/film that is ~4 hours for 25 films and ~170 hours for all 1031 — so the pilot answers the
// question and the library-wide version stays unjustified until it does.
//
// WHAT IT ANSWERS (docs/BPP-PLUS.txt section 14):
//   1. Is the -15%-per-CRF-point rule right for OUR content? BPP+ uses it to move HEADROOM_TARGET at
//      read time without re-probing, so if the slope is wrong that conversion is wrong.
//   2. Does the slope VARY by content? If grainy films have a different slope, one global exponent
//      is averaging over real structure.
//   3. Is log(bitrate) vs CRF straight, or does it bend? A bend is the rate-side shadow of a quality
//      knee — the thing Netflix's ladder work is actually about.
//
// WHAT IT CANNOT ANSWER: where the PERCEPTUAL knee is. That needs a quality axis, which needs
// libvmaf (the box's ffmpeg has none). SSIM is not a substitute — it over-rewards grain, which is
// the failure already recorded in RESEARCH-quality-metrics-2026-08-01.md. That is Stage B.
//
// SAFETY: read-only. Encodes to /dev/null via probe-ladder.sh, touches no media, writes exactly one
// file (the results JSON). Refuses to start while the nightly probe or a manual session is busy —
// this box has 4 cores and two concurrent encode jobs make both slower and the box unresponsive.

const fs = require('fs');
const { execFileSync } = require('child_process');

const API = process.env.CONTROLLER || 'http://localhost:8088';
// Repo-local and host-writable. NOT /opt/appdata/controller — that is root-owned and belongs to
// the controller; this is an offline experiment, not controller state.
const OUT = process.env.LADDER_OUT || `${__dirname}/../data/ladder-pilot.json`;
const CRFS = process.env.LADDER_CRFS || '16 20 24 28';
const SAMPLES = process.env.LADDER_SAMPLES || '4';
const TARGET_N = Number(process.env.LADDER_FILMS || 25);

const mode = process.argv.find((a) => a.startsWith('--'))?.slice(2) || 'plan';

const get = async (p) => {
  const r = await fetch(`${API}${p}`);
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};

// STRATIFIED SELECTION. The question is whether the rate curve varies with CONTENT, so the sample
// has to span content — picking the 25 biggest or 25 worst films would answer a different question
// and look like it answered this one. Strata: complexity decile (the axis most likely to matter,
// since it is largely grain cost) crossed with era, plus deliberate inclusion of the known edge
// cases the doc calls out.
function select(rows) {
  const usable = rows.filter((r) => r.kind === 'movie' && r.cxEff > 0 && r.bytes > 0);
  const byCx = [...usable].sort((a, b) => a.cxEff - b.cxEff);
  const picked = new Map();
  const take = (r, why) => { if (r && !picked.has(r.key)) picked.set(r.key, { ...r, why }); };

  // 1. Even sweep across the complexity range — the primary axis.
  const perDecile = Math.max(1, Math.floor(TARGET_N * 0.6 / 10));
  for (let d = 0; d < 10; d += 1) {
    const lo = Math.floor((d * byCx.length) / 10);
    const hi = Math.floor(((d + 1) * byCx.length) / 10);
    const slice = byCx.slice(lo, hi);
    for (let i = 0; i < perDecile && i < slice.length; i += 1) {
      // Middle of each decile rather than its edge, so a stratum is represented by a typical member.
      take(slice[Math.floor(((i + 0.5) * slice.length) / perDecile)], `complexity decile ${d + 1}`);
    }
  }
  // 2. The named edge cases. These are the films the doc reasons about, so having curves for them
  //    makes the pilot immediately interpretable rather than abstract.
  const byName = (frag) => usable.find((r) => r.title.toLowerCase().includes(frag));
  for (const [frag, why] of [
    ['12 angry men', 'hungriest content in the library (cx 0.93)'],
    ['arrival', 'cheapest content (cx 0.029)'],
    ['blair witch', 'deliberately degraded photography — bits cannot help'],
    ['parasite', 'most over-supplied (R 5.58)'],
    ['casablanca', 'heavy B&W grain, well fed'],
    ['no other choice', 'clean modern digital, grain-free control'],
    ['spirited away', 'animation — no photochemical grain'],
    // Exact-ish match: a bare 'star wars' picks up Solo and every sequel, and the grain-boiling
    // measurement in section 9 was made on the 1977 film specifically.
    ['star wars (1977', 'the grain-boiling case from section 9'],
  ]) take(byName(frag), why);

  // 3. Both re-encode and disc-encode representation, since generation loss may change the curve.
  take(usable.find((r) => /webdl/i.test(r.source || '')), 'WEB-DL tier');
  take(usable.find((r) => /720p/i.test(r.source || '')), '720p tier');

  return [...picked.values()].slice(0, TARGET_N);
}

async function busy() {
  const p = await get('/api/probe');
  // `busy` is only true DURING an encode and drops to false between units, so checking it alone
  // would let a manual session quietly resume alongside the ladder a minute later. An active
  // session is itself a blocker, encoding right now or not.
  if (p.session && !p.session.stopping) {
    return `a manual probe session is active (${p.session.units} units, ${p.session.spentMin} min)`;
  }
  return p.busy ? (p.last ? `probe busy (last: ${p.last.title})` : 'probe busy') : null;
}

const load = () => {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { return { v: 1, films: {} }; }
};
const save = (d) => fs.writeFileSync(OUT, JSON.stringify(d, null, 1));

// Least-squares slope of log(bitrate) on CRF. The -15%/point rule predicts a constant ratio per
// point, i.e. a straight line here; `curvature` is the quadratic term, which is what a knee shows up
// as on the rate side.
function fitLadder(points) {
  const p = points.filter((x) => x.probeBitrate > 0).sort((a, b) => a.crf - b.crf);
  if (p.length < 3) return null;
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
  // Curvature via the residual sign pattern: fit a quadratic and report its second-order term.
  let q = null;
  if (n >= 4) {
    const X = xs.map((x) => x - mx);
    const s2 = X.reduce((s, x) => s + x * x, 0);
    const s4 = X.reduce((s, x) => s + x ** 4, 0);
    const sy2 = X.reduce((s, x, i) => s + x * x * ys[i], 0);
    q = (sy2 - (s2 * my)) / (s4 - (s2 * s2) / n);
  }
  return {
    perPoint: +(Math.exp(b) - 1).toFixed(4),      // fractional bitrate change per +1 CRF
    r2: +(ss ? 1 - rs / ss : 0).toFixed(4),
    curvature: q == null ? null : +q.toFixed(5),
    rungs: n,
  };
}

(async () => {
  const ds = await get('/api/probe/dataset');
  const chosen = select(ds.rows);

  if (mode === 'plan') {
    console.log(`Pilot: ${chosen.length} films, CRFs [${CRFS}], ${SAMPLES} samples each`);
    console.log(`Estimated cost: ~${Math.round(chosen.length * 10)} min total\n`);
    for (const r of chosen) {
      console.log(`  ${r.title.padEnd(46)} cx ${String(r.cxEff).padEnd(8)} BPP+ ${String(r.bppPlus).padEnd(4)} ${r.why}`);
    }
    return;
  }

  if (mode === 'report') {
    const d = load();
    const films = Object.values(d.films).filter((f) => f.fit);
    if (!films.length) { console.log('No measured films yet — run with --run.'); return; }
    console.log(`${films.length} films measured\n`);
    console.log('film                                          cx      %/CRF   R2      curvature');
    for (const f of films.sort((a, b) => a.cxEff - b.cxEff)) {
      console.log(`  ${f.title.slice(0, 42).padEnd(44)}${String(f.cxEff).padEnd(8)}`
        + `${(f.fit.perPoint * 100).toFixed(1).padStart(6)}%${String(f.fit.r2).padStart(8)}`
        + `${String(f.fit.curvature ?? '—').padStart(11)}`);
    }
    const slopes = films.map((f) => f.fit.perPoint).sort((a, b) => a - b);
    const med = slopes[Math.floor(slopes.length / 2)];
    console.log(`\nmedian slope ${(med * 100).toFixed(1)}% per CRF point `
      + `(range ${(slopes[0] * 100).toFixed(1)}% to ${(slopes[slopes.length - 1] * 100).toFixed(1)}%)`);
    console.log('the rule of thumb BPP+ assumes is -15.0%');
    return;
  }

  if (mode !== 'run') { console.log('use --plan, --run or --report'); return; }

  const blocked = await busy();
  if (blocked && !process.env.LADDER_FORCE) {
    console.log(`Refusing to start: ${blocked}.`);
    console.log('Two concurrent encode jobs on a 4-core box make both slower. Stop the probe session');
    console.log('first, or set LADDER_FORCE=1 if you really mean it.');
    process.exit(1);
  }

  const data = load();
  let done = 0;
  for (const r of chosen) {
    if (data.films[r.key] && data.films[r.key].fit) { done += 1; continue; }
    const path = r.path || null;
    if (!path) { console.log(`skip ${r.title}: no path in dataset`); continue; }
    process.stdout.write(`[${done + 1}/${chosen.length}] ${r.title} … `);
    try {
      // VIA THE CONTAINER, ALWAYS. This script runs on the host, where ffmpeg is 4.2 — a different
      // x265 build from the controller's 5.1. Measuring rungs with one build and comparing them to
      // cache values taken with the other would be comparing two rulers (section 12 trap 1).
      const raw = execFileSync('docker',
        ['exec', 'controller', '/app/scripts/probe-ladder.sh',
          path, '--json', '--crfs', CRFS, '--samples', SAMPLES],
        { encoding: 'utf8', timeout: 45 * 60000 });
      const j = JSON.parse(raw.trim().split('\n').pop());
      const fit = fitLadder(j.points);
      data.films[r.key] = {
        key: r.key, title: r.title, cxEff: r.cxEff, bppPlus: r.bppPlus, source: r.source,
        year: r.year, why: r.why, points: j.points, fit, ts: Date.now(),
      };
      save(data);
      console.log(fit ? `${(fit.perPoint * 100).toFixed(1)}%/CRF  R2 ${fit.r2}` : 'measured (no fit)');
    } catch (e) {
      console.log(`FAILED — ${e.message.split('\n')[0]}`);
    }
    done += 1;
  }
  console.log(`\nWrote ${OUT}. Run with --report to analyse.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
