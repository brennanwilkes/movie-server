'use strict';
// The Jobs registry and auto Movie Mode, added 2026-08-06.
//
// Worth its own suite because both are SAFETY-adjacent in a way that is invisible when broken:
//
//   • The auto Movie Mode latch decides whether EVERY background job on this box is allowed to
//     run. A latch that sticks ON silently halts the probe, the audit verifier, every sweep and
//     all downloads, with no error anywhere — the box just quietly stops working and looks fine.
//     A latch that sticks OFF hammers the USB disk during a film, which is the whole thing Movie
//     Mode exists to prevent. Neither failure raises anything; both are only caught by asserting
//     the state machine directly.
//
//   • The two latches have DIFFERENT lifetimes on purpose (manual persists across playback and
//     restarts, auto does not), and the interaction between them is where the bugs live: clearing
//     a manual hold mid-film must not resume the box, and a film ending must not clear a manual
//     hold. Both are asserted below.
//
// The registry tests cover state derivation and the host-job staleness rule, because "a host timer
// stopped firing" otherwise renders as a permanently healthy-looking `idle` card.
const path = require('path');

// jobs.js and movie-mode.js register express routes on require, which is harmless here, but they
// also read /config — point that somewhere disposable so a test run cannot touch real state.
process.env.CONTROLLER_CONFIG_DIR = path.join(require('os').tmpdir(), `jobs-test-${process.pid}`);

const state = require('../controller/lib/state');
const jobs = require('../controller/lib/jobs');
const mm = require('../controller/lib/movie-mode');

