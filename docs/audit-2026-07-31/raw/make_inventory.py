#!/usr/bin/env python3
"""Emit LIBRARY-INVENTORY.txt — distributions first, then the full per-file listing.

Ordered so the audit questions (what codecs, what bitrates, what won't direct-play)
are answerable from the first two pages, with the raw listing underneath as evidence.
"""
import json, os, collections, statistics

D = os.path.dirname(os.path.abspath(__file__))
flat = json.load(open(os.path.join(D, "library_flat.json")))
mov = [r for r in flat if r["kind"] == "movie"]
eps = [r for r in flat if r["kind"] == "episode"]

out = []
W = out.append


def hdr(t):
    W("")
    W("=" * 100)
    W(t)
    W("=" * 100)


def dist(title, rows, keyfn, total=None):
    """Print a sorted count+percent+size distribution."""
    c = collections.Counter()
    sz = collections.Counter()
    for r in rows:
        k = keyfn(r)
        c[k] += 1
        sz[k] += (r.get("size_bytes") or 0)
    n = total or sum(c.values()) or 1
    W("")
    W(f"-- {title} (n={sum(c.values())})")
    W(f"   {'value':<34} {'count':>7} {'pct':>7} {'total GB':>10} {'avg GB':>8}")
    for k, v in c.most_common():
        W(f"   {str(k):<34} {v:>7} {v/n*100:>6.1f}% "
          f"{sz[k]/1e9:>10.1f} {sz[k]/1e9/v:>8.2f}")


def stats(title, rows, valfn, unit="", scale=1.0):
    vals = sorted(v / scale for v in (valfn(r) for r in rows) if v)
    if not vals:
        W(f"-- {title}: no data")
        return
    q = lambda p: vals[min(int(len(vals) * p), len(vals) - 1)]
    W("")
    W(f"-- {title} (n={len(vals)}){unit}")
    W(f"   min {vals[0]:.2f} | p10 {q(.10):.2f} | p25 {q(.25):.2f} | "
      f"median {q(.50):.2f} | p75 {q(.75):.2f} | p90 {q(.90):.2f} | "
      f"p99 {q(.99):.2f} | max {vals[-1]:.2f}")
    W(f"   mean {statistics.mean(vals):.2f} | stdev "
      f"{statistics.stdev(vals):.2f}" if len(vals) > 1 else "")


# ============================================================ HEADER
W("MOVIE SERVER — FULL LIBRARY TECHNICAL INVENTORY")
W("Generated for the hardware/format audit.")
W("")
W("Sources joined per file:")
W("  * Jellyfin  /Items?Fields=MediaSources  — decoded stream truth (codec, profile,")
W("              level, bit depth, pixel format, colour transfer, channel layout)")
W("  * Radarr/Sonarr /api/v3 movieFile+episodefile — provenance (quality tier, source,")
W("              release group, scene name, custom-format score, cutoff status)")
W("")
W(f"Movie files   : {len(mov)}")
W(f"Episode files : {len(eps)}")
W(f"Total files   : {len(flat)}")
W(f"Total bytes   : {sum(r.get('size_bytes') or 0 for r in flat)/1e12:.3f} TB")
W(f"  movies      : {sum(r.get('size_bytes') or 0 for r in mov)/1e12:.3f} TB")
W(f"  episodes    : {sum(r.get('size_bytes') or 0 for r in eps)/1e12:.3f} TB")

# ============================================================ PLAYBACK MATRIX
hdr("SECTION 1 — HARDWARE PLAYBACK CLASSIFICATION")
W("")
W("Classification rules derived from measured hardware capability:")
W("  SERVER  Intel i5-6260U / Iris 540 VA-API decode: H264 all profiles, HEVC Main")
W("          8-bit, MPEG2, VC1, VP8. NO HEVC Main10, NO VP9, NO AV1.")
W("  CLIENT  Fire TV Stick 2 (MT8127): H264 + HEVC hardware decode, both capped at")
W("          1920x1088. 895 MB RAM. Output 1080p.")
W("")
W("  GREEN  = client hardware-decodes directly; server never touches it.")
W("  AMBER  = client cannot direct-play, but the SERVER can hardware-decode it,")
W("           so transcoding is possible (still costs a scarce QSV session).")
W("  RED    = neither can hardware-decode. Server falls back to SOFTWARE decode on a")
W("           2-core 15W chip. This is the failure class.")


