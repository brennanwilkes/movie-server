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

app.post('/api/elo/top100/reorder', async (req, res) => {
  corsOk(res);
  try {
    const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' };
    const { playlistId, itemIds } = req.body; // itemIds = array of Jellyfin itemIds in new order
    if (!playlistId || !Array.isArray(itemIds)) return res.status(400).json({ error: 'playlistId and itemIds required' });
    // NOTE: Playlists/{id}/Items/{itemId}/Move/{newIndex} looks right per the Jellyfin API but
    // is broken for API-key auth — MoveItem resolves the calling user from the request's auth
    // context to look up the playlist, and an API key isn't bound to a user session, so Jellyfin
    // gets an empty user GUID and 400s on every single call ("Guid can't be empty (Parameter
    // 'id')" in PlaylistManager.GetPlaylists). It was failing silently — reorder always reported
    // ok:true while every per-item move errored. Add/remove both accept an explicit userId, so
    // reorder instead by clearing the playlist and re-adding items in the desired order.
    const uid = await jellyfinUserId();
    const current = ((await (await tfetch(`${HOST.jellyfin}/Playlists/${playlistId}/Items?${new URLSearchParams({ UserId: uid })}`, { headers: h }, 10000)).json()).Items) || [];
    const currentIds = new Set(current.map(it => it.Id));
    const orderedIds = itemIds.filter(id => {
      if (!currentIds.has(id)) { console.log(`elo/reorder: item ${id} not in current playlist`); return false; }
      return true;
    });
    if (!orderedIds.length) return res.json({ ok: true });

    const entryIds = current.map(it => it.PlaylistItemId);
    const delR = await tfetch(`${HOST.jellyfin}/Playlists/${playlistId}/Items?${new URLSearchParams({ entryIds: entryIds.join(',') })}`, { method: 'DELETE', headers: h }, 10000);
    if (!delR.ok) throw new Error(`clearing playlist failed: HTTP ${delR.status}`);

    const addR = await tfetch(`${HOST.jellyfin}/Playlists/${playlistId}/Items?${new URLSearchParams({ ids: orderedIds.join(','), userId: uid })}`, { method: 'POST', headers: h }, 15000);
    if (!addR.ok) throw new Error(`re-adding items failed: HTTP ${addR.status}`);

    delete _cache['elo:top100'];  // bust cache so next load picks up new order
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/elo/config', async (_req, res) => {
  corsOk(res);
  try {
    const uid = await jellyfinUserId();
    res.json({ nucIp: NUC_IP, userId: uid, jellyfinBase: HOST.jellyfin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = {};
