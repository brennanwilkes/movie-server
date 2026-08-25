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
const { bppOf, bppIndex, BPP_TARGET, setComplexityResolver, setAudioResolver, X265_EFFICIENCY } = require('./arr-inspect');
const metrics = require('../metrics');
const { top100RankByTmdb } = require('./audit');

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

// VAN DER CORPUT SEQUENCE (base 2): 0, 1/2, 1/4, 3/4, 1/8, 5/8 ...
// Each new term falls in the largest remaining gap, so visit k samples the scenes previous visits
// missed rather than re-encoding clips already measured. A counter that simply stepped 1/k would
// clump; random would break resume and make a run unreproducible.
function phaseFor(visit) {
  let n = visit; let denom = 1; let out = 0;
  while (n > 0) { denom *= 2; out += (n % 2) / denom; n = Math.floor(n / 2); }
  return +out.toFixed(4);
}

function runProbe(file, samples = PROBE_SAMPLES, phase = 0) {
  return new Promise((resolve) => {
    const args = [file, '--json',
      '--width', String(PROBE_REFERENCE_WIDTH), '--samples', String(samples),
      '--seclen', String(PROBE_SECLEN), '--crf', String(PROBE_CRF),
      '--phase', String(phase),
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

// ---- AUDIO BACKFILL ─────────────────────────────────────────────────────────────────────────
// THE HOLE THIS PLUGS, because it is not obvious and it cost four silent days:
//
// probe-film.sh measures true audio bitrate, but ONLY for a unit that is actually (re-)probed, and
// nextUnit() picks only FRESH units (no cache entry) or STALE ones (file replaced). A film already
// measured from the file still on disk is never selected again — correctly, since re-encoding it
// would tell us nothing new about complexity. So a film probed BEFORE audio measurement existed
// (2026-08-13) can never acquire it: the library sits at 99.9% measured, nextUnit() returns null,
// and 129 films keep charging their audio to video FOREVER with no error anywhere to show for it.
// An earlier note in this project claimed "the nightly probe will fill these in over ~10 nights".
// It could not, and this function is why that is now true rather than merely intended.
//
// WHY IT IS SAFE TO RUN INSIDE THE NIGHT WINDOW: this is ONE ffprobe packet read — no decoding, no
// encoding, ~8-24 s/file, and it is I/O-bound rather than CPU-bound. It cannot heat the box the way
// an x265 encode does, so it does not threaten the thermal envelope the window exists to protect.
// It still bills to the night budget and still respects every safety gate, because it does compete
// for the one USB drive that playback reads from.
//
// It runs ONLY when there is no encode work, so complexity measurement — the expensive, more
// valuable half — is never starved by it.
const AUDIO_WIN_SECS = 120;
const AUDIO_BATCH = 8;      // files per tick; keeps a stop responsive, since gates are re-checked between

// Every audio stream, not just the default one. That is the entire point: *arr reports ONE track,
// so a DTS-HD MA track next to an AC3 track is invisible to it and stays charged to video. Lawrence
// of Arabia declares 448k and actually carries 2.59 Mb/s.
function runAudioProbe(file) {
  return new Promise((resolve) => {
    // Sample from a third of the way in, matching measure-audio.sh and probe-film.sh exactly, so a
    // value measured by any of the three paths is directly comparable to the others.
    const sh = `set -e
DUR=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$1" | cut -d. -f1)
[ -n "$DUR" ] && [ "$DUR" -ge 60 ] || { echo '{"error":"too short"}'; exit 0; }
ST=$(awk -v d="$DUR" 'BEGIN{printf "%d", d/3}')
BPS=$(ffprobe -v error -read_intervals "$ST%+${AUDIO_WIN_SECS}" -select_streams a \\
  -show_entries packet=size -of default=nw=1:nk=1 "$1" \\
  | awk '{s+=$1} END{ printf "%.0f", s*8/${AUDIO_WIN_SECS} }')
TR=$(ffprobe -v error -select_streams a -show_entries stream=index -of default=nw=1:nk=1 "$1" | wc -l)
printf '{"audioBps":%s,"audioTracks":%s}\\n' "\${BPS:-0}" "\${TR:-0}"`;
    let out = '', err = '';
    let child;
    // Same detached process group as runProbe(), for the same reason: killProbe() must be able to
    // take down the ffprobe as well as the shell. An ffprobe seeking a 28 GB file over USB is not
    // instant, and a stop request must reach it.
    try { child = spawn('sh', ['-c', sh, '_', file], { stdio: ['ignore', 'pipe', 'pipe'], detached: true }); }
    catch (e) { return resolve({ error: `spawn failed: ${e.message}` }); }
    _child = child;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { _child = null; resolve({ error: `spawn failed: ${e.message}` }); });
    child.on('close', (code, signal) => {
      _child = null;
      if (signal) return resolve({ error: `killed (${signal})`, killed: true });
      if (code !== 0) return resolve({ error: `exit ${code}: ${String(err).trim().slice(0, 120)}` });
      try { resolve(JSON.parse(out)); } catch { resolve({ error: 'unparseable' }); }
    });
  });
}

// Units that are measured, still point at the file on disk, and have no audio figure yet.
// `audioBps === 0` is a MEASUREMENT, not a gap — a file with no audio track at all legitimately
// reads 0 — so only `undefined`/`null` counts as missing, or this would retry such files nightly
// forever. `audioErr` marks a file we already failed on, for the same reason.
function audioPending(units) {
  return units.filter((u) => {
    const e = entryFor(u);
    if (!e || e.error || !e.measuredFrom) return false;
    if (e.audioBps != null || e.audioErr) return false;
    return e.measuredFrom === fileId(u.files[0]);   // stale units get a full re-probe instead
  });
}

// Returns how many it measured. Gates are re-checked between files, so a human pressing play or a
// session stop lands within one file rather than one batch.
async function runAudioBackfill(units, manual) {
  const pending = audioPending(units);
  if (!pending.length) return 0;
  const epoch = _stopEpoch;
  let done = 0;
  for (const u of pending.slice(0, AUDIO_BATCH)) {
    if (_stopEpoch !== epoch) break;
    if (await blockedBy(manual)) break;
    const f = u.files[0];
    const t0 = Date.now();
    const r = await runAudioProbe(f.path);
    if (inWindow()) _night.spentMs += Date.now() - t0;
    if (r.killed) break;
    const e = entryFor(u);
    if (!e) continue;
    if (r.error || !(Number(r.audioBps) >= 0)) {
      // Record the failure so an unreadable file is not retried every night forever.
      setEntry(u.key, { ...e, audioErr: String(r.error || 'no value').slice(0, 120) });
      continue;
    }
    setEntry(u.key, { ...e, audioBps: Number(r.audioBps), audioTracks: Number(r.audioTracks) || 0,
      audioFrom: 'nightly' });
    done += 1;
  }
  if (done) {
    saveProbeCache();
    console.log(`probe: audio backfill measured ${done} unit(s), ${pending.length - done} still pending`);
  }
  return done;
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
// *arr's runTime is "H:MM:SS" for a feature and "MM:SS" for a half-hour episode — the hours field is
// simply absent, not zero-padded. This used to demand three colon-separated groups, so every episode
// under an hour parsed as 0, which made the size-derived fallback bitrate null, which made bppOf()
// return null, which meant the unit HAD NO BPP+ AT ALL. Measured 2026-08-20: 95 of 146 probed
// seasons — 65% of the TV library, every one of them a sub-hour show — carried no score for this
// reason alone. Movies were unaffected (always over an hour), which is why it never showed up on the
// tab that gets looked at.
//
// audit.js has its OWN secs() that pads short forms correctly; this one did not, and two parsers for
// one field disagreeing is what made the gap invisible. Kept in step with that implementation.
function secs(rt) {
  if (!rt) return 0;
  const p = String(rt).split(':').map(Number);
  if (p.some((n) => !Number.isFinite(n))) return 0;
  while (p.length < 3) p.unshift(0);
  return p[0] * 3600 + p[1] * 60 + p[2];
}
// The file's CURRENT bpp — the numerator of BPP+, exactly as the Audit tab computes it today. The
// probe supplies the denominator; this is what it will be divided by, so it must be derived the
// same way or the comparison in /api/probe/score is meaningless.
//
// `key` IS NOT OPTIONAL IN PRACTICE, even though bppOf() tolerates its absence: without it bppOf
// cannot reach the measured-audio resolver and silently falls back to *arr's single-track figure.
// audit.js and routes-actions.js both pass it, so omitting it here made the probe's own idea of a
// file's bpp disagree with the Audit tab's for exactly the multi-track files where it matters most.
const fileBppOf = (mi, bytes, key) => bppOf(mi, secs((mi || {}).runTime) > 0 ? (bytes * 8) / secs((mi || {}).runTime) : null, key);

async function buildUnits() {
  const units = [];
  const movies = await arrGet('radarr', '/movie').catch(() => []);
  for (const m of movies) {
    const mf = m.movieFile;
    if (!m.hasFile || !mf || !mf.path) continue;
    units.push({ kind: 'movie', id: m.id, key: `mv:${m.id}`,
      title: `${m.title} (${m.year || '?'})`,
      tmdbId: m.tmdbId || null,
      source: ((mf.quality || {}).quality || {}).name || null,
      bpp: fileBppOf(mf.mediaInfo, mf.size || 0, `mv:${m.id}`),
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
      const bpps = picks.map((f) => fileBppOf(f.mediaInfo, f.size || 0, `tv:${s.id}:${sn}`)).filter((b) => b != null);
      units.push({ kind: 'season', id: s.id, season: sn, key: `tv:${s.id}:${sn}`,
        title: `${s.title} S${String(sn).padStart(2, '0')}`,
        tvdbId: s.tvdbId || null,
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

// How many previous measurements of one film to keep. Each is ~120 bytes and a film realistically
// gets a handful of copies in its life, so this is generous; the cap exists only so a pathological
// re-grab loop cannot grow the cache without bound.
const PRIOR_MAX = 6;
// Fields worth keeping from a superseded measurement. Deliberately NOT the whole entry: the bulky
// diagnostics are re-derivable and would triple the cache for no benefit. These are exactly what the
// saturation fit needs — what the source was worth, and what the probe concluded from it.
// R is load-bearing here, not decoration: it is fileBpp/complexity, so the file's own bpp is
// recoverable as R*complexity. That makes a prior self-describing in RESOLUTION-NORMALISED units,
// which is the only form comparable across a 720p->1080p upgrade — and it is the one field the
// event-log backfill can also supply, so reconstructed and natively-banked priors have one shape.
const PRIOR_FIELDS = ['ts', 'complexity', 'R', 'probeBitrate', 'srcBitrate', 'source', 'codec',
  'probeW', 'probeH', 'fps', 'measuredFrom', 'srcBasis'];

// The ONLY place probeCache is written. Centralised so the memo cannot go stale behind a direct
// .set() — that would silently serve a pre-measurement score for the rest of the process's life.
//
// ── IT ALSO BANKS THE SUPERSEDED MEASUREMENT (2026-08-12) ────────────────────────────────────
// WHY. `complexity` is supposed to be a property of the FILM, and it is not: the probe re-encodes
// the file ON DISK, and CRF 20 cannot ask for detail the source does not contain. So a starved copy
// measures as an EASY film, the target sinks toward that file's own bitrate, and the deficient file
// scores close to 100. The worse the copy, the more it flatters itself.
//
// MEASURED, same film, same probe, only the source changed — Paris, Texas re-probed after its 2.22 GB
// copy was replaced by a 12.73 GB Criterion transfer:
//     srcBitrate x6.02  ->  complexity 0.05982 -> 0.13939  (x2.33)
//     i.e. complexity scaled as srcBitrate^0.47 — SUB-LINEAR, so it saturates toward a ceiling,
//     and that ceiling is the film's true complexity.
// Fitting that curve is what would let every under-measured film be corrected without downloading
// anything. It needs OLD/NEW pairs of the same film, and it needs several — one pair cannot fit a
// two-parameter saturation.
//
// Every upgrade Brennan does generates exactly such a pair for free... and until now this function
// destroyed the old half of it. 43 units were stale on the night this was written, i.e. 43 pairs were
// hours away from being created and discarded. So: keep the superseded measurement.
//
// Only when the measurement actually CHANGED FILE — re-probing the same file yields the same answer
// and is not a data point. `priors` is append-only history, oldest first, and is never read by the
// scoring path: nothing about BPP+ changes because of this, it is purely accumulating the evidence
// needed to fix BPP+ later. See scripts/probe-pairs.sh to read it back.
function setEntry(key, entry) {
  const prev = probeCache.get(key);
  if (prev && !prev.error && entry && !entry.error
      && prev.measuredFrom && entry.measuredFrom && prev.measuredFrom !== entry.measuredFrom
      && prev.complexity > 0) {
    const keep = {};
    for (const f of PRIOR_FIELDS) if (prev[f] !== undefined) keep[f] = prev[f];
    const priors = [...(prev.priors || []), keep].slice(-PRIOR_MAX);
    entry = { ...entry, priors };
    const ratio = (entry.complexity > 0 && prev.complexity > 0) ? entry.complexity / prev.complexity : null;
    console.log(`probe: ${key} re-measured from a different copy — complexity ${prev.complexity} -> ${entry.complexity}`
      + (ratio ? ` (x${ratio.toFixed(2)})` : '')
      + `; kept the superseded measurement (${priors.length} prior${priors.length === 1 ? '' : 's'} banked for calibration)`);
    _biasFit = null;            // a new pair changes the fit — recompute on next use
    metrics.emitEvent('probe_pair', { key, ti: entry.title || null,
      cxOld: prev.complexity, cxNew: entry.complexity,
      sbOld: prev.srcBitrate || null, sbNew: entry.srcBitrate || null,
      pbOld: prev.probeBitrate || null, pbNew: entry.probeBitrate || null });
  } else if (prev && prev.priors && prev.priors.length && entry && !entry.priors) {
    // CARRY HISTORY FORWARD UNCONDITIONALLY, including onto an ERROR entry. The failure path above
    // (setEntry with {error}) would otherwise wipe every banked pair the moment a file became
    // briefly unreadable — losing measurements that can never be recreated, because the copies they
    // were taken from are gone. A same-file refresh lands here too.
    entry = { ...entry, priors: prev.priors };
  }
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
// STALE GETS A GUARANTEED SHARE, it is no longer starved by fresh work. `fresh.length ? fresh : stale`
// meant a single never-measured unit blocked EVERY re-probe, and re-probes are not a nicety: a film
// whose copy was replaced is carrying a complexity measured from a file that no longer exists, and
// since 2026-08-12 they are also the only source of the old/new pairs the saturation calibration needs
// (see setEntry). One new acquisition a night would have held 43 stale units indefinitely.
//
// One in STALE_SHARE goes to the stale pool whenever both have work. Fresh still gets the majority —
// a film with no measurement at all falls back to the estimator ladder, which is worse than a
// measurement taken from the wrong copy.
const STALE_SHARE = 4;

// IMPRECISE UNITS (#6). A film measured from eight samples that disagreed 10x has a complexity — and
// therefore a BPP+ — that is barely better than a guess, and nothing in the schedule ever revisited
// it: nextUnit() only knew about FRESH (never measured) and STALE (file replaced). With pooling in
// place a revisit now genuinely helps, because the new samples ADD to the old ones rather than
// replacing them, so each visit shrinks the error bar instead of re-rolling it.
//
// Ranked by cxRSE when present (the precision of the MEAN, which is the quantity BPP+ divides by),
// else by spreadRatio. spreadRatio is a WEAK proxy — max/min, so one near-black frame or a silent
// credits scene produces a huge ratio from an otherwise well-measured film — but it is the only
// signal that exists for all 1030 units today, and a weak ranking is still far better than never
// revisiting anything. As cxRSE coverage grows this migrates to the better ruler on its own.
//
// CONVERGENCE GUARD: a unit already pooled to POOL_MAX samples, or already precise, is excluded.
// Without that the worst-spread film in the library would be re-probed every fourth pick forever —
// spreadRatio is outlier-driven and may never fall no matter how many samples we add.
const IMPRECISE_SHARE = 3;    // one pick in 3 of the non-fresh share, once fresh work runs out
const RSE_GOOD = 0.12;        // +/-12% on the mean: precise enough to stop spending encodes on it
function unitImprecise(u) {
  const e = entryFor(u);
  if (!e || e.error || !e.complexity) return false;
  if (e.measuredFrom !== fileId(u.files[0])) return false;   // stale — a full re-probe handles it
  if ((e.sampleN || 0) >= POOL_MAX) return false;            // pooled as far as it goes
  if (e.cxRSE != null) return e.cxRSE > RSE_GOOD;
  return (e.spreadRatio || 0) > SPREAD_WIDE;
}
function impreciseRank(u) {
  const e = entryFor(u);
  // cxRSE and spreadRatio are not on the same scale, so rank within each group rather than mixing:
  // anything with a real error bar sorts ahead of anything judged only by the crude proxy.
  return e.cxRSE != null ? [0, -e.cxRSE] : [1, -(e.spreadRatio || 0)];
}

// ---- UNVERIFIED UNITS: the hole unitImprecise() cannot see ────────────────────────────────────
// unitImprecise() only selects a unit it ALREADY BELIEVES is imprecise. With no cxRSE that belief
// comes from `spreadRatio > SPREAD_WIDE` — and a unit under the threshold is therefore never
// revisited, never records per-sample values, and never produces the cxRSE that could contradict
// the proxy. The rule uses the crude ruler to decide who is worth measuring with the good ruler.
//
// MEASURED 2026-08-18: 761 of 1031 units sit in that hole. They are NOT waiting on the backlog —
// nothing in the schedule will ever select them. So the units carrying the most confident-looking
// numbers in the app are precisely the ones nothing has ever checked.
//
// Note this is not a claim that they are badly measured. Every one of them WAS sampled at least
// PROBE_SAMPLES times; what is missing is the per-sample record needed to put an error bar on the
// mean (per-sample values were only retained from 2026-08-14 — see the PER-SAMPLE VALUES note in
// setEntry). Most are probably fine. The defect is that we cannot tell which.
//
// Fixed the same way STALE_SHARE fixed the equivalent starvation for stale units: a guaranteed
// share of the refinement budget, rather than a priority that can never be reached.
const UNVERIFIED_SHARE = 2;   // every other refinement pick, while both pools have work

function unitUnverified(u) {
  const e = entryFor(u);
  if (!e || e.error || !e.complexity) return false;
  if (e.measuredFrom !== fileId(u.files[0])) return false;   // stale — a full re-probe handles it
  if (e.cxRSE != null) return false;                         // already has a real error bar
  // MUST BE DISJOINT FROM unitImprecise(). Without this the two pools overlap by 259 units (measured
  // 2026-08-18: 269 imprecise, 1020 "unverified", 259 in both) and the alternation below stops being
  // an alternation — half the refinement budget would go back to units the imprecise pool was
  // already going to pick, and the actual blind spot would keep starving. The blind spot is
  // specifically the units NOTHING selects.
  if (unitImprecise(u)) return false;
  return !Array.isArray(e.sampleCx) || e.sampleCx.length < 2;
}

// WHICH unverified unit to visit next, and this choice is load-bearing.
//
// The obvious answer — highest spreadRatio first — would re-import the very bias being corrected:
// it would spend the whole budget confirming that high-spread units are imprecise and take years to
// reach a low-spread one. But the open question is whether spreadRatio PREDICTS cxRSE AT ALL, and
// answering that needs samples from across its range, early.
//
// So: sort by spreadRatio, then walk the sorted list with a stride coprime to its length. That
// covers the full range within the first handful of picks while still visiting every unit exactly
// as often. Deterministic — no Math.random(), which would break resume and make a run unreproducible.
const STRIDE = 7919;                                          // prime; coprime to any pool size < it
let _unverifiedPicks = 0;
function nextUnverified(units) {
  const pool = units.filter(unitUnverified);
  if (!pool.length) return null;
  pool.sort((a, b) => {
    const sa = (entryFor(a).spreadRatio || 0); const sb = (entryFor(b).spreadRatio || 0);
    return sb - sa || a.key.localeCompare(b.key);
  });
  const i = (_unverifiedPicks * STRIDE) % pool.length;
  _unverifiedPicks += 1;
  return pool[i];
}

let _pickCount = 0;
// FIRST MEASUREMENTS ONLY — never-measured, or measured from a copy that is gone. Refinement is a
// SEPARATE pool (nextImprecise) and deliberately not merged in here: runTick spends the budget in
// priority order, and folding refinement into this function would silently outrank the audio
// backfill, which is both cheaper per unit and a larger correction to BPP+.
function nextUnit(units) {
  const fresh = units.filter((u) => !entryFor(u));
  const stale = units.filter(unitStale);
  let pool;
  if (fresh.length && stale.length) {
    _pickCount += 1;
    pool = (_pickCount % STALE_SHARE === 0) ? stale : fresh;
  } else pool = fresh.length ? fresh : stale;
  if (!pool.length) return null;
  pool.sort((a, b) => (a.kind === b.kind ? a.key.localeCompare(b.key) : (a.kind === 'movie' ? -1 : 1)));
  return pool[0];
}

// The loosest-measured unit still worth another visit, or null. Lowest priority of all the probe's
// work: a film with no complexity at all falls back to the estimator ladder, which is worse than any
// real measurement however imprecise, and an unmeasured audio track is a bigger error than a wide
// error bar. So this runs only when both of those are exhausted.
let _refinePicks = 0;
function nextImprecise(units) {
  const pool = units.filter(unitImprecise);
  const unverified = units.filter(unitUnverified);
  // Both pools have work: alternate, so neither can starve the other. KNOWN-imprecise units still
  // get half the budget even though they are the smaller pool — their numbers are wrong NOW and the
  // Audit tab is acting on them — while unverified units get the other half so the blind spot
  // actually closes instead of being permanently deferred.
  if (pool.length && unverified.length) {
    _refinePicks += 1;
    if (_refinePicks % UNVERIFIED_SHARE === 0) return nextUnverified(units);
  } else if (!pool.length) {
    return nextUnverified(units);
  }
  if (!pool.length) return null;
  pool.sort((a, b) => {
    const ra = impreciseRank(a), rb = impreciseRank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || a.key.localeCompare(b.key);
  });
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

// Per-sample complexity, and how precisely the mean is pinned (#9).
//
// Each sample's kb/s is converted with the SAME arithmetic as complexityOf() — per pixel per frame,
// times X265_EFFICIENCY — so a per-sample value is directly comparable to the stored `complexity`
// rather than being in units of its own.
//
// cxSE is the standard error OF THE MEAN (sd/sqrt(n)), not the standard deviation. The question a
// reader asks is "how well do I know this film's number", and with 8 samples those differ by ~2.8x.
// cxRSE expresses it as a fraction so films of different complexity can be compared at all.
// POOL_MAX caps how many samples accumulate. 64 is 8 nights of visits; past that the standard error
// is already ~1/8 of the per-sample sd and further samples buy almost nothing, while the cache entry
// keeps growing. Oldest are dropped first.
const POOL_MAX = 64;

// `prior` is the sample list already banked for THIS FILE (never for a different copy — see the
// caller). Passing it is what turns a re-probe from a re-roll of the dice into convergence.
function sampleStats(results, prior = null, priorPos = null) {
  const r0 = results[0] || {};
  const px = (r0.probeW || 0) * (r0.probeH || 0) * (r0.fps || 0);
  // PAIR THE READING WITH WHERE IT CAME FROM BEFORE FILTERING. Filtering the two lists separately
  // desynchronises them the moment one sample fails, and a position silently attached to the wrong
  // reading is worse than no position at all.
  const paired = results.flatMap((r) => {
    const k = Array.isArray(r.sampleKbps) ? r.sampleKbps : [];
    const p = Array.isArray(r.samplePos) ? r.samplePos : [];
    return k.map((v, i) => [v, p.length === k.length ? p[i] : null]);
  }).filter(([k]) => Number.isFinite(k) && k > 0);
  if (!px) return {};
  const fresh = paired.map(([k]) => (k * 1000 / px) * X265_EFFICIENCY);
  const freshPos = paired.map(([, p]) => (Number.isFinite(p) ? +p.toFixed(4) : null));
  // POOLING. Every visit adds 8 more samples of the same film, so n grows 8 -> 16 -> 24 and the
  // standard error of the mean falls as 1/sqrt(n). Without this, a re-probe DISCARDED the previous
  // eight and stored a fresh mean of eight — statistically no better than the first attempt, just
  // different, which is why re-probing never made a film's number more trustworthy.
  //
  // Safe only because the caller guarantees the file is byte-identical to the one the prior samples
  // came from. A different encode of the same film has a genuinely different complexity, so mixing
  // the two would average two different quantities into a number describing neither.
  const keep = (Array.isArray(prior) ? prior : []).map((x, i) => [x, (priorPos || [])[i] ?? null])
    .filter(([x]) => Number.isFinite(x) && x > 0);
  const pooled = keep.concat(fresh.map((x, i) => [x, freshPos[i]])).slice(-POOL_MAX);
  const cx = pooled.map(([x]) => x);
  const pos = pooled.map(([, p]) => p);
  if (cx.length < 2) return {};
  const m = cx.reduce((a, b) => a + b, 0) / cx.length;
  // EFFECTIVE SAMPLE SIZE, not the raw count. x265 is deterministic and the sample grid was fixed,
  // so before PROBE_PHASE existed a revisit re-encoded the IDENTICAL clips and returned identical
  // bitrates. Feeding those duplicates into SE = sd/sqrt(n) shrinks the error bar on evidence that
  // does not exist — and it gets worse the more a film is "refined", which is the exact opposite of
  // what pooling was added to do. Measured 2026-08-18: Dunkirk held n=64 from 16 distinct clips and
  // reported cxRSE 0.199 against a true 0.407; Sympathy 0.179 against 0.334.
  //
  // Distinct POSITIONS is the right denominator where positions are known. Falling back to distinct
  // VALUES for legacy entries is safe: two different scenes returning byte-identical bitrates at 5
  // decimal places does not happen in practice, so an exact repeat IS a re-measured clip.
  const keyOf = (i) => (pos[i] != null ? `p${pos[i]}` : `v${cx[i].toFixed(5)}`);
  const nEff = new Set(cx.map((_, i) => keyOf(i))).size;
  const sd = Math.sqrt(cx.reduce((s, x) => s + (x - m) ** 2, 0) / (cx.length - 1));
  const seOfMean = sd / Math.sqrt(Math.max(2, nEff));
  return {
    sampleCx: cx.map((x) => +x.toFixed(5)),
    // WHERE each reading was taken, as a fraction of runtime, index-aligned with sampleCx. Null for
    // any sample measured before this was recorded (2026-08-18). Pooled samples from several visits
    // land on the SAME offsets, so this is what distinguishes scene-to-scene variation (a property
    // of the film) from repeat-measurement noise at one timestamp (a property of the encoder) —
    // and without it a per-sample chart can only show a distribution, never a trend.
    samplePos: pos.some((p) => p != null) ? pos : null,
    sampleN: cx.length,                                 // how many readings are stored
    sampleNEff: nEff,                                   // how many DISTINCT clips they came from —
                                                        // the number the error bar is entitled to use
    sampleDup: cx.length - nEff,
    cxMean: +m.toFixed(5),                              // the POOLED mean — what complexity becomes
    cxSE: +seOfMean.toFixed(5),
    cxRSE: m > 0 ? +(seOfMean / m).toFixed(4) : null,   // relative SE — the comparable one
  };
}

// ADAPTIVE SAMPLE COUNT (#3). A film whose first pass came back wildly inconsistent needs more
// samples, not another eight in a different place — and it is much cheaper to take 16 in one visit
// than to schedule a whole second visit later (one ffmpeg startup, one file open, one seek warm-up).
//
// Keyed off spreadRatio because it is the ONLY precision signal that exists for the whole library
// today; cxRSE is the better ruler but only appears once a unit has been re-probed at least once
// under the pooling code above, so keying on it would never fire on a first pass. Prefer cxRSE when
// it is there — it measures the precision of the MEAN, which is the quantity that actually matters,
// whereas spreadRatio is max/min and one freak scene sets it.
const SAMPLES_MAX = 16;
const SPREAD_WIDE = 6;        // ~p75 of the library, measured 2026-08-17
const RSE_WIDE = 0.20;        // +/-20% on the mean is too loose to act on
function samplesFor(u) {
  const e = probeCache.get(u.key);
  if (!e || e.error) return PROBE_SAMPLES;
  if (e.cxRSE != null) return e.cxRSE > RSE_WIDE ? SAMPLES_MAX : PROBE_SAMPLES;
  return (e.spreadRatio || 0) > SPREAD_WIDE ? SAMPLES_MAX : PROBE_SAMPLES;
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
    // Phase advances with each visit to this unit, so pooling adds NEW scenes instead of duplicates.
    //
    // LEGACY ENTRIES HAVE NO COUNTER, and defaulting them to 0 would re-probe the phase-0 grid they
    // already hold — re-measuring the identical clips, which is the exact duplication the counter
    // exists to prevent. Every entry written before 2026-08-19 is in that state. So when `visits` is
    // absent, infer it from how many samples are already stored: each visit contributes at least
    // PROBE_SAMPLES readings, so ceil(sampleN / PROBE_SAMPLES) is the number of grids already used
    // and the next free phase index. Errs high if a visit used 16, which is harmless — it skips a
    // phase rather than repeating one.
    const prev = entryFor(u);
    const visit = (prev && prev.visits != null)
      ? prev.visits
      : Math.ceil(((prev && prev.sampleN) || 0) / PROBE_SAMPLES);
    const r = await runProbe(f.path, samplesFor(u), phaseFor(visit));
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
  // POOL WITH THE PREVIOUS VISIT'S SAMPLES, but ONLY when this is the same bytes on disk. A replaced
  // copy is a different encode with a genuinely different complexity, so its old samples describe a
  // file that no longer exists; setEntry() banks those in `priors` for calibration instead.
  const prevEntry = probeCache.get(u.key);
  const sameFile = !!(prevEntry && !prevEntry.error
    && prevEntry.measuredFrom && prevEntry.measuredFrom === results[0].from);
  const stats = sampleStats(results, sameFile ? prevEntry.sampleCx : null,
    sameFile ? prevEntry.samplePos : null);

  // THE POOLED MEAN IS THE NUMBER, when we have one. `complexity` above is the mean of THIS visit's
  // per-file probeBitrates; stats.cxMean is the mean of every per-sample measurement ever taken of
  // this file. They agree on a first visit (same samples, same arithmetic) and diverge only as the
  // pool grows — which is the entire point: each visit moves the denominator closer to the truth
  // instead of replacing one 8-sample guess with another.
  //
  // Seasons keep the per-file mean: their samples span DIFFERENT EPISODES, so pooling them would
  // pretend a season is one homogeneous work. `disagree` already exists to say when it is not.
  const useMean = u.kind !== 'season' && stats.cxMean > 0;
  const finalCx = useMean ? stats.cxMean : complexity;
  if (sameFile && stats.sampleN > (prevEntry.sampleN || 0)) {
    console.log(`probe: ${u.title} pooled to n=${stats.sampleN}`
      + ` — complexity ${prevEntry.complexity} -> ${+finalCx.toFixed(5)}`
      + `, +/-${stats.cxRSE != null ? (stats.cxRSE * 100).toFixed(1) : '?'}%`);
  }

  const entry = {
    v: PROBE_VERSION, ts: Date.now(), key: u.key, title: u.title, unit: u.kind,
    source: u.source || null,
    complexity: +finalCx.toFixed(5),             // THE number: H.264-equivalent bpp the content needs
    disagree: +disagree.toFixed(3),
    // Provenance — everything needed to re-derive or audit the number later without re-probing.
    probeBitrate: Math.round(results.reduce((a, r) => a + r.probeBitrate, 0) / results.length),
    srcBitrate: Math.round(results.reduce((a, r) => a + r.srcBitrate, 0) / results.length),
    R: +(results.reduce((a, r) => a + r.R, 0) / results.length).toFixed(4),
    codec: results[0].codec, probeW: results[0].probeW, probeH: results[0].probeH, fps: results[0].fps,
    // SOURCE geometry, distinct from the PROBE geometry above: the probe downscales to
    // PROBE_REFERENCE_WIDTH, so probeW equals the source width only while the source is no wider
    // than that. Provenance, not an input — nothing scores off it. It is here so a claim about a
    // measurement can be checked later without re-probing, and specifically so the
    // complexity-vs-R identity can be verified per row (it is expressed at PROBE geometry, which
    // is why re-deriving it from source dimensions does not reproduce it — see BPP-PLUS.txt).
    srcW: results[0].srcW || null, srcH: results[0].srcH || null,
    // Which numerator srcBitrate came from ('video' = already audio-free, 'container' = audio is
    // inside it). Consumed by videoR() to keep the pinning curve's x-axis video-only.
    srcBasis: results[0].srcBasis || null,
    spreadRatio: +(results.reduce((a, r) => a + r.spreadRatio, 0) / results.length).toFixed(3),
    // How many times this unit has been probed from the file currently on disk. Drives phaseFor(),
    // so each visit samples the gaps the previous ones left. Resets with the file, because a
    // replaced copy starts a fresh sample set anyway.
    visits: (sameFile && prevEntry
      ? (prevEntry.visits != null
        ? prevEntry.visits
        : Math.ceil((prevEntry.sampleN || 0) / PROBE_SAMPLES))
      : 0) + 1,
    // PER-SAMPLE VALUES (#9). probe-film.sh has ALWAYS emitted `sampleKbps`; this function averaged
    // it away and stored only the mean, so nothing downstream could distinguish a film measured to
    // +/-2% from one measured to +/-40%. `spreadRatio` is not a substitute: it is max/min, so a
    // single freak scene sets it, and it says nothing about the precision of the MEAN.
    //
    // WHY THIS MATTERS FOR BPP+: complexity is the DENOMINATOR of every BPP+ in the app. A film
    // whose complexity is uncertain has a BPP+ that is uncertain by the same proportion, and right
    // now that uncertainty is invisible — a 94 and a 207 are printed with identical confidence.
    // Measured on the grain set, WITHIN-film scene-to-scene spread is large (Raiders' grainShare
    // ranged 0.02-0.61 across five samples), so this is not a theoretical concern.
    //
    // Stored, never applied: `complexity` is deliberately unchanged, because 1026 measurements and
    // 108 calibration pairs are expressed in its current units and re-defining it would make all of
    // that history incomparable.
    ...stats,
    blockMean: results[0].blockMean, blurMean: results[0].blurMean,
    // PER-SAMPLE detector readings, so blockMean/blurMean can finally be VETTED. They have been
    // stored as bare means and marked UNTESTED since the probe was written, on the assumption that
    // judging a detector needs a subjective label. It does not — split-half reliability asks only
    // whether a detector has real per-film signal, and that needs repeated readings, which the
    // script computed all along and then averaged away. Same test that graded CAMBI's residual.
    sampleBlock: Array.isArray(results[0].sampleBlock) ? results[0].sampleBlock : null,
    sampleBlur: Array.isArray(results[0].sampleBlur) ? results[0].sampleBlur : null,
    // MEASURED audio bitrate, summed over EVERY audio stream (see probe-film.sh). *arr reports one
    // track and omits lossless ones entirely — Lawrence declares 448k AC3 and says nothing about its
    // DTS-HD MA track, while the packets say 2.59 Mb/s total. On the ~18% of the library with no
    // trustworthy videoBitrate, that difference is charged to VIDEO and inflates BPP+ by ~10 points.
    // Stored here so bppOf() can prefer a measurement over *arr's mediaInfo; nothing consumes it yet.
    audioBps: results[0].audioBps ?? null,
    audioTracks: results[0].audioTracks ?? null,
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
// THE BAR MUST TRACK THE WORK THAT IS ACTUALLY HAPPENING, not just the first phase of it.
//
// Until 2026-08-18 `done` was `unitMeasured` alone, so once the library hit 99.9% the bar sat full
// and stayed there — while the audio backfill was measuring 652 units and the refine queue had ~1000
// visits of work ahead of it. A bar that reads "done" for a month of nightly work is worse than no
// bar: it is the card actively asserting there is nothing left to do.
//
// So the bar reports whichever phase the probe is CURRENTLY spending its budget on, matching the
// priority order in runTick(). The phase name rides in `detail` when nothing more specific (a film
// title, a gate reason) is being shown, so the number is never ambiguous about what it counts.
function probePhase(units) {
  const measured = units.filter(unitMeasured).length;
  // "Is there first-measurement work left" is NOT `measured < total`: a unit whose probe failed
  // permanently (an unreadable file) has an error entry, counts as unmeasured forever, and is never
  // selected by nextUnit(). Using the count would pin the phase to "measuring" for good — one
  // corrupt film would hide the audio and refine phases from the card permanently. Ask the same
  // question nextUnit() asks instead.
  const pending = units.filter((u) => !entryFor(u)).length + units.filter(unitStale).length;
  if (pending > 0) return { name: 'measuring', done: measured, total: units.length };
  // Same trap as above, one phase down: a unit with an error entry can never acquire audio either,
  // so counting it as "not done" pinned the phase to "measuring audio" with audioLeft already 0.
  // Every phase here asks "is there work PENDING", never "does the count reach the total".
  const audioLeft = units.filter((u) => {
    const e = entryFor(u);
    return e && !e.error && e.audioBps == null && !e.audioErr;
  }).length;
  if (audioLeft > 0) return { name: 'measuring audio', done: units.length - audioLeft, total: units.length };
  // Refinement: "done" is everything NOT waiting for another visit. It can move backwards when a new
  // film arrives or a copy is replaced, which is honest — the queue really did just grow.
  // Both refinement pools count as outstanding work. Before 2026-08-18 only `unitImprecise` did,
  // so the bar reported "done" while 761 units had never had their precision checked at all.
  const left = units.filter(unitImprecise).length;
  const unver = units.filter(unitUnverified).length;
  const total = left + unver;
  return { name: 'refining complexity', done: units.length - total, total: units.length,
    refine: left, unverified: unver };
}

function reportProgress(units) {
  const ph = probePhase(units);
  const left = Math.max(0, ph.total - ph.done);
  const ses = _session && !_session.stopping ? _session : null;
  // Throughput from THIS session only, so the estimate tracks the box's actual current load. Null
  // until a unit completes — an ETA invented before the first measurement would be a guess.
  //
  // NO ETA WHILE REFINING. A refine unit takes several VISITS to converge, not one, so units-left
  // times seconds-per-unit would understate it by ~4x. An ETA that is confidently wrong is worse
  // than none, and the phase name already says what is going on.
  const mpu = ses && ses.units ? ses.spentMs / ses.units : null;
  jobs.report('probe', {
    progress: { done: ph.done, total: ph.total },
    etaMs: (mpu && ph.name !== 'refining complexity') ? left * mpu : null,
    detail: ses && ses.waiting ? waitReason(ses.waiting) : (_busy ? '' : ph.name),
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
  // THE PROBE'S PRIORITY ORDER, cheapest-and-most-wrong first once first measurements are done:
  //
  //   1. FIRST MEASUREMENT (nextUnit)      a film with no complexity is scored off the estimator
  //                                        ladder — the largest error we can still fix. ~200 s/unit.
  //   2. AUDIO BACKFILL (runAudioBackfill) ~8-24 s/unit and worth up to ~15 BPP+ points on a
  //                                        multi-track file. Best correction per second we have, and
  //                                        it has no other way to happen at all (see the function).
  //   3. REFINEMENT (nextImprecise)        tightening an error bar on a number we already have.
  //                                        Real, but the smallest of the three, so it goes last.
  //
  // Order matters and getting it wrong is silent: when the refinement pool was folded into
  // nextUnit(), step 1 never returned null, so step 2 became unreachable and audio would have
  // stopped filling in with nothing to show for it — the same class of bug as the four-day gap.
  let u = nextUnit(units);
  if (!u) {
    _busy = true;
    jobs.report('probe', { detail: 'measuring audio', startedAt: Date.now() });
    let n = 0;
    try { n = await runAudioBackfill(units, manual); }
    catch (e) { console.log(`probe: audio backfill failed — ${e.message}`); }
    finally { _busy = false; jobs.report('probe', { detail: '', startedAt: null }); }
    if (n) return;                       // more may remain; the next tick continues the batch
    u = nextImprecise(units);            // everything measured and audio complete — start refining
  }
  if (!u) {
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
  // CORRECTED, like every other scoring consumer. This median is the denominator every unprobed film
  // falls back to, so leaving it raw would quietly hold the whole estimated population at the old,
  // flattering scale while measured films moved — two scales in one library. See biasFactor().
  const s = all.map((e) => e.complexity * biasFactor(videoR(e))).sort((a, b) => a - b);
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

  // Corrected too — a sibling season measured from a starved copy would otherwise drag this film's
  // estimate down by the same bias the correction exists to remove.
  const cxOf = (x) => { const y = entryFor(x); return (y && !y.error && y.complexity > 0) ? y.complexity * biasFactor(videoR(y)) : null; };
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
// ---- SOURCE-PINNING CORRECTION ────────────────────────────────────────────────────────────────
// `complexity` is meant to be a property of the FILM. It is not, quite, and this corrects for that.
//
// The probe re-encodes the file ON DISK, and CRF 20 cannot ask for detail the source does not
// contain. A starved copy therefore measures as an EASY film, its target sinks toward that copy's own
// bitrate, and the deficient file then scores close to 100. The worse the copy, the more it flatters
// itself — so BPP+ was systematically OVERSTATED, and most overstated exactly where accuracy matters.
//
// PROVEN on the same film with the same probe, only the source changed (Paris, Texas, 2026-08-12,
// after a 2.22 GB copy was replaced by a 12.73 GB Criterion transfer):
//     srcBitrate x6.02  ->  complexity 0.05982 -> 0.13939   (x2.33)
// And Easy Rider, measured at BPP+ 78, was visibly full of grain-shimmer on flat walls; Brennan put
// it at "a 60ish, or even lower like a 40" by eye. Corrected it lands at ~65.
//
// THE PREDICTOR IS R (= fileBpp / complexity), and it needs no genre or year heuristics — Brennan:
// "that's the point of the quality probe". R < 1 means the file sits BELOW its own measured target,
// i.e. the probe ran out of source before it ran out of appetite, so the number is a FLOOR. R > 1
// means the probe had headroom and the measurement can be believed.
//
// FITTED FROM OUR OWN BANKED PAIRS, so it sharpens on its own as Brennan replaces films — every
// upgrade banks one (see setEntry). Not a hardcoded table: 96 pairs were recovered from the event log
// on 2026-08-12 and the fit is recomputed from whatever the cache holds.
//
// THREE GUARDS, because the raw per-bucket medians are not safe to apply as-is:
//   MIN_N          a bucket with a handful of pairs is noise. The R 1.00-1.20 bucket had n=1 and
//                  produced x1.39 — HIGHER than the better-sampled bucket below it (x1.24, n=4).
//                  Applying that would have injected one data point into ~15-point corrections for
//                  near-transparent films.
//   MONOTONE       the correction must not grow as R grows. A file with more headroom cannot be more
//                  under-measured than one with less; anything else is sampling noise, so the curve
//                  is forced non-increasing.
//   R_TRUST        above it, no correction at all. There are NO pairs up there (you only re-download
//                  films that were bad), so inventing a factor in an unmeasured range would be a
//                  guess dressed as data.
// Non-monotonic pairs (complexity FELL when the source improved — 18 of 96, sampling noise or a
// changed cut) are excluded from the fit entirely.
//
// STILL A FLOOR, and deliberately so. 56 of the 96 corrected films have R < 1 even after their
// upgrade, meaning the better copy was itself pinned, so one round of correction under-corrects. It
// moves the number toward the truth; it does not arrive.
const BIAS_R_TRUST = 1.2;
const BIAS_MIN_N = 8;
const BIAS_BUCKETS = [[0, 0.30], [0.30, 0.40], [0.40, 0.50], [0.50, 0.70], [0.70, 1.00], [1.00, BIAS_R_TRUST]];
let _biasFit = null;                                     // [{lo,hi,F,n}] or null when unfittable

function fitBias() {
  const obs = BIAS_BUCKETS.map(() => []);
  let pairs = 0;
  for (const e of probeCache.values()) {
    if (!e || e.error || !(e.complexity > 0)) continue;
    for (const pr of (e.priors || [])) {
      const cxOld = pr.complexity; const rOld = pr.R;
      if (!(cxOld > 0) || !(rOld > 0)) continue;
      if (e.complexity < cxOld) continue;                // noise-dominated, not a bias observation
      pairs += 1;
      const i = BIAS_BUCKETS.findIndex(([lo, hi]) => rOld >= lo && rOld < hi);
      if (i >= 0) obs[i].push(e.complexity / cxOld);
    }
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  // Raw medians, but ONLY for buckets with enough pairs to mean anything.
  const mid = (b) => (b.lo + b.hi) / 2;
  let out = BIAS_BUCKETS.map(([lo, hi], i) => ({ lo, hi, n: obs[i].length,
    F: obs[i].length >= BIAS_MIN_N ? med(obs[i]) : null, fitted: obs[i].length >= BIAS_MIN_N }));
  // Force non-increasing in R across the FITTED buckets: a file with more headroom cannot be more
  // under-measured than one with less, so anything else is sampling noise.
  let cap = Infinity;
  for (const b of out) {
    if (b.F == null) continue;
    b.F = Math.min(b.F, cap);
    cap = b.F;
  }
  // FILL THE GAPS BY POSITION, NOT BY CARRYING A NEIGHBOUR. Carrying was wrong in both directions and
  // both errors were live for one deploy: the most-starved bucket (n=5) fell through to x1.00 — no
  // correction at all for the worst files — while the undersampled R 0.70-1.20 buckets (n=4, n=1)
  // inherited the low-R factor and over-corrected nearly-transparent films. So:
  //   below the lowest fitted bucket -> take that factor (monotone: it cannot be smaller)
  //   above the highest fitted       -> interpolate down to exactly 1.0 at BIAS_R_TRUST
  //   between two fitted             -> interpolate between them
  const fit = out.filter((b) => b.F != null);
  if (fit.length) {
    const first = fit[0]; const last = fit[fit.length - 1];
    for (const b of out) {
      if (b.F != null) continue;
      const x = mid(b);
      if (x <= mid(first)) { b.F = first.F; continue; }
      if (x >= mid(last)) {
        const span = BIAS_R_TRUST - mid(last);
        b.F = span > 0 ? last.F - ((last.F - 1) * ((x - mid(last)) / span)) : 1;
        continue;
      }
      let a = first; let c = last;
      for (const g of fit) { if (mid(g) <= x) a = g; }
      for (let i = fit.length - 1; i >= 0; i -= 1) { if (mid(fit[i]) >= x) c = fit[i]; }
      const w = (x - mid(a)) / ((mid(c) - mid(a)) || 1);
      b.F = a.F + ((c.F - a.F) * w);
    }
  }
  out = out.map((b) => ({ ...b, F: b.F != null ? +Math.max(1, b.F).toFixed(3) : 1 }));
  _biasFit = { buckets: out, pairs, ts: Date.now() };
  const shape = out.map((b) => `R${b.lo.toFixed(2)}-${b.hi.toFixed(2)} x${b.F.toFixed(2)}${b.n ? `(n=${b.n})` : ''}`).join('  ');
  console.log(`probe: source-pinning correction fitted from ${pairs} pair(s) — ${shape}; R>=${BIAS_R_TRUST} uncorrected`);
  return _biasFit;
}
// The factor for one measurement. 1.0 whenever we cannot justify more: no R, enough headroom, or no fit.
// ---- THE CORRECTION, RECALIBRATED FROM A CONTROLLED EXPERIMENT (2026-08-18) ───────────────────
//
// Everything above describes the ORIGINAL fit, from banked upgrade pairs. That fit is now the
// cross-check rather than the scorer, because a controlled experiment measured the same quantity
// directly and disagreed with it in two specific ways.
//
// THE EXPERIMENT (scripts/starve-experiment.js + controller/scripts/probe-starve.sh): take films the
// model already trusts (R >= 1.2, no correction applied), deliberately starve them to 1/2 and 1/4 of
// their bitrate, and re-measure. Content is byte-identical across the three versions, so anything
// that moves was caused by starvation and nothing else. `cx20` at each level IS the complexity the
// probe would report for that copy, so the understatement is measured, not inferred.
//
// WHAT IT FOUND:
//  1. The effect is real and monotonic on every film tested, including heavy film grain.
//  2. The old fit UNDER-CORRECTS by x1.05 to x1.42 across the whole range.
//  3. *** BIAS_R_TRUST = 1.2 WAS WRONG. *** Points above it average x1.23 understatement while the
//     old rule applied NOTHING. The threshold existed because no banked pair sits above R 1.2 — you
//     only re-download films that were bad — so a factor there would have been invented. That
//     reasoning was correct for observational data; the starvation method simply is not limited that
//     way, and where it looked, it found pinning.
//
// A NOTE ON WHAT THIS IS NOT. An earlier hypothesis held that the CRF LADDER'S SLOPE measured source
// exhaustion, since it tracked supply at rho -0.750 across the library. The same experiment
// falsified it: holding content constant over 16 controlled points, slope predicts the
// understatement at rho +0.335 while observed R predicts it at -0.924. R is the right predictor.
// Do not revive the slope idea.
// CONSTANTS ANCHORED TO THE LIVE PROBE, not to the experiment's own R. The experiment used 3 samples
// where the nightly probe uses 8-16, so on high-scene-variance titles its absolute complexity missed
// the live one badly (Blade Runner 2049 2.29x, Requiem 1.87x, Fargo 1.46x; the divergence tracks
// spreadRatio). Within a film the SAME clips are used at every starvation level, so the understatement
// RATIO is clean — scene-selection error largely cancels in a ratio — and only the x-axis was noisy.
// So R comes from the live probe and the experiment contributes only the ratio. The anchoring is
//     R_anchored = level * R_live * under        under = cx20(base) / cx20(level)
// which is the OBSERVED R the library would compute for that starved copy. `under` is deliberately
// on BOTH sides of the fit: it is the y-variable and it sits inside the x. That is not a mistake —
// at runtime biasFactor only ever has the observed R of a starved file, inflated by the very
// understatement it must predict, so the calibration has to be fitted on the axis it is evaluated
// on. Consequence: rho here is NOT causal evidence (the self-reference biases it POSITIVE, so a
// negative rho survives rather than being produced). Use the unanchored own-R rho -0.924 for that.
//
// ── REFITTED 2026-08-20. THE PREVIOUS CONSTANTS WERE WRONG TWO WAYS, BOTH MEASURED. ──────────────
// They were 1.337 * R^-0.348. Two independent errors, each verified:
//
// 1. THE CODEC FLOOR. The starved copies were made with x265 and the probe also encodes x265, so
//    part of the measured understatement was codec MATCHING rather than starvation. A floor of
//    x1.06 was subtracted for it, estimated from ONE film. The confound check finally ran — the
//    same 8 films starved with libx264, so the artefacts are h264-shaped and x265 has nothing to
//    match — and the real factor is 1.1295 (16 points, median, 95% CI 1.099-1.151, controls
//    bit-exact). Roughly TWICE what was subtracted, and the assumed value is outside the CI.
//    Better still: the x264 arm is not merely a control, it is the LIBRARY-REALISTIC condition —
//    831 of 898 movies here are h264, so a real starved file IS an h264 encode probed with x265.
//    So the x264 arm needs no floor subtraction at all; it is what should have been fitted.
// 2. THE AXIS. The fit used R_live, which was audio-polluted until the same day (see videoR).
//    Scoring now evaluates on video-only R, so the curve was being read on an axis it had not been
//    fitted on. That mismatch alone accounts for A 1.337 -> 1.255.
//
// Refitting on the x264 arm, no floor, video-only R, all 16 points: A 1.114, B -0.392, rho -0.682.
// Effect: correction at the pin floor x1.606 -> x1.370, and it decays to 1.0 by R 1.32 instead of
// R 2.30, so 827 films are corrected rather than 886. Movie median BPP+ 60 -> 64.5; 106 bands flip,
// ALL UPWARD. Full working in docs/REPORT-x264-confound-2026-08-20.md and BPP-PLUS.txt 5.2.
//
// PURE RE-WEIGHTING — DO NOT BUMP PROBE_VERSION FOR THIS. biasFactor is evaluated at read time from
// the stored complexity and stored R, and audit candidates are re-scored at serve time
// (rescoreCand), so changing these two numbers re-derives every score on the next request. Nothing
// is re-probed and no verdict needs invalidating. Bumping PROBE_VERSION would throw away 1044
// measurements to no purpose.
//
// HONEST ABOUT THE COST: rho fell from -0.915 to -0.682. Part is the audio correction compressing
// the R range; part is real — the x264 relationship is noisier than the artificial x265 one looked.
// The direction is unchanged and all 16 points still show understatement, but confidence in the
// EXPONENT is lower than -0.348 ever advertised. Still unvalidated against any subjective label
// (open question 0), which is true of every constant in this file.
const PIN_A = Number(cfg.PROBE_PIN_A || 1.114);      // understatement = PIN_A * R^PIN_B
const PIN_B = Number(cfg.PROBE_PIN_B || -0.392);
// NO EXTRAPOLATION BELOW THE MEASURED RANGE, and the range MOVED with the 2026-08-20 refit — this
// tracks the fit or it is a different curve. Three ranges get quoted for this experiment and only
// one applies: the raw points span R 0.64-5.20 on the experiment's OWN R; anchored on the OLD
// (x265, audio-polluted) axis they spanned 0.59-2.27; anchored on the axis actually fitted now
// (x264 arm, video-only R) they span 0.423-1.689. PIN_R_MIN tracks THAT, because it is the axis the
// live fit uses. Below it the curve is held flat.
//
// It reaches lower than before because `under` is smaller in the x264 arm and sits inside the
// anchored R — so the same films land further left. Practical effect: films between R 0.42 and 0.59
// now get the CURVE where they used to get the flat floor, i.e. MORE correction, not less.
//
// This is the same principle that produced the old R_TRUST cap, applied honestly: that cap was
// removed because we WENT AND MEASURED above it, not because caps are wrong. Extending the power law
// down to the library minimum R 0.14 would predict x2.0 on no evidence at all.
const PIN_R_MIN = Number(cfg.PROBE_PIN_R_MIN || 0.423);
// Hard ceiling, belt and braces. Now UNREACHABLE by construction: the curve's maximum is its value
// at PIN_R_MIN, x1.561. Kept anyway — it costs nothing and it is the backstop if the constants are
// ever overridden via env to something steeper.
const PIN_MAX = Number(cfg.PROBE_PIN_MAX || 2.0);

// THE PINNING CURVE'S x-AXIS MUST BE VIDEO-ONLY, and for ~40% of the library the stored R is not.
// probe-film.sh takes srcBitrate from the video stream when it reports one and falls back to the
// container total when it does not (`srcBasis`). On the fallback path every audio track is inside
// the numerator, so R is overstated, biasFactor comes out too SMALL, and the correction is
// under-applied — on multi-dub and lossless-audio releases, i.e. precisely the class §3.2 removed
// audio from the numerator to stop flattering. It reintroduced the same bias one layer deeper.
//
// MEASURED 2026-08-20 (898 movies, ffprobe ground truth): 361 container-path, 537 already clean.
// Of the container rows, 271 change biasFactor; BPP+ was inflated by a median 2.17%, max 8.33%
// (The Witch, 39% audio), and 16 films sit in the wrong band because of it.
//
// SCOPED, NOT BLANKET. Subtracting audioBps from every row would deflate the 537 clean ones by a
// median 2.1% (max 8.5%) — a new error larger than the one being repaired. `srcBasis` is what makes
// the two separable; entries predating it are left alone rather than guessed at (the backfill in
// scripts/backfill-srcbasis.js fills them in from ffprobe).
//
// The fitted constants do NOT need re-deriving for this: the starvation experiment's own axis is
// already video-only by construction — see the long note in probe-starve.sh.
function videoR(e) {
  const R = e && e.R;
  if (!(R > 0)) return R;
  if (!e || e.srcBasis !== 'container') return R;
  const a = Number(e.audioBps) || 0;
  const src = Number(e.srcBitrate) || 0;
  if (!(a > 0) || !(src > 0) || a >= src) return R;
  return +(R * ((src - a) / src)).toFixed(4);
}

function biasFactor(R) {
  if (!(R > 0)) return 1;
  const r = Math.max(R, PIN_R_MIN);
  const f = PIN_A * (r ** PIN_B);
  return +Math.min(PIN_MAX, Math.max(1, f)).toFixed(4);
}

// The old bucketed fit, kept and still recomputed so /api/probe can report both and any drift
// between them is visible. NOT used for scoring.
function biasFactorLegacy(R) {
  if (!(R > 0) || R >= BIAS_R_TRUST) return 1;
  const fit = _biasFit || fitBias();
  if (!fit || !fit.pairs) return 1;
  const b = fit.buckets.find((x) => R >= x.lo && R < x.hi);
  return b ? b.F : 1;
}

// A WHOLE SERIES, from its measured seasons. The probe's unit is a SEASON (`tv:<id>:<n>`), so a
// series-level row has no entry of its own and used to be passed NO KEY AT ALL — which scored it
// against the flat library-wide BPP_TARGET and rendered it italic, i.e. "never probed". That was
// misleading in the worst direction: measured 2026-08-18, all 146 season units across all 97 series
// ARE measured. The UI was saying "we know nothing" about shows we have fully probed.
//
// The original comment at the call site argued that averaging seasons "would invent a number",
// because seasons of one show genuinely differ (a film-stock first season, a digital revival). That
// is true — but the alternative it chose was a GLOBAL CONSTANT, which is a worse invention: it
// throws away this show's own measurements in favour of the library median. An episode-weighted mean
// of the show's own seasons is strictly more information than that.
//
// It is reported as its own basis, `measured:series`, so the UI can render it as measured (it is)
// while a tooltip can still say it is aggregated across seasons rather than measured as one thing.
// Requires EVERY season to be measured — a partial average would silently describe a subset.
function seriesComplexity(seriesId) {
  const prefix = `tv:${seriesId}:`;
  let wsum = 0, w = 0, n = 0, missing = 0;
  for (const [k, e] of probeCache) {
    if (!k.startsWith(prefix)) continue;
    n += 1;
    if (!e || e.error || !(e.complexity > 0)) { missing += 1; continue; }
    // Weight by episode count where the live queue knows it: a 22-episode season should outweigh a
    // 6-episode one in a number that describes the whole show. Falls back to equal weight in the
    // seconds after a restart before the queue is warm.
    const u = _byKey.get(k);
    const wt = (u && u.episodes > 0) ? u.episodes : 1;
    wsum += e.complexity * wt; w += wt;
  }
  if (!n || missing || !(w > 0)) return null;
  return +(wsum / w).toFixed(5);
}

function complexityForKey(key) {
  if (!key) return { complexity: null, basis: 'none' };
  const hit = _cxMemo.get(key);
  if (hit) return hit;
  // Series-level key (`tv:<id>` with no season) — aggregate, and memoise like any other.
  const ser = /^tv:(\d+)$/.exec(key);
  if (ser) {
    const cx = seriesComplexity(ser[1]);
    const outS = cx > 0 ? { complexity: cx, basis: 'measured:series' } : { complexity: globalComplexity(), basis: 'estimated:global' };
    _cxMemo.set(key, outS);
    return outS;
  }
  let out;
  const e = probeCache.get(key);
  if (e && !e.error && e.complexity > 0) {
    // The one place the correction is applied, so every BPP+ in the app inherits it: bppTargetFor()
    // reads this, and bppIndex() reads that — for rows AND for candidates, which keeps a row and its
    // suggestions on one scale. `basis` is deliberately unchanged: Brennan wants a better number, not
    // more numbers ("we dont render error bars or hidden stats #s").
    //
    // `rse` RIDES ALONG SINCE 2026-08-18. The note above ("Brennan wants a better number, not more
    // numbers - we dont render error bars or hidden stats #s") still governs the DEFAULT rendering:
    // the UI prints a bare BPP+ and nothing else. What changed is his follow-up: when the number is
    // known to be loose, mark it "123*" and put the real figure in a tooltip. So the value is carried
    // but stays invisible unless it is bad enough to be worth a caveat. Null when the unit predates
    // per-sample stats, which is most of the library today.
    out = { complexity: +(e.complexity * biasFactor(videoR(e))).toFixed(5),
      rse: e.cxRSE != null ? e.cxRSE : null,
      sampleN: e.sampleN || null,
      // video-only, matching biasFactor's own axis (see videoR)
      R: e.R > 0 ? videoR(e) : null,
      disagree: e.disagree != null ? e.disagree : null,
      basis: e.measuredFrom && _byKey.has(key)
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
    // `rse` is the relative standard error of the COMPLEXITY. arr-inspect halves it to express the
    // error of the INDEX (BPP+ takes a square root), so do not pre-halve it here.
    // R rides along so the Audit tab's Disk section can ask "how over-supplied is this file" without
    // importing probe.js (which would be a require cycle) or duplicating the cache read.
    return { target: r.complexity * headroomTarget(), basis: r.basis, rse: r.rse ?? null, R: r.R ?? null, disagree: r.disagree ?? null };
  });
  // Measured total audio bitrate for a unit, or null. Deliberately NOT estimated from other films the
  // way complexity is: complexity is a property of the CONTENT and generalises across copies, whereas
  // audio is a property of THIS MUX — a 6-track lossless remux and a YIFY rip of the same film share
  // a complexity and share nothing about their audio. Guessing here would invent quality, so an
  // unmeasured unit simply falls back to *arr's single-track figure.
  setAudioResolver((key) => {
    const e = probeCache.get(key);
    return (e && !e.error && e.audioBps > 0) ? e.audioBps : null;
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
    // The source-pinning correction, for reports and analysis — NOT for the UI. Brennan, 2026-08-12:
    // "the extra #'s and extra error bars and all that can be used behind the scene, used in
    // analysis, used in reports etc etc, I just dont want to further clutter the UI". So the fit is
    // inspectable here and by scripts/bpp-recheck.sh, while the tab shows one corrected number.
    // The LIVE curve, recalibrated 2026-08-18 from the starvation experiment. `legacy` is the old
    // bucketed fit from banked upgrade pairs, still recomputed so the two can be compared.
    pinning: {
      model: 'A*R^B', A: PIN_A, B: PIN_B, rMin: PIN_R_MIN, max: PIN_MAX,
      source: 'controlled starvation experiment, 2026-08-18',
      sample: [0.3, 0.5, 0.7, 1.0, 1.5, 3.0].map((R) => ({
        R, factor: biasFactor(R), legacy: biasFactorLegacy(R),
      })),
    },
    pinningCorrection: (_biasFit || fitBias()),
    units: units.length, measured: done.length, stale: units.filter(unitStale).length,
    // The refine queue, so the cron watcher and any audit can see the phase the bar is showing.
    // `refine` is how many units are still waiting for another visit to tighten their complexity;
    // `audioLeft` is the same for the audio backfill. Both are 0 in the steady state.
    refine: units.filter(unitImprecise).length,
    // Units that have never had a per-sample record taken, so their precision is UNKNOWN rather
    // than known-good. They now get a guaranteed share of refinement (UNVERIFIED_SHARE).
    unverified: units.filter(unitUnverified).length,
    audioLeft: units.filter((u) => { const e = entryFor(u); return e && !e.error && e.audioBps == null && !e.audioErr; }).length,
    phase: probePhase(units).name,
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
      complexity: e.complexity, R: videoR(e), rawR: e.R, srcBasis: e.srcBasis || null,
      probeBitrate: e.probeBitrate, srcBitrate: e.srcBitrate,
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

// THE FULL MEASUREMENT TABLE, read-only, for offline analysis (bpp-lab/, reports, notebooks).
// Everything the other probe endpoints expose is a SUMMARY; this is the per-unit raw record, which
// is what cluster analysis and curve fitting need. It exists so an analysis tool never has to read
// /config/probe-cache.json off the NUC by hand — that path only works on the box, drifts silently,
// and cannot show the DERIVED numbers (the bias factor, the effective target, the score) because
// those live in code rather than in the cache.
//
// Both the raw and the corrected complexity are returned. Anything comparing against BPP+ must use
// `cxEff`, since that is what scoring divides by; `complexity` is the unmodelled measurement and is
// only meaningful when studying the correction itself (see the SOURCE-PINNING block above).
app.get('/api/probe/dataset', async (_req, res) => {
  const units = await getUnits().catch(() => []);
  const byKey = new Map(units.map((u) => [u.key, u]));
  // Reuse audit.js's Top 100 map so the checkbox matches the ELo rank exactly (not a re-parse).
  // Read-only here.
  let top100Rank;
  try { top100Rank = await top100RankByTmdb(); }
  catch { top100Rank = null; }
  const rows = [];
  for (const e of probeCache.values()) {
    if (!e || e.error || !(e.complexity > 0)) continue;
    const u = byKey.get(e.key) || null;
    const F = biasFactor(videoR(e));
    const cxEff = +(e.complexity * F).toFixed(5);
    rows.push({
      key: e.key,
      title: e.title,
      kind: e.unit,
      source: e.source || null,
      codec: e.codec || null,
      // --- the measurement
      complexity: e.complexity,
      biasFactor: +F.toFixed(3),
      cxEff,
      target: +(cxEff * headroomTarget()).toFixed(5),
      // `R` IS THE VIDEO-ONLY SUPPLY RATIO — the axis biasFactor is actually evaluated on, and the
      // one the starvation experiment calibrated. For container-path rows that is NOT the raw
      // measurement, so `rawR` and `srcBasis` are carried beside it: any offline analysis that
      // reproduces R from srcBitrate/probeBitrate will match `rawR`, never `R`. (Nor will it match
      // either without the codec normalisation — R = src/(probe x eff), eff 1.6 for h264 sources.)
      R: e.R != null ? videoR(e) : null,
      rawR: e.R != null ? e.R : null,
      srcBasis: e.srcBasis || null,
      srcBitrate: e.srcBitrate || null,
      probeBitrate: e.probeBitrate || null,
      audioBps: e.audioBps != null ? e.audioBps : null,
      audioTracks: e.audioTracks != null ? e.audioTracks : null,
      // --- per-sample detail: the control points a curve is fitted through
      sampleCx: Array.isArray(e.sampleCx) ? e.sampleCx : null,
      samplePos: Array.isArray(e.samplePos) ? e.samplePos : null,
      sampleN: e.sampleN != null ? e.sampleN : (Array.isArray(e.sampleCx) ? e.sampleCx.length : null),
      // Distinct clips behind those readings. Before PROBE_PHASE (2026-08-18) a revisit re-encoded
      // the same offsets, so sampleN counts duplicates and only sampleNEff is entitled to drive an
      // error bar. Null on entries written before the distinction existed.
      sampleNEff: e.sampleNEff != null ? e.sampleNEff : null,
      sampleDup: e.sampleDup != null ? e.sampleDup : null,
      visits: e.visits != null ? e.visits : null,
      cxMean: e.cxMean != null ? e.cxMean : null,
      cxSE: e.cxSE != null ? e.cxSE : null,
      cxRSE: e.cxRSE != null ? e.cxRSE : null,
      spreadRatio: e.spreadRatio != null ? e.spreadRatio : null,
      disagree: e.disagree != null ? e.disagree : null,
      // --- banked upgrade pairs, which is what the bias correction is fitted from
      priors: Array.isArray(e.priors) ? e.priors : [],
      // --- candidate detectors, neither adopted nor falsified. The eleven-film test that appeared
      //     to rule blockMean out was retracted (docs/BPP-PLUS.txt §8): its labels turned out to
      //     measure grain-visibility, not compression, so they say nothing either way. Exposed here
      //     so a future, properly-paired experiment can test them rather than re-arguing them.
      blockMean: e.blockMean != null ? e.blockMean : null,
      blurMean: e.blurMean != null ? e.blurMean : null,
      // Present only on units probed from 2026-08-21. Needed to run the reliability test that
      // decides whether these two detectors carry any per-film signal at all.
      sampleBlock: Array.isArray(e.sampleBlock) ? e.sampleBlock : null,
      sampleBlur: Array.isArray(e.sampleBlur) ? e.sampleBlur : null,
      // --- THE SECOND AXIS. Banding, measured by the banding job (CAMBI). null = NOT MEASURED,
      // which is not the same as zero and must never be read as "clean": ~1000 units are still
      // unmeasured. It is deliberately NOT folded into any score - the two axes disagree in both
      // directions and there is no valid label to weight them with. See banding.js.
      ...bandingCols(e.key),
      // --- geometry and cost
      probeW: e.probeW || null,
      probeH: e.probeH || null,
      fps: e.fps || null,
      files: e.files || null,
      wallMs: e.wallMs || null,
      ts: e.ts || null,
      // --- what the app currently SHOWS for this unit, so the lab never re-derives the score
      bpp: u && u.bpp != null ? u.bpp : null,
      bppPlus: u && u.bpp != null ? bppIndex(u.bpp, e.key) : null,
      bppPlusFlat: u && u.bpp != null ? bppIndex(u.bpp) : null,
      // Units carry files[], not a total — a season is many files, so summing is the only
      // definition that means the same thing for both kinds.
      bytes: u && Array.isArray(u.files)
        ? u.files.reduce((a, f) => a + (f.size || 0), 0) : null,
      // The file as it is on disk RIGHT NOW, so an offline tool (scripts/ladder-pilot.js) can
      // re-measure this unit without re-deriving *arr's layout. Deliberately the live path rather
      // than `measuredFrom`, which records where the measurement CAME from and may name a copy that
      // has since been replaced. Seasons expose their first episode only — a ladder measures one
      // file, and mixing episodes would confound the curve with episode-to-episode variation.
      path: u && Array.isArray(u.files) && u.files[0] ? u.files[0].path : null,
      year: (() => { const m = /\((\d{4})\)\s*$/.exec(String(e.title || '')); return m ? +m[1] : null; })(),
      // ELo rank within the "Top 100" playlist, else null. Movies are keyed by tmdbId; a TV
      // season carries tvdbId and is never in the (movie) playlist, so it stays null.
      top100: u && u.tmdbId && top100Rank ? (top100Rank.get(String(u.tmdbId)) || null) : null,
    });
  }
  res.json({
    generated: Date.now(),
    crf: PROBE_CRF,
    headroomTarget: headroomTarget(),
    headroomLive: liveHeadroom(units),
    flatFallback: 0.13,
    // The LIVE correction, recalibrated 2026-08-18 from the controlled starvation experiment. There
    // is no hard cut-off any more: the curve decays to 1.0 on its own, so a consumer must NOT draw a
    // trust threshold. `biasFit` below is the superseded bucketed fit, kept for comparison only.
    pinning: {
      model: 'A*R^B', A: PIN_A, B: PIN_B, rMin: PIN_R_MIN, max: PIN_MAX,
      source: 'controlled starvation experiment 2026-08-18 (8 films, 16 points)',
    },
    biasFit: (_biasFit || fitBias()),
    n: rows.length,
    rows,
  });
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
    // KEYED, so "bppPlusNow" is genuinely what the app now shows for this film — including the
    // source-pinning correction. Unkeyed it fell back to the flat 0.13 target and reported a number
    // that appeared nowhere in the UI, which is worse than useless on a diagnostic endpoint.
    res.json({ ...r, bpp: u.bpp, bppPlusNow: bppIndex(u.bpp, u.key), bppPlusProbe,
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
      // Keyed for the same reason as /api/probe/run above: report what the app shows, corrected.
      bpp: u.bpp, bppPlusNow: bppIndex(u.bpp, u.key), measured: unitMeasured(u) })).slice(0, 40));
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

// Banding columns for the dataset. Required LAZILY: banding.js requires probe.js for its gates, so
// a top-level require here would be a cycle and one of the two would see an empty module object.
let _banding = null;
function bandingCols(key) {
  if (_banding === null) { try { _banding = require('./banding'); } catch { _banding = false; } }
  const b = _banding && _banding.bandingFor ? _banding.bandingFor(key) : null;
  return b
    ? { cambi: b.cambi, cambiMax: b.cambiMax, bands: b.bands, cambiLuma: b.yavg }
    : { cambi: null, cambiMax: null, bands: null, cambiLuma: null };
}

// ---- SHARED WITH THE BANDING JOB --------------------------------------------------------------
// banding.js measures a DIFFERENT thing (CAMBI, not complexity) with a DIFFERENT ffmpeg, but it
// competes for the same four cores, the same USB drive and the same thermal envelope. So it does
// not get its own gates or its own budget - it reuses these, and the night budget stays ONE bucket.
// That is the whole safety property: no matter which job spends the 240 minutes, the box never runs
// more than 240 minutes of encoding a night. A second independent budget would silently double it.
const probeGate = blockedBy;                       // same window/temp/playback/MovieMode answer
const billNight = (ms) => { if (inWindow()) _night.spentMs += ms; };
const nightSpentMs = () => _night.spentMs;
const nightBudgetMs = () => PROBE_NIGHT_BUDGET_MS;
const nightWindow = () => ({ start: PROBE_WINDOW_START, end: PROBE_WINDOW_END, inWindow: inWindow() });
// True when the probe still has FRESH measurement work. Refinement — tightening an error bar on an
// already-measured unit — does NOT count: it is optional, while banding has ~1000 units never
// measured at all. The banding job asks this so it can take the window when the probe has only
// refinement left.
//
// *** IT ASKS nextUnit(), IT DOES NOT REIMPLEMENT THE QUESTION, AND THAT IS THE WHOLE POINT. ***
// The first version was `us.some((u) => !unitMeasured(u) || unitStale(u))`, which is the exact bug
// probePhase() carries a comment warning about: a unit whose probe failed permanently has an ERROR
// entry, counts as unmeasured forever, and is never selected by nextUnit(). One corrupt film
// therefore made this return true for good.
//
// Measured consequence, 2026-08-21: `mv:392` (Air, 2023) fails every sample and always will. So the
// probe looked like it had fresh work every night, banding yielded the entire window, and after a
// full 243-minute budget the banding job had measured ZERO units — while the probe spent all of it
// on optional refinement. Silent, and it would have repeated every night forever.
//
// nextUnit() is the authority on what the probe will actually do next, so asking it cannot drift
// from the truth the way a duplicated predicate did.
function probeHasFreshWork() {
  try {
    const us = _byKey ? [..._byKey.values()] : [];
    return us.length ? nextUnit(us) != null : false;
  } catch { return false; }
}

module.exports = { startProbe, probeTick, estimateComplexity, probeBppPlus, complexityForKey,
  installScoring, sessionStart, sessionStop, sessionLive,
  getUnits, probeCache, PROBE_VERSION, PROBE_REFERENCE_WIDTH, headroomTarget, liveHeadroom,
  probeGate, billNight, nightSpentMs, nightBudgetMs, nightWindow, probeHasFreshWork,
  phaseForVisit: phaseFor };
