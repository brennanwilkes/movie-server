# Fire Stick crashes — 2026-09-09 → 11

> **READ THE 09-11 SECTION FIRST.** Crash B was **root-caused and reproduced on the device** on
> 2026-09-11. The conclusion recorded below on 09-10 — "the vector-race hypothesis is disproven" —
> was **WRONG**, and wrong because of a second defect in my own lab, not because of anything the
> device did. Jump to *ROOT CAUSE (2026-09-11)*. Everything before it is kept because the
> measurements are still good and the two lab defects are worth never repeating.


Two distinct failures, both of which kill the app with **no dialog and no ACRA report**, which is
why they read identically ("it just quit") and why neither had ever produced evidence.

| | what it is | how it identifies itself |
|---|---|---|
| **A** | kernel low-memory kill of the FOREGROUND app | `adb logcat -d \| grep fg_lmk` → `3p:fg_lmk_500 … key=org.jellyfin.androidtv.debug` |
| **B** | native heap-corruption abort in Skia's path allocator | `adb logcat -d -b crash` → `Fatal signal 11 … 0xdeadbaad`, `SkPathRef::growForVerb` |

Occurrences so far: **A** on 09-08 21:58 (scrolling) and again 09-09. **B** on 09-07 20:47 and
09-09 22:20 (both opening a detail page; the second was Dunkirk, twice in a row).

A third crash on 09-08 21:43 during *1917* was neither of these — it was an ordinary Java
exception from a Jellyfin plugin-install socket message, already fixed and shipped
(`SocketHandler.launchResilient`).

---

## What changed

### 1. `allowRgb565(true)` on the ImageLoader — `di/AppModule.kt`

Coil applies RGB_565 **only** when the decoded image reports `image/jpeg` (verified in
`BitmapFactoryDecoder`, coil 3.3.0), so photos halve and the transparent PNG clearlogos — 399 of
the library's movies have one — are untouched. That gate is what makes it safe globally.

Measured on the API 22 emulator, one Dunkirk detail page of images (35 cast cards at 260×390 plus
a half-screen backdrop), via `ImageCostLab`:

| | ARGB_8888 | RGB_565 |
|---|---|---|
| bitmap bytes | 15,882 KB | **7,941 KB** |
| per card | 396 KB | 198 KB |
| Java heap delta | 16,326 KB | 8,363 KB |
| **PSS delta** | **19,885 KB** | **11,171 KB** |

Verified through the shipping path (request asks for 8888, comes back 565) and verified NOT to
touch logos (`type=Logo` → `ARGB_8888`, alpha intact). The Bob's Burgers clearlogo renders
correctly over the hero backdrop in the emulator UI.

### 2. `PlaceholderRaster` — one shared Bitmap per placeholder resource

This is the bigger one, and it was a surprise.

A `mutate()` was added to `AsyncImageView.load` on 09-07 in response to crash **B**: the card
placeholders are vector-backed (`tile_port_person` is a layer-list wrapping the `ic_user` vector),
the load runs on a background dispatcher, and two threads walking one `VectorDrawable`'s scratch
`SkPath` corrupts the native heap. Sound reasoning — but:

* **it did not work.** Crash **B** recurred on 09-09 at 22:20, twenty-two hours after that build
  reached the stick.
