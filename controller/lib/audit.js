'use strict';
// Audit tab backend: the library's "worst offenders", each with a CACHED verdict on whether
// a genuinely better source actually exists. Owns: auditBusy, _rowCache; the persisted
// auditVerdicts Map lives in state.js. Timers: startAuditVerifier() → one indexer search
// every 45s while unverified rows remain, first at 8 min.
//
// WHY VERDICTS ARE CACHED, NOT COMPUTED ON LOAD: "is there something better?" can only be
// answered by a live indexer search. Measured 2026-07-27 those run 5-21s each (avg ~13s),
// and a full enrich is ~114 searches ≈ 25 min sequential. Far too slow for a page load, and
// firing 114 searches at public indexers on every visit would get us rate-limited. So the
// verifier trickles in the background and the tab reads whatever is warm; a single row can
// also be re-checked on demand (one search, spinner-friendly).
//
// WHY ROWS ARE GROUPED BY SEASON: 543 CPU-decode TV files collapse to 49 season rows — an 11x
// cut in both searches and scroll length. A season is also the unit a release actually comes
// in, and per-series totals mislead badly (Peaky Blinders looks like a 114 GiB problem but its
// S01 is already x265 at 1.8 Mbps).
//
// THE THREE SECTIONS ARE NOT THE SAME KIND OF PROBLEM:
//   cpu     - 10-bit/AV1/VP9/DV files. Costs PLAYBACK (software decode on the NUC, no
//             direct-play on the Fire TV Stick 2nd gen). Costs no disk. Needs verification.
//   bitrate - files whose picture quality exceeds what the title's profile asks for, judged on
//             the shared bpp band (arr-inspect.js). Costs DISK. Plays fine. Needs verification.
//             Beloved excluded: a large file in that tier is the profile working as intended.
//   stale   - torrents no longer hardlinked into the library. Pure waste, ALWAYS actionable,
//             needs no verification at all (see show-stale-torrents.sh for the safety model).

const metrics = require('../metrics');
const jobs = require('./jobs');
const app = require('./app');
const { cfg, HOST } = require('./config');
const { tfetch, tfetchJson, arrGet, arrDelete, arrOf, qbit } = require('./clients');
// Read-only: used solely to learn the Top 100 playlist's ORDER for the Upgrade tab's ranking.
const { jellyfinUserId } = require('./jellyfin');
const { getQbitTorrents } = require('./arr-data');
const { gpuTier, videoLabel, bppOf, bppBand, bppIndex, bppBasis, bppRSE, bppArtifact, bppRatioR, bppDisagree, BPP_RANK, X265_EFFICIENCY } = require('./arr-inspect');
const { importViaManual, previewManualImport, probeDurationSecs } = require('./importer');
const {
  auditVerdicts, auditPending, auditSwapped, auditDead, auditHistory, recordAuditOutcome, gpuPending, persistState, persistVerdicts, isMasterPaused, swapForHash,
} = require('./state');
// Shared release-title heuristics — see ./release-rules for the case history behind each rule.
// NOTE: TENBIT_RE is deliberately NOT imported; audit.js has its own stricter variant below.
const {
  srcRank, REENC_RE, audioOf, AUDIO_RANK, isRefused, isMultiSeason,
  ownEditionOf, editionRefusal, editionOf, editionFloorFor, editionUpgradeFor, imaxUpgradeFor, resOf, overResCeiling, MAX_USABLE_RES,
  nonSizeCfScore, cfRefusalIsExcusable, runtimeVerdict, runtimeShortDetail,
  editionNotWorse, EDITION_UNSTATED, cfDeficits, cfFormatsFromRejection,
} = require('./release-rules');

// row.key -> { formats, scoreByName } for the file(s) that row represents. Rebuilt by every
// buildRows pass and read only by cfBlockedFor; see the note there for what it is for. Kept beside
// the rows rather than ON them because seven push sites construct rows and none of them should have
// to know about custom formats.
const _cfRowInfo = new Map();

// Bump when the candidate FILTER changes: verdicts computed under older rules are wrong,
// not merely old, so they must be discarded rather than aged out. v2 added the wrong-show
// guard (mappedSeasonNumber / mappedMovieId).
// v8 (2026-07-28, deliberate bump): widened collection — MAX_CANDIDATES 6->12, Playback accepts
// SOURCE upgrades even at the same tier and even when larger (cap 1.6x -> 3x, 5x for a source
// upgrade), and the Disk section's content-aware floor warns via `belowFloor` instead of
// rejecting, leaving only AGGRESSIVE_FLOOR=0.15 as a junk filter.
// v9 (2026-07-30): EDITION is now a hard refusal (editionRefusal). This bump is mandatory, not
// cosmetic — verdicts cached under v8 were computed WITHOUT the edition gate, so they can still be
// holding a theatrical candidate for a film whose extended cut is the only acceptable one. Serving
// those from cache would offer exactly the swap this change exists to prevent. Cost is a re-verify
// of the library at VERIFY_EVERY_MS, which the paced verifier does on its own.
// v14 (2026-08-01, MANDATORY): the candidate filter now applies candidateBandOk(), an ABSOLUTE
// bpp floor, in place of the relative minRatioFor() test. Verdicts cached under v13 were computed
// without it, so they can still be holding a candidate that is compromised in absolute terms —
// exactly the swap this change exists to prevent. The Disk section's membership rule also changed
// from ">= 6 Mbps x264" to a bpp band, so cached rows can be for titles the section would no
// longer list at all. Cost is a paced re-verify at VERIFY_EVERY_MS, which the verifier does itself.
// v16 (2026-08-01): candBppFrom() now divides by the square of the frame-height ratio. Cached
// candidate bpp values from v15 IGNORE resolution, so every 720p -> 1080p upgrade is stored
// several times too high (Meet the Parents: 380 bpp+ cached vs 169 actual). Those are wrong, not
// stale — they would paint a reasonable upgrade as "beyond what the display can resolve".
// v15 (2026-08-01): the stored candidate shape changed — candidates now carry `bppPlus` and the
// gain/loss pills are worded in BPP+ instead of Mbps. v14 verdicts are not WRONG, but they render
// a stale "+2.7 Mbps" pill and a missing before->after figure, and both are baked into the cached
// object rather than derived at render time. Cheap to redo here because the v13->v14 re-verify was
// still in flight; letting them age out over 14 days would leave two units on screen at once.
// v18 (2026-08-06, MANDATORY): THE PROBE CUTOVER. BPP+ is now divided by the film's own measured
// complexity instead of the flat BPP_TARGET=0.13, so a v17 verdict's candidate bppPlus, bppBand and
// bandWeak were all computed against a denominator that can be off by ~2x in either direction (the
// first 69 measurements span 0.0436-0.3511, an 8.1x range). Those cached values are WRONG, not
// merely stale, and bandWeak decides which candidates may lead the sheet — so serving them would
// rank on exactly the bias this change removes. Re-verification is also not a one-off here: as the
// probe measures more films their denominators change from estimated to measured, which is why
// verdicts carry `cxBasis` and the paced verifier's normal TTL churn is the intended mechanism.
const VERDICT_VERSION = 18;  // v17: BPP+ is now square-rooted and HEVC is x1.6 (was x1.8), so both
                             // the band a candidate lands in and the bandWeak ranking penalty can
                             // differ from a v16 verdict. See bppIndex() in arr-inspect.js.
                             // v10: NUC ok->no (10-bit) is now a hard refusal, and EDITION_BEST
                             // adds above-floor edition rows. Both change which candidates are
                             // ADMITTED, so cached v9 verdicts were computed under looser rules.
                             // v11: loose (edition/upgrade) rows no longer require a codec token
                             // in the title — the parsed quality source substitutes for it, so a
                             // 59-char-truncated "...EXTENDED.1080p.BluRay." is no longer dropped
                             // (Fellowship of the Ring read "none better" while 51/137 releases
                             // were extended/final-cut). Changes ADMITTANCE, so cached v10
                             // verdicts are invalid.
                              // v12: EDITION_ORIGINAL_BEST — for a film whose original cut is the
                              // definitive one (The Blues Brothers), the downgrade-refusal is
                              // bypassed so theatrical candidates are admitted again. Changes
                              // ADMITTANCE for those films, so cached v11 verdicts are invalid.
                              // v13: WRONG-SHOW imdbId fallback — a release Radarr could not map
                              // (mappedMovieId null, "Unable to parse release") is admitted when
                              // its indexer-tagged imdbId matches the movie's (the best theatrical
                              // Blues Brothers encodes were hidden this way). Collections/sequels
                              // carry 0 or a different id and still drop. Changes ADMITTANCE, so
                              // cached v12 verdicts are invalid.
const VERDICT_TTL_MS = 14 * 24 * 3600 * 1000;  // release availability drifts; a stale "nothing better" is worse than no verdict
const VERIFY_EVERY_MS = 45000;                 // paced: 114 searches at 45s ≈ 85 min to go fully warm, gentle on public indexers
// DISK-SECTION THRESHOLD. Was BLOAT_MIN_MBPS = 6 (raw Mbps) until 2026-08-01. Raw Mbps is
// resolution-, framerate- and codec-blind: a 1920x800 scope film and a flat 1920x1080 one at the
// same Mbps are not the same quality, and 6 Mbps of HEVC is worth ~10.8 of H.264. The section now
// selects on the shared bpp band instead, which normalises all three — see arr-inspect.js.
//
// THE THRESHOLD DEPENDS ON WHAT THE TITLE IS FOR, and getting this wrong is not a cosmetic bug.
// A first cut used a flat 'ok' (green) for everything, and testing it against the live library
// showed it would have offered to SHRINK Lawrence of Arabia, Blade Runner, Fight Club and six
// other Top 100 films — the exact titles the audit exists to protect. Two separate mistakes:
//
//   1. GREEN IS THE TARGET, NOT BLOAT. bpp 0.13 is "looks its best on current hardware". Flagging
//      it as too big would ratchet the whole library down to orange. Only PURPLE (>=0.20) is
//      arguably more than this projector can show, so purple is the bar for a default title.
//   2. TOP 100 IS DECLARED INTENT, exactly like the Beloved profile. Those films are on `Normal`
//      today only because the profile migration has not happened yet; a purple copy of Lawrence
//      of Arabia is the goal, not waste.
//
// So:
//   Beloved profile   -> never listed. That tier exists to spare no expense.
//   Top 100           -> never listed, for the same reason. Intent is intent.
//   Low (save space)  -> listed at GREEN or better. The profile says "red is fine, that is the
//                        point", so anything comfortably above that is disk spent against a
//                        recorded instruction.
//   Normal (default)  -> listed at PURPLE only. Beyond what the hardware can resolve.
const BLOAT_BAND_BY_PROFILE = (profile) => (String(profile || '').startsWith('Low') ? 'ok' : 'wow');

// ---- OVER-SUPPLY: HOW MUCH DISK IS BUYING NOTHING ────────────────────────────────────────────
// The band above answers "is this file in a tier richer than this title needs". It cannot answer
// "and how much disk would that actually give back", and those come apart badly at both ends:
// Parasite is 13.3 GB at band `wow` with 8.5 GB of slack, while a 2 GB `wow` file has none worth
// the click. Measured 2026-08-18 across 885 films / 3191 GB, only 33 films hold meaningful slack.
//
// R = srcBitrate / probeBitrate, already measured per unit by the CRF probe.
//
// WHAT "TRANSPARENT" DOES AND DOES NOT MEAN — Brennan raised this and it governs the wording:
// probeBitrate is a CRF-20 encode OF OUR COPY, so the baseline is "indistinguishable from the file
// we already have", NEVER "indistinguishable from the negative". Our copy's own compression — and
// any damage baked into the master it came from — sits INSIDE that baseline. So R > 2 means "this
// file spends more than twice the bits reproducing ITS OWN CONTENT would take". It is a statement
// about disk, and it is NOT a claim that the picture is good or that a smaller copy would match it.
// The blind test (2026-08-13) is the proof: BPP+ is essentially R (r=0.944) and R scored rho=0.146
// against what Brennan's eye actually sees. Row copy must not imply "same quality, smaller".
//
// THE BIAS RUNS TOWARD PROTECTING FILES, which is the safe direction. A file with boiling or
// blocking baked in makes the probe spend bits reproducing that damage, which inflates
// probeBitrate and DEFLATES R — so a damaged file looks MORE justified and is less likely to be
// listed. Likewise grainy films can barely ever appear: measured R is 0.19 for Killer of Sheep,
// 0.74 for 12 Angry Men, 0.76 for Taxi Driver, against 5.58 for Parasite. The classics that top the
// raw GB list are structurally excluded, which is the entire point.
//
// 2x, not 1.5x. 1.5 raises the yield from ~80 GB to ~180 GB but starts on files whose margin is
// thinner than a measurement alone should decide. At 2x every listed file still carries double what
// reproducing it needs, so no suggestion here can plausibly be the reason something looks worse.
// Has any release we have already seen for this unit called itself IMAX? Reads the verdict cache the
// verifier fills anyway, so it costs nothing and grows on its own as the library is re-checked.
// Sections are tried in turn because a film is verified under whichever section listed it.
const IMAX_CAND_RE = /\bimax\b/i;
function imaxCandidateSeen(key) {
  for (const sec of ['edition', 'upgrade', 'bitrate', 'cpu']) {
    const v = auditVerdicts.get(`${sec}:${key}`);
    if (!v || !Array.isArray(v.candidates)) continue;
    if (v.candidates.some((c) => IMAX_CAND_RE.test(String(c && c.title || '')))) return true;
  }
  return false;
}
// Scope framing, i.e. NOT already expanded. Mirrors IMAX_AR_MAX in release-rules.js — a held file
// below 2.0 already carries the wider picture whatever its name says (the Nolan discs are 1.78).
function arIsScope(resolution) {
  const m = /^(\d+)\s*x\s*(\d+)$/.exec(String(resolution || '').trim());
  return !!(m && +m[2] > 0 && (+m[1] / +m[2]) >= 2.0);
}
const OVERSUPPLY_R = 2;
const OVERSUPPLY_MIN_GB = 2;    // below this the row is not worth a human's attention
// Bytes that could come back if the file were brought down to OVERSUPPLY_R x transparent. Null when
// the unit was never probed (no R) or is not over-supplied — callers treat null as "no claim".
// A SEASON'S R IS EXTRAPOLATED FROM TWO EPISODES, and that is not always safe to spend disk on.
// The probe measures EPISODES_PER_SEASON = 2 interior episodes and averages them; `disagree` is how
// far apart those two came out. Measured 2026-08-18, the seasons this section ranked HIGHEST were
// exactly the ones with the least trustworthy number: House of Cards S01 disagree 0.789 on a 52 GB
// pack, Peaky Blinders S05 0.817, Lessons in Chemistry S01 0.572. Claiming "26 GB recoverable" from
// two episodes that disagreed by 79% is a bigger leap than a movie's single measured file, and it is
// the rows a human is most likely to act on first.
//
// So a season must be HOMOGENEOUS to carry an over-supply claim. 0.25 is probe.js's own
// SEASON_DISAGREE, the point at which it already logs "season is not homogeneous, its complexity is
// low-confidence" — reused rather than invented so both halves mean the same thing. Such a season is
// not hidden: it still lists on the band rule as before, just without a recoverable figure it cannot
// support. Movies report null disagree and are unaffected.
const SEASON_DISAGREE_MAX = 0.25;
function overSupplyBytes(bytes, key) {
  const R = Number(bppRatioR(key)) || 0;
  const dis = bppDisagree(key);
  if (dis != null && dis > SEASON_DISAGREE_MAX) return null;
  if (!(R > OVERSUPPLY_R) || !(bytes > 0)) return null;
  const over = bytes * (1 - OVERSUPPLY_R / R);
  return over >= OVERSUPPLY_MIN_GB * 1e9 ? Math.round(over) : null;
}
// How long a swap's torrent may be absent from qBittorrent before the swap is abandoned. MODULE
// level because BOTH replaceSweep (which does the abandoning) and the swap-health reported to the
// UI must use the same number: reporting "torrent gone / abandoning" on a swap seconds old was
// wrong and alarming — *arr takes a moment to hand the grab to qBittorrent, so a brand-new swap
// legitimately has no torrent yet. Below this age, absence means "starting", not "gone".
const VANISHED_AFTER_MS = 15 * 60000;
// How long a swap may sit with NO download hash before it is written off. Longer than
// VANISHED_AFTER_MS because the hash arrives from *arr's queue rather than from qBittorrent, and
// *arr can take a while to hand a grab over on a busy box — but bounded, because once its queue is
// empty there is nothing left that could ever supply one. See the !p.hash branch in the sweep.
const HASHLESS_GIVEUP_MS = 60 * 60000;
// Caches must be refreshed BEFORE they expire, not on the request that finds them cold.
// A cold /api/audit pays for ~96 Sonarr episodefile calls, a full inode walk of /data, and
// two *arr history fetches — tens of seconds, which is what Brennan hit. The warmer below
// runs on a shorter interval than the TTL so a page load essentially always finds them warm.
// Aggressive presentation: show the trade, flag it, let the human decide. AGGRESSIVE_FLOOR is
// only a junk filter (a 12% "1080p" release is a different product, not a trade); the
// content-aware minRatioFor() value is now a WARNING, not a rejection.
const AGGRESSIVE_FLOOR = 0.15;
// 2026-07-30: 12 -> 24 at Brennan's request. The point of the sheet is CHOICE — a truncated list
// hides genuinely better releases behind an arbitrary line, and the new Upgrade tab exists precisely
// to browse options rather than accept a top pick. Deliberately NOT paired with a VERDICT_VERSION
// bump: verdicts already cached still hold their old top-12, and invalidating ~192 of them would
// spend ~2.5h of paced indexer searching, which is a decision for the Re-check everything button
// (see /api/audit/rescan), not a side effect of raising a constant. Cached rows widen to 24 as their
// 14-day TTL rolls over, or immediately for any title re-checked by hand.
const MAX_CANDIDATES = 24;
const ROW_CACHE_MS = 12 * 60 * 1000;
const WARM_EVERY_MS = 9 * 60 * 1000;

let auditBusy = false;
let _rowCache = { ts: 0, rows: null };
// The single in-flight rebuild, or null. See startRowBuild.
let _rowBuild = null;
// Run `fn` over `items` with at most `limit` in flight. Order of completion is not preserved and the
// caller collects results itself — every use here is a side-effecting push, so that is all it needs.
async function pooledForEach(items, limit, fn) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let it = queue.shift(); it !== undefined; it = queue.shift()) await fn(it);
  });
  await Promise.all(workers);
}

function secs(rt) {
  if (!rt) return 0;
  const p = String(rt).split(':').map(Number);
  while (p.length < 3) p.unshift(0);
  return p[0] * 3600 + p[1] * 60 + p[2];
}
const gb = (b) => +(b / 1073741824).toFixed(2);

