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

// "Because you watched X" rows. These take over SHELF SLOTS rather than having ids of their own —
// BECAUSE_SLOTS are indexes into SHELF_IDS, so a slot listed here is registered with a
// because-you-watched title and the /api/hss/because endpoint instead of a collection.
//
// WHY SLOTS AND NOT NEW IDS. Two separate plugin problems, both established by testing:
//
//  1. HSS ships its own BecauseYouWatched section and it is broken on Jellyfin 12. Enabling it
//     produced no row and every request threw:
//       [ERR] Error processing request. URL GET /HomeScreen/Section/BecauseYouWatched
//          at BecauseYouWatchedSection.GetResults(...) BecauseYouWatchedSection.cs:line 149
//
//  2. HSS will not SERVE a section id it does not already know, even though it accepts the
//     registration. Registering BecauseA/B/C returned HTTP 200, they appeared in SectionSettings
//     as Enabled, and `GET /HomeScreen/Section/BecauseA` returned exactly the right items — but
//     they never showed up in `GET /HomeScreen/Sections`, which is the list the home page builds
//     from. Retried at OrderIndex 5 and 3, with a CacheBustCounter bump, and with a hand-rolled
//     RegisterSection call. The shelf ids have none of this trouble because the plugin has seen
//     them since the first provision.
//
// Slots are spread across the two OrderIndex blocks (ShelfA–J render at 4, ShelfK–T at 6) so the
// rows land amongst the collections rather than in a block, matching the Fire Stick client, which
// scatters its three rows through the same rotation.
//
// The suggestions themselves are Jellyfin's own (/Items/{id}/Similar) and are worth showing on 12:
// they key strongly on shared director and cast, so "I Saw the Devil" returns Kim Jee-woon /
// Park Chan-wook / Bong Joon-ho thrillers. They were dropped on 10.11 for being too weak.
const BECAUSE_SLOTS = [4, 9, 18];
// A suggestion row shorter than this reads as an accident, the same reason shelfTooThin exists.
const BECAUSE_MIN = 4;
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
  if (/^(Oscar|Cannes|Sundance|Venice|TIFF):/i.test(s.Name || '')) return 'oscar';
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
    const h = { Authorization: `MediaBrowser Token="${cfg.JELLYFIN_KEY || ''}"` };
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
    const h = { Authorization: `MediaBrowser Token="${cfg.JELLYFIN_KEY || ''}"` };
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
// Source films for the because-you-watched rows: most recently played, newest first.
//
// Cached for 10 min — short enough that finishing a film changes the home page on the next
// rotation, long enough that a web home build (which fires one request per row) doesn't re-ask
// for every single row.
async function becauseSources(n = BECAUSE_SLOTS.length) {
  return cachedFetch('hss:because-sources', 600000, async () => {
    const uid = await jellyfinUserId();
    const h = { Authorization: `MediaBrowser Token="${cfg.JELLYFIN_KEY || ''}"` };
    const q = new URLSearchParams({
      IncludeItemTypes: 'Movie', Recursive: 'true', Filters: 'IsPlayed',
      SortBy: 'DatePlayed', SortOrder: 'Descending', Limit: String(n * 2),
    });
    const items = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 20000)).Items) || [];
    return items.filter((i) => i.Id && i.Name).map((i) => ({ Id: i.Id, Name: i.Name }));
  }, [], { serveStale: true });
}

