#!/usr/bin/env python3
"""Dump the full Jellyfin library (movies + TV) with every media/file field available.

Writes:
  movies.json    - 860 movies, full MediaSources/MediaStreams
  series.json    - 96 series (show-level metadata)
  episodes.json  - all episodes, full MediaSources/MediaStreams
Key is read from the controller container; never written to disk.
"""
import json, subprocess, sys, urllib.parse, urllib.request, os

OUT = os.path.dirname(os.path.abspath(__file__))
BASE = "http://192.168.1.74:8096"
MOVIES_LIB = "f137a2dd21bbc1b99aa5c0f6bf02a805"
TV_LIB = "4514ec850e5ad0c47b58444e17b6346c"

KEY = subprocess.run(
    ["docker", "exec", "controller", "sh", "-c",
     "grep JELLYFIN_KEY /config/keys.env | cut -d= -f2"],
    capture_output=True, text=True, check=True).stdout.strip()

# Everything Jellyfin will give us that bears on files, encoding, or provenance.
FIELDS = ",".join([
    "Path", "MediaSources", "MediaStreams", "Container", "Size", "Bitrate",
    "Width", "Height", "RunTimeTicks", "DateCreated", "DateLastMediaAdded",
    "PremiereDate", "ProductionYear", "CommunityRating", "CriticRating",
    "OfficialRating", "Genres", "Tags", "Studios", "ProviderIds",
    "ParentId", "SeriesName", "SeasonName", "IndexNumber", "ParentIndexNumber",
    "MediaStreams", "VideoType", "Video3DFormat", "IsHD", "LocationType",
    "UserData", "SortName",
])
# NOTE: "People" and "Overview" are deliberately excluded. Requesting People makes
# each 200-item page take ~39s instead of ~1.7s (22x) and contributes nothing to a
# codec/bitrate audit.


def fetch(params):
    """Page through /Items and return every item."""
    items, start = [], 0
    while True:
        q = dict(params)
        q.update({"Recursive": "true", "StartIndex": start, "Limit": 200,
                  "Fields": FIELDS, "EnableImages": "false", "api_key": KEY})
        url = BASE + "/Items?" + urllib.parse.urlencode(q)
        with urllib.request.urlopen(url, timeout=180) as r:
            page = json.load(r)
        items.extend(page["Items"])
        total = page["TotalRecordCount"]
        start += 200
        print(f"  {len(items)}/{total}", file=sys.stderr, flush=True)
        if len(items) >= total or not page["Items"]:
            return items


def write(name, data):
    p = os.path.join(OUT, name)
    with open(p, "w") as f:
        json.dump(data, f, indent=1)
    print(f"wrote {p}  ({len(data)} items, {os.path.getsize(p)/1e6:.1f} MB)")


print("movies...", file=sys.stderr)
write("movies.json", fetch({"IncludeItemTypes": "Movie", "ParentId": MOVIES_LIB}))
print("series...", file=sys.stderr)
write("series.json", fetch({"IncludeItemTypes": "Series", "ParentId": TV_LIB}))
print("episodes...", file=sys.stderr)
write("episodes.json", fetch({"IncludeItemTypes": "Episode", "ParentId": TV_LIB}))
