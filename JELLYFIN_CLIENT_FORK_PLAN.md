# Implementation plan: collection-rows fork of jellyfin-androidtv (v0.19.9)

This is the deep, verified build plan that follows `JELLYFIN_CLIENT_FORK_FEASIBILITY.md`. Every
file path, class, method signature, and line number below was read directly from a local checkout of
the **`v0.19.9`** release tag (commit `14a5e16`) — **not** `master` (which has `minSdk 23` and will
not run on the stick). Where something still needs a live check, it's called out as **⚠ VERIFY**.

Goal recap: one home-screen row per Jellyfin collection (BoxSet), reusing the app's existing
poster-card + fanart-backdrop + watch-state pipeline. Continue Watching, Recently Added, posters,
big backdrops, and 2-way watch sync are **already in the stock app**; the only new thing is
collection rows.

---

## 0. Ground truth (verified from the v0.19.9 checkout)

| Fact | Value | Where verified |
|---|---|---|
| Tag / commit | `v0.19.9` / `14a5e16` | `git log` |
| `minSdk` | **21** (your stick is API 22 → OK) | `gradle/libs.versions.toml` |
| `targetSdk` / `compileSdk` | 36 / 36 | same |
| Build JDK | **21** (toolchain-enforced) | `libs.versions.toml` `java-jdk=21`; `buildSrc/build.gradle.kts` `jvmToolchain`; `build.gradle.kts` |
| Bytecode target | Java 8 (`jvmTarget JVM_1_8`, `sourceCompatibility 1.8`) | `build.gradle.kts` |
| Gradle wrapper | **9.1.0** (auto-downloads) | `gradle/wrapper/gradle-wrapper.properties` |
| Android Gradle Plugin | 8.11.1 | `libs.versions.toml` |
| Kotlin | 2.2.21 | same |
| DI framework | Koin 4.1.1 | same |
| Jellyfin SDK | `org.jellyfin.sdk:jellyfin-core` **1.7.1** | same |
| ABI filtering | **none** → universal APK incl. `armeabi-v7a` (32-bit) | `app/build.gradle.kts` (no `abiFilters`/`splits`) |
| Debug app id | `org.jellyfin.androidtv.debug`, label "Jellyfin Debug" | `app/build.gradle.kts`, `res/values/strings.xml` |

**The single most important consequence:** you build the **debug** variant of the **v0.19.9 tag**;
it installs *alongside* the official app (different applicationId), is auto-signed, runs on the
current stick, and is the entire distribution mechanism.

---

## PART I — Verified architecture (what we're hooking into)

### The row pipeline (all confirmed verbatim)

```
HomeRowsFragment.onCreate                                   ui/home/HomeRowsFragment.kt:86
  lifecycleScope.launch(Dispatchers.IO) {                   :91   ← async; api is available here
    homesections = userSettingPreferences.activeHomesections :97
    rows = mutableListOf<HomeFragmentRow>()                 :100
    for (section in homesections) when (section) { ... }    :106–121  ← builds standard rows
    withContext(Dispatchers.Main) {                         :124
      cardPresenter = CardPresenter()                       :125
      for (row in rows) row.addToRowsAdapter(...)           :130  ← renders every row
    }
  }
```

- **`api` (the authenticated SDK client) is injected and in scope:** `private val api by inject<ApiClient>()` — `HomeRowsFragment.kt:60`. It's authenticated as the current user, so any `getItems` call is automatically user-scoped (correct watch-state, correct visibility). No `userId` needed.
- **The row interface** (the extension point), `ui/home/HomeFragmentRow.kt`, entire file:
  ```kotlin
  interface HomeFragmentRow {
      fun addToRowsAdapter(context: Context, cardPresenter: CardPresenter, rowsAdapter: MutableObjectAdapter<Row>)
  }
  ```
- **The workhorse row** `HomeFragmentBrowseRowDefRow` (`ui/home/HomeFragmentBrowseRowDefRow.kt:37`): for `queryType == Items` it hits the `else` branch and builds a generic `ItemRowAdapter(context, browseRowDef.query, chunkSize, preferParentThumb, staticHeight, cardPresenter, rowsAdapter, queryType)`, then `Retrieve()`s and adds a `ListRow`. This is the whole fetch→card path, reused for free.
- **`BrowseRowDef`** (`ui/browsing/BrowseRowDef.java`): the constructor
  `BrowseRowDef(String header, GetItemsRequest query, int chunkSize, ChangeTriggerType[] changeTriggers)`
  sets `queryType = QueryType.Items` (verified lines 57–71). So a `GetItemsRequest` with a
  `parentId` flows straight through the generic path.
