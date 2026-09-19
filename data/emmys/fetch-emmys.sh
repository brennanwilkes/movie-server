#!/usr/bin/env bash
set -euo pipefail
# Build data/emmys/emmys.json — Emmy "majors" per show, keyed by IMDb/TMDb/TVDB id.
#
# Source: English Wikipedia ceremony articles (77 Primetime + 20 Creative Arts), joined to
# Wikidata for ids. No credentials, no URL-slug guessing, no alias file — see
# docs/DESIGN-EMMY-BADGES.md for why the Television Academy route was abandoned.
#
# Wikitext is cached under data/emmys/.cache so the parser can be iterated without re-fetching.
# Re-run after each September ceremony (docs/DESIGN-AWARD-WATCH.md polls for that).

HERE="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$HERE/fetch-emmys.py" "$@"
