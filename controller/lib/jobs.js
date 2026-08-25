'use strict';
// THE BACKGROUND-JOB REGISTRY — one status contract for every recurring thing this box does,
// so the Jobs tab can render them all with a single component. Owns: the job table and
// /api/jobs. No timers of its own; every job registers itself as it loads.
//
// WHY A REGISTRY AND NOT A HAND-WRITTEN ENDPOINT: there are ~25 background jobs across three
// runtimes (in-process sweeps, Jellyfin scheduled tasks, host systemd timers). Before this,
// two of them had UI (audit, probe) in two bespoke formats and the rest were invisible — the
// only way to know whether the oscar sweep had ever run was to grep container logs. A registry
// makes "is it running / how far along / when did it last succeed" a property every job has,
// and makes adding a job to the UI a one-line declaration instead of a frontend change.
//
// THE THREE SOURCES, and why each is read the way it is:
//   controller  in-process sweeps. Instrumented by wrapping the interval callback (see define()),
//               so a job joins the tab without touching its own body.
//   jellyfin    /ScheduledTasks. Jellyfin already tracks state + percent + last result for
//               trickplay, library scans, etc. Polled and mapped, never mirrored into our state.
//   host        systemd timers (ps4fix). The controller is a container and CANNOT read host
//               systemd — no /run/systemd, no systemctl binary, and mounting the host bus to
//               read a timer would be absurd. Instead the host script WRITES a status file into
//               ${CONFIG}/controller (already bind-mounted here as /config) and we read it. Same
//               push-a-status-file pattern the tailscale sidecar already uses in docker-compose.
//
// STATES are deliberately few, and mean exactly this:
//   running  doing work right now
//   waiting  wants to run, held back by a gate it expects to clear (Movie Mode, night window)
//   paused   held back by Movie Mode specifically (a waiting variant, called out because the
//            user controls it directly and should see the consequence of the button they pressed)
//   idle     scheduled, nothing to do right now — the healthy resting state
//   error    last attempt failed
//   never    registered but has not run since this container started
//   off      disabled by config (e.g. a missing API key), so absence is explained rather than
//            looking like a silent failure
const fs = require('fs');
const path = require('path');
const app = require('./app');
const { cfg, HOST } = require('./config');
const { tfetch, tfetchJson } = require('./clients');
const { isMasterPaused, pauseReason, movieModeStatus } = require('./state');

const CONFIG_DIR = process.env.CONTROLLER_CONFIG_DIR || '/config';
// Host-side jobs drop <id>.json here. Directory, not one shared file, so two host scripts can
// never race each other's writes.
const HOST_JOBS_DIR = path.join(CONFIG_DIR, 'host-jobs');

const _jobs = new Map();

