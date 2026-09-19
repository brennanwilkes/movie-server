# Fire Stick client telemetry — what it records and how to read it

**Added 2026-09-07.** Companion to the client fixes of the same date. The point of this file is
the last section: *what to look at in a week*.

## Why

The Movie Night fork's worst faults are intermittent. "The loading screen sort of skips, which
leads to a buggy state" happens perhaps one launch in ten, and there was no record of it ever
having happened — or of anything else.

ACRA is compiled into the app and does catch every uncaught exception, but
`AcraReportSenderFactory` reads a crash-report URL and token out of shared preferences that were
never configured on this server. So every crash was POSTed nowhere, the send failed, and the
report was deleted anyway: `/data/data/org.jellyfin.androidtv.debug/app_ACRA-approved/` is
**empty**. Six months of crashes left no trace.

## Shape

```
Fire Stick                                    controller
──────────                                    ──────────
ClientDiagnostics.record(event, data)
   │  append one JSON line
   ▼
filesDir/diagnostics.jsonl  ──POST x-ndjson──▶  /api/tv-telemetry
   (256 KB cap, oldest half                        │ append
    dropped when full)                             ▼
                                              /config/tv-telemetry.jsonl
                                                 (2 MB cap)
                                                    │
                                    GET /api/tv-telemetry/summary
```

**Buffer first, ship second.** The device writes to disk *before* it tries the network, and only
truncates the buffer on an HTTP 200. A startup fault is exactly the moment the link is least
likely to be working, so nothing may be lost to an unreachable controller. Events from a failed
launch ride along with the next one — that is visibly what happened during commissioning: eight
`app_start` events arrived in one batch once the controller became reachable.

`ClientDiagnostics.setServerUrl()` is called from `JellyfinApplication.onSessionStart()`, not from
the home fragment, so a launch that deep-links straight to an item still ships its events.

## Events

| event | when | key fields |
|---|---|---|
| `app_start` | every process start | — |
| `home_build` | home screen finished building | `outcome`, `totalMs`, `rowCount`, `readyTarget`, `collectionSource`, `collectionFetchMs`, `focused` |
| `controller_rows_failed` | `/api/hss/rows` fetch failed | `error`, `timeoutMs` |
| `splash_backstop_fired` | 30s splash backstop had to dismiss the splash itself | `afterMs` |
| `crash` | uncaught exception, recorded synchronously before the process dies | `thread`, `type`, `message`, `stack` |
| `main_activity_create` | MainActivity created | `restored` (true = came back through the savedInstanceState path) |
| `playback_focus_failed` | the player overlay never took focus, so the controls cannot open | `attempts` |
| `overlay_suppress_expired` | the `shouldShowOverlay` latch had to release itself | `heldMs` |
| `player_key_reveal` | a user key press revealed the player controls via the focus-independent Activity hook (`MainActivity.dispatchKeyEvent` → `CustomPlaybackOverlayFragment.revealControlsFromActivityKey`), and the show latch had been cleared — i.e. exactly the dead-interceptor state the 2026-09-15 fix is meant to make impossible. Emitted only on the hidden→shown edge, so it is low-volume | `keyCode`, `focus` (class that held focus), `inLeanback` |
| `controls_row_empty` | `checkControlsRowRendered` (LeanbackOverlayFragment) found a populated adapter with zero rendered children **and could not recover it by forcing a layout pass**. ⚠️ **CURRENTLY A FALSE POSITIVE — do not read it as a fault.** The detector counts children of an `android.widget.GridView`, but leanback fills `controls_dock`/`secondary_controls_dock` with a `ControlBar` (a `ViewGroup`, not a GridView), so it returns 0 on a perfectly healthy session. Live-verified 2026-09-15 12:28: emitted ~20× during a session whose controls visibly worked. It *was* genuine while the fragment was parked (see the navigation-layout entry below), which is why it looked right then. Until the detector is changed to inspect `ControlBar`, treat this event as noise | `primary`, `secondary`, `primaryChildren`, `secondaryChildren`, `repaired`, `...After` |
| `controls_row_repair` | the same check detected the empty row but a forced `requestLayout()` on the docks + root DID render it within 150 ms. The recovery half of the check; the honest "was broken, now fixed" signal. Has not fired in practice because the navigation-layout fix (below) removed the condition it existed for | `primary`, `secondary`, `*Children`, `*ChildrenAfter`, `repaired` |

`home_build` also carries **`rowsWithItems`** — how many rows ended up with actual content. The
gate counts `onError` as completion (deliberately: otherwise one dead query hangs the splash
forever), so `outcome=ready` can mean "every query came back empty". Without this field the log
cannot tell an honest ready from that.

