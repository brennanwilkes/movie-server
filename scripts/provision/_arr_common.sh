# Shared provisioning for Radarr/Sonarr (same API shape). Sourced by radarr.sh/sonarr.sh.
# provision_arr  APP  PORT  APIVER  ROOTFOLDER  QBIT_CATEGORY
provision_arr() {
  local app=$1 port=$2 ver=$3 root=$4 cat=$5
  local base="http://localhost:${port}/api/${ver}"
  local key; key=$(arr_apikey "/opt/appdata/${app}")
  wait_http "http://localhost:${port}/api/${ver}/system/status" 90

  local AG=(curl -s -H "X-Api-Key: ${key}")
  local AJ=(curl -s -H "X-Api-Key: ${key}" -H 'Content-Type: application/json')

  # 1. Root folder.
  if "${AG[@]}" "${base}/rootfolder" | jq -e --arg p "$root" 'any(.[]; .path==$p)' >/dev/null; then
    ok "${app}: root folder ${root} present"
  else
    "${AJ[@]}" -X POST "${base}/rootfolder" -d "$(jq -n --arg p "$root" '{path:$p}')" >/dev/null
    ok "${app}: root folder ${root} added"
  fi

  # 2. qBittorrent download client (build from the live schema; fill fields by name).
  if "${AG[@]}" "${base}/downloadclient" | jq -e 'any(.[]; .implementation=="QBittorrent")' >/dev/null; then
    ok "${app}: qBittorrent download client present"
  else
    local dc
    dc=$("${AG[@]}" "${base}/downloadclient/schema" \
      | jq --arg cat "$cat" '[.[]|select(.implementation=="QBittorrent")][0]
          | .enable=true | .name="qBittorrent"
          | .fields = (.fields | map(
              if   .name=="host"     then .value="qbittorrent"
              elif .name=="port"     then .value=8080
              elif .name=="username" then .value=env.QBIT_USER
              elif .name=="password" then .value=env.QBIT_PASS
              elif .name=="category" then .value=$cat
              else . end))')
    local test_out
    test_out=$("${AJ[@]}" -X POST "${base}/downloadclient/test" -d "$dc")
    [[ -z "$test_out" || "$test_out" == "[]" || "$test_out" == "{}" ]] || warn "${app}: download client test warned: $test_out"
    "${AJ[@]}" -X POST "${base}/downloadclient" -d "$dc" >/dev/null
    ok "${app}: qBittorrent download client added (category=${cat})"
  fi

  # 3. UI auth = brennan/brennan, bypassed on the LAN. Done last (may restart the app).
  local host cur_method
  host=$("${AG[@]}" "${base}/config/host")
  cur_method=$(echo "$host" | jq -r '.authenticationMethod')
  if [[ "$cur_method" == "forms" ]]; then
    ok "${app}: UI auth already forms"
  else
    echo "$host" | jq --arg u "$QBIT_USER" --arg p "$QBIT_PASS" \
      '.authenticationMethod="forms" | .authenticationRequired="disabledForLocalAddresses"
       | .username=$u | .password=$p | .passwordConfirmation=$p' \
      | "${AJ[@]}" -X PUT "${base}/config/host" -d @- >/dev/null
    [[ "$("${AG[@]}" "${base}/config/host" | jq -r '.authenticationMethod')" == "forms" ]] \
      || die "${app}: UI auth did not persist — check the PUT response"
    ok "${app}: UI auth set to forms (brennan, bypassed on LAN)"
  fi

  # 4. Jellyfin connection — auto-scan Jellyfin on import/upgrade/rename/delete, so new
  #    media (and removals) show up without waiting for Jellyfin's periodic scan.
  if "${AG[@]}" "${base}/notification" | jq -e 'any(.[]; .implementation=="MediaBrowser")' >/dev/null; then
    ok "${app}: Jellyfin auto-scan connection present"
  else
    local jfkey; jfkey=$(jellyfin_apikey arr)
    [[ -n "$jfkey" && "$jfkey" != "null" ]] || die "${app}: could not obtain a Jellyfin API key"
    local notif; notif=$("${AG[@]}" "${base}/notification/schema" | jq --arg k "$jfkey" \
      '[.[]|select(.implementation=="MediaBrowser")][0]
       | .name="Jellyfin" | .onDownload=true | .onUpgrade=true | .onRename=true
       | reduce (to_entries[]|select(.key|test("^supportsOn.*Delete"))|select(.value)
                 |(.key|sub("supports";"")|(.[0:1]|ascii_downcase)+.[1:])) as $t (.; .[$t]=true)
       | .fields = (.fields | map(
           if   .name=="host"          then .value="jellyfin"
           elif .name=="port"          then .value=8096
           elif .name=="useSsl"        then .value=false
           elif .name=="urlBase"       then .value=""
           elif .name=="apiKey"        then .value=$k
           elif .name=="updateLibrary" then .value=true
           elif .name=="notify"        then .value=false
           else . end))')
    local resp; resp=$("${AJ[@]}" -X POST "${base}/notification?forceSave=true" -d "$notif")
    if echo "$resp" | jq -e '.id' >/dev/null 2>&1; then ok "${app}: Jellyfin auto-scan connection added"
    else warn "${app}: Jellyfin connection issue: $(echo "$resp" | jq -c '(.[0].errorMessage // .message // .)' 2>/dev/null)"; fi
  fi
}
