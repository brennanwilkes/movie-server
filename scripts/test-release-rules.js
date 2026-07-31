#!/usr/bin/env node
'use strict';
// Table test for controller/lib/release-rules.js — the title-only heuristics shared by the Audit
// tab's candidate filter and the Downloads tab's manual-grab picker.
//
// Two halves:
//  1. REFUSALS. These were moved out of audit.js, so the point here is that the move changed
//     nothing: camrips, extras discs, dubs and foreign-only audio are still refused, and the
//     deliberate exceptions (dual audio, original-language foreign film) still pass.
//  2. SCOPE. New, and the picker's gap-aware ranking rests entirely on it: getting a season number
//     wrong means offering a pack of episodes we already have instead of the ones we are missing.
//
//   node scripts/test-release-rules.js
const {
  isRefused, refusedReason, scopeOf, resOf, codecOf, audioOf, srcRank, isMultiSeason,
} = require('../controller/lib/release-rules');

let pass = 0, fail = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         want: ${w}\n         got:  ${g}`); }
}

console.log('\n-- REFUSALS (must refuse) --');
for (const [t, why] of [
  ['Mission.Impossible.2023.1080p.HDTS.x264', 'camrip/screener'],
  ['Some.Movie.2020.HDCAM.x264', 'camrip/screener'],
  ['Some.Movie.2020.DVDSCR.XviD', 'camrip/screener'],
  ['Casino.Royale.2006.EXTRAS.1080p.BluRay.H264-RMXTRAS', 'extras/bonus disc'],
  ['Shrek.Forever.After.2010.Bonus.Disc.1080p', 'extras/bonus disc'],
  ['Some.Show.S01.Featurettes.1080p', 'extras/bonus disc'],
  ['American Gods S01 MULTi 1080p x264', 'dubbed/multi-audio'],
  ['Le.Film.2019.TRUEFRENCH.1080p', 'dubbed/multi-audio'],
  ['Some.Movie.2020.Dual.Audio.1080p', 'dubbed/multi-audio'],
  ['Some.Movie.2020.DUBBED.1080p', 'dubbed/multi-audio'],
  ['The.Wire.S05.RUS.1080p.x264', 'Russian-only audio'],
  // Cyrillic script, no Latin language tag at all — these two were live in the picker.
  ['Американские боги / American Gods / S1E1-8 (2017) BDRip 1080p', 'Russian-only audio'],
  ['Прослушка / The Wire / S1E1-60 of 60 (Дэвид Саймон) 1080p', 'Russian-only audio'],
  ['Silicon.Valley.S02.ITA.1080p.x264', 'Italian-only audio'],
]) {
  check(`refuse: ${t}`, refusedReason(t, null), why);
  check(`  isRefused agrees`, isRefused(t, null), true);
}

console.log('\n-- REFUSALS (must PASS — the deliberate exceptions) --');
for (const t of [
  'The.Wire.S05.1080p.BluRay.x265',
  'The.Wire.S05.RUS.ENG.1080p.x264',            // dual audio, English present
  'Some.Show.S01.ENG-GER.1080p',                // dual audio
  'American Gods (S01)(2020)(Complete)(1080p)', // "Complete" is not "extras"
  'Extras.S01.1080p.WEB-DL',                    // the Gervais series, position-guarded
]) check(`pass: ${t}`, isRefused(t, null), false);
// A foreign tag that IS the film's original language must pass.
check('German tag on a German film passes', isRefused('Das.Boot.1981.GER.1080p.BluRay', 'German'), false);
check('German tag on an English show refuses', isRefused('The.Wire.S05.GER.1080p', 'English'), true);
// A Russian-ORIGINAL show must keep its own Cyrillic releases — the whole point of the origLang escape.
check('Cyrillic on a Russian-original show passes', isRefused('Ход королевы S01 1080p', 'Russian'), false);
// Cyrillic alongside an explicit ENG track is dual-audio, not a dub.
check('Cyrillic + ENG passes', isRefused('Прослушка / The Wire S05 ENG RUS 1080p', 'English'), false);

console.log('\n-- SCOPE --');
const sc = (t) => { const s = scopeOf(t); return [s.kind, s.seasons, s.episode]; };
check('single episode S05E08', sc('The Wire S05E08 720p HDTV x264-BATV'), ['episode', [5], 8]);
check('single episode 5x08', sc('The Wire 5x08 720p HDTV'), ['episode', [5], 8]);
// S05E08 also contains "S05" — episode must be detected FIRST or every episode reads as a pack.
check('episode is not a season pack', scopeOf('The Wire S05E08 720p').kind, 'episode');
check('season pack S05', sc('The.Wire.S05.1080p.BluRay.x265'), ['season', [5], null]);
check('season pack "Season 5"', sc('The Wire Season 5 1080p'), ['season', [5], null]);
check('season pack (S01) bracketed', sc('American Gods (S01)(2020)(Complete)(1080p)'), ['season', [1], null]);
check('multi-season span enumerates', sc('The Wire (2002) S01-S05 1080p BluRay'), ['multi', [1, 2, 3, 4, 5], null]);
check('multi-season "Seasons 1-4"', scopeOf('Some Show Seasons 1-4 1080p').seasons, [1, 2, 3, 4]);
check('complete series has no season list', sc('Some.Show.Complete.Series.1080p'), ['multi', null, null]);
check('no marker at all', sc('Some.Movie.2020.1080p.BluRay'), ['unknown', null, null]);
// Episode RANGES must not read as a multi-season span — the dash follows an episode, not a season.
check('S01E01-E10 is not multi-season', isMultiSeason('Some.Show.S01E01-E10.1080p'), false);

console.log('\n-- PICTURE / AUDIO / SOURCE --');
check('res 1080p', resOf('The.Wire.S05.1080p.BluRay'), 1080);
check('res 720p', resOf('The Wire S05E08 720p HDTV'), 720);
check('res 2160p via 4K', resOf('Some.Movie.2020.4K.UHD.BluRay'), 2160);
check('res unstated is null, not SD', resOf('The Wire S05 DVDRip XviD'), null);
check('codec HEVC', codecOf('The.Wire.S05.1080p.BluRay.x265'), 'HEVC');
check('codec H.264', codecOf('The Wire S05E09 1080p BluRay x264-ROVERS'), 'H.264');
check('codec unstated', codecOf('The Wire S05 1080p BluRay'), null);
check('audio Atmos', audioOf('Movie.2020.1080p.TrueHD.Atmos'), 'Atmos');
check('audio DDP 5.1', audioOf('Show.S01.1080p.WEB-DL.DDP5.1'), 'DDP 5.1');
check('srcRank remux > bluray', srcRank('Movie.2020.Remux.1080p') > srcRank('Movie.2020.BluRay.1080p'), true);
check('srcRank bluray > hdtv', srcRank('Movie.BluRay') > srcRank('Movie.HDTV'), true);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
