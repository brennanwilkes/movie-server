'use strict';
// cfRefusalIsExcusable — the gate that decides whether *arr's "Not a Custom Format upgrade" is a
// refusal Brennan wants kept, or one he explicitly does not.
//
// His rule, 2026-07-30: "I'm fine with midrange files being the default for automatic/initial
// downloads, in fact that's what I want, but for upgrades and replacements I've chosen a source, I
// don't want it rejected for file size (something like dub and language that it has better info
// for, sure)."
//
// ...and the one from the same day that the first cut of this gate missed: "Slight device
// compatibility downgrade (ps4 green to orange, web green to orange for example is OK) but nuc green
// to red is not." Size was NOT the only excusable deficit — see the Pulp Fiction case below.
//
// The asymmetry that shapes these tests: a WRONGLY-ALLOWED import replaces a good file with a
// dubbed or foreign-audio one, which is real loss (the Rings of Power case). A WRONGLY-REFUSED one
// costs a download and an annoyed user. So the must-NOT-allow cases are weighted heaviest here,
// and every ambiguity resolves toward refusing.
const {
  isSizeCf, isExcusableCf, AUDIO_TRANSCODE_CF, nonSizeCfScore, cfRefusalIsExcusable,
  CF_UPGRADE_REJECT_RE, SIZE_CF_RE, editionNotWorse, cfDeficits, cfFormatsFromRejection,
} = require('../controller/lib/release-rules');
// The tier Extended parses to (release-rules EDITION_TIER). Named so the edition tests read as
// intent ("against an Extended copy") rather than as a magic number.
const EDITION_TIER_EXTENDED = 2;

let pass = 0; let fail = 0;
const ok = (cond, why) => { if (cond) { pass++; return; } fail++; console.log(`FAIL  ${why}`); };

// The REAL scores, read off the live Radarr/Sonarr "Normal" profile on 2026-07-30. Using the actual
// numbers rather than invented ones is the point: these tests fail if the provisioner's balance
// ever changes in a way that breaks the discrimination.
const NORMAL = new Map(Object.entries({
  'Size <1.5 GB': 30, 'Size 1.5-3 GB': 80, 'Size 3-6 GB': 40,
  'Size 6-10 GB': -150, 'Size 10-15 GB': -500, 'Size >15 GB': -1500,
  Dubbed: -100000, 'Non-original language (reject)': -100000,
  'AV1 (CPU)': -1000, 'VP9 (CPU)': -1000,
  'Likely 10-bit group (CPU)': -120, '10-bit (CPU)': -150,
  'HDR / Dolby Vision (CPU)': -200, 'HD/lossless audio (transcode)': -20,
  'PS4-native audio (AC3)': 15, 'Original-language audio': 200,
  'HEVC 8-bit (GPU)': 20, 'H.264 (GPU)': 80,
  'Extended / Long Cut': 3000, 'Theatrical Cut': -3000,
  'Directors Cut': 3200, 'Final / Ultimate Cut': 3400,
}));

// ── which formats are "size" ────────────────────────────────────────────────────────────────
for (const n of ['Size <1.5 GB', 'Size 1.5-3 GB', 'Size 3-6 GB', 'Size 6-10 GB', 'Size 10-15 GB', 'Size >15 GB']) {
  ok(isSizeCf(n), `"${n}" must be recognised as a size band`);
}
// MUST NOT over-match. Anything caught here is silently excused from the comparison, which is the
// dangerous direction — a format named "Sizeable" or "Resize" must never buy a free pass.
for (const n of ['Dubbed', 'Non-original language (reject)', '10-bit (CPU)', 'Theatrical Cut',
  'HDR / Dolby Vision (CPU)', 'AV1 (CPU)', 'Sizeable', 'Resized', 'Oversize', 'sized']) {
  ok(!isSizeCf(n), `"${n}" must NOT be treated as a size band`);
}
ok(!isSizeCf(''), 'empty name is not a size band');
ok(!isSizeCf(null), 'null name is not a size band');
ok(!isSizeCf(undefined), 'undefined name is not a size band');

