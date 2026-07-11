# DESIGN — Movie Night Custom Branding

**Status:** v5 — design study complete. **Implementation handoff: `docs/branding/SPEC.md`** (self-contained spec + offline prototype + font — supersedes this file on any conflict)
**Prototypes:** `docs/branding/brand-studies.html` (offline copy) · https://claude.ai/code/artifact/49b69fe0-4904-4e91-b20f-909bce29f7fe (v5: bespoke pantheon 1–10 w/ billing blocks + genre/franchise motifs, tiers 1–10/11–50/51–100)
**Target repo:** `~/jellyfin-androidtv` (fork of jellyfin-androidtv v0.19.9, branch `collections`)
**Signature asset:** `PalmCanyonDrive.otf` (`~/gcs-radio/src/frontend/static/`) — 1950s retro script, display-only.

## Locked decisions (2026-07-10)

- **Theme roulette:** all four directions become full in-app themes — **Canyon, Matinee, Reel One, Marquee** — one picked **randomly per app launch**. Each theme keeps its own wordmark treatment, ornament, fonts, rounding, and accent; trickier shared surfaces stay common. Roster is one array (Marquee droppable — Brennan's least favorite, still liked).
- **Canyon is the anchor:** favorite theme; the *static* surfaces that can't rotate wear Canyon permanently — launcher icon, Fire TV banner, and the web client.
- **No taglines, anywhere.** "Movie Night" is the only brand text. Generated filler ("tonight's feature presentation", "Dusk 'til Late") reads as AI slop — banned.
- **Posters/thumbnails untouched.** Card formats, wide thumbnails with clearlogo overlays, name/runtime rows all stay as built. Only their *fonts* join the theme pass, plus per-theme rank-pill styling.
- **Rank pill:** keep today's geometry (`view_card_legacy_image.xml` — top-right, translucent black, 1dp stroke, 12sp bold condensed white). Per-theme dialect: Canyon = turquoise stroke + soft glow; Matinee = 2dp amber stroke, 0 radius, tracked condensed; Reel One = vermilion square hairline; Marquee = gold hairline, wide-tracked.
- **Hero spotlight** (`HomeSpotlight.kt`: 320dp backdrop → black scrim → clearlogo → default `Button("▶ Play")`): brand = tint the scrim per theme + style the Play button in the theme's dialect. No added text; clearlogo/backdrop untouched.
- **Web client:** accent + fonts + login via server-wide Custom CSS (Dashboard → Branding), reusing the outlined wordmark SVG as the login/splash logo. Fixed on Canyon (no rotation). Deeper styling via the existing JavaScript Injector plugin deferred.
- **Launcher icon:** script "MN" monogram (outlined from PalmCanyonDrive), drawn large with minimal margin — near edge-to-edge on the safe zone, cream + subtle halo on teal. Full neon wordmark on the 16:9 banner.
- **Roster:** all four themes in rotation; settings gains "Theme: Roulette (default) / pin one" (replaces the stock picker).
- **Splash motion:** yes in principle, but the Fire Stick is old and laggy (home rows take ~5s to settle) — only trivially cheap single-view Compose animations (alpha/translate, ≤600ms, never delaying startup); drop any beat that costs frames. Phase 5, taste- AND perf-gated.
- **Keep `applicationId`** (`org.jellyfin.androidtv`) — changing it forces reinstall/data loss on the Fire Stick.
- **Screensaver:** structure untouched (server art + clock is great); it reuses `app_logo`, so it inherits the themed wordmark for free.
- **Live artwork backgrounds are sacred.** While browsing, the focused item's backdrop fills the screen (`AppBackground.kt`: blurred 10dp, dimmed by `background_filter #94101010` ≈ 58% near-black). This looks spectacular and must not be lost. Design rule: **themes never own the background — they borrow it.** The theme's only claim is `background_filter` becoming a theme attr with a *hue-biased* near-black at the same alpha (Canyon `#99091D22` teal-bias, Matinee `#99160D06` leather-bias, Reel One `#940B0B0B` neutral, Marquee `#9E0D0A05` warm) — never darker than stock, so zero artwork brightness is lost. The flat theme grounds are fallbacks only (no-backdrop items, settings, splash). Chrome separation over arbitrary art comes from the treatments themselves (neon halo, glow focus rings, pill strokes), not from heavier dimming.

- **Toolbar (TV):** the real `MainToolbar` is logo · center nav buttons (Home / Search / Top 100 / Watchlist) · settings + clock. Themed: nav buttons in the theme's face; active button filled with the accent in the theme's shape dialect (glowing pill / amber slab / vermilion block / gold fill).
- **Top 100 = the flagship page ("fun zone").** The home page with poster/wide-thumbnail rows is the gold-standard *browsing* experience and stays optimized for scrollability; the Top 100 page is where we flex. Replaces the text-list playlist view with a **descending ceremony** — tiers: **1–10 pantheon** (full-bleed panels), **11–50 gallery** (paired 2-col cards), **51–100 ledger** (fast branded rows: poster thumb / rank / title / year / runtime). Pantheon panels are made bespoke per film from its own metadata — no invented text:
  - **Billing block:** director + top-billed cast (item People field) in compressed poster-credit type (condensed caps, wide tracking, slight scaleY) — the classic one-sheet billing look.
  - **Genre/franchise motifs:** vector overlays from a small mapping table — noir → venetian-blind shadow, adventure → map contours + dashed route, caper → deco double frame; TMDB collection id → franchise mark (Bond → gunbarrel dots). Unknown genre → no motif.
  - **Era treatment automatic from release year:** pre-~1955 silver desaturation + silver hairline frame; 1955–75 technicolor lift + warm frame; 1976–99 amber; 2000+ neutral.
  - **Composition variety:** layout picked deterministically per film (motif kind + backdrop aspect + rank parity — poster inset, motif corner, logo scale) so ten big rows never repeat, but are stable across visits.
  - **Focus interaction (stretch):** focusing a pantheon panel glows the ledger rows of that director's other entries.
  - Clearlogo fallback = bold title text. **Header garbage deleted** (genre list, total runtime, item count) — the page opens on №1. Watchlist reuses the component minus rank ceremony (gallery + ledger only). Fire Stick perf: lazy column, half-res backdrops (same trick as `AppBackground`), ≤3 full-bleed images resident, motifs are cheap draws.
  - **Open call:** TMDB theatrical taglines (authentic studio copy, but *added text*) — awaiting Brennan's in/out.
- **Web converges on the Fire Stick.** Sidebar pruned via CSS to Home / Movies / Shows / Top 100 / Watchlist (Dashboard/admin/metadata links hidden — ops live in IaC; dashboard stays reachable by URL). The JS injector (existing pattern) detects the Top 100 route, hides the stock list + junk header, and renders the same showcase tiers from API data. Web stays Canyon-fixed.

## Non-goals
Startup sounds/video; redrawing the ~26 placeholder `tile_*` vectors (recolor via theme attrs only); locale string translations (English only); web theme rotation.

## Current state (audit, 2026-07-10)

Only the app *name* was ever rebranded. Everything visual is stock Jellyfin:

| Surface | Files | State |
|---|---|---|
| Launcher icon (adaptive + rasters) | `res/mipmap-anydpi-v26/app_icon.xml`, `drawable/app_icon_*.xml`, `mipmap-*/app_icon.png` (80–320 px) | Jellyfin chevron |
| TV banner (16:9) | `drawable/app_banner*.xml`, `mipmap-*/app_banner.png` (160×90 – 640×360) | Jellyfin logo |
| Wordmark (splash, toolbar, screensaver, details fallback) | `drawable/app_logo.xml`, `drawable-v24/app_logo.xml`, `values/logo.xml` | Purple→blue "jellyfin", vector 252×72 dp |
| Splash | `ui/startup/fragment/SplashFragment.kt` — Compose, `not_quite_black` + `app_logo` @ 400 dp | Stock |
| Accent | `values/colors.xml`: `jellyfin_blue #00A4DC`, `jellyfin_purple #AA5CC3` — focus/buttons/progress/search | Stock |
| Themes | `theme_jellyfin.xml` / `theme_emerald.xml` / `theme_mutedpurple.xml`; enum `AppTheme.kt`; applied in `ActivityThemeExtensions.kt`; picker in `CustomizationPreferencesScreen.kt` | 3 stock themes |
| Fonts | none (`res/font/` absent, all Roboto) | Stock |
| Strings | `app_name` = "Movie Night" ✓; ~14 residual "Jellyfin" strings in `values/strings.xml` | Partial |
| Hero row | `HomeSpotlight.kt` + `HeroRowPresenter.kt` (fork-custom) | Unbranded default Button |
| Rank pill / bookmark | `view_card_legacy_image.xml` `curated_rank` + `drawable/curated_rank_pill.xml` (stroke = jellyfin_blue!), `view_row_details.xml` parity copy | Wearing Jellyfin blue |

## The four themes (see v2 prototypes)

Shared skeleton: dark ground, PalmCanyonDrive available, accent in exactly three places (focus ring, primary button, ornament/pill), one muted support color for alerts. Everything else is per-theme dialect:

| | Canyon ★anchor | Matinee | Reel One | Marquee |
|---|---|---|---|---|
| Ground | teal night `#0E2A30` | leather `#191009` | flat black `#0B0B0B` | house black `#0E0B06` |
| Accent | turquoise `#47C4B8` | amber `#D98E32` | vermilion `#E8442E` | gold `#C9A227` |
| Support | sunset `#F26D3D` (starburst) | red `#A62B1F` (litho shadow) | brass (rare) | velvet `#7A1E1E` (alerts) |
| Text | cream `#F5EEDC` | paper `#E8D5B0` | paper `#F2EFE6` | cream `#F2E6CB` |
| Wordmark | neon script + halo | condensed caps + red offset | script over vermilion disc | gold-leaf script + deco rules |
| UI font (OFL) | Josefin Sans | Oswald | Archivo | Jost |
| Rounding | 8dp, pills | 2–3dp, boxy | 0dp | 3dp |
| Focus ring | glow | plain, 2dp feel | thick square | hairline |
| Ornament | starburst ✶ | ▸ tick / red rule | vermilion square | ◆ diamond |

## Theme roulette — implementation

The stock plumbing already does 90% of this: `AppTheme` enum → `ActivityThemeExtensions.applyTheme()` maps to a style at activity creation.

1. Replace the three stock themes with four: `theme_movienight_canyon/matinee/reelone/marquee.xml`, all deriving from a shared `Theme.MovieNight` base that defines common attrs.
2. **Per-theme attrs** carry the dialect: accent, button/focus drawables, `app_logo` becomes a theme attr (`?attr/brandWordmark`) so splash/toolbar/screensaver pick up the right wordmark per theme, plus `?attr/brandFontFamily`, pill stroke drawable, corner radii.
3. **Random pick:** process-scoped choice (e.g. in `JellyfinApplication.onCreate` or a small `ThemeRoulette` object: `AppTheme.entries.random()` from the enabled roster) stored for the process lifetime so every activity in one session agrees. New launch → new draw. Keep the preference screen entry replaced by a "Theme: Roulette / pin one" option — pinning is nearly free and good for debugging.
4. Fonts: `res/font/` gets the four OFL UI faces (subset if APK size matters) wired via theme `android:fontFamily`; Compose side mirrors via `JellyfinTheme` typography reading the active theme.
5. Rank pill: `curated_rank_pill.xml` → four variants selected by theme attr (`?attr/curatedPillBackground`); text fontFamily follows `?attr/brandFontFamily`. Same for the details-screen copy in `view_row_details.xml`.
6. Hero: `HomeSpotlight.kt` reads scrim colors + button shape from the Compose theme instead of hardcoded `Color(0x55000000)`/default Button.
7. Live backdrop dim: `background_filter` moves from `colors.xml` to a theme attr (`?attr/backdropDimColor`) consumed by `AppBackground.kt` — the hue-biased per-theme washes above, same ~58% alpha as stock.

## Anti-AI-slop production approach

Vector-first, typography-first — no generated raster imagery in chrome:

1. **Wordmarks = real typography.** Canyon/Reel One/Marquee: render "Movie Night" from PalmCanyonDrive.otf → outline to SVG (fontTools pen API or Inkscape text-to-path) → Android VectorDrawable. Matinee: same pipeline with Oswald. Effects (neon halo, gold gradient, red offset) authored as vector layers, not filters-on-raster.
2. **Ornament = geometry.** Starbursts, diamonds, discs, rules: hand-authored vector primitives.
3. **Launcher assets = Canyon master SVG** composed at target sizes (icon 80–320 px + adaptive vectors; banner 160×90 → 640×360). Legibility check at 160×90 before anything ships.
4. **Licensing:** PalmCanyonDrive is a retail font (Mika Melvas / Fenotype). Outlined-logo use is the safe pattern; don't embed the .otf in the APK for arbitrary text. UI faces are all OFL, safe to commit.

## Implementation phases

**Phase 1 — Canyon identity** (ship first, sideload legibility check on the Fire Stick)
Wordmark SVG → `app_logo` replacement; launcher icon + banner regeneration; splash cleanup. App is fully de-Jellyfinned wearing Canyon only.

**Phase 2 — theme system + roulette**
`Theme.MovieNight` base + four theme XMLs + attrs; delete stock themes/`moviebg.jpg`; `res/font/`; roulette pick + pin preference; recolor `colors.xml` jellyfin_* usages.

**Phase 3 — component dialects**
Rank pill variants (card + details parity), hero scrim/button theming, row-header ornaments, card title/runtime fonts.

**Phase 4 — Top 100 showcase (TV)**
New Compose screen (pattern: `HomeSpotlight.kt`) replacing `ItemListFragment` as the toolbar-button destination for Top 100/Watchlist. Pantheon → gallery → ledger tiers; era treatment from `productionYear`; images via `imageHelper` (backdrop/logo per item id); lazy + downscaled for the old stick. Toolbar nav active-state theming rides Phase 3 attrs.

**Phase 5 — copy + web**
De-Jellyfin ~14 strings ("Welcome to Movie Night"). Web: Custom CSS (accent/fonts/login/sidebar-prune) + wordmark upload in Dashboard → Branding; JS-injector showcase for the Top 100 route; commit CSS/JS to movie-server repo (IaC).

**Phase 6 — optional flourishes (taste-gated)**
Reel One splash beat (disc snap + script fade, ≤500 ms); equivalents for others only if they earn it. All splash motion perf-gated per the Fire Stick constraint.

## Open items
- [ ] Final go on v2 prototypes (any per-theme visual tweaks)
- [ ] APK size check after adding 4 font families (subset if needed)
- [ ] Where Jellyfin's Custom CSS lives in IaC (`jellyfin.sh`?) so web branding is provisioned, not clicked
