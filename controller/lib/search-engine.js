'use strict';
// Missing-item recovery search engine: firstMissing bookkeeping, the arrSweep
// recovery loop (queue cleanup, dedup, cooldown/negative-cache scheduled
// searches), Prowlarr search-outcome probes, the search-gap prober
// (probeSearchGap) and the direct-to-qBittorrent gap grabber. Owns: the timing
// constants (also read by buildDownloads for UI hints), searchProbeTimers, and
// arrSweepBusy. Timers: startSearchEngine() → probe rehydrate at 8s, arrSweep
// every 5 min (first at 30s).

const metrics = require('../metrics');
const { cfg, HOST } = require('./config');
const { tfetch, tfetchJson, qbit, arrGet, arrPost, arrOf, arrDelete } = require('./clients');
const { getQbitTorrents, torrentApp, getIndexerSnapshot } = require('./arr-data');
const { cachedFetch } = require('./cache');
const { searchState, gpuPending, persistState, isMasterPaused } = require('./state');

// ---- *arr sweep: auto-recover stuck queue items + trigger search for missing monitored items ----
let arrSweepBusy = false;
// searchState is declared up by `declined` (must exist before loadState() runs). Tuning knobs:
const SEARCH_COOLDOWN_MS = 6 * 3600000;        // 6h between recovery re-searches of the same item
const SEARCH_FAIL_LIMIT = 4;                   // after this many fruitless searches → negative-cache it
const SEARCH_BLOCK_MS = 7 * 24 * 3600 * 1000;  // ...for a week (a manual /api/retry clears it sooner)
const SWEEP_MAX_ACTIVE_DL = 10;                // capacity guard: no new searches while this many download
const BLOCKLIST_TTL_MS = 12 * 3600 * 1000;    // 12h — blocklisted releases auto-cleared so a temporarily-dead swarm doesn't permanently poison the well
// The sweep is RECOVERY, not the first responder: Radarr/Sonarr already auto-search on request
// (Jellyseerr sets searchForMovie). The sweep must NOT re-search a freshly-requested item while
// that initial search is still resolving — that's what caused duplicate grabs AND the "Not found →
// found seconds later" flip-flop. So we track when an item was FIRST seen missing and only let the
// sweep act after RECOVERY_GRACE. The UI shows "Searching…" (not the alarming "Not found") until
// NOTFOUND_GRACE, covering normal grab latency.
const RECOVERY_GRACE_MS = 2 * 3600000;         // 2h: leave a missing item to *arr's own search first
const NOTFOUND_GRACE_MS = 20 * 60000;          // 20min: show "Searching…" before "Not found" in the UI
const RECENT_RELEASE_WINDOW_MS = 14 * 86400000; // 14 days — movies this new may not have torrents yet
const RECENT_RELEASE_GRACE_MS = 30 * 60000;    // 30 min grace (vs 2h) — recent releases get searched sooner
const RECENT_RELEASE_BLOCK_MS = 1 * 86400000;  // 1 day block (vs 7d) — torrent may appear any time
// firstMissing bookkeeping shared by buildDownloads (UI) and arrSweep (recovery). Starts the clock
// the first time an item is seen missing; cleared once it has a file / queue / torrent again.
function noteMissing(app, id) {
  const k = `${app}:${id}`; const st = searchState.get(k) || {};
  if (!st.firstMissing) {
    st.firstMissing = Date.now();
    searchState.set(k, st);
    metrics.emitEvent('missing_start', { ap: app, id });
  }
  return st.firstMissing;
}
function noteResolved(app, id) {  // item now has file/queue/torrent → reset the missing clock
  const k = `${app}:${id}`; const st = searchState.get(k);
  if (st && st.firstMissing) {
    st.firstMissing = 0;
    searchState.set(k, st);
    metrics.emitEvent('missing_clear', { ap: app, id });
  }
}
function isRecentRelease(item) {
  const dates = [item.inCinemas, item.physicalRelease, item.digitalRelease].filter(Boolean);
  if (!dates.length) return false;
  const newest = Math.max(...dates.map(d => new Date(d).getTime()));
  return Date.now() - newest < RECENT_RELEASE_WINDOW_MS;
}
function touchSearchState(app, id, patch) {
  const k = `${app}:${id}`;
  const st = searchState.get(k) || {};
  Object.assign(st, patch);
  searchState.set(k, st);
  return st;
}
const DL_STATES = new Set(['downloading', 'stalledDL', 'metaDL', 'forcedDL', 'queuedDL', 'checkingDL', 'allocating']);
const searchKeyClear = (app, id) => searchState.delete(`${app}:${id}`); // manual retry overrides cooldown+block
// The specific episodes of a Sonarr series that still need a file: monitored, aired (or with no
// known air date), and not already on disk. This is what we hand to EpisodeSearch so a season with
// no pack fills in episode-by-episode. Returns [] on any error (skip this series this pass).
async function missingEpisodes(seriesId) {
  let eps;
  try { eps = await arrGet('sonarr', `/episode?seriesId=${seriesId}`, 8000); }
  catch { return []; }
  const now = Date.now();
  return (Array.isArray(eps) ? eps : [])
    .filter((e) => !e.hasFile && e.monitored && (!e.airDateUtc || new Date(e.airDateUtc).getTime() <= now))
    .map((e) => ({
      id: e.id,
      seasonNumber: e.seasonNumber,
      episodeNumber: e.episodeNumber,
      title: e.title || '',
    }));
}
const SEARCH_PROBE_INITIAL_MS = 12000;
const SEARCH_PROBE_RETRY_MS = 15000;
const SEARCH_PROBE_MAX_AGE_MS = 120000;
const SEARCH_PROBE_MAX_ATTEMPTS = 5;
const searchProbeTimers = new Map();

