'use strict';
// SUBTITLE GUARD — makes subtitles self-healing.
//
// THE BUG THIS EXISTS FOR (2026-09-13/14). Brennan sat down to watch *In the Mood for Love*, a
// Cantonese film, and it had no subtitles. Bazarr had never searched for it, and never would have:
// its `table_movies_subtitles` held a row claiming an EMBEDDED English track at index 2. That track
// does not exist — ffprobe sees only h264 video and aac audio, and Bazarr's OWN cached probe agrees
// there are zero subtitle streams. The row was simply never reconciled when the file was replaced.
// Because Bazarr believed a subtitle was present, `missing_subtitles` was empty, so every scheduled
// search correctly skipped the film. Silent, and permanent: `scan-disk` does not clear those rows
// (verified, 140s of waiting). An audit found 11 films in this state, 10 of them with no subtitles
// at all — several foreign-language.
//
// THE FIX IS TO STOP ASKING BAZARR WHAT IT BELIEVES. This job takes its ground truth from the
// FILE, via Jellyfin's probe of every item, and then drives Bazarr's MANUAL search endpoint, which
// does not consult `missing_subtitles` at all. So a stale row — or any other corruption of Bazarr's
// derived state — cannot suppress a download again. That is the whole point: the system heals
// regardless of what state Bazarr is in.
//
// Owns: subtitleGuardBusy. Timers: startSubtitleGuardTimer() → every 6h.
//
// SAFETY. This job only ever ADDS a subtitle sidecar next to a media file. It never deletes or
// modifies a media file, never deletes a subtitle, never touches Radarr/Sonarr, never triggers a
// grab or a search for VIDEO, and never writes to Bazarr's database. Per-run work is capped and
// failures back off, so a provider outage cannot turn into a hammering loop.

const fs = require('fs');
const path = require('path');
const app = require('./app');
const { cfg, HOST } = require('./config');
const { tfetch, tfetchJson } = require('./clients');
const { jellyfinUserId } = require('./jellyfin');
const { isMasterPaused } = require('./state');
const jobs = require('./jobs');

// Languages that count as "we have subtitles". Jellyfin reports ISO 639-2/B mostly.
const WANT = new Set(['eng', 'en', 'english']);
// Per-run ceiling. A download costs a provider request plus an ffsubsync pass (~1-4 min, and Bazarr
// serialises them), so a big backlog is drained over several runs rather than in one burst.
const MAX_PER_RUN = Number(cfg.SUBTITLE_GUARD_MAX || 12);
const STATE_FILE = '/config/subtitle-guard.json';
// After this many consecutive failures an item is only retried occasionally — some films genuinely
// have no subtitle anywhere, and retrying them every 6h forever is just noise against the providers.
const BACKOFF = [0, 6 * 3600e3, 24 * 3600e3, 7 * 86400e3, 30 * 86400e3];

let subtitleGuardBusy = false;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { console.log(`subtitleGuard: state write failed — ${e.message}`); }
}
const baseName = (p) => String(p || '').split('/').pop();

// An item needs help when nothing on disk gives it an English subtitle. Both embedded and external
// count — we are asking "can Brennan turn subtitles on", not "does a .srt exist".
function needsSubtitles(item) {
  const streams = [];
  for (const ms of item.MediaSources || []) for (const s of ms.MediaStreams || []) {
    if (s.Type === 'Subtitle') streams.push(s);
  }
  if (!streams.length) return true;
  return !streams.some((s) => WANT.has(String(s.Language || '').toLowerCase()));
}

async function bazarr(pathname, opts = {}, timeout = 120000) {
  const key = cfg.BAZARR_KEY;
  if (!key) return null;
  const headers = Object.assign({ 'X-API-KEY': key }, opts.headers || {});
  return tfetch(`${HOST.bazarr}${pathname}`, Object.assign({}, opts, { headers }), timeout);
}
async function bazarrJson(pathname, timeout = 120000) {
  const key = cfg.BAZARR_KEY;
  if (!key) return null;
  return tfetchJson(`${HOST.bazarr}${pathname}`, { headers: { 'X-API-KEY': key } }, timeout).catch(() => null);
}

// Pick the best candidate. A `hash` match means the provider matched our exact FILE, so the timing
// is right by construction — that beats any score. Otherwise take the highest score.
function bestCandidate(list) {
  let best = null;
  for (const c of list || []) {
    const hash = (c.matches || []).includes('hash');
    const rank = [hash ? 1 : 0, Number(c.score) || 0];
    if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1])) {
      best = { c, rank };
    }
  }
  return best && best.c;
}

async function downloadFor(kind, id, cand, seriesId) {
  // The EPISODE endpoint requires `seriesid` as well as `episodeid` — without it Bazarr answers
  // 400 "Series ID Missing required parameter", which is how the first run downloaded all 3 films
  // and failed all 9 episodes. The movie endpoint takes `radarrid` alone.
  const params = {
    language: 'en', hi: 'False', forced: 'False', original_format: 'False',
    provider: cand.provider, subtitle: cand.subtitle,
  };
  if (kind === 'movie') params.radarrid = String(id);
  else { params.episodeid = String(id); params.seriesid = String(seriesId); }
  const body = new URLSearchParams(params).toString();
  const r = await bazarr(kind === 'movie' ? '/api/providers/movies' : '/api/providers/episodes', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  }, 300000);
  return !!(r && (r.ok || r.status === 204));
}

