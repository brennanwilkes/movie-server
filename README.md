# Home Media Stack
Self-hosted media pipeline on the NUC (`haleiwa`). Runs as system Docker containers
owned by `brennan` (PUID/PGID 1000). The code lives in this repo (your home dir); the
only things deployed outside it are media (`/data`) and app config (`/opt/appdata`).
Survives reboots automatically, regardless of who (if anyone) is logged in — the system
Docker daemon restarts the containers on boot, not your login session.

## First run
    make bootstrap     # creates /data + /opt/appdata, .env, git hook
    $EDITOR .env       # confirm values (defaults are correct for brennan)
    make deploy        # bring up the whole stack (or: make deploy s=jellyfin)

## Daily ops
    make ps            # what's running
    make logs s=radarr # tail a service
    make deploy        # re-apply after editing compose (idempotent)
    make down          # stop everything (data + config safe, images cached)
    make clean         # reset app config, KEEP media (images cached)
    make destroy       # delete config, media AND images (asks you to type 'destroy')

## Debugging the grab algorithm ("why did it pick THAT release?")
    make search q="Pulp Fiction"   # available releases, ranked by the custom-format SCORE *arr grabs on,
                                   #   with the matched formats (codec/size/language) shown per release.
                                   #   The grab is the top row (ties broken by seeders). Add s=1 for Sonarr.
    make profiles                  # live quality-profile scores per tier (Low / Normal / Beloved)
    make history a=--missing       # recent grab/import history (flags: --missing --attention --summary)
    make querylogs s=radarr a='--grep grab'
    make diagnose                  # full stack health check
Codec/size weights live in `scripts/provision/_arr_common.sh` (§8, `build_formatitems`);
change them there and `make provision s=radarr` — never edit scores in the *arr UI (IaC-first).

## Teardown levels
- `down`    — remove containers/networks. Media, config, and images all kept.
- `clean`   — `down` + wipe `/opt/appdata` (app config). Media + images kept.
- `destroy` — the real one. Removes containers, networks, `/data`, `/opt/appdata`,
              AND the pulled Docker images. After this, nothing but this code remains.

## Where things live
- Stack/config-as-code: this repo (`/home/brennan/movie-server`) — **on the boot SSD**
- App config:           /opt/appdata — **on the boot SSD**
- Media + torrents:     /data (7.3 TB external USB drive)
- Research corpora:     /data/research (never in the repo — see below)

## Storage: two filesystems, and the small one is the one that bites

| Mount | Device | Size | Holds |
|-------|--------|------|-------|
| `/` | `/dev/sdb2` (internal SSD) | **221 GB** | OS, **this repo**, `/opt/appdata`, Docker, journals |
| `/data` | `/dev/sda1` (USB, label `media`) | 7.3 TB | media, torrents, research corpora |

`/data` is a real 8 TB WD My Book, mounted by UUID in `/etc/fstab`
(`defaults,nofail,x-systemd.device-timeout=10s`). The old hard cap — a sparse 20 GB
loopback image at `/opt/media-data.img` — was **removed on 2026-06-29** and no longer
exists. `make resize-data` / `DATA_IMG` in `.env` are vestiges of it.

**So there is no storage cap any more, and the 221 GB boot SSD is now the binding
constraint.** `/data` is a *mount, not a quota*: nothing stops a script from writing to the
SSD instead. Anything written inside this repo lands on `/`. On 2026-08-21 a research-corpus
download did exactly that and took `/` to zero bytes — see **Research corpora & scratch
data** in `AGENTS.md`.

Two things to know:
- **Bulk data goes to `/data/research/<name>/`**, symlinked into the repo if a script wants
  a repo-relative path. Preflight big fetches with `df` on the *target* filesystem.
- **The controller's disk gate does not protect `/`.** It calls `statfs('/data')`, so it will
  report terabytes free while the SSD fills. qBittorrent's pause-on-low-free-space is also
  scoped to its own save path on `/data`.

## Ports
8096 Jellyfin · 8080 qBittorrent · 9696 Prowlarr · 7878 Radarr · 8989 Sonarr
6767 Bazarr · 5055 Jellyseerr · 8088 Controller (dashboard)

## Who can log in where
| Account | Jellyfin (8096) | Jellyseerr (5055) | *arr / qBittorrent | Controller (80/8088) |
| --- | --- | --- | --- | --- |
| `brennan` / `brennan` | admin | owner | admin | no auth |
| `leslie` / `leslie` | watch only — non-admin, can't delete media or edit collections | request, **auto-approved**, unlimited | no account | no auth |

Leslie is a watch-and-request household account, provisioned by IaC from `JELLYFIN_USER_2` /
`JELLYFIN_PASS_2` in `.env` (leave the username empty to skip creating her). Her watch history,
Continue Watching and Next Up are separate from brennan's automatically — Jellyfin stores playstate
per user. The Fire Stick stays signed in as brennan, so anything watched **on the TV** lands in
brennan's history; she's web-only for now. The controller dashboard is unauthenticated by design,
so if she uses it her actions run as brennan.

## Controller dashboard (`http://movies.local`)
Mobile-friendly web controller for the whole stack, served from the NUC on **port 80**
(and `:8088`). On the wifi just open **`http://movies.local`** / **`http://movie.local`**
(or `http://192.168.1.74`).

Those `.local` names are published via mDNS by **`make mdns`** (installs a small systemd
service: `scripts/mdns-publish.sh` + `scripts/movie-mdns.service`) — zero DNS server,
router config, or per-device setup, and it follows the NUC's IP if DHCP changes. Names
must end in `.local` (mDNS only handles that suffix); edit `MDNS_NAME` in `.env`
(space-separated list, keep it quoted). Works great on iPhone/Mac; older Android has
weak mDNS support.

Three tabs: **Home** (service health + `/data` free space + Watch/Request
buttons), **Downloads** (live pipeline: Downloading → Importing → In library, with a
backend watchdog that rescues dropped imports), and **Library** (search a watched title
→ one-click *remove it everywhere*: Radarr/Sonarr → qBittorrent → Jellyfin → Jellyseerr,
dry-run confirm). It's a normal compose service: `make deploy s=controller` builds/starts
it, `make provision s=controller` wires the API keys into `/opt/appdata/controller/keys.env`
(never committed), and `make down/clean/destroy` tear it down with everything else.