const normSearchText = (s) => String(s || '').toLowerCase().replace(/['’]/g, '').replace(/[._:()\-]/g, ' ').replace(/\s+/g, ' ').trim();
const searchTokens = (s) => normSearchText(s).split(' ').filter((t) => t.length > 1);

function searchProbeMatchesTarget(probe, rec) {
  if (!probe || !rec || !rec.data) return false;
  const source = probe.app === 'radarr' ? 'Radarr' : 'Sonarr';
  if (String(rec.data.source || '') !== source) return false;
  const query = normSearchText(rec.data.query || '');
  if (!query) return false;
  const probeText = normSearchText(probe.query || probe.title || '');
  const tokens = probe.tokens || [];
  if (probe.mode === 'EpisodeSearch' && String(rec.data.queryType || '').toLowerCase() !== 'tvsearch') return false;
  if (probe.mode === 'MoviesSearch' && String(rec.data.queryType || '').toLowerCase() === 'tvsearch') return false;
  if (probeText && (query === probeText || query.includes(probeText) || probeText.includes(query))) return true;
  if (tokens.length && tokens.every((t) => query.includes(t))) return true;
  return false;
}

function summarizeSearchOutcome(probe, stats) {
  const { hits, queries, errors, hitIndexers, failedIndexers, zeroHitIndexers, topHitIndexers } = stats;
  const hitCount = topHitIndexers.length;
  const zeroCount = zeroHitIndexers.length;
  if (errors > 0 && hits > 0) {
    const good = hitIndexers.slice(0, 3).join(', ');
    const bad = failedIndexers.slice(0, 3).join(', ');
    return {
      kind: 'partial',
      summary: `upstream found ${hits} hit${hits === 1 ? '' : 's'} but ${errors} indexer${errors === 1 ? '' : 's'} errored${good ? ` (${good})` : ''}${bad ? `; errors: ${bad}` : ''}`,
    };
  }
  if (errors > 0) {
    const names = failedIndexers.slice(0, 3).join(', ');
    return {
      kind: 'error',
      summary: names ? `upstream error from ${names}` : 'upstream indexer error',
    };
  }
  if (hits > 0) {
    const names = hitIndexers.slice(0, 3).join(', ');
    return {
      kind: 'found',
      summary: `upstream found ${hits} hit${hits === 1 ? '' : 's'} across ${hitCount} indexer${hitCount === 1 ? '' : 's'}${names ? ` (${names})` : ''}`,
    };
  }
  if (queries > 0) {
    const names = zeroCount ? zeroHitIndexers.slice(0, 3).join(', ') : '';
    return {
      kind: 'empty',
      summary: `upstream returned 0 hits from ${queries} query${queries === 1 ? '' : 'ies'}${names ? ` (${names})` : ''}`,
    };
  }
  return { kind: 'pending', summary: 'search dispatched; waiting for Prowlarr history' };
}

function probeSearchSeasons(probe, st) {
  const seasons = new Set();
  const fromProbe = Array.isArray(probe && probe.seasons) ? probe.seasons : [];
  for (const s of fromProbe) {
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) seasons.add(n);
  }
  const episodeCodes = (st && st.lastSearchEpisodes) || [];
  for (const code of episodeCodes) {
    const m = String(code || '').match(/S(\d{2})E(\d{2})/i);
    if (m) seasons.add(Number(m[1]));
  }
  return [...seasons].sort((a, b) => a - b);
}

function summarizeReleaseDecision(rows) {
  const rels = Array.isArray(rows) ? rows : [];
  const rejected = [];
  const accepted = [];
  const reasonCounts = new Map();
  for (const r of rels) {
    const reasons = Array.isArray(r && r.rejections) && r.rejections.length
      ? r.rejections.map((x) => String(x || '').trim()).filter(Boolean)
      : (r && r.rejected ? ['rejected'] : []);
    if (r && r.rejected) {
      rejected.push(r);
      for (const reason of reasons) reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    } else if (r) {
      accepted.push(r);
    }
  }
  const sortByScore = (a, b) => (Number(b.customFormatScore) || 0) - (Number(a.customFormatScore) || 0)
    || (Number(b.seeders) || 0) - (Number(a.seeders) || 0)
    || String(a.title || a.sourceTitle || '').localeCompare(String(b.title || b.sourceTitle || ''));
  accepted.sort(sortByScore);
  rejected.sort(sortByScore);
  const reasonSummary = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([reason, count]) => `${reason} (${count})`)
    .join('; ');
  const bestAccepted = accepted[0] || null;
  const bestRejected = rejected[0] || null;
  if (accepted.length) {
    return {
      kind: 'accepted',
      summary: `Sonarr has ${accepted.length} acceptable release${accepted.length === 1 ? '' : 's'}${bestAccepted ? `; best is "${bestAccepted.title || bestAccepted.sourceTitle || 'candidate'}"` : ''}`,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      bestAccepted,
      bestRejected,
      reasons: reasonSummary,
    };
  }
  if (rejected.length) {
    const bestLabel = bestRejected ? (bestRejected.title || bestRejected.sourceTitle || 'candidate') : 'candidate';
    return {
      kind: 'rejected',
      summary: `Sonarr rejected all ${rejected.length} candidate${rejected.length === 1 ? '' : 's'}${reasonSummary ? `; top reasons: ${reasonSummary}` : ''}${bestRejected ? `; best rejected was "${bestLabel}"` : ''}`,
      acceptedCount: 0,
      rejectedCount: rejected.length,
      bestAccepted: null,
      bestRejected,
      reasons: reasonSummary,
    };
  }
  return {
    kind: 'none',
    summary: 'Sonarr returned no release candidates to evaluate',
    acceptedCount: 0,
    rejectedCount: 0,
    bestAccepted: null,
    bestRejected: null,
    reasons: '',
  };
}

// Clean a probe title ("Planet Earth (2006) — Seasons 1, 1, …") into a plain raw-search query
// ("planet earth 2006") and pull out the year for match-scoring.
function cleanSearchQuery(rawTitle) {
  const base = String(rawTitle || '').split(' — ')[0].trim();       // drop the " — Seasons …" suffix
  const ym = base.match(/(19|20)\d{2}/);
  const query = base.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  return { query, year: ym ? ym[0] : null };
}
const hasSeasonMarker = (t) => /s\d{1,2}e\d{1,3}|s\d{1,2}\b|season\s*\d+|\d+x\d+/i.test(String(t || ''));

