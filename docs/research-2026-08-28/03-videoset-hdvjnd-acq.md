# 03 — VideoSet & HD-VJND: acquisition logistics

Status: research/legwork only. **No downloads were performed.** All URLs, sizes and
licence/format statements below were verified against the official pages on 2026-08-28
(Official pages = mcl.usc.edu, IEEE DataPort, HAL, arXiv abs/html; not blog echoes).

Context: these two JND-ladder datasets feed the regression `log t_j = a·log c_j + k`
(per-content transparency/anchor bitrate vs our measured x265 CRF-20 complexity).
LEHA-CVQAD (on disk, 60 contents) already gives a first noisy fit. VideoSet (220
contents) and HD-VJND (180 contents) are the intended closure. This file is the
*how-to-obtain* companion to README §5, which already has the methodology + risk
analysis. Tag legend: [SOLID] verified directly / [DIRECTION] reasonable path but
not yet acted on / [UNTESTED] plausible from context, not confirmed / [DEAD].

---

## Dataset 1 — VideoSet (USC MCL / IEEE DataPort)

### 1.1 URLs [SOLID]

| Item | URL | State |
|---|---|---|
| Project page | http://mcl.usc.edu/videoset/ | Live; redirects to IEEE DataPort |
| IEEE DataPort page | https://ieee-dataport.org/documents/videoset | Live; **subscriber-login gated** |
| IEEE DataPort DOI | https://dx.doi.org/10.21227/H2H01C (also DOI 10.21227/4br9-w081) | Live |
| Paper | https://arxiv.org/abs/1701.01500 (JVCIR 2017, doi:10.1016/j.jvcir.2017.04.009) | Live |
| BaiduYun mirror | https://pan.baidu.com/s/1B2TipF-Skq8lRyibdBOrNw | Listed on DataPort update 2017-02-14; login-walled, mirror-lifetime untested |
| README | `ieee-dataport.s3.amazonaws.com/docs/965/README_V2.md` | Live (signed URL) |
| JVCIR PDF | `ieee-dataport.s3.amazonaws.com/docs/965/videoset_jvcir.pdf` | Live |
| Scripts | `encode_x264.sh.tar.gz`, `md5sum.tar.gz`, `database_csv_v1.tar.gz` (dataset scripts, below DataPort "DATASET SCRIPTS") | Live |

Project page says: *"The videoSet was hosted by IEEE Dataport. More informations
available via the LINK."* — i.e. the DataPort page is now the primary distribution.

### 1.2 Download URL + total size [SOLID]

The AWS tarballs are listed on the DataPort page **but sit behind a
"LOGIN TO ACCESS DATASET FILES" / "This dataset requires an IEEE DataPort
Subscription" gate.** The concrete file list (all `.tar.gz`, from the DataPort page)
plus the documented sizes:

```
1920x1080  part_1..11: 30.41,33.91,29.19,26.92,27.96,30.79,17.71,30.69,22.48,17.38,20.73 GB
1280x720   part_1..11: 13.38,12.83,10.99,11.5,12.82,13.43,7.7,13.02,10.31,7.26,8.43 GB
960x540    part_1..11: 7.66,6.5,6.46(+_3_fix 5.54),7.38,7.36,4.28,6.98,5.95,4.03,4.63 GB
640x360    part_1..11: 3.58,2.56,2.19,2.97,3.39,3.17,1.93,2.91,2.76,1.81,2.09 GB
```

Note `960x540_part_3_fix.tar.gz` replaces `960x540_part_3.tar.gz` (the "fix" a known
corrupted part — see §1.7 gotchas).

Rough totals (summing the above):
- 1920x1080 ≈ **288 GB**
- 1280x720  ≈ **122 GB**
- 960x540   ≈ **67 GB** (includes the 5.54 GB fix; original part_3 excluded)
- 640x360   ≈ **29 GB**
- **Full 4-resolution package ≈ ~505 GB** compressed (tar.gz of 5 s H.264 clips).

Practical note for us: this is a **huge** fetch. Our regression only needs the
1080p ladder for the anchor + one way to map JND-QP → bitrate. We do **not** need
all four resolutions to fit `a` — see §1.6. Partial acquisition (1080p only, ~288 GB)
is feasible; that single resolution is the one the probe measures at.

### 1.3 Contents / data format [SOLID]

- 220 source clips (5 s each), 4 resolutions each = 880 clips.
- Each clip encoded **x264 (H.264 High profile), CQP (constant QP), QP = 0..51**
  (QP=0 = losslessly-encoded source/reference; the paper states `220 × 4 × 52 = 45,760`
  clips in total, i.e. **all QP rungs are shipped**, not just clips near the JND).
