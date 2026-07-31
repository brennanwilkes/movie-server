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
  CF_UPGRADE_REJECT_RE, SIZE_CF_RE,
} = require('../controller/lib/release-rules');

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
ok(imp.includes('cfRefusalIsExcusable(opts.cfAllow.oldFormats, c.customFormats, opts.cfAllow.scoreByName)'),
  'importer.js still calls cfRefusalIsExcusable with the cfAllow shape audit.js builds');
const aud = fs.readFileSync(path.join(__dirname, '..', 'controller', 'lib', 'audit.js'), 'utf8');
ok(/return \{ oldFormats, scoreByName \};/.test(aud),
  'audit.js buildCfAllow still returns the {oldFormats, scoreByName} shape importer.js destructures');
ok(aud.includes('previewManualImport(p.app, t.content_path, p.id, { cfAllow })'),
  'the preflight is still given the allowance');
ok(aud.includes('{ downloadId: p.hash, cfAllow }'),
  'the real import is given the SAME allowance, so it cannot disagree with the preflight');
ok(SIZE_CF_RE instanceof RegExp, 'SIZE_CF_RE is exported for anyone who needs the raw pattern');

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
