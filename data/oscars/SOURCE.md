# Oscar Winners Dataset

There are **three independent datasets** here, built by two scripts, feeding two features:

| Script | Output | Keyed by | Feeds |
|---|---|---|---|
| `build.sh` | `controller/oscar-winners.json` | TMDb id | `collectionsSweep()` — the award **collections** (Oscar Best Picture, etc., plus Cannes + Sundance winners) |
| `build-awards.sh` | `controller/film-awards.json` | IMDb id | `oscarTagsSweep()` — per-film win/nom **poster badges** (web + Fire Stick) |
| `build-awards.sh` | `controller/person-awards.json` | normalized name | per-person Oscar counts (person badges) |

`build.sh` additionally merges the curated Cannes/Sundance lists from `festivals.json`
(see below). The two scripts do not overlap and neither touches the other's output.

## Source

**Collections (`build.sh`)**: [`json-nominations`](https://github.com/delventhalz/json-nominations) (MIT)
— every Oscar nomination 1927/28–2023 as structured JSON with TMDb IDs + IMDb IDs.

Built by scraping the [Oscars Award Database](https://awardsdatabase.oscars.org/),
cross-referenced against TMDb for IDs.

**Badges (`build-awards.sh`)**: [`DLu/oscar_data`](https://github.com/DLu/oscar_data)
(`oscars.csv`) — every Academy Award nomination as a row, IMDb-keyed, annually updated
(DLu refreshes within days of each ceremony). We need this separate source for badges
because badge COUNTS require ALL categories (a film's *total* wins/noms), whereas
`json-nominations` above only tracks the handful of categories the collections use.

### `film-awards.json` (badge counts)

Flat lookup `{ "tt0111161": {"noms": 7, "wins": 0}, ... }`. `noms` = total nominations
*including* wins; badge display shows `wins` gold + `noms - wins` silver (never
double-counts). Non-competitive classes (`Special`, `SciTech`) are dropped — only
competitive feature categories count. A build fails loudly if the sanity anchors
(Titanic 14/11, Shawshank 7/0, Parasite 6/4, Oppenheimer 13/7) don't hold.

### `person-awards.json` (badge counts for people)

`build-awards.sh` also emits `controller/person-awards.json` — per-person Oscar counts for
directors/actors/etc., so badges show on person cards and person detail pages (e.g. Martin
Scorsese). Keyed by **normalized name** (`{ "martin scorsese": {"noms":16,"wins":1,"name":"Martin Scorsese"}, ... }`)
because Jellyfin person items almost never carry an IMDb id (10 of ~23k on this library), so the
controller matches people by name. The normalizer (lowercase, strip accents, non-alphanumerics →
space) is duplicated in `build-awards.sh` (`norm_name`) and `controller/lib/oscar-tags.js`
(`normName`) and **must stay identical**. Person anchors: Scorsese 16/1, Walt Disney 60/22.

To rebuild after a ceremony: `bash data/oscars/build-awards.sh`, commit
`controller/film-awards.json` + `controller/person-awards.json`, then rebuild + deploy the
controller image.

## Generated file

`controller/oscar-winners.json` is built by `data/oscars/build.sh`. It's a
lookup keyed by collection name → array of `{tmdb_id, title, year}`, sorted
newest-first. Merges split categories (e.g., B&W + Color Cinematography →
single "Oscar: Best Cinematography" collection). Cannes/Sundance categories
are appended as-is from `festivals.json`, suffixed `(Winners)`.

## Cannes & Sundance winner lists (`festivals.json`)

`data/oscars/festivals.json` holds curated winner lists for **Cannes** (big four:
Palme d'Or, Grand Prix, Jury Prize, Best Director — from 1946 onward) and
**Sundance** (all six competitive features: Grand Jury Prize + Audience Award +
Directing Award, each Dramatic + Documentary — from 1984/1988/1998 onward).
Every entry is `{year, title, tmdb_id}`.

**Sources** (English Wikipedia wikitext, parsed + hand-verified):
`Palme d'Or`, `Grand Prix (Cannes Film Festival)`, `Jury Prize (Cannes Film Festival)`,
`Cannes Film Festival Award for Best Director`, `List of Sundance Film Festival
award winners`. Includes 2025 + 2026 winners. The 2018 honorary "Special Palme
d'Or" (The Image Book) is deliberately **excluded** — it's not a regular win.

### Refreshing the lists: `fetch-festivals.sh` (added 2026-09-13)

`bash data/oscars/fetch-festivals.sh` re-reads the source Wikipedia tables and merges in any
winners `festivals.json` does not already have. **Additive only** — an entry matched on
(category, year, normalized title) is never modified or deleted, so resolved `tmdb_id`s and
hand-corrections survive every run. New rows land with `tmdb_id: null`.

It covers Venice ×3 and TIFF ×1 today; Cannes and Sundance are still the hand-curated lists and
their `SOURCES` entries have not been written yet (their parsers are unverified — adding one
without checking it against the existing 554 entries risks inventing winners). The `SOURCES` table
at the top of `fetch-festivals.py` is where a festival gets added.

Two things that cost time and are now guarded in code:

* **The section scan must be bounded at both ends.** `Silver Lion` holds four different awards
  under one title; a scan that ran past its section end silently pulled pre-1990 Silver Lions into
  "Venice: Best Director". The script now refuses to scan to EOF.
* **`[[File:…]]` captions are stripped first.** They sit between the heading and the table and are
  full of exactly what the parser looks for — `''[[Goodfellas]]'' (1990)`.

Each entry also records `wiki`, the wikilink TARGET of the winner ("Nomadland (film)"). That is
what makes the matching exact — see below.

### `resolve-festivals.sh` — Wikidata first, TMDb search second

**Strategy 0 (exact).** The `wiki` target maps to exactly one Wikidata item, and 281k film items
carry `P4947` (TMDb movie ID). So the join is *Wikipedia table cell → article → Wikidata item →
TMDb id*, with no string similarity in it at all. Batched 50 at a time; no API key needed. On the
2026-09-13 run this resolved **218 of 220** new entries.

**Strategy 1 (fuzzy).** The original TMDb search path, now only a fallback for entries with no
`wiki` field or whose Wikidata item carries no TMDb id. The ALIASES table below it patches titles
TMDb spells differently — it exists for that fallback and should not need to grow.

**Why strategy 0 exists:** title search silently picks the wrong film. Bergman's *The Magician*
(1958, Venice) resolved to an unrelated 2005 Australian film of the same name that happens to be in
this library — a badge on the wrong poster, forever, with nothing to notice. Via the wikilink
target it now resolves to TMDb 29453, correctly. Anything where the source title and the resolved
record disagree is printed under "REVIEW" at the end of a run; read it.

`TMDB_API_KEY` is read from the repo `.env`. Idempotent — already-resolved entries are skipped.
After fixing titles (add an alias or edit the JSON directly and re-run), rebuild with:

```bash
bash data/oscars/build.sh
```

Note the build's category names in `collections.js` `OSCAR_DESC` and the
`hss-shelf.js` award regexes (`/^(Oscar|Cannes|Sundance):/i`) must stay in sync
with these collection names.

## Updating after an Oscars ceremony

The upstream `json-nominations` repo is usually updated within a few weeks of
each ceremony. If it's been updated:

```bash
bash data/oscars/build.sh
```

If it hasn't been updated yet, add the new winners to
`data/oscars/latest-winners.json` in the same format:

```json
{
  "Oscar: Best Picture": [
    {"tmdb_id": 123, "title": "Winner Title", "year": 2027}
  ],
  "Oscar: Best Director": [
    {"tmdb_id": 123, "title": "Winner Title", "year": 2027}
  ]
}
```

Then run `bash data/oscars/build.sh` — it will merge `latest-winners.json` on
top of the canonical dataset. After the upstream repo catches up, delete
`latest-winners.json` so future builds come clean from source.

## Categories tracked

| Collection | Dataset categories merged |
|---|---|
| Oscar: Best Picture | Best Picture |
| Oscar: Best Director | Best Director |
| Oscar: Best Actor | Best Actor |
| Oscar: Best Actress | Best Actress |
| Oscar: Best Supporting Actor | Best Supporting Actor |
| Oscar: Best Supporting Actress | Best Supporting Actress |
| Oscar: Best Film Editing | Best Film Editing |
| Oscar: Best Cinematography | Best Cinematography (Black and White) + Best Cinematography (Color) |

Both split cinematography categories are merged because `collectionsSweep` only
needs to know "did the movie win *any* cinematography Oscar" (it's a single
collection). The `count` field is not stored in the output — duplicates are
collapsed at build time.

### Festival categories (from `festivals.json`)

| Collection | Source list |
|---|---|
| Cannes: Palme d'Or (Winners) | Palme d'Or |
| Cannes: Grand Prix (Winners) | Grand Prix |
| Cannes: Jury Prize (Winners) | Jury Prize |
| Cannes: Best Director (Winners) | Best Director |
| Sundance: Grand Jury Prize (Dramatic/Documentary) (Winners) | Sundance Grand Jury Prize |
| Sundance: Audience Award (Dramatic/Documentary) (Winners) | Sundance Audience Award |
| Sundance: Directing Award (Dramatic/Documentary) (Winners) | Sundance Directing Award |
| Venice: Golden Lion (Winners) | Golden Lion |
| Venice: Grand Jury Prize (Winners) | Grand Jury Prize (Venice Film Festival) |
| Venice: Best Director (Winners) | Silver Lion § Best Direction (1990–present) |
| TIFF: People's Choice (Winners) | TIFF People's Choice Award |

Winners-only (no nominee lists) — these are competitive winner awards, and unlike
the Academy there's no published all-nominee dataset to merge anyway.