- The JVCIR paper (and README) confirm: "*By including the source and all coded video
  clips, there are 220 × 4 × 52 = 45,760 video clips in the VideoSet.*" So the tarballs
  DO contain **every QP encode per content/resolution** — QP 1–51 plus the QP=0 source.
  This is exactly what we need: given a JND-QP threshold, we can read the bitrate of
  that exact encode (or ffprobe it) to map QP → bpp per content. [SOLID]
- Sources: Blender "Tears of Steel" (40 clips) + CFI/CableLabs 4K content; original
  spatial res 4096×2160 / 4096×1714 / 3840×2160, frame rates 60/30/24, YUV444p/422p/420p;
  downscaled to the four target resolutions. The Tears-of-Steel subset carries heavy
  added film grain — a selling point for our grain-vs-clean split. [SOLID]
- Encoding recipe (CQP, adaptive-QP minimised, so QP↔quality is clean) is documented
  in `encode_x264.sh.tar.gz` (the DATA SET SCRIPTS package). [SOLID]

### 1.4 JND label file format [SOLID]

- Labelled by **content id × (resolution × JND-number)** CSV: one CSV per
  resolution × JND index, named like `960x540_1st.csv`, `..._2nd.csv`, `..._3rd.csv`
  (filenames seen directly on the DataPort page; the `960x540_1st.csv` header typo
  "anchor"→"jnd" was fixed 2017-03-01). [SOLID]
- Per the paper's JND measurement and the known MCL-JCV lineage, each row maps a
  content id to the **individual-subject JND samples** in QP units; the dataset also
  ships aggregate mean/SD and the subject outlier-cleaned set (z-score dispersion +
  Grubbs' test, α=0.05; ~95% of per-content JND distributions normal per
  Jarque-Bera). **JND is natively in QP units** (1st/2nd/3rd JND ≈ QP 27/31/34 at
  1080p, per README §5). [SOLID]
- **Usable as-is for our regression? Yes, with a QP→bitrate conversion step.** The
  label is QP, not bitrate — but because all 51 QP rungs are shipped, each content's
  JND-QP maps to a *concrete shipped encode whose bitrate we ffprobe*. So for each of
  the 220 contents we get (anchor bitrate in bpp), (measured CRF-20 complexity) and
  can regress log(anchor bpp) vs log(complexity) without guessing. This is exactly the
  "map QP→bitrate via the shipped encode" the README §5 protocol calls for. [SOLID]
- Caveat to remember for the fit: our probe is x265/CRF; VideoSet JND is x264/QP. The
  codec normalisation the probe already applies to H.264 sources (÷1.6) is the same
  correction needed to put the VideoSet anchor on our x265 complexity scale. Leave the
  raw labels untouched; apply this only in the mapping step. [SOLID]

### 1.5 License / access terms [SOLID]

- **IEEE DataPort standard** download dataset: requires a *free* IEEE account AND an
  **active IEEE DataPort subscription** to download. The page states verbatim:
  "This dataset requires an IEEE DataPort Subscription to access" / "LOGIN TO ACCESS
  DATASET FILES". IEEE DataPort offers annual/free-tier plans; IEEE Society Members
  get DataPort access. **No separate research agreement, no separate "research-only"
  clickthrough beyond the account+subscription terms.** [SOLID]
- The docs (README, JVCIR PDF) and scripts (encode script, md5sum, database_csv) are
  publicly viewable WITHOUT login; only the media tarballs are gated. [SOLID]
- Practical bottom line: **for internal analysis we only need to sign up for a free
  IEEE account + obtain DataPort access; there is no publisher-style licence to sign
  and no data-usage agreement beyond DataPort's standard terms.** BaiduYun mirror
  requires its own (free) Baidu account and is the usual way people sidestep the
  DataPort subscription; but its persistence and whether the share is still active is
  [UNTESTED] — treat Baidu as a fallback to verify at fetch time, not as the primary
  path. [DIRECTION]
- Note: this is a **public download dataset**, not gated-on-request. The earlier
  README §5 wording ("downloadable") already reflects that; the only gate is the
  DataPort account/subscription.

### 1.6 Effort estimate

- Get DataPort access (free account + subscription tier): **minutes to a day**
  (signup friction; IEEE account creation required). [DIRECTION]
- Download 1080p-only (~288 GB): **hours to a day** depending on AWS/region bandwidth
  and the NUC's link; 720p+540p+360p (~217 GB more) only if we want multi-resolution
  points — not needed for `a`. Verify md5sums against `md5sum.tar.gz`. [DIRECTION]
