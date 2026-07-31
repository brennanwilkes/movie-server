#!/usr/bin/env bash
# show-bloat.sh — find re-download candidates: files far larger than a same-resolution
# copy would need to be. Answers "what should I re-grab smaller, and what would it save?"
#
#   ./scripts/show-bloat.sh                  # summary + top offenders (TV then movies)
#   ./scripts/show-bloat.sh --tv             # TV series ranking only
#   ./scripts/show-bloat.sh --movies         # movie ranking only
#   ./scripts/show-bloat.sh --profile        # library shape: size by codec/resolution/tier
#   ./scripts/show-bloat.sh --top 40         # show N rows instead of 25
#   ./scripts/show-bloat.sh --floor          # aggressive model (see below)
#   ./scripts/show-bloat.sh --mbps 4.5       # floor model's target bitrate (default 3.5)
#   ./scripts/show-bloat.sh --beloved        # INCLUDE the protected Beloved tier
#   ./scripts/show-bloat.sh --csv            # machine-readable, for the controller UI
#
# TWO MODELS, because "how much can I reclaim" has two honest answers:
#
#   transparent (DEFAULT) — assumes a same-quality x265 re-encode needs ~55% of the x264
#     bitrate, so savings = 45% of current size. Content-RELATIVE: it never asks a
#     13 Mbps grain-heavy Bluray to become a 2 Mbps file. This is the "no visible loss"
#     number and the one to quote.
#   floor (--floor) — savings = size - (TARGET_MBPS x runtime). Content-BLIND: it drives
#     everything to one bitrate regardless of how demanding the footage is. Useful as an
#     upper bound, but grain-heavy sources (film-shot drama, nature docs) WILL degrade
#     visibly. Do not treat this number as free space.
#
# Both judge on BITRATE, not raw size — raw size cannot compare a 22-minute sitcom to a
# 3-hour epic, which is exactly why the *arr size-band custom formats (tuned for movies)
# fail to restrain TV. Only x264 files are candidates: an x265 file already at 9 Mbps is
# a bad re-grab bet, since the codec is not the reason it is large.
#
# The `Beloved (best quality)` tier is EXCLUDED by default. That profile exists to spare
# no expense, so a large file there is the feature working, not bloat — flagging it is a
# false positive. --beloved overrides, for auditing only.
#
# TARGET 8-BIT x265 ONLY. 10-bit HEVC cannot direct-play on the Fire TV Stick 2nd gen and
# Jellyfin has EnableDecodingColorDepth10Hevc=false, so it falls back to CPU software
# decode on the NUC. See docs/AUDIT-DISK-2026-07-27.md.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib.sh

MODE=all; TOP=25; MBPS=3.5; CSV=false; MODEL=transparent; BELOVED=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tv)      MODE=tv ;;
    --movies)  MODE=movies ;;
    --profile) MODE=profile ;;
    --csv)     CSV=true ;;
    --floor)   MODEL=floor ;;
    --beloved) BELOVED=true ;;
    --top)     TOP="$2"; shift ;;
    --mbps)    MBPS="$2"; shift ;;
    -h|--help) sed -n '2,37p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
  shift
done

RK=$(arr_apikey "${APPDATA:-/opt/appdata}/radarr")
SK=$(arr_apikey "${APPDATA:-/opt/appdata}/sonarr")
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

curl -sf "http://localhost:7878/api/v3/movie" -H "X-Api-Key: $RK" -o "$TMP/movies.json" \
  || die "Radarr unreachable on :7878"
curl -sf "http://localhost:8989/api/v3/series" -H "X-Api-Key: $SK" -o "$TMP/series.json" \
  || die "Sonarr unreachable on :8989"
curl -sf "http://localhost:8989/api/v3/qualityprofile" -H "X-Api-Key: $SK" -o "$TMP/sqp.json"

# One episodefile call per series — Sonarr has no "all files" endpoint.
jq -r '.[].id' "$TMP/series.json" | while read -r sid; do
  curl -sf "http://localhost:8989/api/v3/episodefile?seriesId=$sid" -H "X-Api-Key: $SK" \
    | jq -c --argjson sid "$sid" '.[] | . + {_seriesId:$sid}'
