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

# 3a2. Trust local NFO metadata. *arr's Kodi/Emby consumer (enabled in _arr_common.sh) writes
#      tvshow.nfo / episode NFO carrying the exact tvdbid. With the NFO reader ON, Jellyfin pins
#      each folder to that id INSTEAD of fuzzy-parsing filenames — which is what let a year-less
#      "Cosmos" folder match the wrong show (2014 vs 1980) and scattered messy releases into
#      phantom seasons. Non-destructive: libraries with no NFO fall back to the online agents.
jf_enable_nfo_reader() {  # name — idempotently put 'Nfo' first in LocalMetadataReaderOrder
  local vf
  vf=$(curl -fsS "$JF/Library/VirtualFolders" -H "X-Emby-Token: $token" | jq --arg n "$1" '.[]|select(.Name==$n)')
  [[ -n "$vf" ]] || { warn "  could not find library '$1' to enable NFO reader"; return; }
  if [[ "$(jq -r '.LibraryOptions.LocalMetadataReaderOrder // [] | index("Nfo") // "no"' <<<"$vf")" != "no" ]]; then
    ok "library '$1' NFO reader already on"; return
  fi
  jq '{Id: .ItemId, LibraryOptions: (.LibraryOptions | .LocalMetadataReaderOrder=["Nfo"])}' <<<"$vf" \
    | curl -fsS -X POST "$JF/Library/VirtualFolders/LibraryOptions" \
        -H "X-Emby-Token: $token" -H 'Content-Type: application/json' -d @- >/dev/null
  ok "library '$1' NFO local-metadata reader enabled"
}
jf_enable_nfo_reader TV
jf_enable_nfo_reader Movies

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

# 3c. Curated ordered playlists (Top 100, Watchlist). IaC only CREATES them empty — it
#     NEVER touches membership or order. In-app editing (web/mobile drag-reorder) is the
#     source of truth for contents; a reconcile here would fight manual edits. Once a
#     playlist exists, Jellyfin surfaces a "Playlists" entry in the web sidebar drawer,
#     and the Firestick fork's toolbar buttons open each list by name. See DESIGN-PLAYLISTS.md.
#     Playlists are user-scoped, so create them under the admin user we authenticated as.
jf_uid=$(curl -fsS "$JF/Users/Me" -H "X-Emby-Token: $token" | jq -r '.Id')
[[ -n "$jf_uid" && "$jf_uid" != "null" ]] || die "could not resolve Jellyfin user id for playlists"
existing_playlists=$(curl -fsS "$JF/Items?userId=$jf_uid&IncludeItemTypes=Playlist&Recursive=true" \
  -H "X-Emby-Token: $token" | jq -r '.Items[].Name')
jf_ensure_playlist() {  # name — create an EMPTY video playlist if none with this exact name exists
  if grep -qxF "$1" <<<"$existing_playlists"; then
    ok "playlist '$1' already exists (contents left untouched)"; return
  fi
  # CreatePlaylistDto: empty Ids => empty playlist. MediaType Video so it lives under Movies/TV.
  curl -fsS -X POST "$JF/Playlists" -H "X-Emby-Token: $token" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg n "$1" --arg u "$jf_uid" '{Name:$n, Ids:[], UserId:$u, MediaType:"Video"}')" >/dev/null \
    && ok "playlist '$1' created (empty — populate/rank in-app)" \
    || warn "  failed to create playlist '$1'"
}
jf_ensure_playlist "Top 100"
jf_ensure_playlist "Watchlist"

