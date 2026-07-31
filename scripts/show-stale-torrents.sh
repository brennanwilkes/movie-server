#!/usr/bin/env bash
# show-stale-torrents.sh — find torrents costing real disk that the library no longer uses.
#
#   ./scripts/show-stale-torrents.sh            # summary + the reclaim list
#   ./scripts/show-stale-torrents.sh --list     # every stale torrent, one per line
#   ./scripts/show-stale-torrents.sh --hashes   # bare hashes, for feeding a delete call
#
# THE IDEA: *arr imports by HARDLINK, so a seeding torrent and its library file are
# normally the same inode — the torrent copy costs ZERO extra bytes. That breaks when a
# title is later replaced (re-grab, manual swap, season upgrade): the library moves on to
# a new inode and the old torrent is left holding the only reference to its own data.
# Those are "stale" — still seeding, no longer backing anything you can watch.
#
# Detection is by INODE, not filename or size. Two files with the same name and a similar
# size are routinely different encodes (verified on Blue Planet II, where the library and
# torrent copies differ by ~200 MB per episode); only a shared inode proves the bytes are
# shared. Nothing here dedupes by content — if a torrent is stale, its bytes are genuinely
# its own, and reclaiming them means removing the torrent, not relinking it.
#
# WHAT CREATES THEM: post-import audio normalisation. ps4ify-sweep.sh rewrites imported
# files so the PS4 can direct-play them (adds an AC3 track / remuxes to mp4). A rewrite is
# a NEW inode, so the library file stops sharing bytes with the torrent and the torrent is
# left holding its own copy. Verified on Blue Planet II S01: one clean grab, seven clean
# imports, no re-grab — E01 kept its hardlink, E02-E07 gained an AC3 track alongside the
# original DTS and are ~198 MB larger than the torrent copies they came from. This is
# working-as-designed, not corruption, and it will keep happening.
#
# SAFETY PROOF (this script computes it, it is not an assumption). For each stale torrent
# it looks up the *arr import history by downloadId and checks the imported series/movie
# STILL HAS A FILE today. Three verdicts:
#   COVERED  - history proves it was imported and the library still holds that title.
#              The torrent is redundant; deleting loses nothing but the seed.
#   LOST     - imported, but the library no longer has the title. DO NOT DELETE: this
#              torrent is the only remaining copy.
#   UNPROVEN - no import record (the history window is finite, or it was never imported).
#              Look manually before deleting.
# Deleting never endangers a COVERED library file even if something is hardlinked after
# all: removing a hardlink only drops one name, and the library keeps its own.
#
# Ratio is not a concern here — every configured indexer is PUBLIC (`show-indexers.sh`), so
# seeding is goodwill, not currency. Re-check if a private tracker is ever added. This
# script only REPORTS; deleting is a deliberate manual step, and must remove the torrent in
# qBittorrent (not just the file) or qBittorrent re-checks and errors.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib.sh
set -a; source .env 2>/dev/null || true; set +a

MODE=summary
case "${1:-}" in
  --list)   MODE=list ;;
  --hashes) MODE=hashes ;;
  -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
  "") ;;
  *) echo "Unknown flag: $1" >&2; exit 1 ;;
esac

MEDIA="${DATA:-/data}/media"
TORRENTS="${DATA:-/data}/torrents"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

SK=$(arr_apikey "${APPDATA:-/opt/appdata}/sonarr")
RK=$(arr_apikey "${APPDATA:-/opt/appdata}/radarr")
H='page=1&pageSize=4000&sortKey=date&sortDirection=descending'
curl -sf "http://localhost:8989/api/v3/history?$H" -H "X-Api-Key: $SK" -o "$TMP/shist.json" || die "Sonarr unreachable"
curl -sf "http://localhost:7878/api/v3/history?$H" -H "X-Api-Key: $RK" -o "$TMP/rhist.json" || die "Radarr unreachable"
curl -sf "http://localhost:7878/api/v3/movie"     -H "X-Api-Key: $RK" -o "$TMP/movies.json"
curl -sf "http://localhost:8989/api/v3/series"    -H "X-Api-Key: $SK" -o "$TMP/series.json"
jq -r '.[].id' "$TMP/series.json" | while read -r sid; do
  curl -sf "http://localhost:8989/api/v3/episodefile?seriesId=$sid" -H "X-Api-Key: $SK" \
    | jq -c --argjson sid "$sid" '.[] | {_seriesId:$sid}'
done > "$TMP/epfiles.ndjson"

QB="http://localhost:${QBIT_PORT:-8080}"
curl -s -c "$TMP/cj" -X POST "$QB/api/v2/auth/login" \
  --data-urlencode "username=${QBIT_USER:-brennan}" \
  --data-urlencode "password=${QBIT_PASS:-brennan}" -o /dev/null
curl -sf -b "$TMP/cj" "$QB/api/v2/torrents/info" -o "$TMP/qbt.json" \
  || die "qBittorrent unreachable at $QB"

# Inode sets. -xdev keeps us on the media filesystem; hardlinks cannot cross one anyway.
find "$MEDIA" -xdev -type f -size +50M -printf '%i\n' 2>/dev/null | sort -u > "$TMP/media.inodes"
find "$TORRENTS/complete" -xdev -type f -size +50M -printf '%i\t%s\t%p\n' 2>/dev/null > "$TMP/tor.tsv"

