# Design: Emmy badges for TV shows

**2026-09-13 workshop · SHIPPED 2026-09-14.** Kept as the record of why each decision went the
way it did.

**What shipped:** `data/emmys/fetch-emmys.sh` (Wikipedia → Wikidata, exact id join) →
`data/emmys/build.sh` → `controller/emmy-awards.json` → `controller/lib/emmy-tags.js` (daily sweep,
Tags only) → badges on web and Fire Stick, plus an Awards list on both detail screens.
Live: 53 of 98 series badged, 27 with a named program win. Game of Thrones reads
`4x DRAMA SERIES`, Severance `EMMY NOMINATED`, and Cheers' 95 nominations appear nowhere. Follows `docs/RND-EMMY-DATA.md` (source
feasibility). Two questions were open: **how to match shows to Emmy records safely**, and
**how to render counts that are an order of magnitude bigger than Oscar counts**. Both are
answered below against real numbers from a full dry-run over this library's 98 series.

---

## A. The pipeline — Wikipedia + Wikidata, no slug guessing

**The Television Academy route was abandoned.** It has the richest data, but it publishes no
ids, its URL slugs are not derivable (`The Last of Us` → `last-us`, `The Penguin` → `the-penguin`),
and a full dry-run over the library left **26 of 98 series unresolved** — including *Shōgun*,
*Last Week Tonight*, *The Queen's Gambit* and *Bob's Burgers*, all of which have substantial
records. Shipping that would have meant a hand-maintained alias file as a permanent dependency.

It also produced a genuine false positive: our `House` generated the slug `house`, which is a real
page — for **"In The House"**, an unrelated sitcom. Name verification caught it, but the episode
made the point that the whole approach rests on guessing.

**The route that works is the one the film festivals already use.** English Wikipedia's ceremony
articles are consistently structured across all 77 years, and every show is a **wikilink** — which
resolves to a Wikidata item, which carries `P345` (IMDb), `P4983` (TMDb) and `P4835` (TheTVDB).
All 98 library series carry all three ids, so the join is **exact**. No slugs, no aliases, no
name matching anywhere in the pipeline.

```
77 Primetime ceremony articles   -> 9,173 major entries
20 Creative Arts articles (2005+) ->   357 program-level entries
                                     ------
                                      9,530 entries
articles -> Wikidata item : 1,961 / 2,002
items    -> id claims     : 1,947 / 1,947
LIBRARY SERIES WITH EMMY MAJORS: 53 of 98
```

### Why Creative Arts had to be merged in

The main ceremony article covers Programs / Acting / Directing / Writing. But **Outstanding
Animated Program** and **Outstanding Documentary or Nonfiction Series** are program-level awards
handed out at the *Creative Arts* ceremony, on a separate article. Without them the library lost
*Rick and Morty*, *Bob's Burgers*, *Archer*, and the entire *Planet Earth* / *Blue Planet* /
*Frozen Planet* family — a large and much-watched slice of this library. Only the program-level
categories are taken from those pages; the craft categories stay out by design.

Creative Arts articles exist as `Nth Primetime Creative Arts Emmy Awards` for the 57th (2005)
onward — which covers every gap this library actually had.

### Cross-validated against an independent source

The Television Academy scrape was kept as a check, and the two sources agree on program wins:

| | Wikipedia | Television Academy |
|---|---|---|
| Game of Thrones | 4× Outstanding Drama Series | 4 |
| Mad Men | 4 | 4 |
| Cheers | 4 | 4 |
| Succession | 3 | 3 |
| The Sopranos | 2 | 2 |
| Breaking Bad | 2 | 2 |
| Chernobyl | 1× Outstanding Limited Series | 1 |

### Parsing notes

- `{{Award category|…|[[Primetime Emmy Award for X|X]]}}` names the category; a single `*` bullet
  in bold is the WINNER, `**` are the nominees. Stable from the 30th to the 77th.
