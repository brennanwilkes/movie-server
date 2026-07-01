#!/usr/bin/env bash
# Query Docker logs for any service in the stack with filtering.
# Usage:
#   ./scripts/query-logs.sh                    # list available services
#   ./scripts/query-logs.sh radarr             # last 100 lines
#   ./scripts/query-logs.sh controller --since "1h"
#   ./scripts/query-logs.sh controller --since "30m" --tail 50
#   ./scripts/query-logs.sh controller --since "2026-06-30T12:00:00"
#   ./scripts/query-logs.sh controller --grep "arrSweep|diskGate"
#   ./scripts/query-logs.sh controller --watch  # live tail
set -euo pipefail
cd "$(dirname "$0")/.."

SERVICES=(controller jellyfin qbittorrent radarr sonarr prowlarr bazarr jellyseerr flaresolverr)

if [ $# -eq 0 ] || [[ "${1:-}" == "--help" ]]; then
  echo "Services: ${SERVICES[*]}"
  echo "Usage: $0 <service> [docker logs options]"
  echo "  --grep PATTERN  filter output with grep (uses ripgrep if available)"
  echo "  --watch         run in watch mode (refresh every 5s)"
  exit 0
fi

SERVICE="$1"
shift

WATCH=false
GREP=""
ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --watch) WATCH=true; shift ;;
    --grep=*) GREP="${1#--grep=}"; shift ;;
    --grep) GREP="$2"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

VALID=false
for s in "${SERVICES[@]}"; do [ "$SERVICE" = "$s" ] && VALID=true && break; done
$VALID || { echo "Unknown service: $SERVICE. Valid: ${SERVICES[*]}" >&2; exit 1; }

if $WATCH; then
  if [ -n "$GREP" ]; then
    exec watch -n 5 "docker compose logs --tail=50 ${ARGS[*]} $SERVICE 2>/dev/null | grep -i --color=always '$GREP' | tail -50"
  else
    exec watch -n 5 "docker compose logs --tail=50 ${ARGS[*]} $SERVICE 2>/dev/null | tail -50"
  fi
fi

if [ -n "$GREP" ]; then
  if command -v rg &>/dev/null; then
    docker compose logs "${ARGS[@]}" "$SERVICE" 2>/dev/null | rg -i "$GREP"
  else
    docker compose logs "${ARGS[@]}" "$SERVICE" 2>/dev/null | grep -i "$GREP"
  fi
else
  exec docker compose logs "${ARGS[@]}" "$SERVICE"
fi
