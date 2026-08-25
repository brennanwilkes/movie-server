# Library / Hardware Format Audit

**Pass 1 (2026-07-31)** — data collection, no judgements.
**Pass 2 (2026-08-01)** — empirical playback testing, research, and analysis.

**Pass 3 (2026-08-01)** — UI shipped, scale recalibrated, docs trimmed.

> ### Start here: [`../TODO-quality.md`](../TODO-quality.md)
> The work queue. It opens with the only two open workstreams: **(A)** the
> quality-profile curation pass (never started) and **(B)** the per-title CRF probe
> (designed, not built). This folder is the evidence behind them, not a plan.
>
> For the analysis itself: [`FINDINGS-2026-08-01.md`](FINDINGS-2026-08-01.md).
> For how quality is measured today: `AGENTS.md` → *How file quality is measured*.

**Headline from pass 2:** the projector is a **native 1280x720, 480-lumen** panel
and the speakers are a **stereo pair** — neither was modelled anywhere in the code
or in pass 1. Meanwhile the only file class that forces server work is **HEVC
Main10** (544 files); DTS, TrueHD, FLAC and 19.7 Mbps H.264 all direct-play, which
contradicts pass 1's "326 no-fallback files" finding. And that Main10 transcode
runs at **1.29× realtime under download load**, not the 3.32× pass 1 estimated.

Corrections are marked in place in the pass-1 documents; nothing was silently
overwritten.

## The question this data exists to answer

> Is the way we prioritise disk space, colour-code bitrates, and rank file
> formats in the controller UI actually correct for *our* hardware and *our*
> films — and how good a job is the grab algorithm doing at picking releases?

## Files

| File | What it is |
|---|---|
| `HARDWARE-CAPABILITIES.txt` | What the NUC and the Fire Stick can do, do well, do badly, and cannot do. Every claim tagged `[MEASURED]` / `[DERIVED]` / `[RESEARCH]`. |
| `HARDWARE-PROBES.txt` | Verbatim output of every hardware probe (`lscpu`, `vainfo`, `sensors`, `df`, adb `getprop`, `media_codecs.xml`, …) so the analysis session never needs the devices online. |
| `LIBRARY-INVENTORY.txt` | 4,037-line report: playback classification, codec/bitrate/audio/subtitle distributions, outliers, and a full per-file listing of all 860 movies and 1,696 episodes. |
| `WORKLIST-top100-profiles.txt` | **The one actionable list, and it is STILL UNDONE.** The Top 100 films not on the `Beloved (best quality)` profile, with current vs target size. Its header quotes the pre-recalibration bands; the film list and the safety analysis are still valid. |
| `raw/quality_model.py` / `raw/library_scored.json` | The scoring implementation and its output, re-runnable. |
| `FINDINGS-2026-08-01.md` | **The analysis.** Bottleneck ranking, source-tier truth, where the disk is going, Top 100 status. Trimmed 2026-08-01 — the UI spec shipped and the Q&A threads were folded into `AGENTS.md` / `../TODO-quality.md`. |
| `RESEARCH-APPENDIX.md` | **CLOSED 2026-08-01.** Q1–Q4 and Q6 answered by measurement, Q5 and the new Q7 (the projector) by cited sources. Q8–Q10 still open. |
| `raw/bitrate-plateau-2026-08-01.md` | Does quality plateau above 8 Mbps? Measured to 247 BPP+ — **no**. Corrects an earlier 3.1x-overkill claim and reframes Q8 as the critical open question. |
| `raw/RESEARCH-quality-metrics-2026-08-01.md` | **The state of the art, and why it does not save us.** No-reference metrics, VMAF v1, per-title/convex-hull encoding, complexity proxies. Concludes: no NR metric survives the grain confound; the CRF probe is the real fix. Every claim URL-tagged. |
| `raw/playback-tests-2026-08-01.md` | Empirical Fire Stick playback matrix, the client's verbatim device profile, and the Q6 transcode-throughput measurements. |
| `raw/library_flat.json` | **The main machine-readable artifact.** 2,556 records, one per media file, Jellyfin stream data joined to *arr provenance. Start here for any analysis. |
| `raw/*.json` | Unmodified API dumps (Jellyfin movies/series/episodes; Radarr/Sonarr movies, series, episodefiles, quality profiles, custom formats). |

