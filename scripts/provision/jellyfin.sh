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

# 3b. Auto-collections: group movies into TMDb box sets (trilogies/sagas) automatically —
#     zero new software, big browse win. Idempotent, same pattern as trickplay below.
vf=$(curl -fsS "$JF/Library/VirtualFolders" -H "X-Emby-Token: $token" | jq '.[]|select(.Name=="Movies")')
if [[ "$(jq -r '.LibraryOptions.AutomaticallyAddToCollection // false' <<<"$vf")" == "true" ]]; then
  ok "Movies library already auto-adds to collections"
else
  jq '{Id: .ItemId, LibraryOptions: (.LibraryOptions | .AutomaticallyAddToCollection=true)}' <<<"$vf" \
    | curl -fsS -X POST "$JF/Library/VirtualFolders/LibraryOptions" \
        -H "X-Emby-Token: $token" -H 'Content-Type: application/json' -d @- >/dev/null
  ok "Movies library now auto-adds to TMDb collections (box sets)"
fi

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

# 4b. Intro Skipper config: cap parallelism at 1 so background analysis doesn't pin the
#     CPU on 2c/4t Skylake (each x265 chromaprint decode costs ~50% of a core). Idempotent.
IS_XML="${CONFIG:-/opt/appdata}/jellyfin/data/plugins/configurations/IntroSkipper.xml"
if [[ -f "$IS_XML" ]]; then
  python3 -c "
import xml.etree.ElementTree as ET
tree = ET.parse('$IS_XML')
root = tree.getroot()
for tag, val in [('MaxParallelism','1'), ('PreferChromaprint','false')]:
    el = root.find(tag)
    if el is not None and el.text != val:
        el.text = val; print(f'  set {tag}={val}')
tree.write('$IS_XML', xml_declaration=True, encoding='utf-8')
" 2>&1 | while IFS= read -r line; do ok "$line"; done
else
  cat > "$IS_XML" << 'ISEOF'
<?xml version="1.0" encoding="utf-8"?>
<PluginConfiguration>
  <MaxParallelism>1</MaxParallelism>
  <PreferChromaprint>false</PreferChromaprint>
  <AnalysisLengthLimit>10</AnalysisLengthLimit>
  <AnalysisPercent>25</AnalysisPercent>
  <ProcessPriority>BelowNormal</ProcessPriority>
  <AutoDetectIntros>true</AutoDetectIntros>
  <ScanIntroduction>true</ScanIntroduction>
  <ScanCredits>true</ScanCredits>
  <ScanRecap>true</ScanRecap>
  <ScanPreview>true</ScanPreview>
  <ScanCommercial>true</ScanCommercial>
</PluginConfiguration>
ISEOF
  ok "Intro Skipper config created (parallelism=1)"
fi

# 5. Enable native trickplay (scrubbing thumbnails on seek bar).
#     Built into Jellyfin 10.9+ — no plugin needed.
#     Desired state: extraction ON, but NOT during library scans. Generating trickplay is a
#     multi-core ffmpeg hog; running it inside the 12-hourly library scan spiked the CPU mid-day
#     and stuttered playback. Jellyfin's built-in "Generate Trickplay Images" scheduled task
#     already runs daily at 03:00 (off-hours), so we let THAT do the work and keep it out of scans.
log "  enabling trickplay for libraries (off-hours only, not during scans)"
libraries=$(curl -fsS "$JF/Library/VirtualFolders" -H "X-Emby-Token: $token")
for lib_name in Movies TV; do
  vf=$(jq --arg n "$lib_name" '.[]|select(.Name==$n)' <<<"$libraries")
  [[ -n "$vf" ]] || { warn "  library '$lib_name' not found, skipping trickplay"; continue; }
  # Idempotent on BOTH flags: enabled=true AND during-scan=false. Re-runs correct a library that
  # was previously provisioned with during-scan on.
  if jq -e '.LibraryOptions | (.EnableTrickplayImageExtraction==true and (.ExtractTrickplayImagesDuringLibraryScan // false)==false)' <<<"$vf" >/dev/null; then
    ok "trickplay already set correctly for '$lib_name' (on, off-hours)"
  else
    jq '{Id: .ItemId, LibraryOptions: (.LibraryOptions | .EnableTrickplayImageExtraction=true | .ExtractTrickplayImagesDuringLibraryScan=false)}' <<<"$vf" \
      | curl -fsS -X POST "$JF/Library/VirtualFolders/LibraryOptions" \
          -H "X-Emby-Token: $token" -H 'Content-Type: application/json' -d @- >/dev/null
    ok "trickplay set for '$lib_name' (on, generated off-hours by the 03:00 task)"
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

