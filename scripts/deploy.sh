#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

./scripts/ensure-data.sh                  # remount the media drive at $DATA if it moved (no-op otherwise)
docker compose config -q                  # fail fast on bad compose/env
docker compose pull "$@"                   # latest images
docker compose up -d --remove-orphans --build "$@"   # --build re-bakes the controller image on code changes
docker compose ps
# usage: ./scripts/deploy.sh            (whole stack)
#        ./scripts/deploy.sh jellyfin   (one service, for phased bring-up)
