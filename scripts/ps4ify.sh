#!/usr/bin/env bash
# ps4ify.sh — make a title's files PS4-friendly (direct-play, no transcoding involved):
# MP4 container, H.264 video (stream-copied, quality untouched), AC3 5.1 audio.
# Fixes the "video plays but no audio" class — the PS4 media player cannot decode EAC3/DDP, DTS, Opus,
# or multichannel AAC — and the no-MKV rule, in one cheap pass (audio-only re-encode).
#
#   ./scripts/ps4ify.sh "Mormon Wives"              # every episode file of a series
#   ./scripts/ps4ify.sh --radarr "Pulp Fiction"     # a movie
#   make ps4ify q="Mormon Wives"
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
Q="${1:?usage: ps4ify.sh [--radarr|--sonarr] \"Title\"}"
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
  compat=$(jq -r '[.streams[]|select(.codec_type=="audio")|select(.codec_name=="ac3" or (.codec_name=="aac" and (.channels // 6) <= 2))]|length' <<<"$info")
  ext="${path##*.}"
  if [[ "$v" != h264 || "$vprof" == *"10"* ]]; then
    echo "SKIP (video=$v $vprof — needs a re-grab, not a remux): ${path##*/}"
    skipped=$((skipped+1)); continue
  fi
  if [[ "$compat" -gt 0 ]]; then
    skipped=$((skipped+1)); continue
  fi

  base="${path%.*}"
  # ADDITIVE, quality-preserving: keep every original stream and PREPEND an AC3 5.1 compat
  # track (flagged default). Capable clients keep the original DDP/TrueHD/DTS; the PS4 gets
  # AC3. Container unchanged (PS4 plays MKV). +448kbps ≈ +200MB/h.
  maps=(-map 0:v:0 -map 0:a:0 -map 0:a)
  subs=(-sn); [[ "$ext" == mkv ]] && subs=(-map '0:s?' -c:s copy)
  fast=(); [[ "$ext" == mp4 ]] && fast=(-movflags +faststart)
  if $FF -y -v error -i "$cpath" "${maps[@]}" "${subs[@]}" -c copy \
      -c:a:0 ac3 -b:a:0 448k -disposition:a:0 default "${fast[@]}" "${cpath%.*}.ps4tmp.${ext}"; then
    mv -- "${base}.ps4tmp.${ext}" "$path"
    echo "OK   ${path##*/} → +AC3 5.1 compat track (original audio kept)"
    converted=$((converted+1))
  else
    rm -f -- "${base}.ps4tmp.${ext}"
    echo "FAIL ${path##*/} (original untouched)"
    failed=$((failed+1))
  fi
done <<< "$FILES"
echo "converted=$converted skipped=$skipped failed=$failed"
curl -sf -X POST -H "X-Api-Key: $KEY" -H 'Content-Type: application/json' \
  "http://localhost:$PORT/api/v3/command" -d "$RESCAN" >/dev/null && echo "$APP rescan triggered"