async function subtitleGuardSweep() {
  if (subtitleGuardBusy) return;
  if (isMasterPaused()) { console.log('subtitleGuard: skipped — master paused'); return; }
  if (!cfg.BAZARR_KEY) { console.log('subtitleGuard: skipped — no BAZARR_KEY'); return; }
  subtitleGuardBusy = true;
  const state = loadState();
  const now = Date.now();
  try {
    const uid = await jellyfinUserId();
    const h = { Authorization: `MediaBrowser Token="${cfg.JELLYFIN_KEY}"` };

    // GROUND TRUTH: Jellyfin has probed every file already, so this is one query rather than 1,000
    // ffprobe runs. MediaSources carries the subtitle streams, embedded and external alike.
    // Fetched separately and defensively: the Episode payload is ~2,600 items with full
    // MediaSources, and one bad response must not take the whole sweep down with it.
    const q = 'Recursive=true&Fields=Path,MediaSources&Limit=100000&IncludeItemTypes=';
    const jf = async (type) => {
      const r = await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${q}${type}`, { headers: h }, 300000)
        .catch((e) => { console.log(`subtitleGuard: ${type} query failed — ${e.message || e}`); return null; });
      return (r && r.Items) || [];
    };
    const movies = await jf('Movie');
    const episodes = await jf('Episode');
    if (!movies.length && !episodes.length) { console.log('subtitleGuard: no items returned — skipping'); return; }

    // Bazarr's side is used ONLY to turn a file path into the id its API wants. Its beliefs about
    // what subtitles exist are deliberately ignored — that belief is what broke.
    const bMovies = ((await bazarrJson('/api/movies')) || {}).data || [];
    const byPathMovie = new Map(bMovies.map((m) => [baseName(m.path), m]));

    const series = ((await bazarrJson('/api/series')) || {}).data || [];
    const byPathEp = new Map();
    for (let i = 0; i < series.length; i += 20) {
      const qs = series.slice(i, i + 20).map((s) => `seriesid[]=${s.sonarrSeriesId}`).join('&');
      const eps = ((await bazarrJson(`/api/episodes?${qs}`)) || {}).data || [];
      for (const e of eps) byPathEp.set(baseName(e.path), e);
    }

    const work = [];
    for (const it of movies) {
      if (!needsSubtitles(it)) continue;
      const b = byPathMovie.get(baseName(it.Path));
      if (b) work.push({ kind: 'movie', id: b.radarrId, name: it.Name, jf: it.Id });
    }
    for (const it of episodes) {
      if (!needsSubtitles(it)) continue;
      const b = byPathEp.get(baseName(it.Path));
      if (b) work.push({ kind: 'episode', id: b.sonarrEpisodeId, seriesId: b.sonarrSeriesId, name: `${it.SeriesName} ${it.Name}`, jf: it.Id });
    }

    // Respect the backoff so a title with no subtitle anywhere is not retried every run.
    const due = work.filter((w) => {
      const st = state[w.jf];
      if (!st) return true;
      const wait = BACKOFF[Math.min(st.fails || 0, BACKOFF.length - 1)];
      return now - (st.last || 0) >= wait;
    });

    let got = 0, missed = 0;
    for (const w of due.slice(0, MAX_PER_RUN)) {
      const ep = w.kind === 'movie' ? `/api/providers/movies?radarrid=${w.id}&language=en`
        : `/api/providers/episodes?episodeid=${w.id}&language=en`;
      const cands = ((await bazarrJson(ep, 240000)) || {}).data || [];
      const pick = bestCandidate(cands);
      const st = state[w.jf] || { fails: 0 };
      st.last = Date.now();
      st.name = w.name;
      if (!pick) {
        st.fails = (st.fails || 0) + 1; st.why = 'no candidates';
        state[w.jf] = st; missed++;
        continue;
      }
      const ok = await downloadFor(w.kind, w.id, pick, w.seriesId);
      if (ok) { st.fails = 0; st.why = `downloaded ${pick.provider} score=${pick.score}`; got++; }
      else { st.fails = (st.fails || 0) + 1; st.why = 'download failed'; missed++; }
      state[w.jf] = st;
      // Bazarr runs ffsubsync on each download and serialises them; give it room.
      await new Promise((r) => setTimeout(r, 4000));
    }
    saveState(state);
    console.log(`subtitleGuard: ${work.length} item(s) without an English subtitle, `
      + `${due.length} due, ${got} downloaded, ${missed} failed`
      + (due.length > MAX_PER_RUN ? ` (capped at ${MAX_PER_RUN}/run, rest next pass)` : ''));
  } catch (e) {
    console.log(`subtitleGuard: failed — ${e.message || e}`);
  } finally { subtitleGuardBusy = false; }
}

const tracked = jobs.define({
  id: 'subtitle-guard', name: 'Subtitle guard', group: 'Metadata', weight: 58,
  what: 'Finds media with no English subtitle and fetches one',
  every: 6 * 3600000, scheduleText: 'every 6h · and on boot', pausedByMovieMode: true,
}, subtitleGuardSweep);

function startSubtitleGuardTimer() {
  setInterval(tracked, 6 * 3600000);
}

// Exposed so the audit script and the Jobs tab can show what the guard is holding back on.
app.get('/api/subtitle-guard', (req, res) => {
  try { res.json(loadState()); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

module.exports = { subtitleGuardSweep: tracked, startSubtitleGuardTimer, needsSubtitles };
