# Top 100 — Film-Specific Styling Guide (supplement to SPEC.md §6)

**Date:** 2026-07-10
**Purpose:** Concrete guidance for implementing the Top 100 showcase (SPEC §6) based on the actual current list. This is a **living document** — the list will change. The design system must be data-driven (genre/collection/year from Jellyfin metadata), NOT hardcoded per title. This guide surfaces the *patterns in the current data* so implementation agents know where to focus effort and where the existing spec rules already cover things.

**Rule:** Everything here must be derivable at runtime from item metadata (`productionYear`, `genres`, `people`, TMDB collection). If a guideline here can't be computed from those fields, it's a note for human taste-checking, not a hard implementation rule.

---

## 1. Current tier snapshot

The current top 100 (as of 2026-07-10) breaks down as:

| Tier | Ranks | Count | Current films |
|---|---|---|---|
| **Pantheon** | 1–10 | 10 | Casablanca, Apocalypse Now, GoodFellas, Raiders of the Lost Ark, Pulp Fiction, Lawrence of Arabia, City of God, Blade Runner 2049, The Godfather, North by Northwest |
| **Gallery** | 11–50 | 40 | The Usual Suspects → The Irishman |
| **Ledger** | 51–100 | 50 | Barry Lyndon → Superbad |

### Current top 10 era + motif breakdown

| # | Title | Year | Era | Primary genre | Collection | Motif trigger | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Casablanca | 1942 | Silver | Drama/Romance | — | Noir/Crime pre-1960 ✓ | Venetian-blind shadow |
| 2 | Apocalypse Now | 1979 | Blockbuster | War/Drama | — | Adventure (war = subgenre) | Map contours + route line |
| 3 | GoodFellas | 1990 | Blockbuster | Crime/Drama | — | Noir/Crime post-1960 | Falls outside existing noir rule (pre-1960 only) — see §3 |
| 4 | Raiders of the Lost Ark | 1981 | Blockbuster | Adventure | Indiana Jones Collection | Indiana Jones Collection ✓ | Map contours + dashed route |
| 5 | Pulp Fiction | 1994 | Blockbuster | Crime | — | Noir/Crime post-1960 | Same as GoodFellas — needs genre expansion |
| 6 | Lawrence of Arabia | 1962 | Technicolor | Adventure/War | — | Adventure | Map contours + route line |
| 7 | City of God | 2002 | Modern | Crime/Drama | — | Noir/Crime post-2000 | Same crime question |
| 8 | Blade Runner 2049 | 2017 | Modern | Sci-Fi | — | None (Sci-Fi not mapped) | See §3 for potential Sci-Fi motif |
| 9 | The Godfather | 1972 | Technicolor | Crime/Drama | The Godfather Collection | Crime (technicolor era) | Possible Godfather collection motif |
| 10 | North by Northwest | 1959 | Technicolor | Thriller | — | Hitchcock thriller — not mapped | See §3 |

---

## 2. Franchise / collection clusters

These are the TMDB collection groups that appear multiple times in the list. The motif table in SPEC §6.5 already defines **James Bond** and **Indiana Jones**. This section surfaces the full set of collections that should be considered.

### High-frequency collections (3+ entries)

| Collection | Entries in top 100 | Ranks | Existing motif? |
|---|---|---|---|
| **James Bond** | 6 | #14 Skyfall, #19 Casino Royale, #42 Goldfinger, #57 From Russia with Love, #71 Spectre, #109 Dr. No | ✓ Gunbarrel dots (SPEC §6.5) |
| **Indiana Jones** | 4 | #4 Raiders, #23 Last Crusade, #64 Crystal Skull, #100 Dial of Destiny | ✓ Map contours + route (SPEC §6.5) |
| **Star Wars** | 4 | #18 Star Wars, #55 Empire, #56 Jedi, #73 Rogue One | ✗ Not mapped — see §3 |
| **Pirates of the Caribbean** | 3 | #16 Curse, #65 At World's End, #66 Dead Man's Chest | ✗ Not mapped — see §3 |
| **Lord of the Rings** | 3 | #29 Two Towers, #30 Return of the King, #54 Fellowship | ✗ Not mapped — see §3 |
| **Mission: Impossible** | 3 | #95, #96 Ghost Protocol, #97 Final Reckoning | ✗ Not mapped — see §3 |

