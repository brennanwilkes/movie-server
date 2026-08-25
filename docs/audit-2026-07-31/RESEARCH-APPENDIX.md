# Research Appendix — CLOSED 2026-08-01

Superseded the 2026-07-31 version, which recorded that both research subagents had
been killed and that nothing here was externally sourced.

**Q1–Q4 and Q6 were closed by direct measurement, not research** — see
`raw/playback-tests-2026-08-01.md`. That is a better outcome than forum consensus.
Q5 and the projector question are genuinely external and are sourced below.

Provenance tags are unchanged: `[MEASURED]` on this hardware, `[DERIVED]` from a
measurement, `[RESEARCH]` from a cited external source.

---

## Q1 — Bitrate ceiling before the MT8127 stutters — CLOSED [MEASURED]

**No ceiling reached.** *American Graffiti* at 19.7 Mbps (the library maximum) and
*LOTR: The Two Towers* at 18.7 Mbps both direct-played cleanly. The device profile
the fork submits carries no bitrate condition at all — only `MaxWidth=1920`,
`MaxHeight=1088`. The stick is on wired ethernet, so delivery is not in question
either.

Practical reading: **bitrate is not a client constraint anywhere in our range.**

## Q2 — Does MT8127 decode HEVC Main10? — CLOSED, NO [MEASURED] + [RESEARCH]

