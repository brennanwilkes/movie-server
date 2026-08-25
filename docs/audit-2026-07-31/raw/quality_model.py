#!/usr/bin/env python3
"""Three-axis scoring model: LOOK / SPACE / PLAYBACK.  v2, 2026-08-01.

v2 CHANGES, per Brennan:
  * The content-demand multiplier is GONE. "How much quality does this film
    deserve" is a human decision, not a genre/year heuristic. Correct call: the
    one time I tested the heuristic empirically it pointed the wrong way (a
    CRF-12 reference of Lawrence of Arabia landed at 10.6 Mbps while White Chicks
    landed at 24.5 — the modern comedy was the harder encode).
  * COLOUR IS NOW OBJECTIVE AND UNIVERSAL. One bpp scale for every file, with
    fixed anchors. A 1962 epic and a 2005 romcom at the same bpp get the same
    colour, because they are objectively the same quality.
  * INTENT lives in the Radarr quality profile (Beloved / Normal / Low), which
    the human sets per title.
  * THE ACTIONABLE SIGNAL IS THE MISMATCH between the two. A romcom on Low
    sitting in red is correct and should read as "by design", not as a problem.
    Gladiator on Beloved sitting in red is the thing that must jump off the page.

Reads library_flat.json + top100_ids.txt + radarr_movies.json + radarr_profiles.json.
Writes library_scored.json; prints the report to stdout.

    bpp = video_bitrate / (width * height * fps)      then x1.8 if HEVC
"""
import json
from collections import defaultdict, Counter

GB = 1e9

# ---- AXIS 1: objective colour bands -----------------------------------------
# Anchored to encoder reality at 1080p24, NOT to our library's distribution.
# The library is lean (41% of movies are YTS-family); a scale calibrated to make
# it look balanced would be lying about what those files are.
#
#   purple >= 0.20   ~10 Mbps   CRF 18 — visually lossless, nothing more to gain
#   green  >= 0.13   ~6.5 Mbps  CRF 20-21 — near-transparent on a 720p projector
#   orange >= 0.08   ~4 Mbps    CRF 23-24 — acceptable, visible softening
#   red     < 0.08              compromised; YTS-family lands ~0.05
BANDS = [(0.20, 'purple'), (0.13, 'green'), (0.08, 'orange'), (0.0, 'red')]
BAND_ORDER = ['purple', 'green', 'orange', 'red']
BAND_RANK = {b: i for i, b in enumerate(BAND_ORDER)}

def band(bpp):
    if bpp is None:
        return 'unknown'
    for lo, name in BANDS:
        if bpp >= lo:
            return name
    return 'red'

# ---- INTENT: what the profile says this title deserves -----------------------
# The band the human has implicitly asked for by assigning the profile.
PROFILE_WANTS = {
    'Beloved (best quality)': 'purple',
    'Normal':                 'green',
    'Low (save space)':       'orange',   # and red is fine — see verdict()
}
DEFAULT_PROFILE = 'Normal'

def verdict(actual, profile, top100):
    """The state that should drive ATTENTION. Deliberately quiet by default.

    'Normal' is the DEFAULT profile (749 of 860 movies) — it is the absence of an
    opinion, not a demand for green. Treating it as a demand produced 593
    'under-served' films, which is noise. Only an explicit signal (Beloved, or
    Top 100 membership, or Low) earns a loud verdict.
    """
    if actual == 'unknown':
        return 'unknown', ''
    a = BAND_RANK[actual]
    if profile == 'Beloved (best quality)':
        if a > BAND_RANK['green']:
            return 'UNDER', 'marked Beloved but below green — the loudest signal'
        if actual == 'green':
            return 'near', 'green on a Beloved title; purple is the goal'
        return 'ok', ''
    if top100:
        # In the Top 100 but never assigned Beloved. Needs a DECISION, not a grab.
        return ('UNCLASSIFIED', 'Top 100 but on ' + profile + ' — assign a profile') \
            if a > BAND_RANK['green'] else ('ok', 'Top 100, already good')
    if profile == 'Low (save space)':
        if a <= BAND_RANK['green']:
            return 'OVER', 'green/purple on a save-space title'
        return 'by-design', 'lean by choice'
    # Normal: no opinion recorded. Informational only.
    if actual == 'purple':
        return 'rich', 'purple on a default-profile title — possible overkill'
    return 'unranked', ''

