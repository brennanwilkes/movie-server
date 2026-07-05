# Feasibility study: forking jellyfin-androidtv for collection-rows on the TV

**Question:** can we fork the official Fire TV / Android TV Jellyfin client so our ~27 curated
collections show up as Netflix-style home rows? **Answer: yes, and it's a small, well-scoped
fork** — smaller than the brief assumed, because most of the wanted features already ship in the
stock app and the one missing piece (collections-as-rows) maps almost 1:1 onto code that already
exists in the app. This report gives two concrete fork approaches with the exact files/methods to
edit, the build/sign/sideload flow, an effort + maintenance estimate, and a ranked comparison
against the non-fork alternatives (one of which — Streamyfin — is a genuine contender worth a
30-minute test *before* writing any code).

> Sourcing: everything below marked **[C]** was read from the actual `jellyfin-androidtv` /
> `jellyfin-sdk-kotlin` source or the live GitHub API on 2026-07-03. **[G]** = judgment/estimate.
> Research was done against `master`; the fork should target the **v0.19.9 release tag** — see
> §2 for why, and §9 for the one caveat that follows from that.

---

## 0. TL;DR / recommendation

1. **Two findings reframe the whole thing:**
   - **[C] Your 2017 stick is NOT too old for the current official client.** The latest *release*
     (v0.19.9) has `minSdk = 21` and ships an `armeabi-v7a` (32-bit) library — it installs and runs
     on Fire OS 5.1.1 / API 22. Only the *unreleased* `master` branch bumped `minSdk` to 23. So the
     "we need a 4K Max first" premise is wrong for the client itself.
   - **[C] Almost everything on your non-negotiables list already exists in the stock app:**
     Continue Watching (`HomeSectionType.RESUME`), Latest/Recently Added (`LATEST_MEDIA`), poster
     cards (`CardPresenter`), and big fanart backdrops (`BackgroundService`) are all built in. **The
     *only* thing missing is "one row per collection."** That dramatically shrinks the fork.

2. **The fork is small.** The home screen is built by a switch statement that turns each
   `HomeSectionType` into a `HomeFragmentRow` (a one-method interface). A "collection row" is
   basically the code already in `CollectionFragment.kt` (a `GetItemsRequest(parentId = boxSetId)`
   fed through the existing `BrowseRowDef` → `ItemRowAdapter` → `CardPresenter` pipeline). **[C]**
   Prototype ≈ **1 new file + ~20 edited lines**; polished (in-app picker) ≈ **300–500 LOC**.

3. **It's purely client-side. No server fork.** **[C]** Listing collections and their contents is
   plain `/Items` API the app's SDK already exposes. The server (and your controller's rotating
   shelves) needs zero changes.

