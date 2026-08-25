#!/usr/bin/env python3
"""Dump Radarr/Sonarr file metadata — the provenance Jellyfin doesn't store.

Jellyfin knows what a file IS (codec, bitrate, streams). The *arr apps know where it
CAME FROM: quality tier, source (BluRay/WEB-DL/HDTV), release group, custom-format
score, and the quality profile that chose it. The audit needs both halves.

Writes: radarr_movies.json, radarr_profiles.json,
        sonarr_series.json, sonarr_episodefiles.json, sonarr_profiles.json
"""
import json, subprocess, os, sys, urllib.request

OUT = os.path.dirname(os.path.abspath(__file__))


def key(container):
    return subprocess.run(
        ["docker", "exec", container, "sed", "-n",
         r"s:.*<ApiKey>\(.*\)</ApiKey>.*:\1:p", "/config/config.xml"],
        capture_output=True, text=True, check=True).stdout.strip().split("\n")[0]


def get(base, path, apikey):
    url = f"{base}/api/v3/{path}"
    url += ("&" if "?" in path else "?") + "apikey=" + apikey
    with urllib.request.urlopen(url, timeout=300) as r:
        return json.load(r)


def write(name, data):
    p = os.path.join(OUT, name)
    with open(p, "w") as f:
        json.dump(data, f, indent=1)
    n = len(data) if isinstance(data, list) else 1
    print(f"wrote {name}  ({n} items, {os.path.getsize(p)/1e6:.1f} MB)")


RK, SK = key("radarr"), key("sonarr")
R, S = "http://localhost:7878", "http://localhost:8989"

write("radarr_movies.json", get(R, "movie", RK))
write("radarr_profiles.json", get(R, "qualityprofile", RK))
write("radarr_customformats.json", get(R, "customformat", RK))

series = get(S, "series", SK)
write("sonarr_series.json", series)
write("sonarr_profiles.json", get(S, "qualityprofile", SK))
write("sonarr_customformats.json", get(S, "customformat", SK))

# episodefile is per-series; walk them all.
efs = []
for i, s in enumerate(series, 1):
    try:
        efs.extend(get(S, f"episodefile?seriesId={s['id']}", SK))
    except Exception as e:
        print(f"  !! series {s['id']} {s.get('title')}: {e}", file=sys.stderr)
    if i % 20 == 0:
        print(f"  episodefiles: {i}/{len(series)} series, {len(efs)} files",
              file=sys.stderr, flush=True)
write("sonarr_episodefiles.json", efs)
