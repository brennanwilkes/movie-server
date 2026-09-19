#!/usr/bin/env python3
"""Build the Emmy majors dataset from English Wikipedia, keyed by IMDb/TMDb/TVDB id.

Run via `bash data/emmys/fetch-emmys.sh`. Needs no credentials — MediaWiki and Wikidata only.

WHY WIKIPEDIA AND NOT televisionacademy.com. The Academy has the richer record (every craft
category, exact totals) but publishes NO ids, and its URL slugs are not derivable from a title
(`The Last of Us` -> `last-us`, but `The Penguin` -> `the-penguin`). A full dry-run over this
library left 26 of 98 series unresolved, and produced a real false positive: our `House` matched
the page for "In The House", a different show. Wikipedia instead gives a WIKILINK per show, which
resolves to a Wikidata item, which carries P345/P4983/P4835. The join is exact — no slugs, no
alias file, no name matching anywhere. See docs/DESIGN-EMMY-BADGES.md.

SCOPE IS DELIBERATELY "MAJORS": Programs, Acting, Directing, Writing — plus the program-level
categories from the Creative Arts ceremonies (Animated Program, Documentary or Nonfiction Series).
That is not a limitation of the source; it is the point. Game of Thrones has 59 wins and 47 of
them are craft, which is a number no poster badge should ever show.
"""

import json, os, re, sys, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, '.cache')
OUT = os.path.join(HERE, 'emmys.json')
UA = 'movie-server-emmy-build/1.0 (personal media server; contact via repo)'


def ordinal(n):
    if 10 <= n % 100 <= 20:
        return f'{n}th'
    return f'{n}{ {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th") }'


def api(base, params):
    url = base + '?' + urllib.parse.urlencode(dict(params, format='json'))
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=30) as f:
                return json.load(f)
        except Exception:
            time.sleep(3 + attempt * 4)      # the API rate-limits bursts; back off and retry
    return None


def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def wikitext(title):
    d = api('https://en.wikipedia.org/w/api.php',
            {'action': 'query', 'prop': 'revisions', 'rvprop': 'content',
             'rvslots': 'main', 'titles': title, 'redirects': 1})
    if not d or 'query' not in d:
        return None
    p = list(d['query']['pages'].values())[0]
    return p['revisions'][0]['slots']['main']['*'] if 'revisions' in p else None


def cached(name, title):
    fn = os.path.join(CACHE, name)
    if os.path.exists(fn) and os.path.getsize(fn) > 2000:
        return open(fn, encoding='utf-8').read()
    t = wikitext(title)
    if t and len(t) > 2000:
        os.makedirs(CACHE, exist_ok=True)
        open(fn, 'w', encoding='utf-8').write(t)
        time.sleep(1.1)
        return t
    time.sleep(1.1)
    return None


CAT = re.compile(r'\{\{Award category\|[^|]*\|\[\[[^\]\|]*(?:\|([^\]]*))?\]\]\}\}')
# An italic run: ''[[Target|Display]]'' or a bare ''Display''. Both forms matter — Wikipedia links
# a show only on its FIRST mention, so acting rows routinely carry it unlinked (''Frasier'' (NBC)).
# Capturing linked italics only lost most acting entries; Cheers came back with zero.
ITAL = re.compile(r"''+\s*(?:\[\[([^\]\|]+)(?:\|([^\]]+))?\]\]|([^'\[\]]{2,90}?))\s*''+")

# Program-level Creative Arts categories. Everything else there is craft and stays out.
CA_PROGRAM = re.compile(
    r'^Outstanding (Animated Program|Documentary or Nonfiction Series|'
    r'Documentary or Nonfiction Special|Hosted Nonfiction Series or Special|'
    r'Variety Special.*|Children.s Program|Short Form (Comedy|Drama|Animated).*|'
    r'Structured Reality Program|Unstructured Reality Program|Reality Program|'
    r'Exceptional Merit in Documentary Filmmaking)$', re.I)


def rows(body):
    """[(category, 'winner'|'nominee', 'L'|'P', target-or-title)] for every bullet row."""
    body = re.sub(r'<ref[^>]*>.*?</ref>', '', body, flags=re.S)
    body = re.sub(r'<ref[^>]*/>', '', body)
    out, cat = [], None
    for line in body.split('\n'):
        m = CAT.search(line)
        if m:
            cat = (m.group(1) or '').strip()
        ls = line.lstrip()
        if not ls.startswith('*') or not cat:
            continue
        # A single '*' bullet (bold) is the WINNER; '**' are the nominees. Stable 30th-77th.
        status = 'winner' if len(ls) - len(ls.lstrip('*')) == 1 else 'nominee'
        for mm in ITAL.finditer(ls):
            tgt, _disp, plain = mm.group(1), mm.group(2), mm.group(3)
            if tgt:
                if tgt.startswith(('File:', 'Image:', 'Category:')):
                    continue
                out.append((cat, status, 'L', tgt.strip()))
            elif plain:
                p = plain.strip()
                if p and not p.startswith('('):
                    out.append((cat, status, 'P', p))
            break     # the FIRST italic on a row is the show; later ones are episode titles
    return out