// ---- release-group -> MEASURED bit depth, learned from our own imports ────────────────────
// Titles cannot be trusted for bit depth: modern x265 is 10-bit by default without saying so,
// and the indexers truncate titles at 59 chars (observed "...x265 HEVC 10bi", marker cut off
// mid-word). But we have ffprobe ground truth for every file already imported, so a group's
// track record IS knowable. Measured here: RARBG 208/208 10-bit; SiGMA 27/27 8-bit.
function buildDepthMap(movieFiles, epFiles) {
  const tally = new Map();
  const note = (grp, mi) => {
    if (!grp || !mi) return;
    if (!['x265', 'h265', 'hevc'].includes(String(mi.videoCodec || '').toLowerCase())) return;
    const d = mi.videoBitDepth;
    if (!d) return;
    const k = grp.toLowerCase();
    const e = tally.get(k) || { 8: 0, 10: 0 };
    e[d >= 10 ? 10 : 8]++;
    tally.set(k, e);
  };
  for (const f of movieFiles) note(f.releaseGroup, f.mediaInfo);
  for (const f of epFiles) note(f.releaseGroup, f.mediaInfo);
  const verdict = new Map();
  for (const [g, v] of tally) verdict.set(g, v[10] === 0 ? '8bit' : (v[8] === 0 ? '10bit' : 'mixed'));
  return verdict;
}
const TENBIT_RE = /10.?b(?:it)?\b|10.?bi?$|hi10/i;
// Resolve PESSIMISTICALLY when a title names two groups (e.g. "...AAC 5.1 Joy)[UTR]" — encoded
// by one, repacked by the other): a single 10-bit match condemns the release. Guessing wrong
// toward 8-bit puts another CPU-transcoding file in the library; guessing wrong toward 10-bit
// only costs us a candidate.
function depthOf(title, depthMap) {
  if (TENBIT_RE.test(title)) return '10bit';
  const low = title.toLowerCase();
  const hits = [];
  for (const g of depthMap.keys()) {
    if (new RegExp(`(?<![a-z0-9])${g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(low)) hits.push(depthMap.get(g));
  }
  if (hits.includes('10bit')) return '10bit';
  if (hits.includes('mixed')) return 'mixed';
  if (hits.includes('8bit')) return '8bit';
  if (/\b8.?bit\b/i.test(title)) return '8bit';
  return null;   // unknown — never treated as safe
}

// ---- wrong-show guard ──────────────────────────────────────────────────────────────────
// mappedSeasonNumber is NOT series identity — it only says "this parses as season N". Sonarr
// returns House of the Dragon and House of Cards releases for a "House" search with
// mappedSeasonNumber=1 on all of them. The release's own parsed `seriesTitle` IS reliable, so
// disambiguate it against the WHOLE library and require this row's series to win.
const normTitle = (t) => String(t || '').toLowerCase()
  .replace(/\(\d{4}\)|\b(us|uk)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
// Longest bidirectional prefix match. Both directions are needed: "Cosmos" must claim
// "Cosmos:A Space-Time Odyssey" (library title shorter), while "House of Cards (US)" must
// claim a bare "House of Cards" (library title longer) so plain "House" cannot take it.
// Returns the winning series id, or null when nothing matches OR the match is AMBIGUOUS.
// Ambiguity is a real case, not a corner: the library holds both "Cosmos (2014)" and the 1980
// "Cosmos", which normalise identically. A release named "Cosmos: A Spacetime Odyssey" is the
// 2014 show, but nothing in the release title says so in a form we can tie to one library
// entry (tvdbId comes back 0 from these indexers). Guessing picked the 1980 series and offered
// 2014 season packs as replacements for it. When two entries tie, suggest NOTHING — a missed
// opportunity is cheap, a wrong swap is not.
function bestSeriesMatch(relTitle, seriesNorm) {
  const r = normTitle(relTitle);
  if (!r) return null;
  let best = null, tied = false;
  for (const [id, n] of seriesNorm) {
    if (!n) continue;
    if (r === n || r.startsWith(n + ' ') || n.startsWith(r + ' ')) {
      if (!best || n.length > best.len) { best = { id, len: n.length }; tied = false; }
      else if (n.length === best.len) tied = true;
    }
  }
  return best && !tied ? best.id : null;
}

// ---- playback tiers: never suggest something that plays WORSE than what we have ─────────
// 1 = H.264 (not 10-bit): direct-plays on every device here, PS4 included.
// 2 = HEVC proven 8-bit: Fire Stick direct-plays, NUC hardware-decodes; the PS4 needs a
//     transcode, but a cheap QSV one.
// 3 = HEVC of unproven depth: may be 10-bit, which software-decodes on the NUC.
// ps4ify-sweep only fixes AUDIO — it explicitly skips non-h264 video ("needs a re-grab, not
// a remux") — so a codec change is a permanent playback change, not something import fixes.
function playTierOf(codec, depth) {
  if (codec === 'H.264') return 1;
  return depth === '8bit' ? 2 : 3;
}
function currentTier(mi) {
  const c = String((mi || {}).videoCodec || '').toLowerCase();
  const d = (mi || {}).videoBitDepth || 8;
  if (['x264', 'h264', 'avc'].includes(c)) return d >= 10 ? 3 : 1;
  return d >= 10 ? 3 : 2;
}
const TIER_NOTE = { 1: 'plays everywhere', 2: 'Fire Stick OK · PS4 transcodes', 3: 'depth unverified' };
// Per-device support, so the UI can say WHICH client suffers rather than one vague label.
// ok = direct play · tx = server transcodes it (works, costs CPU) · no = not decodable.
//   Fire  - Fire TV Stick 2nd gen (AFTT): HEVC decoder present, capped 1920x1088, no Main10.
//           MEASURED 2026-08-01 against the live device — HEVC 8-bit, 19.7 Mbps H.264, DTS-only
//           and TrueHD-only all direct-play; Main10 is the only transcode trigger in the library.
//   PS4   - media player is H.264 only; any HEVC means a transcode (cheap via QSV for 8-bit).
//   iOS   - iPhone/iPad and Jellyfin/Streamyfin on them decode HEVC incl. Main10 natively.
//   Web   - desktop browsers: H.264 universal; HEVC only in Safari, so assume a transcode.
// EFFECTIVE quality vs the file we already have. Bitrate alone lies across codecs — x265
// needs roughly 55% of x264's bits for the same picture — so an HEVC candidate's rate is
// scaled by 1.8 before comparison. Without this the ranking rewarded whichever release threw
// away the most detail: for Yellowstone S01 (10.1 Mbps x264) a 2.6 Mbps x264 "saved" the most
// GB precisely because it is a quarter of the quality, and it outranked a 5.5 Mbps HEVC that
// is visually equivalent to the original.
// X265_EFFICIENCY now lives in arr-inspect.js beside bppOf(), which needs the same constant to
// normalise HEVC. It was defined in both files for a few minutes on 2026-08-01 and that is exactly
// the drift these shared-classifier comments exist to prevent — one definition, imported.
// BANDS ARE DELIBERATELY WIDE. This is a bitrate ratio, not a measured quality metric —
// real perceptual quality also depends on encoder settings, source and grain, and bitrate
// has diminishing returns, so 54% of a lavish 11.6 Mbps is not comparable to 54% of a lean
// 4 Mbps. An earlier cut put a boundary at 0.60, which made 61% and 54% render in different
// colours: seven points apart, but reading as a categorical difference that does not exist.
// The boundaries now sit well clear of where candidates actually cluster, so only a genuinely
// large drop changes colour. The label says "bitrate", not "quality", for the same reason.
function qualityBand(curMbps, candMbps, curIsHevc, candIsHevc) {
  if (!curMbps || !candMbps) return { band: 'unknown', ratio: null };
  const eff = candMbps * (candIsHevc && !curIsHevc ? X265_EFFICIENCY : 1);
  const ratio = eff / curMbps;
  const band = ratio >= 0.85 ? 'matched'
    : ratio >= 0.5 ? 'comparable'
      : ratio >= 0.3 ? 'reduced' : 'heavily cut';
  return { band, ratio: +ratio.toFixed(2) };
}
const BAND_RANK = { matched: 0, comparable: 1, unknown: 2, reduced: 3, 'heavily cut': 4 };

// How far below the current bitrate a candidate may sit, BY CONTENT. A flat floor treats a
// talky sitcom and a grain-heavy nature documentary as the same problem, and they are not:
// grain and fast motion collapse at bitrates a static drama survives untouched. This is the
// same reasoning behind exempting Planet Earth / Blue Planet by hand — encoded as a rule so
// it applies to everything, not just the titles someone remembered.
//   Documentary  - nature/science footage is detail-maximal and the worst case for a re-encode.
//   Pre-1990     - shot on film, so grain is signal rather than noise; it eats bitrate.
function minRatioFor(genres, year) {
  const g = (genres || []).map((x) => String(x).toLowerCase());
  if (g.includes('documentary')) return 0.80;   // near-parity or nothing
  if (year && year < 1990) return 0.70;         // film grain
  return 0.30;                                  // the general floor
}
// ---- CANDIDATE QUALITY FLOOR, in absolute bands ─────────────────────────────────────────────
// A RANKING PENALTY, NOT A REFUSAL. Brennan, 2026-08-01: "We should be providing more options,
// more suggestions, not less, and just allowing the user to choose... That said the human decision
// should be easy, as all the information they need should be abundantly clear, colour coded, and
// not misleading, and suggestions should never be absolute crap (IE dubbed copies, wrong edition)."
//
// So the line is drawn by KIND, not by degree. Dubs, camrips, wrong cuts and foreign-only audio
// stay hard refusals (release-rules.js) because no amount of colour-coding makes them a real
// choice. A merely LOW-QUALITY candidate is a legitimate trade — smaller file, worse picture —
// and the human can see exactly that in the coloured bpp badge. Refusing it would be deciding for
// them. An earlier cut of this function returned false and dropped those candidates entirely;
// that was the wrong instinct.
//
// What it still does is push them DOWN the list, so the top of the sheet is the good trade and the
// compromised ones are visible but last.
//
//   Beloved / Top 100  -> anything below GREEN is penalised. These titles are supposed to look
//                         their best, so a merely-adequate replacement should not lead the list.
//   everything else    -> penalised more than ONE band below what is on disk, or below ORANGE.
//
// This also supersedes minRatioFor() as a quality judgement (kept above only because cached
// verdicts still carry `minRatio` mid-TTL). minRatioFor was RELATIVE to the file you already have,
// so 80% of an already-red file passed: Jackie Brown at 0.064 bpp would accept 0.052. It also
// guessed from genre/year, which is a human call, and the one time that guess was tested it
// pointed the wrong way (a CRF-12 reference of Lawrence of Arabia landed at 10.6 Mbps, White
// Chicks at 24.5).
//
// `key` is the ROW's unit key, not the candidate's — a candidate for this film IS this film, so the
// measured complexity of the copy on disk is the correct denominator for every release of it. This is
// the whole point of keying the probe cache by film (Brennan, 2026-08-05: "we need to weight the
// replacements' bpp+ by the probe result of the file on disk too"), and it fixes a bias that ran the
// wrong way under the flat constant: a grainy film's candidates all read purple because their bits go
// to grain, while a clean film's all read red. Both sides of the comparison now share one denominator,
// so the band difference between them is real rather than an artefact of the film's content.
function candidateBandOk(candBpp, curBpp, priority, key) {
  const cand = bppBand(candBpp, key);
  if (!cand) return true;                       // unknown is never penalised on a guess
  const c = BPP_RANK[cand];
  if (priority) return c <= BPP_RANK.ok;
  if (c > BPP_RANK.warn) return false;
  const cur = bppBand(curBpp, key);
  return !cur || c <= BPP_RANK[cur] + 1;
}
// Is this title one we refuse to compromise on? Same rule at verify time and at serve time, so a
// re-scored candidate is judged exactly as the verifier judged it.
function candPriority(row) {
  return !!(row.beloved || row.top100 || String(row.profile || '').startsWith('Beloved'));
}

// RE-SCORE A CACHED CANDIDATE AGAINST TODAY'S COMPLEXITY TARGET.
//
// A candidate's raw `bpp` is a property of the release (bytes / pixels / frames) and never changes.
// Its bppPlus does, because the DENOMINATOR moves: the CRF probe measures films continuously, so a
// verdict cached before its film was probed carries figures computed against an ESTIMATED target.
// Verdicts live 14 days, so without this they stay wrong for up to a fortnight.
//
// THIS IS NOT COSMETIC, which is why it is worth the recompute on every serve. The ROW is rebuilt
// from scratch on every load and therefore scores against the MEASURED target, while its cached
// candidates kept the estimated one — so the replace sheet was comparing two numbers computed on
// different scales. Measured live on The Big Lebowski (probed 2.5h AFTER its verdict was cached):
// the row read 145 while its candidate read a frozen 136, when the candidate was really 168. The
// sheet said "this replacement is slightly worse" about a file that is materially better.
//
// bandWeak is recomputed too: it comes from candidateBandOk(), which reads the same moving target
// and decides whether a candidate is allowed to lead the sheet.
//
// Done on the way OUT, deliberately — same reasoning as rankCands above. The fix reaches every
// verdict already on disk instead of needing a VERDICT_VERSION bump and hours of re-verification.
// ── "*arr will refuse this" — and whether WE override it ───────────────────────────────────────
// The naive test is `candidate.cfScore <= file.cfScore`, which is exactly *arr's own arithmetic and
// was what this used. It is also WRONG for the case Brennan hits most, and it greys out the button
// so he cannot even try:
//
//   Scarface (1983), 2026-08-11. On disk: [H.264 (GPU), Original-language audio, Size 1.5-3 GB] =
//   360. The release he picked: [H.264 (GPU), Original-language audio, Size 6-10 GB] = 260. Same
//   codec, same language, same cut, three times the bitrate — and 100 points "worse", ALL of it the
//   size band, which is deliberately negative at the top end to steer AUTOMATIC grabs toward
//   midrange files. Star Wars: The Rise of Skywalker was the same shape (260 vs 280).
//
// The import path has excused exactly this since 2026-07-30 (cfRefusalIsExcusable, built for this
// sentence: "for upgrades and replacements I've chosen a source, I don't want it rejected for file
// size"). So the preflight, the button and the import must all ask the SAME question, or the tab
// refuses downloads that would have imported perfectly. They disagreed; this is what fixes it.
//
// Falls back to the raw score comparison whenever the format NAMES are unavailable (a cached verdict
// from before this existed, a chunk of /moviefile that failed, a profile we could not read). That
// fallback is the old behaviour — stricter, never looser.
function cfBlockedFor(row, candScore, candFormats) {
  if (typeof row.cfScore !== 'number' || typeof candScore !== 'number') return false;
  if (candScore > row.cfScore) return false;                       // *arr accepts it outright
  const cf = _cfRowInfo.get(row.key);
  if (!cf || !cf.scoreByName || !candFormats) return true;         // no names → old, stricter answer
  return !cfRefusalIsExcusable(cf.formats, candFormats, cf.scoreByName);
}

function rescoreCand(c, row, priority) {
  if (!c || c.bpp == null) return c;
  return {
    ...c,
    bppPlus: bppIndex(c.bpp, row.key), bppRSE: bppRSE(row.key), bppArt: bppArtifact(row.key),
    bppBand: bppBand(c.bpp, row.key),
    cxBasis: bppBasis(row.key),
    bandWeak: !candidateBandOk(c.bpp, row.bpp, priority, row.key),
    // RE-DERIVED AT SERVE TIME, not trusted from the cached verdict. Verdicts live for hours and
    // predate this check entirely, and the row's own score moves every time a file is swapped —
    // so recompute against the CURRENT file rather than pinning whatever was true at verify time.
    cfBlocked: cfBlockedFor(row, c.cfScore, c.cfFormats),
    cfNeed: typeof row.cfScore === 'number' ? row.cfScore : null,
  };
}

// bpp for a row, from the representative mediaInfo plus the row's own bytes/seconds. The
// size-derived total is the fallback because mediaInfo.videoBitrate is 0 on ~18% of movies
// (154 of 859, measured 2026-08-01) — see bppOf() in arr-inspect.js.
// `key` is the probe unit key and is OPTIONAL, exactly as it is for bppIndex(): with it, audio can be
// subtracted from a MEASUREMENT rather than from *arr's single-track claim. Without it the result is
// bit-identical to the previous behaviour, so a call site that cannot name its title degrades rather
// than breaks.
function bppFor(mi, bytes, sec, key) {
  return bppOf(mi, sec > 0 ? (bytes * 8) / sec : null, key);
}
// A candidate's bpp is ESTIMATED, not measured: we have its byte size and title but never probe
// it. Same film and same runtime, so bits scale with bytes — then x1.8 if the candidate switches
// to HEVC, exactly as qualityBand does.
//
// RESOLUTION MUST BE FACTORED IN SEPARATELY, and forgetting it was a real bug (caught 2026-08-01
// on Meet the Parents). bpp is bits per PIXEL, so a candidate that is both bigger AND a higher
// resolution is spreading those extra bits over more pixels. The 720p copy on disk (1280x688,
// 0.034 bpp = 26 bpp+) against a 1080p WEB-DL 14.6x its size estimated to 380 bpp+ — deep purple,
// implying "more than the display can resolve" — when the honest figure is ~167. Left uncorrected
// this systematically overstates every 720p -> 1080p upgrade, which is exactly the upgrade the
// library most often wants.
//
// Frame height is taken from the *arr quality name ("Bluray-720p") and the release title, which
// is all we have for a candidate we have not downloaded. Aspect ratio is preserved across a
// re-encode of the same film, so pixel count scales with the SQUARE of the height ratio. When
// either side is unstated the scale is left at 1 — an unknown is never a guess.
function candBppFrom(rowBpp, rowBytes, candBytes, curIsHevc, candIsHevc, curRes, candRes) {
  if (!rowBpp || !rowBytes || !candBytes) return null;
  const codecScale = (candIsHevc && !curIsHevc) ? X265_EFFICIENCY : 1;
  const resScale = (curRes && candRes && curRes !== candRes) ? (curRes / candRes) ** 2 : 1;
  return +((rowBpp * (candBytes / rowBytes)) * codecScale * resScale).toFixed(5);
}

// The NUC's own decode status for a playback tier, and the ONE place that mapping lives so the
// refusal below cannot drift from the red pill the UI draws (devicesFor() in web/js/audit.js uses
// the same rule: 10-bit → 'no'). Tier 3 is "10-bit or depth unverified", which the Iris 540 cannot
// hardware-decode; everything else it can.
//   ok = hardware decode · no = software decode, the whole box suffers
const devNuc = (tier) => (tier >= 3 ? 'no' : 'ok');

function deviceSupport(codec, depth) {
  const h265 = codec !== 'H.264';
  const tenbit = h265 && depth !== '8bit';
  return {
    Fire: !h265 ? 'ok' : (tenbit ? 'tx' : 'ok'),
    PS4:  !h265 ? 'ok' : 'tx',
    iOS:  'ok',
    Web:  !h265 ? 'ok' : 'tx',
  };
}
// How far the Disk section may regress playback in exchange for space. 1 allows the only
// regression worth having — H.264 to PROVEN 8-bit HEVC — where the Fire Stick still
// direct-plays, the NUC still hardware-decodes, and only the low-use PS4 picks up a cheap
// QSV transcode. 0 forbids any regression; 2 would readmit tier 3, which the guard below
// blocks outright regardless.
const TIER_SLACK = 1;

// ---- row building ─────────────────────────────────────────────────────────────────────────
// THE PUBLIC ENTRY POINT, and it exists to make a slow rebuild invisible rather than to make it fast.
//
// MEASURED 2026-08-10 on a loaded NUC: a cold rebuild is 59.5s, a warm read is 0.038s — a factor of
// 1500. The controller is only at ~5% CPU across those 59 seconds; it is BLOCKED ON HTTP to Radarr
// and Sonarr, which are themselves CPU-starved. So the fix is never to make a request wait on one.
//
// Two guarantees:
//   SINGLE-FLIGHT. Concurrent callers share ONE rebuild. Before this, three requests arriving during
//   a rebuild ran three full independent rebuilds — each re-fetching 878 movies and one episodefile
//   call per series — which loaded the very services they were waiting on and made the stall worse.
//   That is why a /replace and a search could both hang for 30s at the same time.
//
//   STALE-WHILE-REVALIDATE. If rows exist at all, they are returned IMMEDIATELY and the refresh runs
//   in the background. A caller only ever waits when there is genuinely nothing to serve (first call
//   after boot). `force` still waits, because /api/audit?refresh=1 means "I want today's answer".
//
// Together these are what let the invalidation sites stay aggressive: dropping the cache after every
// replace is correct for freshness, and now costs a background refresh instead of a 60s stall.
async function buildRows(force = false) {
  if (!force && _rowCache.rows && Date.now() - _rowCache.ts < ROW_CACHE_MS) return _rowCache.rows;
  if (!force && _rowCache.rows) {
    // Stale but serveable. Kick the refresh and answer now. The catch is load-bearing: nobody is
    // awaiting this promise, so without it a failed rebuild is an unhandled rejection.
    startRowBuild().catch(() => {});
    return _rowCache.rows;
  }
  return startRowBuild();
}
// Owns the in-flight promise. Every path into a rebuild goes through here so there can only ever be
// one, and the cache is written in exactly one place.
function startRowBuild() {
  if (!_rowBuild) {
    _rowBuild = buildRowsInner()
      .then((rows) => { _rowCache = { ts: Date.now(), rows }; return rows; })
      .finally(() => { _rowBuild = null; });
  }
  return _rowBuild;
}
// INVALIDATE WITHOUT DISCARDING. Keeping the rows while zeroing the timestamp is what makes
// stale-while-revalidate possible: the next reader gets last-known-good instantly and triggers the
// refresh, instead of finding null and being forced to block for a minute. The rows are a cache of a
// derived view, so serving one a few seconds out of date is always better than serving nothing.
function invalidateRows() { _rowCache = { ts: 0, rows: _rowCache.rows }; }
async function buildRowsInner() {
  const movies = await arrGet('radarr', '/movie');
  const series = await arrGet('sonarr', '/series');
  const mfs = movies.filter((m) => m.hasFile && m.movieFile).map((m) => m.movieFile);
  // One /episodefile call PER SERIES, and it used to be a serial await inside a for-loop — ~100
  // sequential round-trips to a Sonarr that is busy, which was a large share of the 59.5s. Run them
  // with a small concurrency cap: enough to hide the latency, low enough not to become the reason
  // Sonarr is slow. Failures still skip that series rather than failing the whole rebuild.
  const epFiles = [];
  await pooledForEach(series, 4, async (s) => {
    let fl; try { fl = await arrGet('sonarr', `/episodefile?seriesId=${s.id}`); } catch { return; }
    for (const f of (Array.isArray(fl) ? fl : [])) epFiles.push({ ...f, _series: s });
  });
  const depthMap = buildDepthMap(mfs, epFiles);
  // THE SCORE *ARR WILL JUDGE THE REPLACEMENT AGAINST. Radarr refuses to import a release whose
  // custom-format score does not BEAT the file already on disk ("not a custom format upgrade"), and
  // until now this tab could not see that number, so it cheerfully offered releases that could never
  // land: Blazing Saddles' x265 BONE encode scores 300 against the 310 on disk, and The Force
  // Awakens' AV1 copy scores -1000 against 300. Both were grabbed, both were refused, and the tab
  // gave no warning either time.
  //
  // Sonarr ships customFormatScore on the bulk /episodefile payload; Radarr's /movie does NOT carry
  // it on the embedded movieFile, and one call per movie is ~880 round-trips. /moviefile accepts
  // repeated movieId params, so ask in chunks: ~9 calls at ~170ms for the whole library. Chunked at
  // 100 to keep the URL well short of any proxy's limit. A failed chunk leaves those movies with a
  // null score, which disables the check for them rather than blocking their candidates.
  const cfScoreByMovie = new Map();
  // The format NAMES behind each score, plus the profile that scored them — what cfBlockedFor needs
  // to tell "worse only on file size" from "worse on something that matters". Rebuilt every pass and
  // keyed by row.key so the seven row-push sites below stay untouched.
  _cfRowInfo.clear();
  const rProfFormats = new Map((await arrGet('radarr', '/qualityprofile').catch(() => []))
    .map((p) => [p.id, new Map((p.formatItems || []).map((f) => [f.name, Number(f.score) || 0]))]));
  const withFiles = movies.filter((m) => m.hasFile && m.movieFile);
  const movieById = new Map(movies.map((m) => [m.id, m]));
  for (let i = 0; i < withFiles.length; i += 100) {
    const chunk = withFiles.slice(i, i + 100);
    const qs = chunk.map((m) => `movieId=${m.id}`).join('&');
    try {
      for (const f of await arrGet('radarr', `/moviefile?${qs}`, 20000)) {
        if (typeof f.customFormatScore === 'number') cfScoreByMovie.set(f.movieId, f.customFormatScore);
        const mv = movieById.get(f.movieId);
        const sbn = mv && rProfFormats.get(mv.qualityProfileId);
        if (sbn) {
          _cfRowInfo.set(`mv:${f.movieId}`, {
            formats: (f.customFormats || []).map((c) => c && c.name).filter(Boolean),
            scoreByName: sbn,
          });
        }
      }
    } catch { /* leave this chunk unscored — the check simply does not run for them */ }
  }

  const cpu = [], bitrate = [], edition = [], upgrade = [];
  // Read-only, cached an hour. Degrades to an empty map if Jellyfin is unreachable, in which case
  // the Upgrade tab just falls back to beloved-then-alphabetical instead of failing.
  const top100 = await top100RankByTmdb();
  const rProf = new Map((await arrGet('radarr', '/qualityprofile')).map((p) => [p.id, p.name]));
  // Movies appear in BOTH sections. An earlier cut assumed movie bloat was all Beloved (which
  // is excluded by design) — measured, that was wrong: 49 non-Beloved movies sit at >=6 Mbps
  // for 237 GiB, comparable to a chunk of the TV list.
  for (const m of movies) {
    const mf = m.movieFile;
    if (!m.hasFile || !mf) continue;
    // ── A FILE *ARR COULD NOT READ AT ALL ────────────────────────────────────────────────────
    // This used to be part of the skip above, which meant the single most suspect class of file in
    // the library was invisible in EVERY audit section. The Star Wars Holiday Special (1978) is the
    // case: a 1.07 GB `.VOB` holding 15.7 minutes of a 97-minute programme — 16% of the film — and
    // it appeared in no tab at all, because Radarr has no mediaInfo for it and this loop bailed
    // before any row was built. Brennan went looking for it in the Upgrade tab and it simply was not
    // there. Only the ffprobe pass of `make runtimes` ever found it.
    //
    // Unreadable is not benign. Every quality figure below (bpp, band, codec label, decode tier)
    // needs mediaInfo, so those stay null rather than being guessed — but the ROW still exists, in
    // the one section whose job is "find me a better copy", flagged `unprobed` so the UI can say why
    // it has no numbers. A row with no data is vastly more useful than no row.
    if (!mf.mediaInfo) {
      upgrade.push({ key: `mv:${m.id}`, kind: 'movie', app: 'radarr', id: m.id,
        cfScore: cfScoreByMovie.has(m.id) ? cfScoreByMovie.get(m.id) : null,
        title: `${m.title} (${m.year || '?'})`, files: 1, bytes: mf.size || 0,
        mbps: null, bpp: null, bppPlus: null, bppBand: '', cxBasis: bppBasis(`mv:${m.id}`),
        label: null, profile: rProf.get(m.qualityProfileId) || '?',
        source: ((mf.quality || {}).quality || {}).name || null,
        tier: null, minRatio: minRatioFor(m.genres, m.year),
        origLang: (m.originalLanguage || {}).name || null,
        edition: ownEditionOf(mf.edition, mf.relativePath, mf.originalFilePath),
        editionLabel: ownEditionOf(mf.edition, mf.relativePath, mf.originalFilePath).label,
        top100: m.tmdbId ? (top100.get(String(m.tmdbId)) || null) : null,
        beloved: (rProf.get(m.qualityProfileId) || '').startsWith('Beloved'),
        tmdbId: m.tmdbId || null, imdbId: m.imdbId || null,
        added: Date.parse(m.movieFile.dateAdded || m.added || 0) || 0,
        // The searchable haystack. NOT optional: /api/audit/upgrade does `r.q.includes(q)` on every
        // row, so a row without it throws "Cannot read properties of undefined (reading 'includes')"
        // and takes the WHOLE tab's search down — not just this row. Caught live 2026-08-12 the first
        // time anyone typed in the box after unprobed rows started being listed.
        q: `${m.title} ${m.year || ''}`.toLowerCase(),
        unprobed: true });
      continue;
    }
    const prof = rProf.get(m.qualityProfileId) || '?';
    const title = `${m.title} (${m.year || '?'})`;
    // The file's own SOURCE ("Bluray-1080p", "WEBDL-1080p", "HDTV-1080p"). Candidates have
    // carried this from the start but the current file did not, so the CURRENT card had no
    // source badge and there was nothing to compare a candidate's source against — an
    // HDTV-sourced suggestion for a Bluray-sourced file read as an unqualified win.
    const src = ((mf.quality || {}).quality || {}).name || null;
    const sec = secs((mf.mediaInfo || {}).runTime);
    // ── IS THIS FILE EVEN THE WHOLE FILM? ────────────────────────────────────────────────────
    // Free to ask — both numbers are already in hand, so no ffprobe and no extra request — and it
    // changes which section the row belongs in, which is the second half of the Chinatown bug.
    //
    // THE TRAP: bits-per-pixel is a RATE, so truncation does not lower it. Chinatown's 68 minutes of
    // a 130-minute film sat at 13.2 Mbps and therefore scored BPP+ 139, band "wow" — indistinguishable
    // from a lavish encode. Two things followed, both wrong:
    //   1. It was filed as BLOAT. The Disk section's candidate filter requires a candidate be smaller
    //      than the current file (`size >= bytes * 0.9` is dropped), so the tab would only ever offer
    //      to SHRINK a file that was already missing half the movie.
    //   2. It never reached the Upgrade tab's attention order, which is gated on BPP+ below
    //      UPGRADE_BPP_PLUS_MAX. At 139 it looked like one of the best files in the library.
    // So a short file was simultaneously invisible as a problem and miscategorised as the opposite
    // problem. Same verdict function as the swap preflight, so "short" means one thing everywhere.
    const rtv = runtimeVerdict({ gotSecs: sec, filmSecs: (Number(m.runtime) || 0) * 60 });
    const isShort = rtv.verdict === 'short';
    // Top 100 rank is DECLARED INTENT, read once here: it gates the Disk section (a purple Top 100
    // film is the goal, not bloat) and raises the candidate floor to green in verifyRow.
    const top100Rank = m.tmdbId ? (top100.get(String(m.tmdbId)) || null) : null;
    // Picture quality in the one unit that is comparable across the library. Every section
    // below carries it so the UI never has to re-derive a band. See arr-inspect.js bppOf().
    // MEASURE A SHORT FILE AGAINST THE FILM, NOT AGAINST ITSELF. bpp is a RATE, so a truncated file
    // reports the rate of the footage it happens to contain — 13.2 Mbps for Chinatown's 68 minutes,
    // BPP+ 139, the green "wow" band. That number is not merely cosmetic: `candBppFrom` scales every
    // candidate from it by BYTE RATIO, which silently assumes both files are the same length. Against
    // an inflated baseline the arithmetic then demands a candidate be ~2x the size before it looks
    // like an upgrade at all, which is why the only options offered for Chinatown were 12-49 GB
    // remuxes while the sensible 6-9 GB Blurays were ranked out.
    //
    // So for a short row, divide by the runtime the film SHOULD have. The result answers the question
    // that actually matters — "what rate would this file be if it covered the whole film?" (101 for
    // Chinatown, not 139) — and every candidate comparison downstream becomes honest for free.
    // videoBitrate is zeroed so bppOf cannot prefer the encode's own nominal rate over this.
    const bppMi = isShort ? { ...(mf.mediaInfo || {}), videoBitrate: 0 } : mf.mediaInfo;
    // THE UNIT KEY, and it is load-bearing since the 2026-08-06 probe cutover. Passing it into
    // bppIndex/bppBand is what makes this film's score use ITS OWN measured complexity rather than a
    // library-wide constant. It is the same string as the row key below, and the same string
    // probe.js caches measurements under — both derived from the Radarr id, so they cannot drift.
    // It is now declared BEFORE bppFor() as well, because the numerator needs it too: with a key,
    // audio is subtracted from a measurement of every track instead of *arr's single-track claim.
    const ukey = `mv:${m.id}`;
    const bpp = bppFor(bppMi, mf.size || 0, isShort ? rtv.wantSecs : sec, ukey);
    const band = bppBand(bpp, ukey);
    // Whether that score came from THIS film or was inferred from others. Carried onto every row so
    // the UI can mark an inferred number honestly (DESIGN-CRF-PROBE.md §6) instead of presenting a
    // guess and a measurement with identical confidence.
    const cxBasis = bppBasis(ukey);
    // EDITION: a film on the floor list whose copy is the wrong CUT. Independent of the other two
    // sections — Blade Runner is neither a CPU-decode nor a bitrate offender, it is simply the wrong
    // film. This is why it is a third section rather than a badge on Playback: an extended cut is
    // BIGGER and LONGER, so Disk-section reasoning would score the correct answer as bloat.
    const ownEd = ownEditionOf(mf.edition, mf.relativePath, mf.originalFilePath);
    const edFloor = editionFloorFor(m.title);
    // UPGRADE: every movie with a file, not just the offenders. This tab answers "I love this film,
    // show me the best copy that exists", so a title being already-good is not a reason to hide it —
    // the candidate search decides whether anything better is actually out there.
    // Ordered most-recently-acquired first (see the sort below). top100/beloved are still carried on
    // every row — they gate the candidate floor in verifyRow and drive the UI badges — they just no
    // longer decide position. Deliberately NOT worst-quality-first: that is what Playback/Disk are for.
    upgrade.push({ key: `mv:${m.id}`, kind: 'movie', app: 'radarr', id: m.id, cfScore: cfScoreByMovie.has(m.id) ? cfScoreByMovie.get(m.id) : null,
      title, files: 1, bytes: mf.size || 0, mbps: sec ? +(mf.size * 8 / sec / 1e6).toFixed(1) : null,
      bpp, bppPlus: bppIndex(bpp, ukey), bppBand: band, cxBasis, bppRSE: bppRSE(ukey), bppArt: bppArtifact(ukey),
      // Carried so upgradeEligible() can admit a re-encode whatever its BPP+ — see the note there.
      reenc: REENC_RE.test(`${mf.relativePath || ''} ${mf.originalFilePath || ''}`),
      label: videoLabel(mf.mediaInfo), profile: prof, source: src,
      tier: currentTier(mf.mediaInfo), minRatio: minRatioFor(m.genres, m.year),
      origLang: (m.originalLanguage || {}).name || null,
      edition: ownEd, editionLabel: ownEd.label,
      top100: top100Rank,
      beloved: prof.startsWith('Beloved'),
      // NOT THE WHOLE FILM. The strongest possible reason to replace a file, and it must travel on
      // the row because BPP+ actively argues the opposite (see the runtimeVerdict note above — a
      // truncated file scores HIGH). `shortMin`/`wantMin` are carried so the UI can say what is
      // missing in minutes rather than as a ratio nobody reads.
      short: isShort || undefined,
      shortMin: isShort ? Math.round(rtv.gotSecs / 60) : undefined,
      wantMin: isShort ? Math.round(rtv.wantSecs / 60) : undefined,
      // Identity fallback for the wrong-show guard: Radarr returns mappedMovieId=null for releases
      // whose titles it cannot parse, even when the release IS this movie (the indexer tagged it
      // with the right IMDb id — e.g. "The Blues Brothers*1980*TC[1080p...x264-LEON]" reads
      // "Unable to parse release" yet carries imdbId 80455). Collections/sequels carry 0 or a
      // different id, so the guard can admit exactly the well-tagged, wrongly-hidden copies.
      imdbId: m.imdbId || null,
      // WHEN THE TITLE WAS FIRST ACQUIRED — m.added (added to Radarr), deliberately NOT
      // mf.dateAdded (when the current FILE landed). This is the Upgrade tab's sort key.
      //
      // It was mf.dateAdded for one iteration and that was wrong in practice: every swap re-dates
      // the file, so the top of the tab filled with films Brennan had just REPLACED — the ones he
      // was already done with — instead of the films he had recently ADDED to the library, which is
      // the backlog he actually wants to work. Replacing a copy is not acquiring a movie.
      added: Date.parse(m.added || '') || 0,
      // Lower-cased once here so the client's search filter does not redo it for 800 rows per keypress.
      q: `${m.title} ${m.year || ''}`.toLowerCase() });
    // Two ways into the Edition section, and they are NOT the same claim:
    //   below FLOOR  → what you own must never be on disk (a theatrical Blade Runner). A refusal.
    //   below BEST   → what you own is acceptable but a definitive cut exists (Apocalypse Now Redux
    //                  when the Final Cut is out there). A preference a human may ignore.
    // Brennan asked why Redux → Final Cut was never offered; it was because only the first case had
    // a row. `edPrefer` carries the target tier so the UI can word it as a suggestion rather than a
    // problem, and editionUpgradeFor refuses to fire below the floor so no film is ever in both.
    const edPrefer = editionUpgradeFor(m.title, ownEd);
    // A THIRD WAY IN: right cut, narrower FRAME. For a film with sequences shot on IMAX or large
    // format, the expanded version is more picture at the same runtime — so holding the scope copy is
    // not a wrong cut, it is a smaller image. It ranks with `edPrefer` as a preference rather than a
    // refusal: what is on disk is perfectly watchable, and if no expanded release exists the row is
    // not a problem to be solved. Curated per title (IMAX_BEST) because aspect ratio alone cannot
    // tell open matte from pan-and-scan — one adds picture, the other crops it.
    // TWO WAYS TO KNOW A FILM HAS A WIDER VERSION, and the second one needs no list:
    //
    //   1. CURATED (IMAX_BEST)  — films known to be shot large-format. High confidence, but a hand
    //      list can never be exhaustive and goes stale as the library grows.
    //   2. EVIDENCE             — an IMAX-labelled RELEASE actually exists for this film, seen in
    //      the candidates the verifier already fetched. Self-expanding and empirical: if a wider
    //      version circulates, we find out without anyone maintaining anything.
    //
    // TMDB WAS CHECKED AND HAS NOTHING (2026-08-18): no imax / large-format / 65mm keyword on Dune,
    // Dune Part Two or Oppenheimer. There is no metadata source to look this up in, which is why the
    // evidence path matters rather than being a nicety.
    //
    // The evidence path deliberately matches ONLY /\bimax\b — never "open matte". Open-matte
    // releases are frequently bad TV-framing rips that ADD nothing and reveal rigging, so treating
    // one as proof of a better version could suggest a genuine downgrade. IMAX labelling is specific
    // enough to trust as a hint, and the row is only ever a suggestion a human accepts.
    const imaxSeen = !ownEd.imax && imaxCandidateSeen(`mv:${m.id}`);
    const wantImax = imaxUpgradeFor(m.title, ownEd, (mf.mediaInfo || {}).resolution, m.year)
      || (imaxSeen && arIsScope((mf.mediaInfo || {}).resolution));
    if (edFloor != null && ownEd.tier < edFloor) {
      edition.push({ key: `mv:${m.id}`, kind: 'movie', app: 'radarr', id: m.id, cfScore: cfScoreByMovie.has(m.id) ? cfScoreByMovie.get(m.id) : null,
        title, files: 1, bytes: mf.size || 0, mbps: sec ? +(mf.size * 8 / sec / 1e6).toFixed(1) : null,
      bpp, bppPlus: bppIndex(bpp, ukey), bppBand: band, cxBasis, bppRSE: bppRSE(ukey), bppArt: bppArtifact(ukey),
        label: videoLabel(mf.mediaInfo), profile: prof, source: src,
        tier: currentTier(mf.mediaInfo), minRatio: minRatioFor(m.genres, m.year),
        origLang: (m.originalLanguage || {}).name || null,
        edition: ownEd, editionFloor: edFloor, tmdbId: m.tmdbId || null, imdbId: m.imdbId || null,
        // The UI must not assert "theatrical" when nothing said so. An untagged file is USUALLY
        // theatrical but may just be badly named, and claiming otherwise is the kind of confident
        // wrongness that makes a human distrust the whole tab. `stated` is what lets it say
        // "edition unknown" instead — the candidate list then shows what actually exists.
        editionLabel: ownEd.label, editionStated: ownEd.label !== null,
        want: edFloor >= 3 ? "Director's or Final Cut" : 'Extended / long cut' });
    } else if (edPrefer != null) {
      // The softer row. Same shape so the section renders it with one template, but `editionPrefer`
      // marks it as a suggestion: what is on disk is allowed to stay, and if nothing better turns up
      // this row is not a problem to be solved.
      edition.push({ key: `mv:${m.id}`, kind: 'movie', app: 'radarr', id: m.id, cfScore: cfScoreByMovie.has(m.id) ? cfScoreByMovie.get(m.id) : null,
        title, files: 1, bytes: mf.size || 0, mbps: sec ? +(mf.size * 8 / sec / 1e6).toFixed(1) : null,
      bpp, bppPlus: bppIndex(bpp, ukey), bppBand: band, cxBasis, bppRSE: bppRSE(ukey), bppArt: bppArtifact(ukey),
        label: videoLabel(mf.mediaInfo), profile: prof, source: src,
        tier: currentTier(mf.mediaInfo), minRatio: minRatioFor(m.genres, m.year),
        origLang: (m.originalLanguage || {}).name || null,
        edition: ownEd, editionFloor: edFloor, editionPrefer: edPrefer, tmdbId: m.tmdbId || null,
        imdbId: m.imdbId || null,
        editionLabel: ownEd.label, editionStated: ownEd.label !== null,
        want: edPrefer >= 4 ? 'Final Cut' : (edPrefer === 3 ? "Director's Cut" : 'Extended / long cut') });
    } else if (wantImax) {
      edition.push({ key: `mv:${m.id}`, kind: 'movie', app: 'radarr', id: m.id, cfScore: cfScoreByMovie.has(m.id) ? cfScoreByMovie.get(m.id) : null,
        title, files: 1, bytes: mf.size || 0, mbps: sec ? +(mf.size * 8 / sec / 1e6).toFixed(1) : null,
        bpp, bppPlus: bppIndex(bpp, ukey), bppBand: band, cxBasis, bppRSE: bppRSE(ukey), bppArt: bppArtifact(ukey),
        label: videoLabel(mf.mediaInfo), profile: prof, source: src,
        tier: currentTier(mf.mediaInfo), minRatio: minRatioFor(m.genres, m.year),
        origLang: (m.originalLanguage || {}).name || null,
        edition: ownEd, tmdbId: m.tmdbId || null, imdbId: m.imdbId || null,
        editionLabel: ownEd.label, editionStated: ownEd.label !== null,
        // Distinct from editionPrefer so the UI can word it as FRAMING, not as a cut. Saying
        // "extended cut available" about an IMAX release would be wrong: same edit, more image.
        imaxPrefer: true,
        resolution: (mf.mediaInfo || {}).resolution || null,
        want: 'IMAX / expanded framing — more picture, same cut' });
    }
    if (gpuTier(mf.mediaInfo) !== 'ok') {
      // Playback rows carry `mbps` too. They used not to, and because qualityBand() returns
      // band:'unknown' without a current bitrate, EVERY Playback candidate rendered with no
      // Mbps figure and no bitrate band — the Disk tab looked far better informed for no reason
      // other than which constructor happened to compute a number both tabs could use.
      // It cannot change which candidates are offered: the AGGRESSIVE_FLOOR ratio filter lives
      // in verifyRow's `else` (Disk-only) branch, so Playback still shows everything it did.
      cpu.push({ key: `mv:${m.id}`, kind: 'movie', app: 'radarr', id: m.id, cfScore: cfScoreByMovie.has(m.id) ? cfScoreByMovie.get(m.id) : null,
        title, files: 1, bytes: mf.size || 0, mbps: sec ? +(mf.size * 8 / sec / 1e6).toFixed(1) : null,
      bpp, bppPlus: bppIndex(bpp, ukey), bppBand: band, cxBasis, bppRSE: bppRSE(ukey), bppArt: bppArtifact(ukey), top100: top100Rank, beloved: prof.startsWith('Beloved'),
        label: videoLabel(mf.mediaInfo), profile: prof,
        source: src, tier: currentTier(mf.mediaInfo), minRatio: minRatioFor(m.genres, m.year),
        origLang: (m.originalLanguage || {}).name || null, imdbId: m.imdbId || null,
        // WHICH CUT we hold. Both sources are consulted because each knows things the other does
        // not — see ownEditionOf. Carried on the row so the candidate filter can refuse an edition
        // downgrade without re-fetching anything.
        edition: ownEditionOf(mf.edition, mf.relativePath, mf.originalFilePath) });
    }
    // DISK. Selects on the bpp band now, not a flat Mbps number, and no longer only on x264 —
    // a fat 10-bit HEVC season used to be invisible here because the codec filter excluded it,
    // leaving it to the Playback section which says nothing about disk. Beloved is still exempt
    // by design: that profile exists to spare no expense.
    // LISTED, NOT FILTERED. Brennan, 2026-08-01: "its fine for stuff to appear in multiple audit
    // tabs, or to appear when its low priority, like reducing the file size of a beloved or
    // top100 movie. Those can appear, they just likely should be weighted lower."
    //
    // So a Beloved or Top 100 film that is genuinely large DOES get a row here — shrinking it is a
    // legitimate option a human might take — it just sorts below everything else. Same for a file
    // the Playback section already lists: the two sections are answering different questions about
    // the same file (CPU cost vs disk cost) and seeing both is more useful than seeing one.
    // Only the CODEC filter is gone for good: it excluded HEVC 8-bit, which is pure disk cost.
    // A SHORT FILE IS NEVER BLOAT, whatever its bitrate says. Excluded here rather than sorted low,
    // because every candidate this section could offer is by definition smaller than a file that is
    // already missing footage — the row is not merely low-priority, it is actively harmful. It
    // surfaces in the Upgrade section instead, flagged `short`. See the runtimeVerdict call above.
    if (sec && !isShort) {
      const mbps = mf.size * 8 / sec / 1e6;
      // ADMIT ON BAND *OR* MEASURED OVER-SUPPLY. The band alone missed files that are demonstrably
      // carrying dead weight but sit a tier below `wow`, and admitted 2 GB files with nothing to
      // give back. `overBytes` is the measured answer and it is what the section sorts on.
      const overBytes = overSupplyBytes(mf.size || 0, ukey);
      if ((band && BPP_RANK[band] <= BPP_RANK[BLOAT_BAND_BY_PROFILE(prof)]) || overBytes) {
        bitrate.push({ key: `mv:${m.id}`, kind: 'movie', app: 'radarr', id: m.id, cfScore: cfScoreByMovie.has(m.id) ? cfScoreByMovie.get(m.id) : null,
          title, files: 1, bytes: mf.size || 0, mbps: +mbps.toFixed(1),
          // Bytes above what reproducing THIS FILE takes — a disk claim, never a quality claim.
          overBytes: overBytes || null, overR: bppRatioR(ukey),
          // IS WHAT WE HOLD ITSELF A RE-ENCODE? Read from the filename, because the quality name has
          // already thrown the information away (*arr calls a BRRip "Bluray"). Both sides of the
          // downgrade test must be measured the same way — see effSrcRank.
          reenc: REENC_RE.test(`${mf.relativePath || ''} ${mf.originalFilePath || ''}`),
          bpp, bppPlus: bppIndex(bpp, ukey), bppBand: band, cxBasis, bppRSE: bppRSE(ukey), bppArt: bppArtifact(ukey), top100: top100Rank, beloved: prof.startsWith('Beloved'),
          // Sinks the row in the Disk ordering without hiding it — see the sort below.
          lowPriority: !!(top100Rank || prof.startsWith('Beloved') || gpuTier(mf.mediaInfo) !== 'ok'),
          label: videoLabel(mf.mediaInfo), profile: prof, source: src, target: +(mbps * 0.55).toFixed(1),
          tier: currentTier(mf.mediaInfo), minRatio: minRatioFor(m.genres, m.year),
          origLang: (m.originalLanguage || {}).name || null, imdbId: m.imdbId || null,
          edition: ownEditionOf(mf.edition, mf.relativePath, mf.originalFilePath) });
      }
    }
  }
  // TV: grouped by season for both sections.
  const bySeason = new Map();
  for (const f of epFiles) {
    const k = `${f._series.id}:${f.seasonNumber}`;
    const e = bySeason.get(k) || { s: f._series, season: f.seasonNumber, files: [], bytes: 0, sec: 0 };
    e.files.push(f); e.bytes += f.size || 0; e.sec += secs((f.mediaInfo || {}).runTime);
    bySeason.set(k, e);
  }
  const sProfiles = await arrGet('sonarr', '/qualityprofile');
  const profNames = new Map(sProfiles.map((p) => [p.id, p.name]));
  const sProfFormats = new Map(sProfiles.map((p) => [p.id, new Map((p.formatItems || []).map((f) => [f.name, Number(f.score) || 0]))]));
  for (const [k, e] of bySeason) {
    const bad = e.files.filter((f) => f.mediaInfo && gpuTier(f.mediaInfo) !== 'ok');
    const prof = profNames.get(e.s.qualityProfileId) || '?';
    // Same role as the movie branch's ukey. A season is one probe unit (measured from 2 interior
    // episodes), so every row for this season shares one complexity — see probe.js buildUnits().
    const ukey = `tv:${k}`;
    const cxBasis = bppBasis(ukey);
    // MAX, not average. Sonarr judges each episode against its OWN file, so a season pack has to
    // beat the highest-scoring episode in the set or it imports only part of the season — which
    // leaves the swap half-done and the verification unable to confirm it. Treat the hardest
    // episode as the bar. null when Sonarr reported no score for any file, which disables the check.
    const cfMax = (fl) => {
      const ns = fl.map((f) => f.customFormatScore).filter((n) => typeof n === 'number');
      return ns.length ? Math.max(...ns) : null;
    };
    // The formats of the STRONGEST file, matching cfMax's choice of bar — see buildCfAllow, which
    // makes the same pick for the import-side allowance. Both rows for a season share one key, so
    // this is written from the whole season's file list rather than per-section.
    {
      const sbn = sProfFormats.get(e.s.qualityProfileId);
      if (sbn) {
        let bestF = null; let best = -Infinity;
        for (const f of e.files) {
          const s = nonSizeCfScore(f.customFormats, sbn);
          if (s > best) { best = s; bestF = f; }
        }
        _cfRowInfo.set(`tv:${k}`, {
          formats: ((bestF && bestF.customFormats) || []).map((c) => c && c.name).filter(Boolean),
          scoreByName: sbn,
        });
      }
    }
    if (bad.length) {
      // Bitrate over the BAD files only, not the whole season. A Playback row's `bytes` counts
      // just the offending files, so dividing those bytes by the season's total runtime (e.sec)
      // would understate the rate badly on a season where only 2 of 10 episodes are 10-bit.
      const badBytes = bad.reduce((a, f) => a + (f.size || 0), 0);
      const badSec = bad.reduce((a, f) => a + secs((f.mediaInfo || {}).runTime), 0);
      const badBpp = bppFor(bad[0].mediaInfo, badBytes, badSec, ukey);
      cpu.push({ key: `tv:${k}`, kind: 'season', app: 'sonarr', id: e.s.id, season: e.season, cfScore: cfMax(bad),
        title: `${e.s.title} — S${String(e.season).padStart(2, '0')}`,
        files: bad.length, bytes: badBytes,
        mbps: badSec ? +(badBytes * 8 / badSec / 1e6).toFixed(1) : null,
        bpp: badBpp, bppPlus: bppIndex(badBpp, ukey), bppBand: bppBand(badBpp, ukey), cxBasis, bppRSE: bppRSE(ukey), bppArt: bppArtifact(ukey),
        label: videoLabel(bad[0].mediaInfo), profile: prof, tier: currentTier(bad[0].mediaInfo),
        source: ((bad[0].quality || {}).quality || {}).name || null,
        minRatio: minRatioFor(e.s.genres, e.s.year),
        origLang: (e.s.originalLanguage || {}).name || null });
    }
    // Beloved seasons are LISTED but sorted last (see the movie branch and the sort below) —
    // shrinking one is a legitimate choice, just rarely the first one.
    if (!e.sec) continue;
    const mbps = e.bytes * 8 / e.sec / 1e6;
    const seasonBpp = bppFor(e.files[0].mediaInfo, e.bytes, e.sec, ukey);
    const seasonBand = bppBand(seasonBpp, ukey);
    // Band, not Mbps, and no longer x264-only — see the movie branch above for why.
    // Same admit rule as the movie branch — see the OVER-SUPPLY block. A season's bytes are the whole
    // pack, so overBytes here is the recoverable total across every episode in it.
    const seasonOver = overSupplyBytes(e.bytes, ukey);
    if ((seasonBand && BPP_RANK[seasonBand] <= BPP_RANK[BLOAT_BAND_BY_PROFILE(prof)]) || seasonOver) {
      bitrate.push({ key: `tv:${k}`, kind: 'season', app: 'sonarr', id: e.s.id, season: e.season, cfScore: cfMax(e.files),
        title: `${e.s.title} — S${String(e.season).padStart(2, '0')}`,
        files: e.files.length, bytes: e.bytes, mbps: +mbps.toFixed(1),
        overBytes: seasonOver || null, overR: bppRatioR(ukey),
        // Same as the movie branch — sampled from the first episode's path, which carries the
        // release naming for the whole pack.
        reenc: REENC_RE.test(`${(e.files[0] || {}).relativePath || ''} ${(e.files[0] || {}).originalFilePath || ''}`),
        bpp: seasonBpp, bppPlus: bppIndex(seasonBpp, ukey), bppBand: seasonBand, cxBasis, bppRSE: bppRSE(ukey), bppArt: bppArtifact(ukey), beloved: prof.startsWith('Beloved'),
        lowPriority: !!(prof.startsWith('Beloved') || bad.length),
        label: videoLabel(e.files[0].mediaInfo), profile: prof,
        source: ((e.files[0].quality || {}).quality || {}).name || null,
        target: +(mbps * 0.55).toFixed(1), tier: currentTier(e.files[0].mediaInfo),
        minRatio: minRatioFor(e.s.genres, e.s.year),
        origLang: (e.s.originalLanguage || {}).name || null });
    }

    /* ---- TV IN THE UPGRADE SECTION, PER SEASON ------------------------------------------------
     * *** THE UPGRADE TAB USED TO BE MOVIES ONLY. *** `upgrade.push` was called from the Radarr
     * loop and nowhere else, so 146 measured seasons across 97 series could never appear — not
     * merged into a series row, ABSENT. There was no way to act on a bad season from the UI at all.
     *
     * WHY PER SEASON RATHER THAN PER SERIES, measured 2026-08-29 on this library:
     *   19 series have 2+ measured seasons. Within one series BPP+ spreads a MEDIAN 1.47x, and
     *   74% spread >= 1.25x. Peaky Blinders runs 87-198, Lost 74-145, Supernatural 55-111.
     *   A series-level row is an episode-weighted MEAN, which averages that away by construction —
     *   the number that would decide the row is the one number guaranteed not to show the problem.
     *   And a season is the unit you can actually replace: Sonarr searches per season
     *   (`/release?seriesId=..&seasonNumber=..`, already used by the release path below).
     *
     * IT IS ALSO THE RIGHT UNIT FOR THE REAL DEFECT. Of the 14 series that spread >= 1.25x, TEN
     * have a weakest season that is STARVED — Lost S05 holds 15% of its siblings' bitrate, Peaky
     * Blinders S06 22%, 1923 S01 23% — all wearing the same "Bluray-1080p" label as their siblings.
     * Those are a different, worse release, and a replacement genuinely fixes them.
     *
     * BUT FOUR ARE NOT STARVED, THEY ARE EXPENSIVE: The Sopranos S01 carries 2.20x its siblings'
     * complexity, Squid Game S01 1.52x, House of the Dragon S02 1.42x. Their BPP+ is low because
     * the CONTENT costs more, not because the copy is poor, and a replacement buys little. The two
     * look identical in the score. `overR` already carries R (supply) on this row, which is the
     * discriminator — a starved season sits well under 1, an expensive one does not.
     * DO NOT add a "starved vs expensive" flag here: that would be a cut-off on a continuum, and
     * R is already on the row for the UI to show as a number.
     *
     * `unprobed` is deliberately NOT set: a season with no complexity measurement scores against
     * the estimate ladder like anything else, and admitting every unmeasured season would flood the
     * tab during a backfill. */
    upgrade.push({ key: `tv:${k}`, kind: 'season', app: 'sonarr', id: e.s.id, season: e.season,
      cfScore: cfMax(e.files),
      title: `${e.s.title} — S${String(e.season).padStart(2, '0')}`,
      files: e.files.length, bytes: e.bytes, mbps: +mbps.toFixed(1),
      bpp: seasonBpp, bppPlus: bppIndex(seasonBpp, ukey), bppBand: seasonBand,
      cxBasis, bppRSE: bppRSE(ukey), bppArt: bppArtifact(ukey),
      // R is the starved-vs-expensive discriminator described above. Same field the Disk section
      // uses, so one meaning of "supply" across the tab.
      overR: bppRatioR(ukey),
      reenc: REENC_RE.test(`${(e.files[0] || {}).relativePath || ''} ${(e.files[0] || {}).originalFilePath || ''}`),
      label: videoLabel(e.files[0].mediaInfo), profile: prof,
      source: ((e.files[0].quality || {}).quality || {}).name || null,
      tier: currentTier(e.files[0].mediaInfo), minRatio: minRatioFor(e.s.genres, e.s.year),
      origLang: (e.s.originalLanguage || {}).name || null,
      // A season has no edition and no Top 100 rank; the fields must still EXIST because the sort
      // and the renderer read them unconditionally.
      edition: null, editionLabel: null, top100: null,
      beloved: prof.startsWith('Beloved'),
      imdbId: null,
      // Series-added date, matching the movie branch's choice of m.added over mf.dateAdded: a swap
      // re-dates the file, so file dates fill the top of the tab with what you just replaced.
      added: Date.parse(e.s.added || '') || 0,
      // NOT OPTIONAL. /api/audit/upgrade does r.q.includes(q) on every row; a row without it throws
      // and takes the WHOLE tab's search down, not just this row.
      q: `${e.s.title} s${String(e.season).padStart(2, '0')} season ${e.season}`.toLowerCase() });
  }
  cpu.sort((a, b) => b.bytes - a.bytes);
  // Biggest first, EXCEPT that low-priority rows sink to the bottom: a Beloved/Top-100 title, or
  // one the Playback section already lists. They are real options, just not the ones to lead with.
// SORT BY WHAT COMES BACK, not by what is held. Raw `bytes` put the biggest files on top, and the
// biggest files in this library are grainy classics whose size is justified — 12 Angry Men is
// 24.5 GB with the highest complexity we have measured. Ranking on `overBytes` puts the rows where
// something is actually recoverable first, and those are the clean modern films (Parasite 8.5 GB of
// slack, Blade Runner 2049 6.9, Inglourious Basterds 6.2). Rows with no measured over-supply keep
// their old byte ordering underneath, so nothing that used to be listed has moved out of reach.
bitrate.sort((a, b) => (Number(!!a.lowPriority) - Number(!!b.lowPriority))
  || ((b.overBytes || 0) - (a.overBytes || 0))
  || b.bytes - a.bytes);
  // Alphabetical, not by size: this list is short and every row is equally wrong, so "which film"
  // is the only useful ordering. Sorting by bytes would imply a severity that does not exist here.
  edition.sort((a, b) => a.title.localeCompare(b.title));
  // SORT: MOST RECENTLY ACQUIRED FIRST.
  //
  // This replaced a priority grouping (Top 100 / Beloved with a sub-green picture, then the rest
  // alphabetically). That ordering answered "which film that I love looks worst?", which was the
  // right question while the list was unworked — but Brennan has now been through the whole library
  // once (2026-08-10), so the useful question became "what changed since I last looked?".
  //
  // Recency answers it directly: the films most recently ADDED to the library are the ones whose
  // copy has not been looked at yet. See `added` above for why this is the title's acquisition date
  // and not the current file's import date — sorting by the file date surfaced titles that had just
  // been replaced, i.e. exactly the ones already dealt with.
  //
  // Titles with no usable dateAdded sort last rather than first — a missing timestamp is not news.
  // Alphabetical is the tiebreak so a bulk import that shares a timestamp still lands in a stable,
  // scannable order rather than whatever order Radarr happened to return.
  // BROKEN FILES FIRST, ahead of the acquisition-date ordering. Everything else in this tab is
  // discretionary ("show me the best copy that exists"); a file that is not the whole film is not a
  // preference, it is damage, and it must not be buried N screens down among healthy titles. This is
  // the row Brennan had to discover by watching the film — see the runtimeVerdict call in buildRows.
  upgrade.sort((a, b) => ((b.short || b.unprobed) ? 1 : 0) - ((a.short || a.unprobed) ? 1 : 0)
    || (b.added || 0) - (a.added || 0)
    || a.title.localeCompare(b.title));
  const seriesNorm = new Map(series.map((x) => [x.id, normTitle(x.title)]));
  // The cache write lives in startRowBuild, not here — one writer, so a rebuild that throws part way
  // can never leave a half-built view behind as the new "fresh" answer.
  return { cpu, bitrate, edition, upgrade, depthMap, seriesNorm };
}

// ---- "which films do I care about most?" ─────────────────────────────────────────────────────
// Top 100 rank was originally the Upgrade tab's PRIMARY SORT KEY ("so that the movies I in theory
// should care about the most are near the top"). It no longer is — the tab sorts by acquisition date
// now that the library has been worked through once (2026-08-10) — but the rank is still load-bearing
// elsewhere: it raises the candidate floor to green in verifyRow, gates the Disk section, and colours
// the row badge. So this lookup stays, it just no longer decides ordering.
//
// The join is TMDB id, never the title. The Jellyfin playlist and Radarr disagree on punctuation and
// year suffixes constantly, and a title match here would silently mis-rank films; ProviderIds.Tmdb is
// exact. Cached for an hour — the playlist is hand-curated and changes rarely, and this must not add
// a Jellyfin round trip to every page of scrolling.
const TOP100_TTL_MS = 60 * 60 * 1000;
let _top100 = { ts: 0, byTmdb: new Map() };
async function top100RankByTmdb() {
  if (_top100.byTmdb.size && Date.now() - _top100.ts < TOP100_TTL_MS) return _top100.byTmdb;
  const out = new Map();
  try {
    if (!cfg.JELLYFIN_KEY) return out;
    const uid = await jellyfinUserId();
    const h = { Authorization: `MediaBrowser Token="${cfg.JELLYFIN_KEY}"` };
    const pq = new URLSearchParams({ IncludeItemTypes: 'Playlist', Recursive: 'true', Limit: '200' });
    const pls = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${pq}`, { headers: h }, 20000)).Items) || [];
    const pl = pls.find((p) => p.Name === 'Top 100');
    if (!pl) return out;
    const iq = new URLSearchParams({ Limit: '500', Fields: 'ProviderIds' });
    const items = ((await tfetchJson(`${HOST.jellyfin}/Playlists/${pl.Id}/Items?${iq}&userId=${uid}`, { headers: h }, 20000)).Items) || [];
    // PLAYLIST ORDER IS THE RANK, and it is the irreplaceable, hand-tuned part (see top100-export.js).
    // Read-only here: this never writes to the playlist.
    items.forEach((it, i) => {
      const tm = ((it.ProviderIds || {}).Tmdb) || ((it.ProviderIds || {}).tmdb);
      if (tm) out.set(String(tm), i + 1);
    });
    // An empty read is a Jellyfin hiccup, not an empty playlist — keep the last good map rather than
    // flattening everyone's rank to "unranked", which would silently reshuffle the whole tab.
    if (!out.size) return _top100.byTmdb;
    _top100 = { ts: Date.now(), byTmdb: out };
  } catch { return _top100.byTmdb; }   // Jellyfin down — last good map, or empty; ordering degrades, nothing breaks
  return _top100.byTmdb;
}

