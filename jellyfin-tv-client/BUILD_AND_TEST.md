# Collection-rows Jellyfin Android TV client — build & test

A ~57-line, 2-file fork of **jellyfin-androidtv v0.19.9** that adds one home-screen row per curated
collection (BoxSet), mirroring the web Home Screen Sections shelves. Everything else the user wants
(Continue Watching, Recently Added, poster cards, fanart backdrops, watch-state sync) is stock.

See `JELLYFIN_CLIENT_FORK_PLAN.md` (repo root) for the full design rationale. This file documents
the **as-built** state on `haleiwa` and how to rebuild / test / deploy.

## What the patch does (5 files; see `collection-rows.patch`)

**Home layout** (`HomeRowsFragment.kt`) — a custom ordered home, replacing the stock section loop:
1. **Continue Watching** (resume) + **Next Up** (next episode of in-progress series) — both auto-hide when empty
2. **First 5 curated collections** (`FEATURED_COLLECTION_ROWS`)
3. **TV Shows** row (random series — series discovery)
4. **Remaining collections**

Collection pool = all BoxSets (`getItems(includeItemTypes=[BOX_SET], recursive, limit=100,
fields=[CHILD_COUNT])`), keeping our curated collections **plus** TMDb franchise sets (names ending
`Collection`) that have **≥5 items** (`MIN_FRANCHISE_ITEMS`), then `shuffled().take(40)`
(`MAX_COLLECTION_ROWS`) — a **fresh random set + order every home build**. The stock My Media /
Recently Added / Next Up sections are intentionally omitted.

**Row factories** (`HomeFragmentHelper.kt`):
- `loadCollectionRow(collection)` — `GetItemsRequest(parentId=<boxSetId>)` through the stock
  fetch→card→backdrop pipeline. Sort mirrors `controller/server.js` `/api/hss/shelf`:
  `Oscar:*` → `PremiereDate DESC` (newest first); everything else → `Random` (reshuffles per retrieve).
- `loadTvShowsRow()` — `GetItemsRequest(includeItemTypes=[SERIES], recursive, sortBy=Random)`.
- **Lag fix:** rows load `ROW_CHUNK_SIZE=15` items at a time and lazily page more as scrolled
  horizontally (was an eager 50 per row — the original lag source). Small chunk = light home load,
  which is what makes 40 rows viable on the 1 GB stick.

**Card ratings** — `UserPreferences.defaultRatingType` default → `RATING_STARS` (★ + community
score badge, replacing the Rotten-Tomatoes critic badge); `BaseItemDtoBaseRowItem.getSubText` returns
`null` for movies/series so the **PG/R content-rating subtitle is dropped** — cards show poster +
title + ★ score.

**Branding** — `app_name_debug`/`app_name_release` → **"Movie Night"** (launcher label).

**Card subtitle** — `getSubText` shows **`year · runtime`** for movies (year for series) instead of the PG/R rating; episodes keep their episode-title subtitle.

**"Because you watched X" rows** (`HomeFragmentHelper.loadSimilarRow` + seed in `HomeRowsFragment`) — up to `SIMILAR_ROW_COUNT=2` rows of SimilarItems, seeded from the most-recently-*played* movies (`SIMILAR_SEED_LIMIT=8` scanned, filtered `userData.played`), sprinkled into the collection list at ~slot 8+.

**Perf (1 GB stick)** — `BackgroundService` now decodes backdrops at ~half-screen size and caps how many it holds (`BACKGROUND_LIMIT=5`) — was full-res ~8 MB each; `AppModule` bounds the Coil memory cache to 15%; `AsyncImageView` skips the crossfade on low-RAM devices.

**Spotlight hero banner** — a **scroll-away** hero as the first home row (`HeroRow` +
`HeroRowPresenter` hosting the `HomeSpotlight` composable in a Leanback `ComposeView`; `HomeRowsFragment`
uses a `ClassPresenterSelector`). Shows a random movie (community rating ≥9.0, falling back to ≥8.0
since TMDb ratings rarely reach 9) with backdrop + clearlogo (or title) + a Play button
(`PlaybackLauncher.launch`). Re-rolls each home load. `SPOTLIGHT_HEIGHT=320.dp`. Verified on-device:
renders, scrolls away with content, Play button is focusable and launches playback.

**Title logo images** (`view_card_legacy_image.xml` `title_logo` + `LegacyImageCardView.setTitleLogo` +
`CardPresenter`) — poster cards show the title's clearlogo when available (`ImageHelper.getLogoImageUrl`),
falling back to the text title.

**Card subtitle (final form)** — no rating badge; **year left-aligned** (content text) + **runtime
right-aligned** (badge slot, `alignParentBottom` so year and runtime share one line). Runtime only for
**movies with a real duration** (series have `runTimeTicks` 0/null → no "0m"). Supersedes the earlier
star-rating and centered "year · runtime" approaches.

