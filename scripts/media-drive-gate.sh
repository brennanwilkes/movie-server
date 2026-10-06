#!/usr/bin/env bash
# Is the external media drive genuinely mounted at $DATA?
#
#   exit 0  yes — $DATA is a real mount backed by the drive named in /etc/fstab
#   exit 1  no  — drive absent, or $DATA is NOT a mountpoint (so every path under it,
#                 including $DATA/media and $DATA/torrents, is a directory on the 221 GB
#                 boot SSD — exactly where downloads and imports must never go)
#
# THE POINT: this is a gate, not a report. It is the single authority on "may the stack
# write to $DATA", called from three places that must agree:
#
#   1. ensure-data.sh     — before `make up` starts any container
#   2. media-drive-gate.service — before docker.service, which is what actually stops
#      `restart: unless-stopped` containers from silently coming up after a reboot with
#      the drive unplugged (no deploy.sh runs on boot, so #1 alone does not cover it)
#   3. make test          — asserts the gate is armed, so it cannot rot unnoticed
#
# Read-only: no sudo, no mounting, no side effects. Safe to call in a loop.
set -euo pipefail
cd "$(dirname "$0")/.."

DATA_DIR=/data
[[ -f .env ]] && { set -a; source .env; set +a; }
[[ -n "${DATA:-}" ]] && DATA_DIR="$DATA"

# Expected UUID = whatever fstab mounts at $DATA (single source of truth).
UUID=$(awk -v m="$DATA_DIR" '$1 ~ /^UUID=/ && $2==m {sub(/^UUID=/,"",$1); print $1; exit}' /etc/fstab)

if [[ -z "$UUID" ]]; then
  echo "✗ REFUSING: /etc/fstab has no 'UUID=... $DATA_DIR' line — cannot verify the media drive." >&2
  exit 1
fi

by_uuid="/dev/disk/by-uuid/$UUID"
# -e first: `readlink -f` happily returns the INPUT path when it does not exist, so
# without this the "drive is unplugged" case would masquerade as a detected device.
want=""; [[ -e "$by_uuid" ]] && want=$(readlink -f "$by_uuid")
got=$(findmnt -fno SOURCE --target "$DATA_DIR" 2>/dev/null | head -1)
got=$(readlink -f "$got" 2>/dev/null || true)

banner() {
  cat >&2 <<EOF

  ╔══════════════════════════════════════════════════════════════════════╗
  ║  ✗ MEDIA DRIVE NOT AVAILABLE — REFUSING TO START                   ║
  ╚══════════════════════════════════════════════════════════════════════╝
   $DATA_DIR is NOT backed by the external media drive.

   Drive detected : $( [[ -n "$want" ]] && echo "$want" || echo "NONE (by-uuid $UUID missing)" )
   $DATA_DIR serves  : ${got:-"(not a mountpoint — it is a plain directory on the boot SSD)"}

   Without this gate the stack starts against the 221 GB boot SSD and writes
   torrents and media imports there, which fills the disk holding the OS,
   Docker and /opt/appdata. That is not recoverable by deleting files.

   FIX:  plug the drive in, then run:   make remount && make up
   (or: make eject  before unplugging — it flushes and unmounts cleanly)

EOF
}

if [[ -z "$want" ]]; then banner; echo "   reason: the drive is not plugged in." >&2; exit 1; fi
if [[ -z "$got" ]];   then banner; echo "   reason: $DATA_DIR is not a mountpoint at all." >&2; exit 1; fi
if [[ "$got" != "$want" ]]; then
  banner
  echo "   reason: $DATA_DIR is mounted from $got, not the media drive ($want)." >&2
  exit 1
fi

echo "✓ media drive mounted at $DATA_DIR ($want)"