def majors_section(t):
    s = re.search(r'^=+\s*Winners and nominees\s*=+\s*$', t, re.M)
    if not s:
        return ''
    body = t[s.end():]
    e = re.search(r'^==\s*(Nominations and wins|Presenters|Ceremony information|In Memoriam'
                  r'|References|Notes|Most major)', body, re.M)
    return body[:e.start()] if e else body


def norm(s):
    return re.sub(r'[^a-z0-9]+', ' ', (s or '').lower()).strip()


def main():
    entries = []
    for n in range(1, 78):
        t = cached(f'c_{n}.wiki', f'{ordinal(n)} Primetime Emmy Awards')
        if t:
            entries += [(n,) + r for r in rows(majors_section(t))]
    print(f'primetime ceremonies parsed: {len({e[0] for e in entries})}, entries: {len(entries)}')

    ca = 0
    for n in range(1, 78):
        t = cached(f'ca_{n}.wiki', f'{ordinal(n)} Primetime Creative Arts Emmy Awards')
        if not t:
            continue
        for r in rows(t):                       # whole article: no "Winners and nominees" heading
            if CA_PROGRAM.match(r[0] or ''):
                entries.append((n,) + r)
                ca += 1
    print(f'creative-arts program-level entries: {ca}')
    print(f'total entries: {len(entries)}')

    # Unlinked show titles resolve through the titles that ARE linked somewhere across the corpus.
    alias = {}
    for _, _, _, kind, val in ((e[0], e[1], e[2], e[3], e[4]) for e in entries):
        if kind == 'L':
            alias.setdefault(norm(re.sub(r'\s*\(.*\)$', '', val)), val)
            alias.setdefault(norm(val), val)
    targets = sorted({e[4] for e in entries if e[3] == 'L'}
                     | {alias[norm(e[4])] for e in entries if e[3] == 'P' and norm(e[4]) in alias})
    print(f'distinct show articles: {len(targets)}')

    # article -> Wikidata item. A DROPPED BATCH SILENTLY LOSES 50 SHOWS — that is what once hid
    # Game of Thrones, The Sopranos and Succession, and it looks exactly like a data gap. Retry.
    q_by, failed = {}, []

    def take(r):
        if not r or 'query' not in r:
            return False
        back = {}
        for m in r['query'].get('normalized', []):
            back[m['to']] = m['from']
        for m in r['query'].get('redirects', []):
            back[m['to']] = back.get(m['from'], m['from'])
        for p in r['query'].get('pages', {}).values():
            qid = (p.get('pageprops') or {}).get('wikibase_item')
            if qid:
                q_by[back.get(p['title'], p['title'])] = qid
        return True

    for b in chunks(targets, 50):
        if not take(api('https://en.wikipedia.org/w/api.php',
                        {'action': 'query', 'prop': 'pageprops', 'ppprop': 'wikibase_item',
                         'titles': '|'.join(b), 'redirects': 1})):
            failed.append(b)
        time.sleep(0.4)
    for b in failed:
        take(api('https://en.wikipedia.org/w/api.php',
                 {'action': 'query', 'prop': 'pageprops', 'ppprop': 'wikibase_item',
                  'titles': '|'.join(b), 'redirects': 1}))
        time.sleep(1.0)
    print(f'articles -> wikidata item: {len(q_by)}/{len(targets)} (retried {len(failed)} batches)')

    ids, f2 = {}, []

    def take2(r):
        if not r or 'entities' not in r:
            return False
        for qid, ent in r['entities'].items():
            c = ent.get('claims', {})

            def v(p):
                try:
                    return c[p][0]['mainsnak']['datavalue']['value']
                except Exception:
                    return None
            ids[qid] = {'imdb': v('P345'), 'tmdb': v('P4983'), 'tvdb': v('P4835')}
        return True

    qids = sorted(set(q_by.values()))
    for b in chunks(qids, 50):
        if not take2(api('https://www.wikidata.org/w/api.php',
                         {'action': 'wbgetentities', 'props': 'claims', 'ids': '|'.join(b)})):
            f2.append(b)
        time.sleep(0.4)
    for b in f2:
        take2(api('https://www.wikidata.org/w/api.php',
                  {'action': 'wbgetentities', 'props': 'claims', 'ids': '|'.join(b)}))
        time.sleep(1.0)
    print(f'items -> id claims: {len(ids)}/{len(qids)} (retried {len(f2)} batches)')

    shows = {}
    for cer, cat, status, kind, val in entries:
        tgt = val if kind == 'L' else alias.get(norm(val))
        q = q_by.get(tgt) if tgt else None
        i = ids.get(q) if q else None
        if not i or not any(i.values()):
            continue
        key = tgt
        rec = shows.setdefault(key, {'article': tgt, 'ids': i, 'awards': []})
        rec['awards'].append({'ceremony': cer, 'category': cat, 'won': status == 'winner'})
    json.dump(shows, open(OUT, 'w'), indent=1, ensure_ascii=False)
    print(f'wrote {OUT}: {len(shows)} shows with an id and at least one major award')


if __name__ == '__main__':
    main()
