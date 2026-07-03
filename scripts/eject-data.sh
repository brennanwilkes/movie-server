#!/usr/bin/env bash
# Stop the stack and SAFELY unmount the media drive at $DATA so it can be
# physically disconnected/reconnected. This is the symmetric counterpart to
# `make up` (deploy.sh -> ensure-data.sh mounts $DATA before the stack starts).
#
# Deliberately does NOT fall back to a lazy unmount: for a physical unplug we want
# a real flush + detach, and to fail LOUDLY if anything still holds the drive — so
# you never pull the cable while writes are in flight.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

# Always stop the stack first so no container bind-mount is holding $DATA.
echo "eject: stopping the stack so nothing holds $DATA…"
docker compose down

# Nothing mounted (e.g. drive already unplugged, or degraded start)? Done.
if ! mountpoint -q "$DATA"; then
  echo "eject: ✓ $DATA is not mounted — nothing to unmount; safe to disconnect."
  exit 0
fi

echo "eject: unmounting $DATA (flush + detach, sudo)…"
if ! sudo umount "$DATA"; then
  echo "eject: ✗ umount failed — something is still using $DATA:" >&2
  sudo fuser -vm "$DATA" >&2 || true
  echo "eject: close/stop the above and re-run 'make eject'." >&2
  echo "       (Refusing a lazy unmount — it's unsafe to unplug before a real flush.)" >&2
  exit 1
fi

# Verify it's actually gone.
if mountpoint -q "$DATA"; then
  echo "eject: ✗ $DATA still shows as mounted after umount — do NOT disconnect." >&2
  exit 1
fi
echo "eject: ✓ $DATA unmounted and flushed."

# Confirm the underlying device is now idle (peace-of-mind report).
UUID=$(awk -v m="$DATA" '$1 ~ /^UUID=/ && $2==m {sub(/^UUID=/,"",$1); print $1; exit}' /etc/fstab)
if [[ -n "${UUID:-}" && -e "/dev/disk/by-uuid/$UUID" ]]; then
  dev=$(readlink -f "/dev/disk/by-uuid/$UUID")
  echo "eject: drive idle at $dev — safe to power off and disconnect."
else
  echo "eject: safe to power off and disconnect."
fi
echo "eject: reconnect later, then 'make up' remounts $DATA and restarts the stack."
