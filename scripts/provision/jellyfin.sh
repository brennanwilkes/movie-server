# Jellyfin — complete the first-run wizard and ensure Movies/TV libraries exist.
# Sourced by provision.sh (lib.sh helpers + .env already loaded). Idempotent.
# Jellyfin runs on HOST networking and pins itself to $NUC_IP below (LocalNetworkAddresses), so it
# binds ONLY to $NUC_IP:8096 — localhost:8096 stops responding after the first provision. Target
# $NUC_IP so wait_http + every API call work on a fresh install AND on idempotent re-runs.
JF="http://${NUC_IP:-localhost}:8096"
wait_http "$JF/System/Info/Public" 120

# 1. First-run wizard (only if not already completed).
if [[ "$(curl -fsS "$JF/System/Info/Public" | jq -r '.StartupWizardCompleted')" != "true" ]]; then
  log "  running first-run wizard"
  curl -fsS -X POST "$JF/Startup/Configuration" -H 'Content-Type: application/json' \
    -d '{"UICulture":"en-US","MetadataCountryCode":"CA","PreferredMetadataLanguage":"en"}' >/dev/null
  curl -fsS "$JF/Startup/User" >/dev/null   # GET initializes the default user object
  curl -fsS -X POST "$JF/Startup/User" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg n "$JELLYFIN_ADMIN_USER" --arg p "$JELLYFIN_ADMIN_PASS" '{Name:$n,Password:$p}')" >/dev/null
  curl -fsS -X POST "$JF/Startup/RemoteAccess" -H 'Content-Type: application/json' \
    -d '{"EnableRemoteAccess":true,"EnableAutomaticPortMapping":false}' >/dev/null
  curl -fsS -X POST "$JF/Startup/Complete" >/dev/null
  ok "wizard complete (admin user: $JELLYFIN_ADMIN_USER)"
else
  ok "wizard already complete"
fi

# 2. Authenticate as the admin user to get an access token.
AUTHHDR='MediaBrowser Client="provision", Device="cli", DeviceId="provision-cli", Version="1.0"'
token=$(curl -fsS -X POST "$JF/Users/AuthenticateByName" \
  -H "X-Emby-Authorization: $AUTHHDR" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg n "$JELLYFIN_ADMIN_USER" --arg p "$JELLYFIN_ADMIN_PASS" '{Username:$n,Pw:$p}')" \
  | jq -r '.AccessToken')
[[ -n "$token" && "$token" != "null" ]] || die "Jellyfin auth failed — check JELLYFIN_ADMIN_* in .env"

# 3. Ensure libraries exist AND have real-time monitoring on, so new media (Radarr/
#    Sonarr imports, manual drops) is picked up by Jellyfin's filesystem watcher within
#    ~1 min — instead of waiting for the periodic scan. Radarr's MediaBrowser "Update
#    Library" only refreshes items Jellyfin already knows about (it pings
#    /Library/Media/Updated), so it does NOT reliably discover brand-new files; the
#    watcher is what actually makes fresh downloads appear automatically.
existing=$(curl -fsS "$JF/Library/VirtualFolders" -H "X-Emby-Token: $token" | jq -r '.[].Name')
jf_enable_realtime() {  # name — idempotently set EnableRealtimeMonitor=true on a library
  local vf id
  vf=$(curl -fsS "$JF/Library/VirtualFolders" -H "X-Emby-Token: $token" | jq --arg n "$1" '.[]|select(.Name==$n)')
  [[ -n "$vf" ]] || { warn "  could not find library '$1' to enable real-time monitor"; return; }
  if [[ "$(jq -r '.LibraryOptions.EnableRealtimeMonitor' <<<"$vf")" == "true" ]]; then
    ok "library '$1' real-time monitor already on"; return
  fi
  jq '{Id: .ItemId, LibraryOptions: (.LibraryOptions | .EnableRealtimeMonitor=true)}' <<<"$vf" \
    | curl -fsS -X POST "$JF/Library/VirtualFolders/LibraryOptions" \
        -H "X-Emby-Token: $token" -H 'Content-Type: application/json' -d @- >/dev/null
  ok "library '$1' real-time monitor enabled"
}
jf_add_library() {  # name  collectionType  path
  if grep -qxF "$1" <<<"$existing"; then ok "library '$1' already present"
  else
    curl -fsS -X POST "$JF/Library/VirtualFolders?name=$1&collectionType=$2&refreshLibrary=true" \
      -H "X-Emby-Token: $token" -H 'Content-Type: application/json' \
      -d "$(jq -n --arg p "$3" '{LibraryOptions:{EnableRealtimeMonitor:true,PathInfos:[{Path:$p}]}}')" >/dev/null
    ok "library '$1' -> $3"
  fi
  jf_enable_realtime "$1"   # ensure it's on even for pre-existing libraries
}
jf_add_library Movies movies   /media/movies
jf_add_library TV     tvshows  /media/tv

