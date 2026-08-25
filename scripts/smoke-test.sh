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

echo "=== jobs tab (background work) ==="
chk "/api/jobs answers with a full roster" jqt "http://localhost:8088/api/jobs" '.jobs | length >= 25'
# All three runtimes must be present. Losing one is silent otherwise: the tab just shows fewer
# cards, which looks like "nothing to report" rather than "a whole source stopped reporting".
chk "jobs: controller sweeps reporting" jqt "http://localhost:8088/api/jobs" '[.jobs[]|select(.source=="controller")] | length >= 20'
chk "jobs: jellyfin scheduled tasks reporting" jqt "http://localhost:8088/api/jobs" '[.jobs[]|select(.source=="jellyfin")] | length >= 5'
chk "jobs: host systemd timers reporting (ps4fix)" jqt "http://localhost:8088/api/jobs" 'any(.jobs[]; .id=="host:ps4ify")'
# A host job that stopped firing must read as an ERROR, not a permanently healthy "idle".
chk "jobs: no host job has gone silent" jqt "http://localhost:8088/api/jobs" '[.jobs[]|select(.source=="host" and .state=="error")] | length == 0'
# Every card must carry its plain-language description and a state the UI knows how to render.
chk "jobs: every job has a description" jqt "http://localhost:8088/api/jobs" 'all(.jobs[]; (.what|length) > 0)'
chk "jobs: every state is renderable" jqt "http://localhost:8088/api/jobs" 'all(.jobs[]; .state | IN("running","waiting","paused","idle","error","never","off"))'
chk "jobs: heaviest-first ordering holds" jqt "http://localhost:8088/api/jobs" '[.jobs[].weight] | . == (sort | reverse)'

echo "=== auto Movie Mode ==="
chk "/api/movie-mode answers" jqt "http://localhost:8088/api/movie-mode" 'has("manual") and has("auto")'
# THE POLL is what arms Movie Mode (since 2026-08-12), so assert THAT first — it is the only path
# whose failure is silent. poll.ok goes false when Jellyfin cannot be reached, which is the one way
# the latch can now go blind.
chk "Movie Mode session poll is healthy" jqt "http://localhost:8088/api/movie-mode" '.poll.ok == true'
# The webhook plugin was load-bearing until 2026-08-12 and is NOT any more: its playback notifiers
# silently stopped firing on this box (IEventConsumer registrations; its scheduled-task notifiers
# still run), and auto Movie Mode did nothing for three nights of films while every config below
# remained correct. The controller now polls /Sessions as the source of truth and the webhook only
# accelerates arming. These checks therefore verify an OPTIMISATION, not the delivery path — a
# failure here costs sub-second arming, not the feature.
# Read the key here rather than relying on the jellyfin section's JFKEY — that is defined further
# down the file, so using it above would silently skip every check in this block.
JFKEY="${JFKEY:-$(grep -oP '^JELLYFIN_KEY=\K.*' /opt/appdata/controller/keys.env 2>/dev/null || true)}"
if [[ -n "${JFKEY:-}" ]]; then
  chk "jellyfin: Webhook plugin active" sh -c "curl -sf -H 'X-Emby-Token: $JFKEY' http://localhost:8096/Plugins | jq -e 'any(.[]; .Name==\"Webhook\" and .Status==\"Active\")'"
  chk "jellyfin: exactly one webhook destination, pointed at the controller" sh -c "ID=\$(curl -sf -H 'X-Emby-Token: $JFKEY' http://localhost:8096/Plugins | jq -r '.[]|select(.Name==\"Webhook\").Id'); curl -sf -H \"X-Emby-Token: $JFKEY\" \"http://localhost:8096/Plugins/\$ID/Configuration\" | jq -e '(.GenericOptions|length)==1 and (.GenericOptions[0].WebhookUri|test(\"/api/jellyfin-webhook\")) and .GenericOptions[0].EnableWebhook'"
  # PlaybackProgress is the safety net, not a nicety: without it a dropped PlaybackStop pins Movie
  # Mode on forever and every background job on this box stops with no error anywhere.
  chk "jellyfin: webhook sends Start, Stop AND Progress" sh -c "ID=\$(curl -sf -H 'X-Emby-Token: $JFKEY' http://localhost:8096/Plugins | jq -r '.[]|select(.Name==\"Webhook\").Id'); curl -sf -H \"X-Emby-Token: $JFKEY\" \"http://localhost:8096/Plugins/\$ID/Configuration\" | jq -e '.GenericOptions[0].NotificationTypes | (index(\"PlaybackStart\") and index(\"PlaybackStop\") and index(\"PlaybackProgress\"))'"
