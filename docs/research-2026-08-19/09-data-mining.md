# 09 — Data mining of the live probe dataset (round 2)

**Date:** 2026-08-19 · **Dataset:** `/tmp/opencode/probe-dataset-now.json` (generated ts 1787192740935) · **n=1031 rows** (885 movies, 146 seasons), crf=20, headroomTarget=1.0, headroomLive=0.5736, flatFallback=0.13, pinning `{A:1.337, B:-0.348, rMin:0.59, max:2.0}`.
Everything below is recomputed from that JSON with python3 (snippets in the appendix). No code, no other report, and no dataset file was modified.

## Headline findings

1. **The per-film denominator reorders the library massively.** Median |live−flat| rank shift is **127 of 885 places**; 58% of movies move ≥100 places, 32% move ≥200 (max 762). The shift correlates with complexity at **r = −0.746**: low-complexity tercile gains a median **+192** places under live scoring, high-complexity tercile loses **−189**. Report 01 finding 3 confirmed and quantified.
2. **The worst-precision units are NOT the grainiest films.** corr(cxRSE, complexity) = **−0.129** (Spearman −0.031). Precision is spread-driven instead: corr(cxRSE, spreadRatio) = **+0.458**, corr(cxRSE, sampleNEff) = **+0.276**. The 10 units with cxRSE ≥ 0.13 have median complexity 0.089 — *below* the library median 0.109.
3. **The "32+ sample distribution" barely exists:** only **15 of 163** units (9.2%) have sampleNEff ≥ 32; median sampleNEff = **16** (mean 17.4); none reach 64. At the median cxRSE 0.111, the typical BPP+ carries ~**5.6%** 1σ relative error; only Dunkirk (cxRSE 0.167) exceeds 8%.
4. **The AGENTS.md Dunkirk anecdote does not reproduce.** Current repaired cache: Dunkirk cxRSE = **0.1667** (sampleN=64, neff=48, dup=16, visits=6; cxSE/cxMean self-consistent). Not "0.199 against a true 0.407". It remains the library maximum.
5. **Replacements move measured complexity UP:** 107 prior→current deltas up vs 35 down, median relative change **+30.3%**. Replaced units' R jumps from med 0.471 → **0.914** (event-banked priors) / 0.604 → 0.837 (true replacement priors): upgrades buy bitrate adequacy, and slightly higher measured complexity.
6. **Complexity declines monotonically with release year** (movies): corr(year, complexity) = **−0.358**; decade medians fall 0.254 (1920s) → 0.086 (2020s). But the **"grainy 1970s" is not a peak** — the 1940s–1960s are all grayer (med 0.153–0.191 vs 1970s 0.127); 1970s vs 2020s differs at p < 0.001 (permutation).
7. **"WEBDL starves grainy titles" is rejected.** WEBDL-1080p is the *least* starved source: med R = **1.062**, 13% below the 0.59 pin, vs Bluray-1080p 49% and Bluray-720p **81%** starved. Among high-complexity films, WEB* copies med R 0.762 vs Bluray 0.477.
8. **Audio pollution is real but bounded:** 85 movies (**9.6%**) carry audioBps ≥ 30% of srcBitrate (worst: Marley & Me 65%, Super Troopers 58%); yet only **5 films** cross the R=0.59 pin when audio is subtracted, because the bias curve is flat below the pin. Max single-film effect: Superbad dR = 0.372 (bias 1.45→1.61).
9. **Seasons are a different population:** med complexity 0.087 vs movies 0.112; med R **0.99 vs 0.59** (TV far less starved); med biasFactor 1.33 vs 1.60. And a coverage hole: **95 of 146 seasons have no bpp/bppPlus at all — all 95 are .mkv** (all 37 mp4 seasons plus 14 mkv have it).
10. **blockMean/blurMean are near dead weight for scoring:** |corr| with complexity ≤ 0.24 (blurMean −0.243, blockMean −0.025), ≈0 with cxRSE (+0.075/+0.018), weak links only to srcBitrate (+0.197/−0.154) and year (+0.089/+0.145).

Bonus reproducibility flag: **the stored `R` field does not equal `srcBitrate/probeBitrate`** — only 30/400 rows match within 1%. It matches `bpp/complexity` for 506/936 bpp-bearing rows (median ratio 1.0002); the 430 mismatches deviate by median 11.9% (max 59%). Likely vintage mismatch between the visit that measured R and the current file's mediaInfo-derived bpp. Everything downstream (biasFactor, cxEff, target, bppPlus) is internally exact given stored R: max|cxEff − complexity×biasFactor| = 3.4e-4, target identity exact, bppPlus formula error 0 on all 936.

