#!/usr/bin/env bash
# why-playback.sh "Title" — answer "why isn't this playing (well) on the PS3 / projector?"
# Looks the movie up in Radarr, reads the file's ffprobe mediaInfo, and prints a verdict
# per playback path (PS3 DLNA direct-play, PS3 via transcode, browser/Fire Stick).
# Read-only. Movies only (TV: use `./scripts/search-releases.sh --sonarr` + ffprobe by hand).
#
#   ./scripts/why-playback.sh "Pulp Fiction"
#   make why q="Pulp Fiction"
set -euo pipefail
cd "$(dirname "$0")/.."

[[ $# -ge 1 && -n "$1" ]] || { echo "usage: $0 \"Title\""; exit 1; }
Q="$1"
KEY=$(sed -n 's:.*<ApiKey>\(.*\)</ApiKey>.*:\1:p' /opt/appdata/radarr/config.xml | head -1)
[[ -n "$KEY" ]] || { echo "no Radarr API key found"; exit 1; }

MOVIE=$(curl -sf -H "X-Api-Key: $KEY" http://localhost:7878/api/v3/movie \
  | jq --arg q "$Q" '[.[]|select(.title|ascii_downcase|contains($q|ascii_downcase))][0] // empty')
[[ -n "$MOVIE" ]] || { echo "no Radarr movie matching \"$Q\""; exit 1; }

TITLE=$(jq -r '"\(.title) (\(.year))"' <<<"$MOVIE")
HASFILE=$(jq -r '.hasFile' <<<"$MOVIE")
echo "=== $TITLE ==="
if [[ "$HASFILE" != "true" ]]; then
  echo "No file on disk — nothing to play. Check: ./scripts/show-history.sh --missing"
  exit 0
fi

MI=$(jq '.movieFile.mediaInfo // empty' <<<"$MOVIE")
REL=$(jq -r '.movieFile.relativePath // "?"' <<<"$MOVIE")
EXT="${REL##*.}"
if [[ -z "$MI" ]]; then echo "file: $REL — Radarr hasn't analysed it yet (mediaInfo empty); retry in a minute"; exit 0; fi

VCODEC=$(jq -r '.videoCodec // "?"' <<<"$MI"); DEPTH=$(jq -r '.videoBitDepth // 8' <<<"$MI")
DR=$(jq -r '.videoDynamicRangeType // .videoDynamicRange // ""' <<<"$MI")
ACODEC=$(jq -r '.audioCodec // "?"' <<<"$MI"); ACH=$(jq -r '.audioChannels // 2' <<<"$MI")
ACHI=${ACH%%.*}; [[ "$ACH" == *.* ]] && ACHI=$((ACHI+1))   # "5.1" → 6 discrete channels
RES=$(jq -r '.resolution // "?"' <<<"$MI")
echo "file:  $REL"
echo "video: $VCODEC ${DEPTH}bit ${DR:+$DR }$RES   audio: $ACODEC ${ACH}ch   container: $EXT"
echo

# Normalise
v=$(tr '[:upper:]' '[:lower:]' <<<"$VCODEC"); a=$(tr '[:upper:]' '[:lower:]' <<<"$ACODEC")
is_h264=false; case "$v" in *x264*|*h264*|*avc*) is_h264=true;; esac
is_hevc=false; case "$v" in *x265*|*h265*|*hevc*) is_hevc=true;; esac
is_hdr=false;  [[ -n "$DR" && "$DR" != "SDR" ]] && is_hdr=true

# --- PS3 direct-play (custom DLNA profile: mp4/ts + h264<=L4.1 8bit + aac<=2ch|ac3) ---
echo "— PS3 direct-play:"
if $is_h264 && [[ "$DEPTH" -le 8 && "$EXT" =~ ^(mp4|m4v|ts)$ ]] && { [[ "$a" == *ac3* ]] || { [[ "$a" == *aac* && "$ACHI" -le 2 ]]; }; }; then
  echo "   YES — should play untouched."
else
  why=()
  [[ "$EXT" =~ ^(mp4|m4v|ts)$ ]] || why+=("container $EXT (PS3 only mp4/ts)")
  $is_h264 || why+=("video $VCODEC (PS3 only H.264 8-bit)")
  [[ "$DEPTH" -le 8 ]] || why+=("${DEPTH}-bit (PS3 is 8-bit only)")
  { [[ "$a" == *ac3* ]] || { [[ "$a" == *aac* && "$ACHI" -le 2 ]]; }; } || why+=("audio $ACODEC ${ACH}ch (PS3: AC3 or stereo AAC — 5.1 AAC = silent audio)")
  reasons=$(printf '%s; ' "${why[@]}"); reasons=${reasons%; }
  echo "   NO — ${reasons} → Jellyfin transcodes/remuxes."
fi

# --- Transcode feasibility on the i5-6260U (Skylake QSV: h264 + 8-bit hevc only) ---
echo "— Transcode on this NUC (Skylake QSV):"
if $is_hdr; then
  echo "   HDR source + tone-mapping is OFF → transcoded picture will look washed-out grey."
fi
if { $is_h264 || $is_hevc; } && [[ "$DEPTH" -le 8 ]]; then
  echo "   OK — hardware decode + H.264 encode; smooth unless the NUC is busy (check: curl -s localhost:8088/api/system)."
elif [[ "$DEPTH" -ge 10 ]]; then
  echo "   RISKY — ${DEPTH}-bit $VCODEC has NO hardware decode here → CPU decode on 2c/4t; real-time transcode may stutter/buffer."
  echo "   Fix: redownload as H.264 (dashboard Library → redownload), or wait — gpuVerify auto-swaps files imported <48h ago."
else
  echo "   RISKY — $VCODEC decodes on CPU here (no QSV path)."
fi

# --- Live sessions: is Jellyfin transcoding it right now, and why? ---
JFKEY=$(grep -oP '^JELLYFIN_KEY=\K.*' /opt/appdata/controller/keys.env 2>/dev/null || true)
NUC_IP=$(grep -oP '^NUC_IP=\K.*' .env 2>/dev/null || echo 192.168.1.74)
if [[ -n "$JFKEY" ]]; then
  echo "— Active Jellyfin sessions:"
  curl -sf "http://${NUC_IP}:8096/Sessions" -H "X-Emby-Token: $JFKEY" \
    | jq -r '.[] | select(.NowPlayingItem != null)
        | "   \(.DeviceName): \(.NowPlayingItem.Name) — \(.PlayState.PlayMethod // "?")\(if .TranscodingInfo then " (\(.TranscodingInfo.TranscodeReasons // [] | join(", ")))" else "" end)"' \
    | grep . || echo "   (none playing right now)"
fi
