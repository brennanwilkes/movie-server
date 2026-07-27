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

// Radarr originalLanguage.name → the countries where that language is a primary language, in
// rough "most likely to be the production home" order. Used to pick WHICH production country a
// non-English movie belongs to (see resolveNation).
//
// This is a LIST, not a single country, on purpose. A one-country-per-language table gets
// co-productions wrong in both directions: arabic→'eg' missed Lebanon on Capernaum (France was
// listed first, so it flagged French), and chinese→'cn' missed Hong Kong on In the Mood for Love.
// Matching the language against every production country and taking the earliest hit resolves
// both, and also fixes Incendies (Quebec — ca is in the French list) and The Secret in Their Eyes
// (Argentina, listed ahead of Spain). Brennan 2026-07-26.
const LANG_COUNTRIES = {
  japanese: ['jp'], korean: ['kr', 'kp'],
  french: ['fr', 'be', 'ca', 'ch', 'lu', 'sn', 'ma', 'dz', 'tn'],
  italian: ['it', 'ch'],
  german: ['de', 'at', 'ch'],
  spanish: ['es', 'mx', 'ar', 'cl', 'co', 'pe', 'uy', 've', 'cu', 'bo', 'ec', 'cr', 'pa', 'do', 'gt'],
  portuguese: ['br', 'pt'],
  chinese: ['cn', 'tw', 'hk', 'sg'], mandarin: ['cn', 'tw', 'sg'], cantonese: ['hk', 'cn'],
  hindi: ['in'], tamil: ['in', 'lk'], telugu: ['in'], bengali: ['in', 'bd'], punjabi: ['in', 'pk'],
  marathi: ['in'], malayalam: ['in'], kannada: ['in'],
  danish: ['dk'], norwegian: ['no'], swedish: ['se', 'fi'], finnish: ['fi'], icelandic: ['is'],
  russian: ['ru', 'by', 'kz', 'ua'], polish: ['pl'], dutch: ['nl', 'be'], flemish: ['be'],
  thai: ['th'], turkish: ['tr', 'cy'],
  arabic: ['eg', 'lb', 'ma', 'tn', 'dz', 'sa', 'ae', 'qa', 'jo', 'iq'],
  persian: ['ir', 'af'], farsi: ['ir', 'af'], hebrew: ['il'], greek: ['gr', 'cy'],
  czech: ['cz'], hungarian: ['hu'], romanian: ['ro', 'md'], vietnamese: ['vn'],
  indonesian: ['id'], ukrainian: ['ua'],
  serbian: ['rs', 'ba'], 'serbo-croatian': ['rs', 'hr', 'ba'], croatian: ['hr', 'ba'],
  bulgarian: ['bg'], slovak: ['sk'], estonian: ['ee'], latvian: ['lv'], lithuanian: ['lt'],
  georgian: ['ge'], armenian: ['am'],
  swahili: ['ke', 'tz'], zulu: ['za'], afrikaans: ['za', 'na'], amharic: ['et'], wolof: ['sn'],
  urdu: ['pk', 'in'], nepali: ['np'], sinhala: ['lk'], khmer: ['kh'], lao: ['la'],
  burmese: ['mm'], mongolian: ['mn'], kazakh: ['kz'],
  catalan: ['es'], basque: ['es'], galician: ['es'], quechua: ['pe', 'bo'],
  tagalog: ['ph'], filipino: ['ph'], malay: ['my', 'sg'],
};

// ISO 639-1 spoken_languages code → ISO 3166-1 alpha-2 country. Used to override a bad Radarr
// originalLanguage when the spoken_languages data from TMDB disagrees.
const ISO_639_1_TO_COUNTRY = {
  // TMDB spells Cantonese 'cn' (not an ISO 639-1 code) and Mandarin 'zh'. Without the 'cn' entry
  // a Cantonese film's only spoken language was unmappable and the loop fell through to whatever
  // European co-production language came next — that is how In the Mood for Love became French.
  cn: 'hk', yue: 'hk',
  ja: 'jp', ko: 'kr', fr: 'fr', it: 'it', de: 'de', es: 'es',
  pt: 'br', zh: 'cn', hi: 'in', ta: 'in', te: 'in', bn: 'in',
  pa: 'in', mr: 'in', ml: 'in', kn: 'in',
  da: 'dk', no: 'no', sv: 'se', fi: 'fi', is: 'is',
  ru: 'ru', pl: 'pl', nl: 'nl', th: 'th', tr: 'tr',
  ar: 'eg', fa: 'ir', he: 'il', el: 'gr', cs: 'cz',
  hu: 'hu', ro: 'ro', vi: 'vn', id: 'id', uk: 'ua',
  sr: 'rs', hr: 'hr', bg: 'bg', sk: 'sk',
  lv: 'lv', lt: 'lt', et: 'ee', ka: 'ge', hy: 'am',
  sw: 'ke', zu: 'za', af: 'za', am: 'et', wo: 'sn', ur: 'pk',
  ne: 'np', si: 'lk', km: 'kh', lo: 'la', my: 'mm', mn: 'mn',
  kk: 'kz', az: 'az', eu: 'es', ca: 'es', gl: 'es', tl: 'ph',
};

