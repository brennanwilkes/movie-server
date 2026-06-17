#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

case "${1:-stop}" in
  stop)     # remove containers, keep app-config AND media (images stay cached)
    docker compose down ;;
  clean)    # also wipe per-app config, but KEEP media (images stay cached)
    docker compose down
    sudo rm -rf "${CONFIG:?}/"* ;;
  destroy)  # nuke EVERYTHING: containers, networks, config, media, image, AND images
    read -rp "Deletes containers, images, config AND ALL MEDIA in $DATA. Type 'destroy': " c
    [[ "$c" == "destroy" ]] || { echo "Aborted."; exit 1; }
    docker compose down -v --rmi all
    if [[ -n "${DATA_IMG:-}" ]]; then          # tear down the loopback cap
      mountpoint -q "$DATA" && sudo umount "$DATA"
      sudo sed -i "\# $DATA ext4 loop#d" /etc/fstab
      sudo rm -f "$DATA_IMG"
    fi
    sudo rm -rf "${CONFIG:?}" "${DATA:?}" ;;
  *) echo "usage: teardown.sh [stop|clean|destroy]"; exit 1 ;;
esac
