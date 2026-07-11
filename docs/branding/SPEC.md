# Movie Night — Branding Implementation Spec (v5, 2026-07-10)

This is the complete, self-contained specification for rebranding the "Movie Night" Android TV app and the Jellyfin web client. It assumes **no access to prior conversation** — everything an implementation agent needs is in this file, the visual prototype (`brand-studies.html`, open in any browser, fully offline), the font (`PalmCanyonDrive.otf`), and the decision log (`../../DESIGN-BRANDING.md`).

---

## 0. Context & environment

| Thing | Value |
|---|---|
| TV app repo | `~/jellyfin-androidtv` — fork of jellyfin/jellyfin-androidtv **v0.19.9**, branch `collections` |
| App name | "Movie Night" (already set via `resValue` in `app/build.gradle.kts`) |
| Deploy target | Amazon Fire TV Stick — **old, slow hardware**: home page takes ~5 s to settle. Every design decision is perf-gated. Sideload via adb. |
| Server | Jellyfin on a NUC (`haleiwa-movies`), movie-server repo (this repo) is IaC for it (`jellyfin.sh` provisions) |
| Web client | Stock Jellyfin web + **JavaScript Injector plugin** (already in use for playlist flair) + Dashboard → Branding Custom CSS |
| Curated playlists | Native Jellyfin playlists "Top 100" (ranked) and "Watchlist" (unranked), created by `jellyfin.sh`, surfaced in the fork via `CuratedListsRepository` — see `DESIGN-PLAYLISTS.md` |
| Font asset | `PalmCanyonDrive.otf` (in this directory) — 1950s retro script, **display-only**, commercial license (Mika Melvas/Fenotype) |

### Hard invariants (violating any of these is a failed implementation)

1. **No invented text.** No taglines, no slogans, no flavor copy anywhere ("tonight's feature presentation" style filler is explicitly banned as AI slop). The only brand text is "Movie Night". All other text on screen must come from real item metadata (title, year, runtime, genre, people, collection name).
2. **Content surfaces untouched.** Poster cards, wide thumbnails with clearlogo overlays, home row structure/format: do not restyle. Only fonts (theme UI face) and the rank-pill chrome change. The home page rows are the gold-standard browsing experience.
3. **Live artwork backgrounds are sacred.** While browsing, the focused item's backdrop fills the screen (`AppBackground.kt`: blur 10dp + dim). Themes may only *hue-bias* the dim color at the **same alpha as stock** (`#94101010`) — never darker. Flat theme grounds are fallbacks only.
4. **Keep `applicationId` = `org.jellyfin.androidtv`** (changing it = reinstall + data loss on the Fire Stick).
5. **Do not embed `PalmCanyonDrive.otf` in the APK.** Wordmarks are pre-outlined vectors (see §4). The OFL UI fonts (§3) may be embedded freely.
6. **Screensaver structure untouched** (`integration/dream/` — server art + clock). It reuses `app_logo`, so it inherits themed wordmarks automatically; that is the only change it gets.
7. **Perf-gate everything.** Any animation is a single view, alpha/translate only, ≤600 ms, never delays startup or scrolling. If it costs frames on the stick, cut it.

---

## 1. Architecture: four themes, roulette per launch

Four complete themes ship. **One is picked at random on every app launch** and held for the process lifetime.

