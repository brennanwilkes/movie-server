'use strict';
// Edition/cut rules. Brennan, 2026-07-30: "A theatrical cut of apocalypse, LOTR, or blade runner is
// garbage and should never be on disk, ever, for any reason. Same as dubs or screenrips."
// So these are HARD REFUSALS, and the tests below are weighted toward the must-refuse cases.
const {
  editionOf, ownEditionOf, editionRefusal, editionFloorFor, RESTORED_RE,
} = require('../controller/lib/release-rules');

let pass = 0; let fail = 0;
const ok = (cond, why) => { if (cond) pass++; else { fail++; console.log(`FAIL  ${why}`); } };

function tier(title, wantTier, wantLabel) {
  const e = editionOf(title);
  ok(e.tier === wantTier && e.label === wantLabel,
    `editionOf(${JSON.stringify(title)}) → tier ${e.tier}/${JSON.stringify(e.label)}, want ${wantTier}/${JSON.stringify(wantLabel)}`);
}
// refuse(candidate, ownEdition, movieTitle) — truthy reason means REFUSED
function refuse(cand, mine, title, wantRefused, why) {
  const r = editionRefusal(cand, mine, title);
  ok(!!r === wantRefused, `${why}\n      candidate: ${cand}\n      own: ${JSON.stringify(mine)} title: ${JSON.stringify(title)}\n      got: ${r === null ? 'ALLOWED' : `REFUSED (${r})`}, want ${wantRefused ? 'REFUSED' : 'ALLOWED'}`);
}

// ---- tier parsing -----------------------------------------------------------------------------
tier('Blade Runner 1982 The Final Cut 2160p BluRay x265', 4, 'Final Cut');
tier('Watchmen 2009 Ultimate Cut 1080p BluRay x264', 4, 'Final Cut');
tier('Alien 1979 Directors Cut 1080p BluRay x264', 3, "Director's Cut");
tier("Aliens 1986 Director's Cut 1080p", 3, "Director's Cut");
tier('Blade Runner 1992 Director.s.Cut 1080p', 3, "Director's Cut");
tier('Apocalypse Now Redux 2001 1080p BluRay x264', 2, 'Extended');
tier('The Lord of the Rings The Two Towers 2002 EXTENDED 1080p BluRay x265', 2, 'Extended');
tier('Aliens 1986 Special Edition 1080p', 2, 'Extended');
tier('Das Boot 1981 Uncut 1080p BluRay', 2, 'Extended');
tier('Forgetting Sarah Marshall 2008 UNRATED 1080p', 2, 'Extended');
tier('Once Upon a Time in America 1984 Integral 1080p', 2, 'Extended');
tier('Blade Runner 1982 Theatrical Cut 1080p BluRay x264', 0, 'Theatrical');
tier('Some Movie 2019 1080p BluRay x265-GROUP', 1, null);   // unstated sits between theatrical and extended

// PRECEDENCE: a title naming two editions takes the HIGHEST, because that is what the file is.
tier('Apocalypse Now Final Cut 2019 1080p (not the Redux)', 4, 'Final Cut');
tier('Blade Runner The Final Cut vs Directors Cut 1080p', 4, 'Final Cut');

// ---- restoration is a SEPARATE axis and must never enter the ladder ---------------------------
tier('Close Encounters of the Third Kind THEATRICAL REMASTERED 1080p', 0, 'Theatrical');
tier('American Gangster EXTENDED REMASTERED 1080p BluRay', 2, 'Extended');
tier('Heat 1995 Directors Cut Remastered 1080p', 3, "Director's Cut");
tier('2001 A Space Odyssey 1968 REMASTERED 1080p BluRay x264', 1, null);  // remaster alone states no cut
ok(editionOf('Apocalypse Now REMASTERED 1080p').restored === true, 'restored flag set on REMASTERED');
ok(editionOf('Das Boot 1981 RESTORED 1080p').restored === true, 'restored flag set on RESTORED');
ok(editionOf('The Two Towers EXTENDED 1080p').restored === false, 'restored flag false when absent');
ok(RESTORED_RE.test('4K Restoration'), 'RESTORED_RE covers 4K Restoration');

// ---- THE HARD RULE: never theatrical for a film with a definitive cut -------------------------
// These are Brennan's three named films. Every one must refuse regardless of how good the encode is.
refuse('The Lord of the Rings The Two Towers 2002 THEATRICAL 2160p BluRay REMUX HDR',
  'EXTENDED', 'The Lord of the Rings: The Two Towers', true, 'LOTR theatrical must refuse even as a 2160p REMUX');
refuse('Blade Runner 1982 Theatrical Cut 2160p BluRay x265 HDR',
  'Theatrical Cut', 'Blade Runner', true, 'Blade Runner theatrical refuses even though our COPY is theatrical (floor)');
refuse('Apocalypse Now 1979 Theatrical 2160p UHD BluRay',
  'REMASTERED', 'Apocalypse Now', true, 'Apocalypse Now theatrical must refuse');
