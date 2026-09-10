# BVI-HD — Per-content bitrate-at-QP tables: do they exist publicly?

**Research log — 2026-08-28. Agent: legwork. Deliverable: does source (A) (a published
bitrate-at-QP table) or source (B) (must download the videos and measure) apply for BVI-HD?**

Question under test: to fit the complexity exponent `a` we need, per content, the **bitrate at
each QP rung**, so that the SUBJECTIVE threshold rung can be converted to the bitrate `t_j`.

---

## 1. TL;DR — is the anchor cheap or expensive?

**EXPENSIVE — download the videos and measure. There is NO published per-content bitrate-at-QP
table for BVI-HD.** Confidence: **HIGH (~0.85)** — based on the paper's own stated contents, the
official data-zip description, and enumeration of every homepage download link. The two remaining
uncertainties are both small: the `BVIHD_SUB_DATA` zip and the CDVL package cannot be unpacked
without downloading (so their *exact* internal file lists are inferred from the paper/site text,
not verified byte-for-byte).

What is published is **subjective score vs QP** (DMOS / CR / SE values, x-axis = **QP**, not
bitrate) plus, separately, **PSNR** as a distortion metric (Fig. 4 PSNR-coverage histogram, Fig. 9
metric scatter). Neither the paper, its tables, the site, nor the subjective-data zip exposes a
**bitrate** at any QP for any content. Bitrate appears in the paper only as a qualitative
statement ("synthesised content … reduced bit rates achievable").

So the anchor is NOT a "labels + bitrates, no video download" job. To get `t_j = bitrate(QP)`
for the 6 HEVC rungs {22, 27, 32, 37, 42, 47} we must obtain the video files and read their
actual encoded bitrates (or re-encode at the stated HM14/Random-Access/zero-QPOffset/GOP-4
settings), i.e. option (B).

**Cheapest form of (B):** download only the **32 reference (GT) sequences** from CDVL, encode
them ourselves at the six QPs with HM 14.0 under the paper's exact config, and take each encode's
bitrate. This reproduces the distorted clips' bitrates *exactly* only if we replicate the encoder
bit-for-bit; otherwise it gives a close-but-not-identical anchor (still fine for `t_j`, which only
needs the relationship between QP rung and bitrate, not a perfectly byte-identical encode). See
§6 for the minimal recovery.

---

## 2. BVI-HD homepage (`fan-aaron-zhang.github.io/BVI-HD`) — full link enumeration

Homepage HTML fetched in full — markdown render gives exactly **three** `[DOWNLOAD]` links, plus
the citation block. There is **no** bitrate table, no "supplementary", no per-content table, no
encode-params file linked from the homepage. [SOLID]

| # | Link | Target | HTTP | Contents (per site/paper text) |
|---|------|--------|------|------|
| 1 | `https://cdvl.org/members-section/view-file/?id=2955` | CDVL entry id 2955 | **200** but requires a personal CDVL login (redirects to login page when unauthenticated) | "all videos" — the 32 reference + 384 distorted sequences. Gated. |
| 2 | `https://vilab.blogs.bristol.ac.uk/files/2018/05/instructions-1dsmmd1.zip` | instructions zip | **200, `application/zip`** (resolves to the WP wpcdn mirror) | "instructions and related files", per site "Please read the README file before using the data" |
| 3 | `https://vilab.blogs.bristol.ac.uk/files/2018/07/BVIHD_SUB_DATA-1p2b9zx.zip` | subjective data zip | **200, `application/zip`** | "all subjective data" |

The GitHub source for the page (`fan-aaron-zhang/fan-aaron-zhang.github.io/blob/main/_pages/bvihd.md`)
contains the identical three links and nothing more. [SOLID]

The two `vilab.blogs.bristol.ac.uk` zips both returned `HTTP 200` with `Content-Type:
application/zip` via HEAD (they redirect to the `bpb-eu-w2.wpmucdn.com` WordPress mirror — expected
for the Bristol WP multi-host setup). Links are live. [SOLID] (Not downloaded — verify only.)

The Bristol VI-Lab blog post (English mirror of the homepage) lists the same three downloads, plus
the CDVL/Bristol attribution papers. No additional files. [SOLID]

---

## 3. `BVIHD_SUB_DATA-…1p2b9zx.zip` — what it contains

