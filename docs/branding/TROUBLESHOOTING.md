# Fire Stick / Jellyfin crash & log troubleshooting crib

## Fire Stick (adb) — stick at `192.168.1.77:5555`, app id `org.jellyfin.androidtv.debug`
```bash
adb connect 192.168.1.77:5555
adb shell am force-stop org.jellyfin.androidtv.debug        # hard-kill the app (fixes wedged/black screen)
adb shell am start -n org.jellyfin.androidtv.debug/org.jellyfin.androidtv.ui.startup.StartupActivity
adb logcat -c                                               # clear, then reproduce, then:
adb logcat -d | grep -B2 -A25 "FATAL EXCEPTION" | grep -v com.amazon   # Amazon system svcs crash constantly — ignore them
adb logcat -d | grep -E "jellyfin|Timber"                   # app-tagged lines
adb shell dumpsys dropbox                                   # crash/ANR records survive logcat rotation
adb shell dumpsys dropbox --print data_app_crash
adb exec-out screencap -p > shot.png                        # see what's actually on screen
```
Notes: "app crashed" reports with NO logcat/dropbox record usually mean a WEDGED process (e.g. recreate-during-startup) or LMK kill, not a Java crash — force-stop first, then reproduce with a clean logcat.

## THE GOLD MINE: ACRA crash reports land on the Jellyfin server
The app's "a crash report was sent to your server" → files on the NUC:
```bash
docker exec jellyfin sh -c 'ls -t /config/log/upload* | head'
docker exec jellyfin sh -c 'grep -oE "\"STACK_TRACE\":\"[^\"]{0,1200}" "/config/log/<file>" | sed "s/\\\\n/\n/g"'
```
Full stack trace, device info, exact build — even when you weren't attached with adb. Check here FIRST.

## Jellyfin server logs
```bash
docker exec jellyfin sh -c 'tail -100 /config/log/log_$(date +%Y%m%d).log'
```

## Build & deploy (fork at ~/jellyfin-androidtv, branch collections)
```bash
cd ~/jellyfin-androidtv && JAVA_HOME=$HOME/jdk-21 PATH=$HOME/jdk-21/bin:$PATH ./gradlew :app:assembleDebug
adb -s 192.168.1.77:5555 install -r app/build/outputs/apk/debug/*.apk
```
Worktree builds need `echo "sdk.dir=/home/brennan/android-sdk" > local.properties`.

## Hard-won landmines (real bugs from this project)
1. **`android:colorAccent` in theme XML MUST be a `@color` resource, never a raw hex literal.** Leanback's
   PlaybackTransportRowPresenter resolves it by resourceId → raw literal = id 0 → `Resources$NotFoundException`
   **crash on pressing Play**. Applies to any attr a library resolves by resourceId.
