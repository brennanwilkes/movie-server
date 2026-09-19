#!/usr/bin/env bash
set -euo pipefail
# Resolve festival winner titles -> TMDb IDs and store them back into
# data/oscars/festivals.json (idempotent: already-resolved entries are skipped).
#
# TWO STRATEGIES, in order:
#
#   0. WIKIDATA (exact).  fetch-festivals.py records the wikilink TARGET of each winner
#      ("wiki": "Nomadland (film)"). That article maps to exactly one Wikidata item, and
#      281k film items carry P4947 (TMDb movie ID). So the join is
#      Wikipedia table cell -> article -> Wikidata item -> TMDb id, with no string
#      similarity anywhere in it. Batched 50 at a time, no API key needed.
#
#   1. TMDb SEARCH (fuzzy).  The old path, kept as a fallback for entries with no `wiki`
#      field (hand-added rows) or whose Wikidata item has no TMDb id. Uses the ALIASES
#      table below for titles TMDb spells differently.
#
# WHY STRATEGY 0 EXISTS: title search silently picks the wrong film. Bergman's
# *The Magician* (1958) resolves to an unrelated 2005 Australian film of the same name,
# and that is not a bug you notice — it is a badge on the wrong poster forever. The
# ALIASES table below is the manual patch for that failure mode, and it does not scale.
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
UA = 'movie-server-festival-build/1.0 (personal media server; contact via repo)'

# Manual title->search-title overrides, for the TMDb-search fallback ONLY. Entries that
# carry a `wiki` target never reach this table. Key: normalized source title.
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


def fetch(url):
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception:
            if attempt == 3:
                return None
            time.sleep(2 + attempt * 3)
    return None


def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


# ---------------------------------------------------------------- strategy 0: Wikidata
def wikidata_ids(titles):
    """[article title] -> {article title: (tmdb_id, wikidata label)} via Wikidata P4947."""
    q_by_title, out = {}, {}
    for batch in chunks(titles, 50):
        d = fetch('https://en.wikipedia.org/w/api.php?' + urllib.parse.urlencode({
            'action': 'query', 'prop': 'pageprops', 'ppprop': 'wikibase_item',
            'titles': '|'.join(batch), 'redirects': 1, 'format': 'json'}))
        if not d or 'query' not in d:
            continue
        # The API normalizes and follows redirects, so the key it returns is NOT always
        # the title we asked for. Walk both mapping tables back to our original string,
        # or every redirected article silently drops out.
        back = {}
        for m in d['query'].get('normalized', []):
            back[m['to']] = m['from']
        for m in d['query'].get('redirects', []):
            back[m['to']] = back.get(m['from'], m['from'])
        for p in d['query'].get('pages', {}).values():
            qid = (p.get('pageprops') or {}).get('wikibase_item')
            if qid:
                q_by_title[back.get(p['title'], p['title'])] = qid
        time.sleep(0.3)

    qids = sorted(set(q_by_title.values()))
    claims = {}
    for batch in chunks(qids, 50):
        d = fetch('https://www.wikidata.org/w/api.php?' + urllib.parse.urlencode({
            'action': 'wbgetentities', 'props': 'claims|labels', 'languages': 'en',
            'ids': '|'.join(batch), 'format': 'json'}))
        if not d or 'entities' not in d:
            continue
        for qid, ent in d['entities'].items():
            c = ent.get('claims', {})
            try:
                tmdb = c['P4947'][0]['mainsnak']['datavalue']['value']
            except Exception:
                tmdb = None
            label = ((ent.get('labels') or {}).get('en') or {}).get('value', '')
            if tmdb:
                claims[qid] = (int(tmdb), label)
        time.sleep(0.3)

    for title, qid in q_by_title.items():
        if qid in claims:
            out[title] = claims[qid]
    return out


# ------------------------------------------------------------- strategy 1: TMDb search
def search(query, year=None):
    params = {'api_key': API_KEY, 'query': query, 'include_adult': 'false', 'language': 'en-US'}
    if year:
        params['year'] = year
    d = fetch('https://api.themoviedb.org/3/search/movie?' + urllib.parse.urlencode(params))
    return (d or {}).get('results') or []


def tmdb_search_resolve(entry):
    title, year = entry['title'], entry['year']
    q = ALIASES.get(norm(title), title)
    for res in search(q, year):                       # exact-year, release within +-1
        ry = (res.get('release_date') or '')[:4]
        if ry and abs(int(ry) - year) <= 1:
            return res['id'], res.get('title', title), 'tmdb-year'
    for res in search(q):                             # no year, exact normalized title
        if norm(res.get('title') or '') == norm(q):
            return res['id'], res.get('title', title), 'tmdb-title'
    for res in search(q):                             # no year, same title within +-2
        ry = (res.get('release_date') or '')[:4]
        if ry and abs(int(ry) - year) <= 2 and norm(res.get('title') or '') == norm(title):
            return res['id'], res.get('title', title), 'tmdb-fuzzy'
    return None


# ----------------------------------------------------------------------------- driver
with open(path, encoding='utf-8') as f:
    data = json.load(f)

pending = [(cat, e) for cat, entries in data.items() for e in entries if not e.get('tmdb_id')]
skipped = sum(1 for entries in data.values() for e in entries if e.get('tmdb_id'))
print(f'{len(pending)} entries need a tmdb_id ({skipped} already resolved)')

wiki_targets = sorted({e['wiki'] for _, e in pending if e.get('wiki')})
wd = wikidata_ids(wiki_targets) if wiki_targets else {}
print(f'Wikidata: {len(wd)}/{len(wiki_targets)} wikilink targets carry a TMDb id (P4947)')

resolved, review, unresolved = 0, [], []
for cat, e in pending:
    hit = wd.get(e.get('wiki') or '')
    if hit:
        e['tmdb_id'], src, other = hit[0], 'wikidata', hit[1]
    else:
        r = tmdb_search_resolve(e)
        time.sleep(0.3)
        if not r:
            unresolved.append((cat, e['year'], e['title']))
            continue
        e['tmdb_id'], other, src = r[0], r[1], r[2]
    resolved += 1
    # Anything the source and the resolved record disagree about is worth a human look —
    # this is the report that would have caught the Bergman/Australian *Magician* collision.
    if norm(other) != norm(e['title']) and norm(other) != norm(ALIASES.get(norm(e['title']), e['title'])):
        review.append((cat, e['year'], e['title'], other, src))

with open(path, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=1, ensure_ascii=False)

print(f'\nresolved: {resolved}, unresolved: {len(unresolved)}')
if review:
    print('\n== Title differs from the resolved record — REVIEW (source -> resolved [via]) ==')
    for cat, y, t, o, src in sorted(review):
        print(f'  {cat} | {y}: {t} -> {o}  [{src}]')
if unresolved:
    print('\n== UNRESOLVED (need a manual tmdb_id in festivals.json) ==')
    for cat, y, t in unresolved:
        print(f'  {cat} | {y}: {t}')
PY