// ---- stale torrents: no verification needed, it is waste by definition ────────────────────
// Detection is by INODE, exactly as scripts/show-stale-torrents.sh does it. *arr imports by
// hardlink, so a seeding torrent and its library file are normally the same inode and the
// torrent copy costs ZERO extra bytes. That breaks when the library file is rewritten
// (ps4ify adding an AC3 track) or superseded by a different release — then the torrent is
// left holding the only reference to its own data.
//
// Name/size matching would be WRONG here: Blue Planet II has library and torrent copies with
// identical release names differing by ~198 MB per episode. Only a shared inode proves shared
// bytes. /data is mounted read-only into this container, so the stat walk is safe.
//
// This is REPORT-ONLY. show-stale-torrents.sh stays the authority for deleting, because it
// also cross-checks *arr import history to prove the library still holds the content.
const fs = require('fs');
const path = require('path');
const MIN_STALE_BYTES = 50 * 1024 * 1024;
function walkFiles(dir, out, depth = 0) {
  if (depth > 8) return out;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out, depth + 1);
    else if (e.isFile()) {
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.size >= MIN_STALE_BYTES) out.push({ p, ino: st.ino, size: st.size });
    }
  }
  return out;
}
let _staleCache = { ts: 0, val: null };
async function staleTorrents(force = false) {
  if (!force && _staleCache.val && Date.now() - _staleCache.ts < ROW_CACHE_MS) return _staleCache.val;
  let val;
  try {
    const mediaInodes = new Set(walkFiles('/data/media', []).map((f) => f.ino));
    const torFiles = walkFiles('/data/torrents/complete', []);
    const staleFiles = torFiles.filter((f) => !mediaInodes.has(f.ino));
    let torrents = [];
    try { torrents = await getQbitTorrents(); } catch { /* qbit down — still report the files */ }
    // Longest-prefix match, skipping BLANK content_path: '' + '/' prefixes every absolute
    // path, which would attribute the entire library to one torrent (36 are blank here).
    const byPath = torrents
      .map((t) => [String(t.content_path || '').replace(/\/+$/, ''), t])
      .filter(([cp]) => cp.length > 1)
      .sort((a, b) => b[0].length - a[0].length);
    const groups = new Map();
    for (const f of staleFiles) {
      const hit = byPath.find(([cp]) => f.p === cp || f.p.startsWith(cp + '/'));
      const k = hit ? hit[1].hash : `orphan:${path.dirname(f.p)}`;
      const g = groups.get(k) || { hash: hit ? hit[1].hash : null, title: hit ? hit[1].name : path.basename(path.dirname(f.p)),
        bytes: 0, files: 0, ratio: hit ? +(hit[1].ratio || 0).toFixed(2) : null,
        tracked: !!hit, paths: [] };
      g.bytes += f.size; g.files++; g.paths.push(f.p);
      groups.set(k, g);
    }
    // COVERAGE — the safety verdict, computed the same way scripts/show-stale-torrents.sh
    // does it: resolve the *arr import history by downloadId and check the title it delivered
    // STILL HAS A FILE today. Without this a torrent that is the library's only remaining
    // copy looks identical to one that is pure surplus.
    const imported = new Map();
    // eventType=3 is downloadFolderImported — the ONLY type this check reads. Filtering
    // server-side is not an optimisation, it is what makes the call viable: measured
    // 2026-07-27, an unfiltered pageSize=4000 took >100s and timed out (silently dropping
    // every row to UNPROVEN), while eventType=3 at pageSize=2000 returns 1929 records in 20s.
    const H = 'page=1&pageSize=2000&eventType=3&sortKey=date&sortDirection=descending';
    let histOk = true;
    for (const [app, key] of [['sonarr', 'seriesId'], ['radarr', 'movieId']]) {
      try {
        // 60s, NOT the arrGet default of 8s: 4000 history records is a large payload and the
        // default timeout silently lost it, dropping every row to UNPROVEN. That failed safe
        // (UNPROVEN is never deleted) but made the whole coverage check inert — exactly the
        // kind of quiet failure a safety gate must not have.
        const h = await arrGet(app, `/history?${H}`, 60000);
        for (const r of (h.records || h || [])) {
          if (r.eventType !== 'downloadFolderImported' || !r.downloadId) continue;
          const list = imported.get(r.downloadId.toLowerCase()) || [];
          list.push([app, r[key]]);
          imported.set(r.downloadId.toLowerCase(), list);
        }
      } catch (e) {
        histOk = false;
        console.log(`audit: ${app} history fetch failed — ${e.message || e}; coverage will read UNPROVEN`);
      }
    }
    const haveSeries = new Set((await arrGet('sonarr', '/series').catch(() => []))
      .filter((x) => (x.statistics || {}).episodeFileCount > 0).map((x) => x.id));
    const haveMovie = new Set((await arrGet('radarr', '/movie').catch(() => []))
      .filter((m) => m.hasFile).map((m) => m.id));
    for (const [k, g] of groups) {
      // If history didn't load, NOTHING may claim COVERED — a coverage verdict is only
      // meaningful when the evidence it rests on actually arrived.
      const imp = histOk && g.hash ? imported.get(String(g.hash).toLowerCase()) : null;
      if (!imp || !imp.length) { g.cov = 'UNPROVEN'; continue; }
      g.cov = imp.every(([app, id]) => (app === 'radarr' ? haveMovie.has(id) : haveSeries.has(id)))
        ? 'COVERED' : 'LOST';
    }
    const rows = [...groups.values()].sort((a, b) => b.bytes - a.bytes);
    const safe = rows.filter((r) => r.cov === 'COVERED' && r.hash);
    val = { rows, bytes: rows.reduce((a, r) => a + r.bytes, 0),
      hardlinked: torFiles.length - staleFiles.length,
      safeCount: safe.length, safeBytes: safe.reduce((a, r) => a + r.bytes, 0) };
  } catch (e) { val = { rows: [], bytes: 0, err: String(e.message || e) }; }
  _staleCache = { ts: Date.now(), val };
  return val;
}

// ---- format intelligence ──────────────────────────────────────────────────────────────────
// SOURCE TIER, AUDIO and the HARD REFUSALS (camrip / extras disc / dub / foreign-only) now live in
// ./release-rules, because the Downloads tab's manual-grab picker needs the identical gate: its
// results come from a raw Prowlarr text search, so it was offering exactly the junk these rules were
// written to refuse. Shared rather than copied so tightening one surface can never leave the other
// behind. Behaviour here is unchanged — same regexes, same functions, same names.

// ---- HARD REFUSALS: see ./release-rules ───────────────────────────────────────────────────
// Applied at verify time AND at serve time — serve time is normally presentation only, but a
// refusal applied there cleans every verdict already cached instead of waiting on a
// VERDICT_VERSION bump and hours of re-scraping.
// The rules themselves (CAM_RE, EXTRAS_RE, DUB_RE, LANG_TAG, isForeignOnly, isRefused) and the long
// case histories behind each — the 1080p HDTS offered for Mission: Impossible, the Casino Royale
// extras disc that became a default top pick, the Italian-only pack that looked safe — are all in
// ./release-rules, imported above. They are unchanged; only their address moved.

// Enrich a CACHED candidate with everything derivable from what was already stored. Done at
// SERVE time on purpose: these are presentation and ranking signals, not filter decisions, so
// deriving them here applies them to the 173 verdicts already on disk instead of demanding a
// VERDICT_VERSION bump and ~2h of re-verification.
function enrichCand(c, row) {
  const curRank = srcRank(row.source);
  const n = srcRank(c.source);
  const audio = audioOf(c.title);
  // Bitrate figures are derived HERE, at serve time, from the row's own rate and the size ratio —
  // not read back from the cached verdict. Playback verdicts were all cached while their rows had
  // no `mbps`, so every one holds mbps:null / band:'unknown'; recomputing on the way out gives all
  // ~145 existing verdicts the Mbps and band figures immediately instead of after hours of
  // re-verification (the same reasoning as the serve-time refusals). Falls back to whatever the
  // verdict already stored when the row genuinely has no rate.
  const mbps = row.mbps && row.bytes ? +(row.mbps * (c.bytes / row.bytes)).toFixed(1) : (c.mbps ?? null);
  const q = qualityBand(row.mbps, mbps, (row.tier || 1) !== 1, c.codec === 'HEVC');
  const band = q.band === 'unknown' ? (c.band || 'unknown') : q.band;
  const ratio = q.ratio != null ? q.ratio : (c.ratio ?? null);
  return { ...c,
    mbps,
    band,
    ratio,
    belowFloor: ratio != null ? ratio < (row.minRatio ?? 0.30) : !!c.belowFloor,
    minRatio: row.minRatio ?? 0.30,
    srcRank: n,
    srcDrop: (curRank != null && n != null && n < curRank) ? curRank - n : 0,
    reenc: REENC_RE.test(c.title || ''),
    audio,
    audioRank: audio ? (AUDIO_RANK[audio] ?? null) : null,
    repack: /repack|proper/i.test(c.title || ''),
  };
}

// RANKING. Regressions sink, they are no longer silently first. Order:
//   1. source not downgraded — an HDTV encode of a Bluray file is a real loss whatever its
//      bitrate ratio says, and ranking on the ratio alone put exactly that at the top of
//      Fringe S01.
//   2. bitrate band, 3. playback tier, 4. not a re-encode-of-a-rip, 5. seeders, 6. savings.
// Savings stays LAST: it is the reward, never the reason.
// MULTI-SEASON PACKS must never be offered to replace ONE season. Sonarr parses
// "Lost S01-S06 Complete" as fullSeason with mappedSeasonNumber=1, so it sails through the
// wrong-show guard, and after the v8 re-scrape three such packs were ranked FIRST — Lost S01
// was being offered a 58 GB six-season pack to replace a 31 GB single season. Acting on one
// would delete the old S01 files and import six seasons into a season slot.
//
// MULTI_SEASON_RE / isMultiSeason now live in ./release-rules alongside scopeOf(), which the
// Downloads picker uses to answer "does this pack cover a season I am actually missing".

// The SAME release is routinely carried by several indexers, arriving as separate results with
// different guids — Shrek Forever After listed the identical YIFY encode twice, which wastes a
// slot and makes the sheet look broken. Key on title+size, and keep whichever copy reports the
// most seeders since that is the one worth grabbing.
function dedupeCands(cands) {
  const best = new Map();
  for (const c of cands) {
    const k = `${String(c.title || '').toLowerCase().replace(/\s+/g, ' ').trim()}|${c.bytes}`;
    const prev = best.get(k);
    if (!prev || (c.seeders || 0) > (prev.seeders || 0)) best.set(k, c);
  }
  return [...best.values()];
}

// ---- SOURCE TIER IS A CEILING THE DISK SECTION MUST NOT TRADE AWAY ---------------------------
// `srcDrop` has always been COMPUTED (enrichCand) and drawn as a "↓" on the card, but it was
// explicitly presentation, never a filter. In the Disk section that is the wrong call and it
// produced the suggestion Brennan flagged on 2026-08-18: Peaky Blinders S04, 27 GB Bluray, whose
// only two offers were 6.0 GB and 6.3 GB HDTV rips.
//
// WHY BPP+ CANNOT SEE THIS. Source tier is WHAT THE RELEASE WAS MADE FROM, and it caps how good the
// picture can be at ANY bitrate: an off-air capture carries broadcast compression, station logos and
// sometimes trimmed content, and no number of bits undoes damage already in the master. Same
// structural fact the grain work landed on — BPP+ measures SUPPLY against content and is blind to
// the master that content came from. Brennan: "I've never found a good way to rectify
// bluray/webdl/webrip/hdtv into bpp+ besides just having it as a separate badge." Right — it is not
// a bitrate axis, so it must be a GATE, not a term.
//
// SCOPED TO DISK. Playback already demands a playback or source improvement; Upgrade and Edition are
// deliberately permissive ("better on >=1 axis, tradeoffs LABELLED") and a human is choosing there
// with the drop shown. But Disk's whole premise is "you are over-supplied for your content", and
// that assumes the SAME master. Swapping to a worse one is not reclaiming waste, it is buying a
// worse picture with the space.
// A RE-ENCODE COSTS A FULL TIER. *arr reports BRRip/BDRip as plain "Bluray" and some WEBRips as
// "WEBDL", so srcRank() scores them 4 — identical to a real disc encode — and the gate above waved
// them straight through. Brennan, 2026-08-18: "if re-encodes are really bad, we should treat them
// like a chunky source tier downgrade."
//
// A full tier is the honest size of it, not a fudge factor: BRRip means disc -> rip -> re-encode,
// which is the SAME generation count as a WEBRip (stream -> re-encode), and WEBRip is already
// ranked 3. So dropping a re-encode from 4 to 3 puts it exactly where its provenance belongs.
//
// The release TITLE is the only place this shows — the quality name has already lost it — which is
// why REENC_RE tests titles and why the row carries its own `reenc` flag computed from the filename
// on disk. Both sides must be measured the same way, or a library that already holds a BRRip would
// refuse every other BRRip as a "downgrade" from itself and the row would offer nothing at all.
const REENC_TIER_COST = 1;
const effSrcRank = (rank, isReenc) => (rank == null ? null : rank - (isReenc ? REENC_TIER_COST : 0));
const srcDowngrade = (c, row) => {
  const n = effSrcRank(srcRank(c.source), REENC_RE.test(String(c.title || '')));
  const cur = effSrcRank(srcRank(row.source), !!row.reenc);
  return n != null && cur != null && n < cur;
};
// `section` decides the DISK-only source-tier gate above; omitting it (the force-grab paths)
// simply skips that gate, which is correct — those already know exactly which release the
// human picked and must not silently drop it.
function rankCands(cands, row, haveHashes, section) {
  // Filtered HERE as well as at verify time. Normally serve time is presentation only, but this
  // is a safety filter and applying it on the way out means the 173 verdicts just re-scraped are
  // cleaned immediately rather than after another two hours of re-verification.
  const safe = cands.filter((c) => !isRefused(c.title, row.origLang)
    && !(row.kind === 'season' && isMultiSeason(c.title))
    // DISK ONLY — see the block above. Serve-time so every cached verdict is cleaned on the way out
    // rather than needing a VERDICT_VERSION bump and a full re-scrape.
    && !(section === 'bitrate' && srcDowngrade(c, row))
    // A FRAMING ROW MUST ONLY BE ANSWERED BY FRAMING. An `imaxPrefer` row states one want: expanded
    // framing, same cut. Offering it the ordinary list is misleading — Dune (2021) asked for IMAX
    // and was headlined by a 37 GB scope REMUX, which spends 34 GB and gains ZERO of what the row
    // asked for, because a bigger scope encode is still scope. With none available the row renders
    // "nothing better available yet", which is true, and the Edition section keeps unactionable rows
    // visible on purpose so the finding survives. Ordinary Dune upgrades are untouched: they live in
    // the Upgrade and Disk sections.
    && !(row.imaxPrefer && !/\bimax\b/i.test(String(c.title || '')))
    // Already in the torrent client → ungrabbable (*arr answers 500) and pointless. Filtered here
    // as well as at verify time so the verdicts cached BEFORE this guard existed are cleaned on
    // the way out, instead of each needing a manual re-check.
    && !(haveHashes && c.infoHash && haveHashes.has(String(c.infoHash).toLowerCase())));
  return dedupeCands(safe).map((c) => {
    // MARKED, NOT FILTERED. A release we watched fail is still the human's to choose — swarms
    // revive, and the alternative might be worse — but it must arrive labelled and it must never
    // lead the sheet. Silently hiding it would also make the tab lie about how many options exist.
    const d = deadRelease(c.title);
    const e = enrichCand(c, row);
    if (!d) return e;
    // TWO DIFFERENT FACTS, TWO DIFFERENT BADGES. "dead swarm" means nobody is seeding it — a
    // maybe, worth showing greyed because swarms revive. "refused" means *arr scored it below the
    // file already on disk and will reject the import no matter what, so choosing it cannot work.
    // Labelling the second as a dead swarm sent Brennan chasing seeders for a scoring decision.
    // A REMEMBERED REFUSAL IS EVIDENCE, NOT LAW — and it is now the WEAKER evidence. This record
    // means "we downloaded it once and *arr rejected it", which was the only way to learn the
    // answer before the scores were readable. They are readable now, so when the arithmetic says
    // the release WOULD import, the arithmetic wins and the stale record is dropped.
    //
    // This is not hypothetical: softening two size scores on 2026-08-11 lifted Blazing Saddles'
    // 79-seed x265 BONE encode from refused to importable (300 against 280), and without this the
    // permanent record would have kept it greyed out forever — the profile change would have
    // silently done nothing for exactly the film it was made for.
    if (d.reason === 'cf_refused') {
      // Asks cfBlockedFor, NOT the raw `e.cfScore > row.cfScore` this used to. Same reason the
      // candidate list and the preflight now do: a refusal whose whole deficit is the size band is
      // one the import path forgives, so a record of it is stale the moment that logic lands.
      // Without this, every size-only cf_refused corpse already in state.json stays greyed out
      // forever and the fix appears not to work on exactly the films that provoked it.
      const nowFine = !cfBlockedFor(row, e.cfScore, e.cfFormats);
      if (!nowFine) return { ...e, refused: true };
      const dk = deadKey(c.title);
      if (dk) { auditDead.delete(dk); persistState(); }
      console.log(`audit: cleared the stale refusal on "${c.title}" — ${e.cfScore} against ${row.cfScore} on disk`
        + `, and *arr's objection is no longer anything that matters`);
      return e;
    }
    return { ...e, dead: true, deadAgeH: Math.max(1, Math.round((Date.now() - d.ts) / 3600000)) };
  })
    // Refused below dead below everything else: a release that CANNOT work is worse than one that
    // merely might not, and both are worse than any quality difference between the live options.
    .sort((a, b) => (Number(!!a.refused || !!a.cfBlocked) - Number(!!b.refused || !!b.cfBlocked))
      || (Number(!!a.dead) - Number(!!b.dead))
      || (a.srcDrop - b.srcDrop)
      || ((BAND_RANK[a.band] ?? 9) - (BAND_RANK[b.band] ?? 9))
      || (a.tier - b.tier)
      || (Number(a.reenc) - Number(b.reenc))
      || (b.seeders - a.seeders) || (b.saveGb - a.saveGb));
}

