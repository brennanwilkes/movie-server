'use strict';
// TV series metadata tags. Writes the facts the Fire Stick TV Shows grid shows on each tile, as
// Jellyfin tags, in the same tags-as-shared-source-of-truth style as nation-tags.js and
// oscar-tags.js. Owns: tvMetaBusy. Timers: startTvMetaTimer() → every 24h.
//
// Tags written (idempotent, diff-only):
//   nation, nation-{iso2}  country of origin, SAME namespace the movie sweep uses — so the flag
//                          renders on a series with no client change at all.
//   tv-seasons-{n}         seasons that AIRED (TMDb number_of_seasons)
//   tv-episodes-{n}        episodes that AIRED (TMDb number_of_episodes)
//   tv-eplen-{m}           typical episode length in whole minutes
//
// WHY TMDb AND NOT SONARR/JELLYFIN. Jellyfin holds no ProductionLocations for series at all (0 of
// 98 on this library) and no aired totals — childCount/recursiveItemCount are what we HOLD, which
// is why the grid could only ever say "1 season" for a show we have one season of. All 98 series
// do carry a TMDb id, and one /tv/{id} call answers all three questions at once.
//
// EPISODE LENGTH comes from OUR OWN FILES first — the median runtime of the episodes in the
// library — because TMDb's episode_run_time is empty for a lot of modern shows (Breaking Bad and
// 1883 both return []). Measured beats declared anyway: it is the length of the thing that will
// actually play. TMDb is the fallback for a series we hold no timed episodes of.
//
// SAFETY (memory: storm 2026-07-07): metadata Tags only. Never deletes items, triggers searches or
// grabs, or touches user policies. These tags must NEVER be added to any BlockedTags.
// GOTCHA (memory: jellyfin-dto-write-gotchas): strip .Trickplay before POST /Items or the write 500s.

const { cfg, HOST } = require('./config');
const { tfetch, tfetchJson } = require('./clients');
const { jellyfinUserId } = require('./jellyfin');
const { isMasterPaused } = require('./state');
const jobs = require('./jobs');

const TV_TAG_RE = /^tv-(seasons|episodes|eplen)-\d+$/;
const NATION_TAG_RE = /^nation(-[a-z]{2})?$/;

// Countries whose English-language shows are still "foreign" for flag purposes — same rule the
// movie sweep uses: English + no US origin = flagged (UK/Canada/Australia/NZ/Ireland).
const ENGLISH_SPEAKING = new Set(['gb', 'ca', 'au', 'nz', 'ie']);

// Fallback home country for a non-English language whose origin_country list is empty. Deliberately
// short: TMDb gives origin_country for essentially every series, so this is a long stop, not a map
// to be grown. The movie sweep's LANG_COUNTRIES is the richer version if this ever needs more.
const LANG_HOME = {
  ja: 'jp', ko: 'kr', zh: 'cn', fr: 'fr', de: 'de', es: 'es', it: 'it', pt: 'br', ru: 'ru',
  sv: 'se', da: 'dk', nb: 'no', no: 'no', fi: 'fi', nl: 'nl', pl: 'pl', tr: 'tr', he: 'il',
  hi: 'in', ar: 'sa', th: 'th', is: 'is', cs: 'cz', hu: 'hu', ro: 'ro', el: 'gr', uk: 'ua',
};

/**
 * Flag country for one series: iso2, or null for "American, no flag".
 *
 * origin_country decides whenever it is unambiguous; the LEAD PRODUCTION COMPANY breaks the tie
 * when it is not. Both halves are there for a reason, established by running every candidate rule
 * across all 98 series on 2026-09-13:
 *
 *  • production_COUNTRIES is useless for ranking — TMDb lists it ALPHABETICALLY. "First production
 *    country wins" makes Planet Earth Japanese (JP, GB, US), Frozen Planet German (DE, GR, ES, GB,
 *    US) and Blue Planet II Chinese (CN, FR, DE, GB, US). Not used here at all.
 *
 *  • production_COMPANIES is ordered by importance, so its first entry is meaningful. That is what
 *    separates a genuinely foreign show from an American one shot abroad: Mr Inbetween leads with
 *    Jungle Entertainment (AU) and is Australian, while The Rookie leads with ABC Studios (US) and
 *    is American despite Entertainment One (CA) in the credits.
 *
 *  • The tie-breaker is needed because origin_country for a series often reports the NETWORK's
 *    country: Mr Inbetween is Australian but origin_country says US, because it aired on FX.
 *
 * Any US in origin_country hands the decision to the lead company, which keeps co-productions that
 * TMDb already calls American unflagged (Battlestar Galactica lists CA first but is a US show).
 * Restricting the override to English-speaking countries stops a US show that merely filmed abroad
 * from being flagged — True Detective is US/MX and stays American.
 *
 * Net effect when this replaced the origin-only rule: exactly two series changed, Mr Inbetween
 * (none → au) and Chernobyl (none → gb, lead company Sky UK). 14 flagged → 16.
 */
function resolveSeriesNation(originCountries, companyCountries, lang) {
  const lower = (xs) => (xs || []).map((c) => String(c || '').toLowerCase()).filter(Boolean);
  const origins = lower(originCountries);
  const companies = lower(companyCountries);
  const english = !lang || lang === 'en';

  if (!english) return origins[0] || companies[0] || LANG_HOME[lang] || null;

  // Unambiguously non-American origin — every BBC documentary lands here.
  if (origins.length && !origins.includes('us')) {
    return origins.find((c) => ENGLISH_SPEAKING.has(c)) || origins[0];
  }

  const lead = companies[0] || null;
  return lead && lead !== 'us' && ENGLISH_SPEAKING.has(lead) ? lead : null;
}