# 4. Install Intro Skipper plugin (auto-skip intros/credits in TV shows).
#     Requires a third-party repository; the manifest is versioned by Jellyfin ABI.
log "  ensuring Intro Skipper plugin is installed"
installed=$(curl -fsS "$JF/Plugins" -H "X-Emby-Token: $token" | jq -r '.[].Name')
if grep -qxF "Intro Skipper" <<<"$installed"; then
  ok "Intro Skipper plugin already installed"
else
  repos=$(curl -fsS "$JF/Repositories" -H "X-Emby-Token: $token")
  repo_url="https://raw.githubusercontent.com/intro-skipper/manifest/main/10.11/manifest.json"
  if ! jq -e --arg u "$repo_url" '.[]|select(.Url==$u)' <<<"$repos" >/dev/null 2>&1; then
    # POST replaces the entire list — merge existing + new.
    merged=$(jq --arg n "Intro Skipper" --arg u "$repo_url" \
      '. + [{"Name":$n,"Url":$u,"Enabled":true}]' <<<"$repos")
    curl -fsS -X POST "$JF/Repositories" -H "X-Emby-Token: $token" \
      -H 'Content-Type: application/json' -d "$merged" >/dev/null
    ok "Intro Skipper repository registered"
  else
    ok "Intro Skipper repository already present"
  fi
  # Install the package. Name has a space — URL-encode it in the path.
  curl -fsS -X POST "$JF/Packages/Installed/Intro%20Skipper" \
    -H "X-Emby-Token: $token" >/dev/null
  ok "Intro Skipper plugin installed — restart Jellyfin to activate"
fi

# 5. Enable native trickplay (scrubbing thumbnails on seek bar).
#     Built into Jellyfin 10.9+ — no plugin needed.
log "  enabling trickplay for libraries"
libraries=$(curl -fsS "$JF/Library/VirtualFolders" -H "X-Emby-Token: $token")
for lib_name in Movies TV; do
  vf=$(jq --arg n "$lib_name" '.[]|select(.Name==$n)' <<<"$libraries")
  [[ -n "$vf" ]] || { warn "  library '$lib_name' not found, skipping trickplay"; continue; }
  if jq -e '.LibraryOptions.EnableTrickplayImageExtraction // false' <<<"$vf" | grep -q true; then
    ok "trickplay already enabled for '$lib_name'"
  else
    jq '{Id: .ItemId, LibraryOptions: (.LibraryOptions | .EnableTrickplayImageExtraction=true | .ExtractTrickplayImagesDuringLibraryScan=true)}' <<<"$vf" \
      | curl -fsS -X POST "$JF/Library/VirtualFolders/LibraryOptions" \
          -H "X-Emby-Token: $token" -H 'Content-Type: application/json' -d @- >/dev/null
    ok "trickplay enabled for '$lib_name'"
  fi
done

# 6. Apply custom CSS (scyfin + OLED + red accent + polish).
#     Pure CSS injected via the branding config — no plugin needed.
log "  ensuring custom CSS theme is applied"
branding=$(curl -fsS "$JF/System/Configuration/Branding" -H "X-Emby-Token: $token")
css_urls="@import url('https://cdn.jsdelivr.net/gh/loof2736/scyfin@latest/CSS/scyfin-theme.css');
@import url('https://cdn.jsdelivr.net/gh/loof2736/scyfin@latest/CSS/theme-oled.css');
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(0, 164, 220, 0.3); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: rgba(0, 164, 220, 0.5); }"
if [[ "$(jq -r '.CustomCss // ""' <<<"$branding")" == "$css_urls" ]]; then
  ok "custom CSS theme already applied"