// ── nonSizeCfScore ──────────────────────────────────────────────────────────────────────────
ok(nonSizeCfScore(['H.264 (GPU)', 'Size 1.5-3 GB'], NORMAL) === 80, 'size band excluded from the sum');
ok(nonSizeCfScore([{ name: 'H.264 (GPU)' }, { name: 'Size >15 GB' }], NORMAL) === 80,
  'accepts *arr objects, not just strings — manualimport returns {id,name}');
ok(nonSizeCfScore([], NORMAL) === 0, 'empty format list scores 0');
ok(nonSizeCfScore(null, NORMAL) === 0, 'null format list scores 0');
ok(nonSizeCfScore(undefined, NORMAL) === 0, 'undefined format list scores 0');
ok(nonSizeCfScore(['Some Format Nobody Scored'], NORMAL) === 0,
  'a format the profile does not score contributes 0, exactly as *arr treats it');
ok(nonSizeCfScore(['Original-language audio', 'H.264 (GPU)', 'PS4-native audio (AC3)'], NORMAL) === 280,
  'sums the formats that count: 200 + 80, with the +15 PS4 audio preference excluded');
ok(nonSizeCfScore(['H.264 (GPU)', 'HD/lossless audio (transcode)'], NORMAL) === 80,
  'the -20 lossless-audio penalty is excluded too');
ok(nonSizeCfScore(['H.264 (GPU)'], { 'H.264 (GPU)': 80 }) === 80, 'accepts a plain object as the score map');

// ── the gate itself ─────────────────────────────────────────────────────────────────────────
const allow = (oldF, newF) => cfRefusalIsExcusable(oldF, newF, NORMAL);

// MUST ALLOW — the whole point. A bigger file, identical in every other respect.
ok(allow(
  ['H.264 (GPU)', 'Original-language audio', 'Size 3-6 GB'],
  ['H.264 (GPU)', 'Original-language audio', 'Size 10-15 GB'],
), 'Lawrence of Arabia: same content, one size band up — MUST be allowed');

ok(allow(
  ['H.264 (GPU)', 'Original-language audio', 'Size 1.5-3 GB'],
  ['H.264 (GPU)', 'Original-language audio', 'Size >15 GB'],
), 'a Remux three bands up is still only a size difference — MUST be allowed');

ok(allow(
  ['Theatrical Cut', 'H.264 (GPU)', 'Original-language audio', 'Size 3-6 GB'],
  ['Extended / Long Cut', 'H.264 (GPU)', 'Original-language audio', 'Size 10-15 GB'],
), 'Return of the King: theatrical -> extended is BETTER on content and only worse on size');

ok(allow(
  ['Theatrical Cut', 'H.264 (GPU)', 'Original-language audio', 'Size 1.5-3 GB'],
  ['Final / Ultimate Cut', 'HEVC 8-bit (GPU)', 'Original-language audio', 'Size 6-10 GB'],
), 'Blade Runner: Final Cut gains 6400 on edition, loses 60 on codec — content is net better');

ok(allow(
  ['H.264 (GPU)', 'Original-language audio', 'Size 3-6 GB'],
  ['H.264 (GPU)', 'Original-language audio', 'Size 1.5-3 GB'],
), 'a SMALLER replacement is also size-only — the Disk section must not be blocked either');

ok(allow(
  ['H.264 (GPU)', 'Original-language audio', 'Size 3-6 GB'],
  ['H.264 (GPU)', 'Original-language audio', 'Size 3-6 GB'],
), 'identical non-size formats tie, and a tie is size-only by definition');

ok(allow([], []), 'two unscored files tie at 0 — nothing but size can be in dispute');

// REGRESSION PIN — the exact live case the first cut of this gate got wrong.
// Pulp Fiction, 2026-07-31: a 1.5-3 GB copy was refused a 10-15 GB Bluray x264 with the SAME codec
// and SAME language, purely because the old file carried "PS4-native audio (AC3)" (+15) and the new
// one does not. Fifteen points vetoing a four-times-larger Bluray. It abandoned as cf_rejected and
// was recorded as permanently refused.
ok(allow(
  ['H.264 (GPU)', 'Original-language audio', 'PS4-native audio (AC3)', 'Size 1.5-3 GB'],
  ['H.264 (GPU)', 'Original-language audio', 'Size 10-15 GB'],
), 'Pulp Fiction: losing PS4-native AC3 is the "ps4 green to orange" tradeoff Brennan allows — MUST be allowed');

