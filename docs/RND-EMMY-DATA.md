# R&D: Emmy award data for TV shows

**2026-09-13.** Feasibility study of data sources only, per the ask. No implementation.

**Verdict: feasible, and cheaper than the Oscar pipeline — the Television Academy's own
site serves the exact two numbers the badge system needs, server-rendered, one page per
show, ~98 requests for this whole library. The one real obstacle is that show URLs are
slugs with no resolvable rule, so a slug index/alias file is required.**

A second finding worth stating up front: Emmy counts are an order of magnitude larger
than Oscar counts, which is a **design** problem more than a data one. See §D.

---

## A. Sources evaluated

| Source | Has the data? | Usable? |
|---|---|---|
| **televisionacademy.com** `/shows/<slug>` | Yes — total nominations, total wins, and every individual nomination with category, year, episode, network and winner/nominee status | **Best option.** Server-rendered HTML (no JS needed for the data), `robots.txt` allows it, one page per show. |
| **Wikipedia** `<N>th Primetime Emmy Awards` | Partly | All 77 ceremonies exist and list the major categories' nominees. But the per-program **totals** table (`Nominations and wins by program`) only appears from the **75th (2023)** onward — checked 40th, 50th, 55th, 60th, 65th, 70th: absent. So historical counts would have to be reconstructed by summing 77 pages of category tables, and Creative Arts categories are largely missing from the older ones. |
| **Wikidata** (`P166` award received) | No | **103 series worldwide** carry a Primetime Emmy statement. Dead end, same as it was for film format. |
| **GitHub datasets** | No | There is no Emmy equivalent of `DLu/oscar_data`. Searched; the only hits are abandoned student projects and unrelated repos. |
| **TMDb / Jellyfin** | No | Neither models awards. |

### What a Television Academy show page actually gives you

`https://www.televisionacademy.com/shows/severance` renders, in plain HTML:

```
41 Nominations   10 Emmys
  Nominee  Outstanding Picture Editing For A Drama Series - 2025  Severance  Cold Harbor
           Apple TV+  Fifth Season in association with Apple  Geoffrey Richman, ACE, Editor
  Nominee  Outstanding Supporting Actor In A Drama Series - 2025  Zach Cherry, as Dylan George
  …
```

`N Nominations / M Emmys` maps straight onto the existing badge contract — the Oscar
sweep already stores `{noms, wins}` per title and both clients already render
`wins` gold + `noms - wins` silver. Verified live against known values:

| Show | Reported |
|---|---|
| Game of Thrones | 59 wins / 159 nominations |
| The Sopranos | 21 / 112 |
| Mad Men | 16 / 116 |
| Breaking Bad | 16 / 58 |
| Ted Lasso | 13 / 61 |
| The West Wing | 26 / 95 |
| Severance | 10 / 41 |
| Chernobyl | 10 / 19 |
| The Queen's Gambit | 11 / 18 |
| Squid Game | 6 / 14 |

`robots.txt` has a `User-agent: *` section that disallows only `/cp/`, `/admin/`,
`/api/…` and `/vendor/`. The awards pages are explicitly crawlable.

---

## B. The slug problem (the only real obstacle)

Show URLs are `/shows/<slug>`, and the slug is **not derivable** from the title by any
consistent rule. Observed:

```
The Last of Us   -> /shows/last-us        (drops "the" AND "of")
The White Lotus  -> /shows/white-lotus    (drops "the")
The Diplomat     -> /shows/diplomat       (drops "the")
Game of Thrones  -> /shows/game-thrones   (drops "of")
The Penguin      -> /shows/the-penguin    (keeps "the")
The Studio       -> /shows/the-studio     (keeps "the")
The Pitt         -> /shows/the-pitt       (keeps "the")
House of the Dragon -> /shows/house-of-the-dragon  (keeps everything)
```

The site's own search is client-side (`/site--search` returns an identical 305 KB shell
for every query), and `/shows/` URLs do **not** appear in `sitemap.xml` (52 sub-sitemaps,
1000 URLs each, sampled 1/5/10 — zero show pages).

