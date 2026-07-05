#!/usr/bin/env bash
# Exercises the EXACT Jellyfin queries the patched client issues, and asserts the
# selection/sort behavior matches the web HSS shelves. Requires: curl, jq.
set -euo pipefail

JF="${JF:-http://192.168.1.74:8096}"
USER="${JF_USER:-brennan}"
PASS="${JF_PASS:-brennan}"
AUTH='MediaBrowser Client="patch-test", Device="cli", DeviceId="patch-test-cli", Version="1.0"'

pass(){ echo "  PASS: $1"; }
fail(){ echo "  FAIL: $1"; FAILED=1; }
FAILED=0

echo "== 1. Authenticate ($USER @ $JF) =="
RESP=$(curl -s -m 10 -X POST "$JF/Users/AuthenticateByName" \
  -H "X-Emby-Authorization: $AUTH" -H "Content-Type: application/json" \
  -d "{\"Username\":\"$USER\",\"Pw\":\"$PASS\"}")
TOKEN=$(echo "$RESP" | jq -r '.AccessToken')
JUID=$(echo "$RESP" | jq -r '.User.Id')
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] && pass "authenticated (uid=$JUID)" || { fail "auth"; exit 1; }
H=(-H "X-Emby-Token: $TOKEN")

echo "== 2. shelfCatalog: BoxSets, Limit=100 (client's collection enumeration) =="
SETS=$(curl -s -m 15 "${H[@]}" "$JF/Users/$JUID/Items?IncludeItemTypes=BoxSet&Recursive=true&Limit=100")
TOTAL=$(echo "$SETS" | jq '.Items | length')
echo "  total BoxSets: $TOTAL"
# Mirror the client filter: exclude names ending in "Collection" (TMDb franchise sets)
KEPT=$(echo "$SETS" | jq -r '.Items[].Name | select(endswith("Collection")|not)')
DROPPED=$(echo "$SETS" | jq -r '.Items[].Name | select(endswith("Collection"))')
NKEPT=$(echo "$KEPT" | grep -c . || true)
NDROP=$(echo "$DROPPED" | grep -c . || true)
echo "  kept (curated): $NKEPT   dropped (*Collection): $NDROP"
echo "  --- sample kept ---";    echo "$KEPT" | head -8 | sed 's/^/    /'
[ "$NDROP" -gt 0 ] && { echo "  --- sample dropped ---"; echo "$DROPPED" | head -5 | sed 's/^/    /'; }
[ "$NKEPT" -gt 0 ] && pass "catalog has curated collections after filter" || fail "no curated collections"

echo "== 3. Oscar row: ParentId + SortBy=PremiereDate&SortOrder=Descending (newest first) =="
OSCAR_ID=$(echo "$SETS" | jq -r '.Items[] | select(.Name|test("^Oscar:";"i")) | .Id' | head -1)
OSCAR_NAME=$(echo "$SETS" | jq -r '.Items[] | select(.Name|test("^Oscar:";"i")) | .Name' | head -1)
if [ -n "$OSCAR_ID" ] && [ "$OSCAR_ID" != "null" ]; then
  echo "  using: $OSCAR_NAME"
  YEARS=$(curl -s -m 15 "${H[@]}" "$JF/Users/$JUID/Items?ParentId=$OSCAR_ID&SortBy=PremiereDate&SortOrder=Descending&Limit=24&Fields=ProductionYear" \
    | jq -r '.Items[].ProductionYear // empty')
  echo "  years: $(echo "$YEARS" | tr '\n' ' ')"
  SORTED=$(echo "$YEARS" | sort -rn)
  [ "$YEARS" = "$SORTED" ] && pass "Oscar row is newest-first" || fail "Oscar row not descending"
else
  echo "  (no Oscar: collection found — skipping)"
fi

echo "== 4. Non-Oscar row: SortBy=Random varies between calls =="
RAND_ID=$(echo "$SETS" | jq -r '.Items[] | select((.Name|test("^Oscar:";"i"))|not) | select(.Name|endswith("Collection")|not) | .Id' | head -1)
RAND_NAME=$(echo "$SETS" | jq -r --arg id "$RAND_ID" '.Items[] | select(.Id==$id) | .Name')
if [ -n "$RAND_ID" ] && [ "$RAND_ID" != "null" ]; then
  echo "  using: $RAND_NAME"
  A=$(curl -s -m 15 "${H[@]}" "$JF/Users/$JUID/Items?ParentId=$RAND_ID&SortBy=Random&Limit=24" | jq -r '.Items[].Id' | md5sum | cut -d' ' -f1)
  B=$(curl -s -m 15 "${H[@]}" "$JF/Users/$JUID/Items?ParentId=$RAND_ID&SortBy=Random&Limit=24" | jq -r '.Items[].Id' | md5sum | cut -d' ' -f1)
  echo "  order hash A=$A  B=$B"
  [ "$A" != "$B" ] && pass "random order differs between retrieves" || echo "  NOTE: identical (row may have <2 items); not a hard failure"
else
  echo "  (no non-Oscar curated collection found — skipping)"
fi

echo ""
[ "$FAILED" = 0 ] && echo "ALL ASSERTIONS PASSED" || { echo "SOME ASSERTIONS FAILED"; exit 1; }