- **`GetItemsRequest` with `parentId` = a BoxSet's contents** is already how the app renders a
  collection elsewhere — `ui/browsing/CollectionFragment.kt:9-14`:
  ```kotlin
  val movies = GetItemsRequest(fields = ItemRepository.itemFields, parentId = mFolder.id, includeItemTypes = setOf(BaseItemKind.MOVIE))
  ```
- **Listing all collections already exists** — `ui/browsing/BrowsingUtils.kt:242` `createCollectionsRequest`:
  ```kotlin
  fun createCollectionsRequest(parentId: UUID) = GetItemsRequest(
      fields = ItemRepository.itemFields,
      includeItemTypes = setOf(BaseItemKind.BOX_SET),
      recursive = true, imageTypeLimit = 1, parentId = parentId,
      sortBy = setOf(ItemSortBy.SORT_NAME),
  )
  ```
  We use the same query, minus the `parentId` restriction, to list *all* BoxSets from the root.
- **The SDK call pattern** (`ui/itemhandling/ItemRowAdapterHelper.kt`): `api.itemsApi.getItems(...).content` inside `withContext(Dispatchers.IO)`; import `org.jellyfin.sdk.api.client.extensions.itemsApi`. `getItems` accepts `parentId`, `includeItemTypes`, `recursive`, `sortBy`, `imageTypeLimit` (all seen in-tree).
- **Field sets** (`data/repository/ItemRepository.kt`): `itemFields` (heavy) and `browseFields`
  (light — `PRIMARY_IMAGE_ASPECT_RATIO`, `OVERVIEW`, `GENRES`, `CHILD_COUNT`, `DATE_CREATED`,
  `CAN_DELETE`). **Use `browseFields` for rows** — that's what the resume/next-up rows use, and it's
  lighter on the 1 GB device. Watch-state (`UserData`) and image tags come back by default; no field
  entry needed.
- **What we get for free:**
  - Continue Watching: `HomeSectionType.RESUME` → `helper.loadResumeVideo()` (`HomeRowsFragment.kt:110`).
  - Recently Added: `HomeSectionType.LATEST_MEDIA` → `helper.loadRecentlyAdded(...)` (:107).
  - Fanart backdrops: on item focus, `backgroundService.setBackground(item.baseItem)`
    (`HomeRowsFragment.kt:274`). Automatic for our rows too.
  - Live content refresh: websocket `LibraryChangedMessage` / `UserDataChangedMessage` →
    `refreshRows(force=true)` (`HomeRowsFragment.kt:167-173`) re-pulls each row's items.
  - 2-way watch/resume sync: standard client behavior.

### The preferences system (needed for Approach B)

- `preference/UserSettingPreferences.kt`: a `DisplayPreferencesStore` (server-synced, id
  `usersettings`, app `emby`). Home sections are `homesection0..9` `enumPreference`s;
  `activeHomesections` = the non-`NONE` ones. **`HomeSectionType` is an `enum` in
  `constant/HomeSectionType.kt`** — we deliberately **do not** add a value to it (SDK/web-sync
  contract; unknown types historically crash other clients). Collection rows are appended
  app-side instead.
- Preference factories exist (`preference/src/main/kotlin/Preference.kt`): `booleanPreference`,
  `intPreference`, `stringPreference`, `enumPreference`.
- Settings-screen DSL (`ui/preference/dsl/`): builders `checkbox`, `seekbar`, `list`, `enum`,
  `action`, `info`, `link` all exist. The home settings screen is
  `ui/preference/screen/HomePreferencesScreen.kt`; it's reachable via
  `CustomizationPreferencesScreen.kt:82` (`withFragment<HomePreferencesScreen>()`).

---

## PART II — Approach A: "all collections as rows" (MVP, ~2 files, shippable)

This is the recommended first build. Two files change; no new files; no new resources.

### Edit 1 — `app/src/main/java/org/jellyfin/androidtv/ui/home/HomeFragmentHelper.kt`