fi

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
chk "PS4 DLNA profile installed" test -f "${CONFIG:-/opt/appdata}/jellyfin/data/plugins/configurations/dlna/user/Sony PlayStation 4.xml"
if [[ -n "$JFKEY" ]]; then
  chk "Playback Reporting plugin active" sh -c "curl -sf -H 'X-Emby-Token: $JFKEY' http://${NUC_IP}:8096/Plugins | jq -e 'any(.[]; .Name==\"Playback Reporting\" and .Status==\"Active\")'"
  chk "Home Screen Sections + File Transformation active" sh -c "curl -sf -H 'X-Emby-Token: $JFKEY' http://${NUC_IP}:8096/Plugins | jq -e '[.[]|select(.Name==\"Home Screen Sections\" or .Name==\"File Transformation\")|select(.Status==\"Active\")]|length == 2'"
  chk "HSS home layout configured (13+ rows declared)" sh -c "PID=\$(curl -sf -H 'X-Emby-Token: $JFKEY' http://${NUC_IP}:8096/Plugins | jq -r '.[]|select(.Name==\"Home Screen Sections\").Id'); curl -sf -H 'X-Emby-Token: $JFKEY' http://${NUC_IP}:8096/Plugins/\$PID/Configuration | jq -e '.SectionSettings|length >= 13'"
  chk "Watchlist playlist stays retired (not recreated by provision)" sh -c "curl -sf -H 'X-Emby-Token: $JFKEY' 'http://${NUC_IP}:8096/Items?IncludeItemTypes=Playlist&Recursive=true' | jq -e '[.Items[]|select(.Name==\"Watchlist\")]|length == 0'"
fi

# Second household account. Skipped when JELLYFIN_USER_2 is unset.
if [[ -n "${JELLYFIN_USER_2:-}" && -n "$JFKEY" ]]; then
  echo "=== jellyfin: $JELLYFIN_USER_2 ==="
  chk "'$JELLYFIN_USER_2' can authenticate" sh -c "curl -sf --max-time 8 -X POST 'http://${NUC_IP}:8096/Users/AuthenticateByName' -H 'Content-Type: application/json' -H 'X-Emby-Authorization: MediaBrowser Client=\"smoke\", Device=\"smoke\", DeviceId=\"smoke\", Version=\"1\"' -d '{\"Username\":\"${JELLYFIN_USER_2}\",\"Pw\":\"${JELLYFIN_PASS_2:-}\"}' | jq -e '.AccessToken'"
  # Policy: non-admin, cannot delete media or edit collections, and hides the tiny franchise
  # collections exactly like brennan's steady state.
  chk "'$JELLYFIN_USER_2' policy locked down (no admin/delete/collections, hidden-collection blocked)" sh -c "curl -sf -H 'X-Emby-Token: $JFKEY' http://${NUC_IP}:8096/Users | jq -e --arg n '$JELLYFIN_USER_2' '.[]|select(.Name==\$n).Policy | (.IsAdministrator|not) and (.EnableContentDeletion|not) and (.EnableCollectionManagement|not) and (.BlockedTags|index(\"hidden-collection\") != null)'"
  chk "'$JELLYFIN_USER_2' can play media" sh -c "curl -sf -H 'X-Emby-Token: $JFKEY' http://${NUC_IP}:8096/Users | jq -e --arg n '$JELLYFIN_USER_2' '.[]|select(.Name==\$n).Policy | .EnableMediaPlayback and .EnableAllFolders'"
  chk "Top 100 shared read-only with '$JELLYFIN_USER_2'" sh -c "TID=\$(curl -sf -H 'X-Emby-Token: $JFKEY' 'http://${NUC_IP}:8096/Items?IncludeItemTypes=Playlist&Recursive=true' | jq -r '.Items[]|select(.Name==\"Top 100\").Id'); UID=\$(curl -sf -H 'X-Emby-Token: $JFKEY' http://${NUC_IP}:8096/Users | jq -r --arg n '$JELLYFIN_USER_2' '.[]|select(.Name==\$n).Id'); curl -sf -H 'X-Emby-Token: $JFKEY' \"http://${NUC_IP}:8096/Playlists/\$TID/Users\" | jq -e --arg u \"\$UID\" 'any(.[]; .UserId==\$u and (.CanEdit|not))'"
fi

