# Movie Night — Branding Guidelines v2

Four themes, one app. Each theme is a complete visual language — not just a palette swap.
These guidelines define every DOM element, spacing convention, and visual flourish.

---

## Canyon — "Motel Neon at Dusk"

**Feel**: Warm, inviting, retro-modern. A desert motel sign glowing turquoise against a dark teal sky. Rounded, soft, glowing.

### Palette

| Token | Hex | Role |
|-------|-----|------|
| `--canyon-night` | `#0D1B2A` | Deepest background — true desert night sky |
| `--canyon-dusk` | `#162A35` | Card surfaces — one step lighter |
| `--canyon-teal` | `#47C4B8` | Neon primary accent |
| `--canyon-teal-glow` | `#5FFFF0` | Neon highlight (hot core) |
| `--canyon-orange` | `#F26D3D` | Starburst accent — rare (<5% surface area) |
| `--canyon-cream` | `#F5EEDC` | Primary text |
| `--canyon-sand` | `#C9B99A` | Secondary/muted text |
| `--canyon-rust` | `#8B4513` | Deep warm accent (optional) |

### Typography

| Role | Font | Weight | Treatment |
|------|------|--------|-----------|
| Wordmark/splash h1 | Palm Canyon Drive | 400 | Cream, neon text-shadow glow |
| Section h2 | Poppins/system-ui | 650 | Cream, -0.01em tracking |
| h3/h4 labels | Poppins/system-ui | 600 | Uppercase, 0.18em tracking, 11px, sand |
| Body | Poppins/system-ui | 400 | 15px/1.55, cream primary, sand muted |
| Nav/buttons | Poppins/system-ui | 700 | Uppercase optional |

### DOM Element Styling

| Element | Styling |
|---------|---------|
| **h1** | Script font, neon text-shadow (5-layer: 1px white core + turquoise bloom + outer spill) |
| **h2** | Geometric sans, 650 weight, tight tracking |
| **h3/h4** | Uppercase section labels, wide tracking, sand color |
| **p** | System font, cream primary, sand for secondary text |
| **hr** | Invisible — use spacing. If needed: 1px `#2c261e` |
| **border-radius** | 8px cards, 999px buttons/pills, 6px inputs |
| **buttons** | Pill shape, turquoise bg, dark text, 800 weight, 4-layer glow shadow |
| **cards** | `#162A35` bg, 1px `#2c261e` border, 8px radius, hover: turquoise glow |
| **scrollbar** | 6px wide, turquoise thumb `rgba(71,196,184,.35)` |
| **focus ring** | Turquoise outline + glow shadow |
| **active nav** | Turquoise pill bg, dark text, 700 weight, glow shadow |
| **badges/pills** | Turquoise 1px stroke, 0.55cqw radius, glow shadow |

### Visual Flair

- **Starburst** ✶ glyph in sunset orange as section marker
- **Neon text-shadow** on h1: 5-layer stack (white core → turquoise → bloom → atmospheric → far spill)
- **Subtle neon pulse** animation (3s ease-in-out infinite, on wordmark only)
- **Desert dusk gradient** background: `linear-gradient(180deg, #0D1B2A, #163A4A 50%, #6B3A1A)`
- **Googie arrows** → as navigation indicators
- **Atomic orbital dots** — small glowing circles as decorative accents
- **Card hover glow** — turquoise box-shadow with 4-layer depth

### Button States

```
Default:  turquoise bg, dark text, glow shadow
Hover:    deeper glow, slight scale(1.02)
Active:   scale(0.98), reduced glow
```

---

## Matinee — "Pulp Paperback at the Drive-In"

**Feel**: Bold, condensed, print-energy. Everything squared-off and stamp-like. Amber warmth with a hard red shadow. No flourishes.

### Palette

