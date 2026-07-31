#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

./scripts/ensure-data.sh                  # remount the media drive at $DATA if it moved (no-op otherwise)

# Syntax-gate every JS file we ship. There was NO check here, which is how a one-character
# variable collision in controller/web/js/audit.js reached production and took out the whole
# Audit tab: the backend never sees browser JS, so the container starts happily and the only
# symptom is a blank page. `node --check` costs milliseconds and catches exactly that class.
for f in controller/*.js controller/lib/*.js controller/web/js/*.js; do
  [ -e "$f" ] || continue
  node --check "$f" || { echo "deploy: SYNTAX ERROR in $f — refusing to deploy" >&2; exit 1; }
done
echo "deploy: JS syntax OK"

docker compose config -q                  # fail fast on bad compose/env
docker compose pull "$@"                   # latest images
docker compose up -d --remove-orphans --build "$@"   # --build re-bakes the controller image on code changes
docker compose ps
# usage: ./scripts/deploy.sh            (whole stack)
#        ./scripts/deploy.sh jellyfin   (one service, for phased bring-up)
