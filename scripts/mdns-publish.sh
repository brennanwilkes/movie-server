#!/usr/bin/env bash
# Publish a clean mDNS (.local) alias for this host's CURRENT LAN IPv4, so phones on
# the wifi can reach the dashboard by name (e.g. http://movies.local) with zero DNS
# server, router config, or per-device setup. Run persistently via systemd
# (scripts/movie-mdns.service). Re-checks the IP every 30s and re-publishes if DHCP
# ever changes it, so the name keeps working without a static IP or router reservation.
set -uo pipefail
cd "$(dirname "$0")/.."
[[ -f .env ]] && { set -a; source .env 2>/dev/null || true; set +a; }
# Space-separated list; each name must end in .local. One avahi-publish per name.
NAMES="${MDNS_NAME:-movies.local}"

children=()
cleanup() { for p in "${children[@]:-}"; do kill "$p" 2>/dev/null; done; exit 0; }
trap cleanup TERM INT

last=""
while true; do
  ip=$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9.]+' | head -1)
  if [[ -n "$ip" && "$ip" != "$last" ]]; then
    for p in "${children[@]:-}"; do kill "$p" 2>/dev/null; done
    children=()
    for name in $NAMES; do
      avahi-publish -a -R "$name" "$ip" &
      children+=("$!")
    done
    last="$ip"
    logger -t movie-mdns "publishing [$NAMES] -> $ip" 2>/dev/null || true
  fi
  sleep 30
done
