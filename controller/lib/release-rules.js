'use strict';
// Release-title heuristics shared by the Audit tab's candidate filter and the Downloads tab's
// manual-grab picker. Everything here works from the release TITLE alone (plus, where noted, an
// item's original language) — no *arr metadata required — which is why the picker can use it: the
// picker's results come from a raw Prowlarr text search, so title text is all it has.
//
// These rules were written, tuned and paid for by the Audit tab (a camrip offered for Mission:
// Impossible, an extras disc that overwrote Shrek Forever After, an Italian-only pack that looked
// safe). They live here so there is exactly ONE gate: a rule tightened for one surface can never
// silently fail to apply to the other. audit.js imports them rather than defining its own.
//
// PRINCIPLE: refusing too much costs a candidate; refusing too little costs a film. Where a signal
// is ambiguous these functions say so (langWarn / null) instead of guessing.

// ---- SOURCE TIER ────────────────────────────────────────────────────────────────────────────
// What a release was made FROM, which caps how good it can look at any bitrate.
// Remux 5 = untouched disc stream. Bluray 4 = re-encoded from the disc. WEBDL 4 = bit-for-bit
// from a streaming service (compressed by them, but not re-encoded again). WEBRip 3 = a stream
// re-encoded by the group, one extra generation of loss. HDTV 2 = off-air. DVD 1 = upscaled.
const SRC_RANK = [[/remux/i, 5], [/bluray|blu-?ray|brrip|bdrip/i, 4], [/web-?dl/i, 4],
  [/webrip/i, 3], [/hdtv/i, 2], [/dvd/i, 1], [/sdtv|\bcam\b|telesync/i, 0]];
const srcRank = (s) => { for (const [re, n] of SRC_RANK) if (re.test(s || '')) return n; return null; };
// *arr reports BRRip/BDRip as plain "Bluray" and WEBRip sometimes as "WEBDL", but both are
// re-encodes of an existing rip rather than of the source. The release TITLE still says so, so
// flag it separately instead of trusting the quality name alone.
const REENC_RE = /brrip|bdrip|web-?rip|hdrip/i;

// ---- AUDIO ──────────────────────────────────────────────────────────────────────────────────
// Audio is part of "is this actually better" — a 1.5 GB encode that dropped a 5.1 Atmos track
// for stereo AAC is a downgrade the bitrate ratio cannot see.
const AUDIO_RE = [[/atmos/i, 'Atmos'], [/truehd/i, 'TrueHD'], [/dts-?hd|dtshd/i, 'DTS-HD'],
  [/\bdts\b/i, 'DTS'], [/ddp\s?5[.\s]?1|eac3.*5[.\s]?1|ddp5\.1/i, 'DDP 5.1'],
  [/\bdd\+|eac3/i, 'DD+'], [/dd\s?5[.\s]?1|ac3.*5[.\s]?1/i, 'DD 5.1'],
  [/\baac\s?2[.\s]?0|\baac\b/i, 'AAC'], [/\bmp3\b/i, 'MP3']];
const audioOf = (t) => { for (const [re, n] of AUDIO_RE) if (re.test(t || '')) return n; return null; };
const AUDIO_RANK = { Atmos: 5, TrueHD: 5, 'DTS-HD': 4, DTS: 4, 'DDP 5.1': 3, 'DD+': 3, 'DD 5.1': 3, AAC: 1, MP3: 0 };

