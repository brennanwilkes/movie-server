#!/usr/bin/env bash
# ps3ify-sweep.sh — AUTOMATIC post-import PS3 normalization (runs via ps3fix.timer, host-side).
#
# WHY THIS EXISTS: the best sources (WEB-DLs) almost universally ship EAC3/DDP 5.1 audio in
# MKV — and the PS3 can decode neither (it does AC3, stereo AAC, MP3, LPCM; no MKV). Penalizing
# DDP at grab time would push selection toward WORSE releases, so instead we grab the best
# release and normalize the FILE after import: video stream-copied (quality untouched),
# audio → AC3 5.1, container → mp4. Result: PS3 direct-play, no transcoding, no quality loss.
#
# Scope: files imported in the last 48h (both *arrs, via import history), video already
# h264 8-bit (10-bit/HEVC files are gpuVerifySweep's job — remuxing can't fix video), max 4
# conversions per run. Skips entirely while Movie Mode is on. Manual per-title version:
# `make ps3ify q="Title"`.
set -euo pipefail
cd "$(dirname "$0")/.."

# Movie Mode = someone is watching; don't compete for the disk.
[[ "$(curl -sf --max-time 5 http://localhost:8088/api/downloads 2>/dev/null | jq -r '.masterPaused' 2>/dev/null)" == "true" ]] && exit 0

FF="docker exec jellyfin /usr/lib/jellyfin-ffmpeg/ffmpeg"
FP="docker exec jellyfin /usr/lib/jellyfin-ffmpeg/ffprobe"
LIMIT=4
converted=0
CUTOFF=$(date -u -d '48 hours ago' +%Y-%m-%dT%H:%M:%SZ)

convert() {  # host-path -> 0 converted / 1 skipped
  local path="$1" cpath base info v vprof a ach ext
  cpath="${path/\/data\/media//media}"
  ext="${path##*.}"
  base="${path%.*}"
  [[ -f "$path" ]] || { [[ -f "${base}.mp4" ]] && return 1; return 1; }   # gone or already swapped
  info=$($FP -v quiet -show_entries stream=codec_type,codec_name,channels,profile -of json "$cpath" 2>/dev/null) || return 1
  v=$(jq -r '[.streams[]|select(.codec_type=="video")][0].codec_name' <<<"$info")
  vprof=$(jq -r '[.streams[]|select(.codec_type=="video")][0].profile // ""' <<<"$info")
  a=$(jq -r '[.streams[]|select(.codec_type=="audio")][0].codec_name' <<<"$info")
  ach=$(jq -r '[.streams[]|select(.codec_type=="audio")][0].channels // 2' <<<"$info")
  [[ "$v" == h264 && "$vprof" != *10* ]] || return 1                       # video not remux-fixable
  [[ "$ext" == mp4 && ( "$a" == ac3 || ( "$a" == aac && "$ach" -le 2 ) ) ]] && return 1   # already native
  if ! ls "${base}".*srt >/dev/null 2>&1; then                             # rescue embedded subs
    $FF -y -v error -i "$cpath" -map '0:s:0?' -c:s srt "${cpath%.*}.en.srt" 2>/dev/null || true
    [[ -s "${base}.en.srt" ]] || rm -f "${base}.en.srt"
  fi
  if $FF -y -v error -i "$cpath" -map 0:v:0 -map 0:a:0 -c:v copy -c:a ac3 -b:a 448k -sn -movflags +faststart "${cpath%.*}.ps3tmp.mp4"; then
    rm -f -- "$path"
    mv -- "${base}.ps3tmp.mp4" "${base}.mp4"
    echo "ps3fix: ${path##*/} → mp4 + AC3"
    return 0
  fi
  rm -f -- "${base}.ps3tmp.mp4"
  return 1
}

for APP in radarr sonarr; do
  PORT=7878; [[ $APP == sonarr ]] && PORT=8989
  KEY=$(sed -n 's:.*<ApiKey>\(.*\)</ApiKey>.*:\1:p' "/opt/appdata/$APP/config.xml" | head -1)
  [[ -n "$KEY" ]] || continue
  rescan_ids=""
  while IFS=$'\t' read -r date path id; do
    [[ -n "$path" && "$date" > "$CUTOFF" ]] || continue
    (( converted >= LIMIT )) && break
    if convert "$path"; then converted=$((converted+1)); rescan_ids="$rescan_ids $id"; fi
  done < <(curl -sf -H "X-Api-Key: $KEY" \
      "http://localhost:$PORT/api/v3/history?pageSize=150&sortKey=date&sortDirection=descending" \
    | jq -r '.records[] | select((.eventType|ascii_downcase)|contains("import"))
        | [.date, (.data.importedPath // ""), (.movieId // .seriesId // 0)] | @tsv')
  for id in $(echo "$rescan_ids" | tr ' ' '\n' | sort -u); do
    [[ -n "$id" && "$id" != 0 ]] || continue
    if [[ $APP == radarr ]]; then body="{\"name\":\"RescanMovie\",\"movieId\":$id}"; else body="{\"name\":\"RescanSeries\",\"seriesId\":$id}"; fi
    curl -sf -o /dev/null -X POST -H "X-Api-Key: $KEY" -H 'Content-Type: application/json' "http://localhost:$PORT/api/v3/command" -d "$body" || true
  done
done
(( converted > 0 )) && echo "ps3fix: $converted file(s) normalized" || true