python3 - "$TMP" "$MODE" "$TORRENTS" <<'PY'
import json, sys, os
tmp, mode, torrents_root = sys.argv[1], sys.argv[2], sys.argv[3]
G = 1024**3

media = {int(l) for l in open(f'{tmp}/media.inodes')}
files = []
for line in open(f'{tmp}/tor.tsv'):
    ino, size, path = line.rstrip('\n').split('\t', 2)
    files.append((int(ino), int(size), path))

shared = [f for f in files if f[0] in media]
stale  = [f for f in files if f[0] not in media]

qbt = json.load(open(f'{tmp}/qbt.json'))
# Longest-prefix match. Torrents with a BLANK content_path must be dropped: '' + '/' is a
# prefix of every absolute path, so leaving them in attributes the whole library to one
# torrent (36 of them are blank here — this silently produced a single 135 GiB "group"
# before it was caught).
by_path = sorted(((t.get('content_path') or '').rstrip('/'), t)
                 for t in qbt if (t.get('content_path') or '').strip())
def owner(p):
    best = None
    for cp, t in by_path:
        if p == cp or p.startswith(cp + '/'):
            if best is None or len(cp) > len(best[0]): best = (cp, t)
    return best[1] if best else None

# --- coverage: did *arr import this torrent, and does the library still hold that title? ---
def records(f):
    d = json.load(open(f))
    return d.get('records', d if isinstance(d, list) else [])
imported = {}
for r in records(f'{tmp}/shist.json'):
    if r['eventType'] == 'downloadFolderImported' and r.get('downloadId'):
        imported.setdefault(r['downloadId'].lower(), []).append(('tv', r.get('seriesId')))
for r in records(f'{tmp}/rhist.json'):
    if r['eventType'] == 'downloadFolderImported' and r.get('downloadId'):
        imported.setdefault(r['downloadId'].lower(), []).append(('movie', r.get('movieId')))
have_series = {json.loads(l)['_seriesId'] for l in open(f'{tmp}/epfiles.ndjson')}
have_movie = {m['id'] for m in json.load(open(f'{tmp}/movies.json')) if m.get('hasFile')}

def coverage(h):
    imp = imported.get(h.lower()) if h != '(untracked)' else None
    if not imp: return 'UNPROVEN'
    ok = all((i in have_movie) if k == 'movie' else (i in have_series) for k, i in imp)
    return 'COVERED' if ok else 'LOST'

groups = {}
for ino, size, path in stale:
    t = owner(path)
    k = t['hash'] if t else '(untracked)'
    g = groups.setdefault(k, {'size': 0, 'n': 0, 'name': t['name'] if t else os.path.basename(path),
                              'ratio': t.get('ratio', 0) if t else 0,
                              'state': t.get('state', '-') if t else 'NOT IN QBITTORRENT',
                              'cov': coverage(k)})
    g['size'] += size; g['n'] += 1

if mode == 'hashes':
    # Only COVERED torrents. Anything unproven or lost must not land in a delete list.
    for h, g in groups.items():
        if h != '(untracked)' and g['cov'] == 'COVERED': print(h)
    sys.exit()

if mode == 'list':
    for h, g in sorted(groups.items(), key=lambda x: -x[1]['size']):
        print(f"{g['size']/G:8.2f} GiB  {g['n']:3d}f  {g['cov']:8s} ratio={g['ratio']:5.2f}  {g['name'][:64]}")
    sys.exit()

print(f"=== {torrents_root}/complete ===")
print(f"  hardlinked into library : {len(shared):4d} files  {sum(f[1] for f in shared)/G:8.1f} GiB  (costs nothing)")
print(f"  STALE, own bytes only   : {len(stale):4d} files  {sum(f[1] for f in stale)/G:8.1f} GiB  <- reclaimable")
untracked = groups.get('(untracked)')
if untracked:
    print(f"    of which NOT in qBittorrent (pure garbage): {untracked['n']} files, {untracked['size']/G:.1f} GiB")
else:
    print("    all stale files are still registered in qBittorrent (no leaked garbage)")

print("\n=== safety verdict (from *arr import history, not assumption) ===")
for v, note in (('COVERED',  'library still has the title -> safe to remove'),
                ('LOST',     'library no longer has it -> DO NOT DELETE'),
                ('UNPROVEN', 'no import record -> check manually')):
    sel = [g for g in groups.values() if g['cov'] == v]
    print(f"  {v:9s} {len(sel):3d} torrents  {sum(g['size'] for g in sel)/G:7.1f} GiB   {note}")

for v in ('LOST', 'UNPROVEN'):
    sel = sorted([g for g in groups.values() if g['cov'] == v], key=lambda x: -x['size'])
    if sel:
        print(f"\n  {v} detail:")
        for g in sel[:10]:
            print(f"    {g['size']/G:7.2f} GiB {g['n']:3d}f  {g['name'][:62]}")

safe = [g for g in groups.values() if g['cov'] == 'COVERED']
print(f"\n=== biggest COVERED (safe) torrents ===")
for g in sorted(safe, key=lambda x: -x['size'])[:20]:
    print(f"  {g['size']/G:7.2f} GiB  {g['n']:3d}f  ratio={g['ratio']:5.2f}  {g['name'][:64]}")

print(f"\n  safe to reclaim: {sum(g['size'] for g in safe)/G:.1f} GiB across {len(safe)} torrents")
print("  to act: remove these in qBittorrent WITH their files (never delete from disk alone).")
print("  ./scripts/show-stale-torrents.sh --hashes  emits ONLY the COVERED hashes.")
PY
