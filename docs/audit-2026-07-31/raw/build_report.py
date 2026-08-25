#!/usr/bin/env python3
"""Merge the Jellyfin + *arr dumps into one flat per-file record set, then emit
a human-readable inventory + distribution report for the hardware audit.

Jellyfin supplies the true decoded stream detail (per-stream codec, profile, level,
bit depth, channel layout, subtitle formats). Radarr/Sonarr supply provenance
(quality tier, source, release group, custom-format score). We join on file path.

Writes:
  library_flat.json  - one record per media file, both halves merged
  LIBRARY-INVENTORY.txt - the readable report
"""
import json, os, collections, statistics

D = os.path.dirname(os.path.abspath(__file__))
L = lambda n: json.load(open(os.path.join(D, n)))


def norm(p):
    """Jellyfin sees /media/..., the *arr apps see /data/media/... — same file."""
    if not p:
        return None
    for pre in ("/data/media/", "/media/"):
        if p.startswith(pre):
            return p[len(pre):]
    return p


# ---------------------------------------------------------------- *arr side
arr = {}
for m in L("radarr_movies.json"):
    mf = m.get("movieFile")
    if not mf:
        continue
    mi = mf.get("mediaInfo") or {}
    arr[norm(mf.get("path"))] = {
        "arr_quality": (mf.get("quality") or {}).get("quality", {}).get("name"),
        "arr_source": (mf.get("quality") or {}).get("quality", {}).get("source"),
        "arr_modifier": (mf.get("quality") or {}).get("quality", {}).get("modifier"),
        "arr_proper": (mf.get("quality") or {}).get("revision", {}).get("version"),
        "arr_repack": (mf.get("quality") or {}).get("revision", {}).get("isRepack"),
        "release_group": mf.get("releaseGroup"),
        "scene_name": mf.get("sceneName"),
        "edition": mf.get("edition"),
        "date_added": mf.get("dateAdded"),
        "cf_score": mf.get("customFormatScore"),
        "cutoff_not_met": mf.get("qualityCutoffNotMet"),
        "mi_video_codec": mi.get("videoCodec"),
        "mi_bit_depth": mi.get("videoBitDepth"),
        "mi_video_bitrate": mi.get("videoBitrate"),
        "mi_audio_codec": mi.get("audioCodec"),
        "mi_audio_channels": mi.get("audioChannels"),
        "mi_audio_bitrate": mi.get("audioBitrate"),
        "mi_dynamic_range": mi.get("videoDynamicRangeType") or mi.get("videoDynamicRange"),
        "mi_fps": mi.get("videoFps"),
        "mi_scan": mi.get("scanType"),
        "mi_resolution": mi.get("resolution"),
        "mi_subtitles": mi.get("subtitles"),
        "monitored": m.get("monitored"),
        "profile_id": m.get("qualityProfileId"),
    }

for ef in L("sonarr_episodefiles.json"):
    mi = ef.get("mediaInfo") or {}
    arr[norm(ef.get("path"))] = {
        "arr_quality": (ef.get("quality") or {}).get("quality", {}).get("name"),
        "arr_source": (ef.get("quality") or {}).get("quality", {}).get("source"),
        "arr_modifier": (ef.get("quality") or {}).get("quality", {}).get("modifier"),
        "arr_proper": (ef.get("quality") or {}).get("revision", {}).get("version"),
        "arr_repack": (ef.get("quality") or {}).get("revision", {}).get("isRepack"),
        "release_group": ef.get("releaseGroup"),
        "scene_name": ef.get("sceneName"),
        "date_added": ef.get("dateAdded"),
        "cf_score": ef.get("customFormatScore"),
        "cutoff_not_met": ef.get("qualityCutoffNotMet"),
        "mi_video_codec": mi.get("videoCodec"),
        "mi_bit_depth": mi.get("videoBitDepth"),
        "mi_video_bitrate": mi.get("videoBitrate"),
        "mi_audio_codec": mi.get("audioCodec"),
        "mi_audio_channels": mi.get("audioChannels"),
        "mi_audio_bitrate": mi.get("audioBitrate"),
        "mi_dynamic_range": mi.get("videoDynamicRangeType") or mi.get("videoDynamicRange"),
        "mi_fps": mi.get("videoFps"),
        "mi_scan": mi.get("scanType"),
        "mi_resolution": mi.get("resolution"),
        "mi_subtitles": mi.get("subtitles"),
        "profile_id": None,
    }


