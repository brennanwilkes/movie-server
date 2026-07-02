#!/usr/bin/env bash
# smoke-test.sh — fast, read-only health assertions for the whole stack (`make test`).
# Every check prints PASS/FAIL; exit code = number of failures. Run after any deploy,
# provision, or controller change — and FIRST when debugging "something is off".
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; source .env 2>/dev/null || true; set +a
NUC_IP=${NUC_IP:-192.168.1.74}
FAIL=0
chk() { # name  command...
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then printf '  \033[1;32mPASS\033[0m %s\n' "$name"
  else printf '  \033[1;31mFAIL\033[0m %s\n' "$name"; FAIL=$((FAIL+1)); fi
}
jqt() { curl -sf --max-time 8 "$1" | jq -e "$2"; }   # url  jq-assertion

echo "=== host ==="
chk "/data is a mountpoint (USB drive, not bare SSD dir)" mountpoint -q /data
chk "docker waits for /data (systemd drop-in)" test -f /etc/systemd/system/docker.service.d/wait-for-data.conf
chk "controller state.json parses" sh -c 'jq -e . /opt/appdata/controller/state.json'

echo "=== containers ==="
for c in jellyfin qbittorrent prowlarr radarr sonarr bazarr jellyseerr flaresolverr controller suggestarr; do
  chk "container $c running" sh -c "docker inspect -f '{{.State.Running}}' $c | grep -q true"
done

echo "=== controller API ==="
chk "/api/status answers" jqt "http://localhost:8088/api/status" 'type=="array"'
chk "/api/status: all services up" jqt "http://localhost:8088/api/status" 'all(.[]; .up)'
chk "/api/downloads snapshot built (ts>0)" jqt "http://localhost:8088/api/downloads" '.ts > 0'
chk "/api/disk sane" jqt "http://localhost:8088/api/disk" '.total_bytes > 1e12'
chk "/api/library (radarr) answers" jqt "http://localhost:8088/api/library?app=radarr" '.items | length > 0'

echo "=== *arr config (the grab algorithm) ==="
RKEY=$(sed -n 's:.*<ApiKey>\(.*\)</ApiKey>.*:\1:p' /opt/appdata/radarr/config.xml | head -1)
SKEY=$(sed -n 's:.*<ApiKey>\(.*\)</ApiKey>.*:\1:p' /opt/appdata/sonarr/config.xml | head -1)
for app in "radarr 7878 $RKEY" "sonarr 8989 $SKEY"; do
  set -- $app
  P=$(curl -sf --max-time 8 -H "X-Api-Key: $3" "http://localhost:$2/api/v3/qualityprofile")
  chk "$1: exactly the 3 tier profiles" jq -e '[.[].name]|sort == (["Beloved (best quality)","Low (save space)","Normal"]|sort)' <<<"$P"
  chk "$1: H.264 outranks HEVC in every tier (the 10-bit tie fix)" \
    jq -e 'all(.[]; ([.formatItems[]|select(.name=="H.264 (GPU)").score][0]) > ([.formatItems[]|select(.name=="HEVC 8-bit (GPU)").score][0]))' <<<"$P"
  chk "$1: 10-bit + HDR penalised in every tier" \
    jq -e 'all(.[]; ([.formatItems[]|select(.name=="10-bit (CPU)").score][0]) < 0 and ([.formatItems[]|select(.name=="HDR / Dolby Vision (CPU)").score][0]) < 0)' <<<"$P"
  chk "$1: 'Likely 10-bit group' format exists" \
    sh -c "curl -sf -H 'X-Api-Key: $3' http://localhost:$2/api/v3/customformat | jq -e 'any(.[]; .name==\"Likely 10-bit group (CPU)\")'"
  chk "$1: propers/repacks doNotPrefer" \
    sh -c "curl -sf -H 'X-Api-Key: $3' http://localhost:$2/api/v3/config/mediamanagement | jq -e '.downloadPropersAndRepacks==\"doNotPrefer\"'"
done

echo "=== prowlarr indexers ==="
PKEY=$(sed -n 's:.*<ApiKey>\(.*\)</ApiKey>.*:\1:p' /opt/appdata/prowlarr/config.xml | head -1)
chk "≥4 enabled indexers" sh -c "curl -sf -H 'X-Api-Key: $PKEY' http://localhost:9696/api/v1/indexer | jq -e '[.[]|select(.enable)]|length >= 4'"

