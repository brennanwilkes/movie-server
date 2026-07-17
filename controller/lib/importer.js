'use strict';
// Import rescue subsystem: manual-import strategies (importViaManual, the
// season-alias remap, the 4-strategy force-grab importer), the force-grab
// post-import verifier, fake-release (garbage) detection via ffprobe, the
// importWatchdog sweep, and force-grab recovery after a restart. Owns:
// forceGrabVerify, watchdog busy/backoff state, VIDEO_EXT. Timers:
// startWatchdog() → fg-verify 60s, watchdog 60s (first at 8s), recover at 4s.
// NOTE: in the pre-split monolith, importWatchdog's folder-scan fallback called
// `norm(...)` which was only ever in scope inside buildDownloads — the
// try/catch swallowed the ReferenceError, so the fallback silently never
// worked. Fixed 2026-07-16: the same title normalizer is now defined at module
// scope below, making the fallback functional for the first time.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const metrics = require('../metrics');
const { cfg, HOST } = require('./config');
const { tfetch, qbit, arrGet, arrOf } = require('./clients');
const { getQbitTorrents, getQueueMap } = require('./arr-data');
const { jellyfinUserId } = require('./jellyfin');
const {
  importState, forceGrabImport, completedForceGrabs, persistState, isMasterPaused,
} = require('./state');
const { getDl } = require('./downloads');
const { triggerJellyfinScan } = require('./jf-scan');

