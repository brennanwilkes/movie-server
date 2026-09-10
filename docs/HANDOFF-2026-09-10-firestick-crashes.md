# Fire Stick crashes — overnight R&D, 2026-09-09 → 10

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

## What is NOT settled, and the test for it

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

## Not done / deliberately left

* **The 137 MB baseline.** The two fixes attack the detail page's *increment*. The app was already
  at 137 MB RSS before opening anything, and the 23-row home screen is the likely bulk. Untouched —
  `READY_ROW_COUNT` and the splash-wait behaviour are load-bearing for the "never dismiss onto a
  broken UI" preference, so that needs its own measurement pass, not a guess at 3am.
* **The labs and the `src/debug` manifest** are experiment scaffolding. Keep them while this is
  open; delete the `lab` package and `app/src/debug/AndroidManifest.xml` when it is closed.
* Nothing is committed — `jellyfin-androidtv` and `movie-server` both have the changes in the
  working tree only.