done > "$TMP/epfiles.ndjson"

python3 - "$TMP" "$MODE" "$TOP" "$MBPS" "$CSV" "$MODEL" "$BELOVED" <<'PY'
import json, sys, csv
from collections import defaultdict

tmp, mode, top, target_mbps, as_csv = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4]), sys.argv[5] == 'true'
model, want_beloved = sys.argv[6], sys.argv[7] == 'true'
G, T = 1024**3, 1024**4
TARGET = target_mbps * 1e6

def secs(rt):
    if not rt: return 0
    p = [int(x) for x in rt.split(':')]
    while len(p) < 3: p = [0] + p
    return p[0]*3600 + p[1]*60 + p[2]

def codec(c):
    c = (c or '?').lower()
    if c in ('x265', 'h265', 'hevc'): return 'x265'
    if c in ('x264', 'h264', 'avc'):  return 'x264'
    return c

qp = {p['id']: p['name'] for p in json.load(open(f'{tmp}/sqp.json'))}
sprof = {s['id']: (s['title'], qp.get(s['qualityProfileId'], '?')) for s in json.load(open(f'{tmp}/series.json'))}

rows = []
for m in json.load(open(f'{tmp}/movies.json')):
    f = m.get('movieFile')
    if not f: continue
    mi = f.get('mediaInfo') or {}
    rows.append(dict(kind='movie', title=m['title'], group=m['title'], year=m.get('year'),
                     prof=qp.get(m.get('qualityProfileId'), '?'), size=f['size'], sec=secs(mi.get('runTime')),
                     qual=f['quality']['quality']['name'], res=f['quality']['quality']['resolution'],
                     codec=codec(mi.get('videoCodec')), depth=mi.get('videoBitDepth')))
for line in open(f'{tmp}/epfiles.ndjson'):
    f = json.loads(line)
    mi = f.get('mediaInfo') or {}
    title, prof = sprof.get(f['_seriesId'], ('?', '?'))
    rows.append(dict(kind='tv', title=f['relativePath'], group=title, year=None, prof=prof,
                     size=f['size'], sec=secs(mi.get('runTime')),
                     qual=f['quality']['quality']['name'], res=f['quality']['quality']['resolution'],
                     codec=codec(mi.get('videoCodec')), depth=mi.get('videoBitDepth')))

def mbps(r): return r['size'] * 8 / r['sec'] / 1e6 if r['sec'] > 60 else 0

# x265 is excluded on purpose: if a file is already HEVC and still fat, re-grabbing the
# same codec buys little — the win there is a different encode, not a different container.
# Beloved is excluded because a large file in that tier is the profile working as intended.
def eligible(r):
    if r['codec'] != 'x264' or r['sec'] < 60: return False
    if not want_beloved and r['prof'].startswith('Beloved'): return False
    return True

def saving(r):
    if not eligible(r): return 0
    # 0.45 = 1 - 0.55, the accepted x265-vs-x264 bitrate ratio at equal perceptual quality.
    if model == 'transparent': return r['size'] * 0.45
    return max(0, r['size'] - TARGET * r['sec'] / 8)

