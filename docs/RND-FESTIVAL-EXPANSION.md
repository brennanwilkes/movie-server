# R&D: adding TIFF + Venice to the award badges

**2026-09-13. SHIPPED the same day** — this began as a feasibility study and is kept as the
record of why each decision went the way it did. Extends
`docs/branding/DESIGN-FESTIVAL-BADGES.md` (Cannes + Sundance, shipped 2026-08-01).

**What shipped:** Venice (Golden Lion, Grand Jury Prize, Best Director) and TIFF (People's Choice)
on web, mobile web and the Fire Stick; the four-row case drops the Oscar NOMINATIONS row; Venice is
an azure lion silhouette and TIFF a red maple leaf; `fetch-festivals.sh` regenerates the lists from
Wikipedia and `resolve-festivals.sh` now resolves ids through Wikidata instead of title search.

**Verdict: feasible, cheap, and the badge-overlap risk is small but real — the
"4-line stack never occurs" guarantee the earlier design was built on is broken by
this change.** Exactly 2 films of 934 render four rows' worth of awards; §B.1 is how that
is now resolved.

---

## A. Data source

Same pipeline as Cannes/Sundance: English Wikipedia wikitext via the MediaWiki API,
parsed into `data/oscars/festivals.json`, TMDb ids filled in by
`data/oscars/resolve-festivals.sh`, merged into `controller/oscar-winners.json` by
`data/oscars/build.sh`. No new mechanism, no new credentials, no paid source.

Pages parsed (all fetched and parsed successfully in this study):

| Proposed collection | Wikipedia page | Winners | Span |
|---|---|---|---|
| `Venice: Golden Lion (Winners)` | `Golden Lion` | 70 | 1949–2026 |
| `Venice: Grand Jury Prize (Winners)` | `Grand Jury Prize (Venice Film Festival)` | 72 | 1951–2026 |
| `Venice: Best Director (Winners)` | `Silver Lion` § *Best Direction (1990–present)* | 31 | 1990–2026 |
| `TIFF: People's Choice (Winners)` | `Toronto International Film Festival People's Choice Award` | 48 | 1978–2025 |

### Parsing notes (these cost time; write them down)

- **Film titles are the wikilinks wrapped in `''…''`.** Native-language title cells are
  italicised but *not* linked, so `''\[\[…\]\]''` cleanly isolates the English title.
- **The TIFF table contains runners-up as well as winners**, in the same column. The
  winner is the only entry in **bold-italic** (`'''''[[…]]'''''`) with
  `style="background:#FAEB86;"`. Matching on five apostrophes gives exactly 48 rows for
  1978–2025 — one per year, no gaps.
- **Image captions are not table rows.** `[[File:…|thumb|…won for ''[[Goodfellas]]'' (1990)]]`
  sits between the heading and the table and contains exactly what the parser looks for. The first
  run counted 87 Golden Lion "winners" where there are 70. Captions are stripped with a
  bracket-balanced scan before parsing — plain regex cannot, because a caption contains nested
  `[[…]]`.
- **The Silver Lion for Best Direction really does skip 1991–1997.** It was awarded in 1990, then
  not again until 1998. A parser that "recovers" those years is wrong, not thorough.
- **`Silver Lion` covers several different awards.** Only the
  *Silver Lion for Best Direction (1990–present)* section is the modern Best Director
  award; the page's later *Defunct Categories* hold the 1953–1994 *Silver Lion Prize*,
  which is the historic second prize and therefore **overlaps the Grand Jury Prize page**.
  Terminating the section scan at the next `==` heading matters: a first pass that failed
  to find its end marker ran to the bottom of the page and silently pulled in
  *On the Waterfront* and *Seven Samurai* as "Best Director" winners. Decide deliberately
  whether pre-1990 Silver Lions are in scope — if they are, take them from the Grand Jury
  Prize page only, never from both.
- `Special Jury Prize (Venice Film Festival)` exists (16 winners, 2013–2026) but matches
  **0 films in this library**. Not worth a collection.
- TIFF's `Platform Prize` (2015–, 11 winners) and the separate People's Choice
  *Documentary* / *Midnight Madness* awards are out of scope for the same reason.

### Title matching is not safe on its own — resolve TMDb ids

Matching the 274 scraped winner titles against the library by normalised title produced
**32 hits, of which one is wrong**: Bergman's *The Magician* (1958, Venice Special Jury
Prize) matched the library's *The Magician* (2005, `tt0461989`) — a completely unrelated
Australian mockumentary. That is a 3% false-positive rate on a title-only join, and it
would put a Venice badge on the wrong film forever.

