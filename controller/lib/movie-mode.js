'use strict';
// AUTO MOVIE MODE — starting a film pauses the box; stopping it resumes. Owns: the live playback
// session table, the auto latch's lifecycle, and /api/jellyfin-webhook. One timer, started
// explicitly by server.js.
//
// WHY A WEBHOOK AND NOT POLLING (Brennan's call, 2026-08-06) — SUPERSEDED 2026-08-12, see the end of
// this header: the Jellyfin Webhook plugin pushes PlaybackStart the instant a title begins, so the disk
// goes quiet before the first seek instead of up to a poll-interval later. The cost is that the plugin
// becomes load-bearing infrastructure, which is why scripts/provision/jellyfin.sh installs AND
// configures it idempotently, and why the staleness sweep below exists. That cost came due six days
// later. The latency argument was right and is preserved — the webhook still short-circuits the poll —
// but it is no longer the only thing standing between a film and a busy disk.
//
// THE FAILURE MODE THIS IS BUILT AROUND: a webhook is a fire-and-forget HTTP POST. A dropped
// PlaybackStop — client killed, network blip, Jellyfin restarted mid-film, plugin disabled — would
// otherwise leave the auto latch stuck ON, which silently halts EVERY background job on the box
// forever with no error anywhere. So the latch is not a boolean the events flip; it is DERIVED
// from a table of sessions that each expire on their own. PlaybackProgress refreshes a session's
// timestamp; anything not heard from in PLAY_STALE_MS is dropped. The worst a lost event can cost
// is one stale window, not an indefinite freeze.
//
// GRACE ON RELEASE: when the last session ends we wait GRACE_MS before resuming. Pausing to get a
// drink, an episode boundary, or seeking across a chapter all briefly produce zero sessions, and
// resuming means starting every torrent and re-enabling every sweep — expensive churn to undo
// seconds later. Grace turns a flap into a no-op. Acquiring the latch has NO grace: quiet-the-box
// must be immediate to be worth anything.
//
// ── 2026-08-12: THE WEBHOOK STOPPED BEING TRUSTED AS THE ONLY SOURCE ─────────────────────────────
// Measured, with Brennan playing "One Battle After Another" on Jellyfin Web while we watched: Jellyfin
// reported an unpaused session for 90 seconds and this module received NOTHING. `lastEvent` had been
// null since the 08-09 restart, and the last real auto-arm was 2026-08-06 — so three nights of films
// ran with every background job still hammering the disk.
//
// The cause is in Jellyfin, not here, and the log proves it. At 19:20:36 the Playback Reporting plugin
// logged "Adding playback tracker / Adding Start Event" for that exact session, so Jellyfin IS firing
// playback events and plugins CAN consume them. The Webhook plugin logged nothing. Its Item Added /
// Item Deleted notifiers are SCHEDULED TASKS and they run fine every 90s; its playback notifiers are
// `IEventConsumer<PlaybackStartEventArgs>` registrations through Jellyfin's EventManager, and those
// never fire. Config was never the problem — EnableWebhook, SendAllProperties, the notification-type
// spellings and the URL all matched the provisioner exactly, and the endpoint answers 200 by hand.
//
// A feature that silently stops working is worse than one that is merely slower, and "every background
// job on the box keeps running through a film" is exactly the failure Movie Mode exists to prevent. So
// the SESSION TABLE IS NOW POLLED and the webhook is demoted to an accelerator:
//   poll    — ground truth, every MM_POLL_MS. Cannot silently die: if Jellyfin answers, we know what is
//             playing; if it does not, nothing changes and the existing stale expiry still applies.
//   webhook — kept because when it works it arms the latch in milliseconds rather than up to one poll
//             interval, which is the whole reason Brennan chose it on 2026-08-06. It is now a bonus.
// Both write the same table keyed the same way (DeviceId), so they cannot double-count one playback.
const app = require('./app');
const { cfg, HOST } = require('./config');
const { tfetch } = require('./clients');
const metrics = require('../metrics');
// No persistState here on purpose: the auto latch is deliberately not persisted (see below).
const {
  isManualPaused, isAutoPaused, setAutoPaused, movieModeStatus,
  isAutoHeldQbit, setAutoHeldQbit, persistState,
} = require('./state');