if mode == 'profile':
    print(f"=== library shape ({len(rows)} files, {sum(r['size'] for r in rows)/T:.2f} TiB) ===\n")
    for key, label in (('res', 'resolution'), ('codec', 'video codec'), ('qual', 'quality tier')):
        d = defaultdict(lambda: [0, 0])
        for r in rows:
            d[r[key]][0] += 1; d[r[key]][1] += r['size']
        print(f"  by {label}:")
        for k, v in sorted(d.items(), key=lambda x: -x[1][1]):
            print(f"    {str(k):18s} {v[0]:5d} files  {v[1]/T:6.2f} TiB")
        print()
    print("  bitrate percentiles, 1080p, by kind x codec:")
    for kind in ('movie', 'tv'):
        for c in ('x264', 'x265'):
            br = sorted(mbps(r) for r in rows if r['kind'] == kind and r['res'] == 1080 and r['codec'] == c and r['sec'] > 60)
            if not br: continue
            q = lambda p: br[int(len(br)*p)]
            print(f"    {kind:5s} {c}: n={len(br):4d}  med={q(.5):5.1f}  p75={q(.75):5.1f}  p90={q(.90):5.1f}  max={br[-1]:5.1f} Mbps")
    # Hidden 10-bit: the title-regex custom format can't see it, so these bypassed the penalty.
    hid = [r for r in rows if r['codec'] == 'x265' and r['depth'] == 10]
    print(f"\n  x265 files that are actually 10-bit: {len(hid)} ({sum(r['size'] for r in hid)/T:.2f} TiB)")
    print("    (title-regex custom formats cannot detect these — they scored as 8-bit HEVC)")
    sys.exit()

cands = [r for r in rows if saving(r) > 0]
tv_tot  = sum(saving(r) for r in cands if r['kind'] == 'tv')
mv_tot  = sum(saving(r) for r in cands if r['kind'] == 'movie')

if as_csv:
    w = csv.writer(sys.stdout)
    w.writerow(['kind', 'group', 'title', 'profile', 'quality', 'codec', 'mbps', 'size_bytes', 'saving_bytes'])
    for r in sorted(cands, key=lambda x: -saving(x)):
        w.writerow([r['kind'], r['group'], r['title'], r['prof'], r['qual'], r['codec'],
                    f"{mbps(r):.1f}", r['size'], int(saving(r))])
    sys.exit()

what = "transparent (x265 @55% bitrate, no visible loss)" if model == 'transparent' else f"floor {target_mbps} Mbps (AGGRESSIVE — grain-heavy sources will degrade)"
scope = "incl. Beloved" if want_beloved else "Beloved tier protected"
print(f"model: {what} · {scope}")
print(f"{len(cands)} candidate files · {(tv_tot+mv_tot)/T:.2f} TiB reclaimable "
      f"of {sum(r['size'] for r in rows)/T:.2f} TiB\n")

if mode in ('all', 'tv'):
    d = defaultdict(lambda: {'n': 0, 'sz': 0, 'sav': 0, 'sec': 0, 'prof': '?', 'q': defaultdict(int)})
    for r in cands:
        if r['kind'] != 'tv': continue
        e = d[r['group']]
        e['n'] += 1; e['sz'] += r['size']; e['sav'] += saving(r); e['sec'] += r['sec']
        e['prof'] = r['prof']; e['q'][r['qual']] += 1
    print(f"=== TV series by reclaimable space ({tv_tot/T:.2f} TiB across {len(d)} series) ===")
    print(f"{'':4s}{'series':36s} {'eps':>4s} {'now':>8s} {'save':>8s}  {'rate':>5s}  {'tier':<16s} profile")
    for i, (k, v) in enumerate(sorted(d.items(), key=lambda x: -x[1]['sav'])[:top], 1):
        print(f"{i:3d}. {k[:36]:36s} {v['n']:4d} {v['sz']/G:7.1f}G {v['sav']/G:7.1f}G "
              f"{v['sz']*8/v['sec']/1e6:5.1f}  {max(v['q'], key=v['q'].get):<16s} {v['prof']}")
    print()

if mode in ('all', 'movies'):
    mv = sorted((r for r in cands if r['kind'] == 'movie'), key=lambda x: -saving(x))
    print(f"=== movies by reclaimable space ({mv_tot/G:.0f} GiB across {len(mv)} films) ===")
    print(f"{'':4s}{'title':44s} {'now':>7s} {'save':>7s}  {'rate':>5s}  {'tier':<16s} profile")
    for i, r in enumerate(mv[:top], 1):
        name = f"{r['title']} ({r['year']})"
        print(f"{i:3d}. {name[:44]:44s} {r['size']/G:6.1f}G {saving(r)/G:6.1f}G "
              f"{mbps(r):5.1f}  {r['qual']:<16s} {r['prof']}")
PY