def bpp_of(r):
    w, h, f = r.get('width'), r.get('height'), r.get('fps')
    vb = r.get('video_bitrate') or r.get('total_bitrate')
    if not (w and h and f and vb):
        return None
    b = vb / (w * h * f)
    return b * 1.8 if r.get('video_codec') == 'hevc' else b

# ---- AXIS 3: playback (measured 2026-08-01) ---------------------------------
def playback(r):
    c = (r.get('video_codec') or '').lower()
    bd = r.get('bit_depth') or 8
    if c in ('av1', 'vp9', 'vvc'):
        return 'unplayable', f'no decoder anywhere ({c})'
    if c == 'hevc' and bd > 8:
        return 'transcode', 'HEVC Main10 — server software-decodes, 1.3-2.1x realtime'
    if (r.get('width') or 0) > 1920 or (r.get('height') or 0) > 1088:
        return 'transcode', 'above the client 1920x1088 decoder cap'
    return 'direct', 'direct play'

def load_profiles():
    """(tmdbId -> profile) for movies, (series title -> profile) for TV."""
    mv, tv = {}, {}
    try:
        pr = {p['id']: p['name'] for p in json.load(open('radarr_profiles.json'))}
        mv = {str(m.get('tmdbId')): pr.get(m.get('qualityProfileId'), DEFAULT_PROFILE)
              for m in json.load(open('radarr_movies.json'))}
    except FileNotFoundError:
        pass
    try:
        pr = {p['id']: p['name'] for p in json.load(open('sonarr_profiles.json'))}
        tv = {s.get('title'): pr.get(s.get('qualityProfileId'), DEFAULT_PROFILE)
              for s in json.load(open('sonarr_series.json'))}
    except FileNotFoundError:
        pass
    return mv, tv

