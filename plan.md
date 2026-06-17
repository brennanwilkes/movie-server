# Home Media Stack — Self-Contained Build & Execution Plan

> **This file is the single source of truth.** It is written to be executed by a fresh
> Claude Code session logged in as the **`brennan`** user on the NUC, with **no other
> documents required**. It supersedes all prior plan/spec files. Validate each phase's
> acceptance criteria before moving on.
>
> Host facts below were verified firsthand on the NUC (`haleiwa`) on **2026-06-16**.
> Re-run the quick checks in Phase 0 before trusting them; hardware/network can change.

---

## 0. Goal

Replace the old "Synology → DS File → phone → AirPlay mirror" flow with:

> Pick a title from a phone UI → it auto-downloads, organizes, and grabs subtitles →
> it appears in a media library → a device on the projector's HDMI **direct-plays** it,
> controlled from the phone as a remote.

**No screen mirroring.** The phone becomes a remote, not the video source.

---

## 1. Verified host environment (NUC = `haleiwa`)

| Item | Verified value |
|---|---|
| Machine | The NUC, hostname `haleiwa` (always-on Docker host) |
| OS | Ubuntu 20.04.6 LTS, x86_64, kernel 5.4 |
| Docker | v26.0.0, daemon running, compose **v2** plugin present |
| Run user | **`brennan`** — uid **1000**, gid **1000**; in groups `sudo` + `docker` |
| (other user) | `textgroove` uid 1002/gid 1003 (also sudo+docker) — not used here |
| Disk | single filesystem `/dev/sda2`, 221 GB total, **~69 GB free** |
| LAN IP | `192.168.1.74` (also an overlay IP `10.10.0.9`) |

Implications baked into this plan:
- **Linux** → no Windows/WSL detour.
- `brennan` runs docker without sudo; uses sudo only to create `/opt` and `/data` roots.
- `PUID/PGID = 1000/1000` so all media/config files are owned by `brennan`.
- One disk → **strict storage discipline** (see §3) until an external drive is added.

---

## 2. Architecture (target state)

```
                 ┌─────────────────── NUC (Docker host) ───────────────────┐
  phone (remote) │  Jellyseerr ── Radarr/Sonarr ── Prowlarr ── qBittorrent  │
        │        │      │              │                            │(VPN)   │
        ▼        │   Jellyfin ◄──── Bazarr (subs)             [gluetun later]│
  Jellyfin app   │      ▲                                                    │
  on Fire Stick ─┼──────┘  reads /data/media                                 │
  (HDMI → projector)                                                         │
                 └──────────────────────────────────────────────────────────┘
```

First playback client: existing **Fire TV Stick 2nd Gen** (1080p only) running the
Jellyfin app — a stopgap; a 4K Onn box or Pi/Kodi is the eventual upgrade.
Network: projector room has wired Ethernet; prototype over wifi first, wire later.

### Critical storage convention (do this right or hardlinks break)
A **single shared `/data` root** mounted at the *same path* in qBittorrent, Radarr,
Sonarr, and Bazarr lets Radarr/Sonarr **hardlink** (instant, no extra disk, keeps
seeding) instead of copying. Everything must live on one filesystem (it does — `/data`
and `/opt/appdata` are both on `/dev/sda2`).

```
/data
├── torrents
│   ├── incomplete
│   └── complete        (qBittorrent makes category subdirs: radarr/, sonarr/)
└── media
    ├── movies          <- Radarr library root
    └── tv              <- Sonarr library root
```

Jellyfin libraries point at `/media/movies` and `/media/tv`.

### Test content (legal only)
- **Linux ISOs** (Ubuntu/Debian release torrents) — test download→import path.
- **Public-domain films** from archive.org — test Radarr/Jellyfin/Bazarr with real
  video + subtitles.

Real/private indexer configuration is a deliberately separate, later decision.

---

## 3. Key decisions & constraints

