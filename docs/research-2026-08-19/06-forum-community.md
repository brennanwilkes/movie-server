# 06 · Forum & Community Wisdom — what the internet thinks about encode quality

Date: 2026-08-19 · Research for the BPP+ quality score and the Audit/Upgrade tooling
Scope: Reddit (r/PleX, r/handbrake, r/Tdarr, r/Piracy), Doom9, VideoHelp, AVSForum,
Home Theater Forum, pirates-forum, thewiki.moe (anime standards community), film-review
blogs. Objective: compile community rules of thumb for judging video quality, grain
handling lore, and per-film verdicts that can sanity-check the model's BPP+/R/complexity
scores against human judgement.

Every film anecdote below (Annex A) was cross-checked against the live probe dataset
(`/tmp/opencode/movies.tsv`, columns key,title,year,source,codec,complexity,cxEff,
biasFactor,R,bppPlus,bppPlusFlat,srcBitrate,probeBitrate,bytes,path). "measured" is
`bppPlus` (per-film CRF-20 denominator); "flat" is `bppPlusFlat`.

Tags: **[SOLID]** corpus-corroborated across many independent posters / reviewers ·
**[DIRECTION]** consistent signal, single source or low sample · **[UNTESTED]** plausible,
not yet verified.

---

## 1. Executive summary

The forum record is remarkably consistent with the *direction* of Brennan's model, and
it independently discovered the same failure in the "flat bpp" approach — but it never
quantified the fix, which is what the probe does.

- The most punishing piece of lore is **bpp is not a quality measure** (Doom9), and the
  reason given is exactly the model's core premise: "it doesn't account for source
  compressibility." The probe's per-film CRF-20 denominator **is** that missing variable,
  measured instead of guessed.
- The community's practical rank order is **source provenance > encode size > codec**.
  "Re-encode of a re-encode" is universally condemned, which is precisely the model's
  BRRip/RE-Rip tier gate and its WEBRip regex.