// Radarr originalLanguage.name (lowercase) → ISO 639-1 code. Reverse lookup so we can compare
// the Radarr language against TMDB's spoken_languages array.
const LANG_NAME_TO_ISO639_1 = {
  english: 'en', french: 'fr', spanish: 'es', italian: 'it', german: 'de',
  japanese: 'ja', korean: 'ko', chinese: 'zh', mandarin: 'zh', cantonese: 'zh',
  hindi: 'hi', tamil: 'ta', telugu: 'te', portuguese: 'pt',
  russian: 'ru', polish: 'pl', dutch: 'nl', danish: 'da', norwegian: 'no',
  swedish: 'sv', finnish: 'fi', icelandic: 'is', turkish: 'tr', arabic: 'ar',
  persian: 'fa', farsi: 'fa', hebrew: 'he', greek: 'el', czech: 'cs',
  hungarian: 'hu', romanian: 'ro', vietnamese: 'vi', indonesian: 'id', ukrainian: 'uk',
  thai: 'th', serbian: 'sr', croatian: 'hr', bulgarian: 'bg', slovak: 'sk',
  latvian: 'lv', lithuanian: 'lt', estonian: 'ee', georgian: 'ka', armenian: 'hy',
  swahili: 'sw', urdu: 'ur', nepali: 'ne', khmer: 'km', burmese: 'my',
  mongolian: 'mn', kazakh: 'kk', tagalog: 'tl', filipino: 'tl', malay: 'ms',
  catalan: 'ca', basque: 'eu', galician: 'gl',
};