- ffprobe 220 shortened-with-QP encodes at their JND QPs: **~minutes** (5 s clips,
  220 probes). Regression: trivial once labels are parsed. [SOLID]
- **148 GB free on `/` is the binding constraint** (AGENTS research-corpora rule):
  the full ~505 GB package CANNOT fit on the SSD. Even 1080p-only (~288 GB) does not
  fit `/` as-is. **Target of record: `/data/research/` (7.3 TB), symlinked into the
  repo if a script wants a repo-relative path** — same treatment as `data/cvqad ->
  /data/research/cvqad`. Plan the disk placement BEFORE fetching. [DIRECTION]

### 1.7 Gotchas [MIXED]

- `960x540_part_3` was corrupted in the original upload; **must use
  `960x540_part_3_fix.tar.gz`**. Only matters if we fetch 540p. [SOLID]
- Header typo in `960x540_1st.csv` fixed 2017-03-01 (anchor→jnd) — again only 540p. [SOLID]
- `_part_X.tar.gz` / `_part_X.tar_gz` naming appears inconsistently on the page render
  (a history of two spellings); **the current canonical link list uses `.tar.gz`.**
  If a part fails, check the other spelling rather than assuming the file is gone. [SOLID]
- BaiduYun mirror updated noted 2025-07-16 per the task brief, but DataPort's own
  "Last updated" is also 2025-07-16 — the mirror link itself is the 2017 share; its
  current liveness is [UNTESTED], and Baidu's non-resident speed/auth is a real
  friction point. Primary path = IEEE DataPort. [DIRECTION]
- JND labels are per-content-id; the CSV files must be joined to the clip folder/naming
  convention exactly as shipped (content id ↔ tarball partition). The `database_csv_v1`
  script bundle documents the schema. Verify a couple of `1st.csv` rows against the
  paper's Table/Figure values (e.g. #15 tunnel μ≈30.5, #37 dinner table μ≈22.6 at
  1080p) as a sanity check before building the pipeline. [DIRECTION]

---

## Dataset 2 — HD-VJND (Zhu/Perrin/Le Callet, Nantes / LS2N)

### 2.1 What HD-VJND is (confirmed shape) [SOLID]

- 180 SDR HD sources (10 s, 1080p; selected from a 600+ pool for content diversity).
- Encoded **x265 (HEVC) at CRF 17–31 in 0.25 steps**, at **both 1080p and 720p**.
- 1st-JND anchor = **CRF=1 near-lossless** at native resolution.
- 2nd-JND searched at both 1080p and 720p (convex-hull: 1st JND at source res, 2nd
  may drop a rung) — a content-adaptive ladder. Robust Binary Search (RBS) with a
  pre-processing step to cut test time (~7% faster than plain RBS).
- 20 naive subjects, in-home on 55" displays (UHD Grundig etc.), viewing distance
  3H for HD. **JND is natively in CRF units.**
- Sources: papers [Zhu/Perrin/Le Callet, PCS 2022, doi:10.1109/pcs56426.2022.10018068;
  HAL hal-03796533; cross-confirmed in arXiv:2602.17010 §II-A].
- [SOLID] — this is the same-encoder-family (x265/CRF) twin of our probe, so no codec
  normalisation is needed to compare anchor vs probe complexity. Ideal fit data.

### 2.2 Where to request it / distribution gate [DIRECTION → the single blocker]