* **it cost 12 MB per detail page.** On API 21/22 `VectorDrawable.draw()` keeps a cache Bitmap on
  its own `VectorDrawableState`; `mutate()` gives every card its own state and therefore its own
  cache bitmap. Measured, 36 placeholders (a detail page's cast + crew rows):

  | | Java heap |
  |---|---|
  | 36 × `getDrawable().mutate()` + draw | **12,031 KB** |
  | 36 cards sharing one Bitmap | 390 KB |
  | 36 × `PlaceholderRaster.get` (shipped) | **~0 KB** (`rasterCacheEntries=1`) |

So the fix was a permanent double-digit-MB regression on the device that gets killed for exactly
that, in exchange for a race it didn't close. `PlaceholderRaster` rasterises each placeholder once,
on the main thread, into a shared immutable Bitmap: no per-card state, and no SkPath left anywhere
for a background thread to race over. `CardPresenter` (20 sites) and `CrewCardPresenter` are
migrated; the remaining one-off views still take the old `mutate()` path via `passThrough`, which
is the right call for a single view.

**Gotcha worth remembering:** the first version keyed the cache on `Drawable.ConstantState`. That
works for a bare `VectorDrawable` but NOT for a `LayerDrawable`, which builds a fresh per-instance
`LayerState` in its constructor — the cache missed every time (`rasterCacheEntries=36`) and cost
7.4 MB instead of 0.4. Hence the resource-id key, and hence callers asking by id.

**Combined: ~20.7 MB off a detail page's peak**, on a device with ~130 MB available that gets
killed around 180 MB PSS.

### 3. Memory breadcrumbs — `ClientDiagnostics.recordMemoryBlocking`

Neither failure runs a Java crash handler, so the only evidence that *can* exist is what was
already on disk. `recordMemoryBlocking` appends synchronously and does no network, and is called
on the way INTO the two expensive moments:

* `detail_rows_begin` — item, type, `peopleN`, full PSS snapshot, before the rows are built.
* `playback_start` — item, play method, full PSS snapshot.

Verified end to end on the emulator: written to `files/diagnostics.jsonl`, shipped to the
controller, and surfaced at `/api/tv-telemetry/summary` under a new `memory` block (peak, latest,
p50/max pssKb).

**The signature to look for after a kill:** a breadcrumb with a high `pssKb`, then an `app_start`
from a NEW session with **no `crash` event in between**. That gap is the kill. A `crash` event
means it was an ordinary Java exception instead, which is a different bug.

### 4. Telemetry accuracy — `unfocusedAtSplash`

`unfocused` was reporting 4 faults in 29 home builds; all four were background *rebuilds* where an
unfocused home grid is correct. `splashUp` is now recorded, and `unfocusedAtSplash` is the honest
count. It currently reads **0**.

---

## Test rig (new, reusable)

`system-images;android-22;android-tv;x86` + AVD **`fire22`** (1024 MB, 1920×1080, density 320) —
the same API level as Fire OS 5. Boot headless:

```bash
~/android-sdk/emulator/emulator -avd fire22 -no-window -no-audio -no-boot-anim \
  -gpu swiftshader_indirect -memory 1024 -port 5556
```

Login taps that work on this image at 1920×1080 (the API 36 coords in `emulator-test.sh` differ):

```bash
adb -s emulator-5556 shell input tap 499 357      # Enter server address
adb -s emulator-5556 shell input text '192.168.1.74:8096'
adb -s emulator-5556 shell input keyevent 66
adb -s emulator-5556 shell input tap 184 405      # Connect
adb -s emulator-5556 shell input tap 618 617      # Add account
adb -s emulator-5556 shell input tap 416 991      # Use a password
adb -s emulator-5556 shell input text 'brennan'
adb -s emulator-5556 shell input tap 480 510      # focus password
adb -s emulator-5556 shell input text 'brennan'
adb -s emulator-5556 shell input tap 1660 852     # IME DONE
adb -s emulator-5556 shell input tap 184 610      # Sign in
```

Two debug-only labs, in `app/src/debug` so they cannot ship in release:

* **`VectorRaceLab`** — draws the real placeholder from N threads at once; modes
  `shared_instance` / `per_thread` / `mutated` / `bitmap` / `main_only`.
* **`ImageCostLab`** — loads a real page's images through the app's own ImageLoader and reports
  bitmap bytes / heap / PSS; also `--es mode placeholders` for the placeholder arithmetic.

---

## ON-DEVICE RESULTS (2026-09-10, after the above was written)

**The crash reproduces on demand, and the new build survives it.**

| | old build (09-08 23:54) | new build |
|---|---|---|
| open Dunkirk from a cold start | **crashed, first try** — `SkPath::rCubicTo`, `0xdeadbaad`, `DefaultDispatch` thread, no `fg_lmk` | **5/5 clean**, incl. scrolling the cast/crew rows |
| detail-page PSS | 119,864 KB (1917) | 119–129 MB (Dunkirk, 5 runs) |

Breadcrumbs are live on the stick: `detail_rows_begin` for Dunkirk records `peopleN: 37,
pssKb: 93226, sysAvailKb: 251396`, and a `playback_start` sample came through at 100,902 KB. Both
visible at `/api/tv-telemetry/summary` → `memory`. The Chapters-row placeholder and the clearlogos
render correctly, so neither change broke anything visible.

**The vector-race hypothesis is DISPROVEN, though.** On the real ARMv7 device, 6 threads × 1,200
*fresh* inflations+draws — 7,200 genuine PathParser runs, concurrent with the main thread doing the
same — survived cleanly. So the SkPath realloc was the **victim, not the culprit**: something else
corrupts the heap, and SkPath's realloc is just the first allocator operation to walk into the bad
block. Removing 36 per-card vector rasterisations removed most of the *detector*.

That is a real improvement — 5/5 where the old build failed immediately, and 20 MB less pressure —
but it is a mitigation, not a root-cause fix. **Treat the underlying corruption as open.** If it
resurfaces, the breadcrumbs will now say what the app was doing and how much memory it had, and
the next suspects are the things that write native memory during a detail-page build: Coil's SVG
decoder, the media3/ffmpeg extension, and the blurhash path.

There is a kill switch for the placeholder change:
`adb shell 'run-as org.jellyfin.androidtv.debug sh -c "echo 1 > files/no-raster"'` then force-stop.

**A lab defect that invalidated the first two rounds of results** (both emulator and device, where
every mode "survived"): `VectorDrawable.draw()` rasterises once into a cache bitmap on its own
state and blits thereafter, so drawing ONE drawable 800 times is about one path build and 799
blits. Only a fresh `getDrawable()` per iteration exercises the path code — hence `VectorRaceLab`'s
`per_iter` / `per_iter_mutated` modes. Do not trust a "survived" from the other modes.

---

## Superseded: what was not settled overnight

**`VectorRaceLab` could not reproduce crash B on the emulator** — 8 threads × 4,000 concurrent
draws of one shared `VectorDrawable` survived cleanly. That is an expected limitation, not a
refutation: x86 has far stronger memory ordering (TSO) than the stick's ARMv7, so a weak-ordering
data race can be benign there and fatal here.

**So run it on the device.** This is the decisive experiment and it takes two minutes:

```bash
cd ~/movie-server/jellyfin-tv-client && ./deploy.sh        # finds the stick itself now
for m in main_only bitmap per_thread mutated shared_instance; do
  adb shell am force-stop org.jellyfin.androidtv.debug
  adb logcat -c
  adb shell am start -n org.jellyfin.androidtv.debug/org.jellyfin.androidtv.lab.VectorRaceLab \
    --es mode $m --ei threads 4 --ei iterations 2000
  sleep 20
  echo "== $m"; adb logcat -d | grep -E "VectorRaceLab|Fatal signal|try_realloc_chunk" | tail -4
done
```

* `main_only` and `bitmap` must survive. If they don't, the hypothesis is wrong entirely.
* `per_thread` or `shared_instance` crashing **proves** the mechanism and proves the fix.
* All five surviving means the vector race is NOT crash B, and the next suspect is whatever else
  writes native memory on that page — the SVG decoder, the media3/ffmpeg extension, or the
  blurhash path. The breadcrumbs will then say how much memory was in play, which separates B from
  A.

Also worth doing tomorrow, and it needs no code: **`adb shell dumpsys meminfo org.jellyfin.androidtv.debug`
before and after opening Dunkirk**, to confirm the ~20 MB saving on real hardware rather than on
an emulator.

---

## ROOT CAUSE (2026-09-11) — proven, reproduced, and fixed

Brennan: "the firestick continues to crash … twice this evening while selecting a film." Three
native aborts were sitting in the crash buffer, all on the build installed 09-10 10:49, and
**`adb logcat | grep -c fg_lmk` was 0** — so none of them was a memory kill. All three identical:

```
Fatal signal 11 (SIGSEGV) … fault addr 0xdeadbaad in tid NNNNN (DefaultDispatch)
Abort message: 'invalid address or address of corrupt block 0x… passed to dlfree'
  libc.so      dlfree / dlrealloc / realloc
  libskia.so   sk_realloc_throw / SkPathRef::growForVerb
  libskia.so   SkPath::lineTo / SkPath::rLineTo   (one was rCubicTo)
  boot.oat                                        <- framework Java: PathParser
```

### The chain, end to end

1. **`android.util.PathParser` is the Java caller.** `boot.oat` is the framework's AOT image, and
   `PathParser.PathDataNode.nodesToPath()` is what calls `Path.rLineTo`/`rCubicTo`. That means a
   `VectorDrawable` being rasterised.

2. **A fresh `getDrawable()` is NOT a fresh vector.** `Resources.loadDrawable` caches the
   `ConstantState`, and `VectorDrawableState.newDrawable()` hands the *same* state to the new
   instance — `mVectorState = state`, no copy. That state owns one `VPathRenderer`, which owns one
   `Path mPath`, and `VPathRenderer.drawPath()` does `vPath.toPath(mPath)`. **Every instance of one
   drawable resource writes its geometry into a single shared SkPath.**

3. **Coil rasterises vectors on a worker thread.** `AsyncImageView.doLoad` runs in
   `lifecycleScope.launch(Dispatchers.IO)`, and when `url == null` it passes the placeholder as the
   request's *data*. From `coil3.fetch.DrawableFetcher.fetch()` (a suspend function, on Coil's
   fetcher dispatcher):

   ```
   Utils_androidKt.isVector(drawable)           // true for any bare android VectorDrawable
   DrawableUtils.convertToBitmap(drawable, …)   // -> Drawable.setBounds + Drawable.draw(Canvas)
   ```

   Those threads are named `DefaultDispatcher-worker-N`. **Android truncates thread names to 15
   characters: `DefaultDispatch`** — the thread in all three dumps.