# 6c. Network: host-networked Jellyfin must be reachable on the LAN, over the Tailscale mesh, AND
#     hand each client a playback base URL it can actually reach. Bind ALL interfaces (empty
#     LocalNetworkAddresses) so it answers on the LAN IP, localhost, and the 100.x mesh IP, and let
#     Jellyfin derive its advertised address from each request's Host header
#     (EnablePublishedServerUriByRequest): a LAN client is told 192.168.x, a mesh client is told its
#     100.x address — neither gets a URL it can't reach. PublishedServerUriBySubnet is CLEARED: a
#     static "all=" override there wins over per-request detection and pinned every client back onto
#     the LAN IP (the cause of black-screen playback over Tailscale/cellular). IPv6 stays off —
#     otherwise the DLNA plugin builds an invalid bare-'::' URI and fails to publish on the LAN.
log "  configuring Jellyfin network (bind all; advertise per-request Host)"
net=$(curl -fsS "$JF/System/Configuration/network" -H "X-Emby-Token: $token")
jq '.EnableIPv6=false | .LocalNetworkAddresses=[] | .EnablePublishedServerUriByRequest=true | .PublishedServerUriBySubnet=[]' <<<"$net" \
  | curl -fsS -X POST "$JF/System/Configuration/network" -H "X-Emby-Token: $token" -H 'Content-Type: application/json' -d @- >/dev/null
ok "network: binds all interfaces, advertises per-request Host, IPv6 off"

# 6d. DLNA plugin — removed from Jellyfin core in 10.10+, so the PS4 needs it installed to discover
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

# 6d1. Home Screen Sections (+ File Transformation dependency) — modular, configurable home
#      rows ("Because you watched", genre rows, etc.): the discoverability upgrade for the
#      stock home page. Third-party repo (iamparadox.dev); versions verified against this
#      server's 10.11 ABI on 2026-07-02. If a Jellyfin upgrade ever breaks it, the plugin
#      shows "Malfunctioned" in the dashboard and can be disabled there — core is unaffected.
hss_repo="https://www.iamparadox.dev/jellyfin/plugins/manifest.json"
repos=$(curl -fsS "$JF/Repositories" -H "X-Emby-Token: $token")
if ! jq -e --arg u "$hss_repo" '.[]|select(.Url==$u)' <<<"$repos" >/dev/null 2>&1; then
  jq --arg u "$hss_repo" '. + [{"Name":"iamparadox (Home Screen Sections)","Url":$u,"Enabled":true}]' <<<"$repos" \
    | curl -fsS -X POST "$JF/Repositories" -H "X-Emby-Token: $token" -H 'Content-Type: application/json' -d @- >/dev/null
  ok "Home Screen Sections repository registered"
fi
for hss_pkg in "File Transformation" "Home Screen Sections"; do
  if grep -qxF "$hss_pkg" <<<"$installed"; then ok "$hss_pkg plugin already installed"; continue; fi
  hss_enc=$(jq -rn --arg s "$hss_pkg" '$s|@uri')
  if curl -fsS -X POST "$JF/Packages/Installed/${hss_enc}" -H "X-Emby-Token: $token" >/dev/null 2>&1; then
    ok "$hss_pkg plugin installed — restart below activates it"
  else
    warn "$hss_pkg install failed (catalog may need a minute after repo add) — re-run make provision s=jellyfin"
  fi
done

# 6d2. Playback Reporting plugin (official Jellyfin repo) — records who watched what, when.
#      The raw material for taste-aware home rows, pruning decisions, and SuggestArr-style
#      recommendations. Same install pattern as the DLNA plugin above.
if grep -qxF "Playback Reporting" <<<"$installed"; then
  ok "Playback Reporting plugin already installed"