2. **Fire OS 5 = API 22:** `?attr/...` font references in layout XML silently don't apply; `ImageView.setForeground`
   needs API 23 (use the card/FrameLayout's foreground instead). Compose loads font resources fine.
3. **Activity `recreate()` during the startup flow wedges the app** (black screen, no crash record). Don't change
   the resolved theme while StartupActivity is mid-flow; roulette re-rolls need a background-dwell guard.
4. **Fire OS keeps the app process alive for days** — "per launch" anything must be lifecycle-event based
   (ProcessLifecycleOwner onStop/onStart), not process-lifetime `by lazy`.
5. Heavy `/Items` field sets (MediaSources/MediaStreams/Chapters ×100 items) take ~20-30s on the stick — always
   request minimal `fields=`.
6. Blind adb D-pad navigation is unreliable for reaching specific toolbar buttons — screencap between steps.

## Web client debugging
- CustomCss + flair JS: edit `scripts/provision/jellyfin-custom.css` / `jellyfin-web-flair.js` → `make provision s=jellyfin` → hard refresh.
- Verify class names against the real bundle before styling: `docker exec jellyfin sh -c 'cat /usr/share/jellyfin/web/*.js | grep -o "someClassName"'`
- scyfin themes are CSS-variable driven (`--primary-accent-color`, `--primary-r/g/b`...) — override the VARIABLES.
- Inline styles on `document.documentElement` (flair JS roulette) beat all stylesheets.
- The BOOT loading splash is baked into the web bundle (`banner-light.*.png`) — provision overwrites it in-container.

### Web theme debugging METHOD (2026-07-16 — read this before touching web CSS)

Previous agents burned hours guessing at CSS. Don't guess — **measure, then edit.** The whole
method is: dump computed styles → if an override isn't winning, dump the *matched rules* → do the
specificity math → write the minimal higher-specificity rule. A reusable probe lives at
`scripts/branding-console-probe.js` (paste into DevTools console, logged in as brennan/brennan).

**Deploy & caching model (established, do NOT re-investigate):**
- Live CSS is byte-identical to `jellyfin-custom.css` (provision writes `branding.xml`, §7a sha256-verifies). Live flair JS is byte-identical to `jellyfin-web-flair.js` (JS Injector serves it at a versioned `public.js?v=<ticks>` URL). If a change isn't showing, it's almost never caching — check specificity/scoping first.
- CSS/JS changes ship ONLY via `make provision s=jellyfin`, **never** `make deploy` (deploy just pulls+restarts).
- There is NO service worker (`serviceworker.js` → 404). `index.html` is `Cache-Control:no-cache`. A normal refresh picks up new CSS/JS.

**Two-phase deploy — CSS and flair JS ship at DIFFERENT points of the provision (2026-07-16 landmine):**
- CSS is written to `branding.xml` **before** the §7 restart. The flair JS is pushed to the JS Injector **after**, in **§9** (which needs a working post-restart auth token). So *the two can get out of sync if provision aborts mid-run.*
- Real failure hit this session: §7 re-authenticated immediately after `docker restart jellyfin` with only a 60s window and no health gate; the NUC's cold restart sat right at that boundary → `die "auth failed after restart"` → **provision exited before §9, so CSS updated but flair JS did NOT.** Symptom: your CSS change is live but your JS change isn't, with a *successful-looking* earlier part of the log. Fixed by health-gating the auth loop on `/System/Info/Public` (~120s) — but the lesson stands: **a provision that doesn't print `✓ Provisioning complete.` may have shipped CSS without JS.**
- **ALWAYS verify BOTH are actually served after a provision**, don't trust the log alone:
  ```bash
  curl -s http://localhost:8096/Branding/Css | grep -c 'your-new-css-token'
  curl -s http://localhost:8096/JavaScriptInjector/public.js | grep -c 'yourNewJsFunction'
  ```
  Zero for the JS check while CSS is present = provision aborted before §9. Re-run it.

**Before blaming scyfin, grep our OWN css (2026-07-16):** the "everything is a solid accent-colored block" eyesore (actionsheet items, settings menu links, section-title/MORE buttons all filled teal in canyon) was **self-inflicted** — our own §6 rule `[mn-glow-text="1"] .emby-button { background: <accent> }` paints *every* emby-button. It was NOT scyfin. `grep -n 'emby-button' jellyfin-custom.css` first. To exempt a subset, add a second class for higher specificity (e.g. `.emby-button.button-link`, `.button-submit.emby-button`) rather than a new global rule.

**Why our overrides lose (the #1 time-sink) — specificity + source order:**
- scyfin is loaded via `@import` of a cross-origin jsDelivr URL. Its rules are **invisible to JS/DevTools rule inspectors** (CORS blocks `.cssRules`, and `@import`ed sheets aren't in top-level `document.styleSheets`). So a matched-rules probe will show OUR rules + Jellyfin's bundles, and scyfin is the culprit *by elimination* when computed ≠ any visible rule.
- Our CSS is injected as an inline `<style>`, so on **equal specificity we win by source order** — but scyfin often uses higher-specificity selectors, so a plain `.foo{...!important}` loses. Fix by raising specificity (add an ancestor class / an `[mn-*]` theme-attr prefix), not by adding more `!important`.
- Worked example (tags/links): `[mn-cut-geometry="1"] .emby-button{background:accent!important}` (0,0,2,0) beat `.itemTags a{transparent!important}` (0,0,1,1). Jellyfin renders inline links as `<a class="button-link emby-button">`, so the themed *button* rule hit every link. Fix: `.emby-button.button-link` (0,0,3,0) + later in source.

**Theme tokens are CSS vars set per-theme by the flair JS `applyTheme` (jellyfin-web-flair.js THEMES map):**
`--primary-accent-color`, `--mn-card-radius`, `--mn-btn-radius`, `--mn-divider-accent`, `--mn-muted`, etc.
Reelone (`[mn-cut-geometry="1"]`) sets card/btn radius to **0** (angular theme) — a poster `border-radius:0` is intentional, not a bug. Prefer these vars over hardcoded hex so a rule works across all 4 themes. `[mn-*]` body attrs select the active theme (mn-glow-text=canyon, mn-litho-offset-x=matinee, mn-cut-geometry=reelone, mn-gilded-text=marquee).

**Landmines specific to this theme:**
- `position:` on `.mainDrawer` — DON'T set it. Jellyfin's `.touch-menu-la` gives it `position:fixed;top:0;bottom:0` for full height; overriding to `relative` (equal specificity, ours loads later → wins) collapsed it to `height:0` and the whole left nav "disappeared." Layer with `z-index` only.
- `#mn-wordmark` is `position:fixed`, so `width:100%` resolves against the VIEWPORT, not the 250px drawer — use a drawer-relative px width.
- Card indicators (`.playedIndicator`) get a solid colored circle from Jellyfin `theme.css` + scyfin. Override to transparent bg + `var(--primary-accent-color)`.
- Card hover overlay (`.cardOverlayContainer`) insets inside `.cardImageContainer`'s per-theme border (reelone 2px), so at `inset:0` it's border-width smaller than the poster → grow it with negative `inset`.
- Nav "selected" highlight: the flair JS applies it via inline styles for the Home route (no `.navMenuOption-selected` class), so hover handlers must guard on our own `data-mn-selected` flag or leaving the item wipes the highlight.

### Landmines: drawer/nav DOM manipulation (2026-07-16, #18 header-controls → side nav)
- **Jellyfin destroys & rebuilds the drawer nav on every open/close.** Anything we inject (Top 100 / Watchlist / Search / Settings entries, inline styles, reorder) MUST be re-applied every `scan()` and be **idempotent** (no-op when already present). A one-shot/boolean guard makes injected entries vanish after the first rebuild.
- **Header-right buttons live in the persistent `.skinHeader`; the drawer is transient.** To surface a header action in the drawer, DON'T move the real button (the rebuild would wipe it). Clone a nav-link template and either (a) `href` it to the real route (Settings → `#/mypreferencesmenu`, what Jellyfin's own `onSettingsClick` navigates to) or (b) forward its click: `header.querySelector(sel).click()`. Forwarding preserves all native behavior with zero re-wiring.
- **A popup anchored to a `display:none` button renders at 0,0.** Cast/SyncPlay opened their pickers in the top-left corner because we hid `.headerRight` but forwarded clicks to those buttons. If a forwarded action shows a positioned popup, prefer a direct route/href over click-forwarding (or don't surface it). Search is fine (it navigates, no anchored popup).
- **Reordering the drawer every scan will infinite-loop the MutationObserver.** The observer watches `{childList:true, subtree:true}` — `appendChild`/`insertBefore` (childList) re-fire it → `scan` → reorder → … every 500ms. Guard: compute the desired element sequence, compare to the current one, and only touch the DOM when they differ (see `orderDrawer()`). Note **attribute/style changes do NOT trigger the observer** (not watching `attributes`), which is why `themeDrawer()`'s inline-style writes are safe to run every scan but reordering is not.

**Recurring issue types to expect:** (1) an override that "should work" but loses to scyfin specificity; (2) a fix scoped too narrowly (e.g. `.itemDetailPage`-only) that misses cards/home/search; (3) `@import scyfin@latest` is UNPINNED — a scyfin update can silently change class names/geometry and break overrides (candidate pin: `@v1.5.5`); (4) something that renders differently per theme because a rule hardcodes one theme's value instead of a token.

### Landmine (2026-07-17): theme selectors gated on `[mn-*]` attributes set in JS
The 4 web themes are identified by attributes on `<html>` set in the flair JS `applyTheme`
(`mn-glow-text`=canyon, `mn-cut-geometry`=reelone, `mn-gilded-text`=marquee,
`mn-litho-offset-x`=matinee). CSS rules are gated like `[mn-litho-offset-x="3"] .foo{...}`.
**If a theme's attribute isn't set, EVERY one of its rules silently fails and that theme renders
almost unthemed.** This actually happened: `mn-litho-offset-x` was never `setAttribute`'d (only the
`--mn-litho-offset-x` CSS *variable* was set), so **all of matinee was broken** (Play button
invisible, buttons/tags/wordmark unstyled) while the other three themes worked. When a whole theme
looks wrong, FIRST check `document.documentElement` has its `mn-*` attribute — don't debug individual
rules. Prefer `var(--primary-accent-color)` etc. (always set, attribute-independent) over
`[mn-*="v"]`-gated hardcoded colors where a single themed value suffices.
Note: `mn-glow-color` is also referenced by CSS attribute selectors but only ever set as a CSS var —
the card-hover glow rules `[mn-glow-color]:not(...)` therefore never match (latent, no complaint yet).