def main():
    d = json.load(open('library_flat.json'))
    try:
        top = set(open('top100_ids.txt').read().split())
    except FileNotFoundError:
        top = set()
    prof_mv, prof_tv = load_profiles()

    for r in d:
        b = bpp_of(r)
        p = (prof_mv.get(str(r.get('tmdb'))) if r['kind'] == 'movie'
             else prof_tv.get(r.get('series'))) or DEFAULT_PROFILE
        r['_bpp'] = round(b, 5) if b else None
        r['_band'] = band(b)
        r['_profile'] = p
        r['_wants'] = PROFILE_WANTS.get(p, 'green')
        r['_top100'] = r['jf_id'] in top
        r['_verdict'], r['_note'] = verdict(r['_band'], p, r['_top100'])
        r['_play'], r['_play_why'] = playback(r)
        r['_gb'] = round(r['size_bytes'] / GB, 3)
        rt = r.get('runtime_sec') or 0
        r['_gb_per_hr'] = round(r['size_bytes'] / GB / (rt / 3600), 2) if rt > 600 else None
        # Mbps at the green threshold, for "what would fix it"
        w, h, f = r.get('width') or 0, r.get('height') or 0, r.get('fps') or 0
        px = w * h * f
        r['_gb_at_green'] = round(r['_gb'] * (0.13 / b), 2) if (b and px) else None
        r['_gb_at_purple'] = round(r['_gb'] * (0.20 / b), 2) if (b and px) else None

    json.dump(d, open('library_scored.json', 'w'))

    mv = [r for r in d if r['kind'] == 'movie']
    ep = [r for r in d if r['kind'] == 'episode']
    P = print
    P("=" * 80); P("LIBRARY QUALITY / SPACE / PLAYBACK REPORT  (model v2)"); P("=" * 80)
    P(f"{len(d)} files, {sum(r['size_bytes'] for r in d)/1e12:.3f} TB")
    P("")
    P("COLOUR IS OBJECTIVE — one universal bpp scale, no per-film adjustment:")
    P("   purple >= 0.20  (~10 Mbps @1080p24, CRF18, visually lossless)")
    P("   green  >= 0.13  (~6.5 Mbps, near-transparent on the 720p projector)")
    P("   orange >= 0.08  (~4 Mbps, acceptable, visible softening)")
    P("   red     < 0.08  (compromised; YTS-family sits ~0.05)")
    P("INTENT comes from the Radarr profile. THE SIGNAL IS THE MISMATCH.")

    def dist(rows, label, key):
        c = Counter(r[key] for r in rows); n = len(rows) or 1
        P(f"\n-- {label} (n={len(rows)})")
        order = BAND_ORDER if key == '_band' else sorted(c)
        for k in order:
            if k not in c: continue
            gb = sum(r['_gb'] for r in rows if r[key] == k)
            P(f"   {k:16s} {c[k]:5d}  {100*c[k]/n:5.1f}%   {gb:8.0f} GB")

    P("\n" + "=" * 80); P("AXIS 1 — LOOK (objective band)"); P("=" * 80)
    dist(mv, 'movies', '_band'); dist(ep, 'episodes', '_band')
    dist([r for r in mv if r['_top100']], 'Top 100 movies', '_band')

    P("\n" + "=" * 80); P("AXIS 3 — PLAYBACK"); P("=" * 80)
    dist(mv, 'movies', '_play'); dist(ep, 'episodes', '_play')

    P("\n" + "=" * 80); P("THE SIGNAL — band vs profile intent (movies)"); P("=" * 80)
    dist(mv, 'movies by verdict', '_verdict'); dist(ep, 'episodes by verdict', '_verdict')

    P("\n-- UNDER: marked Beloved but below green — the loudest signal")
    u = sorted([r for r in mv if r['_verdict'] == 'UNDER'], key=lambda r: r['_bpp'] or 9)
    P(f"   {len(u)} films, {sum(r['_gb'] for r in u):.0f} GB now")
    P(f"   {'bpp':>6s} {'band':>7s} {'now':>6s} {'->green':>8s} {'profile':<24s} title")
    for r in u[:40]:
        P(f"   {r['_bpp']:6.3f} {r['_band']:>7s} {r['_gb']:6.1f} {r['_gb_at_green'] or 0:8.1f} "
          f"{r['_profile']:<24s} {r['title'][:36]}")
    if len(u) > 40: P(f"   ... and {len(u)-40} more")

    P("\n-- OVER: green/purple on a save-space title (movies AND tv)")
    o = sorted([r for r in d if r['_verdict'] == 'OVER'], key=lambda r: -r['_gb'])
    P(f"   {len(o)} files, {sum(r['_gb'] for r in o):.0f} GB")
    for r in o[:15]:
        P(f"   {r['_bpp']:6.3f} {r['_band']:>7s} {r['_gb']:6.1f} GB  {r['_profile']:<24s} {r['title'][:36]}")

    P("\n" + "=" * 80); P("TOP 100 NOT ON THE BELOVED PROFILE"); P("=" * 80)
    m = [r for r in mv if r['_top100'] and r['_profile'] != 'Beloved (best quality)']
    P(f"   {len(m)} films.  Band mix: {dict(Counter(r['_band'] for r in m))}")
    P(f"   now {sum(r['_gb'] for r in m):.0f} GB  ->  at purple {sum(r['_gb_at_purple'] or r['_gb'] for r in m):.0f} GB")

    P("\n" + "=" * 80); P("TV SERIES SCORECARD"); P("=" * 80)
    P(f"   {'GB':>7s} {'eps':>4s} {'medBPP':>7s} {'band':>7s} {'tx':>4s}  series")
    s = defaultdict(list)
    for r in ep: s[r['series']].append(r)
    for k, rows in sorted(s.items(), key=lambda x: -sum(r['_gb'] for r in x[1]))[:30]:
        bs = sorted(r['_bpp'] for r in rows if r['_bpp'])
        if not bs: continue
        med = bs[len(bs)//2]
        tx = sum(1 for r in rows if r['_play'] == 'transcode')
        P(f"   {sum(r['_gb'] for r in rows):7.0f} {len(rows):4d} {med:7.4f} {band(med):>7s} {tx:4d}  {k}")

    P("\n" + "=" * 80); P("PLAYBACK DEBT"); P("=" * 80)
    tx = [r for r in d if r['_play'] != 'direct']
    P(f"   {len(tx)} files ({100*len(tx)/len(d):.1f}%), {sum(r['_gb'] for r in tx):.0f} GB force server work.")
    bys = defaultdict(lambda: [0, 0.0])
    for r in tx:
        k = r['series'] if r['kind'] == 'episode' else '(movies)'
        bys[k][0] += 1; bys[k][1] += r['_gb']
    for k, (n, gb) in sorted(bys.items(), key=lambda x: -x[1][0])[:12]:
        P(f"     {n:4d} files {gb:7.0f} GB  {k}")

if __name__ == '__main__':
    main()
