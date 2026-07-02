#!/usr/bin/env bash
# ps3ify.sh — make a title's files PS3-NATIVE (direct-play, no transcoding involved):
# MP4 container, H.264 video (stream-copied, quality untouched), AC3 5.1 audio.
# Fixes the "video plays but no audio" class — the PS3 cannot decode EAC3/DDP, DTS, Opus,
# or multichannel AAC — and the no-MKV rule, in one cheap pass (audio-only re-encode).
#
#   ./scripts/ps3ify.sh "Mormon Wives"              # every episode file of a series
#   ./scripts/ps3ify.sh --radarr "Pulp Fiction"     # a movie
#   make ps3ify q="Mormon Wives"
#
# Uses Jellyfin's bundled ffmpeg via docker exec (host /data/media ↔ container /media).
# Idempotent: mp4 + h264 8-bit + (ac3 | stereo-aac) files are skipped. Embedded text subs
# are extracted to a .en.srt sidecar first (MP4 drops them; existing sidecars win). Files
# with non-h264/10-bit video are SKIPPED with a warning — those need a re-grab, not a remux.
# Ends with an *arr rescan so mediaInfo updates; seeding torrents keep their own copies.
set -euo pipefail
cd "$(dirname "$0")/.."

APP=sonarr
case "${1:-}" in --radarr) APP=radarr; shift;; --sonarr) shift;; esac
Q="${1:?usage: ps3ify.sh [--radarr|--sonarr] \"Title\"}"
PORT=8989; [[ $APP == radarr ]] && PORT=7878
KEY=$(sed -n 's:.*<ApiKey>\(.*\)</ApiKey>.*:\1:p' "/opt/appdata/$APP/config.xml" | head -1)
api() { curl -sf -H "X-Api-Key: $KEY" "http://localhost:$PORT/api/v3$1"; }

if [[ $APP == sonarr ]]; then
  ID=$(api /series | jq -r --arg q "$Q" '[.[]|select(.title|ascii_downcase|contains($q|ascii_downcase))][0].id // empty')
  [[ -n "$ID" ]] || { echo "no series matching '$Q'"; exit 1; }
  FILES=$(api "/episodefile?seriesId=$ID" | jq -r '.[].path')
  RESCAN='{"name":"RescanSeries","seriesId":'"$ID"'}'
else
  ID=$(api /movie | jq -r --arg q "$Q" '[.[]|select(.title|ascii_downcase|contains($q|ascii_downcase))][0].id // empty')
  [[ -n "$ID" ]] || { echo "no movie matching '$Q'"; exit 1; }
  FILES=$(api "/moviefile?movieId=$ID" | jq -r '.[].path')
  RESCAN='{"name":"RescanMovie","movieId":'"$ID"'}'
fi

FF="docker exec jellyfin /usr/lib/jellyfin-ffmpeg/ffmpeg"
FP="docker exec jellyfin /usr/lib/jellyfin-ffmpeg/ffprobe"
converted=0 skipped=0 failed=0
while IFS= read -r path; do
  [[ -n "$path" && -f "$path" ]] || continue
  cpath="${path/\/data\/media//media}"
  info=$($FP -v quiet -show_entries stream=codec_type,codec_name,channels,profile -of json "$cpath")
  v=$(jq -r '[.streams[]|select(.codec_type=="video")][0].codec_name' <<<"$info")
  vprof=$(jq -r '[.streams[]|select(.codec_type=="video")][0].profile // ""' <<<"$info")
  a=$(jq -r '[.streams[]|select(.codec_type=="audio")][0].codec_name' <<<"$info")
  ach=$(jq -r '[.streams[]|select(.codec_type=="audio")][0].channels // 2' <<<"$info")
  ext="${path##*.}"
  if [[ "$v" != h264 || "$vprof" == *"10"* ]]; then
    echo "SKIP (video=$v $vprof — needs a re-grab, not a remux): ${path##*/}"
    skipped=$((skipped+1)); continue
  fi
  if [[ "$ext" == mp4 && ( "$a" == ac3 || ( "$a" == aac && "$ach" -le 2 ) ) ]]; then
    skipped=$((skipped+1)); continue
  fi
  base="${path%.*}"
  if ! ls "${base}".*srt >/dev/null 2>&1; then          # rescue embedded text subs → sidecar
    $FF -y -v error -i "$cpath" -map '0:s:0?' -c:s srt "${cpath%.*}.en.srt" 2>/dev/null || true
    [[ -s "${base}.en.srt" ]] || rm -f "${base}.en.srt"
  fi
  if $FF -y -v error -i "$cpath" -map 0:v:0 -map 0:a:0 -c:v copy -c:a ac3 -b:a 448k -sn -movflags +faststart "${cpath%.*}.ps3tmp.mp4"; then
    rm -f -- "$path"
    mv -- "${base}.ps3tmp.mp4" "${base}.mp4"
    echo "OK   ${path##*/} → .mp4 + AC3 5.1"
    converted=$((converted+1))
  else
    rm -f -- "${base}.ps3tmp.mp4"
    echo "FAIL ${path##*/} (original untouched)"
    failed=$((failed+1))
  fi
done <<< "$FILES"
echo "converted=$converted skipped=$skipped failed=$failed"
curl -sf -X POST -H "X-Api-Key: $KEY" -H 'Content-Type: application/json' \
  "http://localhost:$PORT/api/v3/command" -d "$RESCAN" >/dev/null && echo "$APP rescan triggered"
