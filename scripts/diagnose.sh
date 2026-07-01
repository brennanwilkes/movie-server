#!/usr/bin/env bash
# Cross-service diagnostic tool: compares qBittorrent state, *arr queues, and
# the controller's aggregated view to find discrepancies and surface hidden problems.
#
# Usage:
#   ./scripts/diagnose.sh                        # full diagnosis
#   ./scripts/diagnose.sh --watch                # poll every 10s
#   ./scripts/diagnose.sh --qbit                 # qBittorrent torrent states only
#   ./scripts/diagnose.sh --queue                # *arr queue status
#   ./scripts/diagnose.sh --orphans              # unlinked torrents (in qBit, not in *arr)
set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/lib.sh
source .env 2>/dev/null || true

CONTROLLER="${CONTROLLER_PORT:-8088}"
BASE="http://localhost:${CONTROLLER}"
WATCH=false
MODE=all

for arg in "$@"; do
  case "$arg" in
    --watch)  WATCH=true ;;
    --qbit)   MODE=qbit ;;
    --queue)  MODE=queue ;;
    --orphans) MODE=orphans ;;
    --help)   echo "Usage: $0 [--watch|--qbit|--queue|--orphans]"; exit 0 ;;
  esac
done

require curl python3

# ── Read API keys from the controller's keys.env ──
KEYS=$(docker exec controller cat /config/keys.env 2>/dev/null || cat /opt/appdata/controller/keys.env 2>/dev/null) || {
  echo "Cannot read controller keys — is controller running?" >&2
  exit 1
}
eval "$(echo "$KEYS" | python3 -c "
import sys
for l in sys.stdin:
  l = l.strip()
  if not l or l.startswith('#'): continue
  k,_,v = l.partition('=')
  v = v.strip('\";')
  print(f'{k}={v}')
")"

CONTROLLER_UP=false
curl -sf "$BASE/api/status" >/dev/null 2>&1 && CONTROLLER_UP=true

# ── qBittorrent: cookie login + fetch all torrents ──
qbit_login() {
  local cookie
  cookie=$(curl -sf -c - "http://localhost:8080/api/v2/auth/login" \
    -d "username=${QBIT_USER}&password=${QBIT_PASS}" 2>/dev/null | grep SID | awk '{print $NF}')
  echo "$cookie"
}

QBIT_COOKIE=""
qbit_fetch() {
  local path="$1" cookie="${QBIT_COOKIE:-}"
  if [[ -z "$cookie" ]]; then
    cookie=$(qbit_login)
    QBIT_COOKIE="$cookie"
  fi
  curl -sf "http://localhost:8080${path}" -b "SID=${cookie}" 2>/dev/null
}

# ── *arr helpers ──
arr_get() {
  local app="$1" path="$2"
  local port="${3:-7878}"
  local key
  case "$app" in
    radarr) key="$RADARR_KEY"; port=7878 ;;
    sonarr) key="$SONARR_KEY"; port=8989 ;;
  esac
  curl -sf -H "X-Api-Key: ${key}" "http://localhost:${port}/api/v3${path}" 2>/dev/null
}

# ============================================================================
#  QBITTORRENT STATE
# ============================================================================
show_qbit() {
  echo "=== qBittorrent: Torrent States ==="
  local data
  data=$(qbit_fetch "/api/v2/torrents/info") || { echo "  (qBittorrent unreachable)" >&2; return; }

  echo "$data" | python3 -c "
import json, sys
data = json.load(sys.stdin)
by_state = {}
cats = {}
total = len(data)
for t in data:
    s = t.get('state', 'unknown')
    by_state.setdefault(s, []).append(t)
    c = t.get('category', '') or '(none)'
    cats[c] = cats.get(c, 0) + 1
print(f'  Total torrents: {total}')
print(f'  Categories: ' + ', '.join(f'{k}={v}' for k,v in sorted(cats.items())))
print()
for s in sorted(by_state.keys()):
    ts = by_state[s]
    print(f'  {s}: {len(ts)}')
    # Show first 3 names for unusual states
    if s in ('missingFiles', 'error', 'stalledDL', 'metaDL'):
        for t in ts[:5]:
            print(f'    {t.get(\"name\",\"?\")[:60]}  seeds={t.get(\"num_seeds\",0)} prog={t.get(\"progress\",0)*100:.0f}% cat={t.get(\"category\",\"?\")}')
        if len(ts) > 5: print(f'    ... and {len(ts)-5} more')
" 2>/dev/null
}

# ============================================================================
#  *ARR QUEUE STATUS
# ============================================================================
show_queues() {
  for app in radarr sonarr; do
    local port; [[ "$app" == "radarr" ]] && port=7878 || port=8989
    local data
    data=$(arr_get "$app" "/queue?pageSize=500") || { echo "=== ${app^} Queue ==="; echo "  (unreachable)"; continue; }

    echo "=== ${app^} Queue ==="
    echo "$data" | python3 -c "
import json, sys
data = json.load(sys.stdin)
records = data.get('records', [])
print(f'  Items in queue: {len(records)}')
for r in records:
    tds = r.get('trackedDownloadState', '?')
    tdstatus = r.get('trackedDownloadStatus', '?')
    title = r.get('title', '?')[:55]
    err = r.get('errorMessage', '') or ''
    if r.get('statusMessages'):
        msgs = [m.get('messages', []) for m in r['statusMessages'] if isinstance(m, dict)]
        err = '; '.join([m for sub in msgs for m in sub])[:80]
    print(f'  [{tds:15s}] [{tdstatus:7s}] {title}  err={err[:60]}')
" 2>/dev/null
    echo
  done
}

