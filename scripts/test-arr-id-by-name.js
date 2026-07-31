#!/usr/bin/env node
'use strict';
// Table test for arrIdByName (controller/lib/arr-data.js) — the LAST-RESORT title match that lets
// the Downloads tab offer a release picker on a stalled torrent *arr has no queue record for.
//
// It is only ever used to run a SEARCH, never to touch a file, but a wrong id would offer releases
// for the wrong show — so the must-NOT-match cases matter as much as the must-match ones.
//
//   node scripts/test-arr-id-by-name.js
const { arrIdByName } = require('../controller/lib/arr-data');

// A library shaped like the real one: getHasFileMap stores both "title" and "title year" keys.
const LIB = new Map([
  ['the wire', 60],
  ['the wire 2002', 60],
  ['the office', 12],
  ['the office 2005', 12],
  ['the office us', 13],
  ['the office us 2005', 13],
  ['bobs burgers', 30],
  ['american gods', 91],
  ['the lord of the rings the rings of power', 23],
]);

const CASES = [
  // ── The releases that drove this: *arr-orphaned Wire episodes. ──
  { name: 'Wire episode release', rel: 'The Wire S05E08 720p HDTV x264-BATV', want: 60 },
  { name: 'Wire episode with brackets', rel: 'The Wire S05E09 RERIP 1080p BluRay x264-ROVERS[rartv]', want: 60 },
  { name: 'season pack', rel: 'American Gods (S01)(2020)(Complete)(FHD)(1080p)(x264)', want: 91 },
  { name: 'dotted long title', rel: 'The.Lord.of.the.Rings.The.Rings.of.Power.S01.1080p.WEB-DL.x264', want: 23 },
  { name: 'apostrophe deleted, not spaced', rel: 'Bobs.Burgers.S01E01.1080p.WEB', want: 30 },

  // ── Longest match wins: a shorter title must never shadow a longer one. ──
  { name: 'The Office US beats The Office', rel: 'The.Office.US.S03E01.1080p', want: 13 },
  { name: 'plain The Office still resolves', rel: 'The.Office.S03E01.1080p', want: 12 },
  { name: 'title+year key does not break longest-match', rel: 'The Wire 2002 S01E01 1080p', want: 60 },

  // ── Must NOT match: a prefix guess that reaches beyond a word boundary is a wrong show. ──
  { name: 'different show sharing a prefix word', rel: 'The Wireless S01E01 1080p', want: null },
  { name: 'title is a suffix, not a prefix', rel: 'Watching The Wire S01E01', want: null },
  { name: 'nothing in the library matches', rel: 'Some.Unknown.Show.S01E01.1080p', want: null },
  { name: 'empty release name', rel: '', want: null },
  { name: 'no library map', rel: 'The Wire S05E08', lib: null, want: null },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const got = arrIdByName(c.rel, c.lib === undefined ? LIB : c.lib);
  const ok = (got ?? null) === c.want;
  if (ok) { pass++; console.log(`  ok   ${c.name} -> ${got ?? 'no match'}`); }
  else { fail++; console.log(`  FAIL ${c.name}\n         want: ${c.want ?? 'no match'}\n         got:  ${got ?? 'no match'}`); }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
