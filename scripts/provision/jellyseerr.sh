# Jellyseerr — the request UI. First-run creates the owner from the Jellyfin login,
# enables libraries, and wires Radarr + Sonarr. Idempotent. (serverType 2 = Jellyfin.)
JS="http://localhost:5055/api/v1"
wait_http "$JS/status" 120
jar=$(mktemp)
rkey=$(arr_apikey /opt/appdata/radarr)
skey=$(arr_apikey /opt/appdata/sonarr)

js_login()  { curl -s -o /dev/null -c "$jar" -X POST "$JS/auth/jellyfin" -H 'Content-Type: application/json' \
                -d "$(jq -n --arg u "$JELLYFIN_ADMIN_USER" --arg p "$JELLYFIN_ADMIN_PASS" '{username:$u,password:$p}')"; }
js_authed() { [[ "$(curl -s -b "$jar" "$JS/auth/me" | jq -r '.id // "null"')" != "null" ]]; }

# Post-setup login uses username/password only; a fresh install needs the full server
# config + serverType:2 to create the owner.
js_login
if ! js_authed; then
  curl -s -o /dev/null -c "$jar" -X POST "$JS/auth/jellyfin" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg u "$JELLYFIN_ADMIN_USER" --arg p "$JELLYFIN_ADMIN_PASS" --arg e "${JELLYSEERR_EMAIL:-${JELLYFIN_ADMIN_USER}@jellyseerr.local}" --arg jf "${NUC_IP:-jellyfin}" \
          '{username:$u,password:$p,hostname:$jf,port:8096,useSsl:false,urlBase:"",email:$e,serverType:2}')"
  js_authed || die "jellyseerr: could not authenticate or create owner (check Jellyfin creds)"
  ok "jellyseerr: owner created from Jellyfin login"
else
  ok "jellyseerr: authenticated as owner"
fi

# Enable all Jellyfin libraries (must sync first, then enable in sequence).
libs=$(curl -s -b "$jar" "$JS/settings/jellyfin/library?sync=true")
ids=$(echo "$libs" | jq -r '[.[].id] | join(",")')
curl -s -o /dev/null -b "$jar" "$JS/settings/jellyfin/library?enable=$ids"
ok "jellyseerr: enabled libraries ($(echo "$libs" | jq -r '[.[].name]|join(", ")'))"

# Add a *arr server (idempotent). $1=radarr|sonarr
js_add_arr() {
  local kind=$1 host port key root extra
  if [[ "$kind" == radarr ]]; then host=radarr; port=7878; key=$rkey; root=/data/media/movies; extra='{"minimumAvailability":"released"}'
  else                              host=sonarr; port=8989; key=$skey; root=/data/media/tv;     extra='{"enableSeasonFolders":true}'; fi
  if [[ "$(curl -s -b "$jar" "$JS/settings/$kind" | jq 'length')" -gt 0 ]]; then ok "jellyseerr: $kind already configured"; return; fi
  local test prof rootpath
  test=$(curl -s -b "$jar" -X POST "$JS/settings/$kind/test" -H 'Content-Type: application/json' \
          -d "$(jq -n --arg h "$host" --argjson p "$port" --arg k "$key" '{hostname:$h,port:$p,apiKey:$k,useSsl:false,baseUrl:""}')")
  prof=$(echo "$test" | jq '([.profiles[]|select(.name=="Normal")][0].id) // ([.profiles[]|select(.name=="HD-1080p")][0].id) // (.profiles[0].id)')
  rootpath=$(echo "$test" | jq -r --arg r "$root" '([.rootFolders[]|select(.path==$r)][0].path) // (.rootFolders[0].path)')
  local body
  body=$(jq -n --arg name "${kind^}" --arg h "$host" --argjson p "$port" --arg k "$key" \
              --argjson prof "$prof" --arg root "$rootpath" --argjson extra "$extra" \
    '{name:$name,hostname:$h,port:$p,apiKey:$k,useSsl:false,baseUrl:"",
      activeProfileId:$prof,activeProfileName:"Normal",activeDirectory:$root,
      is4k:false,isDefault:true,externalUrl:"",syncEnabled:true,preventSearch:false,tagRequests:false,tags:[]} + $extra')
  local resp; resp=$(curl -s -b "$jar" -X POST "$JS/settings/$kind" -H 'Content-Type: application/json' -d "$body")
  if echo "$resp" | jq -e '.id' >/dev/null 2>&1; then ok "jellyseerr: $kind added (profile $prof, root $rootpath)"
  else warn "jellyseerr: $kind add issue: $(echo "$resp" | jq -c '.message // .')"; fi
}
js_add_arr radarr
js_add_arr sonarr

# Mark setup complete.
curl -s -o /dev/null -b "$jar" -X POST "$JS/settings/initialize"
ok "jellyseerr: initialized"
rm -f "$jar"