| | **Canyon** ★anchor | **Matinee** | **Reel One** | **Marquee** |
|---|---|---|---|---|
| Mood | 50s Palm Springs drive-in, neon | 40s pulp-adventure poster | Saul Bass / Bond gunbarrel, 60s | Old-Hollywood art deco |
| Ground | `#0E2A30` teal night (gradient to `#123039`) | `#191009` leather (radial from `#241509`) | `#0B0B0B` flat black | `#0E0B06` house black (radial from `#171208`) |
| Accent | `#47C4B8` turquoise | `#D98E32` amber | `#E8442E` vermilion | `#C9A227` antique gold |
| Support (rare) | `#F26D3D` sunset orange — starburst ✶ + badges only | `#A62B1F` serial red — litho offset-shadow + alerts only | `#C9A227` brass — near-unused | `#7A1E1E` velvet red — alerts only |
| Text | `#F5EEDC` cream | `#E8D5B0` aged paper | `#F2EFE6` paper white | `#F2E6CB` cream |
| Muted | `#7FA8A4` sage | `#9C7C53` khaki | `#8D8A80` warm grey | `#9A8C6E` brass grey |
| Text-on-accent | `#0C2429` | `#1C120A` | `#FFFFFF` | `#1A1406` |
| UI font (OFL, Google Fonts) | **Josefin Sans** | **Oswald** | **Archivo** | **Jost** |
| Corner rounding | 8dp cards, pill (999) buttons | 2–3dp, boxy | 0dp everywhere | 3dp |
| Header case | Sentence case, weight 650 | UPPERCASE condensed, tracked .1em | lowercase bold, tight | UPPERCASE, wide-tracked .28em, weight 500 |
| Ornament | ✶ starburst (orange) | ▸ tick (red) / thin red rule | ■ vermilion square | ◆ gold diamond |
| Focus ring | accent + soft glow (`0 0 ~24px rgba(71,196,184,.5)`) | accent, 2dp feel, no glow | thick square, no glow | hairline |
| Wordmark treatment | cream script + turquoise neon halo | condensed caps amber + red offset-shadow (`~3px 3px 0 #A62B1F`); **script font unused in this theme** | script white over off-center vermilion disc | script with gold-leaf vertical gradient (`#E8C96A→#C9A227→#8F6F14`) between hairline rules + ◆ ornaments |
| Backdrop dim (`background_filter`) | `#99091D22` (teal-biased) | `#99160D06` (leather-biased) | `#940B0B0B` (neutral — stock-equivalent) | `#9E0D0A05` (warm) |

Rule of accent scarcity: the accent appears in exactly these places — focus ring, primary/active button, ornament, rank-pill stroke, progress bars. Everything else is text color on ground. Support color is rarer still (see table).

**Exact wordmark/component renderings: open `brand-studies.html` and page through tabs 1–4.** It renders the real font; treat it as the visual source of truth. Tab 5 = Top 100 showcase page, tab 6 = web.

### 1.1 Roulette mechanics

- Current plumbing: enum `preference/constant/AppTheme.kt` → mapped to style in `util/ActivityThemeExtensions.kt` (applied at activity creation) → picker UI in `ui/preference/screen/CustomizationPreferencesScreen.kt`, pref key `app_theme` in `UserPreferences.kt`.
- Replace the three stock themes (`theme_jellyfin.xml` base + `theme_emerald.xml` + `theme_mutedpurple.xml`) with a shared `Theme.MovieNight` base + four children: `theme_movienight_canyon.xml`, `_matinee.xml`, `_reelone.xml`, `_marquee.xml`. Delete `moviebg.jpg` (only Emerald used it).
- `AppTheme` enum becomes: `ROULETTE` (default) + the four named themes ("pin" options). Preference picker shows all five.
- Roulette pick: a process-lifetime singleton (e.g. `object ThemeRoulette { val choice = AppTheme.pinnedOrNull ?: listOf(CANYON, MATINEE, REELONE, MARQUEE).random() }`) resolved once per process, consumed by `applyTheme()` for every activity. New launch → new draw; all activities in one process agree. All four stay in the roster.
- **Everything per-theme rides theme attributes** so the roulette is free elsewhere. New attrs (add to `values/attrs.xml`):
  - `brandWordmark` (drawable) — per-theme wordmark; **replaces every `R.drawable.app_logo` reference** (`SplashFragment.kt` L37, `ui/shared/toolbar/Toolbar.kt` Logo() L29, `integration/dream/composable/DreamContentLogo.kt` L25, `layout/view_row_details.xml` L209 uses app_banner, `view_card_legacy_image.xml` L40).
  - `brandFontFamily` (font) — theme UI face.
  - `backdropDimColor` (color) — consumed by `AppBackground.kt` instead of `R.color.background_filter` (one-line change: `colorResource(...)` → theme attr lookup).
  - `curatedPillBackground` (drawable) — rank-pill background per theme (§5.4).
  - Existing attrs reused: `defaultBackground`, `buttonDefaultNormalBackground`, `buttonDefaultHighlightBackground`, `colorAccent`, `defaultSearchColor`, `cardRounding`, `buttonRounding`, tile `tile_*_bg` attrs (recolor to theme ground-tints; do **not** redraw the ~26 `tile_*.xml` vectors).