Not downloaded (per instructed "verify only"). Contents are inferred from the *paper's own words*,
which are explicit and authoritative:

> "The subjective data, comprised of **384 DMOS, SE, and CR values**, have been published alongside
> the video sequences." — Zhang et al., TMM 2018, §IV-D.

So the zip is the subjective data: **384 DMOS (difference mean opinion scores), SE (standard
error), CR (correct rate)** — one row per distorted clip, i.e. per source×QP×HEVC/HEVC-SYNTH
combination, plus subject-count metadata (86 subjects, 4 groups, outliers removed). [SOLID —
content breadth stated by the authors.]

**It is the scores, not bitrates.** There is no bitrate, no QP-encode parameter dump, and no
per-content bitrate column anywhere in what the paper describes as the published subjective data.
If the zip happened to carry the *reconstructed clip file names* (e.g. `SRC12_Q32.hevc`), those
still wouldn't give bitrates — only the DMOS per rung. [SOLID]

(Note the naming scheme of the sibling BVI-VFI dataset — `{seq}_{res}_{fps}_{method}` in `.mp4` —
does carry encoded bitrate obtainable by probe, but that's a *different* dataset and not applicable
here; cited only to contrast formats.)

---

## 4. The BVI-HD paper (IEEE TMM 20(10):2620–2630, 2018; doi 10.1109/TMM.2018.2817070)

Full text available open-access (CC BY 3.0, `08322297.pdf`; also the UoB research repository
record). Examined the body + tables. [SOLID]

**Confirmed encoding parameters (these ARE published and are the load-bearing facts for a
re-encode):**
- Codec/encoder: **HEVC HM 14.0**, **Random Access** configuration, Main Profile.
- QPs: six values **22, 27, 32, 37, 42, 47** (Exp 2, the DB); Exp 1 pre-study used 20–48.
- GOP: three successive B frames (**GOP size 4**); **CTU 64×64**; **QPOffset = 0** (no
  hierarchical per-level QP offset).
- Resolution 1920×1080, 5-second clips, source rate 50 fps (1080p50).
- Each source → 12 distorted (6 HEVC at the six QPs + 6 HEVC-SYNTH at QP 27/42 × 3 synth
  thresholds).