// Title normalizer for the watchdog's folder-scan fallback (same shape as the
// one buildDownloads uses for torrent-name matching).
const norm = (s) => String(s || '').toLowerCase().replace(/[._'’:()\-]/g, ' ').replace(/\s+/g, ' ').trim();

// ---- Auto-import watchdog (backend, container-to-container; NOT driven by the UI) ----
// The happy path is event-driven: qBittorrent finishes → *arr imports → *arr pushes a
// "library updated" notification to Jellyfin. But when *arr DROPS a completed download
// without importing (the delete→re-download race), there's no event to react to — so a
// periodic sweep is the only way to catch the *absence* of an import. It runs the same
// Manual Import the *arr UI offers, and retries with backoff until the file lands.
async function importViaManual(app, folder, expectedId) {
  const { base, key } = arrOf(app);
  const r = await tfetch(`${base}/manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=true`, { headers: { 'X-Api-Key': key } }, 90000);
  if (!r.ok) return { ok: false, reason: `manualimport HTTP ${r.status}` };
  const files = []; let reason = 'no importable file found yet';
  for (const c of await r.json()) {
    if (!c.path) continue;
    if (c.rejections && c.rejections.length) {
      const rsn = c.rejections[0].reason || '';
      if (/unknown movie/i.test(rsn) && expectedId) { /* trust the grab link despite unparseable filename */ }
      else { reason = rsn || 'rejected'; continue; }
    }
    const f = { path: c.path, quality: c.quality, languages: c.languages || [], releaseGroup: c.releaseGroup || '' };
    // Fall back to the grab-history movie id (expectedId) when the FILE NAME doesn't parse to a
    // movie — e.g. a release titled "Monty Python Life of Brian" for the library entry "Life of
    // Brian". *arr blocks auto-import on an ID-only match; we trust the grab link and import anyway.
    if (app === 'radarr') { const mid = (c.movie && c.movie.id) || expectedId; if (!mid) { reason = 'no matching movie'; continue; } f.movieId = mid; }
    else { if (!c.series) { reason = 'no matching series'; continue; } f.seriesId = c.series.id; f.episodeIds = (c.episodes || []).map((e) => e.id); if (!f.episodeIds.length) { reason = 'no matching episode'; continue; } }
    files.push(f);
  }
  if (!files.length) return { ok: false, reason };
  const cmd = await tfetch(`${base}/command`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ManualImport', importMode: 'auto', files }) }, 90000);
  return { ok: cmd.ok, count: files.length, reason: cmd.ok ? null : `command HTTP ${cmd.status}` };
}

// Season-alias rescue (Sonarr only, rare). Some TVDB series merge two differently-numbered shows
// into one entry — e.g. "Cosmos (2014)" = S01 "A Spacetime Odyssey" (2014) + S02 "Possible Worlds"
// (2020). A "Possible Worlds" release numbers its files in its OWN season 1 (Cosmos.S01E01…), but
// Sonarr grabbed them as the parent series' season 2. At import Sonarr blocks every file:
// "Episode 1x01 was unexpected considering the …Possible.Worlds.S01… folder name". This remaps
// each file to the exact episode Sonarr ITSELF grabbed this download for, matched by episode
// NUMBER — so we never guess a season. The target comes from Sonarr HISTORY (the grabbed events for
// this downloadId), which is DURABLE: it survives the queue being cleared once Sonarr stops tracking
// the blocked import (the queue empties, so it can't be the source). Returns {ok:false} and no-ops
// if history has no grab or nothing matches. Only ever called as a fallback AFTER the normal import
// already failed with the season-mismatch rejection, so the happy path is untouched.
async function importViaSeasonRemap(folder, seriesIdHint, hash) {
  const { base, key } = arrOf('sonarr');
  // 1. Episodes Sonarr GRABBED this exact download for, from history (durable). Per-episode grab
  //    records carry episodeId + seriesId but not the episode NUMBER — resolve those below. The
  //    seriesId also comes from here (once the queue is gone, the caller's rec.id can be null).
  let grabbedEids = [], seriesId = seriesIdHint != null ? seriesIdHint : null;
  try {
    const hr = await arrGet('sonarr', `/history?pageSize=500&sortKey=date&sortDirection=descending&downloadId=${String(hash).toUpperCase()}`, 15000);
    for (const r of (hr.records || [])) {
      if ((r.eventType || '').toLowerCase() !== 'grabbed') continue;
      if (r.episodeId) grabbedEids.push(r.episodeId);
      if (r.seriesId != null) seriesId = r.seriesId;
    }
  } catch { return { ok: false, reason: 'season-remap: history unavailable' }; }
  grabbedEids = [...new Set(grabbedEids)];
  if (!grabbedEids.length || seriesId == null) return { ok: false, reason: 'season-remap: no grabbed episodes in history' };
  // 2. Resolve grabbed episodeIds → episodeNumber, keyed for lookup by the files' embedded numbers.
  const target = new Map();
  try {
    const eps = await arrGet('sonarr', `/episode?seriesId=${seriesId}`, 30000);
    const want = new Set(grabbedEids);
    for (const e of (eps || [])) if (want.has(e.id) && e.episodeNumber != null) target.set(e.episodeNumber, e.id);
  } catch { return { ok: false, reason: 'season-remap: episode table unavailable' }; }
  if (!target.size) return { ok: false, reason: 'season-remap: grabbed episodes not resolved' };
  const r = await tfetch(`${base}/manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=true`, { headers: { 'X-Api-Key': key } }, 90000);
  if (!r.ok) return { ok: false, reason: `season-remap: manualimport HTTP ${r.status}` };
  const files = [];
  for (const c of await r.json()) {
    if (!c.path) continue;
    // Embedded episode number: prefer Sonarr's own parse, else pull E## / S##E## from the filename.
    const emb = (c.episodes || [])[0];
    let epNum = emb && emb.episodeNumber != null ? emb.episodeNumber : null;
    if (epNum == null) { const m = path.basename(c.path).match(/[ ._-]S\d+E(\d+)[ ._-]/i) || path.basename(c.path).match(/[ ._-]E(\d+)[ ._-]/i); if (m) epNum = parseInt(m[1], 10); }
    if (epNum == null) continue;
    const tid = target.get(epNum);
    if (tid == null) continue;
    files.push({ path: c.path, quality: c.quality, languages: c.languages || [], releaseGroup: c.releaseGroup || '', seriesId, episodeIds: [tid], downloadId: String(hash).toUpperCase() });
  }
  if (!files.length) return { ok: false, reason: 'season-remap: no files matched grabbed episode numbers' };
  const cmd = await tfetch(`${base}/command`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ManualImport', importMode: 'auto', files }) }, 90000);
  return { ok: cmd.ok, count: files.length, reason: cmd.ok ? null : `season-remap: command HTTP ${cmd.status}` };
}

// Maximum-aggression force-grab import for Sonarr. Gap releases reachable only via text search
// are, by definition, the ones Sonarr's structured parser can't handle. Their filenames are
// unreliable — no S01E##, wrong series name, year-suffixed, dot-separated nothingburgers.
// This function tries 4 strategies in order, falling through on emptiness:
//
//   1. Sonarr /manualimport — handles releases that parse fine despite the text-search detour
//   2. Episode-number extraction — regex patterns (S01E03, E03, 03, scene-numbered) against
//      the filename, looked up in the series' full episode table
//   3. Episode-title fuzzy match — strip the series name, match remaining words against Sonarr's
//      episode titles (handles "Planet Earth 03 Fresh Water" → "Fresh Water" → S01E03)
//   4. Sequential fill — sort video files by name, assign to first missing monitored episodes in
//      order (last resort; works for season packs whose filenames have no recognizable pattern
//      at all but are known to be a contiguous season)
async function importViaGrab(app, folder, expectedId) {
  const { base, key } = arrOf(app);

  // ── Scan video files directly so we have ground truth ──
  let onDiskVideos = [];
  try {
    const entries = await fs.promises.readdir(folder);
    for (const e of entries) {
      const ext = path.extname(e).toLowerCase();
      if (VIDEO_EXT.has(ext)) onDiskVideos.push(path.join(folder, e));
    }
  } catch {}
  onDiskVideos.sort();

  // ── Fetch full episode table for this series ──
  let allEps = [], episodeCount = 0, episodeFileCount = 0;
  if (expectedId) {
    try {
      const sr = await tfetch(`${base}/episode?seriesId=${expectedId}`, { headers: { 'X-Api-Key': key } }, 30000);
      if (sr.ok) {
        allEps = await sr.json();
        const statsR = await tfetch(`${base}/series/${expectedId}`, { headers: { 'X-Api-Key': key } }, 8000);
        if (statsR.ok) {
          const s = await statsR.json();
          if (s.statistics) { episodeCount = s.statistics.episodeCount || 0; episodeFileCount = s.statistics.episodeFileCount || 0; }
        }
      }
    } catch {}
  }

  // Maps for fast lookup: key = "season:episode" → episode object, key = "season:episode" → id
  const epByKey = new Map();
  const epByTitle = new Map(); // lowercase title → episode id (for fuzzy match)
  for (const ep of allEps) {
    const k = `${ep.seasonNumber}:${ep.episodeNumber}`;
    epByKey.set(k, ep);
    if (ep.title) epByTitle.set(ep.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim(), ep.id);
  }

  // Helper: extract episode id from a filename using regex + episode table
  function resolveEpisode(filename) {
    // Patterns ordered most → least specific
    const patterns = [
      /[ ._-]S(\d+)E(\d+)[ ._-]/i,
      /[ ._-]S(\d+)[ ._-]+E(\d+)[ ._-]/i,
      /[ ._-]E(\d+)[ ._-]/i,
      /[ ._-]0*(\d+)[ ._-][vV]\d+/,
      /[ ._-](\d{2})[ ._-]/,
      /[ ._-](\d)[ ._-]/,
    ];
    for (const pat of patterns) {
      const m = filename.match(pat);
      if (!m) continue;
      if (m[2] !== undefined) {
        const eid = epByKey.get(`${parseInt(m[1],10)}:${parseInt(m[2],10)}`);
        if (eid) return eid.id;
      } else if (m[1] !== undefined) {
        const num = parseInt(m[1], 10);
        if (num >= 1 && num <= 50) {
          const eid = epByKey.get(`1:${num}`);
          if (eid) return eid.id;
        }
      }
    }
    // Episode-title fuzzy match: strip common noise, check remaining words
    const cleaned = filename
      .replace(path.extname(filename), '')
      .replace(/[._()\[\]{}\-]/g, ' ')
      .replace(/\d{3,}p/g, '')           // 1080p, 720p
      .replace(/\bx265\b|\bx264\b|\bh265\b|\bh264\b|\bhevc\b|\bavc\b|\bav1\b|\bvp9\b/gi, '')
      .replace(/\b\d{4}\b/g, '')          // years
      .replace(/\b\d+x\d+\b/g, '')        // resolutions
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const words = cleaned.split(/\s+/).filter(w => w.length > 2);
    for (const [title, epId] of epByTitle) {
      const titleWords = title.split(/\s+/);
      const matchCount = titleWords.filter(tw => words.includes(tw)).length;
      if (matchCount >= Math.min(titleWords.length, 2) && matchCount / titleWords.length >= 0.5) {
        return epId;
      }
    }
    return null;
  }

  // Detect a MULTI-EPISODE file — one video that spans an episode range (e.g. Cosmos 1980's
  // "Carl Sagan's Cosmos - Chapter 5 to 8" = episodes 5,6,7,8 in a single file, or "E05-E08").
  // Returns [episodeId,…] so Sonarr records it as a multi-episode file (all covered episodes get
  // marked present); null when there's no range. Must be tried BEFORE resolveEpisode, which would
  // otherwise match just the first number ("5") and strand the rest as missing.
  function resolveEpisodeRange(filename) {
    const b = filename.replace(path.extname(filename), '');
    let season = 1, a = null, z = null, m;
    if ((m = b.match(/[ ._-]S(\d+)[ ._-]*E(\d+)[ ._-]*(?:-|–|to|thru|through)[ ._-]*E?(\d+)\b/i))) {
      season = parseInt(m[1], 10); a = parseInt(m[2], 10); z = parseInt(m[3], 10);
    } else if ((m = b.match(/[ ._-]E(\d+)[ ._-]*(?:-|–|to|thru|through)[ ._-]*E?(\d+)\b/i))) {
      a = parseInt(m[1], 10); z = parseInt(m[2], 10);
    } else if ((m = b.match(/\b(?:chapters?|ch|episodes?|ep|parts?)[ ._-]*(\d{1,2})[ ._-]*(?:to|thru|through|-|–)[ ._-]*(\d{1,2})\b/i))) {
      a = parseInt(m[1], 10); z = parseInt(m[2], 10);
    } else if ((m = b.match(/[ ._-](\d{1,2})[ ._-]*(?:to|thru|through)[ ._-]*(\d{1,2})[ ._-]/i))) {
      a = parseInt(m[1], 10); z = parseInt(m[2], 10);
    }
    if (a == null || !(a >= 1 && z > a && z - a <= 40)) return null;
    const ids = [];
    for (let n = a; n <= z; n++) { const e = epByKey.get(`${season}:${n}`); if (e) ids.push(e.id); }
    return ids.length >= 2 ? ids : null;
  }

  // ── Strategy 1: Try Sonarr's /manualimport ──
  const mr = await tfetch(`${base}/manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=true`, { headers: { 'X-Api-Key': key } }, 90000);
  if (mr.ok) {
    const manualItems = await mr.json();
    const importable = [];

    for (const c of manualItems) {
      if (!c.path || !onDiskVideos.includes(c.path)) continue;
      const rejected = c.rejections && c.rejections.length;
      const rsn = rejected ? c.rejections[0].reason : '';
      const hasSeries = !!c.series;
      const hasEpisodes = c.episodes && c.episodes.length > 0;

      // Only trust Sonarr's own parse when it agrees with the series the user force-grabbed for.
      // A gap release reachable only via text search often mis-parses (e.g. "Carl Sagan's Cosmos
      // 1980…" → Cosmos 2014); c.series/c.episodes would then point at the WRONG series. When it
      // disagrees (or expectedId is unknown), fall through to our own resolver, which keys off the
      // correct series' episode table below.
      if (hasSeries && hasEpisodes && (!expectedId || c.series.id === expectedId)) {
        // Clean match — Sonarr parsed everything, and it's the series we intended
        importable.push({ path: c.path, quality: c.quality, languages: c.languages || [], releaseGroup: c.releaseGroup || '', seriesId: c.series.id, episodeIds: c.episodes.map(e => e.id) });
        continue;
      }

      // Multi-episode file first (a single video spanning a range, e.g. "Chapter 5 to 8").
      const rangeIds = resolveEpisodeRange(path.basename(c.path));
      if (rangeIds) {
        importable.push({ path: c.path, quality: c.quality, languages: c.languages || [], releaseGroup: c.releaseGroup || '', seriesId: expectedId || (c.series && c.series.id), episodeIds: rangeIds });
        console.log(`importViaGrab: multi-episode file "${path.basename(c.path)}" → ${rangeIds.length} episodes`);
        continue;
      }
      // Attempt our own resolution
      const epId = resolveEpisode(path.basename(c.path));
      if (epId != null) {
        importable.push({ path: c.path, quality: c.quality, languages: c.languages || [], releaseGroup: c.releaseGroup || '', seriesId: expectedId || (c.series && c.series.id), episodeIds: [epId] });
        continue;
      }

      // Last-ditch: if this is a series match with rejections but we know expectedId,
      // try by file order vs missing episodes
      if (hasSeries && expectedId) {
        // We'll handle these in strategy 4 below
      }
    }

    if (importable.length) {
      const cmd = await tfetch(`${base}/command`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ManualImport', importMode: 'auto', files: importable }) }, 90000);
      return { ok: cmd.ok, count: importable.length, reason: cmd.ok ? null : `command HTTP ${cmd.status}` };
    }
  }

  // ── Strategy 2+3: Direct file scan with episode resolution ──
  let resolved = [];
  for (const fp of onDiskVideos) {
    const rangeIds = resolveEpisodeRange(path.basename(fp));
    if (rangeIds) { resolved.push({ path: fp, seriesId: expectedId, episodeIds: rangeIds }); continue; }
    const epId = resolveEpisode(path.basename(fp));
    if (epId != null) {
      resolved.push({ path: fp, seriesId: expectedId, episodeIds: [epId] });
    }
  }

  if (resolved.length) {
    const cmd = await tfetch(`${base}/command`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ManualImport', importMode: 'auto', files: resolved }) }, 90000);
    return { ok: cmd.ok, count: resolved.length, reason: cmd.ok ? null : `command HTTP ${cmd.status}` };
  }

  // ── Strategy 4: Sequential fill — sort files, assign to first missing monitored episodes ──
  if (expectedId && onDiskVideos.length > 0) {
    const missingEps = allEps
      .filter(e => e.monitored && !e.hasFile)
      .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
    if (missingEps.length >= onDiskVideos.length) {
      const sequential = onDiskVideos.map((fp, i) => ({
        path: fp,
        seriesId: expectedId,
        episodeIds: [missingEps[i].id],
      }));
      const cmd = await tfetch(`${base}/command`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ManualImport', importMode: 'auto', files: sequential }) }, 90000);
      return { ok: cmd.ok, count: sequential.length, reason: cmd.ok ? null : `command HTTP ${cmd.status}` };
    }
  }

  return { ok: false, reason: onDiskVideos.length ? 'could not match any video file to an episode' : 'no video files found in folder' };
}

// ── Force-grab post-import verification & telemetry ──────────────────────────────────────────
// Force-grabs bypass Sonarr's own quality/parse gates, so a bad one can look "imported" while
// actually landing in the wrong series, scattering into phantom Jellyfin seasons, doubling, or
// importing only partially. This cross-checks Sonarr AND Jellyfin after import and emits a loud
// `fg_verify` event (make metrics a='events --type fg_verify') the moment anything is off — the
// safety net behind the rename+NFO+range fixes. A few minutes' delay lets Jellyfin finish scanning.
const forceGrabVerify = new Map(); // seriesId -> { hash, dueAt, tries }
function scheduleForceGrabVerify(seriesId, hash) {
  if (seriesId == null) return;
  forceGrabVerify.set(Number(seriesId), { hash: String(hash || '').toLowerCase(), dueAt: Math.floor(Date.now() / 1000) + 150, tries: 0 });
}
async function jellyfinSeriesByPath(mappedPath) {
  if (!cfg.JELLYFIN_KEY || !mappedPath) return [];
  const uid = await jellyfinUserId();
  const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };
  const q = new URLSearchParams({ recursive: 'true', includeItemTypes: 'Series', fields: 'Path,ProviderIds', limit: '2000' });
  const items = ((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 8000)).json()).Items) || [];
  const norm = (p) => String(p || '').replace(/\/+$/, '');
  return items.filter((i) => norm(i.Path) === norm(mappedPath));
}
async function jellyfinSeasonCounts(seriesItemId) {
  const uid = await jellyfinUserId();
  const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };
  const q = new URLSearchParams({ parentId: seriesItemId, recursive: 'true', includeItemTypes: 'Episode', fields: 'ParentIndexNumber', limit: '5000' });
  const eps = ((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 10000)).json()).Items) || [];
  const bySeason = {};
  for (const e of eps) { const s = e.ParentIndexNumber == null ? 'unknown' : String(e.ParentIndexNumber); bySeason[s] = (bySeason[s] || 0) + 1; }
  return { total: eps.length, bySeason };
}
// Compute (do not emit) the verification result for a force-grabbed Sonarr series.
async function computeForceGrabVerify(seriesId) {
  const issues = [];
  let series;
  try { series = await arrGet('sonarr', `/series/${seriesId}`, 8000); }
  catch (e) { return { ok: false, transient: true, issues: ['sonarr_unreachable'], payload: { id: seriesId, error: String(e.message || e) } }; }
  const st = series.statistics || {};
  const title = `${series.title}${series.year ? ` (${series.year})` : ''}`;
  const tvdb = series.tvdbId || null;
  const sonarrSeasons = {};
  for (const sn of (series.seasons || [])) if (sn.seasonNumber > 0) { const ss = sn.statistics || {}; sonarrSeasons[String(sn.seasonNumber)] = ss.episodeFileCount || 0; }
  if (!(st.episodeCount > 0 && st.episodeFileCount >= st.episodeCount)) issues.push(`sonarr_incomplete:${st.episodeFileCount || 0}/${st.episodeCount || 0}`);
  let jf = null, transient = false;
  try {
    const mapped = (series.path || '').replace('/data/media', '/media');
    const jseries = await jellyfinSeriesByPath(mapped);
    if (!jseries.length) { issues.push('jellyfin_missing'); transient = true; }
    else {
      if (jseries.length > 1) issues.push(`jellyfin_duplicate:${jseries.length}`);
      const s0 = jseries[0];
      const jtvdb = s0.ProviderIds && (s0.ProviderIds.Tvdb || s0.ProviderIds.tvdb);
      if (tvdb && jtvdb && String(jtvdb) !== String(tvdb)) issues.push(`jellyfin_wrong_tvdb:${jtvdb}!=${tvdb}`);
      const counts = await jellyfinSeasonCounts(s0.Id);
      jf = { tvdb: jtvdb || null, total: counts.total, seasons: counts.bySeason };
      const real = new Set(Object.keys(sonarrSeasons));
      for (const s of Object.keys(counts.bySeason)) if (s === 'unknown' || !real.has(s)) issues.push(`jellyfin_phantom_season:${s}`);
      if (st.episodeFileCount && counts.total > st.episodeFileCount) issues.push(`jellyfin_extra_episodes:${counts.total}>${st.episodeFileCount}`);
    }
  } catch { issues.push('jellyfin_check_error'); transient = true; }
  return {
    ok: issues.length === 0,
    transient,
    issues,
    payload: { id: Number(seriesId), ti: title, tvdb, ok: issues.length === 0, issues, sonarr: { files: st.episodeFileCount || 0, eps: st.episodeCount || 0, seasons: sonarrSeasons }, jellyfin: jf },
  };
}
let fgVerifyBusy = false;
async function forceGrabVerifySweep() {
  if (isMasterPaused() || fgVerifyBusy || !forceGrabVerify.size) return;
  fgVerifyBusy = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    for (const [sid, v] of forceGrabVerify) {
      if (now < v.dueAt) continue;
      v.tries++;
      const r = await computeForceGrabVerify(sid).catch((e) => ({ ok: false, transient: false, issues: ['verify_error'], payload: { id: sid, error: String(e.message || e) } }));
      // Only transient issues (Jellyfin still scanning) and tries left → wait and retry, don't cry wolf.
      if (!r.ok && r.transient && v.tries < 4) { v.dueAt = now + 180; continue; }
      metrics.emitEvent('fg_verify', r.payload);
      console.log(`fg-verify: ${r.ok ? 'PASS' : 'FAIL'} "${r.payload.ti || sid}" (tvdb ${r.payload.tvdb || '?'})${r.ok ? '' : ' — ' + r.issues.join(', ')}`);
      forceGrabVerify.delete(sid);
    }
  } finally { fgVerifyBusy = false; }
}
// A download can fail to import forever when the "release" is a fake — e.g. a .scr Windows
// executable padded to episode size. *arr rejects it every sweep ("Unable to determine if file
// is a sample") and, with no retry cap, the watchdog retries it every 120s indefinitely while the
// item sits in "Needs attention" until a human deletes it by hand. IMPORT_MAX_FAILS bounds the
// retries; hasVideoContent() then confirms there is genuinely no video before we discard, so a
// real file that fails to import for other reasons is never thrown away.
const IMPORT_MAX_FAILS = 5;                                         // consecutive failed imports (~10 min at 120s backoff) before garbage check
const VIDEO_EXT = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.flv', '.ts', '.m2ts', '.mpg', '.mpeg', '.webm', '.vob', '.divx', '.3gp', '.ogv', '.mts', '.iso']);
// Check if a file actually has a video stream, not just a matching extension.
// Runs ffprobe with a tight probesize so even multi-GB files return fast.
// On error/failure returns false (not video) UNLESS ffprobe itself isn't found,
// in which case we trust the extension check (fail-safe: never delete on uncertainty).
function hasVideoStream(fp) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      '-analyzeduration', '100k',
      '-probesize', '100k',
      fp
    ], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        if (err.code === 'ENOENT') resolve(true);                 // ffprobe not found → trust extension
        else resolve(false);                                        // ffprobe says not a video
        return;
      }
      resolve(stdout.trim() === 'video');
    });
  });
}
async function hasVideoContent(p) {
  try {
    const st = await fs.promises.stat(p);
    if (st.isFile()) {
      if (!VIDEO_EXT.has(path.extname(p).toLowerCase())) return false;
      return await hasVideoStream(p);
    }
    const stack = [p];                                             // directory: any video file anywhere inside counts
    while (stack.length) {
      const dir = stack.pop();
      for (const ent of await fs.promises.readdir(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) stack.push(path.join(dir, ent.name));
        else if (VIDEO_EXT.has(path.extname(ent.name).toLowerCase())) {
          if (await hasVideoStream(path.join(dir, ent.name))) return true;
        }
      }
    }
    return false;
  } catch { return true; }                                         // can't tell → assume video (fail-safe: never delete on uncertainty)
}
// Discard a confirmed-garbage download: blocklist the release so *arr won't re-grab this exact
// fake, remove the torrent + its file from qBittorrent, and re-search for a real copy. Mirrors
// stallRecovery's dual path — prefer the queue record (removeFromClient+blocklist in one call),
// fall back to history/failed when *arr no longer tracks the download.
async function discardGarbage(rec) {
  const { base, key } = arrOf(rec.app);
  let blocklisted = false;
  try {
    const qrec = rec.hash && (await getQueueMap(rec.app)).get(rec.hash.toLowerCase());
    if (qrec && qrec.id != null) {
      await tfetch(`${base}/queue/${qrec.id}?removeFromClient=true&blocklist=true`, { method: 'DELETE', headers: { 'X-Api-Key': key } }, 20000);
      blocklisted = true;
    }
  } catch { /* fall through to history-based blocklist */ }
  if (!blocklisted && rec.hash) {
    try {
      const hr = await arrGet(rec.app, `/history?pageSize=20&sortKey=date&sortDirection=descending&downloadId=${rec.hash.toUpperCase()}`);
      const grab = (hr.records || []).find((r) => (r.eventType || '').toLowerCase() === 'grabbed');
      if (grab) { await tfetch(`${base}/history/failed/${grab.id}`, { method: 'POST', headers: { 'X-Api-Key': key } }, 15000); blocklisted = true; }
    } catch { /* best-effort */ }
  }
  if (rec.hash) {                                                  // ensure the fake file is gone even if there was no queue record
    try { await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ hashes: rec.hash, deleteFiles: 'true' }) }); } catch { /* qbit hiccup — retried */ }
  }
  if (rec.id != null) {                                            // re-search for a real copy of the missing item
    const cmd = rec.app === 'radarr' ? { name: 'MoviesSearch', movieIds: [rec.id] } : { name: 'SeriesSearch', seriesId: rec.id };
    try { await tfetch(`${base}/command`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) }, 20000); } catch { /* search kick best-effort */ }
  }
  return blocklisted;
}

