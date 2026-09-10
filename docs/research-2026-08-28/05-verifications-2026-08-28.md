# 05 — Verification closures 2026-08-28 (post-loops)

Companion to `README.md` §"Session next-steps". Two items from that list are
now CLOSED (web verification only — nothing downloaded, no files modified).
One resources fact updated. Tag legend as elsewhere.
**N.B. written by a stale agent thread; its LEHA-CVQAD "no rung ≥ 4 Mbps"
implication was corrected here on 2026-08-28 against direct on-disk CSV
inventory (see §2). Cross-check everything in this file against disk before
relying on it — item §3 ("/data free") and the disk numbers were confirmed
live by the main agent at 14:37 2026-08-28.**

---

## 1. YT-UGC DMOS-subset rung count = exactly 3 → CLOSED [SOLID]

Checked against the official dataset page (`media.withyoutube.com/ugc-dataset`,
live) and the ICIP 2020 paper (Yim/Wang/Birkbeck/Adsumilli,
doi:10.1109/icip40778.2020.9191194; arXiv:2002.12275):

> "Three VP9 variants: Video-On-Demand (VOD), Video-On-Demand with Lower
> Bitrate (VODLB), and Constant Bitrate (CBR), using the recommended VP9
> settings and target bitrates."

- DMOS exists only for selected content categories (Gaming, Sports, Vlog),
  exactly the three-category subset the README §1/#3 row assumes. [SOLID]
- Full MOS covers all clips + 3 overlapping 10 s chunks; DMOS xlsx at
  `storage.cloud.google.com/ugc-dataset/original_videos/DMOS_for_YouTube_UGC_dataset.xlsx`. [SOLID]
- README verdict stands: usable as secondary fit, VP9-only, UGC no grain.
  Rung count 3 confirmed; `VODLB` ≈ the "round bitrate farther down the same
  content" rung the model needs. No change to rank.

## 2. LEHA-CVQAD v2 full-set publicity → CLOSED [SOLID]

Checked against the paper (arXiv:2507.03990v2), the project page
(`aleksandrgushchin.github.io/lcvqad/`), HF dataset cards
(`msm1rnov/LEHA-CVQAD`, `deepfakesMSU/CVQAD`), and the benchmark page:

- **Open part (public):** 1,962 of 6,240 clips, 59 sources, 57 codecs,
  downloadable (HF + Synology `titan.gml-team.ru` wget). The HF card and
  benchmark page both say 1962; the paper abstract says 1963 — the known
  v1/v2 data-card off-by-one. Our on-disk inventory = 1,962 rows / 60 distinct
  sequence names, consistent with HF. [SOLID]
- **Full part (6,240 / 4,277 hidden):** marked `Bench.` in the paper's Table 1 —
  benchmark-support personnel only, not public. Confirmed: no public full-set
  route. [SOLID]
- **Anchor implication (CORRECTED 2026-08-28, per on-disk CSV):** the open part
  is NOT limited to 4 Mbps. Direct inventory of `Subjective_scores_and_videos_info.csv`
  (1,962 rows, 60 sequences) shows 733/1962 rows above 4000 kbps (37.4%), p90 =
  10,268, p99 = 18,745, max = 39,381 kbps, 233 rows above 10 Mbps — e.g.
  `christmas-cats-2021` x265-ref at 16.4 Mbps has MOS 7.90. The "no rung ≥ 4 Mbps"
  claim came from the paper's nominal 3-target description, not the released labels.
  So the transparency question for CVQAD is **open, not closed**: whether MOS
  saturates with bitrate within a sequence is directly testable from the CSV, and
  must not be ruled out by assumption. [SOLID — direct disk inventory]
- Bonus fact banked: the authors propose **RDAE (Rate-Distortion Alignment
  Error)** — a metric for how well a VQA model preserves bitrate-quality
  ordering, "how many bits are wasted if you optimize codec parameters using
  this metric". Same question our `a`-fit answers; good cross-check vocabulary
  if the write-up ever cites their benchmark.

## 3. Resources/disk reality check (for the fetch decisions) [SOLID]

- `/data/research/cvqad/` present, 36 GB, symlinked `data/cvqad ->` it —
  fit-route-2 raw material is live. Ladder logs
  (`ladder-v1/under/blindspot.log`) and `measured.json` sit alongside.
- `/data` free = **1,874 GB** → VideoSet 1080p-only (~288 GB) FITS with margin.
  `/` free = **33 GB** → still the binding constraint; anything fetched must go
  to `/data/research/`, never the repo (2026-08-21 CVQAD rule).
- So the remaining blockers are not storage but GATES: IEEE DataPort
  account/subscription (VideoSet), LS2N email reply (HD-VJND), Netflix Drive
  access request. Those are human/account actions, not technical steps.

---

### What remains open (unchanged after these closures)

1. **Download-gated fits:** VideoSet 1080p (~288 GB, needs DataPort access +
   explicit go-ahead), BVI-HD (CDVL id 2955, ~25 GB+ GT-only or larger with
   distorted clips, a CDVL account + explicit go-ahead).
2. **Email-gated fit:** HD-VJND via Jingwen Zhu (CC Le Callet) — request the
   1080p CRF JND labels AND per-CRF bitrate logs or raw encodes; the cleanest
   same-encoder-family twin.
3. **Gated check:** Netflix public dataset Drive access.
4. **Ungated but download-heavy:** YT-UGC DMOS subset (~20 GB) is public;
   LEHA-CVQAD open part is already on disk and needs no further fetch.

All require an explicit user go-ahead (bulk corpora → `/data`, per AGENTS
research-corpus rule). Nothing technical is blocked on missing information.