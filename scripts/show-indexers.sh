#!/usr/bin/env bash
# Show Prowlarr indexer health — the thing to check FIRST when "nothing downloads" or a
# search comes back empty. Lists every indexer with enabled/tag/proxy state and recent
# failures, and can live-test each one or run a real cross-indexer search.
#
# Usage:
#   ./scripts/show-indexers.sh                 # list indexers + health warnings
#   ./scripts/show-indexers.sh --test          # live-test every enabled indexer (slow)
#   ./scripts/show-indexers.sh --search "term" # real search, results counted per indexer
#   ./scripts/show-indexers.sh --raw           # raw indexer JSON
#
# Background: public trackers behind Cloudflare (e.g. EZTV) MUST carry the 'flaresolverr'
# tag or they 403/blocked. A hard IP ban shows as "error code: 1006" and FlareSolverr
# can't fix it — swap the mirror or lean on Knaben (a 30+ site meta-aggregator). All of
# this is codified in scripts/provision/prowlarr.sh; re-run `make provision s=prowlarr`
# to reconcile drift.
set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/lib.sh
source .env 2>/dev/null || true

PROW="http://localhost:9696/api/v1"
key=$(arr_apikey /opt/appdata/prowlarr 2>/dev/null) || die "cannot read Prowlarr API key — deployed & provisioned? (make deploy && make provision s=prowlarr)"
curl -sf -o /dev/null "${PROW}/system/status" -H "X-Api-Key: ${key}" 2>/dev/null || die "Prowlarr unreachable on :9696 — is it running? (make ps)"

MODE="list"
SEARCH_TERM=""
case "${1:-}" in
  --test|test)     MODE=test ;;
  --raw|raw)       MODE=raw ;;
  --search|search) MODE=search; SEARCH_TERM="${2:-}"; [[ -z "$SEARCH_TERM" ]] && die "usage: $0 --search \"term\"" ;;
esac

pget() { curl -sf -H "X-Api-Key: ${key}" "${PROW}$1" 2>/dev/null; }

# tag id -> label map, so we can print "flaresolverr" instead of a bare number.
TAGS_JSON=$(pget /tag)

case "$MODE" in
  raw)
    pget /indexer | python3 -m json.tool
    ;;

  list)
    echo "=== Prowlarr indexers ==="
    pget /indexer | TAGS="$TAGS_JSON" python3 -c "
import json,sys,os
tags={t['id']:t['label'] for t in json.loads(os.environ['TAGS'])}
d=json.load(sys.stdin)
for i in sorted(d, key=lambda x: (not x['enable'], x['name'].lower())):
    tg=[tags.get(t,str(t)) for t in i.get('tags',[])]
    bu=next((f.get('value') for f in i.get('fields',[]) if f['name']=='baseUrl'), None)
    flag = 'on ' if i['enable'] else 'OFF'
    proxy = ' via[%s]' % ','.join(tg) if tg else ''
    print(f\"  [{flag}] {i['name']:<20} prio={i.get('priority',25):<3} {i.get('privacy','?'):<8}{proxy}\")
    if bu: print(f\"         url={bu}\")
"
    echo ""
    echo "=== Health ==="
    pget /health | python3 -c "
import json,sys
d=json.load(sys.stdin)
issues=[h for h in d if any(w in h.get('message','').lower() for w in ('indexer','flaresolv','cloudflare'))]
if not issues: print('  no indexer health warnings ✓')
for h in issues: print(f\"  {h['type'].upper()}: {h['message']}\")
"
    ;;

  test)
    echo "=== Live-testing enabled indexers (slow) ==="
    ids=$(pget /indexer | python3 -c "import json,sys;print(' '.join(str(i['id']) for i in json.load(sys.stdin) if i['enable']))")
    for id in $ids; do
      body=$(pget "/indexer/${id}")
      name=$(echo "$body" | python3 -c "import json,sys;print(json.load(sys.stdin)['name'])")
      resp=$(curl -sf -X POST "${PROW}/indexer/test" -H "X-Api-Key: ${key}" -H 'Content-Type: application/json' -d "$body" --max-time 60 2>/dev/null || echo '__ERR__')
      if [[ -z "$resp" ]]; then
        ok "${name}: PASS"
      else
        msg=$(echo "$resp" | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['errorMessage'][:90])" 2>/dev/null || echo "unreachable/timeout")
        warn "${name}: ${msg}"
      fi
    done
    ;;

  search)
    echo "=== Search: '${SEARCH_TERM}' (results per indexer) ==="
    q=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$SEARCH_TERM")
    pget "/search?query=${q}&type=search&limit=200" | python3 -c "
import json,sys
from collections import Counter
d=json.load(sys.stdin)
c=Counter(r.get('indexer') for r in d)
print(f'  total: {len(d)}')
for k,v in c.most_common(): print(f'    {k}: {v}')
if not d: print('  (no results — check --test and health above)')
"
    ;;
esac