// ---- verification: does a genuinely better source exist? ──────────────────────────────────
// "Better" is section-specific, and both definitions REQUIRE 8-bit — a smaller file that
// cannot direct-play is not an upgrade, it just moves the cost from disk to CPU.
async function verifyRow(row, section, depthMap, seriesNorm, outSeen = null) {
  const { base, key } = arrOf(row.app);
  const url = row.app === 'sonarr'
    ? `${base}/release?seriesId=${row.id}&seasonNumber=${row.season}`
    : `${base}/release?movieId=${row.id}`;
  const rels = await (await tfetch(url, { headers: { 'X-Api-Key': key } }, 120000)).json();
  const list = Array.isArray(rels) ? rels : [];
  // What this row was last swapped TO, if anything — used to refuse offering it back.
  const already = auditSwapped.get(`${row.app}:${row.id}:${row.season ?? '-'}`) || null;
  // Torrents ALREADY in qBittorrent. A candidate whose infoHash is one of these is a release we
  // have already got — *arr cannot even grab it (qBittorrent rejects the duplicate and *arr
  // answers POST /release with HTTP 500, which is what "grab failed — HTTP 500" on Supernatural
  // S09 actually was). Better than the auditSwapped record for this purpose because it needs no
  // bookkeeping and so covers every swap done BEFORE that record existed. Cached 5s upstream, so
  // this costs nothing per verify. Empty set on failure — never hide candidates because qBit
  // hiccuped.
  let haveHashes = new Set();
  try { haveHashes = new Set((await getQbitTorrents()).map((t) => String(t.hash || '').toLowerCase())); }
  catch { /* qBit unreachable — fall through with an empty set */ }
  // THE SAME TORRENT, LISTED WITHOUT ITS HASH. The guard above is exact but only as good as the
  // indexer's metadata, and LimeTorrents returns infoHash:null on every result. One release is
  // therefore listed four times — EZTV, Knaben and TPB carry
  // 103a09a8…, LimeTorrents carries nothing — so three copies got filtered and the fourth was
  // offered as a candidate. That is how Frozen Planet II S01 came to propose replacing itself with
  // the byte-identical pack already imported on 2026-07-06 and still seeding in qBittorrent, and
  // why the grab died at qBittorrent's duplicate check (409) surfacing as Sonarr HTTP 500.
  //
  // The same search that returned the hashless copy also returned the hashed ones, so borrow it:
  // map normalised title -> infoHash across the whole result set, and let a hashless release
  // inherit its twin's hash for the purposes of these checks. Title normalisation is safe HERE in a
  // way it is not across items — every release in `list` has already passed the wrong-show and
  // wrong-season gates above, so a title collision means the same release, not a different film.
  const hashByTitle = new Map();
  for (const r of list) {
    if (!r.infoHash) continue;
    const n = normTitle(r.title);
    if (n) hashByTitle.set(n, String(r.infoHash).toLowerCase());
  }
  const hashOf = (r) => String(r.infoHash || hashByTitle.get(normTitle(r.title)) || '').toLowerCase() || null;
  // WHY A RELEASE IS NOT ON THE SHEET. Every gate below drops silently, which is fine while you are
  // reading the sheet and useless the moment you ask "where did that one go?". Rififi's Criterion
  // x265 sat in a two-day-old verdict, still listed by three indexers with 30 seeders, and clicking
  // it answered "no longer available from the indexers — tap Re-check": wrong component, wrong
  // remedy, and Re-check appeared to do nothing because the row simply re-rendered without it.
  //
  // Only collected when a caller asks (the confirm path does), so the normal sweep pays nothing.
  const drop = (r, why) => { if (outSeen) outSeen.push({ title: r.title || '', hash: hashOf(r), why }); };
  const cands = [];
  for (const r of list) {
    if ((r.seeders || 0) < 1) { drop(r, 'no seeders'); continue; }
    // WRONG-SHOW GUARD. *arr returns anything the indexer matched loosely, and the parsed
    // seasonNumber comes straight off the title — so "The.Fabric.of.the.Cosmos.S01" arrived
    // as a candidate to replace Cosmos S01, and Radarr offered "Sicario - The Complete
    // Collection" for Sicario. Use *arr's OWN mapping instead of the title:
    //   Sonarr  - mappedSeasonNumber is null unless it tied the release to a real season of
    //             the series we queried. (mappedSeriesId is NOT usable: it was null even for
    //             the legitimate "Cosmos:A.Space-Time.Odyssey.S01" release.)
    //   Radarr  - mappedMovieId is the queried id, or null for collections/foreign retitles.
    // A title-similarity check cannot substitute here: the series title "Cosmos" is a subset
    // of "The Fabric of the Cosmos", so token overlap passes the very release we must drop.
    if (row.app === 'sonarr') {
      if (!r.fullSeason) { drop(r, 'not a full-season pack'); continue; }
      if (r.mappedSeasonNumber !== row.season) { drop(r, 'parses as a different season'); continue; }
      // mappedSeasonNumber says "parses as season N", NOT "belongs to this series" — House of
      // the Dragon and House of Cards both came back mapped=1 for a "House" search. Settle it
      // on the release's own parsed seriesTitle, disambiguated against the whole library.
      if (seriesNorm && bestSeriesMatch(r.seriesTitle, seriesNorm) !== row.id) { drop(r, 'parses as a different series'); continue; }
    } else if (r.mappedMovieId !== row.id) {
      // mappedMovieId is null in TWO very different cases, and they must not be treated alike:
      //   * a release that IS this movie but whose title Radarr could not parse. The indexer
      //     still tagged it with the movie's IMDb id — e.g. The Blues Brothers' best theatrical
      //     encode arrives as "The Blues Brothers*1980*TC[1080p...x264-LEON]" with rejection
      //     "Unable to parse release" yet imdbId 80455, and the 7.9GB BDrip carries 80455 too.
      //   * a collection/foreign retitle (rejection "Unknown Movie"), which carries imdbId 0 or
      //     another film's id and MUST stay dropped.
      // The signal is strong but NOT infallible, and the margin is worth stating: indexers do
      // mis-tag. Measured against live Radarr data on 2026-07-31, this admits 0 extra releases for
      // Sicario (the "Complete Collection" case this guard was written for — it stays dropped) and
      // 9 for The Blues Brothers, of which "Blues Brothers 2000 AC3 DivX" is the SEQUEL carrying
      // the original's imdbId 80455. So an indexer-supplied id can be wrong; what keeps that
      // harmless is that the /1080p/ and codec gates below drop the mis-tagged junk, which is
      // uniformly DVD-era and unseeded. Every 1080p release this admits was the correct film.
      // The IMDb id is the tie-breaker: admit only when it matches the movie the row is for, and
      // only in the null case — a mappedMovieId that names a DIFFERENT movie is *arr telling us
      // this release is something else, and that is still a hard drop.
      if (r.mappedMovieId != null) { drop(r, '*arr matched it to a different movie'); continue; }
      const relImdb = Number(String(r.imdbId || '').replace(/^tt/i, '').replace(/^0+/, ''));
      const rowImdb = Number(String(row.imdbId || '').replace(/^tt/i, '').replace(/^0+/, ''));
      if (!relImdb || !rowImdb || relImdb !== rowImdb) { drop(r, 'no matching IMDb id'); continue; }
    }
    const t = r.title || '';
    if (!/1080p/i.test(t)) { drop(r, 'not 1080p'); continue; }
    // A pack spanning several seasons is not a replacement for one season — see MULTI_SEASON_RE.
    if (row.kind === 'season' && isMultiSeason(t)) { drop(r, 'a multi-season pack, not this season'); continue; }
    // Camrips and dubs are never a trade worth presenting — see CAM_RE / DUB_RE.
    // origLang MUST be passed: it is the only escape from isForeignOnly's language tests, so
    // without it a bare tag that IS this item's original audio gets refused (Das Boot's GERMAN
    // pack, a Cyrillic-titled Russian film). The sibling call site at ~line 528 always passed it;
    // this one did not, which made the gate quietly stricter here than anywhere else.
    if (isRefused(t, row.origLang)) { drop(r, 'camrip or dub'); continue; }
    // EDITION. Refused outright, alongside CAM and dubs, because a cut is not a quality trade-off:
    // Brennan, 2026-07-30 — "A theatrical cut of apocalypse, LOTR, or blade runner is garbage and
    // should never be on disk, ever, for any reason. Same as dubs or screenrips." Two rules, in
    // editionRefusal: never below the cut we already own, and never below a floored film's minimum.
    // MOVIES ONLY — row.edition is set only on radarr rows. A season has no edition, and inventing
    // one from an episode filename would refuse legitimate TV candidates for no gain.
    if (row.edition && editionRefusal(t, row.edition, row.title)) { drop(r, 'the wrong cut'); continue; }
    // ABOVE 1080p is unplayable on every device here, so it is refused rather than ranked. *arr's
    // profile already stops at 1080p for its own searches, but the Edition and Upgrade sections
    // deliberately relax the other picture gates, and without this the Upgrade tab would have
    // labelled "+ 2160p" a GAIN and recommended a file that cannot be played.
    if (overResCeiling(t)) { drop(r, 'above the 1080p ceiling'); continue; }
    // NEVER OFFER BACK THE RELEASE THIS ROW WAS ALREADY SWAPPED TO. Matched on the recorded
    // infoHash (exact) or release title, not on size/source — a size-and-source heuristic looks
    // equivalent but rejects 56 of 338 Playback candidates, because "same source, same size,
    // unproven depth → proven 8-bit" IS the swap this section exists to offer. See auditSwapped.
    // EXCEPTION: a record with reason:'dead' (swap abandoned because the swarm had no seeders) is
    // only a negative cache, not a final verdict — swarms revive, so it expires after
    // DEAD_REFUSE_TTL_MS and the release can be offered again.
    if (already && (already.reason !== 'dead' || Date.now() - (already.ts || 0) < DEAD_REFUSE_TTL_MS)
      && ((already.hash && hashOf(r) === already.hash)
        || (already.rel && normTitle(already.rel) === normTitle(t)))) { drop(r, 'this row was already swapped to it'); continue; }
    // Already downloaded and sitting in the torrent client — ungrabbable and pointless. See above.
    const rHash = hashOf(r);
    if (rHash && haveHashes.has(rHash)) { drop(r, 'already in the download client'); continue; }
    // FOREIGN-AUDIO-ONLY, decided by *arr's own parse rather than by guessing from the title.
    // DUB_RE catches explicit dub/MULTi markers and a few languages, but it deliberately lets a
    // BARE language tag through so a foreign film can keep its original audio (Das Boot's lone
    // German track is correct). That reasoning only holds when the tag IS the original language —
    // "Silicon.Valley.S02.ITA.1080p.x264" parses as Italian ONLY for an English-original show,
    // i.e. a dub with no English track, and it sailed past the regex.
    //
    // Refuse when *arr parsed a definite language set that contains neither English nor the
    // item's own original language. "Unknown" is discarded first: it means *arr could not tell,
    // and treating that as foreign would reject most of the catalogue.
    const relLangs = (r.languages || []).map((l) => String((l || {}).name || '')).filter((n) => n && n !== 'Unknown');
    if (relLangs.length && !relLangs.includes('English')
      && !(row.origLang && relLangs.includes(row.origLang))) { drop(r, 'audio is neither English nor the original language'); continue; }
    // AMBIGUOUS, not refused. When *arr parsed nothing usable we genuinely do not know what audio
    // this release carries — refusing would throw away most of the catalogue, and staying silent
    // is how an Italian-only pack looked safe. Offer it, flagged, so the choice is informed.
    const langWarn = !relLangs.length;
    const depth = depthOf(t, depthMap);
    // EDITION is exempt from every playback/size test below. Getting the RIGHT CUT is the whole
    // point of that section, and the correct answer is routinely a 10-bit 2160p HDR remaster that
    // the Playback rules would refuse outright — Blade Runner's best Final Cuts are exactly that.
    // Nothing is hidden: depth, tier and devices still render on the card, and the ranking below
    // already puts known-8-bit first, so a human sees the decode cost before choosing.
    const isEd = section === 'edition';
    // UPGRADE is the "show me everything genuinely better" section. Brennan chose "better on >=1 axis,
    // tradeoffs allowed but LABELLED", so it must not inherit Playback's tier gate or Disk's
    // must-be-smaller rule — both would hide real upgrades (a 2160p HDR remaster fails the first, and
    // every larger-but-better release fails the second). The tradeoff is computed below and shipped on
    // the card so the human sees what is being given up rather than being protected from the choice.
    const isUp = section === 'upgrade';
    const loose = isEd || isUp;
    if (!loose && (depth === '10bit' || depth === 'mixed')) { drop(r, '10-bit or unproven-depth HEVC'); continue; }   // pessimistic: only 8bit or a clean unknown survives
    let isHevc = /x265|h\.?265|hevc/i.test(t);
    let isH264 = /x264|h\.?264|avc/i.test(t);
    // CODE-CUT GATE. The strict sections (cpu/bitrate) need a codec token in the title to judge
    // playback at all, so they keep requiring one. But EDITION and UPGRADE exist to find the RIGHT
    // CUT, and the indexers truncate titles at ~59 chars — The Fellowship of the Ring's best
    // copies arrive as "...EXTENDED.1080p.BluRay." with the x264 tag chopped off, and REMUXes name
    // the container, not the codec. A title-token requirement therefore hid every Extended 1080p
    // candidate and produced a bogus "no better edition exists" verdict for a film with 51/137
    // extended/final-cut releases on the indexers right now. *arr's PARSED quality is reliable
    // where the title is not, so for loose sections a known <=1080p video SOURCE substitutes for
    // the title token. Inferred codec is H.264 — the standard 1080p sources (Bluray/Remux/WEBDL/
    // Webrip/HDTV/BRRip) are overwhelmingly AVC — but depth stays whatever the title says (usually
    // unknown), so a hidden HEVC is never misrepresented as proven; it merely stops being hidden
    // behind a "none better" verdict. Resolution is re-checked from the parsed quality too: a title
    // truncated before its 2160p marker would otherwise sail past overResCeiling above.
    if (!isHevc && !isH264) {
      if (!loose) { drop(r, 'no codec named in the title'); continue; }
      const qName = String(((r.quality || {}).quality || {}).name || '');
      const qRes = ((r.quality || {}).quality || {}).resolution || null;
      if (qRes == null || qRes > 1080) { drop(r, 'above the 1080p ceiling'); continue; }
      if (!/(bluray|remux|web-?dl|webrip|hd-?tv|br-?rip|hdr.?rip)/i.test(qName)) { drop(r, 'unrecognised source'); continue; }
      isH264 = true;
    }
    // NEVER suggest a playback regression. House S01 is x264 8-bit — it direct-plays on every
    // device here — so an HEVC "saving" would cost the PS4 a transcode, and an unproven-depth
    // HEVC risks landing another CPU-decode file. A candidate must be no worse than what we
    // already have on this axis, whatever it saves on disk.
    const cTier = playTierOf(isHevc ? 'HEVC' : 'H.264', depth || 'unknown');
    // Tier 3 is never a DESTINATION. Unproven depth may be 10-bit, and with
    // EnableDecodingColorDepth10Hevc=false that means the NUC software-decodes 1080p HEVC on
    // every play — the exact backlog the Playback section exists to drain. Not a picture-
    // quality trade; a "might not play smoothly" trade.
    if (!loose && cTier >= 3) { drop(r, 'unproven bit depth'); continue; }
    const cSrc = ((r.quality || {}).quality || {}).name || null;
    const cSrcRank = srcRank(cSrc);
    const curSrcRank = srcRank(row.source);
    // EFFECTIVE ranks, so a re-encode is judged by its provenance rather than by the label *arr gave
    // it. Measured 2026-08-18: 187 of 886 library files (21%) are re-encodes, and 110 of those are
    // reported as plain "Bluray-1080p" — Forrest Gump, Saving Private Ryan, Back to the Future among
    // them. With raw ranks a real disc encode scored 4 against their 4, so replacing a BRRip with the
    // genuine article did not register as a source upgrade at all and was never offered.
    const cReenc = REENC_RE.test(t);
    const cSrcEff = effSrcRank(cSrcRank, cReenc);
    const curSrcEff = effSrcRank(curSrcRank, !!row.reenc);
    const srcUpgrade = cSrcEff != null && curSrcEff != null && cSrcEff > curSrcEff;
    if (section === 'cpu') {
      // Playback is this section's purpose, so a tier improvement qualifies — but a SOURCE
      // upgrade now qualifies too, even at the same tier and even if the file is BIGGER.
      // WEBRip -> Bluray is a genuine improvement, and the point of this tab is to surface the
      // options and let a human decide when size is worth it.
      if (cTier >= (row.tier || 3) && !srcUpgrade) { drop(r, 'neither a playback nor a source improvement'); continue; }
    } else if (!loose && cTier > (row.tier || 3) + TIER_SLACK) { drop(r, 'too big a step down in decode cost'); continue; }
    // ---- SOURCE TIER IS A CEILING, AND THE DISK SECTION MUST NOT TRADE IT AWAY ----------------
    // `srcDrop` has always been COMPUTED (enrichCand) and rendered as a "↓" on the card, but it was
    // explicitly a presentation signal, never a filter. In the Disk section that is the wrong call
    // and it produced exactly the suggestion Brennan flagged on 2026-08-18: Peaky Blinders S04,
    // 27 GB Bluray, whose only offers were 6.0 GB and 6.3 GB HDTV rips.
    //
    // WHY BPP+ CANNOT SEE THIS, and why a badge is not enough. Source tier is WHAT THE RELEASE WAS
    // MADE FROM, and it caps how good the picture can be at ANY bitrate: an off-air HDTV capture
    // carries broadcast compression, station logos and sometimes trimmed content, and no number of
    // bits undoes damage that is already in the master. It is the same structural fact the grain
    // work landed on — BPP+ measures SUPPLY against content, and is blind to the quality of the
    // master that content came from. Brennan, 2026-08-18: "I've never found a good way to rectify
    // bluray/webdl/webrip/hdtv into bpp+ besides just having it as a separate badge." Correct — it
    // is not a bitrate axis, so it has to be a GATE rather than a term.
    //
    // SCOPED TO THE DISK SECTION ONLY. Playback (cpu) already requires a playback or source
    // improvement. Upgrade and Edition are deliberately permissive ("better on >=1 axis, tradeoffs
    // LABELLED") and a human is choosing there with the drop shown. But Disk's entire premise is
    // "you are over-supplied for your content" — which assumes the SAME master. Swapping to a worse
    // one is not reclaiming waste, it is buying a worse picture with the space.
    // Computed BEFORE the size filters below, which now consult q.ratio.
    const candMbps = row.mbps ? +(row.mbps * (r.size / row.bytes)).toFixed(1) : null;
    const q = qualityBand(row.mbps, candMbps, (row.tier || 1) !== 1, isHevc);
    // Same scaling, expressed in the unit the UI actually shows. Estimated from size, not probed —
    // see candBppFrom(). `priority` is what raises the floor from "one band down" to "never below
    // green": the profile is where Brennan records that a film is supposed to look its best.
    const candBpp = candBppFrom(row.bpp, row.bytes, r.size, (row.tier || 1) !== 1, isHevc,
      resOf(row.source), resOf(t));
    const priority = !!(row.beloved || row.top100 || String(row.profile || '').startsWith('Beloved'));
    if (loose) {
      // No size test at all beyond a sanity cap. The correct cut can be far larger (a 2.2 GB
      // theatrical x264 against a 56 GB Final Cut REMUX is a real pair from this library), and
      // "too big" is a judgement for the person who chose to fix the edition. The floor is the
      // guard that matters here and it already ran, at the top of this loop.
      if (r.size > row.bytes * 30) { drop(r, 'more than 30x the current size'); continue; }
    } else if (section === 'cpu') {
      // Goal is playability, and a bigger file is an acceptable price for it. The old 1.6x cap
      // hid exactly the upgrades worth having — a Bluray-sourced replacement for a WEBRip is
      // routinely 2-3x the size. A source upgrade gets more headroom still; anything beyond
      // these is a Remux, which is a different purchase, not a replacement.
      if (r.size > row.bytes * (srcUpgrade ? 5 : 3)) { drop(r, 'too large a jump in size'); continue; }
    } else {
      // Goal is disk. Must actually be smaller, and not so small it is a different product.
      if (r.size >= row.bytes * 0.9) { drop(r, 'not smaller than the current file'); continue; }
      // AGGRESSIVE_FLOOR is a junk filter, not a quality judgement. The content-aware
      // minRatioFor() value used to REJECT here, which silently hid legitimate trades Brennan
      // wanted to weigh himself (a 31% YTS encode may be wrong for grainy film and fine for a
      // sitcom). It is now carried as `belowFloor` so the UI can flag it and the human decides.
      if (row.mbps && q.ratio != null && q.ratio < AGGRESSIVE_FLOOR) { drop(r, 'far below the bitrate floor'); continue; }
    }
    // NOT a refusal — see candidateBandOk(). Carried onto the candidate so the sort can sink it
    // below the good trades while still offering it.
    const bandWeak = !candidateBandOk(candBpp, row.bpp, priority, row.key);
    // Retained for the UI's caution flag only — the refusal above is what actually protects the
    // library now. A candidate can still be "below the old content-aware floor" and perfectly
    // acceptable in absolute terms, which is precisely why this stopped being a rejection.
    const belowFloor = !!(row.mbps && q.ratio != null && q.ratio < (row.minRatio ?? 0.30));
    // ---- UPGRADE: what is actually BETTER here, and what is being given up? -------------------
    // Brennan's rule: "better on >=1 axis, tradeoffs allowed but labelled". So this computes both
    // sides explicitly instead of collapsing to one score — a single number cannot tell you that a
    // release gains 2160p while losing the source tier, and that distinction is the whole reason he
    // wanted this tab rather than accepting a top pick.
    //
    // Each axis is only judged when BOTH sides are known. An unknown is not a gain and not a loss:
    // guessing either way is how "no edition stated" and "depth unknown" turned into false claims
    // elsewhere in this file.
    const gains = [], losses = [];
    if (isUp) {
      // COMPLETENESS IS THE UPGRADE when what we hold is not the whole film. Every axis below asks
      // "is the picture/source/audio better?", and against a truncated file those are the wrong
      // questions: Chinatown's 8.53 GB AMIABLE Bluray was dropped as "nothing measurably better than
      // what is on disk" because it is the same source, same resolution, and only 12% up on BPP+ —
      // under the 15% threshold for a bitrate pill — so `gains` came out EMPTY. It was compared
      // against 68 minutes of a 130-minute film and judged no better than it.
      //
      // A full-length release is a presumption here, not a proof: nothing can measure a candidate's
      // runtime before it is downloaded. That is precisely what the swap's runtime preflight is for —
      // it refuses a short download before a single original is deleted — so presuming completeness
      // at RANKING time is now safe in a way it was not before that gate existed.
      if (row.short) gains.push('the complete film');
      // Same reasoning for a file *arr cannot read: with no bpp, no tier and no codec on OUR side
      // there is no axis to be "measurably better" than, so `gains` would come out empty and every
      // candidate would be dropped as "nothing measurably better" — leaving the row permanently
      // stuck at "nothing better found". A readable file IS the improvement.
      else if (row.unprobed) gains.push('a file the server can actually read');
      const curRes = resOf(row.source), candRes = resOf(t);
      // Capped at MAX_USABLE_RES on both sides: resolution is an improvement only up to 1080p, and
      // anything above it never reaches here anyway (refused above).
      const capRes = (n) => (n == null ? null : Math.min(n, MAX_USABLE_RES));
      const cR = capRes(curRes), kR = capRes(candRes);
      if (cR != null && kR != null && kR !== cR) {
        (kR > cR ? gains : losses).push(`${kR}p`);
      }
      if (cSrcRank != null && curSrcRank != null && cSrcRank !== curSrcRank) {
        (cSrcRank > curSrcRank ? gains : losses).push(`${cSrc} source`);
      }
      // Bitrate: MORE is better here. This is the mirror image of the Disk section, where less is the
      // goal — same number, opposite meaning, which is exactly why they are separate sections.
      // Stated in BPP+, not Mbps — the rest of the app dropped raw Mbps on 2026-08-01 and a lone
      // "+2.7 Mbps" pill next to a "26 bpp+" figure asked the reader to hold two incompatible
      // scales at once. Falls back to the Mbps comparison only when bpp is unavailable on either
      // side, which is rare and better than saying nothing.
      const curPlus = bppIndex(row.bpp, row.key), cndPlus = bppIndex(candBpp, row.key);
      if (curPlus && cndPlus && Math.abs(cndPlus - curPlus) / curPlus > 0.15) {
        (cndPlus > curPlus ? gains : losses).push(`${cndPlus} bpp+`);
      } else if (!curPlus && row.mbps && candMbps && Math.abs(candMbps - row.mbps) / row.mbps > 0.15) {
        (candMbps > row.mbps ? gains : losses).push(`${candMbps} Mbps`);
      }
      // Playback tier: LOWER is better (1 = direct-plays everywhere). A 10-bit HDR gain in picture is
      // a real loss in decode cost on this NUC, and the tab must say so rather than hide it.
      //
      // SEVERITY MATTERS, and this is the line Brennan drew (2026-07-30): "We shouldnt offer upgrades
      // that are significant downgrades like device compat. Slight device compatibility downgrade
      // (ps4 green to orange, web green to orange for example is OK) but nuc green to red is not."
      //
      // The distinction is what the colour MEANS per device, not how many devices change:
      //   ok → tx  on Fire / PS4 / Web  = the SERVER transcodes it. Costs CPU, still plays. Amber.
      //                                   A labelled tradeoff, which is what the loss pill is for.
      //   ok → no  on the NUC           = 10-bit exceeds the Iris 540's hardware decoder, so the box
      //                                   that has to decode EVERYTHING falls back to software. Red.
      // Red on the NUC is not a tradeoff to weigh, it is a worse experience on every client at once,
      // so it is a hard refusal here rather than a loss pill. Deliberately narrow: it fires only when
      // the copy we ALREADY have is fine on the NUC, so it can never block a lateral 10-bit → 10-bit
      // move or trap a library that is already in the bad state.
      const nucNow = devNuc(row.tier || 3), nucCand = devNuc(cTier);
      if (nucNow === 'ok' && nucCand === 'no') { drop(r, 'the NUC would have to software-decode it (bit depth unproven)'); continue; }
      if (cTier < (row.tier || 3)) gains.push('plays on more devices');
      else if (cTier > (row.tier || 3)) losses.push(TIER_NOTE[cTier] || 'harder to decode');
      const candAudio = audioOf(t);
      if (candAudio && AUDIO_RANK[candAudio] >= 4) gains.push(candAudio);
      // Nothing better on any axis we can actually measure = not an upgrade, just a different file.
      if (!gains.length) { drop(r, 'nothing measurably better than what is on disk'); continue; }
    }
    cands.push({ title: t, bytes: r.size, seeders: r.seeders || 0, score: r.customFormatScore ?? 0,
      // Identity for the replace endpoint. guid is what *arr's grab call takes; infoHash lets
      // replaceSweep find THIS download in qBittorrent rather than guessing from progress.
      // hashOf(), not r.infoHash: a hashless LimeTorrents copy of a release the other indexers DID
      // hash used to start a swap with hash:null, which replaceSweep can only track by guessing —
      // the exact shape of the Frozen Planet II record that sat "starting" for 24 hours.
      guid: r.guid, indexerId: r.indexerId, infoHash: hashOf(r),
      depth: depth || 'unknown', codec: isHevc ? 'HEVC' : 'H.264',
      // Source tier (Bluray-1080p / WEBDL-1080p / WEBRip-1080p ...). A better quality signal
      // than the bitrate ratio: a Bluray-sourced encode has no prior generation loss, whereas
      // a WEBRip was already compressed once before this encode touched it.
      source: cSrc,
      // WHICH CUT this release is. Carried on every section's cards, not just Edition: a Playback
      // or Disk swap that happens to change the cut is something a human must be able to see.
      edition: editionOf(t).label,
      // Labelled tradeoffs for the Upgrade tab. Empty arrays elsewhere — the other sections have their
      // own single-axis story and would only be made noisier by this.
      gains, losses,
      band: q.band, ratio: q.ratio, belowFloor, minRatio: row.minRatio ?? 0.30,
      // langWarn: *arr could not determine this release's audio language. Not a refusal — a
      // "check this one" flag, since a silent unknown is what let an Italian-only pack look safe.
      langWarn, langs: relLangs.length ? relLangs : null,
      tier: cTier, play: TIER_NOTE[cTier], devices: deviceSupport(isHevc ? 'HEVC' : 'H.264', depth || 'unknown'),
      saveGb: gb(Math.max(0, row.bytes - r.size)),
      mbps: row.mbps ? +(row.mbps * (r.size / row.bytes)).toFixed(1) : null,
      bpp: candBpp, bppPlus: bppIndex(candBpp, row.key), bppBand: bppBand(candBpp, row.key), bppRSE: bppRSE(row.key), bppArt: bppArtifact(row.key),
      cxBasis: bppBasis(row.key), bandWeak,
      // WILL *ARR EVEN ACCEPT THIS? Both scores come from the same custom formats, so the
      // comparison *arr makes at import time can be made HERE, before anything is downloaded.
      // Strictly greater, because that is *arr's own test — a tie is refused, which is exactly
      // how Blazing Saddles' two 310-point YIFY copies would have gone.
      //
      // MARKED, NOT FILTERED, for the same reason a dead swarm is: the number is *arr's judgement,
      // not a fact about the file, and Brennan may want to see that the only 8-bit option scores
      // below what is on disk. It just must never be offered as if it could work.
      cfScore: typeof r.customFormatScore === 'number' ? r.customFormatScore : null,
      // The format NAMES, not just the sum, because "is this refusal only about bytes?" cannot be
      // answered from a total. Carried on the candidate so a cached verdict can be re-judged at
      // serve time by cfBlockedFor without re-running the search.
      cfFormats: Array.isArray(r.customFormats) ? r.customFormats.map((c) => c && c.name).filter(Boolean) : null,
      cfBlocked: cfBlockedFor(row, typeof r.customFormatScore === 'number' ? r.customFormatScore : null,
        Array.isArray(r.customFormats) ? r.customFormats.map((c) => c && c.name).filter(Boolean) : null),
      cfNeed: typeof row.cfScore === 'number' ? row.cfScore : null });
  }
  // Rank: known 8-bit first, then seeders — availability matters as much as the numbers.
  // QUALITY first, then playback tier, then seeders. Ranking on seeders (or on savings)
  // ahead of quality is what pushed a quarter-bitrate release to the top of Yellowstone S01.
  // Savings is the LAST tiebreak: it is the reward, never the reason.
  // `bandWeak` first: a candidate that is compromised in ABSOLUTE terms is still offered (the
  // human decides), but it must never lead the sheet. Everything after it is the pre-existing
  // ordering, unchanged.
  // cfBlocked ahead of even bandWeak: "*arr will reject this" outranks every quality judgement
  // below it, because none of them can happen. This is also what keeps `best` (top[0], which the
  // sweep may act on unattended) from ever being a release that cannot import.
  cands.sort((a, b) => (Number(!!a.cfBlocked) - Number(!!b.cfBlocked))
    || (Number(a.bandWeak) - Number(b.bandWeak))
    || (BAND_RANK[a.band] - BAND_RANK[b.band])
    || (a.tier - b.tier) || (b.seeders - a.seeders) || (b.saveGb - a.saveGb));
  // 12, not 6. This is the deliberate "present the options, let the human choose" call: with
  // aggressive trades no longer filtered out, six slots filled up with near-identical safe
  // picks and the interesting extremes never reached the sheet. The final ordering is applied
  // at SERVE time by rankCands(), so this sort only decides which survive the cut.
  const top = cands.slice(0, MAX_CANDIDATES);
  // `best` is what the unattended sweep grabs and what the row summary advertises, so it must be a
  // release that can actually land. When every option is cfBlocked the honest answer is "options
  // exist, none of them can import" — the candidates still render (greyed) so the reason is visible,
  // but nothing is held up as the pick.
  const bestOk = top.find((c) => !c.cfBlocked) || null;
  return top.length
    ? { v: VERDICT_VERSION, ts: Date.now(), state: bestOk ? 'improvable' : 'blocked', best: bestOk, candidates: top }
    : { v: VERDICT_VERSION, ts: Date.now(), state: 'none', reason: `${list.length} releases, none better and 8-bit` };
}