- **No public download repository exists** (unlike VideoSet's DataPort). A HAL record
  (hal-03796533) exists but is the *paper/chapter record* — the HAL API returns only
  the paper PDF as its main file, **no dataset attachment**. Searching HAL for
  "HD-VJND" title returns 0 bundled data files. So HAL is the citation + paper, NOT a
  data mirror. [SOLID — checked via HAL API `api.archives-ouvertes.fr`]
- The task brief's "inserm mirror" is not found; the HAL UI is also Anubis
  proof-of-work gated to scrapers (same wall the brief already hit), which does not
  change the above — the API says there is no dataset file on the record. [DIRECTION]
- **Most likely gate: email request to the LS2N group (Le Callet's unit)**. Le Callet's
  LS2N resources page (`pagesperso.ls2n.fr/~lecallet-p/platforms.htm`, still live and
  currently under the old "IRCCyN" name) lists the IVC databases and states resources
  are "open for collaborative projects" — but HD-VJND is **not** on that list, so no
  closed-form URL exists. The specific release is believed to be granted on request.
  [DIRECTION — the realistic distribution path, matching the brief's prior finding]
- **Contact hints [DIRECTION]:**
  - Patrick Le Callet — pagesperso.ls2n.fr/~lecallet-p/ (the platforms.htm page above).
  - Jingwen Zhu (first author; École Centrale de Nantes / LS2N) — co-supervisor is Le
    Callet; she is the person who built HD-VJND, so she is the most likely author to
    grant the data; she also appears on the arXiv:2602.17010 correspondence.
  - Anne-Flore Perrin (LIRIS/INSA Lyon since ~2023; was Nantes) — co-author.
  - LS2N lab contact page / Le Callet's page is the canonical starting point.
- No public form found; the PCS 2022 and follow-up papers (arXiv:2305.00225v1,
  arXiv:2602.17010) do not ship the data or a request URL. [DIRECTION]

### 2.3 Licence / what can we use it for [UNTESTED]

- Because distribution is request-gated (not a public download), there is **no public
  licence text** to quote. Expect the LS2N standard: **research / non-commercial use**,
  typically granted on a brief email stating purpose + institution, sometimes with a
  short non-disclosure / use-agreement. Our use (internal analysis of the exponent fit,
  no redistribution, citation of the PCS 2022 paper) is exactly the kind of request
  these labs normally approve. [DIRECTION / UNTESTED until the contact replies]
- **Language:** French lab; English email is standard in CS and perfectly acceptable.
  No French needed. Write to Zhu (she publishes in English), CC or bcc Le Callet.
  [SOLID — the group's English publication record makes English correspondence normal]

### 2.4 What's shipped — CRF encodes and/or bitrate tables? [UNTESTED — ask explicitly]

This is the crux for the fit and we must **ask the authors directly**, because the
public record does not specify the package contents:

- **JND as CRF:** the native label is a CRF threshold (1st/2nd JND per content →
  CRF 17–31 grid, 0.25 steps), reported via 75%-SUR. If we only get CRF thresholds,
  converting CRF → bitrate needs a per-content rate table. [SOLID on the label being
  CRF]
- **What we want and should request:** the **per-encode bitrate of the JND-CRF encode
  at 1080p** (or the whole 0.25-step rate table). Two sub-cases to probe in one email:
  1. Do they ship the **actual CRF 17–31 encodes** (i.e. ~180×(57)/(+res) PVS)? If yes,
     we can ffprobe the exact JND encode — same convenient mapping as VideoSet. [UNTESTED]
  2. Or only the CRF labels with a **rate table / x265 bitrate log**? Then map label→bpp
     from their logs. [UNTESTED]
- The DCR follow-up dataset in arXiv:2602.17010 (MOS at 9 PVS per content incl.
  CRF±1 of the JNDs) is a **separate** release; HD-VJND itself "lacks MOS scores"
  (stated in that paper) — which is fine, we need only the CRF JND + bitrate, not MOS.
  Trust arXiv:2602.17010 §II-A for the **content/shape** description (180 SRC, 10 s,
  1080p, CRF 17–31 @ 0.25, two resolutions, RBS, 20 subjects) — that matches PCS 2022;
  treat it as a **secondary** confirmation of shape, but the present request is for the
  PCS 2022 **HD-VJND** release, not the 2602.17010 DCR set. [SOLID]
- **On "0.25-step encodes shipped":** the task brief's phrasing ("-step CRF encodes are
  shipped") is not contradicted by the record but is not confirmed either — the RBS
  tested within the 17–31 grid at 0.25 granularity, so the *labels* exist at 0.25
  resolution; whether all ~57 PVS per res per content are archived and released is the
  open question to put to Zhu. [UNTESTED]

### 2.5 Labour economics against our probe

- Even if they ship only the CRF labels + a rate table, we can reconstruct the anchor
  bitrate from their logs. If they ship only CRF with no bitrate info, we can **re-encode
  the JND-CRF points ourselves on the 10 s sources** — 180 contents × 1-3 encodes @ x265
  medium is trivial CPU load (10 s clips), but it loses the "their exact bitstream"
  strictness. Asking for their rate table avoids re-encoding entirely. [DIRECTION]

### 2.6 Expected turnaround [DIRECTION / UNTESTED]

- Grant-style dataset requests to groups like LS2N typically land in **days to ~2-4
  weeks**, gated on (a) finding the right contact (Zhu most likely) and (b) their
  current load / whether they have a standing EULA. Because this specific dataset was
  built by a PhD student who has since moved through several papers with the data, it
  may be bundled as an Onedrive/Drive link or a downloadable archive on a lab server —
  expect a manual human handoff, not an automated portal. [DIRECTION]
- No established public turnaround to quote; do not assume instant. Follow up once if
  no reply in ~2 weeks. [DIRECTION]

### 2.7 Gotchas [DIRECTION / UNTESTED]

- **There may be no free-form release at all** and the data may only be shared within a
  collaboration. If the email path stalls, alternatives to weigh (outside this task's
  scope but worth knowing): the **Paper/PDF of PCS 2022 includes the SUR/JND figures but
  not the raw labels**; a bio of follow-ups (arXiv:2305.00225v1) uses HD-VJND as a
  training set and may have a mirror of the labels even if not the clips. [DIRECTION]
- Home-environment subjectivity (55" TVs, variable rooms) is a stated property of the
  dataset — this **increases label noise vs VideoSet's controlled labs** and is worth a
  footnote in the eventual fit (weighting / outlier handling). [SOLID]
- Only **1st (1080p) and 2nd (1080p+720p)** JNDs are searched — there is **no 3rd-JND**
  ladder, so it's a 2-point-per-resolution ladder, not a full 3-step staircase like
  VideoSet. Fine for the anchor regression (1st JND is our anchor currency), but it
  limits any ladder-shape analysis. [SOLID — PCS 2022 / arXiv:2602.17010]

---

## Which to fetch first

**Fetch order recommendation: VideoSet first, HD-VJND second, and start the
HD-VJND email in parallel on day one.**

Reasoning:
1. **VideoSet is self-serve and deterministic** — the only blocker is an IEEE DataPort
   account/subscription, which is a minutes-to-a-day fixed cost with a guaranteed
   outcome. The tarballs, README, md5sums and label CSVs are all documented. With the
   220-anchor-points + QP→bitrate mapping it delivers exactly one side of the
   regression (`t_j`) and it's the dataset whose method (controlled labs, 30+ subjects,
   JND1/2/3, grain-heavy Tears-of-Steel subset) is also the strongest statistically.
   It can also run today against `/data/research/` storage. Priority: high.
2. **HD-VJND is the same-encoder-family twin** (x265/CRF, no codec normalisation) and
   180 contents with finely-grained 0.25 CRF — but its acquisition is **gated on a
   human email reply** with unknown turnaround and unknown package contents (bitrate
   logs vs raw encodes). That uncertainty is the reason to *start* the email now (in
   parallel with VideoSet) rather than after, but not to wait for it.
3. **Prefer VideoSet if we want a guaranteed, statship-sound fit today; prefer HD-VJND
   if we want the cleanest cross-encoder comparison to our probe** and are willing to
   accept email-gate + possibly re-encoding. Since both add ~200 contents to the
   LEHA-CVQAD 60, either materially improves the fit; the marginal value of getting both
   is the codec-comparison and the grain split.

Concrete first actions (in order):
1. Create a **free IEEE account + IEEE DataPort access** (IEEE Societies member access
   if applicable). (1 action, ~30 min.)
2. **Email Jingwen Zhu (CC Le Callet)** requesting HD-VJND: state purpose (internal
   analysis of the per-content CRF-transparency exponent), request the 1080p CRF JND
   labels AND the per-CRF/per-JND **bitrate logs or the raw encodes**, and confirm
   licence = research-only internal use. (1 action, ~30 min, big lever — do today.)
3. Stage disk: confirm `/data/research/videoset/` (and `/data/research/hdvjnd/`)
   targets have room (`df --output=avail -BG /data`) **before** any fetch — this is
   the 2026-08-21 CVQAD failure-mitigation rule. (5 min.)
4. Fetch VideoSet 1080p tarballs → verify `md5sum` → ffprobe the JND-QP encodes → parse
   `*_1st/_2nd/_3rd.csv`. (hours, mostly download time.)

---

### Source checklist (all live-checked 2026-08-28)

- mcl.usc.edu/videoset → https://mcl.usc.edu/videoset/
- IEEE DataPort VideoSet → https://ieee-dataport.org/documents/videoset
- DataPort DOI → https://dx.doi.org/10.21227/H2H01C
- Paper arXiv → https://arxiv.org/abs/1701.01500 ; JVCIR doi:10.1016/j.jvcir.2017.04.009
- HAL (PCS 2022, HD-VJND) → https://hal.science/hal-03796533 (paper only; checked via HAL API)
- PCS 2022 DOI → doi:10.1109/pcs56426.2022.10018068
- Follow-up using HD-VJND → arXiv:2305.00225v1 ; DCR-on-HD-VJND → arXiv:2602.17010 (2026-02-19)
- Le Callet LS2N resources → http://pagesperso.ls2n.fr/~lecallet-p/platforms.htm
