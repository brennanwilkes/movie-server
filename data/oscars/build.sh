#!/usr/bin/env bash
set -euo pipefail
# Build controller/oscar-winners.json from the json-nominations dataset.
#
# SOURCE: https://github.com/delventhalz/json-nominations  (MIT)
# Every Oscar nomination 1927/28–2023 as structured JSON with TMDb IDs.
#
# To update after a future Oscars ceremony:
#   1. Wait for the upstream repo to be updated, or manually add winners to
#      data/oscars/latest-winners.json (see data/oscars/SOURCE.md).
#   2. Run this from the repo root:  bash data/oscars/build.sh
#   3. Commit the updated controller/oscar-winners.json.

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/controller/oscar-winners.json"
TMPD="/tmp/oscar-build"
rm -rf "$TMPD"
mkdir -p "$TMPD"

SOURCE_JSON="$TMPD/source.json"
if [ ! -f "$SOURCE_JSON" ]; then
  echo "Downloading json-nominations dataset..."
  curl -sSL -o "$SOURCE_JSON" \
    "https://raw.githubusercontent.com/delventhalz/json-nominations/main/oscar-nominations.json"
fi

exec python3 - "$SOURCE_JSON" "$OUT" "$HERE" << 'PY'
import json, re, sys, os

source_path, out_path, here = sys.argv[1], sys.argv[2], sys.argv[3]

with open(source_path) as f:
    data = json.load(f)

# Map json-nominations category names to our base names
BASE_NAMES = {
    "Best Picture": "Oscar: Best Picture",
    "Best Director": "Oscar: Best Director",
    "Best Actor": "Oscar: Best Actor",
    "Best Actress": "Oscar: Best Actress",
    "Best Supporting Actor": "Oscar: Best Supporting Actor",
    "Best Supporting Actress": "Oscar: Best Supporting Actress",
    "Best Film Editing": "Oscar: Best Film Editing",
    "Best Cinematography (Black and White)": "Oscar: Best Cinematography",
    "Best Cinematography (Color)": "Oscar: Best Cinematography",
}
CINEMA = {"Best Cinematography (Black and White)", "Best Cinematography (Color)"}

def parse_year(y):
    m = re.match(r"(\d{4})", y)
    return int(m.group(1)) if m else 0

def col_name(cat):
    return BASE_NAMES["Best Cinematography (Black and White)"] if cat in CINEMA else BASE_NAMES[cat]

# Build two maps per category: winners and all nominees
winners = {}   # base_name -> { tmdb_id -> {tmdb_id, title, year} }
nominees = {}  # base_name -> { tmdb_id -> {tmdb_id, title, year} }

for entry in data:
    cat = entry["category"].strip()
    if cat not in BASE_NAMES and cat not in CINEMA:
        continue
    base = col_name(cat)

    for movie in entry.get("movies", []):
        tid = movie.get("tmdb_id")
        if not tid:
            continue
        key = str(tid)
        obj = {
            "tmdb_id": tid,
            "title": movie.get("title", "Unknown"),
            "year": parse_year(entry.get("year", "0"))
        }

        # Always add to nominees
        if base not in nominees:
            nominees[base] = {}
        if key not in nominees[base]:
            nominees[base][key] = obj

        # Add to winners if won
        if entry.get("won"):
            if base not in winners:
                winners[base] = {}
            if key not in winners[base]:
                winners[base][key] = obj

# Merge latest-winners.json supplement (uses names with "(Winners)" suffix)
latest_path = os.path.join(here, "latest-winners.json")
if os.path.exists(latest_path):
    with open(latest_path) as f:
        latest = json.load(f)
    for full_name, items in latest.items():
        # Determine if this is winners or nominees from the suffix
        if "(Nominees)" in full_name:
            target = nominees
            base = full_name.replace(" (Nominees)", "")
        else:
            target = winners
            base = full_name.replace(" (Winners)", "")
        if base not in target:
            target[base] = {}
        for item in items:
            key = str(item["tmdb_id"])
            if key not in target[base] or item.get("year", 0) > target[base][key].get("year", 0):
                target[base][key] = item

# Output: both winners and nominees for each base name
result = {}
for base in sorted(set(list(winners.keys()) + list(nominees.keys()))):
    for suffix, data in [("(Winners)", winners), ("(Nominees)", nominees)]:
        if base not in data:
            continue
        items = sorted(data[base].values(), key=lambda x: (-x["year"], x["title"]))
        result[f"{base} {suffix}"] = items

with open(out_path, "w") as f:
    json.dump(result, f, indent=2)

total = sum(len(v) for v in result.values())
print(f"Wrote {len(result)} collections, {total} movie entries to {out_path}")
for col, items in sorted(result.items()):
    years = sorted(set(it["year"] for it in items))
    print(f"  {col}: {len(items)} movies ({years[-1]}–{years[0]})")
PY
