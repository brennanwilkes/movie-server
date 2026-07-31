#!/usr/bin/env node
'use strict';
// Table test for chooseMovieFile (controller/lib/importer.js) — the guard that stops a multi-file
// movie release importing its extras over the feature. That bug deleted the 8.77 GB GoodFellas on
// 2026-07-29 and left a 13-minute featurette in its place (#86).
//
// Two ways to fail, both bad:
//   FALSE PICK    — choose an extras clip, and a swap destroys the film.
//   FALSE REFUSAL — refuse a legitimate release, and swaps that used to work stop working.
// So the must-PICK cases matter exactly as much as the must-REFUSE ones.
//
//   node scripts/test-choose-movie-file.js
const { chooseMovieFile } = require('../controller/lib/importer');

const GB = 1e9;
const e = (name, gb, parsedId = null) => ({ f: { path: `/x/${name}` }, size: gb * GB, parsedId });

const CASES = [
  // ── The actual GoodFellas folder (movie 381). Feature is 42x the runner-up. ──
  { name: 'GoodFellas: feature + 4 extras, none parsed', id: 381,
    entries: [
      e('Goodfellas.Extras1.Getting.Made-Grym.mkv', 0.39),
      e('Goodfellas.Extras2.Made.Men-Grym.mkv', 0.18),
      e('Goodfellas.Extras4.The.Workaday.Gangster-Grym.mkv', 0.10),
      e('Goodfellas.Extras3.Paper.is.Cheaper-Grym.mkv', 0.09),
      e('Goodfellas.1990.Bluray.1080p.DD-5.1.x264-Grym.MKV', 16.71),
    ],
    want: 'Goodfellas.1990.Bluray.1080p.DD-5.1.x264-Grym.MKV' },

  // ── Same folder, but Radarr parsed the feature. Evidence beats size. ──
  { name: 'feature parsed to the expected movie wins outright', id: 381,
    entries: [
      e('Extras.Making.Of.mkv', 3.0),
      e('Goodfellas.1990.feature.mkv', 2.0, 381),
    ],
    want: 'Goodfellas.1990.feature.mkv' },

  // ── The ordinary case: one video. Must never be disturbed. ──
  { name: 'single file is always the pick', id: 42,
    entries: [e('Some.Movie.2020.1080p.mkv', 8.0)], want: 'Some.Movie.2020.1080p.mkv' },
  { name: 'single file with no parse and no expectedId', id: null,
    entries: [e('Unparseable.Thing.mkv', 5.0)], want: 'Unparseable.Thing.mkv' },

  // ── Feature + sample: sample is tiny, so the feature dominates. ──
  { name: 'feature + sample', id: 7,
    entries: [e('sample-movie.mkv', 0.05), e('Movie.2019.1080p.BluRay.x264.mkv', 9.4)],
    want: 'Movie.2019.1080p.BluRay.x264.mkv' },

  // ── REFUSALS: cannot tell which is the film, so do not guess. ──
  { name: 'two similar-sized videos (double feature / two cuts)', id: 9,
    entries: [e('Movie.Theatrical.mkv', 8.0), e('Movie.Directors.Cut.mkv', 9.0)],
    want: null },
  { name: 'largest is only 1.5x the runner-up', id: 9,
    entries: [e('a.mkv', 4.0), e('b.mkv', 6.0)], want: null },
  { name: 'sizes unavailable', id: 9,
    entries: [e('a.mkv', 0), e('b.mkv', 0)], want: null },
  { name: 'every candidate parsed to a DIFFERENT movie', id: 100,
    entries: [e('Other.Film.mkv', 9.0, 555), e('Another.Film.mkv', 8.0, 556)],
    want: null },
  { name: 'no entries at all', id: 1, entries: [], want: null },

  // ── Mixed: a foreign-movie parse must not be eligible even when it is the biggest. ──
  { name: 'biggest parsed to another movie; ours is the dominant remainder', id: 100,
    entries: [
      e('Wrong.Movie.Huge.mkv', 40.0, 999),
      e('Our.Feature.mkv', 12.0),
      e('Our.Extras.mkv', 0.3),
    ],
    want: 'Our.Feature.mkv' },
  { name: 'two cuts BOTH parsed to us, one dominant', id: 100,
    entries: [e('Ours.Small.mkv', 2.0, 100), e('Ours.Big.mkv', 16.0, 100)],
    want: 'Ours.Big.mkv' },
  { name: 'two cuts both parsed to us, similar size -> refuse', id: 100,
    entries: [e('Ours.A.mkv', 8.0, 100), e('Ours.B.mkv', 9.0, 100)],
    want: null },
  // Exactly at the 2x boundary: 2x is "dominant enough" (>= ratio), so this must PICK.
  { name: 'exactly 2x the runner-up picks', id: 5,
    entries: [e('small.mkv', 4.0), e('big.mkv', 8.0)], want: 'big.mkv' },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const got = chooseMovieFile(c.entries, c.id);
  const gotName = got.pick ? got.pick.f.path.replace('/x/', '') : null;
  const ok = gotName === c.want;
  if (ok) { pass++; console.log(`  ok   ${c.name}${gotName ? ` -> ${gotName}` : ' -> refused'}`); }
  else { fail++; console.log(`  FAIL ${c.name}\n         want: ${c.want || 'refused'}\n         got:  ${gotName || 'refused'} (${got.reason || 'no reason'})`); }
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
