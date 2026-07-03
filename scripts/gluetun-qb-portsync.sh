#!/bin/sh
# gluetun-qb-portsync — keep qBittorrent's listening port equal to the port
# ProtonVPN forwards via NAT-PMP, so inbound peer connections (seeding) work.
#
# Runs inside gluetun's network namespace (network_mode: service:gluetun in
# docker-compose.vpn.yml), so:
#   • qBittorrent's WebUI is reachable at 127.0.0.1:8080, and
#   • gluetun's forwarded-port file is read from the shared /gluetun volume.
#
# gluetun re-negotiates the forwarded port periodically (and on reconnect); this
# loop notices the file change and re-applies it. Idempotent — only calls the API
# when the port actually changes.
set -u

QB="http://127.0.0.1:8080"
PORT_FILE="${PORT_FILE:-/gluetun/forwarded_port}"
QUSER="${QBIT_USER:-brennan}"
QPASS="${QBIT_PASS:-brennan}"
INTERVAL="${INTERVAL:-30}"
COOKIE=/tmp/qbc
last=""

log() { echo "portsync: $*"; }

# qBittorrent bypasses auth for localhost by default, but we log in anyway so this
# keeps working even if that option is off. Cookie is refreshed on each apply.
login() {
  curl -fsS -c "$COOKIE" --referer "$QB" \
    --data "username=${QUSER}&password=${QPASS}" \
    "$QB/api/v2/auth/login" >/dev/null 2>&1
}

# Set listen_port + disable random port and UPnP (the VPN forwards a fixed port;
# UPnP/random would fight it).
apply() {
  curl -fsS -b "$COOKIE" --referer "$QB" \
    --data-urlencode "json={\"listen_port\":$1,\"random_port\":false,\"upnp\":false}" \
    "$QB/api/v2/app/setPreferences" >/dev/null 2>&1
}

log "watching $PORT_FILE (every ${INTERVAL}s)"
while :; do
  if [ -r "$PORT_FILE" ]; then
    p="$(tr -dc '0-9' < "$PORT_FILE" 2>/dev/null)"
    if [ -n "$p" ] && [ "$p" != "0" ] && [ "$p" != "$last" ]; then
      if login && apply "$p"; then
        log "qBittorrent listen_port set to $p"
        last="$p"
      else
        log "failed to set port=$p (qBittorrent not ready?) — will retry"
      fi
    fi
  fi
  sleep "$INTERVAL"
done
