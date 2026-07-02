# SuggestArr — full IaC config, NO web wizard. The app's "setup wizard" only writes
# ${CONFIG}/suggestarr/config.yaml; we write that file directly and restart the container.
# Sourced by provision.sh (lib.sh + .env loaded). Idempotent.
#
# The ONE secret that can't be auto-discovered is TMDB_API_KEY (free key:
# https://www.themoviedb.org/settings/api) — set it in .env. Until it's set, this
# provisioner skips with a warning and SuggestArr just idles.
#
# Safety model: suggestions are filed through the request-only 'suggestarr' Jellyseerr user
# (provisioned by jellyseerr.sh), so every one lands in "Pending approval" — nothing
# auto-downloads. Conservative volume: 3 movie / 1 TV suggestions per run, daily at 03:00.
require python3
SA_CFG="${CONFIG:-/opt/appdata}/suggestarr/config.yaml"
if [[ ! -f "$SA_CFG" ]]; then
  warn "suggestarr: no config.yaml yet — start the container first (make deploy s=suggestarr)"
  return 0 2>/dev/null || exit 0
fi
if [[ -z "${TMDB_API_KEY:-}" ]]; then
  warn "suggestarr: TMDB_API_KEY is empty in .env — get a free key at themoviedb.org/settings/api, add it, then: make provision s=suggestarr"
  return 0 2>/dev/null || exit 0
fi
sa_jf_token=$(jellyfin_apikey suggestarr)
sa_seer_key=$(jq -r '.main.apiKey // empty' "${CONFIG:-/opt/appdata}/jellyseerr/settings.json")
[[ -n "$sa_jf_token" && "$sa_jf_token" != "null" && -n "$sa_seer_key" ]] || die "suggestarr: could not obtain Jellyfin/Jellyseerr API keys"

# config.yaml is owned by the container's root user — write it from INSIDE the container
# (docker group ≫ no sudo needed on the host). PyYAML ships with the app.
docker exec -i suggestarr python3 - <<PY
import yaml
p = '/app/config/config_files/config.yaml'
cfg = yaml.safe_load(open(p)) or {}
cfg.update({
    'SELECTED_SERVICE': 'jellyfin',
    'JELLYFIN_API_URL': 'http://${NUC_IP}:8096',   # Jellyfin is HOST-networked: IP, not DNS name
    'JELLYFIN_TOKEN': '${sa_jf_token}',
    'SEER_API_URL': 'http://jellyseerr:5055',      # suggestarr is on the compose bridge: DNS ok
    'SEER_TOKEN': '${sa_seer_key}',
    'SEER_USER_NAME': 'suggestarr',                # request-only user -> pending approvals
    'SEER_USER_PSW': '${QBIT_PASS}',
    'TMDB_API_KEY': '${TMDB_API_KEY}',
    'MAX_SIMILAR_MOVIE': '3',
    'MAX_SIMILAR_TV': '1',
    'CRON_TIMES': '0 3 * * *',
    'SETUP_COMPLETED': True,
})
yaml.safe_dump(cfg, open(p, 'w'), default_flow_style=False, sort_keys=True)
PY
docker restart suggestarr >/dev/null
ok "suggestarr: configured (Jellyfin history → TMDb similar → Jellyseerr pending approvals; daily 03:00, 3 movies + 1 show) — restarted"