app.all('/api/hss/because', async (req, res) => {
  try {
    const uid = (req.body && (req.body.UserId || req.body.userId)) || req.query.userId || await jellyfinUserId();
    const h = { Authorization: `MediaBrowser Token="${cfg.JELLYFIN_KEY || ''}"` };
    let itemId = (req.body && (req.body.AdditionalData || req.body.additionalData)) || req.query.itemId || '';
    if (!itemId) {
      const src = (await becauseSources())[0];
      if (!src) return res.json({ Items: [], TotalRecordCount: 0 });
      itemId = src.Id;
    }
    const q = new URLSearchParams({ userId: uid, limit: '14' });
    const items = ((await tfetchJson(`${HOST.jellyfin}/Items/${itemId}/Similar?${q}`, { headers: h }, 20000)).Items) || [];
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
    // Work out the because-you-watched rows FIRST, because each one takes a shelf slot away from
    // the collection picks. A source film whose similar-items list is too short is dropped rather
    // than shown, so becauseSources() deliberately offers more candidates than there are slots.
    const because = new Map();   // slot index -> { name, itemId }
    let slot = 0;
    for (const src of await becauseSources()) {
      if (slot >= BECAUSE_SLOTS.length) break;
      let count = 0;
      try {
        const q = new URLSearchParams({ userId: await jellyfinUserId(), limit: '14' });
        count = (((await tfetchJson(`${HOST.jellyfin}/Items/${src.Id}/Similar?${q}`,
          { headers: { Authorization: `MediaBrowser Token="${cfg.JELLYFIN_KEY}"` } }, 20000)).Items) || []).length;
      } catch { count = 0; }
      if (count < BECAUSE_MIN) continue;
      because.set(BECAUSE_SLOTS[slot], { name: `Because you watched ${src.Name}`, itemId: src.Id });
      slot++;
    }

    const picks = shelfPicks(await shelfCatalog(), SHELF_IDS.length - because.size);
    let ok = 0;
    const failed = [];
    // One pass over every slot. Slots claimed by a because-row get that row; the rest are filled
    // from the collection picks in order, so no slot is left unregistered (an unregistered slot
    // keeps whatever it was showing before, which is how a stale row would survive a rotation).
    let pi = 0;
    for (let i = 0; i < SHELF_IDS.length; i++) {
      let row = null;
      const why = because.get(i);
      if (why) {
        row = { displayText: why.name, additionalData: why.itemId, endpoint: 'because' };
      } else if (pi < picks.length) {
        const p = picks[pi];
        pi += 1;
        row = { displayText: p.Name, additionalData: p.Id, endpoint: 'shelf' };
      }
      if (!row) break;
      // CHECK THE RESPONSE. This was fire-and-forget until 2026-09-11, and it hid a real outage:
      // HSS holds registrations in memory, so every Jellyfin restart drops them and the controller
      // has to re-register — but the controller boots at the same time as Jellyfin, so the POSTs
      // land while Jellyfin is still starting and come back 503. Nothing checked, nothing logged,
      // and the web home page sat with one section while the log cheerfully said "shelf rows
      // registered". Same failure shape as the unchecked collection writes that silently emptied
      // Critically Loved with an HTTP 414.
      let r = null;
      try {
        r = await tfetch(`${HOST.jellyfin}/HomeScreen/RegisterSection`, {
          method: 'POST',
          headers: { Authorization: `MediaBrowser Token="${cfg.JELLYFIN_KEY}"`, 'Content-Type': 'application/json' },
          // limit 14 (was 10, 2026-08-25): a slightly longer row without touching the row COUNT,
          // which is what actually costs on the web home page — each row is still one /api/hss/shelf
          // call, and that call already fetched 24 items to shuffle from, so the extra four cards
          // ride along on a request we were making anyway.
          body: JSON.stringify({ id: SHELF_IDS[i], displayText: row.displayText, limit: 14, additionalData: row.additionalData, resultsEndpoint: `http://${NUC_IP}:8088/api/hss/${row.endpoint}` }),
        }, 20000);
      } catch (e) { failed.push(`${SHELF_IDS[i]}(${e?.message || e})`); continue; }
      if (r.ok || r.status === 204) ok++;
      else failed.push(`${SHELF_IDS[i]}(HTTP ${r.status})`);
    }

    if (failed.length) {
      // 503 means Jellyfin is still coming up — say so plainly and let the 30-minute timer retry,
      // rather than reporting success and leaving the home page short of rows for half an hour.
      console.log(`hssShelf: ${ok}/${picks.length + because.size} shelf rows registered — ${failed.length} rejected: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ' …' : ''}`);
      registerHssShelf._last = null;   // force a re-log (and a real retry) next pass
      return;
    }
    const titles = [...picks.map((p) => p.Name), ...[...because.values()].map((b) => b.name)];
    if (titles.length && registerHssShelf._last !== titles.join()) {
      registerHssShelf._last = titles.join();
      console.log(`hssShelf: ${ok} shelf rows registered — ${titles.join(' · ')}`);
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