**Add imports** (near the existing `org.jellyfin.sdk...` imports, lines 9–15):
```kotlin
import org.jellyfin.sdk.model.api.ItemSortBy
import org.jellyfin.sdk.model.api.request.GetItemsRequest
```
(`BaseItemDto`, `BaseItemKind`, `ChangeTriggerType`, `ItemRepository`, `BrowseRowDef` are already
imported in this file.)

**Add a factory method** (e.g. after `loadOnNow()`, before the `companion object` at line 79):
```kotlin
fun loadCollectionRow(collection: BaseItemDto): HomeFragmentRow {
    val query = GetItemsRequest(
        parentId = collection.id,
        fields = ItemRepository.browseFields,
        imageTypeLimit = 1,
        limit = ITEM_LIMIT_COLLECTION,
        sortBy = setOf(ItemSortBy.SORT_NAME),   // or PREMIERE_DATE for franchise order
    )
    return HomeFragmentBrowseRowDefRow(
        BrowseRowDef(
            collection.name.orEmpty(),
            query,
            ITEM_LIMIT_COLLECTION,
            arrayOf(ChangeTriggerType.LibraryUpdated),   // re-pull contents on server library change
        )
    )
}
```
This method does **no** network I/O — it only builds a `BrowseRowDef`; the fetch happens later
inside `ItemRowAdapter.Retrieve()` on the existing pipeline. So the helper needs no `api`.

**Add the constant** to the `companion object` (alongside the other `ITEM_LIMIT_*` at lines 81–84):
```kotlin
private const val ITEM_LIMIT_COLLECTION = 50
```

### Edit 2 — `app/src/main/java/org/jellyfin/androidtv/ui/home/HomeRowsFragment.kt`

**Add imports** (among the `org.jellyfin.sdk...` block, lines 51–54):
```kotlin
import org.jellyfin.sdk.api.client.extensions.itemsApi
import org.jellyfin.sdk.model.api.BaseItemKind
import org.jellyfin.sdk.model.api.ItemSortBy
```

**Insert the BoxSet enumeration** immediately after the `for (section in homesections) when (...)`
loop closes (after line 121) and before `// Add sections to layout` (line 123), still inside the
`Dispatchers.IO` coroutine:
```kotlin
// Custom: one row per collection (BoxSet). The controller curates/rotates these server-side;
// the client just mirrors the current set, alphabetically. See JELLYFIN_CLIENT_FORK_PLAN.md.
if (isActive) {
    val collections = runCatching {
        api.itemsApi.getItems(
            includeItemTypes = listOf(BaseItemKind.BOX_SET),
            recursive = true,
            sortBy = listOf(ItemSortBy.SORT_NAME),
            imageTypeLimit = 1,
        ).content.items.orEmpty()
    }.getOrElse {
        Timber.e(it, "Failed to load collection rows")
        emptyList()
    }

    for (collection in collections.take(MAX_COLLECTION_ROWS)) {
        rows.add(helper.loadCollectionRow(collection))
    }
}
```
`Timber` is already imported (line 56). `.content.items.orEmpty()` is null-safe regardless of the
SDK nullability of `items`.

**Add a companion object** (the class currently has none — add before the final `}` of the class,
after `onDestroy`/the listener inner classes):
```kotlin
companion object {
    // Cap rows to protect the 1 GB / API-22 stick. Raise on a 4K Max.
    private const val MAX_COLLECTION_ROWS = 20
}
```

That's the entire MVP. Collection rows appear after the standard sections, each a poster row with
working focus-backdrop and watch-state ticks.

### Ordering & curation with zero client config
Rows are alphabetical by collection `SortName`. Because your controller *names* the collections,
you control order and inclusion entirely server-side:
- **Order:** prefix names, e.g. `01 · Feel-Good`, `02 · Epics` (strip the prefix in display later if
  you like). No client change.
- **Curate (optional, 3 lines):** to show only *marked* collections, filter in the `for` loop, e.g.
  `.filter { it.name?.startsWith("★") == true }` — lets the controller flag which BoxSets are
  "featured" without an in-app UI.

### Effort
~25 lines across 2 files. **Once the toolchain builds (Part IV), ~2–4 hours** including a device
test pass.

---

## PART III — Approach B: in-app control (polish, optional)

Two tiers. **B1 is cheap and low-risk; do it if you want couch-side control without server renames.
B2 is the full picker.**