**Resolved by not matching on titles at all.** `fetch-festivals.py` now records each winner's
wikilink TARGET, and `resolve-festivals.sh` turns that into a TMDb id through Wikidata
(`article → wikibase_item → P4947`). 218 of 220 new entries resolved exactly; the two stragglers
fell through to the old TMDb search. *The Magician* now resolves to TMDb 29453 (Bergman), and the
library's 2005 film carries no festival tag — verified live against `/api/awards`.

The ALIASES table survives only for the search fallback and should not need to grow.

---

## B. Badge overlap — the actual measurement

Measured against the live library (934 movies) on 2026-09-13, using the `oscar-*` and
`festival-*` Tags already on the items, so this reflects what is really rendered today.

A plaque row is emitted for each of: Oscar wins, Oscar nominations, Cannes, Sundance —
and, under this proposal, TIFF and Venice. `oscarPlaqueHtml()` in
`scripts/provision/jellyfin-web-flair.js`; `OscarBadges.kt` stacks the same way on the
Fire Stick.

```
rows | today | with TIFF + Venice
  0  |  439  |  434
  1  |  260  |  260
  2  |  215  |  202
  3  |   20  |   37
  4  |    0  |    2
  5  |    0  |    0
```

Three-row films nearly double (20 → 37). **Four-row films go from zero to two:**