// ---- registration ----------------------------------------------------------------------------
// desc: { id, name, what, group, weight, every, scheduleText, source, pausedByMovieMode, actions }
// Returns an instrumented version of `fn` when given one. Callers pass the wrapped function to
// setInterval so timing/failure bookkeeping happens with no change to the job's own body.
function define(desc, fn) {
  const job = {
    id: desc.id,
    name: desc.name,
    what: desc.what || '',
    group: desc.group || 'System',
    weight: desc.weight == null ? 0 : desc.weight,
    every: desc.every || null,
    // HOW OFTEN THE WORK COMES ROUND, which is not always how often the timer fires. For most jobs
    // they are the same and this stays null. They diverge whenever a job ticks fast but each tick
    // does a slice of a much longer pass: the audit's verifier fires every 45s to run ONE indexer
    // search, but any given file is re-checked on a 14-day cycle.
    //
    // Conflating the two broke the tab in two visible ways (Brennan, 2026-08-09): the cadence chip
    // read "45s" for a job that is really fortnightly, and — worse — the client's isChatty() test
    // treats anything sub-hourly as plumbing and sinks it below everything else, so the library
    // audit sorted to the bottom of the page no matter what weight it was given. `every` still
    // drives the schedule bar (that genuinely tracks the next tick); this drives the chip and the
    // sort.
    cadenceMs: desc.cadenceMs || null,
    scheduleText: desc.scheduleText || '',
    source: desc.source || 'controller',
    pausedByMovieMode: !!desc.pausedByMovieMode,
    actions: desc.actions || [],
    enabled: desc.enabled == null ? true : !!desc.enabled,
    offReason: desc.offReason || '',
    // runtime
    running: false,
    startedAt: 0,
    lastRun: 0,      // when the last attempt FINISHED
    lastOk: 0,       // when the last attempt finished WITHOUT throwing
    lastMs: 0,
    lastError: '',
    runs: 0,
    fails: 0,
    // optional richer reporting, set via report()
    progress: null,  // { done, total }
    etaMs: null,
    detail: '',
    stateOverride: null,
    // A function returning the job's state RIGHT NOW, evaluated at read time. stateOverride is a
    // value written at report time, which is only correct if the job reports on every transition —
    // and the probe proved it does not: it reports once per tick, before the encode starts, so the
    // card read "waiting" for the entire 200s encode. Anything whose state changes between reports
    // should supply this instead.
    stateFn: null,
  };
  _jobs.set(job.id, job);
  if (!fn) return undefined;

  return async function trackedJob(...args) {
    // A job already in flight must not be double-counted. The wrapper does NOT skip the call —
    // every sweep here has its own busy guard and some are re-entrant on purpose; we only avoid
    // clobbering the timing of the run that is already recorded.
    if (job.running) return fn.apply(this, args);
    job.running = true;
    job.startedAt = Date.now();
    try {
      const out = await fn.apply(this, args);
      job.lastMs = Date.now() - job.startedAt;
      job.lastOk = Date.now();
      job.lastError = '';
      job.runs += 1;
      return out;
    } catch (e) {
      job.lastMs = Date.now() - job.startedAt;
      job.lastError = String((e && e.message) || e).slice(0, 200);
      job.runs += 1;
      job.fails += 1;
      // Swallowed on purpose: these are setInterval callbacks. Rethrowing would surface as an
      // unhandled rejection and, under Node's default, could take the controller down — a
      // reporting layer must never be able to do that. The failure is recorded and rendered.
      return undefined;
    } finally {
      job.lastRun = Date.now();
      job.running = false;
    }
  };
}

// Richer state for jobs that know more about themselves than the wrapper can infer (probe's
// per-film progress, audit's verification queue). Merged over the tracked fields at read time.
function report(id, patch) {
  const job = _jobs.get(id);
  if (!job || !patch) return;
  for (const k of ['progress', 'etaMs', 'detail', 'stateOverride', 'stateFn', 'enabled', 'offReason', 'actions', 'startedAt']) {
    if (k in patch) job[k] = patch[k];
  }
}

// Mark a job as not-applicable-here rather than broken (e.g. no API key provisioned).
function disable(id, reason) { report(id, { enabled: false, offReason: reason || 'disabled' }); }

function state(job) {
  // Live first: a job that can answer for itself is always more current than anything cached.
  if (job.stateFn) {
    try { const s = job.stateFn(); if (s) return s; } catch { /* never let a bad hook blank the tab */ }
  }
  if (job.stateOverride) return job.stateOverride;
  if (!job.enabled) return 'off';
  if (job.running) return 'running';
  if (job.pausedByMovieMode && isMasterPaused()) return 'paused';
  if (job.lastError) return 'error';
  if (!job.lastRun) return 'never';
  return 'idle';
}

function snapshot(job) {
  const st = state(job);
  return {
    id: job.id, name: job.name, what: job.what, group: job.group, weight: job.weight,
    source: job.source, state: st,
    // Each state's detail line comes from a different place, and every one of them must say
    // SOMETHING: a card with no explanation is what made these jobs unreadable before this tab.
    //   paused  which latch is holding it (the state already says Movie Mode — don't repeat it)
    //   error   the exception message
    //   off     why it is disabled, e.g. a missing API key
    detail: st === 'paused' ? (pauseReason() || '')
      : st === 'error' ? job.lastError
        : st === 'off' ? (job.offReason || '')
          : job.detail,
    progress: job.progress && job.progress.total
      ? { done: job.progress.done || 0, total: job.progress.total,
          pct: +((job.progress.done || 0) * 100 / job.progress.total).toFixed(1) }
      : null,
    etaMs: job.etaMs || null,
    every: job.every, cadenceMs: job.cadenceMs, scheduleText: job.scheduleText,
    lastRun: job.lastRun || null, lastOk: job.lastOk || null, lastMs: job.lastMs || null,
    // Only meaningful for fixed-interval jobs that have run at least once. Nightly/window jobs
    // and event-driven ones supply their own schedule text instead of a fake countdown.
    nextRun: (job.every && job.lastRun) ? job.lastRun + job.every : null,
    runs: job.runs, fails: job.fails,
    running: st === 'running',
    startedAt: st === 'running' ? (job.startedAt || null) : null,
    actions: job.actions,
  };
}

