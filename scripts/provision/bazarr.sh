# Bazarr — connect to Radarr/Sonarr (config.yaml) + enable the OpenSubtitles provider if
# creds are in .env. Idempotent. NOTE: a language profile lives in Bazarr's DB and the
# provider needs a free OpenSubtitles.com account — see the post-step note in the plan.
BZ_CONF=/opt/appdata/bazarr/config/config.yaml
[[ -f "$BZ_CONF" ]] || die "bazarr config.yaml not found — start the container first"
rkey=$(arr_apikey /opt/appdata/radarr)
skey=$(arr_apikey /opt/appdata/sonarr)

python3 - "$BZ_CONF" "$rkey" "$skey" "${OPENSUBTITLES_USER:-}" "${OPENSUBTITLES_PASS:-}" <<'PY'
import sys, yaml
conf, rkey, skey, osu, osp = sys.argv[1:6]
c = yaml.safe_load(open(conf)) or {}
c.setdefault('general', {})
c['general']['use_radarr'] = True
c['general']['use_sonarr'] = True
c.setdefault('radarr', {}).update({'ip':'radarr','port':7878,'base_url':'/','ssl':False,'apikey':rkey})
c.setdefault('sonarr', {}).update({'ip':'sonarr','port':8989,'base_url':'/','ssl':False,'apikey':skey})
if osu and osp:
    # Bazarr reads the enabled list from general.enabled_providers; creds live at the
    # TOP-LEVEL opensubtitlescom key.
    en = c.setdefault('general', {}).get('enabled_providers') or []
    if 'opensubtitlescom' not in en: en.append('opensubtitlescom')
    c['general']['enabled_providers'] = en
    c.setdefault('opensubtitlescom', {}).update({'username':osu,'password':osp,'use_hash':True})
    # tidy any stray keys an earlier version may have written under `providers`
    if isinstance(c.get('providers'), dict):
        c['providers'].pop('enabled_providers', None)
        c['providers'].pop('opensubtitlescom', None)
    print('  provider opensubtitlescom enabled (creds set)')
else:
    print('  no OpenSubtitles creds in .env — provider left unset (sub search needs an account)')
yaml.safe_dump(c, open(conf,'w'), default_flow_style=False, sort_keys=False)
PY
ok "bazarr: config.yaml wired to Radarr + Sonarr"

docker restart bazarr >/dev/null
wait_http "http://localhost:6767" 90
bkey=$(python3 -c "
import yaml
def find(d):
    if isinstance(d, dict):
        for k, v in d.items():
            if k == 'apikey' and isinstance(v, str) and len(v) >= 32: return v
            r = find(v)
            if r: return r
    return None
print(find(yaml.safe_load(open('$BZ_CONF'))) or '')")
sleep 3
info=$(curl -s -H "X-API-KEY: $bkey" "http://localhost:6767/api/system/status")
rv=$(echo "$info" | jq -r '.data.radarr_version // ""')
sv=$(echo "$info" | jq -r '.data.sonarr_version // ""')
[[ -n "$rv" ]] && ok "bazarr: connected (radarr $rv, sonarr $sv)" \
  || warn "bazarr: connection not confirmed yet (Radarr/Sonarr may still be initializing)"

# Language profile (English) + set as default for movies & series. Idempotent.
BZ="http://localhost:6767"
if [[ "$(curl -s -H "X-API-KEY: $bkey" "$BZ/api/system/languages/profiles" | jq 'length')" -gt 0 ]]; then
  ok "bazarr: language profile present"
else
  prof='[{"profileId":1,"name":"English","items":[{"id":1,"language":"en","audio_exclude":"False","hi":"False","forced":"False"}],"cutoff":null,"mustContain":[],"mustNotContain":[],"originalFormat":false,"tag":null}]'
  curl -s -o /dev/null -H "X-API-KEY: $bkey" -X POST "$BZ/api/system/settings" \
    --data-urlencode 'languages-enabled=en' \
    --data-urlencode "languages-profiles=$prof" \
    --data-urlencode 'settings-general-serie_default_enabled=true' \
    --data-urlencode 'settings-general-serie_default_profile=1' \
    --data-urlencode 'settings-general-movie_default_enabled=true' \
    --data-urlencode 'settings-general-movie_default_profile=1'
  ok "bazarr: English language profile created + set as default"
fi