1. **Ownership / location:** the stack repo lives in **this git repo at
   `/home/brennan/movie-server`** (the code-as-code; edited and deployed from here).
   The *only* things deployed outside the repo are config at `/opt/appdata` and media
   at `/data`, all owned `brennan` (PUID/PGID 1000). This way a `make destroy` from the
   repo root leaves nothing but the code on the machine. (Runtime is unaffected by the
   repo's location — see decision 2.)
2. **Login-independent + power-loss-safe:** services run under the **system Docker
   daemon** (no tie to any login). `restart: unless-stopped` on every container +
   `systemctl enable docker` means the whole stack auto-returns after a reboot/power
   loss with nobody logged in. A reboot test is part of verification.
3. **Hard storage cap (20 GB)** while on the single internal disk. `$DATA` is a
   fixed-size **loopback ext4 image** (`DATA_IMG`/`DATA_IMG_SIZE` in `.env`) created and
   mounted by `bootstrap.sh` and persisted in `/etc/fstab` (`loop,nofail`, so it remounts
   on boot before Docker). The inner filesystem physically cannot exceed the cap — writes
   fail with ENOSPC, no matter what qBittorrent/Radarr attempt — but it's sparse, so it
   only consumes real disk as it fills. qBittorrent's "pause on low free space" is still
   set (Phase 2) as a *graceful* secondary so the cap is a backstop, not the first line.
   `$DATA` is a single `.env` variable, so moving to an external drive later = blank
   `DATA_IMG`, set `DATA=/mnt/<drive>`, migrate, re-deploy.
4. **Local git only** for versioning and "how does this work again in 2 years"
   documentation. No remote, so **no GitOps auto-redeploy hook** — just a `pre-commit`
   guard (blocks committing secrets, validates compose) and a friendly Makefile/README.
5. **No manual `docker run`** ever — `docker-compose.yml` + scripts are the source of
   truth. Bring services up one phase at a time.

---

## 4. Repository contents (create all of these in this repo, `/home/brennan/movie-server`)

```
movie-server/
├── plan.md            # this file (the source of truth / 2-years-later insurance)
├── .env.example       # committed template (NO secrets)
├── .env               # gitignored, real values (created by bootstrap)
├── .gitignore
├── docker-compose.yml # source of truth for the stack
├── Makefile           # make deploy / down / clean / destroy / validate
├── README.md          # lifecycle cheat-sheet (the 2-years-later insurance)
├── scripts/
│   ├── bootstrap.sh   # one-time host prep: dirs, perms, .env, hook
│   ├── deploy.sh      # validate + pull + up -d (idempotent)
│   └── teardown.sh    # stop | clean | destroy (guarded)
└── hooks/
    └── pre-commit     # validate compose + block committing .env
```

### `.env.example`
```env
PUID=1000
PGID=1000
TZ=America/Vancouver
# CONFIG: per-app config (outside the repo)
CONFIG=/opt/appdata
# DATA: shared media root (see §2). Re-point to external drive later.
DATA=/data
```
> Keep comments on their own lines — docker compose does **not** strip inline `#`
> comments from `.env` values, so `CONFIG=/opt/appdata  # ...` would make the path
> literally include the comment text.
> `bootstrap.sh` copies this to `.env` on first run. Values above are already correct
> for the `brennan` user (uid/gid 1000); edit only if that changes.

### `.gitignore`
```gitignore
.env
*.log
```

### `docker-compose.yml`
> **YAML gotcha (verified):** environment entries are written as *quoted* flow-sequence
> items — `["PUID=${PUID}", ...]`. Unquoted (`[PUID=${PUID}]`) is invalid YAML because
> the `{` in `${PUID}` opens a flow-mapping and the parse fails. Block style
> (`environment:` then `PUID: ${PUID}` on indented lines) also works.
```yaml
services:
  jellyfin:
    image: lscr.io/linuxserver/jellyfin:latest
    container_name: jellyfin
    environment: ["PUID=${PUID}", "PGID=${PGID}", "TZ=${TZ}"]
    volumes:
      - ${CONFIG}/jellyfin:/config
      - ${DATA}/media:/media
    ports: ["8096:8096"]
    restart: unless-stopped

  qbittorrent:
    image: lscr.io/linuxserver/qbittorrent:latest
    container_name: qbittorrent
    environment: ["PUID=${PUID}", "PGID=${PGID}", "TZ=${TZ}", "WEBUI_PORT=8080"]
    volumes:
      - ${CONFIG}/qbittorrent:/config
      - ${DATA}:/data
    ports: ["8080:8080", "6881:6881", "6881:6881/udp"]
    restart: unless-stopped

  prowlarr:
    image: lscr.io/linuxserver/prowlarr:latest
    container_name: prowlarr
    environment: ["PUID=${PUID}", "PGID=${PGID}", "TZ=${TZ}"]
    volumes: ["${CONFIG}/prowlarr:/config"]
    ports: ["9696:9696"]
    restart: unless-stopped

  radarr:
    image: lscr.io/linuxserver/radarr:latest
    container_name: radarr
    environment: ["PUID=${PUID}", "PGID=${PGID}", "TZ=${TZ}"]
    volumes:
      - ${CONFIG}/radarr:/config
      - ${DATA}:/data
    ports: ["7878:7878"]
    restart: unless-stopped

  sonarr:
    image: lscr.io/linuxserver/sonarr:latest
    container_name: sonarr
    environment: ["PUID=${PUID}", "PGID=${PGID}", "TZ=${TZ}"]
    volumes:
      - ${CONFIG}/sonarr:/config
      - ${DATA}:/data
    ports: ["8989:8989"]
    restart: unless-stopped

  bazarr:
    image: lscr.io/linuxserver/bazarr:latest
    container_name: bazarr
    environment: ["PUID=${PUID}", "PGID=${PGID}", "TZ=${TZ}"]
    volumes:
      - ${CONFIG}/bazarr:/config
      - ${DATA}:/data
    ports: ["6767:6767"]
    restart: unless-stopped

  # --- Phase 4: uncomment when you reach the Jellyseerr step ---
  # jellyseerr:
  #   image: fallenbagel/jellyseerr:latest
  #   container_name: jellyseerr
  #   environment: ["TZ=${TZ}"]
  #   volumes: ["${CONFIG}/jellyseerr:/app/config"]
  #   ports: ["5055:5055"]
  #   restart: unless-stopped
```

### `scripts/bootstrap.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. create .env from the committed template if it doesn't exist yet
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example — review values before deploying."
fi
set -a; source .env; set +a

# 2. create the data + config tree (single $DATA root enables hardlinks)
sudo mkdir -p "$DATA"/torrents/{incomplete,complete} \
              "$DATA"/media/{movies,tv} \
              "$CONFIG"
sudo chown -R "$PUID:$PGID" "$DATA" "$CONFIG"

# 3. install the git hook so the repo self-checks on commit
if [[ -d .git ]]; then
  install -m 755 hooks/pre-commit .git/hooks/pre-commit
  echo "Installed pre-commit hook."
fi
echo "Bootstrap complete. Next: review .env, then 'make deploy'."
```

### `scripts/deploy.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose config -q                  # fail fast on bad compose/env
docker compose pull "$@"                   # latest images
docker compose up -d --remove-orphans "$@"
docker compose ps
# usage: ./scripts/deploy.sh            (whole stack)
#        ./scripts/deploy.sh jellyfin   (one service, for phased bring-up)
```

### `scripts/teardown.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

case "${1:-stop}" in
  stop)     # remove containers, keep app-config AND media (images stay cached)
    docker compose down ;;
  clean)    # also wipe per-app config, but KEEP media (images stay cached)
    docker compose down
    sudo rm -rf "${CONFIG:?}/"* ;;
  destroy)  # nuke EVERYTHING: containers, networks, config, media, AND images
    read -rp "Deletes containers, images, config AND ALL MEDIA in $DATA. Type 'destroy': " c
    [[ "$c" == "destroy" ]] || { echo "Aborted."; exit 1; }
    docker compose down -v --rmi all
    sudo rm -rf "${CONFIG:?}" "${DATA:?}" ;;
  *) echo "usage: teardown.sh [stop|clean|destroy]"; exit 1 ;;
