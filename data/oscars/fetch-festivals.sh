#!/usr/bin/env bash
set -euo pipefail
# Refresh the festival winner lists in data/oscars/festivals.json from English Wikipedia.
#
# Additive only — existing entries (and their resolved tmdb_ids) are never touched.
# Run this after a festival announces its winners, then:
#
#   bash data/oscars/resolve-festivals.sh   # fill tmdb_id for the new rows
#   bash data/oscars/build.sh              # merge into controller/oscar-winners.json
#
# See data/oscars/SOURCE.md and docs/DESIGN-AWARD-WATCH.md.

HERE="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$HERE/fetch-festivals.py" "$@"
