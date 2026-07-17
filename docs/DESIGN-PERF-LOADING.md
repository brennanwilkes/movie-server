# DESIGN: Loading-Time & UI Responsiveness Overhaul (Web + Fire Stick)

**Date:** 2026-07-17 (4 AM study)
**Scope:** Both repos — `movie-server` (jellyfin-web injection stack + server plugins) and
`~/jellyfin-androidtv` (Movie Night fork). Video playback is fine everywhere; this is about
UI load/interactivity on low-powered devices, and about showing a branded splash instead of
broken half-rendered pages.

---

## 1. Measured evidence (live server, headless Chrome on the NUC, 2026-07-17 ~04:10)

Raw Jellyfin API is **fast**: `/Views` 0.12s, Resume/NextUp/Latest 0.2–0.6s, Top 100 items
with light fields 0.19s, resized poster 0.33s cold / 0.02s cached. Bundles are brotli'd and
small over LAN. The settings page is instant because it touches none of what follows.

Headless-Chrome profile of **home page** (desktop-class CPU, LAN — a Fire Stick is far worse):

| Metric | Value |
|---|---|
| First cards appear | **30.5s** |
| Cards/badges stop changing | **45.8s** |
| Long tasks >50ms | 63, totalling **11.4s blocked main thread** |
| XHR/fetch requests | 59 |
| Final DOM | 493 cards, **1,703 badge elements** |

The two requests that pin the 30s window (everything else queues behind them):

| Request | Time |
|---|---|
| `/HomeScreen/Sections?UserId=…` (Home Screen Sections plugin meta call) | **26.3s** in-page; 9.4–12.7s in isolation |
| `/Playlists/{top100}/Items?Fields=People,Studios` (our flair `loadLists()`) | **19.3s** in-page; **11.2s / 964KB** in isolation |

After the Sections meta call returns (~30s), the web client fires **32 per-shelf content
calls** (`/HomeScreen/Section/ShelfA…T`, BecauseYouWatched, WatchAgain 21.8s, …) plus ~60
thumb images that each take 10–13s while queued.

**Top 100 page** profile: 363 requests (216 images, 50 backdrops), **32.6s of main-thread
blocking** across 80 long tasks, spinner still visible at 60s. The same 11–13s
`People,Studios` fetch runs here too.

**Why settings is instant:** no HSS sections, no playlist/oscar fetches, no card grid, no
image storm — it renders straight from the already-loaded bundle.

---

## 2. Root causes — Web

### 2.1 Server side: Home Screen Sections plugin is the long pole
- We provision **32 enabled shelves** (`jellyfin.sh` §8, `SectionSettings` rows ShelfA–T +
  Jellyseerr Discover/Requests + Radarr/Sonarr upcoming + genres + WatchAgain…).
- The plugin's `/HomeScreen/Sections` meta endpoint takes **9–13s idle, 26s under page
  load** just to enumerate sections (it evaluates shelf visibility/content server-side),
  then the client fetches all 32 section bodies.
- Jellyseerr/Radarr/Sonarr-backed rows fan out to those services server-side; no client
  fix can hide that latency.

**Fix levers (in order):** cut enabled shelves to ~10–12 (rotate the roster nightly via
provisioning instead of showing all at once — variety without the cost); check
plugin config for caching options / update; move Discover/Upcoming rows below the fold or
drop them. Target: meta call under 2s.

### 2.2 Flair JS: `loadLists()` payload is 50× too heavy
`jellyfin-web-flair.js:249-258` fetches the Top 100 with `Fields=People,Studios` —
**964KB / 11s** — on *every page load*, and again every 5 minutes, on every page. Ranks
need only item IDs in order (~10KB, 0.2s). People/Studios enrichment is only used on the
Top 100 showcase page — fetch it there, or serve the controller's existing
`film-awards.json`-style static JSON in one round trip.

### 2.3 Flair JS scheduling: badges starve until the DOM goes silent
This is the direct cause of "rank pills / Oscar icons appear AGES after posters":
- **A1 (critical)** `flair.js:1986-87` — MutationObserver debounce is trailing-reset:
  `scan()` runs only after **500ms of total DOM silence**. During progressive row loading
  on a slow CPU, silence doesn't arrive for tens of seconds even when badge data is ready.
  `scan()` itself mutates the DOM, re-arming the observer.
- **A2** `scan()` re-runs *everything* on every tick (details decoration, drawer reorder,
  4× `querySelectorAll('.navMenuOption')` sweeps, Top-100 logic) regardless of route.
- **A4** every loader (`loadLists`/`loadOscars`/`loadNations`) ends by nuking **all**
  `[data-curated-flair-id]` markers document-wide and re-decorating every card — 4+ full
  re-decorations at startup, each re-firing the observer.