def cls(r):
    c = (r.get("video_codec") or "").lower()
    bd = r.get("bit_depth") or 8
    w, h = r.get("width") or 0, r.get("height") or 0
    if c in ("av1", "vp9", "vp8"):
        return "RED   no server HW decode (" + c + ")"
    if c == "hevc" and bd and bd > 8:
        return "RED   HEVC 10-bit (server cannot HW decode)"
    if c == "h264" and bd and bd > 8:
        return "RED   H.264 Hi10P (client cannot HW decode)"
    if w > 1920 or h > 1088:
        return "AMBER over 1920x1088 client cap"
    if c == "hevc":
        return "GREEN HEVC 8-bit (client direct-play)"
    if c == "h264":
        return "GREEN H.264 8-bit (client direct-play)"
    if c in ("mpeg2video", "vc1", "mpeg4", "msmpeg4v3"):
        return "AMBER legacy codec, server HW decode ok"
    return f"AMBER other ({c})"


for label, rows in (("MOVIES", mov), ("EPISODES", eps), ("ALL", flat)):
    dist(f"Playback class — {label}", rows, cls)

# ============================================================ VIDEO
hdr("SECTION 2 — VIDEO CHARACTERISTICS")
for label, rows in (("MOVIES", mov), ("EPISODES", eps)):
    dist(f"Video codec — {label}", rows, lambda r: r.get("video_codec"))
    dist(f"Bit depth — {label}", rows, lambda r: r.get("bit_depth"))
    dist(f"Resolution (h) — {label}", rows,
         lambda r: f"{r.get('width')}x{r.get('height')}"
         if (r.get("width") or 0) > 1920 else f"height {r.get('height')}")
    dist(f"Video profile — {label}", rows,
         lambda r: f"{r.get('video_codec')} {r.get('video_profile')} L{r.get('video_level')}")
    dist(f"Dynamic range — {label}", rows, lambda r: r.get("video_range_type"))
    dist(f"Pixel format — {label}", rows, lambda r: r.get("pix_fmt"))
    dist(f"Container — {label}", rows, lambda r: r.get("container"))
    dist(f"Interlaced — {label}", rows, lambda r: r.get("interlaced"))
    dist(f"Ref frames — {label}", rows, lambda r: r.get("ref_frames"))

# ============================================================ BITRATE
hdr("SECTION 3 — BITRATE & SIZE (the UI colour-coding question)")
for label, rows in (("MOVIES", mov), ("EPISODES", eps)):
    W("")
    W(f"### {label}")
    stats(f"Total bitrate Mbps — {label}", rows,
          lambda r: r.get("total_bitrate"), scale=1e6)
    stats(f"Video bitrate Mbps — {label}", rows,
          lambda r: r.get("eff_video_bitrate"), scale=1e6)
    stats(f"File size GB — {label}", rows, lambda r: r.get("size_bytes"), scale=1e9)
    stats(f"GB per hour — {label}", rows, lambda r: r.get("gb_per_hour"))
    stats(f"Runtime min — {label}", rows, lambda r: r.get("runtime_sec"), scale=60)

W("")
W("-- Bitrate histogram, MOVIES (total stream bitrate)")
buckets = [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (5, 6), (6, 8), (8, 10),
           (10, 12), (12, 15), (15, 20), (20, 25), (25, 30), (30, 40), (40, 999)]
for lo, hi in buckets:
    n = [r for r in mov if r.get("total_bitrate")
         and lo <= r["total_bitrate"] / 1e6 < hi]
    if n:
        gb = sum(r.get("size_bytes") or 0 for r in n) / 1e9
        W(f"   {lo:>3}-{hi:<3} Mbps  {len(n):>4}  {'#'*min(60,len(n)//3)}  {gb:>8.1f} GB")

W("")
W("-- Bitrate by codec, MOVIES (median Mbps — is HEVC actually saving anything?)")
by = collections.defaultdict(list)
for r in mov:
    if r.get("total_bitrate"):
        by[r.get("video_codec")].append(r["total_bitrate"] / 1e6)
for k, v in sorted(by.items(), key=lambda x: -len(x[1])):
    W(f"   {str(k):<12} n={len(v):<5} median {statistics.median(v):>6.2f} Mbps  "
      f"mean {statistics.mean(v):>6.2f}")

W("")
W("-- Bitrate by *arr quality tier, MOVIES")
by = collections.defaultdict(list)
for r in mov:
    if r.get("total_bitrate"):
        by[r.get("arr_quality")].append(r["total_bitrate"] / 1e6)
for k, v in sorted(by.items(), key=lambda x: -len(x[1])):
    W(f"   {str(k):<22} n={len(v):<5} median {statistics.median(v):>6.2f} Mbps  "
      f"min {min(v):>6.2f}  max {max(v):>6.2f}")

