#!/usr/bin/env bash
# audit-runtimes.sh — find files that are not the whole film. The standing safety net behind the
# Chinatown (1974) bug, 2026-08-10.
#
#   ./scripts/audit-runtimes.sh              # movies + TV, anything under the threshold
#   ./scripts/audit-runtimes.sh --movies     # movies only
#   ./scripts/audit-runtimes.sh --tv         # TV only
#   ./scripts/audit-runtimes.sh --ratio 0.75 # widen the net (default 0.90 to show the grey zone)
#   ./scripts/audit-runtimes.sh --ffprobe    # ground truth: probe every file instead of trusting *arr
#   ./scripts/audit-runtimes.sh --csv        # machine-readable
#
# WHAT IT CATCHES. A release can be correctly named, correctly parsed, a valid container, full
# bitrate, and score fine on every custom format, and still contain half the movie. Chinatown was a
# 6.78 GB "1080p BluRay x264" holding 68 minutes of a 130-minute film. Nothing in *arr's model looks
# at duration, so nothing objected — and it replaced a good copy.
#
# TWO THRESHOLDS, because there are two questions:
#   below 0.60  BROKEN. This is RUNTIME_MIN_RATIO in controller/lib/release-rules.js, the ratio the
#               swap preflight now refuses on. Measured over the whole library, only genuine
#               truncations live here (Chinatown 0.52, a Star Wars Holiday Special .VOB at 0.16).
#   0.60-0.90   GREY ZONE, almost always fine and shown so it can be eyeballed rather than trusted.
#               This is where every legitimate disagreement lives: PAL speedup, credits, a TMDB
#               runtime for a longer cut than the release (The Hateful Eight 167.7 vs the 188 min
#               roadshow), an intermission counted in (The Brutalist 200.6 vs 215), and — on TV —
#               TVDB runtimes that include ad breaks, which puts a whole slab of good sitcom files
#               near 0.8.
#
# TREAT PER-EPISODE TV RATIOS AS ADVISORY, and do not chase them the way you would a movie. TVDB's
# episode `runtime` is frequently just WRONG for multi-part episodes: Lost S01E24 "Exodus (2)" carries
# runtime 85 (the combined two-hour finale) while the episode is a 43-minute half — so a perfectly
# complete file reports 0.51 and looks broken. Confirmed a false positive by Brennan, 2026-08-12.
# The swap preflight is not exposed to this because it compares a WHOLE SEASON at once (Lost S1 comes
# out at 0.94 once the bogus 85 is diluted across 24 episodes); this report is per-file, so it is not.
# For TV, believe a shortfall only when the neighbouring episodes agree.
#
# WHY --ffprobe EXISTS. *arr records mediaInfo at import, which is fine ground truth for what the
# file says — except when there is none at all. The Star Wars Holiday Special is a .VOB with no
# mediaInfo, so it was INVISIBLE to the *arr-based pass and only turned up under ffprobe. Any file
# *arr cannot parse is exactly the kind that is broken, so the two passes disagree in the direction
# that matters. Run --ffprobe when you want the real answer; it is header reads only (~1s/file,
# nice'd, read-only) and took ~4 min over 881 files on 2026-08-12.
#
# READ-ONLY. Reports and exits; it never grabs, imports, deletes or replaces. Recovering a short file
# means picking a replacement BY HAND — see the note on never auto-triggering replacements.
set -uo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib.sh
. scripts/lib.sh 2>/dev/null || true

RATIO=0.90
DO_MOVIES=1
DO_TV=1
USE_FFPROBE=0
CSV=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --movies) DO_TV=0 ;;
    --tv) DO_MOVIES=0 ;;
    --ratio) RATIO="$2"; shift ;;
    --ffprobe) USE_FFPROBE=1 ;;
    --csv) CSV=1 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

RADARR_KEY=$(docker exec radarr cat /config/config.xml 2>/dev/null | grep -oP '(?<=<ApiKey>)[^<]+') || true
SONARR_KEY=$(docker exec sonarr cat /config/config.xml 2>/dev/null | grep -oP '(?<=<ApiKey>)[^<]+') || true
[[ -z "${RADARR_KEY:-}" && -z "${SONARR_KEY:-}" ]] && { echo "could not read *arr API keys — are the containers up?" >&2; exit 1; }

RATIO="$RATIO" DO_MOVIES="$DO_MOVIES" DO_TV="$DO_TV" USE_FFPROBE="$USE_FFPROBE" CSV="$CSV" \
RADARR_KEY="${RADARR_KEY:-}" SONARR_KEY="${SONARR_KEY:-}" python3 - <<'PY'
import json, os, subprocess, sys, urllib.request

RATIO = float(os.environ['RATIO'])
BROKEN = 0.60          # keep in step with RUNTIME_MIN_RATIO in controller/lib/release-rules.js
CSV = os.environ['CSV'] == '1'
FFPROBE = os.environ['USE_FFPROBE'] == '1'

def get(base, key, path, timeout=120):
    req = urllib.request.Request(f'http://localhost:{base}/api/v3{path}', headers={'X-Api-Key': key})
    return json.load(urllib.request.urlopen(req, timeout=timeout))