- **A5** all three loaders re-run in full every 5 min (incl. a 2,000-item `Fields=Tags`
  query with a 5,000-item fallback), even in hidden tabs, each ending in a full rescan.
- **A6 (critical)** zero caching: rank/oscar/nation maps are rebuilt from 4–6 API calls on
  every full page load, and can't even start until a 200ms poll sees an authed ApiClient.
- **A3** per-card `getComputedStyle()` read/write interleave while decorating = layout
  thrash across 100-card grids.

**Fixes:**
1. Decorate `addedNodes` directly in the observer callback (per-card, same frame) instead
   of waiting for silence; ignore mutations from our own nodes; scope observer to the
   content container.
2. Cache the four datasets in `localStorage` (keyed userId+timestamp); decorate from cache
   immediately on load, revalidate in background, re-decorate only on diff.
3. Route-gate `scan()` sub-tasks; drawer work only when the drawer mutates.
4. Replace the marker-nuke with diff-based invalidation; one startup barrier → one
   decoration pass.
5. One refresh interval, skipped when `document.hidden`, diffed before invalidating.
6. Add a static CSS rule `.cardImageContainer{position:relative}` and delete the
   per-card `getComputedStyle` check.

### 2.4 CSS: remote theme + double injection = the "broken half-rendered page"
- **D1 (critical)** `jellyfin-custom.css:25-26` — scyfin is pulled from **jsDelivr at
  runtime via `@import`**. The whole look of the app arrives whenever the CDN answers
  (or never, offline/Tailscale-flaky). Until then the page renders functional-but-broken,
  then does a massive restyle. → Vendor scyfin locally at provision time (concatenate into
  jellyfin-custom.css or bind-mount like the fonts).
- **A7** `refreshBrandingCss()` appends the entire ~70KB CSS as a *second* `<style>` —
  CSSOM holds two copies (both with the remote imports). → Remove/disable the original
  node when injecting, or hash-compare and skip.
- **D2** full-viewport grain overlay with `mix-blend-mode:overlay` + crosshatch gradients
  force whole-screen compositing every frame on themed sessions — gate off on low-end.
- **D3** hover rules strip `contain:` from cards (`overflow:visible!important;
  contain:none!important`) defeating Jellyfin's paint containment on 200-card grids.
- **D5** `body:has(.headroom--unpinned)` re-evaluates on every scroll-direction change.
- **A10** Top 100 showcase eagerly sets ~100 backdrop/poster background images on entry
  (the 216-image storm measured above) → lazy-load via IntersectionObserver.

### 2.5 HSS client script: body-wide observer tax
`/HomeScreen/home-screen-sections.js` attaches a MutationObserver to `<body>` with
`{childList, characterData, attributes, subtree:true}` and runs jQuery per mutation — on
**every page**, forever, just to catch clicks on discover cards. Cheap fix if we patch it
(delegated `click` listener on `document` needs zero observers); at minimum it argues for
fewer DOM mutations from our own flair (fixes above reduce its cost too).

---

## 3. Root causes — Fire Stick fork (`~/jellyfin-androidtv`, branch `collections`)

The badge/rank pipeline on TV is **already right** (in-memory maps, off-main refresh,
sized image requests) — not implicated. The problems are row volume and all-or-nothing
gating, both fork-added:

- **A1 (critical)** Home builds up to **43 rows** (`MAX_COLLECTION_ROWS=40`,
  `HomeRowsFragment.kt:408`), each row's `Retrieve()` firing at add-time → ~45 concurrent
  requests squeezed through OkHttp's ~5-per-host limit = de-facto serial. 40 of them use
  `sortBy=RANDOM` (server-side ORDER BY RANDOM per row) and re-fetch on every
  `LibraryUpdated` — i.e. returning to home re-runs everything.
- **A2 (critical)** Focus/readiness waits for **ALL** rows (30s timeout), then spotlight +
  curated lists (15s timeout), before `requestFocus()` — the home screen is visible but
  D-pad-dead until everything lands (`HomeRowsFragment.kt:218-255`). Upstream showed rows
  incrementally and never gated. There's also a listener-attach race that can force the
  full 30s timeout.
- **A3** Two prefetch queries run *serially* before any row is even assembled
  (`HomeRowsFragment.kt:138-171`).
- **A4** Spotlight hero tries up to 5 sequential queries with the heavy `itemFields` set
  and gates the splash handshake on Compose attach timing.
