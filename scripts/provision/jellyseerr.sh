# Jellyseerr — the request UI. First-run creates the owner from the Jellyfin login,
# enables libraries, and wires Radarr + Sonarr. Idempotent. (serverType 2 = Jellyfin.)
#
# Auth: once Jellyseerr is initialized it has a stable API key (in its on-disk settings.json).
# We use THAT for all provisioning — the Jellyfin cookie-login endpoint (/auth/jellyfin with
# creds only) is unreliable post-setup in 3.3.0 (stores the server under `ip`, reads `hostname`
# on login → INVALID_URL), which used to make re-runs die. The fragile login is now only used
# to CREATE the owner on a genuinely fresh install (before any API key exists).
JS="http://localhost:5055/api/v1"
wait_http "$JS/status" 120
jar=$(mktemp)
rkey=$(arr_apikey /opt/appdata/radarr)
skey=$(arr_apikey /opt/appdata/sonarr)

js_cfg="${CONFIG:-/opt/appdata}/jellyseerr/settings.json"
js_apikey=""
[[ -f "$js_cfg" ]] && js_apikey=$(jq -r '.main.apiKey // empty' "$js_cfg" 2>/dev/null)

if [[ -n "$js_apikey" ]] && curl -s -H "X-Api-Key: $js_apikey" "$JS/settings/main" | jq -e '.apiKey' >/dev/null 2>&1; then
  # Already initialized — use the stable API key (works on every re-run; no fragile login).
  JS_AUTH=(-H "X-Api-Key: $js_apikey")
  ok "jellyseerr: authenticated via API key (already initialized)"
else
  # Fresh install — create the owner from the Jellyfin login (needs the full server config +
  # serverType:2), then adopt the API key that setup generates.
  curl -s -o /dev/null -c "$jar" -X POST "$JS/auth/jellyfin" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg u "$JELLYFIN_ADMIN_USER" --arg p "$JELLYFIN_ADMIN_PASS" --arg e "${JELLYSEERR_EMAIL:-${JELLYFIN_ADMIN_USER}@jellyseerr.local}" --arg jf "${NUC_IP:-jellyfin}" \
          '{username:$u,password:$p,hostname:$jf,port:8096,useSsl:false,urlBase:"",email:$e,serverType:2}')"
  [[ "$(curl -s -b "$jar" "$JS/auth/me" | jq -r '.id // "null"')" != "null" ]] \
    || die "jellyseerr: could not create owner (check Jellyfin creds / first-run state)"
  JS_AUTH=(-b "$jar")
  ok "jellyseerr: owner created from Jellyfin login"
fi
# Unified auth wrapper — cookie on fresh install, API key thereafter.
js() { curl -s "${JS_AUTH[@]}" "$@"; }

# Enable all Jellyfin libraries (must sync first, then enable). The sync endpoint only returns data
# under the cookie session (fresh install); on API-key re-runs it's empty — but libraries are
# already enabled by then, so guard and skip rather than crash.
libs=$(js "$JS/settings/jellyfin/library?sync=true")
if echo "$libs" | jq -e 'type=="array" and length>0' >/dev/null 2>&1; then
  ids=$(echo "$libs" | jq -r '[.[].id] | join(",")')
  js -o /dev/null "$JS/settings/jellyfin/library?enable=$ids"
  ok "jellyseerr: enabled libraries ($(echo "$libs" | jq -r '[.[].name]|join(", ")'))"
else
  ok "jellyseerr: libraries already configured (nothing to sync)"
fi

# Add a *arr server (idempotent). $1=radarr|sonarr
js_add_arr() {
  local kind=$1 host port key root extra
  if [[ "$kind" == radarr ]]; then host=radarr; port=7878; key=$rkey; root=/data/media/movies; extra='{"minimumAvailability":"released"}'
  else                              host=sonarr; port=8989; key=$skey; root=/data/media/tv;     extra='{"enableSeasonFolders":true}'; fi
  if [[ "$(js "$JS/settings/$kind" | jq 'length')" -gt 0 ]]; then ok "jellyseerr: $kind already configured"; return; fi
  local test prof rootpath
  test=$(js -X POST "$JS/settings/$kind/test" -H 'Content-Type: application/json' \
          -d "$(jq -n --arg h "$host" --argjson p "$port" --arg k "$key" '{hostname:$h,port:$p,apiKey:$k,useSsl:false,baseUrl:""}')")
  prof=$(echo "$test" | jq '([.profiles[]|select(.name=="Normal")][0].id) // ([.profiles[]|select(.name=="HD-1080p")][0].id) // (.profiles[0].id)')
  rootpath=$(echo "$test" | jq -r --arg r "$root" '([.rootFolders[]|select(.path==$r)][0].path) // (.rootFolders[0].path)')
  local body
  body=$(jq -n --arg name "${kind^}" --arg h "$host" --argjson p "$port" --arg k "$key" \
              --argjson prof "$prof" --arg root "$rootpath" --argjson extra "$extra" \
    '{name:$name,hostname:$h,port:$p,apiKey:$k,useSsl:false,baseUrl:"",
      activeProfileId:$prof,activeProfileName:"Normal",activeDirectory:$root,
      is4k:false,isDefault:true,externalUrl:"",syncEnabled:true,preventSearch:false,tagRequests:false,tags:[]} + $extra')
  local resp; resp=$(js -X POST "$JS/settings/$kind" -H 'Content-Type: application/json' -d "$body")
  if echo "$resp" | jq -e '.id' >/dev/null 2>&1; then ok "jellyseerr: $kind added (profile $prof, root $rootpath)"
  else warn "jellyseerr: $kind add issue: $(echo "$resp" | jq -c '.message // .')"; fi
}
js_add_arr radarr
js_add_arr sonarr

