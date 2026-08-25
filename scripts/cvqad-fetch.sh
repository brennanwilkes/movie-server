#!/usr/bin/env bash
# Resumable fetch of the CVQAD subset used for external calibration (task #51).
#
# WHY THIS EXISTS AS A SCRIPT. The first download ran ad hoc, straight into the repo, and filled the
# 221 GB boot SSD to zero bytes — it died at 138 of 249 and took the rest of the session's disk with
# it. Two things caused that: the corpus is far larger than the CSV bitrates suggest (the distributed
# clips are HEVC re-encodes at 10-49 Mbps, ~144 MB each, so the subset is ~36 GB not ~9 GB), and
# nothing checked free space between files. Both are fixed here.
#
# RULES ENCODED BELOW:
#   - target is /data (the 8 TB external), NEVER the repo or the boot SSD
#   - stop cleanly if free space falls under MIN_FREE_GB, rather than filling the volume
#   - download to .part and rename only on success, so a partial file can never look complete
#   - skip anything already present, so re-running is free
#
# USAGE: scripts/cvqad-fetch.sh [--dir /data/research/cvqad] [--min-free 20]
set -u

DIR=/data/research/cvqad
MIN_FREE_GB=20
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --min-free) MIN_FREE_GB="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

BASE=https://huggingface.co/datasets/deepfakesMSU/CVQAD/resolve/main
CLIPS="$DIR/clips"
mkdir -p "$CLIPS"

case "$CLIPS" in
  /data/*) ;;
  *) echo "REFUSING: $CLIPS is not under /data — the boot SSD cannot hold this corpus." >&2; exit 1 ;;
esac

freeGb() { df -BG --output=avail "$CLIPS" | tail -1 | tr -dc '0-9'; }

total=$(wc -l < "$DIR/paths.txt")
n=0; got=0; skipped=0; failed=0
while IFS= read -r p; do
  [ -n "$p" ] || continue
  n=$((n + 1))
  name=$(printf '%s' "$p" | sed 's|Compressed_and_GT_videos/||; s|/|__|g')
  out="$CLIPS/$name"
  if [ -s "$out" ]; then skipped=$((skipped + 1)); continue; fi

  free=$(freeGb)
  if [ "$free" -lt "$MIN_FREE_GB" ]; then
    echo "STOPPING at $n/$total — only ${free}G free on $CLIPS (floor ${MIN_FREE_GB}G)."
    break
  fi

  if curl -fsSL --retry 3 --retry-delay 5 -o "$out.part" "$BASE/$p"; then
    mv "$out.part" "$out"
    got=$((got + 1))
    echo "[$n/$total] ok  $name  ($(du -m "$out" | cut -f1) MB, ${free}G free)"
  else
    rm -f "$out.part"
    failed=$((failed + 1))
    echo "[$n/$total] FAIL $p"
  fi
done < "$DIR/paths.txt"

echo "done: $got fetched, $skipped already present, $failed failed, $(ls "$CLIPS" | wc -l) clips on disk"