// Mobile-first hint formatting: phones are the primary device, so row hints must be SHORT. Full
// detail stays in the event log / state for scripts. Collapse a verbose *arr rejection phrase to a
// couple of words.
function shortReason(r) {
  const s = String(r || '');
  if (/wrong series|unknown series|unable to identify/i.test(s)) return 'wrong/unknown series';
  if (/not enough seeders|no seeders/i.test(s)) return 'dead swarm';
  if (/meets cutoff|equal or higher preference/i.test(s)) return 'already have as good';
  if (/not wanted in profile/i.test(s)) return 'quality not allowed';
  if (/wasn.t requested|wrong season/i.test(s)) return 'season/episode mismatch';
  return s.replace(/\s*\(\d+\)\s*$/, '').replace(/:.*$/, '').trim().slice(0, 24);
}
// Truncate any free-text hint to a phone-friendly length.
const clampHint = (s, n = 68) => { const t = String(s || '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// THE SEARCH GAP: releases that are healthy upstream (raw Prowlarr text search) but never became
// Sonarr candidates — e.g. year-named full-series packs with no S01 marker, which structured
// tvsearch drops before the rejection list. `candidates` is Sonarr's /release set (to diff against).
async function probeSearchGap(rawTitle, candidates) {
  const { query, year } = cleanSearchQuery(rawTitle);
  if (!query) { console.log(`probeSearchGap: "${rawTitle}" → null (empty query)`); return null; }
  const titleTokens = searchTokens(query.replace(/(19|20)\d{2}/, '')); // series-name tokens, sans year
  let results = null;
  try {
    const url = `${HOST.prowlarr}/api/v1/search?query=${encodeURIComponent(query)}&type=search&limit=100`;
    results = await tfetchJson(url,
      { headers: { 'X-Api-Key': cfg.PROWLARR_KEY || '' } }, 25000).catch((e) => { console.log(`probeSearchGap: tfetchJson failed for "${query}": ${e?.message || e}`); return null; });
  } catch (e) { console.log(`probeSearchGap: catch for "${query}": ${e?.message || e}`); }
  if (!Array.isArray(results)) { console.log(`probeSearchGap: "${query}" → ${results ? 'non-array result' : 'null'} (candidates=${Array.isArray(candidates) ? candidates.length : 'N/A'})`); return null; }
  console.log(`probeSearchGap: "${query}" → ${results.length} raw results, candidates=${Array.isArray(candidates) ? candidates.length : 'N/A'}`);
  const candTitles = new Set((Array.isArray(candidates) ? candidates : [])
    .map((c) => normSearchText(c.title || c.sourceTitle || '')));
  const isTv = (r) => (r.categories || []).some((c) => { const n = Number(c && (c.id != null ? c.id : c)); return n >= 5000 && n < 6000; });
  const matchesSeries = (t) => { const nt = normSearchText(t); return titleTokens.every((tok) => nt.includes(tok)) && (!year || nt.includes(year)); };
  const filtered = results.filter((r) => Number(r.seeders) >= 1);
  const tvFiltered = filtered.filter((r) => isTv(r));
  const seriesFiltered = tvFiltered.filter((r) => matchesSeries(r.title));
  const misses = seriesFiltered.filter((r) => !candTitles.has(normSearchText(r.title)));
  console.log(`probeSearchGap: "${query}" → seeders>=1:${filtered.length} isTv:${tvFiltered.length} matchesSeries:${seriesFiltered.length} notInCandidates:${misses.length}`);
  if (!misses.length) { console.log(`probeSearchGap: "${query}" → null (no misses after all filters)`); return null; }
  misses.sort((a, b) => {
    // Grabbable releases (magnet guid or infoHash) sort above non-grabbable ones regardless of
    // seed count. A release with no magnet and no infoHash can only be grabbed via Prowlarr's
    // broken POST /api/v1/search path, so prefer the ones we can add to qBittorrent directly.
    const grabbable = (r) => String(r.guid || '').startsWith('magnet:') || !!r.infoHash;
    const ga = grabbable(a) ? 1 : 0, gb = grabbable(b) ? 1 : 0;
    if (ga !== gb) return gb - ga;
    const sa = Number(b.seeders) || 0, sb = Number(a.seeders) || 0;
    if (sa !== sb) return sa - sb;
    // Same seeder count: prefer releases with larger size (better quality).
    return (Number(b.size) || 0) - (Number(a.size) || 0);
  });
  const best = misses[0];
  const reasonClass = !hasSeasonMarker(best.title) ? 'no-season-marker' : 'not-a-candidate';
  return {
    query,
    upstreamHealthy: misses.length,
    reasonClass,
    best: {
      title: best.title,
      seeders: Number(best.seeders) || 0,
      indexer: best.indexer || null,
      guid: best.guid || null,
      indexerId: best.indexerId != null ? best.indexerId : null,
      magnetUrl: best.magnetUrl || null,
      infoHash: best.infoHash || null,
      size: best.size || null,
      downloadUrl: best.downloadUrl || null,
    },
    all: misses.map((r) => ({
      title: r.title,
      seeders: Number(r.seeders) || 0,
      size: r.size || 0,
      indexer: r.indexer || null,
      guid: r.guid || null,
      infoHash: r.infoHash || null,
      magnetUrl: r.magnetUrl || null,
      indexerId: r.indexerId != null ? r.indexerId : null,
      downloadUrl: r.downloadUrl || null,
    })),
    summary: `${misses.length} healthy release${misses.length === 1 ? '' : 's'} exist in raw search but were not season-search candidates (${reasonClass}); best: "${best.title}" (${Number(best.seeders) || 0} seeders)`,
  };
}

// Add a gap release straight to qBittorrent's queue. The release may come from any indexer;
// TPB results carry a magnet `guid`; for others we construct one from `infoHash`.
async function grabGapRelease(rel, category = 'sonarr') {
  let addUrl = null;
  let method = null;
  if (rel.guid && String(rel.guid).startsWith('magnet:')) {
    addUrl = rel.guid;
    method = 'magnet';
  } else if (rel.infoHash) {
    addUrl = `magnet:?xt=urn:btih:${String(rel.infoHash).toUpperCase()}&dn=${encodeURIComponent(String(rel.title || 'unknown'))}`;
    method = 'infohash';
  }
  if (!addUrl) throw new Error('gap release has no magnet guid or infoHash');
  const params = new URLSearchParams({ urls: addUrl, category, tags: 'manual-force-grab' });
  const r = await qbit.fetch('/api/v2/torrents/add', { method: 'POST', body: params }, 20000);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`qBittorrent add → HTTP ${r.status}${text ? ': ' + text.slice(0, 200) : ''}`);
  }
  // Lowercase ALWAYS: qBittorrent reports hashes lowercase and every consumer (buildDownloads,
  // watchdog, stall-recovery) looks up with t.hash.toLowerCase(). A release-supplied rel.infoHash
  // is often UPPERCASE — storing it as the forceGrabImport key uppercased meant every `.has(h)`
  // missed, so the guard/skip never engaged and the generic importer deleted the force-grab.
  const infoHash = String(rel.infoHash || (rel.guid || '').replace(/^magnet:\?xt=urn:btih:/i, '').split('&')[0]).toLowerCase();
  return { ok: true, method, addUrl, infoHash: infoHash || null };
}