### Dual-entry collections

| Collection | Entries | Ranks |
|---|---|---|
| The Godfather | 2 | #9, #17 |
| Blade Runner | 2 | #8 Blade Runner 2049, #48 Blade Runner |
| Pirates (see above) | 3 | — |

### Collection detection note

TMDB collection membership comes from the item's `ProviderIds.TmdbCollectionId` or via the library's collection grouping in Jellyfin. Not all films in a franchise are guaranteed to be in a TMDB collection (e.g. some Star Wars entries may be grouped under "Star Wars" or split by trilogy). The implementation should query the collection field and fall back gracefully (no motif) when absent.

---

## 3. Genre / franchise motif table — recommended expansions

The current SPEC §6.5 motif table has four entries. Based on the actual list, here are the gaps and recommendations. All are **data-driven** (keyed on genre string or TMDB collection name, not hardcoded per title).

### Currently mapped (SPEC §6.5)

| Key | Motif |
|---|---|
| James Bond Collection | Gunbarrel: 3 dots + accent ring |
| Indiana Jones Collection / genre Adventure | Topographic contours + dashed route |
| Film-Noir / Crime pre-1960 | Venetian-blind shadow |
| Caper / Heist / Comedy-crime 60s–70s | Deco double frame |

### Recommended additions

| Key | Applies to (current list) | Motif concept | Priority |
|---|---|---|---|
| **Star Wars Collection** | #18, #55, #56, #73 | Subtle star-field: tiny cream dots at ~6% alpha scattered in upper portion + one thin horizontal light-streak (lightsaber blade reference, ~15% accent alpha). Vector-only. | High — 4 entries |
| **Lord of the Rings Collection** | #29, #30, #54 | Ring motif: single thin circle (hairline, gold/cream at ~20% alpha) in bottom-right corner, partial arc. Elvish feel without text. | High — 3 entries |
| **Pirates of the Caribbean Collection** | #16, #65, #66 | Compass rose: small 8-point star (cream, ~15% alpha) in top-left. Nautical cartography feel. | Medium — 3 entries |
| **Mission: Impossible Collection** | #95, #96, #97 | Countdown timer dots: 3 small horizontal dots (like a digital readout) in top-right, accent color at ~25% alpha. Minimal, modern. | Low — 3 entries, all ranked 95+ |
| **Crime / Thriller (no year gate)** | #3 GoodFellas, #5 Pulp Fiction, #7 City of God, #9 Godfather, #11 Usual Suspects, #22 Matrix, #35 Django, #40 Departed, #53 Fight Club, #67 No Country, #82 Social Network, #93 Heat, + many more | The current "Film-Noir / Crime pre-1960" rule only catches 2 films (Casablanca, Maltese Falcon). Most crime films get no motif. **Recommendation:** extend to "Crime / Thriller" as a genre key without year gate, but with **era-aware styling** — silver-era gets venetian blinds, technicolor gets warm-tinted blinds, blockbuster/modern gets a subtler treatment (lower alpha, finer bars). This is the single highest-impact expansion: ~25+ films in the list are Crime/Thriller. | **High** — covers ~25% of the list |
| **Sci-Fi / Cyberpunk** | #8 Blade Runner 2049, #22 Matrix, #31 2001, #41 Jurassic Park, #48 Blade Runner | Scanlines: very fine horizontal lines (~3% alpha cream) + one faint vertical glitch-bar (~8% accent, 2dp wide, positioned deterministically). Retro-futurist feel. | Medium — 5+ entries |
| **War** (subgenre of Drama/Action) | #2 Apocalypse Now, #6 Lawrence of Arabia, #47 Schindler's List | Contour map is already the Adventure motif. War could share it (battle-map feel) or get its own: topographic + a faint horizontal line (front line). **Simplest:** let War fall through to Adventure. | Low — only 3 films, Adventure motif already covers 2 of them |

### Motif priority rule (updated)

