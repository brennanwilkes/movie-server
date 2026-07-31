#!/usr/bin/env bash
# find-replacements.sh — "a smaller copy of this season exists at almost the same quality;
# swapping saves X GB". Per SEASON, with an explicit quality and playability verdict.
#
#   ./scripts/find-replacements.sh                    # scan every season above the bitrate floor
#   ./scripts/find-replacements.sh "Fringe"           # one series, all its seasons
#   ./scripts/find-replacements.sh --min-mbps 8       # only seasons fatter than this (default 6)
#   ./scripts/find-replacements.sh --groups           # print the measured group -> bit-depth map
#
# WHY SEASON, NOT SERIES: series totals mix lean and fat seasons and badly mislead. Peaky
# Blinders looks like a 114 GiB problem in aggregate, but S01 is 6 episodes of x265 at
# 1.8 Mbps — already optimal. The bloat lives in specific seasons, and a season is also the
# unit a release actually comes in.
#
# THE TWO TESTS a candidate must pass:
#
#   1. QUALITY — target ~55% of the current bitrate. That is the accepted x265-vs-x264
#      ratio at equal perceptual quality, so it is a codec win rather than a quality trade.
#      Candidates far below that are flagged AGGRESSIVE: they are real space savings but a
#      real, visible step down, worst on film grain (older drama, nature documentary).
#
#   2. PLAYABILITY — must be 8-bit HEVC. 10-bit cannot direct-play on the Fire TV Stick
#      2nd gen, and Jellyfin runs with EnableDecodingColorDepth10Hevc=false, so a 10-bit
#      file software-decodes on the NUC CPU: the library's existing 566 10-bit files are
#      why ~70% of playbacks currently transcode. A "smaller" file that streams worse is
#      not an upgrade.
#
# HOW BIT DEPTH IS KNOWN BEFORE DOWNLOADING: not from the title — modern encoders default
# to 10-bit silently, which is exactly how those 566 files got in. Instead this builds an
# EMPIRICAL release-group -> bit-depth map by reading mediaInfo.videoBitDepth off files
# already imported. Measured, not guessed: RARBG is 208-for-208 10-bit; SiGMA is 27-for-27
# 8-bit. Groups with no track record are reported as UNKNOWN, never assumed safe.
#
# Reports only. Every swap is manual: upgradeAllowed=false on all profiles (the deliberate
# no-auto-upgrade-delete invariant), so nothing here can fire on its own.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib.sh

MIN_MBPS=6; ONLY=""; SHOW_GROUPS=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --min-mbps) MIN_MBPS="$2"; shift ;;
    --groups)   SHOW_GROUPS=true ;;
    -h|--help)  sed -n '2,33p' "$0"; exit 0 ;;
    --*) echo "Unknown flag: $1" >&2; exit 1 ;;
    *) ONLY="$1" ;;
  esac
  shift
done

SK=$(arr_apikey "${APPDATA:-/opt/appdata}/sonarr")
RK=$(arr_apikey "${APPDATA:-/opt/appdata}/radarr")
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
SONARR=http://localhost:8989/api/v3

curl -sf "$SONARR/series" -H "X-Api-Key: $SK" -o "$TMP/series.json" || die "Sonarr unreachable"
curl -sf "http://localhost:7878/api/v3/movie" -H "X-Api-Key: $RK" -o "$TMP/movies.json" || true
jq -r '.[].id' "$TMP/series.json" | while read -r sid; do
  curl -sf "$SONARR/episodefile?seriesId=$sid" -H "X-Api-Key: $SK" \
    | jq -c --argjson sid "$sid" '.[] | . + {_seriesId:$sid}'
done > "$TMP/epfiles.ndjson"

# Pass 1: decide which seasons are worth searching, and emit the group map.
python3 - "$TMP" "$MIN_MBPS" "$ONLY" "$SHOW_GROUPS" <<'PY' > "$TMP/plan.txt"
import json, sys
from collections import defaultdict
tmp, min_mbps, only, show_groups = sys.argv[1], float(sys.argv[2]), sys.argv[3], sys.argv[4] == 'true'
G = 1024**3

def secs(rt):
    if not rt: return 0
    p = [int(x) for x in rt.split(':')]
    while len(p) < 3: p = [0] + p
    return p[0]*3600 + p[1]*60 + p[2]

series = {s['id']: s['title'] for s in json.load(open(f'{tmp}/series.json'))}
eps = [json.loads(l) for l in open(f'{tmp}/epfiles.ndjson')]

# --- empirical release-group -> measured bit depth, from our own imported files ---
depth = defaultdict(lambda: defaultdict(int))
def note(grp, mi):
    if not grp or not mi: return
    if (mi.get('videoCodec') or '').lower() not in ('x265', 'h265', 'hevc'): return
    d = mi.get('videoBitDepth')
    if d: depth[grp.lower()][d] += 1
for f in eps: note(f.get('releaseGroup'), f.get('mediaInfo'))
try:
    for m in json.load(open(f'{tmp}/movies.json')):
        mf = m.get('movieFile')
        if mf: note(mf.get('releaseGroup'), mf.get('mediaInfo'))
except Exception: pass

verdict = {}
for g, v in depth.items():
    verdict[g] = '8bit' if v[10] == 0 else ('10bit' if v[8] == 0 else 'mixed')
json.dump({'verdict': verdict, 'counts': {g: dict(v) for g, v in depth.items()}},
          open(f'{tmp}/groups.json', 'w'))

if show_groups:
    print('#GROUPS')
    for g, v in sorted(depth.items(), key=lambda x: -(x[1][8] + x[1][10])):
        print(f"#  {g:22s} 8bit={v[8]:4d} 10bit={v[10]:4d}  -> {verdict[g]}")
    sys.exit()

