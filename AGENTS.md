# Movie Server — Agent Reference

This doc helps agents auto-discover the system layout, failure modes, and where to add diagnostics. Read this first before making changes.

**Fast start:** `make test` (30+ PASS/FAIL assertions — run it before AND after changes) ·
`make search q="Title"` (why the grab algorithm picks what it picks) · `make why q="Title"`
(why a title won't play on the PS4/projector) · `AUDIT.md` (2026-07-02 deep audit: verified
findings + what's already fixed + open recommendations).

**Deep diagnostics:** when scripts/controller-API aren't enough, query each service's own API directly — see **Direct Service API Access** (key retrieval + the most useful Sonarr/Radarr/qBittorrent/Jellyfin/Jellyseerr endpoints for cross-checking DB vs torrents vs library). For the manual force-grab / naming path, see the **Force-grab / manual-import subsystem** and **Naming & Jellyfin identity** sections + `make metrics a='events --type fg_verify'` (post-import PASS/FAIL health check).

## System Overview

Self-hosted media stack on NUC `haleiwa`. 7.3 TB USB drive (`/data`), 20 GB loopback image cap (disabled). Services run as Docker containers via `docker compose`. The controller (`controller/server.js` + `controller/lib/`, see `controller/README.md`) is the brain — it polls every service every 5s, builds a unified download view, and runs the background sweeps.

## File Map

| File | Role |
|------|------|
| `README.md` | User-facing ops guide |
| `AGENTS.md` | This file — agent-facing reference |
| `Makefile` | Top-level ops: `deploy`, `provision`, `logs`, `ps`, `up`, `down` |
| `.env` | Runtime config: credentials, NUC_IP, paths, MDNS_NAME |
| `docker-compose.yml` | Service definitions, volumes, networking, iGPU passthrough |
| `controller/server.js` | **Core** entrypoint (thin) — subsystems live in `controller/lib/*.js`; module map in `controller/README.md` |
| `controller/lib/` | The controller's subsystems (clients, state, downloads, importer, sweeps, search engine, routes) — behavior-preserving 2026-07 split of the old monolith |
| `controller/web/js/` | Dashboard frontend — plain scripts loaded in order by index.html (no framework, no build step; split of the former app.js) |
| `controller/web/index.html` | Dashboard shell (script load order matters) |
| `controller/web/style.css` | Dark theme (custom accent colors) |
| `controller/Dockerfile` | Node 20 slim image |
| `controller/metrics.js` | Time-series metrics + event log writer/reader (JSONL, zero deps) |
| `scripts/query-metrics.sh` | CLI tool for ad-hoc metrics/event analysis |
| `Makefile` → `metrics` | `make metrics a='system --stats cpu'` |
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
| `scripts/why-playback.sh` | **Tool**: `make why q="Title"` — per-title playback diagnosis (PS4 direct-play? transcode feasible? live transcode reasons) |
| `AUDIT.md` | Deep audit 2026-07-02: verified findings, fix log, live-stack snapshot, open [REC] items |
| `docker-compose.yml` → `suggestarr` | Recommendation engine (:5000): Jellyfin history → TMDb similar → Jellyseerr auto-requests. One-time web-UI setup (TMDb key) |
| `scripts/provision/dlna-ps4-profile.xml` | PS4 DLNA device profile (installed by jellyfin.sh). The console IS a PS4 — it was mislabelled "PS3" until 2026-07-02; a PS4 identifies as "PLAYSTATION 4", so PS3 profiles never match |
| `scripts/ps4ify.sh` + `scripts/ps4ify-sweep.sh` | **Tool + timer**: add an AC3 5.1 compat track (originals kept, video untouched) so DDP/DTS files direct-play on the PS4. Manual: `make ps4ify q="Title"`; automatic: ps4fix.timer (every 30 min, fresh imports) |
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

**Network**: Host networking for Jellyfin (PS4 DLNA/SSDP). Bridge for everything else. Controller reaches all services by container name.

**Auth**: `brennan/brennan` everywhere (LAN-only, no inbound exposure). *arr keys auto-discovered via `arr_apikey()` from config.xml.

## Controller Sweeps (controller/lib/)

The controller runs its background sweeps from the lib/ modules (started
explicitly by server.js — full loop table incl. first-run delays in
`controller/README.md`). Each is independent, has its own interval, and pauses
under Movie Mode (`isMasterPaused()`).

| Sweep | Interval | Module | What it does |
|-------|----------|------------|-------------|
| `buildDownloads` / `refreshDownloads` | 5s | `lib/downloads.js` | Polls all services → builds unified `_dl` snapshot |
| `importWatchdog` | 60s | `lib/importer.js` | Manual Import for completed-but-not-imported torrents. **Pre-pass** first handles force-grabs (`sonarr-force`): imports only when complete, via `importViaGrab` (multi-episode ranges, correct-series-only). Generic recover path also runs `importViaSeasonRemap` for merged-series season mismatches. See the force-grab subsystem section. |
| `forceGrabVerifySweep` | 60s | `lib/importer.js` | ~2.5 min after a force-grab imports, cross-checks Sonarr + Jellyfin and emits `fg_verify` (PASS/FAIL). The manual-import safety net. |
| `stallRecovery` | 5min | `lib/stall-recovery.js` | Reannounce stalling torrents; blocklist+research dead ones |
| `diskGate` | 30s | `lib/sweeps.js` | Tear down torrents that would exceed disk cap |
| `orphanSweep` | 5min | `lib/sweeps.js` | Delete torrents whose *arr item is gone |
| `seerrSweep` | 15min | `lib/sweeps.js` | Delete Jellyseerr entries for deleted *arr items |
| `arrSweep` | 5min | `lib/search-engine.js` | Remove stuck queue items, dedup duplicates, trigger searches for missing items |
| `requestGate` | 5min | `lib/sweeps.js` | Flag Jellyseerr requests stuck on disk space |
| `jfLibraryRefresh` | event + 5min safety net | `lib/jf-scan.js` | Trigger Jellyfin library scan after imports (trickplay-aware) |
| `gpuVerifySweep` | 15min | `lib/gpu-verify.js` | Post-import ground truth, ZERO-GAP: a movie imported <48h ago whose mediaInfo is 10-bit/HDR/AV1/VP9 gets a strictly-better H.264 release grabbed (search-first, playstate-guarded); the OLD FILE STAYS until the replacement completes (`gpuPending` persisted), then swap+import. Once per movie ever (`gpuSwapped`); UI labels the download "Auto-upgrade". Log prefix `gpuVerify:` |
| `collectionsSweep` | 6h + boot | `lib/collections.js` | Maintains native auto-collections from library metadata: decades, top-8 + curated genres, Critically Loved, Short & Sweet, Epic Runtimes, and 8 Oscar-winner categories (Best Picture/Director/Acting/Editing/Cinematography, drawn from `data/oscars/build.sh` via `controller/oscar-winners.json`). Vibes shuffle at random; Oscar collections sort year-descending (newest first). Auto-sets each collection's poster from its best-rated member. Pure Jellyfin Collections API. Log prefix `collectionsSweep:`. **Boot:** `bootSequence()` (search it) waits for Jellyfin to answer, then runs the sweep BEFORE the first `registerHssShelf` so the home shelves have box sets to show on first load — no cold-start empty-home gap. **Manual:** `POST /api/collections/build` runs the sweep + shelf re-register on demand (409 if already running). |

(Grep the sweep name in `controller/lib/` to find it. Other cleanups
living inside the sweeps above: `arrSweep` also removes+blocklists terminal import rejections
("not an upgrade"/"sample"); `orphanSweep` also drops zombie `missingFiles` torrents >48h old;
`stallRecovery` also rescues *arr-orphaned dead downloads (torrent exists, queue record gone) by
blocklisting via grab history and deleting the torrent — log prefix `recovery:`.)

### Key Constants (arrSweep — the most important sweep for diagnostics)

```
SEARCH_COOLDOWN_MS  = 6h         # between recovery re-searches of the same item
SEARCH_FAIL_LIMIT   = 4          # → negative-cache for 7 days (1 day for recent releases)
SEARCH_BLOCK_MS     = 7 days     # duration of negative cache (1 day for recent releases)
SWEEP_MAX_ACTIVE_DL = 10         # no new searches while this many downloading
RECOVERY_GRACE_MS   = 2h         # leave missing item to *arr's own search first
NOTFOUND_GRACE_MS   = 20min      # show "Searching…" before "Not found" in UI
RECENT_RELEASE_WINDOW_MS = 14 days  # movies released within this window get faster retries
RECENT_RELEASE_GRACE_MS  = 30min    # shorter grace for recent releases (vs 2h)
RECENT_RELEASE_BLOCK_MS  = 1 day    # shorter block for recent releases (vs 7d)
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

## Metrics & Event Log System

The controller records time-series metrics and pipeline events to append-only JSONL files on disk. Zero external dependencies — no database, no sidecar. Every sweep emits events alongside its `console.log()` calls.

### Storage Layout

```
/config/metrics/  (→ /opt/appdata/controller/metrics/)
├── system/       CPU%, RAM%, CPU temp°C         — every 10s
├── services/     Service up/down (7 services)    — every 10s
├── dl/           Aggregate pipeline snapshot     — every 10s
├── disk/         Disk total/used/free            — every 300s
└── events/       Discrete pipeline events        — per-occurrence
```

One file per day per stream: `YYYY-MM-DD.jsonl`. Each line is a JSON object. Streams rotate automatically at midnight. Data volume: ~2 MB/day at 10s sampling (~700 MB/year). 35 GB free on the SSD — non-issue for years.

### Schemas

| Stream | Fields | Example |
|--------|--------|---------|
| `system` | `t,cpu,mem,temp` | `{"t":1700000000,"cpu":45,"mem":34,"temp":72}` |
| `disk` | `t,uGb,fGb,tGb,pct` | `{"t":1700000000,"uGb":3800,"fGb":3500,"tGb":7300,"pct":52}` |
| `services` | `t,qb,ra,so,pr,ba,jf,js` (1=up) | `{"t":1700000000,"qb":1,"ra":1,"so":1,"pr":1,"ba":1,"jf":1,"js":1}` |
| `dl` | `t,dl,im,rd,st,dq,spB,eta,rGb` | `{"t":1700000000,"dl":3,"im":1,"rd":120,"st":0,"dq":5,"spB":50000000,"eta":600,"rGb":4.7}` |
| `events` | `t,e,...` (event-type-specific) | `{"t":1700000000,"e":"grab","ti":"Dune (2021)","ap":"radarr","sB":8000000000}` |

### Event Types

Every meaningful pipeline state change is logged. Events carry correlation keys (`ti`=title, `ap`=app, hash) so you can join pipeline phases (grab→dl_done→import_ok) to compute durations.

| Event | Emitter | Data |
|-------|---------|------|
| `grab` | `refreshDownloads` (state transition) | ti, ap, sB |
| `dl_done` | `refreshDownloads` (state transition) | ti, ap, dur(s) |
| `import_ok` | `refreshDownloads` / `importWatchdog` | ti, ap, count |
| `import_err` | `importWatchdog` (transient) | ti, ap, backoff |
| `garbage` | `importWatchdog` (fake file) | ti, ap, fails, blocklisted |
| `orphan` | `orphanSweep` / `importWatchdog` | ti/ap/count/type/source |
| `zombie` | `orphanSweep` | count, ap |
| `missing_start` | `buildDownloads` / `noteMissing` | ap, id |
| `missing_clear` | `buildDownloads` / `noteResolved` | ap, id |
| `search_skip` | `arrSweep` | ti, ap, id, reason, next?, fails?, error? |
| `search` | `arrSweep` | ti, ap, id, mode, fails, eps? |
| `search_probe` | `probeSearchOutcome` | ap, id, ti, mode, manual, attempt, status |
| `search_outcome` | `probeSearchOutcome` | ap, id, ti, mode, manual, kind, summary, queries, hits, errors, indexers, indexerErrors |
| `search_decision` | `probeSearchOutcome` | ap, id, ti, mode, manual, kind, summary, accepted, rejected, reasons, indexerErrors |
| `search_reject` | `probeSearchOutcome` | ap, id, ti, mode, manual, summary, reasons, indexerErrors |
| `search_gap` | `probeSearchOutcome` | ap, id, ti, query, upstreamHealthy, reasonClass, best, seeders, indexer — healthy releases found by a raw text search that never became season-search candidates (e.g. year-named full-series packs with no S01 marker). Surfaced in the UI as a `searchHint`; acquisition is MANUAL only (auto-grab removed 2026-07-07 — see INVARIANTS below) |
| `force_grab` | `/api/force-grab` (manual button only) | ap, id, ti, rel, seeders, indexer, method, infoHash, error? — user picked a specific gap release; `grabGapRelease` adds it to qBittorrent in the **`sonarr-force`** category (NOT `sonarr`) so Sonarr never auto-imports it into the wrong series. `error` on failure |
| `fg_import` | `importWatchdog` force-grab pre-pass | id, ti, imported, files, eps, done, via, infoHash — a force-grab folder was imported (per sweep); `done:true` when all episodes present |
| `fg_giveup` | `importWatchdog` force-grab pre-pass | id, ti, folder, reason, infoHash — **ALERT**: a force-grab could not import (unparseable/no video/max fails). Files stay on disk (never deleted) |
| `season_remap` | `importWatchdog` (`importViaSeasonRemap`) | id, ti, count, hash — a merged-series release whose files are numbered in a sub-show's own S01 (e.g. Cosmos 2014 "Possible Worlds") was remapped to the season Sonarr grabbed it for |
| `fg_verify` | `forceGrabVerifySweep` (~2.5 min after import) | id, ti, tvdb, ok, issues[], sonarr{files,eps,seasons}, jellyfin{tvdb,total,seasons} — **the force-grab safety net**: cross-checks Sonarr AND Jellyfin. `ok:false` with issues like `jellyfin_wrong_tvdb`/`jellyfin_phantom_season`/`jellyfin_extra_episodes`/`sonarr_incomplete`/`jellyfin_duplicate`. Query FIRST after any force-grab: `make metrics a='events --type fg_verify'` |
| `block` | `arrSweep` (negative-cached) | ti, ap, id, fails |
| `queue_clean` | `arrSweep` (stuck item) | ap, id, blocklisted |
| `stall_clean` | `arrSweep` (dead magnets) | count |
| `dedup` | `arrSweep` (duplicate torrents) | ap, id, kept, removed |
| `supersede` | `arrSweep` (old copies) | ap, id, kept, removed |
| `decline` | `diskGate` | ti, ap, sB, free |
| `req_blocked` | `requestGate` | key, sB, free |
| `abandon` | `stallRecovery` (*arr-orphaned) | ti, ap, reason |
| `re_search` | `stallRecovery` (blocklisted) | ti, ap, attempt |
| `accepted_rare` | `stallRecovery` (gave up) | ti, ap |
| `swap_start` | `gpuVerifySweep` | ti, label, oldScore, newScore, seeds |
| `swap_done` | `gpuVerifySweep` | ti |
| `swap_abandon` | `gpuVerifySweep` (48h timeout) | ti, reason |
| `swap_defer` | `gpuVerifySweep` (mid-watch) | ti, reason |
| `swap_none` | `gpuVerifySweep` | ti, label, score |
| `swap_fail` | `gpuVerifySweep` | ti, status |
| `svc_down` | `metricsSweep` (transition) | svc |
| `svc_up` | `metricsSweep` (transition) | svc |
| `redownload` | `POST /api/redownload` | ti, tier, steps |

### Querying

**Through the API** (for charts / dashboard):
```bash
# List available streams + date ranges
curl -s localhost:8088/api/metrics

# Query a stream by time range (Unix seconds)
curl -s "localhost:8088/api/metrics?stream=system&from=1700000000&to=1700003600&limit=100"
```

**Directly on disk** (for ad-hoc analysis with standard tools):
```bash
# Count events by type
jq -r '.e' /opt/appdata/controller/metrics/events/2026-07-06.jsonl | sort | uniq -c | sort -rn

# Pipeline timing: time from grab to download complete
jq -s 'group_by(.ti) | .[] | select(length > 1) |
  {title: .[0].ti, grab: .[0].t, done: (.[] | select(.e=="dl_done") | .t)}' \
  /opt/appdata/controller/metrics/events/2026-07-06.jsonl

# CPU spike detection
jq 'select(.cpu > 95)' /opt/appdata/controller/metrics/system/2026-07-06.jsonl

# Service outage timeline
jq -r 'select(.e=="svc_down" or .e=="svc_up") | [.t, .e, .svc] | @tsv' \
  /opt/appdata/controller/metrics/events/2026-07-06.jsonl

# DuckDB (if available): full SQL on all metrics
# duckdb -c "SELECT avg(cpu), max(cpu), min(cpu) FROM read_json_auto('/opt/appdata/controller/metrics/system/*.jsonl')"
```

**CLI tool** (`make metrics` / `./scripts/query-metrics.sh`):
```bash
make metrics a='system --stats cpu'          # CPU min/max/avg
make metrics a='system --chart temp'         # ASCII sparkline of temps
make metrics a='events --type svc_down'      # service outages
make metrics a='events --type grab'          # all downloads
make metrics a='dl --chart spB'              # download speed over time
make metrics a='system --last 100'           # raw data points
```

### Correlation: Pipeline Duration

Events carry timestamps and correlated identifiers (title, hash). To compute average pipeline phase durations:

```bash
# Download time from grab to dl_done (seconds)
jq -s '[group_by(.ti)[] | select(length>1) |
  {title: .[0].ti,
   dl_dur: (map(select(.e=="dl_done"))[0].t - map(select(.e=="grab"))[0].t)} |
  select(.dl_dur > 0)] | .[].dl_dur' events/2026-07-06.jsonl |