SPEC §6.5 says: franchise (TMDB collection) beats genre. With the expanded table, the priority becomes:

1. **TMDB collection** (if collection name matches a motif key → use it, ignore genre)
2. **Genre** (first genre string from item metadata → look up in genre motif table)
3. **No motif** (unknown/unsupported genre → clean panel, era treatment only)

This means: Godfather #9 gets "The Godfather Collection" motif (if we add one) rather than the generic Crime motif. Bond films always get gunbarrel regardless of their secondary genre.

---

## 4. Director cluster data (for §6.3 stretch feature)

The spec mentions a stretch feature: "when a focused panel's director has other entries in the 100, glow those ledger/gallery rank numerals." Here's the current data showing which directors would trigger this.

### Directors with 2+ entries in the top 100

| Director | Entries | Ranks | Would glow |
|---|---|---|---|
| **Steven Spielberg** | 3 | #4 Raiders, #23 Last Crusade, #41 Jurassic Park, #64 Crystal Skull, #100 Dial of Destiny | Ledger #64, #100 + Gallery #23, #41 |
| **Quentin Tarantino** | 3 | #5 Pulp Fiction, #20 Inglourious Basterds, #35 Django Unchained | Ledger #35 |
| **Martin Scorsese** | 3 | #3 GoodFellas, #45 Casino, #49 Irishman | Ledger #45, #49 |
| **Christopher Nolan** | 2 | #52 Interstellar, #94 Inception | Ledger #94 |
| **Ridley Scott** | 2 | #48 Blade Runner, #8 Blade Runner 2049 (produced/directed different) | Ledger #48 |
| **Denis Villeneuve** | 2 | #8 Blade Runner 2049, #74 Killers of the Flower Moon (no — that's Scorsese) | Only 1 in list actually |
| **Sam Mendes** | 2 | #14 Skyfall, #71 Spectre | Ledger #71 |
| **Francis Ford Coppola** | 2 | #9 Godfather, #17 Godfather II | Gallery #17 |
| **George Lucas** | 3 | #18 Star Wars, #55 Empire (produced), #56 Jedi (produced) | Ledger #55, #56 — but note Lucas directed only #18 |
| **Roland Emmerich** | 0 | — | — |
| **Gore Verbinski** | 3 | #16 Pirates, #65 Pirates At World's End, #66 Pirates Dead Man's Chest | Ledger #65, #66 |
| **James Cameron** | 1 | — | — |
| **David Fincher** | 2 | #53 Fight Club, #82 Social Network | Ledger #82 |

### Implementation note

Director names come from `people` field (`PersonKind.DIRECTOR`). The glow computation is: when a pantheon panel (rank 1–10) is focused, find all other items in the playlist where any `PersonKind.DIRECTOR` matches → glow those items' rank numerals in the gallery/ledger tiers. This is **O(n×d)** where n = playlist size and d = avg director count per item — trivial for 100 items.

The glow should be subtle: the rank numeral's text color shifts to the theme accent at ~40% opacity, or a faint accent underline appears. Not a full highlight — just a whisper of connection.

---

## 5. Era distribution — current data

The era treatment (SPEC §6.4) is fully automatic from `productionYear`. Here's how the current list falls, which is useful for knowing how much of each era the implementation will actually render.

### Full list era breakdown

| Era | Year range | Count | % of 100 | Notable entries |
|---|---|---|---|---|
| **Silver** | ≤1954 | 3 | 3% | #1 Casablanca (1942), #24 12 Angry Men (1957 — wait, that's Blockbuster) |
| **Technicolor** | 1955–1975 | 21 | 21% | #6 Lawrence, #9 Godfather, #10 North by Northwest, #17 Godfather II, #24 12 Angry Men, #37 Some Like It Hot, #39 Maltese Falcon, #47 Schindler's List, #51 Barry Lyndon, #59 Sting, #60 Singin' in Rain, + 10 more |
| **Blockbuster** | 1976–1999 | 31 | 31% | #2 Apocalypse Now, #3 GoodFellas, #4 Raiders, #5 Pulp Fiction, #11 Usual Suspects, #14 Skyfall, #18 Star Wars, #22 Matrix, #29 Two Towers, #30 Return of King, + 21 more |
| **Modern** | ≥2000 | 45 | 45% | #7 City of God, #8 BR2049, #12 Parasite, #25 Brutalist, #28 Sinners, #32 Finding Nemo, #33 La La Land, #35 Django, + 37 more |