function verdictFor(key, section) {
  const v = auditVerdicts.get(`${section}:${key}`);
  if (!v) return null;
  if (v.v !== VERDICT_VERSION) return null;   // computed under older filter rules — treat as unchecked
  if (Date.now() - v.ts > VERDICT_TTL_MS) return { ...v, stale: true };
  return v;
}

// ---- night window + manual sessions (shared by BOTH paced audit sweeps) ──────────────────────
//
// Brennan, 2026-08-09: "This should be a nightly cron along with the existing audit cron… It should
// only be running at this time of day if it was requested manually."
//
// Both sweeps used to tick around the clock — the source check every 45s, the upgrade scan every
// 60s — which meant the box was running paced indexer searches while somebody was using it, and a
// card reading `running` at 3pm looked like a job somebody had started when it was just the
// schedule. Now they behave like the probe: work happens inside the night window, and daytime
// running means exactly one thing — a human asked for it.
//
// Same window as the probe by default (01:00–06:00 local). They do not contend: the probe is CPU
// (an x265 encode), these are network (one indexer search), and both defer to Movie Mode.
const AUDIT_WINDOW_START = Number(cfg.AUDIT_WINDOW_START || 1);   // local hour, inclusive
const AUDIT_WINDOW_END = Number(cfg.AUDIT_WINDOW_END || 6);       // local hour, exclusive

function inAuditWindow(d = new Date()) {
  const h = d.getHours();
  // A window written START > END wraps midnight (e.g. 23 -> 6); handle both forms.
  return AUDIT_WINDOW_START <= AUDIT_WINDOW_END
    ? (h >= AUDIT_WINDOW_START && h < AUDIT_WINDOW_END)
    : (h >= AUDIT_WINDOW_START || h < AUDIT_WINDOW_END);
}

// A manual session paces FASTER than the nightly sweep but is still paced. The 45–60s nightly
// interval is a promise to public indexers, and it is affordable overnight because nobody is
// waiting; a human who pressed Run is waiting, and 754 films at 60s is 12 hours, which is not a
// thing anyone sits through. 10s puts a full upgrade pass at ~2h — which is the shape Brennan
// already had in mind for the audit ("takes about 2hrs").
const AUDIT_SESSION_GAP_MS = Number(cfg.AUDIT_SESSION_GAP_MS || 10000);

// jobId -> { startedAt, searches, stopping }. Deliberately NOT persisted: unlike the probe (whose
// session survives a restart because a 4-hour measuring run is expensive to lose), a re-checked
// verdict is cached, so a restart mid-session loses nothing but the pacing.
const auditSessions = new Map();
const auditSessionSoon = new Map();
// Filled in by startAudit() once the tick functions exist — a session drives its own sweep
// back-to-back rather than waiting for the next interval, exactly like the probe.
const AUDIT_TICKS = {};

function auditSessionFor(jobId) {
  const s = auditSessions.get(jobId);
  return s && !s.stopping ? s : null;
}

function scheduleAuditSessionTick(jobId) {
  if (!auditSessionFor(jobId) || auditSessionSoon.has(jobId)) return;
  auditSessionSoon.set(jobId, setTimeout(() => {
    auditSessionSoon.delete(jobId);
    const fn = AUDIT_TICKS[jobId];
    if (fn) fn().catch(() => { });
  }, AUDIT_SESSION_GAP_MS));
}

function auditSessionStart(jobId) {
  const live = auditSessionFor(jobId);
  if (live) return live;
  const s = { startedAt: Date.now(), searches: 0, stopping: false };
  auditSessions.set(jobId, s);
  console.log(`audit: MANUAL SESSION started for ${jobId} — ignoring the night window, one search`
    + ` every ${Math.round(AUDIT_SESSION_GAP_MS / 1000)}s. Movie Mode still applies. Runs until stopped or done.`);
  metrics.emitEvent('audit_session', { job: jobId, act: 'start' });
  // Flip the button HERE rather than letting the next tick do it — see auditSessionStop().
  jobs.report(jobId, { actions: ['stop-sweep'] });
  scheduleAuditSessionTick(jobId);
  return s;
}

function auditSessionStop(jobId, why = 'stopped by request') {
  const s = auditSessions.get(jobId);
  if (!s) return null;
  s.stopping = true;
  const t = auditSessionSoon.get(jobId);
  if (t) { clearTimeout(t); auditSessionSoon.delete(jobId); }
  const summary = { searches: s.searches, mins: Math.round((Date.now() - s.startedAt) / 60000) };
  auditSessions.delete(jobId);
  console.log(`audit: MANUAL SESSION ended for ${jobId} (${why}) — ${summary.searches} searches in ${summary.mins} min`);
  metrics.emitEvent('audit_session', { job: jobId, act: 'stop', n: summary.searches, min: summary.mins, why });
  // HAND THE CARD BACK ITS RUN BUTTON. This is the probe's hard-won lesson repeated: everything a
  // session writes to the card is written PAST the window gate, so after a daytime stop the next
  // tick returns at the gate and nothing downstream ever resets it — the card would keep a Stop
  // button for a session that no longer exists, with no way back to Run. State a session owns must
  // be cleared by the session's own end.
  jobs.report(jobId, { actions: ['start-sweep'], stateOverride: null, detail: '', etaMs: null });
  return summary;
}

// The gated (out-of-window, no session) path still wants the card to show where the backlog stands
// — Brennan asked for progress bars that "essentially always render". Rebuilding rows for that
// would be ~100 *arr calls every 45s all day, so this reports ONLY from a warm cache (warmTick
// refreshes it every 9 min, inside the 12 min TTL) and otherwise leaves the last figures standing.
function cachedRows() {
  return (_rowCache.rows && Date.now() - _rowCache.ts < ROW_CACHE_MS) ? _rowCache.rows : null;
}

// The source check's backlog + its Jobs-tab figures, in one place so the gated path and the working
// path can never disagree about what "left" means.
//
// Worst-first, and only rows with no fresh verdict. EDITION rows go FIRST regardless of size: there
// are only a handful (5 today) and they are the only section where the current file is not merely
// inefficient but the WRONG FILM, so making them wait behind ~140 size-ranked rows would leave them
// unverified for hours.
function verifyWorkList({ cpu, bitrate, edition }) {
  return [...edition.map((r) => ['edition', r]), ...cpu.map((r) => ['cpu', r]), ...bitrate.map((r) => ['bitrate', r])]
    .filter(([sec, r]) => !verdictFor(r.key, sec) || verdictFor(r.key, sec).stale)
    .sort((a, b) => (a[0] === 'edition' ? -1 : 0) - (b[0] === 'edition' ? -1 : 0) || b[1].bytes - a[1].bytes);
}

function reportVerifyProgress(rows) {
  const work = verifyWorkList(rows);
  const total = rows.edition.length + rows.cpu.length + rows.bitrate.length;
  // One search per tick, so remaining ticks × the gap IS the ETA — and the gap depends on who is
  // driving. A session paces at AUDIT_SESSION_GAP_MS; the nightly sweep at VERIFY_EVERY_MS.
  const gap = auditSessionFor('audit-verify') ? AUDIT_SESSION_GAP_MS : VERIFY_EVERY_MS;
  jobs.report('audit-verify', { progress: { done: total - work.length, total }, etaMs: work.length * gap });
  return work;
}

// ---- the paced background verifier ────────────────────────────────────────────────────────
let verifyTimer = null;
async function verifyTick() {
  if (isMasterPaused() || auditBusy) return;
  const manual = !!auditSessionFor('audit-verify');
  // NIGHTLY unless a human asked. Progress is still reported from cache so the card stays honest.
  if (!manual && !inAuditWindow()) {
    const rows = cachedRows();
    if (rows) reportVerifyProgress(rows);
    return;
  }
  auditBusy = true;
  try {
    // buildRows is ~100 *arr calls on a cold cache, so re-check the pause flag immediately
    // before it and again before the indexer search: Movie Mode can be switched on at any
    // point during a tick, and the whole purpose is to leave the NUC alone while streaming.
    if (isMasterPaused()) return;
    const rows = await buildRows();
    const { depthMap, seriesNorm } = rows;
    if (isMasterPaused()) return;
    // Report progress to the Jobs tab BEFORE the early return, so a fully-warm cache reads as
    // "all verified" rather than freezing on whatever count the last incomplete pass left behind.
    const work = reportVerifyProgress(rows);
    if (!work.length) {
      // Nothing left to check — a manual session has done what it was asked for and ends itself,
      // handing the card its Run button back. The nightly sweep just idles until something goes stale.
      if (manual) auditSessionStop('audit-verify', 'everything re-checked');
      return;
    }
    const [section, row] = work[0];
    try {
      const v = await verifyRow(row, section, depthMap, seriesNorm);
      auditVerdicts.set(`${section}:${row.key}`, v);
      console.log(`audit: ${section} "${row.title}" -> ${v.state}`
        + (v.best ? ` (best: ${v.best.codec} ${v.best.depth}, save ${v.best.saveGb} GB, ${v.best.seeders} seeds)` : ''));
    } catch (e) {
      // Record the failure with a timestamp so one dead indexer can't make this row spin forever.
      auditVerdicts.set(`${section}:${row.key}`, { v: VERDICT_VERSION, ts: Date.now(), state: 'error', reason: String(e.message || e).slice(0, 120) });
      console.log(`audit: ${section} "${row.title}" verify failed — ${e.message || e}`);
    }
    persistVerdicts();
    metrics.emitEvent('audit_verify', { sec: section, ti: row.title, st: auditVerdicts.get(`${section}:${row.key}`).state, left: work.length - 1 });
  } catch (e) { console.log(`audit: verifier tick failed — ${e.message || e}`); }
  finally {
    auditBusy = false;
    // Straight into the next search while a session is live, rather than waiting out the interval.
    // AFTER the lock is released, or the next tick would bounce off its own predecessor.
    const s = auditSessions.get('audit-verify');
    if (s && !s.stopping) { s.searches += 1; scheduleAuditSessionTick('audit-verify'); }
  }
}

// ---- the paced background UPGRADE scanner ─────────────────────────────────────────────────────
// THE UPGRADE TAB, PRE-WARMED. Until now the Upgrade tab was strictly lazy: 870 rows listing the
// whole movie library, and a candidate search ran only when a human opened a row. The header on
// GET /api/audit/upgrade justified that with "805 paced searches would be ~10 hours" — true, but it
// made the tab a place you go to WAIT, one row at a time, which is not how anyone browses 870 films.
//
// Brennan, 2026-08-09: "I just mean to grab options automatically, same as if I went down the list
// of all the good upgrade candidates… maybe we should be bold and do like any movies with a
// bpp+ < 100. That said we never EVER actually do the replacement automatically, that is ALWAYS a
// user decision."
//
// So this sweep does exactly, and only, what a human clicking every qualifying row would do: run
// the search, cache the verdict. The tab then renders instantly from cache with no code change —
// GET /api/audit/upgrade already decorates each paged row from `auditVerdicts`.
//
// THE INVARIANT, and it is the whole design: THIS SWEEP NEVER GRABS AND NEVER REPLACES. It writes
// verdicts and nothing else. Replacement stays behind POST /api/audit/replace, which is only ever
// reached by a human pressing a button on a row. Do not add a "just auto-swap the obvious wins"
// path here — that is a different feature with a different risk profile (gpu-verify.js is the one
// place that auto-swaps, deliberately scoped to decode-incompatible fresh imports, once per movie
// ever). The Upgrade tab is the INVERSE of the Disk tab: Disk finds files that cost too much,
// Upgrade finds films that deserve better, and in both cases the human decides.
//
// BPP+ < 100 means "below the target the probe measured for this specific film" — the `warn` and
// `bad` bands — which today is 754 of 870 movies. At UPGRADE_EVERY_MS that is a long first pass;
// after it, the 14-day verdict TTL leaves only ~54 refreshes a day, so the steady state is cheap.
// The cost is entirely in the first sweep, and it is paced precisely so that cost is spread.
const UPGRADE_EVERY_MS = Number(cfg.AUDIT_UPGRADE_EVERY_MS || 60000);
// Below this the film is at or above its measured target and there is nothing to look for.
const UPGRADE_BPP_PLUS_MAX = Number(cfg.AUDIT_UPGRADE_BPP_MAX || 100);
// ...WITH ONE OVERRIDE: a file that is not the whole film always needs options found for it, however
// good its picture looks. BPP+ is a rate and truncation does not lower it, so Chinatown's 68-minute
// copy scored 139 and this gate excluded it — the single worst file in the library was the one the
// upgrade scan considered least in need of attention. See the runtimeVerdict call in buildRows.
// A RE-ENCODE IS ALWAYS WORTH OFFERING A REAL SOURCE, whatever its bitrate. BPP+ cannot see
// provenance — a BRRip and a disc encode at the same size score identically — so a bloated re-encode
// sailed past this gate on its BPP+ alone and was never offered the genuine article.
// Cheap in practice: 181 of the library's 187 re-encodes are already under the BPP+ gate (they are
// small by construction), so this admits SIX additional rows, measured 2026-08-18.
const upgradeEligible = (r) => !!r.short || !!r.unprobed || !!r.reenc
  || (r.bppPlus != null && r.bppPlus < UPGRADE_BPP_PLUS_MAX);

// Same split as reportVerifyProgress: one definition of the backlog, shared by the gated path and
// the working path.
function reportUpgradeProgress(rows) {
  // YIELD TO THE PRIMARY VERIFIER. Those sections are the actual offenders — files that will not
  // play, or that waste disk — while this one is discretionary browsing data. Sharing one indexer
  // between them is fine; letting the discretionary sweep delay a playback verdict is not.
  const primaryLeft = verifyWorkList(rows).length;
  // `upgrade` arrives already sorted by upgGroup() — Top 100 / Beloved with a poor picture first,
  // then the rest alphabetically. That ordering was chosen for the tab, and it is exactly the right
  // order to SEARCH in too: the films Brennan cares about get their options first.
  const eligible = rows.upgrade.filter(upgradeEligible);
  const work = eligible.filter((r) => {
    const v = verdictFor(r.key, 'upgrade');
    return !v || v.stale;
  });
  const gap = auditSessionFor('audit-upgrade') ? AUDIT_SESSION_GAP_MS : UPGRADE_EVERY_MS;
  jobs.report('audit-upgrade', {
    progress: { done: eligible.length - work.length, total: eligible.length },
    // One search per tick, so remaining ticks x the gap IS the ETA — same arithmetic the source
    // check reports. Held at null while yielding, because a figure would be a lie if this sweep is
    // not the one consuming those ticks.
    etaMs: primaryLeft ? null : work.length * gap,
    detail: primaryLeft ? `waiting for the source check (${primaryLeft} left)` : '',
  });
  return { primaryLeft, work };
}

async function upgradeScanTick() {
  // Takes `auditBusy` — the SAME lock verifyTick uses, not a lock of its own. Both do one paced
  // indexer search, and the pacing is the promise made to the indexers ("gentle on public
  // indexers", VERIFY_EVERY_MS); two sweeps each honouring their own interval would still put two
  // searches on the wire at once and quietly break it. One lock, one search in flight.
  if (isMasterPaused() || auditBusy) return;
  const manual = !!auditSessionFor('audit-upgrade');
  // NIGHTLY unless a human asked — see the window/session block above verifyTick().
  if (!manual && !inAuditWindow()) {
    const rows = cachedRows();
    if (rows) reportUpgradeProgress(rows);
    return;
  }
  auditBusy = true;
  try {
    if (isMasterPaused()) return;
    const rows = await buildRows();
    const { depthMap, seriesNorm } = rows;
    if (isMasterPaused()) return;
    const { primaryLeft, work } = reportUpgradeProgress(rows);
    if (primaryLeft || !work.length) {
      // A session that has nothing left to do ends itself. It does NOT end merely because it is
      // yielding to the source check — that is a pause, not completion, and a session that quit
      // there would leave the backlog untouched with the card back on Run.
      if (manual && !primaryLeft) auditSessionStop('audit-upgrade', 'every candidate re-checked');
      return;
    }
    const row = work[0];
    try {
      const v = await verifyRow(row, 'upgrade', depthMap, seriesNorm);
      auditVerdicts.set(`upgrade:${row.key}`, v);
      console.log(`audit: upgrade "${row.title}" (BPP+ ${row.bppPlus}) -> ${v.state}`
        + (v.best ? ` (best: ${v.best.codec} ${v.best.depth}, ${v.best.seeders} seeds)` : ''));
    } catch (e) {
      auditVerdicts.set(`upgrade:${row.key}`, { v: VERDICT_VERSION, ts: Date.now(), state: 'error',
        reason: String(e.message || e).slice(0, 120) });
      console.log(`audit: upgrade "${row.title}" verify failed — ${e.message || e}`);
    }
    persistVerdicts();
    metrics.emitEvent('audit_verify', { sec: 'upgrade', ti: row.title,
      st: auditVerdicts.get(`upgrade:${row.key}`).state, left: work.length - 1 });
  } catch (e) { console.log(`audit: upgrade scan tick failed — ${e.message || e}`); }
  finally {
    auditBusy = false;
    // Back-to-back while a session is live, and only after the lock is released. See verifyTick().
    const s = auditSessions.get('audit-upgrade');
    if (s && !s.stopping) { s.searches += 1; scheduleAuditSessionTick('audit-upgrade'); }
  }
}

// Refresh both caches on a timer so the expensive work never lands on a user request.
// Skipped during Movie Mode like every other sweep; failures are logged, not thrown, because
// a warm-up that fails should degrade to a slow page, never a broken one.
async function warmTick() {
  if (isMasterPaused()) return;
  try {
    await buildRows(true);
    await staleTorrents(true);
  } catch (e) { console.log(`audit: cache warm failed — ${e.message || e}`); }
}

// ---- ZERO-GAP replacement finaliser ──────────────────────────────────────────────────────
// Phase 2 of a swap started from the Audit tab. The replacement was grabbed WITHOUT touching
// the existing files; only once it has fully downloaded (and nobody is mid-watch) are the old
// files removed and the new one imported. Modelled on gpu-verify.js, which proved the pattern
// for movies — the difference is this is human-initiated and covers TV seasons too.
//
// If the replacement never completes, the swap is abandoned after 48h and the ORIGINAL STAYS.
// A title must never be left with nothing.
const REPLACE_TIMEOUT_MS = 48 * 3600 * 1000;
// A swap whose replacement torrent has NO live seeder is not going to finish by itself. The
// indexer's search-time seeder count is a snapshot the real swarm frequently does not honour —
// every swap stuck here shows qBittorrent num_seeds:0 from the moment it was added, with
// num_complete:0 on most (a ghost/stale scrape, not a live peer list). Waiting the full 48h makes
// the row claim "swapping" for two days while standing still. So abandon EARLY and KEEP THE
// ORIGINAL — it is untouched until a completed import, so an early abandon costs nothing but the
// download attempt. Zero-progress is the fast path (metadata never resolved / swarm never had a
// seeder — mirrored from stallRecovery's own metaDL-is-dead stance); a PARTIAL download proves a
// seeder was there and may return, so that one gets a long stall clock measured from its last
// observed byte. This is the swap's OWN sweep ending it — stallRecovery still leaves swaps alone.
// These clocks count ACTIVE time — time qBittorrent spent actually trying — not wall-clock since
// the grab. See QBIT_IDLE_STATES and p.activeMs below for why that distinction is load-bearing.
const SWAP_DEAD_MS = 90 * 60 * 1000;      // 0% with zero connected seeds this long → dead swarm
// PARTIAL download, no movement AND no connected seeds for this long → abandoned. Raised 12h → 72h on
// 2026-08-12 (see SWAP_NEARLY_DONE below for the two casualties that prompted it). 12h was chosen when
// this clock was the only thing standing between a dead swarm and a swap that claimed to be working
// forever; the active-time accounting and the queued-state exemption now do most of that job, so this
// can afford to be patient. A thin public swarm going quiet overnight is normal, not terminal.
const SWAP_STALLED_MS = 72 * 3600 * 1000;
// NEARLY DONE, and it gets its own far longer clock plus its bytes kept. 2026-08-11: the 12h stall
// rule killed Gladiator (2000) Extended at 95%, City Lights at 98% and Bohemian Rhapsody at 99.9%,
// and abandonDeadSwap deletes with deleteFiles:true — so ~20 GB of already-fetched data was thrown
// away to save nothing. Brennan on Gladiator the day before: "I definitely don't want [it] killed,
// I want it to finish."
//
// The arithmetic is one-sided. At 95% the remaining bytes are small enough that ONE seed appearing
// for a few minutes finishes the job, disk is not scarce (2.2 TB free), and a stalled torrent does
// not hold an active slot (qBittorrent's dont_count_slow_torrents is on). Waiting is nearly free;
// deleting is irreversible and throws away the expensive part. So near-complete swaps get three days
// of chances instead of twelve hours, and even then their DATA SURVIVES the abandon.
// REBALANCED 2026-08-12, Brennan's call, after Gladiator (2000) Extended x264-OFT and Paris Texas
// 1984 x264-OFT both died at EXACTLY 720 min (12h) on consecutive nights and had their partial
// downloads deleted. Both were 1-seed public swarms — the shape that routinely goes quiet for longer
// than half a day and then comes back. He expected partial progress to buy days, not hours.
//
// The threshold moved from 0.9 to 0.5 because 0.9 was drawn for "the remaining bytes are trivial", and
// the thing actually worth protecting is broader: ANY download with real progress in hand represents
// hours of transfer that a re-grab has to repeat from zero. Half a film is already expensive.
const SWAP_NEARLY_DONE = 0.5;
const SWAP_STALLED_NEARLY_MS = 168 * 3600 * 1000;   // 7 days at >= SWAP_NEARLY_DONE
// STATES IN WHICH QBITTORRENT IS NOT TRYING, so no dead-swarm clock may run.
//
// THIS IS THE 2026-08-10 REGRESSION, and it cost ~60 good releases in one afternoon. qBittorrent
// has `max_active_downloads` (12 here) and queues everything past it as `queuedDL`. A queued
// torrent reports progress:0 and num_seeds:0 — byte-for-byte identical to a dead swarm — because
// it has not been started, not because nobody is there. Brennan batch-grabbed ~66 replacements from
// the Upgrade tab; the first 12 downloaded and the other ~54 sat in `queuedDL`, hit SWAP_DEAD_MS 90
// minutes later, and were abandoned AND blocklisted for a week (DEAD_REFUSE_TTL_MS). The casualty
// list included The Shawshank Redemption, The Dark Knight, Toy Story and Taxi Driver, which are not
// dead swarms by any definition.
//
// Batch grabbing is a normal way to use this tab, and qBittorrent's queue limit is a GOOD thing —
// it is what keeps the NUC's bandwidth and connection count sane. The two just have to agree on
// what "waiting" means. So: a queued swap must WAIT, not die.
//
// `pausedDL`/`stoppedDL` are here for the same reason — a human paused it, which is not evidence
// about the swarm. The checking/allocating/moving states are disk work, also not swarm evidence.
// `metaDL` is deliberately ABSENT: that one IS trying, and has its own (shorter) SWAP_NO_META_MS.
const QBIT_IDLE_STATES = new Set(['queuedDL', 'pausedDL', 'stoppedDL', 'checkingDL',
  'checkingResumeData', 'queuedForChecking', 'allocating', 'moving', 'unknown']);
// Largest gap between two sweeps that may be credited as active time. The sweep runs every 60s, so
// anything much larger than that is a controller restart or a paused-by-Movie-Mode window, and
// counting a 10-hour downtime as ten hours of a torrent "trying" would re-create the very bug this
// guards against — just with a slower fuse.
const SWAP_ACTIVE_STEP_CAP_MS = 5 * 60 * 1000;
// Still in `metaDL` — no file list, so not one peer has ever been reached. Stronger evidence of a
// dead swarm than plain zero-progress, so it gets a shorter clock than SWAP_DEAD_MS.
//
// 60 min, NOT the 10 min this was first written as. MEASURED, and the measurement is the whole
// reason for the number: Gladiator 2000 Extended x264-OFT sat in metaDL for roughly 25-45 minutes
// — eight working trackers, every one of them returning nobody — and then found a peer through DHT
// and started downloading normally. A 10-minute abandon would have killed the exact download this
// work exists to rescue, and it would have looked like proof the release was dead.
//
// The lesson generalises: on a thin public swarm, metadata can take tens of minutes to arrive via
// DHT, because it has to find one of a handful of reachable peers rather than be handed a peer list
// by a tracker. "No metadata yet" means "nobody found YET" far more often than it means "nobody
// exists". 60 min still beats the 90-minute backstop, and sits comfortably above everything
// observed. Do not lower it without a fresh measurement — see the branch in replaceSweepInner.
const SWAP_NO_META_MS = 60 * 60 * 1000;
// How long a dead-swarm release stays remembered (auditSwapped, reason:'dead') so it is not
// re-offered. Mirrors the arrSweep negative-cache window for dead releases; after this the release
// gets its chance back — swarms do revive.
const DEAD_REFUSE_TTL_MS = 7 * 24 * 3600 * 1000;
// A swap whose PREFLIGHT keeps refusing has a folder that will not become importable — an extras-
// only release, a folder of similarly-sized videos we refuse to guess between. Retrying for the
// full 48h just makes the row lie about being in progress. Nothing was deleted in that state, so
// giving up early is free.
const PREFLIGHT_GIVEUP_MS = 2 * 3600 * 1000;
// ...but some refusals are PERMANENT from the first sight of them, and waiting 2h for a verdict that
// cannot change is just a lying row. *arr scores Custom Formats against the file it ALREADY has, so
// "Not a Custom Format upgrade for existing episode file(s)" is arithmetic on two fixed values — it
// will read the same on every tick until one of the files changes, which in a swap the original never
// does. Observed 2026-07-30 on Rings of Power S01: the release carried NO language tag and no indexer
// language metadata, so nothing in release-rules.js could refuse it, and Sonarr itself scored it 220
// AT GRAB TIME; only after 19 GB landed did it probe the audio, find a non-original-language track and
// rescore it -99800. Audio language is simply not knowable before download, so this will recur — the
// right answer is to end the swap the moment *arr says so, keeping the original.
//
// DELIBERATELY NOT the same thing as UPGRADE_REJECT_RE in importer.js, which the swap PREFLIGHT
// treats as NON-fatal. That one matches "not an upgrade"/"existing file" during the preflight, when
// the original is still on disk and such a rejection is EXPECTED and must not abort. This fires on
// *arr's real refusal of the real import. Getting the two backwards would either abandon every
// healthy swap or never abandon a doomed one, so they are kept textually distinct: the CF phrasing
// ("Custom Format upgrade") does not appear in UPGRADE_REJECT_RE, and vice versa.
const CF_PERMANENT_RE = /not a custom format upgrade|do not improve on existing/i;
// ...EXCEPT when nothing that MATTERS is worse — a bigger file, or an audio track a client will
// transcode — which are the refusals Brennan does not want applied to a replacement he picked
// himself. buildCfAllow gathers what cfRefusalIsExcusable needs to tell those from the real ones;
// see the long note above SIZE_CF_RE in release-rules.js. Returns null on ANY
// failure, and a null allowance means the old behaviour — refuse — so a *arr hiccup can never widen
// what gets imported.
async function buildCfAllow(app, id, season, relTitle) {
  try {
    const item = await arrGet(app, app === 'radarr' ? `/movie/${id}` : `/series/${id}`);
    const profileId = item && item.qualityProfileId;
    if (profileId == null) return null;
    const prof = await arrGet(app, `/qualityprofile/${profileId}`);
    const items = (prof && prof.formatItems) || [];
    if (!items.length) return null;
    const scoreByName = new Map(items.map((f) => [f.name, Number(f.score) || 0]));
    const files = await arrGet(app, app === 'radarr' ? `/moviefile?movieId=${id}` : `/episodefile?seriesId=${id}`);
    const mine = (Array.isArray(files) ? files : [])
      .filter((f) => (app === 'radarr' ? true : f.seasonNumber === season));
    if (!mine.length) return null;
    // A season holds many files and *arr scores each episode against its own. Take the STRONGEST
    // existing file, so the allowance only fires when the replacement clears the highest bar on
    // disk rather than the weakest episode in the season.
    let oldFormats = [];
    let best = -Infinity;
    for (const f of mine) {
      const s = nonSizeCfScore(f.customFormats, scoreByName);
      if (s > best) { best = s; oldFormats = f.customFormats || []; }
    }
    // THE EDITION QUESTION, answered from OUR parse of the release title rather than from *arr's score
    // of the file inside the torrent — which is the discrepancy that refused Gladiator's EXTENDED
    // download (see EDITION_CF in release-rules.js). The bar is the HIGHEST edition tier among the
    // files being replaced, so a season or a film holding a Director's Cut cannot be talked down to an
    // Extended one. Absent a release title we pass nothing and the edition CFs count in full — the old,
    // stricter behaviour, which is always the safe default here.
    let editionOk = false; let editionLabel = null;
    if (relTitle) {
      let oldTier = -Infinity;
      for (const f of mine) {
        const e = ownEditionOf(f.edition, f.relativePath, f.originalFilePath);
        if (e && Number.isFinite(e.tier) && e.tier > oldTier) oldTier = e.tier;
      }
      if (!Number.isFinite(oldTier)) oldTier = EDITION_UNSTATED;
      editionOk = editionNotWorse(relTitle, oldTier);
      editionLabel = editionOf(relTitle).label;
      if (!editionOk) {
        console.log(`audit: "${relTitle}" parses as edition tier ${editionOf(relTitle).tier}`
          + ` (${editionLabel || 'unstated'}) against tier ${oldTier} on disk — edition formats will NOT be excused`);
      }
    }
    return { oldFormats, scoreByName, editionOk, editionLabel };
  } catch { return null; }
}
// How long *arr gets to actually land a submitted import before the verify phase stops waiting and
// starts healing. ManualImport normally completes in seconds; this is generous on purpose.
const VERIFY_WINDOW_MS = 10 * 60 * 1000;