// ---- Jellyfin scheduled tasks ----------------------------------------------------------------
// Only the tasks that represent real work on OUR library. The full list is 28 entries, most of
// which are Jellyfin plumbing (cache cleanup, plugin startup shims, Live TV guide refresh for a
// tuner we do not have) and would bury the jobs that matter in noise. Anything omitted here is
// invisible in the tab by design — add a line to bring one in.
const JF_TASKS = new Map([
  ['Generate Trickplay Images', { weight: 86, group: 'Media processing', what: 'Seek-preview thumbnails' }],
  ['Scan Media Library', { weight: 82, group: 'Media processing', what: 'Finds new files and refreshes metadata' }],
  ['Detect and Analyze Media Segments', { weight: 78, group: 'Media processing', what: 'Finds intros and credits to skip' }],
  ['Extract Chapter Images', { weight: 74, group: 'Media processing', what: 'Thumbnails for chapter markers' }],
  ['Audio Normalization', { weight: 72, group: 'Media processing', what: 'Evens out volume between titles' }],
  ['Keyframe Extractor', { weight: 68, group: 'Media processing', what: 'Indexes keyframes for faster seeking' }],
  ['Media Segment Scan', { weight: 66, group: 'Media processing', what: 'Queues new items for segment analysis' }],
  ['Download missing subtitles', { weight: 62, group: 'Media processing', what: 'Fetches missing subtitles' }],
  ['Refresh People', { weight: 46, group: 'Metadata', what: 'Updates cast photos and bios' }],
  ['Optimize database', { weight: 20, group: 'System', what: 'Compacts the Jellyfin database' }],
]);

const JF_STATE = { Running: 'running', Cancelling: 'running', Idle: 'idle' };

// Jellyfin reports triggers structurally; turn them into the same one-line schedule text the
// controller jobs use so both render identically.
// Jellyfin states its cadence structurally; turn it into BOTH the one-line schedule text and a real
// interval in ms. The interval is what lets a Jellyfin card draw the same fills-toward-next-run bar
// as a controller sweep — without it those ten cards showed an empty track, which is precisely the
// "some rows have a bar, some don't" inconsistency the fixed geometry exists to remove.
function jfEvery(triggers) {
  let best = null;
  for (const t of triggers || []) {
    let ms = null;
    if (t.Type === 'IntervalTrigger' && t.IntervalTicks) ms = t.IntervalTicks / 10000;
    else if (t.Type === 'DailyTrigger') ms = 86400000;
    else if (t.Type === 'WeeklyTrigger') ms = 7 * 86400000;
    // Shortest wins: a task with both a daily and a startup trigger is really on the daily clock.
    if (ms && (best == null || ms < best)) best = ms;
  }
  return best;
}

// Did this run stop because it reached its configured runtime cap? Jellyfin records the cap per
// trigger as MaxRuntimeTicks (100ns units) and does NOT say why a task was cancelled, so the only
// available evidence is that the run lasted about as long as the cap allows. Ticks are compared with
// a small tolerance because the reported end time trails the cancellation by a few seconds — the
// observed trickplay run was "240 minutes and 5 seconds" against a 240 minute cap.
function jfHitRuntimeCap(triggers, start, end) {
  if (!start || !end) return false;
  const ranMs = end - start;
  for (const t of triggers || []) {
    if (!t.MaxRuntimeTicks) continue;
    const capMs = t.MaxRuntimeTicks / 10000;
    if (ranMs >= capMs - 60000) return true;
  }
  return false;
}