- **Grain is the single most-cited reason a release needs more bits**, and film reviewers
  treat *presence* of grain as a sign of an authentic print ("newer scan = true to the
  print; older = upscaled or scrubbed"). This validates treating grain as content the
  model must price — including the biasFactor starved-copy correction it already applies.
- One genuine band-semantics gap to flag (disagreement #2 below): **a reference-grade
  remux of a very grain-heavy B&W film can still land in red because no available copy
  reaches CRF-20 transparency.** The red band then has no actionable upgrade and the UI's
  "bad" label may mislead about a file reviewers call excellent.

## 2. Community rules of thumb for bitrate / CRF / bpp

**[SOLID] BPP ~0.1 is the streaming "sweet spot"; ~0.07 acceptable** — StreamShark's
calculator guide: `bitrate(kbps) = W×H×fps×BPP/1000`, calls 0.1 the sweet spot and 0.07
fine for low-upload. These numbers sit right around the model's own pre-probe `BPP_TARGET
= 0.13` (0.1–0.13 is the same neighbourhood — see the model's own flat fallback table).
https://streamshark.io/blog/bpp-calculator-for-live-stream-bitrate/

**[SOLID] But "bpp is NOT a usable quality measure"** — Doom9 archive thread
"Recommended bits/(pixel*frame) for H.264" (ie 0.5.1 era, revisited for years after):
posters repeat that bpp fails because *sources vary wildly in compressibility* and
recommend judging "quality at a given quantizer" instead. This is the strongest external
vindication of the probe's per-film denominator. A flat 0.13 was a good *average*; the
forum knew that averages lie. https://forum.doom9.org/archive/index.php/t-109907.html

**[DIRECTION] Same CRF ≠ same quality across sources** — r/handbrake CRF thread:
"Depending on the source video, 20-23 is worth trying"; "CRF values also shift with
presets"; "Slower CRF 17/18 … very close to visually lossless, when adding no-sao to
remove the smoothing filter x265 likes". They observe quality at a fixed CRF *moves with
content* — the same symptom the flat-vs-measured 8.1x complexity spread corrected.
https://www.reddit.com/r/handbrake/comments/1egvyzl/
and the precise-encode variant: https://www.reddit.com/r/handbrake/comments/1479xe8/
(x264-vs-x265 threads — both codec-choice threads also repeat "keep x264 for your Blu-ray
library"; see §4 codec lore).

**[SOLID] Release-rank consensus: source provenance trumps everything** — thewiki.moe
(anime-adjacent but film-general release standards): "BluRay Remux trumps
WEB-DL/WEBRip and bad encodes"; "an encode of the BluRay that's better than the source
will trump the source"; "avoid mini encodes"; lossless audio from remuxes should be
transcoded to FLAC, not passed through 24-bit. This is the model's source-tier logic
word for word.
https://thewiki.moe/advanced/release-standards/

**[SOLID] Re-release window consensus on size** — pirates-forum's own Gravity shot-by-shot
comparison (REMUX vs SPARKS vs anoxmous vs YIFY vs VISION vs KINGDOM): "larger rips will
always be better if encoded without errors"; 10–15 GB handles "noise" better; 1–7 GB rips
are comparable with each other; BDRips beat BRRips because *source*; "squeeze 1080p into
a small file and quality may drop below a good 720p." A film's nominal "transparency"
size scales with runtime (their rule of thumb: ~8 GB for 90 min, ~11.5 GB for 2h10 — near
the model's flat green for easy content, way under for grain-heavy B&W).
https://pirates-forum.org/Thread-Comparing-YIFY-SPARKS-ANOXMOUS-LTT-PUBLICHD-VISION-KINGDOM

**[SOLID] "Technical HD" is not HD** — "Why YIFY encodes are technically HD but still
bad": resolution metadata 1080p with low bitrate + stereo-downmixed audio is judged
worse than a good SD encode. Model agrees: the YTS family sits ~65 red, and the audio
tier contributes nothing (`audioCls` returns `''` for everything — matching the forum's
"don't count multichannel as quality" stance).
https://pirates-forum.org/Thread-Why-YIFY-encodes-are-technically-HD-but-still-bad

**[DIRECTION] Across-the-board encoder rule** — r/PleX "when is x265 worth it": "Bit rate
and data is relative to size — a 12 GB x265 encoded from the source will outshine a 12 GB
x264"; "2160p should be x265 only"; "the only time I've seen x265 look worse is when they
try to squeeze the size too tight or it's a reencode". The squeeze/re-encode warning is
what the model's low-band red and tier gate both already encode.
https://www.reddit.com/r/PleX/comments/1fwoipz/when_is_x265_worth_it_over_x264/

## 3. Grain: the community's loudest single signal

**[SOLID] Grain = the thing that breaks encodes first, and its *presence* is treated as authenticity.**

- r/DataHoarder classic thread (grain/bitrate/filesize): "grainy sources require more
  bitrate"; prefer x264 for 1080p; "software encoder vs hardware"; "it depends on the
  source" — the community's shrug, which is the model's whole point.
  https://classic.communick.news/post/412929
- r/Piracy side-by-side "4k remux hevc vs 4k x265": OP confused that the remux has
  "extreme noise" while the x265 is smoother; answer — that noise is *film grain, and
  the encoder removed real texture with it*; and "usually if the Blu-ray has a lot of
  grain it's likely a newer scan more true to the film print; some older ones were
  upscaled or cleaned up." Film-accurate grain is the *smoking gun of a good master*.
  https://oldsh.itjust.works/comment/610680
- Doom9 x265 scheme thread (tune film / grain preservation): tests x264-veryslow tune
  film vs x265 tune-grain holds, conclude x265 wins near-transparent but needs explicit
  `--no-sao` / grain options; x264 holds grain better at very-low bitrate. This is the
  model's +80 H.264 / +20 HEVC profile gap from the encoder's own community.
  https://forum.doom9.org/showthread.php?p=1734081
- x265's biggest flaw (anime community, kokomins guide): "x265 has a tendency to
  blur/smoothen to save bitrate" causing micro-banding and "grain-blocking"; prescribes
  `no-sao:no-strong-intra-smoothing:deblock=-1,-1` + psy tuning. Supports treating grain
  as a *costed* feature rather than noise to be removed.
  https://kokomins.wordpress.com/2019/10/10/anime-encoding-guide-for-x265-and-why-to-never-use-flac/
- Adaptive-grain article (kageru.moe): debanding by adding *grain* dither; too much grain
  degrades quality, too little gets eaten by the encoder → banding resurfaces. Establishes
  the community's grain-as-budget model.
  https://blog.kageru.moe/legacy/adaptivegrain.html

**[SOLID] Coral-plus grain verdict from the review world** — every 4K catalogue review
this session praised *organic, un-manipulated* grain as the sign of a good transfer:
Casablanca ("organic yet well controlled", "no grain management"), Taxi Driver (from OCN,
"faithful reproduction"), Schindler's List (2018 OCN scan, "finite detail magnificent"),
Jackie Brown ("slim grain structure remains untouched"), The Shining (4K OCN scan, "grain
light and pleasing"). The one negative-grain story — GoodFellas ("Brownfellas") — is a
*remaster* dispute, not an encode one (§Annex A row 10).

## 4. Codec lore that touches the model's profile hierarchy

**[SOLID]** The H.264-over-HEVC preference in the profiles is *externally defensible*:
- r/handbrake: "stick with my H.264 encodes … H.265 can be problematic with grain and
  dark scenes"; x265 10-bit files "typically worse … same or larger file size" for
  live-action Blu-rays.
  https://www.reddit.com/r/handbrake/comments/1479xe8/ and
  https://www.reddit.com/r/handbrake/comments/15nk9yl/
- Doom9: x265 needs hand-tuning for grain; HW encoders (NVENC) still trail x265 software
  by generations. https://forum.doom9.org/showthread.php?t=186813 (10-bit-from-8-bit)

The model separately *favours* HEVC efficiency in `bppOf()` (×1.6) and treats 10-bit as a
decode liability. The community would nuance this: **10-bit is a banding/quality tool**
(§6), so the decode penalty is a hardware-real (PS4/Fire Stick) question, not a
"10-bit = bad quality" one. Calling 10-bit a `gpuTier()=bad` is about the box, and the
report should keep that distinction explicit when the Audit tab flags 10-bit files.

## 5. Spotting re-encodes without a reference

**[SOLID] There is no reliable no-reference detector — but the tells are cheap, and they're exactly what the model already reads.**

- VideoHelp "How to recognize an upscaled video": suggestions — much smaller bitrate than
  a same-res encode of equivalent content; lower *effective* resolution (blur/softness,
  ringing, oversmoothing); "reduce frame size and restore, compare high-frequency detail".
  Conclusion, echoed by veterans: without the source you can't *prove* it; it's an
  educated guess. https://forum.videohelp.com/threads/326864-How-to-recognize-an-upscaled-video
- Wikipedia "Pirated movie release types": the definitions themselves. **BRRip = a
  transcode of an already-encoded HD release; BDRip = directly from the disc**; WEBRip is
  now the *captured/re-encoded* tag vs WEB-DL untouched. This is the exact distinction
  the model's `BRRip|BDRip|WEBRip` regex implements as a tier downgrade, and it
  legitimises the naming-based approach where *arr history (`originalFilePath`) confirms
  the real source — 187/886 rows in the library, plus 120/885 on-disk path matches.
  https://en.wikipedia.org/wiki/Pirated_movie_release_types
- The pirates-forum Gravity thread (row in §2) and the "Why YIFY" thread: re-encode
  detection by *habit* — check group name, encode date vs source, file size vs runtime,
  NFO/MediaInfo audio + profile lines. No tool; editorial judgement. **This is why the
  model's tier gate reads the release name and history rather than attempting pixel
  forensics** — it is the community's own method, automated.

## 6. Banding / bit-depth insight for clean, dark, and animated content

**[SOLID] 10-bit's real, repeatable win is banding on flat-gradient/dark/anime content; the model's "clean digital" complexity class is exactly where the community says bit-depth matters.**

- Doom9 "x265 10 bit encoding from 8 bit source": consensus — "10 bit encoding helps
  remove banding, especially on anime; also helps with blacks"; x265's 8-bit mode is even
  described as under-tuned ("severe banding in 8-bit mode at 1500kbps from a clean DVD",
  then "10-bit result is smaller than 8-bit at same CRF"). VideoHelp mirror: "Use 10-bit
  encoding with either encoder. Even with low bitrates you won't get banding."
  https://forum.doom9.org/showthread.php?t=186813 ·
  https://forum.videohelp.com/threads/379879-Output-video-needs-debanding
- kokomins guide: 8-bit precision damage is native ("cannot be overcome by any encoding
  technique"); aq-mode 3 (dark-area bias) is the standard anime prescription.
- It matters most where the model measures **low complexity**: clean digital films and
  animation (Dune's film-out is deliberately light, §Annex A row 6; Spirited Away row 7).
  A 10-bit-encoded anime at BPP+ ~94 isn't "suspicious", it's the community's *default
  choice of encoder* for that content class.
- Doom9 x265 HEVC main thread adds the hardware caveat: 10-bit for 2160p is non-negotiable
  in the community's eyes; for 1080p it's a banding tool with a decode tax.

## 7. Ranked take-aways: where the community and the model agree, and where they diverge

### Strong agreement (network-level)

1. **[SOLID]** Provenance/re-encode hierarchy — remux ≈ best, encode-of-blurays second,
   encode-of-encodes (BRRip/RE-Rip) bottom. Model's tier order and BRRip/WEBRip gate match
   the scene's own taxonomy.
2. **[SOLID]** Grain must be paid for. Reviewers price it as authenticity; encoders price
   it as bitrate; the model prices it as measured complexity (and its biasFactor already
   corrects starved copies that a reviewer would call "washed out").
3. **[SOLID]** Realism about the *no-reference* problem — both communities and the model
   converge on: naming + size + source history are your only trustworthy signals; pixel
   forensics are unrepeatable.
4. **[DIRECTION]** Midrange transparency windows resemble the model's green band: a clean
   film at ~6 Mbps, a 90-min film at ~8 GB. Claude's numbers sit near BPP+ ~100 territory
   for average content.

### Divergences worth flagging (parts of the report conclusion)

1. **bpp-as-measure (Doom9)** — the loudest voice says bpp is not a quality metric at all.
   The probe dissolves the complaint (it adds the missing per-source variable), but the
   residual unanswered claim stands: **the absolute 100-anchor is still
   `HEADROOM_TARGET=1.0` and stays un-pinned until Brennan judges ~10 films
   (`docs/DESIGN-CRF-PROBE.md` §12 Q1)**. The forum has no better anchor; it just refuses
   to pick one, and calls everything "depends on the source".
2. **Grainy-B&W paradox** — 12 Angry Men's Criterion remux (24.5 GB, the best copy that
   exists) measures BPP+ **67** flat-219 → red. Taxi Driver's Sony BD (11.5 GB) measures
   65 flat-133. For these films the model's red band says "needs more bits", but *no
   available release provides them*, so the score's actionable range is empty for the
   band's top end. The UI's "bad" colour on a reference remux may read as an error to a
   fan who knows the disc is sterling. Consider a "this is the best physical copy" cue or
   a band variance note for `R >= 1` files far from transparency. (Film-ambiguity caveat:
   reviewer verdicts are for *disks*, not the specific 1080p files in this library.)
3. **10-bit/HEVC priority** — community says 10-bit = quality (banding) and x264 = grain
   safety, so both directions of the profile gap have external cover. But the model's
   ×1.6 HEVC efficiency in `bppOf()` and its decode-`bad` classification of 10-bit should
   never be *presented* as one policy: one is physics (bits needed), the other is this
   specific hardware stack.

### Best single rule of thumb to carry into the code/docs

> **"Give grain and history their due: a grainy print needs more bits than a clean one,
> and a re-encode of a re-encode is worth less than either — size must scale with content
> cost and provenance, never with resolution alone."**
> (StreamShark's 0.1 bpp is the same spine in streaming-flatland; Doom9 is the same spine
> minus the courage to pick a number. The probe picks the number, per film.)

---

## Annex A — film anecdote table (community vs model)

All model figures from `/tmp/opencode/movies.tsv`. `BPP+` = measured, `flat` = `bppPlusFlat`.

| # | Film (library file) | Source · codec | BPP+ (flat) | R | cx | Community verdict (2026-08-19) | URL | Gap |
|---|---|---|---|---|---|---|---|---|
| 1 | The Blair Witch Project (1999) — 720p | Bluray-720p · h264 | 30 (55) | 0.14 | 0.270 | The film's *entire identity* is intentional lo-fi grain (Hi8+16mm). Second Sight's new restoration removes the *wrong* stuff but keeps/normalises the roughness; "doubles down on the low quality, faux amateurish look". Every old transfer was wrong (added telecine grain). Model correctly prices the grain as content — but this is the extreme case where "good" = not-transparent. | blood-y-flicks / AV Club re-release story | DIRECTION — agrees grain cost; band semantics = art |
| 2 | 12 Angry Men (1957) — remux | Remux-1080p · h264 | 67 (219) | 0.74 | 0.927 | Criterion restorers used heavy DVNR yet "grain is heavy at certain times" (dvdcompare); ioncinema: "a surprising amount of grain for a Criterion product". The reference remux measures 67 because heavy B&W grain costs an absurd bpp. Box: red with no better copy available. | dvdcompare.net / ioncinema | **DISAGREE — band semantics on a reference remux** |
| 3 | Casablanca (1943) | Bluray-1080p · h264 | 115 (181) | 1.57 | 0.279 | WB 4K/BD praised for *un-manipulated* grain; "no obvious digital smoothing", "elements: fine grain master + dupes; first-gen footage pristine". OCN is gone, so the BD's effort is a ceiling. Model: green 115 on the real films' cost. | digitalbits 2022 4K review / avforums / blu-ray.com | ALIGN |
| 4 | Schindler's List (1993) | Bluray-1080p · h264 | 45 (94) | 0.35 | 0.351 | 4K from 2018 OCN scan "blistering"; heavy B&W grain = high complexity. 9 GB 1080p lands red; community agrees grainy B&W eats bitrate (they ask for the 4K for the same reason). | avforums Schindler's List review | ALIGN (dir) |
| 5 | Taxi Driver (1976) | Bluray-1080p · h264 | 65 (133) | 0.76 | 0.373 | Sony 4K from OCN, "faithful reproduction", praised for grain-filled NYC night photography. 11.5 GB BD measures 65 (red) vs flat 133 (purple): the per-film denominator cuts a file the flat scale massively over-credited. | avsforum Taxi Driver 4K review | ALIGN on scale; same paradox as #2 |
| 6 | Dune (2021) | Bluray-1080p (YTS, 2.3 GB) · h264 | 100 (69) | 1.19 | 0.049 | 4K reviews: near-reference, "minimal added grain brings grit", film-out photos scanned through 35mm = light deliberate grain. Model says this is nearly cost-free content: even a 2.3 GB YTS measures green 100 (flat would say 69/orange — the *only* big flip the other direction). | highdefdigest / dune-2021-4k-uhd / doblu | ALIGN — flat-vs-measured flip |
| 7 | Spirited Away (2001) | Bluray-1080p x265 (FINKLEROY bdrip) · hevc | 94 (86) | 1.39 | 0.092 | Ghibli BD praised ("clean, stable, gorgeous", "no banding"); Shout! hits 30000 kbps vs Disney 24.4 Mbps, same master. The community's anime rule book says use 10-bit + aq-mode 3 here — this file is a 10-bit animated encode sitting at BPP+ 94. | blu-ray.com / gkids review / kokomins guide | ALIGN (encoder choice = genre norm) |
| 8 | Heat (1995) | Bluray-1080p x265 (remaster BONE) · hevc | 91 (69) | 1.22 | 0.059 | Mann's 2017 remaster 4K: "visual style doesn't lend itself to eye-catching color", praised set-detail; the remaster cleaned noise, lowering complexity — and the model's measured 91 vs flat 69 reflects exactly that. | avsforum Heat Director's Definitive review | ALIGN |
| 9 | Jackie Brown (1997) | Bluray-1080p · h264 | 139 (148) | 2.51 | 0.147 | 4K "reference grade", "slim grain structure remains untouched"; 2011 BD "spectacular". Nearly at parity flat-vs-measured; purple = above what this projector resolves — community agrees the 1080p leaves little on the table. | doblu 4K review / slant | ALIGN |
| 10 | GoodFellas (1990) | Bluray-1080p · h264 | 157 (149) | 2.64 | 0.117 | "Brownfellas": the 2015 Warner remaster fought as browner/splotchier/desaturated, defenders pointing to blu-ray.com's 4.27. It's a *master* dispute; the encode here measures purple on both scales. | hollywood-elsewhere / blu-ray.com | ALIGN (master-level dispute, not encode) |
| 11 | Jurassic Park (1993) | Bluray-1080p (AMIABLE RERIP) · h264 | 65 (116) | 0.74 | 0.278 | Universal DNR+sharpening saga: 2011 BD "compression doesn't help a heavy grain structure … swarming artifacts"; 4K reuses old scans and re-does grading. The film *behind* the masters is grain-heavy (measure 65 vs flat 116) — exactly what happened to it on disc. | doblu / tweaktown 4K / avforums | ALIGN (dir) — DNR fight is over grain the model charges for |
| 12 | Blade Runner 2049 (2017) | Bluray-1080p (SPARKS) · h264 | 191 (137) | 4.27 | 0.067 | Forbes "reference-grade"; archimago A/B measures 1080p-vs-4K differences as tiny. 12.9 GB at measured 191 = comfortably beyond what a 1080p projector can show; community agrees the 1080p BD is effectively the full experience. | forbes / archimago | ALIGN |
| 13 | Easy Rider (1969) | Bluray-1080p · h264 | 60 (94) | 0.61 | 0.203 | "Heavy grain" across reviewers, 16 mm blow-ups grainier; Sony BD ≈30 Mbps and praised for retaining it. 4.4 GB file measures 60 (red) — below transparency vs the film's real cost. Disc reviewers call the *disc* good; the file is the gap. | dvdbeaver / blu-ray.com / film freak | DIRECTION — file vs disc is the honest split |
| 14 | Aliens (1986) | Bluray-1080p (YIFY BRRip) · h264 | 51 (56) | 0.42 | 0.098 | The 30th-anniversary Aliens BD itself was condemned for DNR scrubbing; the YIFY BRRip of it is the community's bottom tier ("re-encode of re-encode"). Red on both scales, and provenance-bad. | (DNR discourse general) + §2/§5 | ALIGN — re-encode gate works |
| 15 | Pulp Fiction (1994) | Bluray-1080p · h264 | 169 (147) | 3.39 | 0.099 | Tarantino-supervised transfer, community "spectacular"; measured 169 vs flat 147 both purple — file is generous. | digitalbits / §4 | ALIGN |
| 16 | The Blues Brothers (1980) | WEBDL-1080p · h264 | 83 (108) | 1.04 | 0.166 | Grain list member; WEB tops out near-orange. Community rates WEB-DL "untouched and good"; 83 (orange) matches "diminished but maybe fine" for a heavy-grain 1960s-style production. | thewiki.moe / release-type lore (§2) | DIRECTION |

**Anecdote count: 16.** Agreement: 12 align (3 direction-only), **2 genuine band-semantics
disagreements of the same type (rows 2 & 5 — reference remuxes in red with no better copy
on the market)**, 2 special cases (row 1 artistic intent; row 10 master dispute).

---

## Method & limits

- Sources: web search snapshots 2026-08-19, single-pass, snippet-level quotes; long thread
  bodies were truncated in several cases (flagged where it matters — the Gravity thread
  and Doom9 tune-film thread had the fullest quoting). For any quote reused on the
  dashboard/report, re-open the URL before quoting verbatim.
- Reviewer prose describes **disks**, not our library's exact rip/encode of each film;
  the "gap" column states where the file, not the film, is what the model judges.
- No subjective-viewing verification was possible in this session (film-by-film eyeball
  confirmation is the open human step — same open item as `DESIGN-CRF-PROBE.md` §12).

---

## ROUND 2 — ADVERSARIAL VERIFICATION (2026-08-19)

Every number below was recomputed from the fresh ground-truth dump
`/tmp/opencode/probe-dataset-now.json` (885 movies + 146 seasons, generated 19:25) and
cross-checked against this report's own cited `/tmp/opencode/movies.tsv` (09:39). The two
agree EXACTLY on all 16 anecdote rows — **no value drifted after the audio-R fix for these
titles**; the table was written against the same live values that stand now. Internal
consistency holds across all 1031 units: `round(100*sqrt(bpp/(complexity*biasFactor(R))))`
== `bppPlus` and `round(100*sqrt(bpp/0.13))` == `bppPlusFlat`.

**Definitional trap for anyone re-verifying:** R is CODEC-NORMALISED —
`R = srcBitrate / (probeBitrate × 1.6 for h264 / 1.0 for hevc)` (`probe-film.sh`, same
convention as `bppOf()`). Recomputing R as the raw ratio gives Casablanca 2.50 instead of
1.565 and 12 Angry Men 1.18 instead of 0.737, and would falsely condemn the table. All 16
rows reproduce exactly under the normalised formula.

### Annex A, row by row

| # | Verdict | Live values (recomputed) |
|---|---------|--------------------------|
| 1 | **VERIFIED** | Blair Witch 30 (flat 55), R 0.1438, cx 0.2704, Bluray-720p·h264, 0.73 GB. |
| 2 | **VERIFIED** | 12 Angry Men 67 (flat 219), R 0.7371, cx 0.9270, **Remux-1080p·h264**, 24.50 GB. Source field confirms the remux claim — it is one of only FOUR Remux-1080p rows in the library. Highest complexity measured anywhere (library max 0.9270). Red (<75) ✓. "Criterion" provenance and "no better copy on the market" are external disc-market claims, not derivable from the dataset — plausible, unverified here. |
| 3 | **VERIFIED** | Casablanca 115 (181), R 1.565, cx 0.27853, 12.85 GB. |
| 4 | **VERIFIED** | Schindler's List 45 (94), R 0.3537, cx 0.35108, 9.04 GB ("9 GB" ✓). |
| 5 | **VERIFIED, two qualifications** | Taxi Driver 65 (133), R 0.7618, cx 0.37311, 11.57 GB. (a) "11.5 GB" should read 11.6 (BPP-PLUS §8.6 already says 11.6). (b) The file is a Bluray-1080p **encode**, not a remux — see summary finding below. |
| 6 | **REVISED — size wrong** | Dune BPP+ 100 (flat 69), R 1.188, cx 0.04881 all VERIFIED, but the file is **3.08 GB**, not "2.3 GB" (path `Dune.2021.1080p.BluRay.x264.AAC5.1-[YTS.MX].mp4`; YTS attribution correct). The error predates this round — the report's own movies.tsv already said 3.08 GB at 09:39. The qualitative point survives: a ~3 GB YTS still measures green 100 against flat 69. |
| 7 | **VERIFIED** | Spirited Away 94 (86), R 1.3929, cx 0.09183, Bluray-1080p·hevc, 3.71 GB; FINKLEROY bdrip x265 confirmed in filename. |
| 8 | **VERIFIED** | Heat 91 (69), R 1.2178, cx 0.05927, hevc, 2.12 GB; BONE remaster confirmed in filename. |
| 9 | **VERIFIED** | Jackie Brown 139 (148), R 2.5083, cx 0.14741, 21.29 GB. |
| 10 | **VERIFIED** | GoodFellas 157 (149), R 2.6405, cx 0.11668, 16.71 GB. |
| 11 | **VERIFIED** | Jurassic Park 65 (116), R 0.7424, cx 0.27809, 9.39 GB; AMIABLE RERIP confirmed in filename. |
| 12 | **VERIFIED** | BR2049 191 (137), R 4.2721, cx 0.06696, 12.92 GB ("12.9 GB" ✓); SPARKS confirmed in filename. |
| 13 | **VERIFIED** | Easy Rider 60 (94), R 0.6092, cx 0.2030, 4.41 GB ("4.4 GB" ✓). |
| 14 | **VERIFIED w/ caveat** | Aliens 51 (56), R 0.4172, cx 0.09757, 2.36 GB. YIFY BRRip confirmed in FILENAME (`Aliens.Directors.Cut.1986.1080p.BRrip.x264.GAZ.YIFY.mp4`) — but *arr's own source tier for it reads Bluray-1080p. The BRRip call is name-based, which is precisely this report's §5 thesis, not a counter-example. |
| 15 | **VERIFIED** | Pulp Fiction 169 (147), R 3.3889, cx 0.09882, 14.62 GB. |
| 16 | **VERIFIED** | Blues Brothers 83 (108), R 1.0416, cx 0.16582, WEBDL-1080p·h264, 8.56 GB. |

Every band label in the table matches the live band edges (<75 red / 75-99 orange /
100-124 green / ≥125 purple) for all 16 rows.

### Summary-count audit ("16 anecdotes: 12 align / 2 band-semantics / 2 special")

- "12 align" ✓ literal — the Gap column contains ALIGN in exactly rows 3,4,5,6,7,8,9,10,
  11,12,14,15. "3 direction-only" ✓ = the three pure-DIRECTION rows 1, 13, 16 (the two
  "ALIGN (dir)" rows 4 and 11 sit inside the 12).
- **QUALIFIED: the categories overlap instead of partitioning.** Row 5 is counted inside
  the 12 AND named one of the 2 band-semantics disagreements; row 10 is counted inside the
  12 AND named a special case. 12+2+2=16 only works via that double-count. Harmless, but a
  strict reader should treat the buckets as overlapping annotations, not a partition.
- **FALSIFIED sub-claim:** "rows 2 & 5 — reference **remuxes** in red with no better copy
  on the market." Row 5 (Taxi Driver) is NOT a remux: its source tier is Bluray-1080p (an
  11.6 GB encode). The library holds exactly four Remux-1080p rows — 12 Angry Men (67),
  Downfall (75), Evil Does Not Exist (58), Ronin (61). Rows 2 and 5 genuinely share "red
  with no better copy available", but only row 2 is a reference remux. Reword to
  "reference-grade copies".

### §5 statistic

- **REVISED:** "120/885 on-disk path matches" → **119/885** (case-insensitive
  `BRRip|BDRip|WEBRip` over paths; identical result on the report's own movies.tsv and the
  fresh dataset).
- **UNVERIFIABLE:** "187/886 rows in the library" — requires *arr history
  `originalFilePath`, which the probe dataset does not carry, and the denominator 886 does
  not match the current 885 movies. Stale or mis-derived; re-derive before quoting again.

### Web attributions

- **VERIFIED — Doom9 bpp complaint.** Thread t-109907 "Recommended bits/(pixel*frame) for
  H.264" exists (April 2006 — genuinely x264 0.5.1-era) and carries the substance:
  "BPF does not mean anything because same bit for each pixel does not mean same quality…
  1) Source is really important. With same resolution and same video codec quality can be
  really good at 300 Kbps and very bad at 3000 Kbps" (foxyshadis). Citation nuance: the
  canonical one-liner — "Bits per pixel is not a valid measurement. Some sources need more
  bits than others" (Dark Shikari) and "BPP is useless… doesnt take into consideration the
  source material compressibility" (Sharktooth, near-verbatim this report's paraphrase) —
  lives in the sibling thread **t-134555** (2008), not t-109907. Same argument, both real;
  cite t-134555 alongside for the loudest quote.
- **VERIFIED — StreamShark, verbatim.** "Generally it's considered that a BPP of 0.1 is
  the sweet spot for calculating bitrate. You could also go as low as 0.07 if you're being
  limited by your upload speed"; formula `(W×H×fps×BPP)/1000 = kbps`. Caveat to carry
  forward: it is a LIVE-streaming rule of thumb; comparable guides place 1080p30 H.264 at
  0.05-0.11 bpp by motion class (e.g. AntMedia: 0.05-0.07 low / 0.07-0.10 medium /
  0.10-0.15 high motion). The report's "streaming sweet spot" framing is accurate as
  written.
- **VERIFIED — 10-bit as banding cure.** Doom9 t-186813 "x265 10 bit encoding from 8 bit
  source" exists: "significantly less banding with 10-bit, even from 8-bit sources. And
  using the same CRF parameter, the 10-bit result is even smaller than the 8-bit one."
  kokomins guide confirms Main10 as default, aq-mode=3 for anime dark scenes, and carries
  the section title "x265's Biggest Flaw: Grain, Micro-Banding, and Grain-Blocking"
  verbatim as quoted in §3.
- **VERIFIED — thewiki.moe release standards, near-verbatim:** "BluRay Remux trumps
  WEB-DL/WEBRip and Bad Encodes"; "An encode of the BluRay that's better than the source
  will trump the source"; "Avoid mini encodes"; audio "converted to 16-bit FLAC because
  24-bit FLAC is bloated with no benefits".
- **ATTRIBUTION GAP — TRaSH-Guides absent.** The research scope names TRaSH but the report
  never cites it. TRaSH-Guides exists (officially supported Radarr/Sonarr documentation)
  and its custom-format practice — scoring x264/x265/10-bit as separate formats,
  discouraging x265/10-bit at 1080p while embracing it at 2160p — independently supports
  §4's "externally defensible" claim. Add one citing line rather than leave the strongest
  *arr-native community reference missing.
- **UNVERIFIED this session (sources unreachable):** the r/handbrake (1egvyzl, 1479xe8,
  15nk9yl), r/PleX, r/DataHoarder, r/Piracy and pirates-forum quotes. All remain
  directionally consistent with what WAS reachable (Doom9, kokomins, thewiki.moe, and
  HandBrake's official docs recommending RF 20-24 for 1080p, which brackets the "20-23
  worth trying" paraphrase). The report already grades these [DIRECTION]; keep the Method
  § rule about re-opening URLs before verbatim quotation.

### Cross-repo consistency spot-checks (all pass)

- `HEADROOM_TARGET=1.0` un-pinned pending Brennan judging ~10 films — matches
  `docs/DESIGN-CRF-PROBE.md` §12 Q1 status as recorded in AGENTS.md.
- Audio stance (`audioCls()` returns '' for everything; every format ends stereo) matches
  the measured playback ground truth in AGENTS.md.
- "YTS family sits ~65 red" consistent with the dataset's YTS-cluster rows.

**Round-2 bottom line:** 15 of 16 anecdote rows fully verified against live data; 1 revised
(Dune size 2.3 → 3.08 GB, score unaffected); 1 falsified characterisation (Taxi Driver is
not a remux); 1 off-by-one statistic (119 not 120 path matches); 1 unverifiable statistic
(187/886); 1 missing attribution (TRaSH-Guides); 1 citation refinement (loudest Doom9
quote is t-134555). No code or data files touched.