// ── The runtime yardstick: how long SHOULD this swap's content be? ────────────────────────────
// Straight from *arr, which got it from TMDB. This is the half of the test that works when the copy
// being replaced is itself truncated — comparing only against the file on disk would have let a
// second short Chinatown replace the first one without complaint.
//
// Movies: the film's runtime. Seasons: the sum of the runtimes of the episodes the import will
// actually cover, which is the right total to compare a whole-season download against (and handles
// double-length finales, where a flat episodes x runtime would be wrong).
//
// Returns 0 — not a throw — when *arr has no runtime to give. 0 means "no yardstick from TMDB" and
// runtimeVerdict falls back to the on-disk copy alone.
async function expectedRuntimeSecs(p) {
  if (p.app === 'radarr') {
    const m = await arrGet('radarr', `/movie/${p.id}`).catch(() => null);
    return (m && Number(m.runtime) > 0) ? Number(m.runtime) * 60 : 0;
  }
  const eps = await arrGet('sonarr', `/episode?seriesId=${p.id}&seasonNumber=${p.season}`).catch(() => null);
  if (!Array.isArray(eps)) return 0;
  // Only the episodes this swap is responsible for. A season download that covers 8 of 10 episodes
  // is already refused by the cardinality check above, so summing what *arr says the season holds is
  // the correct expectation by the time we get here.
  return eps.reduce((a, e) => a + (Number(e.runtime) > 0 ? Number(e.runtime) * 60 : 0), 0);
}
// Total measured seconds across every file the import would submit. Sequential on purpose: these are
// header reads on a USB drive that may also be feeding a stream, and a 24-file season fanned out at
// once is a burst of seeks for no latency benefit inside a 60s sweep.
//
// One unreadable file among many yields a total that is too SMALL, which biases toward refusing a
// healthy swap — the wrong direction. So a probe failure poisons the whole answer to null ('unknown'
// → proceed) rather than silently under-counting.
async function probeTotalSecs(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return 0;
  let total = 0;
  for (const fp of list) {
    const d = await probeDurationSecs(fp);
    if (!d) return 0;
    total += d;
  }
  return total;
}
// RUNTIME_MIN_RATIO and the arithmetic that uses it now live in release-rules.js (runtimeVerdict),
// because the SAME test runs in two places and they must not drift: once as a preflight on the
// downloaded file before any original is deleted (the Chinatown fix), and once as the post-import
// check on what *arr actually landed. See the long note above runtimeVerdict for the measured
// distribution that sets the threshold.
//
// Self-heal attempts before giving up and leaving it for a human. Each one deletes a provably-wrong
// import and re-runs the (now cardinality-guarded) import against the same still-seeding torrent.
// NOTE the limit of that idea: re-importing only helps when the IMPORT chose wrongly. If the SOURCE
// is wrong — a release that simply does not contain the whole film — every retry re-imports the same
// short file, which is exactly what Chinatown did twice before giving up. See verifySwap's
// `unrepairable` branch: 'short' skips healing entirely.
const VERIFY_MAX_HEALS = 2;
// Titles Jellyfin is playing RIGHT NOW, normalised. One /Sessions call per sweep tick covers
// every pending swap, and it answers the question that actually matters — is someone watching
// this — rather than gpu-verify's PlaybackPositionTicks, which only says a resume point exists.
//
// Returns null on ANY failure, and replaceSweep treats null as "cannot confirm" and defers.
// Deleting a file out from under a live stream is the one irreversible mistake here, so this
// fails CLOSED: a Jellyfin blip postpones a swap by 60s, which costs nothing.
async function nowPlayingTitles() {
  try {
    const r = await tfetch(`${HOST.jellyfin}/Sessions`,
      { headers: { Authorization: `MediaBrowser Token="${cfg.JELLYFIN_KEY || ''}"` } }, 6000);
    if (!r.ok) return null;
    const sessions = await r.json();
    if (!Array.isArray(sessions)) return null;
    const out = new Set();
    for (const s of sessions) {
      const np = s.NowPlayingItem;
      if (!np) continue;
      // SeriesName for episodes, Name for movies — a season swap must match on the series.
      for (const n of [np.SeriesName, np.Name]) if (n) out.add(normTitle(n));
    }
    return out;
  } catch { return null; }
}

// Finalising ONE swap means 1-24 arrDelete calls plus a 90s-timeout ManualImport, which
// routinely outlasts the 60s tick. Without these guards a second tick re-entered the same
// pending entry (it is only deleted after the import returns) and ran a CONCURRENT import of the
// same folder — and because importViaManual passes filterExistingFiles=true, the second import
// listed only the episodes tick one had already deleted, silently dropping the rest. That is how
// The Wire S05 imported exactly 7 of 10 files on 2026-07-28, and why the log showed 20 "replaced"
// lines for 14 swaps. _sweepBusy serialises the ticks; _finalising is the per-title belt-and-
// braces so a future concurrent caller still cannot double-finalise one entry.
let _sweepBusy = false;
const _finalising = new Set();

// The downloadId *arr recorded for this pending swap's item, for entries grabbed from a release
// with no infoHash. Scoped to the exact movie (or series+season) the swap targets so it can never
// latch onto an unrelated download.
async function queueHashFor(p) {
  const q = await arrGet(p.app, '/queue?pageSize=200&includeUnknownMovieItems=true', 8000);
  for (const qe of (q.records || [])) {
    const itemId = p.app === 'radarr' ? qe.movieId : qe.seriesId;
    if (itemId !== p.id) continue;
    if (p.app === 'sonarr' && p.season != null && qe.seasonNumber !== p.season) continue;
    if (qe.downloadId) return String(qe.downloadId).toLowerCase();
  }
  return null;
}

// ── TAKE A REFUSED RELEASE AWAY FROM *arr ────────────────────────────────────────────────────
// Refusing a swap only ever governed OUR importer, and that is half a refusal. The audit grabs
// through POST {arr}/release, so the torrent lands in *arr's OWN download-client category and
// *arr owns that queue item — when it completes, *arr's Completed Download Handling imports it
// on the next pass and deletes the file on disk as an "upgrade", which is precisely the action
// the gate just declined. Two importers, one gate.
//
// Chinatown (1974), 2026-09-15, from metrics/events:
//     audit_replace_abandon  reason:"short_runtime"  gotMin:68  wantMin:131   t=…933
//     import_ok              Chinatown … GeneMige                            t=…939
// The gate was RIGHT, was FIRST, and the 7.95 GB AMIABLE copy died anyway six seconds later,
// because being right about a torrent we left sitting in *arr's queue changes nothing.
//
// Removing the queue record is what makes a refusal refuse:
//   blocklist=true        *arr won't re-grab this exact release either. auditDead binds only us;
//                         without this the next *arr search is free to fetch the same short file.
//   removeFromClient=true the torrent AND its data go, so there is nothing left to import from.
//   skipRedownload=true   CRITICAL. Without it *arr answers the removal by immediately searching
//                         and grabbing a replacement — an unattended grab nobody authorised, and
//                         a direct breach of the auto-grab-off invariant. We want the row to go
//                         back to the audit list for a human to choose from, not a surprise swap.
//                         VERIFY ON DEPLOY: this instance is Radarr 6.3.0 and exposes no swagger,
//                         so the parameter could not be confirmed against the live API. *arr
//                         ignores unknown query params silently, so a rename would degrade to
//                         skipRedownload=false — a redownload, not a crash. Watch the first
//                         refusal's log for an unexpected grab.
//
// FAILS SOFT, always. A refusal that cannot reach *arr is still a refusal and still keeps the
// file, which is the old behaviour exactly — so every failure path here returns false and none
// of them throw into the swap loop.
async function stopArrImport(app, hash, title) {
  const h = String(hash || '').toLowerCase();
  try {
    const unknown = app === 'radarr' ? 'includeUnknownMovieItems=true' : 'includeUnknownSeriesItems=true';
    const q = await arrGet(app, `/queue?pageSize=200&${unknown}`, 8000);
    const recs = (q && q.records) || [];
    // Prefer the infoHash — it is the only identifier that cannot point at the wrong download.
    // Fall back to the release title (normTitle, so indexer punctuation differences don't miss)
    // for the releases whose indexer never handed us a hash; a pending swap stores hash:'' then.
    const rec = (h && recs.find((r) => String(r.downloadId || '').toLowerCase() === h))
      || (title && recs.find((r) => normTitle(r.title) === normTitle(title)))
      || null;
    if (!rec || rec.id == null) return false;
    const r = await arrDelete(app, `/queue/${rec.id}?removeFromClient=true&blocklist=true&skipRedownload=true`);
    if (!r.ok) {
      console.log(`audit: could NOT remove "${title}" from the ${app} queue — HTTP ${r.status}.`
        + ` ${app} may still import it; the copy on disk is at risk.`);
      return false;
    }
    console.log(`audit: removed "${title}" from the ${app} queue, blocklisted it and deleted the torrent`
      + ` — ${app} can no longer import it over your copy`);
    return true;
  } catch (e) {
    console.log(`audit: could NOT remove "${title}" from the ${app} queue — ${e.message || e}.`
      + ` ${app} may still import it; the copy on disk is at risk.`);
    return false;
  }
}

// One exit for a swap whose replacement torrent will never deliver: delete the pending row (the
// ORIGINAL is untouched — old files only go after a completed import), remember the release as
// reason:'dead' so it is not offered again for DEAD_REFUSE_TTL_MS, and drop the dead torrent so it
// stops sitting in the *arr queue as an import-rejected item. Used by the dead_swarm (0%) and
// stalled_swarm (partial) branches of replaceSweepInner.
// Release title -> the key auditDead is stored under. Lowercased and stripped of the punctuation
// that differs between indexers listing the same pack ("Gladiator.2000.Extended" vs "Gladiator 2000
// Extended"), so one corpse is recognised however it is spelled on the row.
function deadKey(rel) {
  return String(rel || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Is this release known dead, and still within the refusal window? Returns the record (for the age
// shown in the UI) or null. Prunes on read, which is all the pruning this map needs.
function deadRelease(rel) {
  const key = deadKey(rel);
  if (!key) return null;
  const d = auditDead.get(key);
  if (!d) return null;
  // A CF REFUSAL DOES NOT EXPIRE. A dead swarm is a fact about the world that changes — seeders come
  // back, so those records time out and the release gets another chance. "*arr scores this release
  // below the file you already have" is arithmetic on two fixed values; it will read the same next
  // week and every week after, until one of the two files changes. Ageing it out would just re-offer
  // a release that is guaranteed to be refused again, which is the loop this record exists to break.
  if (d.reason === 'cf_refused') return d;
  if (Date.now() - d.ts > DEAD_REFUSE_TTL_MS) { auditDead.delete(key); return null; }
  return d;
}

// `progress` is the fraction qBittorrent last reported (0 when unknown). It decides only ONE thing:
// whether the partial data is deleted along with the tracking record. See SWAP_NEARLY_DONE.
async function abandonDeadSwap(k, p, reason, ageMin, progress = 0) {
  auditPending.delete(k);
  // REMEMBER THE RELEASE, not just the row. auditSwapped below is keyed per film and holds one
  // entry, so a film that burns several dead releases in a row forgets all but the last — which is
  // exactly how Gladiator (2000) came round to be offered a second corpse. See auditDead.
  const dk = deadKey(p.rel);
  if (dk) auditDead.set(dk, { ts: Date.now(), hash: String(p.hash || '').toLowerCase(), title: p.rel || '', reason });
  persistState();
  auditSwapped.set(k, { hash: String(p.hash || '').toLowerCase(), rel: p.rel || null, reason: 'dead', ts: Date.now() });
  invalidateRows();
  // KEEP THE BYTES when most of the file is already here. The controller stops tracking the swap
  // either way — but deleting a 95%-complete download destroys hours of transfer to reclaim disk we
  // are not short of, and the torrent left in place can still finish on its own or be resumed by
  // hand. Only genuinely empty attempts are cleaned up.
  const keepData = progress >= SWAP_NEARLY_DONE;
  if (!keepData) {
    try {
      await qbit.fetch('/api/v2/torrents/delete', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ hashes: String(p.hash || '').toLowerCase(), deleteFiles: 'true' }) });
    } catch { /* qbit hiccup — *arr's queue pass clears the record later */ }
  }
  recordAuditOutcome({ title: p.title, rel: p.rel || null, outcome: 'abandoned', reason,
    detail: keepData ? `stopped at ${Math.round(progress * 100)}% — data kept, it can still finish`
      : reason === 'no_metadata' ? 'never reached a single peer'
        : reason === 'stalled_swarm' ? `no data for ${Math.round(ageMin / 60)}h` : 'no seeders' });
  console.log(`audit: replacement for "${p.title}" has had no seeds for ${ageMin} min (${reason}) — swap abandoned, original kept; release remembered so it is not offered again for a week`
    + (keepData ? ` — LEFT IN QBITTORRENT at ${Math.round(progress * 100)}%, data kept so it can still finish` : ''));
  metrics.emitEvent('audit_replace_abandon', { ti: p.title, reason, ageMin, keptData: keepData || undefined });
}

async function replaceSweep() {
  if (isMasterPaused() || !auditPending.size || _sweepBusy) return;
  _sweepBusy = true;
  try { await replaceSweepInner(); } finally { _sweepBusy = false; }
}

async function replaceSweepInner() {
  let torrents = [];
  try { torrents = await getQbitTorrents(); } catch { return; }   // qbit down — retry next tick
  const playing = await nowPlayingTitles();
  const now = Date.now();
  for (const [k, p] of auditPending) {
    // POST-IMPORT VERIFICATION runs on its own tick, before every other branch. ManualImport is an
    // async *arr command, so nothing has landed at the moment it is accepted — checking inline
    // would mean sleeping inside the sweep with a dozen other swaps waiting behind it. Deferring to
    // the next tick costs 60s of latency on the log line and keeps the sweep responsive.
    if (p.phase === 'verify') { await verifySwap(k, p); continue; }
    // THE 48h BACKSTOP, and it is deliberately NOT a plain wall-clock check any more. Two exemptions,
    // both of which exist because a swap can be perfectly healthy and still be old:
    //
    //   QUEUED. A swap parked in qBittorrent's download queue behind a big batch is waiting its turn,
    //   not failing. Killing it at 48h would be the same bug as the dead-swarm regression (see
    //   QBIT_IDLE_STATES) with a slower fuse. The timeout resumes the moment it goes active.
    //
    //   STILL DELIVERING BYTES. A thin public swarm can take days, and a wall-clock cap deletes the
    //   work at 99%. Gladiator (2000) Extended x264-OFT, 2026-08-10, is the case: 28.5h old, 94.5%
    //   downloaded, one seed that comes and goes, and the backstop was going to bin it in 19 hours
    //   with 400 MB left to fetch. Brennan: "I definitely don't want [it] killed, I want it to
    //   finish." So for a PARTIAL download, SWAP_STALLED_MS is the authority and the 48h cap steps
    //   aside — bytes within the stall window mean the swarm is alive, however slowly, and progress
    //   is the only honest evidence of that. A swap that genuinely goes quiet for 12h still dies via
    //   the stalled_swarm branch below; this only removes the SECOND, blunter clock that ignored
    //   progress entirely. Nothing was deleted in either state, so waiting costs only disk.
    if (now - p.ts > REPLACE_TIMEOUT_MS) {
      const cur = torrents.find((x) => String(x.hash || '').toLowerCase() === String(p.hash || '').toLowerCase());
      const incomplete = cur && (cur.progress || 0) < 1;
      const waiting = incomplete && QBIT_IDLE_STATES.has(String(cur.state || ''));
      const progressing = incomplete && (cur.progress || 0) > 0
        && now - (p.lastProgTs || p.ts) < SWAP_STALLED_MS;
      if (!waiting && !progressing) {
        auditPending.delete(k); persistState();
        recordAuditOutcome({ title: p.title, rel: p.rel || null, outcome: 'timeout', reason: 'timeout_48h',
          detail: 'still not finished after 48h of trying' });
        console.log(`audit: replacement of "${p.title}" abandoned after 48h — original kept`);
        metrics.emitEvent('audit_replace_abandon', { ti: p.title });
        continue;
      }
    }
    // Some indexers return a release with no infoHash, so the grab recorded an empty hash and
    // this swap could never be matched — it just sat until the 48h abandon while its replacement
    // downloaded for nothing (observed: American Gods S01). Recover the hash from *arr's own
    // queue, which knows the downloadId it handed to qBittorrent, and persist it.
    if (!p.hash) {
      const h = await queueHashFor(p).catch(() => null);
      if (!h) {
        // ...BUT DO NOT WAIT FOREVER. This `continue` used to be unconditional, which skipped every
        // check below it — including the vanished-torrent abandon — so a grab that *arr accepted but
        // never handed to the download client sat claiming "starting · 1430 min" for the full 48h.
        // Observed 2026-08-11 on Frozen Planet II S01 and Dexter: New Blood S01, both with an EMPTY
        // Sonarr queue: there was no download, no hash to recover, and nothing that would ever
        // change. Give the queue the same grace the vanished check gives qBittorrent, then give up.
        // Nothing was deleted — the original is untouched — so an early abandon costs only the grab.
        if (now - p.ts > HASHLESS_GIVEUP_MS) {
          auditPending.delete(k); persistState();
          invalidateRows();
          recordAuditOutcome({ title: p.title, rel: p.rel || null, outcome: 'abandoned', reason: 'never_started',
            detail: `${p.app} accepted the grab but no download ever appeared` });
          console.log(`audit: replacement for "${p.title}" never reached the download client `
            + `(no hash after ${Math.round((now - p.ts) / 60000)} min, ${p.app} queue empty) — swap abandoned, original kept`);
          metrics.emitEvent('audit_replace_abandon', { ti: p.title, reason: 'never_started',
            ageMin: Math.round((now - p.ts) / 60000) });
        }
        continue;                             // not in the queue yet — try again next tick
      }
      p.hash = h; persistState();
      console.log(`audit: recovered missing download hash for "${p.title}" from the ${p.app} queue`);
    }
    // The replacement is the torrent whose hash we recorded at grab time. Matching on anything
    // looser risks finalising against an unrelated download that happens to be finished.
    const t = torrents.find((x) => String(x.hash || '').toLowerCase() === String(p.hash || '').toLowerCase());
    // TORRENT VANISHED. Something outside this module removed it — stall-recovery used to do
    // exactly that to stalled 1-2 seed swaps before it learned to skip them. Waiting the full 48h
    // is the wrong answer: nothing is downloading, so the row claims "swapping" for two days while
    // standing still. Give up early and KEEP THE ORIGINAL, which is untouched because the old
    // files are only removed after a successful import. `torrents.length` guards against treating
    // an empty/failed qBittorrent listing as "everything vanished".
    if (!t && torrents.length && now - p.ts > VANISHED_AFTER_MS) {
      auditPending.delete(k); persistState();
      invalidateRows();
      recordAuditOutcome({ title: p.title, rel: p.rel || null, outcome: 'abandoned', reason: 'torrent_gone',
        detail: 'the download disappeared from qBittorrent' });
      console.log(`audit: replacement for "${p.title}" is no longer in qBittorrent — swap abandoned, original kept`);
      metrics.emitEvent('audit_replace_abandon', { ti: p.title, reason: 'torrent_gone',
        ageMin: Math.round((now - p.ts) / 60000) });
      continue;
    }
    if (!t || (t.progress || 0) < 1) {
      // DEAD-SWARM / STALLED-SWARM EARLY ABANDON. The indexer's search-time seeder count is a
      // snapshot the real swarm frequently does not honour — every swap stuck here has qBittorrent
      // num_seeds:0 from the moment it was added (ghost/stale tracker scrapes, not live peers). A
      // swap at 0% with no live seeders after the announce grace will not finish by itself, and
      // waiting the full 48h makes the row claim "swapping" while standing still. Abandon early
      // and KEEP THE ORIGINAL (untouched until a completed import), remembering the release so it
      // is not offered straight back (reason:'dead' expires after DEAD_REFUSE_TTL_MS). A PARTIAL
      // download proves a seeder was there, so it gets the longer SWAP_STALLED_MS clock measured
      // from its last observed byte. This is the swap's OWN sweep ending it; stallRecovery still
      // leaves swaps alone, so nothing else can delete the human's chosen release.
      if (t) {
        // ACTIVE-TIME ACCOUNTING, and every zero-progress clock below is measured against it rather
        // than against the grab timestamp. A swap sitting in qBittorrent's download queue accrues
        // NOTHING, so a batch of 60 grabs drains through the 12 active slots at whatever rate the
        // swarms allow and each one gets its full, fair 90 minutes of actually-trying before anyone
        // calls it dead. See QBIT_IDLE_STATES for the incident this exists to prevent.
        const idle = QBIT_IDLE_STATES.has(String(t.state || ''));
        if (!idle) {
          // Credit the gap since the last observation, capped so a restart cannot bank hours.
          p.activeMs = (p.activeMs || 0) + Math.min(now - (p.lastSeenTs || now), SWAP_ACTIVE_STEP_CAP_MS);
        }
        p.lastSeenTs = now; persistState();
        const activeMs = p.activeMs || 0;
        const stuckZero = (t.progress || 0) === 0;
        // Only trust num_seeds when qBit actually reported it — an undefined count means we cannot
        // confirm the swarm is dead, so fail safe and let the 48h backstop handle it.
        const noSeeds = typeof t.num_seeds === 'number' && t.num_seeds === 0;
        // NO-METADATA IS A STRONGER SIGNAL THAN NO-PROGRESS, so it gets a much shorter clock.
        //
        // `metaDL` means qBittorrent has not even fetched the torrent's file list. That is not "the
        // download is slow" — it is "we have never successfully spoken to a single peer", because
        // the metadata comes FROM a peer. A 0%-with-no-seeds torrent might still be a swarm we are
        // about to connect to; a metaDL torrent that has sat past the announce grace has had every
        // tracker in the file answer and produced nobody reachable.
        //
        // Public trackers keep scrape counters long after peers stop announcing, so "4 seeds" on the
        // indexer row can be entirely ghosts — which is why the row's seed count cannot be trusted
        // as a liveness signal and this branch exists at all.
        //
        // But BE PATIENT ABOUT IT (see SWAP_NO_META_MS). Gladiator (2000) x264-OFT, 2026-08-09, is
        // the cautionary case in both directions: eight working trackers returning nobody for ~25-45
        // minutes, then a peer via DHT and a normal download. Every tracker saying "no" is not the
        // same as the swarm being empty — it means peer discovery has not landed yet.
        if (noSeeds && t.state === 'metaDL' && activeMs > SWAP_NO_META_MS) {
          await abandonDeadSwap(k, p, 'no_metadata', Math.round(activeMs / 60000));
          continue;
        }
        if (noSeeds && stuckZero && !idle && activeMs > SWAP_DEAD_MS) {
          await abandonDeadSwap(k, p, 'dead_swarm', Math.round(activeMs / 60000));
          continue;
        }
        // The stall clock scales with how much is already in hand — see SWAP_NEARLY_DONE.
        const stallLimit = (t.progress || 0) >= SWAP_NEARLY_DONE ? SWAP_STALLED_NEARLY_MS : SWAP_STALLED_MS;
        if (noSeeds && !stuckZero && (p.lastProgTs || 0) > p.ts && now - p.lastProgTs > stallLimit) {
          await abandonDeadSwap(k, p, 'stalled_swarm', Math.round((now - p.lastProgTs) / 60000), t.progress || 0);
          continue;
        }
        // Track the last byte seen so a slow-but-alive swap is never judged against the grab time.
        if (!stuckZero && (t.progress || 0) > (p.progress || 0)) {
          p.progress = t.progress; p.lastProgTs = now; persistState();
        }
      }
      continue;
    }
    // PLAYSTATE GUARD. The replacement is complete and the old files are about to go, which is
    // the only moment in a swap where someone can lose a stream mid-scene. Row titles read
    // "Series — S01", so compare on the bare title to catch any episode of that season.
    const mediaTitle = normTitle(String(p.title || '').replace(/\s+—\s+S\d+\s*$/i, ''));
    if (!playing || playing.has(mediaTitle)) {
      console.log(`audit: "${p.title}" replacement ready but ${playing ? 'it is being watched' : 'Jellyfin playstate is unconfirmed'} — deferring`);
      metrics.emitEvent('audit_replace_defer', { ti: p.title, reason: playing ? 'now_playing' : 'playstate_unknown' });
      continue;
    }
    if (_finalising.has(k)) continue;
    _finalising.add(k);
    try {
      // ── PREFLIGHT: prove the import is sane BEFORE the originals are gone ──────────────────
      // The delete-first ordering below is deliberate and unavoidable, which means every defect in
      // the import turns into data loss. On 2026-07-29 a multi-file movie release imported its
      // extras over the feature and the 8.77 GB GoodFellas was deleted for a 13-minute featurette.
      // The shape of that import was knowable in advance. So: ask what the import WOULD do, and if
      // the answer is not sane, abort with every original still on disk. The swap stays open, so a
      // later tick can retry; the 48h abandon is the backstop.
      // No content_path means qBittorrent cannot tell us where the data is, so there is nothing to
      // import FROM. Deleting the originals in that state is pure loss — it used to fall through to
      // the delete and then skip the import entirely. Wait for a tick that knows the path.
      if (!t.content_path) {
        console.log(`audit: "${p.title}" replacement has no content path yet — nothing deleted, will retry`);
        continue;
      }
      // Built ONCE per tick and shared by the preflight and the real import below, so the two can
      // never disagree about whether this release is acceptable — the same reason they share
      // collectImportEntries.
      const cfAllow = await buildCfAllow(p.app, p.id, p.season, p.rel);
      {
        const pre = await previewManualImport(p.app, t.content_path, p.id, { cfAllow })
          .catch((e) => ({ ok: false, reason: String(e.message || e) }));
        if (!pre.ok) {
          // A Custom Format refusal is a comparison against a file that is not going to change, so
          // it is final on the FIRST tick — no reason to spend the 2h clock re-asking a settled sum.
          // Reaching here at all now means something that MATTERS was worse: cfAllow above already
          // let through anything whose deficit was only size or a transcodable audio track, so what
          // is left is content *arr scored down — a dub, a non-original-language track, AV1/VP9, a
          // 10-bit picture, a theatrical cut standing in for a longer one. Refusals Brennan wants kept.
          const permanent = CF_PERMANENT_RE.test(String(pre.reason || ''));
          const stuck = permanent || now - p.ts > PREFLIGHT_GIVEUP_MS;
          console.log(`audit: preflight refused the replacement for "${p.title}" — ${pre.reason}`
            + ` — originals untouched${stuck ? `, abandoning the swap${permanent ? ' (permanent refusal — *arr will never accept this release over your copy)' : ''}` : ', will retry'}`);
          metrics.emitEvent('audit_replace_preflight_fail', { ti: p.title, reason: String(pre.reason || '').slice(0, 120),
            offered: pre.offered || 0, ambiguous: !!pre.ambiguous, giveUp: stuck, permanent });
          // A folder whose shape never becomes importable will never become importable. Don't sit
          // on it for two days claiming to be swapping — close it out, original intact.
          if (stuck) {
            // REMEMBER A PERMANENT REFUSAL, or the tab offers the identical release straight back.
            // Measured on Rings of Power 2026-07-30: it was abandoned as cf_rejected at 14:30, started
            // AGAIN at 14:39, and spent 56 minutes re-downloading the same 19 GB before preflight
            // could refuse it a second time. *arr's verdict is about the RELEASE, so it holds for
            // every future attempt at it — recording it costs nothing and saves a whole download.
            // Reuses auditSwapped, which the candidate filter ALREADY consults ("never offer back
            // what this row was swapped to") — so no new plumbing and no way for the two to drift.
            if (permanent) {
              auditSwapped.set(k, { hash: String(p.hash || '').toLowerCase(), rel: p.rel || null, ts: Date.now() });
              // ALSO record it per-RELEASE, not just per-row. auditSwapped holds ONE entry per film,
              // so a film that burns several refused releases forgets all but the last — and, worse,
              // it is only consulted by verifyRow. A verdict cached BEFORE the refusal keeps serving
              // the refused release to the UI for up to VERDICT_TTL_MS, where it renders as a normal
              // white candidate card. Brennan hit exactly that: clicking one returns the misleading
              // "no longer available from the indexers" 409, because the confirm path re-verifies and
              // the release vanishes underneath it. auditDead is keyed by release and IS consulted by
              // rankCands at serve time, so recording here is what makes cached verdicts self-clean.
              const dk = deadKey(p.rel);
              if (dk) auditDead.set(dk, { ts: Date.now(), hash: String(p.hash || '').toLowerCase(), title: p.rel || '', reason: 'cf_refused' });
              // NAME THE THING THAT IS WORSE. "scored it below the copy you already have" is true of
              // every refusal and therefore says nothing — on Gladiator it pointed a human at size and
              // picture quality when the entire deficit was one edition tag the filename had lost.
              // Brennan, 2026-08-12: "the rejection reason on the audit tab recent should say that it
              // was the wrong edition". cfDeficits reads the two format lists and reports exactly which
              // formats account for it, so the history row can be specific or stay silent — never vague.
              const lists = cfFormatsFromRejection(pre.reason);
              const defs = (cfAllow && lists.newFormats.length)
                ? cfDeficits(lists.oldFormats.length ? lists.oldFormats : cfAllow.oldFormats,
                  lists.newFormats, cfAllow.scoreByName, { editionOk: !!cfAllow.editionOk })
                : [];
              const why = defs.length
                ? `it is worse on ${defs.map((d) => d.name).join(', ')} — *arr will never accept it over your copy`
                : '*arr scored it below the copy you already have — it can never import';
              recordAuditOutcome({ title: p.title, rel: p.rel || null, outcome: 'refused', reason: 'cf_rejected',
                detail: why });
              console.log(`audit: remembering "${p.rel || p.hash}" as refused for "${p.title}" — it will not be offered again`);
            }
            auditPending.delete(k); persistState(); invalidateRows();
            // Say WHY in the abandon event too, not just the preflight one: the abandon is what the
            // UI and the monitors read, and "abandoned" with no reason is what made this look like a
            // fault to be chased rather than a release *arr correctly declined.
            metrics.emitEvent('audit_replace_abandon', { ti: p.title,
              reason: permanent ? 'cf_rejected' : 'preflight_giveup' });
          }
          continue;
        }
        // A movie replacement that offered more than one video is the GoodFellas shape exactly.
        // It is safe now (the importer submits only the chosen file) but it is worth saying out
        // loud, because it means the release carries extras and the choice mattered.
        if (p.app === 'radarr' && pre.offered > 1) {
          console.log(`audit: "${p.title}" replacement offers ${pre.offered} video files — importing only`
            + ` "${path.basename(pre.pick.path)}" (${gb(pre.pick.size)} GB)`);
        }
        // A season replacement must cover at least as many episodes as we are about to delete.
        // Fewer means the swap would leave a hole — the Westworld S01 near-miss, which survived
        // only because a second importer happened to fill the gap 12 seconds earlier.
        if (p.app === 'sonarr' && p.baseline && p.baseline.n && pre.episodeIds.length < p.baseline.n) {
          console.log(`audit: preflight refused the replacement for "${p.title}" — it covers`
            + ` ${pre.episodeIds.length} episode(s) but ${p.baseline.n} file(s) would be deleted`
            + ' — originals untouched, will retry');
          metrics.emitEvent('audit_replace_preflight_fail', { ti: p.title, reason: 'incomplete season',
            covers: pre.episodeIds.length, need: p.baseline.n });
          continue;
        }
        // ── IS IT THE WHOLE FILM? ────────────────────────────────────────────────────────────
        // The last preflight, and the one Chinatown (1974) needed on 2026-08-10: a correctly-named,
        // full-bitrate, 6.78 GB "1080p BluRay" holding 68 minutes of a 130-minute film. Nothing
        // above this line can see that. The name parses, the cardinality is one file, *arr scores it
        // fine, the container is valid — the ONLY evidence is the duration, and the download is
        // complete and on disk right now, so we can simply look.
        //
        // This has to happen HERE, above the delete, because the post-import check that already
        // existed caught it perfectly ("short: 68 min replacing 131 min (52%)") and was still
        // useless: by then the good 1.71 GB copy was gone, and its only repair was to re-import the
        // same short torrent. Measuring first turns unrecoverable data loss into a declined swap.
        //
        // FAILS OPEN, everywhere. No path, no duration, no yardstick → proceed exactly as before.
        // The gate may only ever refuse on positive evidence; an ffprobe hiccup must not start
        // declining healthy replacements. (runtimeVerdict returns 'unknown' for all of those.)
        const rtWant = await expectedRuntimeSecs(p).catch(() => 0);
        const rtGot = await probeTotalSecs(pre.paths);
        const rv = runtimeVerdict({ gotSecs: rtGot, filmSecs: rtWant, oldSecs: (p.baseline && p.baseline.secs) || 0 });
        if (rv.verdict === 'short') {
          // FIRST, before any bookkeeping. Everything below this line binds only the controller,
          // and the six seconds Chinatown had in hand were spent doing exactly that bookkeeping
          // while *arr imported behind us. Taking the release away from *arr is the only step here
          // that protects the file on disk, so it goes before the ones that protect our own state.
          await stopArrImport(p.app, p.hash, p.rel || p.title);
          // PERMANENT, and recorded per-RELEASE. "This release does not contain the whole film" is a
          // fact about the release, true for every future attempt at it — so it goes in auditDead
          // with a reason that never expires (see deadRelease), the way cf_refused does. Re-offering
          // it would cost another full download to reach the same answer.
          const dk = deadKey(p.rel);
          if (dk) auditDead.set(dk, { ts: Date.now(), hash: String(p.hash || '').toLowerCase(), title: p.rel || '', reason: 'short_runtime' });
          auditSwapped.set(k, { hash: String(p.hash || '').toLowerCase(), rel: p.rel || null, ts: Date.now() });
          recordAuditOutcome({ title: p.title, rel: p.rel || null, outcome: 'refused', reason: 'short_runtime',
            detail: `only ${runtimeShortDetail(rv)} — your copy was kept` });
          auditPending.delete(k); persistState(); invalidateRows();
          console.log(`audit: REFUSED the replacement for "${p.title}" — the downloaded release holds only`
            + ` ${runtimeShortDetail(rv)}. It is not the whole film, so it will not be offered again.`
            + ' NOTHING WAS DELETED — your existing copy is untouched.');
          metrics.emitEvent('audit_replace_abandon', { ti: p.title, reason: 'short_runtime',
            gotMin: Math.round(rv.gotSecs / 60), wantMin: Math.round(rv.wantSecs / 60), basis: rv.basis });
          continue;
        }
        if (rv.verdict === 'ok') {
          console.log(`audit: "${p.title}" replacement runtime checks out — ${Math.round(rv.gotSecs / 60)} min`
            + ` against ${Math.round(rv.wantSecs / 60)} min expected (${Math.round(rv.ratio * 100)}%)`);
        } else {
          // Said out loud on purpose. An unproven swap is allowed through, but a silent skip here is
          // indistinguishable from a passing check when someone reads the log after a bad import.
          console.log(`audit: "${p.title}" replacement runtime UNVERIFIED (probed ${rtGot ? Math.round(rtGot / 60) + ' min' : 'nothing'},`
            + ` expected ${rtWant ? Math.round(rtWant / 60) + ' min' : 'unknown'}) — proceeding, the post-import check still applies`);
        }
      }
      // Delete the OLD files through *arr, never off disk, so its DB stays consistent. The
      // delete MUST come first: importViaManual skips any candidate *arr rejects, and while the
      // original is still on disk every file in the replacement is rejected as "Not an upgrade".
      let removed = 0;
      for (const fid of (p.oldFileIds || [])) {
        const path = p.app === 'radarr' ? `/moviefile/${fid}` : `/episodefile/${fid}`;
        try { await arrDelete(p.app, path); removed++; } catch (e) { console.log(`audit: could not delete ${path} — ${e.message || e}`); }
      }
      // An import failure is NOT the end of the swap. It used to be swallowed by
      // `.catch(() => {})` while the entry was deleted and the swap logged as done — so a failed
      // import left the title with nothing and nothing ever retried. Keep the pending entry so
      // the next tick tries again against the same still-seeding torrent; the 48h abandon is the
      // backstop. This is recoverable now only because arrSweep no longer destroys the
      // replacement torrent mid-swap (see isAuditSwap in search-engine.js).
      let imported = 0;
      if (t.content_path) {
        // Pass the grab hash so *arr hardlinks instead of moving and closes its own queue item —
        // see the importViaManual header. The Audit swap is the ONLY caller that opts in; the
        // watchdog, gpu-verify and force-grab paths keep their existing behaviour.
        const res = await importViaManual(p.app, t.content_path, p.id, { downloadId: p.hash, cfAllow })
          .catch((e) => ({ ok: false, reason: String(e.message || e) }));
        if (!res || !res.ok) {
          console.log(`audit: import of replacement for "${p.title}" failed (${(res && res.reason) || 'unknown'}) — keeping the swap open, retrying next tick`);
          metrics.emitEvent('audit_replace_import_fail', { ti: p.title, removed, reason: String((res && res.reason) || 'unknown').slice(0, 120) });
          // Old files are gone, so don't try to delete them again on the retry.
          p.oldFileIds = []; persistState();
          continue;
        }
        imported = res.count || 0;
      }
      // NOT DONE YET. `imported` is the number of files SUBMITTED to an async *arr command, not the
      // number that landed — reporting it as an import count is what let GoodFellas log "3 new
      // file(s) imported" for a one-file movie without anything objecting. Hand off to the verify
      // phase, which reads *arr's own state back on the next tick and is the only thing allowed to
      // call this swap a success. oldFileIds is cleared because the originals are already gone.
      p.phase = 'verify'; p.importedAt = Date.now(); p.submitted = imported; p.removed = removed;
      p.oldFileIds = [];
      persistState();
      invalidateRows();
      console.log(`audit: import submitted for "${p.title}" — ${imported} file(s) offered to ${p.app},`
        + ` ${removed} old file(s) removed; verifying what actually landed`);
    } catch (e) { console.log(`audit: finalising "${p.title}" failed — ${e.message || e}`); }
    finally { _finalising.delete(k); }
  }
}

