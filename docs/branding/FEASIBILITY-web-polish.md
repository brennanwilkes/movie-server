# Web polish backlog — feasibility analysis

Date: 2026-07-16. Scope: the four "bedtime follow-up" backlog items plus the
Fire-Stick-only snackbar bug. Delivery constraints for all of these: everything
must be **IaC via `make provision s=jellyfin`** — CSS ships through `branding.xml`
(docker cp + restart), flair JS ships through the JavaScript Injector plugin
(`/JavaScriptInjector/public.js`). Our JS loads **after** Jellyfin's web bundle
has booted, inside the authenticated SPA. That single fact decides most of what
is and isn't reachable below.

Legend: **TRIVIAL** (do now) · **MODERATE** (bounded, a session of work) ·
**HARD** (large or fights the platform) · **BLOCKED** (can't act right now).

---

## #18 — Top-right header controls (search / preferences): delete or move to side nav

**Verdict: split. Hiding = TRIVIAL. Moving into the native drawer = HARD.**

The header-right cluster (`.headerRight`) is Jellyfin's own DOM: cast, search,
and the user button (which opens settings/logout). We already leave it almost
untouched.

- **Hide** any of these: one CSS rule (`.headerRight .headerSearchButton{display:none}`
  etc.), fully reversible, ships instantly. Trivial.
- **Move to the side nav**: the drawer (`.navMenuOption` list) is destroyed and
  rebuilt by Jellyfin every open/close — that's why our Top 100 / Watchlist
  entries are *re-cloned every scan* in `addSidebarEntries()`. We could clone a
  "Search" entry the same way and wire its click to `Emby.Page.showSearch()` or a
  hash route. That's MODERATE, not trivial, and it fights the rebuild loop.

**Recommendation / open decision:** search is the primary discovery tool — I'd
*keep* search reachable, not delete it. The likely real complaint is redundancy
(top-right + the button feels stranded) rather than "search is bad." Cleanest
options, in order of effort: (a) just hide the settings/user button top-right and
leave search where it is; (b) hide search top-right and add a themed "Search"
drawer entry. This is a genuine product fork — surfaced as a question, not
guessed.

---

## #19 — Loading times + broken-UI window (esp. Top 100)

**Verdict: two different problems.**

- **Actual load latency** (server round-trips, image decode, Jellyfin's own data
  fetches): **HARD / mostly out of scope.** We can't speed up Jellyfin's internal
  fetching from injected CSS/JS. The only real levers are server-side (already
  tuning trickplay/thermal separately) and image sizing. Not a branding task.
- **The "broken-UI flash" window** (unstyled/half-built page visible for a few
  seconds before our `scan()` runs and before the showcase builds): **MODERATE,
  and partially already solved.** Top 100 already hides its container
  (`opacity:0` → `.mn-ready` reveal) and shows `mn-top100-spinner`. The gap is
  that the *reveal* waits on our showcase build, and other routes have no such
  guard so they flash raw scyfin.

  Feasible improvement: generalize the "hold + branded spinner + fade-in" pattern
  (already proven on Top 100) into a small route-transition overlay driven by the
  existing `hashchange`/observer lifecycle. Reuses code we trust. The risk is
  holding the page *too* long (spinner that never clears if a selector misses) —
  needs a hard timeout fallback so we never trap the user behind our own overlay.

---

## #20 — Persistent branded splash w/ spinner until truly loaded

**Verdict: MODERATE for in-session; the true boot splash is HARD.**

Two layers, often conflated:

1. **App boot splash** (the very first paint before the JS bundle loads): lives in
   the served `index.html` shell, which our injected JS runs *after*. We can't
   restyle the pre-bundle splash from the injector. Restyling it would mean
   patching the web image's `index.html`/`loading.html` in `jellyfin.sh` at
   provision time — possible but a different, heavier mechanism (image-layer edit,
   like the fonts bind-mount), and brittle across Jellyfin upgrades. HARD.
2. **In-session route splash / the stock spinner mid-navigation**: fully reachable.
   Jellyfin shows a generic `.docspinner`/`.loading` indicator on navigation; we
   can style or replace it, and we can render our own pulsing-line/branded overlay
   via the existing lifecycle (same hooks as #19). MODERATE, and it's the same
   work as #19's overlay — **these two should be built together as one
   "branded loading state" feature**, not twice.

The "pulsing line" idea is a pure CSS `@keyframes` (we already have `mn-spin`);
adding a themed pulse is trivial once the overlay host exists.

---

## #21 — Mobile web view (hamburger nav, wide stacked images)

**Verdict: MODERATE–LARGE but feasible; no platform fight, just volume.**

This is bounded responsive CSS plus a little JS, all within reach:

- Hamburger/drawer on mobile: Jellyfin already ships a responsive drawer; our
  regressions are almost certainly *our own* fixed-position wordmark + nav
  overrides (`#mn-wordmark`, `.mainDrawer`, the nav-clearance padding) not being
  guarded behind `@media (max-width:…)`. Fix = wrap our desktop-nav assumptions in
  media queries so mobile falls back to Jellyfin's native behavior.
- Wide, stacked cards on narrow viewports: media-query overrides on card
  containers (`.itemsContainer`, `.card` widths) to force single-column, full-width
  posters.

No new mechanism, but it needs real device-width testing and touches many
selectors that interact with scyfin. Estimate: one focused session. Feasible.
Lowest-risk to do *after* the loading-state work, since both touch layout.

---

## Bug 4 — Top 100 snackbar (Android TV fork)

**Verdict: BLOCKED.** This is the native Fire Stick app, not web. Needs a device
+ `logcat` to reproduce, and the Fire Stick is currently powered off. Cannot
diagnose, fix, or verify until the device is back on. Parked.

---

## Suggested sequencing

1. **#18** — resolve the fork (question), then ship the trivial hide immediately.
2. **#19 + #20 in-session layer** — build one shared "branded loading state"
   overlay on the existing lifecycle (spinner + pulsing line + hard-timeout
   fallback). Highest perceived-quality win.
3. **#21** — mobile media-query pass (guard our desktop nav overrides first).
4. **#20 boot splash** and **#19 real latency** — only if still wanted; both are
   HARD / different mechanism, document-and-defer.
5. **Bug 4** — when the Fire Stick is back on.
