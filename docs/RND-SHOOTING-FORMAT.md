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

---

# Addendum — 2026-09-13: second pass, and the ceiling is now measured

Brennan asked for another look for a free, feasible source, and specifically for **which
film stock**, not just film-vs-digital. Three things changed since 2026-09-07.

## 1. The 55% was never a slug problem — it is the corpus

The original study guessed slug-matching had "little headroom" and that an IMDb-id route
would fix the misses. That guess is now tested and **wrong in a useful way**.

`shotonwhat.com` publishes a complete browsable index by acquisition class, paginated:

```
/acquisition/celluloid-acquisition                     156 pages   3,105 titles
/acquisition/digital-cinema-aquisition   [sic]          94 pages   1,863 titles
/acquisition/video-acquisition                          25 pages     487 titles
/acquisition/computer-generated-digital-acquisition     10 pages     182 titles
```

Crawling all 285 pages (0.9 s apart, one pass, ~8 minutes) yields **5,281 unique
`title-year` slugs with their acquisition class already attached** — no per-film fetch
needed for the headline answer. Matching that complete index against the live library:

```
COVERAGE: 523/934 = 56.0%
misses:   411, ALL of them "title is not in the index at all" — zero year mismatches
```

Spot-checked three misses directly (`/12-angry-men-1957`, `/about-time-2013`,
`/20th-century-women-2016`) — all 404. **The site simply does not have them.**

So a perfect index gives 56% where naive slug-guessing gave 55%. The ceiling is the
database, not the matching, and no id-based lookup would move it. (Adding
article-stripped slug variants made it *worse* — 54% — by manufacturing false year
matches. Keep the match strict.)

### Where the gap is

```
1920s   0/  3      1970s  37/ 58      2020s  30/124   ← 24%
1930s   5/ 11      1980s  41/ 84
1940s  11/ 24      1990s  75/120
1950s  17/ 40      2000s 128/188
1960s  21/ 63      2010s 158/219      ← 72%, the peak
```

The 2020s collapse confirms the original finding and sharpens it: **the feature would
light up on the canon and stay dark on most new arrivals.** For a "nerdy detail about old
films" that is acceptable; for a line every film is expected to have, it is not.

## 2. "Which stock" is a real field, and it is thinner than acquisition

`dataLayer_content.pagePostTerms` carries a much richer taxonomy than the earlier study
recorded. For *Oppenheimer*:

```
acquisition          : ["Celluloid"]
project-resolution   : ["Film Project"]
cameras              : ["ARRIFLEX 435 Camera", "IMAX MKIII/MKIV Reflex", "Panavision System 65"]
film-negative-stock  : ["Eastman Double-X 5222/7222 Neg. Film",
                        "Kodak Vision3 250D 5207/7207 Neg. Film",
                        "Kodak Vision3 500T 5219/7219 Neg. Film"]
film-negative-width  : ["35mm Film Negative Width", "65mm Film Negative Width"]
film-negative-pulldown, camera-aperture, lenses, lighting, film-labs-post-facilities,
distribution-medium, projection-format, …
meta.imdb_id         : 15398776          ← the IMDb id IS on the page
```

Field availability, sampled over 25 matched library films:

| Field | Present | Library end-to-end |
|---|---|---|
| `acquisition` (film / digital / video / CGI) | 25/25 | **56%** |
| `cameras` | 22/25 | ~49% |
| `film-negative-width` (35 / 16 / 65 mm) | 18/25 | ~40% |
| **`film-negative-stock`** (the actual emulsion) | **15/25** | **~34%** |

So *which stock* is answerable for roughly a third of the library. That is enough to be a
delightful line on *Killers of the Flower Moon* (4 stocks listed) and absent on most
things.

**`meta.imdb_id` on every page is worth noting** — it lets a backfill *verify* a
title-year match rather than trust it, which is exactly the protection the festival study
found missing when a title-only join put Bergman's *The Magician* on a 2005 Australian
mockumentary (`docs/RND-FESTIVAL-EXPANSION.md` §A).

## 3. Data quality is not perfect

*Horrible Bosses* (2011) is classed `Video` and *It Follows* `Digital Cinema`; both are
worth a second look before trusting the field blindly. Some entries carry multiple
acquisition classes legitimately (*Killers of the Flower Moon*: Celluloid + Digital
Cinema, which is correct), so the field is a set, not an enum, and the UI has to handle
"both".

## 4. The alternatives are still dead — now with numbers

| Source | Status |
|---|---|
| **Wikidata `P3803`** | 7,018 films worldwide carry it; **81 of our 934 = 8.7%**, and worst exactly where it matters (2010s 10/219, 2020s 3/124). Values are gauge only — essentially nothing is marked digital. |
| **Wikidata `P4082`** ("captured with", camera model) | **83 films worldwide.** Not a source. |
| **Wikipedia prose** | Newly tested and dead. `insource:/shot on 35 mm/` returns **5 articles** site-wide; `Kodak Vision3` 20; `Arri Alexa` 309. No film-gauge categories exist either — `Category:Films shot on 35 mm film`, `…16 mm film`, `…on digital video`, `Films shot in 65 mm` are all absent (only `Category:IMAX films` exists). |
| **IMDb** | Unchanged: the canonical data, actively blocked, and the free IMDb datasets (`datasets.imdbws.com`) contain no technical specs. Not worth working around. |

## 5. Revised recommendation

Unchanged in direction, sharper in shape:

- **Seed from the index, not from 934 page fetches.** One 285-page crawl gives
  film-vs-digital for every title the site has. Re-crawl monthly at most; this data never
  changes for a released film.
- **Fetch detail pages only for matched films** (523), for stock / camera / gauge, and
  cache permanently keyed by IMDb id verified from `meta.imdb_id`.
- **Nightly job scope is tiny.** The library gains a handful of films a week, so the
  steady-state job is a few requests a night. The one-time backfill is the only bulk
  traffic, and it should run slowly.
- **Be a good citizen.** This is a small independent site that sells memberships. Its
  `robots.txt` blocks named SEO/commercial crawlers but has no blanket `User-agent: *`
  ban, and its terms carry no anti-scraping clause — but the polite construction (one
  request at a time, ~1 s apart, permanent cache, descriptive User-Agent) is the right
  one regardless, and it is Brennan's call whether to do it at all.
- **Display honestly.** `SHOT ON · 35mm · Kodak Vision3 500T` when known; render nothing
  when not. Never "Unknown", and do not infer "digital" from absence — 44% of this
  library has no entry at all.
