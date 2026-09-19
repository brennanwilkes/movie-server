'use strict';
// Backfill the above-the-line CREW into each movie's Jellyfin People list.
//
// WHY: Jellyfin only creates a Person record for someone an item actually credits, and its
// metadata providers only ever write Actor, Director and Writer. So the library has no person at
// all for cinematographers, editors, composers or designers — measured 2026-09-07 across 237 crew
// credits, directors resolved to a Jellyfin Person 93% of the time but cinematographers, editors
// and composers ~8% and production/costume designers 0%. That is why two thirds of the detail
// page's Crew row had nowhere to click through to.
//
// Writing them into People is the cheap fix, and it is not a new feature so much as filling in
// data Jellyfin already has a place for: once a person is on an item, Jellyfin creates the Person
// entity itself and everything downstream comes free — a real person page, a filmography built
// from every item that credits them, search, and the Oscar badges that oscarTagsSweep already
// writes onto Person items by name. No new UI anywhere.
//
// SAFETY. This mutates library METADATA (never files on disk). It ADDS the crew above, and the
// ONE thing it removes is a Type=Producer entry (see PRODUCER_KIND below):
//   * every other existing People entry is copied through untouched, in its original order;
//   * a crew member already present by name is left alone, whatever their Type;
//   * a movie needing no change is never written at all.
// It cannot remove a cast member or reorder a cast list.
//
// PRODUCER CLEANUP (2026-09-08). An earlier version of this sweep wrote producers too, which put
// ~2000 producer credits into the library (88 of the first 100 films had at least one) and gave
// every producer a person page whose filmography read as a creative connection to films they had
// no authorship role in. crew.js no longer lists the job, so nothing recreates them — but the
// rows already written would have sat there forever, so the sweep now strips them as it goes.
// Removal is keyed on Type alone, which is safe in both directions: Jellyfin's own metadata
// providers write only Actor, Director and Writer (verified against this library), so a Producer
// entry can only have come from this sweep; and a producer who is ALSO in the cast was skipped by
// the name check when the rows were written, so their Actor entry is a different entry and is not
// touched.
//
// Timers: startCrewPeopleTimer() → an hourly tick that only works inside the nightly window. It
// is NOT run on boot (server.js only starts the timer), so a deploy does not kick off a
// library-wide metadata pass; use "Run now" in the Jobs tab to force one.

const jobs = require('./jobs');
const { cfg, HOST } = require('./config');
const { tfetch, tfetchJson } = require('./clients');
const { jellyfinUserId } = require('./jellyfin');
const { normName } = require('./oscar-tags');
const { crewFor, invalidatePersonIds } = require('./crew');

// Jellyfin's PersonKind enum (SDK 1.7.1) accepts exactly: Actor, AlbumArtist, Arranger, Artist,
// Author, Colorist, Composer, CoverArtist, Creator, Director, Editor, Engineer, Illustrator,
// Inker, Letterer, Lyricist, Mixer, Producer, Remixer, Translator, Unknown, Writer.
//
// Director/Writer/Composer/Editor map exactly. There is no cinematographer or designer kind, so
// those ride as Unknown and carry the job in Role, which is what the UI displays anyway. Sending
// an invalid kind risks the whole item write being rejected, so anything unmapped is Unknown
// rather than a guess.
//
// Producer is deliberately absent: crew.js stopped listing the job, so nothing reaches here with
// it, and leaving the mapping in would only make it look like a supported credit again.
const KIND = {
  'Director': 'Director',
  'Screenplay': 'Writer',
  'Writer': 'Writer',
  'Story': 'Writer',
  'Novel': 'Writer',
  'Author': 'Writer',
  'Original Music Composer': 'Composer',
  'Music': 'Composer',
  'Editor': 'Editor',
};

// The one People kind this sweep DELETES — see the PRODUCER CLEANUP note at the top of the file.
const PRODUCER_KIND = 'Producer';

