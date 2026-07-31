'use strict';
// CF_PERMANENT_RE (audit.js) vs UPGRADE_REJECT_RE (importer.js) must NOT overlap.
//
// They mean opposite things at opposite moments:
//   UPGRADE_REJECT_RE — matched during the swap PREFLIGHT, while the original is STILL ON DISK, where
//     "not an upgrade" is the EXPECTED answer and must be treated as harmless.
//   CF_PERMANENT_RE   — matched on *arr's refusal of the REAL import, where the verdict is final and
//     the swap should be abandoned at once.
// If CF_PERMANENT_RE ever matched an UPGRADE_REJECT phrase, every healthy swap would abandon on its
// own preflight. If UPGRADE_REJECT_RE swallowed the CF phrasing, no doomed swap would ever abandon.
// This test pins that separation, since both regexes live in different files and can drift apart.
const CF_PERMANENT_RE = /not a custom format upgrade|do not improve on existing/i;
const UPGRADE_REJECT_RE = /not an upgrade|existing file|already imported|equal or higher preference|higher preference/i;

let pass = 0; let fail = 0;

// ANTI-DRIFT: both regexes are copied here, and a copy is worthless if the original changes under it.
// audit.js and importer.js cannot simply be required (they register routes / start timers on load),
// so assert the literal source text still matches what this file is testing.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'controller', 'lib');
for (const [file, name, re] of [
  ['audit.js', 'CF_PERMANENT_RE', CF_PERMANENT_RE],
  ['importer.js', 'UPGRADE_REJECT_RE', UPGRADE_REJECT_RE],
]) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (src.includes(`const ${name} = ${re.toString()};`)) { pass++; continue; }
  fail++;
  console.log(`FAIL  ${name} in ${file} no longer matches the copy under test — update this file.\n`
    + `      expected to find: const ${name} = ${re.toString()};`);
}
function t(text, wantCf, wantUpgrade, why) {
  const gotCf = CF_PERMANENT_RE.test(text);
  const gotUp = UPGRADE_REJECT_RE.test(text);
  if (gotCf === wantCf && gotUp === wantUpgrade) { pass++; return; }
  fail++;
  console.log(`FAIL  cf:want ${wantCf} got ${gotCf} | upgrade:want ${wantUpgrade} got ${gotUp}\n      ${text}\n      (${why})`);
}

// ---- the real message, verbatim from Sonarr on Rings of Power S01 2026-07-30 -------------------
const REAL = 'Not a Custom Format upgrade for existing episode file(s). New: '
  + '[Non-original language (reject), Original-language audio, Size 1.5-3 GB] (-99800) '
  + 'do not improve on Existing: [HEVC 8-bit (GPU), Original-language audio, Size 1.5-3 GB] (220)';
t(REAL, true, false, 'the actual observed rejection must be PERMANENT and must NOT read as an upgrade-reject');

// Both halves of the CF regex must fire on their own, so a reworded *arr build still matches.
t('Not a Custom Format upgrade for existing movie file', true, false, 'first alternative alone');
t('New: [x] (-500) do not improve on Existing: [y] (10)', true, false, 'second alternative alone');
t('NOT A CUSTOM FORMAT UPGRADE', true, false, 'case-insensitive');

// ---- the preflight phrases: harmless, must NEVER be treated as permanent ----------------------
t('Not an upgrade for existing episode file(s)', false, true, 'plain not-an-upgrade is the EXPECTED preflight answer');
t('Existing file has equal or higher preference', false, true, 'preference wording');
t('File already imported', false, true, 'already imported');
t('Has an existing file with higher preference', false, true, 'higher preference');

// ---- unrelated refusals: neither regex ---------------------------------------------------------
t('Sample file detected', false, false, 'sample');
t('Unknown Series', false, false, 'unparseable release');
t('No files found are eligible for import', false, false, 'empty folder — transient, must keep retrying');
t('Invalid video file: The Wire S05E09.mkv', false, false, 'corrupt file');
t('', false, false, 'empty reason must never abandon');
t('Not a Custom Format upgrade', true, false, 'truncated CF message still matches');

// A message containing BOTH phrasings must be treated as permanent — the CF verdict is the stronger
// statement, and the preflight branch only consults CF_PERMANENT_RE, so this documents the precedence.
t('Not an upgrade. Not a Custom Format upgrade for existing file', true, true,
  'mixed message: CF wins because the abandon branch tests CF_PERMANENT_RE');

console.log(`\ncf-permanent: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
