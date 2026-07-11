# Branding — Next Steps (from Brennan's on-device review, 2026-07-11)

State: fork `70d57c85d` deployed; movie-server `92905ed` provisioned. Everything below is agreed feedback + root-cause where known. Read SPEC.md first; this file is the work queue.

## 1. Roulette picks the same theme every time — ROOT CAUSE KNOWN
`ThemeRoulette.choice` is `by lazy` = once per **process**, but Fire OS keeps the process alive for days; "launching" usually just resumes it. Fix: re-roll on cold start AND when returning to foreground after ≥30 min background (ProcessLifecycleOwner); bias the draw to exclude the previous theme (persist last draw in prefs) so a re-roll always visibly changes. Activities need recreate on new draw (or only roll in StartupActivity path).

## 2. Home page "no glam" — CORRECT, Phase 3 was only ~20% done
What's actually themed today: row-header font/color, rank pill, hero scrim+Play, backdrop dim. Missing (implement, per prototype tabs 1–4):
- **Compose typography bridge**: JellyfinTheme.typography must use the theme's FontFamily (read `brandFontFamily` attr → Font resource). Today Compose text is all default.
- **Card under-titles/runtime** (CardPresenter/LegacyImageCardView TextViews): theme font via textAppearance.
- **Row-header ornaments**: ✶/▸/■/◆ prefix on curated rows, per-theme header case/tracking (Matinee UPPERCASE condensed, Reel One lowercase, Marquee wide-tracked caps).
- **Button shapes per theme**: ButtonDefaults.Shape from `buttonRounding` attr (Canyon pill / Matinee slab / Reel One square / Marquee 2dp) — today everything is default pill.
- **Focus ring dialect on cards**: glow for Canyon, square thick for Reel One etc. (leanback focus drawables via theme attrs).
- **Themed HRs/rules**: subtle accent hairlines between home sections (Marquee deco rules, Matinee red rule, etc.) — chrome only, never over art.
- **Detail page (FullDetailsFragment / view_row_details.xml): completely unthemed.** Buttons, genre text, fonts, the info strip → theme attrs. The backdrop/art handling stays untouched (it's good — invariant).

## 3. Top 100 pantheon — agreed on all four
- **Slow**: images requested at 960w on a 1GB stick. Drop to fillWidth ~720, add ground-color placeholder + crossfade, consider prefetch of first 3.
- **Every panel looks the same / not film-dependent**: implement SPEC §6.5 motifs (franchise via TMDB collection → gunbarrel dots; genre → noir blinds / map contours / deco frame) + composition variety (§6.3: poster inset, logo scale, motif corner by rank parity/genre). **Billing block should be earned, not uniform**: show director/cast lines only when notable — heuristic ideas (pick one): person appears ≥2 more times in the library; or item's TMDB cast order includes a person whose name matches another Top-100 credit; or simply: director always, cast only if the film's people list has ≥3 actors with images (proxy for "known"). City of God → no billing lines, Pulp Fiction → full block. Cheap + data-driven, no hardcoding.
- **Vertical rhythm wrong** (first panel ⅓ screen, next ⅔): focus-scroll offset in the LazyColumn. Make pantheon panels a consistent tall height (~60% viewport), and control bring-into-view so the focused panel sits full and aligned; #1 should open filling the screen.
- **Missing "Top 100" splash header row**: add a themed header item at list top — playlist name rendered big in the theme dialect (this is real data, not invented copy). Should feel like the theme's title card.

## 4. Gallery 11–50 (and Watchlist/all playlists) — agreed
- **2-column grid** (11|12 / 13|14 …), half-width cards → much better backdrop aspect (~16:7 vs current ultra-wide crop).
- **Use the clearlogo asset** instead of plain-text title (text fallback when absent).
- Watchlist and any other playlist showcases use the same 2-col layout.

## 5. Era frames / saturation / focus borders "not seen" — dial up
They exist in code (eraFor(): silver ≤1954 sat 0.18, technicolor ≤1975 sat 1.25, amber frame ≤1999; gallery focus = 2dp accent border) but are too subtle and were judged while backdrops hadn't loaded. Increase: frame 2dp + higher alpha + tighter inset; focus border 3dp + outer glow (per-theme); verify saturation visibly reads on a loaded silver-era backdrop. If still meek, add the era treatment to the frame + numeral together.

## 6. Web — almost nothing visible: DIAGNOSE FIRST
Observed: only the header logo changed; sidebar/home/Top 100/login splash all stock(-scyfin). Likely causes to check in devtools:
- scyfin themes set their own accent/ground via **CSS custom properties** — my literal selectors are overridden or too weak. Right fix: override scyfin's variables (inspect for `--clr-*` / `--accent` names) rather than fighting selectors; and/or drop scyfin entirely and own the CSS.
- Drawer prune selectors (`.adminMenuOptions` etc.) may not match current jellyfin-web DOM — verify class names against the running version, fix, re-provision (`make provision s=jellyfin`).
- **Login loading splash still Jellyfin**: that's the Branding *splashscreen* + loading logo, separate from CustomCss — set Branding `SplashscreenEnabled`/custom splash image (upload wordmark PNG via API in jellyfin.sh).
- Top 100 web page: unstyled — the showcase JS was never built (known). Build it in `jellyfin-web-flair.js` (pattern exists): detect playlist route, restyle into tiers. **REQUIREMENT: keep reorder** — web (unlike TV) must retain drag-and-drop row re-arranging for curating the list. Design: showcase view + an "Edit order" toggle that reveals the stock draggable list (or keeps drag handles on ledger rows). In-app playlist order stays the source of truth.

## 7. Still queued from SPEC
Playlist cover uploads (script "100" mark, via jellyfin.sh); splash motion beats (perf-gated); TMDB taglines in/out (Brennan hasn't ruled); trial-vs-retail font cut note (SPEC §0).

## Ops crib
- Build: `cd ~/jellyfin-androidtv && JAVA_HOME=$HOME/jdk-21 PATH=$HOME/jdk-21/bin:$PATH ./gradlew assembleDebug`
- Deploy: `adb -s 192.168.1.77:5555 install -r app/build/outputs/apk/debug/*.apk` (screencap to verify; roulette = force-stop + relaunch)
- Web: edit `scripts/provision/jellyfin-custom.css` (+ flair JS) → `make provision s=jellyfin` → hard refresh
- Wordmark/asset pipeline: font installed at ~/.fonts; inkscape text-to-path, per-glyph paths (NEVER concatenate `d` strings — relative-m breaks)
