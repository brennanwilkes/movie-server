/* THE PROSE THAT USED TO LIVE IN THE BLEND TAB.
 *
 * The Blend tab was deleted and its data merged into the other four views, but its two essays were
 * the ONLY place in the UI where several measured results are stated — the 3+1 structure, the
 * 96/20000 arbiter pass, why 100 needs no rescale, and the two-blends distinction. Deleting the
 * view must not delete those, so they move here and are attached to whichever panel now owns the
 * corresponding number: WHY to the artifact panels, FLAG to any table selected on |P|.
 *
 * Kept as one module rather than split across the views because they are a single argument, and a
 * reader who finds half of it will draw the wrong conclusion from the half they find.
 */

export const WHY_ARTIFACT = '<b>adj = BPP+ × exp(−strength × provShare × λ × P / 2)</b>, '
  + 'λ = ln(1+35.6%) / 0.2005, and <b>strength is fixed at 100%</b> — it was a slider for as long as '
  + 'it was undecided, and it is now a decision, not a dial.'
  + '<br><br><b>P</b> is one number per file: four artifacts — banding, blocking, blur, grain kept — '
  + 'each compared against what its bitrate and complexity predict, then summed in the direction an '
  + 'extra re-encode physically pushes them (+banding +blocking +blur −grain). <b>P above zero means '
  + 'more damaged than the bitrate explains; below zero means cleaner than it explains.</b> The '
  + 'direction is fixed from physics, not fitted, and the data agrees with it (PC1 sits at cos 0.947 '
  + 'from it).<br><br><b>P is an INDEX, not a measurement of one hidden quantity.</b> The four '
  + 'detectors were factor-analysed with the shared-clip nuisance subtracted: λ₁ = 1.399 where four '
  + 'unrelated things would give 1.000 and one dominant factor would give 2.0+. So the common factor '
  + 'is real (0/2000 under an independence null) but weak — it carries 35% of the variance against a '
  + 'floor of 25%. The structure is <b>3+1</b>: banding, blocking and grain are equicorrelated at '
  + 'r = 0.19, and blur is orthogonal to all of them while carrying a quarter of the weight. Adding '
  + 'up four loosely-related damage signals is a legitimate score; it is just not the estimate of a '
  + 'latent quantity, and two long-standing puzzles follow from it rather than from any defect — P '
  + 'reproducing at only 0.674, and re-weighting being unidentifiable (a near-spherical covariance '
  + 'has no preferred direction to find).<br><br><b>Every constant is measured.</b> One extra '
  + 're-encode costs 35.6% bitrate and moves P by 0.2005 — both from a crossed ladder run on 16 films '
  + 'with both legs on the same clips, replicated from an earlier 8-film run on almost entirely '
  + 'different films. <b>provShare is 0.1089</b>, measured from the bitstream encoder fingerprint '
  + '(p = 0.0025, year-controlled), replacing an earlier estimate of 0.0748.<br><br><b>The ordering '
  + 'is well evidenced.</b> The generation ordering survives within h264 only, so it is not a codec '
  + 'fingerprint; a 720p negative control correctly does not fire; and the direction beats 99.3% of '
  + 'random directions at spanning three controlled provenance axes at once.<br><br><b>The check that '
  + 'used to fail now passes.</b> Random directions reaching our streaming-vs-Bluray gap had gone '
  + 'from 9/20000 to 537/20000 at full coverage. Given a second, independent field contrast — '
  + 'bitstream encoder identity, recovered on 85.7% of the library — the pre-registered direction '
  + 'beats random ones on <i>both</i> contrasts at 96/20000, against a bar of 100 set beforehand. '
  + 'That is a pass by 4%, which is narrow, and it ranks 1st of the 16 sign patterns. See '
  + 'BPP-PLUS.txt §6 and EVIDENCE E.4.3b.<br><br><b>100 is already in the right place, and that is '
  + 'now measured.</b> Converting both external anchors into CRF units (median BPP+ 67 ≈ CRF 25.5, '
  + '−13.6% bitrate per CRF, BPP+ ∝ √bitrate), <b>BPP+ 100 corresponds to CRF 20.0</b> — the top of '
  + 'published x265 visually-lossless practice (18–20). No rescale is implied. The "move the median '
  + 'to 80" idea was backwards: it would redefine 100 as CRF 22.4, a <i>lower</i> bar than '
  + 'transparency, because raising the median number lowers what 100 means. This does not say the '
  + 'library is fine — the median film sits ~5.5 CRF below transparency, and the scale is honestly '
  + 'reporting that gap rather than hiding it.<br><br><b>There are TWO blends and they do not share '
  + 'weights.</b> P is the <i>provenance</i> blend, where all four detectors load. The '
  + '<i>adequacy</i> blend — "does this film need more bits?" — has measured weights of banding '
  + '90.9%, grain 4.9%, blur 0.3%, blocking −4.0%, so it collapses to <b>banding alone</b>: only '
  + 'banding responds to provisioning (t −4.60 with complexity controlled). A detector can carry '
  + 'provenance while carrying no adequacy signal, which is precisely what blur does.<br><br><b>A '
  + 'limit worth knowing:</b> P is centred on this library, so the adjustment is zero-sum and '
  + '<i>cannot move the median</i>. It ranks files against each other, and says nothing about whether '
  + 'the library as a whole is well provisioned. That is a separate question and the absolute '
  + 'artifact thresholds are the tool for it (11.52).';

