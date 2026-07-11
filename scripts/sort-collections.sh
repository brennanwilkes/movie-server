#!/usr/bin/env bash
# sort-collections.sh — reconcile Jellyfin's auto-created (TMDB-linked) collections:
#   1. HIDE tiny ones (< 3 films) server-side, and
#   2. ORDER franchise ones chronologically.
#
# WHY: Jellyfin's AutomaticallyAddToCollection builds a BoxSet for every TMDB franchise it
# detects. Two problems: (a) it also makes 1-2 film "collections" (a lone "Crazy Rich Asians",
# a 2-film "Dune Collection") that are pure clutter, and (b) it defaults their order to
# SortName (alphabetical), scrambling sequels. Both fixes are server-side so they apply on
# every client (web + the TV fork) at once — no client-side card hiding (that flashed the
# card and left orphaned "Collections" headers/rows).
#
#   HIDE  = tag the BoxSet "hidden-collection" + keep that tag in the admin user's
#           BlockedTags policy. Jellyfin then filters it out of EVERY query for that user
#           (search, rows, detail). The member movies are NOT tagged, so they stay visible.
#           Scope: any BoxSet with a Tmdb provider id (the auto-created marker; hand-curated
#           collections like "A24"/"Critically Loved" have none) AND < 3 films.
#   ORDER = DisplayOrder=PremiereDate. Scope: Tmdb id AND name ends " Collection" (true
#           franchises; excludes curated Tmdb-tagged sets like "Pixar") AND >= 3 films.
#
# WHEN IT RUNS: once per boot via collection-sort.service (a systemd one-shot, NOT a
# recurring timer/cron), and once from provision (jellyfin.sh) so a deploy applies it
# immediately. Collections Jellyfin auto-creates mid-uptime are reconciled at the next
# boot/deploy, not instantly — accepted trade-off for not running a background loop.
#
# The BlockedTags policy hides tagged items from THIS user's API queries too, which would
# blind us to collections that later grow to >=3 (and should be un-hidden). So we drop the
# block for the duration of the run and restore it on exit (trap => always re-hides, even on
# error). Idempotent: steady-state runs make zero writes.
set -euo pipefail
cd "$(dirname "$0")/.."

set -a; source .env 2>/dev/null || true; set +a

JF="http://${NUC_IP:-localhost}:8096"
MIN_MOVIES=3
HIDE_TAG="hidden-collection"

# Boot ordering: docker.service is up but the Jellyfin app inside may still be starting.
# Wait (fail-soft) for its API to answer; if it never comes up, exit 0 (no-op, retry next boot).
for _ in $(seq 1 150); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$JF/System/Info/Public" 2>/dev/null || true)
  [[ "$code" =~ ^[2-4][0-9][0-9]$ ]] && break
  sleep 2
done

# Authenticate as the admin user (same flow as provision/jellyfin.sh).
AUTHHDR='MediaBrowser Client="sort-collections", Device="cli", DeviceId="sort-collections", Version="1.0"'
token=$(curl -fsS --max-time 15 -X POST "$JF/Users/AuthenticateByName" \
  -H "X-Emby-Authorization: $AUTHHDR" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg n "$JELLYFIN_ADMIN_USER" --arg p "$JELLYFIN_ADMIN_PASS" '{Username:$n,Pw:$p}')" \
  2>/dev/null | jq -r '.AccessToken')
[[ -n "$token" && "$token" != "null" ]] || { echo "collections: Jellyfin auth failed" >&2; exit 0; }
uid=$(curl -fsS --max-time 15 "$JF/Users/Me" -H "X-Emby-Token: $token" | jq -r '.Id')
[[ -n "$uid" && "$uid" != "null" ]] || { echo "collections: could not resolve user id" >&2; exit 0; }

# Ensure HIDE_TAG present/absent in the user's BlockedTags. POSTs the full policy object.
set_block() {  # $1 = true|false
  local pol
  pol=$(curl -fsS --max-time 15 "$JF/Users/$uid" -H "X-Emby-Token: $token" | jq '.Policy') || return 0
  pol=$(jq --arg t "$HIDE_TAG" --argjson want "$1" \
    '.BlockedTags = ((.BlockedTags // []) | map(select(. != $t)) + (if $want then [$t] else [] end))' <<<"$pol")
  curl -fsS --max-time 15 -X POST "$JF/Users/$uid/Policy" -H "X-Emby-Token: $token" \
    -H 'Content-Type: application/json' -d "$pol" >/dev/null 2>&1 || true
}
set_block false                    # unblock so tagged collections are visible to us
trap 'set_block true' EXIT         # always re-hide on exit, even on error

boxsets=$(curl -fsS --max-time 30 \
  "$JF/Items?userId=$uid&IncludeItemTypes=BoxSet&Recursive=true&Fields=ProviderIds,ChildCount,DisplayOrder,Tags" \
  -H "X-Emby-Token: $token")

changed=0
while IFS=$'\t' read -r bs_id cc bs_name; do
  [[ -n "$bs_id" ]] || continue
  # POST /Items/{id} replaces the item, so patch the full current DTO. <3: add hide tag.
  # >=3: remove hide tag (un-hide a grown franchise) and, if a "... Collection", order it.
  desired=$(curl -fsS --max-time 30 "$JF/Users/$uid/Items/$bs_id" -H "X-Emby-Token: $token" \
    | jq --argjson cc "$cc" --argjson min "$MIN_MOVIES" --arg tag "$HIDE_TAG" '
        if $cc < $min then .Tags = ((.Tags // []) + [$tag] | unique)
        else .Tags = ((.Tags // []) | map(select(. != $tag)))
             | (if (.Name | endswith(" Collection")) then .DisplayOrder = "PremiereDate" else . end)
        end')
  curl -fsS --max-time 30 -X POST "$JF/Items/$bs_id" -H "X-Emby-Token: $token" \
    -H 'Content-Type: application/json' -d "$desired" \
    && { echo "collections: reconciled '$bs_name' (${cc} films)"; changed=$((changed+1)); } \
    || echo "collections: failed to update '$bs_name'" >&2
done < <(jq -r --argjson min "$MIN_MOVIES" --arg tag "$HIDE_TAG" '
  .Items[]
  | select((.ProviderIds.Tmdb // "") != "")
  | ((.Tags // []) | index($tag) != null) as $hasTag
  | (.ChildCount // 0) as $cc
  | (.Name | endswith(" Collection")) as $fr
  # emit only items needing a change: small+untagged -> tag; big+tagged -> untag; franchise misordered -> sort
  | (if $cc < $min then ($hasTag | not)
     else ($hasTag or ($fr and (.DisplayOrder != "PremiereDate"))) end) as $need
  | select($need)
  | "\(.Id)\t\($cc)\t\(.Name)"' <<<"$boxsets")

(( changed > 0 )) && echo "collections: $changed change(s) applied" || true
# trap re-adds the block here, re-hiding all tagged collections.