function jfSchedule(triggers) {
  const parts = [];
  for (const t of triggers || []) {
    if (t.Type === 'DailyTrigger' && t.TimeOfDayTicks != null) {
      const mins = Math.round(t.TimeOfDayTicks / 600000000);
      parts.push(`daily ${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`);
    } else if (t.Type === 'IntervalTrigger' && t.IntervalTicks != null) {
      const h = t.IntervalTicks / 36000000000;
      parts.push(h >= 1 ? `every ${+h.toFixed(1)}h` : `every ${Math.round(h * 60)} min`);
    } else if (t.Type === 'WeeklyTrigger') parts.push('weekly');
    else if (t.Type === 'StartupTrigger') parts.push('on startup');
  }
  return parts.join(' · ') || 'manual only';
}

async function jellyfinJobs() {
  if (!cfg.JELLYFIN_KEY) return [];
  let tasks;
  try {
    tasks = await tfetchJson(`${HOST.jellyfin}/ScheduledTasks`,
      { headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY } }, 8000);
  } catch { return []; }   // Jellyfin down: the tab drops these rows rather than showing fiction
  if (!Array.isArray(tasks)) return [];
  const out = [];
  for (const t of tasks) {
    const meta = JF_TASKS.get(t.Name);
    if (!meta) continue;
    const res = t.LastExecutionResult || {};
    // CANCELLED IS NOT A FAILURE, and conflating the two made the tab cry wolf. Jellyfin's
    // TaskCompletionStatus is Completed | Failed | Cancelled | Aborted, and `Cancelled` is what it
    // writes when a task is stopped deliberately — including by a trigger's MaxRuntimeTicks, which
    // is exactly the 4h cap we put on Generate Trickplay Images after the daytime runaway. So the
    // guardrail doing its job rendered as a red "failed" every single morning.
    //
    // Only `Failed` is a genuine error. Cancelled/Aborted mean "stopped early", which is amber:
    // worth seeing, not worth worrying about. The distinction is carried as its own state so the
    // client can colour it without re-deriving anything.
    const errored = res.Status === 'Failed';
    const cancelled = res.Status === 'Cancelled' || res.Status === 'Aborted';
    const failed = errored;   // kept as the name the rest of this record uses for "counts as a fail"
    const running = JF_STATE[t.State] === 'running';
    const end = res.EndTimeUtc ? Date.parse(res.EndTimeUtc) : 0;
    const start = res.StartTimeUtc ? Date.parse(res.StartTimeUtc) : 0;
    out.push({
      id: `jf:${t.Id}`, name: t.Name, what: meta.what, group: meta.group, weight: meta.weight,
      source: 'jellyfin',
      state: running ? 'running' : (errored ? 'error' : cancelled ? 'cancelled' : (end ? 'idle' : 'never')),
      // Say WHY it stopped early where we can prove it. A run whose duration reached the trigger's
      // MaxRuntimeTicks hit the cap; anything else cancelled was stopped by hand or by shutdown.
      detail: running ? (t.State === 'Cancelling' ? 'stopping' : '')
        : errored ? (res.ErrorMessage || 'failed')
          : cancelled ? (jfHitRuntimeCap(t.Triggers, start, end) ? 'stopped at its time limit' : 'stopped early')
            : '',
      // Jellyfin gives a percentage, not a count. Present it as a completed/total pair so the
      // shared component needs no special case for percent-only jobs.
      progress: running && t.CurrentProgressPercentage != null
        ? { done: +t.CurrentProgressPercentage.toFixed(1), total: 100, pct: +t.CurrentProgressPercentage.toFixed(1) }
        : null,
      etaMs: null,
      every: jfEvery(t.Triggers), scheduleText: jfSchedule(t.Triggers),
      lastRun: end || null, lastOk: (end && !failed) ? end : null,
      lastMs: (start && end) ? end - start : null,
      nextRun: (end && jfEvery(t.Triggers)) ? end + jfEvery(t.Triggers) : null,
      runs: 0, fails: failed ? 1 : 0,
      running, startedAt: running && start ? start : null,
      // One or the other, never both: offering "Run" on a task that is already running is a button
      // whose only possible effect is to restart work that is 48% done.
      actions: running ? ['stop'] : ['start'],
      jfId: t.Id,
    });
  }
  return out;
}