**Does the paper publish bitrate-at-QP for the 32 contents? NO.** [SOLID]
- All subjective plots (Fig. 6, 7) have **QP on the x-axis**, not bitrate.
- The only numeric distortion the paper reports for all clips is **PSNR** (Fig. 4 PSNR-coverage
  histogram; Fig. 9 scatter of DMOS vs each metric's prediction), and even Fig. 4 is a
  *distribution histogram*, not a per-content table.
- **Table I** = objective-metric correlation statistics (LCC/SROCC/OR/RMSE) per metric.
- **Table II** = F-test significance matrix between metrics.
- Neither table contains a bitrate. The term "bitrate" appears only as a qualitative remark
  about synthesis saving bits. No supplementary/attached per-QP rate table is referenced.
- Exp. 1's Fig. 6 shows the *average* DMOS and CR over source sequences vs QP — averaged by
  content, but again QP, not bitrate, and no bitrate anywhere.

There is **no arXiv version** of the BVI-HD paper body with supplementary rate data found; the
IEEE version is the citable source of record (the report page links the IEEE PDF + UoB Pure
record). [SOLID]

---

## 5. CDVL entry (`view-file/?id=2955`)

The CDVL entry itself sits behind the CDVL login/terms (HTTP 200 but serves the login page to an
unauthenticated client), so its **description text could not be read directly** — left [UNTESTED]
for the literal entry description. However:
- The homepage labels it "all videos" and the paper footnote says "All video sequences and
  subjective scores … publicly available for downloading"; the only bitrate-adjacent content CDVL
  posts is in its generic *Resources* page (some Netflix/ZIP docs), **not** per-clip rate metadata
  for BVI-HD. [SOLID for the generic-CLVL claim.]
- CDVL is explicitly a library of **high-quality uncompressed video sources** (QUALINET page: "a
  collection of high-quality uncompressed videos"). The entry is the source material. There is no
  published bitrate or QP-encode table associated with the CDVL listing. [SOLID on CDVL's own
  charter; [UNTESTED] on any per-entry metadata files because login-gated.]

**Practical consequence:** even after registering and downloading id=2955, the *video files*
(whether raw YUV GT, or GT+HEVC distorted) are what you get — no ready-made bitrate table. You
would ffprobe the encoded distorted clips to read bitrate directly, or decode/probe.

---

## 6. Minimal recovery path (option B)

If we commit to downloading, the cheapest route:

1. **Register** a CDVL members account (free account; personal/research terms — the LICENSE is
   "internal research & development only", no redistribution).
2. **Download CDVL id 2955.** If it contains the 32 reference + 384 distorted clips (as the
   homepage says: "all videos"), we do **not** need to re-encode — just `ffprobe` each of the 6
   HEVC distorted clips per content to read the actual encoded bitrate at that QP. That is the
   direct `t_j` source. (Whether id 2955 ships everything or only the 32 GT in one archive was
   not verifiable without login — flagged [UNTESTED].)
3. Fallback if only the **32 GT** are supplied: encode each GT with **HM 14.0 Random Access,
   Main Profile, GOP size 4, CTU 64, QPOffset 0**, at QPs {22,27,32,37,42,47}, and read each
   encode's bitrate. This reproduces the dataset's bitrates up to encoder determinism; close
   enough for `t_j` (we want the QP↔bitrate relationship, and the subjective labels attach to
   QP, not to a specific byte-count).
4. **Download the (un-gated) `BVIHD_SUB_DATA` zip** for the DMOS per rung; join DMOS↔QP↔bitrate
   to build the `t_j` ladder per content.

Both zips from `vilab.blogs.bristol.ac.uk` are directly downloadable (HTTP 200) with no login —
so the subjective labels are free; only the **video bytes** are CDVL-gated.

**Rough size note:** none of the published pages states the CDVL archive size; BVI-HD is 32×(5-s,
1080p50) GT + 384×(5-s) HEVC clips. As raw YUV 4:2:0 1080p50 that is ~155 MB per Gt second (a
5-s GT ≈ 780 MB); if only GT is included that's ~25 GB; if compressed HEVC distorted clips are
included it is far smaller. Exact size [UNTESTED] without login.

---

## 7. Any other published per-QP bitrate values for BVI-HD?

Searched for re-encoding/derivative papers or dataset tables that list BVI-HD per-QP bitrates.
**No published per-content bitrate-at-QP table found for BVI-HD itself.** [DIRECTION — none
located, but the space is large; a press-or-play re-encode paper *could* list rates, but none was
surfaced.]

Caveat for the project: BVI-HD's content overlaps with the **BVI**-named compilation datasets
(e.g. the 2019 "BVI — Video Codec Evaluation" data.bris archive, and BVI-HFR). Those encode at
**target bitrates** for codec comparison, but they use **different sources/codecs/bitrate rungs**
than BVI-HD's HM QP grid, so they are NOT a substitute for BVI-HD's per-QP `t_j`. Do not reuse
them as the same anchor. [SOLID — the codec-eval archive is 189.9 GiB of CC-HD/CC-UHD content,
nine sources, pre-defined target bitrates, distinct from BVI-HD's 32 QP-rung HM content.]

---

## 8. Bottom line for the project

- **Option (A) — cheap (labels + published bitrates, no video): NOT AVAILABLE.** [SOLID]
- **Option (B) — expensive (must obtain the video files): required.** [SOLID]
- The subjective labels are free and ungated; the video bytes are CDVL-gated behind a free
  research account.
- The cheapest execution is: register CDVL → download id=2955 → `ffprobe` the 6 HEVC distorted
  clips per content (if shipped) OR re-encode the 32 GT at the six published HM14 config QPs.
- All load-bearing **encoding parameters are already published** (HM14 RA, Main, GOP4, CTU64,
  QPOffset 0, QPs 22/27/32/37/42/47), so a faithful re-encode is well-specified.

---

### Evidence tags used
- [SOLID] — directly read from a primary source (homepage HTML, paper full text, Bristol blog,
  ZIP HTTP headers).
- [DIRECTION] — plausible but not confirmed (no per-QP rate table found, but absence is search
  evidence, not a proof of nonexistence).
- [UNTESTED] — could not be directly read (CDVL login-gated entry description + exact archive
  contents/size).
- [DEAD] — none of the homepage/paper links are dead (all resolve).
