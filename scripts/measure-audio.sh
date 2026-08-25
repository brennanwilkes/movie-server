#!/usr/bin/env bash
# measure-audio.sh — measure the TRUE total audio bitrate of every library file.
#
# ── WHY ───────────────────────────────────────────────────────────────────────────────────────────
# On the ~18% of the library where *arr gives no trustworthy `videoBitrate`, bppOf() falls back to
# size/duration and charges ALL audio to video. arr-inspect's audioToSubtract() can only subtract the
# audio *arr admits to, and *arr reports ONE track — omitting lossless ones entirely.
#
# Measured on Lawrence of Arabia (1962) 2026-08-13:
#     ffprobe stream metadata:  ac3 448000 bps  +  dts "N/A"
#     actual audio packets:     2,590,746 bps total
# So 2.14 Mb/s of a 16.6 Mb/s container was being scored as picture. That is worth ~10 BPP+ points on
# that title, and it biases in the worst possible direction: it most flatters multi-dub and
# lossless-audio releases, which are exactly the releases we least want flattered.
#
# ── WHY THIS IS SEPARATE FROM THE NIGHTLY PROBE ───────────────────────────────────────────────────
# probe-film.sh now measures this too, but only when a unit is (re-)probed — 1026 entries at ~200 s
# each is ~14 nights. This script needs NO ENCODING AT ALL: it is one ffprobe packet read per file,
# about a second each, so the whole library is minutes rather than nights. The two agree by
# construction (same interval, same arithmetic) — this is the backfill, that is the steady state.
#
# ── COST NOTE ─────────────────────────────────────────────────────────────────────────────────────
# It is I/O-bound on the USB data drive, not CPU-bound. Do NOT run it alongside an encoding
# experiment: the seeks will slow the encodes' reads far more than the CPU saving is worth.
#
# READ-ONLY. Writes one JSONL file; touches no media and no controller state.
set -uo pipefail
cd "$(dirname "$0")/.."

ROOTS="${AUDIO_ROOTS:-/data/media/movies /data/media/tv}"
OUT="${AUDIO_OUT:-docs/audit-2026-07-31/raw/audio-measured.jsonl}"
WIN="${AUDIO_WIN:-120}"
LIMIT="${AUDIO_LIMIT:-0}"        # 0 = no limit; set small to smoke-test

# ── COST, MEASURED 2026-08-13 — READ THIS BEFORE ASSUMING THIS IS QUICK ───────────────────────────
# It is ~24 s/file, so the 884-movie library is ~6 HOURS. The cost is the SEEK, not the window:
# on Lawrence (28 GB) a 120 s window took 161 s and a 30 s window still took 120 s, so shortening the
# sample buys almost nothing. Typical 2-3 GB files are 20-28 s. Do not "optimise" this by shrinking
# AUDIO_WIN — that was tried and it is the wrong lever.
#
# Consequence: this is an OVERNIGHT job, and it MUST NOT run inside the 01:00-06:00 probe window, or
# two I/O-bound jobs will fight over one USB drive and both will crawl. AUDIO_DEADLINE (epoch seconds)
# stops it cleanly before then; the output is append-as-you-go, so a partial run is still useful and
# re-running resumes nothing but wastes only what it already did.
DEADLINE="${AUDIO_DEADLINE:-0}"

mkdir -p "$(dirname "$OUT")"
# APPEND, never truncate: a deadline-stopped run must not throw away what it measured.
[ -f "$OUT" ] || : > "$OUT"
n=0; skipped=0

# shellcheck disable=SC2086 -- ROOTS is a deliberate word-split list of directories
done_paths=$( [ -s "$OUT" ] && grep -oP '"path":"\K[^"]+' "$OUT" | sed 's/\\\\/\\/g' | sort -u || true )
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if [[ "$DEADLINE" -gt 0 ]] && [[ "$(date +%s)" -ge "$DEADLINE" ]]; then
    echo "  deadline reached — stopping cleanly after $n files" >&2; break
  fi
  # RESUME: skip anything already in the output, so a stopped run continues rather than restarts.
  if [[ -n "$done_paths" ]] && grep -qxF "$f" <<<"$done_paths"; then skipped=$((skipped+1)); continue; fi
  dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$f" 2>/dev/null | cut -d. -f1)
  if [[ -z "$dur" || "$dur" -lt 60 ]] 2>/dev/null; then skipped=$((skipped+1)); continue; fi
  start=$(awk -v d="$dur" 'BEGIN{printf "%d", d/3}')
  # Every audio stream, not just the first — dubs and commentary are real bytes in the container.
  bps=$(ffprobe -v error -read_intervals "${start}%+${WIN}" -select_streams a \
    -show_entries packet=size -of default=nw=1:nk=1 "$f" 2>/dev/null \
    | awk -v w="$WIN" '{s+=$1} END{ printf "%.0f", (w>0 ? s*8/w : 0) }')
  tracks=$(ffprobe -v error -select_streams a -show_entries stream=index \
    -of default=nw=1:nk=1 "$f" 2>/dev/null | wc -l | tr -d ' ')
  size=$(stat -c '%s' "$f" 2>/dev/null || echo 0)
  # jq -R is not assumed present; escape the path by hand for a valid JSON string.
  esc=${f//\\/\\\\}; esc=${esc//\"/\\\"}
  printf '{"path":"%s","size":%s,"duration":%s,"audioBps":%s,"audioTracks":%s}\n' \
    "$esc" "$size" "$dur" "${bps:-0}" "${tracks:-0}" >> "$OUT"
  n=$((n+1))
  [[ $((n % 50)) -eq 0 ]] && echo "  measured $n..." >&2
  [[ "$LIMIT" -gt 0 && "$n" -ge "$LIMIT" ]] && break
done < <(find $ROOTS -type f \( -iname '*.mkv' -o -iname '*.mp4' -o -iname '*.avi' -o -iname '*.m4v' \) 2>/dev/null | sort)

echo "measured $n files, skipped $skipped -> $OUT" >&2
