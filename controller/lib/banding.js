'use strict';
// THE BANDING JOB — the second measured quality axis, and the only one BPP+ cannot see.
//
// WHAT IT MEASURES. Banding: flat gradients quantised into visible steps. BPP+ answers "does this
// file carry the bits its own content needs"; a file can pass that and still band in a sky, because
// banding is a LOCAL failure in smooth regions and BPP+ is an average over the frame. Measured
// 2026-08-20 across 85 films: 14% of the files BPP+ calls acceptable band visibly, and two of them
// sat in the GREEN band with supply ABOVE transparency (Fargo 109, Obsession 103). No bitrate
// reasoning reaches those.
//
// WHY IT IS POSSIBLE HERE AT ALL, after two years of "we can't do VMAF without a master":
//   CAMBI is genuinely NO-REFERENCE — it keys on flat regions inside a single frame. Only libvmaf's
//   plumbing insists on two inputs, so probe-banding.sh points both at the SAME file. VMAF proper is
//   the opposite and always will be: a same-file comparison scores ~100 by construction. So banding
//   is measurable in production forever; VMAF is only ever a calibration-dataset tool.
//
// IT PASSED ITS OWN DEGENERACY TESTS, which is why it is here and gShare is not. Pre-registered
// thresholds, |r| > 0.6 would have killed it, replicated on an independent 45-film sample:
//   vs complexity (is it just grain?)     -0.245 / -0.444
//   vs mean luma  (is it just darkness?)  -0.254 / -0.022   <- gShare died here at -0.885
//   vs BPP+       (is it redundant?)      -0.313 / -0.273
// Plus a mechanism: among smooth films, starved copies band 2.33x more than supplied ones.
// Full working: docs/REPORT-cambi-2026-08-20.md, BPP-PLUS.txt 10.5a.
//
// ── HOW IT SHARES THE BOX, which is the part that matters operationally ───────────────────────────
// It does NOT get its own gates or its own thermal budget. It calls probe.js's gate and bills
// probe.js's night bucket, so the box still runs at most PROBE_NIGHT_BUDGET_MS of encoding a night
// no matter which job spends it. A second independent budget would silently double the nightly heat,
// and the 2026-07-09 trickplay runaway is why that ceiling exists.
//
// PRIORITY: banding takes the window while the probe has only REFINEMENT left. The probe is at
// 1044/1045 measured — its remaining work tightens error bars on units already measured, which is
// optional — while banding has ~1000 units never measured at all. When the probe has genuinely
// fresh work (a new film, a replaced file) it wins, because a missing complexity number degrades
// every score for that title and a missing banding number degrades nothing.
//
// SCORING: banding NEVER touches BPP+. It is reported beside the score, never folded into it. There
// is no valid subjective label in this library, so any weight would be invented — and the two axes
// disagree in both directions, which is exactly why they must be read separately. If it is ever
// folded in, it multiplies the DENOMINATOR (capped ~1.6) so the sqrt halves any misread.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const app = require('./app');
const { cfg } = require('./config');
const jobs = require('./jobs');
const metrics = require('../metrics');
const probe = require('./probe');

const CONFIG_DIR = process.env.CONTROLLER_CONFIG_DIR || '/config';
const CACHE_FILE = path.join(CONFIG_DIR, 'banding-cache.json');
const SCRIPT = cfg.BANDING_SCRIPT || '/app/scripts/probe-banding.sh';
// The pinned static build, bind-mounted read-only. NEVER the image's own ffmpeg — see the header of
// probe-banding.sh. Absence is a first-class state, not an error: a fresh box has no tools/ yet.
const FFMPEG = cfg.BANDING_FFMPEG || '/tools/ffmpeg-n8.1-latest-linux64-gpl-8.1/bin/ffmpeg';