### B1 — a toggle + a max-rows slider (recommended polish)

**`UserSettingPreferences.kt`** — add to the `companion object` (import
`org.jellyfin.preference.booleanPreference`):
```kotlin
val showCollectionRows = booleanPreference("showCollectionRows", true)
val maxCollectionRows  = intPreference("maxCollectionRows", 20)
```
(These persist to the server's DisplayPreferences under the `emby`/`usersettings` id — they roam
with the user and survive reinstalls. `intPreference` is already imported.)

**`HomeRowsFragment.kt`** — gate the enumeration and read the cap:
```kotlin
if (isActive && userSettingPreferences[UserSettingPreferences.showCollectionRows]) {
    val cap = userSettingPreferences[UserSettingPreferences.maxCollectionRows]
    // ...getItems as in Approach A...
    for (collection in collections.take(cap)) rows.add(helper.loadCollectionRow(collection))
}
```
(`userSettingPreferences` is already injected at `HomeRowsFragment.kt:66`; the `[...]` get operator
is the same one used by `activeHomesections`.)

**`HomePreferencesScreen.kt`** — add UI inside the existing `category { ... }` (or a new category).
The `checkbox` and `seekbar` DSL builders are confirmed present:
```kotlin
checkbox {
    setTitle(R.string.pref_show_collection_rows)   // new string resource
    bind(userSettingPreferences, UserSettingPreferences.showCollectionRows)
}
seekbar {
    setTitle(R.string.pref_max_collection_rows)    // new string resource
    min = 0; max = 27; increment = 1
    bind(userSettingPreferences, UserSettingPreferences.maxCollectionRows)
}
```
Add the two `<string>`s to `app/src/main/res/values/strings.xml`. **⚠ VERIFY** the exact `seekbar`
property names (`min`/`max`/`increment`) against `ui/preference/dsl/OptionsItemSeekbar.kt` — the
builder exists; confirm the field names before compiling.

**Effort:** ~30–60 min. No new files.

### B2 — full "pick & order which collections" screen (only if you really want it)

- Store an ordered id list as a `stringPreference("collectionRowIds", "")` (comma-joined UUIDs).
- Build a **custom `OptionsFragment`** (not the static DSL) that, in `onViewCreated`, fetches all
  BoxSets via `api.itemsApi.getItems(...)` (same query) and renders one `checkbox` per collection
  plus up/down `action`s to reorder, writing the id list back to the pref. The DSL supports dynamic
  content because `screen`/`category` are built in Kotlin at fragment-create time — but you'll fetch
  collections in a coroutine and rebuild the category, so this is the one piece that needs real
  Android care (async + focus).
- `HomeRowsFragment` reads the id list; empty ⇒ fall back to Approach A ("all, alphabetical").

**Effort:** ~300–500 LOC, ~1–3 days. **Skip unless B1 + server naming proves insufficient.**

---

## PART IV — Build environment (headless, on your Linux movie-server)

You already drive the stick over ADB from the server (`FIRESTICK_KODI.md` §2/§5), so build there
too — no separate machine, no Android Studio required.

### One-time toolchain setup
1. **JDK 21** (toolchain-enforced by `buildSrc`). Install Temurin 21:
   ```bash
   sudo apt-get install -y temurin-21-jdk   # or: apt-get install openjdk-21-jdk
   java -version                            # confirm 21
   export JAVA_HOME=/usr/lib/jvm/temurin-21-jdk-amd64
   ```
   (If you'd rather not set `JAVA_HOME` globally, pass `-Dorg.gradle.java.home=/path/to/jdk21` to
   Gradle.)
2. **Android SDK command-line tools** (no Studio):
   ```bash
   mkdir -p ~/android-sdk/cmdline-tools && cd ~/android-sdk/cmdline-tools
   # download commandlinetools-linux-*.zip from developer.android.com, unzip into ./latest
   export ANDROID_SDK_ROOT=$HOME/android-sdk
   export PATH=$PATH:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin
   yes | sdkmanager --licenses
   sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
   ```
   The Gradle wrapper (`gradlew`) auto-downloads Gradle 9.1.0 and AGP 8.11.1; you don't install
   those yourself.
3. **Disk/RAM:** first build pulls the Gradle dist + dependency cache (~2–4 GB in `~/.gradle`) and
   needs a couple GB RAM for the daemon. Your NUC is fine.

