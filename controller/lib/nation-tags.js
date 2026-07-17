'use strict';
// Nation flag tags sweep. Writes a country-of-origin tag onto every "reasonably non-USA" movie,
// which BOTH clients (web flair JS + the Movie Night Fire Stick fork) read to draw a small retro
// flag in the BOTTOM-LEFT poster corner (watchlist=top-left, rank/oscars=top-right). Same
// tags-as-shared-source-of-truth recipe as oscar-tags.js. Owns: nationTagsBusy.
// Timers: startNationTagsTimer() → every 24h (boot run sequenced by server.js bootSequence()).
//
// Tags written (idempotent, diff-only):
//   nation            presence marker (lets the web client bulk-load all flagged movies in one
//                     Tags= query — per-country queries would be dozens of round trips)
//   nation-{iso2}     lowercase ISO 3166-1 alpha-2 country code, exactly one per flagged movie
//
// WHAT GETS A FLAG (per Brennan 2026-07-16):
//   • Original language ≠ English → ALWAYS flagged. Country = the production location matching
//     the original language when present (TMDB location order isn't authoritative — "The
//     Conformist" listed Germany first), else first non-US production location, else a
//     language→country fallback (rare: only movies with no ProductionLocations metadata).
//   • English-language → flagged only when ProductionLocations exist and do NOT include the USA
//     (UK/Canada/Australia/NZ/Ireland… get flags; US co-productions count as Hollywood).
//   Original language comes from Radarr (Jellyfin doesn't expose it); movies unknown to Radarr
//   fall back to the ProductionLocations rule alone.
//
// SAFETY (memory: storm 2026-07-07): metadata Tags only. Never deletes items, triggers searches/
// grabs, or touches user policies. nation* tags must NEVER be added to any BlockedTags.
// GOTCHA (memory: jellyfin-dto-write-gotchas): strip .Trickplay before POST /Items or movies
// with trickplay images 500.

const { cfg, HOST } = require('./config');
const { tfetch, tfetchJson, arrGet } = require('./clients');
const { jellyfinUserId } = require('./jellyfin');
const { isMasterPaused } = require('./state');

const NATION_TAG_RE = /^nation(-[a-z]{2})?$/;

// Jellyfin ProductionLocations names (TMDB-sourced) → ISO 3166-1 alpha-2. Covers everything a
// movie library plausibly contains; the sweep logs any name it can't map so this table can grow.
const COUNTRY_ISO = {
  'united states of america': 'us', 'united states': 'us', 'usa': 'us',
  'united kingdom': 'gb', 'uk': 'gb', 'england': 'gb', 'scotland': 'gb', 'wales': 'gb', 'northern ireland': 'gb',
  'canada': 'ca', 'australia': 'au', 'new zealand': 'nz', 'ireland': 'ie',
  'france': 'fr', 'germany': 'de', 'west germany': 'de', 'east germany': 'de',
  'italy': 'it', 'spain': 'es', 'portugal': 'pt', 'netherlands': 'nl', 'belgium': 'be',
  'switzerland': 'ch', 'austria': 'at', 'luxembourg': 'lu',
  'denmark': 'dk', 'sweden': 'se', 'norway': 'no', 'finland': 'fi', 'iceland': 'is',
  'japan': 'jp', 'south korea': 'kr', 'korea, south': 'kr', 'republic of korea': 'kr', 'korea': 'kr',
  'china': 'cn', "people's republic of china": 'cn', 'hong kong': 'hk', 'hong kong sar': 'hk',
  'taiwan': 'tw', 'india': 'in', 'thailand': 'th', 'vietnam': 'vn', 'indonesia': 'id',
  'philippines': 'ph', 'malaysia': 'my', 'singapore': 'sg',
  'brazil': 'br', 'mexico': 'mx', 'argentina': 'ar', 'chile': 'cl', 'colombia': 'co',
  'peru': 'pe', 'uruguay': 'uy', 'venezuela': 've', 'cuba': 'cu',
  'russia': 'ru', 'soviet union': 'ru', 'ussr': 'ru', 'ukraine': 'ua', 'poland': 'pl',
  'czech republic': 'cz', 'czechia': 'cz', 'czechoslovakia': 'cz', 'slovakia': 'sk',
  'hungary': 'hu', 'romania': 'ro', 'bulgaria': 'bg', 'greece': 'gr', 'serbia': 'rs',
  'croatia': 'hr', 'yugoslavia': 'rs', 'slovenia': 'si', 'estonia': 'ee', 'latvia': 'lv', 'lithuania': 'lt',
  'turkey': 'tr', 'israel': 'il', 'iran': 'ir', 'islamic republic of iran': 'ir',
  'egypt': 'eg', 'morocco': 'ma', 'tunisia': 'tn', 'algeria': 'dz', 'lebanon': 'lb',
  'saudi arabia': 'sa', 'united arab emirates': 'ae', 'qatar': 'qa', 'jordan': 'jo', 'iraq': 'iq',
  'south africa': 'za', 'nigeria': 'ng', 'kenya': 'ke', 'senegal': 'sn', 'ethiopia': 'et',
  'ghana': 'gh', 'namibia': 'na',
  'pakistan': 'pk', 'bangladesh': 'bd', 'sri lanka': 'lk', 'nepal': 'np', 'mongolia': 'mn',
  'kazakhstan': 'kz', 'georgia': 'ge', 'armenia': 'am', 'afghanistan': 'af',
  'colombia ': 'co', 'bolivia': 'bo', 'ecuador': 'ec', 'costa rica': 'cr', 'panama': 'pa',
  'dominican republic': 'do', 'guatemala': 'gt', 'jamaica': 'jm', 'puerto rico': 'pr',
  'malta': 'mt', 'cyprus': 'cy', 'monaco': 'mc', 'north macedonia': 'mk', 'bosnia and herzegovina': 'ba',
  'albania': 'al', 'belarus': 'by', 'moldova': 'md', 'cambodia': 'kh', 'laos': 'la', 'myanmar': 'mm',
  'north korea': 'kp', "korea, north": 'kp', 'macao': 'mo', 'macau': 'mo',
};