### What ACRA and this log still cannot see

**Native crashes.** A SIGSEGV is not a Java exception, so neither ACRA nor the uncaught-exception
handler sees it. One was caught by hand on 2026-09-07:

```
signal 11 (SIGSEGV), fault addr 0xdeadbaad
Abort message: 'invalid address or address of corrupt block passed to try_realloc_chunk'
thread: DefaultDispatch
  libskia  SkPath::rCubicTo → SkPathRef::growForVerb → sk_realloc_throw
```

`0xdeadbaad` is bionic's heap-corruption marker. Cause: `ContextCompat.getDrawable()` returns
Drawables that SHARE a ConstantState, and for the vector/layer-list card placeholders that shared
state holds the Skia path data — Coil touches the placeholder on a background dispatcher while the
UI thread draws the same state, and SkPath is not thread-safe. `AsyncImageView.load` now
`mutate()`s the placeholder so each view owns its own copy.

To spot another: `adb logcat | grep -E "signal \(11\)|DEBUG"`. The tombstone under
`/data/tombstones/` is not readable without root, but logcat carries the same dump.

**Anything logged at DEBUG.** This device drops DEBUG from logcat entirely — a `logcat -d` has
**zero** `D/` lines. A `Timber.d` diagnostic is invisible here, which is how the invisible-player-
controls bug went undiagnosed despite already having a log line written for it. Use `Timber.i` or
higher, or record an event.

`crash` is written on the dying thread without taking the file lock — a torn last line costs one
entry, a deadlock would cost the crash record.

## What this caught immediately

Three faults, all of which had been live and silent:

1. **`/api/hss/rows` took ~11s; the client gave up at 5s.** So the TV home screen *never once*
   used the controller's weighted collection picks — it silently fell back to shuffled TMDb box
   sets, and spent 5s of the splash budget doing it. Fixed by caching the BoxSet catalog in
   `hss-shelf.js` (35-min TTL, re-warmed by the half-hourly shelf registration). **10.85s → 2ms.**

2. **The readiness gate never waited for a single row.** It collected row adapters with
   `(row as? ListRow)?.adapter`, but `row` is a `HomeFragmentRow`, not a leanback `Row` — the cast
   was always null, so `browseAdapters` was always empty. The splash lifted as soon as the
   spotlight and hero image were ready, regardless of the rows. This is the "skip" itself.
   Telemetry showed it as `rowCount=0, readyTarget=0`; after the fix, `rowCount=23,
   readyTarget=20`.

3. **The splash never dismissed on a deep-link launch.** Only `HomeRowsFragment` called
   `signalStartupReady()`, so opening an item directly sat behind the branded screen for the full
   30s backstop — recorded as `splash_backstop_fired {afterMs=30004}`.

Two timing bugs were fixed alongside them: `awaitGridFocus()` ran on a fresh 10s clock *after* the
26s readiness gate, so the total could outlast MainActivity's 30s backstop (they now share one
deadline); and `setRetrieveFinishedListener` is one-shot, so a row that finished before the gate
attached its listener could never be counted (the gate now counts non-retrieving rows immediately).

Post-fix a cold launch reports `outcome=ready, totalMs≈9000, collectionSource=controller,
focused=true`.

## The loading skip, caught in the act

The remaining "loading screen skips straight to a broken UI" was reproduced live on 2026-09-07 by
pressing Home and returning to the app. Two events from the SAME pid — the process never died:

```
home_build  totalMs=2080   focused=true    ← the original launch
home_build  totalMs=11513  focused=false   ← the glitch
```

Fire OS destroys MainActivity while it is backgrounded but keeps the process, so returning came
back through the `savedInstanceState != null` restore path. The splash was shown only when
`savedInstanceState == null`, so on that path it was **skipped entirely** — while
HomeRowsFragment still rebuilt all 23 rows from scratch, because a restored activity creates a new
fragment. The screen sat for 11.5 seconds showing every row header with every row empty and
nothing holding focus. A restore is not cheap here; it is a cold start.

Fixed by showing the splash on every MainActivity creation. `main_activity_create.restored` records
which path a launch took.

## Focus is the recurring fault in this fork

Three separate bugs this session were the same underlying problem — nothing holding focus:

