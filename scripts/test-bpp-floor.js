'use strict';
// The two ABSOLUTE band rules added 2026-08-01: which titles the Disk section lists, and which
// candidates the picker is allowed to offer. Both are hard refusals living behind a live indexer
// search, so this is the only cheap way to pin them.
//
// The Disk-section rule in particular was WRONG on its first cut and the live library caught it:
// a flat green threshold would have offered to shrink Lawrence of Arabia, Blade Runner, Fight Club
// and six other Top 100 films. Those cases are pinned below so it cannot regress.
const { candidateBandOk, BLOAT_BAND_BY_PROFILE } = require('../controller/lib/audit');
const { BPP_RANK, bppBand } = require('../controller/lib/arr-inspect');

let pass = 0; let fail = 0;
const ok = (c, why) => { if (c) pass++; else { fail++; console.log(`FAIL  ${why}`); } };

// ---- DISK SECTION MEMBERSHIP -----------------------------------------------------------------
// The bar is per-profile. Note that membership is now DELIBERATELY WIDE: Beloved/Top-100 rows and
// rows the Playback section already lists are included and sunk in the ordering via `lowPriority`,
// not filtered out (Brennan, 2026-08-01: "more options, more suggestions, not less").
const listed = (bpp, profile) => {
  const b = bppBand(bpp);
  return !!b && BPP_RANK[b] <= BPP_RANK[BLOAT_BAND_BY_PROFILE(profile)];
};
ok(BLOAT_BAND_BY_PROFILE('Normal') === 'wow', 'a default title is only bloat at PURPLE');
ok(BLOAT_BAND_BY_PROFILE('Low (save space)') === 'ok', 'a save-space title is bloat from GREEN up');
ok(BLOAT_BAND_BY_PROFILE(undefined) === 'wow', 'an unknown profile is treated as default, not as Low');

// GREEN IS THE TARGET, NOT BLOAT. bpp 0.13 is "looks its best on current hardware"; listing it as
// bloat for a default title would ratchet the whole library down to orange.
ok(!listed(0.14, 'Normal'), 'green on a default title is NOT bloat — it is the goal');
ok(!listed(0.19, 'Normal'), 'just under purple on a default title is not bloat');
ok(listed(0.21, 'Normal'), 'purple on a default title IS listed');
// On a save-space title the instruction is already recorded, so green is spending against it.
ok(listed(0.14, 'Low (save space)'), 'green on a save-space title IS listed');
ok(!listed(0.09, 'Low (save space)'), 'orange on a save-space title is lean by choice, not listed');
ok(!listed(0.05, 'Low (save space)'), 'red on a save-space title is exactly what was asked for');
ok(!listed(null, 'Normal'), 'an unmeasurable file is never listed as bloat');

// ---- LOW-PRIORITY ORDERING -------------------------------------------------------------------
// The Disk section sorts low-priority rows to the bottom rather than dropping them. This mirrors
// the comparator in buildRows exactly; if that changes, this must too.
const diskSort = (rows) => [...rows].sort((a, b) =>
  (Number(!!a.lowPriority) - Number(!!b.lowPriority)) || b.bytes - a.bytes);
const ordered = diskSort([
  { title: 'Lawrence of Arabia', bytes: 27.9e9, lowPriority: true },   // Top 100
  { title: 'White Chicks', bytes: 8.7e9, lowPriority: false },
  { title: 'Blue Velvet', bytes: 7.9e9, lowPriority: false },
  { title: 'A 10-bit season', bytes: 40e9, lowPriority: true },        // already in Playback
]);
ok(ordered[0].title === 'White Chicks', 'the biggest ACTIONABLE row leads, not the biggest row');
ok(ordered[1].title === 'Blue Velvet', 'ordinary rows keep biggest-first among themselves');
ok(ordered[2].title === 'A 10-bit season' && ordered[3].title === 'Lawrence of Arabia',
   'low-priority rows sink to the bottom, still biggest-first among themselves');
ok(ordered.length === 4, 'nothing is dropped — a Top 100 film shrinking IS a legitimate option');

// These are the real bpp values that broke the FIRST cut of the threshold (a flat green bar would
// have led the Disk section with them). They are purple, so they still appear — but as
// lowPriority, at the bottom.
for (const [t, bpp] of [['Lawrence of Arabia', 0.330], ['Blade Runner', 0.338], ['Fight Club', 0.359],
  ['Return of the Jedi', 0.276], ["Ocean's Eleven", 0.265], ['American Psycho', 0.245]]) {
  ok(bppBand(bpp) === 'wow', `${t} is genuinely purple (${bpp}) — listed, but sunk by lowPriority`);
}
ok(bppBand(0.164) === 'ok' && !listed(0.164, 'Normal'),
  'The Blues Brothers (0.164, green) is not bloat at all — green is the target');

