# Oscar Winners Dataset

There are **two independent datasets** here, built by two scripts, feeding two features:

| Script | Output | Keyed by | Feeds |
|---|---|---|---|
| `build.sh` | `controller/oscar-winners.json` | TMDb id | `collectionsSweep()` — the Oscar category **collections** (Best Picture, etc.) |
| `build-awards.sh` | `controller/film-awards.json` | IMDb id | `oscarTagsSweep()` — per-film win/nom **poster badges** (web + Fire Stick) |

They do not overlap and neither script touches the other's output.

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
single "Oscar: Best Cinematography" collection).

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