// ---- HARD REFUSALS ──────────────────────────────────────────────────────────────────────────
// Not rankings. These are "never show me this", so they filter rather than sort.
//
// CAM/TS: a camcorder recording of a cinema screen, or its audio-synced cousin. SRC_RANK scored
// telesync 0, which only pushed it DOWN the list — Mission: Impossible was still being offered a
// 1080p HDTS. There is no size saving that makes a camrip acceptable, so it is refused outright.
// Matched on the release title, not *arr's quality name, because *arr frequently parses these as
// plain "1080p".
const CAM_RE = /\bcam(?:rip)?\b|\bhd-?cam\b|\bhd-?ts\b|\btele-?sync\b|\btele-?cine\b|\bworkprint\b|\bscr(?:eener)?\b|\bdvdscr\b|\bts-?rip\b/i;
// EXTRAS / BONUS DISCS. Not the film — a folder of featurettes that imports over the real movie.
// This is exactly how Shrek Forever After became an extras disc in the library.
//
// EXTRAS/BONUS are position-guarded — they only count AFTER a year or a season marker — so the
// Ricky Gervais series "Extras", whose releases begin "Extras.S01.1080p...", is not refused
// wholesale. RMXTRAS is a release-group name and needs no guard; featurettes / deleted scenes /
// special features are never a feature film's own title.
const EXTRAS_RE = new RegExp([
  String.raw`(?:\b(?:19|20)\d{2}\b|\bs\d{1,2}(?:e\d{1,3})?\b)[\s._-].*\b(?:extras?|bonus)\b`,
  String.raw`\brmxtras\b`,
  String.raw`\bbonus[\s._-]?(?:disc|features?)\b`,
  String.raw`\bfeaturettes?\b`,
  String.raw`\bdeleted[\s._-]?scenes\b`,
  String.raw`\bspecial[\s._-]?features\b`,
].join('|'), 'i');
// DUBBED / multi-audio. A dub is not a quality trade-off, it is the wrong film. Matched on
// EXPLICIT dub and multi-audio markers only — a single foreign-language tag is deliberately NOT
// refused, because for a foreign film that is the ORIGINAL audio (the Das Boot replacement is a
// lone German track, which is correct). So "ENG-GER" passes and "MULTi.FRENCH.VF2" does not.
// Known and accepted over-reach: an original-language Hindi or Latin-American film may lose a few
// legitimate releases. Refusing too much here costs a candidate; refusing too little costs a film.
const DUB_RE = new RegExp([
  String.raw`\bdub(?:bed|s|lado|lat)?\b`,
  String.raw`dual[\s._-]?audio`,
  String.raw`\bmulti(?:ple)?\b`,                    // MULTi, "Multi language", MultiSUB
  String.raw`\btrue-?french\b|\bvf[fqi2]?\b|\bvostfr\b`,
  String.raw`\b(?:hindi|tamil|telugu|latino|castellano)\b`,
].join('|'), 'i');
// BARE language tags, e.g. "Silicon.Valley.S02.ITA.1080p.x264". DUB_RE deliberately ignores these
// because for a foreign film the tag IS the original audio — so judging them needs the title's
// original language, which DUB_RE does not have.
const LANG_TAG = [[/\bita\b/i, 'Italian'], [/\b(?:ger|deu)\b/i, 'German'], [/\b(?:fre|fra|french)\b/i, 'French'],
  [/\b(?:spa|esp|spanish)\b/i, 'Spanish'], [/\b(?:rus|russian)\b/i, 'Russian'], [/\b(?:jpn|jap)\b/i, 'Japanese'],
  [/\b(?:kor)\b/i, 'Korean'], [/\b(?:pol)\b/i, 'Polish'], [/\b(?:cze|ces)\b/i, 'Czech'], [/\b(?:hun)\b/i, 'Hungarian'],
  [/\b(?:tur)\b/i, 'Turkish'], [/\b(?:por|bra)\b/i, 'Portuguese'], [/\b(?:swe)\b/i, 'Swedish'],
  [/\b(?:dan)\b/i, 'Danish'], [/\b(?:nor)\b/i, 'Norwegian'], [/\b(?:fin)\b/i, 'Finnish'],
  [/\b(?:nld|dut)\b/i, 'Dutch'], [/\b(?:gre|ell)\b/i, 'Greek'], [/\b(?:heb)\b/i, 'Hebrew'],
  [/\b(?:ara)\b/i, 'Arabic'], [/\b(?:tha)\b/i, 'Thai'], [/\b(?:vie)\b/i, 'Vietnamese']];