> **Six of those dumps are gitignored** — `episodes`, `movies`, `library_flat`, `library_scored`,
> `radarr_movies`, `sonarr_episodefiles` (~50 MB total, machine-generated, never edited). They are
> present on the NUC but **not in a fresh clone**; re-dump with `raw/dump_library.py` +
> `raw/dump_arr.py` (which gives a *current* library, not the July snapshot). The authored analysis
> and the small config dumps are committed normally.
| `raw/*.py` | The four scripts that produced everything, re-runnable. |

## How the data was collected

```
dump_library.py   Jellyfin /Items?Fields=MediaSources  -> movies/series/episodes.json
dump_arr.py       Radarr + Sonarr /api/v3              -> radarr_*/sonarr_*.json
build_report.py   join on file path                    -> library_flat.json
make_inventory.py                                      -> LIBRARY-INVENTORY.txt
```

Jellyfin paths are `/media/...`, *arr paths are `/data/media/...`; the join
normalises both. **All 2,556 files matched** — there are no unjoined records.

## Scope note

Counts differ between systems, and the difference is itself a finding:

- Radarr tracks **876** movies; **860** have files. Sonarr tracks **97** series.
- Jellyfin's Movies library shows **860** movies, TV shows **96** series / 1,696 episodes.
- Jellyfin *globally* reports 1,121 "Movie" items — the extra **261 are
  placeholder entries under `/media/JellyBridge`**, not real files. They are
  excluded from this dataset.

## Key measured facts (no interpretation)

> **Pass-2 corrections to this list:** the "326 no-AC3-fallback files force an audio
> transcode" bullet is **wrong for the Fire Stick** — it decodes DTS/TrueHD itself and
> direct-plays them. The HEVC 10-bit throughput figure is superseded (1.29–2.1×, not
> 3.32×). Everything else below still holds. Library totals have grown to 5.04 TB.

- **Server cannot hardware-decode HEVC 10-bit, VP9, or AV1.** Confirmed by
  `vainfo`: no `VAProfileHEVCMain10`, no VP9, no AV1 entrypoints.
- **Client decoders cap at 1920x1088** and the display is 1080p.
- Measured transcode throughput on the NUC (60s runs, video-only, `h264_qsv` out):
  - H.264 8-bit in → **232 fps (9.66× realtime)**
  - HEVC 8-bit in → **214 fps (8.92× realtime)**
  - HEVC 10-bit in (software decode) → **100 fps (3.32× realtime)** — but the
    sample was 1424x1072, not full 1080p, so this is an *optimistic* bound.
- **21% of the library (544 files) is HEVC 10-bit**, concentrated in TV
  (524 of 1,696 episodes = 31%).
- **HEVC is not saving space here.** Movies: h264 median 2.38 Mbps (n=794) vs
  hevc median 2.53 Mbps (n=64).
- Movie bitrate distribution: median **2.40 Mbps**, p90 5.95, p99 13.32, max 19.70.
- **326 files have a DTS/TrueHD/FLAC/Opus/E-AC3 primary track and no AC3/AAC
  fallback**, so they force an audio transcode.
- Subtitles: 4,903 embedded SRT, 1,302 external SRT, 415 ASS, 415 PGS, 55 DVDSUB.
- `Remux-1080p` is labelled on 4 movies whose median bitrate is 2.66 Mbps — a
  real remux is 20-30 Mbps, so that quality label is not trustworthy.

## Server health at collection time (state, not capability)

Worth carrying into the analysis, because it changes what "the server can
handle a transcode" means in practice:

- Swap **100% full** (7.9 GiB), 181 MiB RAM free — the box is thrashing.
- Load average **6.36** on 4 threads at first measurement.
- CPU package **86 °C** (crit 100 °C), sustained.
- Root filesystem **94% full** — 15 GB free. `/data` is 64% used (2.7 TB free).

