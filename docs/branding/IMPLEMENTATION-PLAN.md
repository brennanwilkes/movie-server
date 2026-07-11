# Movie Night Branding — Master Implementation Plan

**Generated:** 2026-07-10 · **Updated:** 2026-07-10 (post deep-dive verification)
**For:** low-powered implementation agents
**Spec:** `SPEC.md` · **Prototype:** `brand-studies.html` · **Decisions:** `DESIGN-BRANDING.md` · **Top 100 supplement:** `TOP100-GUIDE.md`

This document maps every subsystem in both codebases to the **exact files, line numbers, and changes** required. Each section: current state → exact change → verification command. A low-powered agent should be able to execute this file section-by-section without external context.

---

## Repo Map

| Repo | Path | Role |
|------|------|------|
| **androidtv** | `~/jellyfin-androidtv` (branch `collections`, fork of v0.19.9) | Fire TV client — themes, splash, toolbar, hero, cards, Top 100 showcase |
| **movie-server** | `~/movie-server` | IaC — Jellyfin web provisioning (CSS, JS injector, branding API) |

**minSdk: 21 · compileSdk: 36 · applicationId: `org.jellyfin.androidtv` (DO NOT CHANGE)**

---

## CRITICAL CODING PATTERNS (reference before writing any code)

### Pattern 1: Reading a theme attribute from Compose

```kotlin
// From AppBackground.kt:35-45 — the ONLY pattern that works in Compose
@Composable
fun readThemeDrawable(@DrawableRes attrRes: Int): Drawable? {
    val context = LocalContext.current
    return remember(context.theme) {
        val ta = context.theme.obtainStyledAttributes(intArrayOf(attrRes))
        val d = ta.getDrawable(0)
        ta.recycle()
        d
    }
}

@Composable
fun readThemeColor(@ColorRes attrRes: Int): Color {
    val context = LocalContext.current
    return remember(context.theme) {
        val ta = context.theme.obtainStyledAttributes(intArrayOf(attrRes))
        val c = ta.getColor(0, 0)
        ta.recycle()
        c
    }.toComposeColor()
}
```

### Pattern 2: Fragment with full Compose (from SplashFragment.kt)

```kotlin
class MyFragment : Fragment() {
    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ) = content {                           // ← from androidx.fragment.compose.content
        JellyfinTheme {                     // ← wraps in the app's Compose theme
            MyComposableScreen()
        }
    }
}
```

### Pattern 3: Navigation (Destination.Fragment only, NO Compose variant)

```kotlin
// Destinations.kt — define destination
fun myDestination(args: UUID) = fragmentDestination<MyFragment>(
    "ItemId" to args.toString(),           // bundle key is always "ItemId"
)

// MainToolbar.kt — navigate
navigationRepository.navigate(Destinations.myDestination(id))

// DestinationFragmentView.kt — dispatches via fragmentManager.fragmentFactory.instantiate()
// The Fragment class MUST have a no-arg constructor (Fragment default).
```

### Pattern 4: Reading theme attrs from View-based XML

```xml
<!-- In layout XML — works on API 21+ -->
<TextView android:background="?attr/curatedPillBackground" />
<TextView android:fontFamily="?attr/brandFontFamily" />

<!-- In VectorDrawable XML — works for fillColor/strokeColor on API 21+ -->
<shape>
    <stroke android:color="?attr/colorAccent" />
</shape>
```

---

## Phase 1 — Canyon Identity (ship first)

Static surfaces that can't rotate. Canyon is the permanent identity.

### 1A. Wordmark Vectors → `app_logo`

**Current state:** `drawable/app_logo.xml` is a 252×72dp VectorDrawable with Jellyfin jellyfish icon + "JELLYFIN" text (6 paths, hardcoded `#AA5CC3`/`#00A4DC` gradient). `drawable-v24/app_logo.xml` is identical but references `@color/logo_gradient_start`/`@color/logo_gradient_stop`. `values/logo.xml` defines those gradient colors.

**Changes:**