function clearSearchProbe(key) {
  const t = searchProbeTimers.get(key);
  if (t) clearTimeout(t);
  searchProbeTimers.delete(key);
}

function trackSearchDispatch(app, item, meta = {}) {
  const key = `${app}:${item.id}`;
  clearSearchProbe(key);
  const now = meta.searchAt || Date.now();
  const st = searchState.get(key) || {};
  const probe = {
    id: (st.searchProbe && st.searchProbe.id || 0) + 1,
    at: now,
    title: item.title,
    query: meta.query || item.title || '',
    mode: meta.mode || (app === 'radarr' ? 'MoviesSearch' : 'EpisodeSearch'),
    manual: !!meta.manual,
    attempts: 0,
    tokens: searchTokens(meta.query || item.title || ''),
  };
  Object.assign(st, {
    lastReason: meta.manual ? 'manual_retry' : 'search',
    lastAt: now,
    lastMode: probe.mode,
    lastSearchTitle: item.title,
    lastSearchQuery: probe.query,
    lastOutcomeKind: meta.manual ? 'pending' : 'pending',
    lastOutcomeSummary: meta.manual ? 'manual retry in progress' : 'search in progress',
    lastOutcomeAt: now,
    searchProbe: probe,
  });
  if (meta.episodeCodes && meta.episodeCodes.length) st.lastSearchEpisodes = meta.episodeCodes;
  searchState.set(key, st);
  searchProbeTimers.set(key, setTimeout(() => probeSearchOutcome(app, item.id, probe.id), SEARCH_PROBE_INITIAL_MS));
  return st;
}