ok(allow(
  ['H.264 (GPU)', 'Original-language audio', 'Size 3-6 GB'],
  ['H.264 (GPU)', 'Original-language audio', 'HD/lossless audio (transcode)', 'Size 10-15 GB'],
), 'gaining TrueHD/DTS-HD costs -20 for a downmix the server does anyway — MUST be allowed');

// REGRESSION PINS — the two live cases the Audit tab was still refusing on 2026-08-11, months after
// this gate was written. The gate itself was right; the *tab* never asked it. The Replace button and
// the preflight both compared raw cfScore totals (audit.js cfBlocked), so a release the import path
// would have accepted was greyed out and unclickable with "it has to score higher to import".
// cfBlockedFor in audit.js now routes through this function; these pin the arithmetic it relies on.
//
// Scarface (1983): on disk 360, the chosen "1080p BluRay x264-OFT" 260. Identical codec, language and
// cut; the entire 100-point gap is Size 1.5-3 GB (+80) vs Size 6-10 GB (-20). Both sides are 280 once
// size is excluded, and A TIE IS EXCUSABLE — nothing real is in dispute.
ok(allow(
  ['H.264 (GPU)', 'Original-language audio', 'Size 1.5-3 GB'],
  ['H.264 (GPU)', 'Original-language audio', 'Size 6-10 GB'],
), 'Scarface 1983: 2.58 GB -> 7.92 GB, same everything else — MUST be allowed (was refused 260 vs 360)');
ok(nonSizeCfScore(['H.264 (GPU)', 'Original-language audio', 'Size 1.5-3 GB'], NORMAL)
  === nonSizeCfScore(['H.264 (GPU)', 'Original-language audio', 'Size 6-10 GB'], NORMAL),
  'Scarface: both sides are the SAME once the size band is excluded — the refusal was pure bytes');

// Star Wars: The Rise of Skywalker (2019): on disk 280, the chosen OFT release 260. Here the
// replacement is actually BETTER on content (+80 for H.264, which the on-disk file never matched) and
// only "worse" on size, so it must clear the gate comfortably.
ok(allow(
  ['Original-language audio', 'Size 1.5-3 GB'],
  ['H.264 (GPU)', 'Original-language audio', 'Size 6-10 GB'],
), 'Rise of Skywalker: gains H.264, loses only size — MUST be allowed (was refused 260 vs 280)');

// ...but the exemption must be NARROW. It buys ~35 points of headroom and must not become a way for
// a real regression to ride along.
ok(!allow(
  ['H.264 (GPU)', 'Original-language audio', 'PS4-native audio (AC3)', 'Size 1.5-3 GB'],
  ['H.264 (GPU)', 'Original-language audio', 'PS4-native audio (AC3)', '10-bit (CPU)', 'Size 10-15 GB'],
), 'audio exemption must NOT excuse a 10-bit picture riding along with it');
ok(!allow(
  ['H.264 (GPU)', 'Original-language audio', 'PS4-native audio (AC3)', 'Size 1.5-3 GB'],
  ['H.264 (GPU)', 'Dubbed', 'Size 10-15 GB'],
), 'audio exemption must NOT excuse a dub');
ok(isExcusableCf('PS4-native audio (AC3)') && isExcusableCf('HD/lossless audio (transcode)'),
  'both audio-transcode formats are excusable');
ok(isExcusableCf('  Size 6-10 GB'), 'leading whitespace does not defeat the size test');
for (const n of ['Dubbed', '10-bit (CPU)', 'HDR / Dolby Vision (CPU)', 'AV1 (CPU)', 'Theatrical Cut',
  'Original-language audio', 'H.264 (GPU)', 'PS4-native audio', 'audio (AC3)']) {
  ok(!isExcusableCf(n), `"${n}" must NOT be excusable — only the two named audio formats and the size bands are`);
}
ok(AUDIO_TRANSCODE_CF.size === 2,
  'the exemption list is exactly two entries — growing it must be a deliberate, reviewed act');

