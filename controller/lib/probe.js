'use strict';
// THE NIGHTLY CRF PROBE — measures what each FILM's content actually costs, replacing the single
// global BPP_TARGET=0.13 guess with a per-title measurement. Design + evidence:
// docs/DESIGN-CRF-PROBE.md. Owns: /config/probe-cache.json and the nightly tick. One timer,
// started explicitly by server.js.
//
// THE GOAL, in Brennan's words (2026-08-05) — this settles the design questions below, so re-read
// it whenever one is reopened:
//
//   "score the files with a bpp+ of 100 if they're a perfect tradeoff, lower if they really are
//    lower quality than they should be, and higher if they're losing value per GB... Then the
//    human can decide which movies a quality score of 50 or 70 is sufficient for, and which true
//    greats deserve to eke out every bit of quality even if it costs crazy disk space."
//
// WHAT IS MEASURED, AND WHAT IT IS KEYED BY. The probe measures CONTENT COMPLEXITY — how many
// bits per pixel this film's imagery costs at a fixed quality. That is a property of the FILM, not
// of the torrent: Casablanca's grain is Casablanca's regardless of which rip is on disk. So the
// cache is keyed by film (`mv:<radarrId>` / `tv:<seriesId>:<season>`), NOT by file path, exactly as
// Brennan put it: "film to film, not torrent source to torrent source, we use the same # for each
// file of a given film."
//
// Two consequences, and the second is the one that pays for the whole project:
//   - Re-downloading a film does NOT invalidate its measurement. The file's bitrate changed; the
//     content's complexity did not. The entry is marked stale and refreshed at low priority.
//   - A CANDIDATE release can be scored WITHOUT PROBING IT. Its size and resolution are known from
//     the indexer, and the film's complexity is already measured, so the Audit/Upgrade tabs can
//     predict a candidate's true BPP+ before downloading a byte. That is impossible under the flat
//     BPP_TARGET, which cannot tell a grainy film from a clean one.
//
// LIVE SINCE 2026-08-06 (it shipped observe-only for one night first). installScoring() injects the
// per-film denominator into arr-inspect.js, so every BPP+ in the app — Audit rows, candidate cards,
// the library table — is now scored against the film's own measured complexity where one exists, and
// against the shrinkage estimate where it does not.
//
// WHY IT WAS SAFE TO CUT OVER BEFORE CALIBRATION. The anchor (HEADROOM_TARGET) is what puts 100 at
// Brennan's "perfect tradeoff", and it is NOT yet pinned to films he has judged. But the anchor is a
// single read-time multiplier applied equally to every title, so leaving it unpinned costs only the
// absolute LEVEL of the scale — the per-film ranking, which is what the Audit tab acts on, is correct
// the moment the measurement exists. Night one confirmed the level is roughly right anyway: the
// library median moved 68 -> 69. Recalibrating later changes one constant and requires no re-probing.
//
// THE HONEST LIMITATION: at cutover only 69 of 1014 units were measured, so most titles are scored
// against an estimate. That estimate is derived from measured films rather than invented, and the
// measured median (0.1237) sits within 5% of the flat constant it replaces, so an unmeasured film's
// score barely moves. Every row carries its basis so the reader can tell the difference.
//
// WHY IN THE CONTROLLER rather than a systemd timer like ps4fix: every gate it needs is already
// here — Movie Mode, "is Jellyfin playing right now", CPU temperature, the /data mount and the
// ffmpeg binary. A host timer would have to ask the controller for all of it anyway.
//
// READ-ONLY BY CONSTRUCTION: /data is mounted :ro, so the probe cannot touch a source file even
// with a bug. Everything it writes goes to /config.

const fs = require('fs');
const { spawn } = require('child_process');
const app = require('./app');
const { cfg, HOST } = require('./config');
const { tfetch, arrGet } = require('./clients');
const { isMasterPaused, pauseReason } = require('./state');
const jobs = require('./jobs');
const { readTempC } = require('./system-stats');
const { bppOf, bppIndex, BPP_TARGET, setComplexityResolver, X265_EFFICIENCY } = require('./arr-inspect');
const metrics = require('../metrics');

// ---- MEASUREMENT CONSTANTS ───────────────────────────────────────────────────────────────────
// Bumping ANY of these invalidates the whole cache, because a measurement taken under different
// settings is not comparable with one taken under these. That is what PROBE_VERSION enforces.
const PROBE_VERSION = 1;
// NEVER change this to "match the display". It defines the cache — ~1000 units and weeks of
// nights. The panel's resolution is a SCORING variable applied at read time, where changing it is
// free. The projector died on 2026-08-01 while this was being designed, which is exactly the
// event that would have invalidated everything had the two been conflated. 1920 is also where the
// hardware is going: the replacement projector's hard requirement is a native 1920x1080 panel.
// (Brennan's call 2026-08-05, knowing 1280 would be ~2x cheaper and somewhat sharper today.)
const PROBE_REFERENCE_WIDTH = 1920;
const PROBE_CRF = 20;
// MEASURED 2026-08-05, and 'medium' wins on the thing that matters. A faster preset is cheaper but
// it COMPRESSES the spread between titles, and that spread is the entire product — the probe exists
// to tell a grainy 1943 transfer apart from clean modern digital:
//
//   preset     Blade Runner 2049 R   Casablanca R   separation   cost/title
//   medium              4.27             1.56          2.74x      148-231s
//   fast                4.64             1.84          2.52x      141-171s
//   veryfast            4.74             1.85          2.56x      128-159s
//
// veryfast buys ~22% speed for ~7% less discrimination. Not worth it: the schedule is set by the
// night budget, not by this, and a blunter ruler is permanent while a slower pass is temporary.
const PROBE_PRESET = 'medium';
const PROBE_SAMPLES = 8;      // 8 is the floor, not a luxury: scene complexity varies 8.2x WITHIN
const PROBE_SECLEN = 4;       // one film, so a single clip produces a number with no meaning.
const PROBE_THREADS = 3;      // of 4 cores — a probe must never leave the box unresponsive.
const PROBE_SCRIPT = '/app/scripts/probe-film.sh';

// ---- SCHEDULING CONSTANTS ────────────────────────────────────────────────────────────────────
const PROBE_TICK_MS = 60 * 1000;
const PROBE_WINDOW_START = Number(cfg.PROBE_WINDOW_START || 1);   // local hour, inclusive
const PROBE_WINDOW_END = Number(cfg.PROBE_WINDOW_END || 6);       // local hour, exclusive
// 4h of the 5h window (Brennan's call, 2026-08-05) — ~17 nights to a full first pass instead of
// ~33. The remaining hour is deliberate slack so a long unit started at 04:55 still finishes well
// before the hard 06:00 stop.
const PROBE_NIGHT_BUDGET_MS = Number(cfg.PROBE_NIGHT_BUDGET_MS || 4 * 3600 * 1000);
// 80C. The NUC has form here: on 2026-07-09 an uncapped 03:00 Jellyfin trickplay task ran straight
// through the following day and cooked it; the fix was a hard MaxRuntime. This is the same class
// of job, so it gets BOTH a hard window and a night budget, and the running ffmpeg is KILLED when
// either closes — not merely not-restarted, which is the failure mode that let trickplay run all day.
//
// TUNED AGAINST THIS BOX'S ACTUAL DISTRIBUTION, 2026-08-05 (3 days of /api/metrics system samples,
// n=25211): p50 68C, p75 72C, p90 76C, max 94C; only 5.1% of all samples and 3.9% of 01:00-06:00
// samples reach 80C. The first draft used 80/72 and it was wrong in both directions — 80C is
// merely "busy" here, not "in trouble", and a 72C resume sits BELOW the normal p75, so after one
// trip the probe would have waited for a temperature the box does not reach while downloading.
// The verification run on 2026-08-05 hit exactly that: every manual probe refused at 83-86C while
// the NUC was doing perfectly ordinary work.
//
// The real protection against the 2026-07-09 trickplay incident is the hard window + night budget
// + kill-on-close. Temperature is the secondary guard, so it should fire on GENUINELY hot (~top 1%,
// still well under the ~100C throttle point), not on "working hard".
// RAISED TO 95 on Brennan's push-back (2026-08-05): "this box runs HOT... I'm very used to the NUC
// running hot." He is right and 88 was too conservative — observed max over 3 days was 94C, so 88
// would have tripped on genuinely ordinary peaks.
//
// The correction to the reasoning, though: THIS GATE WAS NEVER PROTECTING THE SILICON. A mobile
// NUC part has Tjmax ~100C and throttles itself there — it cannot be cooked by a userspace encode,
// and the 2026-07-09 trickplay incident was a runaway *duration*, not a temperature. What the gate
// actually protects is RESPONSIVENESS: a background measurement nobody is waiting for should yield
// when the box is already saturated. Above ~95C the CPU is about to throttle anyway, so probing
// harder buys nothing — it just makes everything else slower.
//
// The better lever for that turned out to be jellyfinBusy() below, which yields to library scans
// and trickplay by name rather than inferring contention from a thermometer.
const PROBE_TEMP_MAX = Number(cfg.PROBE_TEMP_MAX || 95);
// Hysteresis: once the thermal gate trips, stay stopped until the box has cooled to this, not
// merely back under the limit. Without the gap a NUC sitting AT the limit would kill a unit,
// restart 60s later, heat straight back and kill again — burning the whole 4h budget on partial
// units it never banks. 88C is a temperature normal load actually returns to (p90 is 76C).
const PROBE_TEMP_RESUME = Number(cfg.PROBE_TEMP_RESUME || 88);
const PROBE_GATE_CHECK_MS = 15 * 1000;  // re-check the gates DURING a probe, not only before it
const QUEUE_TTL_MS = 60 * 60 * 1000;
// A season is represented by 2 episodes (Brennan's call, 2026-08-05): within a season the source,
// release group and encoder settings are near-identical, while BETWEEN seasons they frequently
// differ (a different group, a later remaster). Probing per season is what takes TV from 1696
// probes to ~312, and 2 episodes rather than 1 is what makes the homogeneity check below possible.
const EPISODES_PER_SEASON = 2;
// If the two sampled episodes disagree by more than this, the season is NOT homogeneous and its
// average is a fiction. Flagged rather than silently averaged.
const SEASON_DISAGREE = 0.25;

