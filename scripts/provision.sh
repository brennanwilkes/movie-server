#!/usr/bin/env bash
# Config-as-code: bring each app to its declared state via its REST API.
# Idempotent — safe to re-run. Per-app logic lives in scripts/provision/<app>.sh.
#   ./provision.sh            provision every app that has a provisioner
#   ./provision.sh radarr     provision just one (or several) apps
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib.sh
require curl jq
set -a; source .env; set +a

# Dependency order: download client + indexer manager before the apps that use them.
ALL=(jellyfin qbittorrent prowlarr radarr sonarr bazarr jellyseerr suggestarr controller)
TARGETS=("$@"); [[ ${#TARGETS[@]} -eq 0 ]] && TARGETS=("${ALL[@]}")

for app in "${TARGETS[@]}"; do
  f="scripts/provision/${app}.sh"
  if [[ -f "$f" ]]; then
    log "Provisioning ${app} …"
    # shellcheck source=/dev/null
    source "$f"
  else
    warn "no provisioner for '${app}' yet (${f}) — skipping"
  fi
done
ok "Provisioning complete."