// Radarr originalLanguage.name → country, used ONLY for non-English movies with no
// ProductionLocations metadata (rare). Best-guess for ambiguous languages.
const LANG_ISO = {
  japanese: 'jp', korean: 'kr', french: 'fr', italian: 'it', german: 'de', spanish: 'es',
  portuguese: 'br', chinese: 'cn', mandarin: 'cn', cantonese: 'hk', hindi: 'in', tamil: 'in',
  telugu: 'in', bengali: 'in', punjabi: 'in', marathi: 'in', malayalam: 'in', kannada: 'in',
  danish: 'dk', norwegian: 'no', swedish: 'se', finnish: 'fi', icelandic: 'is',
  russian: 'ru', polish: 'pl', dutch: 'nl', flemish: 'be', thai: 'th', turkish: 'tr',
  arabic: 'eg', persian: 'ir', farsi: 'ir', hebrew: 'il', greek: 'gr', czech: 'cz',
  hungarian: 'hu', romanian: 'ro', vietnamese: 'vn', indonesian: 'id', ukrainian: 'ua',
  serbian: 'rs', 'serbo-croatian': 'rs', croatian: 'hr', bulgarian: 'bg', slovak: 'sk',
  estonian: 'ee', latvian: 'lv', lithuanian: 'lt', georgian: 'ge', armenian: 'am',
  swahili: 'ke', zulu: 'za', afrikaans: 'za', amharic: 'et', wolof: 'sn', urdu: 'pk',
  nepali: 'np', sinhala: 'lk', khmer: 'kh', lao: 'la', burmese: 'mm', mongolian: 'mn',
  kazakh: 'kz', catalan: 'es', basque: 'es', galician: 'es', quechua: 'pe', tagalog: 'ph',
  filipino: 'ph', malay: 'my',
};

const unmappedLogged = new Set();
function locToIso(name) {
  const key = String(name || '').trim().toLowerCase();
  const iso = COUNTRY_ISO[key];
  if (!iso && key && !unmappedLogged.has(key)) {
    unmappedLogged.add(key);
    console.log(`nationTagsSweep: unmapped production location "${name}" — add to COUNTRY_ISO`);
  }
  return iso || null;
}

