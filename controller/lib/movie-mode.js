'use strict';
// AUTO MOVIE MODE — starting a film pauses the box; stopping it resumes. Owns: the live playback
// session table, the auto latch's lifecycle, and /api/jellyfin-webhook. One timer, started
// explicitly by server.js.
//
// WHY A WEBHOOK AND NOT POLLING (Brennan's call, 2026-08-06): the Jellyfin Webhook plugin pushes
// PlaybackStart the instant a title begins, so the disk goes quiet before the first seek instead
// of up to a poll-interval later. The cost is that the plugin is now load-bearing infrastructure,
// which is why scripts/provision/jellyfin.sh installs AND configures it idempotently, and why the
// staleness sweep below exists.
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
const app = require('./app');
const { cfg } = require('./config');
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

// Only these item types quiet the box. Music and photos do not compete for the disk in any way
// that matters, and a Live TV stream is not ours to protect.
const WATCHED_TYPES = new Set(['Movie', 'Episode', 'Video', 'MusicVideo']);

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
  // 20s: qBittorrent is a depends_on peer and is usually still starting when we boot.
  setTimeout(() => { recoverOrphanedPause().catch(() => { /* logged inside */ }); }, 20000);
  console.log(`movie-mode: auto Movie Mode armed (stale ${Math.round(PLAY_STALE_MS / 60000)}m, grace ${Math.round(GRACE_MS / 60000)}m)`);
}

module.exports = {
  startMovieMode, setApplier, status, apply, pruneStale, recoverOrphanedPause,
  // exported for tests
  _sessions, liveCount, wanted, titleOf, describe,
};