esac
```

### `Makefile`
```makefile
.PHONY: bootstrap deploy down clean destroy validate ps logs
bootstrap:  ## one-time host prep (dirs, .env, hook)
	./scripts/bootstrap.sh
deploy:     ## validate + pull + start (make deploy s=jellyfin for one)
	./scripts/deploy.sh $(s)
down:       ## stop & remove containers (keeps data + config)
	./scripts/teardown.sh stop
clean:      ## down + wipe app config (KEEPS media)
	./scripts/teardown.sh clean
destroy:    ## down + delete config, media AND images (guarded)
	./scripts/teardown.sh destroy
validate:   ## lint the compose file
	docker compose config -q && echo OK
ps:
	docker compose ps
logs:       ## tail logs (make logs s=radarr)
	docker compose logs -f --tail=100 $(s)
```

### `hooks/pre-commit`
```bash
#!/usr/bin/env bash
set -euo pipefail
# never commit the real .env
if git diff --cached --name-only | grep -qx '.env'; then
  echo "✗ Refusing to commit .env (contains secrets). Unstage it."; exit 1
fi
# the compose file must always be valid
docker compose config -q || { echo "✗ docker-compose.yml is invalid"; exit 1; }
echo "✓ pre-commit checks passed"
```

### `README.md` (lifecycle cheat-sheet)
```markdown
# Home Media Stack
Self-hosted media pipeline on the NUC. Runs as system Docker containers owned by
`brennan` (PUID/PGID 1000), from this repo in /home/brennan/movie-server. Survives
reboots automatically (system Docker daemon restarts containers on boot — no login,
and no dependency on the repo's location, required).

## First run
    make bootstrap     # creates /data + /opt/appdata, .env, git hook
    $EDITOR .env       # confirm values (defaults are correct for brennan)
    make deploy        # bring up the whole stack (or: make deploy s=jellyfin)

## Daily ops
    make ps            # what's running
    make logs s=radarr # tail a service
    make deploy        # re-apply after editing compose (idempotent)
    make down          # stop everything (data + config safe)
    make clean         # reset app config, KEEP media
    make destroy       # delete config, media AND images (asks you to type 'destroy')

## Where things live
- Stack/config-as-code: /home/brennan/movie-server (this repo)
- App config:           /opt/appdata
- Media + torrents:     /data   (hard-capped 20 GB loopback image — see below)

## Storage cap (hard, 20 GB)
/data is a fixed-size loopback ext4 image (DATA_IMG/DATA_IMG_SIZE in .env), mounted by
`make bootstrap` and kept in /etc/fstab (loop,nofail) so it remounts on boot before
Docker. The inner filesystem cannot exceed the cap; it's sparse so it only uses real disk
as filled. qBittorrent also pauses on low free space (graceful backstop). To grow/move:
`make down`, blank DATA_IMG + set DATA=/mnt/<drive>, migrate, `make bootstrap && make deploy`.

## Ports
8096 Jellyfin · 8080 qBittorrent · 9696 Prowlarr · 7878 Radarr · 8989 Sonarr
6767 Bazarr · 5055 Jellyseerr (Phase 4)
```

---

## 4A. Configuration as code (provisioning)

**Goal: minimize what must be remembered/clicked in any web UI.** Every deterministic
setting is codified and applied via each app's REST API by idempotent scripts. The web
UI is used only to *verify*, never as the source of truth.

**Mechanism (decided): custom `curl`/`jq` scripts** (no extra dependencies; `jq` + `curl`
already present on the host). Layout:
```
scripts/
├── lib.sh             # shared helpers: wait_http, arr_apikey, log/die, require
├── provision.sh       # orchestrator: ./provision.sh [app...]  (dep-ordered, idempotent)
└── provision/
    ├── jellyfin.sh     # wizard automation + /media/movies & /media/tv libraries
    ├── qbittorrent.sh  # save paths, radarr/sonarr categories, pause-on-low-disk, LAN auth
    ├── prowlarr.sh     # register Radarr+Sonarr as apps (syncs indexers) + test indexer
    ├── radarr.sh       # qBittorrent download client + root folder + quality profile
    ├── sonarr.sh       # same, for TV
    └── bazarr.sh       # connect Radarr/Sonarr + languages (+ provider if creds in .env)
```
Run with `make provision` (all) or `make provision s=radarr` (one). `make up` =
`deploy` + `provision`.

**Key handling — pin by discovery (not brittle templates):** Radarr/Sonarr/Prowlarr/Bazarr
generate their own `ApiKey` in `config.xml` on first start; `arr_apikey()` reads it and the
scripts reuse it. No hand-authored config XML to drift against image versions.

**Build discipline:** each provisioner is written and **tested against the live container**
before its phase is marked done — guessed API payloads are how IaC rots.

**What stays manual (irreducible) — kept as secrets in gitignored `.env`:**
- Secret *values*: `JELLYFIN_ADMIN_PASS`, `OPENSUBTITLES_*`, any real indexer creds.
- Fire Stick: install the Jellyfin app + point it at the server (physical device).
- Router: the DHCP reservation for `NUC_IP`.

Each phase below lists its **UI steps**, but every deterministic one of those is realized
by the matching `provision/<app>.sh` — the checklist doubles as the provisioner's spec.

---

## 5. Phased execution (verify acceptance before advancing)

### Phase 0 — Host prep
- [x] Quick re-verify host facts: `docker --version`, `docker compose version`,
      `id` (expect uid/gid 1000), `df -h /`. **DONE 2026-06-16:** Docker 26.0.0,
      compose v2.25.0, uid/gid 1000 (in `docker` group), ~69 GB free, host `haleiwa`.
- [ ] Confirm `192.168.1.74` is a **DHCP reservation / static** so the Fire Stick
      always finds it; record it as `NUC_IP`. (Set this on the router.)
- [x] Confirm Docker starts on boot: `systemctl is-enabled docker` → **enabled**.
- [x] Create all files in §4 in this repo (`/home/brennan/movie-server`, git already
      initialized). **DONE** — compose/scripts/Makefile/hook/README written.
- [ ] `make bootstrap` (needs sudo: creates `/data` + `/opt/appdata`) → review `.env`
      → `make validate`.
- **Acceptance:** `make validate` prints OK *(passing)*; pre-commit hook installed
  *(done)*; docker enabled on boot *(confirmed)*; `/data` (20 GB loopback cap) +
  `/opt/appdata` exist owned by `brennan` *(done)*. **Phase 0 COMPLETE.**

### Phase 1 — Jellyfin + playback (the make-or-break test)
- [x] `make deploy s=jellyfin` — Jellyfin 10.11.11 up on :8096.
- [x] **IaC:** `make provision s=jellyfin` completes the wizard, creates admin user from
      `.env`, and adds Movies (`/media/movies`) + TV (`/media/tv`) libraries. No UI.
      Idempotent. *(see `scripts/provision/jellyfin.sh`)*
- [x] Test film: **Sintel (2010)** (Blender open movie, CC-licensed, on TMDB, ships subs)
      placed at `/data/media/movies/Sintel (2010)/`.
- [x] **Fire Stick test PASSED (2026-06-16):** Jellyfin app → `http://192.168.1.74:8096`,
      `brennan`/`brennan`, Sintel **direct-plays perfectly over wifi**. No transcode.
- **Acceptance: MET.** Smooth 1080p direct play on the projector over wifi. **Phase 1
  COMPLETE.** (`haleiwa.local` not used — avahi advertises a Docker IP; pinned the LAN IP
  via a static address on the NUC instead, see below.)

**Addressing (decided 2026-06-16):** the NUC now has a **static IP `192.168.1.74`** set
on the NUC side via NetworkManager (`Wired connection 1`, ipv4.method manual, gw
`.254`, dns 8.8.8.8). `haleiwa.local` was rejected — avahi advertises a Docker bridge IP
(`172.18.0.1`). Couldn't access the Telus router UI to do a proper DHCP reservation.
**Future caveat:** `.74` came from the DHCP pool, so a reservation (or an IP outside the
pool) is still the cleaner long-term fix to rule out a lease collision. Port `8096` is fixed.

**Credentials (decided):** all services use **`brennan`/`brennan`** — deliberate, this is
a private isolated home LAN with no inbound exposure. Stored in gitignored `.env`.

### Phase 2 — Download + automation
- [x] `make deploy s="qbittorrent prowlarr radarr sonarr"`.
- [x] **IaC** `make provision s=qbittorrent`: WebUI creds (`brennan/brennan`), save paths
      (complete `/data/torrents/complete`, incomplete `/data/torrents/incomplete`),
      `radarr`/`sonarr` categories + their dirs, Automatic Torrent Management on (sorts
      grabs into category subdirs). NOTE: qBittorrent has **no** native "pause on low
      disk space" — the 20 GB loopback cap is the real ceiling (writes fail → torrent
      pauses on I/O error). *(scripts/provision/qbittorrent.sh)*
