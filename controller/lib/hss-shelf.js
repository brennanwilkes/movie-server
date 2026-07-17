'use strict';
// Rotating collection shelves on the Jellyfin home screen (Home Screen
// Sections plugin): the /api/hss/shelf results endpoint + the periodic
// re-registration of 20 shelf rows. Owns: SHELF_IDS and the last-picks memo on
// registerHssShelf. Timers: startShelfTimer() → every 30 min (bootSequence in
// server.js does the first registration once collections exist).

const app = require('./app');
const { cfg, HOST, NUC_IP } = require('./config');
const { tfetch, tfetchJson } = require('./clients');
const { jellyfinUserId } = require('./jellyfin');

// ── HSS custom sections: rotating collection SHELVES as home rows ───────────────────────────
// Three rows registered with the Home Screen Sections plugin, each titled with the ACTUAL
// collection it's showing ("Mob Classics", "90s Movies", …). The registration's displayText
// is the row title and additionalData carries the collection id back to our endpoint, so the
// controller re-registers every 10 min with the current hour's picks — titles and contents
// rotate together. Contents come back as native Jellyfin dtos (already shuffled by the
// collections sweep). NOTE: the plugin POSTs its payload to resultsEndpoint — a GET-only
// route returns Express HTML that breaks its JSON parser, hence app.all.
const SHELF_IDS = ['ShelfA', 'ShelfB', 'ShelfC', 'ShelfD', 'ShelfE', 'ShelfF', 'ShelfG', 'ShelfH', 'ShelfI', 'ShelfJ', 'ShelfK', 'ShelfL', 'ShelfM', 'ShelfN', 'ShelfO', 'ShelfP', 'ShelfQ', 'ShelfR', 'ShelfS', 'ShelfT'];   // 20 rotating shelf rows (grow: add ids here + rows in jellyfin.sh)
async function shelfCatalog() {
  const uid = await jellyfinUserId();
  const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' };
  const bq = new URLSearchParams({ IncludeItemTypes: 'BoxSet', Recursive: 'true', Limit: '100' });
  const sets = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${bq}`, { headers: h }, 25000)).Items) || [];
  return sets.filter((s) => !/Collection$/.test(s.Name));   // ours, not TMDb franchise sets
}
function shelfPicks(autos) {   // fresh set every registration (10 min), spread across the catalog
  if (!autos.length) return [];
  const n = autos.length, base = Math.floor(Date.now() / 600000);
  const step = Math.max(1, Math.floor(n / SHELF_IDS.length));
  let picks = SHELF_IDS.map((_, i) => autos[((base * 7) + (i * step)) % n]);
  picks = [...new Map(picks.map((p) => [p.Id, p])).values()];
  for (let i = picks.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [picks[i], picks[j]] = [picks[j], picks[i]]; }
  return picks;
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

app.all('/api/hss/shelf', async (req, res) => {
  try {
    const uid = (req.body && (req.body.UserId || req.body.userId)) || req.query.userId || await jellyfinUserId();
    const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' };
    let setId = (req.body && (req.body.AdditionalData || req.body.additionalData)) || req.query.setId || '';
    if (!setId) {
      const p = shelfPicks(await shelfCatalog())[0];
      if (!p) return res.json({ Items: [], TotalRecordCount: 0 });
      setId = p.Id;
    }
    const cq = new URLSearchParams({ ParentId: setId, Limit: '24' });
    const items = ((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${cq}`, { headers: h }, 20000)).json()).Items) || [];
    // Look up collection name to decide sort: Oscar = newest-first, everything else = random
    try {
      const meta = await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items/${setId}`, { headers: h }, 5000)).json();
      if (meta.Name && /^Oscar:/i.test(meta.Name)) {
        items.sort((a, b) => (b.ProductionYear || 0) - (a.ProductionYear || 0));
      } else {
        shuffle(items);
      }
    } catch (_) { shuffle(items); }
    res.json({ Items: items, TotalRecordCount: items.length });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
async function registerHssShelf() {
  if (!cfg.JELLYFIN_KEY) return;
  try {
    const picks = shelfPicks(await shelfCatalog());
    for (let i = 0; i < picks.length; i++) {
      await tfetch(`${HOST.jellyfin}/HomeScreen/RegisterSection`, {
        method: 'POST',
        headers: { 'X-Emby-Token': cfg.JELLYFIN_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: SHELF_IDS[i], displayText: picks[i].Name, limit: 10, additionalData: picks[i].Id, resultsEndpoint: `http://${NUC_IP}:8088/api/hss/shelf` }),
      }, 20000);
    }
    if (picks.length && registerHssShelf._last !== picks.map((p) => p.Id).join()) {
      registerHssShelf._last = picks.map((p) => p.Id).join();
      console.log(`hssShelf: shelf rows registered — ${picks.map((p) => p.Name).join(' · ')}`);
    }
  } catch (e) { console.log(`hssShelf: registration failed — ${e?.message || e}`); }
}

function startShelfTimer() {
setInterval(registerHssShelf, 1800000);   // every 30 min: survives Jellyfin restarts, tracks hourly rotation (was 10min; shelf doesn't churn that fast)
// Boot self-heal: on a cold start the box sets don't exist yet, so a bare shelf registration has
// nothing to show. Wait for Jellyfin to answer, build the collections FIRST, then register shelves
// off the fresh sets — no 3-min gap where the home page is empty. bootSequence() is defined below
// (after collectionsSweep) and scheduled there so both functions are in scope.
}

module.exports = { registerHssShelf, startShelfTimer };