// ---- CACHE ───────────────────────────────────────────────────────────────────────────────────
// A separate file from state.json on purpose: state.json is rewritten IN FULL on a 500ms debounce
// from a dozen call sites, and adding ~1000 entries of per-sample data to that write path is a bad
// trade. This one is written once per completed unit.
const CACHE_PATH = '/config/probe-cache.json';
// unitKey -> measurement. Keyed by FILM, not by file — see the header. `measuredFrom` records the
// file it was taken from so a replaced file can be refreshed later without invalidating anything.
const probeCache = new Map();
let _cacheDirty = false;

// Identity of the file a measurement was taken from. A changed identity does NOT invalidate the
// film's complexity; it only marks the entry as worth refreshing once the first pass is done.
const fileId = (f) => `${f.path}|${f.size}|${f.mtime}`;

function loadProbeCache() {
  let raw;
  try { raw = fs.readFileSync(CACHE_PATH, 'utf8'); }
  catch { return; }                       // first boot — nothing probed yet
  let obj;
  try { obj = JSON.parse(raw); }
  catch {
    try { fs.renameSync(CACHE_PATH, `${CACHE_PATH}.corrupt-${Date.now()}`); } catch { /* */ }
    console.log('WARN probe: /config/probe-cache.json is corrupt — backed it up, starting empty');
    return;
  }
  // A settings change makes every stored measurement incomparable with new ones. Dropping the
  // cache costs weeks of nights, so say so loudly rather than silently re-probing the library.
  if (obj.v !== PROBE_VERSION) {
    console.log(`probe: cache was written under v${obj.v}, this build is v${PROBE_VERSION}`
      + ` — discarding ${Object.keys(obj.entries || {}).length} measurements and re-probing`);
    return;
  }
  for (const [k, v] of Object.entries(obj.entries || {})) probeCache.set(k, v);
  // A frozen anchor must survive a restart, or the score would silently re-derive itself from a
  // different slice of the library every time the container is rebuilt.
  if (obj.calib) _calib = obj.calib;   // diagnostic only — never feeds the score
  console.log(`probe: loaded ${probeCache.size} cached measurements (v${PROBE_VERSION}, ref width ${PROBE_REFERENCE_WIDTH})`);
  // A manual session outlives a restart — see sessionStart(). Re-armed by startProbe() after the
  // gates are ready, not here, so a boot cannot begin an encode before the tick loop exists.
  _resumeSession = !!obj.session;
}
let _resumeSession = false;