// Tunables. Defaults chosen to match probe.js's own zombie-session cutoff (15 min) so the two
// subsystems agree on when a session has stopped being real.
const PLAY_STALE_MS = Number(cfg.MM_PLAY_STALE_MS || 15 * 60 * 1000);
const GRACE_MS = Number(cfg.MM_GRACE_MS || 3 * 60 * 1000);
const SWEEP_MS = 30 * 1000;
// How often we ask Jellyfin what is playing. 15s is the worst-case latency for ARMING the latch, and
// the cost is one cheap /Sessions call — the same one replaceSweep already makes every 60s. Not faster,
// because arming is only urgent relative to a film's runtime and a tighter loop buys nothing; not
// slower, because up to a minute of full-speed sweeps at the start of a film is what we are fixing.
const POLL_MS = Number(cfg.MM_POLL_MS || 15 * 1000);

// sessionId -> { id, title, user, client, ts, paused }
const _sessions = new Map();
let _releaseAt = 0;        // when the grace period expires (0 = not in grace)
let _applying = false;     // an apply() is mid-flight; prevents overlapping qBittorrent calls
let _pending = false;      // a state change arrived during an apply(); re-run when it finishes
let _onApply = null;       // injected by routes-actions to reuse the manual button's exact recipe

// routes-actions.js owns the pause/resume recipe (qBittorrent add_stopped + pause/resume all).
// Injected downward rather than required, because routes-actions requires this module for the
// webhook route — requiring it back would be a cycle.
function setApplier(fn) { _onApply = fn; }

// Metrics must never be able to break the latch. emitEvent does a synchronous appendFileSync to
// /config, and pruneStale() runs straight off a setInterval — an ENOSPC or a read-only /config there
// would be an UNCAUGHT exception in a timer, taking down the process that is holding Movie Mode.
// Losing a metrics line is free; losing the controller is not.
function noteEvent(type, data) {
  try { metrics.emitEvent(type, data); } catch { /* telemetry is never load-bearing */ }
}

function liveCount() { return _sessions.size; }

// The latch we WANT, from the session table alone. Distinct from the latch we HAVE (isAutoPaused)
// so apply() can see a difference and act on it exactly once.
function wanted() { return _sessions.size > 0; }

function describe() {
  const titles = [..._sessions.values()].map((s) => s.title).filter(Boolean);
  if (!titles.length) return '';
  return titles.length === 1 ? titles[0] : `${titles[0]} +${titles.length - 1} more`;
}

// Drop sessions we have not heard from in PLAY_STALE_MS. See the header: this is what keeps a lost
// PlaybackStop from freezing the box indefinitely.
function pruneStale() {
  const cutoff = Date.now() - PLAY_STALE_MS;
  let dropped = 0;
  for (const [id, s] of _sessions) {
    if (s.ts < cutoff) { _sessions.delete(id); dropped += 1; }
  }
  if (dropped) {
    console.log(`movie-mode: dropped ${dropped} stale playback session(s) — no webhook for ${Math.round(PLAY_STALE_MS / 60000)} min`);
    noteEvent('movie_mode_stale', { dropped, remaining: _sessions.size });
  }
  return dropped;
}

// Only these item types quiet the box. Music and photos do not compete for the disk in any way
// that matters, and a Live TV stream is not ours to protect. Declared HERE, above both consumers, because
// the poll and the webhook must gate on the identical set — they write the same table.
const WATCHED_TYPES = new Set(['Movie', 'Episode', 'Video', 'MusicVideo']);

