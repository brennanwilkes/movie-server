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
              elif .name=="category"      then .value=$cat
              elif .name=="tvCategory"     then .value=$cat
              elif .name=="movieCategory"  then .value=$cat
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
            elif .name=="mapFrom"       then .value="/data/media"
            elif .name=="mapTo"         then .value="/media"
            else . end))')
    local resp; resp=$("${AJ[@]}" -X POST "${base}/notification?forceSave=true" -d "$notif")
    if echo "$resp" | jq -e '.id' >/dev/null 2>&1; then ok "${app}: Jellyfin auto-scan connection added"
    else warn "${app}: Jellyfin connection issue: $(echo "$resp" | jq -c '(.[0].errorMessage // .message // .)' 2>/dev/null)"; fi
  fi

  # 5. Quality definitions — set preferred sizes so *arr favours reasonably-sized
  #    releases but still allows larger ones as fallbacks. Sizes in MB/min.
  local qd_skip=true
  local qd
  qd=$("${AG[@]}" "${base}/qualitydefinition")
  while IFS=: read -r qname pref max; do
    [[ -z "$qname" ]] && continue
    local cur; cur=$(echo "$qd" | jq --arg n "$qname" '.[] | select(.quality.name==$n)')
    [[ -z "$cur" || "$cur" == "null" ]] && continue
    local cur_pref; cur_pref=$(echo "$cur" | jq '.preferredSize // 0')
    [[ "$cur_pref" == "$pref" ]] && continue
    qd_skip=false
    local body; body=$(echo "$cur" | jq --argjson p "$pref" '.preferredSize=$p')
    if [[ -n "$max" ]]; then
      body=$(echo "$body" | jq --argjson m "$max" '.maxSize=$m')
    else
      body=$(echo "$body" | jq 'del(.maxSize)')
    fi
    local resp
    resp=$("${AJ[@]}" -X PUT "${base}/qualitydefinition/$(echo "$cur" | jq '.id')" -d "$body" 2>/dev/null)
    if echo "$resp" | head -1 | jq -e '.id' >/dev/null 2>&1; then
      ok "${app}: ${qname} preferred size ${pref} MB/min"
    else
      warn "${app}: ${qname} could not update preferred size: $(echo "$resp" | jq -c '(.[0].errorMessage // .message // .)' 2>/dev/null)"
    fi
  done <<< "$(echo "$qd" | if [[ "$app" == "radarr" ]]; then
    jq -r '.[] | select(.quality.name as \$n |
      \$n == "Bluray-1080p" or \$n == "HDTV-1080p" or \$n == "Bluray-720p" or \$n == "HDTV-720p" or \$n == "Remux-1080p")
      | "\(.quality.name):\(
        if .quality.name == "Bluray-1080p" then 35
        elif .quality.name == "HDTV-1080p" then 28
        elif .quality.name == "Bluray-720p" then 20
        elif .quality.name == "HDTV-720p" then 15
        elif .quality.name == "Remux-1080p" then 0
        else 0 end):\(
        if .quality.name == "Remux-1080p" then ""
        elif .quality.name == "Bluray-1080p" then 120
        elif .quality.name == "HDTV-1080p" then 100
        elif .quality.name == "Bluray-720p" then 60
        elif .quality.name == "HDTV-720p" then 50
        else "" end)"'
    else
      jq -r '.[] | select(.quality.name as \$n |
        \$n == "Bluray-1080p" or \$n == "HDTV-1080p" or \$n == "Bluray-720p" or \$n == "HDTV-720p")
        | "\(.quality.name):\(
          if .quality.name == "Bluray-1080p" then 30
          elif .quality.name == "HDTV-1080p" then 25
          elif .quality.name == "Bluray-720p" then 18
          elif .quality.name == "HDTV-720p" then 12
          else 0 end):\(
          if .quality.name == "Bluray-1080p" then 100
          elif .quality.name == "HDTV-1080p" then 80
          elif .quality.name == "Bluray-720p" then 50
          elif .quality.name == "HDTV-720p" then 40
          else "" end)"'
    fi
  )"
  $qd_skip && ok "${app}: quality definition preferred sizes already set"

  # 6. Disallow Remux-1080p in the HD-1080p profile. Remuxes are 20–40 GB/movie —
  #    far too big for the 50 GB /data cap, and Radarr always prefers the highest
  #    allowed tier, so a reachable Remux tier means giant grabs (e.g. a 20 GB Shrek
  #    over a 1 GB Bluray). Bluray-1080p is the sane ceiling for streaming to TVs.
  #    (Sonarr's HD-1080p has no Remux-1080p item, so this is a no-op there.)
  local prof; prof=$("${AG[@]}" "${base}/qualityprofile" | jq '[.[]|select(.name=="HD-1080p")][0]')
  if [[ -z "$prof" || "$prof" == "null" ]]; then
    ok "${app}: no HD-1080p profile — skipping Remux-1080p lockout"
  elif [[ "$(echo "$prof" | jq '[.items[]|select(.quality.name=="Remux-1080p" and .allowed)]|length')" == "0" ]]; then
    ok "${app}: Remux-1080p already disallowed in HD-1080p"
  else
    local pid body; pid=$(echo "$prof" | jq '.id')
    body=$(echo "$prof" | jq '(.items[]|select(.quality.name=="Remux-1080p").allowed)=false')
    "${AJ[@]}" -X PUT "${base}/qualityprofile/${pid}" -d "$body" >/dev/null
    if [[ "$("${AG[@]}" "${base}/qualityprofile/${pid}" | jq '[.items[]|select(.quality.name=="Remux-1080p" and .allowed)]|length')" == "0" ]]; then
      ok "${app}: Remux-1080p disallowed in HD-1080p (Bluray-1080p is the ceiling)"
    else
      warn "${app}: Remux-1080p lockout did not persist — check the PUT response"
    fi
  fi
}
