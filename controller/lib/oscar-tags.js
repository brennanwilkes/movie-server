'use strict';
// Oscar badge tags sweep. Writes per-film AND per-person Academy Award counts onto Jellyfin item
// Tags, which BOTH clients (web flair JS + the Movie Night Fire Stick fork) read to draw gold/silver
// statuette badges on posters and person cards. Tags are the shared source of truth: they ride along
// on queries both clients already make, survive controller downtime, and need no second backend.
// See DESIGN-OSCAR-BADGES.md. Owns: oscarTagsBusy. Timers: startOscarTagsTimer() → every 24h
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

const { cfg, HOST, filmAwards, personAwards } = require('./config');
const { tfetch, tfetchJson } = require('./clients');
const { jellyfinUserId } = require('./jellyfin');
const { isMasterPaused } = require('./state');

const OSCAR_TAG_RE = /^oscar(s|-wins-\d+|-noms-\d+)$/;

// Name normalization — MUST stay byte-for-byte identical to norm_name() in build-awards.sh.
function normName(s) {
  return (s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')  // strip accents (combining marks)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Desired oscar-tag set for an item given its current tags + award entry ({wins,noms} or null).
function desiredTags(current, award) {
  const base = (current || []).filter((t) => !OSCAR_TAG_RE.test(t));
  if (!award) return base;
  const wins = award.wins || 0;
  const losses = Math.max(0, (award.noms || 0) - wins);
  if (wins <= 0 && losses <= 0) return base;
  base.push('oscars');
  if (wins > 0) base.push(`oscar-wins-${wins}`);
  if (losses > 0) base.push(`oscar-noms-${losses}`);
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
async function reconcileTags(uid, h, item, award) {
  const current = item.Tags || [];
  const want = desiredTags(current, award);
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
      let matched = 0, written = 0, removed = 0, noImdb = 0, failed = 0;
      for (const m of movies) {
        const imdb = m.ProviderIds && m.ProviderIds.Imdb;
        if (!imdb) noImdb++;
        const award = imdb ? filmAwards[imdb] : null;
        if (award) matched++;
        const res = await reconcileTags(uid, h, m, award);
        if (res === 'written') { written++; if (!award) removed++; }
        else if (res === 'failed') failed++;
      }
      console.log(`oscarTagsSweep[movies]: ${matched} tagged, ${written} written, ${removed} removed`
        + (noImdb ? `, ${noImdb} without Imdb id` : '') + (failed ? `, ${failed} failed` : ''));
    }

    // ---- People pass (match by normalized Name) ----
    if (havePeople) {
      const people = await fetchAllPersons(uid, h);
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

module.exports = { oscarTagsSweep, startOscarTagsTimer };