**Wide/landscape rows** — ~25% of collection rows (`Random.nextInt(4)==0` in `HomeRowsFragment`) render
**16:9 backdrop cards** instead of posters (`HomeFragmentBrowseRowDefRow(wideCards=true)` builds a
`CardPresenter(THUMB)` with `setPreferBackdrop(true)`; CardPresenter uses `itemBackdropImages`, falling
back to poster if no backdrop). Adds visual variety.

**Skip intro/credits/recap** — client fully supports it already; needs a server media-segment plugin.
See **`SERVER_MEDIA_SEGMENTS_PLAN.md`** (task for a server-side agent).

Reusable diff: **`collection-rows.patch`** (applies cleanly on the pristine `v0.19.9` tag; note it
includes the new file `HomeSpotlight.kt` as an add).

## Environment (set up 2026-07-04, `haleiwa`)

| Component | Location / value |
|---|---|
| Source repo | `~/jellyfin-androidtv`, branch `collections` (v0.19.9 `14a5e16` + patch) |
| JDK | Temurin 21 at `~/jdk-21` (toolchain-enforced) |
| Android SDK | `~/android-sdk` — platform-tools, platforms;android-36, build-tools;36.0.0 |
| Emulator | `~/android-sdk/emulator` + `system-images;android-36;android-tv;x86_64`, AVD `jf_tv` |
| Output APK | `~/jellyfin-androidtv/app/build/outputs/apk/debug/jellyfin-androidtv-*-debug.apk` |
| App id | `org.jellyfin.androidtv.debug` (label "Jellyfin Debug") — coexists with anything |

## Scripts (this directory)

| Script | What it does | Needs stick? |
|---|---|---|
| `build.sh` | Reproducible `assembleDebug` with the right JDK/SDK env | no |
| `verify-apk.sh` | `aapt` assertions: `.debug` id, minSdk 21, leanback launcher, 32-bit ABI | no |
| `test-api.sh` | Auth to live Jellyfin; assert collection filter + Oscar/random sort behavior | no |
| `emulator-test.sh` | Boot headless Android TV emulator, install APK, screenshot home rows | no |
| `deploy.sh` | ADB sideload to the Fire Stick (STAGED — run when it's powered on) | **yes** |

## Test results (2026-07-04, no Fire Stick involved)

### 1. Toolchain / build — PASS
- Clean `assembleDebug` of the **untouched** v0.19.9 tag: `BUILD SUCCESSFUL in 18m` (first build,
  incl. Gradle 9.1.0 + dependency cache).
- Patched build: `BUILD SUCCESSFUL in 2m42s`. APK 28.5 MB.

### 2. APK manifest (`verify-apk.sh`) — PASS
```
applicationId : org.jellyfin.androidtv.debug   (coexists w/ official app)
minSdk        : 21                             (Fire OS 5.1 = API 22 → OK)
launcher      : leanback-launchable-activity   (real Android TV app)
native-code   : arm64-v8a armeabi-v7a x86 x86_64
```

### 3. Live-API behavior (`test-api.sh`, against http://192.168.1.74:8096) — PASS
Exercises the *exact* queries the patched client issues:
- **Catalog + filter:** 100 BoxSets → keeps **78 curated**, drops **22** TMDb `*Collection` sets.
- **Oscar row:** `SortBy=PremiereDate&SortOrder=Descending` → years strictly newest-first
  (`2025 … 2006`).
- **Random row:** two `SortBy=Random` retrieves return different orders.

### 4. Emulator render (`emulator-test.sh`) — PASS
Headless **Android TV** emulator (`system-images;android-36;android-tv;x86_64`, KVM-accelerated),
patched APK installed, logged into the live server (`brennan`/`brennan`). Screenshots in
`screenshots/`:

- `02-home-standard-sections.png` — stock sections render (Next Up, Recently Added, library tiles).
- `03-collection-row-old-hollywood.png` — **collection row "Old Hollywood"** with poster cards,
  watch-state ticks, and the fanart backdrop updating on focus.
- `04-oscar-row-newest-first.png` — **"Oscar: Best Actress (Nominees)"** ordered newest-first
  (Sentimental Value 2025 → Anora 2024 → Killers of the Flower Moon 2023 → … → Million Dollar Baby),
  with a **non-Oscar** row ("Harrison Ford") below it in random order. Confirms the sort split
  visually, on-device.

This is the whole feature working end-to-end on the Android TV form factor — the only thing the real
Fire Stick adds is confirming performance on 1 GB RAM / API 22 (the emulator is API 36).

## Deploy (later, when the Fire Stick is on)

```bash
cd ~/movie-server/jellyfin-tv-client
./deploy.sh                 # adb connect 192.168.1.77:5555 → install -r → launch
```
First launch: add server `http://192.168.1.74:8096`, sign in `brennan`/`brennan`. Rollback:
`adb -s 192.168.1.77:5555 uninstall org.jellyfin.androidtv.debug`. Kodi and anything else untouched.

## Maintenance
Pinned to v0.19.9 → zero maintenance. To take an upstream update: `git rebase <newer-tag>` (only a
tag whose minSdk ≤ 22 while keeping this stick), re-apply is trivial (patch touches 2 stable files),
`./build.sh`. Keep the same debug key or `adb install -r` fails on signature mismatch.
