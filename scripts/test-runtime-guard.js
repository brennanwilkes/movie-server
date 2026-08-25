'use strict';
// runtimeVerdict — the guard that stops a release which is not the whole film from replacing one
// that is. Written from the Chinatown (1974) incident, 2026-08-10.
//
// WHAT HAPPENED: a 6.78 GB "Chinatown 1974 1080p BluRay x264-GeneMige" contained 68 minutes of a
// 130-minute film. Correct name, valid container, full 13.2 Mbps bitrate, one video file, custom
// formats *arr was happy with — and half the movie. The audit swap deleted the good 1.71 GB copy,
// imported it, and only THEN noticed ("short: 68 min replacing 131 min (52%)"). Its only repair was
// to re-import the same short torrent, which it did twice before giving up, leaving the library with
// 68 minutes of Chinatown and no way back.
//
// THE ASYMMETRY THAT SHAPES THESE TESTS is the opposite of cfRefusalIsExcusable's. There, a wrongly
// ALLOWED import loses a good file, so ambiguity resolves toward refusing. Here the gate itself
// refuses, and a false 'short' refuses a perfectly good replacement — so ambiguity must resolve
// toward 'ok'/'unknown', and the must-not-fire cases are weighted heaviest.
//
// The numbers below are MEASURED, not invented: every ratio is from the ffprobe sweep of all 881
// movie files and 1700 episode files on 2026-08-12. That is the point — these tests fail if anyone
// moves the threshold into the range where real files live.
const { runtimeVerdict, runtimeShortDetail, RUNTIME_MIN_RATIO } = require('../controller/lib/release-rules');

let pass = 0; let fail = 0;
const ok = (cond, why) => { if (cond) { pass++; return; } fail++; console.log(`FAIL  ${why}`); };
const mins = (n) => n * 60;
const v = (o) => runtimeVerdict(o);

// ── the threshold itself ─────────────────────────────────────────────────────────────────────
ok(RUNTIME_MIN_RATIO === 0.6, 'threshold is 0.6 — the empty gap between the worst real file (0.82) and Chinatown (0.52)');
ok(RUNTIME_MIN_RATIO > 0.52, 'must fire on Chinatown');
ok(RUNTIME_MIN_RATIO < 0.82, 'must NOT fire on the worst legitimate file measured');

// ── MUST FIRE: the two genuine truncations in the library ────────────────────────────────────
ok(v({ gotSecs: mins(68.2), filmSecs: mins(130) }).verdict === 'short',
  'Chinatown: 68.2 min of a 130 min film (52%) — the case this exists for');
ok(v({ gotSecs: mins(15.7), filmSecs: mins(97) }).verdict === 'short',
  'Star Wars Holiday Special: 15.7 min of 97 (16%) — a .VOB fragment');
ok(v({ gotSecs: mins(13.5), filmSecs: mins(145) }).verdict === 'short',
  'GoodFellas: a 13:32 extras clip standing in for a 145 min film (9%)');
ok(v({ gotSecs: 60, filmSecs: mins(120) }).verdict === 'short', 'a one-minute file is never a feature');

// ── MUST NOT FIRE: every legitimate source of runtime disagreement, measured ─────────────────
// These are the real reasons a good file disagrees with TMDB. Each one is a false positive waiting
// to happen if the threshold creeps up, and each would refuse a replacement Brennan chose.
const legit = [
  [82.4, 88, 'Scary Movie 0.94 — credits/PAL noise'],
  [167.7, 188, 'The Hateful Eight 0.89 — TMDB lists the 188 min roadshow, the release is theatrical'],
  [200.6, 215, 'The Brutalist 0.93 — TMDB counts the intermission'],
  [89.1, 100, 'The Room 0.89 — TMDB runtime simply disagrees'],
  [106.9, 115, 'The Deadly Affair 0.93'],
  [179.2, 191, 'Judgment at Nuremberg 0.94'],
  [146.7, 155, 'A Woman Under the Influence 0.95'],
  [233.2, 238, 'Gone with the Wind 0.98'],
  [5.8, 7, '2036: Nexus Dawn 0.82 — THE WORST LEGITIMATE FILE MEASURED; a short, where seconds swing the ratio'],
  [5.3, 6, '2048: Nowhere to Run 0.88 — another short'],
];
for (const [got, want, why] of legit) {
  ok(v({ gotSecs: mins(got), filmSecs: mins(want) }).verdict === 'ok', `must NOT refuse: ${why}`);
}
// TV: TVDB runtimes include ad breaks, so a whole genre of good files sits near 0.8.
ok(v({ gotSecs: mins(17.9), filmSecs: mins(25) }).verdict === 'ok',
  'Two and a Half Men S01E05 0.71 — sitcom minus ad breaks, the lowest of 22 such files');