awk '{sum+=$1; n++} END {print "avg download:", sum/n, "s"}'
```

### Code

- **Writer**: `controller/metrics.js` — `recordSystem()`, `recordDisk()`, `recordServices()`, `recordDlSummary()`, `emitEvent()`, `queryMetrics()`, `listStreams()`, `stats()`
- **Sweep**: `metricsSweep()` in `server.js` — runs every 10s via `setInterval`, reads in-memory CPU/dl, probes services, appends to JSONL. Tracks service up/down transitions.
- **Event hooks**: 30+ `metrics.emitEvent()` calls across all sweeps at every meaningful action, immediately after the `console.log()`.
- **Transition tracking**: `_knownDownloads` Map tracks torrent state transitions in `refreshDownloads` to detect `grab`/`dl_done`/`import_ok` events without duplicates.
- **Endpoint**: `GET /api/metrics?stream=system&from=...&to=...&limit=N` returns filtered data from JSONL files.

### Storage consideration

At 10s sampling: ~2 MB/day, ~700 MB/year. 35 GB free on the SSD (root) where metrics live. Files are plain text, highly compressible (`gzip` shrinks JSONL ~8:1). To archive: `gzip /opt/appdata/controller/metrics/system/2026-07-06.jsonl` — the API skips gz files (only reads `.jsonl`), but unzip on demand for historical queries.

## Common Failure Modes

### "Why didn't X download?"

1. **Check if it's being searched** → `./scripts/show-history.sh --missing`
   - `cooldown` = searched within 6h, won't retry
   - `blocked` = searched 4× with no grab, blocked for 7 days (1 day for recent releases)
   - `grace` = first seen missing <2h ago, leaving *arr's own search alone (30 min for recent releases)
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
- Missing rows now carry `searchHint` from the controller (`sources degraded`, `cooldown`, `grace`, `trigger failed`) so you can see why a title is still sitting in `Searching…` / `Not found` without jumping into logs first.
- Search retries now emit `search_probe` / `search_outcome` / `search_decision` / `search_reject` events and the dashboard will show upstream results directly (`upstream found ...`, `Sonarr rejected all ...`, `upstream returned 0 hits ...`, `upstream error ...`). Use `./scripts/query-metrics.sh events --type search_outcome` or `make metrics a='events --type search_outcome'` to audit them.
- `search_outcome` and `search_decision` also carry `indexerErrors` so a bad TPB/EZTV/etc call is visible as an explicit failure reason instead of getting flattened into a generic "no grab" result.
- No new Prowlarr config is required for this telemetry: the controller reads Prowlarr history through the API. If we ever need retention or logging changes, keep them in `scripts/provision/prowlarr.sh` so they stay IaC-managed.
- **Gap release grabbing**: `grabGapRelease(rel, category)` adds a gap release to qBittorrent via `POST /api/v2/torrents/add` using `rel.guid` if it starts with `magnet:`, else a magnet built from `rel.infoHash`. It returns the infoHash **lowercased** (see the force-grab subsystem section — this was a load-bearing bug fix). Called ONLY by the manual `/api/force-grab` endpoint, with category **`sonarr-force`**.
- **probeSearchGap sort order**: grabbable releases (magnet guid or infoHash) sort above non-grabbable ones regardless of seed count. The best release object captures `magnetUrl`, `infoHash`, `size`, `downloadUrl`. `probeSearchGap` also returns `all` (every grabbable release) which powers the manual release-picker modal.
- **Auto-grab was REMOVED (2026-07-07)**: `probeSearchOutcome` emits `search_gap` for the UI hint but NEVER acquires. Acquisition is manual only (force-grab button). See INVARIANTS in the force-grab subsystem section — there is no `AUTO_GRAB_ENABLED` flag to flip.
- **UI hint for search gaps** shows the best gap release title (truncated), seeders, and specific reason (e.g. "no S01 marker" or "not a candidate").

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
5. For TV titles, use `make why q="Planet Earth" s=sonarr`; the helper now falls back to Sonarr and diagnoses the first available episode file instead of failing on a series title.

### "Why isn't this playing on the PS4?" (the projector console — long mislabelled "PS3")

1. `make why q="Title"` — one command: codec/bit-depth/audio/container, PS4 direct-play
   verdict with reasons, transcode feasibility on this Skylake NUC, live transcode reasons.
2. PS4 Media Player hard limits: MKV/MP4/TS containers OK; H.264 8-bit ≤L4.2 ONLY (no HEVC,
   no 10-bit, no VP9/AV1); audio = AAC-LC and AC3 ONLY. **E-AC3/DDP, DTS, TrueHD = video
   plays with SILENT AUDIO** — and DDP-in-MKV is what the best WEB-DLs ship, so this is the
   most common failure. Fix per title: `make ps4ify q="Title"` (adds an AC3 compat track,
   originals untouched); automatic for fresh imports via ps4fix.timer.
3. The PS4 DLNA profile (`scripts/provision/dlna-ps4-profile.xml`, installed to
   `/opt/appdata/jellyfin/data/plugins/configurations/dlna/user/`) matches identification
   string "PLAYSTATION 4" and transcodes anything non-native to TS H.264 + AC3 5.1.
   `make test` checks it's installed.
4. Discovery problems (server not in PS4 media player): Jellyfin runs HOST networking bound
   to $NUC_IP; DLNA plugin blasts alive every 180s. `curl -s http://$NUC_IP:8096/System/Info/Public`.