// 8, NOT 4, AND THE NUMBER IS MEASURED RATHER THAN CHOSEN. 4 clips give a per-film residual whose
// split-half reliability is 0.579 — 42% of the disagreement between measured and expected banding is
// measurement noise (scripts/banding-correction.js). That is fine for the absolute GATE, which only
// asks "does this film band a lot", but it is not enough to CORRECT a score with: a correction built
// on 42% noise moves every score by a random amount while looking like precision.
//
// Inverting Spearman-Brown gives a single-clip reliability of 0.256, so: 7 clips reach 0.70, 8 reach
// 0.73, 12 reach 0.80, 27 reach 0.90. 8 is the pick because it clears 0.70 at only double the cost
// (~92s vs ~46s per unit) and because it MATCHES PROBE_SAMPLES — banding and complexity then sample
// the same grid at the same density, which is what makes a per-film comparison between them fair.
//
// The trade is deliberate and worth stating: at 8 clips the nightly budget covers half as many units.
// Measuring half the library usefully beats measuring all of it too coarsely to answer the question
// the measurement exists for.
const SAMPLES = Number(cfg.BANDING_SAMPLES || 8);
const SECLEN = Number(cfg.BANDING_SECLEN || 2);
const THREADS = Number(cfg.BANDING_THREADS || 3);
const TICK_MS = Number(cfg.BANDING_TICK_MS || 60 * 1000);
const VERSION = 1;

// THE "BANDS VISIBLY" THRESHOLD. p75 of the 40-film library-stratified sample. Deliberately NOT
// recomputed from the growing cache: a threshold that chases its own data drifts, and the targeted
// blind-spot sample is biased by construction (it only sampled BPP+ >= 75). Round number, fixed
// reference, revisited only against a subjective label.
const BAND_HIGH = Number(cfg.BANDING_HIGH || 2.817);

let cache = new Map();
let _tickLock = false;
let _busy = false;
let _last = null;
let _child = null;
let _session = null;
let _units = [];

// ---- cache ------------------------------------------------------------------------------------
function load() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    cache = new Map(Object.entries(j.entries || {}));
    console.log(`banding: loaded ${cache.size} measurement(s)`);
  } catch { cache = new Map(); }
}
let _dirty = false;
function save() {
  if (!_dirty) return;
  try {
    const out = { v: VERSION, ts: Date.now(), entries: Object.fromEntries(cache) };
    fs.writeFileSync(`${CACHE_FILE}.tmp`, JSON.stringify(out));
    fs.renameSync(`${CACHE_FILE}.tmp`, CACHE_FILE);
    _dirty = false;
  } catch (e) { console.log(`banding: cache write failed — ${e.message}`); }
}

const toolReady = () => { try { return fs.statSync(FFMPEG).isFile(); } catch { return false; } };

// A unit's identity for staleness: same rule as the probe's `measuredFrom`, so a replaced file
// re-queues rather than keeping a measurement of a copy that no longer exists.
const fileId = (f) => (f ? `${f.path}|${f.size || 0}|${f.mtime || ''}` : '');
const firstFile = (u) => (u && Array.isArray(u.files) && u.files[0]) || null;

function entryFor(u) { return u ? cache.get(u.key) : null; }
function measured(u) {
  const e = entryFor(u);
  return !!(e && !e.error && e.cambiMean != null && e.measuredFrom === fileId(firstFile(u)));
}
// An entry whose file changed, predates the current measurement version, or was measured with FEWER
// CLIPS than we now take. That last clause matters: raising SAMPLES from 4 to 8 would otherwise leave
// the first 85 units at the old precision forever, and a dataset where some films carry a reliable
// residual and others do not is worse for analysis than one that is uniformly coarse — you cannot
// tell which rows are entitled to drive a correction. Re-measuring them is ~2 hours of night budget,
// which is the cheapest possible way to buy a uniform dataset.
function stale(u) {
  const e = entryFor(u);
  if (!e || e.error) return false;
  if (e.measuredFrom !== fileId(firstFile(u))) return true;
  if ((e.v || 0) < VERSION) return true;
  return (e.samples || 0) < SAMPLES;
}
// Errors are retried, but not forever and not immediately: a file the tool cannot read will fail
// every night otherwise and starve the queue. Same shape as the probe's error handling.
const RETRY_MS = 7 * 24 * 3600 * 1000;
function retryable(u) {
  const e = entryFor(u);
  return !!(e && e.error && Date.now() - (e.ts || 0) > RETRY_MS);
}

function pending() {
  return _units.filter((u) => firstFile(u) && (!entryFor(u) || stale(u) || retryable(u)));
}

