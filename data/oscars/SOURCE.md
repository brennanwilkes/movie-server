# Oscar Winners Dataset

## Source

**Primary**: [`json-nominations`](https://github.com/delventhalz/json-nominations) (MIT)
— every Oscar nomination 1927/28–2023 as structured JSON with TMDb IDs + IMDb IDs.

Built by scraping the [Oscars Award Database](https://awardsdatabase.oscars.org/),
cross-referenced against TMDb for IDs.

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
