'use strict';
// playingFromSessions — the parsing half of auto Movie Mode's Jellyfin session poll.
//
// WHY THIS FILE EXISTS. Auto Movie Mode silently stopped working between 2026-08-06 and 2026-08-12:
// three nights of films played with every background job still hammering the USB disk, and the only
// symptom anywhere was `lastEvent: null`, which reads identically to "nothing has played yet". The
// cause was the Jellyfin Webhook plugin's playback notifiers never firing (its IEventConsumer
// registrations, unlike its scheduled-task ones); Jellyfin itself was fine — the Playback Reporting
// plugin logged the very same session. The fix made the /Sessions POLL the source of truth.
//
// Which moves the risk: the feature now depends on parsing a payload correctly rather than on
// receiving one. So the parse is pure, and it is tested HERE against real payload shapes — no
// Jellyfin, no network, and crucially no reporting of fake playback, which would pollute Brennan's
// watch history and Playback Reporting stats to prove a point.
//
// EVERY FIELD NAME BELOW WAS READ OFF THE LIVE SERVER on 2026-08-12 while "One Battle After Another"
// was playing on Jellyfin Web. They are not guesses at Jellyfin's API.
const { playingFromSessions } = require('../controller/lib/movie-mode');

let pass = 0; let fail = 0;
const ok = (cond, why) => { if (cond) { pass++; return; } fail++; console.log(`FAIL  ${why}`); };
const T = 1786000000000;

// The exact shape observed live: a movie on Jellyfin Web, unpaused.
const WEB_MOVIE = {
  Id: 'sess-abc', DeviceId: 'dev-web-1', Client: 'Jellyfin Web', DeviceName: 'Chrome',
  UserName: 'brennan',
  PlayState: { IsPaused: false, PositionTicks: 12345 },
  NowPlayingItem: { Name: 'One Battle After Another', Type: 'Movie', RunTimeTicks: 1e10 },
};

// ── the case the whole fix exists for ────────────────────────────────────────────────────────
{
  const t = playingFromSessions([WEB_MOVIE], T);
  ok(t.size === 1, 'a playing movie produces exactly one row');
  const r = t.get('dev-web-1');
  ok(!!r, 'keyed by DeviceId — the SAME key the webhook uses, so the two sources cannot double-count');
  ok(r.title === 'One Battle After Another', 'title comes from NowPlayingItem.Name');
  ok(r.client === 'Jellyfin Web', 'client comes from Client');
  ok(r.user === 'brennan', 'user comes from UserName');
  ok(r.paused === false, 'paused reads PlayState.IsPaused');
  ok(r.ts === T, 'stamped with the poll time so pruneStale stays a backstop');
}

// ── what must NOT arm the latch ──────────────────────────────────────────────────────────────
ok(playingFromSessions([{ Id: 's', DeviceId: 'd', Client: 'Jellyfin Web' }], T).size === 0,
  'an IDLE client (no NowPlayingItem) is not playback — this is most of /Sessions most of the time');
ok(playingFromSessions([{ DeviceId: 'd', NowPlayingItem: { Name: 'Kind of Blue', Type: 'Audio' } }], T).size === 0,
  'music does not quiet the box');
ok(playingFromSessions([{ DeviceId: 'd', NowPlayingItem: { Name: 'A photo', Type: 'Photo' } }], T).size === 0,
  'photos do not quiet the box');
ok(playingFromSessions([{ DeviceId: 'd', NowPlayingItem: { Name: 'BBC One', Type: 'TvChannel' } }], T).size === 0,
  'a Live TV stream is not ours to protect');
ok(playingFromSessions([], T).size === 0, 'an empty session list means nothing is playing');
ok(playingFromSessions(null, T).size === 0, 'null payload yields nothing, not a throw');
ok(playingFromSessions(undefined, T).size === 0, 'undefined payload yields nothing');
ok(playingFromSessions('not an array', T).size === 0, 'a non-array payload yields nothing');
ok(playingFromSessions([null, undefined], T).size === 0, 'null entries are skipped, not thrown on');

// ── what MUST arm it ─────────────────────────────────────────────────────────────────────────
for (const type of ['Movie', 'Episode', 'Video', 'MusicVideo']) {
  ok(playingFromSessions([{ DeviceId: 'd', NowPlayingItem: { Name: 'x', Type: type } }], T).size === 1,
    `${type} quiets the box`);
}
// An ABSENT type is accepted, matching the webhook handler's rule: an unrecognised payload must not
// silently ignore real playback. This is the fail-OPEN direction and it is deliberate.
ok(playingFromSessions([{ DeviceId: 'd', NowPlayingItem: { Name: 'x' } }], T).size === 1,
  'a missing item Type is accepted rather than ignored');

