# Prowlarr — indexer manager. Set UI auth + register Radarr/Sonarr as applications so
# indexers added here auto-sync to them. (Adding actual indexers = deferred "real indexer
# strategy" — see plan §8.) Idempotent.
PROW="http://localhost:9696/api/v1"
key=$(arr_apikey /opt/appdata/prowlarr)
wait_http "http://localhost:9696/api/v1/system/status" 90
PG=(curl -s -H "X-Api-Key: ${key}")
PJ=(curl -s -H "X-Api-Key: ${key}" -H 'Content-Type: application/json')

# UI auth = brennan/brennan, bypassed on LAN.
host=$("${PG[@]}" "${PROW}/config/host")
if [[ "$(echo "$host" | jq -r '.authenticationMethod')" == "forms" ]]; then
  ok "prowlarr: UI auth already forms"
else
  echo "$host" | jq --arg u "$QBIT_USER" --arg p "$QBIT_PASS" \
    '.authenticationMethod="forms" | .authenticationRequired="disabledForLocalAddresses" | .username=$u | .password=$p | .passwordConfirmation=$p' \
    | "${PJ[@]}" -X PUT "${PROW}/config/host" -d @- >/dev/null
  [[ "$("${PG[@]}" "${PROW}/config/host" | jq -r '.authenticationMethod')" == "forms" ]] \
    || die "prowlarr: UI auth did not persist — check the PUT response"
  ok "prowlarr: UI auth set to forms (brennan, bypassed on LAN)"
fi

# Patch TPB Cardigann definition: drop season/ep from tv-search mode.
# TPB's keyword search doesn't handle "S01" appended after the series name
# (e.g. "Bloodline S01" misses "Bloodline 2015 S01 ..."). Sonarr parses
# season/ep from the title after the fact (same as RSS sync), so sending
# just the show name works better.
TPB_DEF=/config/Definitions/thepiratebay.yml
if grep -q 'tv-search: \[q, season, ep\]' "$TPB_DEF" 2>/dev/null; then
  sed -i 's/tv-search: \[q, season, ep\]/tv-search: [q]/' "$TPB_DEF"
  ok "prowlarr: patched TPB tv-search to [q] — restarting"
  pkill Prowlarr 2>/dev/null || true
  sleep 8
  wait_http "http://localhost:9696/api/v1/system/status" 60
  ok "prowlarr: back up after TPB definition reload"
else
  ok "prowlarr: TPB tv-search already patched"
fi

# Register Radarr + Sonarr as applications (built from live schema).
existing=$("${PG[@]}" "${PROW}/applications")
prow_add_app() {  # implementation  appBaseUrl  appApiKey
  if echo "$existing" | jq -e --arg i "$1" 'any(.[]; .implementation==$i)' >/dev/null; then
    ok "prowlarr: ${1} application present"; return
  fi
  local app
  app=$("${PG[@]}" "${PROW}/applications/schema" | jq --arg i "$1" --arg burl "$2" --arg ak "$3" \
    '[.[]|select(.implementation==$i)][0]
     | .name=$i | .syncLevel="fullSync"
     | .fields = (.fields | map(
         if   .name=="prowlarrUrl" then .value="http://prowlarr:9696"
         elif .name=="baseUrl"     then .value=$burl
         elif .name=="apiKey"      then .value=$ak
         else . end))')
  "${PJ[@]}" -X POST "${PROW}/applications" -d "$app" >/dev/null
  ok "prowlarr: ${1} application registered (${2})"
}
prow_add_app Radarr "http://radarr:7878" "$(arr_apikey /opt/appdata/radarr)"
prow_add_app Sonarr "http://sonarr:8989" "$(arr_apikey /opt/appdata/sonarr)"

# ---- Public torrent indexers + FlareSolverr proxy for the Cloudflare-protected ones ----
appid=$("${PG[@]}" "${PROW}/appprofile" | jq -r '.[0].id')

# tag used to bind Cloudflare indexers to the FlareSolverr proxy
tagid=$("${PG[@]}" "${PROW}/tag" | jq -r '.[]|select(.label=="flaresolverr").id')
if [[ -z "$tagid" || "$tagid" == "null" ]]; then
  tagid=$("${PJ[@]}" -X POST "${PROW}/tag" -d '{"label":"flaresolverr"}' | jq -r '.id')
  ok "prowlarr: created tag 'flaresolverr' (id $tagid)"
else
  ok "prowlarr: tag 'flaresolverr' present (id $tagid)"
fi

# FlareSolverr indexer proxy
if "${PG[@]}" "${PROW}/indexerproxy" | jq -e 'any(.[]; .implementation=="FlareSolverr")' >/dev/null; then
  ok "prowlarr: FlareSolverr proxy present"
else
  fs=$("${PG[@]}" "${PROW}/indexerproxy/schema" | jq --argjson t "$tagid" \
    '[.[]|select(.implementation=="FlareSolverr")][0] | .name="FlareSolverr" | .tags=[$t]
     | .fields = (.fields | map(if .name=="host" then .value="http://flaresolverr:8191" else . end))')
  "${PJ[@]}" -X POST "${PROW}/indexerproxy" -d "$fs" >/dev/null
  ok "prowlarr: FlareSolverr proxy added (host flaresolverr:8191, tag flaresolverr)"
fi

# add a public indexer from its Cardigann definition; forceSave so a flaky tracker test
# doesn't block provisioning. needs_flare=yes tags it for the FlareSolverr proxy.
prow_add_indexer() {  # definitionName  priority  needs_flare(yes|no)
  if "${PG[@]}" "${PROW}/indexer" | jq -e --arg d "$1" 'any(.[]; .definitionName==$d)' >/dev/null; then
    ok "prowlarr: indexer '$1' present"; return
  fi
  local tags='[]'; [[ "$3" == yes ]] && tags="[$tagid]"
  local ix; ix=$("${PG[@]}" "${PROW}/indexer/schema" | jq --arg d "$1" --argjson app "$appid" --argjson prio "$2" --argjson tags "$tags" \
    '[.[]|select(.definitionName==$d)][0] | .enable=true | .appProfileId=$app | .priority=$prio | .tags=$tags')
  local resp; resp=$("${PJ[@]}" -X POST "${PROW}/indexer?forceSave=true" -d "$ix")
  if echo "$resp" | jq -e '.id' >/dev/null 2>&1; then
    ok "prowlarr: indexer '$1' added (priority $2$([[ $3 == yes ]] && echo ', via FlareSolverr'))"
  else
    warn "prowlarr: indexer '$1' add issue: $(echo "$resp" | jq -c '(.[0].errorMessage // .) // "unknown"' 2>/dev/null)"
  fi
}
prow_add_indexer yts          10 no    # movies, small direct-play-friendly encodes
prow_add_indexer thepiratebay 25 no    # broad catalog, no Cloudflare
prow_add_indexer 1337x        25 yes   # broad catalog, behind Cloudflare
prow_add_indexer eztv         25 no    # TV-focused