// MUST NOT ALLOW — every one of these is a case Brennan named, or a data-loss shape.
ok(!allow(
  ['H.264 (GPU)', 'Original-language audio', 'Size 3-6 GB'],
  ['H.264 (GPU)', 'Dubbed', 'Size 10-15 GB'],
), 'DUBBED replacement must still be refused — Brennan: "dub and language ... sure"');

ok(!allow(
  ['H.264 (GPU)', 'Original-language audio', 'Size 1.5-3 GB'],
  ['H.264 (GPU)', 'Non-original language (reject)', 'Size 6-10 GB'],
), 'Rings of Power: the -99800 foreign-audio rescore must still abandon the swap');

ok(!allow(
  ['H.264 (GPU)', 'Original-language audio', 'Size 1.5-3 GB'],
  ['H.264 (GPU)', 'Size 6-10 GB'],
), 'LOSING "Original-language audio" is a content regression, not a size one');

ok(!allow(
  ['Extended / Long Cut', 'H.264 (GPU)', 'Size 10-15 GB'],
  ['Theatrical Cut', 'H.264 (GPU)', 'Size 3-6 GB'],
), 'an edition DOWNGRADE must be refused even though it also shrinks the file');

ok(!allow(
  ['H.264 (GPU)', 'Original-language audio', 'Size 3-6 GB'],
  ['AV1 (CPU)', 'Original-language audio', 'Size 1.5-3 GB'],
), 'AV1 cannot be hardware-decoded here — refuse, however small it is');

ok(!allow(
  ['H.264 (GPU)', 'Original-language audio', 'Size 3-6 GB'],
  ['HEVC 8-bit (GPU)', 'Original-language audio', '10-bit (CPU)', 'HDR / Dolby Vision (CPU)', 'Size 10-15 GB'],
), '10-bit + HDR is a real decode regression on the NUC — refuse');

ok(!allow(
  ['H.264 (GPU)', 'Original-language audio', 'Size 3-6 GB'],
  ['H.264 (GPU)', 'Original-language audio', 'Dubbed', 'Size 3-6 GB'],
), 'same size band, dubbed — nothing about this is a size dispute');

// A profile that scores NOTHING must not become a blanket allow for content regressions... except
// it necessarily does, because with no scores there is no deficit and *arr would not have refused
// in the first place. Pinned so the behaviour is a decision rather than an accident.
ok(cfRefusalIsExcusable(['Dubbed'], ['Dubbed'], new Map()),
  'an unscoring profile ties at 0 — but *arr cannot raise a CF refusal under one, so this is unreachable');

// ── the rejection string this gate is attached to ───────────────────────────────────────────
ok(CF_UPGRADE_REJECT_RE.test('Not a Custom Format upgrade for existing movie file(s)'),
  'matches Radarr phrasing');
ok(CF_UPGRADE_REJECT_RE.test('Not a Custom Format upgrade for existing episode file(s)'),
  'matches Sonarr phrasing');
ok(!CF_UPGRADE_REJECT_RE.test('Not an upgrade for existing movie file(s). New Quality is WEBDL-1080p'),
  'must NOT match the plain-quality arm — that one is always tolerated at preflight and needs no allowance');
ok(!CF_UPGRADE_REJECT_RE.test('Unknown movie'), 'must not match unrelated rejections');
ok(!CF_UPGRADE_REJECT_RE.test('Has same filesize as existing file'), 'must not match the same-filesize rejection');

// ── anti-drift: the live profile still has the inversion this exists to work around ─────────
// If someone later re-balances _arr_common.sh so bigger files are no longer penalised, this gate
// becomes dead code and the test should say so rather than quietly passing forever.
ok(NORMAL.get('Size 6-10 GB') < NORMAL.get('Size 3-6 GB'),
  'the size-band inversion is still real: a bigger file scores lower, which is why this gate exists');

// ── anti-drift: importer.js still uses this gate ────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const imp = fs.readFileSync(path.join(__dirname, '..', 'controller', 'lib', 'importer.js'), 'utf8');
ok(imp.includes('cfRefusalIsExcusable(opts.cfAllow.oldFormats, c.customFormats, opts.cfAllow.scoreByName'),
  'importer.js still calls cfRefusalIsExcusable with the cfAllow shape audit.js builds');