// ---- the measurement --------------------------------------------------------------------------
function run(file, phase = 0) {
  return new Promise((resolve) => {
    const args = [file, '--json', '--samples', String(SAMPLES), '--seclen', String(SECLEN),
      '--phase', String(phase)];
    let out = ''; let err = '';
    let child;
    // detached:true for the same reason as the probe: the image has no pkill, so killing the whole
    // process group is the only way to stop the ffmpeg running under the shell. Killing the shell
    // alone would orphan a live encode — the exact "stopped but still burning CPU" state the
    // thermal gate exists to prevent.
    try {
      child = spawn(SCRIPT, args, {
        stdio: ['ignore', 'pipe', 'pipe'], detached: true,
        env: { ...process.env, BANDING_FFMPEG: FFMPEG, BANDING_THREADS: String(THREADS),
          BANDING_FFPROBE: FFMPEG.replace(/ffmpeg$/, 'ffprobe') },
      });
    } catch (e) { return resolve({ error: `spawn failed: ${e.message}` }); }
    _child = child;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { _child = null; resolve({ error: `spawn failed: ${e.message}` }); });
    child.on('close', (code, signal) => {
      _child = null;
      if (signal) return resolve({ error: `killed (${signal})`, killed: true });
      if (code !== 0) return resolve({ error: `exit ${code}: ${String(err).trim().slice(0, 200)}` });
      try { resolve(JSON.parse(out)); }
      catch { resolve({ error: `unparseable output: ${String(out).trim().slice(0, 200)}` }); }
    });
  });
}

function kill(why = 'stopped') {
  if (!_child) return false;
  try { process.kill(-_child.pid, 'SIGKILL'); } catch { /* already gone */ }
  console.log(`banding: killed — ${why}`);
  return true;
}

// ---- the tick ---------------------------------------------------------------------------------
async function bandingTick() {
  if (_tickLock) return;
  _tickLock = true;
  try {
    if (!toolReady()) { reportProgress(); return; }
    const manual = !!(_session && !_session.stopping);
    await refreshUnits(60 * 1000);
    // Same gate as the probe: window, night budget, Movie Mode, CPU temp, playback, Jellyfin.
    const blocked = await probe.probeGate(manual);
    if (blocked) { reportProgress({ detail: `${blocked} · ${pending().length} left` }); return; }
    // The probe wins whenever it has FRESH work — a never-measured or replaced unit. Its refinement
    // work does not outrank a unit that has never been measured at all.
    if (!manual && probe.probeHasFreshWork()) {
      reportProgress({ detail: `yielding to the quality probe · ${pending().length} left` });
      return;
    }

    if (!_units.length) { reportProgress(); return; }
    const queue = pending();
    if (!queue.length) { reportProgress(); return; }

    // Oldest-first by nothing clever: this is a one-pass backfill, not a refinement loop, so any
    // stable order covers the library in the same number of nights. Stale units go first because a
    // measurement of a file that no longer exists is actively misleading, unlike a missing one.
    queue.sort((a, b) => (stale(b) ? 1 : 0) - (stale(a) ? 1 : 0));
    const u = queue[0];
    const f = firstFile(u);

    _busy = true;
    reportProgress({ detail: `measuring ${u.title}` });
    const t0 = Date.now();
    const prev = entryFor(u);
    // Phase-shift on a re-measure so a revisit samples the gaps rather than re-encoding the same
    // clips — the same bug the probe had until 2026-08-18, avoided here from the start.
    const visits = (prev && prev.measuredFrom === fileId(f) ? (prev.visits || 0) : 0);
    const r = await run(f.path, probe.phaseForVisit(visits));
    const wallMs = Date.now() - t0;
    _busy = false;
    probe.billNight(wallMs);

    if (r.killed) return;
    if (r.error) {
      cache.set(u.key, { v: VERSION, ts: Date.now(), key: u.key, title: u.title,
        error: String(r.error).slice(0, 300), measuredFrom: fileId(f) });
      _dirty = true; save();
      console.log(`banding: ${u.title} FAILED — ${r.error}`);
      return;
    }

    cache.set(u.key, {
      v: VERSION, ts: Date.now(), key: u.key, title: u.title, unit: u.kind,
      cambiMean: r.cambiMean, cambiMax: r.cambiMax, cambiMin: r.cambiMin,
      // Mean luma, kept so the darkness degeneracy check can be re-run at any time on live data
      // rather than trusted from a report. It is the check that killed gShare.
      yavg: r.yavg,
      sampleCambi: Array.isArray(r.sampleCambi) ? r.sampleCambi : null,
      samplePos: Array.isArray(r.samplePos) ? r.samplePos : null,
      samples: r.samplesOk, seclen: r.seclen,
      visits: visits + 1,
      wallMs, measuredFrom: fileId(f),
    });
    _dirty = true; save();
    _last = { title: u.title, cambiMean: r.cambiMean, secs: Math.round(wallMs / 1000), ts: Date.now() };
    const left = pending().length;
    console.log(`banding: ${u.title} — cambi ${r.cambiMean} (luma ${r.yavg}) in `
      + `${Math.round(wallMs / 1000)}s, ${left} left`);
    metrics.emitEvent('banding_unit', { ti: u.title, cambi: r.cambiMean, luma: r.yavg,
      secs: Math.round(wallMs / 1000), kind: u.kind });
    reportProgress();
  } catch (e) {
    console.log(`banding: tick error — ${e.message}`);
  } finally { _busy = false; _tickLock = false; }
}