**Measured recovery.** Trying four candidate forms per title — full slug, all stopwords
stripped, leading article stripped, `of` stripped — resolved **10 of 16** hand-picked
library series, including the awkward ones (*Game of Thrones* → `game-thrones`,
*The Sopranos* → `sopranos`, *The Queen's Gambit* → `queens-gambit`).

The six misses were *Suits*, *Shōgun*, *FROM*, *Blue Mountain State*,
*It's Always Sunny in Philadelphia* and *Last Week Tonight with John Oliver*. At least
two of those (*Shōgun*, *Last Week Tonight*) certainly have Emmy pages, so they are real
slug failures — a 404 here is **not** evidence that a show has no Emmy history, and a
build must never treat it as such. Whether the others have pages was not checked.

**Recommendation:** the four-candidate probe plus a small checked-in
`data/emmys/tva-slugs.json` alias map, in the same spirit as `resolve-festivals.sh`'s
`ALIASES`. The library has 98 series and grows by a handful a year, so the alias file is
a one-time afternoon and a line per new show — far cheaper than the alternative, which is
crawling 77 year pages × ~123 category pages (~9,000 requests) to harvest the show links
that appear there.

The show links **are** present on the year and category pages
(`/awards/nominees-winners/2025/outstanding-drama-series` links `/shows/andor`,
`/shows/the-pitt`, …), so a full index is *possible* — it is just not worth 9,000
requests to a single organisation's site to save 98 hand-checks.

---

## C. Matching to Jellyfin

Unlike films, series have no reliable id join here: the Television Academy publishes no
IMDb/TVDB/TMDb ids. Matching is by **name**, which is exactly the weak join that put a
Venice badge on the wrong *The Magician* in the film study
(`docs/RND-FESTIVAL-EXPANSION.md` §A). Mitigations:

- The slug alias file makes the join explicit and human-checked rather than fuzzy.
- Key the stored data by **Jellyfin series id or TVDB id**, resolved once by hand, not by
  title at sweep time.
- Remakes are the live hazard in this library already — `Dexter` vs `Dexter: New Blood`
  vs `Dexter: Original Sin` vs `Dexter: Resurrection`, `Cosmos` vs `Cosmos (2014)`,
  `Suits` vs `Suits LA`, `Yellowstone (2018)`.

---

## D. The design problem: Emmy counts are huge

Oscar badges top out around 11 wins / 14 nominations. Emmy badges would read
**59 EMMY WINS / 159 NOMINATIONS** for *Game of Thrones*, and a good half of those are
Creative Arts craft categories (sound editing, prosthetic makeup, main title design).
Rendering that with the same visual weight as `4 OSCAR WINS` overstates it badly, and
five-glyph-wide numbers will not fit the compact Fire Stick pill (`59W` is fine, `159N`
is not — the pill is sized for two digits).

Three ways out, for a later decision:

1. **Count major categories only** (program, acting, directing, writing) — the same
   distinction Wikipedia's own tables draw, and the one a viewer actually means by "how
   many Emmys did it win". Requires parsing the per-nomination list rather than reading
   the headline totals, but that list is on the same page.
2. **Show the totals but change the wording** to a single line — `59 EMMYS · 159 NOMS` —
   so it reads as a stat, not as a stack of statuettes.
3. **Show totals as-is** and accept that *Game of Thrones* dominates every shelf it
   appears on.

No recommendation yet — this is a taste call, and it is downstream of whether TV badges
should look like film badges at all.

---

## E. Sketch, if built

- `data/emmys/build-emmys.sh` — read the library's series list, resolve each slug (four
  candidates + `tva-slugs.json`), fetch `/shows/<slug>`, parse totals and the per-category
  list, emit `controller/emmy-awards.json` keyed by Jellyfin series id. ~98 requests at a
  1s delay ≈ 2 minutes, cached; it only needs to re-run after an Emmy ceremony, not nightly.
- `controller/lib/oscar-tags.js` — the sweep already walks `Series` items for nation tags;
  add `emmy-wins-N` / `emmy-noms-N` tags on the same Tags-only, diff-only contract
  (no deletes, no searches, no policy writes — and these tags must never enter a
  `BlockedTags` list).
- Clients read the tags exactly as they read `oscar-wins-N` today.

Keeping it updated after each September ceremony: `docs/DESIGN-AWARD-WATCH.md`.
