# TODO — file quality work

Parked items from the 2026-07-31/08-01 audit. Nothing here is in progress.
Evidence for all of it: `docs/audit-2026-07-31/`.

---

# ⭐ THE TWO OPEN WORKSTREAMS — START HERE

Everything else on this page is background. If you are a new agent picking this up,
these are the two things Brennan is waiting on.

## A. The quality-profile curation pass — NOT STARTED, biggest single lever

**Verified live 2026-08-01: Radarr is 749 `Normal` / 91 `Low (save space)` /
36 `Beloved (best quality)`.** Identical to the 2026-07-31 dump — nothing has moved.
Only 36 of 112 Top 100 films are on `Beloved`.

This is a **one-time manual pass over the library**, title by title, moving films off
the `Normal` default and onto `Beloved` or `Low` where `Normal` is simply the wrong
label. It is the highest-value item in the whole audit because the profile is where
*intent* lives — the colour bands are deliberately objective, so a film only gets
treated as important if its profile says it is.

**IT IS SAFE AND IT DOES NOT REDOWNLOAD ANYTHING.** Verified 2026-08-01:
- `upgradeAllowed=false` on all three profiles → cutoff-unmet never fires
- `Beloved`'s allowed-quality list spans SDTV..Bluray-1080p, so every existing file
  already satisfies it
- RSS sync therefore has nothing to grab for a movie that already has a file

Nothing moves until someone deliberately searches. Reassignment is pure relabelling.

**The worklist already exists:** `docs/audit-2026-07-31/WORKLIST-top100-profiles.txt`
— the Top 100 films not on `Beloved`, with current vs target size. Note its header
quotes the OLD band thresholds (raw bpp, HEVC x1.8); the bands are now BPP+
125/100/75 with HEVC x1.6. The film list and the safety analysis are still valid.

**How Brennan wants it done:** as a conversation, title by title — not a bulk script.
He decides what is acceptable per film by style; a crappy 2000s romcom sitting in red
is fine and even desirable if it saves disk. Do not batch-assign. Do not infer intent
from the colour.

## B. The per-title CRF probe — LIVE. Only calibration is left.

**→ Full design: `docs/DESIGN-CRF-PROBE.md`. Read that, not the sketch further
down this page, which it supersedes.** Operational detail: `AGENTS.md`.

Shipped 2026-08-05 (`controller/lib/probe.js` + `controller/scripts/probe-film.sh`),
ran one observe-only night, **cut over 2026-08-06** — every BPP+ in the app is now
divided by the film's own measured complexity. Status: `curl localhost:8088/api/probe`.

### What night one proved (67 films, 01:00–05:25, zero failures)

Stopped exactly on budget (242 of 240 min), not on the window. ~198 s median per
film ⇒ **~69 units/night, ~14 nights for 1014 units**.

| | complexity | note |
|---|---|---|
| Schindler's List (1993) | 0.3511 | highest — B&W, heavy grain |
| Casablanca (1943) | 0.2785 | |
| **measured median** | **0.1237** | the old flat 0.13 was a good *average* |
| Blade Runner 2049 (2017) | 0.0670 | |
| Dune (2021) | 0.0436 | lowest — clean digital |

**8.1× spread, and the flat constant's error was systematic** — it overrated grainy
film-stock transfers and underrated clean modern digital ones. Casablanca 183→125,
Schindler's List 94→57, Blade Runner 2049 137→191, Dune 69→118.

Reproducibility, unprompted: Ocean's Eleven/Twelve/Thirteen landed within 4% of each
other; six Mission: Impossible films clustered 0.111–0.163 with the cleanest lowest.

Two operational findings: **Brennan's 95C thermal call was decisive** (window median
was 88C, max 92C, and 60.7% of samples were ≥88 — the originally-proposed 88/80 gate
would have spent the night cooling), and **trickplay is a non-issue** (3m51s at 03:00).

### The ONE thing still open: where 100 sits

`HEADROOM_TARGET = 1.0` asserts Brennan's "perfect tradeoff" is exactly CRF-20
transparency. That is the standard 1080p figure, **not a measurement of his eyes.**