def hms(s):
    """*arr's mediaInfo.runTime, 'H:MM:SS' or 'MM:SS'. None when absent — which is itself a finding."""
    if not s:
        return None
    parts = [float(x) for x in str(s).split(':')]
    while len(parts) < 3:
        parts.insert(0, 0)
    return parts[0] * 3600 + parts[1] * 60 + parts[2]

def probe(path):
    try:
        r = subprocess.run(['nice', '-n', '19', 'ffprobe', '-v', 'error',
                            '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                           capture_output=True, text=True, timeout=120)
        return float(r.stdout.strip()) if r.stdout.strip() else None
    except Exception:
        return None

rows, noinfo = [], []

if os.environ['DO_MOVIES'] == '1' and os.environ.get('RADARR_KEY'):
    for m in get(7878, os.environ['RADARR_KEY'], '/movie'):
        mf = m.get('movieFile')
        if not mf:
            continue
        want = (m.get('runtime') or 0) * 60
        path = mf.get('path') or ''
        got = probe(path) if FFPROBE else hms((mf.get('mediaInfo') or {}).get('runTime'))
        if got is None:
            # No duration ANYWHERE is the Star Wars Holiday Special shape. Never silently skipped:
            # a file *arr cannot parse is more suspect than one that merely disagrees.
            noinfo.append(('movie', f"{m['title']} ({m.get('year')})", path, mf.get('size') or 0))
            continue
        if want <= 0:
            continue
        rows.append((got / want, 'movie', f"{m['title']} ({m.get('year')})", want, got, mf.get('size') or 0, path))

if os.environ['DO_TV'] == '1' and os.environ.get('SONARR_KEY'):
    key = os.environ['SONARR_KEY']
    for s in get(8989, key, '/series'):
        if not (s.get('statistics') or {}).get('episodeFileCount'):
            continue
        # Per-EPISODE runtimes summed per FILE, never series-average x count: a double-length finale
        # or a multi-episode file would otherwise read as a huge shortfall. Cosmos ships one file for
        # S01E09-E13 and is perfectly fine.
        want_by_file = {}
        for e in get(8989, key, f"/episode?seriesId={s['id']}"):
            fid = e.get('episodeFileId')
            if fid:
                want_by_file[fid] = want_by_file.get(fid, 0) + ((e.get('runtime') or s.get('runtime') or 0) * 60)
        for f in get(8989, key, f"/episodefile?seriesId={s['id']}"):
            want = want_by_file.get(f['id'], 0)
            path = f.get('path') or ''
            got = probe(path) if FFPROBE else hms((f.get('mediaInfo') or {}).get('runTime'))
            if got is None:
                noinfo.append(('episode', f"{s['title']} {f.get('relativePath', '')}", path, f.get('size') or 0))
                continue
            if want <= 0:
                continue
            rows.append((got / want, 'episode', f"{s['title']} — {f.get('relativePath', '')}", want, got, f.get('size') or 0, path))

rows.sort(key=lambda r: r[0])
hits = [r for r in rows if r[0] < RATIO]

if CSV:
    print('ratio,kind,title,expected_min,actual_min,gb,path')
    for r in hits:
        print(f'{r[0]:.4f},{r[1]},"{r[2]}",{r[3]/60:.1f},{r[4]/60:.1f},{r[5]/1e9:.2f},"{r[6]}"')
    for n in noinfo:
        print(f'NA,{n[0]},"{n[1]}",NA,NA,{n[3]/1e9:.2f},"{n[2]}"')
    sys.exit(0)

src = 'ffprobe (ground truth)' if FFPROBE else '*arr mediaInfo'
print(f'\nRuntime audit — {len(rows)} files compared via {src}, threshold {RATIO:.2f}\n')

broken = [r for r in hits if r[0] < BROKEN]
grey = [r for r in hits if r[0] >= BROKEN]

if broken:
    print(f'  BROKEN — under {BROKEN:.2f}, not the whole film ({len(broken)}):')
    for r in broken:
        print(f'    {r[0]:.2f}  {r[2][:56]:58s} want {r[3]/60:6.1f} min  got {r[4]/60:6.1f} min  {r[5]/1e9:5.2f} GB')
    print()
else:
    print(f'  BROKEN — under {BROKEN:.2f}: none\n')

if grey:
    print(f'  GREY ZONE — {BROKEN:.2f} to {RATIO:.2f}, usually a different cut or metadata noise ({len(grey)}):')
    for r in grey:
        print(f'    {r[0]:.2f}  {r[2][:56]:58s} want {r[3]/60:6.1f} min  got {r[4]/60:6.1f} min  {r[5]/1e9:5.2f} GB')
    print()

if noinfo:
    print(f'  NO DURATION AT ALL — unparseable, treat as suspect ({len(noinfo)}):')
    for n in noinfo:
        print(f'    {n[1][:70]:72s} {n[3]/1e9:5.2f} GB')
    if not FFPROBE:
        print('    (re-run with --ffprobe — these are exactly the files *arr cannot see)')
    print()

print(f'  {len(broken)} broken, {len(grey)} grey, {len(noinfo)} unparseable, {len(rows) - len(hits)} fine')
print('  Recovery is BY HAND: pick a replacement per title. Nothing here grabs or deletes.\n')
sys.exit(1 if broken or noinfo else 0)
PY
