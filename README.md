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
6767 Bazarr · 5055 Jellyseerr (Phase 4)