// A PAUSED film still holds the latch — the viewer is mid-film and about to resume, and thrashing the
// disk during a bathroom break is exactly what Movie Mode exists to prevent.
{
  const t = playingFromSessions([{ ...WEB_MOVIE, PlayState: { IsPaused: true } }], T);
  ok(t.size === 1, 'a PAUSED film still counts as playing');
  ok(t.get('dev-web-1').paused === true, 'and is reported as paused');
}
ok(playingFromSessions([{ DeviceId: 'd', NowPlayingItem: { Name: 'x', Type: 'Movie' } }], T)
  .get('d').paused === false, 'a missing PlayState is not "paused"');

// ── episodes get a readable title ────────────────────────────────────────────────────────────
{
  const t = playingFromSessions([{
    DeviceId: 'firetv', Client: 'Movie Night', UserName: 'brennan',
    NowPlayingItem: { Name: 'Exodus (2)', Type: 'Episode', SeriesName: 'Lost', ParentIndexNumber: 1, IndexNumber: 24 },
  }], T);
  ok(t.get('firetv').title === 'Lost S1E24', `episode title is Series SxxEyy: got "${t.get('firetv').title}"`);
}
ok(playingFromSessions([{ DeviceId: 'd', NowPlayingItem: { Name: 'Pilot', Type: 'Episode', SeriesName: 'Lost' } }], T)
  .get('d').title === 'Pilot', 'an episode with no IndexNumber falls back to its own Name');
ok(playingFromSessions([{ DeviceId: 'd', NowPlayingItem: { Type: 'Movie' } }], T).get('d').title === 'something',
  'a nameless item still produces a row rather than being dropped');

// ── identity edge cases ──────────────────────────────────────────────────────────────────────
ok(playingFromSessions([{ Id: 'sess-only', NowPlayingItem: { Name: 'x', Type: 'Movie' } }], T).has('sess-only'),
  'falls back to session Id when DeviceId is absent');
ok(playingFromSessions([{ NowPlayingItem: { Name: 'x', Type: 'Movie' } }], T).has('unknown'),
  'falls back to "unknown" rather than dropping playback with no identifier');
// TWO SESSIONS ON ONE DEVICE collapse to one row. Jellyfin routinely lists a stale session alongside
// the live one after a client reconnects; keyed per-device they cannot both count, which is what keeps
// describe() from reporting "X +1 more" to a single viewer.
{
  const t = playingFromSessions([
    { Id: 'old', DeviceId: 'dev-web-1', NowPlayingItem: { Name: 'Film A', Type: 'Movie' } },
    { Id: 'new', DeviceId: 'dev-web-1', NowPlayingItem: { Name: 'Film B', Type: 'Movie' } },
  ], T);
  ok(t.size === 1, 'two sessions on ONE device collapse to a single row');
  ok(t.get('dev-web-1').title === 'Film B', 'the later entry wins');
}
// Genuinely separate viewers must both count — the latch is held until the LAST one stops.
{
  const t = playingFromSessions([
    { DeviceId: 'firetv', NowPlayingItem: { Name: 'Film A', Type: 'Movie' } },
    { DeviceId: 'iphone', NowPlayingItem: { Name: 'Film B', Type: 'Movie' } },
    { DeviceId: 'idle-ps4' },
  ], T);
  ok(t.size === 2, 'two real viewers produce two rows and the idle client produces none');
}

// ── the mixed real-world payload ─────────────────────────────────────────────────────────────
// What /Sessions actually looks like on this box: several idle clients, one film, some music.
{
  const t = playingFromSessions([
    { DeviceId: 'idle-1', Client: 'Jellyfin Web' },
    { DeviceId: 'idle-2', Client: 'Movie Night' },
    WEB_MOVIE,
    { DeviceId: 'sonos', NowPlayingItem: { Name: 'Blue Train', Type: 'Audio' } },
    { DeviceId: 'idle-3', Client: 'Jellyfin iOS' },
  ], T);
  ok(t.size === 1, 'one film among idle clients and music yields exactly one row');
  ok(t.has('dev-web-1'), 'and it is the film');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