else
  jq --arg css "$css_urls" '.CustomCss = $css' <<<"$branding" \
    | curl -fsS -X POST "$JF/System/Configuration/Branding" \
        -H "X-Emby-Token: $token" -H 'Content-Type: application/json' -d @- >/dev/null
  ok "custom CSS theme applied"
fi

# 6b. Intel Quick Sync hardware transcoding. Requires the iGPU passed into the container via
#     docker-compose (devices: /dev/dri + group_add render/video). The Iris 540 (Skylake) has no
#     10-bit HEVC HW decode, so EnableDecodingColorDepth10Hevc=false → those fall back to software
#     cleanly instead of erroring. (vainfo confirmed: H.264 + 8-bit HEVC decode/encode only.)
log "  enabling Intel Quick Sync hardware transcoding"
enc=$(curl -fsS "$JF/System/Configuration/encoding" -H "X-Emby-Token: $token")
jq '.HardwareAccelerationType="qsv" | .QsvDevice="/dev/dri/renderD128" | .EnableHardwareEncoding=true
    | .HardwareDecodingCodecs=["h264","hevc","mpeg2video","vc1"] | .EnableDecodingColorDepth10Hevc=false' <<<"$enc" \
  | curl -fsS -X POST "$JF/System/Configuration/encoding" -H "X-Emby-Token: $token" -H 'Content-Type: application/json' -d @- >/dev/null
ok "Quick Sync (QSV) enabled"

# 6c. Network: Jellyfin runs on host networking (compose) so the PS3 can find it over DLNA. Pin the
#     advertised address to the LAN IP and disable IPv6 — otherwise the DLNA plugin builds an
#     invalid bare-'::' URI and fails to publish on the LAN.
log "  pinning Jellyfin network to $NUC_IP (DLNA-friendly)"
net=$(curl -fsS "$JF/System/Configuration/network" -H "X-Emby-Token: $token")
jq --arg ip "$NUC_IP" '.EnableIPv6=false | .LocalNetworkAddresses=[$ip] | .PublishedServerUriBySubnet=["all=http://"+$ip+":8096"]' <<<"$net" \
  | curl -fsS -X POST "$JF/System/Configuration/network" -H "X-Emby-Token: $token" -H 'Content-Type: application/json' -d @- >/dev/null
ok "network advertised on $NUC_IP, IPv6 off"

# 6d. DLNA plugin — removed from Jellyfin core in 10.10+, so the PS3 needs it installed to discover
#     and browse Jellyfin. Lives in the default Jellyfin Stable repo. (Sony PS3 device profile ships
#     with the plugin and auto-applies by the PS3's identity on connect.)
if grep -qxF "DLNA" <<<"$installed"; then
  ok "DLNA plugin already installed"
else
  pkgs=$(curl -fsS "$JF/Packages" -H "X-Emby-Token: $token")
  dguid=$(jq -r '.[]|select(.name=="DLNA").guid' <<<"$pkgs")
  dver=$(jq -r '.[]|select(.name=="DLNA").versions[0].version' <<<"$pkgs")
  if [[ -n "$dguid" && "$dguid" != "null" ]]; then
    curl -fsS -X POST "$JF/Packages/Installed/DLNA?assemblyGuid=$dguid&version=$dver" -H "X-Emby-Token: $token" >/dev/null
    ok "DLNA plugin installed ($dver) — restart below activates it"
  else
    warn "DLNA package not found in catalog — PS3 discovery will be unavailable"
  fi
fi

# 7. Restart Jellyfin so plugin and CSS changes take effect (Branding API writes
#     to disk but server caches config in memory until restart).
log "  restarting Jellyfin to apply changes"
docker restart jellyfin
for i in $(seq 1 30); do
  token=$(curl -fsS -X POST "$JF/Users/AuthenticateByName" \
    -H "X-Emby-Authorization: $AUTHHDR" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg n "$JELLYFIN_ADMIN_USER" --arg p "$JELLYFIN_ADMIN_PASS" '{Username:$n,Pw:$p}')" \
    2>/dev/null | jq -r '.AccessToken' 2>/dev/null) || true
  [[ -n "$token" && "$token" != "null" ]] && break
  sleep 2
done
[[ -n "$token" && "$token" != "null" ]] || die "auth failed after restart"