// ...and the good editions of those same films must be ALLOWED.
refuse('Blade Runner The Final Cut 2160p BluRay x265', 'Theatrical Cut', 'Blade Runner', false,
  'Blade Runner Final Cut is the whole point — must be allowed');
refuse('Blade Runner 1992 Directors Cut 1080p BluRay', 'Theatrical Cut', 'Blade Runner', false,
  "Blade Runner Director's Cut meets the floor of 3");
refuse('Apocalypse Now Redux 2001 1080p BluRay x264', 'REMASTERED', 'Apocalypse Now', false,
  'Redux clears the floor of 2 — Brennan accepted Redux over Final Cut as not the end of the world');
refuse('Apocalypse Now Final Cut 2019 2160p', 'REMASTERED', 'Apocalypse Now', false,
  'Final Cut allowed');
refuse('The Lord of the Rings The Return of the King EXTENDED 2160p',
  'EXTENDED', 'The Lord of the Rings: The Return of the King', false, 'LOTR extended-for-extended allowed');

// A floored film with an UNSTATED candidate is refused: unstated (1) is below every floor.
refuse('The Lord of the Rings The Two Towers 2002 2160p BluRay x265-GROUP',
  'EXTENDED', 'The Lord of the Rings: The Two Towers', true,
  'untagged LOTR release is refused by the floor — almost certainly theatrical');

// Floor lookup must be robust to punctuation, colons and a trailing year.
ok(editionFloorFor('The Lord of the Rings: The Two Towers') === 2, 'floor found despite colon');
ok(editionFloorFor('Blade Runner (1982)') === 3, 'floor found despite year suffix');
ok(editionFloorFor('blade  runner') === 3, 'floor found despite case and double space');
ok(editionFloorFor('Blade Runner 2049') === null, 'Blade Runner 2049 is a DIFFERENT film — no floor');
ok(editionFloorFor('The Two Towers') === null, 'partial title must not match the floor entry');
ok(editionFloorFor('Some Other Movie') === null, 'unlisted film has no floor');

// ---- THE GENERAL RULE: never go below the edition you already own -----------------------------
refuse('Gladiator 2000 Theatrical 2160p BluRay', 'EXTENDED', 'Gladiator', true,
  'explicit theatrical below our extended copy — refused by the general rule, no floor entry needed');
refuse('Alien 1979 Theatrical 1080p', 'Directors Cut', 'Alien', true, 'theatrical below our DC copy');
refuse('Avatar 2009 1080p BluRay x264', 'Extended Collectors Edition', 'Avatar', true,
  'untagged candidate below our extended copy');
refuse('Blue Velvet 1986 Extended 2160p', 'Extended', 'Blue Velvet', false, 'same tier is the normal upgrade path');
refuse('Heat 1995 Directors Cut 2160p', 'Directors Cut Remastered', 'Heat', false,
  'DC-for-DC allowed; the remaster word on our side must not change the tier');
refuse('Almost Famous 2000 Directors Cut 1080p', 'EXTENDED', 'Almost Famous', false,
  'UPGRADING the edition is always allowed');
// The ordinary case: neither side states an edition. Must not refuse, or most of the library breaks.
refuse('Ronin 1998 REMASTERED BluRay 1080p x264', '', 'Ronin', false, 'no edition either side — allowed');
refuse('Burn After Reading 2008 1080p BluRay x264-OFT', null, 'Burn After Reading', false, 'null own edition — allowed');
refuse('Some Movie 2020 2160p', undefined, 'Some Movie', false, 'undefined own edition — allowed');

// ---- known-harmless false positive, documented on purpose ------------------------------------
// "Uncut Gems" contains the word UNCUT, so the film itself parses as tier 2. Harmless: the word is in
// the TITLE, so it appears on both sides of every comparison for that film and they tie.
tier('Uncut Gems 2019 1080p BluRay x264', 2, 'Extended');
refuse('Uncut Gems 2019 2160p BluRay x265', 'Uncut Gems', 'Uncut Gems', false,
  'Uncut Gems must still be upgradable despite UNCUT matching its own title');

// ---- ownEditionOf: the best of *arr's field and the filename ----------------------------------
// Every case below is REAL data from the live library on 2026-07-30.
const own = (ed, p) => ownEditionOf(ed, p);
ok(own('REMASTERED', 'Apocalypse.Now.1979.Redux.Explicit.REMASTERED.1080p.BluRay.x265-RBG.mp4').tier === 2,
  'Apocalypse Now: filename says Redux, field says only REMASTERED — we DO own Redux');
ok(own('REMASTERED', 'Independence Day 1996 REMASTERED EXTENDED 1080p BluRay HEVC x265 5.1.mp4').tier === 2,
  'Independence Day: filename says EXTENDED');
ok(own('', 'The Iron Giant (1999) DIRECTOR CUT REPACK 1080p BluRay 5 1-LAMA.mp4').tier === 3,
  'The Iron Giant: filename says DIRECTOR CUT (no apostrophe-s)');
ok(own('Directors Cut', 'The Exorcist (1973) Bluray-1080p.mkv').tier === 3,
  'The Exorcist: the FIELD is the only source — renaming stripped it from the file');
