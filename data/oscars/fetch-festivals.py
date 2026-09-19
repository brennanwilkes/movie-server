#!/usr/bin/env python3
"""Regenerate the festival winner lists in festivals.json from English Wikipedia.

Run via `bash data/oscars/fetch-festivals.sh` (which supplies nothing but a sane cwd —
this script needs no credentials; it only reads the public MediaWiki API).

WHY THIS EXISTS. The Cannes and Sundance lists were parsed and hand-verified once, in
2026-07, and every subsequent year has to be typed in by hand. That does not scale past
two festivals, and it is the brittle part Brennan called out. This script makes the
winner lists *derived* rather than *curated*: it re-reads the source Wikipedia tables and
merges in anything new.

IT IS ADDITIVE ONLY. An entry already present in festivals.json — matched on
(category, year, normalized title) — is never modified and never deleted, so a resolved
`tmdb_id` or a hand-corrected title survives every re-run. New rows are appended with
`tmdb_id: null` for resolve-festivals.sh to fill in. That means the worst this script can
do on a bad parse is add junk you can see in the diff, never silently rewrite good data.

WHAT IT CAPTURES THAT THE OLD HAND-PARSE DID NOT: the wikilink TARGET, not just the
display text ("wiki": "Nomadland (film)"). That target is what resolve-festivals.sh feeds
to Wikidata to get an exact TMDb id, instead of guessing from a title string. Keeping it
is the whole reason the matching stopped being brittle — see resolve-festivals.sh.

ADDING A FESTIVAL: add a row to SOURCES. `start`/`end` bound the section scan, and
bounding it is not optional — the Silver Lion page holds four different awards under one
title, and a scan that runs off the end of its section silently pulls pre-1990 Silver
Lions into "Best Director" (it did, during the 2026-09-13 study).
"""

import json, os, re, sys, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, 'festivals.json')
API = 'https://en.wikipedia.org/w/api.php'
UA = 'movie-server-festival-build/1.0 (personal media server; contact via repo)'

# category -> how to read its winners off Wikipedia.
#   page   : article title
#   start  : regex for the heading the winners table starts AFTER
#   end    : regex for the heading that ends it (REQUIRED — see the module docstring)
#   bold   : True when the table also lists runners-up and the winner is the only
#            bold-italic entry (TIFF People's Choice lists two runners-up per year)
SOURCES = {
    'Venice: Golden Lion': dict(
        page='Golden Lion',
        start=r'^==\s*Winners\s*==',
        end=r'^==\s*Multiple winners',
    ),
    'Venice: Grand Jury Prize': dict(
        page='Grand Jury Prize (Venice Film Festival)',
        start=r'^==\s*Winners\s*==',
        end=r'^==\s*Multiple winners',
    ),
    # Only the MODERN Best Direction award. The page's "Defunct Categories" hold the
    # 1953-1994 Silver Lion Prize, which is the historic second prize and therefore
    # duplicates Grand Jury Prize above.
    'Venice: Best Director': dict(
        page='Silver Lion',
        start=r'^==\s*Silver Lion for Best Direction',
        end=r'^==+\s*Multiple Winners',
    ),
    "TIFF: People's Choice": dict(
        page="Toronto International Film Festival People's Choice Award",
        start=r'^==\s*Winners and runners-up\s*==',
        end=r'^==\s*References',
        bold=True,
    ),
}

# Wikilink targets that are never films, in case a table cell italicises something odd.
NOT_A_FILM = re.compile(r'^(Category|File|Image|List of|Template):', re.I)


def strip_files(txt):
    """Remove [[File:…]] / [[Image:…]] blocks, brackets balanced.

    These sit between the section heading and the table, and their captions are full of
    exactly what this parser looks for — ''[[Goodfellas]]'' (1990). They are not winner
    rows. They were harmless in the first run only because the year carry-forward had not
    started yet; a caption placed *between* two tables would have inherited the previous
    table's year and invented a winner. Regex alone cannot do this — a caption contains
    nested [[…]] — so scan and count depth.
    """
    out, i, n = [], 0, len(txt)
    while i < n:
        if txt.startswith('[[', i) and re.match(r'\[\[\s*(File|Image)\s*:', txt[i:i + 12], re.I):
            depth, j = 0, i
            while j < n:
                if txt.startswith('[[', j):
                    depth += 1
                    j += 2
                elif txt.startswith(']]', j):
                    depth -= 1
                    j += 2
                    if depth == 0:
                        break
                else:
                    j += 1
            i = j
            continue
        out.append(txt[i])
        i += 1
    return ''.join(out)