// A manualimport that throws (AbortController timeout, socket reset, HTTP 5xx) is *arr being slow
// or briefly down — NOT the release being unimportable. Timeouts must never paint a row red or
// count toward the garbage cap: on a loaded NUC that turned every genuinely-importable download
// into a permanent, self-reinforcing "Needs attention" (each retry fired another heavy 90s probe
// that pushed the box slower). Transient errors only extend the per-folder backoff.
const isTransientErr = (e) => { const m = (e && e.message || String(e || '')).toLowerCase(); return m.includes('abort') || m.includes('timeout') || m.includes('timed out') || m.includes('network') || m.includes('fetch failed') || m.includes('econn') || /http 5\d\d/.test(m); };
const IMPORT_BACKOFF_MIN = 120, IMPORT_BACKOFF_MAX = 1800; // s — grows 120→240→…→1800 on repeated failure
const WATCHDOG_BATCH = 3;                                  // heavy manualimport calls per sweep — cap the added load
let watchdogBusy = false;                                  // reentrancy guard: a slow sweep must not overlap the next tick
async function importWatchdog() {
  if (isMasterPaused() || watchdogBusy) return;                         // Movie Mode / already running
  const snap = getDl().raw;                                             // reuse the background snapshot — no extra buildDownloads
  if (!snap || !snap.length) return;
  watchdogBusy = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    let handled = 0;
    // Pre-pass: resolve force-grabbed torrents whose content is on disk but Sonarr hasn't
    // fully imported. These don't appear in `snap` (torrent may be gone from qBittorrent
    // while the download folder still holds orphaned episode files). Try Manual Import for
    // any watched hash whose folder is known (either from the live torrent or from disk).
    const fgTorrents = forceGrabImport.size ? await getQbitTorrents().catch(() => []) : [];
    const fgByHash = new Map();
    for (const t of fgTorrents) fgByHash.set((t.hash || '').toLowerCase(), t);
    const CAT_PATH = '/data/torrents/complete/sonarr-force';
    for (const [infoHash, fg] of forceGrabImport) {
      if (handled >= WATCHDOG_BATCH) break;
      const liveTorrent = fgByHash.get(infoHash);
      if (liveTorrent) {
        // Import ONLY once the torrent is complete. Importing mid-download hardlinks preallocated/
        // half-written files into the library — Sonarr then marks them imported and never replaces
        // them with the finished data, and Jellyfin probes partial media. qBit's content_path also
        // points into the incomplete/ tree until completion. Wait for the next sweep.
        if ((liveTorrent.progress || 0) < 1) { fg.folder = null; continue; }
        if (liveTorrent.content_path) fg.folder = liveTorrent.content_path;
      } else if (!fg.folder) {
        // Torrent gone from qBittorrent but may still have files on disk.
        // Scan the sonarr category folder for a directory matching the series title.
        try {
          const entries = await fs.promises.readdir(CAT_PATH).catch(() => []);
          const seriesNorm = norm(fg.seriesTitle);
          for (const entry of entries) {
            if (norm(entry).includes(seriesNorm)) {
              const fp = path.join(CAT_PATH, entry);
              const st = await fs.promises.stat(fp).catch(() => null);
              if (st && st.isDirectory()) { fg.folder = fp; break; }
            }
          }
        } catch { /* best-effort */ }
      }
      if (!fg.folder) continue; // not ready yet, retry next sweep
      if (fg.folder.includes('/torrents/incomplete/')) continue; // defense: never import from the incomplete tree
      // Already fully imported (by a prior sweep, or the standard path) → finalize and stop retrying.
      // Without this, importViaGrab finds nothing new to import (all files present) and would keep
      // counting "failures" against a series that's actually complete.
      try {
        const s0 = await arrGet('sonarr', `/series/${fg.id}`, 6000);
        const ss = s0 && s0.statistics;
        if (ss && ss.episodeCount > 0 && ss.episodeFileCount >= ss.episodeCount) {
          forceGrabImport.delete(infoHash);
          completedForceGrabs.set(infoHash, { id: fg.id });
          importState.delete(fg.folder);
          persistState();
          metrics.emitEvent('fg_import', { id: fg.id, ti: fg.seriesTitle, files: ss.episodeFileCount, eps: ss.episodeCount, done: true, via: 'precomplete', infoHash });
          scheduleForceGrabVerify(fg.id, infoHash);
          console.log(`watchdog: force-grab complete (${ss.episodeFileCount}/${ss.episodeCount}) — "${fg.seriesTitle}"`);
          continue;
        }
      } catch { /* stats unavailable — fall through and let importViaGrab try */ }
      const st = importState.get(fg.folder) || { lastTry: 0, reason: null, fails: 0, backoff: IMPORT_BACKOFF_MIN };
      if (now - st.lastTry < (st.backoff || IMPORT_BACKOFF_MIN)) continue;
      st.lastTry = now; handled++;
      let res;
      try { res = await importViaGrab('sonarr', fg.folder, fg.id); }
      catch (e) { res = { ok: false, reason: e.message || 'error' }; }
      if (res && res.ok) {
        importState.set(fg.folder, { lastTry: now, reason: null, fails: 0, backoff: IMPORT_BACKOFF_MIN });
        triggerJellyfinScan();
        console.log(`watchdog: force-grab imported ${res.count} file(s) from "${fg.folder}"`);
        // Check if ALL episodes are now in the library — partial imports keep retrying.
        let allDone = false, stats = null;
        try {
          const seriesData = await arrGet('sonarr', `/series/${fg.id}`, 6000);
          stats = seriesData && seriesData.statistics;
          if (stats && stats.episodeCount > 0 && stats.episodeFileCount != null) {
            allDone = stats.episodeFileCount >= stats.episodeCount;
          }
        } catch { /* best-effort — retry next sweep */ }
        metrics.emitEvent('fg_import', { id: fg.id, ti: fg.seriesTitle, imported: res.count, files: stats && stats.episodeFileCount, eps: stats && stats.episodeCount, done: allDone, via: 'watchdog', infoHash });
        if (allDone) {
          forceGrabImport.delete(infoHash);
          completedForceGrabs.set(infoHash, { id: fg.id }); // remember the series so buildDownloads renders this Ready (no downloadId-keyed *arr history)
          persistState();
          scheduleForceGrabVerify(fg.id, infoHash);
        }
      } else if (res && (/no matching (series|episode)/i.test(res.reason || '') || (st.fails || 0) >= IMPORT_MAX_FAILS)) {
        // Can't match: folder was removed or Sonarr truly can't parse these files. Give up.
        console.log(`watchdog: force-grab gave up on "${fg.folder}" — ${res.reason || 'max fails'}`);
        metrics.emitEvent('fg_giveup', { id: fg.id, ti: fg.seriesTitle, folder: fg.folder, reason: res ? res.reason : 'max fails', infoHash });
        forceGrabImport.delete(infoHash);
        importState.delete(fg.folder);
        persistState();
      } else {
        st.fails = (st.fails || 0) + 1;
        st.backoff = Math.min((st.backoff || IMPORT_BACKOFF_MIN) * 2, IMPORT_BACKOFF_MAX);
        st.reason = res ? res.reason : 'error';
        importState.set(fg.folder, st);
      }
    }
    for (const it of snap) {
      if (handled >= WATCHDOG_BATCH) break;                         // spread the backlog across sweeps, don't pile onto the CPU
      const rec = it._recover; if (!rec) continue;                  // only completed-but-not-imported / import-blocked
      const st = importState.get(rec.folder) || { lastTry: 0, reason: null, fails: 0, backoff: IMPORT_BACKOFF_MIN };
      if (now - st.lastTry < (st.backoff || IMPORT_BACKOFF_MIN)) continue; // per-folder (exponential) backoff
      try { await fs.promises.stat(rec.folder); } catch { importState.delete(rec.folder); continue; } // content gone → nothing to import
      // (manualimport accepts a single file path OR a folder, so we no longer skip single-file torrents —
      //  import-blocked single files like "matched by ID, manual import required" must be rescued too.)
      st.lastTry = now; handled++;
      // Fresh per-hash ground truth before importing: the snapshot's history view is 20s-cached
      // and raced *arr's own importer, producing duplicate "Upgrade over itself" imports
      // (Moneyball ×2, Mormon Wives ×3 in the audit). Walk this download's own history newest-
      // first: an import event BEFORE the latest grab means this cycle already imported — skip.
      // (Import-after-grab ordering matters because an upgrade re-grab reuses the same hash.)
      if (rec.hash) {
        try {
          const hr = await arrGet(rec.app, `/history?pageSize=30&sortKey=date&sortDirection=descending&downloadId=${rec.hash.toUpperCase()}`, 8000);
          let alreadyImported = false;
          for (const r of (hr.records || [])) {
            const et = (r.eventType || '').toLowerCase();
            if (et.includes('import')) { alreadyImported = true; break; }
            if (et === 'grabbed') break;                            // reached the grab first → not imported this cycle
          }
          if (alreadyImported) { importState.delete(rec.folder); continue; }
        } catch { /* history unavailable — fall through to the existing rescue path */ }
      }
      let res;
      try { res = await importViaManual(rec.app, rec.folder, rec.id); }
      catch (e) {
        if (isTransientErr(e)) {                                    // *arr slow/down — retry later, never flag or count
          st.backoff = Math.min((st.backoff || IMPORT_BACKOFF_MIN) * 2, IMPORT_BACKOFF_MAX);
          importState.set(rec.folder, st);                          // note: st.reason left untouched → row stays "Importing", not red
          console.log(`watchdog: transient import error for "${rec.folder}" — ${e.message || e}; retry in ${st.backoff}s`);
          metrics.emitEvent('import_err', { ti: rec.folder, ap: rec.app, reason: 'transient', backoff: st.backoff });
          continue;
        }
        res = { ok: false, reason: e.message || 'error' };          // a real, non-transient throw is treated as a rejection below
      }
      // Season-alias fallback: only when the normal import was blocked because the files' embedded
      // season differs from the season Sonarr grabbed the release for (merged TVDB series like
      // Cosmos 2014's "Possible Worlds" S02). Scoped tightly — Sonarr only, needs the download hash,
      // and only this exact rejection class — so the standard import path is never affected.
      if (!res.ok && rec.app === 'sonarr' && rec.hash &&
          /unexpected considering the .* folder name|not found in the grabbed release/i.test(res.reason || '')) {
        try {
          const remap = await importViaSeasonRemap(rec.folder, rec.id, rec.hash);
          if (remap.ok) { res = remap; console.log(`watchdog: season-alias remap imported ${remap.count} file(s) from "${rec.folder}"`); metrics.emitEvent('season_remap', { id: rec.id, ti: rec.folder, count: remap.count, hash: rec.hash }); }
        } catch { /* fall through to normal failure handling */ }
      }
      if (res.ok) {
        importState.set(rec.folder, { lastTry: now, reason: null, fails: 0, backoff: IMPORT_BACKOFF_MIN }); // cleared on success
        triggerJellyfinScan();
        console.log(`watchdog: imported ${res.count} file(s) from "${rec.folder}"`);
        metrics.emitEvent('import_ok', { ti: rec.folder, ap: rec.app, count: res.count });
        continue;
      }
      // ORPHAN: *arr no longer tracks this series/movie (removed from the library, or a release for
      // content that isn't in *arr). It can NEVER import — remove the torrent so it stops recurring
      // and quits consuming disk/seed slots. Not garbage, so don't blocklist (the content may be re-added).
      if (/no matching (series|movie)|unknown (series|movie)/i.test(res.reason || '')) {
        // Defense-in-depth: never orphan-delete a manual force-grab. Its release name frequently
        // doesn't parse to any series (that's WHY it was force-grabbed), which would otherwise trip
        // this branch and wipe the files with deleteFiles:true. The pre-pass owns these folders.
        if ((rec.folder || '').includes('/complete/sonarr-force/')) { importState.delete(rec.folder); continue; }
        try { if (rec.hash) await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ hashes: rec.hash, deleteFiles: 'true' }) }); } catch { /* qbit hiccup — retried next sweep */ }
        importState.delete(rec.folder);
        console.log(`watchdog: orphan removed (not tracked by ${rec.app}): "${rec.folder}" — ${res.reason}`);
        metrics.emitEvent('orphan', { ti: rec.folder, ap: rec.app, reason: res.reason, source: 'watchdog' });
        continue;
      }
      st.reason = res.reason;
      st.fails = (st.fails || 0) + 1;
      st.backoff = Math.min((st.backoff || IMPORT_BACKOFF_MIN) * 2, IMPORT_BACKOFF_MAX); // back off real rejections too, don't thrash
      importState.set(rec.folder, st);
      // Bounded retries + a video check: a download that fails to import N times AND has no real
      // video file is a fake release (e.g. a .scr executable padded to episode size). Discard it —
      // blocklist, delete from qBittorrent, re-search — instead of retrying forever.
      if (st.fails >= IMPORT_MAX_FAILS && !(await hasVideoContent(rec.folder))) {
        try {
          const blk = await discardGarbage(rec);
          importState.delete(rec.folder);
          console.log(`watchdog: garbage file, deleted and re-searching (${st.fails} failed imports, no video, blocklisted=${blk}): "${rec.folder}" — ${res.reason}`);
          metrics.emitEvent('garbage', { ti: rec.folder, ap: rec.app, fails: st.fails, blocklisted: blk });
        } catch (e) { console.log(`watchdog: garbage discard failed for "${rec.folder}": ${e.message || e}`); }
        continue;
      }
      console.log(`watchdog: "${rec.folder}" not importable yet — ${res.reason} (fail ${st.fails}/${IMPORT_MAX_FAILS}, retry ${st.backoff}s)`);
    }
  } finally { watchdogBusy = false; }
}
// Recover forceGrabImport from qBittorrent torrents tagged manual-force-grab.
// Runs early (before bootSequence / collectionsSweep) so the watchdog pre-pass
// can retry imports immediately after a controller restart.
async function recoverForceGrabImport() {
  try {
    const fgTorrents = await getQbitTorrents();
    for (const t of fgTorrents) {
      const tags = t.tags || '';
      if (!tags.includes('manual-force-grab')) continue;
      const h = (t.hash || '').toLowerCase();
      if (forceGrabImport.has(h) || completedForceGrabs.has(h)) continue; // already tracked or already fully imported
      let seriesTitle = null, seriesId = null;
      if (t.content_path) {
        const folderName = path.basename(t.content_path);
        const cleaned = folderName.replace(/\.\w+$/, '').replace(/[\(\)]/g, '').trim();
        seriesTitle = cleaned;
        try {
          const seriesList = await arrGet('sonarr', '/series', 8000);
          if (Array.isArray(seriesList)) {
            const n = (x) => String(x || '').toLowerCase().replace(/[._'’:()\-]/g, ' ').replace(/\s+/g, ' ').trim();
            // Title match is ambiguous when two series share a name (e.g. Cosmos 1980 vs Cosmos
            // 2014). Collect every title match, then disambiguate by a year token in the folder
            // name — a wrong bind here would import the whole pack into the wrong series.
            const cands = seriesList.filter((s) => n(cleaned).includes(n(s.title)) || n(s.title).includes(n(cleaned)));
            const years = (cleaned.match(/\b(19|20)\d{2}\b/g) || []).map(Number);
            const byYear = years.length ? cands.find((s) => s.year && years.includes(s.year)) : null;
            const pick = byYear || (cands.length === 1 ? cands[0] : null); // don't guess when ambiguous and no year to break the tie
            if (pick) { seriesTitle = pick.title; seriesId = pick.id; }
          }
        } catch { /* best-effort */ }
      }
      if (seriesId != null) {
        forceGrabImport.set(h, { app: 'sonarr', id: seriesId, seriesTitle: seriesTitle || 'Unknown', folder: t.content_path || null });
        console.log(`recover: force-grab → sonarr id=${seriesId} "${seriesTitle || '?'}" (${h.slice(0, 12)}…)`);
      }
    }
    // Prune completedForceGrabs whose torrent is gone from qBittorrent — the row can't render
    // anymore, so the entry is dead weight in state.json. (Force-grabs are rare; this just keeps
    // the persisted map from accreting hashes forever.)
    let pruned = false;
    const liveHashes = new Set(fgTorrents.map((t) => (t.hash || '').toLowerCase()));
    for (const h of completedForceGrabs.keys()) if (!liveHashes.has(h)) { completedForceGrabs.delete(h); pruned = true; }
    if (forceGrabImport.size || pruned) persistState();
  } catch (e) { console.log('recover: forceGrabImport error —', e.message || e); }
}

function startWatchdog() {
setInterval(forceGrabVerifySweep, 60000);
setInterval(importWatchdog, 60000); // sweep every 60s (was 30s); imports take minutes, per-folder exponential backoff + batch cap bound real attempts
setTimeout(importWatchdog, 8000);
setTimeout(recoverForceGrabImport, 4000);  // after loadState, before 1st watchdog at ~6s
}

module.exports = { importViaManual, importWatchdog, recoverForceGrabImport, startWatchdog };