const HAS_ENG = /\b(?:eng|english)\b/i;
// NON-LATIN SCRIPT. LANG_TAG only catches Latin abbreviations ("RUS", "ITA"), so a release named in
// its own alphabet sailed straight through: "Американские боги / American Gods / S1E1-8" ranked
// third in the picker, and "Прослушка / The Wire / S1E1-60" was offered too. A title written for a
// Russian-speaking audience is a Russian-audio release.
//
// Cyrillic ONLY, deliberately. CJK would refuse legitimately Japanese-original anime, and the same
// origLang escape hatch below is not enough protection when the script is that common in correct
// releases. Refusing too much costs a candidate; this is the narrowest rule that fixes the observed
// case. Paired with the origLang check, so a Russian-original title keeps its own releases.
const CYRILLIC_RE = /[Ѐ-ӿ]/;
// True when the title advertises a foreign audio language that is NOT this title's original
// language and carries no English tag alongside it — i.e. a dub. "ITA ENG" passes (dual audio),
// "S02.ITA" for an English show does not, and a German tag on a German film does not match.
function isForeignOnly(title, origLang) {
  const t = String(title || '');
  if (HAS_ENG.test(t)) return false;
  if (CYRILLIC_RE.test(t) && origLang !== 'Russian') return true;
  for (const [re, name] of LANG_TAG) {
    if (!re.test(t)) continue;
    if (origLang && name === origLang) continue;   // that IS the original audio
    if (name === 'English') continue;
    return true;
  }
  return false;
}
// Which foreign language a title advertises, for display ("Russian only"). Null when none or when
// an English tag is present alongside. Presentation only — isRefused makes the decision.
function foreignLangOf(title, origLang) {
  const t = String(title || '');
  if (HAS_ENG.test(t)) return null;
  if (CYRILLIC_RE.test(t) && origLang !== 'Russian') return 'Russian';
  for (const [re, name] of LANG_TAG) {
    if (re.test(t) && !(origLang && name === origLang)) return name;
  }
  return null;
}
// ONE gate so every call site can never drift apart.
const isRefused = (t, origLang) => CAM_RE.test(String(t || '')) || DUB_RE.test(String(t || ''))
  || EXTRAS_RE.test(String(t || '')) || isForeignOnly(t, origLang);
// Which rule refused it — for logging and for telling a human why a list is short.
function refusedReason(t, origLang) {
  const s = String(t || '');
  if (CAM_RE.test(s)) return 'camrip/screener';
  if (EXTRAS_RE.test(s)) return 'extras/bonus disc';
  if (DUB_RE.test(s)) return 'dubbed/multi-audio';
  const fl = isForeignOnly(s, origLang) ? foreignLangOf(s, origLang) : null;
  if (fl) return `${fl}-only audio`;
  return null;
}

// ---- SCOPE ──────────────────────────────────────────────────────────────────────────────────
// Episode ranges ("S01E01-E10") deliberately do NOT match: the dash must follow the season
// number directly, not an episode marker.
// Separators are [\s._-]+ throughout, not \s+: scene names are dot-delimited, so
// "Some.Show.Complete.Series.1080p" would slip past a whitespace-only pattern.
const MULTI_SEASON_RE = new RegExp([
  String.raw`\bs\d{1,2}\s*[-–—]\s*s?\d{1,2}\b`,          // S01-S06, S01 - 6
  String.raw`\bseasons?[\s._-]*\d{1,2}[\s._-]*[-–—][\s._-]*\d{1,2}\b`, // Seasons 1-4
  String.raw`\bcomplete[\s._-]+series\b`,
  String.raw`\ball[\s._-]+seasons\b`,
].join('|'), 'i');
const isMultiSeason = (t) => MULTI_SEASON_RE.test(String(t || ''));

