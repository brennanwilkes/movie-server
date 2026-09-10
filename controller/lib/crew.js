'use strict';
// The film detail page's CREW row: director, writers, cinematographer, editor, composer and the
// other above-the-line heads of department, each annotated with their Oscar record exactly the
// way the cast row already is.
//
// WHY TMDB AND NOT JELLYFIN: Jellyfin's People array only carries Actor, Director and Writer —
// checked against this library, The Godfather has 30 Actors, 1 Director, 2 Writers and nothing
// else. There is no cinematographer, editor or composer in it at all. TMDB's /movie/{id}/credits
// returns the full crew (106 entries for the same film) with `job`, `department` and a
// `profile_path` for the headshot, so that is the source.
//
// Oscar counts come from the SAME personAwards table the cast badges use, keyed with the same
// normName(), so a crew member's badge cannot disagree with the one on their person page.
//
// Fail-soft like /api/awards: any failure returns an empty crew list and the client simply adds
// no row. Owns no timers.

const app = require('./app');
const { cfg, personAwards, HOST } = require('./config');
const { tfetchJson } = require('./clients');
const { jellyfinUserId } = require('./jellyfin');
const { normName } = require('./oscar-tags');
const { cachedFetch, _cache } = require('./cache');

// Credits for a released film essentially never change, and this sits on the detail-page render
// path where the Fire Stick gives up after a few seconds. A day is plenty fresh.
const CREW_TTL = 86400000;
const TMDB_TIMEOUT_MS = 8000;
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w300';

// The heads of department worth a card, in the order they are shown. This is a whitelist, not a
// filter: TMDB returns ~100 crew rows per film (stunt doubles, location coordinators, wardrobe
// supervisors) and a 10-foot row has room for the people you would actually name. Order is
// deliberate — Director first, then the writing credit, then the crafts in the order the awards
// are announced, which is also roughly the order a film nerd asks about them.
//
// NO PRODUCERS (2026-09-08). Producing is a financing and logistics credit, not an authorship one:
// the row filled up with names nobody in this house wants to click, and because crewPeopleSweep
// writes this same list into Jellyfin's People, every producer also became a person page whose
// filmography implied a creative link it doesn't have. Dropping the job here removes it
// everywhere at once — the detail row, the People backfill and the person pages that came from
// it. A producer who also directed, wrote, shot, cut or scored the film still gets a card for
// THAT credit, since the card is per person and keyed on their most senior listed job.
const JOBS = [
  'Director',
  'Screenplay', 'Writer', 'Story', 'Novel', 'Author',
  'Director of Photography',
  'Editor',
  'Original Music Composer', 'Music',
  'Production Design',
  'Costume Design',
];
const JOB_RANK = new Map(JOBS.map((j, i) => [j, i]));

// What the card actually says under the name. TMDB's own job strings are either too long for a
// card ("Director of Photography") or too vague ("Novel"), so they get display names; anything
// not listed falls through to the TMDB string unchanged.
const JOB_LABEL = {
  'Director of Photography': 'Cinematographer',
  'Original Music Composer': 'Composer',
  'Production Design': 'Production Designer',
  'Costume Design': 'Costume Designer',
  'Screenplay': 'Writer',
  'Story': 'Story',
  'Novel': 'Novel',
  'Author': 'Novel',
};