// ---- manual session ---------------------------------------------------------------------------
// Brennan's "the box is free, catch up on the library" control — he said he would run this through
// the day at his discretion. Waives only the SCHEDULE (window + night budget). Every safety gate
// still applies: Movie Mode, CPU temp, someone watching, Jellyfin busy. Same contract as the
// probe's manual session, deliberately, so one mental model covers both.
function sessionStart() {
  _session = { started: Date.now(), stopping: false };
  console.log('banding: manual session started — schedule waived, safety gates still on');
  bandingTick();
  return _session;
}
function sessionStop(why = 'stopped') {
  if (!_session) return null;
  const s = { ..._session, stopped: Date.now(), why };
  _session = null;
  kill(why);
  console.log(`banding: manual session stopped — ${why}`);
  return s;
}
const sessionLive = () => !!(_session && !_session.stopping);

// ---- state for the Jobs tab -------------------------------------------------------------------
// The unit list is refreshed by the tick, but the tick returns EARLY when a gate is closed — and
// the Jobs tab is read exactly then, all day, outside the window. Without this the tab would show
// "0 left" until the first tick that actually got through, i.e. it would look finished while
// ~1000 units were untouched. Refresh here too, cheaply, and only when it is empty or cold.
let _unitsAt = 0;
async function refreshUnits(maxAgeMs = 10 * 60 * 1000) {
  if (_units.length && Date.now() - _unitsAt < maxAgeMs) return;
  try { _units = await probe.getUnits(); _unitsAt = Date.now(); } catch { /* keep what we have */ }
}

// THE CONTRACT, which is easy to get wrong: stateFn is called SYNCHRONOUSLY by jobs.js and must
// return a STRING state or null. Returning a Promise (or an object) makes the registry store the
// Promise, and the tab renders a blank card — which is exactly what the first version of this did.
// null means "no opinion, fall through to the registry's own idle/never/paused determination", which
// is what gives us Movie Mode and the night window for free.
//
// `detail` and `progress` are NOT returned from here — they are PUSHED via jobs.report() from the
// tick, for the same reason the probe does it: computing them needs the unit list, and a full
// Radarr+Sonarr enumeration is far too expensive to run on every render of the Jobs tab.
function bandingState() {
  if (!toolReady()) return 'off';
  if (_busy) return 'running';
  if (sessionLive()) return 'waiting';
  return null;
}

// Push the human-readable line and the bar. Cheap: `pending()` is a filter over an already-cached
// unit list, so this can be called from the tick even on the gated early-return paths.
function reportProgress(extra = {}) {
  const total = _units.length;
  const left = pending().length;
  const done = Math.max(0, total - left);
  let detail;
  if (!toolReady()) detail = 'libvmaf tool not installed — run scripts/setup-vmaf-tool.sh';
  else if (!total) detail = 'waiting for the library list';
  else if (!left) detail = 'every unit measured';
  else if (extra.detail) detail = extra.detail;
  else detail = `${done}/${total} measured · ${left} left`;
  jobs.report('banding', {
    detail,
    progress: total ? { done, total } : null,
    ...(extra.report || {}),
  });
}

// ---- read API for other modules ---------------------------------------------------------------
// The ONE accessor anything else should use. Returns null when unmeasured, which callers must treat
// as "unknown", never as "clean" — 0 and null mean very different things here.
function bandingFor(key) {
  const e = cache.get(key);
  if (!e || e.error || e.cambiMean == null) return null;
  return { cambi: e.cambiMean, cambiMax: e.cambiMax, yavg: e.yavg,
    bands: e.cambiMean >= BAND_HIGH, samples: e.samples, ts: e.ts };
}

