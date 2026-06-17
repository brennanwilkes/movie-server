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

## Teardown levels
- `down`    — remove containers/networks. Media, config, and images all kept.
- `clean`   — `down` + wipe `/opt/appdata` (app config). Media + images kept.
- `destroy` — the real one. Removes containers, networks, `/data`, `/opt/appdata`,
              AND the pulled Docker images. After this, nothing but this code remains.

## Where things live
- Stack/config-as-code: this repo (`/home/brennan/movie-server`)
- App config:           /opt/appdata
- Media + torrents:     /data   (single disk for now; ~10 GB cap — see below)

## Storage cap (hard, 20 GB)
`/data` is a fixed-size loopback ext4 image (`DATA_IMG`=/opt/media-data.img,
`DATA_IMG_SIZE`=20G in .env), created+mounted by `make bootstrap` and kept in
/etc/fstab (`loop,nofail`) so it remounts on boot before Docker. The inner filesystem
cannot exceed the cap — writes fail past 20 GB — but it's sparse, so it only uses real
disk as it fills. qBittorrent is also set to pause on low free space (graceful backstop).
To grow / move to a real drive: `make down`, blank DATA_IMG and set DATA=/mnt/<drive>
in .env, migrate the data, then `make bootstrap && make deploy`.

## Ports
8096 Jellyfin · 8080 qBittorrent · 9696 Prowlarr · 7878 Radarr · 8989 Sonarr
6767 Bazarr · 5055 Jellyseerr · 8088 Controller (dashboard)

## Controller dashboard (`:8088`)
Mobile-friendly web controller for the whole stack — open `http://192.168.1.74:8088`
on your phone at home. Three tabs: **Home** (service health + free space vs the 20 GB
cap + a "Request" button to Jellyseerr), **Downloads** (live progress), and **Library**
(search a watched title → one-click *remove it everywhere*: Radarr/Sonarr → qBittorrent
→ Jellyfin → Jellyseerr, with a dry-run confirm). It's a normal compose service:
`make deploy s=controller` builds/starts it, `make provision s=controller` discovers
the API keys into `/opt/appdata/controller/keys.env` (never committed), and
`make down/clean/destroy` tear it down with everything else.

A public **launcher** copy is published to GitHub Pages from `controller/web/` on each
commit (`.github/workflows/pages.yml`) — handy as a bookmark, but live data/delete only
work from the NUC-served URL above (an HTTPS page can't reach the LAN over http; it
shows a "not on your home network" banner instead). A custom HTTPS domain that's live
at home would need a reverse proxy + cert on the NUC (future).