echo "=== qBittorrent ==="
QC=$(curl -si --max-time 8 http://localhost:8080/api/v2/auth/login -d "username=${QBIT_USER:-brennan}&password=${QBIT_PASS:-brennan}" | sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*\).*/\1/p' | head -1)
chk "login works (v5 cookie)" test -n "$QC"
chk "share limits set (seeding actually ends)" sh -c "curl -sf -b '$QC' http://localhost:8080/api/v2/app/preferences | jq -e '.max_ratio_enabled and .max_seeding_time_enabled'"
chk "no errored torrents" sh -c "curl -sf -b '$QC' http://localhost:8080/api/v2/torrents/info | jq -e '[.[]|select(.state==\"error\")]|length == 0'"

echo "=== jellyfin ==="
chk "answers on ${NUC_IP}:8096 (host-net; localhost will NOT answer)" curl -sf --max-time 8 "http://${NUC_IP}:8096/System/Info/Public"
JFKEY=$(grep -oP '^JELLYFIN_KEY=\K.*' /opt/appdata/controller/keys.env 2>/dev/null || true)
if [[ -n "$JFKEY" ]]; then
  chk "QSV hardware transcoding on" sh -c "curl -sf -H 'X-Emby-Token: $JFKEY' http://${NUC_IP}:8096/System/Configuration/encoding | jq -e '.HardwareAccelerationType==\"qsv\"'"
  chk "DLNA plugin active" sh -c "curl -sf -H 'X-Emby-Token: $JFKEY' http://${NUC_IP}:8096/Plugins | jq -e 'any(.[]; .Name==\"DLNA\" and .Status==\"Active\")'"
fi
chk "custom PS3 DLNA profile installed" test -f "${CONFIG:-/opt/appdata}/jellyfin/data/plugins/configurations/dlna/user/Sony PlayStation 3.xml"
if [[ -n "$JFKEY" ]]; then
  chk "Playback Reporting plugin active" sh -c "curl -sf -H 'X-Emby-Token: $JFKEY' http://${NUC_IP}:8096/Plugins | jq -e 'any(.[]; .Name==\"Playback Reporting\" and .Status==\"Active\")'"
  chk "Home Screen Sections + File Transformation active" sh -c "curl -sf -H 'X-Emby-Token: $JFKEY' http://${NUC_IP}:8096/Plugins | jq -e '[.[]|select(.Name==\"Home Screen Sections\" or .Name==\"File Transformation\")|select(.Status==\"Active\")]|length == 2'"
  chk "HSS home layout configured (13+ rows declared)" sh -c "PID=\$(curl -sf -H 'X-Emby-Token: $JFKEY' http://${NUC_IP}:8096/Plugins | jq -r '.[]|select(.Name==\"Home Screen Sections\").Id'); curl -sf -H 'X-Emby-Token: $JFKEY' http://${NUC_IP}:8096/Plugins/\$PID/Configuration | jq -e '.SectionSettings|length >= 13'"
fi

echo "=== jellyseerr ==="
SEERRKEY=$(jq -r '.main.apiKey' "${CONFIG:-/opt/appdata}/jellyseerr/settings.json" 2>/dev/null || true)
if [[ -n "$SEERRKEY" ]]; then
  chk "custom discovery sliders present + enabled" sh -c "curl -sf -H 'X-Api-Key: $SEERRKEY' http://localhost:5055/api/v1/settings/discover | jq -e '[.[]|select(.isBuiltIn|not)] | length >= 4 and all(.[]; .enabled)'"
  chk "'suggestarr' request-only user exists (approval gate)" sh -c "curl -sf -H 'X-Api-Key: $SEERRKEY' 'http://localhost:5055/api/v1/user?take=200' | jq -e '.results[]|select((.username // .displayName // .email)|test(\"suggestarr\";\"i\"))'"
fi

echo
if [[ $FAIL -eq 0 ]]; then echo "ALL PASS"; else echo "$FAIL FAILURE(S) — see above"; fi
exit "$FAIL"
