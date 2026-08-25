'use strict';
// Elo Tuner backend: read the "Top 100" Jellyfin playlist, reorder it (via
// clear + re-add — MoveItem is broken under API-key auth), persist elo ratings
// BETWEEN runs, and expose config for the elo-tuner web app (CORS-open). Owned
// state: _cache keys + /config/elo-ratings.json. No timers.

const fs = require('fs');
const app = require('./app');
const { cfg, HOST, NUC_IP } = require('./config');
const { tfetch } = require('./clients');
const { _cache, cachedFetch } = require('./cache');
const { jellyfinUserId } = require('./jellyfin');
const { safeRewrite, readPlaylistItems } = require('./top100-write');

// ── Elo Tuner: Top 100 playlist reading + reordering ───────────────────────────────────────
function corsOk(res) { res.header('Access-Control-Allow-Origin', '*'); res.header('Access-Control-Allow-Headers', 'Content-Type'); return res; }
app.get('/api/elo/top100', async (_req, res) => {
  corsOk(res);
  try {
    const data = await cachedFetch('elo:top100', 30000, async () => {
      const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' };
      const uid = await jellyfinUserId();
      // Cache the playlist ID for 1 hour — changes only on manual rename/delete (extremely rare).
      const playlistId = await cachedFetch('elo:top100:id', 3600000, async () => {
        const playlists = ((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${new URLSearchParams({ IncludeItemTypes: 'Playlist', Recursive: 'true', Limit: '20' })}`, { headers: h }, 15000)).json()).Items) || [];
        const p = playlists.find(p => p.Name === 'Top 100');
        return p ? p.Id : null;
      });
      if (!playlistId) throw new Error('Top 100 playlist not found');
      const items = ((await (await tfetch(`${HOST.jellyfin}/Playlists/${playlistId}/Items?${new URLSearchParams({ UserId: uid, Fields: 'ProductionYear,Genres,CommunityRating,RunTimeTicks,ProviderIds,People,Studios,Path,ImageTags' })}`, { headers: h }, 60000)).json()).Items) || [];
      return { playlistId, items: items.map((it, i) => ({ ...it, _eloRank: i + 1, _playlistItemId: it.PlaylistItemId, _eloKey: eloKey(it) })) };
    });
    if (!data) return res.status(404).json({ error: 'Top 100 playlist not found' });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save a new order. A reorder is a PERMUTATION — same titles, different sequence — and this route
// now enforces that rather than assuming it.
//
// NOTE: Playlists/{id}/Items/{itemId}/Move/{newIndex} looks right per the Jellyfin API but is
// broken for API-key auth — MoveItem resolves the calling user from the request's auth context to
// look up the playlist, and an API key isn't bound to a user session, so Jellyfin gets an empty
// user GUID and 400s on every single call ("Guid can't be empty (Parameter 'id')" in
// PlaylistManager.GetPlaylists). It was failing silently — reorder always reported ok:true while
// every per-item move errored. Add/remove both accept an explicit userId, so reorder means clearing
// the playlist and re-adding in the desired order.
//
// THAT CLEAR-THEN-RE-ADD IS WHY THE PLAYLIST WAS FOUND EMPTY on 2026-08-09 with all 116 hand-ranked
// titles gone. This route used to do it bare: DELETE all, POST all, and if the POST failed the
// playlist stayed empty forever — no backup, no rollback, and the route logged nothing on failure,
// so there was no trace of it afterwards. The write now goes through top100-write.js::safeRewrite,
// which backs up, compare-and-swaps, verifies and rolls back. See the header there.
//
// The other half of that bug was this route's old tolerance for a STALE client. It filtered the
// submitted ids down to whatever was still in the playlist and wrote the remainder — so a tuner tab
// opened before an audit swap (which re-mints the item id of every renamed file) would silently
// shrink the playlist to the intersection. Dropping titles is never what "save my new order" means:
// safeRewrite's no-drop check now refuses, and the tuner is told to reload.
app.post('/api/elo/top100/reorder', async (req, res) => {
  corsOk(res);
  try {
    const { playlistId, itemIds } = req.body; // itemIds = array of Jellyfin itemIds in new order
    if (!playlistId || !Array.isArray(itemIds)) return res.status(400).json({ error: 'playlistId and itemIds required' });
    if (!itemIds.length) return res.status(400).json({ error: 'itemIds is empty — refusing to clear the playlist' });
    if (new Set(itemIds).size !== itemIds.length) return res.status(400).json({ error: 'itemIds contains duplicates' });

    const uid = await jellyfinUserId();
    const current = await readPlaylistItems(playlistId, uid);
    const currentIds = current.map((it) => it.Id);

    // A permutation, checked both ways. safeRewrite catches the dangerous direction (dropping a
    // title) on its own, but catching it here lets the tuner say something useful, and the
    // added-titles direction is caught only here — an id the playlist doesn't contain means the
    // client is out of date, not that we should add it.
    const curSet = new Set(currentIds);
    const unknown = itemIds.filter((id) => !curSet.has(id));
    if (unknown.length) {
      console.log(`elo/reorder: REFUSED — ${unknown.length} submitted id(s) are not in the playlist (stale tuner tab?)`);
      return res.status(409).json({
        ok: false, stale: true, unknown: unknown.length,
        error: `${unknown.length} of the submitted titles are no longer in the playlist under those ids `
          + '(a file swap re-mints Jellyfin ids). Nothing was changed — reload the tuner and redo the move.',
      });
    }

    const r = await safeRewrite({ playlistId, uid, desired: itemIds, expectBefore: currentIds, tag: 'elo-reorder' });
    if (!r.ok) {
      console.log(`elo/reorder: REFUSED — ${r.reason}`);
      return res.status(409).json({ ok: false, ...r, error: r.reason });
    }

    delete _cache['elo:top100'];  // bust cache so next load picks up new order
    console.log(`elo/reorder: saved new order for ${r.wrote} items`);
    res.json({ ok: true, wrote: r.wrote });
  } catch (e) {
    // Loudly. The silent 500 on this route is precisely why the 2026-08-09 wipe left no trace.
    console.log(`elo/reorder: FAILED — ${e.message || e}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PERSISTED ELO RATINGS ────────────────────────────────────────────────────────────────────
// Its own file, not state.json: state.json is rewritten in full on a 500 ms debounce from a dozen
// hot call sites, and this is a cold, human-paced blob (~120 titles, written once per tuning
// session). Same split, same reasoning, as audit-verdicts.json and probe-cache.json.
//
// LOSS MODEL: ratings are a CACHE of past judgements, not the ranking itself. The Jellyfin
// playlist order is the source of truth; losing this file costs a full re-tune from scratch (every
// title reseeded from its playlist position), never a wrong list.
//
// KEYED BY TMDB ID, NOT JELLYFIN ITEM ID. A file swap (audit replacement, upgrade) re-mints the
// Jellyfin id of a title while it stays the same film — keying on the item id would silently orphan
// the rating of anything that got upgraded between sessions, which is a large slice of the list.
const RATINGS_PATH = '/config/elo-ratings.json';
// Ratings for titles no longer in the playlist are KEPT — a film pulled from the Top 100 is often
// put back, and its earned history is the expensive part. Pruned only once they are this stale, so
// the file cannot grow forever.
const ORPHAN_TTL_MS = 365 * 24 * 3600 * 1000;

function eloKey(it) {
  const tmdb = it && it.ProviderIds && (it.ProviderIds.Tmdb || it.ProviderIds.tmdb);
  if (tmdb) return `tmdb:${tmdb}`;
  const imdb = it && it.ProviderIds && (it.ProviderIds.Imdb || it.ProviderIds.imdb);
  if (imdb) return `imdb:${imdb}`;
  // Last resort. Stable enough for a hand-curated list, and the only alternative is no memory
  // at all for a title Jellyfin never matched.
  return `name:${String((it && it.Name) || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${(it && it.ProductionYear) || 0}`;
}

function readRatings() {
  try {
    const obj = JSON.parse(fs.readFileSync(RATINGS_PATH, 'utf8'));
    return {
      ts: obj.ts || 0,
      // Monotonic session counter. Films record the session they were last compared in, so the tuner
      // can tell a title it has not asked about in ten sittings from one it vetted yesterday — that
      // staleness is what lets a list "not showing every film" still stay honest over time.
      sessions: obj.sessions || 0,
      // The playlist order AS WE LAST SAW IT, in elo keys. Manual-move detection is a diff of this
      // against the order the playlist has now — see the tuner's reconcile().
      seenOrder: Array.isArray(obj.seenOrder) ? obj.seenOrder : [],
      ratings: (obj.ratings && typeof obj.ratings === 'object') ? obj.ratings : {},
    };
  } catch { return { ts: 0, seenOrder: [], ratings: {} }; }
}

function writeRatings(payload) {
  const tmp = `${RATINGS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, RATINGS_PATH);       // atomic: a crash mid-write cannot truncate the live file
}

app.get('/api/elo/ratings', (_req, res) => {
  corsOk(res);
  res.json(readRatings());
});

// Save ratings. `seenOrder` is the playlist order the client believes is live RIGHT NOW — either
// the order it loaded (mid-session autosave, playlist untouched) or the order it just successfully
// wrote (after a reorder). Recording it is what makes the next session able to tell a manual
// drag-and-drop in Jellyfin apart from a change the tuner itself made.
app.post('/api/elo/ratings', (req, res) => {
  corsOk(res);
  try {
    const { ratings, seenOrder, sessions } = req.body || {};
    if (!ratings || typeof ratings !== 'object') return res.status(400).json({ error: 'ratings object required' });
    const prev = readRatings();
    const now = Date.now();
    const merged = { ...prev.ratings };
    let saved = 0;
    for (const [k, v] of Object.entries(ratings)) {
      if (!v || typeof v.rating !== 'number' || !Number.isFinite(v.rating)) continue;
      merged[k] = {
        rating: Math.round(v.rating * 100) / 100,
        comparisons: Math.max(0, Math.round(v.comparisons || 0)),
        lastSeen: Math.max(0, Math.round(v.lastSeen || 0)),
        name: String(v.name || '').slice(0, 200),
        year: v.year || null,
        ts: now,
      };
      saved++;
    }
    // Prune long-dead entries (title pulled from the list a year ago and never re-added).
    let pruned = 0;
    for (const [k, v] of Object.entries(merged)) {
      if (!ratings[k] && v && v.ts && (now - v.ts) > ORPHAN_TTL_MS) { delete merged[k]; pruned++; }
    }
    const payload = {
      ts: now,
      // Never rewinds: two tabs open at once would otherwise reset the counter and make every film
      // look freshly vetted.
      sessions: Math.max(prev.sessions || 0, Math.round(sessions || 0)),
      seenOrder: Array.isArray(seenOrder) && seenOrder.length ? seenOrder : prev.seenOrder,
      ratings: merged,
    };
    writeRatings(payload);
    console.log(`elo/ratings: saved ${saved} ratings (${Object.keys(merged).length} stored, ${pruned} pruned)`);
    res.json({ ok: true, saved, stored: Object.keys(merged).length, pruned });
  } catch (e) {
    console.log(`elo/ratings: FAILED — ${e.message || e}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/elo/config', async (_req, res) => {
  corsOk(res);
  try {
    const uid = await jellyfinUserId();
    res.json({ nucIp: NUC_IP, userId: uid, jellyfinBase: HOST.jellyfin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = {};
