#!/usr/bin/env bash
set -euo pipefail
# Resolve Cannes/Sundance winner titles -> TMDb IDs and store them back into
# data/oscars/festivals.json (idempotent: already-resolved entries are skipped).
#
# Uses the TMDb API key from the repo .env (TMDB_API_KEY). Rate-safe: ~0.3s
# between calls; ~554 entries on first run => ~3 minutes.
#
# Usage:  bash data/oscars/resolve-festivals.sh
# After running, `bash data/oscars/build.sh` merges the resolved entries into
# controller/oscar-winners.json.

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

if [ ! -f "$ROOT/.env" ]; then
  echo "error: $ROOT/.env not found (need TMDB_API_KEY)" >&2
  exit 1
fi
TMDB_API_KEY="$(grep -oP '^TMDB_API_KEY=\K.*' "$ROOT/.env" | tr -d '\r' || true)"
if [ -z "${TMDB_API_KEY:-}" ]; then
  echo "error: TMDB_API_KEY not set in $ROOT/.env" >&2
  exit 1
fi

export TMDB_API_KEY
exec python3 - "$HERE/festivals.json" << 'PY'
import json, os, re, sys, time, urllib.parse, urllib.request

path = sys.argv[1]
API_KEY = os.environ["TMDB_API_KEY"]

# Manual title->search-title overrides for films whose festival/English title
# differs from the title TMDb uses (key: normalized source title).
ALIASES = {
    "fruitvale": "Fruitvale Station",
    "the surrogate": "The Sessions",
    "the sting of death": "Death",
    "butchered": "Kinatay",
    "down and dirty": "Down and Dirty",
    "heroes of shipka": "The Heroes of Shipka",
    "the secret agent": "O Agente Secreto",
    "sex, lies and videotape": "sex, lies, and videotape",
    "ha-chan, shake your booty!": "Ha-chan, Shake Your Booty!",
}

def norm(s):
    return re.sub(r'[^a-z0-9]+', ' ', (s or '').lower()).strip()

def search(query, year=None):
    params = {'api_key': API_KEY, 'query': query, 'include_adult': 'false', 'language': 'en-US'}
    if year:
        params['year'] = year
    url = 'https://api.themoviedb.org/3/search/movie?' + urllib.parse.urlencode(params)
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'movie-server-build/1.0'})
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.load(r).get('results') or []
        except Exception:
            time.sleep(2 + attempt * 2)
    return []

def resolve(entry):
    title = entry['title']
    year = entry['year']
    q = ALIASES.get(norm(title), title)
    # 1) exact-year search, accept a result whose release year is within +-1
    for res in search(q, year):
        ry = (res.get('release_date') or '')[:4]
        if ry and abs(int(ry) - year) <= 1:
            return {'tmdb_id': res['id'], 'title': res.get('title', title), 'year': year, 'match': 'year'}
    # 2) no-year search, prefer exact normalized-title match
    for res in search(q):
        if norm(res.get('title') or '') == norm(q):
            return {'tmdb_id': res['id'], 'title': res.get('title', title), 'year': year, 'match': 'title'}
    # 3) no-year search, accept normalized-title fuzzy match within +-2 years
    best = None
    for res in search(q):
        ry = (res.get('release_date') or '')[:4]
        if not ry:
            continue
        if abs(int(ry) - year) <= 2 and norm(res.get('title') or '') == norm(title):
            return {'tmdb_id': res['id'], 'title': res.get('title', title), 'year': year, 'match': 'fuzzy'}
    return None

with open(path) as f:
    data = json.load(f)

resolved = 0
skipped = 0
unresolved = []
changed = False
for cat, entries in data.items():
    for entry in entries:
        if entry.get('tmdb_id'):
            skipped += 1
            continue
        r = resolve(entry)
        if r is None:
            unresolved.append((cat, entry['year'], entry['title']))
            continue
        # keep the source display title; only add the id (title is TMDb's, for the report)
        entry['tmdb_id'] = r['tmdb_id']
        entry['_tmdb'] = r['title']
        entry['_match'] = r['match']
        resolved += 1
        changed = True
        time.sleep(0.3)

if changed:
    with open(path, 'w') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"Wrote resolved tmdb_ids back to {path}")
else:
    print("No new resolutions needed.")

print(f"\nresolved: {resolved}, already-resolved: {skipped}, unresolved: {len(unresolved)}")

# Report: entries whose TMDb title differs a lot from the source title (review me)
print("\n== Title mismatches to review (source -> TMDb) ==")
for cat, entries in data.items():
    for entry in entries:
        if entry.get('_match') == 'year':
            tm = entry.get('_tmdb', '')
            if norm(tm) != norm(entry['title']) and norm(tm) != norm(ALIASES.get(norm(entry['title']), entry['title'])):
                print(f"  {cat} | {entry['year']}: {entry['title']} -> {tm}")
if unresolved:
    print("\n== UNRESOLVED (need manual tmdb_id) ==")
    for cat, y, t in unresolved:
        print(f"  {cat} | {y}: {t}")

# strip report-only fields so the committed file stays clean
for cat, entries in data.items():
    for entry in entries:
        entry.pop('_tmdb', None)
        entry.pop('_match', None)
if changed or unresolved:
    with open(path, 'w') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print("\nCleaned report fields from festivals.json")
PY
