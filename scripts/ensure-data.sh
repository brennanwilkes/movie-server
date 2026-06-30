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

# Drive not detected: stay online but degraded — empty $DATA on the SSD.
if [[ ! -e "$by_uuid" ]]; then
  echo "ensure-data: ⚠ media drive not detected — starting with an empty $DATA (no media/torrents until reconnected)."
  mountpoint -q "$DATA" && { echo "  clearing stale $DATA mount"; sudo umount -l "$DATA" || true; }
  sudo mkdir -p "$DATA"/media/{movies,tv} "$DATA"/torrents/{incomplete,complete}
  sudo chown -R "$PUID:$PGID" "$DATA"
  exit 0
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
