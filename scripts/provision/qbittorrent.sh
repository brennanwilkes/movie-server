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

# Set save paths + WebUI credentials. (qBittorrent has no native low-disk pause;
# the 20 GB loopback cap enforces the ceiling — it pauses torrents on the write error.)
prefs=$(jq -n --arg u "$QBIT_USER" --arg p "$QBIT_PASS" '{
  web_ui_username: $u,
  web_ui_password: $p,
  save_path: "/data/torrents/complete",
  temp_path_enabled: true,
  temp_path: "/data/torrents/incomplete",
  auto_tmm_enabled: true,
  category_changed_tmm_enabled: true,
  save_path_changed_tmm_enabled: true,
  auto_delete_mode: 0
}')
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