# ============================================================ AUDIO
hdr("SECTION 4 — AUDIO (direct-play / AC3 compat-track question)")
for label, rows in (("MOVIES", mov), ("EPISODES", eps)):
    dist(f"Primary audio codec — {label}", rows, lambda r: r.get("audio_codec"))
    dist(f"Primary channel layout — {label}", rows, lambda r: r.get("audio_layout"))
    dist(f"Audio track count — {label}", rows, lambda r: r.get("audio_track_count"))

W("")
W("-- Every audio codec present across ALL tracks (not just the primary)")
c = collections.Counter()
for r in flat:
    for a in r.get("audio_streams") or []:
        c[f"{a.get('codec')} / {a.get('layout')}"] += 1
for k, v in c.most_common(40):
    W(f"   {k:<40} {v:>6}")

W("")
W("-- Files whose PRIMARY audio needs transcode for the Fire Stick")
W("   (Fire OS 5 reliably handles AAC/AC3; DTS/TrueHD/FLAC/PCM/Opus are the risk set)")
RISK = {"dts", "truehd", "flac", "pcm", "pcm_s16le", "pcm_s24le", "opus",
        "mlp", "dtshd", "vorbis", "eac3"}
risky = [r for r in flat if (r.get("audio_codec") or "").lower() in RISK]
W(f"   count: {len(risky)} of {len(flat)}")
has_compat = [r for r in risky
              if any((a.get("codec") or "").lower() in ("ac3", "aac")
                     for a in r.get("audio_streams") or [])]
W(f"   ...of which ALREADY have an AC3/AAC compatibility track: {len(has_compat)}")
W(f"   ...with NO compatible fallback track (will force transcode): "
  f"{len(risky)-len(has_compat)}")

# ============================================================ SUBS
hdr("SECTION 5 — SUBTITLES")
c = collections.Counter()
for r in flat:
    for s in r.get("subtitle_streams") or []:
        c[f"{s.get('codec')} ext={s.get('external')}"] += 1
for k, v in c.most_common(30):
    W(f"   {k:<40} {v:>6}")
W("")
W("   NOTE: PGS/DVDSUB are image subs — they cannot be burned in without a full")
W("   video transcode. ASS/SSA need software rendering. SRT is the cheap case.")

# ============================================================ PROVENANCE
hdr("SECTION 6 — PROVENANCE / GRAB QUALITY (how well is the picker doing?)")
for label, rows in (("MOVIES", mov), ("EPISODES", eps)):
    dist(f"*arr quality tier — {label}", rows, lambda r: r.get("arr_quality"))
    dist(f"Source type — {label}", rows, lambda r: r.get("arr_source"))
    dist(f"Cutoff not met (wants upgrade) — {label}", rows,
         lambda r: r.get("cutoff_not_met"))
dist("Release group — MOVIES (top)", mov, lambda r: r.get("release_group") or "(none)")

# ============================================================ OUTLIERS
hdr("SECTION 7 — OUTLIERS & AUDIT TARGETS")
W("")
W("-- 40 LARGEST movie files (disk-reclaim candidates)")
W(f"   {'GB':>7} {'Mbps':>7} {'codec':<7} {'res':<10} {'quality':<18} title")
for r in sorted(mov, key=lambda r: -(r.get("size_bytes") or 0))[:40]:
    W(f"   {(r.get('size_bytes') or 0)/1e9:>7.2f} "
      f"{(r.get('total_bitrate') or 0)/1e6:>7.2f} "
      f"{str(r.get('video_codec')):<7} "
      f"{str(r.get('width'))+'x'+str(r.get('height')):<10} "
      f"{str(r.get('arr_quality')):<18} {r.get('title')} ({r.get('year')})")

W("")
W("-- 40 HIGHEST-bitrate movies (over-spec for a 1080p Fire Stick?)")
for r in sorted(mov, key=lambda r: -(r.get("total_bitrate") or 0))[:40]:
    W(f"   {(r.get('total_bitrate') or 0)/1e6:>7.2f} Mbps "
      f"{(r.get('size_bytes') or 0)/1e9:>6.2f} GB  "
      f"{str(r.get('video_codec')):<6} {str(r.get('arr_quality')):<18} "
      f"{r.get('title')} ({r.get('year')})")

W("")
W("-- 40 LOWEST-bitrate movies (quality floor — are these too compressed?)")
lowm = [r for r in mov if r.get("total_bitrate")]
for r in sorted(lowm, key=lambda r: (r.get("total_bitrate") or 0))[:40]:
    W(f"   {(r.get('total_bitrate') or 0)/1e6:>7.2f} Mbps "
      f"{(r.get('size_bytes') or 0)/1e9:>6.2f} GB  "
      f"{str(r.get('video_codec')):<6} {str(r.get('arr_quality')):<18} "
      f"{r.get('title')} ({r.get('year')})")

