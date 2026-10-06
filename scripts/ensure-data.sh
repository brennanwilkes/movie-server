#!/usr/bin/env bash
# Ensure $DATA is mounted from the media drive before the stack starts.
#
# Recovers the unplug/replug cycle:  make down -> unplug -> (later) replug -> make up.
# After a yank, the kernel keeps a dead mount on $DATA and the desktop may auto-mount
# the returning drive elsewhere (/media/$USER/...). This detects that and remounts the
# drive at $DATA so the freshly-(re)created containers bind the good mount.
#
# Only invokes sudo when a remount is actually needed — the happy path (drive already
# mounted at $DATA) does zero sudo, so a normal `make up` never prompts for a password.
#
# FAIL-CLOSED: if the drive is not there, this exits 1 and the stack does not start at all.
# See the drive-absent branch below and scripts/media-drive-gate.sh for why there is no
# "start anyway, degraded" path.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

# Expected UUID = whatever fstab mounts at $DATA (single source of truth).
UUID=$(awk -v m="$DATA" '$1 ~ /^UUID=/ && $2==m {sub(/^UUID=/,"",$1); print $1; exit}' /etc/fstab)
if [[ -z "$UUID" ]]; then
  echo "ensure-data: no 'UUID=... $DATA' line in /etc/fstab — skipping."
  exit 0
fi

by_uuid="/dev/disk/by-uuid/$UUID"                 # exists iff the drive is plugged in
dev_of_data() { local s; s=$(findmnt -fno SOURCE --target "$DATA" 2>/dev/null) && [[ -n "$s" ]] && readlink -f "$s"; }

# Happy path: $DATA is already backed by the media drive — no sudo, no prompt.
if [[ -e "$by_uuid" && "$(dev_of_data)" == "$(readlink -f "$by_uuid")" ]]; then
  echo "ensure-data: ✓ $DATA mounted from the media drive."
  exit 0
fi

# Drive not detected. FAIL CLOSED — do not create anything under $DATA.
#
# This branch used to `mkdir -p $DATA/media/{movies,tv} $DATA/torrents/{...}` and exit 0,
# starting the whole stack against an empty $DATA on the boot SSD. Because /data is on the
# 221 GB SSD that also holds the OS, Docker and /opt/appdata, a single download would then
# eat the root filesystem and the box becomes unbootable — a failure no amount of deleting
# fixes. There is no safe version of "start anyway": an absent drive is not a degraded
# $DATA, it is an EMPTY ONE ON THE WRONG FILESYSTEM.
if [[ ! -e "$by_uuid" ]]; then
  mountpoint -q "$DATA" && { echo "  clearing stale $DATA mount"; sudo umount -l "$DATA" || true; }
  echo "ensure-data: ✗ media drive ($UUID) not detected — NOT starting the stack." >&2
  ./scripts/media-drive-gate.sh >&2 || true
  echo "ensure-data:   plug the drive in, then: make remount && make up" >&2
  echo "ensure-data:   (use 'make eject' BEFORE unplugging — it flushes and unmounts cleanly)" >&2
  exit 1
fi

# Drive present but not mounted at $DATA (stale mount after a yank, or auto-mounted
# elsewhere by the desktop). Recover.
echo "ensure-data: ↻ media drive present but $DATA isn't mounted from it — recovering (sudo)…"
dev=$(readlink -f "$by_uuid")
# 1. Release stray mounts of the drive (e.g. udisks auto-mount under /media/$USER/…).
while read -r tgt; do
  [[ -n "$tgt" && "$tgt" != "$DATA" ]] && { echo "  unmounting stray $tgt"; sudo umount "$tgt" 2>/dev/null || sudo umount -l "$tgt"; }
done < <(findmnt -rno TARGET "$dev" 2>/dev/null)
# 2. Clear a stale/broken mount sitting on $DATA.
mountpoint -q "$DATA" && { echo "  clearing stale $DATA"; sudo umount "$DATA" 2>/dev/null || sudo umount -l "$DATA"; }
# 3. Mount fresh from fstab.
sudo mount "$DATA"

if [[ "$(dev_of_data)" == "$dev" ]]; then
  echo "ensure-data: ✓ $DATA recovered."
else
  echo "ensure-data: ✗ failed to mount the media drive at $DATA." >&2
  exit 1
fi