- [x] **IaC** `make provision s=prowlarr`: UI auth; **Radarr + Sonarr registered as
      Applications** (`fullSync`) so indexers added later auto-sync. Adding an actual
      indexer = deferred real-indexer strategy (§8). *(scripts/provision/prowlarr.sh)*
- [x] **IaC** `make provision s="radarr sonarr"`: qBittorrent download client (verified
      reachable, HTTP 200 test), root folders `/data/media/movies` & `/data/media/tv`,
      UI auth forms `brennan`/`brennan` bypassed on LAN. *(scripts/provision/_arr_common.sh)*
- [x] **Hardlink test PASSED (2026-06-17):** downloaded **Big Buck Bunny (2008)** (CC,
      TMDB) through qBittorrent, imported via Radarr → library copy and download copy
      share **inode 131079, link count 2**, 264 MB counted once. Seeding copy intact.
- **Acceptance: MET.** Imports by hardlink (same inode, link count ≥ 2), original keeps
  seeding, no copy duplication, all on `/dev/loop10`. **Phase 2 COMPLETE.**
- *Caveat:* end-to-end **indexer-driven search** is not exercised (no indexer yet — the
  deferred real-indexer decision). The download→import→hardlink pipeline itself is proven.

### Phase 3 — Subtitles
- [x] `make deploy s=bazarr` — Bazarr 1.5.6 up.
- [x] **IaC** `make provision s=bazarr` (`scripts/provision/bazarr.sh`): wires Radarr +
      Sonarr into `config.yaml`; enables the **opensubtitlescom** provider with creds from
      `.env` (`general.enabled_providers` + top-level `opensubtitlescom`); creates an
      **English language profile** and sets it default for movies & series (via settings API).