// ---- the poll: ground truth ------------------------------------------------------------------
// Reads Jellyfin's live session list and makes the table match it. Returns true when Jellyfin
// answered (so the caller knows the answer is authoritative), false on any failure.
//
// WHEN THE POLL SUCCEEDS IT IS THE AUTHORITY, including for REMOVAL — a session Jellyfin no longer
// lists is gone, whoever put it in the table. That is what makes a lost PlaybackStop self-heal in one
// poll instead of one PLAY_STALE_MS, and it also means a stuck webhook latch can no longer pin the box
// quiet for 15 minutes. Entries are still stamped with `ts` so pruneStale remains a backstop for the
// case this function keeps failing.
//
// WHEN IT FAILS, NOTHING CHANGES. Jellyfin being briefly unreachable must never look like "nothing is
// playing" — that would resume every torrent mid-film, which is the exact opposite of the job.
let _pollFailures = 0;
async function pollSessions() {
  let sessions;
  try {
    const r = await tfetch(`${HOST.jellyfin}/Sessions`,
      { headers: { Authorization: `MediaBrowser Token="${cfg.JELLYFIN_KEY || ''}"` } }, 6000);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    sessions = await r.json();
  } catch (e) {
    // Logged once per transition, not every 15s — a Jellyfin restart must not spam the log.
    if (_pollFailures === 0) console.log(`movie-mode: Jellyfin session poll failed (${e.message || e}) — table left as-is`);
    _pollFailures += 1;
    return false;
  }
  if (!Array.isArray(sessions)) { _pollFailures += 1; return false; }
  if (_pollFailures) {
    console.log(`movie-mode: Jellyfin session poll recovered after ${_pollFailures} failure(s)`);
    _pollFailures = 0;
  }
  const now = Date.now();
  const live = playingFromSessions(sessions, now);
  for (const [id, row] of live) {
    if (!_sessions.has(id)) console.log(`movie-mode: start — ${row.title} [${row.client || 'unknown client'}] (poll)`);
    _sessions.set(id, row);
  }
  for (const [id, s] of [..._sessions]) {
    if (live.has(id)) continue;
    _sessions.delete(id);
    console.log(`movie-mode: stop — ${s.title} (poll says it is gone, ${_sessions.size} still playing)`);
  }
  return true;
}

// The PURE half of the poll: a Jellyfin /Sessions payload -> the rows the table should hold. Split out
// so it can be tested against real payload shapes without a Jellyfin, without a network call and
// without reporting fake playback against Brennan's watch history (see scripts/test-movie-mode.js).
// Every field name here was read off the live server on 2026-08-12.
function playingFromSessions(sessions, now = Date.now()) {
  const out = new Map();
  for (const s of (Array.isArray(sessions) ? sessions : [])) {
    const np = s && s.NowPlayingItem;
    if (!np) continue;                                     // an idle client is not playback
    // Same item-type gate the webhook applies, from Jellyfin's own field. Music and photos do not
    // compete for the USB disk in any way worth pausing downloads over. An ABSENT type is accepted,
    // matching the webhook: unknown is not a reason to ignore playback.
    const itemType = String(np.Type || '');
    if (itemType && !WATCHED_TYPES.has(itemType)) continue;
    // DeviceId FIRST, matching the webhook's key exactly — otherwise one film playing on one device
    // would occupy two rows, and `describe()` would report "X +1 more" for a single viewer.
    const id = String(s.DeviceId || s.Id || 'unknown');
    const title = np.SeriesName && np.IndexNumber != null
      ? `${np.SeriesName} S${np.ParentIndexNumber ?? '?'}E${np.IndexNumber}`
      : (np.Name || 'something');
    out.set(id, {
      id,
      title,
      user: s.UserName || '',
      client: s.Client || s.DeviceName || '',
      paused: !!(s.PlayState && s.PlayState.IsPaused),
      ts: now,
    });
  }
  return out;
}

// Reconcile the auto latch with the session table. Idempotent and safe to call often.
async function apply(why) {
  if (_applying) { _pending = true; return; }
  const want = wanted();
  const have = isAutoPaused();

  if (want && !have) {
    _releaseAt = 0;
    _applying = true;
    try {
      setAutoPaused(true);
      console.log(`movie-mode: AUTO ON — ${describe() || 'playback started'} (${why})`);
      noteEvent('movie_mode_auto', { on: true, title: describe(), sessions: _sessions.size });
      // Only touch qBittorrent if the manual latch was not already holding the box quiet; if it
      // was, torrents are stopped already and re-issuing the recipe is pointless churn.
      if (!isManualPaused() && _onApply) {
        await _onApply(true);
        // Remember that AUTO is why the torrents are down, so a restart before the matching resume
        // can undo it — see the note on autoHeldQbit in state.js.
        setAutoHeldQbit(true); persistState();
      }
    } finally { _applying = false; }
  } else if (!want && have) {
    // Start the grace clock on the first tick that sees an empty table, then wait it out.
    if (!_releaseAt) {
      _releaseAt = Date.now() + GRACE_MS;
      console.log(`movie-mode: playback stopped — resuming in ${Math.round(GRACE_MS / 60000)} min unless it restarts`);
      return;
    }
    if (Date.now() < _releaseAt) return;
    _releaseAt = 0;
    _applying = true;
    try {
      setAutoPaused(false);
      console.log(`movie-mode: AUTO OFF — nothing playing for ${Math.round(GRACE_MS / 60000)} min (${why})`);
      noteEvent('movie_mode_auto', { on: false, sessions: 0 });
      // The manual button may still be holding it. Resuming here would override a deliberate
      // human hold, which is the one thing the two-latch split exists to prevent.
      if (!isManualPaused() && _onApply) await _onApply(false);
      setAutoHeldQbit(false); persistState();
    } finally { _applying = false; }
  } else if (want && have) {
    _releaseAt = 0;   // playback came back during grace — cancel the pending resume
  }

  if (_pending) { _pending = false; await apply('coalesced'); }
}