// What a TV release covers, from its title alone: a single episode, one season, several seasons, or
// unknown. Returns { kind, seasons: [n], episode: n|null }.
//
// `seasons` is what makes gap-aware ranking possible: a picker can ask "does this release cover a
// season I am actually missing episodes from", which is the difference between offering The Wire's
// complete S05 and offering four packs of seasons that are already finished.
function scopeOf(title) {
  const t = String(title || '');
  // Single episode: S05E08, 5x08. Checked first — "S05E08" also contains an "S05" season marker.
  const ep = t.match(/\bs(\d{1,2})[\s._-]?e(\d{1,3})\b/i) || t.match(/\b(\d{1,2})x(\d{1,3})\b/);
  if (ep) return { kind: 'episode', seasons: [Number(ep[1])], episode: Number(ep[2]) };
  if (isMultiSeason(t)) {
    // Enumerate the span so a gap test can ask whether a needed season falls inside it.
    const span = t.match(/\bs?(\d{1,2})[\s._-]*[-–—][\s._-]*s?(\d{1,2})\b/i);
    if (span) {
      const a = Number(span[1]), b = Number(span[2]);
      if (b > a && b - a < 40) {
        const out = [];
        for (let n = a; n <= b; n++) out.push(n);
        return { kind: 'multi', seasons: out, episode: null };
      }
    }
    // "Complete Series" / "All Seasons" — covers everything, so no season list to enumerate.
    return { kind: 'multi', seasons: null, episode: null };
  }
  const sn = t.match(/\bs(\d{1,2})\b/i) || t.match(/\bseason[\s._-]*(\d{1,2})\b/i);
  if (sn) return { kind: 'season', seasons: [Number(sn[1])], episode: null };
  return { kind: 'unknown', seasons: null, episode: null };
}
const SCOPE_LABEL = { episode: 'Single episode', season: 'Season pack', multi: 'Multi-season', unknown: 'Scope unclear' };

// Does release `neu` fully cover everything release `old` would have delivered? Used to cancel the
// dead download a manual pick was chosen to replace (see cancelSuperseded in routes-actions.js), so
// it must only ever answer true when the coverage is CERTAIN — an 'unknown' scope on either side is
// a no, never an assumption, because the cost of a false yes is a discarded download.
function supersedes(neu, old) {
  if (!neu || !old) return false;
  if (neu.kind === 'unknown' || old.kind === 'unknown') return false;
  if (old.kind === 'multi' && old.seasons == null) return neu.kind === 'multi' && neu.seasons == null;
  if (neu.kind === 'multi' && neu.seasons == null) return true;         // "Complete Series" covers all
  if (!neu.seasons || !neu.seasons.length || !old.seasons || !old.seasons.length) return false;
  const span = new Set(neu.seasons);
  if (!old.seasons.every((n) => span.has(n))) return false;
  // A single-episode pick replaces only that same episode; a pack replaces any episode inside it.
  if (neu.kind === 'episode') return old.kind === 'episode' && neu.episode === old.episode;
  return true;
}