// PACING. This job's whole risk is load, not correctness — it runs against the same Jellyfin the
// TV and the *arrs are using, and the box already sits around load 4-5 with Radarr, Sonarr and
// Jellyfin on it.
//
// The first draft asked for all ~955 movies with Fields=People in ONE query: measured at 219s for
// a 7.9 MB response, which pushed Jellyfin hard enough that the unrelated /Persons index fetch
// started timing out and crew links broke library-wide. So the listing is PAGED, with a pause
// between pages, and each page is small enough to come back in a couple of seconds.
const PAGE_SIZE = 100;
const PAGE_DELAY_MS = 750;
const WRITE_DELAY_MS = 250;
// Writes per run — a safety bound, not a throttle.
//
// This was 150 on the assumption that the pass needed rationing across several nights. Measured
// instead (2026-09-07): 25 films took 28s, so ~1.1s each and the whole ~955-film library is about
// 18 minutes — trivially inside the 3-hour window, at a load the box did not notice (2.4 while
// streaming). Rationing would have dragged the backfill out over a week for no reason, leaving
// most crew unclickable in the meantime.
//
// Set above the library size so a normal night finishes the job, while still capping the damage if
// something ever makes every film look like it needs rewriting on every pass.
const MAX_WRITES_PER_RUN = 1200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let busy = false;

async function crewPeopleSweep(opts = {}) {
  if (!cfg.JELLYFIN_KEY) { console.log('crewPeople: no Jellyfin key — skipping'); return; }
  if (busy) { console.log('crewPeople: already running — skipping tick'); return; }
  busy = true;
  try {
    const uid = await jellyfinUserId();
    const h = { Authorization: `MediaBrowser Token="${cfg.JELLYFIN_KEY || ''}"` };

    // Fields=People on the LISTING so a film that already has its crew is skipped without paying
    // a per-item DTO fetch — but paged, so the response is ~800 KB at a time instead of 7.9 MB.
    // /Items honours StartIndex (unlike /Persons, see fetchAllPersons in oscar-tags.js).
    const maxWrites = Number(opts.maxWrites) || MAX_WRITES_PER_RUN;
    const stopAfter = Number(opts.limit) || 0;   // test hook: examine only the first N films

    let scanned = 0, written = 0, added = 0, dropped = 0, skipped = 0, noTmdb = 0, failed = 0;
    let start = 0;
    outer: for (;;) {
      const q = new URLSearchParams({
        IncludeItemTypes: 'Movie', Recursive: 'true',
        Limit: String(PAGE_SIZE), StartIndex: String(start),
        Fields: 'ProviderIds,People', userId: uid,
      });
      const page = ((await tfetchJson(`${HOST.jellyfin}/Items?${q}`, { headers: h }, 60000)).Items) || [];
      if (!page.length) break;
      start += page.length;

      for (const m of page) {
        if (stopAfter && scanned >= stopAfter) break outer;
        scanned++;
        const tmdb = (m.ProviderIds || {}).Tmdb || (m.ProviderIds || {}).TMDB;
        if (!tmdb) { noTmdb++; continue; }

        // Producer entries left over from when this sweep still wrote them. Counted BEFORE the
        // crew fetch and OR-ed into the write decision, so a film that needs nothing added but
        // still carries producers is not skipped — otherwise the cleanup would never reach the
        // ~90% of the library that is already complete.
        const staleProducers = (m.People || []).some((p) => p.Type === PRODUCER_KIND);

        let crew;
        try { crew = await crewFor(String(tmdb)); }
        catch { failed++; continue; }
        if (!crew) crew = [];
        if (!crew.length && !staleProducers) { skipped++; continue; }

        const have = new Set((m.People || []).map((p) => normName(p.Name)));
        const missing = crew.filter((c) => !have.has(normName(c.name)));
        if (!missing.length && !staleProducers) { skipped++; continue; }

        const res = await writePeople(uid, h, m, missing);
        if (res.ok) { written++; added += res.added; dropped += res.removed; }
        else failed++;
        await sleep(WRITE_DELAY_MS);

        // Bounded work per run. The rest is picked up tomorrow — skipping a completed film is
        // cheap, so successive passes converge without ever repeating a write.
        if (written >= maxWrites) {
          console.log(`crewPeople: reached the ${maxWrites}-write cap for this run — resuming next pass`);
          break outer;
        }
      }
      if (page.length < PAGE_SIZE) break;
      await sleep(PAGE_DELAY_MS);
    }

    console.log(`crewPeople: ${scanned} scanned, ${written} films updated (+${added} people`
      + (dropped ? `, −${dropped} producer(s)` : '') + '), '
      + `${skipped} already complete, ${noTmdb} without a TMDB id`
      + (failed ? `, ${failed} failed` : ''));

    // Every person this sweep created was, until a moment ago, cached as "no such person" by
    // /api/crew's name→id lookup. Drop those answers so the new crew cards become clickable now
    // rather than whenever the 6h TTL happens to lapse.
    if (written) invalidatePersonIds();
  } catch (e) {
    console.log(`crewPeople: sweep failed — ${e?.message || e}`);
  } finally { busy = false; }
}