- Compose side: `ui/base/JellyfinTheme` must expose the same tokens (accent, ground, fonts, dim) so Compose components (splash, toolbar, hero, showcase) match the XML theme. Read the active `AppTheme` from the roulette singleton.
- Replace `jellyfin_blue`/`jellyfin_purple` usages in `values/colors.xml` and any hardcoded references (search the tree; progress bars and search orb use them).

---

## 2. Static (non-rotating) surfaces — always Canyon

The launcher can't rotate. These wear Canyon permanently:

### 2.1 Launcher icon (`mipmap-*/app_icon.png` + adaptive `mipmap-anydpi-v26/app_icon.xml`)
- Design: **script "MN" monogram** (the two capitals outlined from PalmCanyonDrive), cream `#F5EEDC` with a subtle turquoise outer glow, on teal `#0E2A30`. **Large, minimal margin** — near edge-to-edge within the adaptive-icon safe zone (66dp of 108dp viewport); user explicitly wants big glyphs, tight padding.
- Deliverables: adaptive layers `drawable/app_icon_background.xml` (flat teal), `app_icon_foreground.xml` (MN vector), `app_icon_foreground_monochrome.xml` (MN, single color); raster PNGs at 80/120/160/240/320 px (mdpi→xxxhdpi).
- Legibility check at 80 px before shipping.

### 2.2 TV banner (`mipmap-*/app_banner.png` + `drawable/app_banner*.xml`)
- Design: full neon-script "Movie Night" wordmark (Canyon treatment) + small orange ✶, on teal. 16:9 rasters at 160×90 / 240×135 / 320×180 / 480×270 / 640×360. Vector layers `app_banner_background.xml` / `app_banner_foreground.xml`.
- **The 160×90 render is the acceptance test** — the Fire TV home screen shows roughly this size.

### 2.3 Web client — entirely Canyon (§7).

---

## 3. Typography

- **PalmCanyonDrive** (script): wordmarks and pantheon rank numerals **only**, always as pre-outlined vectors or (web) via `@font-face` in CSS where licensing is our own server serving our own family (acceptable exposure; do NOT bundle in APK).
- **UI faces** (download from Google Fonts, OFL; commit the .ttf files): Josefin Sans (Canyon), Oswald (Matinee), Archivo (Reel One), Jost (Marquee). Place in `app/src/main/res/font/` as e.g. `josefin_sans.ttf`, `josefin_sans_bold.ttf` (regular + bold weights each). Wire per theme via `brandFontFamily` + `android:fontFamily` in `values/styles.xml` text appearances, and via Compose typography.
- Where the UI face applies: row headers, card titles/runtime under posters, buttons, toolbar nav, menus, settings, dialogs — everything that is currently Roboto. Body/metadata text stays regular weight; headers per the case/tracking table in §1.
- If APK size balloons, subset fonts to Latin.

## 4. Wordmark & vector asset production (anti-AI-slop pipeline)

Nothing raster-generated, nothing painterly. All chrome assets are **real typography outlined to vectors + hand-authored geometry**:

1. Render text with the actual font → outline to SVG paths. Tooling (on this machine or any Linux box): `pip install fontTools` then use `fontTools.pens.svgPathPen` to dump glyph paths, or Inkscape: place text, `Path → Object to Path`, save plain SVG. Text needed: "Movie Night" (script, for Canyon/Reel One/Marquee marks), "MN" (icon monogram), "MOVIE NIGHT" (Oswald condensed caps, Matinee mark), "100" (script, playlist cover §6.6).
2. Compose per-theme wordmark SVGs adding geometry: Canyon = script + halo (halo via layered stroked copies at low alpha — vector, not blur filter, so it converts to VectorDrawable cleanly); Matinee = caps + red offset copy behind (dx=dy≈3dp); Reel One = script over off-center filled circle; Marquee = script with 3-stop vertical gradient + hairline rules + ◆.
3. Convert SVG → Android VectorDrawable (Android Studio Vector Asset importer or `vd-tool`). Target the existing `app_logo` geometry: **252×72 dp viewport** (splash shows it at width 400dp via `SplashFragment.kt`; toolbar ~95dp-high bar).
4. Four files `drawable/wordmark_canyon.xml` … `_marquee.xml`, referenced by the `brandWordmark` attr. Keep `drawable/app_logo.xml` as an alias to the Canyon wordmark for any unconverted reference.
5. Update `values/logo.xml` colors or retire it.

## 5. Component specs (TV app)

Visual reference for every one of these: `brand-studies.html` tabs 1–4.

### 5.1 Splash (`ui/startup/fragment/SplashFragment.kt`)
- Now: full-screen `not_quite_black` + `app_logo` at 400dp width, centered.
- Becomes: theme ground color (attr `defaultBackground`) + `brandWordmark` at 400dp. **No tagline text.**
- Optional motion (Phase 6, perf-gated): single beat ≤600 ms — Canyon: neon flicker-on (2 alpha dips then hold); Reel One: disc translates in from left then script fades over (~500 ms); Matinee: wordmark scales 1.03→1.00 with alpha ("stamp"); Marquee: hairline rules scaleX 0→1 from center. One animated view each; must not delay `StartupActivity` navigation.

### 5.2 Toolbar (`ui/shared/toolbar/Toolbar.kt`, `MainToolbar.kt`)
- Real structure (do not change structure): start = `Logo()` (wordmark, small); center = text buttons **Home / Search / Top 100 / Watchlist** (curated buttons appear when `CuratedListsRepository` resolves ids); end = settings icon + clock.
- Theming: buttons in `brandFontFamily` with the theme's header case/tracking; **active** button = accent fill + text-on-accent color in the theme's shape (Canyon glowing pill / Matinee amber slab / Reel One flat vermilion block / Marquee gold fill, tracked caps). Inactive = muted text, transparent. `activeButtonColors` in `MainToolbar.kt` currently carries this — point it at theme tokens.
- Clock: muted color, tabular numerals.

### 5.3 Hero spotlight (`ui/home/HomeSpotlight.kt`)
- Existing behavior (keep all of it): first home row, 320dp tall, scrolls away; picks item (resume <24h → next-up → newest-in-24h → random ≥8.5 rating); backdrop `ContentScale.Crop`; vertical scrim; clearlogo at 64dp height (fallback: bold white title 34sp); Play button.
- Changes (visual only): scrim colors from theme — top ≈ ground @ 34% alpha, bottom ≈ ground @ 92% (currently hardcoded `0x55000000`/`0xE6000000`); Play button styled as the theme primary button (shape/fill/glow per §1). **No text added.**

### 5.4 Cards & rank pill (`ui/presentation/CardPresenter.java`, `ui/card/LegacyImageCardView.java`, `layout/view_card_legacy_image.xml`)
- Card structure, sizes, overlays, watched indicators, runtime badge: **unchanged**. Card title/runtime text switches to `brandFontFamily`.
- Rank pill (`curated_rank` TextView + `drawable/curated_rank_pill.xml`): geometry unchanged (top-right, translucent black `@color/black_transparent` fill, 12sp bold white `#`+rank, condensed). Stroke + radius via `curatedPillBackground` per theme: Canyon 1dp `#47C4B8` + soft glow (layer-list with a translucent outer stroke), radius 5dp; Matinee 2dp `#D98E32`, radius 0; Reel One 1dp `#E8442E`, radius 0; Marquee 1dp `#C9A227`, radius 4dp, letterSpacing .1em. Same for the details-screen copy in `layout/view_row_details.xml` (~L218).
- Focus ring/glow on cards comes from the theme focus attrs (§1 table).

