# R&D: "what was this shot on?" on the film detail page

**2026-09-07.** Feasibility study, not an implementation. The ask: show whether a film was shot
on 8/16/35/65-70mm, IMAX, VistaVision, anamorphic, Panavision — or digitally.

**Verdict: feasible and worth building, with one honest caveat — ~55% of this library can be
answered, and the gap is almost entirely films from 2024 onward.**

## Sources evaluated

| Source | Has the data? | Usable? |
|---|---|---|
| **Jellyfin / the media files** | No | The file describes the *encode*, not the shoot. A 1080p H.264 rip says nothing about the negative. Dead end. |
| **TMDB** | No | `/movie/{id}` and `/credits` have no technical specs at all. |
| **OMDb** | No | Same. |
| **IMDb `/technical`** | Yes — the canonical source (Camera, Negative Format, Cinematographic Process, Printed Film Format) | **Blocked.** Returns HTTP 202 with a zero-byte body to non-browser clients. No public API exposes these fields. |
| **Wikidata `P3803`** ("original film format") | Partly | Only ~5.7k films carry it at all, and coverage of the films that matter is poor — see below. |
| **shotonwhat.com** | Yes, and richly | **Best option.** Camera, lens, negative width, aspect ratio, and an explicit film-vs-digital field. |

### Wikidata is not enough on its own

Queried `P3803` for six named films:

```
2001: A Space Odyssey     Super Panavision 70   ✓
Lawrence of Arabia        — missing
Raiders of the Lost Ark   — missing
Ghostbusters              — missing
Empire Strikes Back       — missing
Sinners                   — missing
```

1 of 6. Global counts are similarly thin: 4,072 films tagged 35mm, 1,448 16mm, **7 IMAX, 2
70mm** — and essentially nothing marked digital, which is precisely the distinction Brennan
cares about most.

### shotonwhat.com

Each page embeds a clean, parseable `var dataLayer_content = {...}` blob. For Lawrence of Arabia:

```json
"acquisition":            ["Celluloid"],
"cameras":                ["Super Panavision-70 Camera"],
"lenses":                 ["Panavision Super Panavision 70 Series Lenses"],
"film-negative-width":    ["65mm Film Negative Width"],
"distributed-aspect-ratio": ["2.20:1", "2.35:1"]
```

`acquisition` is the headline field — `Celluloid` / `Digital Cinema` / `Video` /
`Computer Generated (Digital)`. That alone answers "was this shot digitally?".

Spot checks on the nerdy canon are excellent:

| Film | acquisition | negative | camera |
|---|---|---|---|
| Dunkirk | Celluloid | 65mm | IMAX MKIV, Panavision System 65 |
| Oppenheimer | Celluloid | 35mm + 65mm | IMAX MKIII/MKIV, ARRIFLEX 435 |
| The Hateful Eight | Celluloid | 65mm | ARRIFLEX 765, Panavision 65 |
| Raiders of the Lost Ark | Celluloid | 16mm + 35mm | ARRIFLEX 35 IIC, Panaflex-X |
| The Social Network | **Digital Cinema** | — | Red One MX |

## Measured coverage

`format-coverage.py` sampled 40 random movies from the actual library (955 total), resolving each
by a `title-year` slug:

```
COVERAGE: 22/40 = 55%
acquisition: {Celluloid: 19, Digital Cinema: 3, Video: 2, Computer Generated (Digital): 1}
misses:      {404 (no such page): 13, page exists but no acquisition data: 5}
```

Misses are dominated by two causes:

1. **Films the site does not have.** Confirmed by hand for *The Brutalist* (2024) and *Sinners*
   (2025) — the database lags recent releases. This is the real ceiling.
2. **Slug mismatches** for older films (*The Magnificent Seven*, *Lady Bird*, *My Neighbor
   Totoro*). Trying year ±1 recovered **none** of them, and the site's own search returns
   unrelated results, so slug-guessing has little headroom. An IMDb-id route would fix this —
   the site keys its images by IMDb id (`/images/0056172.jpg`) — but no id-based page URL is
   exposed, and `?imdb=` does not resolve.

So ~55% is close to the realistic ceiling for this source, weighted towards exactly the older,
canonical films worth being nerdy about, and weakest on the last two years.

## If built

- **Controller**: `GET /api/film-format?imdb=&tmdb=`, one fetch per film, result cached
  permanently on disk (this data never changes for a released film) — mirroring `/api/crew`.
  Rate-limit to one request at a time; this is a courtesy scrape of a small site, so it should
  backfill slowly in a sweep rather than hammer on demand.
- **Display**: a single line on the detail page next to RUNS/ENDS — `SHOT ON · 65mm · IMAX MKIV`,
  or `SHOT ON · Digital · Red One MX`. Absent when unknown; never "Unknown".
- **Nice-to-have**: because `acquisition` is a clean enum, a "Shot on film" collection shelf
  becomes trivial once the backfill exists.

## Not recommended

Scraping IMDb directly. It is the best data and it is actively blocked; working around that is
both fragile and impolite.

## Reproducing

`format-coverage.py` (the probe used above) is in the session scratchpad, not committed — it is
a one-off measurement, not a tool. It samples Jellyfin, slugifies, fetches, and reports coverage
with a 1.5s delay between requests.
