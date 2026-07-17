'use strict';
// The unified Downloads snapshot: merges qBittorrent torrents with *arr
// queue/history/library state, the Bazarr-subtitles and Jellyfin-probe
// readiness gates, missing/unreleased-item surfacing, and the batch summary.
// Owns: the precomputed _dl snapshot (read via getDl()), knownInLibrary,
// download-transition metric dedup, and the ETA smoothing state. Registers
// GET /api/downloads. Timers: startDownloadsLoop() → refresh every 5s (first
// at 1.5s).

const app = require('./app');
const metrics = require('../metrics');
const { cfg, HOST } = require('./config');
const { tfetch, qbit, arrGet } = require('./clients');
const { _cache, cachedFetch } = require('./cache');
const { jellyfinUserId, jellyfinIdByTmdb, jellyfinSearchId } = require('./jellyfin');
const {
  getQbitTorrents, getQueueMap, getHistoryIndex, getHasFileMap, torrentApp,
  arrOwns, resetParseBudget, getIndexerSnapshot,
} = require('./arr-data');
const {
  declined, blocked, searchState, gpuPending, importState, forceGrabImport,
  completedForceGrabs, isMasterPaused,
} = require('./state');
const {
  SEARCH_COOLDOWN_MS, RECOVERY_GRACE_MS, NOTFOUND_GRACE_MS, RECENT_RELEASE_GRACE_MS,
  noteMissing, noteResolved, isRecentRelease, shortReason, clampHint,
} = require('./search-engine');
const { _stallSince, STALL_DEAD } = require('./stall-recovery');
const { triggerJellyfinScan } = require('./jf-scan');

// Downloads — qBittorrent torrents (live progress) merged with *arr queue extras.
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
function parseTimeleft(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return (+(m[1] || 0)) * 86400 + (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4]);
}
function friendlyTorrentState(t) {
  const s = t.state || '';
  if (s === 'error' || s === 'missingFiles') return 'Error';
  // Completion is checked BEFORE paused/stopped: our share limits (ratio 2.0 / 7 days, act=stop)
  // auto-STOP a torrent the moment it's done seeding, landing it in stoppedUP/pausedUP. That's a
  // finished download, not a user pause — treat it as complete so it doesn't masquerade as "Paused"
  // at 100%. A genuine user pause is on an INCOMPLETE torrent, handled below.
  if ((t.progress || 0) >= 1) return 'Seeding';
  if (s.startsWith('paused') || s.startsWith('stopped')) return 'Paused';   // qBittorrent v5 renamed paused* → stopped*
  if (s === 'metaDL' || s.startsWith('checking')) return 'Starting';
  if (s.startsWith('queued')) return 'Queued';
  if (s.startsWith('stalled')) return 'Stalled';
  return 'Downloading';
}
// ---- Pipeline correlation: qBittorrent + *arr queue + *arr library (hasFile) ----
// The AUTHORITY for "it's in the library and playable" is Radarr/Sonarr's own hasFile —
// not a filesystem guess. So the bar can never say "ready" before the app actually has
// the file, and never falsely flags an imported title.
// ── Bazarr: subtitle-acquisition gate ──
// A freshly-imported title is in the library, but Bazarr is still off fetching subs for it.
// We hold the Downloads row at "Getting subtitles" (yellow, not clickable) until Bazarr has
// them, so it doesn't go green/playable early.
async function bazarrGet(p, ms = 6000) {
  const r = await tfetch(`${HOST.bazarr}${p}`, { headers: { 'X-Api-Key': cfg.BAZARR_KEY || '' } }, ms);
  if (!r.ok) throw new Error(`bazarr HTTP ${r.status}`);
  return r.json();
}
// True once Bazarr has the title's subtitles — or once we've waited long enough that we stop
// holding the row (subs may simply be unavailable for an obscure release). Fails OPEN (returns
// true) whenever Bazarr isn't provisioned/reachable or we can't pin the *arr id, so subtitles
// never wedge a download permanently at "Getting subtitles".
const SUBS_GRACE = 1800; // s — max time to hold a freshly-imported title waiting on subs
async function subsReady(app, id, completionOn) {
  if (!cfg.BAZARR_KEY || id == null) return true;                       // can't gate → don't
  if (completionOn && Math.floor(Date.now() / 1000) - completionOn > SUBS_GRACE) return true;
  try {
    if (app === 'radarr') {
      const m = ((await bazarrGet(`/api/movies?radarrid[]=${id}`)).data || [])[0];
      if (!m) return false;                                             // Bazarr hasn't synced it yet
      return (m.missing_subtitles || []).length === 0;                  // every wanted language present
    }
    // sonarr: ready once no episode of the series is still wanting subtitles
    const wanted = (await bazarrGet('/api/episodes/wanted?start=0&length=-1')).data || [];
    return !wanted.some((r) => r.sonarrSeriesId === id);
  } catch { return true; }                                              // Bazarr down → fail open
}

