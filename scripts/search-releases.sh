#!/usr/bin/env bash
# Search available releases in Radarr/Sonarr for a given title.
# Shows: seeders, size, quality, and release name — sorted by seed count.
# Helps answer "are there better-seeded options available?"
#
# Usage:
#   ./scripts/search-releases.sh "Skyfall"                      # Radarr (default)
#   ./scripts/search-releases.sh --sonarr "Rick and Morty"      # Sonarr
#   ./scripts/search-releases.sh --raw "Skyfall"                # raw JSON
#   ./scripts/search-releases.sh --top3 "Skyfall"               # top 3 by seeders
#   ./scripts/search-releases.sh --watch "Moneyball"            # poll every 10s
set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/lib.sh
source .env 2>/dev/null || true

APP=radarr
MODE=normal
WATCH=false
TOP_N=0

# Parse args
POS_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --sonarr) APP=sonarr ;;
    --radarr) APP=radarr ;;
    --watch)  WATCH=true ;;
    --raw)    MODE=raw ;;
    --top3)   TOP_N=3 ;;
    --top5)   TOP_N=5 ;;
    --top10)  TOP_N=10 ;;
    --*)      echo "Unknown flag: $arg" >&2; exit 1 ;;
    *)        POS_ARGS+=("$arg") ;;
  esac
done

TITLE="${POS_ARGS[0]:-}"
[[ -z "$TITLE" ]] && { echo "Usage: $0 [--radarr|--sonarr] [--raw|--topN] <title>" >&2; exit 1; }

case "$APP" in
  radarr) PORT=7878; API_PATH=movie ;;
  sonarr) PORT=8989; API_PATH=series ;;
esac

KEY=$(arr_apikey "/opt/appdata/${APP}" 2>/dev/null) || {
  echo "ERROR: Cannot read API key for ${APP} at /opt/appdata/${APP}/config.xml" >&2
  echo "  Has it been deployed + provisioned? (make deploy && make provision s=${APP})" >&2
  exit 1
}

# Fetch matching item(s)
ITEMS=$(curl -sf -H "X-Api-Key: ${KEY}" "http://localhost:${PORT}/api/v3/${API_PATH}" 2>/dev/null) || {
  echo "ERROR: Cannot reach ${APP} at :${PORT}" >&2; exit 1
}

MATCHES=$(echo "$ITEMS" | TITLE="$TITLE" python3 -c "
import json, sys, os
data = json.load(sys.stdin)
q = os.environ['TITLE'].lower()
for m in data:
    if q in m.get('title', '').lower():
        print(f\"{m['id']}|{m['title']}|{m.get('year','?')}\")
" 2>/dev/null)

[[ -z "$MATCHES" ]] && { echo "No matches for \"$TITLE\" in ${APP}." >&2; exit 1; }

show_releases() {
  while IFS='|' read -r MID MNAME YEAR; do
    echo "=== ${MNAME} (${YEAR}) ==="
    RELEASES=$(curl -sf -H "X-Api-Key: ${KEY}" "http://localhost:${PORT}/api/v3/release?${API_PATH}Id=${MID}" 2>/dev/null) || { echo "  (no releases available)" >&2; continue; }

    if [[ "$MODE" == "raw" ]]; then
      echo "$RELEASES" | python3 -m json.tool 2>/dev/null
      continue
    fi

    echo "$RELEASES" | TOP_N="$TOP_N" python3 -c "
import json, sys, os
data = json.load(sys.stdin)
releases = []
for r in data:
    releases.append({
        'title': r.get('title', ''),
        'sizeGB': r.get('size', 0) / 1e9,
        'seeders': r.get('seeders', 0),
        'indexer': r.get('indexer', ''),
        'quality': r.get('quality', {}).get('name', ''),
        'age': r.get('ageMinutes', 0) // 60,
        'protocol': r.get('protocol', ''),
    })
releases.sort(key=lambda x: -x['seeders'])
top_n = int(os.environ.get('TOP_N', '0'))
if top_n > 0:
    releases = releases[:top_n]
print(f'{\"Seed\":>6}  {\"Size\":>7}  {\"Age\":>4}  {\"Quality\":>18}  {\"Indexer\":>20}  Title')
print('-'*110)
for r in releases:
    proto = '*' if r['protocol'] == 'usenet' else ' '
    age = r['age']
    age_str = f'{age}h' if age < 99 else f'{age//24}d' if age < 99*24 else 'old'
    q = r['quality'] if r['quality'] else 'any'
    title = r['title'][:90]
    print(f'{r[\"seeders\"]:>5}{proto}  {r[\"sizeGB\"]:>6.1f}GB  {age_str:>4}  {q:>18}  {r[\"indexer\"]:>20}  {title}')
" 2>/dev/null
    echo
  done <<< "$MATCHES"
}

if $WATCH; then
  while true; do
    clear 2>/dev/null || true
    date '+%H:%M:%S'
    show_releases
    sleep 10
  done
else
  show_releases
fi