- [x] **Subtitle download PASSED (2026-06-17):** Bazarr fetched
      `Big Buck Bunny.en.srt` next to the media (score 77.5%, provider opensubtitlescom);
      Jellyfin rescanned to expose it.
- **Acceptance: MET.** Subtitles auto-download next to the media file. **Phase 3 COMPLETE.**
- *Gotchas learned:* OpenSubtitles **.com** (the API) is a separate account from **.org**;
  Bazarr persists provider auth failures in `config/throttled_providers.dat` for 12 h
  (delete + restart to retry). Movies synced **before** a default profile exists have no
  profile (`missing=0`) — re-sync or set profile to fix. The OpenSubtitles account is the
  one irreducible secret (in `.env`).

### Bonus (done 2026-06-17) — Indexers + FlareSolverr (real acquisition)
- [x] Added **FlareSolverr** service (compose) for Cloudflare-protected indexers.
- [x] **IaC** Prowlarr now adds public indexers from their Cardigann definitions:
      **YTS** (movies, priority 10), **The Pirate Bay** (25), **1337x** (25, via
      FlareSolverr proxy), **EZTV** (25, TV). FlareSolverr registered as a tagged indexer
      proxy. *(scripts/provision/prowlarr.sh)*
- **Verified:** Prowlarr aggregated search returned 22 (TPB) + 6 (1337x) results; indexers
  synced to Radarr/Sonarr. The download→import→hardlink pipeline now has live search.
