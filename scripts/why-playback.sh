#!/usr/bin/env bash
# why-playback.sh "Title" — answer "why isn't this playing (well) on the PS4 / projector?"
# Reads the library item from Radarr or Sonarr, inspects the first available mediaInfo,
# and prints a verdict per playback path.
#
#   ./scripts/why-playback.sh "Pulp Fiction"
#   ./scripts/why-playback.sh --sonarr "Planet Earth"
#   make why q="Planet Earth" s=sonarr
set -euo pipefail
cd "$(dirname "$0")/.."

[[ $# -ge 1 ]] || { echo "usage: $0 [--radarr|--sonarr] \"Title\"" >&2; exit 1; }

APP=radarr
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --sonarr) APP=sonarr ;;
    --radarr) APP=radarr ;;
    *) ARGS+=("$arg") ;;
  esac
done

Q="${ARGS[*]}"
[[ -n "$Q" ]] || { echo "usage: $0 [--radarr|--sonarr] \"Title\"" >&2; exit 1; }

api_key() {
  local app="$1"
  local file="/opt/appdata/${app}/config.xml"
  sed -n 's:.*<ApiKey>\(.*\)</ApiKey>.*:\1:p' "$file" | head -1
}

find_match() {
  local app="$1" port path key data
  case "$app" in
    radarr) port=7878; path=movie ;;
    sonarr) port=8989; path=series ;;
    *) return 1 ;;
  esac
  key=$(api_key "$app")
  [[ -n "$key" ]] || { echo "no ${app^} API key found" >&2; return 1; }
  data=$(curl -sf -H "X-Api-Key: $key" "http://localhost:${port}/api/v3/${path}") || return 1
  jq --arg q "$Q" '[.[] | select((.title // "") | ascii_downcase | contains($q | ascii_downcase))][0] // empty' <<<"$data"
}

analyze_media() {
  local rel="$1" mi="$2"
  local ext="${rel##*.}"
  local vcodec vdepth dr acodec ach achi res v a is_h264=false is_hevc=false is_hdr=false

  vcodec=$(jq -r '.videoCodec // "?"' <<<"$mi")
  vdepth=$(jq -r '.videoBitDepth // 8' <<<"$mi")
  dr=$(jq -r '.videoDynamicRangeType // .videoDynamicRange // ""' <<<"$mi")
  acodec=$(jq -r '.audioCodec // "?"' <<<"$mi")
  ach=$(jq -r '.audioChannels // 2' <<<"$mi")
  achi=${ach%%.*}; [[ "$ach" == *.* ]] && achi=$((achi+1))
  res=$(jq -r '.resolution // "?"' <<<"$mi")

  echo "file:  $rel"
  echo "video: $vcodec ${vdepth}bit ${dr:+$dr }$res   audio: $acodec ${ach}ch   container: $ext"
  echo

  v=$(tr '[:upper:]' '[:lower:]' <<<"$vcodec")
  a=$(tr '[:upper:]' '[:lower:]' <<<"$acodec")
  case "$v" in *x264*|*h264*|*avc*) is_h264=true;; esac
  case "$v" in *x265*|*h265*|*hevc*) is_hevc=true;; esac
  [[ -n "$dr" && "$dr" != "SDR" ]] && is_hdr=true

  echo "— PS4 direct-play:"
  if $is_h264 && [[ "$vdepth" -le 8 && "$ext" =~ ^(mp4|m4v|ts|mkv)$ ]] && { [[ "$a" == *ac3* && "$a" != *eac3* && "$a" != *e-ac* ]] || { [[ "$a" == *aac* && "$achi" -le 6 ]]; }; }; then
    echo "   YES — should play untouched."
  else
    why=()
    [[ "$ext" =~ ^(mp4|m4v|ts|mkv)$ ]] || why+=("container $ext (PS4: mkv/mp4/ts)")
    $is_h264 || why+=("video $vcodec (PS4 media player is H.264-only — no HEVC)")
    [[ "$vdepth" -le 8 ]] || why+=("${vdepth}-bit (PS4 is 8-bit only)")
    { [[ "$a" == *ac3* && "$a" != *eac3* && "$a" != *e-ac* ]] || { [[ "$a" == *aac* && "$achi" -le 6 ]]; }; } || why+=("audio $acodec ${ach}ch (PS4: AAC or AC3 only — EAC3/DDP, DTS, TrueHD = silent audio; fix: make ps4ify q=\"Title\")")
    reasons=$(printf '%s; ' "${why[@]}")
    reasons=${reasons%; }
    echo "   NO — ${reasons} → Jellyfin transcodes/remuxes."
  fi

  echo "— Transcode on this NUC (Skylake QSV):"
  if $is_hdr; then
    echo "   HDR source + tone-mapping is OFF → transcoded picture will look washed-out grey."
  fi
  if { $is_h264 || $is_hevc; } && [[ "$vdepth" -le 8 ]]; then
    echo "   OK — hardware decode + H.264 encode; smooth unless the NUC is busy (check: curl -s localhost:8088/api/system)."
  elif [[ "$vdepth" -ge 10 ]]; then
    echo "   RISKY — ${vdepth}-bit $vcodec has NO hardware decode here → CPU decode on 2c/4t; real-time transcode may stutter/buffer."
    echo "   Fix: redownload as H.264 (dashboard Library → redownload), or wait — gpuVerify auto-swaps files imported <48h ago."
  else
    echo "   RISKY — $vcodec decodes on CPU here (no QSV path)."
  fi
}