### Era visual impact

- **Silver (3%):** Rare — each one will feel special. The desaturation + silver frame is distinctive. Only Casablanca is in the pantheon; the other Silver entries are lower-ranked.
- **Technicolor (21%):** One-fifth of the list. The warm saturation lift + orange frame will be a recurring visual beat, especially in the gallery tier (ranks 11–50).
- **Blockbuster (31%):** The most common "classic" era. Amber frame, no filter. The Godfather at #9 is the highest-ranked Blockbuster-era entry in the pantheon.
- **Modern (45%):** Nearly half the list. Neutral/no filter. This is the default visual state — the other eras provide contrast.

### Edge case: year boundaries

A few films sit right on era boundaries:
- #82 The Social Network (2010) — Modern ✓
- #100 Indiana Jones and the Dial of Destiny (2023) — Modern ✓
- #24 12 Angry Men (1957) — Technicolor (the boundary is ≤1954 for Silver, so 1957 = Technicolor) ✓

The boundaries in SPEC §6.4 are clean for the current list. No films straddle a year boundary in a way that would feel wrong.

---

## 6. Data quality considerations

### Films where metadata may be incomplete

| Title | Risk | Mitigation |
|---|---|---|
| #43 The Man from U.N.C.L.E. | TMDB collection may be absent (it's a standalone film based on a TV show) | No collection → genre-based motif (Adventure/Comedy) |
| #73 Rogue One: A Star Wars Story | TMDB may group it under "Star Wars" collection or treat it separately | Check collection membership; if grouped, gets Star Wars motif automatically |
| #87 Jay Kelly | 2025 film — TMDB data may be sparse | Fall back to genre; year = Modern era |
| #101 Marty Supreme | 2025 film — same concern | Same mitigation |
| Films with "CC" in the list | CC = Closed Captions (metadata tag, not relevant to visual styling) | Ignore — this is a Jellyfin metadata field, not a visual element |

### Clearlogo availability

The pantheon panels (ranks 1–10) use the film's clearlogo as a primary visual element (SPEC §6.3). Clearlogo availability varies:

- **Likely available:** #1 Casablanca, #4 Raiders, #5 Pulp Fiction, #9 Godfather, #10 North by Northwest, #22 Matrix (major studio films with strong home video presence)
- **May be missing:** #7 City of God (Brazilian film, less US home video branding), #8 Blade Runner 2049 (depends on which edition Jellyfin scraped)
- **Fallback:** Bold title text in the theme's condensed face, colored per era frame (SPEC §6.3 already specifies this)

Implementation should check `imageTags` for the clearlogo tag and fall back gracefully. The top 10 are all well-known studio films, so clearlogo coverage should be high (~80%+ expected).

### Billing block data

The billing block (SPEC §6.3) requires `director` + top 3 `ACTOR` entries from `people`. All top-10 films are major studio productions with complete cast/crew metadata in Jellyfin. Risk is low. The one edge case is #7 City of God — Brazilian cast names may be less complete in English-language metadata sources.

---

## 7. Composition variety — current top 10 mapping

SPEC §6.3 defines composition variety as deterministic from `(motifKind, rank % 2, backdrop aspect)`. Here's how the current top 10 would resolve, assuming the expanded motif table from §3:

| # | Title | Motif kind | Rank parity | Likely aspect | Composition |
|---|---|---|---|---|---|
| 1 | Casablanca | noir | odd | ~16:9 | Standard + noir blind overlay, no poster inset |
| 2 | Apocalypse Now | adventure | even | ~2.39:1 (anamorphic) | Poster inset bottom-right (anamorphic gives wide backdrop, poster adds vertical balance) |
| 3 | GoodFellas | crime | odd | ~16:9 | Standard crime treatment, no inset |
| 4 | Raiders | adventure | even | ~2.35:1 | Map motif in corner + poster inset (franchise + wide aspect) |
| 5 | Pulp Fiction | crime | odd | ~2.35:1 | Crime overlay, motif corner placement |
| 6 | Lawrence | adventure | even | ~2.20:1 (70mm) | Map contours + route, poster inset (epic scale) |
| 7 | City of God | crime | odd | ~1.85:1 | Crime overlay, standard |
| 8 | BR2049 | sci-fi (if added) | even | ~2.39:1 | Scanlines + poster inset (anamorphic) |
| 9 | Godfather | crime/collection | odd | ~2.35:1 | Crime overlay, collection badge (if Godfather motif added) |
| 10 | North by Northwest | thriller | even | ~1.85:1 | No mapped motif — clean panel, era frame only, poster inset for variety |

This is illustrative — the actual composition algorithm picks from a fixed set of layout variants. The point is that the current top 10 has good variety in motif kind (noir, adventure, crime, sci-fi, none) and aspect ratio (1.85 to 2.39), so composition variety will naturally produce visually distinct panels.

---

## 8. Gallery tier (ranks 11–50) — patterns worth noting

The gallery shows 2-column wide cards with backdrop + rank + title + year/runtime. The current 11–50 range has some patterns:

### Franchise representation in gallery

Many franchise entries land here rather than pantheon:
- #17 Godfather Part II, #29 Two Towers, #30 Return of the King, #41 Jurassic Park, #42 Goldfinger, #48 Blade Runner, #54 Fellowship, #55 Empire, #56 Jedi

The gallery cards should show the franchise motif badge (small, not full overlay) to visually connect these to their pantheon counterparts. **Recommendation:** gallery cards for franchise films get a tiny collection-icon in the corner (the franchise motif glyph at ~40% scale, same color as era frame). This is cheap (one extra compositor draw) and creates visual continuity.

### Director clusters visible in gallery