// ---- webhook ---------------------------------------------------------------------------------
// The Webhook plugin's "Generic" destination posts a flat JSON body. Field names depend on the
// configured template, so we accept the several spellings the plugin and its default templates
// use rather than trusting one. NotificationType is the only field that is always present.
function pick(b, ...names) {
  for (const n of names) if (b[n] != null && b[n] !== '') return b[n];
  return undefined;
}

function titleOf(b) {
  const name = pick(b, 'Name', 'ItemName', 'name');
  const series = pick(b, 'SeriesName', 'seriesName');
  const season = pick(b, 'SeasonNumber00', 'SeasonNumber');
  const ep = pick(b, 'EpisodeNumber00', 'EpisodeNumber');
  if (series && season != null && ep != null) return `${series} S${season}E${ep}`;
  if (series && name) return `${series} — ${name}`;
  return name || series || 'something';
}


// Last event's SHAPE, kept for diagnosis. The Webhook plugin's property names depend on its version
// and template, and "auto Movie Mode did nothing" is otherwise indistinguishable from "the plugin is
// not installed". Keys only plus the fields we resolved — enough to see a rename, no payload hoarding.
let _lastEvent = null;

app.post('/api/jellyfin-webhook', async (req, res) => {
  const b = req.body || {};
  // Answer FIRST, always 200. The plugin retries or logs errors on a non-2xx, and a webhook
  // sender must never be left waiting on our qBittorrent round-trip.
  res.json({ ok: true });

  const type = String(pick(b, 'NotificationType', 'notificationType') || '');
  if (!type.startsWith('Playback')) return;

  const itemType = String(pick(b, 'ItemType', 'itemType') || '');
  // Empty itemType means a template we do not recognise; accept it rather than ignore playback.
  if (itemType && !WATCHED_TYPES.has(itemType)) return;

  // DeviceId is the one identifier the plugin definitely sends (SessionId is not in its payload at
  // all — verified against Webhook 21.0.0.0 on 2026-08-06). Per-device is the right granularity
  // anyway: one device plays one thing at a time.
  const id = String(pick(b, 'SessionId', 'PlaySessionId', 'sessionId', 'DeviceId', 'Id') || 'unknown');
  const title = titleOf(b);
  _lastEvent = { at: Date.now(), type, itemType, id, title, keys: Object.keys(b).slice(0, 60) };

  if (type === 'PlaybackStop') {
    _sessions.delete(id);
    console.log(`movie-mode: stop — ${title} (${_sessions.size} still playing)`);
  } else {
    // Start AND Progress both assert "this session is alive now". Treating them identically means
    // a missed PlaybackStart cannot leave a playing film undetected — the next progress ping arms it.
    const prev = _sessions.get(id);
    if (!prev) console.log(`movie-mode: start — ${title} [${pick(b, 'ClientName', 'Client', 'DeviceName') || 'unknown client'}]`);
    _sessions.set(id, {
      id, title,
      user: pick(b, 'NotificationUsername', 'UserName', 'userName') || '',
      client: pick(b, 'ClientName', 'Client', 'DeviceName') || '',
      // IsPaused arrives as a real boolean or the string "true" depending on the template.
      paused: String(pick(b, 'IsPaused', 'isPaused') || 'false') === 'true',
      ts: Date.now(),
    });
  }
  // A PAUSED film still holds the latch on purpose: the viewer is mid-film and about to resume,
  // and thrashing the disk during a bathroom break is exactly what Movie Mode exists to prevent.
  await apply(type).catch((e) => console.log(`movie-mode: apply failed — ${e && e.message}`));
});

