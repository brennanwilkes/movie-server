#!/usr/bin/env bash
set -euo pipefail
# Push scripts/provision/jellyfin-web-flair.js into the JavaScript Injector plugin — WITHOUT
# restarting Jellyfin.
#
# WHY THIS EXISTS. The flair script is the most frequently edited file in the repo (badges, rank
# pills, drawer branding, theme roulette), and its only deploy path was `make provision s=jellyfin`,
# whose §7 does an unconditional `docker restart jellyfin`. That is ~2 minutes of downtime and kills
# any in-progress playback — unacceptable for a one-line JS change, and exactly the kind of
# disruption Brennan has asked us to avoid. The plugin applies its configuration LIVE, so a flair-
# only change needs no restart at all: push, hard-refresh the browser, done.
#
# This is the ONE implementation of the push — provision/jellyfin.sh §9 calls this script rather
# than carrying a second copy of the jq. When it does, it exports JF and JF_TOKEN so we reuse its
# already-authenticated session instead of logging in again.
#
# Does NOT deploy jellyfin-custom.css: Branding config is cached in memory until restart, so CSS
# genuinely needs the full provision run.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

FLAIR_JS="$HERE/provision/jellyfin-web-flair.js"
[[ -f "$FLAIR_JS" ]] || die "missing $FLAIR_JS"

# Syntax-gate BEFORE pushing. A broken flair script does not fail loudly — it throws once inside the
# injected <script> and every badge, the drawer branding and the Top 100 UI silently disappear.
node --check "$FLAIR_JS" >/dev/null || die "jellyfin-web-flair.js has a syntax error — not pushing"

# NO RAW 4-BYTE UTF-8. The JS Injector strips non-BMP characters (emoji) when it stores the script,
# so a raw glyph is silently dropped from what the browser actually runs — and, because the stored
# copy then never byte-matches the source, the idempotency check below can never match either, so
# every provision re-POSTs the whole 200 KB. That is how this was found: one trophy glyph in a
# COMMENT made the push non-idempotent. Write non-BMP chars as JS \uD83C\uDFC6 surrogate-pair escapes.
# (And no raw emoji in THIS file either, so the check below reads as its own example.)
if raw=$(perl -CSD -ne 'print "  line $.: $_" if /[\x{10000}-\x{10FFFF}]/' "$FLAIR_JS") && [[ -n "$raw" ]]; then
  printf '%s\n' "$raw" >&2
  die "raw 4-byte UTF-8 in jellyfin-web-flair.js (the injector strips it) — use \\uXXXX escapes"
fi

if [[ -z "${JF_TOKEN:-}" ]]; then
  [[ -f "$ROOT/.env" ]] && set -a && source "$ROOT/.env" && set +a
  JF="http://${NUC_IP:-localhost}:8096"
  wait_http "$JF/System/Info/Public" 60
  AUTHHDR='MediaBrowser Client="provision", Device="cli", DeviceId="provision-cli", Version="1.0"'
  JF_TOKEN=$(curl -fsS -X POST "$JF/Users/AuthenticateByName" \
    -H "Authorization: $AUTHHDR" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg n "$JELLYFIN_ADMIN_USER" --arg p "$JELLYFIN_ADMIN_PASS" '{Username:$n,Pw:$p}')" \
    | jq -r '.AccessToken')
  [[ -n "$JF_TOKEN" && "$JF_TOKEN" != "null" ]] || die "Jellyfin auth failed — check JELLYFIN_ADMIN_* in .env"
fi
JF="${JF:-http://${NUC_IP:-localhost}:8096}"

js_id=$(curl -fsS --max-time 30 "$JF/Plugins" -H "Authorization: MediaBrowser Token=$JF_TOKEN" \
  | jq -r '.[]|select(.Name=="JavaScript Injector" and .Status=="Active").Id // empty')
[[ -n "$js_id" ]] || { warn "JavaScript Injector not active — skipping web flair (run: make provision s=jellyfin)"; exit 0; }

# Dedupe by NAME, not Id: the plugin does NOT persist an Id on stored entries (keys are only
# Name/Script/Enabled/RequiresAuthentication), so an Id-based "update in place" never matched and
# every provision piled up another duplicate — which the plugin then CONCATENATES into public.js.
flair_name="Curated List Flair"
js_cur=$(curl -fsS --max-time 30 "$JF/Plugins/$js_id/Configuration" -H "Authorization: MediaBrowser Token=$JF_TOKEN")
js_desired=$(jq --rawfile js "$FLAIR_JS" --arg name "$flair_name" '
  .PluginJavaScripts = (.PluginJavaScripts // []) |
  .CustomJavaScripts = (((.CustomJavaScripts // []) | map(select(.Name != $name))) + [{
    Name: $name, Script: $js, Enabled: true, RequiresAuthentication: false
  }])' <<<"$js_cur")

if [[ "$(jq -S . <<<"$js_cur")" == "$(jq -S . <<<"$js_desired")" ]]; then
  ok "web flair script already up to date in JavaScript Injector"
  exit 0
fi

# --data-binary @file: the script is well past the exec single-arg limit ("Argument list too long").
js_tmp=$(mktemp); trap 'rm -f "$js_tmp"' EXIT
printf '%s' "$js_desired" > "$js_tmp"
curl -fsS --max-time 30 -X POST "$JF/Plugins/$js_id/Configuration" \
  -H "Authorization: MediaBrowser Token=$JF_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @"$js_tmp" >/dev/null
ok "web flair script pushed (served at /JavaScriptInjector/public.js — hard-refresh the browser)"