function saveProbeCache() {
  if (!_cacheDirty) return;
  try {
    const entries = {};
    for (const [k, v] of probeCache) entries[k] = v;
    // Atomic replace, exactly as persistState() does. A truncated cache parses as empty, which
    // would silently throw away every night of work done so far.
    const tmp = `${CACHE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: PROBE_VERSION, refWidth: PROBE_REFERENCE_WIDTH,
      ts: Date.now(), calib: _calib,
      // Only whether a session is open, not its counters: the units/minutes are a report on THIS
      // process's work and resetting them on restart is honest. What must persist is the intent.
      session: _session ? { startedAt: _session.startedAt } : null,
      entries }));
    fs.renameSync(tmp, CACHE_PATH);
    _cacheDirty = false;
  } catch (e) { console.log(`probe: cache write failed — ${e.message}`); }
}

// ---- THE MEASUREMENT ─────────────────────────────────────────────────────────────────────────
// Shells out to scripts/probe-film.sh rather than re-implementing the ffmpeg loop in JS. One
// implementation means the number a human measures by hand is the number the scheduler stores —
// two copies of this logic would drift, and a drifted probe is an uncalibrated one.
let _child = null;

function runProbe(file) {
  return new Promise((resolve) => {
    const args = [file, '--json',
      '--width', String(PROBE_REFERENCE_WIDTH), '--samples', String(PROBE_SAMPLES),
      '--seclen', String(PROBE_SECLEN), '--crf', String(PROBE_CRF),
      '--preset', PROBE_PRESET, '--threads', String(PROBE_THREADS)];
    let out = '', err = '';
    let child;
    // detached:true puts the script AND every ffmpeg it spawns in one process group, so a single
    // kill(-pid) takes the whole tree down. This is not a stylistic choice: the image has no
    // pgrep/pkill (confirmed 2026-08-01), so a group kill is the ONLY way to stop the ffmpeg under
    // the shell. Killing just the shell would orphan a running 3-thread x265 encode — the exact
    // "stopped but still burning CPU" state the thermal gate exists to prevent.
    try { child = spawn(PROBE_SCRIPT, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true }); }
    catch (e) { return resolve({ error: `spawn failed: ${e.message}` }); }
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

function killProbe(why) {
  if (!_child) return;
  console.log(`probe: stopping mid-unit — ${why}`);
  // Negative pid = the whole process group (see the detached:true note above): the shell AND the
  // ffmpeg it is currently running.
  try { process.kill(-_child.pid, 'SIGKILL'); } catch { /* group already gone */ }
  try { _child.kill('SIGKILL'); } catch { /* already reaped */ }
}

// ---- THE UNIT QUEUE ──────────────────────────────────────────────────────────────────────────
// A "unit" is one film, or one TV season (represented by EPISODES_PER_SEASON episodes).
let _queue = { ts: 0, units: [] };

// "HH:MM:SS(.ms)" -> seconds. Same shape audit.js parses out of mediaInfo.runTime.
function secs(rt) {
  const m = /^(\d+):(\d+):(\d+)/.exec(String(rt || ''));
  return m ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) : 0;
}
// The file's CURRENT bpp — the numerator of BPP+, exactly as the Audit tab computes it today. The
// probe supplies the denominator; this is what it will be divided by, so it must be derived the
// same way or the comparison in /api/probe/score is meaningless.
const fileBppOf = (mi, bytes) => bppOf(mi, secs((mi || {}).runTime) > 0 ? (bytes * 8) / secs((mi || {}).runTime) : null);

async function buildUnits() {
  const units = [];
  const movies = await arrGet('radarr', '/movie').catch(() => []);
  for (const m of movies) {
    const mf = m.movieFile;
    if (!m.hasFile || !mf || !mf.path) continue;
    units.push({ kind: 'movie', id: m.id, key: `mv:${m.id}`,
      title: `${m.title} (${m.year || '?'})`,
      source: ((mf.quality || {}).quality || {}).name || null,
      bpp: fileBppOf(mf.mediaInfo, mf.size || 0),
      files: [{ path: mf.path, size: mf.size || 0, mtime: mf.dateAdded || null }] });
  }
  const series = await arrGet('sonarr', '/series').catch(() => []);
  for (const s of series) {
    if (!s.statistics || !s.statistics.episodeFileCount) continue;
    let fl;
    try { fl = await arrGet('sonarr', `/episodefile?seriesId=${s.id}`); } catch { continue; }
    const bySeason = new Map();
    for (const f of (fl || [])) {
      if (!f.path) continue;
      if (!bySeason.has(f.seasonNumber)) bySeason.set(f.seasonNumber, []);
      bySeason.get(f.seasonNumber).push(f);
    }
    for (const [sn, files] of bySeason) {
      if (!files.length) continue;
      files.sort((a, b) => String(a.path).localeCompare(String(b.path)));
      // Sample from the INTERIOR of the season. Premieres and finales are routinely the atypical
      // episodes — a feature-length pilot, an effects-heavy finale — and a season's representative
      // number should not be anchored to them.
      const picks = [];
      for (let i = 0; i < Math.min(EPISODES_PER_SEASON, files.length); i++) {
        picks.push(files[Math.floor(files.length * (i + 1) / (EPISODES_PER_SEASON + 1))] || files[i]);
      }
      const bpps = picks.map((f) => fileBppOf(f.mediaInfo, f.size || 0)).filter((b) => b != null);
      units.push({ kind: 'season', id: s.id, season: sn, key: `tv:${s.id}:${sn}`,
        title: `${s.title} S${String(sn).padStart(2, '0')}`,
        source: ((picks[0].quality || {}).quality || {}).name || null,
        episodes: files.length,
        bpp: bpps.length ? bpps.reduce((a, b) => a + b, 0) / bpps.length : null,
        files: picks.map((f) => ({ path: f.path, size: f.size || 0, mtime: f.dateAdded || null })) });
    }
  }
  return units;
}

// Key -> unit, and the memo for resolved complexity. Both exist because bppIndex() is now called
// per-row by audit.js — thousands of times per Audit render — and the estimator ladder below is
// O(units) per lookup. Without a memo a single render would be ~1M filter operations. Both are
// cleared whenever the inputs change: a new measurement (setEntry) or a queue rebuild.
let _byKey = new Map();
let _cxMemo = new Map();
const invalidateCx = () => { _cxMemo.clear(); };

// The ONLY place probeCache is written. Centralised so the memo cannot go stale behind a direct
// .set() — that would silently serve a pre-measurement score for the rest of the process's life.
function setEntry(key, entry) {
  probeCache.set(key, entry);
  _cacheDirty = true;
  invalidateCx();
}

async function getUnits() {
  if (Date.now() - _queue.ts < QUEUE_TTL_MS && _queue.units.length) return _queue.units;
  const units = await buildUnits();
  if (units.length) {
    _queue = { ts: Date.now(), units };
    _byKey = new Map(units.map((u) => [u.key, u]));
    invalidateCx();
  }
  return _queue.units;
}

const entryFor = (u) => probeCache.get(u.key);
const unitMeasured = (u) => { const e = entryFor(u); return !!(e && !e.error); };
// The film is measured, but from a file that is no longer the one on disk (a re-download, an
// Audit swap). The complexity still applies — content did not change — so this is a refresh, not
// an invalidation, and it waits until every unmeasured film has had its first pass.
const unitStale = (u) => {
  const e = entryFor(u);
  return !!(e && !e.error && e.measuredFrom && e.measuredFrom !== fileId(u.files[0]));
};

// The next thing to measure. Order is deliberate and it is NOT "biggest first": a first pass whose
// early results were all blockbusters would calibrate the constant against a skewed slice, and the
// estimator ladder leans on the scanned set being representative. Movies before TV because movies
// are what the Audit tab's disk decisions are actually about. Never-measured always beats stale.
function nextUnit(units) {
  const fresh = units.filter((u) => !entryFor(u));
  const pool = fresh.length ? fresh : units.filter(unitStale);
  if (!pool.length) return null;
  pool.sort((a, b) => (a.kind === b.kind ? a.key.localeCompare(b.key) : (a.kind === 'movie' ? -1 : 1)));
  return pool[0];
}

// ---- GATES ───────────────────────────────────────────────────────────────────────────────────
function inWindow(d = new Date()) {
  const h = d.getHours();
  // A window that wraps midnight (e.g. 23 -> 6) is written START > END, so handle both.
  return PROBE_WINDOW_START <= PROBE_WINDOW_END
    ? (h >= PROBE_WINDOW_START && h < PROBE_WINDOW_END)
    : (h >= PROBE_WINDOW_START || h < PROBE_WINDOW_END);
}

// "Is anyone watching right now" — one /Sessions call. FAILS CLOSED: if Jellyfin cannot be
// reached we assume someone IS watching and skip the tick. A probe is a 3-thread x265 encode on a
// 4-core box; stuttering somebody's film to save 60s of scheduling is the wrong trade, and the
// work is never lost — it just happens tomorrow night.
//
// IGNORES ZOMBIE SESSIONS. A Jellyfin session keeps its NowPlayingItem when a client goes away
// without stopping playback — background the iOS app mid-film, kill the Fire Stick, lose wifi — and
// nothing ever clears it. Without a staleness check, one abandoned session blocks the probe FOREVER:
// every night reports "someone is watching" and measures nothing, and the failure is silent because
// that is also what a normal busy evening looks like.
//
// Real risk, and near-missed on night one (2026-08-05): a Streamyfin/iPhone session was playing at
// 22:27, and had it not ended cleanly the 01:00 window would have produced zero films. The library
// already carries two sessions days old, so sessions demonstrably persist on this server.
//
// STALE means LastActivityDate older than PLAY_STALE_MS. A genuinely playing client heartbeats every
// few seconds, so 15 minutes is far outside normal jitter while still being shorter than the pause a
// human takes mid-film — and a paused-but-live client keeps heartbeating anyway, so a real pause is
// never mistaken for a zombie. A session with no LastActivityDate at all is treated as LIVE, because
// an unparseable timestamp is not evidence that nobody is watching.
const PLAY_STALE_MS = Number(cfg.PROBE_PLAY_STALE_MS || 15 * 60 * 1000);
function sessionLive(s) {
  if (!s.NowPlayingItem) return false;
  const t = Date.parse(s.LastActivityDate || s.LastPlaybackCheckIn || '');
  if (!Number.isFinite(t)) return true;              // no usable timestamp -> assume live
  return (Date.now() - t) < PLAY_STALE_MS;
}
async function anyonePlaying() {
  try {
    const r = await tfetch(`${HOST.jellyfin}/Sessions`,
      { headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' } }, 6000);
    if (!r.ok) return true;
    const sessions = await r.json();
    if (!Array.isArray(sessions)) return true;
    return sessions.some(sessionLive);
  } catch { return true; }
}

// Jellyfin's own heavy scheduled work. DISCOVERED 2026-08-05 during the first verification run:
// the NUC was sitting at 86C with no one watching, and the cause was Jellyfin at 137% CPU running
// "Scan Media Library". Worse, the trickplay task is a DailyTrigger at 03:00 capped at 4h (the
// 2026-07-09 runaway fix), so it occupies 03:00-07:00 — overlapping most of the probe window.
//
// Two CPU-bound jobs on 4 cores is bad for both: the probe gets slower and hotter, and Jellyfin's
// scan/trickplay — which directly affect what a human sees in the UI — get starved by a background
// measurement nobody is waiting for. Jellyfin wins that contest every time, so the probe yields.
//
// Only the genuinely heavy tasks count. Most scheduled tasks are cheap bookkeeping and blocking on
// them would idle the probe for no reason.
// DEFAULT OFF (Brennan's call, 2026-08-05: "keep 01:00-06:00, let them share"). He is comfortable
// with the box running hot and trickplay is incremental, so most nights the collision is brief.
// Yielding would also have meant ZERO progress on any night Jellyfin has a stuck task — which is
// exactly the state the server is in tonight (a "Scan Media Library" wedged at 92.76% for over an
// hour; parked for investigation, see docs/TODO-quality.md). A gate that turns one stuck Jellyfin
// task into weeks of lost probing is the wrong default.
//
// The machinery stays because the reasoning behind it is still sound if contention ever becomes a
// real problem: set PROBE_YIELD_TO_JELLYFIN=1 in keys.env to turn it back on, no code change.
const PROBE_YIELD_TO_JELLYFIN = String(cfg.PROBE_YIELD_TO_JELLYFIN || '0') === '1';
const JF_HEAVY = /trickplay|scan media library|chapter image|extract|refresh people|thumbnails/i;
async function jellyfinBusy() {
  if (!PROBE_YIELD_TO_JELLYFIN) return false;
  try {
    const r = await tfetch(`${HOST.jellyfin}/ScheduledTasks`,
      { headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' } }, 6000);
    if (!r.ok) return null;                       // cannot tell — caller decides (see blockedBy)
    const tasks = await r.json();
    if (!Array.isArray(tasks)) return null;
    const hot = tasks.find((t) => t.State === 'Running' && JF_HEAVY.test(String(t.Name || '')));
    return hot ? String(hot.Name) : false;
  } catch { return null; }
}

// Night accounting. `night` is the date-string of the window's START, so a run that crosses
// midnight still bills to one night rather than resetting its budget at 00:00.
let _night = { key: '', spentMs: 0, units: 0 };
// LOCAL date, not toISOString(). The window is expressed in local hours (getHours()), so bucketing
// it by the UTC date put the boundary at 17:00 PDT — the middle of an evening, splitting nothing
// useful and rolling the budget seven hours before local midnight. Every part of this accounting
// must speak one clock.
function nightKey(d = new Date()) {
  const ref = new Date(d);
  if (PROBE_WINDOW_START > PROBE_WINDOW_END && d.getHours() < PROBE_WINDOW_END) ref.setDate(ref.getDate() - 1);
  return `${ref.getFullYear()}-${String(ref.getMonth() + 1).padStart(2, '0')}-${String(ref.getDate()).padStart(2, '0')}`;
}
function rollNight() {
  const k = nightKey();
  if (_night.key !== k) _night = { key: k, spentMs: 0, units: 0 };
}

// Bumped by every sessionStop(). Anything mid-flight compares the value it captured on entry
// against this to notice "the session I belong to has ended" — see probeUnit().
let _stopEpoch = 0;

let _hot = false;   // latched by the thermal hysteresis below
// Returns null when clear to run, else the reason it is not. Used BOTH before starting a unit and
// every PROBE_GATE_CHECK_MS while one is running — the mid-run check is what makes Movie Mode and
// "someone pressed play" actually stop work rather than merely prevent the next unit.
//
// TWO CLASSES OF GATE, and the distinction is the point:
//   SCHEDULE gates (night window, night budget) say "not now, do it later". A human asking for one
//     specific title is entitled to override them — that is what `manual` does.
//   SAFETY gates (Movie Mode, someone watching, CPU temperature) say "this would hurt something".
//     They are NEVER bypassable. "Run it now" is not a reason to stutter a film or cook the NUC.
// Conflating the two is why the first manual verification run on 2026-08-05 returned instantly
// with "outside the night window" — a probe you could only trigger between 01:00 and 06:00.
async function blockedBy(manual = false) {
  if (!manual) {
    if (!inWindow()) return 'outside the night window';
    if (_night.spentMs >= PROBE_NIGHT_BUDGET_MS) return 'night budget spent';
  }
  if (isMasterPaused()) return 'Movie Mode';
  const t = readTempC();
  if (t != null) {
    if (t >= PROBE_TEMP_MAX) _hot = true;
    else if (t <= PROBE_TEMP_RESUME) _hot = false;
    if (_hot) return `CPU at ${t}C (cooling to ${PROBE_TEMP_RESUME}C)`;
  }
  if (await anyonePlaying()) return 'someone is watching';
  // null = could not ask Jellyfin. Unlike playback this fails OPEN: an unreachable Jellyfin is
  // not evidence of contention, and failing closed here would idle the probe every night that
  // Jellyfin restarts. The playback gate already fails closed, which is where it matters.
  const jf = await jellyfinBusy();
  if (jf) return `Jellyfin is running "${jf}"`;
  return null;
}

// ---- THE TICK ────────────────────────────────────────────────────────────────────────────────
// TWO FLAGS, and they are not the same question:
//   _tickLock  someone is inside probeTick — mutual exclusion. Held across the gate checks and the
//              queue build as well as the encode, which is the whole point (see probeTick).
//   _busy      an encode is actually in flight. This is what /api/probe reports, because a human
//              asking "is it probing?" does not mean "is it deciding whether to probe?".
let _tickLock = false;
let _busy = false;
let _last = null;      // last completed unit, for /api/probe

// COMPLEXITY, in the same units as bppOf(): H.264-equivalent bits per pixel per frame.
//
// This is the number that replaces the flat BPP_TARGET=0.13, and expressing it per-pixel is what
// makes it a property of the FILM rather than of the file. The probe encodes x265, so its bitrate
// is in HEVC units and gets the same X265_EFFICIENCY factor bppOf() applies to an HEVC file —
// otherwise the measured denominator and the file's numerator would be in different currencies.
function complexityOf(r) {
  const px = (r.probeW || 0) * (r.probeH || 0) * (r.fps || 0);
  if (!px || !(r.probeBitrate > 0)) return null;
  return +((r.probeBitrate / px) * X265_EFFICIENCY).toFixed(5);
}

// Measure one unit: 1 file for a film, EPISODES_PER_SEASON for a season.
async function probeUnit(u, manual = false) {
  const results = [];
  // A season is EPISODES_PER_SEASON files, so this loop crosses a gap between encodes where nothing
  // is running for killProbe() to kill. A stop landing in that gap would otherwise be invisible
  // here — blockedBy(manual=true) waives the schedule gates, so the loop would happily start the
  // second episode after the human ended the session. Compare the epoch, not `_session`, because
  // sessionStop() clears the session before this ever gets to look at it.
  const epoch = _stopEpoch;
  for (const f of u.files) {
    if (_stopEpoch !== epoch) return { partial: true, reason: 'session stopped' };
    const stop = await blockedBy(manual);
    if (stop) return { partial: true, reason: stop };
    const t0 = Date.now();
    const r = await runProbe(f.path);
    const wallMs = Date.now() - t0;
    // ONLY IN-WINDOW WORK BILLS TO THE NIGHT BUDGET. The budget's job is to cap how long the box
    // encodes during 01:00-06:00; work done at 3pm has already cost nothing from that allowance.
    //
    // This was NOT what the code did, and it is why the nightly run silently stopped happening:
    // a manual session started on 2026-08-06 ran through the daytime, and every one of those
    // encodes was billed to `_night.spentMs`. By 00:44 on 2026-08-09 the bucket held 320 min
    // against a 240 min budget, so when the 01:00 tick arrived blockedBy() answered "night budget
    // spent" and the scheduled probe did nothing — with no error anywhere to show for it.
    // (The module header's claim that daytime session time "does not touch the night's budget"
    // described the intent; nothing implemented it.)
    //
    // A session that runs THROUGH the window still shares the budget, which is the deliberate
    // behaviour documented in §3 of the session header: two jobs, one thermal envelope.
    if (inWindow()) _night.spentMs += wallMs;
    if (r.error) {
      if (r.killed) return { partial: true, reason: 'killed' };
      console.log(`probe: "${u.title}" failed — ${r.error}`);
      // Remember the failure so a permanently-unreadable file cannot be retried every night
      // forever, starving the rest of the queue.
      setEntry(u.key, { v: PROBE_VERSION, ts: Date.now(), title: u.title,
        error: String(r.error).slice(0, 200), measuredFrom: fileId(f) });
      return { error: r.error };
    }
    const cx = complexityOf(r);
    if (cx != null) results.push({ ...r, complexity: cx, wallMs, from: fileId(f) });
  }
  if (!results.length) return { error: 'no usable samples' };

  const cxs = results.map((r) => r.complexity);
  const complexity = cxs.reduce((a, b) => a + b, 0) / cxs.length;
  // Season homogeneity check. If the sampled episodes disagree badly the season's average is a
  // fiction — record it so the estimator and any future cutover can refuse to trust it, rather
  // than quietly applying a meaningless number to a dozen episodes.
  let disagree = 0;
  if (cxs.length > 1) {
    const lo = Math.min(...cxs), hi = Math.max(...cxs);
    disagree = lo > 0 ? (hi - lo) / lo : 0;
    if (disagree > SEASON_DISAGREE) {
      console.log(`probe: ${u.title} episodes disagree by ${Math.round(disagree * 100)}%`
        + ' — season is not homogeneous, its complexity is low-confidence');
    }
  }
  const entry = {
    v: PROBE_VERSION, ts: Date.now(), key: u.key, title: u.title, unit: u.kind,
    source: u.source || null,
    complexity: +complexity.toFixed(5),          // THE number: H.264-equivalent bpp the content needs
    disagree: +disagree.toFixed(3),
    // Provenance — everything needed to re-derive or audit the number later without re-probing.
    probeBitrate: Math.round(results.reduce((a, r) => a + r.probeBitrate, 0) / results.length),
    srcBitrate: Math.round(results.reduce((a, r) => a + r.srcBitrate, 0) / results.length),
    R: +(results.reduce((a, r) => a + r.R, 0) / results.length).toFixed(4),
    codec: results[0].codec, probeW: results[0].probeW, probeH: results[0].probeH, fps: results[0].fps,
    spreadRatio: +(results.reduce((a, r) => a + r.spreadRatio, 0) / results.length).toFixed(3),
    blockMean: results[0].blockMean, blurMean: results[0].blurMean,
    wallMs: results.reduce((a, r) => a + r.wallMs, 0),
    files: results.length, measuredFrom: results[0].from,
  };
  setEntry(u.key, entry);
  return entry;
}

// ---- THE MANUAL SESSION ──────────────────────────────────────────────────────────────────────
// Brennan, 2026-08-06: "I'd like the ability to manually start and then stop the probe separately
// from the schedule, so I can blast through some of the library if I know I don't need the NUC for
// anything else."
//
// So: an open-ended run that ignores the SCHEDULE gates (night window, night budget) and keeps every
// SAFETY gate (Movie Mode, someone watching, CPU temperature). Same distinction the `manual` flag
// already draws for a single-title probe — this just holds it open across units instead of one.
//
// PERSISTED across restarts, deliberately. "Until I tell it to stop" has to survive a controller
// redeploy or the promise is not kept; a session that quietly died during a routine `make deploy`
// would look exactly like one that was still running. It re-arms on boot with a log line saying so.
//
// HOW IT COEXISTS WITH THE NIGHTLY RUN (Brennan asked directly, 2026-08-06 — and the first answer
// was wrong, see probeTick's lock comment). Three separate mechanisms, none of them accidental:
//
//   1. ONE ENCODE AT A TIME. Both paths enter through probeTick and both take `_tickLock`
//      synchronously. So a session running through 01:00 does not race the nightly interval; the
//      interval simply finds the lock held and returns.
//   2. NO DUPLICATED WORK. There is one queue and one cursor — nextUnit() returns the first
//      never-measured unit — so whichever path runs next picks up exactly where the other left off.
//      A unit killed mid-probe was never cached, so it is simply next in line again.
//   3. THE NIGHT BUDGET IS SHARED, DELIBERATELY. probeUnit bills every encode to `_night.spentMs`
//      including a session's, so a session that runs 01:00-03:00 leaves the nightly run ~120 min
//      instead of 240. That is correct rather than double-counting: the budget caps how long this box
//      runs hot at night, and a manual encode at 02:00 heats it exactly as much as a scheduled one.
//      Daytime session time does not touch the night's budget at all, because probeUnit() only bills
//      `_night.spentMs` when inWindow(). (Until 2026-08-09 this paragraph described an intent nothing
//      implemented — every daytime encode billed to the night, and a multi-day session silently ate
//      the budget so the scheduled run never fired. See the comment at the billing site.)
//
// If a session is still going at 01:00 it simply keeps going and the nightly window has nothing left
// to claim — the right outcome, not a conflict.
let _session = null;   // { startedAt, units, spentMs, stopping, waiting, resumed }
let _sessionSoon = null;

// Back-to-back, not once a minute. A unit takes ~200s and the tick is 60s, so waiting for the next
// tick after each one would idle the box ~20% of the time — unacceptable for a run whose entire
// purpose is throughput. 2s is enough for the event loop to drain and for a stop to land.
const SESSION_GAP_MS = 2000;
function scheduleSessionTick() {
  if (!_session || _session.stopping || _sessionSoon) return;
  _sessionSoon = setTimeout(() => { _sessionSoon = null; probeTick().catch(() => { }); }, SESSION_GAP_MS);
}

function sessionStart(resumed = false) {
  if (_session) return _session;
  _session = { startedAt: Date.now(), units: 0, spentMs: 0, stopping: false, waiting: null, resumed };
  _cacheDirty = true;
  console.log(`probe: MANUAL SESSION ${resumed ? 're-armed after restart' : 'started'}`
    + ' — ignoring the night window and budget; Movie Mode, playback and temperature still apply.'
    + ' Runs until stopped.');
  metrics.emitEvent('probe_session', { act: resumed ? 'resume' : 'start' });
  // Flip the card's button HERE, not in reportProgress(). See sessionStop() for why.
  jobs.report('probe', { actions: ['stop-session'] });
  scheduleSessionTick();
  return _session;
}

function sessionStop(why = 'stopped by request') {
  if (!_session) return null;
  _session.stopping = true;
  _stopEpoch += 1;
  if (_sessionSoon) { clearTimeout(_sessionSoon); _sessionSoon = null; }
  // Kill any in-flight encode immediately rather than waiting out the current unit — a human asking
  // it to stop usually wants the CPU back now, and a killed unit is simply re-probed later.
  killProbe(why);
  const summary = { units: _session.units, mins: Math.round(_session.spentMs / 60000),
    startedAt: _session.startedAt };
  console.log(`probe: MANUAL SESSION ended (${why}) — ${summary.units} units in ${summary.mins} min`);
  metrics.emitEvent('probe_session', { act: 'stop', u: summary.units, min: summary.mins, why });
  _session = null;
  // HAND THE CARD BACK ITS "START" BUTTON, AND ERASE THE SESSION'S LEFTOVERS.
  //
  // These three fields were only ever written by reportProgress(), which lives PAST the gate check
  // in runTick(). Outside 01:00-06:00 a non-manual tick returns at that gate, so after a daytime
  // stop reportProgress() was unreachable for hours and the card kept the last thing the session
  // wrote: state "waiting" (a stale `stateOverride`), detail "Fringe S01" (a film that stopped
  // being probed days earlier), and actions ["stop-session"] — a Stop button for a session that no
  // longer existed. Pressing it answered {stopped:false} and changed nothing, so there was no way
  // back to Start from the UI at all. State that a session owns must be cleared by the session's
  // own end, not by the next tick that happens to get far enough.
  //
  // `stateOverride: null` is safe because probeState() answers live (running / waiting / idle) and
  // is registered as the probe's stateFn; the override was always redundant with it.
  jobs.report('probe', { actions: ['start-session'], stateOverride: null, detail: '', etaMs: null });
  _cacheDirty = true;
  saveProbeCache();
  return summary;
}

async function probeTick() {
  rollNight();
  // CLAIM THE SLOT SYNCHRONOUSLY, before any await. This is the ONLY thing standing between the
  // 60s nightly interval and a manual session's own 2s follow-up tick, and getting it wrong is not
  // theoretical: an earlier cut of this function checked `_busy` here but did not SET it until after
  // `await blockedBy()` (two Jellyfin HTTP calls, up to 12s) and `await getUnits()` (a full
  // Radarr+Sonarr enumeration on a cold queue). Any nightly tick firing inside that multi-second
  // window passed the check and proceeded, so BOTH would spawn an encode.
  //
  // The damage would not have been mere slowness. `_child` is one module-level handle, so the second
  // spawn overwrites the first and killProbe() can then only reach the second — leaving an ORPHANED
  // 3-thread x265 encode that no safety gate can stop, on a 4-core box, while a human is watching a
  // film. It would also double-count `_night.spentMs` and let two writers race the same cache entry.
  //
  // A synchronous test-and-set is sufficient and needs no real mutex: Node runs this to completion
  // before any other timer callback can interleave, precisely because there is no await between the
  // read and the write.
  if (_tickLock) return;
  _tickLock = true;
  try {
    await runTick();
  } finally {
    _tickLock = false;
    scheduleSessionTick();   // straight into the next unit while the session is live
  }
}

// blockedBy() returns internal gate names. "Movie Mode" is the one the Jobs tab also renders on
// every OTHER paused card, where it reads as the LATCH's own words ("someone is watching" / "held on
// manually") — so pass it through the same phrasing rather than having one card describe a shared
// cause differently from the eighteen next to it. Every other gate name is already plain English.
function waitReason(why) {
  return why === 'Movie Mode' ? (pauseReason() || 'Movie Mode') : why;
}

// THE PROBE'S STATE, ANSWERED LIVE. Evaluated every time the Jobs tab reads, because the probe's
// state changes DURING a tick, not between ticks: reportProgress() runs once, just before an encode
// that then takes ~200s, so anything it wrote about running/waiting is wrong for almost the whole
// unit. (That is exactly what "Quality probe · waiting" during an active encode was.)
//
// `_busy` is the truth — it brackets the actual encode. A session that is open but not encoding is
// genuinely waiting: for a gate to clear, or for the next unit to start.
function probeState() {
  if (_busy) return 'running';
  if (_session && !_session.stopping) return 'waiting';
  return null;   // no session — fall through to the registry's own idle/never determination
}

// Push the probe's real state into the Jobs registry. Called from runTick (which has the unit list
// in hand anyway) rather than on a timer of its own — getUnits() is a full Radarr+Sonarr
// enumeration and is far too expensive to run just to refresh a progress bar.
function reportProgress(units) {
  const done = units.filter(unitMeasured).length;
  const left = Math.max(0, units.length - done);
  const ses = _session && !_session.stopping ? _session : null;
  // Throughput from THIS session only, so the estimate tracks the box's actual current load. Null
  // until a unit completes — an ETA invented before the first measurement would be a guess.
  const mpu = ses && ses.units ? ses.spentMs / ses.units : null;
  jobs.report('probe', {
    progress: { done, total: units.length },
    etaMs: mpu ? left * mpu : null,
    detail: ses && ses.waiting ? waitReason(ses.waiting) : '',
    actions: ses ? ['stop-session'] : ['start-session'],
  });
}

async function runTick() {
  // A live session is what makes this tick manual: schedule gates off, safety gates on.
  const manual = !!(_session && !_session.stopping);
  const stop = await blockedBy(manual);
  if (stop) {
    // Record WHY a session is idling so the UI can say "waiting: someone is watching" rather than
    // just going quiet — a silent session is indistinguishable from a broken one.
    // No `stateOverride` here: probeState() is the probe's registered stateFn and already answers
    // "waiting" for an open session, live. Writing an override as well meant the LAST gated tick of
    // a session left "waiting" latched on the card forever (see sessionStop).
    if (manual) { _session.waiting = stop; jobs.report('probe', { detail: stop }); }
    // A gated NON-manual tick is the normal daytime state. Clear whatever the last run left behind
    // so the card doesn't keep naming a film that finished hours ago.
    else jobs.report('probe', { detail: '' });
    // STILL REPORT COVERAGE. The bar is the card's whole point — "975 of 1015 films measured" is
    // true at 3pm just as much as at 3am, and it was the only job on the tab whose bar appeared
    // solely while it was running (Brennan, 2026-08-09). Progress used to be written only past this
    // gate, so for the ~19 hours a day outside the night window the probe rendered an empty track.
    // getUnits() is a full Radarr+Sonarr enumeration but is cached for QUEUE_TTL_MS (1h), so this
    // costs one enumeration an hour, not one per 60s tick.
    reportProgress(await getUnits().catch(() => []));
    return;
  }
  if (manual) _session.waiting = null;
  const units = await getUnits().catch(() => []);
  reportProgress(units);
  const u = nextUnit(units);
  if (!u) {                              // library fully measured — nothing to do until new arrivals
    if (manual) sessionStop('library fully measured');
    return;
  }
  _busy = true;
  // Stamp the Jobs tab with what is being measured RIGHT NOW and when this unit started, so the
  // card names the film instead of going quiet for three minutes. Cleared in the finally below.
  jobs.report('probe', { detail: u.title || '', startedAt: Date.now() });
  // Watch the gates DURING the encode. Without this, pressing play at 02:00 would stutter for the
  // remaining minutes of a unit instead of stopping within 15s.
  const guard = setInterval(async () => {
    if (_session && _session.stopping) { clearInterval(guard); killProbe('session stopped'); return; }
    const why = await blockedBy(manual);
    if (why) { clearInterval(guard); killProbe(why); }
  }, PROBE_GATE_CHECK_MS);
  const t0 = Date.now();
  try {
    const r = await probeUnit(u, manual);
    const s = Math.round((Date.now() - t0) / 1000);
    if (_session) _session.spentMs += Date.now() - t0;
    if (r.partial) {
      console.log(`probe: "${u.title}" interrupted after ${s}s (${r.reason})`
        + (manual ? ' — session will retry it' : ' — will resume tomorrow'));
    } else if (r.error) {
      metrics.emitEvent('probe_error', { ti: u.title, err: String(r.error).slice(0, 140) });
    } else {
      _night.units += 1;
      if (_session) _session.units += 1;
      _last = { title: u.title, kind: u.kind, complexity: r.complexity, R: r.R, secs: s, ts: Date.now() };
      maybeCalibrate(units);
      const done = units.filter(unitMeasured).length;
      console.log(`probe: ${u.title} — complexity ${r.complexity} bpp (R ${r.R.toFixed(2)}) in ${s}s`
        + ` (${done}/${units.length} measured, ${_night.units} tonight`
        + (_session ? `, ${_session.units} this session` : '') + ')');
      metrics.emitEvent('probe_unit', { ti: u.title, cx: r.complexity, R: r.R, secs: s, kind: u.kind,
        ses: _session ? 1 : 0 });
    }
  } catch (e) {
    console.log(`probe: tick failed — ${e.message}`);
  } finally {
    clearInterval(guard);
    saveProbeCache();
    _busy = false;
    // The session's next tick is scheduled by probeTick's finally, which runs after this one and
    // only once the lock is released — otherwise the follow-up would find it still held and no-op.
  }
}

// ---- ESTIMATING THE UNMEASURED ───────────────────────────────────────────────────────────────
// Brennan's explicit ask: "films that have not been scanned can use a sample of the ones that have
// to better inform their default value until they themselves are scanned."
//
// Shrinkage toward the global median (empirical Bayes): a group's average is trusted in proportion
// to how many measurements back it. With k=5, a group of 1 is pulled 5/6 of the way to the global
// value; a group of 50 barely moves. This is what stops a single oddball measurement from becoming
// the confident answer for forty unscanned films.
const SHRINK_K = 5;

const measuredEntries = () => [...probeCache.values()].filter((e) => e && !e.error && e.complexity > 0);

function globalComplexity() {
  const all = measuredEntries();
  if (!all.length) return null;
  // Median, not mean: complexity is right-skewed (a handful of very grainy transfers would drag a
  // mean well above anything typical).
  const s = all.map((e) => e.complexity).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Complexity for a unit — measured if we have it, estimated otherwise. ALWAYS returns which of the
// two it is: a number derived from five other films is not the same claim as a number derived from
// this film, and presenting them identically is fake precision. Two rules follow, and they are the
// caller's to enforce (DESIGN-CRF-PROBE.md §6):
//   - an estimated value must be visibly marked in the UI and the API
//   - NOTHING destructive (delete, replace) may act on an estimated value. Probe it first.
function estimateComplexity(u, units) {
  const e = entryFor(u);
  if (e && !e.error && e.complexity > 0) {
    return { complexity: e.complexity, basis: unitStale(u) ? 'measured:stale' : 'measured', n: 1 };
  }
  const global = globalComplexity();
  if (global == null) return { complexity: null, basis: 'none', n: 0 };

  const cxOf = (x) => { const y = entryFor(x); return (y && !y.error && y.complexity > 0) ? y.complexity : null; };
  const pool = (pred) => (units || []).filter((x) => x.key !== u.key && pred(x)).map(cxOf).filter((c) => c != null);
  const shrink = (ms) => {
    const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
    return +(((ms.length * mean) + (SHRINK_K * global)) / (ms.length + SHRINK_K)).toFixed(5);
  };

  // Most specific first — take the first group that has any measured member at all.
  const ladder = [
    // Same series: other seasons of this show are by far the best predictor of this one.
    ['series', () => (u.kind === 'season' ? pool((x) => x.kind === 'season' && x.id === u.id) : [])],
    // Same source label (Bluray / WEB-DL / WEBRip / HDTV). The 2026-08-01 release-group analysis
    // showed within-label variance is tight enough for this to carry real information.
    ['source', () => (u.source ? pool((x) => x.source === u.source && x.kind === u.kind) : [])],
    // Same kind (film vs TV) — the last rung before giving up on specificity.
    ['kind', () => pool((x) => x.kind === u.kind)],
  ];
  for (const [basis, get] of ladder) {
    const ms = get();
    if (ms.length) return { complexity: shrink(ms), basis: `estimated:${basis}`, n: ms.length };
  }
  return { complexity: global, basis: 'estimated:global', n: measuredEntries().length };
}

// ---- SCORING (not yet live) ──────────────────────────────────────────────────────────────────
// What BPP+ becomes after cutover. Identical in shape to bppIndex(), with the measured per-film
// complexity replacing the flat BPP_TARGET:
//
//     BPP+ = round(100 * sqrt(fileBpp / (complexity * HEADROOM_TARGET)))
//
// HEADROOM_TARGET is the single global calibration constant that survives — "how many times the
// content's bare cost is the right amount to spend". It is the dial that puts 100 at Brennan's
// "perfect tradeoff". IT IS NOT CALIBRATED YET: the value below is a placeholder that holds the
// library median near 100 so the comparison in /api/probe/score is readable. Pinning it needs the
// ~10 films Brennan has judged (DESIGN-CRF-PROBE.md §12 Q1) — until then, read the RANKING, not
// the absolute numbers.
// WHAT 100 MEANS. Brennan, 2026-08-05:
//
//   "for a given film (film specific) if it's got a 100 it's got a perfect tradeoff of quality to
//    size, where increasing the bits will not yield a strong return on investment for the disk
//    space, while dropping from a 100 to a 70 represents a significant drop in quality compared to
//    the filespace recovered... I love Casablanca so I likely will target a # higher than 100, but
//    implicitly if I pick 100, I should be getting a good film, even if it requires more disk
//    space than say a 100 of Blade Runner does."
//
// That is the KNEE of the rate-distortion curve, and it is per-film. The probe already sits on it,
// because CRF IS A PERCEPTUAL-QUALITY ANCHOR, NOT A BITRATE ONE: a CRF-20 encode of Casablanca and
// a CRF-20 encode of Blade Runner 2049 are the same visual quality, they merely cost 3853 vs
// 1035 kb/s (measured 2026-08-05). So "the bitrate this film needs to look transparent" is exactly
// what probeBitrate reports, and 1.0 is the principled anchor:
//
//     HEADROOM_TARGET = 1.0  ->  100 means "as many bits as a CRF-20 encode of THIS film"
//
// Casablanca's copy is 1.56x that (score ~125); Blade Runner 2049's is 4.27x (~207, badly
// over-provisioned); a YIFY rip lands near 0.6x (~78). Sizes differ hugely, quality claim does not.
// That is the property asked for.
//
// THE ONE REMAINING JUDGMENT is whether CRF 20 is where Brennan's knee actually is. It is the
// standard "visually transparent for 1080p" figure, not a measurement of his eyes, and it is what
// the judged films (DESIGN-CRF-PROBE.md §12 Q1) will confirm or move. Moving it does NOT require
// re-probing: x265 bitrate runs roughly -15% per CRF point, so a preference for CRF 22 is just
// HEADROOM_TARGET ~= 0.85^2 ~= 0.72, applied at read time. The expensive measurement stays valid;
// only this constant moves. Same separation of concerns as PROBE_REFERENCE_WIDTH vs the display.
const HEADROOM_FALLBACK = Number(cfg.PROBE_HEADROOM_TARGET || 1.0);
// Minimum measured units before the anchor is derived from data. ~150 is enough for a stable
// median and lands around night 3 of the first pass.
const CALIBRATION_MIN_UNITS = Number(cfg.PROBE_CALIBRATION_MIN || 150);
// Derived once, then FROZEN. Persisted in the cache file so a restart cannot silently re-anchor.
let _calib = null;   // { headroom, ts, n, method }

// AUTO-ANCHOR: BOOTSTRAP ONCE, THEN FREEZE. (Brennan asked whether 100 should be re-centred
// continuously as data accumulates — 2026-08-05.)
//
// Deriving the anchor from the library beats an invented 2.5, so it is worth doing. Letting it
// FLOAT is not, for three reasons:
//   1. A moving anchor is unimprovable. If 100 always tracks the median, upgrading fifty films
//      moves the median up with them and every score re-centres to where it was. The number could
//      never register that the library got better — which is the main thing it exists to report.
//   2. It destroys comparability over time. A film scored 84 last month and 84 today would not
//      mean the same thing, and audit.js caches verdicts keyed to a version, so a nightly drift
//      would churn every cached verdict for the life of the first pass.
//   3. It assumes the conclusion. Anchoring to the median asserts "what I already own is, on
//      average, correct" — the exact proposition the probe was built to test.
//
// So: freeze at CALIBRATION_MIN_UNITS, keep reporting what the live data WOULD imply (see
// `headroomLive` on /api/probe), and let a human recalibrate deliberately. The frozen value is
// still only a statistical placeholder — pinning 100 to Brennan's actual "perfect tradeoff"
// needs the judged films (DESIGN-CRF-PROBE.md §12 Q1). This gets it close; that makes it right.
// Always the principled anchor. _calib is a diagnostic record only (see maybeCalibrate).
const headroomTarget = () => HEADROOM_FALLBACK;

// What the measured data currently implies: the median file's ratio of bits-spent to bits-needed.
// Setting the anchor to this puts the median film at exactly 100.
function liveHeadroom(units) {
  const rs = [];
  for (const u of (units || [])) {
    const e = entryFor(u);
    if (e && !e.error && e.complexity > 0 && u.bpp > 0) rs.push(u.bpp / e.complexity);
  }
  if (!rs.length) return null;
  rs.sort((a, b) => a - b);
  return +rs[Math.floor(rs.length / 2)].toFixed(4);
}

// REPORT-ONLY. An earlier cut of this auto-anchored HEADROOM_TARGET to the library median once
// enough units were measured. That is now deliberately NOT applied, for the reason above: the
// median says "what I already own is correct by definition", which is the proposition the probe
// exists to test, whereas CRF-20 transparency is an external standard the library is measured
// AGAINST. Anchoring to our own library would also mean a 700-film YIFY collection defines its own
// success. So this records what the median implies and nothing more — the gap between
// `headroomTarget` and `headroomLive` on /api/probe is a useful read on how the library compares
// to transparent, not an input to the score.
function maybeCalibrate(units) {
  if (_calib) return;
  const n = units.filter(unitMeasured).length;
  if (n < CALIBRATION_MIN_UNITS) return;
  const h = liveHeadroom(units);
  if (!(h > 0)) return;
  _calib = { suggestedFromMedian: h, ts: Date.now(), n, method: 'median-of-measured', applied: false };
  _cacheDirty = true;
  console.log(`probe: library median sits at ${h}x the transparent bitrate (n=${n}).`
    + ` Scoring anchor stays ${HEADROOM_FALLBACK} (CRF ${PROBE_CRF} transparency) — this is a`
    + ' diagnostic, not a recalibration.');
  metrics.emitEvent('probe_median_report', { median: h, n });
}

function probeBppPlus(fileBpp, complexity) {
  if (!(fileBpp > 0) || !(complexity > 0)) return null;
  return Math.round(100 * Math.sqrt(fileBpp / (complexity * headroomTarget())));
}

// THE CANDIDATE HOOK — the reason the cache is keyed by film rather than by file.
//
// Brennan, 2026-08-05: "otherwise we will accurately judge the downloaded file but all the
// potential replacements will be using crap numbers... We need to weight the replacements' bpp+
// by the probe result of the file on disk too."
//
// Correct, and it falls straight out of the keying. A candidate release for a film is the SAME
// CONTENT as the copy on disk — same grain, same motion, same detail — so the complexity measured
// from the file we hold is the right denominator for every candidate for that film. The candidate
// only supplies the numerator (its own estimated bpp, from size + runtime + resolution, which
// audit.js already computes).
//
// Without this, candidate scoring is worse than useless on exactly the films where it matters
// most: under the flat 0.13, a grainy film's high-bitrate candidates all look purple (they are
// spending bits on grain, not quality) and a clean film's candidates all look red. That is the
// current behaviour, and it is backwards.
//
// CUT OVER 2026-08-06. audit.js now passes the ROW's key into bppIndex()/bppBand() — never the
// candidate's — because the complexity belongs to the film, not to the release. A candidate supplies
// only the numerator (its estimated bpp from size + runtime + resolution, which audit.js already
// computes); the denominator is the film's, measured from the copy we hold.
//
// Resolution order, most specific first:
//   1. measured        this film was probed. The real thing.
//   2. measured:stale  probed, but from a copy since replaced. Content is identical, so the number
//                      still applies — it is queued for a refresh, not treated as invalid.
//   3. estimated:*     the shrinkage ladder (same series -> same source label -> same kind ->
//                      global median). Brennan, 2026-08-06: "any films that don't [have a probed
//                      number] can just use the average or whatever."
//   4. null            no probe data at all. Caller falls back to the flat BPP_TARGET.
//
// The ladder is used rather than a bare global median because it is strictly better and already
// built: another season of the same show is a far better predictor of this season than the library
// median is. It costs nothing extra — the memo makes repeat lookups O(1).
function complexityForKey(key) {
  if (!key) return { complexity: null, basis: 'none' };
  const hit = _cxMemo.get(key);
  if (hit) return hit;
  let out;
  const e = probeCache.get(key);
  if (e && !e.error && e.complexity > 0) {
    out = { complexity: e.complexity, basis: e.measuredFrom && _byKey.has(key)
      && unitStale(_byKey.get(key)) ? 'measured:stale' : 'measured' };
  } else {
    // Unmeasured. Use the full ladder when the queue is warm enough to know what this title IS
    // (series, source label, kind); fall back to the bare global median when it is not — which is
    // only the first seconds after a restart.
    const u = _byKey.get(key);
    if (u) {
      const est = estimateComplexity(u, _queue.units);
      out = { complexity: est.complexity, basis: est.basis };
    } else {
      const g = globalComplexity();
      out = { complexity: g, basis: g == null ? 'none' : 'estimated:global' };
    }
  }
  _cxMemo.set(key, out);
  return out;
}

// THE CUTOVER ITSELF — one call, made once at startup.
//
// arr-inspect.js owns BPP+ and is required by half the codebase; probe.js owns complexity and is
// required by nobody. Injecting the resolver downward keeps that direction (probe.js -> arr-inspect)
// and avoids the require cycle a straight require() back would create.
//
// What crosses the boundary is the finished denominator — complexity x the headroom anchor — not the
// complexity itself. That means arr-inspect never learns what CRF is, and a future recalibration
// (moving the anchor once Brennan has judged ~10 films) changes one constant HERE and every score in
// the app follows, with no re-probing and no edit to the scoring module.
function installScoring() {
  setComplexityResolver((key) => {
    const r = complexityForKey(key);
    if (!(r.complexity > 0)) return null;
    return { target: r.complexity * headroomTarget(), basis: r.basis };
  });
}

// ---- API ─────────────────────────────────────────────────────────────────────────────────────
// Read-only status. Drives the Quality probe panel on the Audit tab, the overnight cron watcher
// (/opt/appdata/controller/probe-watch-once.sh), and pulling the calibration set out without reading
// the cache by hand.
app.get('/api/probe', async (req, res) => {
  const units = await getUnits().catch(() => []);
  const done = units.filter(unitMeasured);
  const all = measuredEntries();
  const cx = all.map((e) => e.complexity).sort((a, b) => a - b);
  const pick = (q) => (cx.length ? +cx[Math.floor(cx.length * q)].toFixed(4) : null);
  const body = {
    version: PROBE_VERSION, refWidth: PROBE_REFERENCE_WIDTH,
    crf: PROBE_CRF, preset: PROBE_PRESET, samples: PROBE_SAMPLES, seclen: PROBE_SECLEN,
    window: `${PROBE_WINDOW_START}:00-${PROBE_WINDOW_END}:00`,
    nightBudgetMin: Math.round(PROBE_NIGHT_BUDGET_MS / 60000),
    // headroomTarget is what scoring USES; headroomLive is what the data currently implies. They
    // diverge over time by design — that gap is the signal that a deliberate recalibration is due,
    // and it is only visible because the anchor does not silently chase it.
    headroomTarget: headroomTarget(), headroomLive: liveHeadroom(units),
    anchor: _calib ? { ..._calib, frozen: true } : { frozen: false, needs: CALIBRATION_MIN_UNITS },
    calibratedToJudgement: false,
    units: units.length, measured: done.length, stale: units.filter(unitStale).length,
    pctComplete: units.length ? +(done.length * 100 / units.length).toFixed(1) : 0,
    complexity: { min: pick(0), p25: pick(0.25), median: pick(0.5), p75: pick(0.75),
      max: cx.length ? +cx[cx.length - 1].toFixed(4) : null, flatTargetToday: 0.13 },
    tonight: { night: _night.key, units: _night.units, spentMin: Math.round(_night.spentMs / 60000) },
    session: _session ? {
      startedAt: _session.startedAt, units: _session.units,
      spentMin: Math.round(_session.spentMs / 60000),
      elapsedMin: Math.round((Date.now() - _session.startedAt) / 60000),
      waiting: _session.waiting, resumed: !!_session.resumed,
      // Throughput measured from THIS session, so the estimate reflects the box's actual current
      // load rather than a constant. Null until a unit completes — no fabricated first guess.
      minsPerUnit: _session.units ? +(_session.spentMs / 60000 / _session.units).toFixed(1) : null,
    } : null,
    // Live, so the tab can show the score the app is ACTUALLY using and whether it is trustworthy.
    scoring: { live: true, flatFallback: BPP_TARGET, anchor: headroomTarget() },
    busy: _busy,
    // With a session open this is the SAFETY-gate answer (schedule gates are waived), so the UI is
    // never told "outside the night window" about a run that is deliberately outside it.
    blockedBy: await blockedBy(!!(_session && !_session.stopping)),
    last: _last,
  };
  if (req.query.detail) {
    body.detail = all.map((e) => ({ title: e.title, key: e.key, kind: e.unit, source: e.source,
      complexity: e.complexity, R: e.R, probeBitrate: e.probeBitrate, srcBitrate: e.srcBitrate,
      codec: e.codec, spreadRatio: e.spreadRatio, disagree: e.disagree,
      blockMean: e.blockMean, blurMean: e.blurMean, wallMs: e.wallMs, files: e.files }))
      .sort((a, b) => b.complexity - a.complexity);
  }
  res.json(body);
});

// THE BEFORE/AFTER VIEW: what BPP+ would have been under the flat 0.13, beside what it now is.
// It was how the cutover got judged before it happened (2026-08-06); it stays because it is the only
// place the old number still exists, which makes it the audit trail for every score in the app.
//
// `bppPlusFlat` calls bppIndex WITHOUT a key on purpose — that is exactly the pre-probe code path,
// so the comparison cannot drift as the resolver changes. Renamed from `bppPlusNow`, which stopped
// being true the moment the cutover landed: "now" IS the probe value.
app.get('/api/probe/score', async (_req, res) => {
  const units = await getUnits().catch(() => []);
  const rows = [];
  for (const u of units) {
    const est = estimateComplexity(u, units);
    if (est.complexity == null || u.bpp == null) continue;
    const flat = bppIndex(u.bpp);                    // no key -> flat BPP_TARGET, the old behaviour
    const live = bppIndex(u.bpp, u.key);             // what the app actually shows now
    rows.push({ key: u.key, title: u.title, kind: u.kind, source: u.source,
      bpp: u.bpp, complexity: est.complexity, basis: est.basis,
      bppPlusFlat: flat, bppPlusProbe: live,
      delta: (flat != null && live != null) ? live - flat : null });
  }
  rows.sort((a, b) => Math.abs(b.delta || 0) - Math.abs(a.delta || 0));
  res.json({ live: true, headroomTarget: headroomTarget(), headroomLive: liveHeadroom(units),
    anchorFrozen: !!_calib, calibratedToJudgement: false, n: rows.length, rows });
});

// Probe ONE unit right now, ignoring the night window. For the manual verification pass — this is
// how a human checks a specific title without waiting for 01:00. Still refuses if Movie Mode is on
// or someone is watching: "run it now" is not a reason to stutter a film.
app.post('/api/probe/run', async (req, res) => {
  const want = String((req.body || {}).key || req.query.key || '').trim();
  if (!want) return res.status(400).json({ error: 'key required, e.g. mv:123 or tv:45:2' });
  // Same lock the tick uses, and claimed synchronously for the same reason: the validation below
  // awaits on Radarr/Sonarr and Jellyfin, and a nightly tick firing inside that window would
  // otherwise start a second concurrent encode. Taking the lock FIRST also means the 409 is honest —
  // it now reports a busy tick as well as a busy endpoint, which the old `_busy` check missed
  // entirely for the several seconds a tick spends deciding.
  if (_tickLock) return res.status(409).json({ error: 'a probe is already running' });
  _tickLock = true;
  const release = () => { _tickLock = false; scheduleSessionTick(); };
  const units = await getUnits().catch(() => []);
  const u = units.find((x) => x.key === want);
  if (!u) { release(); return res.status(404).json({ error: `no unit ${want}` }); }
  if (isMasterPaused()) { release(); return res.status(409).json({ error: 'Movie Mode is on' }); }
  if (await anyonePlaying()) { release(); return res.status(409).json({ error: 'someone is watching' }); }
  _busy = true;
  const t0 = Date.now();
  // manual=true: skip the SCHEDULE gates only. Movie Mode, playback and temperature are still
  // enforced, here and on every mid-run re-check.
  const guard = setInterval(async () => {
    const why = await blockedBy(true);
    if (why) { clearInterval(guard); killProbe(why); }
  }, PROBE_GATE_CHECK_MS);
  try {
    const r = await probeUnit(u, true);
    saveProbeCache();
    const bppPlusProbe = r.complexity ? probeBppPlus(u.bpp, r.complexity) : null;
    res.json({ ...r, bpp: u.bpp, bppPlusNow: bppIndex(u.bpp), bppPlusProbe,
      secs: Math.round((Date.now() - t0) / 1000) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally { clearInterval(guard); _busy = false; release(); }
});

// ---- MANUAL SESSION CONTROL ──────────────────────────────────────────────────────────────────
// Start: run continuously, ignoring the night window and budget, until stopped. Stop: end it and
// kill any encode in flight. Both idempotent, because the UI button will get double-tapped.
app.post('/api/probe/session/start', async (_req, res) => {
  if (_session) {
    return res.json({ ok: true, already: true, units: _session.units,
      elapsedMin: Math.round((Date.now() - _session.startedAt) / 60000) });
  }
  sessionStart();
  // Report the current gate state so the UI can say "started, but waiting: someone is watching"
  // rather than implying work has begun when a safety gate is holding it.
  res.json({ ok: true, started: true, blockedBy: await blockedBy(true) });
});

app.post('/api/probe/session/stop', (_req, res) => {
  const s = sessionStop('stopped by request');
  res.json({ ok: true, stopped: !!s, ...(s || {}) });
});

// Search the queue by title — so a human can find a unit key without knowing *arr's ids.
app.get('/api/probe/find', async (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const units = await getUnits().catch(() => []);
  res.json(units.filter((u) => u.title.toLowerCase().includes(q))
    .map((u) => ({ key: u.key, title: u.title, kind: u.kind, source: u.source,
      bpp: u.bpp, bppPlusNow: bppIndex(u.bpp), measured: unitMeasured(u) })).slice(0, 40));
});

function startProbe() {
  loadProbeCache();
  rollNight();
  // THE CUTOVER. From here on every BPP+ in the app is scored against measured complexity where it
  // exists. Installed before the first tick so no request can be served with the flat value after
  // boot, and unconditional: with an empty cache the resolver returns null for every key and the
  // scores are identical to the pre-probe ones, so there is no state where this is unsafe to install.
  installScoring();
  // The probe is the heaviest job on the box (hours of x265 per night), so it sits at the top of
  // the Jobs tab. Wrapped for timing; the per-film progress comes from reportProgress().
  const tracked = jobs.define({
    // "Audit · …" because this feeds the Audit tab (every BPP+ on it is scored against these
    // measurements) and, with the source check, is one of the two jobs a human actually wants to
    // trigger by hand. Weight 100 pins it to the top of the tab; the shared prefix sits it next to
    // its sibling. See the naming note in audit.js.
    id: 'probe', name: 'Audit · quality probe', group: 'Audit', weight: 100,
    what: 'Measures the true bitrate each film needs',
    // No `every`: a fixed interval would render a "next run in 60s" countdown, which is true of the
    // tick but a lie about the work — the tick does nothing outside the night window.
    every: null,
    scheduleText: `nightly ${String(PROBE_WINDOW_START).padStart(2, '0')}:00–${String(PROBE_WINDOW_END).padStart(2, '0')}:00`
      + ` · ${Math.round(PROBE_NIGHT_BUDGET_MS / 60000)} min budget`,
    pausedByMovieMode: true, actions: ['start-session'],
  }, probeTick);
  // Live state, not a cached one — see probeState(). Registered here so it is in place before the
  // first tick, and separately from the wrapper because a manual session drives runTick through
  // scheduleSessionTick(), bypassing the wrapped function entirely.
  jobs.report('probe', { stateFn: probeState });
  setInterval(tracked, PROBE_TICK_MS);
  // Flush any cache the tick left dirty (a kill mid-unit can leave a measurement unsaved).
  setInterval(saveProbeCache, 5 * 60 * 1000);
  console.log(`probe: nightly CRF probe armed — window ${PROBE_WINDOW_START}:00-${PROBE_WINDOW_END}:00,`
    + ` budget ${Math.round(PROBE_NIGHT_BUDGET_MS / 60000)} min/night, ref width ${PROBE_REFERENCE_WIDTH},`
    + ` crf ${PROBE_CRF}/${PROBE_PRESET}, ${PROBE_SAMPLES}x${PROBE_SECLEN}s`);
  console.log(`probe: BPP+ IS LIVE — ${probeCache.size} films scored against their own measured`
    + ` complexity, the rest against the measured median (anchor ${headroomTarget()},`
    + ` flat fallback ${BPP_TARGET})`);
  // A session that was open when the process died resumes here — see sessionStart().
  if (_resumeSession) { _resumeSession = false; sessionStart(true); }
}

module.exports = { startProbe, probeTick, estimateComplexity, probeBppPlus, complexityForKey,
  installScoring, sessionStart, sessionStop, sessionLive,
  getUnits, probeCache, PROBE_VERSION, PROBE_REFERENCE_WIDTH, headroomTarget, liveHeadroom };