// ---- EDITION / CUT ──────────────────────────────────────────────────────────────────────────
// A cut is not a quality tier, it is WHICH FILM YOU GET. Brennan, 2026-07-30: "A theatrical cut of
// apocalypse, LOTR, or blade runner is garbage and should never be on disk, ever, for any reason.
// Same as dubs or screenrips." So an edition downgrade is a HARD REFUSAL, not a labelled tradeoff —
// it sits with CAM_RE and DUB_RE, not with the ranking helpers.
//
// RUNTIME IS NOT THE SIGNAL, and this is the trap worth naming: Apocalypse Now Final Cut (183 min) is
// SHORTER than Redux (202 min) and is nonetheless the definitive version. Anything that preferred the
// longer file would get that backwards, and audit.js already has RUNTIME_MIN_RATIO for a different
// job (proving a replacement is the same CONTENT). Editions are ranked by editorial authority.
//
// RESTORATION IS A SEPARATE AXIS. The live library holds "EXTENDED REMASTERED", "Directors Cut
// Remastered" and "THEATRICAL REMASTERED" — remaster/restored describes the transfer, never the cut,
// so it must not enter the ladder or a remastered theatrical would outrank a plain extended.
const RESTORED_RE = /\bremaster(?:ed)?\b|\brestored\b|\brestoration\b|\b4k\.?restoration\b/i;
// Higher wins. The gaps between named tiers are deliberate: Brennan relaxed the Final-vs-Redux
// requirement ("if we end up doing a longer redux cut of apocolypse over the more desirable but
// shorter final cut, its not the end of the world"), so tiers 3 and 4 are a PREFERENCE, while the
// 0-vs-anything gap is the hard rule that actually matters.
const EDITION_TIER = [
  [/\bfinal[\s._-]?cut\b|\bultimate[\s._-]?(?:cut|edition)\b/i, 4, 'Final Cut'],
  [/\bdirector.?s?[\s._-]?cut\b|\bdirectors[\s._-]?cut\b|\bdc\b/i, 3, "Director's Cut"],
  [/\bextended\b|\bredux\b|\broadshow\b|\bintegral\b|\bthe[\s._-]?complete\b|\bimax[\s._-]?edition\b|\bspecial[\s._-]?edition\b|\buncut\b|\bunrated\b/i, 2, 'Extended'],
  [/\btheatrical\b/i, 0, 'Theatrical'],
];
const EDITION_UNSTATED = 1;   // between Theatrical(0) and Extended(2): worse than a known long cut, better than an explicit theatrical
// Returns { tier, label, restored }. label is null when unstated, so callers can tell "no edition
// mentioned" from "explicitly theatrical" — the difference decides whether a refusal is certain.
function editionOf(text) {
  const t = String(text || '');
  for (const [re, tier, label] of EDITION_TIER) {
    if (re.test(t)) return { tier, label, restored: RESTORED_RE.test(t) };
  }
  return { tier: EDITION_UNSTATED, label: null, restored: RESTORED_RE.test(t) };
}
// Films whose theatrical cut must never be on disk, keyed by normalised title. The general rule
// ("never go below the edition you already own") cannot help when the copy you own is ALREADY the
// wrong one — Radarr says this library's Blade Runner is the `Theatrical Cut`, so without a floor
// every theatrical candidate would look like a lateral move rather than a refusal.
// Values are the MINIMUM acceptable tier for a candidate.
const EDITION_FLOOR = new Map([
  ['the lord of the rings the fellowship of the ring', 2],
  ['the lord of the rings the two towers', 2],
  ['the lord of the rings the return of the king', 2],
  ['blade runner', 3],                    // Final Cut (2007) or the 1992 Director's Cut; never the 1982 theatrical
  ['apocalypse now', 2],                  // Final Cut or Redux
  ['aliens', 2],                          // Special Edition
  ['watchmen', 3],                        // Ultimate/Director's
  ['kingdom of heaven', 3],
  ['once upon a time in america', 2],
  ['das boot', 2],
  ['cinema paradiso', 3],
  ['amadeus', 3],
  ['the abyss', 2],
  ['dances with wolves', 2],
]);
// A SECOND, SOFTER axis: the edition this film is genuinely BEST in, where that outranks the floor.
// The floor answers "what must never be on disk"; this answers "what would you rather have".
//
// Brennan asked why Apocalypse Now was not offered Redux → Final Cut. It was not a bug but a scope
// limit: he owns Redux (tier 2), the floor for that film is 2, so the edition section considered it
// satisfied and said nothing — even though Final Cut (tier 4) is the definitive version. Keeping the
// two numbers separate is what lets the same table encode both of his rules at once:
//   floor 2, best 4  → a theatrical Apocalypse Now is REFUSED, a Redux copy is merely IMPROVABLE.
// That matches the relaxation exactly ("if we end up doing a longer redux cut over the more
// desirable but shorter final cut, its not the end of the world") — below best is a suggestion a
// human may ignore, below floor is a refusal that nothing can override.
//
// Only listed where a higher cut genuinely exists and is the one to own. A film absent from here has
// no known better edition, which is the honest default for the ~790 titles with no cut distinction.
const EDITION_BEST = new Map([
  ['apocalypse now', 4],                 // Final Cut (2019) — shorter than Redux and still definitive
  ['blade runner', 4],                   // The Final Cut (2007), Scott's only unrestricted version
  ['the lord of the rings the fellowship of the ring', 2],   // Extended IS the best; no higher cut exists
  ['the lord of the rings the two towers', 2],
  ['the lord of the rings the return of the king', 2],
  ['watchmen', 4],                       // Ultimate Cut folds in Black Freighter
  ['kingdom of heaven', 3],              // the Director's Cut is famously a different film
  ['aliens', 2],
  ['the abyss', 3],
  ['amadeus', 3],
  ['cinema paradiso', 3],
  ['once upon a time in america', 2],
  ['das boot', 2],
  ['dances with wolves', 2],
]);
const normEdTitle = (s) => String(s || '').toLowerCase()
  .replace(/\((?:19|20)\d{2}\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const editionFloorFor = (title) => EDITION_FLOOR.get(normEdTitle(title)) ?? null;
const editionBestFor = (title) => EDITION_BEST.get(normEdTitle(title)) ?? null;
// Is a copy we already own merely IMPROVABLE (a better cut exists) rather than unacceptable?
// Returns the target tier, or null. Never fires below the floor — that case is already a refusal
// and reporting it twice would put the same film in two states at once.
function editionUpgradeFor(title, mine) {
  const best = editionBestFor(title);
  if (best == null) return null;
  const floor = editionFloorFor(title);
  const tier = typeof mine === 'number' ? mine : (mine && typeof mine.tier === 'number' ? mine.tier : null);
  if (tier == null) return null;
  if (floor != null && tier < floor) return null;    // below floor: a refusal, not a preference
  return tier < best ? best : null;
}
// WHAT DO WE ALREADY OWN? Take the BEST of *arr's edition field and our own filename, because
// measured against the live library (2026-07-30, 806 files) each one knows things the other does not:
//   - the field usually wins, since renaming strips the edition from the name — The Exorcist,
//     Cinema Paradiso, The Warriors, Salt and Blue Velvet are all plain "(year) Bluray-1080p" on disk
//     with "Directors Cut"/"Extended" only in the field.
//   - but the FILENAME sometimes knows more, and it matters: Apocalypse Now's field reads only
//     "REMASTERED" while the file is "Apocalypse.Now.1979.Redux.Explicit.REMASTERED..." — we DO own
//     Redux. Same for Independence Day ("REMASTERED EXTENDED") and The Iron Giant ("DIRECTOR CUT").
// Trusting the field alone would have reported Apocalypse Now as below its floor and offered to
// "upgrade" a Redux copy we already have. Taking the max can only ever UNDER-refuse, never over-.
// An EXPLICIT label always beats silence, even when silence scores higher. Plain max() was wrong
// here and the tests caught it: Blade Runner's field says "Theatrical Cut" (tier 0) while its renamed
// file says nothing (unstated, tier 1), so max() laundered a known-bad edition into "unknown" and
// lost the very fact the floor check needs. Among explicit labels, the higher tier wins.
function ownEditionOf(edition, relativePath) {
  const a = editionOf(edition), b = editionOf(relativePath);
  const restored = a.restored || b.restored;
  const stated = [a, b].filter((e) => e.label !== null);
  if (!stated.length) return { ...a, restored };
  const best = stated.reduce((x, y) => (y.tier > x.tier ? y : x));
  return { ...best, restored };
}
// The whole rule in one place. `mine` is what we already hold: pass ownEditionOf(...) — or a bare
// string, which is treated as an edition label. `title` is the MOVIE title, for the floor table.
// Returns null to allow, or a human-readable reason to refuse.
function editionRefusal(candidateTitle, mine, title) {
  const cand = editionOf(candidateTitle);
  const floor = editionFloorFor(title);
  if (floor != null && cand.tier < floor) {
    return `${cand.label || 'no edition stated'} — this film must be the ${floor >= 3 ? "Director's/Final Cut" : 'extended/long cut'}`;
  }
  // Accept either a pre-computed {tier,label} (from ownEditionOf) or a bare label string.
  const own = (mine && typeof mine === 'object' && 'tier' in mine) ? mine : editionOf(mine);
  // Only refuse a DOWNGRADE. Equal tiers are fine (a better encode of the same cut is the normal
  // upgrade path), and a higher tier is exactly what we want to encourage.
  if (cand.tier < own.tier) {
    return `${cand.label || 'no edition stated'} is a downgrade from your ${own.label} copy`;
  }
  return null;
}

// ---- RESOLUTION CEILING ─────────────────────────────────────────────────────────────────────
// Brennan, 2026-07-30: "we have no tech that can play anything above 1080p, so theres never any
// reason to grab something that isnt 720 or 1080." So 2160p is not a better copy — it is a file
// nothing here can play, at several times the disk, forcing a CPU transcode on a 2c/4t Skylake NUC
// (hardware transcode is still deferred). Above the ceiling is a DOWNGRADE in practice, not an
// upgrade, and it belongs with the hard refusals rather than the rankings.
//
// The *arr quality profiles already stop at 1080p, but two surfaces never see those profiles:
// /api/force-grab/search reads RAW Prowlarr text search, and the Audit Upgrade section scores
// resolution as a gain. Both consult this instead of re-deciding.
const MAX_USABLE_RES = 1080;
// True only when the title STATES a resolution above the ceiling. An unstated resolution is not
// assumed to be 4K — same rule as everywhere else in this file: an unknown is never a refusal.
const overResCeiling = (title) => { const r = resOf(title); return r != null && r > MAX_USABLE_RES; };

// ---- PICTURE ────────────────────────────────────────────────────────────────────────────────
// Vertical resolution from the title. Null when unstated — common for older DVD-era releases, and
// deliberately NOT treated as SD, because guessing low would hide legitimate releases.
function resOf(title) {
  const m = String(title || '').match(/\b(\d{3,4})[pi]\b/i);
  if (m) return Number(m[1]);
  if (/\b(?:2160|4k|uhd)\b/i.test(String(title || ''))) return 2160;
  return null;
}
// Codec from the title. Null when unstated.
function codecOf(title) {
  const t = String(title || '');
  if (/x265|h\.?265|hevc/i.test(t)) return 'HEVC';
  if (/x264|h\.?264|\bavc\b/i.test(t)) return 'H.264';
  if (/xvid|divx/i.test(t)) return 'XviD';
  return null;
}
// 10-bit is not a refusal here (it is on the Audit tab, which is draining a CPU-decode backlog) but
// it IS worth flagging: on this NUC a 10-bit HEVC software-decodes. See jellyfin.sh / DESIGN-THERMAL.
const TENBIT_RE = /\b10-?bit\b|\bmain\s?10\b|\bhi10p?\b/i;

// ---- CUSTOM FORMATS: is *arr's refusal about SIZE, or about the content? ────────────────────
// Brennan, 2026-07-30: "I'm fine with midrange files being the default for automatic/initial
// downloads, in fact that's what I want, but for upgrades and replacements I've chosen a source, I
// don't want it rejected for file size (something like dub and language that it has better info
// for, sure)."
//
// The two halves of that sentence are in tension inside *arr, which has ONE number. The size-band
// custom formats provisioned in scripts/provision/_arr_common.sh (§8) are what steer automatic
// grabs toward midrange files, and they are strongly negative at the top end — measured on the
// Normal profile: Size 1.5-3 GB +80, Size 3-6 GB +40, Size 6-10 GB -150, Size 10-15 GB -500,
// Size >15 GB -1500. So a deliberately-chosen bigger replacement arrives carrying a 200-1500 point
// deficit before anything about its actual content is considered, and *arr refuses the import with
// "Not a Custom Format upgrade for existing movie file(s)".
//
// Lowering those scores is the wrong fix: it would also change what the nightly automatic grabs
// pick, which is the behaviour Brennan explicitly wants to keep.
//
// So: discriminate on WHY the score is lower. Recompute both sides with the size bands removed. If
// the new file is no worse on everything else, the refusal was purely about bytes and a human has
// already decided the bytes are acceptable. If anything else is worse, the refusal stands — and
// "everything else" is exactly the list he said should still refuse: Dubbed (-100000),
// Non-original language (-100000), AV1/VP9 (-1000), Theatrical Cut (-3000), HDR (-200),
// 10-bit (-150). Rings of Power S01, abandoned 2026-07-30 for a -99800 foreign-audio rescore, still
// gets refused by this, which is the point.
//
// Names, not ids: format ids are per-instance and differ between Radarr and Sonarr, whereas the
// provisioner writes the same names into both.
const SIZE_CF_RE = /^\s*size\s/i;
const isSizeCf = (name) => SIZE_CF_RE.test(String(name || ''));
// SIZE IS NOT THE ONLY EXCUSABLE DEFICIT. Measured on Pulp Fiction, 2026-07-31: a 1.5-3 GB copy was
// refused an upgrade to a 10-15 GB Bluray x264 with the SAME codec and the SAME language, and the
// entire blocking deficit was 15 points of "PS4-native audio (AC3)" — the old file has an AC3 track
// the PS4 direct-plays and the new one does not.
//
// That is not a quality regression, it is the PS4 picking up a cheap audio transcode, and it is the
// exact tradeoff Brennan authorised in the same breath as the NUC rule (2026-07-30): "Slight device
// compatibility downgrade (ps4 green to orange, web green to orange for example is OK) but nuc green
// to red is not." A 15-point audio preference must not veto a four-times-larger Bluray.
//
// So these join the size bands as excusable. They are named EXPLICITLY rather than excused by a
// magnitude threshold: a threshold would silently start forgiving any new small-negative format the
// provisioner adds, whereas this list can only ever grow on purpose. Both entries affect nothing but
// whether a client transcodes AUDIO — never picture, never language, never the cut.
const AUDIO_TRANSCODE_CF = new Set([
  'PS4-native audio (AC3)',        // +15  the PS4 direct-plays AC3; losing it costs a QSV audio pass
  'HD/lossless audio (transcode)', // -20  TrueHD/DTS-HD, which the server downmixes anyway
]);
const isExcusableCf = (name) => isSizeCf(name) || AUDIO_TRANSCODE_CF.has(String(name || '').trim());
// Sum a format list's score, counting only the formats that are allowed to DECIDE this. `scoreByName`
// is the profile's own formatItems, so this is *arr's arithmetic rather than a re-implementation of
// it. A format the profile does not score contributes 0, which is also how *arr treats it.
function nonSizeCfScore(formats, scoreByName) {
  let n = 0;
  for (const f of (formats || [])) {
    const name = typeof f === 'string' ? f : (f && f.name);
    if (!name || isExcusableCf(name)) continue;
    n += Number((scoreByName instanceof Map ? scoreByName.get(name) : (scoreByName || {})[name]) || 0);
  }
  return n;
}
// True when nothing that MATTERS is worse — i.e. the refusal is about bytes, or about an audio track
// a client will transcode, and not about picture, language or the cut.
// Ties count as excusable: equal on everything that matters means nothing real is in dispute.
function cfRefusalIsExcusable(oldFormats, newFormats, scoreByName) {
  return nonSizeCfScore(newFormats, scoreByName) >= nonSizeCfScore(oldFormats, scoreByName);
}
// *arr's own phrasing for the Custom Format arm of the upgrade check. Radarr says "movie file(s)",
// Sonarr "episode file(s)". Kept separate from importer.js's UPGRADE_REJECT_RE (the plain-quality
// arm) because the two are treated differently: quality is always tolerated at preflight, CF only
// when cfRefusalIsExcusable agrees.
const CF_UPGRADE_REJECT_RE = /not a custom format upgrade/i;

module.exports = {
  SIZE_CF_RE, isSizeCf, AUDIO_TRANSCODE_CF, isExcusableCf,
  nonSizeCfScore, cfRefusalIsExcusable, CF_UPGRADE_REJECT_RE,
  SRC_RANK, srcRank, REENC_RE,
  AUDIO_RE, audioOf, AUDIO_RANK,
  CAM_RE, EXTRAS_RE, DUB_RE, LANG_TAG, HAS_ENG, CYRILLIC_RE,
  isForeignOnly, foreignLangOf, isRefused, refusedReason,
  MULTI_SEASON_RE, isMultiSeason, scopeOf, SCOPE_LABEL, supersedes,
  RESTORED_RE, EDITION_TIER, EDITION_UNSTATED, EDITION_FLOOR, EDITION_BEST, MAX_USABLE_RES, overResCeiling,
  editionOf, ownEditionOf, editionFloorFor, editionBestFor, editionUpgradeFor, editionRefusal, normEdTitle,
  resOf, codecOf, TENBIT_RE,
};