async function probeSearchOutcome(app, id, probeId) {
  const key = `${app}:${id}`;
  const st = searchState.get(key);
  if (!st || !st.searchProbe || st.searchProbe.id !== probeId) return;
  const probe = st.searchProbe;
  const age = Date.now() - probe.at;
  if (age > SEARCH_PROBE_MAX_AGE_MS) {
    // The probe never confirmed within its window (Prowlarr history never matched, or the
    // controller was restarted mid-probe and by the time we rehydrated it had aged out). Finalize
    // with an explicit terminal outcome so the row doesn't hang on "search in progress" forever.
    if (st.lastOutcomeKind === 'pending') {
      const summary = 'search dispatched; outcome unconfirmed (probe timed out)';
      Object.assign(st, { lastOutcomeKind: 'unknown', lastOutcomeSummary: summary, lastOutcomeAt: Date.now(), lastReason: 'search_unconfirmed' });
      searchState.set(key, st);
      persistState();
      metrics.emitEvent('search_outcome', { ap: app, id, ti: probe.title, mode: probe.mode, manual: probe.manual, kind: 'unknown', summary, attempt: probe.attempts || 0 });
    }
    clearSearchProbe(key);
    return;
  }
  let history = null;
  let indexers = null;
  try {
    [history, indexers] = await Promise.all([
      tfetchJson(`${HOST.prowlarr}/api/v1/history?pageSize=200&sortKey=date&sortDirection=descending`, { headers: { 'X-Api-Key': cfg.PROWLARR_KEY || '' } }, 8000).catch(() => null),
      cachedFetch('indexers:snapshot', 60000, getIndexerSnapshot, { degradedNames: [] }).catch(() => null),
    ]);
  } catch { /* best-effort */ }

  const rows = (history && history.records) || [];
  const idxById = new Map(((indexers && indexers.indexers) || []).map((ix) => [ix.id, ix.name]));
  const matched = rows.filter((r) => r.eventType === 'indexerQuery'
    && r.date
    && new Date(r.date).getTime() >= probe.at - 5000
    && new Date(r.date).getTime() <= Date.now() + 5000
    && searchProbeMatchesTarget(probe, r));

  if (!matched.length) {
    const nextAttempt = (probe.attempts || 0) + 1;
    probe.attempts = nextAttempt;
    st.searchProbe = probe;
    searchState.set(key, st);
    metrics.emitEvent('search_probe', { ap: app, id, ti: probe.title, mode: probe.mode, manual: probe.manual, attempt: nextAttempt, status: 'pending' });
    if (nextAttempt < SEARCH_PROBE_MAX_ATTEMPTS && age < SEARCH_PROBE_MAX_AGE_MS) {
      clearSearchProbe(key);
      searchProbeTimers.set(key, setTimeout(() => probeSearchOutcome(app, id, probeId), SEARCH_PROBE_RETRY_MS));
      return;
    }
    const summary = 'search dispatched; no matching Prowlarr history yet';
    Object.assign(st, { lastOutcomeKind: 'pending', lastOutcomeSummary: summary, lastOutcomeAt: Date.now() });
    searchState.set(key, st);
    persistState();
    metrics.emitEvent('search_outcome', { ap: app, id, ti: probe.title, mode: probe.mode, manual: probe.manual, kind: 'pending', summary, attempt: nextAttempt });
    clearSearchProbe(key);
    return;
  }

  const statsByIndexer = new Map();
  const indexerErrors = [];
  let hits = 0;
  let errors = 0;
  for (const r of matched) {
    const name = idxById.get(r.indexerId) || `indexer-${r.indexerId}`;
    const qRes = Number(r.data && r.data.queryResults) || 0;
    const cur = statsByIndexer.get(name) || { queries: 0, hits: 0, errors: 0, maxElapsed: 0 };
    cur.queries += 1;
    cur.hits += qRes;
    cur.errors += r.successful === false ? 1 : 0;
    cur.maxElapsed = Math.max(cur.maxElapsed, Number(r.data && r.data.elapsedTime) || 0);
    statsByIndexer.set(name, cur);
    hits += qRes;
    if (r.successful === false) {
      errors += 1;
      indexerErrors.push({
        indexer: name,
        query: r.data && r.data.query || null,
        reason: r.data && (r.data.errorMessage || r.data.message || r.data.error || r.data.exception || r.data.responseMessage) || 'indexer query failed',
        status: r.data && (r.data.statusCode || r.data.status || r.data.httpStatus) || null,
        url: r.data && r.data.url || null,
      });
    }
  }
  const hitIndexers = [];
  const failedIndexers = [];
  const zeroHitIndexers = [];
  const topHitIndexers = [];
  for (const [name, stat] of statsByIndexer) {
    if (stat.hits > 0) {
      hitIndexers.push(name);
      topHitIndexers.push(name);
    } else {
      zeroHitIndexers.push(name);
    }
    if (stat.errors > 0) failedIndexers.push(name);
  }
  const outcome = summarizeSearchOutcome(probe, { hits, queries: matched.length, errors, hitIndexers, failedIndexers, zeroHitIndexers, topHitIndexers });
  const details = {
    queries: matched.length,
    hits,
    errors,
    indexers: [...statsByIndexer.entries()].map(([name, stat]) => ({ name, ...stat })),
    indexerErrors,
  };
  let decision = null;
  let gap = null;
  if (app === 'sonarr' && outcome.kind !== 'pending') {
    let releases = [];
    try {
      const seasons = probeSearchSeasons(probe, st);
      for (const sn of seasons.length ? seasons : [1]) {
        try {
          const rows = await arrGet('sonarr', `/release?seriesId=${id}&seasonNumber=${sn}`, 30000);
          if (Array.isArray(rows)) releases.push(...rows);
        } catch { /* per-season query best-effort */ }
      }
      decision = summarizeReleaseDecision(releases);
    } catch { /* best-effort */ }
    // Nothing grabbable? Check whether healthy releases exist upstream that never became candidates.
    if (!decision || decision.acceptedCount === 0) {
      // The probe title may lack a year (Sonarr series title = "Planet Earth" not "Planet Earth (2006)").
      // A bare "Planet Earth" Prowlarr query is too broad and times out → gap probe fails silently.
      // Fetch the year from Sonarr and append it so the query is fast + targeted.
      let gapTitle = probe.title;
      if (app === 'sonarr' && !/(19|20)\d{2}/.test(gapTitle)) {
        try {
          const series = await arrGet(app, `/series/${id}`, 6000);
          if (series && series.year) gapTitle = `${gapTitle} ${series.year}`;
        } catch { /* best-effort */ }
      }
      try { gap = await probeSearchGap(gapTitle, releases); } catch (e) { console.log(`probeSearchOutcome: gap probe threw: ${e?.message || e}`); }
      if (gap) {
        console.log(`probeSearchOutcome: gap found for "${probe.title}" (${id}) — "${gap.best.title}" (${gap.best.seeders} seeders, ${gap.reasonClass})`);
      } else {
        console.log(`probeSearchOutcome: gap probe returned null for "${probe.title}" (${id}) — Prowlarr returned no matching releases (check indexers, query timeouts)`);
        // If gap is null, the correct releases may be IN the candidate set but were
        // rejected by Sonarr's parser (false negative, like "Carl Sagans Cosmos 1980...").
        // Retry with empty candidates (same as force-grab endpoint).
        if (app === 'sonarr') {
          console.log(`probeSearchOutcome: retrying with empty candidates (rejected-false-negative fallback) for "${probe.title}" (${id})`);
          try { gap = await probeSearchGap(gapTitle, []); } catch (e) { console.log(`probeSearchOutcome: fallback gap probe threw: ${e?.message || e}`); }
          if (gap) {
            gap.reasonClass = 'rejected-false-negative';
            gap.summary = gap.summary.replace(/not.*candidates/, 'correct release was rejected by Sonarr parser');
            console.log(`probeSearchOutcome: false-negative gap found for "${probe.title}" (${id}) — "${gap.best.title}" (${gap.best.seeders} seeders)`);
          } else {
            console.log(`probeSearchOutcome: false-negative fallback also returned null for "${probe.title}" (${id})`);
          }
        }
      }
    } else {
      console.log(`probeSearchOutcome: skipping gap probe for "${probe.title}" (${id}) — decision=${decision.kind} accepted=${decision.acceptedCount}`);
    }
  }
  Object.assign(st, {
    lastOutcomeKind: decision && decision.kind === 'rejected' ? 'rejected' : outcome.kind,
    lastOutcomeSummary: decision && decision.summary ? decision.summary : outcome.summary,
    lastOutcomeAt: Date.now(),
    lastOutcomeDetails: details,
    lastOutcomeDecision: decision,
    lastSearchGap: gap,
    lastReason: decision && decision.kind === 'rejected'
      ? 'search_rejected'
      : outcome.kind === 'error'
        ? 'search_failed'
        : outcome.kind === 'empty'
          ? 'search_empty'
          : 'search_found',
  });
  searchState.set(key, st);
  persistState();
  metrics.emitEvent('search_outcome', {
    ap: app,
    id,
    ti: probe.title,
    mode: probe.mode,
    manual: probe.manual,
    kind: outcome.kind,
      summary: outcome.summary,
      queries: matched.length,
      hits,
      errors,
      indexers: [...statsByIndexer.keys()],
      indexerErrors,
    });
  if (decision) {
    metrics.emitEvent('search_decision', {
      ap: app,
      id,
      ti: probe.title,
      mode: probe.mode,
      manual: probe.manual,
      kind: decision.kind,
      summary: decision.summary,
      accepted: decision.acceptedCount,
      rejected: decision.rejectedCount,
      reasons: decision.reasons || null,
      indexerErrors,
    });
    if (decision.kind === 'rejected') {
      metrics.emitEvent('search_reject', {
        ap: app,
        id,
        ti: probe.title,
        mode: probe.mode,
        manual: probe.manual,
        summary: decision.summary,
        reasons: decision.reasons || null,
        indexerErrors,
      });
    }
  }
  if (gap) {
    metrics.emitEvent('search_gap', {
      ap: app,
      id,
      ti: probe.title,
      query: gap.query,
      upstreamHealthy: gap.upstreamHealthy,
      reasonClass: gap.reasonClass,
      best: gap.best && gap.best.title,
      seeders: gap.best && gap.best.seeders,
      indexer: gap.best && gap.best.indexer,
    });
  }
  clearSearchProbe(key);
}

