#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. create .env from the committed template if it doesn't exist yet
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example — review values before deploying."
fi
set -a; source .env; set +a

# 2. hard storage cap (optional): mount $DATA as a fixed-size loopback ext4 image.
#    The inner filesystem cannot exceed $DATA_IMG_SIZE — writes fail past the cap,
#    no matter what qBittorrent/Radarr try. Sparse: only uses real disk as filled.
if [[ -n "${DATA_IMG:-}" ]]; then
  if ! mountpoint -q "$DATA"; then
    if [[ ! -f "$DATA_IMG" ]]; then
      echo "Creating ${DATA_IMG_SIZE} sparse image at $DATA_IMG ..."
      sudo truncate -s "$DATA_IMG_SIZE" "$DATA_IMG"
      sudo mkfs.ext4 -q -F "$DATA_IMG"
    fi
    sudo mkdir -p "$DATA"
    # persist across reboots; local-fs.target mounts this before Docker starts
    if ! grep -qsF " $DATA ext4 loop" /etc/fstab; then
      echo "$DATA_IMG $DATA ext4 loop,nofail 0 0" | sudo tee -a /etc/fstab >/dev/null
      echo "Added /etc/fstab entry for $DATA (survives reboot)."
    fi
    sudo mount "$DATA"
    echo "Mounted hard-capped filesystem at $DATA (${DATA_IMG_SIZE})."
  fi
fi

# 2b. Docker must WAIT for /data before starting containers. The fstab entry for the USB
#     data drive is nofail with a 10s device timeout — after a power-loss reboot, slow USB
#     enumeration means boot proceeds WITHOUT /data mounted, Docker auto-starts the stack
#     against the bare /data dir on the SSD, and qBittorrent marks every torrent
#     missingFiles / starts re-downloading onto the root disk (audit 2026-07-02; the
#     2026-06-29 outage already demonstrated the reboot path). RequiresMountsFor makes
#     docker.service depend on the /data mount unit — no mount, no containers.
DOCKER_DROPIN=/etc/systemd/system/docker.service.d/wait-for-data.conf
if mountpoint -q "$DATA" && ! grep -qs "RequiresMountsFor=$DATA" "$DOCKER_DROPIN" 2>/dev/null; then
  sudo mkdir -p "$(dirname "$DOCKER_DROPIN")"
  printf '[Unit]\nRequiresMountsFor=%s\n' "$DATA" | sudo tee "$DOCKER_DROPIN" >/dev/null
  sudo systemctl daemon-reload
  echo "Installed docker.service drop-in: containers now wait for $DATA to mount at boot."
fi

# 2c. PS3 normalization timer: fresh imports get audio→AC3 / container→mp4 (video untouched)
#     so the best-quality grabs (WEB-DL EAC3/MKV) still direct-play on the PS3. Host-side
#     because the controller mounts /data read-only and ffmpeg lives in the jellyfin image.
if ! cmp -s scripts/ps3fix.service /etc/systemd/system/ps3fix.service 2>/dev/null \
   || ! cmp -s scripts/ps3fix.timer /etc/systemd/system/ps3fix.timer 2>/dev/null; then
  sudo install -m 644 scripts/ps3fix.service scripts/ps3fix.timer /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now ps3fix.timer
  echo "Installed ps3fix.timer (post-import PS3 audio normalization, every 30 min)."
fi

# 3. create the data + config tree (single $DATA root enables hardlinks)
sudo mkdir -p "$DATA"/torrents/{incomplete,complete} \
              "$DATA"/media/{movies,tv} \
              "$CONFIG"
sudo chown -R "$PUID:$PGID" "$DATA" "$CONFIG"

# 4. install the git hook so the repo self-checks on commit
if [[ -d .git ]]; then
  install -m 755 hooks/pre-commit .git/hooks/pre-commit
  echo "Installed pre-commit hook."
fi
echo "Bootstrap complete. Next: review .env, then 'make deploy'."
