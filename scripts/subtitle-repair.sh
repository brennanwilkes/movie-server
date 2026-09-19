#!/usr/bin/env bash
set -euo pipefail
# Audit (and optionally repair) Bazarr's EMBEDDED-subtitle rows against what the files actually
# contain.
#
# WHY. Bazarr keeps a derived row per subtitle in `table_movies_subtitles` /
# `table_episodes_subtitles`. A row with `path IS NULL` and an `embedded_track_id` means "this file
# has an embedded subtitle track". Those rows are NOT reconciled when a media file is replaced, so
# a film can end up with a phantom track that does not exist. Bazarr then computes
# `missing_subtitles = []`, every scheduled search skips it, and the film stays subtitle-less
# forever — silently. `scan-disk` does not clear them (verified).
#
# That is how *In the Mood for Love* had no subtitles for months; an audit found 11 such films.
#
# THE ONGOING FIX IS NOT THIS SCRIPT — it is controller/lib/subtitle-guard.js, which ignores
# Bazarr's beliefs entirely and drives the manual-search endpoint from Jellyfin's probe of the
# actual file. This script exists to tidy the stale rows so Bazarr's OWN UI and scheduled searches
# stop lying, and to re-check after any bulk file replacement.
#
#   bash scripts/subtitle-repair.sh          # audit only, prints what it would delete
#   bash scripts/subtitle-repair.sh --fix    # back up the DB, then delete the phantom rows
#
# Safety: only ever DELETEs rows whose `path IS NULL` (i.e. embedded claims) for items where the
# file truly has no subtitle stream. Never touches rows describing a real subtitle file on disk,
# never deletes media, never changes Radarr/Sonarr.

FIX=0
[ "${1:-}" = "--fix" ] && FIX=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

command -v docker >/dev/null || { echo "docker not found" >&2; exit 1; }
docker ps --format '{{.Names}}' | grep -qx bazarr || { echo "bazarr container not running" >&2; exit 1; }

JF_URL="http://127.0.0.1:8096"
JF_USER="${JELLYFIN_ADMIN_USER:-brennan}"
JF_PASS="${JELLYFIN_ADMIN_PASS:-brennan}"

AUTH='MediaBrowser Client="subtitle-repair", Device="cli", DeviceId="subtitle-repair", Version="1.0"'
TOKEN="$(curl -fsS --max-time 20 -X POST "$JF_URL/Users/AuthenticateByName" \
  -H "Authorization: $AUTH" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg n "$JF_USER" --arg p "$JF_PASS" '{Username:$n,Pw:$p}')" | jq -r '.AccessToken')"
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || { echo "jellyfin auth failed" >&2; exit 1; }
UID_JF="$(curl -fsS --max-time 20 "$JF_URL/Users/Me" -H "Authorization: MediaBrowser Token=$TOKEN" | jq -r '.Id')"

echo "▸ reading what the FILES actually contain (Jellyfin probe)…"
curl -fsS --max-time 300 \
  "$JF_URL/Users/$UID_JF/Items?IncludeItemTypes=Movie,Episode&Recursive=true&Fields=Path,MediaSources&Limit=100000" \
  -H "Authorization: MediaBrowser Token=$TOKEN" \
  | jq -r '.Items[] | (.Path // "") as $p
      | ([.MediaSources[]?.MediaStreams[]? | select(.Type=="Subtitle")] | length) as $n
      | "\($p|split("/")|last)\t\($n)"' > /tmp/subtitle-repair-truth.tsv
echo "  $(wc -l < /tmp/subtitle-repair-truth.tsv) media files probed"

docker cp /tmp/subtitle-repair-truth.tsv bazarr:/tmp/truth.tsv >/dev/null

if [ "$FIX" = "1" ]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  echo "▸ backing up bazarr.db -> bazarr.db.bak-$STAMP"
  docker exec bazarr sh -lc "cp /config/db/bazarr.db /config/db/bazarr.db.bak-$STAMP"
fi

# -i is REQUIRED: without it docker exec does not forward stdin and the heredoc is
# silently discarded — the script exits 0 having done nothing at all.
docker exec -i -e FIX="$FIX" bazarr python3 - <<'PY'
import os, sqlite3
fix = os.environ.get('FIX') == '1'
truth = {}
for line in open('/tmp/truth.tsv', encoding='utf-8'):
    name, _, n = line.rstrip('\n').partition('\t')
    if name:
        truth[name] = int(n or 0)

db = sqlite3.connect('/config/db/bazarr.db')
db.row_factory = sqlite3.Row
base = lambda p: (p or '').split('/')[-1]

plans = []
for tbl, idcol, parent, pidcol in (
        ('table_movies_subtitles', 'radarrId', 'table_movies', 'radarrId'),
        ('table_episodes_subtitles', 'sonarrEpisodeId', 'table_episodes', 'sonarrEpisodeId')):
    paths = {r[pidcol]: r['path'] for r in db.execute(f'SELECT {pidcol}, path FROM {parent}')}
    for r in db.execute(f'SELECT * FROM {tbl} WHERE path IS NULL AND embedded_track_id IS NOT NULL'):
        p = paths.get(r[idcol])
        b = base(p)
        if b not in truth:            # unknown to Jellyfin — leave it alone rather than guess
            continue
        if truth[b] == 0:             # file has NO subtitle streams, so this embedded claim is a ghost
            plans.append((tbl, r['id'], b, r['language']))

print(f'phantom embedded rows: {len(plans)}')
for tbl, rid, b, lang in plans[:40]:
    print(f'   {tbl} id={rid} lang={lang}  {b[:70]}')
if not plans:
    print('   nothing to repair')
elif fix:
    for tbl, rid, *_ in plans:
        db.execute(f'DELETE FROM {tbl} WHERE id=?', (rid,))
    db.commit()
    print(f'DELETED {len(plans)} phantom row(s). Bazarr will recompute missing_subtitles.')
else:
    print('(audit only — re-run with --fix to delete these)')
db.close()
PY

if [ "$FIX" = "1" ]; then
  echo "▸ restarting bazarr so it reloads state from the database"
  docker restart bazarr >/dev/null
  echo "  done"
fi
