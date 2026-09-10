'use strict';
// Rotating collection shelves on the Jellyfin home screen (Home Screen
// Sections plugin): the /api/hss/shelf results endpoint + the periodic
// re-registration of 20 shelf rows. Owns: SHELF_IDS and the last-picks memo on
// registerHssShelf. Timers: startShelfTimer() → every 30 min (bootSequence in
// server.js does the first registration once collections exist).

const app = require('./app');
const jobs = require('./jobs');
const { cfg, HOST, NUC_IP } = require('./config');
const { tfetch, tfetchJson } = require('./clients');
const { cachedFetch } = require('./cache');
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
// oscar was 5 until 2026-08-25. With ~26 award categories in the catalog a 5x weight had them
// taking most of the 20 rows, so the home page read as an awards page; 4x keeps them the
// dominant family without crowding out the vibe shelves.
const SHELF_WEIGHTS = { oscar: 4, craft: 2, nature: 10 };
// MINIMUM TITLES FOR A ROW. A shelf with two films on it reads as a bug, not as curation, so a
// set below its floor is never offered as a home row. The floors are the same ones the SWEEP
// creates at (collections.js): 5 for everything, 4 for the award/festival categories, which are
// deliberately allowed to be thinner because some of them will never grow.
//
// This is enforced HERE as well as at creation because the library can hold a set the sweep would
// no longer make: one whose films were deleted, one created under an older rule, or one orphaned
// by a rename — the two-film "Joel Coen" left behind when the brothers were merged into a single
// "Coen Brothers" shelf is exactly that, and it kept appearing on the web home page because the
// display side only ever floored AWARD sets and TMDb "… Collection" ones. A floor that applies to
// every category can't be outlived by a rule change upstream.
//
// ChildCount is always present on the catalog query — verified across all 235 box sets on
// 2026-09-08 — so 0 here means genuinely empty rather than "field missing", and an empty row is
// the one most worth suppressing. (The previous `> 0` guard existed for the missing-field case and
// had the effect of always showing empty sets.)
const SHELF_MIN = 5;
const AWARD_MIN = 4;
function shelfTooThin(s) {
  return (s.ChildCount || 0) < (shelfCategory(s) === 'oscar' ? AWARD_MIN : SHELF_MIN);
}
function shelfCategory(s) {
  if (/^(Oscar|Cannes|Sundance):/i.test(s.Name || '')) return 'oscar';
  if ((s.Name || '') === 'Nature & Cosmos') return 'nature';
  const ov = (s.Overview || '').trim();
  if (/^(Directed by|Shot by|Edited by|Music by)/.test(ov) || (s.Name || '') === 'Coen Brothers') return 'craft';
  return 'other';
}
// The raw BoxSet catalog behind BOTH the HSS shelf registration and /api/hss/rows.
//
// CACHED because that one Jellyfin query — 250 sets with Overview + ChildCount — measures ~11s
// on this library, and /api/hss/rows was paying it on every single call. The Fire Stick client
// gives up after 8s (HomeRowsFragment.CONTROLLER_TIMEOUT_MS), so the TV home screen never once
// received the weighted picks: it silently fell back to shuffled TMDb franchise box sets, and
// the 5s spent waiting went straight onto the splash budget. See the loading-skip note in
// docs/DESIGN-TV-TELEMETRY.md.
//
// The TTL is deliberately LONGER than the 30-min shelf-registration interval. Registration calls
// shelfCatalog() and so re-warms this key every 30 min; a TTL under that would leave a window in
// which the first caller — very possibly the Fire Stick mid-splash — pays the full 11s again.
// At 35 min the refresh always lands first and the client never sees a cold miss. The catalog
// only changes when the collections sweep creates or deletes a set, so staleness is harmless;
// the weighted pick (shelfPicks) still runs per request, so rows stay freshly randomised.
//
// serveStale (2026-09-08): that "the refresh always lands first" argument only holds while the
// controller has been up for a while. It does NOT hold right after a restart, or if a
// registration pass happens to fail, and the TV telemetry shows what that costs — 7 of 29 home
// builds fell back to the slow client-side path on an 8s SocketTimeoutException, one home build
// took 43s, and the splash backstop fired twice. Since a stale catalog is explicitly harmless
// here, a caller past the TTL now gets the previous answer at once and the refresh happens
// behind it; only a genuinely COLD cache can still make anyone wait. Together with cachedFetch's
// single-flight, a burst of Fire Stick requests can no longer multiply that wait either.
const SHELF_CATALOG_TTL = 2100000;
async function shelfSets() {
  return cachedFetch('hss:boxsets', SHELF_CATALOG_TTL, async () => {
    const uid = await jellyfinUserId();
    const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY || '' };
    const bq = new URLSearchParams({ IncludeItemTypes: 'BoxSet', Recursive: 'true', Limit: '250', Fields: 'Overview,ChildCount' });
    return ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${bq}`, { headers: h }, 25000)).Items) || [];
  }, [], { serveStale: true });
}

// Fill the catalog cache and nothing else. bootSequence calls this the moment Jellyfin answers,
// BEFORE the collections sweep — the sweep takes minutes, and until it finished (and
// registerHssShelf ran) the cache was cold, so a TV launched in that window paid the full query
// and timed out. Costs one query on a path that was going to make it anyway.
async function warmShelfCatalog() {
  try { await shelfSets(); } catch { /* the next caller retries; never block boot on it */ }
}
async function shelfCatalog() {
  const sets = await shelfSets();
  return sets.filter((s) => !/Collection$/.test(s.Name) && !shelfTooThin(s));   // ours, not TMDb franchise sets
}
function shelfPicks(autos, n = SHELF_IDS.length) {   // weighted random sampling without replacement
  if (!autos.length) return [];
  const pool = autos.map((s) => ({ s, w: SHELF_WEIGHTS[shelfCategory(s)] || 1 }));
  const picks = [];
  while (picks.length < n && pool.length) {
    const total = pool.reduce((a, x) => a + x.w, 0);
    let r = Math.random() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) { r -= pool[i].w; if (r <= 0) { idx = i; break; } }
    picks.push(pool.splice(idx, 1)[0].s);
  }
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
    // EVERY shelf is randomized now, awards included (2026-08-25): a Best Picture row that always
    // opened on the last three winners read as a fixed list rather than a shelf to browse. That
    // also let the per-row `/Users/{uid}/Items/{setId}` name lookup go — it existed ONLY to spot
    // award collections and sort them newest-first, and it cost one extra Jellyfin request per
    // row (~32 on a web home build, which is already the slow path).
    shuffle(items);
    res.json({ Items: items, TotalRecordCount: items.length });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.all('/api/hss/rows', async (req, res) => {
  try {
    // Shares the cached catalog with the shelf registration — this is the TV client's home-row
    // call and it is on the splash critical path, so it must not re-run the ~11s BoxSet query.
    const sets = await shelfSets();
    // Unlike shelfCatalog(), TMDb franchise sets ARE eligible here (that's what gives the TV home
    // screen rows like "Alien Collection"), they just have to clear the same floor as everything
    // else. The floor used to be spelled out per family here, which let a thin set through when it
    // was neither an award category nor named "… Collection" — a 3-film "OSS 117 - Saga" and a
    // 2-film "The Vengeance Trilogy" were both live TV rows.
    const list = sets.filter((s) => !shelfTooThin(s));
    let n = parseInt((req.query && req.query.n) || 20, 10);
    if (!Number.isFinite(n)) n = 20;
    n = Math.max(1, Math.min(50, n));
    const picks = shelfPicks(list, n);
    res.json({ items: picks.map((s) => ({ id: s.Id, name: s.Name, childCount: s.ChildCount || 0, category: shelfCategory(s) })) });
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
        // limit 14 (was 10, 2026-08-25): a slightly longer row without touching the row COUNT,
        // which is what actually costs on the web home page — each row is still one /api/hss/shelf
        // call, and that call already fetched 24 items to shuffle from, so the extra four cards
        // ride along on a request we were making anyway.
        body: JSON.stringify({ id: SHELF_IDS[i], displayText: picks[i].Name, limit: 14, additionalData: picks[i].Id, resultsEndpoint: `http://${NUC_IP}:8088/api/hss/shelf` }),
      }, 20000);
    }
    if (picks.length && registerHssShelf._last !== picks.map((p) => p.Id).join()) {
      registerHssShelf._last = picks.map((p) => p.Id).join();
      console.log(`hssShelf: shelf rows registered — ${picks.map((p) => p.Name).join(' · ')}`);
    }
  } catch (e) { console.log(`hssShelf: registration failed — ${e?.message || e}`); }
}

// Export is wrapped so bootSequence's registration counts (see collections.js for why).
const tracked = jobs.define({
  id: 'hss-shelf', name: 'Home shelves', group: 'Metadata', weight: 38,
  what: 'Refreshes the Jellyfin home rows',
  every: 1800000, scheduleText: 'every 30 min · and on boot',
}, registerHssShelf);

function startShelfTimer() {
setInterval(tracked, 1800000);   // every 30 min: survives Jellyfin restarts, tracks hourly rotation (was 10min; shelf doesn't churn that fast)
// Boot self-heal: on a cold start the box sets don't exist yet, so a bare shelf registration has
// nothing to show. Wait for Jellyfin to answer, build the collections FIRST, then register shelves
// off the fresh sets — no 3-min gap where the home page is empty. bootSequence() is defined below
// (after collectionsSweep) and scheduled there so both functions are in scope.
}

module.exports = { registerHssShelf: tracked, startShelfTimer, warmShelfCatalog };