export const FLAG_ARTIFACT = (prov) => '<b>⚠ Judge this on its ORDERING, not on the size of the '
  + 'numbers.</b><br><br>'
  + '<b>P is reproducible.</b> Measured directly over all 462 disjoint 6/6 clip splits, a '
  + '<b>4-clip P reproduces itself at 0.674</b> (0.756 at 6 clips, 0.861 at 12), agreeing with an '
  + 'earlier corr(P) = 0.693 between two independent reads. An older figure of <i>0.106</i> was '
  + 'quoted as if it were the reliability; it is not — it is the split-half across <i>disjoint '
  + 'detector pairs</i>, which asks whether the four detectors share a common factor, not whether two '
  + 'reads of a file agree. The two were conflated.<br><br>'
  + '<b>What is still open is VALIDITY, not precision.</b> P reproduces well enough to rank films; '
  + 'what is unclear is that the thing it reproduces is provenance rather than a mixture. Nothing '
  + 'here has ever been checked against whether a film actually looks bad to a person.<br><br>'
  + '<b>It is a mixture in a specific, measured way.</b> With the shared-clip nuisance removed, '
  + 'banding, blocking and grain are equicorrelated at r = 0.19 and <i>blur is orthogonal to all '
  + 'three</i> while carrying a quarter of the weight. Sourcing blur from the nightly probe instead '
  + 'was tried and <b>rejected</b> — it fails the pre-registered check at 355/20000.<br><br>'
  + '<b>A correction, because this used to say otherwise.</b> Blocking fires on a median 0% of '
  + 'scenes even at 60 clips, and that was read as a detector contributing almost no signal. That '
  + "inference was wrong: P uses each detector's continuous <i>level</i>, not its threshold-crossing "
  + '<i>fraction</i>, and blocking loads perfectly normally (40% of its variance sits on the common '
  + 'factor, the same as banding and grain). A silent detector can still carry provenance.<br><br>'
  + 'Scene sampling IS a real shared nuisance: all four detectors read the same 2-second clips and '
  + 'the sampling direction points along the signal. It is simply not large enough to make the '
  + 'ordering unusable. And any table <i>selected</i> on |P| is winner\'s-cursed at the extremes — '
  + 'treat the top and bottom few rows as the least trustworthy, not the most.<br><br>'
  + '<b>The last failing pre-registered check now PASSES</b> (96/20000 on a worst-of-two statistic '
  + 'against a bar of 100/20000 set beforehand — by 4%, so narrow). <b>provShare is now MEASURED at '
  + `${(prov && prov.shrink && prov.shrink.floor != null ? prov.shrink.floor : 0.1089).toFixed(4)}</b> `
  + 'from the bitstream encoder fingerprint, p = 0.0025, replacing an estimate of 0.0748 — every '
  + 'adjustment is ×1.46 larger than before. See BPP-PLUS §6 and EVIDENCE E.4.3b / E.4.5 / E.9.5.';

/* THE TWO RELIABILITY NUMBERS, AND WHY THEY DISAGREE. Kept next to the prose that quotes them,
 * because regenerating provenance.json prints 0.377 while every doc quotes 0.674 and the gap looks
 * like a regression until you know it is not.
 *   0.674  how well a 4-clip P reproduces ANOTHER 4-clip read of the SAME FILE. Precision. This is
 *          the number the docs mean by "P reproduces".
 *   0.377  split-half across disjoint DETECTOR pairs — "do the four detectors share a common
 *          factor". provenance.json emits this one, under `reliability`, and its own `shrink`
 *          object files it under `rejected` because it was once wrongly used as the shrinkage.
 * They answer different questions and neither is a check on the other. E.9.7 records 0.377. */
export const RELIABILITY_CLIP = 0.674;
export const RELIABILITY_DETECTOR_SPLIT = 0.377;