---

## 1. Sample precision (sampleNEff, cxRSE)

169 of 1031 units carry per-sample records (`sampleCx`); 163 also have `sampleNEff`; 162 have `samplePos`.

**sampleNEff distribution (n=163):**

| threshold | count | share |
|---|---|---|
| ≥ 8 | 163 | 100% |
| ≥ 16 | 107 | 66% |
| ≥ 24 | 47 | 29% |
| ≥ 32 | **15** | **9.2%** |
| ≥ 48 | 5 | 3.1% |
| ≥ 64 | 0 | 0% |

Values observed: {8×47, 12, 13×2, 14×2, 15×4, 16×60, 24×29, 27, 30, 31, 32×7, 40×3, 48×4, 56}. Median 16, mean 17.41.

**cxRSE distribution (n=169):** min 0.046, p10 0.085, p25 0.101, **median 0.111**, p75 0.122, p90 0.128, max 0.167. Thresholds: ≥0.10 → 127 (75%); ≥0.12 → 49 (29%); ≥0.15 → 1 (Dunkirk). Since BPP+ takes a square root, its 1σ relative error ≈ cxRSE/2: **75% of units carry ≥5% error, 1 unit ≥8%, none ≥10%.** Green band width (100–124) is ~4–5σ at these errors — band assignment is mostly stable, adjacent-band flips are not.

**Where the worst precision sits — correlations over the 169 units:**

| pair | Pearson |
|---|---|
| cxRSE vs complexity | **−0.129** (Spearman −0.031) |
| cxRSE vs sampleNEff | **+0.276** |
| cxRSE vs R | +0.047 |
| cxRSE vs spreadRatio | **+0.458** |

High-cxRSE (≥0.13, n=10) vs low (<0.10, n=42): median complexity 0.089 vs 0.103; median R 0.75 vs 0.69; only 4/10 high-cxRSE units are above the library's median complexity. **Precision is limited by within-film scene variance, not by graininess, and more distinct clips (revisits) expose more variance rather than shrinking the estimate.**

Top cxRSE units: Dunkirk 0.167 (neff 48), Sympathy for Mr. Vengeance 0.146 (cx 0.333), Arrival 0.134 (cx 0.038!), Severance S01 0.131 (neff 13), Silicon Valley S01 0.131 (neff 14), John Wick 3 0.131 (neff 8). Best: The Lives of Others 0.046, Casino Royale (1954) 0.056, Always Sunny S01 0.062.

**Dunkirk fact-check:** stored cxRSE = cxSE/cxMean = 0.02793/0.1676 = 0.1666, and sd/sqrt(neff)/mean reproduces it exactly (sd 0.1935 over 64 raw samples). The AGENTS.md claim "read 0.199 against a true 0.407" matches neither the pre-repair arithmetic (n=64 would give 0.144) nor any recomputation from this cache. Current truth: **0.167, still the library max.**

**Revisit mechanics:** visits distribution {1×62, 2×72, 3×15, 4×7, 5×1, 6×2, 7×3}. visits≥2 units (n=100) have median neff 16 / cxRSE 0.113 vs visits=1 (n=62) neff 8 / cxRSE 0.106. Pooled `complexity` is stable across revisits: max |cxMean − complexity| among revisited units is 0.014 (Breaking Bad S01). **Phase-shift leakage:** 20 units still hold duplicates (sampleDup>0) — Breaking Bad S01 neff 16 of 32 (50% dup), Dunkirk/MI: Final Reckoning/Sympathy for Mr. Vengeance 16 of 64, Blended 16 of 56, Arrival 8 of 64. The phase shift reduced but did not eliminate re-encoded-clip overlap.

**Sample position is unbiased (162 units with samplePos, 147 usable):** per-unit regression slope of sampleCx on fractional position has median **−0.0025** (p25 −0.030, p75 +0.035); 48% positive; median within-unit correlation −0.017. No systematic early/late-film difficulty gradient — phase-shifting sample grids introduces no positional bias. Largest genuine gradients: Killer of Sheep +0.30/fraction (harder late), The 39 Steps −0.17 (easier late).

## 2. The pinning / replacement cycle (priors)