function desiredTags(current, iso, seasons, episodes, epLen) {
  const base = (current || []).filter((t) => !TV_TAG_RE.test(t) && !NATION_TAG_RE.test(t));
  if (iso) base.push('nation', `nation-${iso}`);
  if (seasons > 0) base.push(`tv-seasons-${seasons}`);
  if (episodes > 0) base.push(`tv-episodes-${episodes}`);
  if (epLen > 0) base.push(`tv-eplen-${epLen}`);
  return base;
}

function sameTags(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((t) => s.has(t));
}

/** Median runtime in whole minutes of the episodes we actually hold, or 0 if none are timed. */
async function heldEpisodeMinutes(uid, h, seriesId) {
  try {
    const q = new URLSearchParams({
      ParentId: seriesId, IncludeItemTypes: 'Episode', Recursive: 'true', Limit: '80',
    });
    const items = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 20000)).Items) || [];
    const mins = items.map((i) => Math.round((i.RunTimeTicks || 0) / 600000000)).filter((m) => m > 0).sort((a, b) => a - b);
    if (!mins.length) return 0;
    // Median, not mean: a feature-length finale or a 3-minute recap would drag an average off the
    // number that describes the show.
    return mins[Math.floor(mins.length / 2)];
  } catch { return 0; }
}

async function tmdbSeries(tmdbId) {
  if (!cfg.TMDB_API_KEY) return null;
  try {
    return await tfetchJson(
      `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${cfg.TMDB_API_KEY}`, {}, 15000);
  } catch { return null; }
}

async function reconcileTags(uid, h, item, want) {
  const current = item.Tags || [];
  if (sameTags(current, want)) return 'skip';
  try {
    const dto = await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items/${item.Id}`, { headers: h }, 15000);
    dto.Tags = want;
    delete dto.Trickplay;   // Jellyfin 500s round-tripping its own TrickplayInfoDto
    const r = await tfetch(`${HOST.jellyfin}/Items/${item.Id}`, {
      method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(dto),
    }, 20000);
    return r.ok ? 'written' : 'failed';
  } catch (e) { console.log(`tvMetaSweep: write failed for "${item.Name}" — ${e.message || e}`); return 'failed'; }
}

let tvMetaBusy = false;

async function tvMetaSweep() {
  if (isMasterPaused() || tvMetaBusy || !cfg.JELLYFIN_KEY) {
    console.log(`tvMetaSweep: skipped (masterPaused=${isMasterPaused()} busy=${tvMetaBusy} key=${!!cfg.JELLYFIN_KEY})`);
    return;
  }
  tvMetaBusy = true;
  try {
    const uid = await jellyfinUserId();
    const h = { Authorization: `MediaBrowser Token="${cfg.JELLYFIN_KEY}"` };
    const q = new URLSearchParams({
      IncludeItemTypes: 'Series', Recursive: 'true', Fields: 'ProviderIds,Tags', Limit: '2000',
    });
    const series = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 60000)).Items) || [];

    let written = 0, skipped = 0, failed = 0, flagged = 0, noTmdb = 0, noLen = 0;
    for (const s of series) {
      const tmdbId = (s.ProviderIds || {}).Tmdb;
      const meta = tmdbId ? await tmdbSeries(tmdbId) : null;
      if (!meta) noTmdb++;

      const iso = meta
        ? resolveSeriesNation(
          meta.origin_country,
          // Ordered by importance by TMDb; blanks dropped so the first REAL country leads.
          (meta.production_companies || []).map((c) => c.origin_country).filter(Boolean),
          meta.original_language,
        )
        : null;
      if (iso) flagged++;
      const seasons = Math.max(0, parseInt(meta?.number_of_seasons, 10) || 0);
      const episodes = Math.max(0, parseInt(meta?.number_of_episodes, 10) || 0);

      // Ours first, TMDb's declared runtime only as a fallback.
      let epLen = await heldEpisodeMinutes(uid, h, s.Id);
      if (!epLen) {
        const declared = (meta?.episode_run_time || []).filter((n) => n > 0);
        epLen = declared.length ? Math.round(declared.reduce((a, b) => a + b, 0) / declared.length) : 0;
      }
      if (!epLen) noLen++;

      const res = await reconcileTags(uid, h, s, desiredTags(s.Tags, iso, seasons, episodes, epLen));
      if (res === 'written') written++;
      else if (res === 'skip') skipped++;
      else failed++;
    }

    console.log(`tvMetaSweep: ${series.length} series — ${written} written, ${skipped} unchanged, `
      + `${flagged} flagged${noTmdb ? `, ${noTmdb} without TMDb` : ''}`
      + `${noLen ? `, ${noLen} without an episode length` : ''}${failed ? `, ${failed} failed` : ''}`);
  } catch (e) { console.log(`tvMetaSweep: failed — ${e.message || e}`); }
  finally { tvMetaBusy = false; }
}

// Tracked for the Jobs tab; the export is wrapped so bootSequence's call counts.
const tracked = jobs.define({
  id: 'tv-meta', name: 'TV series metadata', group: 'Metadata', weight: 40,
  what: 'Tags series with country, aired counts and episode length',
  every: 24 * 3600000, scheduleText: 'daily · and on boot', pausedByMovieMode: true,
}, tvMetaSweep);

function startTvMetaTimer() {
  setInterval(tracked, 24 * 3600000);   // aired totals move an episode at a time — daily is plenty
}

module.exports = { tvMetaSweep: tracked, startTvMetaTimer, resolveSeriesNation };