// Decide the flag country for one movie: iso2 string, or null for no flag (Hollywood).
function resolveNation(locations, langName) {
  const locs = (locations || []).map(locToIso).filter(Boolean);
  const english = !langName || /^english$/i.test(langName);
  const nonUS = locs.filter((c) => c !== 'us');
  if (!english) {
    const langIso = LANG_ISO[String(langName).toLowerCase()];
    if (langIso && locs.includes(langIso)) return langIso;   // co-productions: language beats TMDB order
    return nonUS[0] || langIso || null;
  }
  if (locs.length && !locs.includes('us')) return locs[0];
  return null;
}

function desiredTags(current, iso) {
  const base = (current || []).filter((t) => !NATION_TAG_RE.test(t));
  if (iso) base.push('nation', `nation-${iso}`);
  return base;
}

function sameTags(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((t) => s.has(t));
}

// Full-DTO fetch→patch→POST (same recipe + Trickplay gotcha as oscar-tags.js reconcileTags).
async function reconcileTags(uid, h, item, iso) {
  const current = item.Tags || [];
  const want = desiredTags(current, iso);
  if (sameTags(current, want)) return 'skip';
  try {
    const dto = await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items/${item.Id}`, { headers: h }, 15000);
    dto.Tags = want;
    delete dto.Trickplay;   // Jellyfin 500s round-tripping its own TrickplayInfoDto
    const r = await tfetch(`${HOST.jellyfin}/Items/${item.Id}`, {
      method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(dto),
    }, 20000);
    return r.ok ? 'written' : 'failed';
  } catch (e) { console.log(`nationTagsSweep: write failed for "${item.Name}" — ${e.message || e}`); return 'failed'; }
}

// imdbId/tmdbId → originalLanguage name, from Radarr's movie list (one call). Empty map on failure
// — the sweep then falls back to the ProductionLocations rule alone rather than skipping.
async function radarrLanguageMap() {
  const map = new Map();
  try {
    const movies = await arrGet('radarr', '/movie', 30000);
    for (const m of movies) {
      const lang = m.originalLanguage && m.originalLanguage.name;
      if (!lang) continue;
      if (m.imdbId) map.set(m.imdbId, lang);
      if (m.tmdbId) map.set(`tmdb:${m.tmdbId}`, lang);
    }
  } catch (e) { console.log(`nationTagsSweep: radarr language fetch failed (${e.message || e}) — using locations only`); }
  return map;
}

let nationTagsBusy = false;
async function nationTagsSweep() {
  if (isMasterPaused() || nationTagsBusy || !cfg.JELLYFIN_KEY) {
    console.log(`nationTagsSweep: skipped (masterPaused=${isMasterPaused()} busy=${nationTagsBusy} key=${!!cfg.JELLYFIN_KEY})`);
    return;
  }
  nationTagsBusy = true;
  try {
    const uid = await jellyfinUserId();
    const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };
    const langBy = await radarrLanguageMap();
    const q = new URLSearchParams({
      IncludeItemTypes: 'Movie', Recursive: 'true',
      Fields: 'ProviderIds,ProductionLocations,Tags', Limit: '5000',
    });
    const movies = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 120000)).Items) || [];
    let flagged = 0, written = 0, removed = 0, failed = 0;
    const byCountry = {};
    for (const m of movies) {
      const pid = m.ProviderIds || {};
      const lang = (pid.Imdb && langBy.get(pid.Imdb)) || (pid.Tmdb && langBy.get(`tmdb:${pid.Tmdb}`)) || null;
      const iso = resolveNation(m.ProductionLocations, lang);
      if (iso) { flagged++; byCountry[iso] = (byCountry[iso] || 0) + 1; }
      const res = await reconcileTags(uid, h, m, iso);
      if (res === 'written') { written++; if (!iso) removed++; }
      else if (res === 'failed') failed++;
    }
    const top = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(`nationTagsSweep: ${flagged}/${movies.length} flagged, ${written} written, ${removed} removed`
      + (failed ? `, ${failed} failed` : '') + (top ? ` — ${top}` : ''));
  } catch (e) { console.log(`nationTagsSweep: failed — ${e.message || e}`); }
  finally { nationTagsBusy = false; }
}

function startNationTagsTimer() {
  setInterval(nationTagsSweep, 24 * 3600000);   // country-of-origin never changes — daily re-check is plenty
}

module.exports = { nationTagsSweep, startNationTagsTimer, resolveNation };
