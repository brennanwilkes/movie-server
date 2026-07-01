#!/usr/bin/env bash
# Query the controller's in-memory state to diagnose download/recovery issues.
# This reads the /api/downloads endpoint (snapshot refreshed every 5s) and
# /api/disk / /api/status for disk health and service status.
#
# Usage:
#   ./scripts/show-history.sh                  # one-shot summary
#   ./scripts/show-history.sh --watch           # refresh every 5s
#   ./scripts/show-history.sh --missing         # just the "Not found" / "Searching…" items
#   ./scripts/show-history.sh --attention       # just the Needs-attention items
#   ./scripts/show-history.sh --summary         # just the aggregate counts
#   ./scripts/show-history.sh --disk            # disk usage
#   ./scripts/show-history.sh --raw             # raw JSON from /api/downloads
set -euo pipefail
cd "$(dirname "$0")/.."

CONTROLLER="${CONTROLLER_PORT:-8088}"
BASE="http://localhost:${CONTROLLER}"

if ! curl -sf "$BASE/api/status" >/dev/null 2>&1; then
  echo "Controller not reachable at $BASE. Is it running?" >&2
  echo "  make ps && docker compose logs --tail=20 controller" >&2
  exit 1
fi

MODE="${1:-summary}"
WATCH=false
case "${MODE}" in
  --watch|watch)  WATCH=true; MODE=summary ;;
esac

fetch() {
  curl -sf "$BASE/api/downloads" 2>/dev/null || echo '{"items":[],"summary":{}}'
}

show_disk() {
  curl -sf "$BASE/api/disk" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
pct=d.get('used_pct',0)
g=1e9
print(f\"  Disk: {d['used_bytes']/g:.1f} GB / {d['total_bytes']/g:.1f} GB ({pct}% used)\")
print(f\"  Free: {d['free_bytes']/g:.1f} GB\")
if d.get('cap_bytes'):
    print(f\"  Cap:  {d['cap_bytes']/g:.1f} GB\")
" 2>/dev/null || echo "  (disk API unavailable)"
}

show_summary() {
  local data="$1"
  echo "$data" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'summary' in d and d['summary']:
    s=d['summary']
    c=s.get('counts',{})
    print('  Counts: ' + ', '.join(f'{k}={v}' for k,v in c.items()))
    b=s.get('bytes',{})
    g=1e9
    print('  Sizes:  ' + ', '.join(f'{k}={v/g:.1f}G' for k,v in b.items() if v))
    if s.get('remainingBytes'):
        print(f'  Remaining: {s[\"remainingBytes\"]/g:.1f} GB')
    if s.get('speedBytes'):
        print(f'  Speed: {s[\"speedBytes\"]/1e6:.1f} MB/s')
    if s.get('etaSeconds'):
        h=s['etaSeconds']//3600; m=(s['etaSeconds']%3600)//60
        print(f'  ETA: {h}h{m}m')
    if s.get('sizing'):
        print(f'  Still sizing: {s[\"sizing\"]}')
else:
    print('  (no summary)')
if d.get('masterPaused'):
    print('  *** MOVIE MODE ON (masterPaused=true) ***')
" 2>/dev/null
}

show_missing() {
  local data="$1"
  echo "$data" | python3 -c "
import json,sys
d=json.load(sys.stdin)
missing = [i for i in d.get('items',[]) if i.get('state') in ('Not found','Searching…')]
if not missing:
    print('  No missing items.')
else:
    for m in missing:
        rs=m.get('recoveryStatus','')
        rn=m.get('recoveryNext',0)
        rf=m.get('recoveryFails',0)
        rn_str = (' (' + str((rn - (d.get('ts',0) or 0))//60000) + ' min)') if rn and d.get('ts') else ''
        print(f\"  {m['source']}: {m['title']} — {m['state']} (fails={rf}, recovery={rs}{rn_str})\")
" 2>/dev/null
}

show_attention() {
  local data="$1"
  echo "$data" | python3 -c "
import json,sys
d=json.load(sys.stdin)
attn = [i for i in d.get('items',[]) if i.get('attention')]
if not attn:
    print('  No items needing attention.')
else:
    for a in attn:
        print(f\"  {a.get('source','?')}: {a['title']} — {a['state']}\")
" 2>/dev/null
}

show_raw() {
  python3 -m json.tool <<<"$1"
}

show_declined_blocked() {
  local data="$1"
  echo "$data" | python3 -c "
import json,sys
d=json.load(sys.stdin)
items = d.get('items',[])
declined = [i for i in items if i.get('state') == 'Declined']
if declined:
    print('  Declined (disk gate):')
    for i in declined:
        nb=i.get('neededBytes',0); fb=i.get('freeBytes',0)
        print(f\"    {i['title']} (needs {nb/1e9:.1f} GB, {fb/1e9:.1f} GB free)\")
" 2>/dev/null
}

case "${MODE}" in
  --raw|raw)      data=$(fetch); show_raw "$data" ;;
  --disk|disk)    show_disk ;;
  --missing|missing) data=$(fetch); show_missing "$data" ;;
  --attention|attention) data=$(fetch); show_attention "$data" ;;
  --declined|declined) data=$(fetch); show_declined_blocked "$data" ;;
  --summary|summary|*)
    if $WATCH; then
      exec watch -n 5 "
        echo '=== Controller State ==='
        echo '--- Disk ---'
        curl -sf $BASE/api/disk 2>/dev/null | python3 -c \"import json,sys; d=json.load(sys.stdin); print(f'  {d[\"used_bytes\"]/1e9:.1f} GB / {d[\"total_bytes\"]/1e9:.1f} GB ({d[\"used_pct\"]}% used), {d[\"free_bytes\"]/1e9:.1f} GB free')\" 2>/dev/null || echo '  (unavailable)'
        echo '--- Summary ---'
        curl -sf $BASE/api/downloads 2>/dev/null | python3 -c \"
import json,sys
d=json.load(sys.stdin)
s=d.get('summary',{})
c=s.get('counts',{})
if c: print('  ' + ', '.join(f'{k}={v}' for k,v in c.items()))
if d.get('masterPaused'): print('  *** MOVIE MODE ON ***')
\" 2>/dev/null || echo '  (unavailable)'
        echo '--- Missing (Not found / Searching) ---'
        curl -sf $BASE/api/downloads 2>/dev/null | python3 -c \"
import json,sys
d=json.load(sys.stdin)
for i in d.get('items',[]):
    if i.get('state') in ('Not found','Searching…'):
        rs=i.get('recoveryStatus','')
        rf=i.get('recoveryFails',0)
        print(f'  {i[\"source\"]}: {i[\"title\"]} — {i[\"state\"]} (fails={rf}, recovery={rs})')
\" 2>/dev/null
        echo '--- Needs Attention ---'
        curl -sf $BASE/api/downloads 2>/dev/null | python3 -c \"
import json,sys
d=json.load(sys.stdin)
for i in d.get('items',[]):
    if i.get('attention'): print(f'  {i[\"title\"]} — {i[\"state\"]}')
\" 2>/dev/null
      "
    else
      echo "=== Controller State ==="
      echo "--- Disk ---"
      show_disk
      data=$(fetch)
      echo "--- Summary ---"
      show_summary "$data"
      echo "--- Missing ---"
      show_missing "$data"
      echo "--- Needs Attention ---"
      show_attention "$data"
      echo "--- Declined ---"
      show_declined_blocked "$data"
    fi
    ;;
esac
