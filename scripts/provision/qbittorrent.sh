# qBittorrent — set WebUI creds + save paths + radarr/sonarr categories. Idempotent.
# Sourced by provision.sh (lib.sh + .env loaded).
QB="http://localhost:8080"
wait_http "$QB" 90
jar=$(mktemp)

qb_login() {  # username password ; stores the session cookie in $jar
  curl -s -o /dev/null -c "$jar" --data-urlencode "username=$1" --data-urlencode "password=$2" "$QB/api/v2/auth/login"
}
qb_authed() {  # true if the current cookie is authenticated (this version returns 204, no "Ok." body)
  [[ "$(curl -s -b "$jar" "$QB/api/v2/app/version")" == v* ]]
}

# Log in with our desired creds (idempotent re-runs); first run falls back to the
# per-session temp password qBittorrent prints to its log.
qb_login "$QBIT_USER" "$QBIT_PASS"
if ! qb_authed; then
  temp=$(docker logs qbittorrent 2>&1 | grep -oP 'temporary password is provided for this session: \K\S+' | tail -1)
  [[ -n "$temp" ]] || die "qBittorrent: '$QBIT_USER/$QBIT_PASS' rejected and no temp password in logs — 'docker restart qbittorrent' for a fresh one"
  qb_login "admin" "$temp"
  qb_authed || die "qBittorrent: temp-password login failed"
  log "  logged in with temp password (first run)"
fi

# Set save paths + WebUI credentials + throughput/concurrency tuning. Data drive is an 8 TB USB
# disk, so disk isn't the limiter. Concurrency notes (NUC = 2-core/4-thread i5-6260U):
#   - More active downloads = more throughput, because the gain comes from running many torrents
#     in parallel (each high-seed one alone hit ~10 MB/s; 18 active reached ~45 MB/s at load ~6).
#     Higher slots ALSO surface high-seed torrents stuck behind low-seed ones in the queue.
#   - dont_count_slow_torrents keeps a dead-seeded torrent from squatting an active slot.
#   - Share limits (ratio 2.0 OR 14 days seeding, then stop): without them every completed
#     torrent queued for upload FOREVER (373 stuck queuedUP at audit time) — they never met a
#     goal so never dequeued. Stopping is safe: library files are hardlinks, nothing is deleted.
#   - The CPU risk is NOT the downloading (qBittorrent ~36%); it's MANY titles importing+being
#     analysed by Jellyfin ffmpeg at once (the one-time storm that pegged the NUC). That backlog
#     is transient. Until Quick Sync HW transcode is enabled (see memory), avoid dumping a huge
#     well-seeded batch that finishes faster than Jellyfin can analyse. 12 is a safe steady default.
prefs=$(jq -n --arg u "$QBIT_USER" --arg p "$QBIT_PASS" '{
  web_ui_username: $u,
  web_ui_password: $p,
  web_ui_csrf_protection_enabled: false,
  web_ui_host_header_validation_enabled: false,
  save_path: "/data/torrents/complete",
  temp_path_enabled: true,
  temp_path: "/data/torrents/incomplete",
  auto_tmm_enabled: true,
  category_changed_tmm_enabled: true,
  save_path_changed_tmm_enabled: true,
  auto_delete_mode: 0,
  queueing_enabled: true,
  add_stopped_enabled: false,
  max_active_downloads: 12,
  max_active_torrents: 25,
  max_active_uploads: 8,
  max_uploads_per_torrent: 6,
  max_ratio_enabled: true,
  max_ratio: 2.0,
  max_seeding_time_enabled: true,
  max_seeding_time: 10080,
  max_ratio_act: 0,
  dont_count_slow_torrents: true,
  slow_torrent_dl_rate_threshold: 50,
  slow_torrent_ul_rate_threshold: 50,
  slow_torrent_inactive_timer: 60,
  random_port: false,
  upnp: (env.QBIT_HOST != "gluetun")
}')
# When qBittorrent rides the VPN (QBIT_HOST=gluetun) the listening port is the one
# ProtonVPN forwards, kept in sync by the gluetun-qb-portsync sidecar — so UPnP/NAT-PMP
# must be OFF here (they would fight the forwarded port). In direct mode UPnP stays on.
curl -s -b "$jar" --data-urlencode "json=$prefs" "$QB/api/v2/app/setPreferences" >/dev/null
ok "WebUI creds + save paths set ($QBIT_USER / save=/data/torrents/complete)"

# Re-auth in case the password just changed, then ensure categories exist.
qb_login "$QBIT_USER" "$QBIT_PASS"
existing=$(curl -s -b "$jar" "$QB/api/v2/torrents/categories")
for cat in radarr sonarr; do
  mkdir -p "/data/torrents/complete/$cat"   # so Radarr/Sonarr's path-exists check passes
  if echo "$existing" | jq -e --arg c "$cat" 'has($c)' >/dev/null 2>&1; then
    curl -s -b "$jar" --data-urlencode "category=$cat" --data-urlencode "savePath=/data/torrents/complete/$cat" "$QB/api/v2/torrents/editCategory" >/dev/null
    ok "category '$cat' present (path updated)"
  else
    curl -s -b "$jar" --data-urlencode "category=$cat" --data-urlencode "savePath=/data/torrents/complete/$cat" "$QB/api/v2/torrents/createCategory" >/dev/null
    ok "category '$cat' created -> /data/torrents/complete/$cat"
  fi
done
rm -f "$jar"