The client profile advertises `hevc-profile=main` with no `main10`. Playing a
Main10 file produced `TranscodeReasons: VideoProfileNotSupported` and the server
transcoded to H.264. Confirmed externally: the Gen-2 stick pairs the MT8127 with a
Mali-450 GPU, and 10-bit requires Mali-T800 — a hard silicon limit. Jellyfin
tracked this as [androidtv#3952](https://github.com/jellyfin/jellyfin-androidtv/issues/3952)
and [#4006](https://github.com/jellyfin/jellyfin-androidtv/issues/4006), where the
stock client wrongly *attempted* direct play and failed.

**Our fork gets this right** — it declares Main-only and lets the server transcode.
That is worth knowing before anyone "fixes" the profile.

## Q3 — H.264 level and reference frames — CLOSED [MEASURED]

From the submitted profile: `h264-profile=high,main,baseline,constrainedbaseline`
and `h264-maxrefframes=4`. Every H.264 file in the library is Level 4.1 or below,
so nothing is near this limit. HEVC is accepted up to `hevc-level=153` (5.1) —
level is not our problem, bit depth is.

## Q4 — AC3/EAC3/DTS over HDMI: bitstream or PCM? — CLOSED [MEASURED]

**Neither, in the way the question assumed.** ExoPlayer decodes the audio *itself*
in software and hands PCM to AudioTrack — DTS 5.1 → 6-channel PCM, TrueHD 7.1 →
8-channel PCM, EAC3-JOC → via `OMX.dolby.eac3_joc.decoder`. Then `AudioALSAStreamOut`
opens every single time with `channel_mask=3` = stereo.

The sink advertises `hdmiencodings [2,5,6]` (PCM16, AC3, E-AC3 — no DTS, no TrueHD),
but it does not matter: the projector's only audio output is a 3.5 mm stereo jack
feeding a stereo monitor pair.

**Consequence: the AC3-compat-track strategy is unnecessary for the Fire Stick path.**
The 328 files with no AC3/AAC track are a non-problem for the 95% client. `ps4ify`
remains correct *for the PS4*, which is 1% of playback.

## Q5 — At what bitrate is 1080p H.264 visually transparent? — [RESEARCH]

This one has no local answer and the honest summary is that the sources give a
range, not a number.

- CRF 17–18 is the widely repeated threshold for "visually lossless" x264, with
  CRF 16 cited for grain-heavy Blu-ray sources
  ([slhck CRF guide](https://slhck.info/video/2017/02/24/crf-guide.html),
  [VideoHelp CRF threads](https://forum.videohelp.com/threads/398461-CRF-values),
  [Doom9](https://forum.doom9.org/archive/index.php/t-174679.html)).
  On typical 1080p live-action that lands roughly **8–12 Mbps**, higher for grain.
- Streaming services deliver 1080p at far less: ~3.6 Mbps for YouTube 1080p, and
  4–8 Mbps is the commonly quoted "high quality 1080p H.264" band
  ([Jellyfin hardware guide](https://jellywatch.app/blog/jellyfin-server-hardware-requirements-2026),
  [Blu-ray vs WEB-DL comparisons](https://www.bluraycopys.com/rip-blu-ray/blu-ray-vs-webdl/)).
- Blu-ray itself runs up to ~35 Mbps, which is why a remux is 20–40 GB.

**Caveat that matters more than the numbers:** all of the above assume a 1080p
display. Ours is not one — see below. Treat 8–12 Mbps as the transparency target
*for a 1080p panel*, and read our own situation against the projector finding, not
against this figure.

## Q6 — True 1920x1080 HEVC 10-bit software-decode throughput — CLOSED [MEASURED]

**2.1× realtime idle, 1.29× realtime while downloading.** Not the 3.32× estimated
on 2026-07-31 from an undersized sample. Full method and per-sample figures in
`raw/playback-tests-2026-08-01.md`.

---

## Q7 (NEW) — What is the display actually capable of? — [RESEARCH]

Not asked on 2026-07-31, and it turns out to be the most consequential fact in the
whole audit.

**The WiMiUS K5 is a native 1280x720 panel.** It accepts 1080p input and downscales.

- [projector-database.com — Wimius K5](https://www.projector-database.com/pro/wimiusk5-en.html):
  Native Resolution "HDTV 1280 x 720"; accepts "HDTV 1920 x 1080 compressed";
  480 ANSI lumens; 9000:1 full-on/off; mini-jack audio in and out.
- [WiMiUS store listing](https://store.wimius.com/products/wimius-home-projector-k5)
  and [manuals.plus user manual](https://manuals.plus/wimius/k5-projector-wifi-bluetooth-projector-manual)
  corroborate 1280x720 native with 1080p support, 2 HDMI, 3.5 mm audio out.

The Fire Stick outputs 1080p (`persist.sys.hdmi.tvresolution: 1080_1`) and the
projector scales it to 720p. 480 ANSI lumens with a real (not marketing) contrast
ratio in the low thousands also means shadow detail and fine grain are the first
things lost — long before codec-level detail is.

Speakers are **PreSonus Eris 3.5** — 3.5" powered *stereo* monitors, which is the
other half of why the audio chain collapses to 2.0.

**This is not a reason to stop storing 1080p.** Downscaling 1080p to 720p is
supersampling and looks visibly better than a native 720p source — our 68
Bluray-720p movies at a 1.00 Mbps median are genuinely the worst-looking files we
own. It *is* a reason to disbelieve that the top of the bitrate range buys
anything on this display.

---

## What is still open

| # | Question | Why it is still open |
|---|---|---|
| Q8 | At what bitrate does 1080p-downscaled-to-720p become transparent *on a 480-lumen projector*? | **NOW THE HIGHEST-VALUE OPEN QUESTION.** Measured 2026-08-01 (`raw/bitrate-plateau-2026-08-01.md`): SSIM shows **no plateau at all** up to 247 BPP+ on grain-heavy film — each step buys *more* than the last. But SSIM over-rewards grain reproduction, so that is an upper bound, not proof of visibility. Only an A/B viewing test on the actual wall can say whether purple is real or wasted, and the scale's upper boundary rests on it. |
| Q9 | Does the Movie Night fork expose an AC3/EAC3 passthrough toggle, and would the projector do a better job of the downmix than ExoPlayer? | Only matters if Brennan ever cares about the 2.0 fold-down quality; measurable but not yet measured. |
| Q10 | Are the 3 `Remux-1080p`-labelled movies (median 3.09 Mbps) mislabelled, or did Radarr inherit a bad quality tag? | Cheap to check per-file; the label is currently not trustworthy. |