W("")
W("-- ALL files in the RED playback class (software-decode failures)")
red = [r for r in flat if cls(r).startswith("RED")]
W(f"   count: {len(red)}")
for r in sorted(red, key=lambda r: -(r.get("size_bytes") or 0)):
    nm = r.get("title") if r["kind"] == "movie" else \
        f"{r.get('series')} S{r.get('season')}E{r.get('episode')} {r.get('title')}"
    W(f"   {cls(r):<44} {(r.get('size_bytes') or 0)/1e9:>6.2f} GB  "
      f"{str(r.get('video_codec')):<6} {r.get('bit_depth')}bit  {nm}")

W("")
W("-- Files ABOVE the 1920x1088 client decoder cap")
big = [r for r in flat if (r.get("width") or 0) > 1920 or (r.get("height") or 0) > 1088]
W(f"   count: {len(big)}")
for r in sorted(big, key=lambda r: -(r.get("size_bytes") or 0)):
    nm = r.get("title") if r["kind"] == "movie" else \
        f"{r.get('series')} S{r.get('season')}E{r.get('episode')}"
    W(f"   {r.get('width')}x{r.get('height')} "
      f"{(r.get('size_bytes') or 0)/1e9:>6.2f} GB {str(r.get('video_codec')):<6} {nm}")

W("")
W("-- Interlaced content (needs deinterlace = extra transcode cost)")
il = [r for r in flat if r.get("interlaced")]
W(f"   count: {len(il)}")
for r in il[:60]:
    nm = r.get("title") if r["kind"] == "movie" else \
        f"{r.get('series')} S{r.get('season')}E{r.get('episode')}"
    W(f"   {str(r.get('video_codec')):<6} {r.get('width')}x{r.get('height')}  {nm}")

# ============================================================ FULL LISTING
hdr("SECTION 8 — FULL PER-FILE LISTING: MOVIES")
W("")
W(f"{'title':<52}{'yr':<6}{'GB':>7}{'Mbps':>7}{'vcodec':>8}{'prof':>10}"
  f"{'lvl':>5}{'bd':>4}{'WxH':>11}{'fps':>7}{'acodec':>8}{'ch':>6}"
  f"{'#a':>4}{'#s':>4}  {'container':<6}{'quality':<18}{'group':<16}class")
for r in sorted(mov, key=lambda r: (r.get("title") or "").lower()):
    W(f"{str(r.get('title'))[:50]:<52}{str(r.get('year')):<6}"
      f"{(r.get('size_bytes') or 0)/1e9:>7.2f}"
      f"{(r.get('total_bitrate') or 0)/1e6:>7.2f}"
      f"{str(r.get('video_codec')):>8}{str(r.get('video_profile'))[:9]:>10}"
      f"{str(r.get('video_level')):>5}{str(r.get('bit_depth')):>4}"
      f"{str(r.get('width'))+'x'+str(r.get('height')):>11}"
      f"{str(r.get('fps')):>7}{str(r.get('audio_codec')):>8}"
      f"{str(r.get('audio_layout'))[:5]:>6}"
      f"{r.get('audio_track_count'):>4}{r.get('subtitle_count'):>4}  "
      f"{str(r.get('container')):<6}{str(r.get('arr_quality')):<18}"
      f"{str(r.get('release_group'))[:14]:<16}{cls(r)[:5]}")

hdr("SECTION 9 — FULL PER-FILE LISTING: EPISODES")
W("")
for series in sorted({r.get("series") for r in eps if r.get("series")}):
    se = [r for r in eps if r.get("series") == series]
    tot = sum(r.get("size_bytes") or 0 for r in se)
    W("")
    W(f"### {series}  —  {len(se)} files, {tot/1e9:.1f} GB")
    for r in sorted(se, key=lambda r: (r.get("season") or 0, r.get("episode") or 0)):
        W(f"   S{str(r.get('season') or 0).zfill(2)}E{str(r.get('episode') or 0).zfill(2)} "
          f"{str(r.get('title'))[:40]:<42}"
          f"{(r.get('size_bytes') or 0)/1e9:>6.2f}GB"
          f"{(r.get('total_bitrate') or 0)/1e6:>7.2f}Mbps "
          f"{str(r.get('video_codec')):>6} {str(r.get('bit_depth')):>2}bit "
          f"{str(r.get('width'))+'x'+str(r.get('height')):>10} "
          f"{str(r.get('audio_codec')):>6} {str(r.get('arr_quality')):<16} {cls(r)[:5]}")

p = os.path.join(D, "LIBRARY-INVENTORY.txt")
open(p, "w").write("\n".join(out))
print(f"wrote {p} ({os.path.getsize(p)/1e6:.2f} MB, {len(out)} lines)")