4. **Upstream contribution is a dead end for our timeline.** **[C]** The androidtv feature request
   (#4241) is **closed as not-planned**; the server PR (#13820) is a **dormant single-author draft**
   that hasn't even implemented the `PinnedCollection` type yet. Don't wait for it.

5. **Recommended path:** before writing code, spend ~30 min on the stick testing (a) stock
   jellyfin-androidtv 0.19.9 as a baseline and (b) **Streamyfin + its server plugin**, which already
   does collections-as-rows on Android TV with *no fork*. If Streamyfin runs acceptably on 1 GB RAM,
   you're done with zero maintenance. If it's too heavy (likely, it's React Native), **do the fork
   (Approach A) against v0.19.9, debug-signed, coexisting APK.** Both routes keep the current stick.

---

## 1. Architecture: how home rows are built (the extension point) [C]

All home-row code lives in `app/src/main/java/org/jellyfin/androidtv/ui/home/`.

**The row pipeline:**

```
HomeRowsFragment.onCreate
  └─ for (section in homesections) when(section) { ... }      // maps HomeSectionType → HomeFragmentRow
        └─ HomeFragmentHelper.loadX(...)                       // factory: wraps a BrowseRowDef
              └─ HomeFragmentBrowseRowDefRow(browseRowDef)     // implements HomeFragmentRow
                    └─ addToRowsAdapter(ctx, cardPresenter, rowsAdapter)
                          └─ ItemRowAdapter(context, GetItemsRequest, ...)   // fetch
                                └─ api.itemsApi.getItems(query).content       // SDK call
                                      └─ BaseItemDtoBaseRowItem → CardPresenter  // render cards
```

**The one interface a row must implement** — `ui/home/HomeFragmentRow.kt`, verbatim **[C]**:

```kotlin
interface HomeFragmentRow {
	fun addToRowsAdapter(context: Context, cardPresenter: CardPresenter, rowsAdapter: MutableObjectAdapter<Row>)
}
```

**The section switch** in `HomeRowsFragment.kt` **[C]** (abbreviated):

```kotlin
for (section in homesections) when (section) {
    HomeSectionType.LATEST_MEDIA        -> rows.add(helper.loadRecentlyAdded(userViewsRepository.views.first()))
    HomeSectionType.LIBRARY_TILES_SMALL -> rows.add(HomeFragmentViewsRow(small = false))
    HomeSectionType.RESUME              -> rows.add(helper.loadResumeVideo())   // ← Continue Watching, already here
    HomeSectionType.NEXT_UP             -> rows.add(helper.loadNextUp())
    HomeSectionType.LIVE_TV             -> { ... }
    ...
}
```

**The workhorse row** — `HomeFragmentBrowseRowDefRow.addToRowsAdapter` picks an `ItemRowAdapter`
overload by `browseRowDef.queryType`; the generic path (the `else` branch) uses
`browseRowDef.query`, which is an **`org.jellyfin.sdk.model.api.request.GetItemsRequest`** — and
`GetItemsRequest` has a `parentId` field. **[C]** So a row backed by an arbitrary `ParentId` (i.e.
a BoxSet) is already a first-class, supported shape.

**The closest existing code to what we want** — `ui/browsing/CollectionFragment.kt` **[C]**:

```kotlin
val movies = GetItemsRequest(
    fields = ItemRepository.itemFields,
    parentId = mFolder.id,                       // ← a BoxSet/folder id
    includeItemTypes = setOf(BaseItemKind.MOVIE),
)
... BrowseRowDef(getString(R.string.lbl_movies), movies, 100)
```

That is *exactly* the query a collection row needs. The fork is essentially: run this per-BoxSet
and emit each as a home row.

**What we get for free (no code):** **[C]**
- **Continue Watching** — `HomeSectionType.RESUME` → `helper.loadResumeVideo()`.
- **Recently Added** — `HomeSectionType.LATEST_MEDIA` → `helper.loadRecentlyAdded(...)`.
- **Poster cards** — `CardPresenter`, passed into every row.
- **Big fanart backgrounds** — `BackgroundService` updates the screen backdrop from the focused
  item's `Backdrop` image as you scroll rows. **[G]** confirmed to exist; behavior is automatic.
- **2-way watch/resume sync** — standard client behavior against the server.

So the fork adds one thing: **collection rows.**

---

## 2. Hardware reality — the surprise finding [C]

| | minSdk | 32-bit (armeabi-v7a)? | Runs on your API-22 stick? |
|---|---|---|---|
| v0.19.9 (latest **release**) | **21** | **yes** (universal APK, ~1.36 MB v7a lib) | **YES** |
| every release 0.15 → 0.19.9 | 21 | yes | YES |
| `master` (unreleased) | **23** | yes | NO (API 23 = Android 6.0) |

- **[C]** minSdk was 21 for the entire tracked release history; the jump to 23 is only on `master`
  and has never shipped. The next release (**[G]** ~0.20.0) will be the first to drop the device.
- **[C]** No `abiFilters`/`splits`/flavors constrain the ABI; the app is ExoPlayer/Media3-based
  (not libVLC anymore) and the official universal APK contains `armeabi-v7a`.

**Implication:** you can run/fork **v0.19.9** on the *current* stick today. The 1 GB RAM is a real
constraint (it's why Kodi skins OOM'd), but the native app is far lighter than Kodi+Aeon-Nox, so
**[G]** it should be fine — that's the first thing to validate (§8, step 1). The 4K Max is still the
better long-term device, but it's no longer a blocker to starting.

---

## 3. Fork approach A — "all collections as rows" (recommended prototype→shippable)

**Idea:** on home load, query all BoxSets from the server, and append one row per collection,
reusing the existing pipeline. No hardcoded IDs — the *server* (your controller) already owns which
collections exist and rotates them, so the client just mirrors "all BoxSets."

**Files to edit — exactly two:**

**(1) `ui/home/HomeFragmentHelper.kt`** — add a factory method (mirrors the existing `loadX`
methods; **[C]** it already has `Context` + repos and returns `HomeFragmentRow`s wrapping
`BrowseRowDef`):

```kotlin
fun loadCollectionRow(collection: BaseItemDto): HomeFragmentRow {
    val query = GetItemsRequest(
        parentId = collection.id,
        fields = ItemRepository.itemFields,          // posters, overview, userData, etc.
        sortBy = listOf(ItemSortBy.SORT_NAME),       // or PREMIERE_DATE for franchises
        enableImages = true,
        enableUserData = true,                        // resume state on cards
        limit = 50,                                   // cap items/row for the 1 GB device
    )
    return HomeFragmentBrowseRowDefRow(BrowseRowDef(collection.name.orEmpty(), query, 50))
}
```

**(2) `ui/home/HomeRowsFragment.kt`** — after the existing section `when` loop, fetch BoxSets and
append rows. `HomeRowsFragment` already builds rows inside a coroutine (it `await`s
`userViewsRepository.views.first()`), so an async SDK call fits **[C]**:

```kotlin
// after the standard sections are added:
val boxSets = api.itemsApi.getItems(
    includeItemTypes = listOf(BaseItemKind.BOX_SET),
    recursive = true,
    sortBy = listOf(ItemSortBy.SORT_NAME),
).content.items

for (collection in boxSets.take(MAX_COLLECTION_ROWS)) {   // MAX_COLLECTION_ROWS ≈ 15–20 for 1 GB
    rows.add(helper.loadCollectionRow(collection))
}
```

(`api` is the injected `org.jellyfin.sdk.api.client.ApiClient` the fragment/helper already holds —
same one `ItemRowAdapterHelper` uses. **[C]**)

**Ordering / curation without an in-app UI:** collections come back sorted by `SortName`. Because
your controller names the collections, you can control row order purely server-side with a name
prefix convention (`01 - Feel-Good`, `02 - Epics`, …) — zero client config, and it also lets the
controller's rotation drive what's featured. **[C]** (This is the "read the shelf list from the
server" idea from the brief, achieved with no custom endpoint.)

**Reflecting the ~10-min rotation:** rows rebuild every time the home screen is (re)entered, so the
current server state shows up on each visit. **[G]** Good enough; no polling needed. If you want it
to re-roll while sitting on the home screen, add the BoxSet query to the row's
`setReRetrieveTriggers(...)` or refresh on `onResume`.

**Effort:** **[G]** ~1 new method + ~20 lines. A few hours *once the toolchain builds* (§6). This is
both the prototype and a perfectly shippable v1.

**Downsides:** shows *all* collections (can't hide/reorder from the couch); order is via naming
convention only. Fine for a single-user box.

---

## 4. Fork approach B — "in-app collection picker" (the polished version)

Everything in A, plus a settings screen to choose *which* collections become rows and in what
order, stored in the app's own preferences.

**Additional pieces:**
- **A preference store.** The app has a preference system under
  `org.jellyfin.androidtv.preference` (e.g. `UserSettingPreferences`). **[G]** Add a key holding an
  ordered list of BoxSet ids (JSON or CSV). **[C]** that a preference layer exists; exact class to
  extend needs a 10-min look at that package.
- **A picker fragment.** A Leanback preferences/`GuidedStepFragment` screen that lists all BoxSets
  (from the §3 query) with checkboxes + up/down ordering, writing the selection to the pref. **[G]**
  ~200–350 LOC. Register it in the existing Settings navigation.
- **`HomeRowsFragment`** reads the pref instead of "all BoxSets": if the pref is empty, fall back to
  "all" (A's behavior); otherwise emit rows for the chosen ids in the chosen order.

**True new `HomeSectionType`?** Tempting to add a first-class section type so collection rows slot
into the existing home-section ordering UI. **Not recommended:** `HomeSectionType` is an **SDK model
enum** (`org.jellyfin.sdk.model.api.HomeSectionType`) — adding a value means forking the SDK model,
and **[C]** injecting an unknown home-section type is exactly what historically *crashed* Android TV
/ Swiftfin clients (jellyfin-meta #83). Keep collection rows an **app-level concept appended after
the standard sections** — no SDK fork, no crash surface.

**Effort:** **[G]** ~300–500 LOC on top of A; ~1–3 days including a settings screen that feels native.

---

## 5. Does anything need server support? No. [C]

- **List collections:** `GET /Items?IncludeItemTypes=BoxSet&Recursive=true&SortBy=SortName` →
  Kotlin `api.itemsApi.getItems(includeItemTypes = listOf(BaseItemKind.BOX_SET), recursive = true, sortBy = listOf(ItemSortBy.SORT_NAME))`.
- **Collection contents:** `GET /Items?ParentId=<boxSetId>` → `getItems(parentId = boxSetId, ...)`.
- **Resume/watch state on cards:** request `enableUserData = true`; each `BaseItemDto.userData`
  carries `played`, `playbackPositionTicks`, `playedPercentage` (ticks ÷ 10,000,000 = seconds).
- **Images:** `api.imageApi.getItemImageUrl(itemId, ImageType.PRIMARY/BACKDROP, tag = ...)`.
- **Same SDK the app already ships:** `org.jellyfin.sdk:jellyfin-core` (v1.8.11 in androidtv). A
  fork already has `itemsApi`, `imageApi`, all DTOs, and auth wiring — you add a Fragment/row, not
  an API layer.

The server, DLNA config, and the controller's `collectionsSweep` are all untouched.

---

## 6. Build, sign, and get it on the stick [C]

**Target the release, not master.** Build the **`v0.19.9` tag** (minSdk 21). `master` (minSdk 23)
would lock out the stick.

```bash
git clone https://github.com/jellyfin/jellyfin-androidtv
cd jellyfin-androidtv
git checkout v0.19.9            # or: git switch -c mine v0.19.9
# ... make the §3 edits ...
./gradlew assembleDebug         # → app/build/outputs/apk/debug/app-debug.apk
```

**Toolchain** (from `gradle/libs.versions.toml`) — **[C]** on `master`: **JDK 21, AGP 9.2.1, Kotlin
2.4.0, compileSdk 36**. **[G]** the v0.19.9 tag may pin slightly older (likely JDK 17) — read that
tag's `libs.versions.toml` for the exact JDK/AGP before installing. Android SDK + build-tools for
the tag's compileSdk. No product flavors — just `debug`/`release` build types. **[C]**

**Signing — easiest viable path: just use the debug build. [C]**
- The `debug` build type sets `applicationIdSuffix ".debug"`, so it installs as
  `org.jellyfin.androidtv.debug` and **coexists with the official app** (great for A/B'ing).
- Debug APKs are auto-signed with the standard debug keystore — **fine for indefinite personal
  sideload.** The only rule: sign every future update with the *same* key or `adb install -r` fails
  on signature mismatch. **[G]** (For a "real" signed build: `keytool -genkey ... -keystore my.jks`,
  pass `-Pkeystore.file=...` etc. to `assembleRelease`, or `apksigner sign --ks my.jks ...`.)

**Sideload / update over ADB** — reuse the exact wiring from `FIRESTICK_KODI.md` §2/§5 (Ethernet,
`192.168.1.77`, ADB already enabled):

```bash
FIRE=192.168.1.77:5555
adb connect $FIRE
adb -s $FIRE install -r app/build/outputs/apk/debug/app-debug.apk   # -r keeps data; -d allows downgrade
adb -s $FIRE shell monkey -p org.jellyfin.androidtv.debug -c android.intent.category.LAUNCHER 1
```

Publishing = literally that `adb install -r`. No store, no account, no review. **[C]**

---

## 7. Maintenance cost — smaller than the brief fears [G]

The brief's worry ("rebase on upstream, rebuild, redistribute on every update") **only bites if you
chase upstream releases.** For a single personal device:

- **You can pin to your v0.19.9 fork indefinitely.** Jellyfin's server/client wire protocol is
  stable across 10.x; a 0.19.9-based client will keep working against your server for a long time.
  Maintenance while pinned = **zero.**
- **Cost is per-*wanted*-upgrade, not per-upstream-release.** When you decide you want a new upstream
  feature, you rebase your ~20-line patch (Approach A is tiny and touches stable files, so rebases
  are trivial) and `./gradlew assembleDebug && adb install -r`. **[G]** ~15–30 min, occasional.
- **The real one-time cost is the first toolchain setup** (JDK + Android SDK + first Gradle build),
  not the ongoing patch.

Contrast with the Kodi setup you already maintain by hand (skins, add-ons, per-file config over
ADB) — the fork is *less* fiddly to keep alive, and it's the "single polished app" you wanted.

---

## 8. Alternatives, ranked

1. **[RECOMMENDED, non-fork] Streamyfin + `jellyfin-plugin-streamyfin`.** **[C]** The server plugin
   lets an admin define custom home sections — including **"Custom Sections: create any view using
   Jellyfin's API"** — synced to the client; and Streamyfin **shipped Android TV support** (v0.54.1+,
   D-pad nav, recommendations row). Plugin actively developed (v0.67.0.0, 2026-06). This is
   collections-as-rows **with no fork and no per-update rebuild.** **Risk [G]:** it's Expo/React
   Native — comparatively heavy; **may run poorly or not at all on the 1 GB / 32-bit stick.** Test
   it first (§8-step-2). If it flies, it beats the fork on maintenance.

2. **[RECOMMENDED fork] Fork jellyfin-androidtv, Approach A, v0.19.9, debug-signed.** Native, light,
   sleek single app; runs on the current stick; ~20-line patch; near-zero maintenance while pinned.
   The endgame the brief was looking for. Pick this if Streamyfin is too heavy.

3. **[STATUS QUO] Kodi + Jellyfin-for-Kodi** (documented in `FIRESTICK_KODI.md`). Works, but capped
   at 2 widget rows on the only skin the 1 GB stick can run — can't do one-row-per-collection.
   Acceptable stopgap; not the goal. Keep as fallback.

4. **[NOT VIABLE] Contribute PinnedCollection upstream.** **[C]** androidtv #4241 closed
   *not-planned* (maintainer: the app only renders what the server home-section API exposes); server
   PR #13820 is a dormant single-author draft with no milestone, failing its quality gate, and
   **hasn't even implemented the PinnedCollection type yet.** You'd have to finish the server API
   *and* write the client rendering the maintainers declined. **[G]** Many months to >1 year, if
   ever. Don't block on it. (If you do the fork, your Approach-A code is a ready reference should the
   server API ever land.)

5. **[NOT VIABLE] Findroid.** **[C]** No Android TV (it's phone/tablet), no collection rows, minSdk
   28. Rules out the stick on every axis.

6. **[POOR stopgap] jellyfin-web + Home Screen Sections plugin in a WebView/browser on the stick.**
   **[C/G]** Technically possible (Fire TV is Android), and it *does* render your existing HSS rows —
   but jellyfin-web is mouse/touch-first (bad D-pad focus) and heavy in a WebView on 1 GB RAM.
   Usable in a pinch, painful as a daily driver.

**Suggested order of operations:**
- **Step 1 (10 min):** sideload the **official** jellyfin-androidtv **0.19.9** APK on the stick.
  Confirms the device runs the native app well and gives you the free baseline (Continue Watching,
  Latest, posters, fanart) — everything but collection rows. Validates the RAM question.
- **Step 2 (20 min):** install Streamyfin + its plugin, define a couple of custom collection
  sections, and see if it performs on the stick. If yes → **done, no fork.**
- **Step 3 (only if 1–2 disappoint):** do the fork (Approach A). Prototype milestone below.

---

## 9. Prototype milestone (the fork, if you get there)

**"Collections show as home rows" — done when:**
1. `git checkout v0.19.9`; confirm `./gradlew assembleDebug` builds and the unmodified debug APK
   installs + runs on the stick.
2. Make the §3 edits (2 files). Rebuild, `adb install -r`.
3. Home screen shows Continue Watching + Latest (free) **and** one poster row per collection, with
   fanart backdrops updating as you scroll, and resume state on cards.
4. Confirm re-entering home reflects the controller's latest rotation.
5. (Optional, Approach B) add the picker screen.

**The one caveat to verify first [G]:** the architecture in §1 was read from `master`. The v0.19.9
tag's home code is **[G]** almost certainly the same (this structure has been stable for many
releases), but before editing, `git checkout v0.19.9` and confirm these files exist with these
shapes: `ui/home/HomeFragmentRow.kt`, `HomeFragmentHelper.kt`, `HomeFragmentBrowseRowDefRow.kt`,
`HomeRowsFragment.kt`, and `ui/browsing/CollectionFragment.kt` (the `parentId` pattern). If a name
drifted, the mapping is 1:1 and the fix is mechanical.

---

## Appendix: key source references

- Home rows: `app/src/main/java/org/jellyfin/androidtv/ui/home/` — `HomeFragmentRow.kt` (interface),
  `HomeRowsFragment.kt` (section switch), `HomeFragmentHelper.kt` (row factory),
  `HomeFragmentBrowseRowDefRow.kt` (fetch→card workhorse).
- ParentId precedent: `ui/browsing/CollectionFragment.kt`; row def `ui/browsing/BrowseRowDef.java`;
  adapter `ui/itemhandling/ItemRowAdapter.java` + `ItemRowAdapterHelper.kt`.
- Build/targeting: `gradle/libs.versions.toml`, `app/build.gradle.kts` (minSdk, `.debug` suffix,
  signingConfigs, media3 deps).
- SDK: `org.jellyfin.sdk:jellyfin-core` 1.8.11 — `itemsApi.getItems(GetItemsRequest)`,
  `imageApi.getItemImageUrl(...)`, `BaseItemDto.userData`.
- Upstream (don't wait on): jellyfin/jellyfin #13820 (draft), jellyfin-meta #93 (discussion) / #83
  (crash-on-unknown-type warning), jellyfin-androidtv #4241 (closed not-planned).
- Non-fork contender: `streamyfin/streamyfin` + `streamyfin/jellyfin-plugin-streamyfin`.