# ============================================================================
#  ORPHAN / DISCREPANCY DETECTION
# ============================================================================
show_orphans() {
  echo "=== Controller vs qBittorrent Discrepancies ==="

  local qdata cdata
  qdata=$(qbit_fetch "/api/v2/torrents/info") || { echo "  (qBittorrent unreachable)" >&2; return; }
  cdata=$(curl -sf "$BASE/api/downloads" 2>/dev/null) || { echo "  (Controller unreachable)" >&2; return; }

  echo "$qdata" "$cdata" | python3 -c "
import json, sys

qdata = json.loads(sys.stdin.readline())
cdata = json.loads(sys.stdin.readline())

# Build controller's hash set
c_hashes = set()
c_states = {}
for i in cdata.get('items', []):
    h = i.get('hash', '')
    if h:
        c_hashes.add(h.lower())
        c_states[h.lower()] = i.get('state', '')

# Build qBit's hash set
q_hashes = {}
for t in qdata:
    h = t.get('hash', '').lower()
    if h:
        q_hashes[h] = t

# qBit torrents NOT in controller
in_qbit_not_controller = []
for h, t in q_hashes.items():
    if h not in c_hashes and h != 'missing:':
        in_qbit_not_controller.append(t)

print(f'  Torrents in qBit but NOT in controller view: {len(in_qbit_not_controller)}')
for t in in_qbit_not_controller[:10]:
    s = t.get('state', '?')
    name = t.get('name', '?')[:55]
    cat = t.get('category', '')
    prog = t.get('progress', 0) * 100
    print(f'    {s:15s} {prog:3.0f}%  cat={cat:10s} {name}')
if len(in_qbit_not_controller) > 10:
    print(f'    ... and {len(in_qbit_not_controller)-10} more')

# Controller states where qBit has 'error' or 'missingFiles'
print()
print(f'  Controller state vs qBit state discrepancies:')
count = 0
for h, t in q_hashes.items():
    if h in c_states:
        qs = t.get('state', '?')
        cs = c_states[h]
        if (qs in ('error', 'missingFiles') and cs != 'Needs attention') or \
           (cs == 'Needs attention' and qs not in ('error', 'missingFiles')):
            count += 1
            if count <= 5:
                print(f'    qBit={qs:15s} ctrl={cs:15s} {t.get(\"name\",\"?\")[:50]}')
if count == 0:
    print('    (none found)')
elif count > 5:
    print(f'    ... and {count-5} more')
" 2>/dev/null
}

# ============================================================================
#  CONTROLLER STATE (quick summary)
# ============================================================================
show_controller() {
  if ! $CONTROLLER_UP; then echo "  (controller unreachable)"; return; fi

  echo "=== Controller Summary ==="
  curl -sf "$BASE/api/downloads" 2>/dev/null | python3 -c "
import json, sys
d = json.load(sys.stdin)
s = d.get('summary', {})
c = s.get('counts', {})
print('  Counts: ' + ', '.join(f'{k}={v}' for k,v in c.items()))
if d.get('masterPaused'): print('  *** MOVIE MODE ON ***')
# List by state
items = d.get('items', [])
by_state = {}
for i in items:
    st = i['state']
    by_state[st] = by_state.get(st, 0) + 1
print('  By state: ' + ', '.join(f'{k}={v}' for k,v in sorted(by_state.items())))
" 2>/dev/null
}

# ============================================================================
#  DISK
# ============================================================================
show_disk() {
  if ! $CONTROLLER_UP; then return; fi
  curl -sf "$BASE/api/disk" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
g=1e9
print(f'  Disk: {d[\"used_bytes\"]/g:.1f} GB / {d[\"total_bytes\"]/g:.1f} GB ({d[\"used_pct\"]}%)')
print(f'  Free: {d[\"free_bytes\"]/g:.1f} GB')
" 2>/dev/null || echo "  (disk API unavailable)"
}

# ============================================================================
#  MAIN
# ============================================================================
if $WATCH; then
  exec watch -n 10 "
    echo '=== Site Diagnostics ==='
    echo '--- Disk ---'
    curl -sf $BASE/api/disk 2>/dev/null | python3 -c \"import json,sys; d=json.load(sys.stdin); print(f'  {d[\"used_bytes\"]/1e9:.1f}GB / {d[\"total_bytes\"]/1e9:.1f}GB ({d[\"used_pct\"]}%)')\" 2>/dev/null || echo '  (unavailable)'
    echo '--- Controller ---'
    curl -sf $BASE/api/downloads 2>/dev/null | python3 -c \"import json,sys; d=json.load(sys.stdin); s=d.get('summary',{}); c=s.get('counts',{}); print('  ' + ', '.join(f'{k}={v}' for k,v in c.items()))\" 2>/dev/null
  "
fi

case "$MODE" in
  all)
    echo "=== Diagnostic Report ==="
    echo ""
    show_disk
    echo ""
    show_controller
    echo ""
    show_qbit
    echo ""
    show_queues
    echo ""
    show_orphans
    ;;
  qbit)
    show_qbit
    ;;
  queue)
    show_queues
    ;;
  orphans)
    show_orphans
    ;;
esac
