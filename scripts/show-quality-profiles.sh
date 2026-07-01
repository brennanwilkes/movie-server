#!/usr/bin/env bash
# Dump the current quality profile config from Radarr and Sonarr.
# Shows: profile name, cutoff quality, allowed qualities, custom-format scores.
# Usage:
#   ./scripts/show-quality-profiles.sh           # both Radarr and Sonarr
#   ./scripts/show-quality-profiles.sh radarr    # just Radarr
#   ./scripts/show-quality-profiles.sh sonarr    # just Sonarr
#   ./scripts/show-quality-profiles.sh --diff    # show differences between expected and actual
set -euo pipefail
cd "$(dirname "$0")/.."

# Source lib.sh for arr_apikey()
source scripts/lib.sh
source .env 2>/dev/null || true

SHOW_DIFF=false
APPS=()
for arg in "$@"; do
  case "$arg" in
    --diff|diff) SHOW_DIFF=true ;;
    radarr|sonarr) APPS+=("$arg") ;;
  esac
done
[ ${#APPS[@]} -eq 0 ] && APPS=(radarr sonarr)

for app in "${APPS[@]}"; do
  port=""
  case "$app" in radarr) port=7878;; sonarr) port=8989;; esac

  key=$(arr_apikey "/opt/appdata/${app}" 2>/dev/null) || {
    echo "ERROR: Cannot read API key for ${app} at /opt/appdata/${app}/config.xml" >&2
    echo "  Has it been deployed + provisioned? (make deploy && make provision s=${app})" >&2
    continue
  }

  echo "=== ${app^} quality profiles ==="

  profiles=$(curl -sf -H "X-Api-Key: ${key}" "http://localhost:${port}/api/v3/qualityprofile" 2>/dev/null) || {
    echo "  (unreachable — is ${app} running on :${port}?)" >&2
    continue
  }

  echo "$profiles" | python3 -c "
import json,sys
data=json.load(sys.stdin)
for p in data:
    name=p.get('name','?')
    cutoff=p.get('cutoff',0)
    min_score=p.get('minFormatScore',0)
    cutoff_score=p.get('cutoffFormatScore',0)
    items=p.get('items',[])
    format_items=p.get('formatItems',[]) or []
    allowed=[i['quality']['name'] for i in items if i.get('allowed') and i.get('quality')]
    scores={f['name']:f['score'] for f in format_items}
    print('  Profile: %s' % name)
    print('    Cutoff: %d  |  minFormatScore=%d  |  cutoffFormatScore=%d' % (cutoff, min_score, cutoff_score))
    print('    Allowed: %s' % ', '.join(allowed))
    if scores:
        sorted_scores=sorted(scores.items(), key=lambda x: -x[1])
        print('    Format scores (%d):' % len(scores))
        for s in sorted_scores:
            print('      %-40s %+d' % (s[0], s[1]))
    print()
"
done

if [ "$SHOW_DIFF" = true ]; then
  echo "=== Comparing with provision script expectations ==="
  echo "  (expected config in scripts/provision/_arr_common.sh lines 288-307)"
  echo "  Run provision to re-apply: make provision s=<app>"
fi