- *Note:* this supersedes the earlier "real indexer strategy deferred" stance — user opted
  in for the local PoC.

### Phase 4 — Nice UI + custom retention
- [x] `jellyseerr` service deployed (`:5055`).
- [x] **IaC** `make provision s=jellyseerr` (`scripts/provision/jellyseerr.sh`): creates the
      owner from the Jellyfin login (serverType **2**=Jellyfin), enables Movies+TV
      libraries (`?sync=true` THEN `?enable=ids`), wires Radarr + Sonarr (HD-1080p profile,
      correct roots, default+sync), marks initialized. Idempotent.
- **Verified:** initialized=true, Radarr/Sonarr default+sync, TMDB search works (Inception),
  reachable on LAN `:5055`. Log in with Jellyfin `brennan`/`brennan`. **Request UI LIVE.**
- *Auth gotchas:* first-run needs the full server payload + `serverType:2`; afterwards login
  is username/password only (the setup payload then errors "already configured").
- [x] **Auto-scan connection (done 2026-06-17):** Radarr + Sonarr each have a **Jellyfin
      (MediaBrowser) connection** with `updateLibrary=true` + triggers on import / upgrade /
      rename / delete, so new media appears in Jellyfin **automatically** (Jellyfin's own
      real-time monitoring is unreliable over Docker bind-mounts). Uses a Jellyfin API key
      minted via `lib.sh:jellyfin_apikey` (app "arr"). Tested HTTP 200.
      *(scripts/provision/_arr_common.sh)*