| Film | Rows |
|---|---|
| *Life Is Beautiful* (1997) | 3 Oscar wins · 7 nominations · Cannes (Grand Prix) · TIFF (People's Choice) |
| *Nomadland* (2021) | 3 Oscar wins · 6 nominations · Venice (Golden Lion) · TIFF (People's Choice) |

**Five rows cannot happen**, and this is measured rather than assumed. Intersecting the
four full winner corpora by normalised title (Cannes 323, Sundance 206, Venice 187,
TIFF 48 titles — the whole datasets, not just this library):

```
Cannes ∩ Venice   : none          Sundance ∩ Venice : none
Cannes ∩ TIFF     : Life Is Beautiful
Sundance ∩ TIFF   : Precious       Venice ∩ TIFF     : Nomadland, Zatoichi
Cannes ∩ Sundance : sex, lies, and videotape  (and it is in no TIFF or Venice list)
```

No title appears in three festivals. So the ceiling is
OscarW + OscarN + one festival + TIFF = **4 rows**, permanently — and it will stay 4
unless a future year produces the first triple, which the watcher in
`docs/DESIGN-AWARD-WATCH.md` would surface at rebuild time.

**Why this matters.** `DESIGN-FESTIVAL-BADGES.md` opens with *"The 4-line stack never
occurs (0 of 2,213 films), so it is omitted"*. Both clients were built on that premise.
Adding TIFF + Venice invalidates it, so a policy has to be chosen rather than inherited.

### Options for the 4-row case

1. **Allow four rows.** Two films. Cheapest option; nothing to build.
2. **Collapse the Oscar block to one line** — `3 WINS · 7 NOMS`. Keeps every award visible.
3. **Drop the Oscar NOMINATIONS row when a fourth row would appear.** **CHOSEN** (Brennan,
   2026-09-13): *"lets just straight up drop oscar noms from the box (Noms still render on the
   detail page)."* Wins and festival wins are the rarer, more interesting facts; the nomination
   count is the one thing on the plaque that is also available in full one screen away. A festival
   row is never dropped — two festival rows plus a wins row is exactly three.

   Implemented identically in both clients as
   `wantNoms = losses > 0 && (1 + festivalRows + (wins > 0 ? 1 : 0)) <= 3`
   (`oscarPlaqueHtml()` in `jellyfin-web-flair.js`, `applyOscarPlaque()` in `OscarBadges.kt`).
   Verified live: *Nomadland* renders `3 OSCAR WINS / GOLDEN LION / PEOPLE'S CHOICE`, and its
   detail-page Awards row still lists all six Oscar nominations.

---

## C. Colour and glyph

Existing palette, for contrast: Oscar gold `#E6B94C`, Oscar silver `#C9CDD3`,
Cannes sage `#9fb87f` (film-reel glyph), Sundance orange `#f26d3d` (sun glyph).

Proposal — both need a hue that survives an 11px glyph on a dark translucent plaque, and
must not read as a near-miss of Sundance orange:

| Festival | Glyph | Colour | Why |
|---|---|---|---|
| **Venice** | lion silhouette, in profile | azure `#6FA8DC` | The Golden Lion's own animal. Gold is unavailable (it is the Oscar win colour), and azure is the only cool hue in the palette, so it can never be confused with Cannes sage or Sundance orange. |
| **TIFF** | maple leaf | red `#D64545` | The People's Choice Award is the one award the public gives, and TIFF's identity is maple-red. Pushed redder than Sundance's `#f26d3d` deliberately — they are the two warm glyphs and the only other safeguard is the glyph shape. |

### Both glyphs are traced from public-domain art, not drawn

This was the single most time-consuming part of the change, so it is worth writing down why.

A *lion's head* was the original proposal and it does not work. Four constructed variants were
rendered and compared at 44/22/14/11px — spiky mane, rounded mane, smooth mane, mane plus ears —
and every one reads as a featureless blob at badge size, and worse, as a near-twin of the Cannes
disc. Likewise a hand-built 11-point maple leaf rendered as a red splat.

What survives the size is the **shape class**, not the detail: a disc, a sun, an animal in profile,
a leaf. So both new glyphs are traced:

* **Lion** — the NIH BioArt mountain-lion silhouette (public domain). Source art is 477×200, so it
  is a WIDE glyph: 18×11px on web, ~17×7dp on the Fire Stick, against the square 11px/7dp the other
  three use. Squeezed into a square box it smears to a dash. `FESTIVALS[].boxW` and the `wide` flag
  in `OscarBadges.kt` carry that through; changing one without the other squashes the lion.
* **Leaf** — the maple leaf lifted out of the public-domain Flag of Canada SVG.

Both keep their source coordinate space and are fitted with a transform, so the framing can be
re-derived rather than re-eyeballed. A CC BY-SA "Leone d'Oro" silhouette exists on Commons and was
**rejected**: it is a derivative of the festival's own logo, which brings both a share-alike
obligation and a trademark question that a badge glyph does not need.

Both are single-path SVGs in the same style as `FESTIVAL_REEL_SVG` / `FESTIVAL_SUN_SVG`,
and need Fire Stick vector twins in `res/drawable/` plus `res/values/colors.xml` entries
(`festival_venice`, `festival_tiff`).

**This is a taste call and it is yours to make** — the table above is a recommendation,
not a decision.

---

## D. Library impact, per collection

Collection shelves use a "hide if fewer than 3 films" rule (see
[[franchise-collection-ordering]] / `scripts/sort-collections.sh`).

| Collection | Winners | In library (title match, estimate) | In library (TMDb id, actual) | Collection created? |
|---|---|---|---|---|
| TIFF: People's Choice | 48 | 18 | **18** | yes |
| Venice: Golden Lion | 70 | 13 | **9** | yes |
| Venice: Best Director | 31 | 5 | **3** | no — below `AWARD_MIN` |
| Venice: Grand Jury Prize | 72 | 2 | **2** | no — below `AWARD_MIN` |
| Venice: Special Jury Prize | 16 | 0 | — | not tracked |

**The estimate column was optimistic, and that is the point.** The feasibility pass matched winner
titles against library titles and over-counted Venice by six films. The shipped numbers come from
the TMDb-id join. A title match is a plausible-looking wrong answer, which is exactly the failure
this whole change was built to remove.

`AWARD_MIN = 4` in `collections.js` is a pre-existing rule — a shelf holding two or three films is
a stub — so the two thin Venice categories correctly get no collection. **Badges are unaffected:**
they come from item Tags, not from collections, so those five films still wear their Venice badge.

27 films gained a badge (18 TIFF, 10 Venice, *Nomadland* in both).

---

## E. What was built

All of it, 2026-09-13, verified live unless noted.

**Data**
1. `data/oscars/fetch-festivals.py` + `.sh` — NEW. Regenerates the winner lists from Wikipedia,
   additive-only, recording each winner's wikilink target. 221 new entries.
2. `data/oscars/resolve-festivals.sh` — rewritten around the Wikidata join (§A). 221/221 resolved,
   0 unresolved, 9 flagged for review (all benign alternative-title cases).
3. `bash data/oscars/build.sh` — 4 new collections in `controller/oscar-winners.json`,
   **zero churn** to the 26 existing ones (diffed by membership).

**Controller**
4. `oscar-tags.js` — a single `FESTIVALS` table now drives the tag regex, the tmdb index, the tag
   writer and `/api/awards`; `festivals` in the API response is one key per festival, always
   present. Sweep result: `477 oscar-tagged, 85 festival-tagged, 32 written`.
5. `collections.js` — four `OSCAR_DESC` entries. `hss-shelf.js` — award regex extended to
   `Venice|TIFF`.

**Web** (`jellyfin-web-flair.js`, `jellyfin-custom.css`, deployed via `./scripts/provision.sh jellyfin`)
6. Matching `FESTIVALS` table; generalised tag parser; plaque rows; the four-row policy;
   mobile pill segments; detail-page Awards rows; colours in both stylesheets.
7. **`mn_oscars_v2` → `v3`.** The parsed shape changed from flat `c/s/cName/sName` to an `f{}` map.
   A returning browser holding a v2 entry would deserialise `f === undefined` and silently drop
   every festival row until its next refresh, so the cache key is bumped rather than migrated.

**Fire Stick** (`~/jellyfin-androidtv`, built with JDK 21, installed to `org.jellyfin.androidtv.debug`)
8. `OscarAwards.kt` — `Festival` enum + counts map replacing positional `cannes`/`sundance` Ints.
   Every call site had taken them positionally, so a fifth festival meant widening six signatures
   again; `LegacyImageCardView.setOscarAwards` now takes the whole `OscarAwards`.
9. `OscarBadges.kt` — festival loop + the same four-row rule. `AwardsRow`/`AwardsFetcher`/
   `AwardsRowPresenter` — `Kind.VENICE`/`Kind.TIFF`, colours, meta labels.
10. `ic_festival_venice.xml`, `ic_festival_tiff.xml`, two `colors.xml` entries.

### Verification

| Check | Result |
|---|---|
| `/api/awards` Nomadland | `venice: [GOLDEN LION], tiff: [PEOPLE'S CHOICE]` |
| `/api/awards` The Magician (2005) | all festivals empty — the false positive is gone |
| Jellyfin tags, Nomadland | `festival-venice-1`, `festival-venice-name-GOLDEN LION`, `festival-tiff-1`, … |
| Web plaque, Nomadland | `3 OSCAR WINS / GOLDEN LION / PEOPLE'S CHOICE` — 3 rows, noms dropped |
| Web plaque, The King's Speech | `4 OSCAR WINS / 12 NOMINATIONS / PEOPLE'S CHOICE` — noms kept (only 3 rows needed) |
| Web plaque, Parasite (regression) | `4 OSCAR WINS / 6 NOMINATIONS / PALME D'OR` — unchanged |
| Detail Awards row, Nomadland | all 6 Oscar rows + `Golden Lion · Venice` + `People's Choice · TIFF` |
| Mobile pill (390px, real `layout-mobile`) | `🏆 3W · 3N · 🦁1 · 🍁1`; Venice-only films take the Venice accent |
| TIFF collection page | 18 plaques, all correct |
| Fire Stick | builds, installs, launches, authenticates, no crash in logcat |

**Not yet confirmed:** the Fire Stick glyphs *on screen*. The TV was asleep
(`Display Power: state=OFF`) during this session, and waking it would have switched the TV input
over CEC. The drawable geometry was verified by rendering the exact Android `pathData` and
viewports in a browser, and the plaque logic is a line-for-line mirror of the web version above —
but a human should glance at a Venice or TIFF poster on the TV.

Keeping data updated: see `docs/DESIGN-AWARD-WATCH.md`.