### 5.5 Backgrounds (`data/service/BackgroundService.kt`, `ui/background/AppBackground.kt`)
- Keep: backdrop selection, blur 10dp, half-res decode, crossfade, `BACKGROUND_LIMIT` memory guard.
- Change: tint color `R.color.background_filter` → theme attr `backdropDimColor` (§1 last row). Fallback `AppThemeBackground` already reads `defaultBackground` — set per theme (Canyon/Marquee may use their subtle gradients via drawable; flat color is fine too).

### 5.6 Row headers (home rows)
- Text in `brandFontFamily` + theme case/tracking; ornament glyph before curated rows ("Top 100", "Watchlist") only — ✶ / ▸ / ■ / ◆ colored per §1. Implemented in the row header presenter/style (`Widget.Jellyfin.Row.Header` in `values/styles.xml`). Don't ornament every row — curated rows only.

## 6. Top 100 showcase page (TV) — the flagship

**Replaces** `ItemListFragment` as the destination of the toolbar "Top 100"/"Watchlist" buttons (`MainToolbar.kt` currently navigates `Destinations.itemList(playlistId)` — add a new destination). New Compose screen (pattern reference: `HomeSpotlight.kt` + `AppBackground.kt` for image handling). Visual source of truth: **tab 5 of `brand-studies.html`**.

Design thesis: *descending ceremony*. The page opens directly on №1. **No header block** — no genre list, no total runtime, no item count. Play/Shuffle: toolbar row only.

### 6.1 Data
- Playlist items in playlist order = rank order, via existing `CuratedListsRepository` / playlist id + `itemsApi`. Fields per item: `name`, `productionYear`, `runTimeTicks`, `genres` (first = primary), `people` (director = first `PersonKind.DIRECTOR`; cast = first 3 `ACTOR` in billing order), TMDB collection name/id (from provider ids / `parentId` collection membership if populated — fall back gracefully), image tags.
- Images via `ImageHelper`: backdrop (pantheon/gallery), clearlogo, primary poster (ledger thumb, pantheon inset).

### 6.2 Tiers
| Ranks | Tier | Layout |
|---|---|---|
| 1–10 | **Pantheon** | Full-width panels, ~30% screen height each (~320dp class), one per row |
| 11–50 | **Gallery** | 2-column grid of wide cards (16:6.6 aspect), backdrop + rank numeral + title + `year · runtime` |
| 51–100 | **Ledger** | Dense rows: poster thumb (≈44dp wide) · rank (accent, tabular) · title · year · runtime; focus = accent-tinted row wash in theme dialect |
- Tier boundaries constant (10/50). If the playlist has fewer items, tiers truncate naturally (e.g. 30 items → 10 pantheon + 20 gallery, no ledger).

### 6.3 Pantheon panel anatomy (each = film's own assets, nothing invented)
- Backdrop fills panel (`Crop`), under: era treatment (§6.4) + genre/franchise motif (§6.5) + scrim (horizontal ground-tint gradient strong-left→weak-right, plus bottom fade; see prototype).
- **Rank numeral**: huge (≈120dp class), bottom-left, in the theme's display treatment — Canyon/Marquee/Reel One: PalmCanyonDrive outlines (pre-generate vector numerals 1–10 per §4 pipeline, or one font-outlined set tinted per theme); Canyon neon-glow turquoise, Marquee gold, Reel One paper-white on a vermilion disc, Matinee condensed amber with red offset.
- **Clearlogo** right of numeral (≈64–90dp tall, max ~420dp wide). Fallback when absent: film title in bold condensed caps, text color per era frame.
- **Billing block** under logo: "DIRECTED BY {director}" (small, tracked, muted) over "{Cast1} · {Cast2} · {Cast3}" — compressed poster-credit type: condensed face, uppercase, wide tracking, `scaleY ≈ 1.25`. Omit lines whose data is missing.
- **Meta line**: `{year} · {runtime} · {primary genre OR collection name}` — collection name wins when a franchise motif fired. Nothing else. Tabular numerals.
- **Composition variety** (deterministic, not random — stable across visits): vary by `(motifKind, rank % 2, backdrop aspect)` → choose among: standard; + poster inset bottom-right (≈90dp wide, shadowed, hairline outline); motif corner placement; logo scale step. No two adjacent panels identical.
- Whole panel is one focus target; click = Play (reuse `PlaybackHelper.retrieveAndPlay`). Focus ring per theme.
- **Stretch** (only if cheap): when a focused panel's director has other entries in the 100, glow those ledger/gallery rank numerals.