- [x] **Web portal / dashboard (done 2026-06-17):** mobile-friendly controller served by a
      new **`controller`** container (`:8088`, `controller/`), an IaC compose service like
      the rest. Node/Express `server.js` serves a dependency-light 3-tab UI
      (Home: service health + free-space-vs-cap + a Jellyseerr "Request" button;
      Downloads: live qBittorrent + *arr-queue progress; Library: search + one-click clean-up)
      and a same-origin API (`/api/status|disk|downloads|library|delete`) that injects each
      service's auth server-side — keys never reach the browser. Provisioned by
      `scripts/provision/controller.sh` (pin-by-discovery via `arr_apikey`/`jellyfin_apikey`
      into `/opt/appdata/controller/keys.env`); `controller` runs **last** in
      `provision.sh`'s `ALL`. `deploy.sh` gained `--build` so the image re-bakes on code
      changes. **Resolved the GH-Pages caveat:** the live controller is the NUC-served
      `http://192.168.1.74:8088` (same-origin http — no mixed content); GitHub Pages
      (`.github/workflows/pages.yml`) publishes the same `web/` as a public deep-link
      launcher that degrades to a "not on your home network" banner off-LAN. A unified
      HTTPS domain live at home remains a future reverse-proxy + cert task.
- [x] **One-click "delete everything" (done 2026-06-17):** implemented in the controller as
      `POST /api/delete {app,id,dryRun}` (**dry-run by default**; UI shows the plan, then a
      confirm fires the real run). Proven recipe, executed in order:
      1) **Radarr/Sonarr** `DELETE /movie|series/{id}?deleteFiles=true` (library file + notifies Jellyfin),
      2) **qBittorrent** `torrents/delete?deleteFiles=true` (torrent hashes resolved via *arr
         history; stops seeding + removes download copy; hardlinks mean space frees only once
         BOTH 1 & 2 are gone),
      3) **Jellyfin** `DELETE /Items/{id}` — only when a library goes *fully* empty
         (empty-library safety skips purging otherwise; single deletes clear via the scan),
      4) **Jellyseerr** `DELETE /api/v1/media/{mediaId}` — else it keeps showing the title as
         "Available" (404-tolerant/idempotent so a half-finished delete re-runs safely).