- **Splash flaw:** `StartupActivity` holds the splash *behind* MainActivity —
  `startActivity()` covers it, so the user stares at the half-loaded home anyway; the
  StartupContinue handshake achieves nothing visible (explains BUGS.md #5).

**Fixes (prioritized):**
1. **P0** Signal ready + `requestFocus()` on "first K≈3 rows populated" with a 5–8s cap;
   drop the spotlight/curated wait entirely (pills popping in late is invisible).
2. **P0** Initial build ≤12 rows; append remaining collection rows after ready, or defer
   `Retrieve()` until a row first becomes visible (`lazyRetrieve` flag in
   `HomeFragmentBrowseRowDefRow.kt:54` — also fixes the listener race).
3. **P1** Branded splash as a Compose overlay *inside* MainActivity (Box above home
   content; reuse `brandWordmarkPainter()`/`brandGroundColor()`, pulsing bar via
   `infiniteTransition`), driven by a `StateFlow<Boolean>` replacing StartupLoadState's
   one-shot deferred; delete the StartupContinue cross-activity handshake.
4. **P1** Parallelize the two prefetch queries; add Resume/NextUp rows immediately.
5. **P1** Kill `RANDOM` sort — fetch by SortName/PremiereDate, shuffle client-side; drop
   `LibraryUpdated` triggers from collection rows.
6. **P2** Spotlight: use `browseFields`, collapse fallbacks, never gate on it.
7. **P3** Hoist per-card font/attr lookups (`LegacyImageCardView.java:60-101`), revert
   hot-path `Timber.i` → `Timber.d`.

---

## 4. Splash design — "Movie Night, always, until actually ready"

### Web
Three unrelated "splash" mechanisms exist today (login background PNG; jellyfin-web's boot
`.splashLogo`, removed the instant the bundle boots — exactly when the broken window
begins; the Top-100-only opacity gate whose reveal is hostage to the starved `scan()`).

**Design:** one full-screen branded overlay owned by the flair JS:
- Injected synchronously at script-execute time (public.js runs during index.html parse,
  before app boot) so it takes over seamlessly from the boot PNG. Wordmark + pure-CSS
  pulsing bar (`@keyframes`, compositor-only — animate `transform`/`opacity`).
- Shown again on route changes to heavy views via the `viewshow` event (jellyfin-web
  dispatches `viewbeforeshow`/`viewshow`/`viewdestroy` — no polling needed; this also
  replaces the 200ms `waitForApi` loop).
- Removed when the route's readiness predicate passes, OR a hard 8–10s timeout (never trap
  the user):
  - home: ≥N populated `.itemsContainer`s / first section cards present
  - Top 100: existing `.mn-ready`
  - details: `.detailPagePrimaryContainer` populated
- Once §2 fixes land, the 30s window shrinks to a few seconds and the overlay covers what
  remains.

### Fire Stick
Compose overlay inside MainActivity (fix 3 above): same wordmark + pulsing bar, fades when
first rows are populated, focus granted at the same moment. StartupActivity finishes
immediately after `startActivity()`.

---

## 5. Prioritized work plan

**Phase 1 — kill the 30s window (server + data):**
1. Reduce HSS shelves 32 → ~10–12 in `jellyfin.sh` §8; optionally rotate roster nightly. *(S)*
2. Drop `Fields=People,Studios` from `loadLists()`; enrich only on the Top 100 page. *(S)*
3. Vendor scyfin CSS locally; stop double-injecting CustomCss. *(S)*

**Phase 2 — badges render with posters (flair JS):**
4. Decorate-on-addedNodes + self-mutation guard + scoped observer. *(M)*
5. localStorage cache for rank/oscar/nation/watchlist maps; diff-based invalidation
   replacing the marker-nuke; single hidden-aware refresh interval. *(M)*
6. Route-gate scan sub-tasks; static CSS `position:relative`; batch DOM writes. *(S–M)*

**Phase 3 — branded splash overlays:**
7. Web overlay on `viewshow` + readiness predicates + hard timeout (§4). *(M)*
8. TV Compose overlay + first-K-rows readiness + delete StartupContinue. *(M)*

**Phase 4 — Fire Stick load behavior:**
9. Row count ≤12 + lazy Retrieve + parallel prefetch + no RANDOM sort. *(M)*
10. Spotlight lightweight fields, non-gating. *(S)*

**Phase 5 — polish / low-end GPU:**
11. Top 100 lazy backdrops (IntersectionObserver). *(S)*
12. CSS: containment-preserving hover glow, gate grain/crosshatch off on low-end,
    replace `body:has()`, thin text-shadows. *(S–M)*
13. Patch HSS public.js observer → delegated click listener. *(S)*

**Verification:** re-run the headless profile (script preserved in the session scratchpad;
trivially recreated — puppeteer-core against `movies.local:8096` seeding
`jellyfin_credentials`) before/after each phase. Success = home first-cards <3s, interactive
<5s on desktop; badges within one frame-batch of card appearance; no unstyled/broken frame
ever visible; Fire Stick home focusable <8s.

**Invariants:** IaC-first (all changes via provisioning/repo, no hand-edits in
containers); no git commit/push — Brennan commits.