// ── Did the swap actually land the right thing? ───────────────────────────────────────────────
// Reads *arr's own state back, because that is the only source that knows what exists. Returns
// { state } where state is:
//   'ok'      — the replacement is present and plausible; landed = how many files
//   'pending' — nothing (or not everything) has landed yet; *arr may still be importing
//   'wrong'   — POSITIVE evidence the result is bad, with `bad` naming which way
//
// The asymmetry is deliberate and load-bearing: 'wrong' authorises deleting a file, so it is only
// ever returned on proof. Missing runtime metadata, an unreadable *arr response, a zero baseline —
// every one of those is 'pending' or 'ok', never 'wrong'. A false 'wrong' would destroy a good file,
// which is the exact failure this whole mechanism exists to prevent.
async function swapResult(p) {
  if (p.app === 'radarr') {
    let files;
    try { files = await arrGet('radarr', `/moviefile?movieId=${p.id}`); } catch { return { state: 'pending' }; }
    if (!Array.isArray(files)) return { state: 'pending' };
    if (!files.length) return { state: 'pending' };
    // More than one file on a movie should now be impossible (the importer submits exactly one),
    // but if it ever happens again we cannot tell which is the film — say so and touch nothing.
    if (files.length > 1) return { state: 'wrong', bad: 'multiple', files, detail: `${files.length} files on a one-file movie` };
    const f = files[0];
    const got = secs((f.mediaInfo || {}).runTime);
    // BOTH yardsticks, same as the preflight — see runtimeVerdict. This used to compare only against
    // the file being replaced, which is blind in the one case that matters most: if the copy on disk
    // was ALREADY short, a second short import passed as an upgrade. TMDB's runtime closes that.
    const filmSecs = await expectedRuntimeSecs(p).catch(() => 0);
    const rv = runtimeVerdict({ gotSecs: got, filmSecs, oldSecs: (p.baseline && p.baseline.secs) || 0 });
    // No runtime on either side = no evidence. Accept: unproven is not the same as wrong.
    if (rv.verdict === 'unknown') return { state: 'ok', landed: 1, detail: `1 file, ${gb(f.size || 0)} GB (runtime unverified)` };
    if (rv.verdict === 'short') return { state: 'wrong', bad: 'short', files, detail: runtimeShortDetail(rv) };
    return { state: 'ok', landed: 1, detail: `1 file, ${gb(f.size || 0)} GB, ${Math.round(got / 60)} min` };
  }
  // Sonarr: the season must hold at least as many files as we deleted. Counting episodes with files
  // (not episodefile rows) is what catches a hole, which is the only TV failure that matters.
  let eps;
  try { eps = await arrGet('sonarr', `/episode?seriesId=${p.id}&seasonNumber=${p.season}`); } catch { return { state: 'pending' }; }
  if (!Array.isArray(eps) || !eps.length) return { state: 'pending' };
  const have = eps.filter((e) => e.hasFile).length;
  const want = (p.baseline && p.baseline.n) || 0;
  if (!want) return { state: 'ok', landed: have, detail: `${have} episode file(s)` };
  if (have >= want) return { state: 'ok', landed: have, detail: `${have}/${eps.length} episode(s) present` };
  // Short of the baseline — could still be mid-import, so this is 'pending' until the window
  // expires. The caller decides when waiting becomes healing.
  return { state: 'pending', have, want, detail: `${have}/${want} episode(s) so far` };
}

// The verify phase. Success is declared HERE and nowhere else.
async function verifySwap(k, p) {
  const r = await swapResult(p).catch(() => ({ state: 'pending' }));
  if (r.state === 'ok') {
    // Remember WHAT this row now holds, so the verifier never offers it back. See auditSwapped.
    auditSwapped.set(k, { hash: String(p.hash || '').toLowerCase(), rel: p.rel || null, ts: Date.now() });
    auditPending.delete(k); persistState();
    invalidateRows();
    recordAuditOutcome({ title: p.title, rel: p.rel || null, outcome: 'replaced', reason: 'verified',
      detail: r.detail });
    console.log(`audit: replaced "${p.title}" — VERIFIED: ${r.detail}, ${p.removed || 0} old file(s) removed`);
    metrics.emitEvent('audit_replace_done', { ti: p.title, files: p.removed || 0, imported: r.landed,
      verified: true, submitted: p.submitted || 0 });
    return;
  }
  const waited = Date.now() - (p.importedAt || 0);
  if (r.state === 'pending' && waited < VERIFY_WINDOW_MS) return;      // *arr is probably still working
  // Either we have proof it is wrong, or it never landed. Both are repairable the same way: get rid
  // of anything provably bad and run the import again — the torrent is still seeding, and the
  // importer's cardinality guard means the retry picks the feature rather than an extras clip.
  const heals = (p.heals || 0) + 1;
  const why = r.state === 'wrong' ? `${r.bad}: ${r.detail}` : `nothing landed after ${Math.round(waited / 60000)} min`;
  // SOME FAILURES ARE NOT REPAIRABLE BY RE-IMPORTING, and 'short' is the one that matters. Healing
  // works by deleting the bad import and running the import again against the same still-seeding
  // torrent — which fixes an import that CHOSE wrongly (the GoodFellas extras clip), but can do
  // nothing about a release that does not contain the whole film. Chinatown burned both attempts
  // re-importing the identical 68-minute file before giving up.
  //
  // So stop on the first verdict, and — unlike the healing path — DO NOT DELETE THE FILE. The
  // originals are already gone by this point; a short film is a bad outcome, an empty one is worse,
  // and leaving it in place is what makes the damage visible in the library and in the runtime audit
  // instead of silently emptying the row. Record it as a release-level corpse so it is never offered
  // again, and leave it for a human, loudly.
  const unrepairable = r.state === 'wrong' && r.bad === 'short';
  if (unrepairable || heals > VERIFY_MAX_HEALS) {
    if (unrepairable) {
      const dk = deadKey(p.rel);
      if (dk) auditDead.set(dk, { ts: Date.now(), hash: String(p.hash || '').toLowerCase(), title: p.rel || '', reason: 'short_runtime' });
      auditSwapped.set(k, { hash: String(p.hash || '').toLowerCase(), rel: p.rel || null, ts: Date.now() });
      recordAuditOutcome({ title: p.title, rel: p.rel || null, outcome: 'failed', reason: 'short_runtime',
        detail: `imported only ${r.detail} — NEEDS A NEW COPY, pick one by hand` });
      console.log(`audit: the replacement that landed for "${p.title}" is NOT THE WHOLE FILM — ${r.detail}.`
        + ' Re-importing cannot fix a short source, so healing is skipped and the release is blocklisted.'
        + ` THIS TITLE NOW NEEDS A HUMAN: the original was already removed, so the library holds only the short copy.`);
      metrics.emitEvent('audit_replace_unrepaired', { ti: p.title, reason: `short_runtime: ${String(r.detail).slice(0, 100)}`,
        hash: p.hash || null, needsHuman: true });
      auditPending.delete(k); persistState(); invalidateRows();
      return;
    }
    recordAuditOutcome({ title: p.title, rel: p.rel || null, outcome: 'failed', reason: 'unrepaired',
      detail: `still wrong after ${VERIFY_MAX_HEALS} repair attempts — left for a human` });
    console.log(`audit: replacement for "${p.title}" is still wrong after ${VERIFY_MAX_HEALS} repair attempt(s)`
      + ` — ${why}. LEAVING IT FOR A HUMAN; the release is still seeding under hash ${String(p.hash || '').slice(0, 12)}`);
    metrics.emitEvent('audit_replace_unrepaired', { ti: p.title, reason: String(why).slice(0, 140), hash: p.hash || null });
    auditPending.delete(k); persistState();
    invalidateRows();
    return;
  }
  // Delete ONLY files this swap imported, and only when swapResult proved them wrong. A 'pending'
  // verdict means we never saw a bad file, so there is nothing to remove — just re-run the import.
  if (r.state === 'wrong' && Array.isArray(r.files)) {
    for (const f of r.files) {
      const route = p.app === 'radarr' ? `/moviefile/${f.id}` : `/episodefile/${f.id}`;
      try {
        await arrDelete(p.app, route);
        console.log(`audit: removed the wrong import for "${p.title}" (${path.basename(f.relativePath || f.path || String(f.id))})`);
      } catch (e) { console.log(`audit: could not remove wrong import ${route} — ${e.message || e}`); }
    }
  }
  p.heals = heals; p.phase = null; p.importedAt = null;
  persistState();
  console.log(`audit: replacement for "${p.title}" failed verification (${why})`
    + ` — repairing, attempt ${heals}/${VERIFY_MAX_HEALS}`);
  metrics.emitEvent('audit_replace_repair', { ti: p.title, attempt: heals, reason: String(why).slice(0, 140) });
}

function startAuditVerifier() {
  // Announce swaps that survived a restart. auditPending is persisted precisely so a reboot
  // mid-swap resumes instead of stranding a title between two copies, but a silent resume is
  // indistinguishable from a bug when someone is reading the log later.
  if (auditPending.size) {
    for (const [, p] of auditPending) {
      const age = Math.round((Date.now() - p.ts) / 60000);
      console.log(`audit: resuming pending replacement of "${p.title}" (started ${age} min ago, ${(p.oldFileIds || []).length} old file(s) still in place)`);
    }
    metrics.emitEvent('audit_replace_resume', { n: auditPending.size });
  }
  const tVerify = jobs.define({
    // NAMED FOR THE THING SOMEONE GOES LOOKING FOR. "Source check" described the mechanism (it
    // runs searches) and so hid the job: this IS the library audit behind the Audit tab — the long
    // fortnightly pass over every file. Brennan scanned the Jobs tab for it on 2026-08-09, read
    // straight past this row, and concluded the audit had no row at all. The schedule text made
    // that worse: "one search every 45s while rows remain" is true of a tick and says nothing
    // about the 14-day cycle or the ~85 min a full pass costs, which is exactly what someone
    // deciding whether to re-run it needs.
    // Both this and the probe are named "Audit …" because both are read FROM the Audit tab and are
    // the two jobs a human is most likely to want to fire by hand. Weights 100/95 keep them the
    // top two rows; the shared prefix keeps them adjacent and findable by the word someone is
    // actually scanning for.
    id: 'audit-verify', name: 'Audit · source check', group: 'Audit', weight: 95,
    what: 'Re-checks every file for a better available source',
    // `every: null` on purpose, exactly as the probe does it. The tick still fires every 45s, but
    // outside the night window it returns at the gate — so a "next run in 45s" countdown would be
    // true of the tick and a lie about the work. cadenceMs = the 14-day verdict TTL, which is how
    // often a given file actually comes round; that is what the chip and the sort must use.
    every: null, cadenceMs: VERDICT_TTL_MS,
    scheduleText: `nightly ${String(AUDIT_WINDOW_START).padStart(2, '0')}:00–${String(AUDIT_WINDOW_END).padStart(2, '0')}:00`
      + ` · each file re-checked every ${Math.round(VERDICT_TTL_MS / 86400000)} days`,
    pausedByMovieMode: true,
    // Run = a manual session: ignore the window and work through the backlog now, until stopped or
    // done. Recheck = drop every cached verdict so the whole library comes round again.
    actions: ['start-sweep', 'recheck-sources'],
  }, verifyTick);
  // Weight 94 — directly under the source check it yields to, so the three jobs someone opens the
  // Audit tab to think about read as one block at the top.
  const tUpgrade = jobs.define({
    id: 'audit-upgrade', name: 'Audit · upgrade scan', group: 'Audit', weight: 94,
    what: 'Finds replacement options for films below their quality target',
    every: null, cadenceMs: VERDICT_TTL_MS,
    scheduleText: `nightly ${String(AUDIT_WINDOW_START).padStart(2, '0')}:00–${String(AUDIT_WINDOW_END).padStart(2, '0')}:00`
      + ` · every film under BPP+ ${UPGRADE_BPP_PLUS_MAX}, re-checked every ${Math.round(VERDICT_TTL_MS / 86400000)} days`
      + ' · never replaces anything',
    pausedByMovieMode: true,
    actions: ['start-sweep', 'rescan-upgrades'],
  }, upgradeScanTick);
  // A session drives its sweep back-to-back rather than waiting out the interval, so it needs the
  // TRACKED wrappers (not the bare ticks) — otherwise session work would not register as runs.
  AUDIT_TICKS['audit-verify'] = tVerify;
  AUDIT_TICKS['audit-upgrade'] = tUpgrade;
  const tWarm = jobs.define({
    id: 'audit-warm', name: 'Audit · row cache', group: 'Audit', weight: 48,
    what: 'Keeps the Audit tab fast',
    every: WARM_EVERY_MS, scheduleText: 'every 9 min', pausedByMovieMode: true,
  }, warmTick);
  const tReplace = jobs.define({
    id: 'audit-replace', name: 'Audit · replacement finaliser', group: 'Audit', weight: 46,
    what: 'Finishes file replacements',
    every: 60000, scheduleText: 'every 60s', pausedByMovieMode: true,
  }, replaceSweep);

  verifyTimer = setInterval(tVerify, VERIFY_EVERY_MS);
  setInterval(tWarm, WARM_EVERY_MS);
  setInterval(tReplace, 60000);    // finalise completed swaps once a minute
  setInterval(tUpgrade, UPGRADE_EVERY_MS);
  setTimeout(tWarm, 45000);        // populate soon after boot so the first visit is fast
  setTimeout(tVerify, 8 * 60000);  // 8 min after boot — well clear of the startup rush
  // Later than tVerify on purpose: the source check should own the indexer for the first stretch
  // after a restart, and the upgrade scan's own tick yields to it anyway.
  setTimeout(tUpgrade, 12 * 60000);
}

// Mark rows with a swap ALREADY IN FLIGHT, and report its HEALTH rather than merely its existence.
// The server has always known this (it 409s a second attempt) but the tab used to offer a Replace
// button for a title it was mid-way through swapping.
//
// Audit swaps are deliberately exempt from stallRecovery (which was deleting in-flight swaps and
// destroying libraries), so a dead swarm sits untouched until the 48h abandon with NOTHING retrying
// it. Reporting that as plain "swapping · 445 min" is indistinguishable from progress — which is why
// a dead American Gods swap read as active. Report-only: a stalled swap is surfaced for a human to
// cancel or leave, never auto-cancelled.
//
// SHARED by /api/audit and /api/audit/upgrade. The Upgrade tab used to set a bare { since, rel },
// so its rows greyed out but could not say WHY, and drifted from the other sections' styling the
// moment either changed. One implementation, one shape, no drift.
const STALL_QUIET_MS = 45 * 60 * 1000;   // no swarm activity this long = not coming back on its own
function annotateSwaps(rows, torByHash, keyOf) {
  for (const r of rows) {
    const p = auditPending.get(keyOf(r));
    if (!p) continue;
    r.swapping = { since: p.ts, rel: p.rel || null };
    if (!p.hash) { r.swapping.health = 'pending'; continue; }   // hash not yet recovered from *arr's queue
    const t = torByHash.get(String(p.hash).toLowerCase());
    if (!t) {
      // Absent is only "gone" once replaceSweep would actually abandon it. *arr needs a moment to
      // hand a grab to qBittorrent, so a swap seconds old has no torrent yet and was reporting
      // "torrent gone · abandoning · just started" — three contradictory things, the first two
      // false and alarming. Same constant as the abandon itself so they cannot disagree.
      r.swapping.health = (Date.now() - p.ts > VANISHED_AFTER_MS) ? 'gone' : 'pending';
      continue;
    }
    const quietMs = t.last_activity ? Date.now() - t.last_activity * 1000 : 0;
    r.swapping.progress = t.progress || 0;
    r.swapping.seeds = typeof t.num_seeds === 'number' ? t.num_seeds : null;
    r.swapping.dlKbps = Math.round((t.dlspeed || 0) / 1024);
    r.swapping.etaMin = t.eta && t.eta < 8640000 ? Math.round(t.eta / 60) : null;
    r.swapping.quietMin = Math.round(quietMs / 60000);
    // Do NOT gate this on the state string. qBittorrent reports a dead swarm as any of
    // stalledDL / metaDL / queuedDL / downloading-with-no-peers, and requiring /stalled/ let
    // Rings of Power sit at 0% for 89 min with 0 seeds while still rendering as "swapping" —
    // the very row that read as active when there was no active download. Movement is the only
    // honest signal: no bytes for STALL_QUIET_MS on an incomplete torrent is stalled, whatever
    // qBittorrent calls it. A user-paused torrent reports stalled too, which is also true.
    const dead = (t.progress || 0) < 1 && !t.dlspeed && quietMs > STALL_QUIET_MS;
    // QUEUED IS ITS OWN ANSWER, and it outranks 'stalled'. The comment above is right that a state
    // string is a bad liveness signal — but `queuedDL` is not a claim about the swarm at all, it is
    // qBittorrent saying "I have not started this one yet" because max_active_downloads is full.
    // Such a torrent has no dlspeed and no activity by definition, so the movement test calls every
    // queued swap stalled, which is how a batch of 60 healthy grabs read as 60 dead ones. It waits,
    // and the row should say so.
    const queued = (t.progress || 0) < 1 && QBIT_IDLE_STATES.has(String(t.state || ''));
    r.swapping.health = (t.progress || 0) >= 1 ? 'importing'
      : queued ? 'queued' : dead ? 'stalled' : 'downloading';
  }
}