// Probe timers live only in memory (searchProbeTimers), but the probe object itself rides along in
// searchState → state.json. So a controller restart mid-search would leave st.searchProbe persisted
// with NO timer to resolve it — the row would show "search in progress" forever. On boot, walk the
// restored state and re-arm (or finalize) any probe that was still pending when we went down.
function rehydrateSearchProbes() {
  const now = Date.now();
  for (const [key, st] of searchState) {
    const probe = st && st.searchProbe;
    if (!probe || st.lastOutcomeKind !== 'pending') continue;
    const [app, idStr] = key.split(':');
    const id = Number(idStr);
    if (!app || !Number.isFinite(id)) continue;
    const age = now - (probe.at || 0);
    if (age > SEARCH_PROBE_MAX_AGE_MS || (probe.attempts || 0) >= SEARCH_PROBE_MAX_ATTEMPTS) {
      // Aged out while we were down — finalize so the UI doesn't hang on "pending".
      const summary = 'search dispatched; outcome unconfirmed (controller restarted mid-search)';
      Object.assign(st, { lastOutcomeKind: 'unknown', lastOutcomeSummary: summary, lastOutcomeAt: now, lastReason: 'search_unconfirmed' });
      searchState.set(key, st);
      metrics.emitEvent('search_outcome', { ap: app, id, ti: probe.title, mode: probe.mode, manual: probe.manual, kind: 'unknown', summary, attempt: probe.attempts || 0 });
      continue;
    }
    // Still within its window — re-arm the timer. Give the *arr/Prowlarr stack a moment to come up
    // after the restart before we poll history.
    clearSearchProbe(key);
    searchProbeTimers.set(key, setTimeout(() => probeSearchOutcome(app, id, probe.id), SEARCH_PROBE_INITIAL_MS));
  }
  persistState();
}
async function sweepBlocklist() {
  for (const app of ['radarr', 'sonarr']) {
    try {
      const bl = await arrGet(app, '/blocklist?pageSize=200', 10000);
      const cutoff = Date.now() - BLOCKLIST_TTL_MS;
      const expired = (bl.records || []).filter((r) => new Date(r.date).getTime() < cutoff).map((r) => r.id);
      if (!expired.length) continue;
      await tfetch(`${arrOf(app).base}/blocklist/bulk`, { method: 'DELETE', headers: { 'X-Api-Key': arrOf(app).key, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: expired }) }, 15000);
      console.log(`sweepBlocklist: cleared ${expired.length} expired ${app} blocklist entry/entries (≥${Math.round(BLOCKLIST_TTL_MS / 3600000)}h old)`);
    } catch { /* best-effort */ }
  }
}
async function arrSweep() {
  if (isMasterPaused() || arrSweepBusy) return;               // Movie Mode — no searches/grabs/recovery
  arrSweepBusy = true;
  try {
    await sweepBlocklist();                                // clear expired blocklist entries before processing queue
    for (const app of ['radarr', 'sonarr']) {
      let queue = [];
      try { const qr = await arrGet(app, '/queue?pageSize=200&includeUnknownMovieItems=true', 8000); queue = qr.records || []; }
      catch { continue; }

      const stuckIds = [];
      const stalledHashes = [];
      for (const qe of queue) {
        const id = qe.movieId || qe.seriesId;
        if (qe.trackedDownloadState === 'importBlocked' && qe.errorMessage && /missing file/i.test(qe.errorMessage)) {
          stuckIds.push({ id, queueId: qe.id, blocklist: false });   // good release, import glitch — don't blocklist
        }
        if ((qe.status === 'queued' || qe.status === 'paused') && qe.size === 0 && qe.sizeleft === 0 && qe.errorMessage && /metadata/i.test(qe.errorMessage)) {
          // Dead magnet: couldn't even fetch metadata (0 seeds). Blocklist it so *arr grabs a DIFFERENT
          // release next search instead of re-grabbing the same corpse (that loop = the "Not found" churn).
          stuckIds.push({ id, queueId: qe.id, blocklist: true });
          if (qe.downloadId) stalledHashes.push(qe.downloadId);
        }
        // Terminal import rejections: a COMPLETED download *arr refuses to import ("Not an
        // upgrade…", "Sample") will never improve — it sits in the queue wasting disk and a
        // slot forever (audit found 4 wedged for days). Remove + blocklist so it's never
        // re-grabbed. Transient states (still downloading, missing-file glitch) don't match.
        const doneDl = (qe.status || '').toLowerCase() === 'completed'
          || (qe.trackedDownloadState === 'importPending' || qe.trackedDownloadState === 'importBlocked');
        // EXEMPT in-flight gpuVerify zero-gap swaps: their replacement will briefly sit at
        // "not an upgrade" (old file still on disk by design) until Phase 1 clears the old
        // copy — cleaning it up here would kill the upgrade mid-swap.
        const isPendingSwap = app === 'radarr' && qe.movieId != null && gpuPending.has(qe.movieId);
        if (doneDl && !isPendingSwap && (qe.trackedDownloadStatus || '').toLowerCase() === 'warning') {
          const msgs = ((qe.statusMessages || []).flatMap((m) => m.messages || []).join(' ') + ' ' + (qe.errorMessage || '')).toLowerCase();
          if (/not an upgrade|not a custom format upgrade|\bsample\b|matched to movie by id|manual import required/i.test(msgs)) {
            stuckIds.push({ id, queueId: qe.id, blocklist: true });
          }
        }
      }

      for (const s of stuckIds) {
        try {
          await arrDelete(app, `/queue/${s.queueId}?removeFromClient=true&blocklist=${s.blocklist}`);
          console.log(`arrSweep: removed stuck queue item id=${s.id} from ${app}${s.blocklist ? ' (blocklisted dead release)' : ''}`);
          metrics.emitEvent('queue_clean', { ap: app, id: s.id, blocklisted: !!s.blocklist });
        } catch (e) { console.log(`arrSweep: failed to remove queue item id=${s.id} from ${app} — ${e.message || e}`); }
      }

      if (stalledHashes.length) {
        try {
          const body = new URLSearchParams({ hashes: stalledHashes.join('|'), deleteFiles: 'true' });
          await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
          console.log(`arrSweep: removed ${stalledHashes.length} stalled torrent(s) from qBittorrent`);
          metrics.emitEvent('stall_clean', { count: stalledHashes.length });
        } catch (e) { console.log(`arrSweep: failed to remove stalled torrents — ${e.message || e}`); }
      }

      // Map this app's qBittorrent torrents to their *arr item id (via queue + history download
      // hashes). This is the dedup / already-downloading guard the old sweep lacked: it decided
      // what to search from the *arr QUEUE alone, which can list fewer items than qBittorrent
      // actually holds — so it re-searched titles that were already downloading, and Radarr then
      // grabbed a second, different release. That, plus the (formerly in-memory) cooldown being
      // wiped on every restart, is what produced the duplicate-download storm.
      let torrents = [];
      try { torrents = await getQbitTorrents(); } catch { /* qbit down — skip dedup + guard this pass */ }
      const hashToId = new Map();
      for (const q of queue) if (q.downloadId) hashToId.set(q.downloadId.toLowerCase(), q.movieId || q.seriesId);
      try {
        for (const r of ((await arrGet(app, '/history?pageSize=500&sortKey=date&sortDirection=descending')).records || [])) {
          const h = (r.downloadId || '').toLowerCase();
          if (h && (r.movieId || r.seriesId) != null && !hashToId.has(h)) hashToId.set(h, r.movieId || r.seriesId);
        }
      } catch { /* history optional */ }

      let activeDl = 0;
      const inflightById = new Map();   // movieId -> [in-flight torrents] (dedup candidates, radarr only)
      const completedById = new Map();  // movieId -> [completed/seeding torrents] (supersede cleanup, radarr only)
      const hasTorrentIds = new Set();  // arrId -> a real (non-orphan) torrent exists → don't re-search
      for (const t of torrents) {
        const state = t.state || '';
        const inflight = DL_STATES.has(state);
        if (inflight) activeDl++;                                // global active-download count
        if (torrentApp(t) !== app) continue;
        const id = hashToId.get((t.hash || '').toLowerCase());
        if (id == null) continue;
        if (state !== 'missingFiles') hasTorrentIds.add(id);     // present/downloading/seeding — already handled
        if (inflight) {
          if (!inflightById.has(id)) inflightById.set(id, []);
          inflightById.get(id).push(t);
        } else if ((t.progress || 0) >= 1 && state !== 'missingFiles') {
          if (!completedById.has(id)) completedById.set(id, []);
          completedById.get(id).push(t);
        }
      }

      // Duplicate resolution — MOVIES ONLY, and only among IN-FLIGHT (downloading) torrents.
      //   • A Sonarr series legitimately holds many torrents (one per season/episode), so grouping
      //     by seriesId would wrongly flag whole seasons as "duplicates" — never dedup TV here.
      //   • Completed/seeding library torrents and orphaned missingFiles are never touched, so we
      //     can't delete real media. Only a genuine concurrent download race (≥2 in-flight torrents
      //     for the same movie) is resolved: keep the most-progressed, delete the rest (partial data).
      if (app === 'radarr') {
        for (const [id, ts] of inflightById) {
          if (ts.length < 2) continue;
          const sorted = ts.slice().sort((a, b) => (b.progress || 0) - (a.progress || 0) || (a.size || 0) - (b.size || 0));
          const losers = sorted.slice(1).map((t) => t.hash).filter(Boolean);
          if (!losers.length) continue;
          try {
            await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ hashes: losers.join('|'), deleteFiles: 'true' }) });
            console.log(`arrSweep: radarr id=${id} had ${ts.length} in-flight torrents — kept "${sorted[0].name}", removed ${losers.length} duplicate download(s)`);
            metrics.emitEvent('dedup', { ap: 'radarr', id, kept: sorted[0].name, removed: losers.length });
          } catch (e) { console.log(`arrSweep: duplicate cleanup failed for radarr id=${id} — ${e.message || e}`); }
        }
        // Superseded copies: a movie with >1 COMPLETED torrent (old pre-upgrade/redownload copy still
        // seeding + the current one). Keep the newest, delete the rest. Safe: the library file is a
        // separate/hard-linked copy, so removing the torrent's copy never deletes the movie from Jellyfin.
        for (const [id, ts] of completedById) {
          if (ts.length < 2) continue;
          const sorted = ts.slice().sort((a, b) => (b.completion_on || 0) - (a.completion_on || 0));  // newest first
          const losers = sorted.slice(1).map((t) => t.hash).filter(Boolean);
          if (!losers.length) continue;
          try {
            await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ hashes: losers.join('|'), deleteFiles: 'true' }) });
            console.log(`arrSweep: radarr id=${id} had ${ts.length} completed torrents — kept newest "${sorted[0].name}", removed ${losers.length} superseded copy(ies)`);
            metrics.emitEvent('supersede', { ap: 'radarr', id, kept: sorted[0].name, removed: losers.length });
          } catch (e) { console.log(`arrSweep: superseded cleanup failed for radarr id=${id} — ${e.message || e}`); }
        }
      }
      const downloadingIds = hasTorrentIds;

      // Trigger search for monitored items with no file, not already queued, not already
      // downloading in qBittorrent, not within cooldown, and not negative-cached.
      let items = [];
      try {
        if (app === 'radarr') items = await arrGet('radarr', '/movie', 8000);
        else items = await arrGet('sonarr', '/series', 8000);
      } catch { continue; }

      const now = Date.now();
      const qIds = new Set(queue.map((q) => q.movieId || q.seriesId));
      const needSearch = [];
      for (const i of items) {
        // Sonarr: a series is "complete" only when every monitored, aired episode has a file.
        // The old `!!episodeFileCount` treated a series holding ANY file as done, so a partially
        // filled series (e.g. S1 present, S2–S4 missing) was cleared and NEVER recovered.
        const ss = app === 'sonarr' && i.statistics;
        const hasContent = app === 'radarr'
          ? !!i.hasFile
          : !!(ss && ss.episodeCount > 0 && ss.episodeFileCount >= ss.episodeCount);
        if (hasContent) { searchKeyClear(app, i.id); noteResolved(app, i.id); continue; }             // got it — clear all state
        if (i.monitored === false) continue;
        // Future release (Radarr): don't search for content that hasn't been released yet.
        if (app === 'radarr') {
          const fDates = [i.inCinemas, i.physicalRelease, i.digitalRelease].filter(Boolean);
          if (fDates.length && fDates.some(d => new Date(d).getTime() > now + 86400000)) continue;
        }
        if (qIds.has(i.id) || downloadingIds.has(i.id)) { noteResolved(app, i.id); continue; } // in flight — reset clock
        const firstMissing = noteMissing(app, i.id);                            // start/read the missing clock
        const isRR = app === 'radarr' && isRecentRelease(i);
        const st = searchState.get(`${app}:${i.id}`);
        if (st && st.blockedUntil && st.blockedUntil > now) {
          if (!st.lastOutcomeKind || st.lastOutcomeKind === 'pending') {
            touchSearchState(app, i.id, { lastReason: 'blocked', lastAt: now });
          }
          metrics.emitEvent('search_skip', { ti: i.title, ap: app, id: i.id, reason: 'blocked', fails: st.fails || 0, next: st.blockedUntil });
          continue;                                                               // negative-cached (no content)
        }
        if (now - firstMissing < (isRR ? RECENT_RELEASE_GRACE_MS : RECOVERY_GRACE_MS)) {
          // Grace applies to EVERY missing item, including never-searched ones. This is what makes
          // a controller restart safe: firstMissing resets to now on restart, so the whole missing
          // library sits in grace instead of triggering an immediate mass EpisodeSearch (which made
          // Sonarr re-grab everything — including wrong-language/duplicate releases — every restart).
          // Recent releases get a shorter grace (30 min vs 2h) since torrents may appear soon.
          if (!st || !st.lastOutcomeKind || st.lastOutcomeKind === 'pending') {
            touchSearchState(app, i.id, { lastReason: 'grace', lastAt: now });
          }
          metrics.emitEvent('search_skip', { ti: i.title, ap: app, id: i.id, reason: 'grace', next: firstMissing + (isRR ? RECENT_RELEASE_GRACE_MS : RECOVERY_GRACE_MS) });
          continue;                                                               // still *arr's own job — don't interfere
        }
        if (st && st.ts && now - st.ts < SEARCH_COOLDOWN_MS) {
          if (!st.lastOutcomeKind || st.lastOutcomeKind === 'pending') {
            touchSearchState(app, i.id, { lastReason: 'cooldown', lastAt: now });
          }
          metrics.emitEvent('search_skip', { ti: i.title, ap: app, id: i.id, reason: 'cooldown', next: st.ts + SEARCH_COOLDOWN_MS, fails: st.fails || 0 });
          continue;                                                               // already recovered recently
        }
        needSearch.push(i);
      }

      if (needSearch.length) {
        // Up to 8 recovery searches per 5-min sweep — gentle on indexers, and it does NOT gate on
        // how many are already downloading: qBittorrent's own max_active_downloads caps real
        // concurrency (extra grabs just queue), so a full missing-library backlog steadily fills in
        // instead of being starved whenever a handful of downloads are active (which stranded a pile
        // of requested movies at "Not found"). A grab storm is prevented by compact sizes + dedup +
        // the qBittorrent cap, not by refusing to search.
        const batch = needSearch.slice(0, 8);
        if (activeDl >= SWEEP_MAX_ACTIVE_DL) console.log(`arrSweep: ${activeDl} downloading; still searching ${batch.length} missing ${app} item(s) (qBittorrent caps concurrency)`);
        for (const item of batch) {
          const key = `${app}:${item.id}`;
          // Sonarr: resolve exactly which episodes still need grabbing BEFORE touching the fail
          // counter — if nothing is searchable (all missing episodes are unaired) we skip without
          // burning a "fail", so an airing show never gets negative-cached for episodes that
          // simply haven't come out yet.
          let episodeRefs = null;
          if (app === 'sonarr') {
            episodeRefs = await missingEpisodes(item.id);
            if (!episodeRefs.length) {
              touchSearchState(app, item.id, { lastReason: 'no_searchable_episodes', lastAt: now });
              metrics.emitEvent('search_skip', { ti: item.title, ap: app, id: item.id, reason: 'no_searchable_episodes' });
              continue;
            }
          }
          const st = searchState.get(key) || { ts: 0, fails: 0, blockedUntil: 0 };
          if (st.ts) st.fails = (st.fails || 0) + 1;   // a prior search left it with no content → it failed
          if (st.fails >= SEARCH_FAIL_LIMIT) {
            const rr = app === 'radarr' && isRecentRelease(item);
            const blockMs = rr ? RECENT_RELEASE_BLOCK_MS : SEARCH_BLOCK_MS;
            st.blockedUntil = now + blockMs;
            console.log(`arrSweep: ${app} "${item.title}" (${item.id}) searched ${st.fails}× with no grab — negative-caching ${rr ? '1d' : '7d'} (manual retry clears)`);
            metrics.emitEvent('block', { ti: item.title, ap: app, id: item.id, fails: st.fails, recent: rr || undefined });
          }
          try {
            if (app === 'radarr') {
              await arrPost(app, '/command', { name: 'MoviesSearch', movieIds: [item.id] }, 5000);
              st.ts = now;
              searchState.set(key, st);
              trackSearchDispatch(app, item, { searchAt: now, mode: 'MoviesSearch' });
              console.log(`arrSweep: triggered search for radarr "${item.title}" (${item.id})`);
              metrics.emitEvent('search', { ti: item.title, ap: app, id: item.id, mode: 'MoviesSearch', fails: st.fails || 0 });
            } else {
              // EpisodeSearch (NOT SeriesSearch): SeriesSearch/SeasonSearch only look for whole-season
              // PACKS, which airing shows usually lack — so those searches find nothing and the season
              // never fills in. EpisodeSearch with explicit episode IDs makes Sonarr grab the
              // individual-episode releases that actually exist, one per missing episode.
              const episodeIds = episodeRefs.map((e) => e.id);
              await arrPost(app, '/command', { name: 'EpisodeSearch', episodeIds }, 8000);
              const episodeCodes = episodeRefs.map((e) => `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}`);
              st.ts = now;
              searchState.set(key, st);
              trackSearchDispatch(app, item, { searchAt: now, mode: 'EpisodeSearch', episodeCodes });
              console.log(`arrSweep: triggered EpisodeSearch for sonarr "${item.title}" (${item.id}) — ${episodeIds.length} missing episode(s)`);
              metrics.emitEvent('search', { ti: item.title, ap: app, id: item.id, mode: 'EpisodeSearch', fails: st.fails || 0, eps: episodeCodes });
            }
          } catch (e) {
            touchSearchState(app, item.id, { lastReason: 'trigger_failed', lastError: String(e.message || e), lastAt: now });
            console.log(`arrSweep: search trigger failed for ${item.id} — ${e.message || e}`);
            metrics.emitEvent('search_skip', { ti: item.title, ap: app, id: item.id, reason: 'trigger_failed', error: String(e.message || e) });
          }
        }
        persistState();
      }
    }
  } catch (e) { console.log(`arrSweep: sweep failed — ${e.message || e}`); }
  finally { arrSweepBusy = false; }
}

function startSearchEngine() {
  setTimeout(rehydrateSearchProbes, 8000);  // after loadState() + a brief settle for the *arr stack
  setInterval(arrSweep, 300000); // every 5 min
  setTimeout(arrSweep, 30000);    // first run after 30s
}

module.exports = {
  SEARCH_COOLDOWN_MS, RECOVERY_GRACE_MS, NOTFOUND_GRACE_MS, RECENT_RELEASE_GRACE_MS,
  noteMissing, noteResolved, isRecentRelease, touchSearchState, searchKeyClear,
  missingEpisodes, shortReason, clampHint, probeSearchGap, grabGapRelease,
  trackSearchDispatch, arrSweep, startSearchEngine,
};
