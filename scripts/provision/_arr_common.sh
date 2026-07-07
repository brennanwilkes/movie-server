# Shared provisioning for Radarr/Sonarr (same API shape). Sourced by radarr.sh/sonarr.sh.
# provision_arr  APP  PORT  APIVER  ROOTFOLDER  QBIT_CATEGORY
provision_arr() {
  local app=$1 port=$2 ver=$3 root=$4 cat=$5
  local base="http://localhost:${port}/api/${ver}"
  # Wait for the app FIRST (any HTTP answer counts), THEN read its API key — on a fresh
  # install config.xml may not exist until the app has fully started.
  wait_http "http://localhost:${port}/api/${ver}/system/status" 90
  local key; key=$(arr_apikey "/opt/appdata/${app}")
  [[ -n "$key" ]] || die "${app}: empty <ApiKey> in /opt/appdata/${app}/config.xml"

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
  #    QBIT_HOST is 'qbittorrent' normally, or 'gluetun' when qBittorrent is routed
  #    through the VPN overlay (make vpn-up) — where it shares gluetun's namespace and
  #    is reachable at gluetun:8080. RECONCILE the host on an existing client (not just
  #    create), so flipping the VPN on/off actually re-points the arr instead of leaving
  #    it aimed at a host that no longer resolves.
  local qbit_host="${QBIT_HOST:-qbittorrent}"
  local existing_dc; existing_dc=$("${AG[@]}" "${base}/downloadclient" | jq '[.[]|select(.implementation=="QBittorrent")][0]')
  if [[ -n "$existing_dc" && "$existing_dc" != "null" ]]; then
    local cur_host; cur_host=$(echo "$existing_dc" | jq -r '.fields[]|select(.name=="host").value // ""')
    if [[ "$cur_host" == "$qbit_host" ]]; then
      ok "${app}: qBittorrent download client present (host=${qbit_host})"
    else
      echo "$existing_dc" | jq --arg h "$qbit_host" '.fields=(.fields|map(if .name=="host" then .value=$h else . end))' \
        | "${AJ[@]}" -X PUT "${base}/downloadclient/$(echo "$existing_dc" | jq '.id')?forceSave=true" -d @- >/dev/null
      ok "${app}: qBittorrent download client host reconciled ${cur_host:-?} → ${qbit_host}"
    fi
  else
    local dc
    dc=$("${AG[@]}" "${base}/downloadclient/schema" \
      | jq --arg cat "$cat" --arg h "$qbit_host" '[.[]|select(.implementation=="QBittorrent")][0]
          | .enable=true | .name="qBittorrent"
          | .fields = (.fields | map(
              if   .name=="host"     then .value=$h
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
    ok "${app}: qBittorrent download client added (host=${qbit_host}, category=${cat})"
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

  # 4. Log level = info (reduces CPU on 2c/4t Skylake; keep API-accessible diagnostics).
  local ll; ll=$("${AG[@]}" "${base}/config/host" | jq -r '.logLevel // ""')
  if [[ "$ll" == "info" ]]; then
    ok "${app}: log level already info"
  else
    echo "$("${AG[@]}" "${base}/config/host")" | jq '.logLevel="info"' \
      | "${AJ[@]}" -X PUT "${base}/config/host" -d @- >/dev/null
    [[ "$("${AG[@]}" "${base}/config/host" | jq -r '.logLevel')" == "info" ]] \
      || die "${app}: log level change did not persist"
    ok "${app}: log level set to info (was ${ll})"
  fi

  # 5. Jellyfin connection — auto-scan Jellyfin on import/upgrade/rename/delete, so new
  #    media (and removals) show up without waiting for Jellyfin's periodic scan.
  if "${AG[@]}" "${base}/notification" | jq -e 'any(.[]; .implementation=="MediaBrowser")' >/dev/null; then
    ok "${app}: Jellyfin auto-scan connection present"
  else
    local jfkey; jfkey=$(jellyfin_apikey arr)
    [[ -n "$jfkey" && "$jfkey" != "null" ]] || die "${app}: could not obtain a Jellyfin API key"
    local notif; notif=$("${AG[@]}" "${base}/notification/schema" | jq --arg k "$jfkey" --arg jfhost "${NUC_IP:-jellyfin}" \
      '[.[]|select(.implementation=="MediaBrowser")][0]
       | .name="Jellyfin" | .onDownload=true | .onUpgrade=true | .onRename=true
       | reduce (to_entries[]|select(.key|test("^supportsOn.*Delete"))|select(.value)
                 |(.key|sub("supports";"")|(.[0:1]|ascii_downcase)+.[1:])) as $t (.; .[$t]=true)
       | .fields = (.fields | map(
           if   .name=="host"          then .value=$jfhost
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

  # 6. Quality definitions — sizes in MB/min. preferredSize is a soft target (Radarr
  #    aims for it when a near-size release exists); maxSize is the HARD reject ceiling.
  #    Caps are deliberately loose (80–120 for 1080p, i.e. ~14–21 GB for a 2 h film) so
  #    the SIZE-BAND custom formats (§8) do the real steering per tier — maxSize only
  #    rejects the true remux-class outliers. Note: with a near-empty 8 TB /data, the
  #    free-space import guard no longer brakes oversized grabs the way the old ~50 GB
  #    disk did, so maxSize is the only hard ceiling left.
  local qd_skip=true
  local qd
  qd=$("${AG[@]}" "${base}/qualitydefinition")
  while IFS=: read -r qname pref max; do
    [[ -z "$qname" ]] && continue
    local cur; cur=$(echo "$qd" | jq --arg n "$qname" '.[] | select(.quality.name==$n)')
    [[ -z "$cur" || "$cur" == "null" ]] && continue
    local cur_pref; cur_pref=$(echo "$cur" | jq '.preferredSize // 0')
    # Compare BOTH knobs — keying the skip on preferredSize alone meant a maxSize-only
    # change in this script never propagated to a live system (silent IaC drift).
    local cur_max; cur_max=$(echo "$cur" | jq -r '.maxSize // ""')
    [[ "$cur_pref" == "$pref" && "$cur_max" == "${max}" ]] && continue
    qd_skip=false
    local body; body=$(echo "$cur" | jq --argjson p "$pref" '.preferredSize=$p')
    if [[ -n "$max" ]]; then
      body=$(echo "$body" | jq --argjson m "$max" '.maxSize=$m')
    else
      body=$(echo "$body" | jq 'del(.maxSize)')
    fi
    local resp
    resp=$("${AJ[@]}" -X PUT "${base}/qualitydefinition/$(echo "$cur" | jq '.id')" -d "$body" 2>/dev/null)
    if echo "$resp" | jq -e '.id' >/dev/null 2>&1; then
      ok "${app}: ${qname} preferred size ${pref} MB/min"
    else
      warn "${app}: ${qname} could not update preferred size: $(echo "$resp" | jq -c '(.[0].errorMessage // .message // .)' 2>/dev/null)"
    fi
  done <<< "$(echo "$qd" | if [[ "$app" == "radarr" ]]; then
    jq -r '.[] | select(.quality.name as $n |
      $n == "Bluray-1080p" or $n == "HDTV-1080p" or $n == "WEBDL-1080p" or $n == "WEBRip-1080p"
      or $n == "Bluray-720p" or $n == "HDTV-720p" or $n == "Remux-1080p")
      | "\(.quality.name):\(
        if .quality.name == "Bluray-1080p" then 27
        elif .quality.name == "HDTV-1080p" then 25
        elif .quality.name == "WEBDL-1080p" then 27
        elif .quality.name == "WEBRip-1080p" then 27
        elif .quality.name == "Bluray-720p" then 16
        elif .quality.name == "HDTV-720p" then 14
        elif .quality.name == "Remux-1080p" then 0
        else 0 end):\(
        if .quality.name == "Remux-1080p" then ""
        elif .quality.name == "Bluray-1080p" then 120
        elif .quality.name == "HDTV-1080p" then 80
        elif .quality.name == "WEBDL-1080p" then 80
        elif .quality.name == "WEBRip-1080p" then 80
        elif .quality.name == "Bluray-720p" then 80
        elif .quality.name == "HDTV-720p" then 50
        else "" end)"'
    else
      jq -r '.[] | select(.quality.name as $n |
        $n == "Bluray-1080p" or $n == "HDTV-1080p" or $n == "Bluray-720p" or $n == "HDTV-720p")
        | "\(.quality.name):\(
          if .quality.name == "Bluray-1080p" then 18
          elif .quality.name == "HDTV-1080p" then 16
          elif .quality.name == "Bluray-720p" then 11
          elif .quality.name == "HDTV-720p" then 9
          else 0 end):\(
          if .quality.name == "Bluray-1080p" then 120
          elif .quality.name == "HDTV-1080p" then 80
          elif .quality.name == "Bluray-720p" then 80
          elif .quality.name == "HDTV-720p" then 50
          else "" end)"'
    fi
  )"
  $qd_skip && ok "${app}: quality definition preferred sizes already set"

  # 7. Propers/Repacks = "Do Not Prefer". The default (preferAndUpgrade) ranks a PROPER/REPACK
  #    above EVERY non-repack by quality revision BEFORE custom-format score is even considered —
  #    so a 17 GB "REPACK" HDR rip beats a 1.6 GB x264 with a far higher score (this is exactly
  #    why Gladiator/Godfather/Sinners kept grabbing bloated REPACKs). "doNotPrefer" hands that
  #    decision to custom formats, so our size penalties actually win.
  local mm; mm=$("${AG[@]}" "${base}/config/mediamanagement")
  if [[ "$(echo "$mm" | jq -r '.downloadPropersAndRepacks')" == "doNotPrefer" ]]; then
    ok "${app}: propers/repacks already 'doNotPrefer' (custom formats decide)"
  else
    echo "$mm" | jq '.downloadPropersAndRepacks="doNotPrefer"' \
      | "${AJ[@]}" -X PUT "${base}/config/mediamanagement/$(echo "$mm" | jq '.id')" -d @- >/dev/null
    if [[ "$("${AG[@]}" "${base}/config/mediamanagement" | jq -r '.downloadPropersAndRepacks')" == "doNotPrefer" ]]; then
      ok "${app}: propers/repacks set to 'doNotPrefer' — size/codec custom formats now decide"
    else
      warn "${app}: propers/repacks setting did not persist — check the PUT response"
    fi
  fi

  # 8. Delay profile — collect RSS arrivals in a 30 min window, then grab the best.
  #    bypassIfAboveCustomFormatScore=true + minimumCustomFormatScore=0 means releases
  #    scoring >= 0 (decent-size H.264 or better) skip the delay and grab immediately.
  #    Scores below 0 wait 30 min — during that window a better release may appear (fixes
  #    the "two grabs" bug: YTS 720p at -450 was grabbed 9 s before a 1080p +60 arrived).
  #    After 30 min the best of whatever arrived is grabbed (something over nothing).
  local delay; delay=$("${AG[@]}" "${base}/delayprofile" | jq '.[0] // empty')
  if [[ -n "$delay" ]]; then
    local cur_s; cur_s=$(echo "$delay" | jq '{enableUsenet,enableTorrent,preferredProtocol,usenetDelay,torrentDelay,bypassIfHighestQuality,bypassIfAboveCustomFormatScore,minimumCustomFormatScore,tags}')
    local des_s; des_s=$(echo "$cur_s" | jq '.torrentDelay=30|.bypassIfHighestQuality=false|.bypassIfAboveCustomFormatScore=true|.minimumCustomFormatScore=0')
    if [[ "$cur_s" == "$des_s" ]]; then
      ok "${app}: delay profile already set (30 min, bypass on score≥0)"
    else
      local body; body=$(echo "$delay" | jq '.torrentDelay=30|.bypassIfHighestQuality=false|.bypassIfAboveCustomFormatScore=true|.minimumCustomFormatScore=0')
      "${AJ[@]}" -X PUT "${base}/delayprofile/$(echo "$delay" | jq '.id')" -d "$body" >/dev/null \
        && ok "${app}: delay profile set to 30 min, bypassIf≥0" \
        || warn "${app}: failed to update delay profile"
    fi
  else
    "${AJ[@]}" -X POST "${base}/delayprofile" -d '{"enableUsenet":true,"enableTorrent":true,"preferredProtocol":"usenet","usenetDelay":0,"torrentDelay":30,"bypassIfHighestQuality":false,"bypassIfAboveCustomFormatScore":true,"minimumCustomFormatScore":0,"tags":[]}' >/dev/null \
      && ok "${app}: delay profile created (30 min, bypass on score≥0)" \
      || warn "${app}: failed to create delay profile"
  fi

  # 8b. Minimum seeders = 5 on every torrent indexer. Custom-format score alone would grab a +330
  #     2-seeder over a +310 85-seeder — the dead one stalls, gets removed, is re-grabbed = the
  #     "Not found" churn. Rejecting <5-seed releases makes selection pick a copy that actually
  #     downloads; a genuinely seedless title simply waits (re-searched each sweep) until seeds
  #     appear. forceSave skips the connectivity test (1337x is Cloudflare-fronted and would 400).
  local ms_changed=false _ixid _ixj
  for _ixid in $("${AG[@]}" "${base}/indexer" | jq -r '.[]|select(.protocol=="torrent").id'); do
    _ixj=$("${AG[@]}" "${base}/indexer/${_ixid}")
    [[ "$(echo "$_ixj" | jq -r '(.fields[]|select(.name=="minimumSeeders").value) // 1')" == "5" ]] && continue
    echo "$_ixj" | jq '(.fields[]|select(.name=="minimumSeeders").value)=5' \
      | "${AJ[@]}" -X PUT "${base}/indexer/${_ixid}?forceSave=true" -d @- >/dev/null && ms_changed=true
  done
  $ms_changed && ok "${app}: minimum seeders set to 5 on torrent indexers (skip dead releases)" \
              || ok "${app}: minimum seeders already 5 on torrent indexers"

  # 9. Custom formats + the THREE fuzzy quality tiers shown in Jellyseerr's request dropdown:
  #      "Low (save space)"  ·  "Normal"  ·  "Beloved (best quality)"
  #    The requester picks one in plain language ("is this beloved, normal, or low-importance?") and
  #    the tier decides the quality↔disk tradeoff — no resolution jargon. The projector is 1080p-max,
  #    so ALL tiers cap at 1080p and differ only by target BITRATE/size. Every tier:
  #      • allows the FULL SD→1080p range, so a request ALWAYS yields something — resolution is never
  #        a hard gate (a 720p-only title still grabs) and minFormatScore=-10000 rejects nothing.
  #      • prefers HW-decodable codecs (H.264 / 8-bit HEVC); HDR/10-bit/AV1/VP9 are penalised (the
  #        Iris 540 CPU-transcodes them — worse on an SDR 1080p projector).
  #    Scores only ORDER releases (never gate them). *arr compares quality TIER before custom-format
  #    score, so the size bands pick the right-sized release WITHIN the 1080p tier; 720p/SD is the
  #    something-over-nothing fallback when no 1080p exists.
  rt() { jq -n --arg v "$1" --argjson neg "${2:-false}" '{name:"s",implementation:"ReleaseTitleSpecification",negate:$neg,required:true,fields:[{name:"value",value:$v}]}'; }
  sz() { jq -n --argjson lo "$1" --argjson hi "$2" '{name:"s",implementation:"SizeSpecification",negate:false,required:true,fields:[{name:"min",value:$lo},{name:"max",value:$hi}]}'; }
  # lang ID [exceptLanguage] — LanguageSpecification. Language -2 is the special "Original" value:
  # it matches when the release's parsed language INCLUDES the title's own TMDb original language,
  # so one format works for every title (English, Japanese, French…) with no per-title config.
  lg() { jq -n --argjson v "$1" --argjson ex "${2:-false}" '{name:"s",implementation:"LanguageSpecification",negate:false,required:true,fields:[{name:"value",value:$v},{name:"exceptLanguage",value:$ex}]}'; }
  local existing_cf; existing_cf=$("${AG[@]}" "${base}/customformat")
  # cf_ensure name spec-array -> custom-format id. Creates if missing, and RECONCILES the
  # specifications when they differ from the declared state — a create-only version meant
  # every regex improvement in this file silently never reached a live install (the exact
  # drift that let hidden-10-bit x265 keep its GPU bonus). ok() to stderr so $() gets the id.
  cf_ensure() {
    local n="$1" spec="$2" id
    # Normalize both sides to implementation+negate+required+field-values for comparison
    # (the live API decorates fields with order/label/etc. that we don't declare).
    local _cfn='map({i:.implementation,n:.negate,r:.required,v:([.fields[]|select(.name=="value" or .name=="min" or .name=="max" or .name=="exceptLanguage").value]|sort)})|sort_by(.i,.v)'
    id=$(jq -r --arg n "$n" '.[]|select(.name==$n).id' <<<"$existing_cf")
    if [[ -z "$id" || "$id" == "null" ]]; then
      id=$("${AJ[@]}" "${base}/customformat" -d "$(jq -n --arg n "$n" --argjson s "$spec" '{name:$n,includeCustomFormatWhenRenaming:false,specifications:$s}')" | jq -r '.id')
      ok "${app}: custom format '$n' created" >&2
    else
      local want have cur
      cur=$(jq -c --arg n "$n" '[.[]|select(.name==$n)][0]' <<<"$existing_cf")
      want=$(jq -nc --argjson s "$spec" "\$s|${_cfn}")
      have=$(jq -c ".specifications|${_cfn}" <<<"$cur")
      if [[ "$want" != "$have" ]]; then
        jq --argjson s "$spec" '.specifications=$s' <<<"$cur" \
          | "${AJ[@]}" -X PUT "${base}/customformat/${id}" -d @- >/dev/null \
          && ok "${app}: custom format '$n' reconciled (spec changed)" >&2 \
          || warn "${app}: custom format '$n' reconcile failed" >&2
      fi
    fi
    echo "$id"
  }
  declare -A CFID
  local hdr_re='(?i)(\bhdr\b|hdr10|hdr10\+|dolby.?vision|\bdovi\b|\bdv\b)'
  # 10-bit markers: "10bit"/"10-bit" plus the shorthand forms ("10b", "Hi10"/"Hi10P").
  local tenbit_re='(?i)(10.?bit|\bhi10p?\b|\b10b\b)'
  CFID["HDR / Dolby Vision (CPU)"]=$(cf_ensure "HDR / Dolby Vision (CPU)" "[$(rt "$hdr_re")]")
  CFID["HEVC 8-bit (GPU)"]=$(cf_ensure "HEVC 8-bit (GPU)" "[$(rt '(?i)(x265|h\.?265|hevc)'),$(rt "$tenbit_re" true),$(rt "$hdr_re" true)]")
  CFID["H.264 (GPU)"]=$(cf_ensure "H.264 (GPU)" "[$(rt '(?i)\b(x264|h\.?264|avc)\b')]")
  CFID["10-bit (CPU)"]=$(cf_ensure "10-bit (CPU)" "[$(rt "$tenbit_re")]")
  # Groups that encode 10-bit x265 essentially always but rarely say so in the title —
  # ffprobe of this library confirmed "clean"-named rips from these landing as Main 10.
  # Title text can't prove bit depth, so this is a probabilistic penalty, not a gate.
  CFID["Likely 10-bit group (CPU)"]=$(cf_ensure "Likely 10-bit group (CPU)" "[$(rt '(?i)\b(tigole|qxr|t3nzin|afm72|vyndros|psa)\b')]")
  # Audio bias — TIEBREAKER ONLY (±15/20, dwarfed by codec/size scores). AC3/"DD5.1" is
  # PS4-native (direct-plays); TrueHD/DTS/Atmos/FLAC are big and always need transcoding.
  # EAC3/DDP is deliberately NEUTRAL: it's what the best WEB-DLs ship, and the ps4fix timer
  # normalizes it to AC3 after import — don't trade source quality for audio codec.
  CFID["PS4-native audio (AC3)"]=$(cf_ensure "PS4-native audio (AC3)" "[$(rt '(?i)\b(dd ?5\.?1|dd ?2\.?0|ac-?3)\b')]")
  CFID["HD/lossless audio (transcode)"]=$(cf_ensure "HD/lossless audio (transcode)" "[$(rt '(?i)\b(truehd|atmos|dts(-?(hd|es|x))?( ?ma)?|flac|opus)\b')]")
  CFID["AV1 (CPU)"]=$(cf_ensure "AV1 (CPU)" "[$(rt '(?i)\bav1\b')]")
  CFID["VP9 (CPU)"]=$(cf_ensure "VP9 (CPU)" "[$(rt '(?i)\bvp9\b')]")
  CFID["Size <1.5 GB"]=$(cf_ensure "Size <1.5 GB" "[$(sz 0 1.5)]")
  CFID["Size 1.5-3 GB"]=$(cf_ensure "Size 1.5-3 GB" "[$(sz 1.5 3)]")
  CFID["Size 3-6 GB"]=$(cf_ensure "Size 3-6 GB" "[$(sz 3 6)]")
  CFID["Size 6-10 GB"]=$(cf_ensure "Size 6-10 GB" "[$(sz 6 10)]")
  CFID["Size 10-15 GB"]=$(cf_ensure "Size 10-15 GB" "[$(sz 10 15)]")
  CFID["Size >15 GB"]=$(cf_ensure "Size >15 GB" "[$(sz 15 99999)]")
  # Language: prefer releases that CARRY the original-language audio; REJECT explicit dubs.
  #   • "Original-language audio" matches releases whose language includes the title's original language
  #     (MULTi/DUAL releases match too — they contain the original alongside a dub, which is fine).
  #   • "Dubbed" catches dub-only rips (e.g. "[Hindi Dub]", "[English Dub]", "dubbed"). The score is
  #     so extreme (-100000) that it gates: any release matching this format scores below minFormatScore
  #     (-10000) and is REJECTED entirely. Foreign films whose original language matches a dub language
  #     (e.g. a Hindi film with Hindi audio) won't say "Dub" and will match Original-language audio
  #     instead. English subs are handled separately by Bazarr.
  CFID["Original-language audio"]=$(cf_ensure "Original-language audio" "[$(lg -2 false)]")
  CFID["Dubbed"]=$(cf_ensure "Dubbed" "[$(rt '(?i)\b(dub|dubbed|dublado|dubbing)\b')]")
  # Movie-only: prefer the LONGER cut (Redux/Extended/Director's/Final/etc.) when one exists, and
  # nudge explicitly-labelled Theatrical down. Matched on the RELEASE TITLE (not Radarr's flaky
  # edition parser). Only affects the initial grab — an already-imported theatrical won't auto-swap
  # (cutoffFormatScore=0 marks it "done"); re-grab those via Interactive Search. See test notes.
  if [[ "$app" == "radarr" ]]; then
    CFID["Extended / Long Cut"]=$(cf_ensure "Extended / Long Cut" "[$(rt '(?i)(\bredux\b|\bextended\b|\buncut\b|\bintegral\b|\broadshow\b|\bdirector.?s?.?cut\b|\bfinal.?cut\b|\bultimate.?(edition|cut)\b|\bthe.?complete\b|\bimax.?edition\b)')]")
    CFID["Theatrical Cut"]=$(cf_ensure "Theatrical Cut" "[$(rt '(?i)\btheatrical\b')]")
  fi
  # Remove superseded custom formats from earlier iterations so they don't linger at score 0.
  local _cf_all _old _oid; _cf_all=$("${AG[@]}" "${base}/customformat")
  for _old in "PS3-native audio (AC3)" "Tiny (<2.5 GB)" "Oversized (>6 GB)" "Bloated (>10 GB)" "Huge (>14 GB)" "HDR / Dolby Vision (keep)"; do
    _oid=$(jq -r --arg n "$_old" '.[]|select(.name==$n).id' <<<"$_cf_all")
    [[ -n "$_oid" && "$_oid" != "null" ]] && { "${AG[@]}" -X DELETE "${base}/customformat/${_oid}" >/dev/null; ok "${app}: removed superseded custom format '$_old'"; }
  done
  # Radarr/Sonarr require EVERY defined custom format to appear in a profile's formatItems ("all
  # custom formats and no extra ones"). Build the id map from ALL current CFs (re-fetched after the
  # create/delete above); build_formatitems scores the ones we care about and 0 for everything else.
  local CF_IDMAP; CF_IDMAP=$("${AG[@]}" "${base}/customformat" | jq 'map({key:.name,value:.id})|from_entries')
  # build_formatitems TIER -> profile formatItems JSON. Codec scores are constant across tiers
  # (GPU-friendly always wins); the SIZE-BAND scores shift each tier's preferred-size "peak":
  #   Low → smallest (save space) · Normal → ~1.5–3 GB · Beloved → biggest 1080p (~6–15 GB).
  # For TV (sonarr) the size lean is GENTLE — season-pack size scales with episode count, so large
  # penalties would misfire; the lean still biases smaller/bigger sensibly within a season's options.
  build_formatitems() {
    jq -n --argjson ids "$CF_IDMAP" --arg tier "$1" --arg app "$app" '
      def sc($name):
        if   $name=="Original-language audio" then 200
        elif $name=="Dubbed" then -100000
        elif $name=="Extended / Long Cut" then 500
        elif $name=="Theatrical Cut" then -100
        # Codec spread is DELIBERATELY asymmetric: H.264 is the only codec whose 8-bit-ness the
        # title can prove (modern x265 is 10-bit-by-default without saying so — ffprobe-verified
        # on this library). At +50/+50 they tied and seeders picked the codec, which is how
        # hidden-10-bit x265 kept winning. HEVC stays positive (beats unknown) but loses to H.264.
        elif $name=="H.264 (GPU)" then 80
        elif $name=="HEVC 8-bit (GPU)" then 20
        elif $name=="Likely 10-bit group (CPU)" then -120
        elif $name=="HDR / Dolby Vision (CPU)" then -200
        elif $name=="10-bit (CPU)" then -150
        elif $name=="PS4-native audio (AC3)" then 15
        elif $name=="HD/lossless audio (transcode)" then -20
        elif $name=="AV1 (CPU)" or $name=="VP9 (CPU)" then -1000
        elif ($name|startswith("Size")) then
          ((if $app=="sonarr"
            then {"Size <1.5 GB":{low:30,normal:0,beloved:-40},"Size 1.5-3 GB":{low:20,normal:0,beloved:-20},"Size 3-6 GB":{low:0,normal:0,beloved:-10},"Size 6-10 GB":{low:-10,normal:0,beloved:0},"Size 10-15 GB":{low:-20,normal:0,beloved:20},"Size >15 GB":{low:-40,normal:0,beloved:40}}
            else {"Size <1.5 GB":{low:150,normal:30,beloved:-500},"Size 1.5-3 GB":{low:-100,normal:80,beloved:-150},"Size 3-6 GB":{low:-200,normal:40,beloved:-20},"Size 6-10 GB":{low:-500,normal:-150,beloved:100},"Size 10-15 GB":{low:-1500,normal:-500,beloved:30},"Size >15 GB":{low:-3000,normal:-1500,beloved:-50}}
            end)[$name][$tier])
        else 0 end;
      [$ids|to_entries[]|{format:.value,name:.key,score:(sc(.key) // 0)}]'
  }
  # 10. Build the three tier profiles
  # Shared policy (applied to each): FULL SD→1080p allow-list so
  #    resolution is never a hard gate; junk (CAM/TS/SCR/workprint), Remux (20–40 GB) and 2160p/4K
  #    (projector tops out at 1080p) stay OFF; cutoff = Bluray-1080p (the upgrade target — 1080p
  #    preferred, 720p/SD the something-over-nothing fallback); minFormatScore=-10000 (Dubbed at -100000 gates; everything else passes); formatItems = the tier's codec+size scores.
  local schema; schema=$("${AG[@]}" "${base}/qualityprofile/schema")
  local cutid cut720
  cutid=$(jq 'first(..|objects|select(.quality?.name=="Bluray-1080p").quality.id)' <<<"$schema")
  cut720=$(jq 'first(..|objects|select(.quality?.name=="Bluray-720p").quality.id)' <<<"$schema")
  # profile_body: base-json  name  formatItems  tier  cutoff-id
  #   The "low" tier RE-ORDERS the quality list so 720p ranks ABOVE 1080p — *arr compares quality
  #   tier before custom-format score, so without this a "smallest 1080p" (e.g. a 2.5 GB 40-Year-Old
  #   Virgin) always beats a ~1 GB 720p. Low therefore grabs the small 720p and only falls back to
  #   1080p when no 720p exists (still something-over-nothing). Normal/Beloved keep 1080p on top.
  profile_body() {
    jq --arg n "$2" --argjson it "$3" --arg tier "$4" --argjson cut "$5" '
      (["SDTV","DVD","Bluray-480p","Bluray-576p","HDTV-720p","Bluray-720p","HDTV-1080p","WEBDL-1080p","WEBRip-1080p","Bluray-1080p"]) as $allow
      | (["WEB 480p","WEB 720p","WEB 1080p"]) as $gallow
      | (if $tier=="low"
          then ["Unknown","WORKPRINT","CAM","TELESYNC","TELECINE","REGIONAL","DVDSCR","SDTV","DVD","DVD-R","WEB 480p","Bluray-480p","Bluray-576p","HDTV-1080p","WEB 1080p","Bluray-1080p","Bluray-720p","HDTV-720p","WEB 720p","Remux-1080p","HDTV-2160p","WEB 2160p","Bluray-2160p","Remux-2160p","BR-DISK","Raw-HD"]
          else null end) as $order
      | .name=$n | .upgradeAllowed=true | .cutoff=$cut | .minFormatScore=-10000 | .cutoffFormatScore=0 | .formatItems=$it
      | .items=(.items|map(
          if (.quality and .quality.name) then ((.quality.name) as $qn | .allowed=(($allow|index($qn))!=null))
          elif (.items!=null and .items!=[]) then (.name as $gn | (($gallow|index($gn))!=null) as $ga | .allowed=$ga | .items=(.items|map(.allowed=$ga)))
          else . end))
      | (if $order then .items=(.items | sort_by((.quality.name // .name) as $qn | ($order|index($qn)) // 999)) else . end)' <<<"$1"
  }
  ensure_tier() {  # display-name  tier(low|normal|beloved)
    local pname="$1" tier="$2" fitems cur cut
    fitems=$(build_formatitems "$tier")
    if [[ "$tier" == "low" ]]; then cut="$cut720"; else cut="$cutid"; fi
    cur=$("${AG[@]}" "${base}/qualityprofile" | jq --arg n "$pname" '[.[]|select(.name==$n)][0]')
    if [[ -z "$cur" || "$cur" == "null" ]]; then
      "${AJ[@]}" -X POST "${base}/qualityprofile" -d "$(profile_body "$schema" "$pname" "$fitems" "$tier" "$cut")" >/dev/null && ok "${app}: tier profile '$pname' created"
    else
      "${AJ[@]}" -X PUT "${base}/qualityprofile/$(jq '.id' <<<"$cur")" -d "$(profile_body "$cur" "$pname" "$fitems" "$tier" "$cut")" >/dev/null && ok "${app}: tier profile '$pname' updated"
    fi
  }
  # Rename the legacy HD-1080p profile to "Normal" ONCE (preserves its id, so every already-assigned
  # movie/series keeps its profile instead of being orphaned).
  local legacy; legacy=$("${AG[@]}" "${base}/qualityprofile" | jq '[.[]|select(.name=="HD-1080p")][0]')
  if [[ -n "$legacy" && "$legacy" != "null" && "$("${AG[@]}" "${base}/qualityprofile" | jq '[.[]|select(.name=="Normal")]|length')" == "0" ]]; then
    "${AJ[@]}" -X PUT "${base}/qualityprofile/$(jq '.id' <<<"$legacy")" -d "$(jq '.name="Normal"' <<<"$legacy")" >/dev/null
    ok "${app}: renamed legacy HD-1080p → Normal (id preserved, assignments kept)"
  fi
  ensure_tier "Normal" normal
  ensure_tier "Low (save space)" low
  ensure_tier "Beloved (best quality)" beloved
  # Normalize: sweep any item still on a NON-tier profile (legacy HD-720p/SD/Any/etc.) onto Normal,
  # so nothing is left on a profile that rejects 1080p (which is what stranded Jericho).
  local norm_id; norm_id=$("${AG[@]}" "${base}/qualityprofile" | jq 'first(.[]|select(.name=="Normal").id)')
  local tier_ids; tier_ids=$("${AG[@]}" "${base}/qualityprofile" | jq -c '[.[]|select(.name=="Normal" or .name=="Low (save space)" or .name=="Beloved (best quality)").id]')
  local ep field; if [[ "$app" == "radarr" ]]; then ep=movie; field=movieIds; else ep=series; field=seriesIds; fi
  local stray; stray=$("${AG[@]}" "${base}/${ep}" | jq -c --argjson t "$tier_ids" '[.[]|select((.qualityProfileId) as $p|($t|index($p))==null).id]')
  if [[ -n "$stray" && "$stray" != "[]" ]]; then
    "${AJ[@]}" -X PUT "${base}/${ep}/editor" -d "$(jq -n --argjson ids "$stray" --argjson q "$norm_id" --arg f "$field" '{($f):$ids,qualityProfileId:$q,moveFiles:false}')" >/dev/null
    ok "${app}: migrated $(jq 'length' <<<"$stray") item(s) off legacy profiles → Normal"
  else
    ok "${app}: all items already on a tier profile"
  fi
  # Also migrate Radarr Collections (list imports) — they can pin a profile "in use".
  if [[ "$app" == "radarr" ]]; then
    local stray_cols; stray_cols=$("${AG[@]}" "${base}/collection" | jq -c --argjson t "$tier_ids" '[.[]|select((.qualityProfileId) as $p|($t|index($p))==null).id]')
    if [[ -n "$stray_cols" && "$stray_cols" != "[]" ]]; then
      for _cid in $(echo "$stray_cols" | jq -r '.[]'); do
        "${AJ[@]}" -X PUT "${base}/collection/${_cid}" -d "$(jq -n --argjson q "$norm_id" '{qualityProfileId:$q}')" >/dev/null
      done
      ok "${app}: migrated $(jq 'length' <<<"$stray_cols") collection(s) → Normal"
    fi
  fi
  # Cleanup: DELETE every non-tier profile so Jellyseerr's request dropdown shows ONLY the three
  # tiers. The item/collection migration above left them unreferenced, so DELETE succeeds (verified
  # 200 on both Radarr and Sonarr — including the built-in HD-720p/Ultra-HD/Any/SD). Renaming does
  # NOT work: Jellyseerr lists every profile regardless of name. Fallback (rename to hidden) only if
  # a delete is ever refused because something still references it.
  local _p _pid _pname _code
  while IFS= read -r _p; do
    _pid="${_p%%:*}" _pname="${_p#*:}"
    [[ -z "$_pid" || "$_pid" == "null" ]] && continue
    case "$_pname" in "Low (save space)"|"Normal"|"Beloved (best quality)") continue;; esac
    _code=$("${AG[@]}" -o /dev/null -w '%{http_code}' -X DELETE "${base}/qualityprofile/${_pid}" 2>/dev/null)
    if [[ "$_code" =~ ^2 ]]; then
      ok "${app}: deleted non-tier profile '$_pname' (id=$_pid) — dropdown shows tiers only"
    else
      "${AG[@]}" "${base}/qualityprofile/${_pid}" | jq --arg n "_$_pname (hidden)" '.name=$n' \
        | "${AJ[@]}" -X PUT "${base}/qualityprofile/${_pid}" -d @- >/dev/null 2>&1
      warn "${app}: could not delete '$_pname' (id=$_pid, still referenced?) — renamed hidden"
    fi
  done < <("${AG[@]}" "${base}/qualityprofile" | jq -r '.[] | select(.id != null) | "\(.id):\(.name)"')
}
