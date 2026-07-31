'use strict';
// Resolution ceiling. Brennan, 2026-07-30: "we have no tech that can play anything above 1080p, so
// theres never any reason to grab something that isnt 720 or 1080."
//
// Worth its own tests because the *arr quality profiles already stop at 1080p, so the two surfaces
// this actually protects — the raw-Prowlarr force-grab picker and the Audit Upgrade section — are
// exactly the ones where a regression would be INVISIBLE until an unplayable 4K file landed.
const { overResCeiling, MAX_USABLE_RES, resOf } = require('../controller/lib/release-rules');

let pass = 0; let fail = 0;
const ok = (c, why) => { if (c) pass++; else { fail++; console.log(`FAIL  ${why}`); } };
const t = (title, want) => ok(overResCeiling(title) === want,
  `overResCeiling(${JSON.stringify(title)}) → ${overResCeiling(title)}, want ${want}`);

ok(MAX_USABLE_RES === 1080, 'ceiling is 1080p');

// ---- ABOVE the ceiling: must be refused --------------------------------------------------------
t('Blade.Runner.1982.The.Final.Cut.UHD.BluRay.2160p.DDP.7.1.DV.HDR.x265', true);
t('Dune 2021 2160p WEB-DL DDP5.1 Atmos HDR HEVC', true);
t('Some Movie 2020 4K UHD BluRay REMUX', true);          // resOf maps 4k/uhd to 2160
t('Some Movie 2020 UHD BluRay x265', true);
t('Movie.2019.4320p.8K.HDR', true);                      // beyond 2160 is still above

// ---- AT or BELOW the ceiling: must pass --------------------------------------------------------
t('The.Wire.S05.1080p.BluRay.x265', false);
t('Blade Runner (1982) Final Cut 1080p BluRay.x264 SUJAIDR', false);
t('The Wire S05E09 720p HDTV x264-BATV', false);
t('Old Movie 1948 480p DVDRip', false);                  // low is a different problem (PICK_RES_FLOOR)

// ---- UNSTATED is never assumed to be 4K -------------------------------------------------------
// Same principle as the edition and language rules: an unknown is not a refusal. Guessing high here
// would silently drop every release whose title omits the resolution.
t('Ronin 1998 REMASTERED BluRay x264', false);
t('', false);
t(null, false);
t(undefined, false);
ok(resOf('Ronin 1998 REMASTERED BluRay x264') === null, 'unstated resolution parses as null, not 0');

// ---- must not be fooled by numbers that are not a resolution ----------------------------------
// "2160" only counts with a p/i suffix or as an explicit 4k/uhd token, so these are NOT above the
// ceiling. A film whose TITLE contains a big number must stay grabbable.
t('Blade Runner 2049 2018 1080p BluRay x265', false);
t('2160 The Movie 1080p BluRay', false);
t('Apollo 2160 1080p WEB', false);

console.log(`\nres-ceiling: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