### Build
```bash
git clone https://github.com/jellyfin/jellyfin-androidtv
cd jellyfin-androidtv
git switch -c collections v0.19.9     # branch off the tag we verified
# ...apply Part II edits...
./gradlew assembleDebug               # → app/build/outputs/apk/debug/app-debug.apk
```
- Output: `app/build/outputs/apk/debug/app-debug.apk`, applicationId `org.jellyfin.androidtv.debug`,
  auto-signed with the Android debug keystore (`~/.android/debug.keystore`), universal (contains
  `armeabi-v7a`).
- **Sanity build first, then edit:** do a clean `./gradlew assembleDebug` on the untouched tag
  before applying edits, so any toolchain problem is isolated from your code.

### Signing (only if you ever want a non-debug build)
For a single personal device, **the debug APK is sufficient indefinitely.** The only rule: always
reinstall with the *same* key or `adb install -r` fails with a signature mismatch. If you want a
"release" build later:
```bash
keytool -genkey -v -keystore ~/jf.jks -alias jf -keyalg RSA -keysize 2048 -validity 10000
./gradlew assembleRelease \
  -Pkeystore.file=$HOME/jf.jks -Pkeystore.password=... -Pkeystore.alias=jf -Pkeystore.aliasPassword=...
```
(The release `signingConfig` is created only when those `keystore.*` properties are present —
`app/build.gradle.kts:33-40,68`.) **Keep the keystore backed up** — losing it means no in-place
updates. The debug path avoids this entirely.

---

## PART V — Deployment to the Fire TV Stick

Reuse the exact ADB wiring from `FIRESTICK_KODI.md` (wired Ethernet, `192.168.1.77`, ADB already
enabled, unknown sources on).

```bash
FIRE=192.168.1.77:5555
adb connect $FIRE                                   # re-approve on TV if prompted
adb -s $FIRE install -r app/build/outputs/apk/debug/app-debug.apk
adb -s $FIRE shell monkey -p org.jellyfin.androidtv.debug -c android.intent.category.LAUNCHER 1
```

Details that matter:
- **Coexistence:** the debug build's `.debug` applicationId means it installs *next to* anything
  else (the Kodi app, or an official Jellyfin app), labeled **"Jellyfin Debug"** on the launcher.
  Nothing is clobbered; Kodi stays as the fallback.
- **First launch = one login:** it's a fresh app, so you'll connect to the server once
  (`http://192.168.1.74:8096`, `brennan`/`brennan`). After that, watch-state syncs with the server
  like any client.
- **Updates:** rebuild → `adb install -r ...` again (same key). `-r` keeps app data/login; add `-d`
  if you ever install an older build over a newer one during testing.
- **Rollback:** `adb -s $FIRE uninstall org.jellyfin.androidtv.debug`. Server and Kodi untouched.
- **If DHCP moved the stick's IP:** hunt by the Ethernet MAC exactly as documented in
  `FIRESTICK_KODI.md §5` (`ip neigh | grep -i 8c:2a:85:cd:7b:a6`).

---

## PART VI — Verification checklist (do these on-device)

1. **Baseline first:** install the *unmodified* v0.19.9 debug APK; confirm it launches, connects,
   and that the stock home screen (Continue Watching, Latest, posters, backdrops) performs
   acceptably on the 1 GB stick. This de-risks the whole plan before you write a line. *(This is
   also the go/no-go on hardware.)*
2. After Part II edits: home screen shows the standard sections **plus one poster row per
   collection**, alphabetical.
3. Focus a card in a collection row → the big fanart backdrop updates (BackgroundService).
4. A half-watched movie in a collection shows a resume indicator; resume playback works and syncs
   back to the server (check the web UI).
5. Add/remove a movie in a collection server-side → within the session, the row's *contents* update
   on a library-change websocket push or on returning to home; a *newly created* collection appears
   after relaunch (see the live-refresh note in Part VIII).
6. Scroll performance / memory: with `MAX_COLLECTION_ROWS = 20`, watch for jank or OOM. If rough,
   lower the cap and/or the per-row `limit`.
7. (If B1) toggle off collection rows in Settings → Customization → Home; confirm they disappear.

---

## PART VII — Maintenance workflow (small, on-demand)

- **While pinned to your v0.19.9 fork, maintenance is zero.** A 0.19.x client keeps working against
  your 10.x server for a long time.