# Enable "Advanced Requests" quality-profile dropdown for ALL users (defaultPermissions
# 8224 = REQUEST | REQUEST_ADVANCED). Without this, non-admin users (e.g. family accounts) only
# see a plain "Request" button with no Low/Normal/Beloved tier picker.
cur_settings=$(js "$JS/settings/main")
perms=$(echo "$cur_settings" | jq -r '.defaultPermissions')
if [[ "$perms" != "8224" ]]; then
  echo "$cur_settings" | jq '.defaultPermissions=8224 | del(.apiKey)' | \
    js -o /dev/null -X POST "$JS/settings/main" -H 'Content-Type: application/json' -d @-
  new_perms=$(js "$JS/settings/main" | jq -r '.defaultPermissions')
  if [[ "$new_perms" == "8224" ]]; then
    ok "jellyseerr: defaultPermissions set to 8224 (REQUEST + REQUEST_ADVANCED) — all users see the tier dropdown"
  else
    warn "jellyseerr: defaultPermissions update did not persist (got $new_perms)"
  fi
else
  ok "jellyseerr: defaultPermissions already 8224 (REQUEST + REQUEST_ADVANCED)"
fi

# Custom discovery sliders — extra browse rows on the request page (movie genres via TMDb).
# Type 14 = TMDB_MOVIE_GENRE, data = TMDb genre id. /add creates them DISABLED with order=-1,
# so a follow-up PUT enables each. Idempotent by title; a leftover "__iac_test" probe slider
# is cleaned up. Reorder/curate freely in the Jellyseerr UI — this only ensures they exist.
sliders=$(js "$JS/settings/discover")
slider_ensure() {  # title  tmdb-genre-id
  local id; id=$(jq -r --arg t "$1" '.[]|select(.title==$t).id // empty' <<<"$sliders" | head -1)
  if [[ -n "$id" ]]; then ok "jellyseerr: discovery slider '$1' present"; return; fi
  local created; created=$(js -X POST "$JS/settings/discover/add" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg t "$1" --arg d "$2" '{title:$t,type:14,data:$d,enabled:true}')")
  id=$(jq -r '.id // empty' <<<"$created")
  if [[ -n "$id" ]]; then ok "jellyseerr: discovery slider '$1' created"; sliders_changed=true
  else warn "jellyseerr: could not create discovery slider '$1'"; fi
}
for tid in $(jq -r '.[]|select(.title=="__iac_test").id' <<<"$sliders"); do
  js -o /dev/null -X DELETE "$JS/settings/discover/$tid" && ok "jellyseerr: removed test slider (id=$tid)"
done
sliders_changed=false
slider_ensure "Comedy Picks"   35
slider_ensure "Sci-Fi Picks"   878
slider_ensure "Thriller Picks" 53
slider_ensure "Family Night"   10751
# /add creates sliders DISABLED (order=-1) and the per-id PUT does NOT flip `enabled` —
# only the batch save (POST the full list, like the UI does) enables them. Verified live.
if $sliders_changed; then
  js "$JS/settings/discover" \
    | jq '[.[]|{id,type,order,title,data,enabled:(if .isBuiltIn then .enabled else true end),isBuiltIn}]' \
    | js -o /dev/null -X POST "$JS/settings/discover" -H 'Content-Type: application/json' -d @-
  ok "jellyseerr: custom sliders enabled (batch save)"
fi

# Mark setup complete (no-op if already initialized).
js -o /dev/null -X POST "$JS/settings/initialize"
ok "jellyseerr: initialized"
rm -f "$jar"