def get(params):
    q = dict(params, format='json')
    url = API + '?' + urllib.parse.urlencode(q)
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception as e:
            if attempt == 3:
                raise
            time.sleep(2 + attempt * 3)   # the API rate-limits bursts; back off politely
    return {}


def wikitext(title):
    d = get({'action': 'query', 'prop': 'revisions', 'rvprop': 'content',
             'rvslots': 'main', 'titles': title, 'redirects': 1})
    page = list(d['query']['pages'].values())[0]
    if 'revisions' not in page:
        raise SystemExit(f'error: Wikipedia page not found: {title}')
    return page['revisions'][0]['slots']['main']['*']


def section(txt, start, end):
    s = re.search(start, txt, re.M | re.I)
    if not s:
        raise SystemExit(f'error: section start not found: {start}')
    rest = txt[s.end():]
    e = re.search(end, rest, re.M | re.I)
    if not e:
        raise SystemExit(f'error: section END not found: {end} — refusing to scan to EOF')
    return rest[:e.start()]


def winners(region, bold=False):
    """[(year, display title, wikilink target)] for each winner row.

    Film titles in these tables are the wikilinks wrapped in italics; native-language
    title cells are italicised but NOT linked, so this cleanly isolates the English
    title. `bold` narrows that to bold-italic, which is how the TIFF table marks the
    winner among its runners-up.
    """
    region = re.sub(r'<ref[^>]*>.*?</ref>', '', region, flags=re.S)
    region = re.sub(r'<ref[^>]*/>', '', region)
    region = strip_files(region)
    pat = (r"'''''\s*\[\[([^\]\|]+)(?:\|([^\]]+))?\]\]" if bold
           else r"''+\s*\[\[([^\]\|]+)(?:\|([^\]]+))?\]\]")
    out, year = [], None
    for row in re.split(r'^\|-.*$', region, flags=re.M):
        # Year cells carry a rowspan, so carry the last one seen forward. Prefer a year
        # that looks like a festival-year link/cell over one embedded in a film title's
        # disambiguator ("The Master (2012 film)").
        ys = re.findall(r'\|\s*(?:\[\[)?((?:18|19|20)\d{2})\b', row)
        if ys:
            year = int(ys[0])
        for m in re.finditer(pat, row):
            target = m.group(1).strip()
            if NOT_A_FILM.match(target):
                continue
            out.append((year, (m.group(2) or m.group(1)).strip(), target))
    return out


def norm(s):
    return re.sub(r'[^a-z0-9]+', ' ', (s or '').lower()).strip()


def main():
    with open(PATH, encoding='utf-8') as f:
        data = json.load(f)

    added = total = 0
    for cat, cfg in SOURCES.items():
        txt = wikitext(cfg['page'])
        rows = winners(section(txt, cfg['start'], cfg['end']), cfg.get('bold', False))
        existing = data.setdefault(cat, [])
        seen = {(e.get('year'), norm(e.get('title'))) for e in existing}
        new = 0
        for year, title, target in rows:
            if year is None:
                print(f'  ! {cat}: no year for "{title}" — skipped')
                continue
            key = (year, norm(title))
            if key in seen:
                # Backfill the wikilink target onto an entry that predates this script,
                # so old hand-curated rows get the exact-match route too. This is the one
                # in-place edit allowed, and it only ever ADDS a field.
                for e in existing:
                    if (e.get('year'), norm(e.get('title'))) == key and not e.get('wiki'):
                        e['wiki'] = target
                continue
            seen.add(key)
            existing.append({'year': year, 'title': title, 'wiki': target, 'tmdb_id': None})
            new += 1
        existing.sort(key=lambda e: (-(e.get('year') or 0), norm(e.get('title'))))
        added += new
        total += len(existing)
        print(f'{cat}: {len(rows)} rows parsed, {len(existing)} total, {new} new')

    with open(PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    everything = sum(len(v) for v in data.values())
    print(f'\nWrote {PATH}: {len(data)} categories, {everything} entries total '
          f'({total} in the {len(SOURCES)} categories this script manages), {added} new.')
    if added:
        print('Next: bash data/oscars/resolve-festivals.sh   (fills tmdb_id)')


if __name__ == '__main__':
    main()