else
  pkgs=${pkgs:-$(curl -fsS "$JF/Packages" -H "X-Emby-Token: $token")}
  prguid=$(jq -r '.[]|select(.name=="Playback Reporting").guid' <<<"$pkgs")
  prver=$(jq -r '.[]|select(.name=="Playback Reporting").versions[0].version' <<<"$pkgs")
  if [[ -n "$prguid" && "$prguid" != "null" ]]; then
    curl -fsS -X POST "$JF/Packages/Installed/Playback%20Reporting?assemblyGuid=$prguid&version=$prver" -H "X-Emby-Token: $token" >/dev/null
    ok "Playback Reporting plugin installed ($prver) — restart below activates it"
  else
    warn "Playback Reporting not found in plugin catalog — skipped"
  fi
fi

# 6e. PS4 DLNA device profile — the console is a PS4 (long mislabelled PS3): it identifies
#     as "PLAYSTATION 4", so only a matching profile applies. Direct-plays MKV/MP4 with
#     H.264 8-bit + AAC/AC3; everything else (E-AC3/DDP, DTS, HEVC, 10-bit) transcodes to
#     TS H.264 + AC3 5.1. See dlna-ps4-profile.xml for the full capability notes.
PS4_SRC="$(dirname "${BASH_SOURCE[0]}")/dlna-ps4-profile.xml"
PS4_DST="${CONFIG:-/opt/appdata}/jellyfin/data/plugins/configurations/dlna/user/Sony PlayStation 4.xml"
rm -f "${CONFIG:-/opt/appdata}/jellyfin/data/plugins/configurations/dlna/user/Sony PlayStation 3.xml"  # retired (wrong console)
if [[ -f "$PS4_SRC" ]]; then
  mkdir -p "$(dirname "$PS4_DST")"
  if cmp -s "$PS4_SRC" "$PS4_DST" 2>/dev/null; then
    ok "PS4 DLNA profile already installed"
  else
    cp "$PS4_SRC" "$PS4_DST"
    ok "PS4 DLNA profile installed (MKV+H.264+AAC/AC3 direct-play; DDP/DTS/HEVC → TS+AC3 transcode) — restart below activates it"
  fi
else
  warn "dlna-ps4-profile.xml missing next to jellyfin.sh — PS4 profile not installed"
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

# 8. Home Screen Sections — declared section layout + integrations (IaC). Runs after the
#    restart so the plugin is loaded. Schema discovered from the plugin's OpenAPI:
#    SectionSettings = {SectionId, Enabled, AllowUserOverride, LowerLimit, UpperLimit,
#    OrderIndex, ViewMode(Portrait|Landscape|Square|Small), HideWatchedItems}.
#    Jellyfin runs HOST networking, so integrations use $NUC_IP, never container DNS names.
hss_id=$(curl -fsS "$JF/Plugins" -H "X-Emby-Token: $token" | jq -r '.[]|select(.Name=="Home Screen Sections" and .Status=="Active").Id // empty')
if [[ -z "$hss_id" ]]; then
  warn "Home Screen Sections not active — skipping section layout (re-run make provision s=jellyfin)"