ITEM=$(find_match "$APP")
if [[ -z "$ITEM" && "$APP" == "radarr" ]]; then
  ITEM=$(find_match sonarr)
  APP=sonarr
fi
[[ -n "$ITEM" ]] || { echo "no ${APP^} title matching \"$Q\"" >&2; exit 1; }

TITLE=$(jq -r '"\(.title) (\(.year // "?"))"' <<<"$ITEM")
echo "=== $TITLE ==="

if [[ "$APP" == "radarr" ]]; then
  HASFILE=$(jq -r '.hasFile' <<<"$ITEM")
  if [[ "$HASFILE" != "true" ]]; then
    echo "No file on disk — nothing to play. Check: ./scripts/show-history.sh --missing"
    exit 0
  fi
  MI=$(jq '.movieFile.mediaInfo // empty' <<<"$ITEM")
  REL=$(jq -r '.movieFile.relativePath // "?"' <<<"$ITEM")
  if [[ -z "$MI" ]]; then
    echo "file: $REL — Radarr hasn't analysed it yet (mediaInfo empty); retry in a minute"
    exit 0
  fi
  analyze_media "$REL" "$MI"
else
  HASFILE=$(jq -r '((.statistics.episodeFileCount // 0) > 0)' <<<"$ITEM")
  if [[ "$HASFILE" != "true" ]]; then
    echo "No file on disk — nothing to play. Check: ./scripts/show-history.sh --missing"
    exit 0
  fi
  KEY=$(api_key sonarr)
  FILE=$(curl -sf -H "X-Api-Key: $KEY" "http://localhost:8989/api/v3/episodefile?seriesId=$(jq -r '.id' <<<"$ITEM")" \
    | jq 'map(select(.mediaInfo != null))[0] // empty')
  if [[ -z "$FILE" ]]; then
    echo "Series has files, but Sonarr hasn't analysed one yet (mediaInfo empty); retry in a minute"
    exit 0
  fi
  REL=$(jq -r '.relativePath // .path // "?"' <<<"$FILE")
  MI=$(jq '.mediaInfo // empty' <<<"$FILE")
  if [[ -z "$MI" ]]; then
    echo "file: $REL — Sonarr hasn't analysed it yet (mediaInfo empty); retry in a minute"
    exit 0
  fi
  echo "TV series detected — diagnosing the first available episode file."
  analyze_media "$REL" "$MI"
fi

# Live sessions: is Jellyfin transcoding it right now, and why?
JFKEY=$(grep -oP '^JELLYFIN_KEY=\K.*' /opt/appdata/controller/keys.env 2>/dev/null || true)
NUC_IP=$(grep -oP '^NUC_IP=\K.*' .env 2>/dev/null || echo 192.168.1.74)
if [[ -n "$JFKEY" ]]; then
  echo "— Active Jellyfin sessions:"
  curl -sf "http://${NUC_IP}:8096/Sessions" -H "X-Emby-Token: $JFKEY" \
    | jq -r '.[] | select(.NowPlayingItem != null)
        | "   \(.DeviceName): \(.NowPlayingItem.Name) — \(.PlayState.PlayMethod // "?")\(if .TranscodingInfo then " (\(.TranscodingInfo.TranscodeReasons // [] | join(", ")))" else "" end)"' \
    | grep . || echo "   (none playing right now)"
fi
