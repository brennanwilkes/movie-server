'use strict';
// Elo Tuner backend: read the "Top 100" Jellyfin playlist, reorder it (via
// clear + re-add — MoveItem is broken under API-key auth), and expose config
// for the elo-tuner web app (CORS-open). No owned state beyond _cache keys,
// no timers.

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
      return { playlistId, items: items.map((it, i) => ({ ...it, _eloRank: i + 1, _playlistItemId: it.PlaylistItemId })) };
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

app.get('/api/elo/config', async (_req, res) => {
  corsOk(res);
  try {
    const uid = await jellyfinUserId();
    res.json({ nucIp: NUC_IP, userId: uid, jellyfinBase: HOST.jellyfin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = {};