// Last-resort manual overrides, keyed by IMDb id (stable across TMDB re-scrapes; Jellyfin's own
// item ids are not). ONLY add an entry when every queryable source is demonstrably wrong — if the
// right answer is derivable from ProductionLocations, spoken_languages or production_countries,
// fix resolveNation instead so the whole library benefits.
const NATION_OVERRIDES = {
  // Roma (2018) — Cuaron's Mexico City film, flagged GB. Verified against TMDB 2026-07-26:
  // production_countries = [GB, US], origin_country = [US], and Cuaron's own Mexican company
  // Esperanto Filmoj is tagged origin GB. Jellyfin's ProductionLocations mirror that. The
  // spoken_languages cross-check can't help either: it only fires when Radarr's language is
  // absent from TMDB's spoken list, and Roma's 'es' is present. Nothing we can query says Mexico.
  tt6155172: 'mx',
  // Paris, Texas (1984) — Wenders' West German/French production, flagged GB. It IS an
  // English-language film with a British co-producer (Channel 4), which is exactly what the
  // ENGLISH_SPEAKING preference is designed to pick up (it's what correctly makes Hot Fuzz
  // British). Here that heuristic misfires: the film is German by any normal reckoning.
  tt0087884: 'de',
  // It Was Just an Accident (2025) — Panahi's Iranian film. Both Radarr and TMDB record the
  // original language as French; TMDB's spoken_languages ([az, fa]) shows no French at all, and
  // Iran is the first production country. The spoken-language cross-check does reach 'ir' here,
  // but only when it is allowed to fire — and it cannot be, because "Last Tango in Paris" is
  // structurally identical (claimed Italian, no Italian dialogue, France listed first) and the
  // same rule turns that one French. The two are indistinguishable from metadata alone.
  tt36491653: 'ir',
  // Incendies (2010) — Villeneuve's Quebec film. France co-produced, and French is French's home
  // country, so every language-based rule lands on France. Canadian by production and director.
  tt1255953: 'ca',
  // The Secret in Their Eyes (2009) — Campanella's Argentine film (won Argentina the foreign-film
  // Oscar). Spain co-produced and Spain is Spanish's home country, so the same rule applies.
  tt1305806: 'ar',
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

// English-speaking production countries: prefer these over non-English co-production partners
// when the original language is English (fixes e.g. Hot Fuzz FR→GB — TMDB lists France first
// due to a Working Title co-production credit, but the movie is British).
const ENGLISH_SPEAKING = new Set(['gb', 'ca', 'au', 'nz', 'ie']);

// Decide the flag country for one movie: iso2 string, or null for no flag (Hollywood).
// Returns { iso, matchedLanguage } — matchedLanguage tells the sweep whether the production
// countries actually corroborated the original language, which gates the TMDB override.
function resolveNation(locations, langName) {
  const locs = (locations || []).map(locToIso).filter(Boolean);
  const english = !langName || /^english$/i.test(langName);
  const nonUS = locs.filter((c) => c !== 'us');
  if (!english) {
    // Prefer the language's HOME country when it co-produced (family[0] — 'de' for German, 'fr'
    // for French); only then fall back to the earliest listed country that also speaks it.
    //
    // The order matters. Ranking purely by production-location order instead looked tempting but
    // regressed real tags: Downfall lists Austria before Germany (→ Austrian), and The Taste of
    // Things lists Belgium before France (→ Belgian). TMDB's location order carries no signal
    // about which partner is the film's home. Checking the home country first is the safe read,
    // and the earliest-other-speaker fallback still catches the cases where the home country
    // isn't involved at all: Capernaum (Arabic, no Egypt → Lebanon) and In the Mood for Love
    // (Cantonese/Chinese, no mainland → Hong Kong). Brennan 2026-07-26.
    const family = LANG_COUNTRIES[String(langName).toLowerCase()] || [];
    if (family.length && locs.includes(family[0])) return { iso: family[0], matchedLanguage: true };
    const hit = locs.find((c) => family.includes(c));
    if (hit) return { iso: hit, matchedLanguage: true };
    // No production country speaks it — fall back to the first non-US partner, else the
    // language's home country (the only option for movies with no ProductionLocations at all).
    return { iso: nonUS[0] || family[0] || null, matchedLanguage: false };
  }
  if (locs.length && !locs.includes('us')) {
    const engMatch = nonUS.find((c) => ENGLISH_SPEAKING.has(c));
    // matchedLanguage: an English-speaking co-production partner corroborates "English film".
    return { iso: engMatch || nonUS[0], matchedLanguage: !!engMatch };
  }
  return { iso: null, matchedLanguage: true };   // Hollywood — nothing to second-guess
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

// imdbId/tmdbId → originalLanguage name, from Radarr's movie list (one call). Returns
// { langBy: Map, movies: Array } so callers can cross-check against TMDB without a second fetch.
// Empty map + empty array on failure — the sweep falls back to ProductionLocations alone.
async function radarrLanguageMap() {
  const map = new Map();
  let movies = [];
  try {
    movies = await arrGet('radarr', '/movie', 30000);
    for (const m of movies) {
      const lang = m.originalLanguage && m.originalLanguage.name;
      if (!lang) continue;
      if (m.imdbId) map.set(m.imdbId, lang);
      if (m.tmdbId) map.set(`tmdb:${m.tmdbId}`, lang);
    }
  } catch (e) { console.log(`nationTagsSweep: radarr language fetch failed (${e.message || e}) — using locations only`); }
  return { langBy: map, movies };
}

// Build a map: tmdbId (string) → { spoken: Set<iso639_1>, countries: Set<iso3166> }. Cross-checks
// Radarr's originalLanguage against TMDB's ground-truth spoken languages + production countries.
// Only fetches for non-English movies (English needs no override). Returns empty Map on missing
// API key or total failure.
async function tmdbSpokenLangMap(radarrMovies) {
  const key = cfg.TMDB_API_KEY;
  if (!key) { console.log('nationTagsSweep: no TMDB_API_KEY — skipping spoken_languages cross-check'); return new Map(); }

  // Only fetch for non-English Radarr movies that have a tmdbId
  const toFetch = radarrMovies.filter((m) => {
    if (!m.tmdbId) return false;
    const lang = m.originalLanguage && m.originalLanguage.name;
    return lang && !/^english$/i.test(lang);
  });
  if (!toFetch.length) return new Map();

  console.log(`nationTagsSweep: cross-checking ${toFetch.length} non-English movies against TMDB spoken_languages`);
  const result = new Map();
  const BATCH = 10;
  for (let i = 0; i < toFetch.length; i += BATCH) {
    const batch = toFetch.slice(i, i + BATCH);
    await Promise.all(batch.map(async (m) => {
      try {
        const r = await fetch(`https://api.themoviedb.org/3/movie/${m.tmdbId}?api_key=${key}`, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) return;
        const data = await r.json();
        const spoken = new Set((data.spoken_languages || []).map((l) => l.iso_639_1).filter(Boolean));
        // 'su' (Soviet Union) is a historic code TMDB still uses for Tarkovsky/Klimov et al.
        // Normalise to 'ru' so it matches ISO_639_1_TO_COUNTRY['ru'] in the cross-check below —
        // otherwise a Soviet film's production countries look like they speak nothing at all.
        const countries = new Set((data.production_countries || []).map((c) => c.iso_3166_1).filter(Boolean)
          .map((c) => c.toLowerCase()).map((c) => (c === 'su' ? 'ru' : c)));
        if (spoken.size) result.set(String(m.tmdbId), { spoken, countries });
      } catch { /* skip — fall back to existing logic */ }
    }));
    if (i + BATCH < toFetch.length) await new Promise((r) => setTimeout(r, 50));
  }
  console.log(`nationTagsSweep: TMDB spoken_languages fetched for ${result.size}/${toFetch.length} movies`);
  return result;
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
    const { langBy, movies: radarrMovies } = await radarrLanguageMap();
    const spokenBy = await tmdbSpokenLangMap(radarrMovies);
    const q = new URLSearchParams({
      IncludeItemTypes: 'Movie', Recursive: 'true',
      Fields: 'ProviderIds,ProductionLocations,Tags', Limit: '5000',
    });
    const movies = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 120000)).Items) || [];
    let flagged = 0, written = 0, removed = 0, failed = 0, overrides = 0;
    const byCountry = {};
    for (const m of movies) {
      const pid = m.ProviderIds || {};
      let lang = (pid.Imdb && langBy.get(pid.Imdb)) || (pid.Tmdb && langBy.get(`tmdb:${pid.Tmdb}`)) || null;
      let iso = null;
      let overridden = false;

      // Manual override wins over every derived signal — see NATION_OVERRIDES.
      const manual = pid.Imdb && NATION_OVERRIDES[pid.Imdb];
      if (manual) { iso = manual; overridden = true; }

      // Derive from production locations + original language first, so the TMDB cross-check below
      // knows whether that already produced a corroborated answer.
      const resolved = resolveNation(m.ProductionLocations, lang);

      // TMDB spoken_languages cross-check: if Radarr's language isn't in TMDB's spoken_languages,
      // the Radarr metadata is likely wrong. Use the spoken language's country directly.
      // When multiple spoken languages exist, prefer the one matching a TMDB production country.
      //
      // GATED on resolved.matchedLanguage (2026-07-26). Ungated, this fired whenever the claimed
      // language merely went unlisted in spoken_languages and wrecked two correct tags: "In the
      // Mood for Love" (Radarr "Chinese"→zh, but TMDB spells Cantonese 'cn', so zh looked absent)
      // became French, and "Last Tango in Paris" (Italian production, dialogue in English/French)
      // became French. Both had a production country that speaks the claimed language, so
      // resolveNation already had a corroborated answer and there was nothing to correct. Only
      // consult TMDB when resolveNation was reduced to guessing.
      if (!overridden && !resolved.matchedLanguage && lang && pid.Tmdb) {
        const tmdbData = spokenBy.get(String(pid.Tmdb));
        if (tmdbData && tmdbData.spoken.size > 0 && !tmdbData.spoken.has('xx')) {
          const radarrIso = LANG_NAME_TO_ISO639_1[String(lang).toLowerCase()];
          if (radarrIso && !tmdbData.spoken.has(radarrIso)) {
            // Find best spoken language: prefer one whose country is in production_countries
            for (const code of tmdbData.spoken) {
              const country = ISO_639_1_TO_COUNTRY[code];
              if (country && tmdbData.countries.has(country)) {
                console.log(`nationTagsSweep: tmdb override "${m.Name}": ol=${lang} → spoken=${code} (country=${country}, matched production)`);
                iso = country;
                overridden = true;
                overrides++;
                break;
              }
            }
            // Fallback: no spoken language matched a production country — pick first mappable one
            if (!overridden) {
              for (const code of tmdbData.spoken) {
                const country = ISO_639_1_TO_COUNTRY[code];
                if (country) {
                  console.log(`nationTagsSweep: tmdb override "${m.Name}": ol=${lang} → spoken=${code} (country=${country}, no prod match)`);
                  iso = country;
                  overridden = true;
                  overrides++;
                  break;
                }
              }
            }
          }
        }
      }

      if (!overridden) iso = resolved.iso;

      if (iso) { flagged++; byCountry[iso] = (byCountry[iso] || 0) + 1; }
      const res = await reconcileTags(uid, h, m, iso);
      if (res === 'written') { written++; if (!iso) removed++; }
      else if (res === 'failed') failed++;
    }
    const top = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(`nationTagsSweep: ${flagged}/${movies.length} flagged, ${written} written, ${removed} removed`
      + (overrides ? `, ${overrides} tmdb overrides` : '')
      + (failed ? `, ${failed} failed` : '') + (top ? ` — ${top}` : ''));
  } catch (e) { console.log(`nationTagsSweep: failed — ${e.message || e}`); }
  finally { nationTagsBusy = false; }
}

function startNationTagsTimer() {
  setInterval(nationTagsSweep, 24 * 3600000);   // country-of-origin never changes — daily re-check is plenty
}

module.exports = { nationTagsSweep, startNationTagsTimer, resolveNation };
