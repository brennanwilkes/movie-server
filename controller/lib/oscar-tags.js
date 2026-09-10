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

const app = require('./app');
const { cfg, HOST, filmAwards, personAwards, oscarWinners } = require('./config');
const { tfetch, tfetchJson } = require('./clients');
const { jellyfinUserId } = require('./jellyfin');
const { isMasterPaused } = require('./state');
const jobs = require('./jobs');

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
  // Built from the SAME list, in the same pass: crew.js needs normalised-name → Jellyfin person
  // id so the detail page's crew cards can link to a real person page. Piggy-backing here means
  // no second /Persons call — that query costs ~50s and returns ~9.7 MB.
  personIdByName = new Map();
  for (const p of people) if (p.Id && p.Name) personIdByName.set(normName(p.Name), p.Id);
  console.log(`personOscarIndex: ${rows.length} awarded people indexed, ${personIdByName.size} names → ids`);
}

// normName → Jellyfin person Id, for crew.js. NOT every crew member is in here: Jellyfin only
// creates a Person for someone an item actually credits, and items credit only Actor/Director/
// Writer — measured 2026-09-07, directors resolve 93% of the time but cinematographers, editors
// and composers ~8%, and production/costume designers 0%. Callers must handle a miss as normal.
let personIdByName = null;

// Shares getPersonOscarIndex's rebuild path, so a cold or stale index is refreshed by the same
// single /Persons fetch rather than a second one.
//
// BLOCKING. Only for callers that can wait minutes — the nightly sweep, not a request handler.
async function getPersonIdIndex() {
  await getPersonOscarIndex();
  return personIdByName || new Map();
}

// NON-BLOCKING variant, for request handlers.
//
// The rebuild behind getPersonIdIndex is a single /Persons query that returns ~9.7 MB and takes
// ~50s when the box is idle — and simply TIMES OUT when Jellyfin is busy, which is exactly when a
// detail page is most likely to be open. Awaiting it inside GET /api/crew meant the Fire Stick's
// 6s client timeout won every time: no crew row at all, and when the fetch failed outright the
// index came back empty so every crew member looked unlinkable. Both were live regressions.
//
// So: answer from whatever index exists right now — even an empty one — and warm it in the
// background for next time. A cold first request costs the crew their links for one page view,
// which is worth far more than costing everyone the row.
function peekPersonIdIndex() {
  const fresh = personOscarRows && (Date.now() - personOscarBuiltAt) < PERSON_OSCAR_TTL_MS;
  if (!fresh && !personOscarBusy) {
    // Fire and forget; getPersonOscarIndex has its own busy guard so this cannot pile up.
    getPersonOscarIndex().catch(() => { /* logged inside */ });
  }
  return personIdByName || new Map();
}

