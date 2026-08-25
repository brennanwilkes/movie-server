# Empirical playback tests — 2026-08-01

Method: Jellyfin remote-control (`POST /Sessions/{id}/Playing`) driving the live
Fire Stick session (`Amazon AFTT`, `Jellyfin Android TV (debug)` = the Movie Night
fork), then reading `/Sessions` for the settled `PlayMethod` / `TranscodingInfo`,
and `adb logcat` on the stick for the OMX component and AudioTrack format actually
instantiated.

**Methodological warning that cost us a wrong answer once already:** a session
sampled at ~20 s still reports `DirectPlay` for a file that ends up transcoding.
The first pass of these tests concluded "everything direct-plays", which was
wrong. Sample at **≥45 s** after issuing PlayNow. Every result below is from a
≥55 s window.

## Results

| File | Video | Audio | Server decision | Client decoder | AudioTrack out |
|---|---|---|---|---|---|
| American Graffiti | h264 8b 1920x1080 **19.7 Mbps** | AC3 2.0 | **DirectPlay** | `OMX.MTK.VIDEO.DECODER.AVC` | — |
| Blade Runner 2049 | h264 8b 1920x800 12.1 Mbps | **DTS 5.1 only** | **DirectPlay** | AVC | PCM 6ch → ALSA `channel_mask=3` |
| LOTR: The Two Towers | h264 8b 1920x804 18.7 Mbps | **TrueHD 7.1** | **DirectPlay** | AVC | PCM 8ch → ALSA `channel_mask=3` |
| Casablanca | h264 8b 1480x1080 18.0 Mbps | **FLAC 2.0** | **DirectPlay** | AVC | PCM 2ch → `channel_mask=3` |
| Spirited Away | **hevc 8-bit** 1920x1080 4.9 Mbps | AAC 5.1 | **DirectPlay** | HEVC | — |
| Blade Runner | **hevc Main10** 1920x800 L5.1 8.6 Mbps | EAC3-JOC (Atmos) | **TRANSCODE** | AVC (post-transcode) + `OMX.dolby.eac3_joc.decoder` (SW) | PCM 2ch → `channel_mask=3` |
| Bound by Honor | **hevc Main10 1920x1080** 5.6 Mbps | Opus 5.1 | **TRANSCODE** | AVC (post-transcode) | — |

## The only transcode trigger

`TranscodeReasons: ["VideoProfileNotSupported"]` — and on Blade Runner also
`VideoRangeTypeNotSupported`. **HEVC Main10 is the sole cause.** Nothing else in
the library forces server work on this client.

The client device profile, read verbatim from the `master.m3u8` the fork requested:

```
VideoCodec=hevc,h264  MaxWidth=1920  MaxHeight=1088
hevc-profile=main                     <-- Main only; Main10 absent
hevc-level=153                        <-- 5.1 accepted
h264-profile=high,main,baseline,constrainedbaseline
h264-maxrefframes=4
hevc-rangetype=Unknown,SDR,HLG,DOVIWithHLG,DOVIWithSDR
AudioCodec=eac3  eac3-audiochannels=8
```

This answers Q1 (no bitrate cap hit at 19.7 Mbps), Q2 (no Main10), Q3 (H.264 High,
4 ref frames), Q4 (client decodes DTS/TrueHD itself; no AC3 fallback needed).

## Q6 — HEVC 10-bit transcode throughput, true 1920x1080

Source: *Bound by Honor*, hevc Main10, 1920x1080, 5.6 Mbps, 23.976 fps.
Server decode is software (no `VAProfileHEVCMain10` in vainfo); encode is `h264_qsv`.
Sampled every 12 s from `TranscodingInfo.Framerate`.

| Server state | Sustained fps | × realtime |
|---|---|---|
| Downloads active (load 4.1 → 14.3) | 29–38, settling **31** | **1.29×** |
| Movie Mode on, quiesced (load 1.9 → 7.3) | 54, 54, 53, 52, 48, 49, 49 | **~2.1×** |

The 2026-07-31 estimate of 3.32× was optimistic, exactly as flagged — it came from
a 1424x1072 sample. **The real figure is 2.1× idle and 1.29× while downloading.**
The client logged 40 dropped frames during the loaded run.

A single 10-bit HEVC transcode also drove server load from 4.1 to 14.3 on a 4-thread box.

## Audio chain — every format ends in stereo

Regardless of source format, `AudioALSAStreamOut` opens with `channel_mask=3`
(`AUDIO_CHANNEL_OUT_STEREO`). TrueHD 7.1 decodes to 8-channel PCM and DTS 5.1 to
6-channel PCM inside ExoPlayer, then both are downmixed to 2.0 at the HDMI sink.

`persist.sys.hdmi.hdmiencodings: [2, 5, 6]` — the sink's EDID advertises PCM 16-bit,
AC3 and E-AC3 only. No DTS, no TrueHD passthrough. And the terminal devices are a
WiMiUS K5 (3.5 mm stereo out) into PreSonus Eris 3.5 — a **stereo** monitor pair.

## Historical corroboration

Jellyfin logs for 2026-07-30, 07-31 and 08-01 contain **zero** transcode sessions
prior to these tests. Real-world viewing has been hitting the direct-play path
essentially always.