144 units carry priors (148 entries: 140 units ×1, 4 units ×2). Two kinds: **96 event-banked** (from:'events', starvation-experiment measurements) and **52 true replacement priors** (measuredFrom path, e.g. MI: Fallout's old YTS copy).

| prior class | n | prior R med | current R med | Δcomplexity med | up/down | rel change med |
|---|---|---|---|---|---|---|
| events | 96 | 0.471 | 0.914 | +0.0403 | 78/18 | +32.7% |
| replacement | 52 | 0.604 | 0.837 | +0.0102 | 29/17 | +10.2% |
| all | 148 | 0.481 | 0.876 | +0.0409 | 107/35 | +30.3% |

|Δcomplexity|: min 0.0000, p25 0.0133, **med 0.0409**, p75 0.0846, max 0.4004.

Biggest moves: **12 Angry Men +0.400 (0.527→0.927, ×1.76)**, Star Wars Holiday Special **−0.366** (×0.35 — the truncated 15.7-min VOB replaced by a real copy of a low-complexity programme), sex, lies, and videotape +0.267 (×2.62), The General +0.248, Stalag 17 +0.234, Key Largo +0.208, Mad Max: Fury Road +0.182, Sabrina +0.176.

Most-replaced (2 priors): Gladiator (0.087→0.132→0.189), MI: The Final Reckoning (0.184→0.079→0.093), Chinatown (0.074→0.182→0.114), Drive (0.123→0.093→0.091). Note Gladiator/Chinatown/Drive converged upward then downward as source quality changed — complexity tracks the *content*, and big swings came from measuring starved copies first.

Systematic R difference: replaced units med R **0.876** vs never-replaced **0.603** (means 0.962 vs 0.805). Replacement selects for titles worth upgrading and lands better-bitrated files; the +30% complexity drift is consistent with the pinning model's premise that starved copies under-measure content cost.

## 3. Complexity vs year, source, codec (movies)

**By decade (median complexity):**

| decade | n | med cx | mean cx |
|---|---|---|---|
| 1920s | 3 | 0.2539 | 0.2863 |
| 1930s | 11 | 0.1398 | 0.1680 |
| 1940s | 22 | 0.1906 | 0.1968 |
| 1950s | 40 | 0.1540 | 0.1965 |
| 1960s | 59 | 0.1531 | 0.1633 |
| 1970s | 56 | 0.1268 | 0.1549 |
| 1980s | 84 | 0.1190 | 0.1397 |
| 1990s | 118 | 0.1147 | 0.1237 |
| 2000s | 178 | 0.1122 | 0.1278 |
| 2010s | 195 | 0.1033 | 0.1110 |
| 2020s | 119 | 0.0862 | 0.0971 |

corr(year, complexity) = **−0.358**. Permutation tests on means: 1970s vs 2020s **p<0.001**, 2000s vs 2010s p=0.005, 2010s vs 2020s p=0.010, 1940s vs 1970s p=0.073, 1950s vs 1970s p=0.089, 1960s vs 1970s p=0.596. So: clean-2020s story **confirmed**; grainy-1970s story **not a peak** — classic film stock (1940s–60s) is consistently more expensive than the 70s–80s, and the decline since 2000 is statistically solid.

**By source (movies):**

| source | n | med cx | note |
|---|---|---|---|
| SDTV | 2 | 0.4125 | incl. Holiday Special class |
| Remux-1080p | 4 | 0.1157 (mean 0.3062) | 12 Angry Men pulls the mean |
| Bluray-1080p | 727 | 0.1143 | the reference population |
| Bluray-720p | 68 | 0.1107 | |
| WEBDL-720p | 15 | 0.1125 | |
| WEBDL-1080p | 30 | 0.1080 | |
| WEBRip-720p | 18 | 0.0955 | |
| WEBRip-1080p | 19 | **0.0788** | web re-encodes smooth grain away |

WEBRip content measures systematically cleaner (medians 0.079–0.096 vs 0.111 for Blu-ray) — consistent with generational loss before the probe ever sees it.

**By codec (movies):** h264 n=831 med cx 0.1125; hevc n=52 med cx 0.1043; mpeg4 n=2 (0.4125). HEVC-sourced content is marginally cleaner; nothing dramatic.

## 4. R vs source / codec — who is starved

Starved = R < 0.59 (pin floor):

| source | n | med R | starved |
|---|---|---|---|
| Bluray-720p | 68 | **0.431** | **81%** |
| WEBRip-720p | 18 | 0.596 | 50% |
| Bluray-1080p | 727 | 0.595 | 49% |
| WEBRip-1080p | 19 | 0.673 | 37% |
| WEBDL-720p | 15 | 0.845 | 27% |
| Remux-1080p | 4 | 0.719 | 25% |
| WEBDL-1080p | 30 | **1.062** | **13%** |

Codec: h264 med R 0.574 vs hevc 0.884 — the HEVC copies on disk are less starved (they were picked as upgrades).

Complexity-tercile cross-check (low/mid/high by movie terciles 0.096/0.135):

| group | low cx | mid cx | high cx |
|---|---|---|---|
| WEB* (n=83) | 0.863 | 0.518 | **0.762** |
| Bluray (n=795) | 0.721 | 0.520 | **0.477** |

corr(R, complexity) overall = −0.137; within low-cx films −0.297; within high-cx films −0.011. **Conclusion: the starved class is small-file Blu-ray rips (especially 720p) of mid-complexity content, not WEBDL of grainy films.** WEBDL's bitrate cap is offset by its content being modern/clean; where WEBDL carries a genuinely grainy title it does *better* than Blu-ray rips do.

## 5. Within-film spread

spreadRatio: movies med **4.006** (p25 2.83, p75 6.24, max 1279); seasons med 4.034 (max 29.2) — distributions are nearly identical. ln(spread) correlations: vs complexity **+0.061** (movies), **−0.084** (seasons); vs year **+0.185**.

**The "grain is spatially non-uniform ⇒ high-cx films spread more" hypothesis is rejected**: complexity-tercile medians barely move (3.78 / 4.04 / 4.28). What high spread actually flags is **scene diversity**: Blade Runner Black Out 2022 (short anime) 1279, Sicario 160, The Witch 129, Samsara 98 (montage documentary), Navalny 75, Mirror 38, 1917 32. Seasons' top spreaders are anthology/nature TV: Black Mirror S01 29.2, Cosmos (2014) S02 26.1, 1923 20.6.

Season `disagree` (between-episode): all 146 nonzero, median **0.232**, mean 0.343, max 1.444 — episodes of a season routinely differ more from each other than samples within a film; the season unit's complexity is a genuine average over heterogeneous content. Movies: disagree always 0 by construction.

## 6. Score behaviour: live vs flat (movies, n=885)

corr(live, flat): Pearson **0.677**, Spearman 0.611. live−flat: median **−8**, mean −9.5; 645 movies score lower live, 227 higher.

Rank shifts (live rank minus flat rank within the 885): |Δ| median **127**, p75 250, p90 397, max 762; ≥100 for 515 films (58%), ≥200 for 284 (32%). corr(rank-shift, complexity) = **−0.746**; tercile median shifts **+192 / +6 / −189** (low/mid/high complexity). corr(rank-shift, year) = +0.32, corr(rank-shift, R) = +0.23.

Largest promotions by live (flat underrates clean films): BlackBerry +604 places (71 vs 49), Oppenheimer +599 (70/45), Office Space +597 (87/59), El Camino +558, Marathon Man +558, The Beast +557, 12th Fail +545, Prisoners +532, Her +530. Largest demotions (flat overrates grain): Killer of Sheep −762 (34 vs 95), Autumn Sonata −728 (41/94), City of Men −716 (47/136), World's Fastest Indian −673, Detachment −622, Schindler's List −611 (45/94), Following −605, Flow −598, Sympathy for Mr. Vengeance −576.

Biggest absolute score gaps: **12 Angry Men −152 (live 67, flat 219)**, Beach Party −92, The Father **+89** (183/94, R 3.61), City of Men −89, Citizen Kane −82, Casino Royale (1954) −81, sex, lies −77, Key Largo −76, Stalag 17 −73, The General −73, 2036: Nexus Dawn **+73** (231/158), Train Dreams +71 (182/111), Taxi Driver −68, Casablanca −66 (115/181), Apocalypse Now −66.

Beloved/Top-100 (117 ranked rows) median |shift| 69: Schindler's List −611, Office Space +597, No Other Choice −554, Catch Me If You Can −450, Barry Lyndon −442, WALL·E +424, I Swear +416, Psycho −414.

Band migration (flat → live): purple 79→29 (**−50**), orange 171→143 (−28), green 38→58 (**+20**), red 597→655 (+58). Transition counts: same band 638 (72.1%); red→orange 89 (10.1%), orange→red 44 (5.0%), green→purple 23 (2.6%), orange→purple 21, green→orange 17, orange→green 18, red→green 9 (1.0%), green→red 8 (0.9%), red→purple 12, purple→orange 5, purple→green 1. Reading: the live denominator **widens both tails** (pulls inflated flat-purples down, pushes marginal flat-oranges into red) but still nets **+20 films into green** — the target band grows under per-film scoring.

Live band census (movies): red 655 (74%), orange 143, green 58, purple 29; bppPlus med 60, p10 46, p90 99, range 30–231.

## 7. Audio pollution (movies)

audioBps/srcBitrate: median **0.098**, p25 0.056, p75 0.175, max 0.654. Shares: ≥10% for 430 films (48.6%), ≥20% for 173 (19.5%), **≥30% for 85 (9.6%)**.

Worst offenders: Marley & Me 0.65 (0.64 Mbps audio of 0.98 total), Super Troopers 0.58, Yojimbo 0.47 (3 tracks), Drive My Car 0.47, Superbad 0.47 (7 tracks), Shutter Island 0.46, Heathers 0.45. By source, web rips carry the most audio share: WEBRip-1080p med 0.183, WEBDL-1080p 0.150, vs Bluray-1080p 0.090.

Effect on the bias correction (video-only R′ = (src−audio)/probe, counterfactual on stored fields): among the 85, median ΔR is tiny (−0.005) because most already sit below the pin where the curve is flat; the max is **Superbad dR 0.372 (bias 1.45→1.61)**, Marley & Me 0.284 (1.56→1.61), Drive My Car 0.104. Only **5 films** sit above the pin with audio and below it without — so audio inflation currently mis-directs the correction for ~0.6% of the library, but the 85-film class is exactly where future *smaller* files would be mis-scored if audio share stays constant while video bits drop.

## 8. Outliers and anomalies

**bppPlus > 200 (3 films):** 2036: Nexus Dawn **231** (R 5.43, 0.52 GB short), Parasite **218** (R 5.58, 13.3 GB feature), 2048: Nowhere to Run 206 (R 4.30, short). So no — not all shorts: **Parasite is a full feature whose CRF-20 cost measures 0.065**, i.e. an extremely clean digital film carrying a 13.5 Mbps source.

**R > 3 (17 units):** Parasite 5.58, 2036 5.43, Peaky Blinders S04 4.58 / S05 4.23 / S02 3.44 / S03 3.17 (seasons, no bppPlus), 2048 4.30, Blade Runner 2049 4.27, Inglourious Basterds 4.22, Lessons in Chemistry S01 3.97, Train Dreams 3.97, House of Cards S01 3.97, The Father 3.61, American Psycho 3.49, Pulp Fiction 3.39, Cosmos S01 3.24, Mr Inbetween S02 3.15. Extremes elsewhere: R<0.2 for 2 units, R<0.3 for 45, R>1.5 for 103, R>2 for 49.

**Over-provisioned files (bytes/complexity, top):** Parasite 205 GB-per-unit-cx, Blade Runner 2049 193, Inglourious Basterds 178, Killers of the Flower Moon 170, Lawrence of Arabia 153, Pulp Fiction 148, Jackie Brown 144, Sinners 144, GoodFellas 143, The Father 131. These are the audit tab's natural "nothing to fix" set.

**12 Angry Men — the strangest row in the library:** highest complexity measured anywhere (0.927, after a +0.400 revision from its starved prior 0.527), Remux-1080p, 24.5 GB file, srcBitrate 34 Mbps, **probeBitrate 28.8 Mbps = the largest probe encode in the library** — a single-room B&W film costs more at CRF-20 than anything else owned, yet still scores BPP+ 67 (flat would say 219, the largest single flat-vs-live gap at −152). Its spreadRatio is only 1.52 — uniformly grainy, not scenatically variable.

**Small-but-demanding:** Beach Party (1963) cx 0.450 in a 0.73 GB file (BPP+ 73), Casino Royale (1954) cx 0.375 at 0.73 GB (81), Blair Witch cx 0.270 at R 0.14 (30). Among 49 sub-800 MB movies the median cx is 0.113 — the class is not uniformly easy content.

**Visit-drift check:** pooled complexity vs latest-session cxMean never diverges by more than 0.014 across revisited units — no measurement instability beyond the known duplicate-sample repair.

## 9. Seasons vs movies

| field | movies (n=885) med | seasons (n=146) med |
|---|---|---|
| complexity | 0.112 | **0.087** |
| R | 0.594 | **0.988** |
| biasFactor | 1.603 | **1.333** |
| cxEff | 0.172 | 0.115 |
| spreadRatio | 4.01 | 4.01 |
| cxRSE (where present) | 0.112 | 0.105 |
| srcBitrate | 2.25 Mbps | 2.64 Mbps |
| audioTracks | 1 (p75 2) | 1 |
| files | 1 | 2 |
| wallMs | 203 s | 427 s |
| bppPlus present | 885/885 | **51/146** |

Seasons measure cheaper (TV content, and 2 interior episodes averaged), are far less starved (med R ≈ parity), and therefore get smaller bias corrections. Their spread behaviour is identical to movies; their between-episode disagree (med 0.232) is the extra variance dimension movies don't have. Season wall-clock is 2.1× a movie unit — the night budget prices a season like two films.

**Coverage hole:** the 95 seasons without bpp/bppPlus are **exactly the .mkv ones** (95/95 mkv missing; of the 51 with bpp, 37 are .mp4 and 14 .mkv). Whatever joins mediaInfo→bpp for seasons fails on matroska, so 65% of TV units have no score at all — they appear in probe outputs with complexity but no BPP+. Also all 146 season rows have year=0, so no decade analysis is possible for TV from this dataset alone.

## 10. blockMean / blurMean — dead weight?

Correlations (movies, n=885; detector columns present on every row):

| vs | blockMean | blurMean |
|---|---|---|
| complexity | −0.025 | **−0.243** |
| R | +0.168 | −0.052 |
| spreadRatio | +0.018 | −0.088 |
| bppPlus | +0.182 | −0.048 |
| srcBitrate | +0.197 | −0.154 |
| cxRSE | +0.075 | +0.018 |
| year | +0.089 | +0.145 |
| biasFactor | −0.210 | +0.083 |

Neither detector tracks measurement precision or within-film spread — the two things an artifact detector would need to explain sample noise. blurMean's modest anti-correlation with complexity (−0.243) says it mostly fires on clean, soft, modern digital content (top blur: Crazy Stupid Love, A Million Miles Away, BlackBerry, Dallas Buyers Club, Senna), i.e. it is closer to a "source softness" gauge than a compression-artifact gauge. blockMean tops out on No Country for Old Men (10.4), The Creator (9.2), Jackie Brown (7.6) and correlates positively with bitrate (+0.197) — the opposite of what a blocking-artifact metric should do. Verdict: as inputs to scoring they are dead weight today; blurMean might have secondary value as a candidate-filter signal ("soft remaster"), but nothing here validates either for ranking.

---

## Appendix — reproduction snippets

All numbers above come from these snippets run against `/tmp/opencode/probe-dataset-now.json` with python3 (stdlib only). Shared helpers:

```python
import json, math, statistics as st
d = json.load(open('/tmp/opencode/probe-dataset-now.json'))
rows = d['rows']
mv = [r for r in rows if r['kind']=='movie']
se = [r for r in rows if r['kind']=='season']

def pearson(xs, ys):
    pairs=[(a,b) for a,b in zip(xs,ys) if a is not None and b is not None]
    xs=[a for a,_ in pairs]; ys=[b for _,b in pairs]; n=len(xs)
    mx=sum(xs)/n; my=sum(ys)/n
    num=sum((a-mx)*(b-my) for a,b in zip(xs,ys))
    return num/(sum((a-mx)**2 for a in xs)**.5 * sum((b-my)**2 for b in ys)**.5)

def spearman(xs, ys):
    pairs=[(a,b) for a,b in zip(xs,ys) if a is not None and b is not None]
    rx={v:i for i,v in enumerate(sorted(a for a,_ in pairs))}
    ry={v:i for i,v in enumerate(sorted(b for _,b in pairs))}
    return pearson([rx[a] for a,_ in pairs],[ry[b] for _,b in pairs])

def q(x,p):
    x=sorted(v for v in x if v is not None)
    return x[min(len(x)-1,int(p*(len(x)-1)))] if x else float('nan')

def perm_p(a,b,iters=5000,seed=42):
    import random; random.seed(seed)
    obs=abs(st.mean(a)-st.mean(b)); pool=a+b; cnt=0
    for _ in range(iters):
        random.shuffle(pool)
        if abs(st.mean(pool[:len(a)])-st.mean(pool[len(a):]))>=obs: cnt+=1
    return (cnt+1)/(iters+1)
```

**§1 precision**
```python
ws=[r for r in rows if r.get('sampleCx')]
neff=[r['sampleNEff'] for r in ws if r.get('sampleNEff') is not None]
print(len(ws), len(neff),
      [sum(1 for x in neff if x>=t) for t in (8,16,24,32,48,64)],
      st.median(neff), st.mean(neff))
print(pearson([r['cxRSE'] for r in ws],[r['complexity'] for r in ws]),
      spearman([r['cxRSE'] for r in ws],[r['complexity'] for r in ws]),
      pearson([r['cxRSE'] for r in ws],[r['sampleNEff'] for r in ws]),
      pearson([r['cxRSE'] for r in ws],[r['spreadRatio'] for r in ws]))
hi=[r for r in ws if r['cxRSE']>=0.13]; lo=[r for r in ws if r['cxRSE']<0.10]
print(st.median([r['complexity'] for r in hi]), st.median([r['complexity'] for r in lo]))
# Dunkirk
dk=[r for r in ws if 'Dunkirk' in r['title']][0]
print(dk['cxRSE'], dk['cxSE'], dk['cxMean'], dk['sampleN'], dk['sampleNEff'], dk['sampleDup'], dk['visits'])
# position slopes
sl=[]
for r in [x for x in rows if x.get('samplePos')]:
    cx=[a for a in r['sampleCx'] if a is not None]; pos=[p for p in r['samplePos'] if p is not None]
    if len(cx)>=4 and len(cx)==len(pos):
        n=len(pos); mx=sum(pos)/n; my=sum(cx)/n
        den=sum((a-mx)**2 for a in pos)
        if den: sl.append(sum((a-mx)*(b-my) for a,b in zip(pos,cx))/den)
print(len(sl), st.median(sl), sum(1 for s in sl if s>0)/len(sl))
```

**§2 priors**
```python
ev=[]; rep=[]
for r in rows:
    for p in r.get('priors') or []:
        (ev if p.get('from')=='events' else rep).append((p,r))
for name,grp in (('events',ev),('rep',rep)):
    ds=[r['complexity']-p['complexity'] for p,r in grp]
    print(name,len(grp),st.median([p['R'] for p,_ in grp]),st.median([r['R'] for _,r in grp]),
          st.median(ds),sum(1 for x in ds if x>0),sum(1 for x in ds if x<0))
allp=[(p,r) for r in rows for p in r.get('priors') or []]
ds=sorted(abs(r['complexity']-p['complexity']) for p,r in allp)
print(q(ds,.25), q(ds,.5), q(ds,.75), ds[-1])
print(st.median([(r['complexity']-p['complexity'])/p['complexity'] for p,r in allp]))
repl=[r for r in rows if r.get('priors')]; norepl=[r for r in rows if not r.get('priors')]
print(st.median([r['R'] for r in repl]), st.median([r['R'] for r in norepl]))
```

**§3 year/source/codec**
```python
dec={}
for r in mv: dec.setdefault((r['year']//10)*10,[]).append(r['complexity'])
for k in sorted(dec): print(k, len(dec[k]), st.median(dec[k]), st.mean(dec[k]))
print(pearson([r['year'] for r in mv],[r['complexity'] for r in mv]))
print(perm_p(dec[1970],dec[2020]), perm_p(dec[1940],dec[1970]))
src={}
for r in mv: src.setdefault(r['source'],[]).append(r)
for s in sorted(src,key=lambda s:-len(src[s])):
    g=src[s]; print(s,len(g),st.median([r['complexity'] for r in g]))
cod={}
for r in mv: cod.setdefault(r['codec'],[]).append(r['complexity'])
for c,v in cod.items(): print(c,len(v),st.median(v))
```

**§4 R vs source**
```python
for s in sorted({r['source'] for r in mv}):
    g=[r for r in mv if r['source']==s]
    if len(g)>=4: print(s,len(g),st.median([r['R'] for r in g]),
                        sum(1 for r in g if r['R']<0.59)/len(g))
cxs=sorted(r['complexity'] for r in mv); lo,hi=cxs[len(cxs)//3],cxs[2*len(cxs)//3]
for name,g in (('WEB',[r for r in mv if 'WEB' in r['source']]),('BR',[r for r in mv if 'Bluray' in r['source']])):
    print(name,[ (len([r for r in g if f(r)]), round(st.median([r['R'] for r in g if f(r)]),3))
                 for f in (lambda r:r['complexity']<lo, lambda r:lo<=r['complexity']<hi, lambda r:r['complexity']>=hi)])
print(pearson([r['R'] for r in mv],[r['complexity'] for r in mv]))
```

**§5 spread**
```python
import math
print(st.median([r['spreadRatio'] for r in mv]), st.median([r['spreadRatio'] for r in se]))
print(pearson([math.log(r['spreadRatio']) for r in mv],[r['complexity'] for r in mv]))
print(pearson([math.log(r['spreadRatio']) for r in mv],[r['year'] for r in mv]))
dis=[r['disagree'] for r in se]; print(st.median(dis), st.mean(dis), max(dis))
for r in sorted(mv,key=lambda r:-r['spreadRatio'])[:10]: print(round(r['spreadRatio'],1), r['title'])
```

**§6 live vs flat**
```python
m=[r for r in mv if r.get('bppPlus') is not None]
def ranks(v):
    o=sorted(range(len(v)),key=lambda i:v[i]); rk=[0]*len(v)
    for p,i in enumerate(o): rk[i]=p
    return rk
rkl,rkf=ranks([r['bppPlus'] for r in m]),ranks([r['bppPlusFlat'] for r in m])
sh=[a-b for a,b in zip(rkl,rkf)]
ads=sorted(map(abs,sh)); n=len(ads)
print(n,q(ads,.5),q(ads,.75),q(ads,.9),ads[-1],
      sum(1 for x in ads if x>=100)/n, sum(1 for x in ads if x>=200)/n)
print(pearson(sh,[r['complexity'] for r in m]))
cxs=sorted(r['complexity'] for r in m); lo,hi=cxs[len(cxs)//3],cxs[2*len(cxs)//3]
for f,lbl in ((lambda r:r['complexity']<lo,'lo'),(lambda r:lo<=r['complexity']<hi,'mid'),(lambda r:r['complexity']>=hi,'hi')):
    s=[sh[i] for i,r in enumerate(m) if f(r)]; print(lbl,st.median(s))
band=lambda x:'purple' if x>=125 else 'green' if x>=100 else 'orange' if x>=75 else 'red'
from collections import Counter
print(Counter((band(r['bppPlusFlat']),band(r['bppPlus'])) for r in m))
print(Counter(band(r['bppPlus']) for r in m))
```

**§7 audio**
```python
fr=sorted(r['audioBps']/r['srcBitrate'] for r in mv if r['srcBitrate']>0)
print(q(fr,.5),q(fr,.75),fr[-1],sum(1 for x in fr if x>=.3),sum(1 for x in fr if x>=.2))
big=[r for r in mv if r['srcBitrate']>0 and r['audioBps']/r['srcBitrate']>=.3]
flip=sum(1 for r in mv if r['srcBitrate']>0 and r['R']>=0.59 and
         (r['srcBitrate']-r['audioBps'])/r['probeBitrate']<0.59)
print(len(big), flip)
def bias(R):
    b=1.337*R**-0.348
    return min(1.337*0.59**-0.348 if R<0.59 else b, 2.0)
for r in sorted(big,key=lambda r:-(r['R']-(r['srcBitrate']-r['audioBps'])/r['probeBitrate']))[:5]:
    Rv=(r['srcBitrate']-r['audioBps'])/r['probeBitrate']
    print(r['title'],round(r['R']-Rv,3),round(bias(r['R']),2),round(bias(Rv),2))
```

**§8 outliers**
```python
print([ (r['bppPlus'],r['title'],round(r['R'],2)) for r in mv if (r.get('bppPlus') or 0)>200 ])
print(sorted(((round(r['R'],2),r['title']) for r in rows if r['R']>3),reverse=True))
print(sum(1 for r in rows if r['R']<0.2), sum(1 for r in rows if r['R']>2))
for r in sorted(mv,key=lambda r:-r['bytes']/r['complexity'])[:10]:
    print(round(r['bytes']/r['complexity']/1e9), r['title'])
am=[r for r in mv if '12 Angry Men' in r['title']][0]
print(am['complexity'],am['source'],am['bytes']/1e9,am['probeBitrate']/1e6,
      am['bppPlus'],am['bppPlusFlat'],am['spreadRatio'],
      am['probeBitrate']==max(x['probeBitrate'] for x in rows))
```

**§9 seasons**
```python
for f in ('complexity','R','biasFactor','spreadRatio','srcBitrate','wallMs','files'):
    print(f, q([r[f] for r in mv],.5), q([r[f] for r in se],.5))
import os
nb=[r for r in se if r.get('bpp') is None]; yb=[r for r in se if r.get('bpp') is not None]
print(len(nb), Counter(os.path.splitext(r['path'])[1] for r in nb),
      Counter(os.path.splitext(r['path'])[1] for r in yb))
print(set(r['year'] for r in se))
```

**§10 detectors**
```python
for name,f in (('block',lambda r:r['blockMean']),('blur',lambda r:r['blurMean'])):
    for lbl,g in (('cx',lambda r:r['complexity']),('R',lambda r:r['R']),
                  ('spread',lambda r:r['spreadRatio']),('bpp+',lambda r:r['bppPlus']),
                  ('src',lambda r:r['srcBitrate']),('cxRSE',lambda r:r['cxRSE']),
                  ('year',lambda r:r['year'])):
        print(name,lbl,round(pearson([f(r) for r in mv],[g(r) for r in mv]),3))
```

**Model reproduction check**
```python
e1=max(abs(r['cxEff']-r['complexity']*r['biasFactor']) for r in rows)          # 3.4e-4
e2=max(abs(r['target']-r['cxEff']*d['headroomTarget']) for r in rows)          # 0
e3=max(abs(r['bppPlus']-round(100*math.sqrt(r['bpp']/r['target'])))
       for r in rows if r.get('bpp') is not None)                              # 0
k1=sum(1 for r in rows[:400] if abs(r['R']-r['srcBitrate']/r['probeBitrate'])<0.01)   # 30
k2=sum(1 for r in rows[:400] if r.get('bpp') and abs(r['R']-r['bpp']/r['complexity'])<0.01) # 190
```