### 6.4 Era treatment — automatic from `productionYear`
| Years | Name | Backdrop filter | Frame (1dp inset hairline, ~12dp in from edges) |
|---|---|---|---|
| ≤1954 | Silver | saturation ≈ 0.18, contrast ≈ 1.06 | `rgba(201,204,210,.4)` |
| 1955–1975 | Technicolor | saturation ≈ 1.25 | `rgba(242,109,61,.4)` |
| 1976–1999 | Blockbuster | none | `rgba(217,142,50,.42)` |
| ≥2000 | Modern | none | `rgba(245,238,220,.28)` |
Compose: `ColorMatrix` saturation on the Image. Cheap.

### 6.5 Genre / franchise motifs — small static mapping table, vector-only overlays
Priority: franchise (TMDB collection) beats genre. Unknown → no motif (fine).
| Key | Motif |
|---|---|
| James Bond Collection | Gunbarrel: 3 small paper dots + 1 accent ring, top-right |
| Indiana Jones Collection / genre Adventure | Faint topographic contour arcs (repeating radial strokes, ~10% alpha cream) + one dashed red route line (rotated ~-6°) |
| Film-Noir / Crime pre-1960 | Venetian-blind shadow: repeating near-horizontal dark bars, ~28% alpha, multiply feel |
| Caper / Heist / Comedy-crime 60s-70s | Deco double inner frame (two nested hairlines, warm gold, ~45%/25% alpha) |
| (extendable) | table lives in one file; adding a motif = one entry + one drawable |
All motifs are Compose Canvas draws or simple drawables — no bitmaps.

### 6.6 Playlist cover
Generated covers are replaced: `jellyfin.sh` (this repo) uploads branded **square** covers for Top 100 / Watchlist via the playlist image API — script "100" mark / bookmark mark on Canyon teal (produce via §4 pipeline → PNG 720×720). Shows in TV list headers, web, search.

### 6.7 Loading & perf budget (the stick is slow — this section is binding)
- `LazyColumn`; every tier item is lazy.
- Backdrops decoded at **half resolution** (copy the downscale approach from `BackgroundService.loadBackgrounds`).
- At most ~3 full-bleed backdrops resident (pantheon panels near viewport); Coil handles eviction — set explicit `size()` on requests.
- Ledger thumbs are small posters (Coil, existing card pipeline sizes).
- No parallax, no Ken Burns, no scroll-linked effects. Crossfade image placeholders (ground color) only.
- Scroll must stay smooth end-to-end on the Fire Stick; if not, reduce pantheon image height/count before touching the design.

### 6.8 Watchlist variant
Same screen component, `ranked = false`: **no pantheon** — gallery cards + ledger only, no rank numerals (no ceremony for an unranked list). Ordering = playlist order.

## 7. Web client (Canyon, fixed — no roulette)

Mechanisms: (a) Dashboard → Branding → **Custom CSS** (+ logo/splash image upload), (b) the **JavaScript Injector plugin** (already used for playlist flair). Both should be provisioned from this repo's `jellyfin.sh` (IaC), not clicked in — find where existing web-flair JS is provisioned and follow that pattern.

### 7.1 Custom CSS scope
- Swap Jellyfin blue accents → `#47C4B8` (buttons, links, focus, progress, checkboxes).
- Ground → `#0E2A30`-family; text → cream/sage per §1 Canyon column.
- `@font-face` PalmCanyonDrive (served asset) for the login header + page titles **only**; Josefin Sans for headings if easy; body text stays the web client's default stack.
- Login page: wordmark above the form (styled per prototype tab 6), pill turquoise Sign In with soft glow.
- **Sidebar prune** (CSS `display:none`): Dashboard/admin links, metadata manager, syncplay, and other non-family items. Keep: Home, library entries (Movies, Shows), Top 100, Watchlist, user/sign-out. Admin remains reachable by direct URL. Sidebar visual: dark teal panel `#0A2026`, cream items, turquoise active pill, script wordmark at top.
- Keep CSS to accents/fonts/visibility — **no layout surgery** (selector churn across Jellyfin upgrades).