# Rebuild each curated playlist's cover as a 2x2 poster mosaic from its CURRENT items.
# We build it OURSELVES rather than letting Jellyfin regenerate: Jellyfin's collage generator
# STRETCHES each 2:3 poster to fill a square cell, so the posters come out vertically squashed.
# Instead we cover-crop each poster to a 300x300 cell (proportions preserved, edges trimmed) and
# tile four into a 600x600 square with ImageMagick, then upload it. Runs every provision so covers
# track the list. Falls back to Jellyfin's (squashed) regen if ImageMagick isn't installed.
# (Caveat: editing a playlist in-app can make Jellyfin rebuild its own squashed collage; the next
# provision re-asserts ours.)
jf_refresh_playlist_cover() {  # name
  local pid tmp iid n=0; local -a cells=()
  pid=$(curl -fsS "$JF/Items?userId=$jf_uid&IncludeItemTypes=Playlist&Recursive=true" \
    -H "X-Emby-Token: $token" | jq -r --arg n "$1" '.Items[]|select(.Name==$n).Id // empty')
  [[ -n "$pid" ]] || return
  if ! command -v montage >/dev/null 2>&1 || ! command -v convert >/dev/null 2>&1; then
    # Fallback: let Jellyfin rebuild its own collage (may look squashed).
    curl -fsS -X DELETE "$JF/Items/$pid/Images/Primary" -H "X-Emby-Token: $token" >/dev/null 2>&1 || true
    curl -fsS -X POST "$JF/Items/$pid/Refresh?metadataRefreshMode=FullRefresh&imageRefreshMode=FullRefresh&replaceAllImages=true" \
      -H "X-Emby-Token: $token" >/dev/null 2>&1 || true
    warn "  ImageMagick not found — '$1' cover left to Jellyfin (may look squashed)"; return
  fi
  tmp=$(mktemp -d)
  while read -r iid; do
    [[ -n "$iid" ]] || continue
    curl -fsS "$JF/Items/$iid/Images/Primary?maxHeight=450&quality=90" -H "X-Emby-Token: $token" -o "$tmp/raw$n" 2>/dev/null \
      && convert "$tmp/raw$n" -resize 300x300^ -gravity center -extent 300x300 "$tmp/cell$n.png" 2>/dev/null \
      && { cells+=("$tmp/cell$n.png"); n=$((n+1)); } || true
  done < <(curl -fsS "$JF/Playlists/$pid/Items?userId=$jf_uid&Limit=8" -H "X-Emby-Token: $token" \
             | jq -r '.Items[]|select(.ImageTags.Primary!=null)|.Id' | head -4)
  if (( ${#cells[@]} >= 1 )) \
     && montage "${cells[@]}" -tile 2x2 -geometry +0+0 -background '#000' "$tmp/mosaic.png" 2>/dev/null \
     && base64 -w0 "$tmp/mosaic.png" | curl -fsS -X POST "$JF/Items/$pid/Images/Primary" \
          -H "X-Emby-Token: $token" -H 'Content-Type: image/png' --data-binary @- >/dev/null; then
    ok "playlist '$1' cover rebuilt (${#cells[@]}-poster mosaic, correct aspect)"
  else
    warn "  could not rebuild cover for '$1' (no poster items yet, or ImageMagick error)"
  fi
  rm -rf "$tmp"
}
jf_refresh_playlist_cover "Top 100"
jf_refresh_playlist_cover "Watchlist"

# 3d. Reconcile auto-created (TMDB) collections: HIDE tiny ones (<3 films) server-side via a
#     tag + the user's BlockedTags policy, and ORDER franchise ones chronologically
#     (DisplayOrder=PremiereDate). sort-collections.sh does both. It also runs once per boot
#     via collection-sort.service (installed by bootstrap.sh) to catch collections created
#     since the last deploy; we invoke it here so a deploy applies it immediately. Single
#     implementation lives in the script — see its header for scope + the block-toggle detail.
scripts/sort-collections.sh || warn "  collection reconcile failed (re-runs next boot)"

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

# 5b. Cap the "Generate Trickplay Images" task so it can't run past its off-hours window.
#     The task ships as a DailyTrigger at 03:00 with NO MaxRuntimeTicks. On a large backlog
#     (fresh library, many slow-decoding x265 10-bit files) a single run takes far longer than
#     one night and keeps ffmpeg pinned all day and into primetime — the exact thing section 5
#     tried to avoid. Cap it at 4h so it only runs 03:00–07:00. Trickplay is incremental, so it
#     resumes the next night and the backlog clears over several nights without ever touching
#     daytime. Same 4h cap Jellyfin already ships on "Extract Chapter Images".
#     Ticks are 100ns: 03:00 = 108000000000 ; 4h cap = 144000000000.
log "  capping Generate Trickplay Images at 4h (03:00–07:00 window)"
tp_id=$(curl -fsS "$JF/ScheduledTasks" -H "X-Emby-Token: $token" | jq -r '.[]|select(.Key=="RefreshTrickplayImages").Id // empty')
if [[ -z "$tp_id" ]]; then
  warn "  trickplay task not found, skipping runtime cap"
else
  cur=$(curl -fsS "$JF/ScheduledTasks" -H "X-Emby-Token: $token" | jq -c --arg id "$tp_id" '.[]|select(.Id==$id).Triggers')
  if jq -e 'length==1 and .[0].Type=="DailyTrigger" and .[0].TimeOfDayTicks==108000000000 and .[0].MaxRuntimeTicks==144000000000' <<<"$cur" >/dev/null 2>&1; then
    ok "trickplay task already capped at 4h"
  else
    curl -fsS -X POST "$JF/ScheduledTasks/$tp_id/Triggers" \
      -H "X-Emby-Token: $token" -H 'Content-Type: application/json' \
      -d '[{"Type":"DailyTrigger","TimeOfDayTicks":108000000000,"MaxRuntimeTicks":144000000000}]' >/dev/null
    ok "trickplay task capped: DailyTrigger 03:00 + 4h MaxRuntime"
  fi
fi

# 5c. Keyframe-only trickplay extraction — clears the one-time library backlog far faster.
#     By default trickplay full-decodes every frame at 0.1fps to sample thumbnails; on this 2c/4t
#     Skylake, software x265 10-bit decode is ~13 min/file, so the initial ~1800-file backlog would
#     take ~3 months of nightly 4h runs (section 5b). Keyframe-only seeks to keyframes instead of
#     full-decoding — several times faster, at the cost of slightly coarser scrub-preview precision.
#     Only ever runs inside the capped 03:00–07:00 window, so daytime is untouched either way.
#     TrickplayOptions lives on the ROOT server config (not encoding) as of 10.11. ProcessThreads
#     left at its default of 1 on purpose. Existing spritesheets are unaffected; this applies to
#     the files still missing trickplay.
log "  enabling keyframe-only trickplay extraction (faster backlog clear)"
sc=$(curl -fsS "$JF/System/Configuration" -H "X-Emby-Token: $token")
if [[ "$(jq -r '.TrickplayOptions.EnableKeyFrameOnlyExtraction' <<<"$sc")" == "true" ]]; then
  ok "keyframe-only trickplay already enabled"
else
  jq '.TrickplayOptions.EnableKeyFrameOnlyExtraction=true' <<<"$sc" \
    | curl -fsS -X POST "$JF/System/Configuration" \
        -H "X-Emby-Token: $token" -H 'Content-Type: application/json' -d @- >/dev/null
  ok "keyframe-only trickplay enabled"
fi

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

# 6d3. JavaScript Injector plugin (n00bcodr) — delivery vehicle for our custom WEB JS (curated-list
#      flair: Top 100 rank pills + Watchlist bookmarks on posters, and the Top 100 / Watchlist
#      sidebar entries). It registers via File Transformation's RUNTIME path — the same mechanism
#      HSS uses — so it COEXISTS with HSS's index.html transform. (FT's config-based search/replace
#      does NOT: HSS's runtime transform wins on index.html, and config transforms don't reach the
#      static JS bundles — verified on-box 2026-07-10.) The script itself is pushed as this plugin's
#      config in §9, after the §7 restart activates the plugin. See DESIGN-PLAYLISTS.md.
jsinj_repo="https://raw.githubusercontent.com/n00bcodr/jellyfin-plugins/main/10.11/manifest.json"
repos=$(curl -fsS "$JF/Repositories" -H "X-Emby-Token: $token")
if ! jq -e --arg u "$jsinj_repo" '.[]|select(.Url==$u)' <<<"$repos" >/dev/null 2>&1; then
  jq --arg u "$jsinj_repo" '. + [{"Name":"n00bcodr","Url":$u,"Enabled":true}]' <<<"$repos" \
    | curl -fsS -X POST "$JF/Repositories" -H "X-Emby-Token: $token" -H 'Content-Type: application/json' -d @- >/dev/null
  ok "JavaScript Injector repository registered"
fi
if grep -qxF "JavaScript Injector" <<<"$installed"; then
  ok "JavaScript Injector plugin already installed"
else
  sleep 2   # give the catalog a moment after a fresh repo add
  if curl -fsS -X POST "$JF/Packages/Installed/JavaScript%20Injector?assemblyGuid=f5a34f7b-2e8a-4e6a-a722-3a216a81b374" -H "X-Emby-Token: $token" >/dev/null 2>&1; then
    ok "JavaScript Injector plugin installed — restart below activates it"
  else
    warn "JavaScript Injector install failed (catalog may need a minute after repo add) — re-run make provision s=jellyfin"
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

# 9. Web curated-list flair — push our custom web JS into the JavaScript Injector plugin (installed
#    in §6d3, activated by the §7 restart). It surfaces the Top 100 rank pills + Watchlist bookmarks
#    on movie posters AND the Top 100 / Watchlist sidebar entries — the web counterpart to the
#    Firestick fork's card badges + toolbar buttons. JS Injector serves the script at
#    /JavaScriptInjector/public.js and injects a loader into index.html via File Transformation's
#    runtime path (coexists with HSS). Config applies LIVE — no restart needed. Script source is
#    jellyfin-web-flair.js next to this file. In-app playlist edits stay the source of truth.
#    NOTE: browsers cache the web assets via a service worker — hard-refresh once after a change.
#    See DESIGN-PLAYLISTS.md.
FLAIR_JS="$(dirname "${BASH_SOURCE[0]}")/jellyfin-web-flair.js"
js_id=$(curl -fsS "$JF/Plugins" -H "X-Emby-Token: $token" | jq -r '.[]|select(.Name=="JavaScript Injector" and .Status=="Active").Id // empty')
if [[ -z "$js_id" ]]; then
  warn "JavaScript Injector not active — skipping web flair (re-run make provision s=jellyfin)"
elif [[ ! -f "$FLAIR_JS" ]]; then
  warn "jellyfin-web-flair.js missing next to jellyfin.sh — skipping web flair"
else
  # Dedupe by NAME, not Id: the JS Injector plugin does NOT persist an Id field on stored
  # entries (keys are only Name/Script/Enabled/RequiresAuthentication), so an Id-based
  # "update in place" never matched and every provision piled up another duplicate — which
  # the plugin concatenates into public.js. Drop all prior "Curated List Flair" entries,
  # then append exactly one.
  flair_name="Curated List Flair"
  js_cur=$(curl -fsS "$JF/Plugins/$js_id/Configuration" -H "X-Emby-Token: $token")
  js_desired=$(jq --rawfile js "$FLAIR_JS" --arg name "$flair_name" '
    .PluginJavaScripts = (.PluginJavaScripts // []) |
    .CustomJavaScripts = (((.CustomJavaScripts // []) | map(select(.Name != $name))) + [{
      Name: $name, Script: $js, Enabled: true, RequiresAuthentication: false
    }])' <<<"$js_cur")
  if [[ "$(jq -S . <<<"$js_cur")" == "$(jq -S . <<<"$js_desired")" ]]; then
    ok "web flair script already up to date in JavaScript Injector"
  else
    curl -fsS -X POST "$JF/Plugins/$js_id/Configuration" -H "X-Emby-Token: $token" \
      -H 'Content-Type: application/json' -d "$js_desired" >/dev/null
    ok "web flair script pushed to JavaScript Injector (served at /JavaScriptInjector/public.js; hard-refresh browser)"
  fi
fi
