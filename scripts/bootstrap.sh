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