// Force the next getPersonIdIndex()/getPersonOscarIndex() to refetch.
//
// crewPeopleSweep creates Jellyfin Person records that did not exist when this index was built,
// and the index is cached for a DAY. Without this, crew cards for people the sweep just created
// would keep reporting "no person page" until tomorrow — the shake would be lying.
function invalidatePersonIndex() {
  personOscarBuiltAt = 0;
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

// Tracked for the Jobs tab; the export is wrapped so bootSequence's call counts (see collections.js).
const tracked = jobs.define({
  id: 'oscar-tags', name: 'Oscar badges', group: 'Metadata', weight: 56,
  what: 'Tags films and people with Oscar wins',
  every: 24 * 3600000, scheduleText: 'daily · and on boot', pausedByMovieMode: true,
}, oscarTagsSweep);

function startOscarTagsTimer() {
  setInterval(tracked, 24 * 3600000);   // yearly-changing data — daily is plenty
}

// ---- PER-AWARD DETAIL, for the detail pages ---------------------------------------------------
// The Tags carry COUNTS ("oscar-wins-1"), which is all a poster badge needs. A detail page wants
// the LIST — which award, which year, won or merely nominated (Brennan, 2026-08-09). That does not
// belong in Tags: a film with 11 nominations would need 11 more of them, and Jellyfin renders Tags
// verbatim in the detail page's own Tags line, where the existing three are already visible. So
// the list is served from here instead.
//
// Both clients can reach this. The web flair JS is same-host; the Fire TV fork already derives a
// controller base URL from the Jellyfin host and calls /api/hss/rows (HomeRowsFragment.kt), with a
// graceful fallback when the controller is unreachable — the same pattern applies here.
//
// Keyed by IMDb for Oscars (how film-awards.json is keyed) and by TMDB for festivals (how
// oscar-winners.json is keyed); a caller passes whichever ids Jellyfin gave it and gets back
// whatever matched. Read-only, and no heavier than a map lookup, so it is safe on every page load.
// ONE year, not a split season. The first six ceremonies covered an August-to-July eligibility
// window, so the dataset carries "1932/33" for them (Katharine Hepburn's Morning Glory, and every
// other award from those years). Seven characters where every neighbouring row has four throws the
// column's spacing out (Brennan, 2026-08-09), and the second half adds nothing a viewer wants.
//
// Take the leading year, which is the FILM's year — consistent with what the four-digit rows
// already show, and with the year rendered elsewhere on the detail page.
//
// Normalised HERE rather than in build-awards.sh or in each client: the raw value stays intact in
// film-awards.json for archival, and the web flair script and the Fire TV fetcher both consume this
// endpoint, so doing it once server-side means the two can never drift apart on it.
const shortYear = (y) => {
  const m = /^(\d{4})/.exec(String(y || ''));
  return m ? m[1] : String(y || '');
};

app.get('/api/awards', (req, res) => {
  try {
    const imdb = String(req.query.imdb || '').trim();
    const tmdb = String(req.query.tmdb || '').trim();
    // PEOPLE are matched by normalised NAME, not by id — Jellyfin's person records mostly carry no
    // IMDb id, which is why the tag sweep matches them this way too (see MATCHING at the top of
    // this file). normName() here and norm_name() in build-awards.sh must stay identical.
    const person = String(req.query.person || '').trim();
    const film = imdb ? filmAwards[imdb] : (person ? personAwards[normName(person)] : null);
    // Festivals are film awards; a person has none, so this stays empty on a person lookup.
    const fest = tmdb && !person ? festivalByTmdb.get(tmdb) : null;
    res.json({
      imdb: imdb || null,
      tmdb: tmdb || null,
      person: person || null,
      oscars: {
        wins: (film && film.wins) || 0,
        noms: (film && film.noms) || 0,
        // build-awards.sh already orders these wins-first then by category; passed through in that
        // order so every client renders the same list without re-deriving the sort.
        // `a.n` carries the row's OTHER party, and which party that is depends on the lookup: on a
        // film it is the people cited (pipe-delimited), on a person it is the film they were cited
        // for. Split into two distinctly-named fields rather than one ambiguous `nominees`, so a
        // client cannot render an actor's filmography under a "Nominees" label by accident.
        awards: ((film && film.a) || []).map((a) => (person
          ? { year: shortYear(a.y), category: a.c, won: !!a.w, film: a.n || '', nominees: [] }
          : { year: shortYear(a.y), category: a.c, won: !!a.w, film: '', nominees: a.n ? a.n.split('|').filter(Boolean) : [] })),
      },
      festivals: {
        cannes: (fest && fest.cannes) || [],
        sundance: (fest && fest.sundance) || [],
      },
    });
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
});

// normName is exported for crew.js, which annotates TMDB crew with Oscar counts out of the same
// personAwards table and MUST key it identically — see MATCHING at the top of this file.
module.exports = { oscarTagsSweep: tracked, startOscarTagsTimer, getPersonOscarIndex, personOscarIndexAge, normName, getPersonIdIndex, peekPersonIdIndex, invalidatePersonIndex };