- the home grid (`focused=false`, D-pad dead after the splash lifted);
- the player controls, which never opened because Leanback only delivers them via
  `dispatchKeyEvent` on its own root view and a live `uiautomator dump` during a stuck session
  showed **not one node with `focused="true"`** anywhere on screen. Play/pause still worked because
  remote media keys arrive via MediaSession, which ignores view focus — which is why it presented
  as "the controls are simply not there" rather than "the remote is dead";
- the awards row, which could not be read until it was made a focus stop, because leanback only
  scrolls a row fully into view once it takes focus.

When something on this client is unreachable, check focus first.

## Correction: the player controls were NOT a focus bug (2026-09-15)

The bullet above about the player controls is the one entry in that list that was diagnosed
wrongly. Focus was the *symptom*, not the cause. The real cause, found the next day by logging the
fragment's own lifecycle: **the player fragment was never `RESUMED`.**

`DestinationFragmentView.activateHistoryEntry` added every destination with
`setCustomAnimations(fade_in, …)` + `setReorderingAllowed(true)`. FragmentManager defers the move to
RESUMED until the enter transition finishes, and for the full-screen player that transition never
completes. Measured live on the stick during playback:

```
isAdded=true  isResumed=false  isVisible=true  viewShown=true  actState=STARTED
```

while the OS reported the activity RESUMED. (`FragmentActivity.getLifecycle()` is the *fused
FragmentManager* state, so `actState=STARTED` was the stuck manager talking, not the window.) Half
of leanback is gated on `isResumed()` — the key interceptor, the show/hide **animations**, and the
layout pass that fills the controls row. One parked state explains all three reports:
invisible controls, no slide-in animation, and the half-render.

Fixed by landing the player fragment without an animation or reordering (`DestinationFragmentView`,
`isPlayer` branch), so the transition completes at commit and the fragment reaches RESUMED. The
`MainActivity.dispatchKeyEvent` reveal from 2026-09-15 is kept as a **fallback**, not the fix: it
still guarantees a key press shows the controls even if this regresses.

**This is why `uiautomator` showed no focused node and why the media keys still worked.** It was
never "focus on the wrong view"; there was no functional leanback lifecycle to hold focus at all.
The lesson: before blaming focus, check `isResumed()` on the fragment that owns the UI.

## Reading it in a week

```bash
curl -s http://192.168.1.74:8088/api/tv-telemetry/summary | python3 -m json.tool
```

What to look for, in order:

- **`counts.crash` > 0** — open `?event=crash` for the stack. These are the crashes that could
  not be reproduced on demand; this is the whole reason the log exists.
- **`counts.splash_backstop_fired` > 0** — the splash fault recurred. `afterMs` says whether it
  was the 30s backstop or something else.
- **`homeBuild.outcomes.timeout`** — the readiness gate ran out of budget. Compare against
  `homeBuild.totalMs.p95`.
- **`homeBuild.unfocused` > 0** — a build finished with nothing holding focus. This is the
  precise signature of "the loading screen skipped and now the D-pad does nothing".
- **`homeBuild.collectionSource.boxset-fallback`** — the controller stopped supplying rows again;
  cross-reference `counts.controller_rows_failed`.
- **`counts.controls_row_empty`** — ⚠️ **ignore this count** until the detector is fixed (it looks
  for a GridView that leanback never creates). It fires on healthy sessions; see the Events table.
- **`counts.overlay_suppress_expired` with a large `heldMs`** — the real invisibility signature:
  nothing asked the overlay to show for that long while the remote was in use. With
  `OVERLAY_SUPPRESS_MS = 0` you should only ever see near-zero values (e.g. `heldMs=384`).
- **`counts.player_key_reveal`** — the focus-independent reveal fired from the hidden→shown edge.
  Some are expected; a burst is the fallback covering a regression of the navigation-layout fix.

Raw lines, newest first:

```bash
curl -s 'http://192.168.1.74:8088/api/tv-telemetry?limit=50' | python3 -m json.tool
curl -s 'http://192.168.1.74:8088/api/tv-telemetry?event=crash' | python3 -m json.tool
```

Straight off the device, if the controller never got them:

```bash
adb -s 192.168.1.72:5555 shell run-as org.jellyfin.androidtv.debug \
  cat /data/data/org.jellyfin.androidtv.debug/files/diagnostics.jsonl
```

## Notes

- The store is `/config/tv-telemetry.jsonl` — the controller's writable volume. `./data` is
  mounted read-only, so it cannot live there.
- `received` is stamped server-side because the stick has no RTC and its clock can be wrong; the
  device's own `ts` is kept so ordering within a launch survives.
- This is a debug-build diagnostic aid, not a product feature. It is low volume (a handful of
  events per launch) and both ends are capped.