// ---- host-side jobs --------------------------------------------------------------------------
// Contract for the status files (written by scripts/*.sh via scripts/lib.sh job_status):
//   { id, name, what, group, weight, state, detail, progress:{done,total}, lastRun, lastMs,
//     scheduleText, ts }
// `ts` is the write time and is how we detect a job whose host unit has stopped firing.
const HOST_STALE_FACTOR = 3;   // no heartbeat for 3 scheduled intervals => the timer is broken

function hostJobs() {
  let names;
  try { names = fs.readdirSync(HOST_JOBS_DIR); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(HOST_JOBS_DIR, n), 'utf8')); } catch { continue; }
    if (!j || !j.id) continue;
    const ts = Number(j.ts) || 0;
    const every = Number(j.every) || 0;
    // A host job cannot tell us it has died; silence is the only symptom. Surfacing that as an
    // error beats rendering a stale "idle" that looks healthy forever.
    const stale = every && ts && (Date.now() - ts) > every * HOST_STALE_FACTOR;
    out.push({
      id: `host:${j.id}`, name: j.name || j.id, what: j.what || '',
      group: j.group || 'Media processing', weight: j.weight == null ? 50 : j.weight,
      source: 'host',
      state: stale ? 'error' : (j.state || 'idle'),
      detail: stale
        ? `no heartbeat since ${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')} — is ps4fix.timer running?`
        : (j.detail || ''),
      progress: j.progress && j.progress.total
        ? { done: j.progress.done || 0, total: j.progress.total,
            pct: +((j.progress.done || 0) * 100 / j.progress.total).toFixed(1) }
        : null,
      etaMs: j.etaMs || null,
      every: every || null, scheduleText: j.scheduleText || '',
      lastRun: Number(j.lastRun) || ts || null, lastOk: Number(j.lastOk) || null,
      lastMs: Number(j.lastMs) || null, nextRun: (every && ts) ? ts + every : null,
      runs: Number(j.runs) || 0, fails: Number(j.fails) || 0,
      running: j.state === 'running', startedAt: null,
      actions: [],
    });
  }
  return out;
}

// ---- the endpoint ----------------------------------------------------------------------------
async function allJobs() {
  const local = [..._jobs.values()].map(snapshot);
  const jf = await jellyfinJobs();
  return local.concat(jf, hostJobs())
    // Heaviest and most interesting first, as the tab is meant to be read top-down.
    .sort((a, b) => (b.weight - a.weight) || a.name.localeCompare(b.name));
}

app.get('/api/jobs', async (_req, res) => {
  try {
    res.json({
      ts: Date.now(),
      movieMode: movieModeStatus(),
      jobs: await allJobs(),
    });
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});

// Run or stop a Jellyfin scheduled task on demand. Controller-job actions are owned by the module
// that runs them (probe already has /api/probe/session/*), so this route is Jellyfin-only.
app.post('/api/jobs/jf/:id/:verb', async (req, res) => {
  const { id, verb } = req.params;
  if (!cfg.JELLYFIN_KEY) return res.status(503).json({ error: 'Jellyfin key not provisioned' });
  if (verb !== 'start' && verb !== 'stop') return res.status(400).json({ error: 'verb must be start or stop' });
  // Only ids we actually published, so this cannot be used to poke arbitrary Jellyfin endpoints.
  if (!/^[a-f0-9]{8,40}$/i.test(id)) return res.status(400).json({ error: 'bad task id' });
  try {
    // tfetch, not tfetchJson: both verbs answer 204 with an empty body, which is not JSON.
    const r = await tfetch(`${HOST.jellyfin}/ScheduledTasks/Running/${id}`,
      { method: verb === 'start' ? 'POST' : 'DELETE', headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY } }, 8000);
    if (!r.ok) return res.status(502).json({ error: `Jellyfin answered ${r.status}` });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: String((e && e.message) || e) }); }
});

module.exports = { define, report, disable, allJobs, snapshot, jfSchedule, jfEvery, HOST_JOBS_DIR };