ok(v({ gotSecs: mins(19.2), filmSecs: mins(25) }).verdict === 'ok', "It's Always Sunny 0.77 — same shape");
ok(v({ gotSecs: mins(243.3), filmSecs: mins(300) }).verdict === 'ok', 'Cosmos S01E09-E13 multi-episode file 0.81');

// A LONGER file is never short. Cuts differ in both directions and the gate has no opinion about
// extra footage — Apocalypse Now Redux is 202 min against a 183 min Final Cut.
ok(v({ gotSecs: mins(202), filmSecs: mins(183) }).verdict === 'ok', 'a longer cut is not short');
ok(v({ gotSecs: mins(238), filmSecs: mins(130) }).verdict === 'ok', 'a much longer file is still not "short"');

// ── BOTH YARDSTICKS ─────────────────────────────────────────────────────────────────────────
// The half of the fix that matters most for RECURRENCE: if the copy on disk is already truncated,
// comparing only against it would wave a second truncation straight through.
ok(v({ gotSecs: mins(68), filmSecs: mins(130), oldSecs: mins(68) }).verdict === 'short',
  'THE REGRESSION PIN: replacing the broken 68 min Chinatown with another 68 min copy is still short,'
  + ' because TMDB says 130 — the old comparison-against-the-old-file alone would have allowed it');
ok(v({ gotSecs: mins(100), filmSecs: 0, oldSecs: mins(130) }).verdict === 'ok',
  'no TMDB runtime → falls back to the file on disk, and 77% of it is fine');
ok(v({ gotSecs: mins(60), filmSecs: 0, oldSecs: mins(130) }).verdict === 'short',
  'no TMDB runtime → the on-disk copy still catches a halving');
ok(v({ gotSecs: mins(120), filmSecs: mins(130), oldSecs: mins(200) }).verdict === 'ok',
  'a 200 min extended cut on disk must not make a 120 min theatrical "short" — 0.6 of 200 is 120');
ok(v({ gotSecs: mins(68), filmSecs: mins(130), oldSecs: mins(200) }).verdict === 'short',
  'but a genuinely truncated file is caught against whichever yardstick is longer');
ok(v({ gotSecs: mins(90), filmSecs: mins(130), oldSecs: mins(100) }).basis === 'tmdb',
  'basis names TMDB when it is the longer yardstick');
ok(v({ gotSecs: mins(90), filmSecs: mins(100), oldSecs: mins(130) }).basis === 'disk',
  'basis names the existing copy when IT is the longer yardstick');

// ── MUST FAIL OPEN: no evidence is not evidence ──────────────────────────────────────────────
// Every one of these would refuse a healthy swap if it returned 'short'. ffprobe failing on a loaded
// NUC must never start declining replacements.
ok(v({ gotSecs: null, filmSecs: mins(130) }).verdict === 'unknown', 'ffprobe failed → unknown, never short');
ok(v({ gotSecs: 0, filmSecs: mins(130) }).verdict === 'unknown', 'zero duration → unknown (0 is "could not read", not "empty film")');
ok(v({ gotSecs: undefined, filmSecs: mins(130) }).verdict === 'unknown', 'undefined duration → unknown');
ok(v({ gotSecs: mins(90), filmSecs: 0, oldSecs: 0 }).verdict === 'unknown', 'no yardstick at all → unknown');
ok(v({ gotSecs: mins(90) }).verdict === 'unknown', 'yardsticks omitted entirely → unknown');
ok(v({}).verdict === 'unknown', 'empty input → unknown');
ok(v().verdict === 'unknown', 'no input at all → unknown, not a throw');
ok(v({ gotSecs: 'nonsense', filmSecs: 'nonsense' }).verdict === 'unknown', 'garbage in → unknown');
ok(v({ gotSecs: mins(68), filmSecs: null, oldSecs: null }).verdict === 'unknown', 'null yardsticks → unknown');

// ── boundary ────────────────────────────────────────────────────────────────────────────────
ok(v({ gotSecs: 60, filmSecs: 100 }).verdict === 'ok', 'exactly at the ratio is ok (strict <)');
ok(v({ gotSecs: 59, filmSecs: 100 }).verdict === 'short', 'just under the ratio is short');
ok(v({ gotSecs: mins(130), filmSecs: mins(130) }).verdict === 'ok', 'an exact match is ok');
ok(v({ gotSecs: mins(50), filmSecs: mins(100), minRatio: 0.4 }).verdict === 'ok', 'minRatio is overridable');

// ── the human-readable sentence ──────────────────────────────────────────────────────────────
const cd = v({ gotSecs: mins(68.2), filmSecs: mins(130) });
ok(runtimeShortDetail(cd) === '68 min of a 130 min film (52%)', `detail reads naturally: got "${runtimeShortDetail(cd)}"`);
const dd = v({ gotSecs: mins(60), filmSecs: 0, oldSecs: mins(130) });
ok(runtimeShortDetail(dd) === '60 min of a 130 min existing copy (46%)',
  `detail names the existing copy when that is the basis: got "${runtimeShortDetail(dd)}"`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
