#!/usr/bin/env bash
set -euo pipefail
# data/emmys/emmys.json  ->  controller/emmy-awards.json
#
# Reduces the raw per-ceremony record to exactly what the badges need, so the display rules can be
# re-derived without re-fetching 97 Wikipedia articles. Run after fetch-emmys.sh.
#
# See docs/DESIGN-EMMY-BADGES.md for why the output is shaped this way: Emmy TOTALS are unusable on
# a poster (Game of Thrones is 59 wins / 159 nominations, 47 of those wins craft), so a badge shows
# the PROGRAM award by name plus a plain "nominated" boolean.

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

exec python3 - "$HERE/emmys.json" "$ROOT/controller/emmy-awards.json" << 'PY'
import json, re, sys, collections

src, out = sys.argv[1], sys.argv[2]

# PROGRAM categories: the award is for the SHOW itself. Everything else (acting, directing, writing
# and every craft category) is a "major nomination" at most. This list is explicit rather than
# structural — a "no 'for a' clause" rule looked clean and quietly swept in Outstanding Special
# Visual Effects, which inflated Game of Thrones to 15 program wins instead of 4.
PROGRAM = re.compile(r'^Outstanding ('
    r'Drama Series|Comedy Series|Limited or Anthology Series|Limited Series|'
    r'Miniseries.*|Television Movie|Movie Made for Television|'
    r'Variety Series|Variety Talk Series|Variety Sketch Series|Scripted Variety Series|'
    r'Variety Special.*|Talk Series|Variety, Music or Comedy Series|Comedy-Variety.*|'
    r'Competition Program|Reality-Competition Program|Reality Program|'
    r'Structured Reality Program|Unstructured Reality Program|'
    r'Animated Program|Documentary or Nonfiction Series|Documentary or Nonfiction Special|'
    r'Hosted Nonfiction Series or Special|Children.s Program|Drama or Comedy Special|'
    r'Informational Series.*|Short Form.*)$', re.I)

# Short display names for the plaque. The full category is often far too long for a poster row
# ("Outstanding Documentary or Nonfiction Series" is 44 characters), so each collapses to its
# distinguishing noun. Anything unmatched falls back to the category with "Outstanding " stripped.
DISPLAY = [
    (r'Drama Series$', 'DRAMA SERIES'),
    (r'Comedy Series$', 'COMEDY SERIES'),
    (r'Limited or Anthology Series$|Limited Series$|Miniseries', 'LIMITED SERIES'),
    (r'Television Movie$|Movie Made for Television$', 'TELEVISION MOVIE'),
    (r'Animated Program$', 'ANIMATED PROGRAM'),
    (r'Documentary or Nonfiction Series$|Hosted Nonfiction', 'DOCUMENTARY SERIES'),
    (r'Documentary or Nonfiction Special$', 'DOCUMENTARY SPECIAL'),
    (r'Variety Talk Series$|Talk Series$', 'VARIETY TALK SERIES'),
    (r'Variety Sketch Series$|Scripted Variety Series$', 'VARIETY SKETCH SERIES'),
    (r'Variety Series$|Variety, Music or Comedy Series$|Comedy-Variety', 'VARIETY SERIES'),
    (r'Variety Special', 'VARIETY SPECIAL'),
    (r'Competition Program$|Reality-Competition Program$', 'COMPETITION PROGRAM'),
    (r'Reality Program$|Structured Reality Program$|Unstructured Reality Program$', 'REALITY PROGRAM'),
    (r'Children.s Program$', "CHILDREN'S PROGRAM"),
    (r'Short Form', 'SHORT FORM SERIES'),
]

def display(cat):
    for pat, name in DISPLAY:
        if re.search(pat, cat, re.I):
            return name
    return re.sub(r'^Outstanding\s+', '', cat).upper()

shows = json.load(open(src, encoding='utf-8'))
result = {}
for article, rec in shows.items():
    wins = collections.Counter()
    prog_noms = 0
    major_noms = len(rec['awards'])
    for a in rec['awards']:
        if PROGRAM.match(a['category'] or ''):
            prog_noms += 1
            if a['won']:
                wins[display(a['category'])] += 1
    ids = {k: v for k, v in (rec.get('ids') or {}).items() if v}
    if not ids:
        continue
    total_wins = sum(wins.values())
    if not total_wins and not major_noms:
        continue
    top = wins.most_common(1)[0][0] if wins else None
    entry = {
        'article': article,
        'ids': ids,
        'programWins': total_wins,
        'programNoms': prog_noms,
        'majorNoms': major_noms,
        'topAward': top,
        'topAwardWins': wins[top] if top else 0,
        'awards': dict(wins),
    }
    # Keyed by EVERY id we know, so the sweep can match whichever one Jellyfin happens to carry.
    for k, v in ids.items():
        result.setdefault(k, {})[str(v)] = entry

json.dump(result, open(out, 'w'), indent=1, ensure_ascii=False)
n = len({id(e) for tbl in result.values() for e in tbl.values()})
print(f'wrote {out}')
for k in result:
    print(f'  keyed by {k}: {len(result[k])} shows')
PY