let pass = 0; let fail = 0;
const ok = (c, why) => { if (c) pass++; else { fail++; console.log(`FAIL  ${why}`); } };
const eq = (a, b, why) => ok(a === b, `${why} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// Reset both latches and the session table between cases — these modules are singletons.
function reset() {
  state.setMasterPaused(false);
  state.setAutoPaused(false);
  mm._sessions.clear();
}

// ---- the two latches ---------------------------------------------------------------------------
reset();
eq(state.isMasterPaused(), false, 'both latches clear = not paused');

state.setMasterPaused(true);
eq(state.isMasterPaused(), true, 'manual latch alone pauses');
eq(state.pauseReason(), 'held on manually', 'manual latch explains itself');

state.setAutoPaused(true);
eq(state.pauseReason(), 'held on manually',
  'manual wins the description when both are set — it is the one the user can act on');

state.setMasterPaused(false);
eq(state.isMasterPaused(), true,
  'clearing the manual hold while something plays leaves the box paused on the auto latch');
eq(state.pauseReason(), 'someone is watching', 'and the reason updates to the surviving latch');

state.setAutoPaused(false);
eq(state.isMasterPaused(), false, 'clearing both resumes');

// The whole point of the split: a film ending must never clear a deliberate human hold.
reset();
state.setMasterPaused(true);
state.setAutoPaused(true);
state.setAutoPaused(false);              // playback ended
eq(state.isMasterPaused(), true, 'a film ending does NOT release a manual hold');
eq(state.movieModeStatus().manual, true, 'and the manual latch is still reported as the holder');

// ---- session table -> wanted() -----------------------------------------------------------------
reset();
eq(mm.wanted(), false, 'no sessions = nothing playing');
mm._sessions.set('dev1', { id: 'dev1', title: 'Heat', ts: Date.now() });
eq(mm.wanted(), true, 'one session = playing');
mm._sessions.set('dev2', { id: 'dev2', title: 'Alien', ts: Date.now() });
eq(mm.describe(), 'Heat +1 more', 'two sessions summarise rather than listing everything');
mm._sessions.delete('dev2');
eq(mm.describe(), 'Heat', 'one session names it');

// THE failure this design exists for: a dropped PlaybackStop must not pin the latch on forever.
reset();
mm._sessions.set('ghost', { id: 'ghost', title: 'Zombie', ts: Date.now() - 30 * 60000 });
mm._sessions.set('live', { id: 'live', title: 'Real', ts: Date.now() });
eq(mm.pruneStale(), 1, 'a session with no webhook for 15+ min is dropped');
eq(mm.wanted(), true, 'but a live session in the same table survives the prune');
mm._sessions.clear();
mm._sessions.set('ghost', { id: 'ghost', title: 'Zombie', ts: Date.now() - 30 * 60000 });
mm.pruneStale();
eq(mm.wanted(), false, 'once the last stale session is dropped the latch can release');

// ---- orphaned-pause recovery -------------------------------------------------------------------
// The auto latch is not persisted but its qBittorrent side effect IS, so a restart mid-film would
// otherwise leave every torrent stopped with nothing left that knows to resume them. This path only
// ever runs on boot, which is exactly why it needs a test — nobody will see it fail in practice.
async function testOrphanRecovery() {
  reset();
  const calls = [];
  mm.setApplier(async (on) => { calls.push(on); });

  // Nothing was held: recovery must be a no-op, not a gratuitous "resume everything" on every boot.
  state.setAutoHeldQbit(false);
  await mm.recoverOrphanedPause();
  eq(calls.length, 0, 'recovery does nothing when auto was not holding the torrents');

  // Auto was holding them and we restarted: resume exactly once.
  state.setAutoHeldQbit(true);
  await mm.recoverOrphanedPause();
  eq(calls.length, 1, 'an orphaned auto-pause is resumed on boot');
  eq(calls[0], false, 'and it resumes rather than re-pausing');
  eq(state.isAutoHeldQbit(), false, 'the claim is cleared so it cannot fire twice');

  // A manual hold outranks it: recovery must NOT override a deliberate human pause.
  calls.length = 0;
  state.setAutoHeldQbit(true);
  state.setMasterPaused(true);
  await mm.recoverOrphanedPause();
  eq(calls.length, 0, 'recovery never overrides a manual hold');
  eq(state.isAutoHeldQbit(), false, 'but it drops its stale claim so a later boot will not resume');
  state.setMasterPaused(false);
  mm.setApplier(null);
}

// ---- webhook payload parsing -------------------------------------------------------------------
// Field names vary by plugin version and template, so titleOf accepts several spellings. A silent
// regression here shows up as "something" on the Movie Mode card rather than as an error.
eq(mm.titleOf({ Name: 'Blade Runner 2049' }), 'Blade Runner 2049', 'movie title from Name');
eq(mm.titleOf({ SeriesName: 'The Wire', SeasonNumber: 1, EpisodeNumber: 6 }), 'The Wire S1E6',
  'episode renders as SxxExx');
eq(mm.titleOf({ SeriesName: 'The Wire', Name: 'The Wire Up' }), 'The Wire — The Wire Up',
  'episode without numbers falls back to series and name');
eq(mm.titleOf({}), 'something', 'an unrecognised payload never renders undefined');
eq(mm.titleOf({ name: 'lowercase key' }), 'lowercase key', 'alternate field casing is accepted');

// ---- registry state derivation -----------------------------------------------------------------
reset();
const run = jobs.define({ id: 't-basic', name: 'Basic', every: 1000 }, async () => 'done');
let snap = jobs.allJobs;   // referenced to keep the export honest
ok(typeof snap === 'function', 'allJobs is exported');

const find = async (id) => (await jobs.allJobs()).find((j) => j.id === id);

(async () => {
  await testOrphanRecovery();

  eq((await find('t-basic')).state, 'never', 'a registered job that has not run reads as never');

  await run();
  const afterRun = await find('t-basic');
  eq(afterRun.state, 'idle', 'a clean run leaves the job idle, not "ok" — healthy jobs stay quiet');
  eq(afterRun.runs, 1, 'runs is counted');
  eq(afterRun.fails, 0, 'a clean run does not count a failure');
  ok(afterRun.lastOk > 0, 'lastOk is stamped on success');
  ok(afterRun.nextRun === afterRun.lastRun + 1000, 'nextRun is derived from the interval');

  // A throwing job must be RECORDED, never rethrown: these are setInterval callbacks and an
  // unhandled rejection could take the whole controller down. A reporting layer must not be able
  // to kill the thing it reports on.
  const boom = jobs.define({ id: 't-throw', name: 'Throws' }, async () => { throw new Error('nope'); });
  let threw = false;
  try { await boom(); } catch { threw = true; }
  eq(threw, false, 'a failing job does not propagate its error to the timer');
  const failed = await find('t-throw');
  eq(failed.state, 'error', 'a failing job reads as error');
  eq(failed.detail, 'nope', 'and the message is carried into the detail line');
  eq(failed.fails, 1, 'the failure is counted');

  // Movie Mode presentation: jobs that stand down must say so, and jobs that do not must not.
  const gated = jobs.define({ id: 't-gated', name: 'Gated', pausedByMovieMode: true }, async () => {});
  await gated();
  const ungated = jobs.define({ id: 't-ungated', name: 'Ungated' }, async () => {});
  await ungated();
  state.setMasterPaused(true);
  eq((await find('t-gated')).state, 'paused', 'a Movie-Mode-gated job reads as paused');
  eq((await find('t-gated')).detail, 'held on manually', 'and explains which latch is holding it');
  eq((await find('t-ungated')).state, 'idle', 'a job that ignores Movie Mode is unaffected');
  state.setMasterPaused(false);

  // LIVE STATE. This is a regression test for a real bug: the probe reported its state once per
  // tick, immediately BEFORE starting a ~200s encode, so the card read "waiting" for the entire
  // time it was working. A value written at report time is only ever correct for jobs that report
  // on every transition — anything else needs a function evaluated when the tab reads.
  let live = 'waiting';
  const liveJob = jobs.define({ id: 't-live', name: 'Live' }, async () => {});
  await liveJob();
  jobs.report('t-live', { stateFn: () => live });
  eq((await find('t-live')).state, 'waiting', 'stateFn wins over the wrapper');
  live = 'running';
  eq((await find('t-live')).state, 'running', 'and it is re-evaluated on every read, not cached');
  eq((await find('t-live')).running, true, 'the running flag follows the resolved state');
  live = null;
  eq((await find('t-live')).state, 'idle', 'returning null falls through to the normal determination');
  // A throwing hook must not take the tab down — it would blank every card, not just this one.
  jobs.report('t-live', { stateFn: () => { throw new Error('bad hook'); } });
  eq((await find('t-live')).state, 'idle', 'a throwing stateFn is ignored rather than fatal');
  jobs.report('t-live', { stateFn: null });

  // Progress reporting, which is what the shared bar renders.
  jobs.report('t-basic', { progress: { done: 133, total: 1014 }, etaMs: 60000 });
  const prog = await find('t-basic');
  eq(prog.progress.pct, 13.1, 'percentage is derived, not supplied');
  eq(prog.etaMs, 60000, 'eta passes through for the UI to format');

  // A disabled job must be explained, not merely absent — silence reads as a bug.
  jobs.disable('t-basic', 'no API key');
  const offJob = await find('t-basic');
  eq(offJob.state, 'off', 'a disabled job reads as off');
  eq(offJob.detail, 'no API key', 'with the reason it is off');

  // Ordering is the tab's whole information architecture: heaviest first.
  const heavy = jobs.define({ id: 't-heavy', name: 'Heavy', weight: 999 }, async () => {});
  void heavy;
  const all = await jobs.allJobs();
  eq(all[0].id, 't-heavy', 'the heaviest job sorts to the top');
  ok(all.every((j, i) => i === 0 || all[i - 1].weight >= j.weight), 'the list is weight-ordered');

  // ---- Jellyfin trigger rendering --------------------------------------------------------------
  // Ticks are Jellyfin's unit (100ns). Getting this wrong renders "every 0.0h" on real tasks.
  eq(jobs.jfSchedule([{ Type: 'DailyTrigger', TimeOfDayTicks: 3 * 36000000000 }]), 'daily 03:00',
    'daily trigger ticks convert to a padded clock time');
  eq(jobs.jfSchedule([{ Type: 'IntervalTrigger', IntervalTicks: 24 * 36000000000 }]), 'every 24h',
    'interval trigger ticks convert to hours');
  eq(jobs.jfSchedule([{ Type: 'IntervalTrigger', IntervalTicks: 36000000000 / 4 }]), 'every 15 min',
    'sub-hour intervals render as minutes, not "every 0.3h"');
  eq(jobs.jfSchedule([]), 'manual only', 'a task with no trigger says so rather than looking broken');
  eq(jobs.jfSchedule([{ Type: 'StartupTrigger' }, { Type: 'DailyTrigger', TimeOfDayTicks: 0 }]),
    'on startup · daily 00:00', 'multiple triggers are joined');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