- **Wikipedia links a show only on its first mention.** Acting rows therefore carry the show
  unlinked (`''Frasier'' (NBC)`), and capturing linked italics only lost most acting entries —
  *Cheers* came back with zero. Unlinked titles are resolved through a map built from the titles
  that ARE linked somewhere across the 77 articles (2,959 of 3,558 resolve that way).
- The first italic on a row is the show; later italics are episode titles.
- **Retry failed API batches.** A dropped batch of 50 silently loses 50 shows — that is what hid
  *Game of Thrones*, *The Sopranos* and *Succession* from an earlier run, and it looked exactly
  like a data gap rather than a bug.

## B. Rendering — the numbers, measured

Oscar badges top out around 11 wins. Emmy totals do not — *Game of Thrones* is **59 wins from
159 nominations**, and 47 of those wins are Creative Arts craft categories.

### Two candidate treatments the data rules out

1. **"Majors only" is not enough.** Stripping craft still leaves Cheers at 95 nominations,
   The Sopranos 74, Game of Thrones 70. Two digits everywhere, and `159N` will not fit the compact
   Fire Stick pill.
2. **A boolean over ALL nominations does not discriminate.** Of the series with any Emmy history,
   97% have at least one nomination. A badge on almost everything says nothing.

**But a boolean over MAJOR nominations does discriminate** — 53 of 98 series, a bit over half.
That is the "in between" Brennan asked for, and it is what the design uses.

### The design (Brennan, 2026-09-13)

> *"Maybe we do 'Emmy Nominated' as a boolean for any sort of major nomination and then do the
> program award wins as their own row with numbers?"*

```
Row 1 (gold)    4x OUTSTANDING DRAMA SERIES    program WINS, named; "4x" only when > 1
Row 2 (silver)  EMMY NOMINATED                 any MAJOR nomination — shown only when there is
                                               no program win, so it never states the obvious
```

Measured over the library: **27 series** show a named program-win row, **26** show the boolean,
**45** show nothing. Largest number that can appear anywhere: **7** (Last Week Tonight's seven
Outstanding Variety Talk Series wins). Cheers' 95 nominations never appear — which was the point.

| Show | Plaque |
|---|---|
| Last Week Tonight | `7x OUTSTANDING VARIETY TALK SERIES` |
| Game of Thrones | `4x OUTSTANDING DRAMA SERIES` |
| Succession | `3x OUTSTANDING DRAMA SERIES` |
| The Bear | `OUTSTANDING COMEDY SERIES` |
| Chernobyl | `OUTSTANDING LIMITED SERIES` |
| Rick and Morty | `OUTSTANDING ANIMATED PROGRAM` |
| Planet Earth II | `OUTSTANDING DOCUMENTARY OR NONFICTION SERIES` |
| Severance | `EMMY NOMINATED` |
| Better Call Saul | `EMMY NOMINATED` |
| **The Wire** | `EMMY NOMINATED` |

*The Wire* gets its credit — one major nomination (Outstanding Writing for a Drama Series) — without
the plaque ever implying Cheers is the best show ever made.

The full record still exists on the **detail page's Awards list**, the same place the film plaque
sends you for the Oscar nominations it drops.

### Glyph and colour — resolved

> *"likely we want a glyph like the oscar one. We can use silver/gold cause TV shows are different
> than movies."*

So: an **Emmy statuette** glyph (the winged figure holding an atom), drawn in the same style as the
existing `ic_oscar_win` / `ic_oscar_nom` vectors, reusing **gold for the win row and silver for the
nominated row**. No new colour is needed — a film and a series never share a plaque, so gold cannot
be ambiguous. This also means the compact Fire Stick card form works unchanged: glyph + short text,
exactly like the festival rows.

One open detail: the Emmy statuette's wings make a 1:1 glyph, unlike the tall Oscar statuette
(9×18). It should sit in the same square 11px slot the festival glyphs use rather than the
statuette's tall one.