4. **The specific pair.** `ClockUserView` (the toolbar avatar, on screen on the home page *and*
   detail pages) used `ContextCompat.getDrawable(context, R.drawable.ic_user)` as its placeholder,
   and a user with no avatar makes `url` null — so `ic_user` went to Coil as data and got drawn on
   a fetcher thread. Meanwhile `tile_port_person`, which every person card rasterises on the main
   thread, is a layer-list whose second item is **`android:drawable="@drawable/ic_user"`**. Same
   resource, same cached state, same `mPath`, two threads. That is the crash, and it explains why
   it fires on the home screen as readily as on a detail page.

### Reproduced on the device

`VectorRaceLab`, new `shared_state_varying` mode — one instance per thread (as the app has one per
card) drawn at bounds that change every iteration, 6 threads × 1200:

| mode | result |
|---|---|
| `main_only` | survived — control |
| `bitmap` | survived — **the fix's mechanism** |
| `mutated_varying` | `fg_lmk_500/600/800` — LMK-killed, see below |
| `shared_state_varying` | **CRASHED: `tid (lab-worker-5)`, `SkPathRef::growForVerb`, `'… corrupt block 0xb85c9f28 passed to dlfree'`** |

Same abort, same allocator call, same Skia frame as production.

`mutated_varying` is **inconclusive as a race test** — it was killed by the low-memory killer
before it could finish, because a `mutate()`d instance keeps its *own* 1.5 MB cache bitmap and six
threads churning those exhausts the device. That is itself the 12 MB regression measured on 09-10,
demonstrated from the other direction.