// Live playback, for the Jobs tab's Movie Mode card.
function status() {
  const mm = movieModeStatus();
  return {
    ...mm,
    // Non-null only while a resume is actually pending, so the UI can say "resuming in 2 min"
    // instead of implying a countdown that is not running.
    resumingInMs: _releaseAt ? Math.max(0, _releaseAt - Date.now()) : null,
    playing: [..._sessions.values()].map((s) => ({
      title: s.title, user: s.user, client: s.client, paused: s.paused,
      ageMs: Date.now() - s.ts,
    })),
    // THE POLL'S OWN HEALTH, surfaced so "auto Movie Mode did nothing" is answerable from one call.
    // The 2026-08-06→08-12 outage was invisible precisely because nothing reported that the source of
    // truth had gone silent; `lastEvent: null` was the only clue and it reads identically to "nothing
    // has played yet". Now the poll is the source and it says whether it is working.
    poll: {
      everySec: Math.round(POLL_MS / 1000),
      failures: _pollFailures,
      ok: _pollFailures === 0,
    },
    webhook: {
      staleMin: Math.round(PLAY_STALE_MS / 60000), graceMin: Math.round(GRACE_MS / 60000),
      // null here after a restart is normal; null after a film has played means the plugin is not
      // delivering, which is the single most useful thing to know when this feature looks dead.
      lastEvent: _lastEvent,
    },
  };
}

// Undo an auto-pause that a restart orphaned. Without this, deploying while a film was playing
// leaves every torrent stopped and add_stopped_enabled set, with nothing left in the process that
// knows why — downloads simply never resume until someone toggles Movie Mode by hand.
//
// Runs once, late, and ONLY when auto (never manual) was the holder. If something is genuinely
// still playing, the next PlaybackProgress re-arms the latch within a minute and pauses again; a
// few seconds of torrent activity is a much smaller cost than an indefinite silent stall.
async function recoverOrphanedPause() {
  if (!isAutoHeldQbit()) return;
  if (isManualPaused()) {
    // A manual hold is already keeping the torrents down and outranks us. Drop our claim so we do
    // not resume on some later restart against the human's wishes.
    setAutoHeldQbit(false); persistState();
    return;
  }
  console.log('movie-mode: restarted while auto Movie Mode held the torrents down — resuming them');
  noteEvent('movie_mode_recover', { on: false });
  try { if (_onApply) await _onApply(false); } catch (e) { console.log(`movie-mode: recovery failed — ${e && e.message}`); }
  setAutoHeldQbit(false); persistState();
}

function startMovieMode() {
  // One timer drives both expiry and the grace countdown. Without it, a grace period started by
  // the last PlaybackStop would never elapse — no further events arrive to trigger apply().
  setInterval(() => {
    pruneStale();
    apply('sweep').catch(() => { /* logged inside */ });
  }, SWEEP_MS);
  // THE POLL, and it is the reason this feature is no longer hostage to a plugin. Separate timer from
  // the sweep above because the two answer different questions on different clocks: the sweep expires
  // and reconciles the latch, this one refreshes the facts. apply() runs straight after a SUCCESSFUL
  // poll so arming does not wait for the next 30s sweep — the whole point is that the disk goes quiet
  // near the start of the film rather than a minute into it.
  const pollTick = () => pollSessions()
    .then((ok) => (ok ? apply('poll') : null))
    .catch((e) => console.log(`movie-mode: poll tick failed — ${e && e.message}`));
  setInterval(pollTick, POLL_MS);
  setTimeout(pollTick, 3000);              // know what is playing almost immediately after a restart
  // 20s: qBittorrent is a depends_on peer and is usually still starting when we boot.
  setTimeout(() => { recoverOrphanedPause().catch(() => { /* logged inside */ }); }, 20000);
  console.log(`movie-mode: auto Movie Mode armed — polling Jellyfin every ${Math.round(POLL_MS / 1000)}s`
    + ` (stale ${Math.round(PLAY_STALE_MS / 60000)}m, grace ${Math.round(GRACE_MS / 60000)}m);`
    + ' webhook accepted as a low-latency accelerator');
}

module.exports = {
  startMovieMode, setApplier, status, apply, pruneStale, recoverOrphanedPause,
  playingFromSessions, pollSessions,
  // exported for tests
  _sessions, liveCount, wanted, titleOf, describe,
};