## C. Work if built

1. `data/emmys/fetch-emmys.py` + `.sh` — mirror of `data/oscars/fetch-festivals.py`: pull the 77
   Primetime ceremony articles plus the 20 Creative Arts articles, parse majors (+ program-level
   Creative Arts), record each show's wikilink target, write `data/emmys/emmys.json`.
2. `data/emmys/resolve-emmys.sh` — wikilink target → Wikidata → `P345`/`P4983`/`P4835`, exactly as
   `resolve-festivals.sh` does for films. **Retry failed batches** (see §A).
3. `data/emmys/build.sh` → `controller/emmy-awards.json`, keyed by the ids, not by title.
4. `controller/lib/oscar-tags.js` — the sweep already walks Series for nation tags. Add
   `emmy-program-wins-N`, `emmy-name-{AWARD}` and `emmy-nominated`, on the same Tags-only,
   diff-only contract: no deletes, no searches, no policy writes, and never in a `BlockedTags`.
5. Clients read the tags the way they already read `festival-*`; both need an Emmy statuette
   vector in gold and silver.

Re-run after each September ceremony — staleness detection is in `docs/DESIGN-AWARD-WATCH.md`,
which already polls the Emmys.

## D. Known gaps

- **Creative Arts before 2005** has no Wikipedia article, so an Animated Program or Documentary
  win older than the 57th ceremony is invisible. Nothing in this library is affected.
- *Rick and Morty* resolves to 1 Outstanding Animated Program win where it should be 2 (2018 and
  2020). Worth one look at the 72nd Creative Arts article before building — it is the kind of
  single-article parse nuance that the per-source cross-check in §A is there to surface.
- 41 of 2,002 show articles resolve to no Wikidata item, and a further 14 items carry no id
  claims. None are in this library, but a build should report them rather than swallow them.

## E. Surfaces (as shipped, 2026-09-14)

Both clients draw the badge from the item's Tags, so every surface that renders a Series card gets
it for free — *provided the client's card path admits Series at all*, which is where this first
shipped incomplete:

| Surface | Path | Notes |
| --- | --- | --- |
| Web — series detail poster | `decorateDetails()` → `applyFlair(…, isDetail=true)` | Large plaque. |
| Web — series detail "Awards …" list | `decorateDetailExtras()` → `/api/emmys` | Named awards + counts. |
| Web — every Series card/list row | `decorateItem()` → `applyFlair()` | Home rows, TV library, search, collections. |
| Fire Stick — poster cards | `CardPresenter.java` → `LegacyImageCardView.setOscarAwards()` | Compact `4W` pill. |
| Fire Stick — detail Awards row | `FullDetailsFragment.loadAwards()`, `case SERIES:` | Gold/silver rows. |

**The card-path gate is the thing to check when adding any non-film flair.** `decorateItem()` read
`if (type !== 'Movie') return;` — written when rank, runtime and Oscars were all film concepts — so
the Emmy badges landed on the series detail page (its own code path) and nowhere else. Brennan
caught it the same day: "only on say the TV show detail page… not for posters / previews for tv
shows on other pages". The Fire Stick had the identical shape of gate in `CardPresenter.java` and
was widened when the badges were built. Two further halves of the same fix:

- `loadOscars()` / `loadNations()` each query Jellyfin per `IncludeItemTypes`, so a Series query
  has to be added alongside the Movie one or the id index is simply empty for shows.
- Rank (Top 100) and the card runtime line stay **Movie-only** — a series' `RunTimeTicks` is one
  episode's length, not the show's.

Nation flags now render on series too, from the same `nation-{iso2}` namespace
`controller/lib/tv-meta.js` writes (16 of 98 shows).

Deploy a flair-only change with `scripts/push-web-flair.sh` — the JavaScript Injector applies its
configuration live. `make provision s=jellyfin` also pushes it but restarts Jellyfin, which is far
too blunt for a JS edit.