// ---- CANDIDATE FLOOR -------------------------------------------------------------------------
// candidateBandOk is a RANKING signal now, not a refusal — false means "offer it, but last".
// Quality is a trade the human can see in the colour; only KIND (dubs, camrips, wrong cuts) is
// refused outright, and that lives in release-rules.js.
ok(candidateBandOk(0.22, 0.05, true), 'priority: a purple candidate ranks normally');
ok(candidateBandOk(0.13, 0.05, true), 'priority: exactly green ranks normally');
ok(!candidateBandOk(0.12, 0.05, true), 'priority: orange is demoted even though it beats what we hold');
ok(!candidateBandOk(0.04, 0.05, true), 'priority: red is demoted');
// THE CASE minRatioFor GOT WRONG. Jackie Brown sits at 0.064 (red). A relative "at least 80% of
// current" test treats a 0.052 replacement as fine; both are compromised, so the absolute test
// must demote it.
ok(!candidateBandOk(0.052, 0.064, true), 'priority: 80% of an already-red file is still demoted');

// Non-priority: at most one band down, and not below orange, before it gets demoted.
ok(candidateBandOk(0.14, 0.22, false), 'default: purple -> green is one band, ranks normally');
ok(!candidateBandOk(0.09, 0.22, false), 'default: purple -> orange is two bands, demoted');
ok(candidateBandOk(0.09, 0.14, false), 'default: green -> orange is one band, ranks normally');
ok(!candidateBandOk(0.05, 0.14, false), 'default: green -> red is two bands, demoted');
ok(!candidateBandOk(0.05, 0.09, false), 'default: below orange is demoted');
ok(!candidateBandOk(0.04, 0.05, false), 'default: red -> red is demoted; red never leads the sheet');
// Unknowns are never demoted on a guess.
ok(candidateBandOk(null, 0.14, false), 'an unmeasurable candidate is not demoted');
ok(candidateBandOk(0.14, null, false), 'an unmeasurable CURRENT file does not demote a green candidate');

// The sort itself: demoted candidates must land last, never be absent.
const candSort = (c) => [...c].sort((a, b) => (Number(a.bandWeak) - Number(b.bandWeak)) || (b.seeders - a.seeders));
const cs = candSort([
  { n: 'weak but well-seeded', bandWeak: true, seeders: 900 },
  { n: 'solid', bandWeak: false, seeders: 12 },
]);
ok(cs[0].n === 'solid', 'a demoted candidate does not outrank a solid one on seeders alone');
ok(cs.length === 2, '...but it is still offered');

// ---- CANDIDATE bpp ESTIMATE: resolution must be factored in ----------------------------------
// REGRESSION (Meet the Parents, 2026-08-01). bpp is bits per PIXEL, so a candidate that is both
// bigger AND higher-resolution spreads its extra bits over more pixels. Scaling by byte size alone
// estimated a 720p -> 1080p upgrade at 380 bpp+ (deep purple, "more than the display can resolve")
// when the honest figure is ~169. Aspect ratio survives a re-encode, so pixels scale with the
// SQUARE of the height ratio.
const X265 = 1.8;
const candBpp = (rowBpp, rowBytes, candBytes, curHevc, candHevc, curRes, candRes) => {
  if (!rowBpp || !rowBytes || !candBytes) return null;
  const cs = (candHevc && !curHevc) ? X265 : 1;
  const rs = (curRes && candRes && curRes !== candRes) ? (curRes / candRes) ** 2 : 1;
  return +((rowBpp * (candBytes / rowBytes)) * cs * rs).toFixed(5);
};
const idx = (b) => Math.round(b / 0.13 * 100);
const MTP_BPP = 0.03377; const MTP_BYTES = 575773895; const MTP_CAND = MTP_BYTES * 14.6;
ok(idx(candBpp(MTP_BPP, MTP_BYTES, MTP_CAND, false, false, 720, 1080)) === 169,
   'Meet the Parents 720p -> 1080p estimates 169 bpp+, not 380');
ok(idx(candBpp(MTP_BPP, MTP_BYTES, MTP_CAND, false, false, 1080, 1080)) === 379,
   'the same size jump at the SAME resolution really is 379 — the correction is resolution, not size');
ok(candBpp(0.1, 1e9, 2e9, false, false, null, 1080) === 0.2,
   'an unstated current resolution leaves the scale at 1 — never a guess');
ok(candBpp(0.1, 1e9, 2e9, false, false, 1080, null) === 0.2,
   'an unstated candidate resolution leaves the scale at 1');
ok(candBpp(0.1, 1e9, 1e9, false, true, 1080, 1080) === 0.18,
   'the HEVC x1.8 scale still applies independently of resolution');
ok(candBpp(0.1, 1e9, 1e9, false, false, 1080, 720) > 0.1,
   'a DOWNGRADE in resolution concentrates the same bits on fewer pixels, so bpp rises');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