// ── Jellyfin: scan-and-probe gate ──
// *arr reporting hasFile means the file is in the library FOLDER — but Jellyfin still has to
// scan that folder and ffprobe each file before a playable MediaSource exists. In that window
// the episode/movie ITEM exists (so it shows in Jellyfin) but tapping Watch errors with
// "Unable to find a valid media source to play". So we hold the Downloads row at "Processing"
// until Jellyfin has actually probed the title (RunTimeTicks populated). Fails OPEN (returns
// true) whenever we can't resolve the item or Jellyfin is unreachable, and lapses after
// JF_GRACE, so a probe that never registers can never wedge a row permanently.
const JF_GRACE = 1800; // s — max time to hold a freshly-imported title at "Processing"
async function jellyfinReady(app, arrId, completionOn) {
  if (!cfg.JELLYFIN_KEY || arrId == null) return true;                 // can't gate → don't
  if (completionOn && Math.floor(Date.now() / 1000) - completionOn > JF_GRACE) return true;
  try {
    const type = app === 'sonarr' ? 'Series' : 'Movie';
    const arrItem = await arrGet(app, app === 'radarr' ? `/movie/${arrId}` : `/series/${arrId}`);
    // Resolve the Jellyfin item: pin on TMDB id, else fall back to a title search.
    let itemId = await jellyfinIdByTmdb(type, arrItem.tmdbId);
    if (!itemId) itemId = await jellyfinSearchId(arrItem.title, type);
    if (!itemId) return false;                                         // Jellyfin hasn't created it yet
    const uid = await jellyfinUserId();
    const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };
    if (app === 'radarr') {                                            // movie: the item itself carries the runtime once probed
      const it = await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items/${itemId}`, { headers: h }, 6000)).json();
      return (it.RunTimeTicks || 0) > 0;
    }
    // sonarr: every imported episode must be present AND probed — a half-scanned season would
    // otherwise go green while its later episodes still error on Watch.
    const expected = ((arrItem.statistics || {}).episodeFileCount) || 0;
    const q = new URLSearchParams({ parentId: itemId, recursive: 'true', includeItemTypes: 'Episode', fields: 'RunTimeTicks', limit: '2000' });
    const eps = ((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 8000)).json()).Items) || [];
    const allProbed = eps.length > 0 && eps.every((e) => (e.RunTimeTicks || 0) > 0);
    return expected > 0 ? (eps.length >= expected && allProbed) : allProbed;
  } catch { return true; }                                            // Jellyfin hiccup → fail open
}

const knownInLibrary = new Set(); // torrent hash -> tracked for event-driven scan
const _knownDownloads = new Map(); // hash -> { title, app, prog, imported, ts } — download transition tracking for metrics
const _emittedEvents = new Set();  // `${event}:${hash}` dedup for metrics events

// A torrent qBittorrent has flagged as broken — typically after an unclean shutdown (power
// loss), when on recheck its files don't line up with its resume data. It reports progress 0
// even though the real media is usually still on disk (and often already imported by *arr).
const isErrored = (t) => { const s = t.state || ''; return s === 'error' || s === 'missingFiles'; };

// Resolve a torrent that *arr has already imported to its user-facing "in the library" state,
// gating green on Bazarr subs + a Jellyfin probe (so Watch never errors). Shared by the normal
// completed path and the self-heal path for errored-but-imported torrents.
async function resolveLibraryState(app, hi, t) {
  const h = (t.hash || '').toLowerCase();
  if (!knownInLibrary.has(h)) { knownInLibrary.add(h); triggerJellyfinScan(); }
  if (!(await subsReady(app, hi && hi.id, t.completion_on))) return 'Getting subtitles';
  if (!(await jellyfinReady(app, hi && hi.id, t.completion_on))) return 'Processing';
  return 'Ready';
}

// Is this queue item for an episode/movie whose release/air date hasn't arrived yet?
// When true, a stuck/failed import isn't a real error — it's a premature grab of a
// future release. The UI shows it as "Unreleased" (grey, queued-like) instead of red.
function isFutureRelease(app, qrec) {
  if (!qrec) return false;
  const now = Date.now();
  if (app === 'sonarr') {
    const airDate = qrec.episode && (qrec.episode.airDateUtc || qrec.episode.airDate);
    if (airDate) return new Date(airDate).getTime() > now;
  }
  if (app === 'radarr') {
    const movie = qrec.movie;
    if (movie) {
      const dates = [movie.inCinemas, movie.physicalRelease, movie.digitalRelease].filter(Boolean);
      for (const d of dates) {
        if (new Date(d).getTime() > now + 86400000) return true;
      }
    }
  }
  return false;
}

async function buildDownloads() {
  const now = Math.floor(Date.now() / 1000), DAY = 86400;
  resetParseBudget(12);                          // cap cold /parse round-trips this pass (backlog warms over the next few)
  const torrents = await getQbitTorrents();
  const queues = { radarr: await getQueueMap('radarr'), sonarr: await getQueueMap('sonarr') };
  let indexerSnapshot = { degradedNames: [] };
  try {
    indexerSnapshot = await cachedFetch('indexers:snapshot', 60000, getIndexerSnapshot, { degradedNames: [] });
  } catch { /* best-effort */ }
  // History (imported flag + indexer-reported size) and library hasFile, for whichever apps own a
  // torrent. Both are 20s-cached, so fetching unconditionally is cheap — we need them to size queued
  // torrents (real progress bar) and to classify idle/errored ones against the library.
  const hist = {}, hasFile = {}, nameIds = {};
  for (const app of new Set(torrents.map(torrentApp).filter(Boolean))) {
    hist[app] = await getHistoryIndex(app);
    const lib = await getHasFileMap(app);
    hasFile[app] = lib.hasFile;
    nameIds[app] = lib.nameIds;
  }

  const items = [];
  // arrIds that already have a torrent-derived row (downloading/importing/seeding/etc.). The
  // missing-item surfacing below skips these so a title can't appear BOTH as its live download AND
  // as a phantom "Searching…/Not found" row (e.g. a season pack downloading before Sonarr queues it).
  const shownIds = { radarr: new Set(), sonarr: new Set() };
  // Collapse duplicate COMPLETED rows for the same MOVIE (e.g. an old orphaned torrent still seeding
  // after an upgrade/redownload + the current library copy) — keep the most-recently-completed. Movies
  // only: a Sonarr series legitimately has many completed torrents (one per season/episode).
  const completedByMovie = new Map();   // "radarr:movieId" -> { completion, item }
  for (const t of torrents) {
    const h = (t.hash || '').toLowerCase();
    const app = torrentApp(t);
    const prog = Math.round((t.progress || 0) * 100);
    const eta = (t.eta && t.eta < 8640000) ? t.eta : null;
    const qrec = app ? queues[app].get(h) : null;
    // Ground truth, independent of qBittorrent's (post-crash) progress/state: has *arr actually
    // imported this release into the library?
    let hi = app && hist[app] && hist[app].get(h);
    // Force-grabs import via a downloadId-less ManualImport, so *arr history isn't keyed to this
    // hash and `hi` stays null. Once the watchdog confirms every episode landed it records the
    // series in completedForceGrabs — synthesize the history entry so the row resolves to Ready
    // (and never falls into the recover/"Importing"-forever path below).
    if (!hi && app === 'sonarr' && completedForceGrabs.has(h)) hi = { id: completedForceGrabs.get(h).id, imported: true, size: 0 };
    // Has *arr actually imported THIS torrent? `hi.imported` is per-downloadId (an import event
    // referenced this exact hash) and is authoritative for both apps. The hasFile fallback (for a
    // cold history cache after restart) is RADARR-ONLY: a movie's hasFile is 1:1 with its torrent,
    // but a Sonarr series' hasFile is true if it holds ANY episode — so using it here flagged every
    // still-downloading episode of a partially-present series as "imported → Ready", hiding the
    // live download from the UI. For Sonarr we trust the per-hash import event alone.
    const imported = !!(hi && (hi.imported || (app === 'radarr' && hi.id != null && hasFile[app] && hasFile[app].get(hi.id) === true)));
    const _arrId = (qrec && (qrec.movieId || qrec.seriesId)) ?? (hi && hi.id);
    let state, attention = false, recover = null, attnNote = null;
    if (app && imported) {
      // Already imported into the library = the download is DONE, no matter what the torrent is
      // doing now (errored after a crash, paused, or a zombie pointing at files *arr already
      // hardlinked/moved out). Trust the library, never the torrent — and never re-download
      // content we already have. resolveLibraryState still gates green on subs + a Jellyfin probe.
      state = await resolveLibraryState(app, hi, t);
    } else if (isErrored(t) && app) {
      // Errored AND not in the library via history (hi=null = cold cache after restart, or
      // history window too small). Try a title match as fallback before flagging — the media
      // is often still on disk and already imported by *arr (qBittorrent just lost its resume
      // data after a crash/recheck). Only if the *arr library also has no file for this title
      // do we flag for human attention.
      const owned = !hi ? await arrOwns(app, t.name, hasFile[app], nameIds[app]) : null;
      if (owned) state = await resolveLibraryState(app, { id: owned.id, imported: true, size: 0 }, t);
      else if (app && isFutureRelease(app, qrec)) { state = 'Unreleased'; }
      else { state = 'Needs attention'; attention = true; }
    } else if (qrec) {                              // *arr is actively tracking it
      // *arr's queue exposes BOTH its own view (trackedDownloadState/Status) and the underlying
      // torrent (t.state). Surface real trouble from EITHER source — a stalled or errored
      // download that *arr still lists must never masquerade as "Downloading".
      const tds = (qrec.trackedDownloadState || '').toLowerCase();      // downloading|importPending|importing|imported|failedPending|failed
      const tdStatus = (qrec.trackedDownloadStatus || '').toLowerCase(); // ok|warning|error
      const ts = friendlyTorrentState(t);                               // Paused|Error|Seeding|Starting|Queued|Stalled|Downloading
      if (prog < 100 && ((qrec.status || '').toLowerCase() === 'paused' || ts === 'Paused')) state = 'Paused';
      else if (tds === 'failed' || tds === 'failedpending' || tdStatus === 'error') { if (isFutureRelease(app, qrec)) { state = 'Unreleased'; } else { state = 'Needs attention'; attention = true; } } // download/import failed in *arr
      else if (tds.includes('import')) {
        // *arr parked the import (e.g. importBlocked: "matched by ID — manual import required",
        // or a release for an unaired/nonexistent episode it can't match). Hand it to the recovery
        // sweep so it runs a Manual Import automatically. But DON'T let a genuinely-blocked import
        // masquerade as active "Importing" forever: a plain importPending resolves in seconds, so
        // only the first IMPORT_GRACE after completion is really "importing" — past that, a
        // still-warning item is stuck and gets surfaced for attention (amber, honest) rather than
        // looking like progress. tdStatus 'ok' importPending stays "Importing" regardless (*arr
        // just hasn't gotten to it yet).
        if (tdStatus === 'warning' && t.content_path) recover = { app, folder: t.content_path, id: app === 'radarr' ? qrec.movieId : qrec.seriesId, hash: h };
        const IMPORT_GRACE = 15 * 60;   // seconds a warning import may sit before we call it blocked
        const stuck = tdStatus === 'warning' && (t.completion_on || 0) > 0 && (now - t.completion_on) > IMPORT_GRACE;
        if (stuck) {
          if (isFutureRelease(app, qrec)) { state = 'Unreleased'; recover = null; }
          else { state = 'Needs attention'; attention = true; }
        }
        else state = 'Importing';
      }
      else if (prog < 100) state = (ts === 'Stalled' || ts === 'Queued' || ts === 'Starting') ? ts : 'Downloading'; // honour a real stall
      else state = 'Importing';                                         // complete in qbit, waiting on *arr to import
    } else if (prog < 100) {                        // still downloading, *arr not (yet) tracking
      state = friendlyTorrentState(t);
    } else if (app) {                               // complete, no longer in the *arr queue
      if (imported) {
        // *arr has the file, but "Ready" is the only clickable/playable state — so it must mean
        // *fully* ready: subtitles fetched AND Jellyfin has scanned+probed the file (else Watch
        // errors with "no valid media source"). resolveLibraryState kicks the scan and gates green.
        state = await resolveLibraryState(app, hi, t);
      } else {                                      // downloaded but *arr has NOT imported it
        // Authoritative check first: is the library already holding this release's content? (cold
        // history cache after restart / aged-out window would otherwise flag imported titles.)
        const owned = await arrOwns(app, t.name, hasFile[app], nameIds[app]);
        if (owned) state = await resolveLibraryState(app, { id: owned.id, imported: true, size: 0 }, t);
        else {
          // Fresh completions (≤1 day old) may still be picked up by the import watchdog →
          // keep them as "Importing". Older completions with no queue entry and no confirmed
          // import are almost certainly fine — the history window aged out the import event.
          if (forceGrabImport.has(h) || (t.category || '').toLowerCase() === 'sonarr-force') {
            // Force-grabs are owned EXCLUSIVELY by the watchdog pre-pass (importViaGrab, which knows
            // the user-chosen series). NEVER emit a recover for a sonarr-force torrent: the generic
            // recover runs importViaManual with no expectedId, and on an unparseable release its
            // "Unknown Series" branch DELETES the folder with deleteFiles:true — this is what wiped
            // Cosmos 1980. Gating on the CATEGORY (not just the hash map) keeps this safe even if the
            // bookkeeping entry is briefly missing (e.g. right after a restart, before recover runs).
            state = 'Importing';
          } else if ((t.completion_on || 0) > 0 && now - t.completion_on > DAY) {
            state = 'Likely imported';
          } else {
            recover = { app, folder: t.content_path, id: hi && hi.id, hash: h };
            const reason = (importState.get(t.content_path) || {}).reason;
            if (reason) { state = 'Needs attention'; attention = true; }
            else state = 'Importing';             // the watchdog will import it shortly
          }
        }
      }
    } else {
      state = 'Done';                               // a non-*arr torrent, just complete
    }
    const finished = state === 'Ready' || state === 'Done';
    const show = !finished || ((t.completion_on || 0) > 0 && now - t.completion_on <= DAY);
    // "Ready"/"Done" items always show full bar even if qBit reports 0% (missing files)
    const displayProg = (finished || state === 'Importing' || state === 'Needs attention' || state === 'Getting subtitles' || state === 'Processing') ? 100 : prog;
    if (show) {
      // Seed count is only meaningful once a torrent is actually talking to the swarm: while
      // 'Downloading' (explains progress/speed) or 'Stalled' (0 seeds explains the stall). A
      // 'Queued'/'Starting' torrent hasn't announced to the tracker yet, so its num_seeds is a
      // misleading 0 that isn't a true reflection of the release's availability — omit it there.
      const seeds = (state === 'Downloading' || state === 'Stalled') && typeof t.num_seeds === 'number' ? t.num_seeds : null;
      // "Stalled" mirrors stallRecovery's own give-up clock (STALL_DEAD after first seen at 0
      // seeds) so the UI can say when it'll blocklist-and-research instead of sitting silent.
      const stallGiveUpAt = state === 'Stalled' && _stallSince.has(h) ? (_stallSince.get(h) + STALL_DEAD) * 1000 : null;
      const item = { title: t.name, progress: displayProg, state, etaSeconds: state === 'Downloading' ? eta : null, sizeBytes: t.size || (hi && hi.size) || (qrec && qrec.size) || 0, source: app || 'torrent', attention, _recover: recover, hash: t.hash, seeds, stallGiveUpAt };
      // An auto-upgrade the user didn't request must explain itself in the UI.
      if (app === 'radarr' && qrec && qrec.movieId != null && gpuPending.has(qrec.movieId)) {
        item.note = 'Auto-upgrade: fetching a GPU-friendly copy — your current file stays watchable until this finishes';
      }
      if (attnNote) item.note = attnNote;
      if (finished && app === 'radarr' && _arrId != null) {
        const key = `radarr:${_arrId}`, comp = t.completion_on || 0, prev = completedByMovie.get(key);
        if (prev && comp <= prev.completion) continue;                 // older/equal duplicate of a movie we already show — drop it
        if (prev) { const i = items.indexOf(prev.item); if (i >= 0) items.splice(i, 1); }  // newer copy wins — remove the stale row
        completedByMovie.set(key, { completion: comp, item });
      }
      if (app && _arrId != null) shownIds[app].add(_arrId);   // this title has a live download → don't also list it as missing
      items.push(item);
    }
  }
  // Surface missing items: monitored, no file, no queue, no torrent — as warnings.
  // appIdsInQueue, norm, catTorNames, and beingFetched are defined at this scope so the
  // unreleased-episode surfacing below can reuse them without recomputing.
  const appIdsInQueue = { radarr: new Set(), sonarr: new Set() };
  for (const app of ['radarr', 'sonarr']) {
    if (!queues[app]) continue;
    for (const [, qrec] of queues[app]) {
      const id = qrec.movieId || qrec.seriesId;
      if (id != null) appIdsInQueue[app].add(id);
    }
  }
  // A JUST-grabbed torrent (redownload / fresh request) is in qBittorrent seconds before the
  // 20s-cached *arr queue/history links it to its item — so shownIds/queue miss it and the title
  // would show BOTH its download row AND a phantom "Searching…" row. Bridge that window by matching
  // the item's title+year against the raw torrent names of the same category.
  const norm = (s) => String(s || '').toLowerCase().replace(/[._'’:()\-]/g, ' ').replace(/\s+/g, ' ').trim();
  const catTorNames = { radarr: [], sonarr: [] };
  for (const t of torrents) { const a = torrentApp(t); if (a) catTorNames[a].push(norm(t.name)); }
  const beingFetched = (app, it) => {
    const tn = norm(it.title); if (!tn) return false;
    const yr = it.year ? String(it.year) : '';
    return catTorNames[app].some((n) => {
      if ((n === tn || n.startsWith(tn + ' ')) && (!yr || n.includes(yr))) return true;
      // Match title appearing anywhere as a word sequence (force-grabbed releases often
      // prepend the uploader name or add suffixes before the title, e.g. "Carl Sagans Cosmos 1980...")
      const idx = n.indexOf(tn);
      if (idx >= 0) {
        const before = idx === 0 || n[idx - 1] === ' ';
        const after = idx + tn.length >= n.length || n[idx + tn.length] === ' ';
        if (before && after && (!yr || n.includes(yr))) return true;
      }
      return false;
    });
  };
  try {
    for (const app of ['radarr', 'sonarr']) {
      let list = [];
      try { list = await arrGet(app, app === 'radarr' ? '/movie' : '/series', 8000); } catch { continue; }
      for (const it of list) {
        const id = it.id;
        const hasF = app === 'radarr' ? !!it.hasFile : !!(it.statistics && it.statistics.episodeCount > 0 && it.statistics.episodeFileCount >= it.statistics.episodeCount);
        if (hasF || it.monitored === false) { noteResolved(app, id); continue; }
        if (appIdsInQueue[app].has(id) || shownIds[app].has(id) || beingFetched(app, it)) { noteResolved(app, id); continue; }   // in queue / linked / freshly-grabbed torrent → not missing
        // Future release: movie hasn't been released yet → show Unreleased, don't mark missing.
        if (app === 'radarr') {
          const dates = [it.inCinemas, it.physicalRelease, it.digitalRelease].filter(Boolean);
          if (dates.length && dates.some(d => new Date(d).getTime() > Date.now() + 86400000)) {
            items.push({ title: it.title + (it.year ? ` (${it.year})` : ''), progress: 0, state: 'Unreleased', etaSeconds: null, sizeBytes: 0, source: app, attention: false, hash: `missing:${app}:${id}`, _id: id, recoveryNext: 0, recoveryFails: 0, recoveryBlocked: false });
            continue;
          }
        }
        // Recent release: movie came out in the last 14 days. Torrents may not exist yet, so use
        // shorter grace/cooldown and show a softer status (not alarming like "Not found").
        const recentRelease = app === 'radarr' && isRecentRelease(it);
        // A freshly-requested item briefly has no file/queue while *arr's own search resolves. Show
        // "Searching…" (not the alarming "Not found") until NOTFOUND_GRACE — this is what stops the
        // "Not found → found seconds later" flip-flop. Only after the grace do we call it "Not found".
        const firstMissing = noteMissing(app, id);
        const now2 = Date.now();
        const st = searchState.get(`${app}:${id}`) || {};
        const manualRetryAt = st.manualRetryAt || 0;
        const manualRetryRecent = manualRetryAt && now2 - manualRetryAt < 10 * 60 * 1000;
        const outcomeKind = st.lastOutcomeKind || '';
        const outcomeVisible = ['found', 'partial', 'pending'].includes(outcomeKind);
        const manualRetryVisible = manualRetryRecent && !['empty', 'error'].includes(outcomeKind);
        const uiGrace = recentRelease ? RECENT_RELEASE_GRACE_MS : NOTFOUND_GRACE_MS;
        const searching = manualRetryVisible || outcomeVisible || (!outcomeKind && now2 - firstMissing < uiGrace);
        const title = it.title + (it.year ? ` (${it.year})` : '');
        // Mirror arrSweep's own scheduling logic so the UI can say when the NEXT recovery search
        // will actually fire, instead of leaving "Not found" with no indication of what happens next.
        const searchHint = [];
        const dec = st.lastOutcomeDecision;
        if (st.lastSearchGap && st.lastSearchGap.best) {
          // Most actionable: a healthy release exists but structured search can't reach it.
          const g = st.lastSearchGap;
          const b = g.best;
          const shortTitle = String(b.title || '').replace(/ *\[.*?\]/g, '').replace(/ *\(.*?\)/g, '').trim().slice(0, 36);
          const why = g.reasonClass === 'no-season-marker' ? 'no S01 marker' : 'not a candidate';
          searchHint.push(clampHint(`"${shortTitle}" (${b.seeders} seeders) — ${why}`));
        } else if (dec && dec.rejectedCount && !dec.acceptedCount) {
          const reasons = String(dec.reasons || '').split(';').map(shortReason)
            .filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 2).join(', ');
          searchHint.push(`all ${dec.rejectedCount} rejected${reasons ? `: ${reasons}` : ''}`);
        } else if (st.lastOutcomeSummary) {
          searchHint.push(clampHint(st.lastOutcomeSummary));
        }
        if (st.lastOutcomeDetails && Array.isArray(st.lastOutcomeDetails.indexerErrors) && st.lastOutcomeDetails.indexerErrors.length) {
          const errs = st.lastOutcomeDetails.indexerErrors.slice(0, 2).map((e) => e.indexer).join(', ');
          if (errs) searchHint.push(`indexer error: ${errs}`);
        }
        if (!st.lastOutcomeSummary || outcomeKind === 'pending') {
          if (manualRetryRecent && !st.lastOutcomeSummary) searchHint.push('manual retry in progress');
          if (st.lastReason === 'blocked' && st.lastError) searchHint.push(`last search blocked: ${st.lastError}`);
          else if (st.lastReason === 'blocked') searchHint.push('last search blocked');
          else if (st.lastReason === 'grace') searchHint.push('waiting on the original search to settle');
          else if (st.lastReason === 'cooldown') searchHint.push('waiting for cooldown');
          else if (st.lastReason === 'manual_retry' && !st.lastOutcomeSummary) searchHint.push('manual retry in progress');
          else if (st.lastReason === 'no_searchable_episodes') searchHint.push('no aired episodes were searchable yet');
          else if (st.lastReason === 'trigger_failed' && st.lastError) searchHint.push(`search trigger failed: ${st.lastError}`);
        }
        if (!searchHint.length && indexerSnapshot.degradedNames && indexerSnapshot.degradedNames.length) {
          searchHint.push(`sources degraded: ${indexerSnapshot.degradedNames.slice(0, 2).join(', ')}`);
        }
        const recoveryBlocked = !!(st.blockedUntil && st.blockedUntil > now2);
        const recoveryGrace = recentRelease ? RECENT_RELEASE_GRACE_MS : RECOVERY_GRACE_MS;
        let recoveryNext;
        if (manualRetryRecent) recoveryNext = now2;
        else if (recoveryBlocked) recoveryNext = st.blockedUntil;
        else if (now2 - firstMissing < recoveryGrace) recoveryNext = firstMissing + recoveryGrace;
        else if (st.ts) recoveryNext = st.ts + SEARCH_COOLDOWN_MS;
        else recoveryNext = now2; // sweep hasn't tried yet — due on its next 5-min tick
        // attention (→ red) is reserved for items automation has actually given up on
        // (negative-cached). A "Not found" that's still going to retry on its own is orange, not
        // red — red should mean "a human needs to look at this," not "still working on it."
        items.push({ title, progress: 0, state: searching ? 'Searching…' : (recentRelease ? 'Not found (recent)' : 'Not found'),
          etaSeconds: null, sizeBytes: 0, source: app, attention: recoveryBlocked && !recentRelease,
          hash: `missing:${app}:${id}`, _id: id, recentRelease,
          recoveryNext, recoveryFails: st.fails || 0, recoveryBlocked,
          searchHint: searchHint.join(' · '), searchReason: outcomeKind || st.lastReason || null });
      }
    }
  } catch { /* missing scan best-effort */ }

  // Surface unreleased Sonarr episodes: monitored, no file, future air date, no torrent/queue.
  // Unlike the missing-items scan above (which checks series-level episodeFileCount), this checks
  // episode-level air dates so a series with past-season files still surfaces future episodes.
  // Uses Sonarr's /calendar endpoint (single call, upcoming-only) instead of per-series episode
  // fetches, cached for 5 min since air dates are slow-moving.
  try {
    const unreleased = await cachedFetch('sonarr:unreleased', 300000, async () => {
      const now = new Date();
      const start = now.toISOString().slice(0, 10);
      const end90 = new Date(now.getTime() + 90 * 86400000).toISOString().slice(0, 10);
      let eps;
      try { eps = await arrGet('sonarr', `/calendar?start=${start}&end=${end90}&includeSeries=true`, 8000); } catch { return []; }
      if (!Array.isArray(eps)) return [];
      // Build a series-id→title map from the calendar entries (no separate series list needed)
      const sidTitle = {};
      for (const e of eps) { if (e.series) sidTitle[e.seriesId] = e.series.title; }
      const seen = new Set(); // one row per series
      const out = [];
      for (const e of eps) {
        if (e.hasFile || !e.monitored) continue;
        if (!e.airDateUtc) continue;
        if (new Date(e.airDateUtc).getTime() <= now.getTime()) continue;
        const title = sidTitle[e.seriesId] || '';
        if (!title || seen.has(e.seriesId)) continue;
        seen.add(e.seriesId);
        out.push({ seriesId: e.seriesId, episodeId: e.id, title, seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber, airDateUtc: e.airDateUtc });
      }
      return out;
    }, []);
    for (const u of unreleased) {
      if (appIdsInQueue.sonarr.has(u.seriesId) || shownIds.sonarr.has(u.seriesId)) continue;

      const label = `${u.title} S${String(u.seasonNumber).padStart(2, '0')}E${String(u.episodeNumber).padStart(2, '0')}`;
      items.push({ title: label, progress: 0, state: 'Unreleased', etaSeconds: null, sizeBytes: 0, source: 'sonarr', attention: false, hash: `unreleased:sonarr:${u.seriesId}:${u.episodeId}` });
    }
  } catch (eu) { console.log('unreleased scan:', eu.message || eu); }

  // Sort tiers: any problem to the very top, then anything actively transferring (partial
  // progress, whatever its label), then the rest in progress, then recently-finished (Ready/Done
  // only ever survive the 24h `show` window above), and finally the long Queued backlog at the
  // bottom. Within a tier, the closer to done floats higher.
  const rank = (it) => {
    const s = it.state, p = it.progress || 0;
    if (s === 'Needs attention' || s === 'Error' || s === 'Not found') return 0;    // errors of any kind first
    if (p > 0 && p < 100) return 1;                            // mid-transfer → near the top regardless of status
    if (s === 'Queued' || s === 'Unreleased') return 4;        // backlog or waiting to air → bottom
    if (s === 'Ready' || s === 'Done') return 3;               // recently finished (≤ 24h)
    return 2;                                                  // everything else in progress (100% but not done: Importing/Processing/…)
  };
  items.sort((a, b) => rank(a) - rank(b) || (b.progress || 0) - (a.progress || 0));
  return items;
}

// Precomputed snapshot. The heavy work — qBittorrent + both *arr queues + history + library +
// the per-item Bazarr/Jellyfin gate checks — runs in ONE background loop, never inside a client
// request. So /api/downloads returns instantly from memory: a dashboard tab can't hang waiting on
// a busy NUC, requests can't pile up, and N open tabs cost the same as one. The snapshot keeps its
// last good value if a refresh fails, and `_dlRefreshing` guarantees refreshes never overlap (so a
// slow cycle under load self-throttles instead of stacking).
let _dl = { served: [], raw: [], summary: null, ts: 0 };
let _dlRefreshing = false;
// Smoothed max individual ETA from qBit — exponential moving average to dampen the
// short-window noise in per-torrent ETAs (a 2-seed torrent might momentarily blip from
// 30 min to 4h after a tracker timeout, then recover). 0.25 weight = 4-cycle (20s) half-life.
const _MAX_EMA_ALPHA = 0.25;
let _smoothedMaxDlEta = 0;
// The same for the per-poll speed — qBit's dl_info_speed is instantaneous and noisy.
let _smoothedSpeedEta = 0;
// Titles declined for disk space — the download-stage gate (`declined`, keyed by torrent
// hash) and the request-stage gate (`blocked`, keyed by app:id:seasons). Rendered as
// terminal red "Declined" rows. They join the snapshot BEFORE the summary is computed so
// the legend always counts exactly what the list shows (they used to be injected per-request
// afterwards, leaving the summary blind to them).
const asDeclinedRow = (hash, d) => ({ title: d.title, progress: 0, state: 'Declined', etaSeconds: null,
  sizeBytes: d.neededBytes, neededBytes: d.neededBytes, freeBytes: d.freeBytes, source: d.source || 'request', attention: false, hash });
async function refreshDownloads() {
  if (_dlRefreshing) return;
  _dlRefreshing = true;
  try {
    const raw = await buildDownloads();
    const served = raw.map(({ _recover, ...r }) => r);
    const now = Math.floor(Date.now() / 1000), DAY = 86400;
    for (const [h, d] of declined) if (now - d.ts <= DAY) served.unshift(asDeclinedRow(h, d));
    for (const [h, b] of blocked) if (now - b.ts <= DAY) served.unshift(asDeclinedRow(h, b));
    const summary = await downloadSummary(served);
    _dl = { served, raw, summary, ts: Date.now() };

    // Download transition events (grab / dl_done / import_ok)
    const nowSec = Date.now() / 1000;
    for (const it of raw) {
      if (!it.hash || !it.source) continue;
      const h = it.hash;
      const prev = _knownDownloads.get(h);
      const ek = (ev) => `${ev}:${h}`;
      if (prev) {
        if (it.progress >= 100 && (prev.prog == null || prev.prog < 100) && !_emittedEvents.has(ek('dl_done'))) {
          _emittedEvents.add(ek('dl_done'));
          metrics.emitEvent('dl_done', { ti: it.title, ap: it.source, dur: Math.round(nowSec - prev.ts) });
        }
        if ((it.state === 'Ready' || it.state === 'Done') && prev.state !== 'Ready' && prev.state !== 'Done' && !_emittedEvents.has(ek('import_ok'))) {
          _emittedEvents.add(ek('import_ok'));
          metrics.emitEvent('import_ok', { ti: it.title, ap: it.source });
        }
      } else if (it.state === 'Downloading' && !_emittedEvents.has(ek('grab'))) {
        _emittedEvents.add(ek('grab'));
        metrics.emitEvent('grab', { ti: it.title, ap: it.source, sB: it.sizeBytes || 0 });
      }
      _knownDownloads.set(h, { prog: it.progress, state: it.state, ts: prev ? prev.ts : nowSec, title: it.title, app: it.source });
    }
  } catch (e) { console.log('refreshDownloads failed (keeping last snapshot):', e.message || e); }
  finally { _dlRefreshing = false; }
}
// A mutation just changed qBittorrent/*arr state — drop the caches that would keep serving
// the pre-mutation view and rebuild the snapshot now, so the UI reflects the action on its
// next poll (~4s) instead of after cache TTL + snapshot loop + poll (~15s worst case).
function bustDownloadsCache() {
  delete _cache['qbit:torrents'];
  delete _cache['queue:radarr'];
  delete _cache['queue:sonarr'];
  setTimeout(refreshDownloads, 400);   // give the service a beat to register the change
}

app.get('/api/downloads', (_req, res) => {
  res.json({ items: _dl.served, summary: _dl.summary, ts: _dl.ts, masterPaused: isMasterPaused() });
});
// Batch ETA — "how long until this whole backlog is done?" Remaining bytes ÷ throughput.
// Wrinkles, all handled:
//  • Concurrency (qBittorrent runs ~3 at once): no special-casing needed — we divide by the
//    AGGREGATE speed (sum across all active torrents), so total wall-clock time is the same
//    however the queue is sliced, as long as it stays saturated (it is: 100+ queued).
//  • Speed stability: instantaneous aggregate speed is noisy, so we blend it with the SUSTAINED
//    throughput actually achieved by recently-completed torrents (bytes done ÷ wall-clock span).
//    That historic rate already reflects the real 3-at-a-time concurrency and disk/peer ceiling.
//  • Unknown sizes: queued torrents without metadata (size 0) are estimated at the average size
//    of the releases we do know, and we report how many are still being sized.
//  • Only states that actually consume bandwidth count toward remaining (Paused/Error/finished
//    are excluded from the in-progress + queued buckets below).
async function downloadSummary(items) {
  let liveSpeed = 0, torrents = [];
  try { const r = await qbit.fetch('/api/v2/transfer/info'); if (r.ok) liveSpeed = (await r.json()).dl_info_speed || 0; } catch { /* qbit down */ }
  try { torrents = await getQbitTorrents(); } catch { /* qbit down */ }

  // Sustained throughput from torrents completed in the last 6h: total bytes ÷ time since the
  // first of them finished. Needs a few data points to be meaningful, else we lean on live speed.
  const now = Math.floor(Date.now() / 1000), WINDOW = 6 * 3600;
  const doneRecently = torrents.filter((t) => t.completion_on > 0 && now - t.completion_on <= WINDOW && t.size > 0);
  let histSpeed = null;
  if (doneRecently.length >= 3) {
    const span = now - Math.min(...doneRecently.map((t) => t.completion_on));
    if (span > 120) histSpeed = doneRecently.reduce((a, t) => a + t.size, 0) / span;
  }
  // Blend: weight the stable historic rate, let live speed pull it toward current conditions.
  const speedBytes = Math.round((histSpeed && liveSpeed) ? histSpeed * 0.6 + liveSpeed * 0.4 : (histSpeed || liveSpeed));

  // Estimate the size of metadata-less queued torrents (size 0) from the average of EVERY release
  // we do have metadata for — completed, downloading, and queued alike — the broadest sample.
  const knownSized = items.filter((i) => i.sizeBytes > 0 && i.state !== 'Declined');
  const avgItemBytes = knownSized.length ? knownSized.reduce((a, i) => a + i.sizeBytes, 0) / knownSized.length : 0;
  const sizeOf = (i) => (i.sizeBytes > 0 ? i.sizeBytes : avgItemBytes);

  // Buckets for the visual bar mirror the row colors exactly, so the summary never shows a
  // different picture than the list underneath it: red = needs a human, blue = actively resolving
  // on its own (including subtitles/import/processing, not just live byte transfer), orange =
  // mid-recovery (stalled/retrying/paused), grey = plain pending, green = done.
  const DONE = new Set(['Ready', 'Done']);
  const BLUE_STATES = new Set(['Downloading', 'Importing', 'Getting subtitles', 'Processing']);
  const ORANGE_STATES = new Set(['Stalled', 'Not found', 'Paused']);
  const done = items.filter((i) => DONE.has(i.state));
  const attention = items.filter((i) => i.attention || i.state === 'Needs attention' || i.state === 'Error' || i.state === 'Declined');
  const inProg = items.filter((i) => BLUE_STATES.has(i.state) && !attention.includes(i));
  const blocked = items.filter((i) => ORANGE_STATES.has(i.state) && !attention.includes(i));
  const queued = items.filter((i) => !DONE.has(i.state) && !attention.includes(i) && !inProg.includes(i) && !blocked.includes(i));
  const sum = (arr) => Math.round(arr.reduce((a, i) => a + sizeOf(i), 0));
  const bytes = { completed: sum(done), inProgress: sum(inProg), queued: sum(queued), attention: sum(attention), blocked: sum(blocked) };

  // Remaining to download = the unfinished part of everything not done (downloading + all pending).
  const remainingBytes = Math.round([...inProg, ...queued].reduce((a, i) => a + sizeOf(i) * (1 - Math.min(100, i.progress || 0) / 100), 0));
  const sizing = [...queued, ...inProg].filter((i) => !(i.sizeBytes > 0)).length;   // still fetching metadata

  // Per-torrent ETAs from qBittorrent for actively downloading items.
  // These run in PARALLEL, so wall-clock time to finish the current batch is the MAX
  // of their individual ETAs — not total_remaining / total_speed (which assumes a
  // serial pipeline). Use the max as a floor so the summary never says "18 min left"
  // when a 1-seed torrent still has 4h to go.
  const dlEtas = inProg
    .filter((i) => i.state === 'Downloading' && i.etaSeconds != null && i.etaSeconds > 0)
    .map((i) => i.etaSeconds);
  // qBit's per-torrent ETA uses a short averaging window and can spike momentarily after
  // a tracker blip. EMA-smooth it so real trends still track but noise doesn't jitter the
  // summary. Let drops through instantly (torrent finished) but smooth upward spikes.
  const rawMaxDlEta = dlEtas.length > 0 ? Math.max(...dlEtas) : 0;
  if (rawMaxDlEta <= 0) _smoothedMaxDlEta = 0;
  else if (_smoothedMaxDlEta <= 0) _smoothedMaxDlEta = rawMaxDlEta;
  else if (rawMaxDlEta >= _smoothedMaxDlEta) _smoothedMaxDlEta = Math.round(rawMaxDlEta * _MAX_EMA_ALPHA + _smoothedMaxDlEta * (1 - _MAX_EMA_ALPHA));
  else _smoothedMaxDlEta = rawMaxDlEta; // drops pass through immediately (a torrent finished)
  const maxDlEta = _smoothedMaxDlEta;

  // Queue items can't fully overlap with the current batch — they wait for a free slot
  // and may have different (likely worse) peer characteristics. Add their estimated
  // serial time on top rather than absorbing them into the maxDlEta window, since
  // throughput after fast torrents finish and slow queued ones replace them is uncertain.
  const queuedRemaining = queued.reduce((a, i) => a + sizeOf(i) * (1 - Math.min(100, i.progress || 0) / 100), 0);
  const queueEta = speedBytes > 0 ? queuedRemaining / speedBytes : 0;
  const fastEta = speedBytes > 0 ? remainingBytes / speedBytes : 0;
  const slowEta = maxDlEta + queueEta;

  // Blend between them based on the gap. When the slowest torrent's ETA ≈ pipeline
  // (gap ≤ 1.5×), speeds are uniform and the pipeline is right (common — most torrents
  // in the same quality tier have similar peer counts). When the slowest is ≥ 5× the
  // pipeline, it's a clear parallel bottleneck and slowEta dominates. In between,
  // interpolate — the truth is somewhere on the continuum.
  let etaSeconds = null;
  if (speedBytes > 0 && remainingBytes > 0) {
    const gap = slowEta / Math.max(1, fastEta);
    if (gap <= 1.5) {
      etaSeconds = Math.round(fastEta);
    } else if (gap >= 5) {
      etaSeconds = Math.round(slowEta);
    } else {
      const t = (gap - 1.5) / (5 - 1.5);
      etaSeconds = Math.round(fastEta * (1 - t) + slowEta * t);
    }
  }

  return {
    counts: { completed: done.length, inProgress: inProg.length, queued: queued.length, attention: attention.length, blocked: blocked.length },
    bytes,
    remainingBytes,
    speedBytes,
    liveSpeedBytes: liveSpeed,
    histSpeedBytes: histSpeed ? Math.round(histSpeed) : null,
    etaSeconds,
    sizing,
    avgItemBytes: Math.round(avgItemBytes),
  };
}

function startDownloadsLoop() {
  setInterval(refreshDownloads, 5000);
  setTimeout(refreshDownloads, 1500);
}
function getDl() { return _dl; }

module.exports = { startDownloadsLoop, getDl, bustDownloadsCache, refreshDownloads };