async function fetchCredits(tmdbId) {
  const key = cfg.TMDB_API_KEY;
  if (!key) return null;
  const url = `https://api.themoviedb.org/3/movie/${encodeURIComponent(tmdbId)}/credits?api_key=${key}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(TMDB_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`TMDB ${r.status}`);
  return r.json();
}

// One card per PERSON, not per credit. Coppola directed and wrote The Godfather; two identical
// headshots in a row would be noise, so the jobs are merged onto one card ("Director · Writer")
// and the card sorts by its highest-ranked job.
function buildCrew(credits) {
  const byPerson = new Map();
  for (const c of (credits && credits.crew) || []) {
    if (!JOB_RANK.has(c.job) || !c.name) continue;
    const id = c.id != null ? String(c.id) : normName(c.name);
    const label = JOB_LABEL[c.job] || c.job;
    const entry = byPerson.get(id) || {
      name: c.name,
      jobs: [],
      rank: Infinity,
      image: c.profile_path ? IMAGE_BASE + c.profile_path : null,
    };
    if (!entry.jobs.includes(c.job)) entry.jobs.push(c.job);
    entry.rank = Math.min(entry.rank, JOB_RANK.get(c.job));
    // A person can appear several times with only some rows carrying a photo.
    if (!entry.image && c.profile_path) entry.image = IMAGE_BASE + c.profile_path;
    byPerson.set(id, entry);
  }

  return [...byPerson.values()]
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .map((e) => {
      const award = personAwards[normName(e.name)] || null;
      // Sorted by JOBS rank, so jobs[0] is the person's most senior credit on this film.
      const jobs = [...e.jobs].sort((a, b) => JOB_RANK.get(a) - JOB_RANK.get(b));
      return {
        name: e.name,
        // The SINGLE most prominent role, not the full list. Coppola both directed and wrote The
        // Godfather, but on a card at three metres "Director" is the useful word and
        // "Director · Writer" is a second line that pushes the name out of view. The full list is
        // still in `jobs` for any client that wants it.
        role: JOB_LABEL[jobs[0]] || jobs[0],
        jobs,
        image: e.image,
        // LOSING nominations, not total — the same thing desiredTags() writes into `oscar-noms-N`
        // and therefore the same number every other badge in the app is drawn from. personAwards
        // stores TOTAL noms, so subtract the wins here exactly as desiredTags does; otherwise a
        // crew card would claim more nominations than the same person's cast card.
        oscarWins: (award && award.wins) || 0,
        oscarNoms: Math.max(0, ((award && award.noms) || 0) - ((award && award.wins) || 0)),
      };
    });
}

// ── name → Jellyfin person id ────────────────────────────────────────────────────────────────
// Resolved with a TARGETED /Persons search, one name at a time, cached.
//
// The first implementation used the whole-library name→id index that oscar-tags builds. That
// index is a single /Persons?Limit=100000 query, and measured on this box it is 78 seconds and
// 10.9 MB — and it simply TIMES OUT when Radarr, Sonarr and Jellyfin are all busy, which is
// exactly when someone is most likely to be on a detail page. When it timed out the index came
// back EMPTY, so every crew member on every film looked unlinkable: the shake was lying.
//
// A targeted search for one name is 25ms. That is ~3000x cheaper, it degrades per-name instead of
// library-wide, and it needs no warm-up. Measured side by side, 2026-09-07.
const PERSON_ID_TTL = 6 * 3600000;

// The longest whitespace-delimited token that survives accent-folding unchanged, i.e. one Jellyfin
// can actually match on. Returns '' when the whole name is non-ASCII.
function asciiToken(name) {
  let best = '';
  for (const t of String(name).split(/\s+/)) {
    // Strip punctuation so "Anna B." contributes "B" (too short to win) rather than "B.".
    const bare = t.replace(/[^\p{L}\p{N}]/gu, '');
    // Plain ASCII letters/digits only. Compared against /^[A-Za-z0-9]+$/ rather than against
    // normName(), which also LOWERCASES — comparing to that rejected every capitalised token and
    // made this return '' for every name.
    if (!/^[A-Za-z0-9]+$/.test(bare)) continue;
    if (bare.length > best.length) best = bare;
  }
  return best.length >= 3 ? best : '';
}

async function resolvePersonId(name) {
  if (!name || !cfg.JELLYFIN_KEY) return null;
  const key = `personid:${normName(name)}`;
  return cachedFetch(key, PERSON_ID_TTL, async () => {
    const uid = await jellyfinUserId();
    const want = normName(name);
    const headers = { 'X-Emby-Token': cfg.JELLYFIN_KEY };

    const lookup = async (term, limit) => {
      const q = new URLSearchParams({ searchTerm: term, Limit: String(limit), userId: uid });
      const items = ((await tfetchJson(`${HOST.jellyfin}/Persons?${q}`, { headers }, 8000)).Items) || [];
      // Always require an exact NORMALISED-name hit rather than taking the first row: searchTerm
      // is a substring match, so "Michael Curtiz" must not resolve to "Michael Curtis", and a
      // token search for "Janusz" must not resolve to "Janusz Głowacki".
      const hit = items.find((p) => normName(p.Name) === want);
      return (hit && hit.Id) || null;
    };

    // 1. The whole name. Works for any plain-ASCII name.
    const direct = await lookup(name, 5);
    if (direct) return direct;

    // 2. Fall back to one ASCII token.
    //
    // Jellyfin's person searchTerm CANNOT match a string containing diacritics — verified against
    // the live library: "Janusz Kamiński" returns nothing, and so does the folded "Janusz
    // Kaminski" and even the bare token "Kamin", yet searching "Janusz" returns him. So a
    // full-name lookup silently fails for every accented name, which for this library means most
    // of world cinema's crew (and it failed the same way BEFORE the People backfill — the
    // backfill just made it visible). Searching a token Jellyfin can match, then confirming with
    // the normalised full name, recovers them without ever risking a wrong match.
    const token = asciiToken(name);
    if (!token || normName(token) === want) return null;
    return lookup(token, 60);
  }, null);
}

// Drop every cached name→id answer. crewPeopleSweep creates Person records that did not exist
// when those answers were cached, and a stale `null` would keep a newly-created person's card
// unclickable for the rest of the TTL.
function invalidatePersonIds() {
  for (const k of Object.keys(_cache)) if (k.startsWith('personid:')) delete _cache[k];
}

// The cached crew list for one film, WITHOUT personId. Shared with crew-people.js, which walks
// the whole library nightly — going through the same cache means the backfill and the detail page
// never disagree, and the second of them to ask pays nothing.
async function crewFor(tmdb) {
  if (!tmdb) return [];
  return (await cachedFetch(
    `crew:${tmdb}`,
    CREW_TTL,
    async () => buildCrew(await fetchCredits(tmdb)),
    [],
  )) || [];
}

// GET /api/crew?tmdb=<id>
//
// Returns { tmdb, crew: [...] }. An empty crew array is a normal, expected answer (no TMDB key,
// no tmdb id, film not in TMDB, request failed) and means "render no crew row".
app.get('/api/crew', async (req, res) => {
  try {
    const tmdb = String((req.query && req.query.tmdb) || '').trim();
    if (!tmdb) return res.json({ tmdb: null, crew: [] });
    const crew = await crewFor(tmdb);
    // personId is resolved OUTSIDE the crew cache: baking a null into a 24h entry would leave a
    // film's cards unclickable for a day just because a lookup happened to fail once.
    const withIds = await Promise.all((crew || []).map(async (c) => ({
      ...c,
      personId: await resolvePersonId(c.name),
    })));
    res.json({ tmdb, crew: withIds });
  } catch (e) {
    // Never 500 a decorative row off the detail page.
    res.json({ tmdb: null, crew: [], error: String((e && e.message) || e) });
  }
});

module.exports = { buildCrew, crewFor, resolvePersonId, invalidatePersonIds, JOBS };