| # | File | Action |
|---|------|--------|
| 1 | `res/drawable/wordmark_canyon.xml` | **CREATE** — Canyon wordmark VectorDrawable (cream script "Movie Night" + turquoise neon halo). 252×72dp viewport. 4 separate wordmark files are required because `colorFilter` on VectorDrawable only works on monochrome sources; Canyon uses 3 colors (cream+turquoise+orange). |
| 2 | `res/drawable/wordmark_matinee.xml` | **CREATE** — Matinee wordmark (condensed caps "MOVIE NIGHT" amber + red offset shadow behind). |
| 3 | `res/drawable/wordmark_reelone.xml` | **CREATE** — Reel One wordmark (cream script over off-center vermilion disc). |
| 4 | `res/drawable/wordmark_marquee.xml` | **CREATE** — Marquee wordmark (script with gold-leaf vertical gradient between hairline rules + ◆ ornaments). |
| 5 | `res/drawable/app_logo.xml` | **REPLACE** content with Canyon wordmark (same 252×72dp viewport). This becomes the unconverted-reference fallback. |
| 6 | `res/drawable-v24/app_logo.xml` | **REPLACE** content with Canyon wordmark (identical to #5). |
| 7 | `res/values/logo.xml` | **REPLACE** with Canyon brand colors: `logo_gradient_start=#47C4B8`, `logo_gradient_stop=#F5EEDC`, `logo_background=#0E2A30`, `logo_text=#F5EEDC`. (May become unused after the wordmark swap, but keeps things clean.) |
| 8 | `app/src/debug/res/values/logo.xml` | **UPDATE** debug gradient to match Canyon or remove. |

**References to `app_logo` that resolve automatically after the swap:**

| File | Line | Usage | Notes |
|------|------|-------|-------|
| `SplashFragment.kt` | 37 | `painterResource(R.drawable.app_logo)` | Splash screen |
| `Toolbar.kt` | 29 | `painterResource(R.drawable.app_logo)` | Logo() composable |
| `DreamContentLogo.kt` | 25 | `painterResource(R.drawable.app_logo)` | Screensaver logo |
| `view_card_legacy_image.xml` | 40 | `tools:src="@drawable/app_logo"` | Design-time only |

**Vector production pipeline (§4 of SPEC):**
1. Render text with PalmCanyonDrive.otf → outline to SVG paths via `fontTools` (`pip install fontTools`, use `pens.svgPathPen`) or Inkscape (`Path → Object to Path`)
2. Compose per-theme wordmark SVGs adding geometry (neon halo = layered stroked copies at low alpha; red offset = translate copy; gradient = 3-stop vertical gradient)
3. Convert SVG → Android VectorDrawable via Android Studio Vector Asset importer or `vd-tool`
4. Target existing `app_logo` geometry: **252×72 dp viewport** (splash shows it at width 400dp)

**Verification:** Build APK, sideload. Splash = teal background + cream neon wordmark. Toolbar shows wordmark. Screensaver shows wordmark. Zero Jellyfin marks visible.

### 1B. Launcher Icon

| # | File | Action |
|---|------|--------|
| 1 | `res/drawable/app_icon_background.xml` | **REPLACE** with Canyon teal `#0E2A30` solid fill (108dp viewport) |
| 2 | `res/drawable/app_icon_foreground.xml` | **REPLACE** with MN monogram vector (cream `#F5EEDC`, large near edge-to-edge within 66dp safe zone of 108dp viewport, subtle turquoise outer glow) |
| 3 | `res/drawable/app_icon_foreground_monochrome.xml` | **REPLACE** with white MN monochrome |
| 4 | `res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/app_icon.png` | **REGENERATE** at 80/120/160/240/320px from Canyon MN design |
| 5 | `mipmap-anydpi-v26/app_icon.xml` | **NO CHANGE** — keep adaptive icon structure |

**Acceptance test:** Icon legible at 80px (mdpi).

### 1C. TV Banner

| # | File | Action |
|---|------|--------|
| 1 | `res/drawable/app_banner_background.xml` | **REPLACE** with Canyon teal `#0E2A30` fill (320×180dp) |
| 2 | `res/drawable/app_banner_foreground.xml` | **REPLACE** with full neon "Movie Night" script + small orange ✶ (hardcoded Canyon colors) |
| 3 | `res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/app_banner.png` | **REGENERATE** at 160×90 / 240×135 / 320×180 / 480×270 / 640×360 |

**Acceptance test:** 160×90 render legible on Fire TV home screen.

### 1D. Splash Cleanup

| # | File | Line | Change |
|---|------|------|--------|
| 1 | `SplashFragment.kt` | 31 (`R.color.not_quite_black`) | Change background to Canyon teal ground `#0E2A30` (hardcoded for Phase 1; will become theme attr in Phase 2). Either: `Color(0xFF0E2A30)` or add a `R.color.brand_ground_canyon` color resource. |

### 1E. Screensaver

No changes needed — `DreamContentLogo.kt:25` uses `R.drawable.app_logo`, which inherits the Canyon wordmark from 1A. Background stays black (screensaver is always dark).

### Phase 1 Deliverables

- [ ] Produce Canyon wordmark VectorDrawable from PalmCanyonDrive.otf (§4 pipeline)
- [ ] Produce MN monogram vector + monochrome for launcher icon
- [ ] Produce banner vector layers (foreground + background)
- [ ] Create 4 wordmark files + replace `app_logo.xml`
- [ ] Replace icon drawables + regenerate 5 PNG sizes
- [ ] Replace banner drawables + regenerate 5 PNG sizes
- [ ] Update `logo.xml` and debug `logo.xml`
- [ ] Change splash background to Canyon teal
- [ ] Sideload, verify all surfaces

---

## Phase 2 — Theme System + Roulette

Replace the 3 stock themes with 4 branded themes + roulette.

### 2A. Theme XML Files

**Current state:**
- `theme_jellyfin.xml` defines `Theme.Jellyfin` (parent `Theme.AppCompat.Leanback`) with `jellyfin_blue` accent, `not_quite_black` bg, 20+ tile color attrs. Also contains `Theme.Jellyfin.Preferences`.
- `theme_emerald.xml` defines `Theme.Jellyfin.Emerald` extending `Theme.Jellyfin` with green accent + `moviebg` jpg.
- `theme_mutedpurple.xml` defines `Theme.Jellyfin.MutedPurple` extending `Theme.Jellyfin` with blue-purple accent.

**Changes:**

| # | File | Action |
|---|------|--------|
| 1 | `res/values/theme_jellyfin.xml` | **REPLACE** `Theme.Jellyfin` with `Theme.MovieNight` (same parent `Theme.AppCompat.Leanback`). All tile `tile_*_bg` attrs recolored to ground-tint variants (do NOT redraw the ~26 `tile_*.xml` vectors — just change the color values). Keep `Theme.Jellyfin.Preferences` (rename to `Theme.MovieNight.Preferences`). |
| 2 | `res/values/theme_emerald.xml` | **DELETE** entirely |
| 3 | `res/drawable/moviebg.jpg` | **DELETE** — only Emerald used it |
| 4 | `res/values/theme_mutedpurple.xml` | **DELETE** entirely |
| 5 | `res/values/theme_movienight_canyon.xml` | **CREATE** — parent `Theme.MovieNight`. See exact attrs below. |
| 6 | `res/values/theme_movienight_matinee.xml` | **CREATE** — parent `Theme.MovieNight`. |
| 7 | `res/values/theme_movienight_reelone.xml` | **CREATE** — parent `Theme.MovieNight`. |
| 8 | `res/values/theme_movienight_marquee.xml` | **CREATE** — parent `Theme.MovieNight`. |

**Per-theme attribute values (exact hex values):**

| Attr | Canyon | Matinee | Reel One | Marquee |
|------|--------|---------|----------|---------|
| `colorAccent` | `#47C4B8` | `#D98E32` | `#E8442E` | `#C9A227` |
| `defaultBackground` | `#0E2A30` | `#191009` | `#0B0B0B` | `#0E0B06` |
| `cardRounding` | `8dp` | `3dp` | `0dp` | `3dp` |
| `buttonRounding` | `999dp` (pill) | `2dp` | `0dp` | `2dp` |
| `headerTextColor` | `#F5EEDC` | `#E8D5B0` | `#F2EFE6` | `#F2E6CB` |
| `progressPrimary` | `#47C4B8` | `#D98E32` | `#E8442E` | `#C9A227` |
| `progressSecondary` | `#7FA8A4` | `#9C7C53` | `#8D8A80` | `#9A8C6E` |
| `defaultSearchColor` | `#47C4B8` | `#D98E32` | `#E8442E` | `#C9A227` |
| `controlIconForegroundActive` | `#47C4B8` | `#D98E32` | `#E8442E` | `#C9A227` |
| `brandWordmark` | `@drawable/wordmark_canyon` | `@drawable/wordmark_matinee` | `@drawable/wordmark_reelone` | `@drawable/wordmark_marquee` |
| `brandFontFamily` | `@font/josefin_sans` | `@font/oswald` | `@font/archivo` | `@font/jost` |
| `backdropDimColor` | `#99091D22` | `#99160D06` | `#940B0B0B` | `#9E0D0A05` |
| `curatedPillBackground` | `@drawable/curated_pill_canyon` | `@drawable/curated_pill_matinee` | `@drawable/curated_pill_reelone` | `@drawable/curated_pill_marquee` |
| `buttonDefaultNormalBackground` | Canyon ground-tint drawable | Matinee ground-tint | Reel One ground-tint | Marquee ground-tint |
| `buttonDefaultHighlightBackground` | Canyon accent at 30% alpha | Matinee accent at 30% | Reel One accent at 30% | Marquee accent at 30% |

**Tile background recolor:** The ~20 `tile_*_bg` attrs in `theme_jellyfin.xml` are currently `@color/indigo_dye` / `@color/midnight_blue` / `@color/spanish_blue`. Recolor each theme's tile attrs to ground-tint variants (e.g. Canyon: `#0A1E24` dark teal tints). Do NOT redraw the `tile_*.xml` vector drawables.

### 2B. Custom Attributes

| # | File | Change |
|---|------|--------|
| 1 | `res/values/attrs.xml` | **ADD** to `JellyfinTheme` styleable: `brandWordmark` (reference), `brandFontFamily` (reference), `backdropDimColor` (color), `curatedPillBackground` (reference). Keep all existing attrs. |

### 2C. AppTheme Enum + Roulette

| # | File | Lines | Change |
|---|------|-------|--------|
| 1 | `preference/constant/AppTheme.kt` | 1-23 | **REPLACE** 3-value enum with 5-value: `ROULETTE(R.string.pref_theme_roulette)`, `CANYON(R.string.pref_theme_canyon)`, `MATINEE(R.string.pref_theme_matinee)`, `REELONE(R.string.pref_theme_reelone)`, `MARQUEE(R.string.pref_theme_marquee)`. Remove `PreferenceEnum` override if `serializedName` not needed (or keep). |
| 2 | `util/ActivityThemeExtensions.kt` | 15-20 | **REPLACE** `AppTheme.style` mapping with 5 themes: `ROULETTE` → resolve via `ThemeRoulette.choice.style`, `CANYON` → `R.style.Theme_MovieNight_Canyon`, etc. |
| 3 | `preference/UserPreferences.kt` | 42 | **CHANGE** default: `enumPreference("app_theme", AppTheme.ROULETTE)` |

**New file:**

| # | File | Purpose |
|---|------|---------|
| 4 | `util/ThemeRoulette.kt` | **CREATE** — Process-lifetime singleton. |

```kotlin
package org.jellyfin.androidtv.util

import org.jellyfin.androidtv.preference.constant.AppTheme

object ThemeRoulette {
    private val pinnedThemes = listOf(
        AppTheme.CANYON, AppTheme.MATINEE, AppTheme.REELONE, AppTheme.MARQUEE
    )

    val choice: AppTheme by lazy {
        pinnedThemes.random()
    }

    fun resolve(userPref: AppTheme): AppTheme =
        if (userPref == AppTheme.ROULETTE) choice else userPref
}
```

**Preference migration:** `SharedPreferenceStore.getEnum()` at line 67-73 falls back to `preference.defaultValue` when the stored value doesn't match any enum constant. Users with `app_theme=DARK/EMERALD/MUTED_PURPLE` stored will silently get ROULETTE. **No migration code needed.**

### 2D. Fonts

| # | File | Action |
|---|------|--------|
| 1 | `res/font/josefin_sans.ttf` | **CREATE** — download from Google Fonts, regular weight |
| 2 | `res/font/josefin_sans_bold.ttf` | **CREATE** — bold weight |
| 3 | `res/font/oswald.ttf` | **CREATE** |
| 4 | `res/font/oswald_bold.ttf` | **CREATE** |
| 5 | `res/font/archivo.ttf` | **CREATE** |
| 6 | `res/font/archivo_bold.ttf` | **CREATE** |
| 7 | `res/font/jost.ttf` | **CREATE** |
| 8 | `res/font/jost_bold.ttf` | **CREATE** |

8 font files (4 families × 2 weights). ~1-1.6MB total. Subset to Latin if APK size balloons.

### 2E. Compose Theme Bridge

**Current state:** `colorScheme.kt` has hardcoded greyscale. `typography.kt` has `TextStyle.Default`. `shapes.kt` has fixed corner sizes. `JellyfinTheme.kt` passes these via `CompositionLocalProvider`. None read from the View-based theme.

**Changes:**

| # | File | Change |
|---|------|--------|
| 1 | `ui/base/colorScheme.kt` | **Parameterize** `colorScheme()` to accept the active `AppTheme` and return per-theme colors. Add `accent`, `onAccent`, `ground`, `text`, `muted` to `ColorScheme` data class. |
| 2 | `ui/base/typography.kt` | **Expand** to hold per-theme `default: TextStyle` using the theme's `brandFontFamily`. Read font from attr via `obtainStyledAttributes` → `ContextCompat.getFont()` → `FontFamily`. |
| 3 | `ui/base/shapes.kt` | **Parameterize** per theme: Canyon = Small(8dp)/pill(999), Matinee = ExtraSmall(2-3dp), Reel One = 0dp, Marquee = Small(3dp). |
| 4 | `ui/base/JellyfinTheme.kt` | **No structural change** — feed per-theme values from the roulette singleton. The `colorScheme()`, `typography()`, `shapes()` calls should read from `ThemeRoulette.resolve(userPrefs.appTheme)`. |

**How to read theme attrs from Compose (reference Pattern 1 above):**

```kotlin
// In colorScheme.kt or a helper:
@Composable
fun readThemeColor(@ColorRes attrRes: Int): Color {
    val context = LocalContext.current
    return remember(context.theme) {
        val ta = context.theme.obtainStyledAttributes(intArrayOf(attrRes))
        val c = ta.getColor(0, 0)
        ta.recycle()
        c
    }.let { Color(it) }
}
```

### 2F. Recolor `colors.xml` + Hardcoded References

| # | File | Line | Change |
|---|------|------|--------|
| 1 | `res/values/colors.xml` | 3 | `jellyfin_blue` → rename to `brand_accent` with value `#47C4B8` (Canyon default). Or remove if no longer referenced. |
| 2 | `res/values/colors.xml` | 4 | `jellyfin_purple` → **REMOVE** |
| 3 | `res/drawable/ic_bookmark.xml` | 8 | `android:fillColor="@color/jellyfin_blue"` → `android:fillColor="?attr/colorAccent"` |
| 4 | `res/drawable/curated_rank_pill.xml` | 8 | `android:color="@color/jellyfin_blue"` → will be replaced by per-theme pill drawables in Phase 3 |

### 2G. Theme Picker UI + Strings

| # | File | Change |
|---|------|--------|
| 1 | `CustomizationPreferencesScreen.kt` | No code change needed — the `enum<AppTheme>` picker auto-expands to show all 5 values. Display names come from `AppTheme.nameRes` string resources. |
| 2 | `res/values/strings.xml` | **REPLACE** theme label strings: remove `pref_theme_dark`, `pref_theme_emerald`, `pref_theme_muted_purple`. **ADD:** `pref_theme_roulette` = "Roulette (random per launch)", `pref_theme_canyon` = "Canyon", `pref_theme_matinee` = "Matinee", `pref_theme_reelone` = "Reel One", `pref_theme_marquee` = "Marquee". |

### Phase 2 Deliverables

- [ ] Create `Theme.MovieNight` base + 4 theme children, delete stock themes
- [ ] Add 4 new attrs to `attrs.xml`
- [ ] Replace `AppTheme` enum, add `ThemeRoulette.kt`
- [ ] Download 8 font files to `res/font/`
- [ ] Parameterize Compose bridge (colorScheme, typography, shapes)
- [ ] Recolor `colors.xml` references
- [ ] Add theme label strings
- [ ] Build 8× launch: verify all four themes appear; pinning works; no jellyfin_blue

---

## Phase 3 — Component Dialects

Per-theme visual treatments for toolbar, hero, rank pills, row headers, cards.

### 3A. Toolbar Active States

| # | File | Lines | Change |
|---|------|-------|--------|
| 1 | `MainToolbar.kt` | 90-93 | `activeButtonColors` currently uses `JellyfinTheme.colorScheme.buttonActive/onButtonActive` (greyscale). **Replace** with per-theme accent fills after Phase 2E adds accent tokens to `ColorScheme`. Canyon = turquoise pill with glow; Matinee = amber slab; Reel One = flat vermilion block; Marquee = gold fill. |
| 2 | `MainToolbar.kt` | 146 | Button text style: add font family + case/tracking per theme. Canyon = sentence case 650 weight; Matinee = uppercase condensed tracked .1em; Reel One = lowercase bold tight; Marquee = uppercase wide-tracked .28em weight 500. |

### 3B. Hero Spotlight

| # | File | Lines | Change |
|---|------|-------|--------|
| 1 | `HomeSpotlight.kt` | 95 | `Brush.verticalGradient(listOf(Color(0x55000000), Color(0xE6000000)))` → per-theme scrim. Read ground color from `JellyfinTheme.colorScheme`, compute top at ~34% alpha and bottom at ~92% alpha. Canyon = teal-biased `rgba(12,36,41,.34)` → `rgba(12,36,41,.92)`. |
| 2 | `HomeSpotlight.kt` | 112-116 | Default `Button("▶  Play")` → style as theme primary button: Canyon = glowing turquoise pill; Matinee = amber condensed slab; Reel One = flat vermilion block; Marquee = gold fill with halo. Use `JellyfinTheme.colorScheme.accent` + per-theme shape. |

### 3C. Rank Pill × 4

| # | File | Action |
|---|------|--------|
| 1 | `res/drawable/curated_pill_canyon.xml` | **CREATE**: 1dp `#47C4B8` stroke, 5dp radius, `@color/black_transparent` fill, glow via layer-list outer stroke |
| 2 | `res/drawable/curated_pill_matinee.xml` | **CREATE**: 2dp `#D98E32` stroke, 0 radius, `@color/black_transparent` fill |
| 3 | `res/drawable/curated_pill_reelone.xml` | **CREATE**: 1dp `#E8442E` stroke, 0 radius, `@color/black_transparent` fill |
| 4 | `res/drawable/curated_pill_marquee.xml` | **CREATE**: 1dp `#C9A227` stroke, 4dp radius, `@color/black_transparent` fill |
| 5 | `res/layout/view_card_legacy_image.xml` | L147: `android:background="@drawable/curated_rank_pill"` → `android:background="?attr/curatedPillBackground"` |
| 6 | `res/layout/view_row_details.xml` | L217: `android:background="@drawable/curated_rank_pill"` → `android:background="?attr/curatedPillBackground"` |
| 7 | `res/layout/view_card_legacy_image.xml` | L153: `android:fontFamily="sans-serif-condensed"` → `android:fontFamily="?attr/brandFontFamily"` |
| 8 | `res/layout/view_row_details.xml` | L218: `android:fontFamily="sans-serif-condensed"` → `android:fontFamily="?attr/brandFontFamily"` |

### 3D. Row Headers + Ornaments

| # | File | Lines | Change |
|---|------|-------|--------|
| 1 | `res/values/styles.xml` | 8-10 | `Widget.Jellyfin.Row.Header`: **ADD** `android:fontFamily="?attr/brandFontFamily"`, `android:textColor="?attr/headerTextColor"`. Add per-theme case/tracking via `android:textAllCaps` and `android:letterSpacing` (Canyon = no caps; Matinee = allCaps + .1em; Reel One = no caps; Marquee = allCaps + .28em). |
| 2 | Row header ornaments | — | **CREATE**: prepend Unicode ornament to `HeaderItem.getName()` before rows are added to `rowsAdapter`. Pattern: in the home fragment's row setup, call a `curateHeaders()` method that replaces `"Top 100"` → `"✶ Top 100"` (Canyon) or `"◆ Top 100"` (Marquee). `RowHeaderView extends TextView` supports SpannableString. Zero presenter changes needed. |

**Ornaments per theme:**
- Canyon: `✶` (orange `#F26D3D`)
- Matinee: `▸` (red `#A62B1F`)
- Reel One: `■` (vermilion `#E8442E`)
- Marquee: `◆` (gold `#C9A227`)

### 3E. Card Title/Runtime Fonts

| # | File | Change |
|---|------|--------|
| 1 | `res/layout/view_card_legacy_image.xml` | Card title and runtime TextViews currently use `sans-serif-condensed`. **Change** to `?attr/brandFontFamily` or wire through theme text appearance. |
| 2 | `res/layout/view_row_details.xml` | Same — details page title/runtime fonts. |

### 3F. Background Dim Color

| # | File | Lines | Change |
|---|------|-------|--------|
| 1 | `ui/background/AppBackground.kt` | ~75 | `R.color.background_filter` → read `R.attr.backdropDimColor` from theme via Pattern 1. Change: `colorResource(R.color.background_filter)` → `readThemeColor(R.attr.backdropDimColor)`. |

---

## Phase 4 — Top 100 Showcase (TV)

The flagship page. Replaces `ItemListFragment` as the destination for curated playlist toolbar buttons.

### 4A. New Fragment + Destination

**Navigation system constraint:** `Destination` is a sealed interface with only one variant: `Destination.Fragment(KClass<Fragment>, Bundle)`. There is NO `Destination.Compose` variant. The `DestinationFragmentView` instantiates fragments via `fragmentManager.fragmentFactory.instantiate(classLoader, className)`. The fragment MUST have a no-arg constructor.

**Approach:** Create a `ShowcaseFragment` that uses the `content {}` extension from `androidx.fragment.compose` (same pattern as `SplashFragment.kt`). Navigate to it via `Destination.Fragment`.

| # | File | Action |
|---|------|--------|
| 1 | `ui/top100/ShowcaseFragment.kt` | **CREATE** — new Fragment class. |

```kotlin
package org.jellyfin.androidtv.ui.top100

import android.os.Bundle
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.fragment.compose.content
import org.jellyfin.androidtv.ui.base.JellyfinTheme
import java.util.UUID

class ShowcaseFragment : Fragment() {
    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ) = content {
        JellyfinTheme {
            val playlistId = UUID.fromString(requireArguments().getString("ItemId")!!)
            Top100Showcase(playlistId = playlistId)
        }
    }
}
```

| # | File | Action |
|---|------|--------|
| 2 | `ui/navigation/Destinations.kt` | **ADD** new destination function. |

```kotlin
fun showcase(playlist: UUID) = fragmentDestination<ShowcaseFragment>(
    "ItemId" to playlist.toString(),
)
```

| # | File | Lines | Change |
|---|------|-------|--------|
| 3 | `ui/shared/toolbar/MainToolbar.kt` | 177 | **CHANGE** `Destinations.itemList(playlistId)` → `Destinations.showcase(playlistId)` for curated playlist buttons. |

### 4B. New Compose Screen

| # | File | Purpose |
|---|------|---------|
| 1 | `ui/top100/Top100Showcase.kt` | **CREATE** — main Compose screen. `LazyColumn` with 3 tiers. |
| 2 | `ui/top100/PantheonPanel.kt` | **CREATE** — full-bleed panel composable for ranks 1–10. |
| 3 | `ui/top100/EraTreatment.kt` | **CREATE** — `ColorMatrix` saturation filters + era frame border per `productionYear`. |
| 4 | `ui/top100/Motifs.kt` | **CREATE** — genre/franchise motif overlays (Compose Canvas draws, no bitmaps). |
| 5 | `ui/top100/GalleryCard.kt` | **CREATE** — 16:6.6 wide card for ranks 11–50. |
| 6 | `ui/top100/LedgerRow.kt` | **CREATE** — dense row for ranks 51–100. |
| 7 | `ui/top100/WatchlistShowcase.kt` | **CREATE** — variant: `ranked = false`, gallery + ledger only. |

### 4C. Data Layer

| # | File | Change |
|---|------|--------|
| 1 | `data/repository/CuratedListsRepository.kt` | **Extend** — add `suspend fun getPlaylistItems(playlistId: UUID): List<BaseItemDto>`. Currently only exposes `rankFor()` and `isWatchlisted()`. The new method should call `playlistsApi.getPlaylistItems()` with the full field set (name, productionYear, runTimeTicks, genres, people, providerIds, imageTags). Pattern: same as `ItemListFragmentHelper.kt:55-97` `getPlaylist()`. |
| 2 | `ImageHelper.kt` | **Verify** — `getBackdropUrl(item, maxWidth)`, `getClearlogoUrl(item, maxHeight)`, `getPrimaryImageUrl(item)` should already be exposed. If not, add convenience methods. |

### 4D. Pantheon Panel Data Requirements

Each panel reads fields from `BaseItemDto`:

| Field | Source | How to access |
|-------|--------|---------------|
| `name`, `productionYear`, `runTimeTicks` | `BaseItemDto` | `.name`, `.productionYear`, `.runTimeTicks` |
| `genres` (first = primary) | `BaseItemDto.genres` | `.genres?.firstOrNull()` |
| Director | `BaseItemDto.people` | `.people?.firstOrNull { it.personType == PersonKind.DIRECTOR }?.name` |
| Top 3 actors | `BaseItemDto.people` | `.people?.filter { it.personType == PersonKind.ACTOR }?.take(3)` |
| TMDB collection | `BaseItemDto.providerIds` | `.providerIds?.tmdbCollectionId` or via `GET /Movies/{id}/Collections` (genre fallback if absent) |
| Backdrop | `BaseItemDto.itemBackdropImages` | Via `ImageHelper.getBackdropUrl()` |
| Clearlogo | `BaseItemDto.imageTags` | Via `ImageHelper.getLogoImageUrl()` — check `imageTags.containsKey("Logo")` |
| Primary poster | `BaseItemDto.imageTags` | Via `ImageHelper.getPrimaryImageUrl()` |

### 4E. Performance Budget (binding — Fire Stick is slow)

| Constraint | Implementation |
|------------|----------------|
| Lazy loading | `LazyColumn` — every tier item is lazy |
| Half-res backdrops | Copy downscale approach from `BackgroundService.loadBackgrounds` (decode to half screen dimensions) |
| Max 3 full-bleed images resident | Coil eviction + explicit `size()` on requests |
| No parallax/scroll-linked effects | Crossfade placeholders only |
| Motifs = cheap draws | Compose Canvas, no bitmaps |
| Era filters | `ColorMatrix` saturation on Image composable — cheap |

### 4F. Motif Table (expanded per TOP100-GUIDE.md §3)

| Key | Motif | Priority |
|-----|-------|----------|
| James Bond Collection | Gunbarrel: 3 dots + accent ring | High (6 entries) |
| Indiana Jones Collection / genre Adventure | Map contours + dashed route | High (4+3 entries) |
| Star Wars Collection | Star-field dots + light-streak | High (4 entries) |
| Lord of the Rings Collection | Ring arc, bottom-right | High (3 entries) |
| Pirates of the Caribbean Collection | Compass rose, top-left | Medium (3 entries) |
| Crime / Thriller (no year gate) | Venetian-blind shadow, era-aware alpha | High (~25 entries) |
| Film-Noir / Crime pre-1960 | Venetian-blind shadow, heavy alpha | (subset of Crime above) |
| Caper / Heist / Comedy-crime 60s–70s | Deco double inner frame | Medium |
| Sci-Fi / Cyberpunk | Scanlines + glitch bar | Medium (5+ entries) |
| Mission: Impossible Collection | Countdown timer dots | Low (3 entries, ranked 95+) |

**Priority rule:** TMDB collection → genre → no motif.

### 4G. Playlist Covers

| # | Repo | File | Change |
|---|------|------|--------|
| 1 | movie-server | `scripts/provision/jellyfin.sh` | **Add** section to upload branded square covers (720×720) for Top 100 / Watchlist via `POST /Items/{playlistId}/Images` API. Covers produced from §4 pipeline: script "100" mark / bookmark mark on Canyon teal. |
| 2 | movie-server | `docs/branding/` | **Produce** 2 PNG files: `cover-top100.png` and `cover-watchlist.png` (720×720, Canyon themed) |

---

## Phase 5 — Strings + Web

### 5A. De-Jellyfin Strings (androidtv)

**File:** `res/values/strings.xml`

| Line | Current | New |
|------|---------|-----|
| 338 | "Jellyfin requires a server to connect with...docs.jellyfin.org...Jellyfin." | "Movie Night requires a server to connect with...docs.jellyfin.org...Movie Night." |
| 351 | "Jellyfin requires network permissions to function" | "Movie Night requires network permissions to function" |
| 354 | "Welcome to Jellyfin!" | "Welcome to Movie Night!" |
| 388 | "...libraries used by the Jellyfin app" | "...libraries used by Movie Night" |
| 408 | "Search Jellyfin" | "Search Movie Night" |
| 457 | "Open the Jellyfin app on your phone..." | "Open the Movie Night app on your phone..." |
| 466 | "This server uses Jellyfin version %1$s...Jellyfin %2$s..." | "This server uses an unsupported version (%1$s). Please update to continue." |
| 475 | "...crash report was sent to your Jellyfin server." | "...crash report was sent to your server." |
| 476 | "Open Jellyfin in a web browser..." | "Open Movie Night in a web browser..." |
| 478 | "...the Jellyfin beta program." | "...the Movie Night beta program." |
| 487 | "Show the Jellyfin screensaver..." | "Show the Movie Night screensaver..." |
| 543 | "...to the Jellyfin server..." | "...to the server..." |
| 545 | "...Your Jellyfin server may prohibit..." | "...Your server may prohibit..." |

Leave the 65 translated locale files untouched. Leave license texts that genuinely refer to the Jellyfin project factually intact.

### 5B. Web Client — Custom CSS (movie-server)

**File:** `scripts/provision/jellyfin.sh` lines 295-312

**Current state:** Scyfin OLED imports + Jellyfin-blue scrollbar written to `CustomCss`.

**Replace entire `css_urls` block** with Canyon-themed CSS:

```css
/* Accent swap */
*:focus { outline-color: #47C4B8 !important; }
a, .link { color: #47C4B8 !important; }
.btnLogin, .raised.button-submit, button.btnSubmit { 
  background: #47C4B8 !important; color: #0C2429 !important; 
  border-radius: 999px !important; font-weight: 800;
  box-shadow: 0 0 16px rgba(71,196,184,.4);
}
.progress-bar { background: #47C4B8 !important; }
input[type="checkbox"]:checked { background-color: #47C4B8 !important; }

/* Ground + text */
.card, .dialog, .sheet, .menu { background: #1B1712 !important; color: #F5EEDC !important; }
html, body { background: #0E2A30 !important; color: #F5EEDC !important; }
.itemTitle { color: #F5EEDC !important; }
.text-secondary, .secondary { color: #7FA8A4 !important; }

/* Sidebar prune + restyle */
.navItem:not(.homePage):not(.moviesSection):not(.tvSection):not(.top100Entry):not(.watchlistEntry):not(.userSection) { display: none !important; }
.sidebar, .mainDrawer { background: #0A2026 !important; }
.sidebar .navItem, .mainDrawer .navItem { color: #7FA8A4 !important; border-radius: 999px; }
.sidebar .navItem.active, .mainDrawer .navItem.active { 
  background: #47C4B8 !important; color: #0C2429 !important; font-weight: 700; 
  box-shadow: 0 0 12px rgba(71,196,184,.4);
}

/* Login page */
.loginPage .loginContainer { background: linear-gradient(180deg, #0E2A30, #123039) !important; }
```

**Remove** the scyfin CDN imports (lines 299-300).

### 5C. Web Client — Login Logo

**File:** `scripts/provision/jellyfin.sh`

**Add** section to upload Canyon wordmark via `POST /Branding/BrandingImage`:

```bash
# Upload Canyon wordmark as login logo
curl -fsS -X POST "$JF/Branding/BrandingImage" \
  -H "X-Emby-Token: $token" \
  -F "Type=0" \
  -F "file=@/path/to/wordmark-canyon.png"
```

Also set `SplashscreenEnabled=true` via `POST /System/Configuration/Branding`.

**Alternative:** Use the existing `LoginDisclaimer` HTML field to inject an inline SVG wordmark above the login form (more control, no raster upload needed).

### 5D. Web Client — Top 100 Showcase (JS Injector)

**Separate file (recommended):** `scripts/provision/jellyfin-web-showcase.js` — isolates risk from existing flair.js.

**flair.js stays untouched.** The existing 322-line file handles rank pills, bookmarks, sidebar nav, timezone, playlist clicks, watchlist shuffle. Do NOT add showcase logic here.

**New file `jellyfin-web-showcase.js` requirements:**
- **DOM version probe** at top: check 1-2 canonical elements; bail with `console.warn` if missing
- Detect Top 100 playlist route (by playlist id or name in URL hash)
- **Replace stock innerHTML wholesale** (1 selector) instead of targeting 5 individual header elements
- Fetch playlist items via `ApiClient` (same API contract as flair.js)
- Render 3 tiers (pantheon/gallery/ledger) into the injected container
- Era filters via CSS `filter: saturate()`
- Motifs via inline SVG/CSS gradients
- Images by item id URLs (`/Items/{id}/Images/Backdrop`, etc.)
- **Single try/catch** wrapper: crash → remove injected elements → stock view shows through

**jellyfin.sh change:** Add a second JavaScript Injector config entry following the same pattern as section 9:

```bash
showcase_js_id="$js_id"  # same plugin
showcase_name="Branding Showcase"
# ... read jellyfin-web-showcase.js, push into CustomJavaScripts array
```

**Stability measures from DOM audit:**
1. Separate JS file isolates risk (showcase breakage ≠ flair breakage)
2. DOM version probe catches structural changes early
3. Replace innerHTML wholesale = 1 fragile selector vs 5
4. Pin Jellyfin image tag in `docker-compose.yml` to prevent surprise upgrades
5. Document every selector with version tested for easy upgrade diffing

### 5E. IaC Provisioning

All web changes must be provisioned from `movie-server` so they survive container recreate:

| # | File | Change |
|---|------|--------|
| 1 | `jellyfin.sh` section 6 (L295-312) | Replace CSS block with Canyon CSS |
| 2 | `jellyfin.sh` | Add login logo upload |
| 3 | `jellyfin.sh` section 9 (L530-565) | Add showcase JS entry |
| 4 | `jellyfin.sh` section 7 | Ensure CSS push triggers Jellyfin restart (already does `docker restart jellyfin`) |

---

## Phase 6 — Optional Flourishes

### 6A. Splash Motion

| # | File | Change | Perf Gate |
|---|------|--------|-----------|
| 1 | `SplashFragment.kt` | Add per-theme single-beat animation. Canyon: 2 alpha dips then hold (~600ms). Reel One: disc translate + script fade (~500ms). Matinee: scale 1.03→1.00. Marquee: hairline scaleX 0→1. | Must not delay `StartupActivity` navigation. Single view, alpha/translate only. Cut any beat that costs frames. |

### 6B. Stretch: Director Glow

| # | File | Change |
|---|------|--------|
| 1 | `Top100Showcase.kt` / `LedgerRow.kt` | When a pantheon panel (rank 1–10) is focused, glow the ledger rows of that director's other entries. Requires maintaining a director→entries mapping in the showcase data. Glow = rank numeral text color shifts to theme accent at ~40% opacity. |

---

## Cross-Cutting Concerns

### Pref Migration
**RESOLVED.** `SharedPreferenceStore.getEnum()` at line 67-73 falls back to `preference.defaultValue` when stored value doesn't match. No migration code needed.

### APK Size
8 font files add ~1-1.6MB. Check after Phase 2. Subset to Latin if needed.

### `applicationId` Invariant
`applicationId = "org.jellyfin.androidtv"` (in `app/build.gradle.kts:18`). **DO NOT CHANGE** — forces reinstall + data loss on Fire Stick.

### Screensaver Invariant
`integration/dream/` structure untouched. Only `DreamContentLogo.kt` inherits the new wordmark via `app_logo`. No other dream files need changes.

### Background Invariant
`AppBackground.kt` reads `R.color.background_filter` = `#94101010`. Must change to `R.attr.backdropDimColor` (per-theme hue-biased near-black at same ~58% alpha). One-line change via Pattern 1.

### Build/Deploy
After any phase: sideload APK via `adb install -r app-release.apk`. For web changes: `make provision s=jellyfin`. `make test` to verify service health.

---

## File Inventory (Complete)

### androidtv — Files to Create (28)

| File | Phase | Purpose |
|------|-------|---------|
| `res/drawable/wordmark_canyon.xml` | 1 | Canyon wordmark VectorDrawable |
| `res/drawable/wordmark_matinee.xml` | 1 | Matinee wordmark |
| `res/drawable/wordmark_reelone.xml` | 1 | Reel One wordmark |
| `res/drawable/wordmark_marquee.xml` | 1 | Marquee wordmark |
| `res/drawable/curated_pill_canyon.xml` | 3 | Canyon rank pill background |
| `res/drawable/curated_pill_matinee.xml` | 3 | Matinee rank pill |
| `res/drawable/curated_pill_reelone.xml` | 3 | Reel One rank pill |
| `res/drawable/curated_pill_marquee.xml` | 3 | Marquee rank pill |
| `res/values/theme_movienight_canyon.xml` | 2 | Canyon theme |
| `res/values/theme_movienight_matinee.xml` | 2 | Matinee theme |
| `res/values/theme_movienight_reelone.xml` | 2 | Reel One theme |
| `res/values/theme_movienight_marquee.xml` | 2 | Marquee theme |
| `res/font/josefin_sans.ttf` | 2 | Canyon UI face |
| `res/font/josefin_sans_bold.ttf` | 2 | Canyon UI face bold |
| `res/font/oswald.ttf` | 2 | Matinee UI face |
| `res/font/oswald_bold.ttf` | 2 | Matinee UI face bold |
| `res/font/archivo.ttf` | 2 | Reel One UI face |
| `res/font/archivo_bold.ttf` | 2 | Reel One UI face bold |
| `res/font/jost.ttf` | 2 | Marquee UI face |
| `res/font/jost_bold.ttf` | 2 | Marquee UI face bold |
| `java/.../util/ThemeRoulette.kt` | 2 | Process-lifetime roulette singleton |
| `java/.../ui/top100/ShowcaseFragment.kt` | 4 | Fragment wrapper for Compose showcase |
| `java/.../ui/top100/Top100Showcase.kt` | 4 | Main showcase Compose screen |
| `java/.../ui/top100/PantheonPanel.kt` | 4 | Full-bleed panel composable |
| `java/.../ui/top100/EraTreatment.kt` | 4 | Era filters + frames |
| `java/.../ui/top100/Motifs.kt` | 4 | Genre/franchise overlays |
| `java/.../ui/top100/GalleryCard.kt` | 4 | 2-col wide cards |
| `java/.../ui/top100/LedgerRow.kt` | 4 | Dense rows |

### androidtv — Files to Create (Phase 4, optional)

| File | Purpose |
|------|---------|
| `java/.../ui/top100/WatchlistShowcase.kt` | Unranked variant |

### androidtv — Files to Modify (27)

| File | Phase | Change |
|------|-------|--------|
| `res/drawable/app_logo.xml` | 1 | Replace with Canyon wordmark |
| `res/drawable-v24/app_logo.xml` | 1 | Replace with Canyon wordmark |
| `res/drawable/app_icon_background.xml` | 1 | Teal fill |
| `res/drawable/app_icon_foreground.xml` | 1 | MN monogram |
| `res/drawable/app_icon_foreground_monochrome.xml` | 1 | MN monochrome |
| `res/drawable/app_banner_background.xml` | 1 | Teal fill |
| `res/drawable/app_banner_foreground.xml` | 1 | Neon wordmark + ✶ |
| `res/mipmap-*/app_icon.png` (5 files) | 1 | Regenerate rasters |
| `res/mipmap-*/app_banner.png` (5 files) | 1 | Regenerate rasters |
| `res/values/logo.xml` | 1 | Canyon brand colors |
| `res/values/colors.xml` | 2 | Remove jellyfin_blue/purple |
| `res/values/attrs.xml` | 2 | Add brandWordmark, brandFontFamily, backdropDimColor, curatedPillBackground |
| `res/values/theme_jellyfin.xml` | 2 | Replace as Theme.MovieNight base |
| `res/values/styles.xml` | 3 | Add fontFamily + letterSpacing to Widget.Jellyfin.Row.Header |
| `res/drawable/ic_bookmark.xml` | 2 | Theme-aware fill color |
| `res/drawable/curated_rank_pill.xml` | 3 | Deprecated by per-theme pills (keep as fallback) |
| `res/layout/view_card_legacy_image.xml` | 3 | Rank pill background + font |
| `res/layout/view_row_details.xml` | 3 | Rank pill background + font |
| `java/.../preference/constant/AppTheme.kt` | 2 | 5-value enum |
| `java/.../util/ActivityThemeExtensions.kt` | 2 | 5-theme mapping + roulette |
| `java/.../preference/UserPreferences.kt` | 2 | Default → ROULETTE |
| `java/.../ui/base/colorScheme.kt` | 2 | Per-theme Compose colors |
| `java/.../ui/base/typography.kt` | 2 | Per-theme fonts |
| `java/.../ui/base/shapes.kt` | 2 | Per-theme corner radii |
| `java/.../ui/home/HomeSpotlight.kt` | 3 | Theme scrim + button |
| `java/.../ui/shared/toolbar/MainToolbar.kt` | 3 | Active button colors + font + nav to showcase |
| `java/.../ui/background/AppBackground.kt` | 2 | backdropDimColor attr |

### androidtv — Files to Delete (3)

| File | Phase | Reason |
|------|-------|--------|
| `res/values/theme_emerald.xml` | 2 | Stock theme removed |
| `res/values/theme_mutedpurple.xml` | 2 | Stock theme removed |
| `res/drawable/moviebg.jpg` | 2 | Only Emerald used it |

### movie-server — Files to Modify (3)

| File | Phase | Change |
|------|-------|--------|
| `scripts/provision/jellyfin.sh` | 5 | Replace CSS (§6), add login logo, add showcase JS entry (§9) |
| `controller/web/style.css` | 5 | Recolor accent (optional) |

### movie-server — Files to Create (3-4)

| File | Phase | Purpose |
|------|-------|---------|
| `scripts/provision/jellyfin-web-showcase.js` | 5 | Top 100 showcase JS (separate from flair) |
| `docs/branding/FONT-PIPELINE.md` | — | Font production pipeline (already written) |
| `docs/branding/cover-top100.png` | 4 | Playlist cover art |
| `docs/branding/cover-watchlist.png` | 4 | Playlist cover art |

---

## Feasibility Risks (Ranked, post deep-dive)

| # | Risk | Severity | Status | Mitigation |
|---|------|----------|--------|------------|
| 1 | **Vector production pipeline** — converting PalmCanyonDrive.otf to 4 wordmark VectorDrawables + MN monogram + banner layers is the critical creative path. | **High** | Open | Start Phase 1 with Canyon wordmark only. Use Android Studio's Vector Asset importer as a fallback. If fontTools output is clean, pipeline is automatable. |
| 2 | **Fire Stick performance** — Top 100 showcase with full-bleed backdrops + era filters + motifs must scroll smoothly. | **High** | Open | Half-res decoding, max 3 resident images, Coil explicit size hints. Test on real hardware after Phase 4 skeleton. |
| 3 | **Web DOM fragility** — showcase JS depends on Jellyfin web's internal DOM structure. | **Medium** | Accepted | Existing flair JS has same dependency. Wrap in try/catch; degrade to stock playlist view. |
| 4 | **Preference migration** — stored `AppTheme=DARK/EMERALD/MUTED_PURPLE` don't exist in new enum. | **Medium** | **RESOLVED** | `SharedPreferenceStore.getEnum()` falls back to default (verified at lines 67-73). |
| 5 | **APK size** — 4 font families add ~1-1.6MB. | **Low** | Open | Subset to Latin if needed. Check after Phase 2. |
| 6 | **TMDB collection data** — showcase needs franchise names for motifs. `BaseItemDto` may not carry this. | **Low** | **MITIGATED** | Fall back to genre motifs. Use `GET /Movies/{id}/Collections` for enrichment. |
| 7 | **Compose theme attrs** — must be readable from both XML and Compose. | **Low** | **RESOLVED** | `obtainStyledAttributes` pattern in `AppBackground.kt` works for both. |
| 8 | **Navigation — no Compose destination variant** | **Medium** | **RESOLVED** | Create `ShowcaseFragment` using `content {}` extension (Pattern 2). Navigate via `Destination.Fragment`. |
| 9 | **Branding API login logo** | **Medium** | **RESOLVED** | Upload via `POST /Branding/BrandingImage` (multipart, type=0) or inject via `LoginDisclaimer` HTML. |
| 10 | **Row header ornaments** | **Low** | **RESOLVED** | Prepend Unicode to `HeaderItem.getName()` string. `RowHeaderView extends TextView` supports it. |
| 11 | **Rank pill drawable attr in XML** | **Low** | **RESOLVED** | `?attr/curatedPillBackground` works in `android:background`. `?attr/colorAccent` works in `<stroke>` on API 21+. |
| 12 | **colorFilter on VectorDrawable** | **Medium** | **RESOLVED** | Cannot recolor multi-color sources. Must create 4 separate wordmark VectorDrawables. |
| 13 | **ItemListFragment replacement** | **Low** | **RESOLVED** | `content {}` pattern + `Destination.Fragment` wrapper. Non-curated playlists keep `ItemListFragment`. |
| 14 | **TMDB collection membership** | **Low** | **MITIGATED** | Genre fallback is accepted. Enrichment via `/Movies/{id}/Collections` optional. |

---

## Dependency Graph

```
Phase 1 (Canyon identity)
  ├─ 1A: Wordmark vectors → app_logo
  ├─ 1B: Launcher icon
  ├─ 1C: TV banner
  ├─ 1D: Splash cleanup
  └─ 1E: Screensaver (auto from 1A)

Phase 2 (Theme system) — depends on 1A (brandWordmark attr needs wordmark drawables)
  ├─ 2A: Theme XMLs
  ├─ 2B: New attrs
  ├─ 2C: AppTheme enum + roulette
  ├─ 2D: Fonts
  ├─ 2E: Compose bridge
  ├─ 2F: Recolor colors.xml
  └─ 2G: Pref picker UI + strings

Phase 3 (Component dialects) — depends on Phase 2 (reads theme tokens)
  ├─ 3A: Toolbar active states
  ├─ 3B: Hero spotlight
  ├─ 3C: Rank pills ×4
  ├─ 3D: Row headers + ornaments
  ├─ 3E: Card fonts
  └─ 3F: Background dim color

Phase 4 (Top 100 showcase) — depends on Phase 2 + 3
  ├─ 4A-4B: ShowcaseFragment + Compose screen
  ├─ 4C-4D: Data layer
  └─ 4F: Playlist covers (movie-server)

Phase 5 (Strings + Web) — independent of TV phases (can run in parallel)
  ├─ 5A: De-Jellyfin strings
  ├─ 5B: Custom CSS (movie-server)
  ├─ 5C: Login logo
  ├─ 5D: Showcase JS
  └─ 5E: IaC provisioning

Phase 6 (Flourishes) — depends on Phase 1-4
  ├─ 6A: Splash motion
  └─ 6B: Director glow (stretch)
```