### THE SECOND LAB DEFECT — why 09-10 concluded the opposite

The 09-10 run used `per_iter`: a fresh `ContextCompat.getDrawable()` every iteration. It reported
7,200 "genuine path builds" surviving. It was **~1 path build and 7,199 bitmap blits**, because per
(2) those fresh instances all share one state — cache bitmap included — so once the first draw
rasterised, `canReuseCache()` was true for every later draw from every thread. Both lab defects are
the same trap wearing a different hat: **`VectorDrawable.draw()` only touches path data when the
cached bitmap is unusable.** `canReuseCache()` compares the cache's dimensions against the current
bounds, so the bounds must CHANGE every iteration. Never trust a "survived" from a fixed-size mode.

### The fix

Never let a live vector reach Coil or any background thread; rasterise each placeholder once, on
the main thread, into a shared immutable Bitmap.

* **Five call sites migrated** from `ContextCompat.getDrawable` to `PlaceholderRaster.get(id)`:
  `ClockUserView` (the culprit), `UserViewCardPresenter`, `ItemListFragment`, `NowPlayingView`, and
  `LiveTvGuideFragment` (already safe — a PNG — done anyway so "no call site hands a raw
  `getDrawable()` to `load()`" is a checkable invariant). `CardPresenter` (20 sites) and
  `CrewCardPresenter` were already migrated on 09-10.
* **`PlaceholderRaster.passThrough` no longer calls `mutate()`.** It rasterises instead, and
  reports the call site. `mutate()` was the 09-07 fix; it did not work, Coil's own
  `convertToBitmap` already calls it internally to no effect, and it costs a private cache bitmap
  per instance.
* **One global rasterisation lock.** Per-resource locking would be wrong: `tile_port_person` and
  `ic_user` are different keys sharing one `VPathRenderer`. Contended a handful of times at
  startup and never again.
* **A tripwire.** Anything still handing over a live Drawable emits `placeholder_not_migrated`
  with the Java call site, once per drawable class; `placeholder_raster_skipped` covers the
  off-main-thread and kill-switch paths. Both surface at
  `/api/tv-telemetry/summary` → `placeholderFaults` and should stay empty.

### Telemetry that will not need luck next time

Three of the four ways this app dies run **no Java code at all**, so ACRA and the uncaught handler
structurally cannot see them, and in the log they were indistinguishable from pressing Home:

| | leaves | |
|---|---|---|
| Java exception | `crash` event | covered already |
| native abort | nothing | silent |
| kernel LMK kill | nothing | silent |
| backgrounded, then reclaimed | nothing | **not a fault** |

So the client now keeps `files/live-state.json`, overwritten as it goes: session, timestamp, the
last 12 breadcrumbs with thread names, heap figures, and **whether an activity was resumed**. On
the next launch `reportPreviousDeath()` reads it and, *only if the app was in the foreground*,
emits `died_in_foreground` carrying the whole run-up. Foreground is tracked by counting resumed
activities application-wide via `registerActivityLifecycleCallbacks` — not by hooking
`MainActivity.onPause`, which would mark the app backgrounded exactly when playback starts and
mislabel every playback crash.

Every `record()` and `recordMemoryBlocking()` call is now also a breadcrumb, so all existing
instrumentation feeds it with no extra wiring, plus a new `home_focus` crumb naming the row and
card under the cursor — which is what the 22:08 crash needed and did not have. The file write goes
to a dedicated min-priority thread (`diag-live-state`); `home_focus` fires on every D-pad move on
the main thread, and this device's flash is slow enough that a synchronous write there would drop
frames while scrolling. Cost: a native abort within ~1 ms of a crumb loses that one line, and the
eleven before it are already on disk.

Read it at `/api/tv-telemetry/summary` → `deaths`. `hadJavaCrash` correlates each death against
`crash` events for the same session, so a `died_in_foreground` with `hadJavaCrash: false` is the
native abort or the kill — and the `pssKb` in the last breadcrumb says which (high, with low
`sysAvailKb`, is the kill).

### To verify tomorrow

Nothing is deployed — the APK is built but the stick was switched off for the night.

```bash
cd ~/movie-server/jellyfin-tv-client && ./deploy.sh     # finds the stick itself
make deploy                                             # controller, for the summary fields

# 1. The race is gone from the shipping path: open a few detail pages and scroll the cast rows,
#    then confirm nothing was skipped or left unmigrated.
curl -s localhost:8088/api/tv-telemetry/summary | python3 -m json.tool | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print('placeholderFaults:', d['placeholderFaults']); print('deaths:', d['deaths'])"

# 2. The lab must now survive the mode that killed it. This is the regression test.
adb shell am start -n org.jellyfin.androidtv.debug/org.jellyfin.androidtv.lab.VectorRaceLab \
  --es mode shared_state_varying --ei threads 6 --ei iterations 1200
# ^ still expected to CRASH: it deliberately drives the framework vector directly, bypassing
#   PlaceholderRaster. It is the positive control, not a test of the app.

# 3. Prove the death reporter works, by causing a death it should catch:
adb shell kill -9 $(adb shell pidof org.jellyfin.androidtv.debug)   # while on screen
#    -> next launch must emit died_in_foreground, with home_focus crumbs naming the last card.
# Then the negative case — press Home on the remote FIRST, then kill it:
#    -> must emit NOTHING, because onActivityPaused ran and cleared the foreground flag.
```

**Two known false positives, both ours and neither worth "fixing":** `adb shell am force-stop` and
an `adb install` over a running app both kill the process without running `onActivityPaused`, so
they report as foreground deaths. Expect a `died_in_foreground` after every deploy and every test
force-stop — check its `lastCrumb` before believing it. The alternative (some cleared-on-purpose
marker) would be a flag the real crashes could also clear.

**One known gap:** a crash before *any* activity reaches `onResume` records `foreground: false` and
so is not reported. That window is the first moment of `Application.onCreate`, and a fault there is
almost certainly a Java exception, which the `crash` event already covers.

The honest caveat: the mechanism is proven and the exposure is closed, but "no crash for a week of
normal use" is still the acceptance test, because the failure was always intermittent. The kill
switch (`files/no-raster`) reverts the placeholder behaviour without a rebuild.

---

## Not done / deliberately left

* **The 137 MB baseline.** The two fixes attack the detail page's *increment*. The app was already
  at 137 MB RSS before opening anything, and the 23-row home screen is the likely bulk. Untouched —
  `READY_ROW_COUNT` and the splash-wait behaviour are load-bearing for the "never dismiss onto a
  broken UI" preference, so that needs its own measurement pass, not a guess at 3am.
* **The labs and the `src/debug` manifest** are experiment scaffolding. Keep them while this is
  open; delete the `lab` package and `app/src/debug/AndroidManifest.xml` when it is closed.
* Nothing is committed — `jellyfin-androidtv` and `movie-server` both have the changes in the
  working tree only.