5. Stutter/buffering during PS4 playback: 10-bit HEVC source = CPU decode on a 2c/4t box —
   check `curl -s localhost:8088/api/system` (load) and use Movie Mode (dashboard) to pause
   all downloads/sweeps while streaming.

### "Why is a TV series stuck with only some seasons?"

Sonarr's on-add / `SeriesSearch` only looks for whole-season **packs**. A currently-airing show
usually has no pack, so those seasons come back empty and never fill in on their own.
- The controller's `arrSweep` recovers this by firing `EpisodeSearch` on the specific missing
  **monitored, aired** episode IDs (see `missingEpisodeIds` in `controller/lib/search-engine.js`) — per-episode
  search finds the individual releases that packs-only search misses. Respects per-season monitoring,
  so requesting one season still grabs only that season.
- Manual kick: `curl -X POST .../api/v3/command -d '{"name":"EpisodeSearch","episodeIds":[...]}'`

### "Why is this stuck at 'Importing'?"

The import watchdog runs every 30s but backs off 120s per folder. Check:
- `./scripts/query-logs.sh controller --grep watchdog` — shows "not importable yet: <reason>"
- Common reasons: "no matching movie" (file name parsing mismatch), "rejected" (file quality below cutoff)

### Force-grab / manual-import subsystem (the `sonarr-force` path)