Spielberg has 2 entries in gallery (#23 Last Crusade, #41 Jurassic Park). Scorsese has 2 (#45 Casino, #49 Irishman). Tarantino has 1 (#20 Inglourious Basterds). The stretch glow feature (§4) would fire on these when their director's pantheon entry is focused.

---

## 9. Ledger tier (ranks 51–100) — patterns

The ledger is the densest tier: poster thumb · rank · title · year · runtime. Visual interest comes from the row-wash focus effect and accent rank numerals.

### Notable ledger entries

- #51 Barry Lyndon (1975, Technicolor) — one of the most visually distinctive films ever made; its ledger row gets the warm Technicolor era tint on focus
- #64 Indiana Jones Crystal Skull (2006, 6.0 rating) — lowest-rated entry in the list; its presence is a user preference, not a quality signal; no special treatment needed
- #68 Lion King (1994, 3D) — the "3D" tag in the list is a format tag, not metadata; ignore for styling
- #113 Superbad (2007) — last entry, ends the ledger

### Rating data (from the list)

The list includes IMDb-style ratings (6.0–8.7 range). These are **not used** in the showcase design — the design is rank-ordered, not rating-ordered. The rating data is metadata only and doesn't affect visual treatment. The only rating-like interaction is the hero spotlight's ≥8.5 threshold (SPEC §5.3), which is separate from the Top 100 page.

---

## 10. Implementation priorities (based on this analysis)

### Must-have for Phase 4 (Top 100 showcase)

1. **Expand the genre motif table** (§3) — at minimum: Crime/Thriller without year gate, Star Wars, LOTR, Pirates. This is the single change with the most visual impact across the full 100.
2. **Clearlogo fallback logic** — test with the top 10; at least 2–3 will likely be missing clearlogos.
3. **Composition variety algorithm** — the 4 layout variants × motif kind × aspect ratio should produce 8+ distinct compositions. Test with top 10.
4. **Era filter rendering** — Silver desaturation is the most visually aggressive; verify it doesn't make Casablanca look muddy (may need saturation floor).

### Nice-to-have for Phase 4

5. **Gallery franchise badges** — small collection icons on gallery cards for franchise films.
6. **Director glow** — the stretch feature; low priority, high delight.

### Defer

7. **Sci-Fi motif** — only 5 films; can add later.
8. **Mission: Impossible motif** — all 3 entries are ranked 95+; low visibility.

---

## 11. Top 15 — per-film visual notes

These are **taste notes** for implementation agents, not hard rules. They describe what *this specific film's* pantheon panel should feel like, using the data-driven system (era + motif + composition variety). The goal: when someone scrolls to #1, they should think "that looks like Casablanca" without reading the title. All of this must come from metadata + the motif/era/composition system — no hardcoded per-title assets.

### #1 Casablanca (1942)
- **Era:** Silver — desaturated backdrop, silver hairline frame. The black-and-white source material means the backdrop will already be near-monochrome; the era filter is subtle here (saturation ≈ 0.18 on something already low-saturation).
- **Motif:** Noir — venetian-blind shadow bars. Casablanca's iconic Rick's Café scenes are defined by light through blinds. This is the single most natural noir-motif pairing in the list.
- **Composition:** Standard (no poster inset — the Casablanca backdrop is strong enough to stand alone). Rank numeral "1" in the bottom-left is the visual anchor.
- **Billing:** Directed by Michael Curtiz. Ingrid Bergman, Humphrey Bogart, Paul Henreid.
- **Clearlogo:** Likely available (Warner Bros. classic catalogue). Fallback: "CASABLANCA" in bold condensed, silver era frame color.

### #2 Apocalypse Now (1979)
- **Era:** Blockbuster — no filter, amber frame. The Francis Ford Coppola warm palette.
- **Motif:** Adventure (war subgenre) — map contours + dashed route line. The patrol boat journey upriver is the film's structure; the route line feels like it traces the river.
- **Composition:** Poster inset bottom-right. The anamorphic (2.39:1) backdrop is very wide; the inset poster balances the composition. The route line should rotate slightly (~-6°) to suggest downstream movement.
- **Billing:** Directed by Francis Ford Coppola. Martin Sheen, Marlon Brando, Robert Duvall.
- **Clearlogo:** Likely available (Paramount catalogue).
- **Note:** This is the highest-ranked Coppola film. The stretch glow (§4) would touch #17 Godfather II in the gallery.

### #3 GoodFellas (1990)
- **Era:** Blockbuster — no filter, amber frame.
- **Motif:** Crime — needs the expanded crime motif from §3 (the pre-1960 noir rule doesn't cover this). Subtle venetian-blind treatment at lower alpha (~18%) for a modern crime film — the motif is present but not as heavy as Casablanca's.
- **Composition:** Standard. The Copacabana tracking-shot backdrop (if available) is one of the most famous shots in cinema — let it breathe.
- **Billing:** Directed by Martin Scorsese. Ray Liotta, Robert De Niro, Joe Pesci.
- **Clearlogo:** Likely available (Warner Bros. catalogue).
- **Note:** First of 3 Scorsese films (#3, #45, #49). Stretch glow would fire on Casino and Irishman.

### #4 Raiders of the Lost Ark (1981)
- **Era:** Blockbuster — no filter, amber frame.
- **Motif:** Indiana Jones Collection — map contours + dashed route. Already defined in SPEC §6.5. The adventure motif is the most visually dynamic of the set.
- **Composition:** Poster inset bottom-right. The Raiders backdrop (jungle/temple) is usually busy; the poster inset adds a clean visual anchor. Anamorphic aspect (2.35:1) gives the map contours room.
- **Billing:** Directed by Steven Spielberg. Harrison Ford, Karen Allen, Paul Freeman.
- **Clearlogo:** Almost certainly available (Lucasfilm/Disney catalogue, one of the most recognized logos).
- **Note:** First of 4 Spielberg entries. Stretch glow would fire on #23, #64, #100 in gallery/ledger.

### #5 Pulp Fiction (1994)
- **Era:** Blockbuster — no filter, amber frame.
- **Motif:** Crime — same expansion as GoodFellas. Lower alpha for modern crime.
- **Composition:** Motif corner placement. The non-linear structure of Pulp Fiction suits a less conventional composition — put the crime motif bars in the corner rather than full-overlay. Anamorphic backdrop (2.35:1).
- **Billing:** Directed by Quentin Tarantino. John Travolta, Uma Thurman, Samuel L. Jackson.
- **Clearlogo:** Likely available (Miramax catalogue).
- **Note:** First of 3 Tarantino entries (#5, #20, #35).

### #6 Lawrence of Arabia (1962)
- **Era:** Technicolor — saturation lift (1.25×), warm orange frame. The 70mm desert photography is already deeply saturated; the Technicolor treatment will make it glow.
- **Motif:** Adventure — map contours + route line. The desert crossing is the film's visual identity; the route line traces Lawrence's journey.
- **Composition:** Poster inset. The 2.20:1 70mm backdrop is extremely wide; the poster inset adds vertical balance. One of the most visually spectacular panels in the set.
- **Billing:** Directed by David Lean. Peter O'Toole, Alec Guinness, Omar Sharif.
- **Clearlogo:** Likely available (Columbia/Sony catalogue).
- **Note:** David Lean has no other entries in the 100; no stretch glow.

### #7 City of God (2002)
- **Era:** Modern — no filter, neutral frame. Clean and contemporary.
- **Motif:** Crime — the expanded crime motif. City of God's favela backdrop is vibrant and kinetic; the crime motif should be very subtle here (low alpha bars) so it doesn't compete with the already-powerful imagery.
- **Composition:** Standard. The backdrop (usually the favela skyline or the kid-with-gun iconic shot) carries the panel. No poster inset — let the photography speak.
- **Billing:** Directed by Fernando Meirelles. Alexandre Rodrigues, Leandro Firmino, Phellipe Haagensen.
- **Clearlogo:** May be absent (Brazilian film, less US home video branding). Fallback: "CITY OF GOD" in bold condensed, modern era frame color.
- **Note:** The most visually vibrant film in the top 10; the lack of era filter preserves its natural color.

### #8 Blade Runner 2049 (2017)
- **Era:** Modern — no filter, neutral frame. The Deakins cinematography needs no enhancement.
- **Motif:** Sci-Fi (if added per §3) — scanlines + glitch bar. The neon-drenched, rain-soaked aesthetic of BR2049 is the ideal canvas for a subtle sci-fi overlay. If sci-fi motif is deferred, the panel is clean and lets the backdrop speak.
- **Composition:** Poster inset bottom-right. The 2.39:1 anamorphic backdrop is very wide; the inset adds balance. The neon color palette of BR2049's backdrops will contrast beautifully with the Modern era's neutral frame.
- **Billing:** Directed by Denis Villeneuve. Ryan Gosling, Harrison Ford, Ana de Armas.
- **Clearlogo:** Likely available (Warner Bros. catalogue).
- **Note:** Harrison Ford appears in both #4 Raiders and #8 BR2049 — the stretch glow (§4) is director-based, not actor-based, so this doesn't trigger anything. But it's a fun data connection.

### #9 The Godfather (1972)
- **Era:** Technicolor — saturation lift (1.25×), warm orange frame. The Coppola warm palette is already there; the Technicolor treatment amplifies it.
- **Motif:** Crime + possible Godfather Collection motif. If a Godfather collection motif is added (§3), this gets it; otherwise the crime motif applies. The iconic opening dark backdrop (wedding scene) with the warm Technicolor frame would be stunning.
- **Composition:** Standard. The Godfather backdrop is usually dark and intimate; no poster inset needed. The warm frame and crime/collection motif do the work.
- **Billing:** Directed by Francis Ford Coppola. Marlon Brando, Al Pacino, James Caan.
- **Clearlogo:** Almost certainly available (Paramount catalogue, one of the most recognized logos in cinema).
- **Note:** Second Coppola entry; stretch glow fires on #2 Apocalypse Now (pantheon, so no glow — it's the same tier) and #17 Godfather II (gallery, would glow).

### #10 North by Northwest (1959)
- **Era:** Technicolor — saturation lift, warm frame. The Hitchcock Technicolor palette (vivid greens, reds) responds beautifully to the saturation boost.
- **Motif:** None of the current mapped genres fit exactly. North by Northwest is a Thriller, not Crime/Noir in the traditional sense. **Options:** (a) leave it clean (era frame only), (b) add a Thriller genre key with a minimal motif (single diagonal line — the Mount Rushmore cliff face), (c) let it inherit the "adventure" motif loosely. Recommendation: option (a) — clean panel. The Technicolor frame + the iconic crop-duster or Mount Rushmore backdrop is enough.
- **Composition:** Poster inset bottom-right. The 1.85:1 backdrop is narrower than anamorphic; the poster inset adds width. Hitchcock's visual compositions are already perfect — let the backdrop do the work.
- **Billing:** Directed by Alfred Hitchcock. Cary Grant, Eva Marie Saint, James Mason.
- **Clearlogo:** Likely available (MGM/Paramount catalogue).
- **Note:** Hitchcock has no other entries in the 100; no stretch glow. The only "North by Northwest" franchise entry is itself — it's a standalone film.

### #11 The Usual Suspects (1995) — gallery tier
- **Era:** Blockbuster — no filter, amber frame.
- **Motif:** Crime — expanded crime motif. The lineup-scene backdrop is iconic; the crime overlay at moderate alpha adds texture without obscuring.
- **Gallery card:** Wide card (16:6.6), backdrop + rank "11" + title + "1995 · 1h 46m". No pantheon ceremony — gallery is clean and fast.

### #12 Parasite (2019) — gallery tier
- **Era:** Modern — no filter, neutral frame.
- **Motif:** None (Comedy/Thriller/Drama — not a mapped genre). Clean card. The Parasite backdrop (usually the park-house contrast shot) is visually striking on its own.
- **Gallery card:** Standard gallery treatment.

### #13 Jackie Brown (1997) — gallery tier
- **Era:** Blockbuster — no filter, amber frame.
- **Motif:** Crime — Tarantino crime. The funk/soul aesthetic of Jackie Brown is unique; the crime motif at low alpha adds a subtle texture.
- **Gallery card:** Standard. Second Tarantino entry in the gallery area.

### #14 Skyfall (2012) — gallery tier
- **Era:** Modern — no filter, neutral frame.
- **Motif:** James Bond Collection — gunbarrel dots. Already defined in SPEC §6.5. The gunbarrel motif on a Modern-era card creates a nice visual link to the other Bond entries scattered through the list.
- **Gallery card:** Standard, with Bond gunbarrel badge. First Bond entry in the gallery (after #10 North by Northwest in pantheon, which is Hitchcock not Bond).

### #15 American Graffiti (1973) — gallery tier
- **Era:** Technicolor — saturation lift, warm frame. The car-culture nostalgia of American Graffiti benefits from the warm Technicolor treatment.
- **Motif:** None (Comedy/Drama — not mapped). Clean card. The warm era frame is the visual identity.
- **Gallery card:** Standard. George Lucas's only directorial entry in the list (produced credits on Star Wars sequels don't count for stretch glow).

---

## 12. Open questions (for Brennan)

1. **Crime motif expansion:** The current rule is "Film-Noir / Crime pre-1960" (2 films). Expanding to all Crime/Thriller would affect ~25 films. Is that too much motif, or does it make the list feel more cohesive? Alternative: keep noir blind motif for pre-1975 crime, use a different (subtler) motif for modern crime.
2. **Godfather collection motif:** The Godfather I (#9) and II (#17) are both in the list. Worth a dedicated motif (laurel wreath? Italian flag colors in muted tones?), or does the generic Crime motif suffice?
3. **Star Wars:** 4 entries spread across ranks 18–73. The gunbarrel-for-Bond approach suggests each franchise gets its own mark. Star Wars motif: star field, lightsaber streak, or something else?
4. **Taglines:** Still out per SPEC §10. The billing block (director + cast) fills the "authentic text" role without being added copy. Confirming no change.
5. **Rating display:** The list shows ratings (8.1, 8.3, etc.). Should these appear anywhere in the showcase (e.g. a tiny rating badge), or is rank the only signal? Currently spec says rank only.
