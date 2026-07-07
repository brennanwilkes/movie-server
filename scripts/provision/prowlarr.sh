# Prowlarr — indexer manager. Set UI auth + register Radarr/Sonarr as applications so
# indexers added here auto-sync to them. (Adding actual indexers = deferred "real indexer
# strategy" — see plan §8.) Idempotent.
PROW="http://localhost:9696/api/v1"
# Wait for the app FIRST — on a fresh install config.xml may not exist until it has started.
wait_http "http://localhost:9696/api/v1/system/status" 90
key=$(arr_apikey /opt/appdata/prowlarr)
[[ -n "$key" ]] || die "prowlarr: empty <ApiKey> in /opt/appdata/prowlarr/config.xml"
PG=(curl -s -H "X-Api-Key: ${key}")
PJ=(curl -s -H "X-Api-Key: ${key}" -H 'Content-Type: application/json')

# UI auth = brennan/brennan, bypassed on LAN.
host=$("${PG[@]}" "${PROW}/config/host")
if [[ "$(echo "$host" | jq -r '.authenticationMethod')" == "forms" ]]; then
  ok "prowlarr: UI auth already forms"
else
  echo "$host" | jq --arg u "$QBIT_USER" --arg p "$QBIT_PASS" \
    '.authenticationMethod="forms" | .authenticationRequired="disabledForLocalAddresses" | .username=$u | .password=$p | .passwordConfirmation=$p' \
    | "${PJ[@]}" -X PUT "${PROW}/config/host" -d @- >/dev/null
  [[ "$("${PG[@]}" "${PROW}/config/host" | jq -r '.authenticationMethod')" == "forms" ]] \
    || die "prowlarr: UI auth did not persist — check the PUT response"
  ok "prowlarr: UI auth set to forms (brennan, bypassed on LAN)"
fi

# Log level = info (reduces CPU on 2c/4t Skylake; keep API-accessible diagnostics).
ll=$("${PG[@]}" "${PROW}/config/host" | jq -r '.logLevel // ""')
if [[ "$ll" == "info" ]]; then
  ok "prowlarr: log level already info"
else
  echo "$("${PG[@]}" "${PROW}/config/host")" | jq '.logLevel="info"' \
    | "${PJ[@]}" -X PUT "${PROW}/config/host" -d @- >/dev/null
  [[ "$("${PG[@]}" "${PROW}/config/host" | jq -r '.logLevel')" == "info" ]] \
    || die "prowlarr: log level change did not persist"
  ok "prowlarr: log level set to info (was ${ll})"
fi

# Install the year-strip TPB definition (a Custom/ clone, not an in-place patch).
# WHY a Custom def: Prowlarr regenerates the cached built-in defs
# (/config/Definitions/*.yml) from its canonical copies whenever they differ,
# silently reverting any in-place edit on the next restart (verified 2026-07-02 —
# the earlier in-place patch here NEVER survived). Files under Definitions/Custom/
# are the only ones Prowlarr leaves untouched. A Custom def can't reuse the
# built-in's id/name (Prowlarr rejects the collision), so this lands as a SECOND
# TPB indexer, "The Pirate Bay (year-strip)", alongside the stock one.
#
# What it does: adds a keywordsfilter — placed FIRST, before the built-in filter
# that collapses spaces to '.' — that strips a trailing 19xx/20xx release year.
# Radarr/Sonarr always append their metadata year to the query, and that year
# sometimes differs from the year in the actual release title on TPB (e.g. Radarr
# has The African Queen at 1952, but TPB titles it 1951, its true UK release year).
# Dropping the trailing year lets the title match. Radarr still parses every result
# and rejects wrong-movie/wrong-year releases, so correctness is unaffected. Only a
# year at the very END is removed, so embedded title years (1917, 2001, 2049) are
# safe — the appended metadata year is always the trailing token. See YEAR_BUG.md.
CUSTOM_SRC="$(dirname "${BASH_SOURCE[0]}")/custom_tpb_definition.yml"
CUSTOM_DST="${CONFIG:-/opt/appdata}/prowlarr/Definitions/Custom/thepiratebayys.yml"
mkdir -p "$(dirname "$CUSTOM_DST")"
if [[ -f "$CUSTOM_DST" ]] && cmp -s "$CUSTOM_SRC" "$CUSTOM_DST"; then
  ok "prowlarr: year-strip TPB definition already installed"