When a title is "Not found" (no season-search candidate), the user can pick a specific release via the dashboard download-arrow button. This path is **deliberately isolated** from Sonarr's normal import so a mis-parsed release can't pollute the wrong series. Read this before touching `grabGapRelease`, `importViaGrab`, `importViaSeasonRemap`, or the `importWatchdog` pre-pass.

**Pipeline**: `/api/force-grab` → `grabGapRelease(rel,'sonarr-force')` adds the torrent to qBittorrent category **`sonarr-force`** (savePath `/data/torrents/complete/sonarr-force`, created by `qbittorrent.sh`). Sonarr's download client only watches `sonarr`, so it never sees these → no wrong-series auto-import. The controller's `importWatchdog` **pre-pass** is the sole importer: it waits for the torrent to be 100% complete, then `importViaGrab('sonarr', folder, expectedId)` maps files to episodes using the user-chosen `seriesId`.

**`importViaGrab` strategies** (in order, all keyed on the correct `expectedId` series):
1. Sonarr `/manualimport` — but trusts its parse only when `c.series.id === expectedId` (else falls through, so a "Carl Sagan's Cosmos 1980"→Cosmos 2014 mis-parse can't win).
2. `resolveEpisodeRange` — multi-episode files ("Chapter 5 to 8", "E05-E08") → one file mapped to episodeIds `[5,6,7,8]`. Tried BEFORE single-episode matching.
3. `resolveEpisode` — regex (SxxExx / E## / bare number) then episode-title fuzzy match.
4. Sequential fill — sort files, assign to first missing monitored episodes (last resort).

**`importViaSeasonRemap`** (generic recover watchdog, Sonarr-only fallback): for merged TVDB series where a release's files are numbered in the sub-show's own S01 but Sonarr grabbed them as S2 (Cosmos 2014 "Possible Worlds"). Fires ONLY on the rejection `unexpected considering the … folder name` / `not found in the grabbed release`. Reads the target episodes from Sonarr **history** grabbed-events (durable — the queue empties once import is blocked), matches by episode number, and ManualImports to the right season.

**State**: `forceGrabImport` (in-flight) + `completedForceGrabs` (done) Maps, both persisted in `state.json`, both keyed by **LOWERCASE infoHash**. This casing is load-bearing — qBittorrent reports hashes lowercase and every consumer looks up `t.hash.toLowerCase()`; a 2026-07-09 bug keyed them UPPERCASE so `.has()` always missed, which bypassed the guards and let the generic importer delete a force-grab with `deleteFiles:true`. Guards on the buildDownloads recover path and stall-recovery skip gate on the `sonarr-force` **category** (not just the hash map) as belt-and-suspenders.

**INVARIANTS** (do not regress): no auto-grab (manual button is the only acquirer); force-grabs import ONLY when the torrent is complete (never from `/torrents/incomplete/`); nothing except the pre-pass imports or deletes a `sonarr-force` torrent; force-grabs are never deleted for being unparseable (they sit as "Importing"; `fg_giveup` is emitted, files stay for manual handling).

**Diagnosing a force-grab**: `make metrics a='events --type fg_verify'` (PASS/FAIL + issues), then `fg_import` / `fg_giveup` / `season_remap`. `fg_verify` cross-checks Jellyfin, so it catches wrong-tvdb merges, phantom seasons, doubling, and partial imports automatically. Live: `docker logs controller | grep -E "force-grab|season-alias remap|multi-episode|fg-verify"`.

### Naming & Jellyfin identity (why episodes show wrong seasons / a show splits or merges)

Jellyfin identifies content by **filename + NFO**, not by Sonarr's DB. Two config levers make this deterministic (both codified, both new-import-only — never a library-wide rename):
- **Sonarr/Radarr `renameEpisodes`/`renameMovies` = true** (`_arr_common.sh` §4b) → clean `Series (Year) - S01E05 - Title` names. Without it, raw release names make Jellyfin invent phantom seasons (e.g. "…2006…" → Season 20) and collapse a sub-show's S01-numbered files onto Season 1 (doubling).
- **Sonarr/Radarr Kodi/Emby (Xbmc) NFO metadata consumer** (`_arr_common.sh` §4b) writes `tvshow.nfo`/episode NFO with the exact `tvdbid`; **Jellyfin TV+Movies `LocalMetadataReaderOrder=['Nfo']`** (`jellyfin.sh`) reads it. This pins the right series — e.g. a year-less `Cosmos` folder resolves to tvdb 74995 (1980) instead of fuzzy-matching Cosmos 2014 (260586).

To verify identity: `GET {jellyfin}/Items?includeItemTypes=Series&fields=Path,ProviderIds` and compare `ProviderIds.Tvdb` per folder against Sonarr's `tvdbId`. Note `POST /Library/Refresh` only re-checks KNOWN items — a brand-new folder needs the real-time watcher or a full scan to appear.

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

# Rebuild collections + re-register home shelves NOW (don't wait for the schedule).
# Handy right after a boot, or after bulk imports. 409 if a sweep is already running.
curl -X POST http://localhost:8088/api/collections/build

# Force-grab the best search_gap release for a Sonarr series (adds to qBittorrent via magnet/infoHash).
# Use sonarr id from the URL or from the dashboard row's _id field.
curl -X POST http://localhost:8088/api/force-grab -H 'Content-Type: application/json' -d '{"app":"sonarr","id":104}'

# Cross-service diagnosis
./scripts/diagnose.sh

# Torrent state breakdown from qBittorrent
./scripts/diagnose.sh --qbit

# Unlinked torrents (in qBit but not in controller/*arr)
./scripts/diagnose.sh --orphans

# *arr queue status (blocked imports, stuck items)
./scripts/diagnose.sh --queue
```

## Direct Service API Access (deep diagnostics)

When the controller API + scripts aren't enough, query each service's own API directly. This is how the 2026-07-09 force-grab/naming investigation was done — cross-checking Sonarr's DB vs qBittorrent's torrents vs Jellyfin's parsed library. Each service is on `localhost` (bridge/host net); the controller reaches them by container name.

**Get the API keys** (all also available inside the controller container's `/config/keys.env`):
```bash
SONARR_KEY=$(docker exec sonarr cat /config/config.xml | grep -oP '(?<=<ApiKey>)[^<]+')   # radarr/prowlarr same
JELLYFIN_KEY=$(grep -oP '^JELLYFIN_KEY=\K.*' /opt/appdata/controller/keys.env)             # header: X-Emby-Token
JELLYSEERR_KEY=$(docker exec jellyseerr sh -c 'python3 -c "import json;print(json.load(open(\"/app/config/settings.json\"))[\"main\"][\"apiKey\"])"')
# qBittorrent uses a session cookie, not a key:
docker exec qbittorrent sh -c 'curl -s -c /tmp/j -d "username=brennan&password=brennan" localhost:8080/api/v2/auth/login >/dev/null && curl -s -b /tmp/j "<endpoint>"'
```

**Sonarr / Radarr** (`localhost:8989` / `:7878`, `/api/v3`, header `X-Api-Key`):
- `GET /series` · `/series/{id}` — `statistics.episodeFileCount`/`episodeCount` (completeness), `seasons[].statistics`, `tvdbId`, `path`. (Radarr: `/movie`, `hasFile`, `tmdbId`.)
- `GET /episode?seriesId={id}` — per-episode `hasFile`, `episodeFileId`, season/episode numbers.
- `GET /episodefile?seriesId={id}` — PHYSICAL files (fewer than episodes ⇒ multi-episode files; cross-ref which episodes map to each fileId).
- `GET /queue?includeEpisode=true&includeUnknownSeriesItems=true` — import-blocked items + their episode mapping + `statusMessages` (rejection reasons like "unexpected considering the folder name").
- `GET /history?downloadId={HASH}` — durable grab→episode mapping. **`downloadId` is the UPPERCASE hash**; qBit reports lowercase. Grabbed events carry `episodeId`+`seriesId`.
- `GET /rename?seriesId={id}` — preview clean names (0 entries if `renameEpisodes` is off). `GET /config/naming`, `/metadata` — rename + NFO-consumer config.
- Mutations used: `POST /command {name:"RenameFiles"|"RefreshSeries"|"ManualImport"|"EpisodeSearch",…}`, `DELETE /series/{id}?deleteFiles=true`.

**qBittorrent** (`localhost:8080`, `/api/v2`, cookie auth above):
- `GET /torrents/info[?category=sonarr-force]` — `hash` (LOWERCASE), `progress`, `state`, `category`, `content_path` (points into `/torrents/incomplete/…` until complete).
- `GET /torrents/files?hash={h}` — per-file names/sizes/progress → reveals multi-file packaging (e.g. one 18 GB "Chapter 5 to 8" file).
- `GET /torrents/categories` — category → savePath.

**Jellyfin** (`localhost:8096`, header `X-Emby-Token`; media path maps `/data/media`→`/media`):
- `GET /Items?recursive=true&includeItemTypes=Series&fields=Path,ProviderIds` — **match a folder by `Path`, then check `ProviderIds.Tvdb`** to catch wrong-tvdb merges (two folders → same tvdb) or duplicates.
- `GET /Items?parentId={seriesItemId}&recursive=true&includeItemTypes=Episode&fields=ParentIndexNumber` — season/episode distribution (phantom seasons, doubling). `ParentIndexNumber` null = "Season Unknown".
- `GET /Library/VirtualFolders` — libraries + `LibraryOptions` (`LocalMetadataReaderOrder` for NFO). `POST /Library/VirtualFolders/LibraryOptions` to change (see `jellyfin.sh` pattern).
- `POST /Library/Refresh` — scan; only re-checks KNOWN items (new folders need the watcher/full scan). `GET /ScheduledTasks` — poll `State=="Running"` to wait for a scan. `DELETE /Items/{id}` — remove a stale/phantom entry.

**Jellyseerr** (`localhost:5055`, `/api/v1`, header `X-Api-Key`):
- `GET /search?query=Title` — per-result `mediaInfo` (null/absent ⇒ CLEARED ⇒ re-requestable; status 5 = available). Use to confirm a wipe left a title re-requestable.
- `GET /request?take=N&filter=all` · `DELETE /media/{id}` — inspect/clear requests+media. (The controller's `seerrSweep` auto-clears orphans when *arr items are deleted.)

**Controller internals** (files on the host):
- `/opt/appdata/controller/state.json` — `forceGrabImport`/`completedForceGrabs` (LOWERCASE infoHash keys), `searchState` (keyed `sonarr:{id}`), `declined`, `blocked`, `gpuSwapped`, `masterPaused`. To hand-edit: `docker stop controller`, edit, `docker start controller` (avoids the running process overwriting on its persist timer).
- `/opt/appdata/controller/metrics/events/$(date +%F).jsonl` — event log (in-container: `/config/metrics/events/`). `jq -c 'select(.e=="fg_verify")'` etc.

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
2. **Sweep timing/constants**: edit the constants in the owning `controller/lib/` module (see controller/README.md), rebuild: `make up` or `make deploy s=controller`
3. **New service**: add to `docker-compose.yml`, add provision script, add API key discovery to `controller.sh`, add status check to `server.js:STATUS_SERVICES`
4. **Logging**: all sweeps use `console.log()` (→ docker logs). New diagnostics should use the `INFO/WARN/ERROR` helpers that add log level prefixes.
5. **Library fallback**: the `isErrored` branch in `buildDownloads` (server.js:498-520) now has a title-based fallback when the history cache misses. The `getHasFileMap` function returns `{ hasFile, nameIds }` — both Maps. `hasFile[id]` is the authoritative "in library" check. `nameIds[normTitle]` maps normalized *arr titles to ids. If adding a new fallback, make sure to pre-populate `nameIds` for both `norm(title)` and `norm(title + year)`.
6. **TV client fork** ("Movie Night", jellyfin-androidtv): clone lives outside this repo at `~/jellyfin-androidtv`. Build requires **JDK 21** (`~/jdk-21`; system `java` is 17): `cd ~/jellyfin-androidtv && ./gradlew :app:compileDebugKotlin -Dorg.gradle.java.home=/home/brennan/jdk-21`. Android SDK at `~/android-sdk`.
7. **Branding CSS/JS** (web): edit `scripts/provision/jellyfin-custom.css` / `jellyfin-web-flair.js`, then `make provision s=jellyfin` (NOT `make deploy` — deploy only pulls/restarts, it does not re-push branding or flair). §7a verifies the served CSS is sha256-identical to source. Theme values are mirrored across Android XML + web JS/CSS: keep `docs/branding/THEME-TOKENS.json` in sync and run `make check-themes`.

## Restart Safety

The controller persists its state to `/config/state.json` on every sweep mutation. On restart, `loadState()` restores:
- `declined` (disk-gate tombstones)
- `blocked` (request-gate entries)
- `searchState` (cooldown/block timers)
- `gpuSwapped` (movies already GPU-swapped once — the verifier's never-loop guard)
- `masterPaused` (Movie Mode)

This prevents reboot-triggered re-search storms.
