#!/usr/bin/env node
'use strict';
// ONE-TIME SEED for the Elo tuner's persisted ratings (/config/elo-ratings.json).
//
// WHY THIS EXISTS. The tuner treats saved ratings as earned history: the rank-dependent K freeze that
// makes the top of the list hard to move is scaled by how many comparisons a film carries, so with an
// empty store EVERY film moves at the same rate and the first session is a ~580-matchup cold run in
// which the already-settled top 10 can reshuffle. But the live Top 100 order is not a guess — it is
// the product of Brennan's previous tuning sessions. That history is real, it is just not in a file.
//
// So this seeds a rating for EVERY film from its current playlist position, plus a carried-comparison
// count derived from how confident Brennan actually is at that depth (2026-08-18, his numbers):
//
//     top 10   ~99%        #50   ~65%
//     top 25   ~85%        bottom 50   25-40%
//
// Confidence maps to carried comparisons (carried = confidence × CARRIED_CAP), which the tuner reads
// two ways: as stiffness (a 99% film moves at ~half base K and needs several consistent results to
// shift a slot; a 30% film moves freely) and as vetting status (anything under UNPROVEN_CARRIED joins
// the work set, in batches, until it has earned its place).
//
// WHAT THIS DELIBERATELY DOES NOT DO: trust only the top N and leave the rest unrated. That was tried
// and simulated first, and it is much worse — an unrated film enters PLACEMENT (binary search), and
// placement is for inserting a few titles into an established list. With 67 of them at once they end
// up bisecting against each other's provisional ratings, which are all the same band midpoint, and the
// tail comes out scrambled (measured: 796 inversions, films 40+ ranks from where they belonged, worse
// than doing no bootstrap at all). Grading confidence keeps every film's current position as its
// starting point and lets ordinary refinement do the work.
// Usage:  node scripts/elo-bootstrap.js [--host http://192.168.1.74:8088] [--force]
// Refuses to overwrite an existing store unless --force: real earned history is not worth clobbering.

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const HOST = flag('host', 'http://192.168.1.74:8088');
const FORCE = args.includes('--force');

// Must match RANK_SPACING in elo-tuner/app.js — the tuner's whole calibration (K, drift, proximity)
// is expressed in these units, so seeding at a different spacing would silently mis-scale all of it.
const RANK_SPACING = 20;
const BASE_RATING = 1500;
// Must match CARRIED_CAP in elo-tuner/app.js: the count at which a film earns the FULL rank freeze.
const CARRIED_CAP = 12;

// Brennan's stated confidence by depth, as (fraction through the list, confidence) anchors, linearly
// interpolated between. Expressed as fractions rather than absolute ranks so it keeps meaning if the
// list grows past 117.
const CONFIDENCE = [
  [0.00, 0.99],   // #1
  [0.085, 0.99],  // through the top 10
  [0.21, 0.85],   // #25
  [0.43, 0.65],   // #50
  [0.57, 0.40],   // top of the bottom 50
  [1.00, 0.25],   // last
];

function confidenceAt(frac) {
  for (let i = 1; i < CONFIDENCE.length; i++) {
    const [x1, y1] = CONFIDENCE[i - 1], [x2, y2] = CONFIDENCE[i];
    if (frac <= x2) return y1 + (y2 - y1) * ((frac - x1) / (x2 - x1 || 1));
  }
  return CONFIDENCE[CONFIDENCE.length - 1][1];
}

async function main() {
  const cur = await (await fetch(`${HOST}/api/elo/ratings`)).json();
  if (Object.keys(cur.ratings || {}).length && !FORCE) {
    console.error(`refusing: ${Object.keys(cur.ratings).length} ratings already stored (pass --force to overwrite)`);
    process.exit(1);
  }

  const list = await (await fetch(`${HOST}/api/elo/top100`)).json();
  if (!list.items || !list.items.length) throw new Error(`no items: ${JSON.stringify(list).slice(0, 200)}`);
  const items = list.items;
  const n = items.length;

  const ratings = {};
  items.forEach((it, i) => {
    const conf = confidenceAt(n > 1 ? i / (n - 1) : 0);
    ratings[it._eloKey] = {
      rating: BASE_RATING - i * RANK_SPACING,
      comparisons: Math.round(conf * CARRIED_CAP),
      lastSeen: 1,               // session 1, so the staleness audit does not fire on them immediately
      name: it.Name,
      year: it.ProductionYear || null,
    };
  });

  const body = { sessions: 1, seenOrder: items.map((it) => it._eloKey), ratings };
  const res = await fetch(`${HOST}/api/elo/ratings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const out = await res.json();
  if (!res.ok || !out.ok) throw new Error(`save failed: ${JSON.stringify(out)}`);

  // UNPROVEN_CARRIED in elo-tuner/app.js — quoted here only to report how much work session 1 has.
  const UNPROVEN_CARRIED = 6;
  const unproven = items.filter((it) => ratings[it._eloKey].comparisons < UNPROVEN_CARRIED).length;
  console.log(`bootstrapped ${n} films from the live playlist order`);
  for (const at of [1, 10, 25, 50, Math.ceil(n * 0.57) + 1, n]) {
    const it = items[at - 1];
    if (!it) continue;
    const r = ratings[it._eloKey];
    console.log(`  #${String(at).padEnd(4)} ${String(Math.round(confidenceAt((at - 1) / (n - 1)) * 100) + '%').padEnd(4)} carried=${String(r.comparisons).padEnd(2)} ${it.Name}`);
  }
  console.log(`  ${unproven} film(s) below the confidence threshold — worked in batches of 20 per session`);
}

main().catch((e) => { console.error(`elo-bootstrap: ${e.message}`); process.exit(1); });
