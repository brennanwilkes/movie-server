'use strict';
// Oscar badge tags sweep. Writes per-film AND per-person Academy Award counts onto Jellyfin item
// Tags, which BOTH clients (web flair JS + the Movie Night Fire Stick fork) read to draw gold/silver
// statuette badges on posters and person cards. Tags are the shared source of truth: they ride along
// on queries both clients already make, survive controller downtime, and need no second backend.
// Owns: oscarTagsBusy. Timers: startOscarTagsTimer() → every 24h
// (award data changes yearly; the boot run is sequenced by server.js bootSequence()).
//
// Tags written (idempotent, diff-only):
//   oscars            presence marker
//   oscar-wins-{N}    count of wins        (only if wins > 0)
//   oscar-noms-{N}    count of LOSING noms (only if noms - wins > 0)
// `noms` in the datasets INCLUDES wins, so losses = noms - wins (never double-counted).
//
// MATCHING:
//   • Movies  — by ProviderIds.Imdb against film-awards.json (tt-keyed). ~100% coverage on this lib.
//   • People  — by NORMALIZED NAME against person-awards.json (people mostly lack IMDb ids in
//               Jellyfin). normName() below MUST match norm_name() in data/oscars/build-awards.sh.
//
// SAFETY (memory: storm 2026-07-07): metadata Tags only. Never deletes items, triggers
// searches/grabs, or touches user policies. oscar* tags must NEVER be added to any BlockedTags.

const { cfg, HOST, filmAwards, personAwards, oscarWinners } = require('./config');
const { tfetch, tfetchJson } = require('./clients');
const { jellyfinUserId } = require('./jellyfin');
const { isMasterPaused } = require('./state');

const OSCAR_TAG_RE = /^oscar(s|-wins-\d+|-noms-\d+)$/;
const FESTIVAL_TAG_RE = /^festival(?:-(cannes|sundance)(?:-(?:\d+|name-.+))?)?$/;

const FESTIVAL_DISPLAY = {
  "Cannes: Palme d'Or (Winners)": "PALME D'OR",
  "Cannes: Grand Prix (Winners)": "GRAND PRIX",
  "Cannes: Jury Prize (Winners)": "JURY PRIZE",
  "Cannes: Best Director (Winners)": "BEST DIRECTOR",
  "Sundance: Grand Jury Prize (Dramatic) (Winners)": "GRAND JURY",
  "Sundance: Grand Jury Prize (Documentary) (Winners)": "GRAND JURY",
  "Sundance: Audience Award (Dramatic) (Winners)": "AUDIENCE",
  "Sundance: Audience Award (Documentary) (Winners)": "AUDIENCE",
  "Sundance: Directing Award (Dramatic) (Winners)": "DIRECTING AWARD",
  "Sundance: Directing Award (Documentary) (Winners)": "DIRECTING AWARD",
};
// tmdb_id in the JSON is a NUMBER; Jellyfin ProviderIds.Tmdb is a STRING — key by String().
// Value: { cannes: [displayNames], sundance: [displayNames] } (names in collection order).
const festivalByTmdb = (() => {
  const m = new Map();
  for (const [key, rows] of Object.entries(oscarWinners)) {
    const label = FESTIVAL_DISPLAY[key];
    if (!label) continue;
    const fest = key.startsWith('Cannes: ') ? 'cannes'
      : key.startsWith('Sundance: ') ? 'sundance' : null;
    if (!fest) continue;
    for (const r of rows || []) {
      if (r && r.tmdb_id != null) {
        const k = String(r.tmdb_id);
        if (!m.has(k)) m.set(k, { cannes: [], sundance: [] });
        m.get(k)[fest].push(label);
      }
    }
  }
  return m;
})();