else
  seerr_key=$(jq -r '.main.apiKey // empty' "${CONFIG:-/opt/appdata}/jellyseerr/settings.json" 2>/dev/null)
  radarr_key=$(arr_apikey /opt/appdata/radarr 2>/dev/null || true)
  sonarr_key=$(arr_apikey /opt/appdata/sonarr 2>/dev/null || true)
  hss_cur=$(curl -fsS "$JF/Plugins/${hss_id}/Configuration" -H "X-Emby-Token: $token")
  # Layout: everyday rows first (media, resume, fresh arrivals), then taste (because-you-
  # watched, genre rows, top ten, watch-again), then outward discovery (Jellyseerr discover +
  # requests, *arr upcoming). Sections SHARING an OrderIndex render in random order among
  # themselves on every load (plugin behavior) — the taste group (5) and discovery group (9)
  # deliberately share numbers so the home page shuffles a little each visit. Overlapping/
  # irrelevant rows explicitly disabled; users can override anything.
  hss_desired=$(jq --arg ip "$NUC_IP" --arg sk "$seerr_key" --arg rk "$radarr_key" --arg nk "$sonarr_key" '
    def row($id; $ord; $en; $hide; $max; $vm):
      {SectionId:$id, Enabled:$en, AllowUserOverride:true, LowerLimit:1, UpperLimit:$max,
       OrderIndex:$ord, ViewMode:$vm, HideWatchedItems:$hide};
    .Enabled=true | .AllowUserOverride=true
    | .JellyseerrUrl=("http://"+$ip+":5055") | .JellyseerrApiKey=$sk
    | .Radarr.Url=("http://"+$ip+":7878") | .Radarr.ApiKey=$rk
    | .Sonarr.Url=("http://"+$ip+":8989") | .Sonarr.ApiKey=$nk
    | .SectionSettings=[
        row("MyMedia";                1; true;  false; 1; "Landscape"),
        row("ContinueWatchingNextUp"; 2; true;  false; 1; "Landscape"),
        row("ShelfA";                 4; true;  false; 10; "Landscape"),
        row("ShelfB";                 4; true;  false; 10; "Landscape"),
        row("ShelfC";                 4; true;  false; 10; "Landscape"),
        row("ShelfD";                 4; true;  false; 10; "Landscape"),
        row("ShelfE";                 4; true;  false; 10; "Landscape"),
        row("ShelfF";                 4; true;  false; 10; "Landscape"),
        row("ShelfG";                 4; true;  false; 10; "Landscape"),
        row("ShelfH";                 4; true;  false; 10; "Landscape"),
        row("ShelfI";                 4; true;  false; 10; "Landscape"),
        row("ShelfJ";                 4; true;  false; 10; "Landscape"),
        row("BecauseYouWatched";      5; true;  true;  4; "Landscape"),
        row("ShelfK";                 6; true;  false; 10; "Landscape"),
        row("ShelfL";                 6; true;  false; 10; "Landscape"),
        row("ShelfM";                 6; true;  false; 10; "Landscape"),
        row("ShelfN";                 6; true;  false; 10; "Landscape"),
        row("ShelfO";                 6; true;  false; 10; "Landscape"),
        row("ShelfP";                 6; true;  false; 10; "Landscape"),
        row("ShelfQ";                 6; true;  false; 10; "Landscape"),
        row("ShelfR";                 6; true;  false; 10; "Landscape"),
        row("ShelfS";                 6; true;  false; 10; "Landscape"),
        row("ShelfT";                 6; true;  false; 10; "Landscape"),
        row("RecentlyAddedMovies";    7; true;  true;  1; "Landscape"),
        row("RecentlyAddedShows";     7; true;  true;  1; "Landscape"),
        row("Genre";                  8; true;  true;  3; "Landscape"),
        row("TopTen";                 8; true;  false; 1; "Landscape"),
        row("WatchAgain";             8; true;  false; 1; "Landscape"),
        row("DiscoverMovies";        11; true;  false; 1; "Portrait"),
        row("DiscoverTv";            11; true;  false; 1; "Portrait"),
        row("UpcomingMovies";        11; true;  false; 1; "Portrait"),
        row("UpcomingShows";         11; true;  false; 1; "Portrait"),
        row("MyRequests";            15; true;  false; 1; "Landscape"),
        row("ContinueWatching";     999; false; false; 1; "Landscape"),
        row("LatestMovies";         999; false; false; 1; "Landscape"),
        row("LatestShows";          999; false; false; 1; "Landscape"),
        row("LiveTv";               999; false; false; 1; "Landscape"),
        row("MyList";               999; false; false; 1; "Landscape")
      ]' <<<"$hss_cur")
  if [[ "$(jq -S 'del(.CacheBustCounter)' <<<"$hss_cur")" == "$(jq -S 'del(.CacheBustCounter)' <<<"$hss_desired")" ]]; then
    ok "Home Screen Sections layout already configured"
  else
    curl -fsS -X POST "$JF/Plugins/${hss_id}/Configuration" -H "X-Emby-Token: $token" \
      -H 'Content-Type: application/json' -d "$hss_desired" >/dev/null
    ok "Home Screen Sections layout applied (14 rows enabled incl. Off the Shelf, integrations wired to $NUC_IP)"
  fi
fi
