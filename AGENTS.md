# Movie Server — Agent Reference

This doc helps agents auto-discover the system layout, failure modes, and where to add diagnostics. Read this first before making changes.

**Fast start:** `make test` (30+ PASS/FAIL assertions — run it before AND after changes) ·
`make search q="Title"` (why the grab algorithm picks what it picks) · `make why q="Title"`
(why a title won't play on the PS3/projector) · `AUDIT.md` (2026-07-02 deep audit: verified
findings + what's already fixed + open recommendations).

## System Overview

Self-hosted media stack on NUC `haleiwa`. 7.3 TB USB drive (`/data`), 20 GB loopback image cap (disabled). Services run as Docker containers via `docker compose`. The controller (`controller/server.js`) is the brain — it polls every service every 5s, builds a unified download view, and runs 6 background sweeps.

## File Map

| File | Role |
|------|------|
| `README.md` | User-facing ops guide |
| `AGENTS.md` | This file — agent-facing reference |
| `Makefile` | Top-level ops: `deploy`, `provision`, `logs`, `ps`, `up`, `down` |
| `.env` | Runtime config: credentials, NUC_IP, paths, MDNS_NAME |
| `docker-compose.yml` | Service definitions, volumes, networking, iGPU passthrough |
| `controller/server.js` | **Core**: aggregation API + 6 background sweeps (1830+ lines) |
| `controller/web/app.js` | SPA frontend (Vue/Petite + interactive-search modal) |
| `controller/web/index.html` | Dashboard shell |
| `controller/web/style.css` | Dark theme (custom accent colors) |
| `controller/Dockerfile` | Node 20 slim image |
| `scripts/bootstrap.sh` | One-time host prep: dirs, loopback image, fstab, .env |
| `scripts/deploy.sh` | Pull + recreate containers |
| `scripts/provision.sh` | Apply config-as-code to all services |
| `scripts/teardown.sh` | Stop/clean/destroy with 3 levels |
| `scripts/lib.sh` | Shared shell helpers: `ok()`, `warn()`, `die()`, `wait_http()`, `arr_apikey()` |
| `scripts/ensure-data.sh` | Remount `/data` after drive re-plug |
| `scripts/mdns-publish.sh` | Publish `.local` names via Avahi |
| `scripts/query-logs.sh` | **Tool**: filter docker logs by service/time/grep |
| `scripts/show-history.sh` | **Tool**: dump controller state (missing, declined, attention, disk) |
| `scripts/show-quality-profiles.sh` | **Tool**: dump *arr quality profile config |
| `scripts/search-releases.sh` | **Tool**: search available *arr releases sorted by seeders |
| `scripts/diagnose.sh` | **Tool**: cross-service state comparison (qBit vs *arr vs controller) |
| `scripts/show-indexers.sh` | **Tool**: Prowlarr indexer health/tags/proxy, live-test, per-indexer search counts |
| `scripts/smoke-test.sh` | **Tool**: `make test` — 30+ read-only PASS/FAIL assertions over the whole stack. Run FIRST when anything seems off, and after every change |
| `scripts/why-playback.sh` | **Tool**: `make why q="Title"` — per-title playback diagnosis (PS3 direct-play? transcode feasible? live transcode reasons) |
| `AUDIT.md` | Deep audit 2026-07-02: verified findings, fix log, live-stack snapshot, open [REC] items |
| `docker-compose.yml` → `suggestarr` | Recommendation engine (:5000): Jellyfin history → TMDb similar → Jellyseerr auto-requests. One-time web-UI setup (TMDb key) |
| `scripts/provision/dlna-ps3-profile.xml` | Custom PS3 DLNA device profile (installed by jellyfin.sh; overrides the plugin's built-in) |
| `scripts/provision/_arr_common.sh` | Shared *arr provisioning: quality profiles, custom formats, delay profiles, indexers |
| `scripts/provision/radarr.sh` | Radarr provisioning wrapper |
| `scripts/provision/sonarr.sh` | Sonarr provisioning wrapper |
| `scripts/provision/prowlarr.sh` | Prowlarr provisioning (indexers, download client) |
| `scripts/provision/bazarr.sh` | Bazarr provisioning (languages, providers) |
| `scripts/provision/qbittorrent.sh` | qBit config: speed, ratio, queueing, categories |
| `scripts/provision/jellyfin.sh` | Jellyfin user policy, library scan, API key |
| `scripts/provision/jellyseerr.sh` | Jellyseerr settings, services |
| `scripts/provision/controller.sh` | Writes all API keys into controller container |
| `scripts/provision/custom_tpb_definition.yml` | Custom TPB indexer definition for Prowlarr |
| `data/oscars/build.sh` | Build script: downloads json-nominations dataset → generates `controller/oscar-winners.json` |
| `data/oscars/SOURCE.md` | Source docs for the Oscar dataset; how to update after future ceremonies |
| `data/oscars/latest-winners.json` | Supplementary winners for years not yet in the upstream dataset (merged by `build.sh`) |
| `controller/oscar-winners.json` | Oscar winner lookup keyed by collection name → `[{tmdb_id, title, year}]`, sorted newest-first |

## Service Architecture

```
Jellyseerr (request) → Prowlarr (indexer search) → qBittorrent (download) → *arr (import) → Jellyfin (serve)
         ↑                                                                                       │
         └──────────────────────── Bazarr (subtitles) ←──────────────────────────────────────────┘
```

All ports: `docker-compose.yml:104`

**Network**: Host networking for Jellyfin (PS3 DLNA). Bridge for everything else. Controller reaches all services by container name.

**Auth**: `brennan/brennan` everywhere (LAN-only, no inbound exposure). *arr keys auto-discovered via `arr_apikey()` from config.xml.

## Controller Sweeps (server.js)

The controller runs 6 background sweeps. Each is independent and has its own interval.

| Sweep | Interval | File Lines | What it does |
|-------|----------|------------|-------------|
| `buildDownloads` / `refreshDownloads` | 5s | `628-640` | Polls all services → builds unified `_dl` snapshot |
| `importWatchdog` | 30s | `774-795` | Manual Import for completed-but-not-imported torrents |
| `stallRecovery` | 5min | `837-881` | Reannounce stalling torrents; blocklist+research dead ones |
| `diskGate` | 8s | `1291-1387` | Tear down torrents that would exceed disk cap |
| `orphanSweep` | 5min | `1393-1445` | Delete torrents whose *arr item is gone |
| `seerrSweep` | 15min | `1458-1486` | Delete Jellyseerr entries for deleted *arr items |
| `arrSweep` | 5min | `1520-1685` | Remove stuck queue items, dedup duplicates, trigger searches for missing items |
| `requestGate` | 1min | `1786-1779` | Flag Jellyseerr requests stuck on disk space |
| `jfLibraryRefresh` | event + 2min watchdog | `1787-1816` | Trigger Jellyfin library scan after imports |
| `gpuVerifySweep` | 10min | search `gpuVerifySweep` | Post-import ground truth, ZERO-GAP: a movie imported <48h ago whose mediaInfo is 10-bit/HDR/AV1/VP9 gets a strictly-better H.264 release grabbed (search-first, playstate-guarded); the OLD FILE STAYS until the replacement completes (`gpuPending` persisted), then swap+import. Once per movie ever (`gpuSwapped`); UI labels the download "Auto-upgrade". Log prefix `gpuVerify:` |
| `collectionsSweep` | 12h | search `collectionsSweep` | Maintains native auto-collections from library metadata: decades, top-8 + curated genres, Critically Loved, Short & Sweet, Epic Runtimes, and 8 Oscar-winner categories (Best Picture/Director/Acting/Editing/Cinematography, drawn from `data/oscars/build.sh` via `controller/oscar-winners.json`). Vibes shuffle at random; Oscar collections sort year-descending (newest first). Auto-sets each collection's poster from its best-rated member. Pure Jellyfin Collections API. Log prefix `collectionsSweep:` |

(Line numbers drift — prefer grepping the sweep name in `controller/server.js`. Other cleanups
living inside the sweeps above: `arrSweep` also removes+blocklists terminal import rejections
("not an upgrade"/"sample"); `orphanSweep` also drops zombie `missingFiles` torrents >48h old;
`stallRecovery` also rescues *arr-orphaned dead downloads (torrent exists, queue record gone) by
blocklisting via grab history and deleting the torrent — log prefix `recovery:`.)

### Key Constants (arrSweep — the most important sweep for diagnostics)

```
SEARCH_COOLDOWN_MS  = 6h         # between recovery re-searches of the same item
SEARCH_FAIL_LIMIT   = 4          # → negative-cache for 7 days
SEARCH_BLOCK_MS     = 7 days     # duration of negative cache
SWEEP_MAX_ACTIVE_DL = 10         # no new searches while this many downloading
RECOVERY_GRACE_MS   = 2h         # leave missing item to *arr's own search first
NOTFOUND_GRACE_MS   = 20min      # show "Searching…" before "Not found" in UI
```

### Key Constants (stallRecovery)

```
STALL_DEAD          = 1h         # 0-seed stall before abandoning
REANNOUNCE_EVERY    = 600s       # reannounce interval
RESEARCH_EVERY      = 6h         # re-research throttle
MAX_RESEARCH        = 3          # before accepting title as rare
```

### Key Constants (gates)

```
SUBS_GRACE          = 30min      # max time waiting for Bazarr subtitles
JF_GRACE            = 30min      # max time waiting for Jellyfin scan
HIST_TTL            = 20s        # history + library cache TTL
QUEUE_TTL           = 8s         # *arr queue + qBit cache TTL
```

## Common Failure Modes

### "Why didn't X download?"

1. **Check if it's being searched** → `./scripts/show-history.sh --missing`
   - `cooldown` = searched within 6h, won't retry
   - `blocked` = searched 4× with no grab, blocked for 7 days
   - `grace` = first seen missing <2h ago, leaving *arr's own search alone
   - `recovery=initial` = never searched by sweep yet

2. **Check arrSweep logs** → `./scripts/query-logs.sh controller --grep "arrSweep"`
   - Shows: "X to search, Y skipped (blocked=Z grace=W cooldown=V hasFile=U)"
   - If `hasFile` count is wrong → history cache stale or *arr API issue

3. **Check if disk gate blocked it** → `./scripts/show-history.sh --declined`
   - Disk gate tears down torrents if they'd exceed cap
   - Also check `requestGate` logs for "blocked on disk"

4. **Check if it was grabbed but stalled** → `./scripts/query-logs.sh controller --grep "recovery:"`
   - Shows blocklist+research events and "rare" acceptance

5. **Check if better-seeded options exist** → `./scripts/search-releases.sh --top5 "Skyfall"`
   - Queries *arr for all available releases sorted by seed count
   - Use `--sonarr` for TV shows, `--top3/--top5/--top10` to limit output
   - Helps answer: did the profile pick the best-seeded release?
   - If a better-seeded option exists, manually remove the current torrent and re-search

6. **Check indexers are actually up** → `./scripts/show-indexers.sh` (then `--test` / `--search "term"`)
   - If a whole search comes back thin/empty, an indexer is probably down, not the request
   - **Cloudflare-protected trackers (EZTV) MUST carry the `flaresolverr` tag** or they 403/blocked
   - `error code: 1006` = the tracker IP-banned this host; FlareSolverr can NOT fix it — disable that
     mirror and lean on **Knaben** (meta-aggregator over 30+ sites, incl. 1337x/RARBG/TGx)
   - Indexer config is IaC in `scripts/provision/prowlarr.sh` (a self-healing reconciler); re-run
     `make provision s=prowlarr` to restore tags/enable/priority after any manual UI change

### "Why was THIS release picked?" (codec/size/quality complaints)

1. `make search q="Title"` — every available release ranked by the SAME customFormatScore
   *arr grabs on, with matched formats shown. The grab is the top row that is also
   quality-ALLOWED (2160p/Remux score high but are rejected — qualities cap at Bluray-1080p).
   Ties break by seeders.
2. `make history` — what was actually grabbed/imported recently, with scores.
3. `make profiles` — the live per-tier scores. Compare against `_arr_common.sh`
   `build_formatitems`; if they differ, someone hand-edited the UI → `make provision s=radarr`.
4. File landed 10-bit anyway? Title-based detection can't prove bit depth. Check
   `curl -s localhost:8088/api/library?app=radarr | jq '.items[]|select(.gpuCompat!="ok")|{title,videoLabel}'`
   — and `gpuVerifySweep` auto-swaps such files if imported <48h ago (log: `gpuVerify:`).
   Older files: dashboard Library tab → Redownload.

### "Why isn't this playing on the PS3?"

1. `make why q="Title"` — one command: prints the file's codec/bit-depth/audio/container,
   whether the PS3 can direct-play it, whether this NUC can transcode it in real time, and
   any live Jellyfin session's transcode reasons.
2. PS3 hard limits: H.264 8-bit ≤L4.1 video, mp4/ts containers, AC3 or STEREO AAC audio
   (5.1 AAC = video plays with silent audio), no MKV, no HEVC, no 10-bit — ever.
3. The custom DLNA profile (`scripts/provision/dlna-ps3-profile.xml`, installed to
   `/opt/appdata/jellyfin/data/plugins/configurations/dlna/user/`) caps AAC direct-play at
   2ch and transcodes to MPEG-TS H.264 + AC3 5.1. If the PS3 misbehaves, confirm that file
   exists (make test checks it), then check Jellyfin logs for the chosen profile.
4. Discovery problems (server not in PS3 menu): Jellyfin runs HOST networking bound to
   $NUC_IP; DLNA plugin blasts alive every 180s. `curl -s http://$NUC_IP:8096/System/Info/Public`.
5. Stutter/buffering during PS3 playback: 10-bit HEVC source = CPU decode on a 2c/4t box —
   check `curl -s localhost:8088/api/system` (load) and use Movie Mode (dashboard) to pause
   all downloads/sweeps while streaming.

### "Why is a TV series stuck with only some seasons?"

Sonarr's on-add / `SeriesSearch` only looks for whole-season **packs**. A currently-airing show
usually has no pack, so those seasons come back empty and never fill in on their own.
- The controller's `arrSweep` recovers this by firing `EpisodeSearch` on the specific missing
  **monitored, aired** episode IDs (see `missingEpisodeIds` in `controller/server.js`) — per-episode
  search finds the individual releases that packs-only search misses. Respects per-season monitoring,
  so requesting one season still grabs only that season.
- Manual kick: `curl -X POST .../api/v3/command -d '{"name":"EpisodeSearch","episodeIds":[...]}'`

### "Why is this stuck at 'Importing'?"

The import watchdog runs every 30s but backs off 120s per folder. Check:
- `./scripts/query-logs.sh controller --grep watchdog` — shows "not importable yet: <reason>"
- Common reasons: "no matching movie" (file name parsing mismatch), "rejected" (file quality below cutoff)

### "Why did it grab a huge/bloated release?"

Quality profile scoring. Check:
- `./scripts/show-quality-profiles.sh radarr` — shows format scores
- The `Size >15 GB` format should have a large negative score in Low/Normal tiers
- If a REPACK beat the size penalty → check `downloadPropersAndRepacks` = `doNotPrefer`
- Run `make provision s=radarr` to re-apply profile config

### "Why does EpisodeSearch return 0 results on TPB?"

Two possible causes:

**1. TVDB/Skyhook rate limit (Prowlarr log: `Term: []`)**
Prowlarr converts Sonarr's `rid` to a text query via Skyhook (TVDB proxy). Skyhook rate-limits after ~10 lookups. When rate-limited, `.Keywords` is empty and searches return 0.
- **Fix**: TPB Cardigann definition was updated to `tv-search: [q, season, ep]` so Prowlarr uses Sonarr's `q` param directly, bypassing TVDB lookup entirely.
- To verify: check if Prowlarr log shows `Term: [Better Call Saul]` (text) vs `Term: []` (TVDB failed).
- After Cardigann fix Prowlarr must be restarted and the TPB indexer re-created (delete + re-add via API or UI) to pick up the new caps.

**2. Year-scoped query fails (Prowlarr log: `0 reports` then fallback succeeds)**
Skyhook returns "Better Call Saul 2014" (with year). TPB ignores year → 0 results. Prowlarr internally falls back without year → 23+ results.
- **Fix**: Year-stripping keywordsfilter added to TPB Cardigann definition: `(\D)\d{4}(\W|$) → $1$2`.

**3. "TV search skipped due to unsupported capabilities"**
Prowlarr's Cardigann engine checks if the search parameters match the indexer's caps. If `rid` is used but not in `caps.modes.tv-search`, the indexer is skipped.
- **Fix**: Added `season, ep` to `caps.modes.tv-search` (doesn't need `rid` because text `q` is preferred).

### "Why did Sonarr grab the whole season pack instead of individual episodes?"

The controller's `arrSweep` uses `EpisodeSearch` for series with partial content (some episodes already have files) and `SeriesSearch` for fully missing series. The behavior changed in server.js:1688-1763:
- Radarr: single-file items skipped
- Sonarr: pass through even with files; `EpisodeSearch` for partial, `SeriesSearch` for fully missing

### "Why is a Sonarr series stuck in grace?"

`RECOVERY_GRACE_MS` = 2h after first detection. Shows as `grace=32` in arrSweep logs. Gives Sonarr time to search on its own before the controller intervenes.

### "Why did everything show 'Needs attention' after a restart?"

After a qBittorrent crash/restart, torrents get `state=error` or `state=missingFiles`. The controller's `buildDownloads` shows "Needs attention" for errored torrents that the *arr history cache hasn't linked to a library file yet (cold cache after restart, or API timeout).

**Normal recovery**: the history cache warms within 20s (`HIST_TTL`) and items flip to "Ready". If they don't, check:
- `./scripts/diagnose.sh --orphans` — shows controller-vs-qBit hash mismatches
- `./scripts/diagnose.sh --qbit` — lists every errored/missingFiles torrent

**If items stay red**: the *arr history page size (250) may not cover old imports. The fix at `server.js:498-520` adds a title-based fallback: if the normal hash lookup misses, it matches the torrent name against *arr library titles and checks `hasFile` directly, bypassing history entirely.

### "Why is Bazarr not getting subtitles?"

- Check subs grace: 30 min window before the UI gives up
- `./scripts/query-logs.sh bazarr` for provider errors
- Bazarr config at `/opt/appdata/bazarr/config/config.yaml`

## Diagnostic Commands

```bash
# Who's alive?
curl -s http://localhost:8088/api/status | python3 -m json.tool

# Disk usage
curl -s http://localhost:8088/api/disk | python3 -m json.tool

# Full download pipeline (every row in the dashboard)
curl -s http://localhost:8088/api/downloads | python3 -m json.tool | head -100

# NUC load
curl -s http://localhost:8088/api/system | python3 -m json.tool

# Cross-service diagnosis
./scripts/diagnose.sh

# Torrent state breakdown from qBittorrent
./scripts/diagnose.sh --qbit

# Unlinked torrents (in qBit but not in controller/*arr)
./scripts/diagnose.sh --orphans

# *arr queue status (blocked imports, stuck items)
./scripts/diagnose.sh --queue
```

## Log Query Patterns

```bash
# All recent activity from a sweep
./scripts/query-logs.sh controller --grep "arrSweep|recovery:|watchdog|diskGate|heartbeat"

# See what was blocked on disk
./scripts/query-logs.sh controller --grep "diskGate|blocked on disk"

# See stalled/rare torrent decisions
./scripts/query-logs.sh controller --grep "recovery:"

# Live watch of controller decisions
./scripts/query-logs.sh controller --since 0 --grep "INFO" --watch

# A specific service
./scripts/query-logs.sh radarr --since "2h"

# Diagnose Sonarr search failures (TVDB rate limit, caps mismatch)
./scripts/query-logs.sh prowlarr --grep "Term: \[\]|TV search skipped|unsupported capabilities" --since "1h"

# See if TPB is actually being searched with text
./scripts/query-logs.sh prowlarr --grep "q.php\?q=better.call.saul" --since "30m"
```

## Quality Profiles (Three Tiers)

All tiers allow full SD→1080p range. They differ only in size-band scores:

- **Low (save space)**: biases hard toward tiny (<1.5 GB, +150 for radarr). 720p ranked above 1080p. For space-constrained or casual viewing.
- **Normal**: balanced. 1.5-3 GB gets +80. For everyday use. Default for all migrated items.
- **Beloved (best quality)**: biases toward larger 1080p (6-15 GB). For important content.

**Cutoff**: Bluray-1080p (Low uses Bluray-720p cutoff so small 720p is terminal).

**Codec hierarchy**: H.264 (+80) > HEVC 8bit (+20) > Likely-10bit-group (-120) > 10bit (-150) > HDR/DV (-200) > AV1/VP9 (-1000).
The H.264/HEVC gap is DELIBERATE and load-bearing: at parity (+50/+50) *arr broke ties by
seeders, x265 out-seeds x264 on popular titles, and modern x265 is 10-bit WITHOUT saying so
in the title (ffprobe-verified) — so hidden-10-bit kept winning. Never re-tie them. Titles
that still slip through get caught post-import by `gpuVerifySweep` (mediaInfo ground truth).
Scores live ONLY in `_arr_common.sh` `build_formatitems` — `cf_ensure` reconciles spec changes
to live installs on every provision, so edit the script, never the *arr UI.

**Language**: Original-language audio (+200), Dubbed (-800). Never gates — only orders.

## Credentials & Config

- **All services**: `brennan` / `brennan`
- **API keys**: written to `controller:/config/keys.env` by `provision/controller.sh`; never committed
- **Config root**: `/opt/appdata` (SSD)
- **Media root**: `/data` (7.3 TB USB drive)
- **Controller state**: `/opt/appdata/controller/state.json` (persisted declined/blocked/searchState)
- **mDNS names**: `movies.local`, `movie.local` — published via Avahi, survives DHCP changes

## Making Changes

1. **Profile changes**: edit `scripts/provision/_arr_common.sh`, then `make provision s=radarr` (or sonarr)
2. **Sweep timing/constants**: edit `controller/server.js` constants, rebuild: `make up` or `make deploy s=controller`
3. **New service**: add to `docker-compose.yml`, add provision script, add API key discovery to `controller.sh`, add status check to `server.js:STATUS_SERVICES`
4. **Logging**: all sweeps use `console.log()` (→ docker logs). New diagnostics should use the `INFO/WARN/ERROR` helpers that add log level prefixes.
5. **Library fallback**: the `isErrored` branch in `buildDownloads` (server.js:498-520) now has a title-based fallback when the history cache misses. The `getHasFileMap` function returns `{ hasFile, nameIds }` — both Maps. `hasFile[id]` is the authoritative "in library" check. `nameIds[normTitle]` maps normalized *arr titles to ids. If adding a new fallback, make sure to pre-populate `nameIds` for both `norm(title)` and `norm(title + year)`.

## Restart Safety

The controller persists its state to `/config/state.json` on every sweep mutation. On restart, `loadState()` restores:
- `declined` (disk-gate tombstones)
- `blocked` (request-gate entries)
- `searchState` (cooldown/block timers)
- `gpuSwapped` (movies already GPU-swapped once — the verifier's never-loop guard)
- `masterPaused` (Movie Mode)

This prevents reboot-triggered re-search storms.