**What is needed: ~10 films he has judged** — a few clearly excellent, a few clearly
poor, a couple borderline (design §12 Q1). Then confirm or move the anchor.

Safe to run unpinned: the anchor is one read-time multiplier applied to every title,
so it moves the whole scale without reordering it, and **moving it needs no
re-probing** (x265 ≈ −15%/CRF point, so CRF 22 is just `HEADROOM_TARGET ≈ 0.72`).

Relevant measurement: **90% of files sit below CRF-20 transparency** (median R 0.49),
so the library median BPP+ is ~69. Whether that is fine on a native-720p projector is
the judgement, not a bug. Brennan's call 2026-08-06: **recalibrate once more of the
library is scanned, not now.**

**Never re-anchor 100 to the library median.** `maybeCalibrate()` reports what the
median implies and deliberately does not apply it — see the reasoning in probe.js.

## B2. Jellyfin "Scan Media Library" wedged — WATCH FOR RECURRENCE (2026-08-05)

Found while verifying the probe: the task sat at **92.76% for well over an hour**
burning **~128% CPU**, holding the NUC at 86C all evening. Not a probe bug — the
probe merely noticed it, and it is why the first verification runs kept refusing.

**It cleared itself overnight** and now completes in ~39 s. Deliberately never
cancelled (Brennan: do not touch it). **Root cause was never found**, so this stays
open as a watch item rather than closed — if it recurs, start with Jellyfin's logs
around the scan's start and which item it stalls on (a single unreadable or
pathological file is the usual cause).

Related: `PROBE_YIELD_TO_JELLYFIN` in probe.js can make the probe stand down while
Jellyfin runs heavy tasks. It is **off by default** on purpose — with it on, one
wedged Jellyfin task would cost weeks of probing.

## B3. Zombie Jellyfin sessions — FIXED 2026-08-06

`anyonePlaying()` blocked on any session with a `NowPlayingItem` and no idle timeout,
so a client that died mid-film (background the iOS app, kill the Fire Stick, lose
wifi) would have blocked the probe **forever**, silently — every night reporting
"someone is watching". Near-missed on night one: a Streamyfin/iPhone session was
playing at 22:27 and only ended cleanly by luck. Sessions demonstrably persist here
(the list carries entries days old).

Fix: ignore sessions whose `LastActivityDate` is older than `PROBE_PLAY_STALE_MS`
(15 min). A live client heartbeats every few seconds — including while paused — so a
real pause is never mistaken for a zombie. No timestamp at all is treated as LIVE.

---

## Deferred infrastructure (Brennan handling separately)

- [ ] **HDMI → speakers path.** Assumed chain is Fire Stick → HDMI → projector →
      3.5 mm → PreSonus Eris 3.5. If so, the projector's headphone-amp stage is
      the weak link, and a ~$30–60 HDMI audio extractor with analog out would
      bypass its DAC entirely. Confirm the actual wiring first.

## Research / experiments worth doing later

- [x] **Is release group a usable quality signal?** ANSWERED 2026-08-01. Yes, but
      only as a *predictor of bpp+*, not as information on top of it. Across 665
      Bluray-1080p H.264 files (like-for-like), median bpp+ by group ranges 223
      (HALLOWED) down to 27 (CLASSICS) — an 8x spread — and within-group variance
      is tight (OFT n=36: 91–108; YIFY n=102: 26–46). So a group name predicts
      bpp+ well enough to rank a release *before* downloading it, which is useful
      in the force-grab picker and for candidates with no mediainfo. It does NOT
      answer the original question (does a good encoder at 0.10 beat a bad one at
      0.20?) — that needs a perceptual metric, not bitrate. Full table in
      `docs/audit-2026-07-31/raw/` analysis, re-runnable from `library_scored.json`
      joined to `radarr_movies.json` on the last two path segments.