echo "=== jellyseerr ==="
SEERRKEY=$(jq -r '.main.apiKey' "${CONFIG:-/opt/appdata}/jellyseerr/settings.json" 2>/dev/null || true)
if [[ -n "$SEERRKEY" ]]; then
  chk "custom discovery sliders present + enabled" sh -c "curl -sf -H 'X-Api-Key: $SEERRKEY' http://localhost:5055/api/v1/settings/discover | jq -e '[.[]|select(.isBuiltIn|not)] | length >= 4 and all(.[]; .enabled)'"
  chk "'suggestarr' request-only user exists (approval gate)" sh -c "curl -sf -H 'X-Api-Key: $SEERRKEY' 'http://localhost:5055/api/v1/user?take=200' | jq -e '.results[]|select((.username // .displayName // .email)|test(\"suggestarr\";\"i\"))'"
  if [[ -n "${JELLYFIN_USER_2:-}" ]]; then
    # 9120 = REQUEST|REQUEST_ADVANCED|AUTO_APPROVE|AUTO_APPROVE_MOVIE|AUTO_APPROVE_TV. Anything
    # less and her requests land in Pending instead of going straight through.
    chk "'$JELLYFIN_USER_2' imported with auto-approve (permissions 9120)" sh -c "curl -sf -H 'X-Api-Key: $SEERRKEY' 'http://localhost:5055/api/v1/user?take=200' | jq -e --arg n '$JELLYFIN_USER_2' 'any(.results[]; ((.jellyfinUsername // .username // .displayName)==\$n) and .permissions==9120)'"
    # A quota rejects a request BEFORE auto-approve runs, so unlimited is load-bearing here.
    chk "'$JELLYFIN_USER_2' has unlimited request quotas" sh -c "UID=\$(curl -sf -H 'X-Api-Key: $SEERRKEY' 'http://localhost:5055/api/v1/user?take=200' | jq -r --arg n '$JELLYFIN_USER_2' '.results[]|select((.jellyfinUsername // .username // .displayName)==\$n).id'); curl -sf -H 'X-Api-Key: $SEERRKEY' \"http://localhost:5055/api/v1/user/\$UID/settings/main\" | jq -e '((.movieQuotaLimit // 0) == 0) and ((.tvQuotaLimit // 0) == 0)'"
  fi
fi

# === unit tests ===
# These 16 files existed and were GREEN, and `make test` ran none of them — so a regression in the
# release-title rules, the CF gates, the runtime guard or the BPP+ maths could ship without anything
# objecting, while this script diligently checked that containers were up. They are pure (no network,
# no *arr, no Jellyfin) and the whole set runs in a couple of seconds, so there is no reason not to.
#
# test-preview-import.js is deliberately EXCLUDED: it is a live in-container smoke test that requires
# the *arr container names to resolve (see its header), so it fails by design on the host.
echo
echo "=== unit tests ==="
for _t in scripts/test-*.js; do
  case "$_t" in */test-preview-import.js) continue ;; esac
  chk "unit: $(basename "$_t" .js)" node "$_t"
done

# === library integrity: files that are not the whole film ===
# THE CHINATOWN CLASS, and it is asserted here because every OTHER safeguard for it is on a code path
# that only runs when a swap happens. Radarr's own automatic imports never touch the controller, so
# without a standing check the next truncated file waits until somebody sits down to watch it.
#
# TWO SEPARATE ASSERTIONS ON PURPOSE, because they fail for different reasons and one hid the other:
#   short      — mediaInfo exists and says the file is under 60% of the film's runtime (Chinatown:
#                68 of 130 min). RUNTIME_MIN_RATIO in controller/lib/release-rules.js.
#   unreadable — Radarr has NO mediaInfo at all. Strictly worse, because nothing downstream can even
#                measure it: The Star Wars Holiday Special (15.7 min of 97) was invisible in every
#                audit section until 2026-08-12 precisely because buildRows skipped these rows.
# Full detail + ffprobe ground truth: ./scripts/audit-runtimes.sh --ffprobe
echo
echo "=== library integrity ==="
RKEY=$(docker exec radarr cat /config/config.xml 2>/dev/null | grep -oP '(?<=<ApiKey>)[^<]+' || true)
if [[ -n "$RKEY" ]]; then
  # Radarr's /movie payload is ~1 MB for this library. It MUST go to a file, not into an
  # `sh -c` argv: embedding it inline used to blow the exec arg limit ("Argument list too
  # long", exit 126), which `chk` recorded as a FAIL without ever running the assertion — a
  # false alarm on a clean library, and worse, it masked the check. The old form also
  # interpolated the JSON inside single quotes inside a double-quoted string, so any
  # apostrophe in a title (Ocean's Eleven, You've Got Mail — 29 of them here) corrupted it.
  # Passing the jq program as one argv element and the data as a filename avoids both.
  MOVF=$(mktemp)
  if curl -sf --max-time 60 -H "X-Api-Key: $RKEY" http://localhost:7878/api/v3/movie -o "$MOVF" && [[ -s "$MOVF" ]]; then
    chk "no movie file is dramatically shorter than its film (see: make runtimes)" \
      jq -e '[ .[] | select(.hasFile and .movieFile and (.movieFile.mediaInfo.runTime // "") != "" and (.runtime // 0) > 0)
        | (.movieFile.mediaInfo.runTime | split(":") | map(tonumber) | if length==2 then (.[0]*60 + .[1]) else (.[0]*3600 + .[1]*60 + .[2]) end) as $got
        | select($got / (.runtime * 60) < 0.60) | .title ] | length == 0' "$MOVF"
    chk "every movie file is readable by Radarr (has mediaInfo)" \
      jq -e '[ .[] | select(.hasFile and .movieFile and (.movieFile.mediaInfo == null or (.movieFile.mediaInfo.runTime // "") == "")) | .title ] | length == 0' "$MOVF"
  fi
  rm -f "$MOVF"
fi

echo
if [[ $FAIL -eq 0 ]]; then echo "ALL PASS"; else echo "$FAIL FAILURE(S) — see above"; fi
exit "$FAIL"