// The edition arm has to be PASSED, not merely available. It defaults to off, so forgetting to thread
// it through is silent: every Gladiator-shaped refusal simply comes back and nothing looks broken.
ok(/editionOk: !!opts\.cfAllow\.editionOk/.test(imp),
  'importer.js still forwards cfAllow.editionOk into the gate (default-off means a silent regression)');
const aud = fs.readFileSync(path.join(__dirname, '..', 'controller', 'lib', 'audit.js'), 'utf8');
ok(/return \{ oldFormats, scoreByName, editionOk, editionLabel \};/.test(aud),
  'audit.js buildCfAllow still returns the shape importer.js destructures, editionOk included');
// ...and that editionOk is derived from OUR parse of the chosen release title. If this ever becomes a
// constant or reads *arr's filename score instead, the hard theatrical rule loses its guard.
ok(aud.includes('editionOk = editionNotWorse(relTitle, oldTier)'),
  'buildCfAllow still derives editionOk from editionNotWorse() on the release title');
ok(/buildCfAllow\(p\.app, p\.id, p\.season, p\.rel\)/.test(aud),
  'the swap still passes its release title into buildCfAllow — without it editionOk is always false');
ok(aud.includes('previewManualImport(p.app, t.content_path, p.id, { cfAllow })'),
  'the preflight is still given the allowance');
ok(aud.includes('{ downloadId: p.hash, cfAllow }'),
  'the real import is given the SAME allowance, so it cannot disagree with the preflight');
ok(SIZE_CF_RE instanceof RegExp, 'SIZE_CF_RE is exported for anyone who needs the raw pattern');

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

// ── THE EDITION ARM (2026-08-12, Gladiator) ─────────────────────────────────────────────────
// *arr scores the RELEASE TITLE when it grabs and the FILE INSIDE THE TORRENT when it imports, so a
// release named ...EXTENDED... whose internal filename omits the tag loses 3000 points between those
// two moments and the import reads as an edition downgrade. Gladiator.2000.EXTENDED...-CiNEFiLE
// downloaded for days and was refused twice (08-07 and 08-12) on exactly that.
//
// The exemption is driven by OUR OWN parse of the chosen release title (editionNotWorse), never by
// *arr's filename score. Brennan's rule, same day: "If it wasnt theatrical then it shouldnt have been
// rejected" — and its inverse is the hard rule that must survive: a theatrical cut is never allowed.
const editionAllow = (oldF, newF, editionOk) => cfRefusalIsExcusable(oldF, newF, NORMAL, { editionOk });

// THE REGRESSION PIN — the exact live format lists from the Gladiator refusal.
const GLAD_OLD = ['Extended / Long Cut', 'H.264 (GPU)', 'Original-language audio', 'Size 1.5-3 GB'];
const GLAD_NEW = ['H.264 (GPU)', 'Original-language audio', 'Size 10-15 GB'];
ok(!editionAllow(GLAD_OLD, GLAD_NEW, false),
  'Gladiator: WITHOUT the edition exemption the refusal stands — this is the old behaviour, unchanged');
ok(editionAllow(GLAD_OLD, GLAD_NEW, true),
  'Gladiator: WITH it (title parses Extended, disk is Extended) the naming artifact is forgiven');

// MUST NOT ALLOW — the exemption is keyed on the TITLE PARSE, so a real cut change can never use it.
ok(!editionNotWorse('Gladiator.2000.THEATRICAL.1080p.BluRay.x264-FOO', EDITION_TIER_EXTENDED),
  'an explicitly THEATRICAL release never clears the tier test against an Extended copy');
ok(!editionNotWorse('Gladiator.2000.1080p.BluRay.x264-FOO', EDITION_TIER_EXTENDED),
  'an UNSTATED-edition release does not clear it either — unstated is not proof of the long cut');
ok(editionNotWorse('Gladiator.2000.EXTENDED.1080p.BluRay.x264-CiNEFiLE', EDITION_TIER_EXTENDED),
  'the same tier passes');
ok(editionNotWorse('Blade.Runner.1982.FINAL.CUT.1080p.BluRay.x264', EDITION_TIER_EXTENDED),
  'a HIGHER tier passes (Final Cut over Extended)');
ok(!editionNotWorse('Blade.Runner.1982.EXTENDED.1080p.BluRay.x264', 3),
  "Extended does NOT clear a Director's Cut on disk — the bar is what you already hold");

