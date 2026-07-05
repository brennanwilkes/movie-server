# Plan: server-side media segments (skip intro / credits / recap) for Jellyfin

> **STATUS: DONE (verified 2026-07-04).** The server-side work described below is already
> implemented in `scripts/provision/jellyfin.sh` §4 and live on `haleiwa` (10.11.11):
> **Intro Skipper 1.10.11.21** is installed & Active, detection has run ("Detect and Analyze
> Media Segments" + "Media Segment Scan" both Completed), and INTRO/OUTRO segments are present
> for the TV library — a 12-episode API sample returned Outro on 12/12 and Intro on 8/12. Skip
> works end-to-end in the fork.
> **Only gap:** RECAP ("previously on") — Intro Skipper emits Intro/Outro only, so recap-skip has
> no data (client supports it; there's just nothing to skip). This is a plugin limitation, not a
> TODO. To re-run detection for new content: Dashboard → Scheduled Tasks, or wait for the
> scheduled run. The rest of this doc is retained as historical context.

**Audience:** an agent doing the *server-side* work on the movie-server controller. This is
self-contained. The **client is already done** — our "Movie Night" fork of jellyfin-androidtv
(v0.19.9) fully supports media segments: it reads them via `mediaSegmentsApi.getItemSegments`, shows
a "Skip" overlay, and auto-skips per user prefs (INTRO/OUTRO default `ASK_TO_SKIP`; RECAP/PREVIEW
default off). Autoplay-next-episode and the next/previous buttons already work too. **None of that
needs client changes.** ~~The only missing piece is that the **server currently produces no segment
data**, so no skip UI ever appears.~~ (No longer true — see STATUS above.)

## Goal
Make the Jellyfin server generate media segments so intros, credits/outros, and "previously on"
recaps can be skipped — in the fork *and* in the official Jellyfin apps.

## Facts / environment
- Jellyfin server: **`haleiwa` at `http://192.168.1.74:8096`**, version **10.11.11**, admin `brennan`/`brennan`.
- Server runs via the repo's IaC (see `controller/` / provisioning — confirm how Jellyfin is deployed:
  Docker container vs. native; check `docker ps` / compose files / `controller/server.js` and any
  jellyfin service definition). Media library is on the 8 TB USB data drive.
- Media segments were introduced in Jellyfin 10.10+; 10.11.11 supports the **MediaSegments API** and a
  **plugin provider** model. The server ships no segment *detector* by default — a plugin provides them.

## Recommended approach: Intro Skipper plugin
**Intro Skipper** (`intro-skipper/intro-skipper`, formerly `ConfusedPolarBear/jellyfin-plugin-intro-skipper`)
is the standard community plugin that fingerprints audio to detect intros and credits and writes them
as Jellyfin media segments.

### Steps (verify each against the actual deployment)
1. **Confirm how Jellyfin is deployed** and where its config/plugin dir lives
   (`/config/plugins` in the linuxserver/official Docker image; a data dir if native). Check the repo's
   controller/compose for the Jellyfin service and volume mounts. Do it IaC-first — put changes in the
   repo's provisioning, not by hand, per repo conventions.
2. **Add the Intro Skipper plugin repository** in Jellyfin (Dashboard → Plugins → Repositories) using
   the plugin's current manifest URL (look it up — the project moved orgs; confirm the maintained repo
   and a version compatible with server **10.11.11**). Then install the plugin and restart Jellyfin.
   Prefer encoding this in IaC if the deployment supports it (some setups drop the plugin .dll/manifest
   into the plugins volume during provisioning).
3. **Configure & run detection**: in the plugin settings, enable intro + credits detection, then run
   the detection task (Dashboard → Scheduled Tasks → "Detect Introductions"/"Detect Credits"). First
   run scans the whole TV library and is CPU-heavy — expect a long run on the NUC; consider scheduling
   off-hours and watch for the NUC-crash-on-load history (UPS note in memory).
4. **Recaps ("previously on")**: intro/credits detection covers INTRO and OUTRO segments. RECAP
   segments are less commonly auto-detected — check whether the installed plugin version supports RECAP;
   if not, recap-skip won't have data (the client supports it, but there'll be nothing to skip). Note
   this limitation in the writeup.
5. **Verify via the API** (same auth pattern as `jellyfin-tv-client/test-api.sh`): authenticate, then
   for a TV episode id call `GET /MediaSegments/{itemId}` (or the SDK `mediaSegmentsApi.getItemSegments`)
   and confirm INTRO/OUTRO segments come back with start/end ticks. Only then will the client show the
   Skip prompt.

## Client behavior once segments exist (no action needed, just context)
- INTRO/OUTRO → "Skip" prompt appears bottom-right near the segment (default `ASK_TO_SKIP`).
- To make skips automatic instead of a prompt, set the per-type actions to `SKIP` in the app: Settings
  → Playback → Media segment actions (per-type pickers already exist). Optionally we could change the
  fork's defaults in `UserPreferences.kt` (`media_segment_actions`) — a trivial client tweak — but only
  worth doing after segment data is confirmed working.
- Autoplay-next-episode already works (on by default); no server dependency.

## Deliverables for the server agent
1. Jellyfin on haleiwa producing INTRO/OUTRO (and RECAP if supported) media segments for the TV library.
2. IaC/provisioning updated so the plugin + config survive a controller image rebuild (repo convention:
   changes reproducible, not hand-applied). Document any manual step that can't be IaC'd.
3. A short note in the repo: plugin name/version installed, how detection is scheduled, how to re-run it
   for new content, and API-verified proof that segments exist for a sample episode.

## Cross-refs
- Client fork & how segments are consumed: `jellyfin-tv-client/BUILD_AND_TEST.md`, and the research
  summary (all skip/next features already in-app) is captured in the fork memory.
- API/auth test pattern to copy: `jellyfin-tv-client/test-api.sh`.
- Repo conventions (IaC-first, creds, data drive), NUC crash/UPS history: project memory / `controller/`.