- [ ] **Retention janitor** (bespoke, **dry-run by default**, never deletes until
      explicitly switched on): keeps monitored-but-unaired TV indefinitely; deletes
      movies N days after marked watched in Jellyfin; respects a "keep" allowlist.
      APIs: Radarr/Sonarr REST + Jellyfin playstate. Open question: own small DB vs
      stateless (decide when building).
- **Acceptance:** requesting from the phone fulfills automatically; janitor dry-run
  correctly lists what it *would* delete (and deletes nothing).

---

## 6. Verification (end-to-end)
- `make validate` → OK; `docker compose ps` shows expected services up per phase.
- **Hardlink proof:** `stat` the imported media file → link count ≥ 2, same inode as
  the torrent copy, both on `/dev/sda2`.
- **Power-loss sim:** `sudo reboot`; after boot, confirm containers auto-return
  (`docker compose ps`, nothing started by hand) and Jellyfin answers on `:8096`.
- **Login-independent:** confirm web UIs are reachable from another LAN device while
  no one is logged into the NUC console.

---

## 7. Guardrails for Claude Code
- **Legal test content only** (Linux ISOs, archive.org). No real/private indexers in
  the prototype.
- Retention janitor is **dry-run by default**; never auto-delete until explicitly on.
- Bring services up **one phase at a time**; verify acceptance before the next.
- All secrets in `.env` (gitignored); commit `.env.example` only — the pre-commit hook
  blocks a real `.env`.
- **No manual `docker run`** — `docker-compose.yml` + scripts are the single source of
  truth.
- **Never** run `make destroy` / `teardown.sh destroy` without explicit user
  confirmation — it deletes media. `down`/`clean` are the safe defaults.

---

## 8. Future TODOs (not part of the initial prototype)
- **VPN for the downloader (deferred):** route only torrent traffic through a VPN
  (e.g. Mullvad ~CA$7/mo). Add a `gluetun` service; set qBittorrent
  `network_mode: "service:gluetun"` and move its published ports onto gluetun; VPN
  creds in `.env`. Verify the qBittorrent container's public IP ≠ home IP and that
  killing the VPN kills its traffic (no leak). Only needed beyond legal test content.
- **External drive:** when the prototype proves out, mount a drive, set `DATA=` to it
  in `.env`, migrate `/data`, re-deploy.
- **Playback client upgrade:** Fire Stick (1080p) → 4K Onn box or Pi+Kodi.
- **Jellyfin hardware transcoding:** only if direct play ever fails — map `/dev/dri`
  for Intel QSV.
- **Real indexer strategy:** out of scope for prototyping.

---

## 9. Service reference (ports)
| Service | Port | Role |
|---|---|---|
| Jellyfin | 8096 | media library + server + player API |
| qBittorrent | 8080 | torrent download client |
| Prowlarr | 9696 | indexer manager (feeds Radarr/Sonarr) |
| Radarr | 7878 | movie automation |
| Sonarr | 8989 | TV automation |
| Bazarr | 6767 | automatic subtitles |
| Jellyseerr | 5055 | request UI (Phase 4) |
