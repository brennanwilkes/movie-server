# Controller architecture

The controller is the brain of the stack: a Node 20 / Express service (deps:
`express` + `compression` only) that serves the mobile dashboard (`web/`),
aggregates qBittorrent + Radarr/Sonarr/Prowlarr/Bazarr/Jellyfin/Jellyseerr into
a same-origin API, and runs the background sweeps that keep the pipeline
self-healing. It was a single 4,700-line `server.js` until the 2026-07 modular
refactor; the split was **behavior-preserving** — bodies moved verbatim, same
routes, same timers, same `/config/state.json` format.

## Layout

```
server.js            Thin entrypoint. Fixed boot order: middleware → loadState()
                     → route modules → start*() timer calls → listen. Modules
                     NEVER start timers on require.
metrics.js           JSONL time-series/event logger (unchanged by the refactor).
lib/
  app.js             Shared Express instance (routes register on require).
  config.js          cfg (/config/keys.env over env), HOST/PORTS maps, data files.
  clients.js         tfetch/tfetchJson, qbit cookie client, seerr, arr* REST helpers.
  cache.js           cachedFetch resilient TTL cache + raw _cache object.
  state.js           Persisted Maps + masterPaused accessors + persistState/loadState.
  jellyfin.js        Jellyfin/Jellyseerr id resolvers (user/server/tmdb/title).
  jf-scan.js         Debounced library-refresh trigger + trickplay-aware safety net.
  system-stats.js    Host CPU%/RAM%/temp sampling from /proc + /sys.
  arr-data.js        Cached qbit/*arr views (queue/history/hasFile), arrOwns, indexers.
  arr-inspect.js     videoLabel/gpuTier, disk headroom, titles, disk-only diagnoser.
  downloads.js       buildDownloads aggregator, readiness gates, _dl snapshot,
                     GET /api/downloads.
  importer.js        Manual-import strategies, importWatchdog, force-grab verify,
                     garbage (fake release) discard, restart recovery.
  stall-recovery.js  Reannounce → blocklist+research → accept-rare escalation.
  gpu-verify.js      Zero-gap swap of CPU-only files for GPU-decodable H.264.
  collections.js     Auto box-set sweep (decades/vibes/Oscars/people/studios).
  oscar-tags.js      Oscar badge Tags sweep (film-awards.json → item Tags, diff-only).
  hss-shelf.js       Rotating home shelves (HSS plugin) + /api/hss/shelf.
  delete-plan.js     The layered delete recipe (*arr → qbit → Jellyfin → seerr).
  search-engine.js   Missing-item bookkeeping, arrSweep, search probes, gap grabber.
  sweeps.js          diskGate / orphanSweep / seerrSweep / requestGate.
  routes-system.js   /api/status,/vpn,/tailscale,/disk,/system,/indexers.
  routes-elo.js      Elo tuner Top-100 read/reorder/config (CORS-open).
  routes-actions.js  All mutating dashboard routes (delete/redownload/retry/
                     force-grab/pause/Movie-Mode/library/collections-build).
  metrics-recorders.js  system/service metric sampling + /api/metrics.
web/                 Dashboard frontend — plain scripts in web/js/, loaded in
                     order by index.html (shared global scope, no build step).
```

Dependency rule: modules form layers — config → clients → cache/state/jellyfin →
arr-data/arr-inspect/system-stats → downloads/search-engine/stall-recovery →
importer/gpu-verify/sweeps/delete-plan → routes → server.js. Peer modules never
cross-import; anything shared by two subsystems lives in `state.js` (Maps) or a
lower layer. Mutable `let`s are never exported — accessors only (`getDl()`,
`isMasterPaused()`, `getCpuPct()`, `resetParseBudget()`).

## Background loops

All started explicitly by `server.js`; every sweep checks `isMasterPaused()`
(Movie Mode) and its own reentrancy busy-flag.

| Loop | Module | Interval / first run |
|---|---|---|
| sampleCpu | system-stats | 3s / immediate |
| refreshDownloads | downloads | 5s / 1.5s |
| registerHssShelf | hss-shelf | 30m / via bootSequence |
| forceGrabVerifySweep | importer | 60s |
| importWatchdog | importer | 60s / 8s |
| recoverForceGrabImport | importer | once at 4s |
| stallRecovery | stall-recovery | 5m / 20s |
| gpuVerifySweep | gpu-verify | 15m / 60s |
| collectionsSweep | collections | 6h / via bootSequence (15s) |
| oscarTagsSweep | oscar-tags | 24h / via bootSequence (15s) |
| recordSystemMetrics | metrics-recorders | 10s / 2s |
| recordServiceMetrics | metrics-recorders | 30s / 7s |
| diskGate | sweeps | 30s / 6s |
| orphanSweep | sweeps | 5m / 15s |
| seerrSweep | sweeps | 15m / 30s |
| requestGate | sweeps | 5m / 15s |
| rehydrateSearchProbes | search-engine | once at 8s |
| arrSweep | search-engine | 5m / 30s |
| jf safety-net scan | jf-scan | 5m + 45s catch-up |

## Persisted state (/config/state.json)

Written debounced (500ms) by `state.persistState()`, restored by
`state.loadState()` before anything else runs. Keys: `declined`, `blocked`,
`searchState`, `gpuSwapped`, `gpuPending`, `masterPaused`, `forceGrabImport`,
`completedForceGrabs` (all Maps serialized as objects; infoHash keys lowercase).

## Config

`lib/config.js` overlays `/config/keys.env` (written by
`scripts/provision/controller.sh`) onto `process.env`. Keys: `CONTROLLER_PORT`,
`NUC_IP`, `QBIT_HOST/USER/PASS`, `RADARR_KEY`, `SONARR_KEY`, `PROWLARR_KEY`,
`BAZARR_KEY`, `SEERR_KEY`, `JELLYFIN_KEY`. Missing file → degraded mode (status
pages work, actions don't).

Two monolith-era latent bugs were found during the refactor and fixed on
2026-07-16: `intl-languages.json` was never COPY'd into the image (the
International Films collection ran on `{}`), and `importer.js`'s folder-scan
fallback referenced a `norm()` that was never in scope (ReferenceError
swallowed by its try/catch — the fallback had never worked). Both work now.

## Verifying changes

```
node --check server.js lib/*.js          # syntax
make deploy                              # controller = image rebuild + recreate
scripts/smoke-test.sh
curl -s localhost:8088/api/status | jq   # …and /api/downloads, /api/system
docker logs -f controller                # watch one sweep cycle (~5 min)
```