- **When you *choose* to take an upstream update:** the patch is ~25 lines in 2 stable files, so:
  ```bash
  git fetch origin
  git rebase v0.20.z          # onto the newer release tag (NOT master while it's minSdk 23)
  # resolve the (usually trivial) conflicts in HomeRowsFragment.kt / HomeFragmentHelper.kt
  ./gradlew assembleDebug && adb -s $FIRE install -r app/build/outputs/apk/debug/app-debug.apk
  ```
  **⚠** Only rebase onto a release tag whose `minSdk` is still ≤ 22 *if you're keeping this stick*.
  Once you move to a 4K Max, any tag is fair game.
- Keep your changes as a single commit (or a `git format-patch`) so re-applying is one step. The
  edits are additive and touch code that has been structurally stable across many releases, so
  conflicts are unlikely.

---

## PART VIII — Risk register & subtleties (each with a mitigation)

| # | Risk / subtlety | Reality | Mitigation |
|---|---|---|---|
| 1 | 1 GB RAM / 27 rows | Real; the reason Kodi skins OOM'd. Native app is far lighter, but many rows still cost memory. | Cap via `MAX_COLLECTION_ROWS` (20) and per-row `limit` (50). Baseline test (VI.1) decides the number. |
| 2 | New collections don't appear live | The *set* of rows is built in `onCreate`; websocket refresh only re-pulls existing rows' *contents*. | Acceptable (new collections show after relaunch). Optional enhancement: also re-run the BoxSet enumeration inside the `LibraryChangedMessage` handler (`HomeRowsFragment.kt:171`). |
| 3 | Controller rotates shelves every ~10 min | Rotation changes collection *membership*; `ChangeTriggerType.LibraryUpdated` + the library-change websocket re-pull row contents. | Works for content churn. For the row *list* itself, see #2. |
| 4 | `getItems` nullability of `items` | SDK 1.7.1 may type `items` nullable. | Plan uses `.content.items.orEmpty()` — safe either way. |
| 5 | `HomeSectionType` enum | Adding a value would desync from web and can crash other clients. | Deliberately **not** touched; collection rows are app-level, appended after standard sections. |
| 6 | Toolchain JDK mismatch | Build requires JDK 21 (toolchain), even though bytecode targets Java 8. | Install Temurin 21 (Part IV) or let Gradle toolchain resolve it. |
| 7 | Signature pinning | Reinstalling with a different key fails. | Always use the same (debug) keystore; back it up if you switch to release signing. |
| 8 | `seekbar` DSL field names (B1) | Builder confirmed to exist; exact property names not verified. | **⚠ VERIFY** against `ui/preference/dsl/OptionsItemSeekbar.kt` before compiling B1. |
| 9 | Next release drops the device | `master` is already `minSdk 23`. | Pin to v0.19.9; don't chase `master`. A 4K Max removes this permanently. |
| 10 | Duplicate content (a movie in many collections) | Expected — a film can appear in several shelves. | This is desired Netflix-like behavior; no action. |

---

## PART IX — Milestones

- **M0 (30 min):** install stock v0.19.9 debug APK on the stick; verify hardware handles the native
  app (VI.1). *Go/no-go.*
- **M1 (½ day):** stand up the build toolchain on the server; clean `assembleDebug` of the untouched
  tag succeeds.
- **M2 (½ day):** apply Part II (Approach A); collection rows render on-device; run VI.2–VI.6.
- **M3 (optional, ½ day):** apply B1 (toggle + cap) if you want couch-side control.
- **M4 (optional):** B2 full picker, only if warranted.

Total to a working, daily-driver build: **~1 day of hands-on work** after M0, most of it one-time
toolchain setup — then near-zero maintenance while pinned.

---

### File-change summary (Approach A)
```
app/src/main/java/org/jellyfin/androidtv/ui/home/HomeFragmentHelper.kt   +2 imports, +1 method, +1 const
app/src/main/java/org/jellyfin/androidtv/ui/home/HomeRowsFragment.kt     +3 imports, +~15 lines, +companion const
```
Everything above was verified against the local `v0.19.9` checkout; the only pre-compile checks left
are the two **⚠ VERIFY** items (SDK `items` nullability is already defensively handled; the
`seekbar` DSL field names matter only for optional B1).