| Token | Hex | Role |
|-------|-----|------|
| `--matinee-leather` | `#1C1209` | Background — aged leather |
| `--matinee-leather-mid` | `#2A1E14` | Card surfaces |
| `--matinee-amber` | `#D4912B` | Primary accent — poster ink |
| `--matinee-red` | `#B52A1A` | Serial red — shadows, secondary |
| `--matinee-paper` | `#E2D1AD` | Primary text — aged paper |
| `--matinee-cream` | `#F5ECD7` | High-emphasis text |
| `--matinee-rule` | `#7A6B5A` | Dividers, borders, muted UI |
| `--matinee-ink` | `#1E1410` | Near-black for inverted sections |

### Typography

| Role | Font | Weight | Treatment |
|------|------|--------|-----------|
| Display h1 | Bebas Neue / Oswald | 400/800 | Uppercase, 0.02em tracking, red offset shadow |
| Section h2 | Oswald | 800 | Uppercase, 0.1em tracking, paper color |
| h3/h4 labels | Oswald | 500 | Uppercase, 0.15em tracking, muted |
| Body | system-ui | 400 | Paper color, 1.55 line-height |

### DOM Element Styling

| Element | Styling |
|---------|---------|
| **h1** | Condensed display, amber, **hard red text-shadow offset** (3px 3px 0 #B52A1A, zero blur) |
| **h2** | Condensed, uppercase, paper color |
| **h3/h4** | Condensed labels, wide tracking, muted rule color |
| **p** | System font, paper color |
| **hr** | **Red gradient rule**: `linear-gradient(90deg, transparent, #B52A1A, transparent)` — 2px |
| **border-radius** | 0px cards, 2px buttons, 0px images |
| **buttons** | Amber slab, 2px radius, condensed uppercase, **red hard-offset box-shadow** (3px 3px 0) |
| **cards** | `#1C1209` bg, 0px radius, optional 1px `#7A6B5A` border |
| **scrollbar** | Amber-tinted, squared |
| **focus ring** | Solid amber outline |
| **active nav** | Amber bg, dark text, no radius, condensed uppercase |
| **badges/pills** | Amber stroke, 0 radius, condensed numerals |

### Visual Flair

- **▸ tick** glyph in serial red as section marker
- **Litho-offset shadow** on big type: hard 3px red offset, zero blur
- **Thick-thin double rules** for section breaks
- **Halftone dot texture** at 6% opacity on backgrounds: `radial-gradient(circle, rgba(181,42,26,0.08) 1px, transparent 1px) 12px 12px`
- **Paper grain overlay** via SVG feTurbulence at 3-5% opacity
- **Condensed uppercase** as default text treatment for all chrome
- **Button hard-shadow** on hover: plates "re-register" (shadow slides)
- **Letterpress debossed** effect on mid-tone surfaces

### Button States

```
Default:  amber bg, red hard-offset shadow
Hover:    shadow offsets further (-1px, -1px translate)
Active:   plates compress (shadow shrinks, button translates into shadow)
```

---

## Reel One — "Saul Bass Opening Credits"

**Feel**: Flat, graphic, bold. True black with one punch of vermilion. Cut-paper geometry. No shadows, no gradients, no blur.

### Palette

| Token | Hex | Role |
|-------|-----|------|
| `--reel-black` | `#0B0B0B` | Surface — true flat black |
| `--reel-vermilion` | `#E34234` | Primary accent — the ONE punch |
| `--reel-paper` | `#F2EFE6` | Light surface / text on dark |
| `--reel-warm-grey` | `#8D8A80` | Muted text / secondary |
| `--reel-charcoal` | `#111111` | Card background (lifted from black) |
| `--reel-deep-red` | `#D7261E` | Hover state for vermilion |
| `--reel-dark-grey` | `#5B5248` | Muted text on light bg |

### Typography

| Role | Font | Weight | Treatment |
|------|------|--------|-----------|
| Display h2 | Archivo / Oswald | 700/800 | Lowercase, -0.02em tracking, paper white |
| Section h3/h4 | Archivo | 600 | Lowercase, wide tracking, warm grey |
| Body | Archivo | 400 | Paper white primary, warm grey muted |
| Credits/captions | Archivo | 600 | Uppercase, 0.1em tracking |

### DOM Element Styling

| Element | Styling |
|---------|---------|
| **h1** | Palm Canyon Drive script (wordmark only) |
| **h2** | Archivo 700, lowercase, paper white, no decoration |
| **h3/h4** | Lowercase, bold, warm grey |
| **p** | Archivo, paper white, warm grey secondary |
| **hr** | None preferred. If needed: 1px #333 |
| **border-radius** | **0px everywhere** — the sharpest of the four |
| **buttons** | Flat vermilion block, 0 radius, bold, white text. No glow, no shadow |
| **cards** | `#111111` bg, 0 radius, 2px solid `#2A2725` border |
| **scrollbar** | Vermilion thumb, squared |
| **focus ring** | Vermilion solid, no glow |
| **active nav** | Vermilion bg, white text, lowercase, 700 weight, 0 radius |
| **badges/pills** | Vermilion 1px stroke, 0 radius, no glow |

### Visual Flair

- **■ vermilion square** glyph as section marker
- **Diagonal vermilion strip** across sections (4px, rotated -3deg)
- **Crosshair / target** motif (CSS-only, vermilion)
- **Vermilion disc** — large flat circle as geometric motif behind wordmark
- **Colour blocking** as the ONLY differentiation strategy (no shadows, no blur)
- **Accent strip** on featured cards: `border-top: 4px solid vermilion`
- **One vermilion element per viewport** — restraint is the point
- **Cut-paper clip-path** on special cards: `clip-path: polygon(0 0, 100% 0, 100% calc(100% - 20px), 0 100%)`

### Button States

```
Default:  vermilion bg, paper text
Hover:    deeper red (#D7261E) — darker, not lighter
Active:   INVERT — black bg, vermilion text (dramatic)
```

---

## Marquee — "Old Hollywood Premiere"

**Feel**: Formal, elegant, restrained. Gold-leaf on black velvet. Hairline rules, diamond glyphs, wide-tracked capitals. The most ceremonial.

### Palette

| Token | Hex | Role |
|-------|-----|------|
| `--marquee-black` | `#0E0B06` | House-black — warm, not cool |
| `--marquee-surface` | `#171311` | Card backgrounds |
| `--marquee-gold` | `#D4AF37` | Primary gold — headings |
| `--marquee-gold-muted` | `#C9A227` | Secondary gold — borders, rules |
| `--marquee-gold-border` | `#8F6B2E` | Hairline rules, input borders |
| `--marquee-gold-muted-text` | `#B79F77` | Secondary text, disabled |
| `--marquee-cream` | `#F2E6CB` | Body text |
| `--marquee-champagne` | `#F4E9D8` | Headings, high-emphasis |
| `--marquee-red` | `#8B1A1A` | Alerts / destructive |
| `--marquee-red-surface` | `#C4544C` | Error surfaces |

### Typography

| Role | Font | Weight | Treatment |
|------|------|--------|-----------|
| Wordmark h1 | Palm Canyon Drive | 400 | Gold gradient text-fill (5-stop metallic) |
| Display h2 | Playfair Display / Jost | 700/500 | Uppercase, 0.1em tracking, champagne |
| Section h3/h4 | Jost | 500 | Uppercase, 0.15em tracking, muted gold |
| Body | system-ui / Cormorant Garamond | 400 | Cream, 1.6 line-height |
| Captions | Jost | 300 | Uppercase, 0.2em tracking |

### DOM Element Styling

| Element | Styling |
|---------|---------|
| **h1** | Script font, **gold gradient text-fill** (`linear-gradient(135deg, #BF953F, #FCF6BA, #B38728, #FBF5B7, #AA771C)`, background-clip: text) |
| **h2** | Serif or geometric sans, uppercase, wide tracking, champagne |
| **h3/h4** | Uppercase, very wide tracking (0.15em+), muted gold |
| **p** | System font, cream primary |
| **hr** | **Gold hairline rules**: 1px, fading at edges via gradient. Double rules for formal sections |
| **border-radius** | 2-3px — slightly more than Reel One, less than Canyon |
| **buttons** | Gold bg, 2px radius, uppercase, 0.22em tracking, faint halo shadow |
| **cards** | `#171311` bg, 3px radius, 1px `rgba(143,107,46,0.25)` border, subtle top-left gradient |
| **scrollbar** | Gold-tinted thumb |
| **focus ring** | Gold hairline stroke |
| **active nav** | Gold bg, dark text, uppercase, wide tracking |
| **badges/pills** | Gold 1px hairline, 0.4cqw radius, wide-tracked numerals |

### Visual Flair

- **◆ diamond** glyph in gold as section marker
- **Hairline rules** flanking the wordmark (fading at edges)
- **◆ ◆ ◆** diamond dividers between sections
- **Gold gradient text-fill** on h1 — the single most distinctive element
- **Art Deco geometric patterns** at low opacity:
  - Chevron dividers: `linear-gradient(135deg, gold 33%, transparent 33%)`
  - Crosshatch overlay: 3-5% opacity diagonal lines
  - Diamond grid: repeating rotated squares
  - Sunburst: `repeating-conic-gradient` behind hero
- **Stepped corner L-brackets** on cards (CSS pseudo-elements)
- **Triple parallel rules** for formal section breaks
- **Vignette effect** on body: `radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.3))`
- **Paper texture overlay** at 2-3% opacity
- **Generous padding** (2.5-3rem cards, 5rem+ section breaks) — ceremony requires space

### Button States

```
Default:  gold bg, dark text, faint halo
Hover:    brighter gold, increased halo
Active:   scale(0.98), reduced halo
```

---

## Cross-Theme: Universal Element Matrix

| Element | Canyon | Matinee | Reel One | Marquee |
|---------|--------|---------|----------|---------|
| **h1 font** | Script (Palm Canyon Drive) | Condensed display (Bebas/Oswald) | Script (wordmark only) | Script with gold gradient fill |
| **h2 font** | Geometric sans | Condensed sans | Grotesque (Archivo) | Serif or geometric sans |
| **border-radius** | 8px | 0-2px | 0px | 2-3px |
| **letter-spacing** | Normal (0.02em) | 0.02em display, 0.15em labels | Normal to -0.02em display | 0.1em+ (wide, always) |
| **text-transform** | None (script), uppercase labels | Uppercase everywhere | Lowercase (display), uppercase captions | Uppercase everywhere |
| **Section marker** | ✶ (orange, glowing) | ▸ (red, hard) | ■ (vermilion square) | ◆ (gold diamond) |
| **Button style** | Glowing pill | Flat slab + red offset | Flat block, no shadow | Gold + faint halo |
| **Card hover** | Turquoise glow + scale | None / snap | Border colour change | Subtle gold border |
| **Box shadows** | Multi-layer turquoise glow | Hard red offset (no blur) | None | Faint gold halo |
| **text-shadow** | Neon glow (5-layer) | Litho offset (hard, 0 blur) | None | None (gradient fill replaces) |
| **Scrollbar** | Turquoise | Amber | Vermilion | Gold |
| **Focus outline** | Turquoise + glow | Amber hard | Vermilion solid | Gold hairline |
| **Background** | Desert night gradient | Warm leather radial | Flat true black | Warm black + vignette |
| **Muted colour** | Sand/teal | Faded warm grey | Warm grey | Muted gold |
| **Decorative rule** | None (spacing) | Red gradient | None | Gold hairline fade |
| **Texture overlay** | None | Paper grain / halftone | None | Crosshatch / paper |
| **Spinner colour** | Turquoise | Amber | Vermilion | Gold |
| **Badge glow** | Yes (turquoise) | No | No | Faint (gold) |
| **Motion** | Fade + slide-up | Snap | Linear, hard cuts | Elegant fade |
| **Extra flourish** | Neon pulse, starburst | Double rules, letterpress | Diagonal strip, disc | Diamonds, sunburst, vignette |