## The four levers (Brennan's framing, 2026-08-01)

**A. Use the Beloved profile properly.** 78 of 112 Top 100 films aren't on it.
Verified safe: reassignment cannot trigger a download (`upgradeAllowed=false`,
and Beloved's allowed-quality list already covers every existing file).
→ `WORKLIST-top100-profiles.txt`

**B. Dial the three profiles to the measured model.** Open — blocked on the CRF probe
giving a defensible target.

**C. Recolour Library + Audit around objective bpp bands + profile intent.**
**DONE and deployed 2026-08-01.** Colour is the carrier; the verdict is a sort order,
not a badge. Shipped in `controller/web/js/{library,audit,util}.js`.

**D. Rebuild audit suggestions on the measured hardware facts.** **DONE.**

**→ [`../TODO-quality.md`](../TODO-quality.md) is the work queue.** It opens with the two
open workstreams: (A) the quality-profile curation pass, never started, verified live on
2026-08-01 as 749 Normal / 91 Low / 36 Beloved; and (B) the per-title CRF probe, designed
but not built. Everything else — NUC disk, HDMI→speakers, projector shopping — is parked
there too.

**The UI work described in earlier drafts of these documents is DONE and deployed.** Do not
re-plan it. `SPEC-ui-changes.md` was deleted 2026-08-01 for exactly that reason; the shipped
behaviour lives in `controller/web/js/{library,audit,util}.js` and is documented in
`AGENTS.md` → *How file quality is measured*.

## Status / what to do next

Pass 2 closed every starting point from pass 1. Current state:

1. ~~Compare UI bitrate thresholds against the distribution~~ — **done.** 82.7% of
   movies landed in the worst band under the old raw-Mbps rule; replaced by BPP+.
2. ~~Check whether grab rules distinguish HEVC 8-bit from 10-bit~~ — **they do**
   (`release-rules.js` TENBIT_RE, `audit.js` depthMap, and a −150 custom format).
   Confirmed correct against measurement.
3. ~~Reconcile gpu-verify/audit classification against vainfo~~ — **consistent.**
   `deviceSupport()` and `devNuc()` match the measured hardware.
4. ~~Decide on extending ps4ify to the Fire Stick~~ — **not needed.** The Fire
   Stick decodes DTS/TrueHD itself; the compat track is PS4-only value.
5. ~~Re-measure HEVC 10-bit at true 1080p~~ — **done.** 2.1× idle, 1.29× loaded.

Pass 3 (2026-08-01) shipped the UI and recalibrated the scale. BPP+ is now
square-rooted so it tracks picture rather than bits (200 ~= half the visible error
of 100), HEVC is x1.6 not x1.8, and the bands moved to 125/100/75 — the same
cutoffs carried through the transform, so no file changed colour except 8 that
moved red→orange on rounding. Q9/Q10 closed; the release-group question closed.

Open, in priority order:

1. **Assign the 78 Top 100 films to the `Beloved (best quality)` profile**
   (`WORKLIST-top100-profiles.txt`). Inert until searched; biggest single lever.
2. **The per-title CRF probe** — the one thing that would replace the guessed
   `BPP_TARGET` constant with a measured per-film value, and the only route left
   to resolving the 720p-display credit. Design in
   `raw/RESEARCH-quality-metrics-2026-08-01.md` §2; scheduled in `../TODO-quality.md`.
3. **Reclaim ~14.5 GB on the root filesystem** (94% full) — commands listed in
   `FINDINGS-2026-08-01.md`, not yet run, needs approval.
4. **Decide the priority taxonomy** — it must cover TV, not just the Top 100
   playlist. Lost is the proof: 74 series sit on `Normal` with no per-title
   mechanism to say one matters more than another.

**Q8 is no longer answerable the way it was framed.** The A/B viewing test was
abandoned 2026-08-01 (Brennan: everything will look "sort of good" by eye), and
SSIM is confounded by grain in exactly this regime. It is now a sub-goal of the
CRF probe, not a standalone experiment.