- [x] **Per-file complexity measurement — THE CRF PROBE. BUILT AND LIVE 2026-08-06.**
      See §B above for what shipped and what it measured; the sketch below is kept
      only because its reasoning about *why* the flat constant had to go is still the
      clearest statement of it. Everything the sketch proposes was either built or
      superseded — do not work from this list.
      Design revised 2026-08-01 after the metrics research
      (`docs/audit-2026-07-31/raw/RESEARCH-quality-metrics-2026-08-01.md` §2); the
      earlier "one 60 s clip at CRF 18" version had two flaws — a single sample
      cannot represent a film whose scene complexity varies 2.4x, and measuring at
      1080p charges the file for pixels the 720p projector discards.

      ```
      8 x 4s samples, evenly spaced, skipping the first and last 5%
      each: ffmpeg -ss T -t 4 -i FILE -vf scale=1280:720:flags=lanczos \
                   -c:v libx265 -crf 20 -preset medium -an -f null -
      probeBitrate = total encoded bits / 32s
      R = sourceVideoBitrate / probeBitrate
      ```

      `R` is a *measured* per-title answer to "how many bits does this content
      need", replacing the single global 0.13 constant. Downscaling before probing
      is also a free grain filter, which is the confound that broke SSIM.
      ~1–3 min CPU/file, ~20–50 h for the library, cacheable forever (only changes
      if the file changes). **Brennan: happy to run this over a weekend away.**
      Must checkpoint and respect Movie Mode.

      Two things to build with it, both cheap on the same 8 samples:
      `ffmpeg -vf blockdetect` (catches an already-destroyed source, which is
      *cheap* to re-encode and therefore fools the probe) and libvmaf's CAMBI
      (banding, 0–24, ~5 starts to annoy). These are the only two no-reference
      measures in the whole research report validated on compression artifacts.

      **Calibrate before trusting absolute values:** run it on ~10 files whose
      quality Brennan has already judged and set the R thresholds so those land
      where they belong. Skip this and the numbers are arbitrary.
- [ ] **Does audio still matter after a projector upgrade?** Current answer is no
      — a new projector does not add speakers, and the Eris 3.5 are a stereo pair.
      It only changes if the speaker setup changes too (or the new projector has
      HDMI ARC/optical into a future AVR). Revisit when the projector is bought.
      Meanwhile: keep multichannel tracks, stop *colouring* them as quality.
- [ ] **Q8 — transparent bitrate on THIS projector.** The one number that most
      affects the disk budget. **A/B viewing test ABANDONED 2026-08-01** — Brennan's
      call: everything will look "sort of good" to the naked eye, so the test
      cannot resolve it. Replaced by: find a perceptual metric that predicts
      appearance from the file. Research in
      `docs/audit-2026-07-31/raw/RESEARCH-quality-metrics-2026-08-01.md`.
- [x] **Q10 — the `Remux-1080p`-labelled movies.** ANSWERED 2026-08-01. Three
      files, all genuinely mislabelled, all with the source in the release name:
      *Evil Does Not Exist* 3.1 Mbps 1800x1080 h264 [YTS.MX] (37 bpp+) — a YTS rip
      tagged as a remux; *Downfall* 2.2 Mbps hevc (52 bpp+); *Ronin* 4.5 Mbps
      1920x816 h264 (77 bpp+). A real 1080p remux is 20–35 Mbps, so all three are
      off by ~10x. Radarr inherited the tag from the release name, not the file.
      **Consequence: the `Remux-1080p` quality label is not trustworthy and must
      never be used as a quality signal — bpp+ already ignores it, correctly.**
      Fix if desired: re-scan the three files or force the correct quality in
      Radarr. Not doing it unprompted (would touch library metadata).

## Hardware aspiration

- [ ] **Projector upgrade — target ~$500–1,000 CAD, ~$50/month saving.**
      Hard rule when shopping: **native resolution must be genuinely 1920x1080.**
      Most cheap "1080p" projectors (including the current WiMiUS K5) are native
      1280x720 and merely *accept* 1080p — that is not an upgrade. Second rule:
      **contrast over lumens** for a dark room. The BenQ HT2060 (native 1080p,
      2,200 ANSI, LED, no lamp to replace) is the reference point at
      ~$950–1,200 CAD; anything considered below that price needs its native
      resolution verified on projectorcentral or rtings, not the retailer page.
      Do not buy on "supported resolution" or lumen claims.
