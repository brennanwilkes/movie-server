# Font Production Pipeline

**Purpose:** Convert `PalmCanyonDrive.otf` into 4 themed Android VectorDrawable wordmark XMLs + subset 4 UI font families for APK bundling.

**Tools on this system:** fontTools 4.57.0, svg2vd (npm), pyftsubset, Inkscape 0.92.5

---

## Part 1: Wordmark VectorDrawables

### Pipeline

```
PalmCanyonDrive.otf
       │
       ▼
  fontTools (SVGPathPen)
  - TTFont loads .otf
  - Extracts CFF glyph outlines as SVG path data
  - Y-flip + scale to 252×72dp viewport + kerning
       │
       ├─[gradient needed]─► Direct VectorDrawable generation (Python)
       │                     Outputs XML with <aapt:attr> gradient blocks
       │
       └─[simple fill]────► Intermediate SVG file
                                   │
                                   ▼
                             svg2vd (npm)
                             Optimizes path data → VectorDrawable XML
                                   │
                                   ▼
                             Post-process: viewportWidth/Height, width/height dp
```

### Why 4 Separate Files (Not One Recolored)

`VectorDrawable.colorFilter` only works when the source uses `#000000` fills. The wordmarks use multi-color fills:
- Canyon: cream `#F5EEDC` + turquoise `#47C4B8` + orange `#F26D3D` (3 colors)
- Matinee: amber `#D98E32` + red `#A62B1F` (2 colors)
- Reel One: vermilion `#E8442E` only (1 color — this one COULD use colorFilter, but consistency with the others is simpler)
- Marquee: gold `#C9A227` + cream `#F2E6CB` (2 colors)

Each wordmark is an independent VectorDrawable with hardcoded theme colors.

### Proof-of-Concept Results

Generated "Movie Night" text using the fontTools direct pipeline:

| Metric | Value | vs Existing `app_banner_foreground.xml` |
|--------|-------|----------------------------------------|
| Paths | 8 (one per character) | 10 (icon + 8 letters + extras) |
| Total segments | 370 | 457 |
| File size (white fill) | 8,030 B | 9,362 B |
| File size (gradient fill) | 12,201 B | 9,362 B |
| Gradients | 8 (one per path) | 2 (shared) |
| Valid VectorDrawable | Yes | Yes |

The generated vectors are **comparable in complexity** to the existing banner. Each gradient path duplicates its `<aapt:attr>` block (no `<defs>` in VectorDrawable) — this is normal.

### Script Location

The proof-of-concept script is at `/tmp/vectordrawable_output/`. The final production script should live at `docs/branding/build-wordmarks.py`.

### Steps

1. Load `PalmCanyonDrive.otf` via `fontTools.ttLib.TTFont`
2. For each target string ("Movie Night", "Matinée", "Reel One", "Marquee"):
   - Use `SVGPathPen` to extract glyph outlines for each character
   - Apply coordinate transform: Y-flip (font Y-up → Android Y-down), scale to target viewport, kerning via x-advance
   - Generate VectorDrawable XML with `<aapt:attr>` gradient blocks per path
3. Write 4 XML files to `androidtv/app/src/main/res/drawable/wordmark_{canyon,matinee,reelone,marquee}.xml`
4. Copy Canyon wordmark as `app_logo.xml` (both `drawable/` and `drawable-v24/`)

### Font Limitation

`PalmCanyonDrive.otf` is a Trial version with only 53 glyphs: A-Z, a-z, space. No digits, no punctuation, no accented characters. This is sufficient for the 4 wordmark strings. If the Marquee wordmark needs an accent (e.g., "Marquee" vs "Marquée"), the font can't render it — use ASCII only.

---

## Part 2: UI Font Subsetting

### 4 Font Families

| Family | Used By | APK Role |
|--------|---------|----------|
| Josefin Sans | Canyon theme UI text | Primary UI face |
| Oswald | Matinee theme UI text | Condensed display face |
| Archivo | Reel One theme UI text | Monospace-adjacent display face |
| Jost | Marquee theme UI text | Geometric sans UI face |

### Subset Command

```bash
pyftsubset input.ttf \
  --unicodes="U+0000-007F,U+00A0-00FF,U+0100-017F" \
  --layout-features="*" \
  --output-file=output.ttf
```

Latin Extended (U+0000-017F) covers: English, all Western/Central/Eastern European languages, Vietnamese. This is the right balance for a media app with international content.

### Size Impact

| Subset | Raw Total (8 files) | Compressed in APK | % of 30 MB APK |
|--------|--------------------|--------------------|-----------------|
| No subsetting | 614 KB | ~272 KB | 0.90% |
| **Latin Extended (recommended)** | **291 KB** | **~135 KB** | **0.45%** |
| Basic Latin only | 116 KB | ~65 KB | 0.22% |

Basic Latin is too aggressive — misses accented characters common in movie titles (é, ñ, ü, etc.).

### Steps

1. Download static TTFs from Google Fonts CDN (`fonts.gstatic.com`)
2. Subset each with `pyftsubset` as above
3. Copy to `androidtv/app/src/main/res/font/`:
   - `josefin_sans_regular.ttf`, `josefin_sans_bold.ttf`
   - `oswald_regular.ttf`, `oswald_bold.ttf`
   - `archivo_regular.ttf`, `archivo_bold.ttf`
   - `jost_regular.ttf`, `jost_bold.ttf`
4. Verify APK size delta after build

### Wire Per Theme

In each theme's XML, set `android:fontFamily` on text appearance styles:
```xml
<item name="android:fontFamily">@font/josefin_sans</item>
```

In Compose, read font resource ID from `brandFontFamily` attr → `ContextCompat.getFont()` → `FontFamily` in `JellyfinTheme`:
```kotlin
val fontFamily = FontFamily(
    Font(context.resources.getResourceFont(R.attr.brandFontFamily)),
    Font(context.resources.getResourceFont(R.attr.brandFontFamily), FontWeight.Bold)
)
```