// ---- routes ───────────────────────────────────────────────────────────────────────────────
// GET /api/audit — the whole tab in one payload. Reads cached verdicts only; never searches.
app.get('/api/audit', async (req, res) => {
  try {
    const { cpu, bitrate, edition } = await buildRows(req.query.refresh === '1');
    // One cached lookup for the whole payload — see the same guard in verifyRow. Empty set on
    // failure, so a qBittorrent hiccup never blanks the candidate lists.
    let haveHashes = new Set();
    let torByHash = new Map();
    try {
      const ts = await getQbitTorrents();
      haveHashes = new Set(ts.map((t) => String(t.hash || '').toLowerCase()));
      torByHash = new Map(ts.map((t) => [String(t.hash || '').toLowerCase(), t]));
    } catch { /* qBit unreachable — show everything rather than nothing */ }
    // Candidates are RE-RANKED and re-enriched here, at serve time, not read back in the order
    // they were cached. Ranking and badges are presentation, not filtering, so deriving them on
    // the way out means a ranking fix applies to every verdict already on disk instead of
    // needing a VERDICT_VERSION bump and hours of re-verification. `best` is recomputed from the
    // same sort so the row headline and the sheet can never disagree.
    const decorate = (rows, section) => rows.map((r) => {
      const v = verdictFor(r.key, section);
      if (!v) return { ...r, verdict: null };
      const prio = candPriority(r);
      const fresh = Array.isArray(v.candidates) ? v.candidates.map((c) => rescoreCand(c, r, prio)) : null;
      const ranked = fresh ? rankCands(fresh, r, haveHashes, section) : [];
      // NEVER fall back to the cached `v.best` when the row HAS a candidate list. `best` was
      // chosen at verify time, before the serve-time refusals existed, so the fallback resurrects
      // exactly what rankCands() just threw out: on 2026-07-28 it kept offering
      // Silicon.Valley.S0{1,2}.ITA as the headline pick with an empty candidate list underneath.
      // A row whose every candidate was refused is not improvable — it has nothing to offer.
      const hadList = Array.isArray(v.candidates);
      // First candidate *arr can actually accept, not merely the first candidate. rankCands sinks
      // cfBlocked to the bottom, so ranked[0] is usually right — but when EVERY option scores at or
      // below the file on disk it would headline a release that is guaranteed to be refused.
      const best = ranked.find((c) => !c.cfBlocked)
        || (hadList ? null : rescoreCand(v.best, r, prio)) || null;
      const state = v.state === 'improvable' && !best ? 'none' : v.state;
      return { ...r, verdict: { state, ts: v.ts, stale: !!v.stale, reason: v.reason,
        best, candidates: ranked } };
    });
    // refresh=1 must force the stale scan too, not just the row build. It did not, which is
    // how a mid-delete snapshot got pinned for 12 minutes after the 2026-07-27 reclaim: the
    // client's post-confirm reload re-scanned while qBittorrent was still unlinking, saw files
    // whose torrents were already deregistered, and cached 21 phantom "no torrent" rows.
    const stale = await staleTorrents(req.query.refresh === '1');
    const trend = metrics.queryMetrics('events', { limit: 4000 })
      .filter((e) => e.type === 'cpu_census')
      .slice(-30)
      .map((e) => ({ ts: e.ts, gb: (e.mvGb || 0) + (e.tvGb || 0), files: (e.mv || 0) + (e.tv || 0) }));
    const c = decorate(cpu, 'cpu'), b = decorate(bitrate, 'bitrate'), ed = decorate(edition, 'edition');
    // Mark rows with a swap ALREADY IN FLIGHT. The server has always known this (it 409s a second
    // attempt) but never said so, leaving the tab happy to offer a Replace button for a title it
    // was mid-way through swapping. Now the row can say "swapping" and grey itself out.
    annotateSwaps([...c, ...b, ...ed], torByHash, (r) => `${r.app}:${r.id}:${r.season ?? '-'}`);
    const pend = [...c, ...b, ...ed].filter((r) => !r.verdict || r.verdict.stale).length;
    // Headline figures count ONLY rows with a confirmed better source. A total that includes
    // rows we cannot act on overstates the opportunity — the tab exists to show what is
    // actually reclaimable, and that number should fall as swaps are done.
    const act = (rows) => rows.filter((r) => r.verdict && r.verdict.state === 'improvable' && !r.verdict.stale);
    const ac = act(c), ab = act(b);
    res.json({
      cpu: c, bitrate: b, edition: ed, stale,
      totals: {
        cpuRows: ac.length, cpuFiles: ac.reduce((a, r) => a + r.files, 0), cpuGb: gb(ac.reduce((a, r) => a + r.bytes, 0)),
        // NET disk change, and it can be NEGATIVE for Playback now that source upgrades and
        // larger-but-better replacements are accepted there. Fixing playback is allowed to cost
        // disk — that is the trade — so this must not be clamped or presented as a "saving":
        // after the v8 re-scrape it came out at -187 GB, which the tile would have rendered as a
        // recoverable figure. The client labels it "saves"/"costs" from the sign.
        cpuSaveGb: gb(ac.reduce((a, r) => a + (r.verdict.best ? r.bytes - r.verdict.best.bytes : 0), 0)),
        bitrateRows: ab.length, bitrateGb: gb(ab.reduce((a, r) => a + r.bytes, 0)),
        bitrateSaveGb: gb(ab.reduce((a, r) => a + (r.verdict.best ? r.bytes - r.verdict.best.bytes : 0), 0)),
        staleRows: stale.rows.length, staleGb: gb(stale.bytes || 0),
        // Deliberately NOT filtered by act() (verdict === 'improvable'): a wrong cut is a problem
        // whether or not a better release happens to be seeded today. Reporting only the fixable
        // ones would hide the fact that the file is wrong, which is the thing worth knowing.
        editionRows: ed.length, editionFixable: act(ed).length,
        unverified: pend, etaMin: Math.ceil(pend * VERIFY_EVERY_MS / 60000),
        // The DENOMINATOR pend is out of, so the client can draw a real progress bar instead of
        // inventing a percentage from a count with nothing to divide by. Same row set pend counts.
        verifyTotal: c.length + b.length + ed.length,
      },
      trend,
      // RECENT OUTCOMES — sent WHOLE. An earlier cut served only the newest 24, which is fine for
      // idle browsing and useless for the case this exists for: after a 74-title batch, the 24 most
      // recent outcomes are all from the tail of that batch and everything that failed early is
      // invisible. The ring is already bounded (AUDIT_HISTORY_MAX) and costs ~22 KB, which is small
      // next to the candidate lists in this same payload.
      history: auditHistory.slice(),
    });
  } catch (e) {
    // LOG the stack, don't just hand a 500 to the browser. A 500 with no server-side trace is
    // undiagnosable — the Supernatural S09 Replace failure on 2026-07-28 produced a bare "500"
    // in the UI and NOTHING in the log, so there was nothing to work from.
    console.log(`audit: ${req.method} ${req.path} failed — ${(e && e.stack) || e}`);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// POST /api/audit/verify {section, key} — re-check ONE row now. 5-21s, spinner-friendly.
app.post('/api/audit/verify', async (req, res) => {
  const { section, key } = req.body || {};
  if (!['cpu', 'bitrate', 'edition', 'upgrade'].includes(section) || !key) return res.status(400).json({ error: 'section and key required' });
  try {
    const rows = await buildRows();
    const row = (rows[section] || []).find((r) => r.key === key);
    if (!row) return res.status(404).json({ error: 'row not found' });
    const v = await verifyRow(row, section, rows.depthMap, rows.seriesNorm);
    auditVerdicts.set(`${section}:${key}`, v);
    persistVerdicts();
    res.json({ key, section, verdict: v });
  } catch (e) {
    // LOG the stack, don't just hand a 500 to the browser. A 500 with no server-side trace is
    // undiagnosable — the Supernatural S09 Replace failure on 2026-07-28 produced a bare "500"
    // in the UI and NOTHING in the log, so there was nothing to work from.
    console.log(`audit: ${req.method} ${req.path} failed — ${(e && e.stack) || e}`);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// POST /api/audit/rescan — throw away every cached verdict so the whole library is re-checked.
//
// A verdict is normally trusted for VERDICT_TTL_MS (14 days), which is right for a background sweep
// but means "is there something better yet?" cannot be asked on demand. Indexer availability moves
// far faster than a fortnight: a release that had 2 seeds last week may have 200 today.
//
// READ-ONLY, despite clearing state. The verifier only SEARCHES indexers and caches what it finds;
// grabbing and deleting happen exclusively through /api/audit/replace, which a human drives. So the
// worst this can do is spend indexer requests and make the tab briefly say "checking" again — which
// GET /api/audit/upgrade?q=&offset=&limit= — the whole movie library, ranked and PAGED.
//
// Separate from /api/audit rather than another array on it, for two reasons that both matter at 805
// rows: that response already carries ~140 verdict-bearing rows plus the stale scan, and adding every
// movie would roughly quintuple it on a request the tab makes on every load; and this list needs
// SEARCH + PAGING, which the other sections do not.
//
// PAGED SERVER-SIDE, not client-side. The client could hold all 805 lightweight rows, but each one
// gains a decorated verdict (up to 24 candidates) once checked, and shipping those for films nobody
// has scrolled to is waste. The filter runs on the precomputed lowercase `q` field so a keystroke is
// a substring scan over 805 short strings, not a re-lowercasing of the library.
//
// READ-ONLY. No verdict is computed here — rows arrive with whatever the cache already holds, and the
// candidate search happens only when a human opens a row (POST /api/audit/verify, section=upgrade).
// That is the whole reason this can list the entire library: 805 paced searches would be ~10 hours.
app.get('/api/audit/upgrade', async (req, res) => {
  try {
    const { upgrade } = await buildRows();
    const q = String(req.query.q || '').trim().toLowerCase();
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(120, Math.max(1, parseInt(req.query.limit, 10) || 40));
    // DEFENSIVE on r.q, because the blast radius is the whole tab rather than one row: a single row
    // constructed without `q` threw "Cannot read properties of undefined (reading 'includes')" and
    // broke search for the entire library (2026-08-12, the unprobed-file rows). Falling back to the
    // title keeps an under-populated row searchable instead of taking every other row down with it.
    const hay = (r) => (typeof r.q === 'string' ? r.q : String(r.title || '').toLowerCase());
    const matched = q ? upgrade.filter((r) => hay(r).includes(q)) : upgrade;
    const page = matched.slice(offset, offset + limit);
    // Decorate only the page. verdictFor() is cheap but rankCands() is not, and running it over the
    // whole library per request would undo the point of paging.
    let haveHashes = new Set();
    try { haveHashes = new Set((await getQbitTorrents()).map((t) => String(t.hash || '').toLowerCase())); } catch { /* qbit down */ }
    const rows = page.map((r) => {
      const v = verdictFor(r.key, 'upgrade');
      if (!v) return { ...r, verdict: null };
      // Re-scored against today's complexity target, exactly as decorate() does — see rescoreCand().
      const prio = candPriority(r);
      const fresh = Array.isArray(v.candidates) ? v.candidates.map((c) => rescoreCand(c, r, prio)) : null;
      const ranked = fresh ? rankCands(fresh, r, haveHashes, 'upgrade') : [];
      const best = ranked.find((c) => !c.cfBlocked) || null;   // see the note in /api/audit
      return { ...r, verdict: { state: v.state === 'improvable' && !best ? 'none' : v.state,
        ts: v.ts, stale: !!v.stale, reason: v.reason, best, candidates: ranked } };
    });
    // In-flight swaps are flagged through the SAME helper the other sections use, so an Upgrade row
    // mid-swap renders identically to a Playback or Bitrate one — same health pills, same greyed-out
    // treatment — instead of a bare "replacing now…" that could not say whether it was moving.
    // Only paged rows are annotated (40 at a time), so this costs one qBittorrent read, not 805.
    let upgTors = new Map();
    try { upgTors = new Map((await getQbitTorrents()).map((t) => [String(t.hash || '').toLowerCase(), t])); }
    catch { /* qBit unreachable — rows still render, just without swap health */ }
    annotateSwaps(rows, upgTors, (r) => `${r.app}:${r.id}:-`);
    res.json({ rows, total: matched.length, libraryTotal: upgrade.length, offset, limit, q });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// is why it needs no dry run and no confirmation dialog.
//
// It does not verify anything itself. It clears, and lets the existing paced verifier do the work at
// VERIFY_EVERY_MS — one search per tick, deliberately gentle on public indexers. Doing it inline
// would mean a single request holding ~114 searches open.
// `dryRun` reports what WOULD be re-checked and changes nothing — the same convention as
// /api/audit/stale/reclaim. It exists so the endpoint can be exercised without spending an
// ~85-minute library-wide re-scrape, and so a caller can show the cost before committing to it.
// SCOPED to the source check's own verdicts. `upgrade:`-prefixed keys belong to the upgrade scan,
// which is a separate row with a separate button and a much longer backlog (754 films at one search
// a minute). A blanket clear() here would silently throw away hours of that sweep's progress as a
// side effect of pressing a button labelled "re-check every SOURCE" — see /api/audit/upgrade-rescan.
const isUpgradeKey = (k) => String(k).startsWith('upgrade:');
app.post('/api/audit/rescan', async (req, res) => {
  try {
    const keys = [...auditVerdicts.keys()].filter((k) => !isUpgradeKey(k));
    const before = keys.length;
    if ((req.body || {}).dryRun) {
      return res.json({ dryRun: true, wouldDrop: before, paused: isMasterPaused(),
        etaMinutes: Math.round((before * VERIFY_EVERY_MS) / 60000) });
    }
    for (const k of keys) auditVerdicts.delete(k);
    persistVerdicts();
    invalidateRows();
    // Tell the truth about how long this takes, and about Movie Mode — the verifier is paused while
    // streaming, so a rescan started then would look silently broken.
    const paced = Math.round((before * VERIFY_EVERY_MS) / 60000);
    const paused = isMasterPaused();
    console.log(`audit: manual rescan — dropped ${before} cached verdict(s); re-checking at one per `
      + `${Math.round(VERIFY_EVERY_MS / 1000)}s (~${paced} min)${paused ? ' — PAUSED until Movie Mode is off' : ''}`);
    metrics.emitEvent('audit_rescan', { dropped: before, paused });
    res.json({ ok: true, dropped: before, etaMinutes: paced, paused });
  } catch (e) {
    console.log(`audit: ${req.method} ${req.path} failed — ${(e && e.stack) || e}`);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// POST /api/audit/upgrade-rescan — the upgrade scan's equivalent of /api/audit/rescan.
//
// The sweep is self-driving (one search a minute, forever), so this is not "start it" — it is
// "forget what you found and look again". Worth having its own button anyway: the scan's answer for
// a given film is cached for 14 days, and indexer availability moves far faster than that, so
// without this the only way to re-ask "is there something better yet?" for the whole upgrade list is
// to wait out the TTL.
//
// READ-ONLY, exactly like the source-check rescan and for the same reason: this sweep SEARCHES and
// caches. It never grabs and never replaces — a replacement is always a human pressing the button on
// a row. The worst case here is spent indexer requests.
app.post('/api/audit/upgrade-rescan', async (req, res) => {
  try {
    const keys = [...auditVerdicts.keys()].filter(isUpgradeKey);
    const before = keys.length;
    if ((req.body || {}).dryRun) {
      return res.json({ dryRun: true, wouldDrop: before, paused: isMasterPaused(),
        etaMinutes: Math.round((before * UPGRADE_EVERY_MS) / 60000) });
    }
    for (const k of keys) auditVerdicts.delete(k);
    persistVerdicts();
    invalidateRows();
    const paced = Math.round((before * UPGRADE_EVERY_MS) / 60000);
    const paused = isMasterPaused();
    console.log(`audit: manual upgrade rescan — dropped ${before} cached verdict(s); re-checking at `
      + `one per ${Math.round(UPGRADE_EVERY_MS / 1000)}s (~${paced} min)`
      + `${paused ? ' — PAUSED until Movie Mode is off' : ''}`);
    metrics.emitEvent('audit_upgrade_rescan', { dropped: before, paused });
    res.json({ ok: true, dropped: before, etaMinutes: paced, paused });
  } catch (e) {
    console.log(`audit: ${req.method} ${req.path} failed — ${(e && e.stack) || e}`);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// POST /api/audit/session/:job/(start|stop) — run a nightly audit sweep NOW.
//
// Both sweeps are gated to the night window, which is right for the schedule and wrong for a human
// who wants an answer today. A session lifts the window gate for one sweep and paces it at
// AUDIT_SESSION_GAP_MS until it is stopped or the backlog is empty. Everything else still applies:
// Movie Mode pauses it, the shared auditBusy lock still allows exactly one indexer search in
// flight, and NEITHER SWEEP EVER GRABS OR REPLACES — a session only fills the same verdict cache
// the nightly run fills.
//
// :job is whitelisted rather than passed through, so this can never reach into the jobs registry
// for an id it was not meant to drive.
const SESSION_JOBS = new Set(['audit-verify', 'audit-upgrade']);
app.post('/api/audit/session/:job/:act', (req, res) => {
  const job = String(req.params.job || '');
  const act = String(req.params.act || '');
  if (!SESSION_JOBS.has(job)) return res.status(404).json({ error: `no such audit sweep: ${job}` });
  if (act === 'start') {
    const already = !!auditSessionFor(job);
    auditSessionStart(job);
    return res.json({ ok: true, started: !already, alreadyRunning: already, window: inAuditWindow() });
  }
  if (act === 'stop') {
    const s = auditSessionStop(job, 'stopped by request');
    return res.json({ ok: true, stopped: !!s, ...(s || {}) });
  }
  return res.status(400).json({ error: 'act must be start or stop' });
});

// POST /api/audit/stale/reclaim — the ONLY mutating endpoint on this tab.
//
// SAFETY MODEL (this deletes files; read before changing):
//   1. The client's hash list is a FILTER, never authority. The server re-runs the whole
//      stale scan and re-derives COVERED/LOST/UNPROVEN, so a stale browser tab or a crafted
//      request can never widen the blast radius. Anything not COVERED right now is refused.
//   2. PER-TORRENT deletes, not a batch. qBittorrent's batch delete was observed on
//      2026-07-27 returning HTTP 200 while silently leaving ~201 GiB of files on disk.
//   3. Post-delete VERIFICATION. Every torrent's files are stat'd afterwards; anything still
//      present is reported back as `leftover` rather than assumed gone. Trusting the 200 is
//      exactly the mistake that produced the orphan pile.
//   4. dryRun defaults TRUE. The caller must opt in to the real thing.
// Removing a hardlinked file would only drop one name and leave the library's own intact, so
// even a misclassification cannot destroy a watchable file — the loss is the seed.
// Wait for a WHOLE BATCH of paths to disappear, polling until the set empties or the deadline.
// Returns the set that survived — empty means every delete really landed.
//
// This is deliberately ONE pass over all torrents rather than a per-torrent wait. Waiting per
// torrent serialised the timeouts: a 16-torrent reclaim spent 16 x 15s = 4 minutes, because
// qBittorrent needs well over 15s to unlink a 50 GB multi-file torrent so every single one hit
// its full timeout. Issuing all the deletes first and then watching them clear together costs
// roughly the real unlink time instead of the sum of worst cases.
//
// The budget scales with the batch: unlinking 221 GB genuinely takes longer than 2 GB, and a
// fixed timeout is either too short to be truthful or too long to be tolerable.
const LEFTOVER_POLL_MS = 1000;
const leftoverBudgetMs = (totalGb) => Math.min(300000, 20000 + totalGb * 600);
async function waitForUnlink(paths, totalGb, onTick) {
  const present = () => paths.filter((p) => { try { fs.statSync(p); return true; } catch { return false; } });
  const deadline = Date.now() + leftoverBudgetMs(totalGb);
  let left = present();
  while (left.length && Date.now() < deadline) {
    await new Promise((z) => setTimeout(z, LEFTOVER_POLL_MS));
    left = present();
    if (onTick) onTick(left.length);
  }
  return new Set(left);
}

app.post('/api/audit/stale/reclaim', async (req, res) => {
  const { hashes, dryRun = true } = req.body || {};
  if (!Array.isArray(hashes) || !hashes.length) return res.status(400).json({ error: 'hashes[] required' });
  // Movie Mode means someone is watching and the disk is meant to be left alone. Deleting a
  // few hundred GB is exactly the I/O it exists to prevent, so refuse rather than compete —
  // even though this is user-initiated. A dry run is read-only and stays allowed.
  if (!dryRun && isMasterPaused()) {
    return res.status(409).json({ error: 'Movie Mode is on — turn it off before reclaiming' });
  }
  const want = new Set(hashes.map((h) => String(h).toLowerCase()));
  try {
    _staleCache = { ts: 0, val: null };                 // force a fresh scan; never act on cached state
    const st = await staleTorrents();
    const eligible = st.rows.filter((r) => r.hash && r.cov === 'COVERED' && want.has(String(r.hash).toLowerCase()));
    const refused = [...want].filter((h) => !eligible.some((r) => String(r.hash).toLowerCase() === h));
    if (dryRun) {
      return res.json({ dryRun: true, wouldRemove: eligible.map((r) => ({ hash: r.hash, title: r.title, files: r.files, gb: gb(r.bytes) })),
        gb: gb(eligible.reduce((a, r) => a + r.bytes, 0)), refused });
    }
    // INTENT is recorded before anything is destroyed. If the controller dies mid-run the
    // event log still shows exactly what was about to be removed — without this, a crash
    // between the qBittorrent call and the summary event leaves no trace at all.
    metrics.emitEvent('audit_reclaim_start', { n: eligible.length, gb: gb(eligible.reduce((a, r) => a + r.bytes, 0)),
      hashes: eligible.map((r) => String(r.hash).slice(0, 12)) });
    console.log(`audit: reclaim starting — ${eligible.length} torrents, ${gb(eligible.reduce((a, r) => a + r.bytes, 0))} GB`);
    // PHASE 1 — issue every delete, waiting on none of them. qBittorrent's delete is
    // ASYNCHRONOUS (the 200 means "accepted", not "unlinked"), so there is nothing to gain by
    // pausing between calls, and pausing is what made a 16-torrent reclaim take four minutes.
    const done = [];
    const totalGb = gb(eligible.reduce((a, r) => a + r.bytes, 0));
    for (const r of eligible) {
      let ok = false;
      try {
        const resp = await qbit.fetch('/api/v2/torrents/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ hashes: r.hash, deleteFiles: 'true' }), ms: 30000,
        });
        ok = resp.ok;
      } catch { ok = false; }
      done.push({ hash: r.hash, title: r.title, gb: gb(r.bytes), ok, paths: r.paths || [], leftover: 0 });
      // PER-TORRENT event, emitted as soon as the call returns rather than after verification,
      // so a crash during the wait still leaves a record of what was actually asked for.
      metrics.emitEvent('audit_reclaim_item', { ti: r.title.slice(0, 80), hash: String(r.hash).slice(0, 12),
        gb: gb(r.bytes), ok });
      console.log(`audit: delete accepted for "${r.title}" (${gb(r.bytes)} GB) — qbit ok=${ok}`);
    }
    // PHASE 2 — watch them all clear together. Budget scales with the batch, and it returns the
    // instant the disk is actually clean, so a small reclaim is quick and a 221 GB one takes
    // about as long as the filesystem genuinely needs.
    const allPaths = done.filter((x) => x.ok).flatMap((x) => x.paths);
    console.log(`audit: waiting for ${allPaths.length} file(s) to be unlinked (budget ${Math.round(leftoverBudgetMs(totalGb) / 1000)}s)`);
    const survived = await waitForUnlink(allPaths, totalGb);
    for (const x of done) {
      const left = x.paths.filter((p) => survived.has(p));
      x.leftover = left.length;
      if (left.length) {
        // The count alone is not enough to act on a real leftover — you need the path to go and
        // look. /data is read-only here, so this is the only way it becomes recoverable.
        console.log(`audit: WARNING "${x.title}" — ${left.length} file(s) still on disk`);
        console.log(`audit: leftover paths — ${left.join(' | ')}`);
        metrics.emitEvent('audit_reclaim_leftover', { ti: x.title.slice(0, 80), n: left.length });
      }
      delete x.paths;                                   // response carries counts, not the tree
    }
    _staleCache = { ts: 0, val: null };
    const freed = done.filter((x) => x.ok && !x.leftover).reduce((a, x) => a + x.gb, 0);
    metrics.emitEvent('audit_reclaim', { n: done.length, gb: +freed.toFixed(1), leftover: done.filter((x) => x.leftover).length });
    console.log(`audit: reclaim finished — freed ${freed.toFixed(1)} GB, ${done.filter((x) => x.leftover).length} with leftovers`);
    res.json({ dryRun: false, removed: done, freedGb: +freed.toFixed(1), refused,
      leftover: done.filter((x) => x.leftover) });
  } catch (e) {
    // LOG the stack, don't just hand a 500 to the browser. A 500 with no server-side trace is
    // undiagnosable — the Supernatural S09 Replace failure on 2026-07-28 produced a bare "500"
    // in the UI and NOTHING in the log, so there was nothing to work from.
    console.log(`audit: ${req.method} ${req.path} failed — ${(e && e.stack) || e}`);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// POST /api/audit/replace {section, key, guid, dryRun} — swap one row for a chosen candidate.
//
// SAFETY MODEL (this deletes media; read before changing):
//   1. The client picks a GUID; it does not describe the work. The server re-derives the row
//      and its candidate list and REFUSES any guid not currently among them. A stale tab
//      cannot grab something the filters would reject today.
//   2. ZERO-GAP. The replacement is grabbed and NOTHING is deleted. replaceSweep() removes the
//      old files only after the new download completes. If it never completes, the swap is
//      abandoned at 48h and the original stays. A title never has zero copies.
//   3. Old files are deleted THROUGH *arr, never off disk, so its database stays consistent.
//   4. Import is handed to the existing importViaManual path — the same one the watchdog and
//      gpu-verify use — rather than a second, divergent implementation.
//   5. dryRun defaults TRUE.
// This deliberately does NOT touch upgradeAllowed: it is a human-initiated one-off, not a
// policy change, so the no-auto-upgrade-delete invariant is untouched.
app.post('/api/audit/replace', async (req, res) => {
  const { section, key, guid, dryRun = true } = req.body || {};
  // Entry log. The Supernatural S09 "500" on 2026-07-28 left NOTHING in the log — not even the
  // catch-block trace added minutes earlier — so the first question is whether the request even
  // reaches this handler. Cheap, and it answers that immediately.
  console.log(`audit: replace ${dryRun ? 'DRY' : 'CONFIRM'} section=${section} key=${key} guid=${String(guid || '').slice(0, 40)}`);
  if (!['cpu', 'bitrate', 'edition', 'upgrade'].includes(section) || !key || !guid) {
    return res.status(400).json({ error: 'section, key and guid are required' });
  }
  // Same reasoning as reclaim: starting a multi-GB download mid-playback is what Movie Mode
  // exists to stop. Dry runs are read-only and stay allowed.
  if (!dryRun && isMasterPaused()) {
    return res.status(409).json({ error: 'Movie Mode is on — turn it off before replacing' });
  }
  try {
    const rows = await buildRows();
    const row = (rows[section] || []).find((r) => r.key === key);
    if (!row) return res.status(404).json({ error: 'row not found' });
    const pk = `${row.app}:${row.id}:${row.season ?? '-'}`;
    if (auditPending.has(pk)) return res.status(409).json({ error: 'a replacement is already in flight for this title' });
    // Mutual exclusion with gpuVerifySweep: never run an Audit replacement against a movie a GPU
    // auto-upgrade is already swapping — both delete the same file class via *arr, and an overlap can
    // take a freshly-imported copy from the other. (gpuVerifySweep guards the reverse direction.)
    if (row.app === 'radarr' && gpuPending.has(row.id)) return res.status(409).json({ error: 'a GPU auto-upgrade is already in flight for this movie' });

    // A DRY RUN READS THE CACHE. It used to run a full verifyRow() — a live Prowlarr search
    // across every indexer — so merely clicking a suggestion cost 40-60s, and confirming cost
    // another 40-60s for a second identical search. Two searches per swap is why a replacement
    // took "multiple minutes". A dry run changes nothing and every number it reports (size,
    // seeders, codec, saving) is already in the cached verdict the tab is displaying, so there is
    // nothing for a live search to add. The authoritative re-verify still happens below, on the
    // mutating path only, where it is the actual safety gate.
    let pick;
    // The freshly-verified candidate list, kept so the grab can fall back to a sibling copy of
    // the same release when the chosen guid is not grabbable. Only populated on the confirm path.
    let freshList = null;
    // Filled by verifyRow on the confirm path: every release it saw and why it did not survive.
    // Read only when the chosen release is missing, to say which of those two things went wrong.
    const dropped = [];
    // The candidate the CLIENT thinks it clicked, resolved from the cached verdict it rendered.
    // Hoisted out of the guid-rotation block below because the not-found handler needs it too.
    let want = null;
    if (dryRun) {
      const cached = verdictFor(row.key, section);
      pick = rankCands((cached && cached.candidates) || [], row).find((c) => c.guid === guid);
      // Cache miss (verdict expired or the row was never verified) — fall back to a live search
      // so the sheet still works, just slowly.
      if (!pick) {
        const v = await verifyRow(row, section, rows.depthMap, rows.seriesNorm);
        pick = (v.candidates || []).find((c) => c.guid === guid);
      }
    } else {
      // Re-verify NOW rather than trusting the cached verdict: the candidate must still pass
      // every filter (wrong-show, playback tier, content-aware bitrate floor, camrip/dub) at
      // this moment. A stale tab must not be able to grab something today's filters reject.
      const v = await verifyRow(row, section, rows.depthMap, rows.seriesNorm, dropped);
      const fresh = v.candidates || [];
      freshList = fresh;
      pick = fresh.find((c) => c.guid === guid);
      // GUIDS ROTATE. Some indexers mint a per-query guid (Knaben returns a
      // "description.php?id=…" that changes between searches) and the same release carried by a
      // second indexer has a different guid entirely, so a guid is an unstable identifier for a
      // release. Once the dry run started reading the CACHE instead of searching, that became
      // visible as a dead Replace button: My Neighbor Totoro's chosen VXT release was in the
      // cached verdict but absent from a fresh search purely because its guid had rotated, so
      // this lookup failed and the swap 409'd with the sheet still open.
      //
      // Fall back to identifiers that actually identify the file: the torrent's infoHash first,
      // then normalised title + size within 50 MB. This does NOT weaken the safety model — the
      // match is still made only against a FRESHLY VERIFIED list, so every filter has already
      // been applied. It just stops a cosmetic id change from blocking a legitimate swap.
      if (!pick) {
        const cached = verdictFor(row.key, section);
        want = rankCands((cached && cached.candidates) || [], row).find((c) => c.guid === guid) || null;
        if (want) {
          const wh = String(want.infoHash || '').toLowerCase();
          const wt = normTitle(want.title);
          pick = (wh && fresh.find((c) => String(c.infoHash || '').toLowerCase() === wh))
            || fresh.find((c) => normTitle(c.title) === wt && Math.abs((c.bytes || 0) - (want.bytes || 0)) < 50 * 1024 * 1024);
          if (pick) console.log(`audit: "${row.title}" — guid rotated, matched the chosen release by ${wh && pick.infoHash ? 'infoHash' : 'title+size'}`);
        }
      }
    }
    if (!pick) {
      // TWO VERY DIFFERENT FAILURES, PREVIOUSLY ONE MESSAGE. A verdict can be hours or days old, and
      // in between the library changes under it: importing one 10-bit file from a release group
      // flips that group's depth verdict, and every unproven-depth HEVC candidate from it is then
      // refused by the NUC gate. The release is still there with 30 seeders — it is the ROW that
      // moved, not the indexers — so "no longer available, tap Re-check" pointed at the wrong thing
      // and Re-check looked broken because it was already doing its job.
      // Match on anything that identifies the release. `want` comes from the cached verdict the
      // client rendered, but that verdict may since have been overwritten by a re-verify — in which
      // case the guid the client sent is all that is left, and a magnet guid carries the infoHash.
      const guidHash = (String(guid).match(/btih:([0-9a-f]{40})/i) || [])[1];
      const gone = dropped.find((d) => (want && want.title && normTitle(d.title) === normTitle(want.title))
        || (want && want.infoHash && d.hash && d.hash === String(want.infoHash).toLowerCase())
        || (guidHash && d.hash && d.hash === guidHash.toLowerCase()));
      if (gone) {
        console.log(`audit: "${row.title}" — ${gone.title} is still listed but no longer eligible: ${gone.why}`);
        return res.status(409).json({ error: `that release is still on the indexers but no longer passes this row's checks — ${gone.why}.`
          + ` The list below has been refreshed${freshList ? ` (${freshList.length} option${freshList.length === 1 ? '' : 's'} now)` : ''}.`, refreshed: true });
      }
      return res.status(409).json({ error: 'that release is no longer listed by any indexer — the list below has been refreshed', refreshed: true });
    }
    // CANNOT IMPORT — refuse before a byte moves. The tab already renders these greyed and
    // unclickable, but a page left open across a swap holds a stale score and could still POST one,
    // and the confirm path re-verified against CURRENT scores a few lines above. *arr requires the
    // replacement to score strictly HIGHER than the file on disk; equal is refused. Blocking here
    // is what turns "downloaded 6 GB, then rejected at import" into an instant, explained no.
    // NOTE what cfBlocked now means: not merely "scores lower" but "scores lower for a reason that is
    // not file size or a transcodable audio track" — see cfBlockedFor. A bigger file that is
    // otherwise identical is no longer refused here, because the import would have accepted it.
    if (pick.cfBlocked) {
      console.log(`audit: refused "${row.title}" — ${pick.title} scores ${pick.cfScore}, on-disk copy scores ${pick.cfNeed}`
        + ' (and the deficit is NOT just file size)');
      return res.status(409).json({ error: `*arr scores that release ${pick.cfScore} against ${pick.cfNeed} for the copy on disk,`
        + ' and the difference is something that matters — a dub, a non-original-language track, a 10-bit or HDR picture,'
        + ' AV1/VP9, or a shorter cut. File-size deficits are already forgiven, so this one is real:'
        + ` it would download in full and then be rejected. Pick a release that is not worse on those.` });
    }

    const files = await arrGet(row.app, row.app === 'radarr'
      ? `/moviefile?movieId=${row.id}` : `/episodefile?seriesId=${row.id}`).catch(() => []);
    const oldFiles = (Array.isArray(files) ? files : [])
      .filter((f) => (row.app === 'radarr' ? true : f.seasonNumber === row.season));
    const oldFileIds = oldFiles.map((f) => f.id);
    // BASELINE for the post-import check. Captured now, while the originals still exist, because
    // after the delete there is nothing left to compare against — and "is what landed actually the
    // thing we replaced?" is the question that GoodFellas answered too late. Runtime is the honest
    // signal: a 13-minute file standing in for a 145-minute film is provably wrong, whatever its
    // name or bitrate says.
    const baseline = { n: oldFileIds.length,
      secs: oldFiles.reduce((a, f) => a + secs((f.mediaInfo || {}).runTime), 0),
      bytes: oldFiles.reduce((a, f) => a + (f.size || 0), 0) };

    if (dryRun) {
      // SIGNED, deliberately. The Math.max(0, ...) clamp that used to be here dates from when the
      // sheet only ever described savings; it threw the sign away, so a LARGER replacement reported
      // 0 and the client — which now renders the direction correctly — read |0| < 1 as "About the
      // same size on disk". Observed on Blade Runner (1982) -> a 7.63 GB Final Cut standing in for a
      // 3.5 GB theatrical. Negative means "uses this much more"; the client owns the wording.
      return res.json({ dryRun: true, title: row.title, pick: { title: pick.title, gb: gb(pick.bytes), seeders: pick.seeders, codec: pick.codec, depth: pick.depth },
        willRemove: oldFileIds.length, freesGb: gb(row.bytes - pick.bytes) });
    }

    // ALREADY IN THE DOWNLOAD CLIENT. qBittorrent rejects a duplicate add with 409, *arr reports
    // that as HTTP 500, and the tab said "the indexer could not hand this release to sonarr" —
    // which names the wrong component and sends you looking for a different candidate when the
    // problem is that you already have this one. The candidate filter drops these upstream, but it
    // works off qBit state cached seconds ago and off an infoHash the indexer may have omitted, so
    // say it plainly here rather than letting a duplicate reach *arr and come back mislabelled.
    if (pick.infoHash) {
      const dupe = await getQbitTorrents().catch(() => [])
        .then((ts) => ts.find((t) => String(t.hash || '').toLowerCase() === String(pick.infoHash).toLowerCase()));
      if (dupe) {
        const done = (dupe.progress || 0) >= 1;
        console.log(`audit: refused duplicate grab of "${row.title}" — ${pick.title} is already in qBittorrent`
          + ` (${dupe.state}, ${Math.round((dupe.progress || 0) * 100)}%)`);
        return res.status(409).json({ error: done
          ? 'you already have this exact release — it finished downloading and is seeding, so there is nothing to fetch'
          : `this exact release is already downloading (${Math.round((dupe.progress || 0) * 100)}%) — no need to start it again` });
      }
    }

    // Grab FIRST. If this fails, nothing has been touched.
    const { base, key: apiKey } = arrOf(row.app);
    // NOT EVERY GUID IS GRABBABLE. Some indexers hand back a human description PAGE as the guid
    // ("https://knaben.xyz/thepiratebay/description.php?id=37356899") rather than a magnet or a
    // .torrent, and *arr answers POST /release with HTTP 500 for those — which surfaced as
    // "grab failed — HTTP 500" on Supernatural S09 and looked like a controller bug. The very
    // same release is usually ALSO listed with a proper magnet guid by another indexer (that is
    // what the duplicate entries in a candidate list are), so try the siblings that share this
    // release's infoHash, magnet-style guids first, before giving up.
    const grabbable = (c) => /^magnet:|\.torrent(\?|$)/i.test(String(c.guid || ''));
    const wantHash = String(pick.infoHash || '').toLowerCase();
    const attempts = [pick, ...(freshList || [])
      .filter((c) => c !== pick && wantHash && String(c.infoHash || '').toLowerCase() === wantHash)]
      // pick stays first unless it is plainly ungrabbable, in which case a magnet sibling goes first.
      .sort((a, b) => Number(grabbable(b)) - Number(grabbable(a)));
    let gr = null, used = null;
    for (const cand of attempts) {
      gr = await tfetch(`${base}/release`, { method: 'POST',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        // cand.guid, NOT the client's guid: when the fallback above matched a rotated release by
        // infoHash, the guid the tab sent is stale and *arr would reject or mis-grab it.
        body: JSON.stringify({ guid: cand.guid, indexerId: cand.indexerId }) }, 30000);
      if (gr.ok) { used = cand; break; }
      console.log(`audit: grab of "${row.title}" via indexer ${cand.indexerId} failed HTTP ${gr.status}`
        + `${attempts.length > 1 ? ' — trying another copy of the same release' : ''}`);
    }
    if (!used) {
      return res.status(502).json({ error: attempts.length > 1
        ? `every copy of that release failed to grab (last HTTP ${gr && gr.status}) — try a different candidate`
        : `the indexer could not hand this release to ${row.app} (HTTP ${gr && gr.status}) — try a different candidate` });
    }
    pick = used;

    auditPending.set(pk, { app: row.app, id: row.id, season: row.season ?? null, key, title: row.title,
      // rel is for the UI: an in-flight row shows WHICH release it is fetching, so a swap that
      // takes hours is legible instead of just "swapping".
      rel: pick.title, oldFileIds, baseline, guid, hash: (pick.infoHash || '').toLowerCase(), ts: Date.now() });
    persistState();
    console.log(`audit: grabbed "${pick.title}" to replace "${row.title}" — original stays until it completes`);
    metrics.emitEvent('audit_replace_start', { ti: row.title, gb: gb(pick.bytes), seeds: pick.seeders });
    res.json({ dryRun: false, started: true, title: row.title, willRemove: oldFileIds.length });
  } catch (e) {
    // LOG the stack, don't just hand a 500 to the browser. A 500 with no server-side trace is
    // undiagnosable — the Supernatural S09 Replace failure on 2026-07-28 produced a bare "500"
    // in the UI and NOTHING in the log, so there was nothing to work from.
    console.log(`audit: ${req.method} ${req.path} failed — ${(e && e.stack) || e}`);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- SWAP CANCELLATION ─────────────────────────────────────────────────────────────────────
// swapForHash / isSwapHash live in ./state (next to auditPending) so downloads.js can ask the
// question without creating a require cycle — see the note there. Only the part that needs this
// module's row cache stays here.
//
// Forget a swap without touching a single file. Used when a human cancels the replacement download:
// the ORIGINAL stays exactly as it is (that is the whole promise of a zero-gap swap), and the row
// returns to the audit list to be offered again later.
function forgetSwap(hash) {
  const found = swapForHash(hash);
  if (!found) return null;
  auditPending.delete(found.key);
  persistState();
  invalidateRows();   // the row goes back to "improvable" immediately
  console.log(`audit: swap for "${found.pending.title}" cancelled by hand — original left untouched`);
  return found.pending;
}

// devNuc is exported ONLY so scripts/test-nuc-compat.js can pin the refusal rule. It is the hinge
// of a hard filter that is otherwise reachable only through a live indexer search.
// candidateBandOk and BLOAT_BAND_BY_PROFILE are exported for scripts/test-bpp-floor.js only —
// both live inside decisions that otherwise need a live indexer search to reach, and both are
// hard refusals, so pinning them cheaply is the difference between a tested rule and a hoped-for
// one. Same reasoning as devNuc above.
module.exports = {
  startAuditVerifier, verifyTick, buildRows, forgetSwap, devNuc,
  top100RankByTmdb, candidateBandOk, BLOAT_BAND_BY_PROFILE,
};