// ---- HTTP -------------------------------------------------------------------------------------
app.get('/api/banding', async (_req, res) => {
  await refreshUnits();
  const left = pending().length;
  const vals = [...cache.values()].filter((e) => e && !e.error && e.cambiMean != null)
    .map((e) => e.cambiMean).sort((a, b) => a - b);
  const q = (p) => (vals.length ? +vals[Math.floor(vals.length * p)].toFixed(4) : null);
  res.json({
    version: VERSION, tool: FFMPEG, toolReady: toolReady(),
    samples: SAMPLES, seclen: SECLEN, threshold: BAND_HIGH,
    units: _units.length, measured: cache.size - [...cache.values()].filter((e) => e.error).length,
    // How many carry a reading taken at the CURRENT clip count — the only ones entitled to drive a
    // per-film correction. See the reliability note above SAMPLES.
    atFullPrecision: [...cache.values()].filter((e) => e && !e.error && (e.samples || 0) >= SAMPLES).length,
    errors: [...cache.values()].filter((e) => e.error).length,
    pending: left,
    pctComplete: _units.length ? +(((_units.length - left) * 100) / _units.length).toFixed(1) : 0,
    distribution: vals.length ? { min: q(0), p25: q(0.25), median: q(0.5), p75: q(0.75), max: q(0.999) } : null,
    bandingCount: vals.filter((v) => v >= BAND_HIGH).length,
    night: { spentMin: Math.round(probe.nightSpentMs() / 60000),
      budgetMin: Math.round(probe.nightBudgetMs() / 60000), ...probe.nightWindow() },
    session: _session, busy: _busy, last: _last,
    blockedBy: await probe.probeGate(sessionLive()).catch(() => null),
  });
});

// The full table, for bpp-lab and any offline analysis. Same spirit as /api/probe/dataset.
app.get('/api/banding/dataset', (_req, res) => {
  res.json({
    generated: Date.now(), threshold: BAND_HIGH, samples: SAMPLES, seclen: SECLEN,
    rows: [...cache.values()].map((e) => ({
      key: e.key, title: e.title, kind: e.unit || null,
      cambiMean: e.cambiMean ?? null, cambiMax: e.cambiMax ?? null, cambiMin: e.cambiMin ?? null,
      bands: e.cambiMean != null ? e.cambiMean >= BAND_HIGH : null,
      yavg: e.yavg ?? null,
      sampleCambi: e.sampleCambi || null, samplePos: e.samplePos || null,
      samples: e.samples ?? null, visits: e.visits ?? null,
      error: e.error || null, ts: e.ts || null,
    })),
  });
});

// IMPORT MEASUREMENTS TAKEN OFFLINE. scripts/cambi-probe.js makes the SAME measurement this job
// makes — same CAMBI, same lossless extraction, same grid — so the 85 films measured during the
// 2026-08-20 research round are real data, not a shortcut. Without this they would be re-encoded from
// scratch: ~3 hours of x265 for numbers already on disk.
//
// It is a one-shot migration path and it is deliberately STRICT, because a silently incompatible
// import would poison the cache in a way no error would ever surface:
//   * samples and seclen must MATCH this job's configuration, or the measurement is not comparable
//   * the unit must exist and have a file, so measuredFrom is the live file identity
//   * an existing measurement of the SAME file is never overwritten
// `measuredFrom` has to be built here rather than by the caller: it carries *arr's dateAdded, which
// only the server can see.
app.post('/api/banding/import', async (req, res) => {
  const rows = (req.body && req.body.rows) || [];
  const samples = Number((req.body || {}).samples);
  const seclen = Number((req.body || {}).seclen);
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'no rows' });
  if (samples !== SAMPLES || seclen !== SECLEN) {
    return res.status(400).json({
      error: `geometry mismatch: import is ${samples}x${seclen}s, this job measures ${SAMPLES}x${SECLEN}s`,
    });
  }
  await refreshUnits(0);
  const byKey = new Map(_units.map((u) => [u.key, u]));
  const out = { imported: 0, skippedExisting: 0, unknownKey: 0, noFile: 0, badRow: 0 };
  for (const r of rows) {
    const u = byKey.get(r.key);
    if (!u) { out.unknownKey += 1; continue; }
    const f = firstFile(u);
    if (!f) { out.noFile += 1; continue; }
    if (!(r.cambiMean >= 0)) { out.badRow += 1; continue; }
    const prev = cache.get(u.key);
    if (prev && !prev.error && prev.measuredFrom === fileId(f)) { out.skippedExisting += 1; continue; }
    cache.set(u.key, {
      v: VERSION, ts: r.ts || Date.now(), key: u.key, title: u.title, unit: u.kind,
      cambiMean: r.cambiMean, cambiMax: r.cambiMax ?? null, cambiMin: r.cambiMin ?? null,
      yavg: r.yavg ?? null,
      sampleCambi: Array.isArray(r.sampleCambi) ? r.sampleCambi : null,
      samplePos: Array.isArray(r.samplePos) ? r.samplePos : null,
      samples: r.samples ?? samples, seclen, visits: 1,
      measuredFrom: fileId(f), importedFrom: r.from || 'offline',
    });
    out.imported += 1;
  }
  if (out.imported) { _dirty = true; save(); reportProgress(); }
  console.log(`banding: imported ${out.imported} offline measurement(s)`);
  res.json({ ok: true, ...out, pending: pending().length });
});

