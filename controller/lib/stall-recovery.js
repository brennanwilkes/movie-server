'use strict';
// Stalled-download recovery: reannounce → blocklist+re-search → accept-rare
// escalation. Owns: the per-hash throttle Maps (_stallSince, _lastReannounce,
// _lastResearch, _researchCount, _accepted) and STALL_DEAD (both read by
// buildDownloads for the UI give-up clock). Timers: startStallRecovery() →
// every 5 min, first run at 20s.

const metrics = require('../metrics');
const { tfetch, qbit, arrGet, arrOf } = require('./clients');
const { getQbitTorrents, getQueueMap, torrentApp, isForceGrabCategory } = require('./arr-data');
const { forceGrabImport, auditPending, isMasterPaused } = require('./state');

// ── Stalled-download recovery (backend, container-to-container) ──────────────────────────────
// Two tiers, escalating, so the queue heals itself instead of sitting on dead torrents:
//   1. Gentle: a stalled torrent gets periodic reannounces — enough to wake one that simply lost
//      its peers (e.g. our Out of Africa, 9 seeds).
//   2. Give-up: a torrent stalled with ZERO seeds for STALL_DEAD has grabbed a dead release (the
//      movie isn't obscure — Cast Away had 121-seed alternatives). We blocklist that release in
//      *arr (so it won't be re-grabbed) and kick off a fresh search, which pulls a seeded copy.
// All actions are throttled per-hash so a sweep can't thrash trackers or *arr.
async function qbitReannounce(hash) {
  try { await qbit.fetch('/api/v2/torrents/reannounce', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `hashes=${hash}` }); } catch { /* qbit hiccup */ }
}
async function arrBlocklistAndResearch(app, queueId, itemId, opts = {}) {
  const { base, key } = arrOf(app);
  // remove from qBittorrent + blocklist the dead release so *arr never re-grabs this exact copy
  await tfetch(`${base}/queue/${queueId}?removeFromClient=true&blocklist=true`, { method: 'DELETE', headers: { 'X-Api-Key': key } }, 20000);
  // then search for a replacement (a better-seeded release). Skipped when another dead torrent for
  // this same title already triggered the search in this sweep — one SeriesSearch/MoviesSearch
  // covers the whole title, so firing it again would be a duplicate.
  if (opts.search === false) return;
  const cmd = app === 'radarr' ? { name: 'MoviesSearch', movieIds: [itemId] } : { name: 'SeriesSearch', seriesId: itemId };
  await tfetch(`${base}/command`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) }, 20000);
}
// Grab the single best-seeded release available for a title (radarr only — Sonarr's interactive
// search is per-episode and messier). Used by the "accept rare" tier: when re-searching keeps
// turning up only dead releases, we stop churning and just take the healthiest option there is.
async function grabBestSeeded(app, itemId) {
  if (app !== 'radarr') return null;
  const { base, key } = arrOf(app);
  const rels = await (await tfetch(`${base}/release?movieId=${itemId}`, { headers: { 'X-Api-Key': key } }, 60000)).json();
  // Only releases the profile itself would accept (not rejected), ranked by the SAME
  // custom-format score the profiles grab on, THEN seeders. The old pure best-seeded pick
  // bypassed every quality/codec/size rule and could force-grab a 40 GB 10-bit HDR remux.
  // If everything is rejected there is nothing worth forcing — return null and let it sit.
  const ok = (Array.isArray(rels) ? rels : []).filter((r) => !r.rejected && (r.seeders || 0) > 0);
  const best = ok.sort((a, b) => (b.customFormatScore || 0) - (a.customFormatScore || 0) || (b.seeders || 0) - (a.seeders || 0))[0];
  if (!best || !best.guid) return null;
  await tfetch(`${base}/release`, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ guid: best.guid, indexerId: best.indexerId }) }, 30000);
  return best.seeders || 0;
}
const _stallSince = new Map();   // hash -> first-seen-stalled-with-0-seeds ts
const _lastReannounce = new Map();
const _lastResearch = new Map();
const _researchCount = new Map(); // app:itemId -> how many ROUNDS of blocklist+re-search this title has had
const _accepted = new Map();      // app:itemId -> ts we gave up; re-armed after ACCEPT_COOLDOWN
const STALL_DEAD = 3600;          // s a torrent may sit at 0 seeds before we abandon the release
const REANNOUNCE_EVERY = 600;
const RESEARCH_EVERY = 6 * 3600;  // never re-research the same hash more than this often
const MAX_RESEARCH = 3;           // after this many dead re-search ROUNDS, accept the title is rare & let it sit
// Giving up used to be FOREVER (for the lifetime of the process). That is not self-healing: what
// the indexers have today is not what they will have next week, and The Wire S05 was written off
// permanently on 2026-07-29 within a single sweep. After this long, a title gets its rounds back.
const ACCEPT_COOLDOWN = 24 * 3600;
// SINGLE definition of "we have stopped trying on this title", because the Downloads tab has to
// render exactly the same rule the sweep enforces — it previously showed a give-up countdown for
// titles the sweep would never act on again, promising a blocklist-and-research forever.
function isAcceptedRare(app, itemId) {
  const at = _accepted.get(`${app}:${itemId}`);
  return !!at && (Math.floor(Date.now() / 1000) - at) < ACCEPT_COOLDOWN;
}
async function stallRecovery() {
  if (isMasterPaused()) return;                                         // Movie Mode — leave torrents as-is
  const now = Math.floor(Date.now() / 1000);
  let torrents; try { torrents = await getQbitTorrents(); } catch { return; }
  const queues = { radarr: await getQueueMap('radarr'), sonarr: await getQueueMap('sonarr') };
  // In-flight Audit-tab swaps, by grab hash. EXEMPT from every path below, all of which end in
  // removing the torrent (with deleteFiles, or removeFromClient+blocklist). A swap deliberately
  // targets ONE chosen release, so blocklisting it and re-searching the series both discards the
  // human's choice and strands the swap: replaceSweep matches on the recorded hash, so once the
  // torrent is gone the row shows "swapping" until the 48h abandon while nothing downloads.
  // Observed 2026-07-28: five swaps stranded this way (Rings of Power, Breaking Bad S01, Mickey
  // 17, Totoro, Ali G) — all 1-2 seed grabs that stalled, which is exactly when recovery fires.
  // This is the same omission as arrSweep's missing auditPending exemption; fixed in both now.
  // The 48h abandon (which KEEPS the original) is the only thing that should end a swap.
  const swapHashes = new Set([...auditPending.values()]
    .map((p) => String(p.hash || '').toLowerCase()).filter(Boolean));
  // Titles whose re-search already fired in THIS sweep. MAX_RESEARCH is meant to count sequential
  // ROUNDS ("we tried three times and everything was dead"), but the throttle guarding it is
  // per-hash, so three dead torrents from one series burned the entire budget in a single pass —
  // that is exactly what wrote off The Wire S05 on 2026-07-29, after what was really one round.
  // Every dead torrent is still blocklisted and removed; only the counting and the search itself
  // collapse to once per title per sweep, which is also all a SeriesSearch needs.
  const researchedNow = new Set();
  for (const t of torrents) {
    const h = (t.hash || '').toLowerCase();
    if (swapHashes.has(h)) continue;                                    // audit swap — hands off
    const stalled = (t.state === 'stalledDL' || t.state === 'metaDL') && (t.progress || 0) < 1;
    if (!stalled) { _stallSince.delete(h); continue; }
    if (now - (_lastReannounce.get(h) || 0) > REANNOUNCE_EVERY) { _lastReannounce.set(h, now); qbitReannounce(h); }  // tier 1
    // A stalledDL WITH active seeds is recoverable — reannounce reconnects it, so don't abandon. But
    // metaDL (can't even fetch the torrent's metadata) or a 0-seed stall is dead even if it claims
    // a complete peer (num_complete is historical, not current), so let those escalate.
    if (t.state !== 'metaDL' && (t.num_seeds || 0) > 0) { _stallSince.delete(h); continue; }
    if (!_stallSince.has(h)) _stallSince.set(h, now);
    if (now - _stallSince.get(h) < STALL_DEAD) continue;                                 // give a 0-seed swarm time to appear
    const app = torrentApp(t); const qrec = app && queues[app].get(h);
    if (app && (!qrec || qrec.id == null)) {
      // Force-grabbed torrents are user-approved and may not have an *arr queue record
      // yet (or ever, if the release name doesn't parse). Don't delete them — the import
      // watchdog will retry Manual Import on the download folder until files land.
      if (forceGrabImport.has(h) || isForceGrabCategory(t.category)) { _stallSince.delete(h); continue; }
      // Dead download that *arr no longer tracks (queue record gone — e.g. a prior cleanup
      // removed the record but the qBittorrent delete failed). NOTHING else can rescue it:
      // the escalation below needs a queue id, and the orphan sweep only acts when the
      // movie/series itself is deleted — so it sits as "Starting"/"Stalled" forever
      // (observed: Were.the.Millers x265 10bit metaDL, weeks stuck). Blocklist the release
      // via its grab-history record (so it isn't re-grabbed) and drop the torrent; the
      // missing-item sweep then re-searches a healthy copy on its normal schedule.
      try {
        const { base, key } = arrOf(app);
        const hr = await arrGet(app, `/history?pageSize=20&sortKey=date&sortDirection=descending&downloadId=${h.toUpperCase()}`);
        const grab = (hr.records || []).find((r) => (r.eventType || '').toLowerCase() === 'grabbed');
        if (grab) await tfetch(`${base}/history/failed/${grab.id}`, { method: 'POST', headers: { 'X-Api-Key': key } }, 15000);
      } catch { /* blocklist is best-effort — removing the torrent still unsticks the title */ }
      try {
        await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ hashes: t.hash, deleteFiles: 'true' }) });
        console.log(`recovery: removed *arr-orphaned dead download "${t.name}" (no queue record — blocklisted via history)`);
        metrics.emitEvent('abandon', { ti: t.name, ap: app, reason: 'orphan_no_queue' });
      } catch { /* qbit hiccup — retried next sweep */ }
      _stallSince.delete(h);
      continue;
    }
    if (!qrec || qrec.id == null) continue;
    const itemId = app === 'radarr' ? qrec.movieId : qrec.seriesId;
    const key = `${app}:${itemId}`;
    if (isAcceptedRare(app, itemId)) { _stallSince.delete(h); continue; }                // rare title we already chose to let sit
    // Cooldown expired — give the title its rounds back. Indexer availability changes.
    if (_accepted.has(key)) {
      _accepted.delete(key); _researchCount.delete(key);
      console.log(`recovery: "${key}" was written off ${Math.round(ACCEPT_COOLDOWN / 3600)}h ago — trying again`);
    }
    if (now - (_lastResearch.get(h) || 0) < RESEARCH_EVERY) continue;
    _lastResearch.set(h, now);
    const cnt = _researchCount.get(key) || 0;
    try {
      if (cnt < MAX_RESEARCH) {
        // Still worth trying for a healthy copy: blocklist the dead one and re-search.
        const firstThisSweep = !researchedNow.has(key);
        await arrBlocklistAndResearch(app, qrec.id, itemId, { search: firstThisSweep });
        if (firstThisSweep) {
          researchedNow.add(key);
          _researchCount.set(key, cnt + 1);
          console.log(`recovery: dead release blocklisted + re-searched (round ${cnt + 1}/${MAX_RESEARCH}): ${t.name}`);
          metrics.emitEvent('re_search', { ti: t.name, ap: app, attempt: cnt + 1 });
        } else {
          console.log(`recovery: dead release blocklisted (same title already re-searched this sweep): ${t.name}`);
        }
      } else {
        // Tried enough — this title is genuinely rare. Drop the dead copy, grab the single
        // best-seeded release available, and ACCEPT it: stop churning and let it sit until a seed
        // shows up. (Sonarr: no forced grab, just stop churning.) Re-armed after ACCEPT_COOLDOWN.
        await tfetch(`${arrOf(app).base}/queue/${qrec.id}?removeFromClient=true&blocklist=true`, { method: 'DELETE', headers: { 'X-Api-Key': arrOf(app).key } }, 20000);
        const seeders = await grabBestSeeded(app, itemId);
        _accepted.set(key, now);
        console.log(`recovery: "${t.name}" is rare after ${MAX_RESEARCH} rounds — grabbed best available (${seeders == null ? 'left as-is' : seeders + ' seeds'}) and letting it sit`
          + `; will try again in ${Math.round(ACCEPT_COOLDOWN / 3600)}h`);
        metrics.emitEvent('accepted_rare', { ti: t.name, ap: app, retryInH: Math.round(ACCEPT_COOLDOWN / 3600) });
      }
      _stallSince.delete(h);
    } catch (e) { console.log(`recovery action failed for ${t.name}: ${e.message || e}`); }
  }
}

function startStallRecovery() {
  setInterval(stallRecovery, 300000); // every 5 min — STALL_DEAD/throttles gate the actual actions
  setTimeout(stallRecovery, 20000);
}

module.exports = { stallRecovery, startStallRecovery, _stallSince, isAcceptedRare, STALL_DEAD };