### 7.2 Top 100 showcase on web (JS injector)
- Detect the Top 100 playlist route (playlist id known/discoverable via API by name). Hide the stock item list and the header junk (genre chips, total runtime, count). Render the same tier structure (§6.2–6.5) into the page from the same API data; images by item id URLs. Era filters via CSS `filter: saturate()`; motifs via inline SVG/CSS gradients (prototype tab 5/6 shows both clients).
- Accepted risk: DOM selectors churn across Jellyfin upgrades; this is already the accepted pattern for playlist flair.

### 7.3 Convergence principle
Web mirrors the Fire Stick nav set (Home / Movies / Shows / Top 100 / Watchlist), palette, fonts, wordmark, and showcase. When in doubt, make web look like the TV app, not vice versa.

## 8. Strings de-Jellyfin (`values/strings.xml`, English only)
Rewrite residual "Jellyfin" user-visible strings (~14): `welcome_title` ("Welcome to Movie Night"), `searchable_hint` ("Search Movie Night"), about/licenses screen labels, etc. Grep `values/strings.xml` for `Jellyfin`; lines ~338, 351, 354, 388, 408, 457–487, 543–545 at v0.19.9. Leave the 65 translated locales untouched (family uses English). Leave license/attribution texts factually intact where they genuinely refer to the Jellyfin project.

## 9. Phases & acceptance

| Phase | Scope | Acceptance |
|---|---|---|
| 1 | Canyon wordmark vector → `app_logo`/`brandWordmark`; launcher icon + banner; splash cleanup | Fire Stick home shows MN icon + neon banner legible at 160×90; splash = teal + neon wordmark; screensaver logo swapped; zero Jellyfin marks visible in normal use |
| 2 | Theme system: `Theme.MovieNight` ×4, attrs, fonts in `res/font/`, roulette + pin pref, delete stock themes, recolor `colors.xml` | Launch app 8×: all four themes appear; pinning works; no jellyfin_blue anywhere; stock theme XMLs gone |
| 3 | Component dialects: toolbar active states, hero scrim/button, rank pills ×4 (+details parity), row-header ornaments, card fonts, `backdropDimColor` | Each theme's toolbar/hero/pill matches prototype tabs 1–4; browsing backdrop art unchanged in brightness |
| 4 | Top 100 showcase screen (TV) + Watchlist variant + playlist covers | Tab-5 fidelity; opens on №1; smooth scroll on the stick; billing/motifs/era all from real metadata; missing-data fallbacks exercised |
| 5 | Strings; web CSS + sidebar prune + login + JS-injector showcase, provisioned via `jellyfin.sh` | Web login + sidebar match tab 6; Top 100 web page renders tiers; all provisioned by IaC, survives container recreate |
| 6 | Optional splash beats (§5.1), stretch focus-glow (§6.3) | Each ≤600 ms, single-view, no startup delay, no dropped frames — else cut |

Each phase ships independently; sideload + eyeball on the real Fire Stick after every phase.

## 10. Open items (decide with Brennan before/while implementing)
- [ ] TMDB theatrical taglines on pantheon panels: authentic studio copy but *added text* — currently **out**; needs his in/out.
- [ ] APK size after 4 font families — subset to Latin if needed.
- [ ] Exact motif table coverage beyond the four listed (extend as taste dictates, vector-only).

## Files in this directory
- `SPEC.md` — this file
- `brand-studies.html` — v5 interactive prototype, fully offline (font embedded); tabs: Canyon / Matinee / Reel One / Marquee / Top 100 / Web; ←/→ pages, 🎲 simulates roulette
- `PalmCanyonDrive.otf` — the script font (input to the §4 outlining pipeline; do not bundle in APK)
- `../../DESIGN-BRANDING.md` — decision log & audit trail (context; this SPEC supersedes it on any conflict)
