'use strict';
// Unit tests for supersedes() — the gate that decides whether a manually-picked release fully
// covers a stalled download, and therefore whether cancelSuperseded may delete that download.
// A false POSITIVE throws away a real download, so the must-NOT cases below are the important half.
const { scopeOf, supersedes } = require('../controller/lib/release-rules');

let pass = 0; let fail = 0;
function t(neu, old, want, why) {
  const got = supersedes(scopeOf(neu), scopeOf(old));
  if (got === want) { pass++; return; }
  fail++;
  console.log(`FAIL  want ${want} got ${got}\n      new: ${neu}\n      old: ${old}\n      (${why})`);
}

// ---- the case that prompted this: a season pack replaces a single stalled episode of it ---------
t('The.Wire.S05.1080p.BluRay.x265', 'The Wire S05E09 720p HDTV x264-BATV', true, 'S05 pack covers S05E09');
t('The.Wire.S05.1080p.BluRay.x265', 'The Wire S05E08 720p HDTV x264-BATV', true, 'same, other episode');
t('The Wire Complete Series 1080p BluRay x265', 'The Wire S05E09 720p HDTV', true, 'complete series covers everything');
t('The.Wire.S01-S05.1080p.BluRay.x265', 'The Wire S05E09 720p HDTV', true, 'span S01-S05 contains S05');
t('The.Wire.S01-S05.1080p.BluRay.x265', 'The.Wire.S03.1080p.BluRay', true, 'span contains a whole season');

// ---- must NOT cancel: different season --------------------------------------------------------
t('The.Wire.S05.1080p.BluRay.x265', 'The Wire S04E11 720p HDTV', false, 'S05 does not cover S04');
t('The.Wire.S01-S04.1080p.BluRay', 'The Wire S05E09 720p HDTV', false, 'span stops before S05');
t('The.Wire.S02.1080p.BluRay', 'The.Wire.S03.1080p.BluRay', false, 'unrelated seasons');

// ---- must NOT cancel: the new pick is NARROWER than the old download --------------------------
t('The Wire S05E09 1080p WEB-DL', 'The.Wire.S05.1080p.BluRay.x265', false, 'one episode cannot replace a season pack');
t('The.Wire.S05.1080p.BluRay', 'The.Wire.S01-S05.1080p.BluRay', false, 'one season cannot replace the whole span');
t('The.Wire.S05.1080p.BluRay', 'The Wire Complete Series 1080p', false, 'one season cannot replace "all seasons"');
t('The Wire S05E09 1080p WEB-DL', 'The Wire S05E08 720p HDTV', false, 'different episode, same season');

// ---- episode-for-episode IS allowed (a healthier copy of the exact same episode) ---------------
t('The Wire S05E09 1080p WEB-DL', 'The Wire S05E09 720p HDTV x264-BATV', true, 'same episode, better source');
t('The.Wire.5x09.1080p.WEB', 'The Wire S05E09 720p HDTV', true, '5x09 and S05E09 are the same episode');

// ---- unknown scope is never assumed either way ------------------------------------------------
t('The Wire 1080p BluRay x265', 'The Wire S05E09 720p HDTV', false, 'unknown new scope — refuse');
t('The.Wire.S05.1080p.BluRay', 'The Wire 1080p BluRay REPACK', false, 'unknown old scope — refuse');
t('The Wire 1080p', 'The Wire 720p', false, 'both unknown — refuse');
t('Complete Series 1080p', 'Complete Series 720p', true, 'all-seasons for all-seasons is total coverage');

// ---- degenerate input -------------------------------------------------------------------------
if (supersedes(null, scopeOf('The Wire S05E09')) !== false) { fail++; console.log('FAIL null new scope'); } else pass++;
if (supersedes(scopeOf('The.Wire.S05'), null) !== false) { fail++; console.log('FAIL null old scope'); } else pass++;
if (supersedes(scopeOf(''), scopeOf('')) !== false) { fail++; console.log('FAIL empty titles'); } else pass++;

console.log(`\nsupersedes: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
