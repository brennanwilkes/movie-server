#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Grow the hard-capped $DATA loopback image to $DATA_IMG_SIZE (from .env).
# Grow-only and idempotent: shrinking is refused (resize2fs shrink is risky),
# and a no-op exit if the image already matches the target.
#
# Stop the stack first so nothing holds /data open:   make down
#
# Steps: unmount -> truncate image up -> e2fsck -f -> resize2fs -> remount.

set -a; source .env; set +a

if [[ -z "${DATA_IMG:-}" || -z "${DATA_IMG_SIZE:-}" ]]; then
  echo "DATA_IMG / DATA_IMG_SIZE not set in .env — nothing to resize." >&2
  exit 1
fi
if [[ ! -f "$DATA_IMG" ]]; then
  echo "$DATA_IMG does not exist yet — run 'make bootstrap' to create it." >&2
  exit 1
fi

target_bytes=$(numfmt --from=iec "$DATA_IMG_SIZE")
current_bytes=$(stat -c %s "$DATA_IMG")

if (( target_bytes == current_bytes )); then
  echo "$DATA_IMG already ${DATA_IMG_SIZE} — nothing to do."
  exit 0
fi
if (( target_bytes < current_bytes )); then
  echo "Refusing to shrink: image is $(numfmt --to=iec $current_bytes), target ${DATA_IMG_SIZE}." >&2
  exit 1
fi

# Preflight: is there room on the filesystem that backs the image for the growth?
grow_bytes=$(( target_bytes - current_bytes ))
avail_bytes=$(( $(stat -f -c '%a' "$(dirname "$DATA_IMG")") * $(stat -f -c '%S' "$(dirname "$DATA_IMG")") ))
if (( grow_bytes > avail_bytes )); then
  echo "Not enough free space on $(dirname "$DATA_IMG"): need $(numfmt --to=iec $grow_bytes), have $(numfmt --to=iec $avail_bytes)." >&2
  exit 1
fi

# /data must be unmounted (and not held open by containers) to resize safely.
if mountpoint -q "$DATA"; then
  echo "Unmounting $DATA ..."
  if ! sudo umount "$DATA"; then
    echo "$DATA is busy — stop the stack first:  make down" >&2
    exit 1
  fi
fi

echo "Growing $DATA_IMG to ${DATA_IMG_SIZE} ..."
sudo truncate -s "$DATA_IMG_SIZE" "$DATA_IMG"
sudo e2fsck -fy "$DATA_IMG" || true   # resize2fs requires a clean fsck; -y auto-fixes
sudo resize2fs "$DATA_IMG"

sudo mount "$DATA"
echo "Resized. $DATA is now:"
df -h "$DATA"
