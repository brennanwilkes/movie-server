# Jellyfin — complete the first-run wizard and ensure Movies/TV libraries exist.
# Sourced by provision.sh (lib.sh helpers + .env already loaded). Idempotent.
JF="http://localhost:8096"
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

# 3. Ensure libraries (skip any whose name already exists).
existing=$(curl -fsS "$JF/Library/VirtualFolders" -H "X-Emby-Token: $token" | jq -r '.[].Name')
jf_add_library() {  # name  collectionType  path
  if grep -qxF "$1" <<<"$existing"; then ok "library '$1' already present"; return; fi
  curl -fsS -X POST "$JF/Library/VirtualFolders?name=$1&collectionType=$2&refreshLibrary=true" \
    -H "X-Emby-Token: $token" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg p "$3" '{LibraryOptions:{PathInfos:[{Path:$p}]}}')" >/dev/null
  ok "library '$1' -> $3"
}
jf_add_library Movies movies   /media/movies
jf_add_library TV     tvshows  /media/tv