ok(own('EXTENDED', 'Almost Famous (2000) Bluray-1080p.mp4').tier === 2, 'Almost Famous: field only');
ok(own('Theatrical Cut', 'Blade Runner (1982) Bluray-1080p.mkv').tier === 0,
  'Blade Runner: field correctly reports the THEATRICAL cut — must not be rounded up');
ok(own('Unrated', 'Tropic Thunder 2008 Unrated DC 1080p BluRay HEVC H265 5.1 BONE.mp4').tier === 3,
  'Tropic Thunder: filename DC (3) beats the field Unrated (2)');
ok(own('', '').tier === 1, 'nothing stated either side → unstated');
ok(own(null, undefined).tier === 1, 'null/undefined safe');
ok(own('REMASTERED', 'x REMASTERED y').restored === true, 'restored survives the max()');

// And the payoff: with the filename consulted, Apocalypse Now is NOT below its floor any more, so we
// must not offer to "upgrade" a Redux copy we already hold to another Redux.
refuse('Apocalypse Now 1979 Theatrical 1080p BluRay',
  own('REMASTERED', 'Apocalypse.Now.1979.Redux.Explicit.REMASTERED.1080p.BluRay.x265-RBG.mp4'),
  'Apocalypse Now', true, 'theatrical still refused against our Redux');
refuse('Apocalypse Now Final Cut 2019 2160p',
  own('REMASTERED', 'Apocalypse.Now.1979.Redux.Explicit.REMASTERED.1080p.BluRay.x265-RBG.mp4'),
  'Apocalypse Now', false, 'Final Cut is an upgrade from Redux and must be allowed');

// ---- ABOVE-FLOOR PREFERENCE (EDITION_BEST) -----------------------------------------------------
// Brennan, 2026-07-30: "somehow it didnt find apocolypse now? Which should go from redux -> final?"
// Not a bug at the time — a scope limit. The floor for Apocalypse Now is 2 and he owns Redux (2), so
// the section considered it satisfied. EDITION_BEST is the second, softer axis: below FLOOR is a
// refusal, below BEST is a suggestion. These assert the two never overlap.
{
  const { editionUpgradeFor, editionBestFor, editionFloorFor, EDITION_BEST } = require('../controller/lib/release-rules');
  const T = (title, mineTier, want, why) => ok(editionUpgradeFor(title, mineTier) === want,
    `editionUpgradeFor(${JSON.stringify(title)}, tier ${mineTier}) → ${editionUpgradeFor(title, mineTier)}, want ${want} — ${why}`);

  // THE REPORTED CASE: Redux (2) is at the floor but below best (4) → suggest the Final Cut.
  T('Apocalypse Now', 2, 4, 'Redux is acceptable but the Final Cut is definitive');
  T('Apocalypse Now (1979)', 2, 4, 'year suffix is normalised away');
  T('Apocalypse Now', 4, null, 'already holding the Final Cut → nothing to suggest');

  // BELOW THE FLOOR IS NEVER A "PREFERENCE". It is already a refusal, and a film must never be
  // reported as both — that would put one title in two contradictory states in the same section.
  T('Apocalypse Now', 1, null, 'unstated is below floor 2 → refusal territory, not a suggestion');
  T('Apocalypse Now', 0, null, 'explicit theatrical is a refusal, never a suggestion');
  T('Blade Runner', 0, null, 'theatrical Blade Runner is below floor 3 → refusal, not preference');
  T('Blade Runner', 3, 4, "Director's Cut is at the floor; the 2007 Final Cut is the one to own");
  T('Blade Runner', 4, null, 'Final Cut held → satisfied');

  // LOTR: extended IS the best there is, so owning it must produce no nagging row.
  T('The Lord of the Rings: The Two Towers', 2, null, 'Extended is the best cut; do not suggest more');
  T('The Lord of the Rings: The Two Towers', 0, null, 'theatrical LOTR is a refusal, not a suggestion');

  // Films with no cut distinction must be silent — this is ~790 of the 806 in the library.
  T('Casablanca', 1, null, 'not in EDITION_BEST → no suggestion');
  T('Pulp Fiction', 2, null, 'not in EDITION_BEST → no suggestion');
  T('', 1, null, 'empty title');
  T('Apocalypse Now', null, null, 'unknown owned tier → no claim either way');

  // Accepts the ownEditionOf() shape as well as a bare tier, since that is what audit.js holds.
  ok(editionUpgradeFor('Apocalypse Now', { tier: 2, label: 'Extended' }) === 4, 'accepts an edition object');
  ok(editionUpgradeFor('Apocalypse Now', {}) === null, 'edition object with no tier makes no claim');

  // CONSISTENCY: best must never be BELOW floor, or the two rules would contradict each other.
  for (const [t, best] of EDITION_BEST) {
    const f = editionFloorFor(t);
    ok(f == null || best >= f, `EDITION_BEST["${t}"]=${best} must be >= its floor ${f}`);
  }
  ok(editionBestFor('apocalypse now') === 4, 'editionBestFor is title-normalised');
  ok(editionBestFor('Nothing At All') === null, 'unknown film has no best edition');
}

console.log(`\nedition: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