by_season = defaultdict(list)
for f in eps: by_season[(f['_seriesId'], f['seasonNumber'])].append(f)
for (sid, sn), files in sorted(by_season.items()):
    title = series.get(sid, '?')
    if only and only.lower() not in title.lower(): continue
    sz = sum(f['size'] for f in files)
    sec = sum(secs((f.get('mediaInfo') or {}).get('runTime')) for f in files)
    if not sec: continue
    br = sz * 8 / sec / 1e6
    if br < min_mbps: continue
    codec = (files[0].get('mediaInfo') or {}).get('videoCodec', '?')
    print(f"{sid}\t{sn}\t{title}\t{len(files)}\t{sz}\t{sec}\t{br:.1f}\t{codec}")
PY

if $SHOW_GROUPS; then sed -n 's/^#//p' "$TMP/plan.txt"; exit 0; fi

N=$(wc -l < "$TMP/plan.txt")
[[ "$N" -eq 0 ]] && { echo "No seasons above ${MIN_MBPS} Mbps."; exit 0; }
echo "Scanning $N season(s) above ${MIN_MBPS} Mbps — one indexer search each, ~30-60s per season."
echo

while IFS=$'\t' read -r sid sn title neps sz sec br codec; do
  printf '%s\n' "$(printf '=%.0s' {1..92})"
  printf '%s S%02d — %s eps, %.1f GiB @ %s Mbps (%s)\n' \
    "$title" "$sn" "$neps" "$(echo "$sz/1073741824" | bc -l)" "$br" "$codec"
  if ! timeout 240 curl -sf "$SONARR/release?seriesId=$sid&seasonNumber=$sn" \
       -H "X-Api-Key: $SK" -o "$TMP/rel.json"; then
    echo "   (search failed or timed out)"; continue
  fi
  python3 - "$TMP/rel.json" "$TMP/groups.json" "$sz" "$sec" "$br" "$sn" <<'PY'
import json, sys, re
relf, grpf, cur_size, cur_sec, cur_br = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), float(sys.argv[5])
want_season = int(sys.argv[6])
G = 1024**3
rels = json.load(open(relf))
gm = json.load(open(grpf))['verdict']
TARGET = cur_br * 0.55          # transparent: the x265-at-equal-quality point
FLOOR  = cur_br * 0.30          # below this, quality loss is no longer subtle

# Substring match against KNOWN group names — far more robust than parsing the trailing
# "-GROUP" token, which release names mangle constantly ("...AAC 5.1 Joy)[UTR]").
def groups_in(t):
    low = t.lower()
    return [g for g in gm if re.search(r'(?<![a-z0-9])' + re.escape(g) + r'(?![a-z0-9])', low)]

# A title can name two groups ("...AAC 5.1 Joy)[UTR]" — an encode by one, repacked by the
# other). Resolve PESSIMISTICALLY: one 10-bit match condemns the release. Guessing wrong
# toward 8-bit lands another CPU-transcoding file in the library; guessing wrong toward
# 10-bit only costs us a candidate.
def resolve(names):
    v = {gm[g] for g in names if gm.get(g)}
    if not v: return None
    if '10bit' in v: return '10bit'
    if 'mixed' in v: return 'mixed'
    return '8bit'

# Indexers truncate titles (observed: a hard 59-char cut mid-word, "...x265 HEVC 10bi"),
# so the depth marker is routinely chopped. Match the truncated prefixes too, and treat a
# title that ends mid-token as untrustworthy rather than clean.
TENBIT = re.compile(r'(?i)10.?b(?:it)?\b|10.?bi?$|hi10')
def depth_of(t):
    if TENBIT.search(t):                return '10bit'
    d = resolve(groups_in(t))
    if d:                               return d          # measured beats any title claim
    if re.search(r'(?i)\b8.?bit\b', t): return '8bit'
    return None

rows = []
for r in rels:
    t = r['title']
    if not r.get('fullSeason'): continue
    # Sonarr returns anything matching the SERIES, so S03 packs surface in an S01 search.
    if r.get('seasonNumber') != want_season: continue
    if not re.search(r'(?i)1080p', t): continue
    if not re.search(r'(?i)x265|h\.?265|hevc', t): continue
    if r['size'] >= cur_size: continue                      # must actually save something
    br = r['size'] * 8 / cur_sec / 1e6
    d = depth_of(t)
    play = {'8bit': 'OK 8-bit', '10bit': 'NO 10-bit', 'mixed': '? mixed grp'}.get(d, '? unknown')
    qual = 'transparent' if br >= TARGET else ('acceptable' if br >= FLOOR else 'AGGRESSIVE')
    rows.append((play, qual, br, r['size'], r.get('seeders') or 0, t))

if not rows:
    print("   no smaller 1080p x265 full-season candidate"); raise SystemExit
prio = {'OK 8-bit': 0, '? unknown': 1, '? mixed grp': 2, 'NO 10-bit': 3}
qord = {'transparent': 0, 'acceptable': 1, 'AGGRESSIVE': 2}
print(f"   target >= {TARGET:.1f} Mbps for a transparent swap")
for play, qual, br, sz, sd, t in sorted(rows, key=lambda x: (prio[x[0]], qord[x[1]], -x[4]))[:8]:
    print(f"   {play:11s} {qual:11s} {br:5.1f}Mbps  save {(cur_size-sz)/G:6.1f}G  seed={sd:4d}  {t[:52]}")
PY
  echo
done < "$TMP/plan.txt"