else
  cp "$CUSTOM_SRC" "$CUSTOM_DST"
  ok "prowlarr: installed year-strip TPB definition → Custom/thepiratebayys.yml"
fi
# Prowlarr scans Custom/ only at startup; if the def isn't in the indexer schema
# yet, restart so it loads before we register it as an indexer below.
if ! "${PG[@]}" "${PROW}/indexer/schema" | jq -e 'any(.[]; .definitionName=="thepiratebayys")' >/dev/null 2>&1; then
  docker restart prowlarr >/dev/null 2>&1 || true
  wait_http "http://localhost:9696/api/v1/system/status" 90
  ok "prowlarr: restarted to load year-strip definition into schema"
fi

# Register Radarr + Sonarr as applications (built from live schema).
existing=$("${PG[@]}" "${PROW}/applications")
prow_add_app() {  # implementation  appBaseUrl  appApiKey
  if echo "$existing" | jq -e --arg i "$1" 'any(.[]; .implementation==$i)' >/dev/null; then
    ok "prowlarr: ${1} application present"; return
  fi
  local app
  app=$("${PG[@]}" "${PROW}/applications/schema" | jq --arg i "$1" --arg burl "$2" --arg ak "$3" \
    '[.[]|select(.implementation==$i)][0]
     | .name=$i | .syncLevel="fullSync"
     | .fields = (.fields | map(
         if   .name=="prowlarrUrl" then .value="http://prowlarr:9696"
         elif .name=="baseUrl"     then .value=$burl
         elif .name=="apiKey"      then .value=$ak
         else . end))')
  "${PJ[@]}" -X POST "${PROW}/applications" -d "$app" >/dev/null
  ok "prowlarr: ${1} application registered (${2})"
}
prow_add_app Radarr "http://radarr:7878" "$(arr_apikey /opt/appdata/radarr)"
prow_add_app Sonarr "http://sonarr:8989" "$(arr_apikey /opt/appdata/sonarr)"

# ---- Public torrent indexers + FlareSolverr proxy for the Cloudflare-protected ones ----
appid=$("${PG[@]}" "${PROW}/appprofile" | jq -r '.[0].id')

# tag used to bind Cloudflare indexers to the FlareSolverr proxy
tagid=$("${PG[@]}" "${PROW}/tag" | jq -r '.[]|select(.label=="flaresolverr").id')
if [[ -z "$tagid" || "$tagid" == "null" ]]; then
  tagid=$("${PJ[@]}" -X POST "${PROW}/tag" -d '{"label":"flaresolverr"}' | jq -r '.id')
  ok "prowlarr: created tag 'flaresolverr' (id $tagid)"
else
  ok "prowlarr: tag 'flaresolverr' present (id $tagid)"
fi

# FlareSolverr indexer proxy
if "${PG[@]}" "${PROW}/indexerproxy" | jq -e 'any(.[]; .implementation=="FlareSolverr")' >/dev/null; then
  ok "prowlarr: FlareSolverr proxy present"
else
  fs=$("${PG[@]}" "${PROW}/indexerproxy/schema" | jq --argjson t "$tagid" \
    '[.[]|select(.implementation=="FlareSolverr")][0] | .name="FlareSolverr" | .tags=[$t]
     | .fields = (.fields | map(if .name=="host" then .value="http://flaresolverr:8191" else . end))')
  "${PJ[@]}" -X POST "${PROW}/indexerproxy" -d "$fs" >/dev/null
  ok "prowlarr: FlareSolverr proxy added (host flaresolverr:8191, tag flaresolverr)"
fi

# Reconcile a public indexer from its Cardigann definition to the desired state. Idempotent AND
# self-healing: if the indexer already exists it PATCHES tags/enable/priority to match (so drift —
# e.g. a Cloudflare tracker missing its FlareSolverr tag — is corrected on every re-provision, not
# just on first create). forceSave so a flaky tracker test never blocks provisioning.
#   needs_flare=yes → tag for the FlareSolverr proxy (required for Cloudflare-protected trackers).
#   enabled=no      → keep the definition on record but disabled (e.g. an IP-banned mirror).
prow_add_indexer() {  # definitionName  priority  needs_flare(yes|no)  [enabled(yes|no)=yes]
  local def="$1" prio="$2" flare="$3" want_enable="${4:-yes}"
  local tags='[]'; [[ "$flare" == yes ]] && tags="[$tagid]"
  local en=true;  [[ "$want_enable" == no ]] && en=false
  local how="$([[ $flare == yes ]] && echo 'via FlareSolverr' || echo direct)$([[ $en == false ]] && echo ', disabled')"

  local existing; existing=$("${PG[@]}" "${PROW}/indexer" | jq --arg d "$def" '[.[]|select(.definitionName==$d)][0] // empty')
  if [[ -n "$existing" ]]; then
    local desired; desired=$(echo "$existing" | jq --argjson tags "$tags" --argjson en "$en" --argjson prio "$prio" '.tags=$tags | .enable=$en | .priority=$prio')
    if [[ "$(echo "$existing" | jq -cS '{tags,enable,priority}')" == "$(echo "$desired" | jq -cS '{tags,enable,priority}')" ]]; then
      ok "prowlarr: indexer '$def' already correct ($how)"
    else
      local id; id=$(echo "$existing" | jq -r '.id')
      "${PJ[@]}" -X PUT "${PROW}/indexer/${id}?forceSave=true" -d "$desired" >/dev/null
      ok "prowlarr: indexer '$def' reconciled ($how, priority $prio)"
    fi
    return
  fi

  local ix; ix=$("${PG[@]}" "${PROW}/indexer/schema" | jq --arg d "$def" --argjson app "$appid" --argjson prio "$prio" --argjson tags "$tags" --argjson en "$en" \
    '[.[]|select(.definitionName==$d)][0] | .enable=$en | .appProfileId=$app | .priority=$prio | .tags=$tags')
  local resp; resp=$("${PJ[@]}" -X POST "${PROW}/indexer?forceSave=true" -d "$ix")
  if echo "$resp" | jq -e '.id' >/dev/null 2>&1; then
    ok "prowlarr: indexer '$def' added (priority $prio, $how)"
  else
    warn "prowlarr: indexer '$def' add issue: $(echo "$resp" | jq -c '(.[0].errorMessage // .) // "unknown"' 2>/dev/null)"
  fi
}
# Public indexers. FlareSolverr is required for Cloudflare-protected trackers (EZTV); the rest are
# reachable directly. Knaben is a meta-aggregator that searches 30+ torrent sites at once (incl.
# 1337x, RARBG, TGx) — the single highest-coverage add and our replacement for the direct 1337x
# indexer, whose default mirror IP-bans this host (Cloudflare error 1006, unfixable via FlareSolverr).
prow_add_indexer yts            25 no    # movies, small direct-play-friendly encodes
prow_add_indexer thepiratebay   25 no    # broad catalog, no Cloudflare
prow_add_indexer thepiratebayys 25 no    # year-strip TPB clone: matches releases whose title year ≠ Radarr/Sonarr metadata year (see YEAR_BUG.md)
prow_add_indexer eztv         25 yes     # TV-focused, Cloudflare-protected → needs FlareSolverr
prow_add_indexer Knaben       20 no      # meta-aggregator (30+ sites) — broadest coverage
prow_add_indexer limetorrents       25 no    # broad catalog, no Cloudflare
prow_add_indexer torrentdownloads   25 no    # general tracker, alternative to TPB/KAT
prow_add_indexer kickasstorrents-ws 25 no    # KAT clone, broad movie/TV coverage
prow_add_indexer 1337x              25 yes no  # IP-banned (CF 1006) — kept on record but DISABLED; Knaben covers it