// Name normalization — MUST stay byte-for-byte identical to norm_name() in build-awards.sh.
function normName(s) {
  return (s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')  // strip accents (combining marks)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Desired oscar-tag set for an item given its current tags + award entry ({wins,noms} or null).
function desiredTags(current, award, festival) {
  const base = (current || []).filter((t) => !OSCAR_TAG_RE.test(t) && !FESTIVAL_TAG_RE.test(t));
  const wins = (award && award.wins) || 0;
  const losses = Math.max(0, ((award && award.noms) || 0) - wins);
  const cannes = (festival && festival.cannes) || [];
  const sundance = (festival && festival.sundance) || [];
  const hasOscar = wins > 0 || losses > 0;
  const hasFestival = cannes.length > 0 || sundance.length > 0;
  if (!hasOscar && !hasFestival) return base;
  if (hasOscar) {
    base.push('oscars');
    if (wins > 0) base.push(`oscar-wins-${wins}`);
    if (losses > 0) base.push(`oscar-noms-${losses}`);
  }
  if (hasFestival) {
    base.push('festival');                       // presence marker (web bulk-query filter)
    if (cannes.length > 0) {
      base.push(`festival-cannes-${cannes.length}`);
      if (cannes.length === 1) base.push(`festival-cannes-name-${cannes[0]}`);
    }
    if (sundance.length > 0) {
      base.push(`festival-sundance-${sundance.length}`);
      if (sundance.length === 1) base.push(`festival-sundance-name-${sundance[0]}`);
    }
  }
  return base;
}

function sameTags(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((t) => s.has(t));
}

// Full-DTO fetch→patch→POST (same recipe as scripts/sort-collections.sh): POST /Items/{id} REPLACES
// the item, so patch only .Tags on the complete DTO — omitted fields get erased. Returns 'written',
// 'skip' (already correct) or 'failed'. Works for Movie and Person items alike.
async function reconcileTags(uid, h, item, award, festival) {
  const current = item.Tags || [];
  const want = desiredTags(current, award, festival);
  if (sameTags(current, want)) return 'skip';
  try {
    const dto = await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items/${item.Id}`, { headers: h }, 15000);
    dto.Tags = want;
    // Jellyfin 500s deserializing its own TrickplayInfoDto on POST /Items/{id} (constructor
    // binding bug), so any movie that has trickplay images fails the round-trip. Trickplay
    // isn't an editable metadata field — drop it from the payload.
    delete dto.Trickplay;
    const r = await tfetch(`${HOST.jellyfin}/Items/${item.Id}`, {
      method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(dto),
    }, 20000);
    return r.ok ? 'written' : 'failed';
  } catch (e) { console.log(`oscarTagsSweep: write failed for "${item.Name}" — ${e.message || e}`); return 'failed'; }
}

// Fetch ALL persons in one query. /Persons IGNORES StartIndex (verified live 2026-07-16: every
// page returns the same first 1000, TotalRecordCount echoes the Limit), so paging silently
// truncates. A single Limit=100000 query returns all ~23k in ~50s — hence the long timeout.
async function fetchAllPersons(uid, h) {
  const q = new URLSearchParams({ Fields: 'Tags', Limit: '100000', userId: uid });
  try {
    const res = await tfetchJson(`${HOST.jellyfin}/Persons?${q}`, { headers: h }, 180000);
    return res.Items || [];
  } catch (e) { console.log(`oscarTagsSweep: /Persons fetch failed — ${e.message || e}`); return []; }
}

// ---- Person oscar index (served to the Fire Stick fork) ----------------------------------
// The TV app cannot build this itself: it authenticates with a USER token, so the SDK sends
// userId on /Items, and user-scoped /Items excludes Person items entirely (returns 0 rows).
// /Persons does work but ignores StartIndex/Tags/EnableImages filters, so the app's only option
// there is one ~9.7 MB, 30-50s response — far too heavy to parse on a 1 GB Fire Stick.
// We already resolve every person→award here, so serve the answer directly: ~1.5k rows, ~50 KB.
// Shape mirrors the TAG semantics the client already parses: n = LOSING noms, not total.
let personOscarRows = null;
let personOscarBuiltAt = 0;
const PERSON_OSCAR_TTL_MS = 24 * 3600000;

function awardRow(id, award) {
  const wins = award.wins || 0;
  const losses = Math.max(0, (award.noms || 0) - wins);
  if (wins <= 0 && losses <= 0) return null;
  return { id, w: wins, n: losses };
}

// Build from a person list we already have in hand (the sweep's people pass).
function setPersonOscarIndex(people) {
  const rows = [];
  for (const p of people) {
    const award = personAwards[normName(p.Name)];
    if (!award || !p.Id) continue;
    const row = awardRow(p.Id, award);
    if (row) rows.push(row);
  }
  personOscarRows = rows;
  personOscarBuiltAt = Date.now();
  console.log(`personOscarIndex: ${rows.length} awarded people indexed`);
}

let personOscarBusy = false;
// Cached accessor for the API route. Rebuilds on demand (one /Persons call) when cold or stale,
// so the endpoint still works if it is hit before the first sweep completes.
async function getPersonOscarIndex() {
  const fresh = personOscarRows && (Date.now() - personOscarBuiltAt) < PERSON_OSCAR_TTL_MS;
  if (fresh || personOscarBusy) return personOscarRows || [];
  if (!cfg.JELLYFIN_KEY || !personAwards || !Object.keys(personAwards).length) return personOscarRows || [];
  personOscarBusy = true;
  try {
    const uid = await jellyfinUserId();
    const people = await fetchAllPersons(uid, { 'X-Emby-Token': cfg.JELLYFIN_KEY });
    if (people.length) setPersonOscarIndex(people);
  } catch (e) {
    console.log(`personOscarIndex: build failed — ${e.message || e}`);
  } finally { personOscarBusy = false; }
  return personOscarRows || [];
}

function personOscarIndexAge() {
  return personOscarBuiltAt ? Date.now() - personOscarBuiltAt : null;
}

let oscarTagsBusy = false;
async function oscarTagsSweep() {
  if (isMasterPaused() || oscarTagsBusy || !cfg.JELLYFIN_KEY) {
    console.log(`oscarTagsSweep: skipped (masterPaused=${isMasterPaused()} busy=${oscarTagsBusy} key=${!!cfg.JELLYFIN_KEY})`);
    return;
  }
  const haveFilms = filmAwards && Object.keys(filmAwards).length;
  const havePeople = personAwards && Object.keys(personAwards).length;
  if (!haveFilms && !havePeople) { console.log('oscarTagsSweep: no award data — skipping'); return; }
  oscarTagsBusy = true;
  try {
    const uid = await jellyfinUserId();
    const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };

    // ---- Movies pass (match by ProviderIds.Imdb) ----
    if (haveFilms) {
      const q = new URLSearchParams({ IncludeItemTypes: 'Movie', Recursive: 'true', Fields: 'ProviderIds,Tags', Limit: '5000' });
      const movies = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 120000)).Items) || [];
      let matched = 0, written = 0, removed = 0, noImdb = 0, failed = 0, festivalMatched = 0;
      for (const m of movies) {
        const imdb = m.ProviderIds && m.ProviderIds.Imdb;
        if (!imdb) noImdb++;
        const award = imdb ? filmAwards[imdb] : null;
        if (award) matched++;
        const tmdb = m.ProviderIds && m.ProviderIds.Tmdb;
        const festival = tmdb ? festivalByTmdb.get(String(tmdb)) : null;
        if (festival) festivalMatched++;   // separate counter — a film in BOTH oscar+festival
                                           // would otherwise double-count `matched`
        const res = await reconcileTags(uid, h, m, award, festival);
        if (res === 'written') { written++; if (!award && !festival) removed++; }
        else if (res === 'failed') failed++;
      }
      console.log(`oscarTagsSweep[movies]: ${matched} oscar-tagged, ${festivalMatched} festival-tagged, `
        + `${written} written, ${removed} removed`
        + (noImdb ? `, ${noImdb} without Imdb id (festival still matched if tagged)` : '') + (failed ? `, ${failed} failed` : ''));
    }

    // ---- People pass (match by normalized Name) ----
    if (havePeople) {
      const people = await fetchAllPersons(uid, h);
      // Feed the Fire Stick's index off the list we already paid for.
      if (people.length) setPersonOscarIndex(people);
      let matched = 0, written = 0, removed = 0, failed = 0;
      for (const p of people) {
        const award = personAwards[normName(p.Name)] || null;
        if (award) matched++;
        // Only touch a person who either matches now or still carries stale oscar tags — avoids
        // fetching a full DTO for the ~20k people who are neither.
        const hasOscarTag = (p.Tags || []).some((t) => OSCAR_TAG_RE.test(t));
        if (!award && !hasOscarTag) continue;
        const res = await reconcileTags(uid, h, p, award);
        if (res === 'written') { written++; if (!award) removed++; }
        else if (res === 'failed') failed++;
      }
      console.log(`oscarTagsSweep[people]: ${people.length} scanned, ${matched} tagged, ${written} written, ${removed} removed`
        + (failed ? `, ${failed} failed` : ''));
    }
  } catch (e) { console.log(`oscarTagsSweep: failed — ${e.message || e}`); }
  finally { oscarTagsBusy = false; }
}

function startOscarTagsTimer() {
  setInterval(oscarTagsSweep, 24 * 3600000);   // yearly-changing data — daily is plenty
}

module.exports = { oscarTagsSweep, startOscarTagsTimer, getPersonOscarIndex, personOscarIndexAge };