def streams(ms):
    """Split a Jellyfin MediaSource's stream list into typed buckets."""
    v, a, s = [], [], []
    for st in ms.get("MediaStreams") or []:
        t = st.get("Type")
        if t == "Video":
            v.append({
                "codec": st.get("Codec"), "profile": st.get("Profile"),
                "level": st.get("Level"), "bit_depth": st.get("BitDepth"),
                "width": st.get("Width"), "height": st.get("Height"),
                "bitrate": st.get("BitRate"), "fps": st.get("AverageFrameRate"),
                "real_fps": st.get("RealFrameRate"),
                "pix_fmt": st.get("PixelFormat"),
                "color_space": st.get("ColorSpace"),
                "color_transfer": st.get("ColorTransfer"),
                "color_primaries": st.get("ColorPrimaries"),
                "video_range": st.get("VideoRange"),
                "video_range_type": st.get("VideoRangeType"),
                "dv_profile": st.get("DvProfile"),
                "ref_frames": st.get("RefFrames"),
                "interlaced": st.get("IsInterlaced"),
                "avc": st.get("IsAVC"),
                "codec_tag": st.get("CodecTag"),
            })
        elif t == "Audio":
            a.append({
                "codec": st.get("Codec"), "profile": st.get("Profile"),
                "channels": st.get("Channels"),
                "layout": st.get("ChannelLayout"),
                "bitrate": st.get("BitRate"),
                "sample_rate": st.get("SampleRate"),
                "lang": st.get("Language"),
                "default": st.get("IsDefault"),
                "title": st.get("Title"),
            })
        elif t == "Subtitle":
            s.append({
                "codec": st.get("Codec"), "lang": st.get("Language"),
                "external": st.get("IsExternal"), "forced": st.get("IsForced"),
                "default": st.get("IsDefault"),
            })
    return v, a, s


def flatten(item, kind):
    out = []
    for ms in item.get("MediaSources") or []:
        v, a, s = streams(ms)
        v0 = v[0] if v else {}
        a0 = a[0] if a else {}
        path = ms.get("Path") or item.get("Path")
        ticks = item.get("RunTimeTicks") or ms.get("RunTimeTicks") or 0
        rec = {
            "kind": kind,
            "title": item.get("Name"),
            "series": item.get("SeriesName"),
            "season": item.get("ParentIndexNumber"),
            "episode": item.get("IndexNumber"),
            "year": item.get("ProductionYear"),
            "jf_id": item.get("Id"),
            "tmdb": (item.get("ProviderIds") or {}).get("Tmdb"),
            "imdb": (item.get("ProviderIds") or {}).get("Imdb"),
            "path": path,
            "filename": os.path.basename(path) if path else None,
            "container": ms.get("Container"),
            "size_bytes": ms.get("Size"),
            "runtime_sec": round(ticks / 1e7, 1) if ticks else None,
            "total_bitrate": ms.get("Bitrate"),
            "video_codec": v0.get("codec"),
            "video_profile": v0.get("profile"),
            "video_level": v0.get("level"),
            "bit_depth": v0.get("bit_depth"),
            "width": v0.get("width"),
            "height": v0.get("height"),
            "video_bitrate": v0.get("bitrate"),
            "fps": v0.get("fps"),
            "pix_fmt": v0.get("pix_fmt"),
            "video_range": v0.get("video_range"),
            "video_range_type": v0.get("video_range_type"),
            "color_transfer": v0.get("color_transfer"),
            "color_primaries": v0.get("color_primaries"),
            "dv_profile": v0.get("dv_profile"),
            "ref_frames": v0.get("ref_frames"),
            "interlaced": v0.get("interlaced"),
            "audio_codec": a0.get("codec"),
            "audio_profile": a0.get("profile"),
            "audio_channels": a0.get("channels"),
            "audio_layout": a0.get("layout"),
            "audio_bitrate": a0.get("bitrate"),
            "audio_track_count": len(a),
            "subtitle_count": len(s),
            "community_rating": item.get("CommunityRating"),
            "critic_rating": item.get("CriticRating"),
            "genres": item.get("Genres"),
            "tags": item.get("Tags"),
            "date_created": item.get("DateCreated"),
            "play_count": (item.get("UserData") or {}).get("PlayCount"),
            "played": (item.get("UserData") or {}).get("Played"),
            "video_streams": v,
            "audio_streams": a,
            "subtitle_streams": s,
        }
        rec.update(arr.get(norm(path), {}))
        # Derived: effective video bitrate, best available.
        vb = rec["video_bitrate"] or rec.get("mi_video_bitrate")
        if not vb and rec["size_bytes"] and rec["runtime_sec"]:
            vb = int(rec["size_bytes"] * 8 / rec["runtime_sec"])
        rec["eff_video_bitrate"] = vb
        if rec["size_bytes"] and rec["runtime_sec"]:
            rec["overall_bitrate_calc"] = int(rec["size_bytes"] * 8 / rec["runtime_sec"])
            rec["gb_per_hour"] = round(
                rec["size_bytes"] / 1e9 / (rec["runtime_sec"] / 3600), 2)
        out.append(rec)
    return out


flat = []
for m in L("movies.json"):
    flat += flatten(m, "movie")
for e in L("episodes.json"):
    flat += flatten(e, "episode")

json.dump(flat, open(os.path.join(D, "library_flat.json"), "w"), indent=1)
print(f"library_flat.json: {len(flat)} media files")