// And the exemption must not become a tunnel for anything else while it is open.
ok(!editionAllow(
  ['Extended / Long Cut', 'H.264 (GPU)', 'Original-language audio', 'Size 1.5-3 GB'],
  ['H.264 (GPU)', 'Dubbed', 'Size 10-15 GB'], true,
), 'a DUB riding along with an excused edition tag is still refused');
ok(!editionAllow(
  ['Extended / Long Cut', 'H.264 (GPU)', 'Original-language audio', 'Size 1.5-3 GB'],
  ['H.264 (GPU)', 'Original-language audio', '10-bit (CPU)', 'Size 10-15 GB'], true,
), 'a 10-bit picture riding along with an excused edition tag is still refused');
ok(!editionAllow(
  ['Extended / Long Cut', 'H.264 (GPU)', 'Original-language audio', 'Size 1.5-3 GB'],
  ['H.264 (GPU)', 'Non-original language (reject)', 'Size 10-15 GB'], true,
), 'foreign audio riding along with an excused edition tag is still refused');
// Theatrical Cut is itself an EDITION format, so the exemption would hide it — which is safe ONLY
// because editionOk can never be true for a title that parses as theatrical. Pinned both ways.
ok(!editionNotWorse('Gladiator.2000.Theatrical.Cut.1080p.x264', 2),
  'the guard that makes the above safe: a theatrical title can never set editionOk');

// ── cfDeficits: name what is actually worse ─────────────────────────────────────────────────
// "scored it below the copy you already have" is true of every refusal and so says nothing. Brennan:
// "the rejection reason on the audit tab recent should say that it was the wrong edition".
const gd = cfDeficits(GLAD_OLD, GLAD_NEW, NORMAL);
ok(gd.length === 1 && gd[0].name === 'Extended / Long Cut',
  `cfDeficits names the edition as the sole cause: got ${JSON.stringify(gd.map((d) => d.name))}`);
ok(gd[0].delta === -3000, 'and reports its magnitude');
ok(cfDeficits(GLAD_OLD, GLAD_NEW, NORMAL, { editionOk: true }).length === 0,
  'with the edition excused there is nothing left to report');
ok(cfDeficits(['H.264 (GPU)', 'Size 1.5-3 GB'], ['H.264 (GPU)', 'Size >15 GB'], NORMAL).length === 0,
  'a size-only difference is never reported as a deficit');
const dd = cfDeficits(['H.264 (GPU)', 'Original-language audio'], ['H.264 (GPU)', 'Dubbed'], NORMAL);
ok(dd.some((d) => d.name === 'Dubbed') && dd.some((d) => d.name === 'Original-language audio'),
  'both a lost good format and a gained bad one are reported');
ok(dd[0].name === 'Dubbed', 'worst first (-100000 leads)');

// ── cfFormatsFromRejection: read *arr's own words ───────────────────────────────────────────
const REAL = 'Not a Custom Format upgrade for existing movie file(s). New: [H.264 (GPU), '
  + 'Original-language audio, Size 10-15 GB] (-220) do not improve on Existing: [Extended / Long Cut, '
  + 'H.264 (GPU), Original-language audio, Size 1.5-3 GB] (3360)';
const parsed = cfFormatsFromRejection(REAL);
ok(JSON.stringify(parsed.newFormats) === JSON.stringify(GLAD_NEW), 'parses the New: list verbatim');
ok(JSON.stringify(parsed.oldFormats) === JSON.stringify(GLAD_OLD), 'parses the Existing: list verbatim');
ok(cfFormatsFromRejection('some other rejection entirely').newFormats.length === 0,
  'unrecognised phrasing yields nothing — degrades to the vague message, never to a wrong one');
ok(cfFormatsFromRejection('').newFormats.length === 0, 'empty reason yields nothing');
ok(cfFormatsFromRejection(null).newFormats.length === 0, 'null reason yields nothing, not a throw');
ok(cfFormatsFromRejection('New: [] (0) do not improve on Existing: [] (0)').newFormats.length === 0,
  'empty bracket lists yield nothing');

console.log(`\n${pass} passed, ${fail} failed (edition arm included)`);
process.exit(fail ? 1 : 0);
