#!/usr/bin/env bash
set -euo pipefail
# Build controller/intl-languages.json from Radarr movie data.
# Maps TMDb ID -> language name for all non-English, non-Animation movies.
#
# Prerequisites: Radarr running on localhost:7878 with API key discoverable.
# Run from repo root:  bash data/intl/build.sh

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/controller/intl-languages.json"

# Discover Radarr API key from keys.env or Radarr config.xml
RADARR_KEY=""
KEYS_ENV="/opt/appdata/controller/keys.env"
if [ -f "$KEYS_ENV" ]; then
  RADARR_KEY=$(grep '^RADARR_KEY=' "$KEYS_ENV" | head -1 | sed 's/^RADARR_KEY=//')
fi
if [ -z "$RADARR_KEY" ] && [ -f /opt/appdata/radarr/config.xml ]; then
  RADARR_KEY=$(sed -n 's/.*<ApiKey>\(.*\)<\/ApiKey>.*/\1/p' /opt/appdata/radarr/config.xml)
fi
if [ -z "$RADARR_KEY" ]; then
  echo "ERROR: cannot discover Radarr API key" >&2
  exit 1
fi

echo "Fetching Radarr movies..."
MOVIES=$(curl -s "http://localhost:7878/api/v3/movie?apiKey=$RADARR_KEY")

# Filter: non-English originalLanguage, non-Animation genre
# Output: { "tmdb_id": "language_name", ... }
echo "$MOVIES" | python3 -c "
import json, sys

out_path = '$OUT'
movies = json.load(sys.stdin)
result = {}
for m in movies:
    genres = m.get('genres', [])
    if 'Animation' in genres:
        continue
    ol = m.get('originalLanguage', {})
    if not ol or ol.get('name', '') == 'English':
        continue
    tid = m.get('tmdbId')
    if tid:
        result[str(tid)] = ol['name']

with open(out_path, 'w') as f:
    json.dump(result, f, indent=2)

print(f'Wrote {len(result)} non-English movies to {out_path}')
for lang in sorted(set(result.values())):
    count = sum(1 for v in result.values() if v == lang)
    print(f'  {lang}: {count}')
"