app.post('/api/banding/session/start', (_req, res) => res.json({ ok: true, session: sessionStart() }));
app.post('/api/banding/session/stop', (_req, res) => {
  const s = sessionStop('stopped by request');
  res.json({ ok: true, stopped: !!s, ...(s || {}) });
});

// Measure ONE unit now, by key — for spot-checking a film without opening a session.
app.post('/api/banding/run', async (req, res) => {
  const key = String((req.body && req.body.key) || req.query.key || '');
  if (!toolReady()) return res.status(503).json({ error: 'libvmaf tool not installed' });
  if (_busy) return res.status(409).json({ error: 'already measuring' });
  try { _units = await probe.getUnits(); } catch { /* keep the previous list */ }
  const u = _units.find((x) => x.key === key);
  if (!u) return res.status(404).json({ error: `no unit ${key}` });
  const f = firstFile(u);
  if (!f) return res.status(400).json({ error: 'unit has no file' });
  _busy = true;
  const t0 = Date.now();
  const r = await run(f.path, 0);
  const wallMs = Date.now() - t0;
  _busy = false;
  probe.billNight(wallMs);
  if (r.error) return res.status(500).json({ error: r.error });
  cache.set(u.key, { v: VERSION, ts: Date.now(), key: u.key, title: u.title, unit: u.kind,
    cambiMean: r.cambiMean, cambiMax: r.cambiMax, cambiMin: r.cambiMin, yavg: r.yavg,
    sampleCambi: r.sampleCambi || null, samplePos: r.samplePos || null,
    samples: r.samplesOk, seclen: r.seclen, visits: 1, wallMs, measuredFrom: fileId(f) });
  _dirty = true; save();
  res.json({ ok: true, title: u.title, ...r, bands: r.cambiMean >= BAND_HIGH });
});

// ---- boot -------------------------------------------------------------------------------------
function startBanding() {
  load();
  // Prime the queue so the Jobs tab is truthful from the first render rather than after the first
  // tick that clears a gate. Deliberately not awaited — boot must not block on *arr being up.
  refreshUnits().catch(() => {});
  const tracked = jobs.define({
    // Sits directly under the quality probe: same group, weight one below, so the two measurement
    // jobs read as a pair in the tab. `start-session` is the manual control.
    id: 'banding', name: 'Audit · banding probe', group: 'Audit', weight: 99,
    what: 'Measures banding — the artifact BPP+ cannot see',
    every: null,
    scheduleText: 'nightly, after the quality probe · shares its budget',
    pausedByMovieMode: true, actions: ['start-session'],
  }, bandingTick);
  jobs.report('banding', { stateFn: bandingState });
  // Absence of the tool is a CONFIG state, not a failure — the registry's 'off' exists so a missing
  // dependency explains itself instead of looking like a silent breakage on a fresh box.
  if (!toolReady()) {
    jobs.disable('banding', 'libvmaf tool not installed — run scripts/setup-vmaf-tool.sh');
  }
  refreshUnits().then(() => reportProgress()).catch(() => {});
  setInterval(tracked, TICK_MS);
  setInterval(save, 5 * 60 * 1000);
  console.log(`banding: armed — ${SAMPLES}x${SECLEN}s CAMBI per unit, tool ${toolReady() ? 'ready' : 'MISSING'}`
    + `, ${cache.size} measured, threshold ${BAND_HIGH}`);
}

module.exports = { startBanding, bandingFor, bandingTick, sessionStart, sessionStop, sessionLive,
  bandingCache: cache, BAND_HIGH };