// Full-DTO fetch→patch→POST, the same recipe as oscar-tags' reconcileTags: POST /Items/{id}
// REPLACES the item, so the complete DTO has to go back with only People changed.
async function writePeople(uid, h, movie, missing) {
  try {
    const dto = await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items/${movie.Id}`, { headers: h }, 20000);
    const existing = Array.isArray(dto.People) ? dto.People : [];

    // Re-check against the DTO's own People, not just the list query's: the two come from
    // different queries and a film edited in between would otherwise get duplicates.
    const have = new Set(existing.map((p) => normName(p.Name)));
    const toAdd = missing
      .filter((c) => !have.has(normName(c.name)))
      .map((c) => ({
        Name: c.name,
        // jobs[0] is the person's most senior credit on this film (crew.js sorts by seniority).
        Type: KIND[c.jobs && c.jobs[0]] || 'Unknown',
        // The human label — "Cinematographer", "Production Designer". Jellyfin shows Role beneath
        // the name, so this is what makes an Unknown-typed person read correctly.
        Role: c.role || '',
      }));
    // Re-derived from the DTO for the same reason as `have` above.
    const keep = existing.filter((p) => p.Type !== PRODUCER_KIND);
    const removed = existing.length - keep.length;
    if (!toAdd.length && !removed) return { ok: true, added: 0, removed: 0 };   // nothing to do; success

    // APPEND, minus the producers. Every other existing entry passes through untouched and keeps
    // its order, so the cast list a person sees on the detail page is exactly what it was, with
    // crew after it.
    dto.People = keep.concat(toAdd);

    // Jellyfin 500s deserializing its own TrickplayInfoDto on POST /Items/{id} (constructor
    // binding bug), so any movie with trickplay images fails the round-trip. Trickplay is not an
    // editable metadata field — drop it from the payload.
    delete dto.Trickplay;

    const r = await tfetch(`${HOST.jellyfin}/Items/${movie.Id}`, {
      method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(dto),
    }, 30000);
    if (!r.ok) { console.log(`crewPeople: write rejected for "${movie.Name}" — HTTP ${r.status}`); return { ok: false, added: 0, removed: 0 }; }
    return { ok: true, added: toAdd.length, removed };
  } catch (e) {
    console.log(`crewPeople: write failed for "${movie.Name}" — ${e?.message || e}`);
    return { ok: false, added: 0, removed: 0 };
  }
}

// NIGHTLY WINDOW, not "every 24h from boot". A plain 24h interval lands wherever the last restart
// happened to fall, which on a box that already sits at load 4-5 with Radarr, Sonarr and Jellyfin
// running means it can just as easily fire mid-afternoon while someone is browsing. Same shape as
// the library audit's window.
const WINDOW_START = 3;
const WINDOW_END = 6;
const TICK_MS = 3600000;

function inWindow() {
  const h = new Date().getHours();
  return h >= WINDOW_START && h < WINDOW_END;
}

// Weight 58 puts it near the top of the Metadata group — above Oscar badges (56) and Nation flags
// (54), below Auto-collections (60), which is still the sweep the home screen depends on.
// pausedByMovieMode because it writes to Jellyfin, and nothing should be patching item metadata
// while someone is watching.
//
// `every` is the TICK, `cadenceMs` is how often the work actually comes round — see the note on
// the two in jobs.js. Without that split the Jobs tab would call this an hourly job and sink it
// below everything else as plumbing.
const tracked = jobs.define({
  id: 'crew-people', name: 'Crew people', group: 'Metadata', weight: 58,
  what: 'Adds directors, writers, DPs, editors and composers to each film so they get person pages',
  every: TICK_MS, cadenceMs: 24 * 3600000,
  scheduleText: `nightly ${String(WINDOW_START).padStart(2, '0')}:00–${String(WINDOW_END).padStart(2, '0')}:00`,
  pausedByMovieMode: true,
}, crewPeopleSweep);

function startCrewPeopleTimer() {
  // The window is checked HERE rather than inside the job, so "Run now" in the Jobs tab still
  // works at any hour — the guard is about unattended scheduling, not about refusing to work.
  setInterval(() => { if (inWindow()) tracked(); }, TICK_MS);
}

// `runCrewPeopleSweep` is the UNtracked function and is the only one that takes options — the
// jobs wrapper calls its fn with no arguments. It exists so a library-wide metadata change can be
// rehearsed on one film first: runCrewPeopleSweep({ limit: 1 }).
module.exports = { crewPeopleSweep: tracked, runCrewPeopleSweep: crewPeopleSweep, startCrewPeopleTimer, KIND };
