#!/usr/bin/env bash
set -euo pipefail
# Build controller/film-awards.json — per-film Oscar win/nomination COUNTS, keyed by IMDb id.
#
# This is a PARALLEL dataset to build.sh / controller/oscar-winners.json. The two do not
# overlap and neither touches the other's output:
#   • build.sh  → controller/oscar-winners.json : category collections (Best Picture, etc.),
#                 TMDB-keyed, feeds collectionsSweep() (the Oscar BoxSets).
#   • THIS       → controller/film-awards.json   : total {noms, wins} per film, IMDb-keyed,
#                 feeds oscarTagsSweep() → poster badges (web + Fire Stick). See DESIGN-OSCAR-BADGES.md.
#
# SOURCE: https://github.com/DLu/oscar_data  (oscars.csv) — every Academy Award nomination,
# IMDb-keyed, annually updated (DLu refreshes within days of each ceremony). See SOURCE.md.
#
# To update after a future Oscars ceremony:
#   1. Wait for the upstream repo to be refreshed (usually within days).
#   2. Run this from the repo root:  bash data/oscars/build-awards.sh
#   3. Commit the updated controller/film-awards.json, then rebuild+deploy the controller image.

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/controller/film-awards.json"
OUT_PEOPLE="$(cd "$HERE/../.." && pwd)/controller/person-awards.json"
TMPD="/tmp/oscar-awards-build"
rm -rf "$TMPD"
mkdir -p "$TMPD"

SOURCE_CSV="$TMPD/oscars.csv"
echo "Downloading DLu/oscar_data oscars.csv..."
if ! curl -sSL --fail -o "$SOURCE_CSV" \
     "https://raw.githubusercontent.com/DLu/oscar_data/main/oscars.csv"; then
  # Offline-idempotent: keep the previously-built file rather than clobbering it with nothing.
  if [ -f "$OUT" ]; then
    echo "WARN: download failed — keeping existing $OUT unchanged." >&2
    exit 0
  fi
  echo "ERROR: download failed and no existing $OUT to fall back on." >&2
  exit 1
fi

# The file is TAB-separated despite the .csv name; FilmId is pipe-delimited (a single
# acting nomination can list every film the nominee was cited for that year — each is
# credited, per DESIGN-OSCAR-BADGES.md §2.1). Use python3's csv module (quoted fields).
# Emits TWO files: film-awards.json (IMDb tt-keyed) and person-awards.json (name-keyed —
# people mostly lack IMDb ids in Jellyfin, so the controller matches them by normalized name).
exec python3 - "$SOURCE_CSV" "$OUT" "$OUT_PEOPLE" << 'PY'
import csv, json, sys, re, unicodedata
from collections import defaultdict

src, out, out_people = sys.argv[1], sys.argv[2], sys.argv[3]

# Name normalization — MUST stay byte-for-byte identical to normName() in controller/lib/oscar-tags.js
# (lowercase, strip accents, non-alphanumerics → single space, trim). A drift here silently breaks
# every person match.
def norm_name(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return s.strip()

# Drop non-competitive classes. In this dataset the non-feature awards split into two
# classes: "Special" (honorary / humanitarian / memorial) and "SciTech" (scientific &
# technical citations). Both are excluded — only competitive feature categories count.
# Sanity anchors that MUST hold (see §7): Titanic tt0120338 = 14/11, Shawshank
# tt0111161 = 7/0, Parasite tt6751668 = 6/4, Oppenheimer tt15398776 = 13/7.
DROP_CLASSES = {"Special", "SciTech"}

noms = defaultdict(int)
wins = defaultdict(int)
# Per-PERSON counts, keyed by IMDb person id (nm...) for accuracy, plus that id's display name.
pnoms = defaultdict(int)
pwins = defaultdict(int)
pname = {}

with open(src, newline="") as f:
    for row in csv.DictReader(f, delimiter="\t"):
        if (row.get("Class") or "") in DROP_CLASSES:
            continue
        won = (row.get("Winner") or "").strip() == "True"

        fid = (row.get("FilmId") or "").strip()
        if fid and fid != "?":
            for f_id in fid.split("|"):
                f_id = f_id.strip()
                if not f_id or f_id == "?":
                    continue
                noms[f_id] += 1
                if won:
                    wins[f_id] += 1

        # People: NomineeIds (nm... ids) aligned with Nominees (display names).
        nids = (row.get("NomineeIds") or "").strip()
        if nids and nids != "?":
            names = (row.get("Nominees") or row.get("Name") or "").split("|")
            for i, nm in enumerate(nids.split("|")):
                nm = nm.strip()
                if not nm or nm == "?" or not nm.startswith("nm"):
                    continue
                pnoms[nm] += 1
                if won:
                    pwins[nm] += 1
                if nm not in pname and i < len(names) and names[i].strip():
                    pname[nm] = names[i].strip()

# Emit { imdb_id: {"noms": N, "wins": M} }, sorted by id for stable diffs.
result = {k: {"noms": noms[k], "wins": wins.get(k, 0)} for k in sorted(noms)}
with open(out, "w") as f:
    json.dump(result, f, separators=(",", ":"), sort_keys=True)
    f.write("\n")

# Collapse per-nm person counts to normalized-name keys. When two distinct nm ids share a
# normalized name (rare — a common name), keep the MORE-awarded person rather than summing a
# nobody into a legend. Value carries the display name for debugging.
by_name = {}
for nm, n in sorted(pnoms.items()):
    key = norm_name(pname.get(nm, ""))
    if not key:
        continue
    entry = {"noms": n, "wins": pwins.get(nm, 0), "name": pname.get(nm, "")}
    prev = by_name.get(key)
    if prev is None or entry["noms"] > prev["noms"]:
        by_name[key] = entry
people = {k: by_name[k] for k in sorted(by_name)}
with open(out_people, "w") as f:
    json.dump(people, f, separators=(",", ":"), sort_keys=True)
    f.write("\n")

# Verify the anchors so a bad upstream change fails loudly instead of silently shipping.
ANCHORS = {"tt0120338": (14, 11), "tt0111161": (7, 0),
           "tt6751668": (6, 4), "tt15398776": (13, 7)}
bad = []
for tt, (en, ew) in ANCHORS.items():
    got = (result.get(tt, {}).get("noms", 0), result.get(tt, {}).get("wins", 0))
    if got != (en, ew):
        bad.append(f"  {tt}: got {got[0]}/{got[1]}, expected {en}/{ew}")

total_wins = sum(v["wins"] for v in result.values())
print(f"Wrote {len(result)} films ({total_wins} total wins) to {out}")
print(f"Wrote {len(people)} people to {out_people}")

# People anchors (keyed by normalized name).
PANCHORS = {"martin scorsese": (16, 1), "walt disney": (60, 22)}
for nm, (en, ew) in PANCHORS.items():
    got = (people.get(nm, {}).get("noms", 0), people.get(nm, {}).get("wins", 0))
    if got != (en, ew):
        bad.append(f"  person '{nm}': got {got[0]}/{got[1]}, expected {en}/{ew}")

if bad:
    print("ANCHOR CHECK FAILED — upstream data may have changed:", file=sys.stderr)
    print("\n".join(bad), file=sys.stderr)
    sys.exit(1)
print("Anchor check passed (films: Titanic 14/11, Shawshank 7/0, Parasite 6/4, Oppenheimer 13/7; "
      "people: Scorsese 16/1, Walt Disney 60/22).")
PY
