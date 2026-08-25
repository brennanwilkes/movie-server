const API = '/api/elo';
let state;

const $ = s => document.querySelector(s);

// ── TUNING CONSTANTS ─────────────────────────────────────────────────────────────────────────
// EVERYTHING IS CALIBRATED AGAINST RANK_SPACING — the rating gap between two adjacent films. It has
// to be stated explicitly, because elo's 400-point logistic is what turns a rating delta into a
// probability, and the old 5-points-per-rank scale made films SIXTEEN ranks apart look like a 61%
// coin flip. A single (correct, uninformative) win over a clearly weaker film then paid out 24
// points and vaulted the winner five slots past films it had never faced — measured in simulation as
// a no-change refinement session steadily making a converged list WORSE (49 → 88 inversions over
// four passes). At 20 points a rank, adjacent films sit at 53% and a film 20 ranks down at 9%, so an
// expected result pays almost nothing and only a genuine upset moves anything.
const RANK_SPACING = 20;
const BASE_K = 24;

// RANK-DEPENDENT K. The top of the list is nearly finalised and must not wobble on one stray click;
// the bottom is where the real uncertainty lives and should move freely. Read the factors as
// "adjacent-swap cost": at the top a win against the neighbour above moves ~a quarter of a rank, so
// it takes three or four consistent results to actually trade places, while at the bottom one result
// moves a full rank.
const MIN_RANK_FACTOR = 0.5;
const MAX_RANK_FACTOR = 1.8;
const RANK_GAMMA = 1.4;
// Placement (see below) IGNORES the rank curve: a film being placed for the first time has no earned
// position to protect.
const PLACEMENT_RANK_FACTOR = 1.8;
// How much history it takes to earn the FULL rank curve. Films with less get proportionally less
// positional protection — see the `trust` blend in eloK().
const CARRIED_CAP = 12;
// Mild within-session damping so a film asked about repeatedly settles rather than oscillating.
// Deliberately gentler than the old sqrt(1 + n/5): the rank curve now does the freezing, and
// stacking both made top-of-list films immovable rather than merely sticky.
const SESSION_DECAY = 8;

// ── PLACEMENT (binary search) ────────────────────────────────────────────────────────────────
// A new or manually-moved film is placed by BISECTION, not by random pairing: probe the middle of
// its remaining candidate band, halve the band on the result, repeat. ~7 comparisons locates a
// title in a list of 116 versus dozens of proximity-weighted coin flips — and it produces exactly
// the pairings that matter, i.e. a surging film gets matched against the top 10 as soon as its
// band moves up there.
const PLACE_BAND = 3;        // stop bisecting once this few films remain inside the band…
const PLACE_MAX = 9;         // …or this many probes in, whichever comes first
const CONFIRM_NEIGHBOURS = 2; // then queue direct head-to-heads against this many ranks either side
// A BRAND-NEW FILM IS NOT THE SAME AS A HAND-MOVED ONE. A move is a stated opinion about position, so
// bisection only has to confirm it. A new film carries no information at all — Brennan's words: "truely
// unconfident, should have lots of comparisons made" — so it gets a wider confirmation sweep and owes
// more answers before the session will call it settled. Bisection is efficient (~8 questions) but
// efficient is not the goal here; being sure is.
const CONFIRM_NEIGHBOURS_FRESH = 3;
const FRESH_VET_COMPARISONS = 8;
// A film ALREADY on the list can also turn out to be badly placed — "a few weeks later my thoughts on
// them have changed a bit". The signal is an upset WIN spanning this many ranks: beating a film four
// or more slots above you is direct evidence your slot is too low, and one-slot-per-result elo would
// take dozens of sessions to walk you there. So an upset that big drops the WINNER back into placement
// and it gets re-bisected — which is also what pairs a surging title against the top 10.
//
// Only the winner, and never a confident film on a single result. The loser of an upset used to be
// re-placed too, symmetrically, and that was destructive: it threw away an earned rating on one click
// and re-bisected a film that was probably fine, which measured as the MIDDLE of a bootstrapped list
// steadily degrading (157 → 228 inversions over four sessions, worst film 54 ranks out of place).
// The winner inserting itself above the loser is already the correct fix for that pair; the loser only
// needs the one-slot drop the clamp gives it.
const UPSET_RANKS = 4;
// A film this confident is not re-placed on a modest upset — it takes a landslide (below) to reopen a
// slot Brennan has effectively confirmed.
const UPSET_TRUST_GUARD = 0.75;
const UPSET_RANKS_CONFIDENT = 10;

// ── VETTING / CONVERGENCE ────────────────────────────────────────────────────────────────────
// A session no longer has to touch every film. The work set is: films that are new, films Brennan
// moved by hand since the last session, and films that DRIFTED during this session (i.e. a surge
// pulled them out of position, so their new neighbourhood needs re-checking).
const DRIFT_VET = RANK_SPACING * 3;   // three ranks of movement makes a film worth re-vetting
const MIN_VET_COMPARISONS = 4;
// STALENESS AUDIT. A session that only looks at new and hand-moved films never revisits the other
// 110, so an opinion that quietly changed is invisible — measured, a film that should have been #15
// sat at #90 forever. Each session therefore re-asks about a small batch of the longest-unseen films;
// they are not re-placed from scratch, just questioned, and a big upset re-opens their placement on
// its own. Weighted by DEPTH as well as age, because this is the mechanism that keeps running once
// every film has earned full trust and the unproven batch empties: without the depth weighting the
// audit spreads evenly over a list whose top is 99% settled and whose tail is 25-40%, and the tail
// stops improving (measured: it plateaued at ~3.7% of pairs misordered, mean 3.4 ranks out).
const STALE_BATCH = 12;
// UNPROVEN FILMS. Carried history does double duty: it scales the K freeze (see eloK) AND it says
// whether a film has been vetted at all. A bootstrapped list starts with graded confidence — Brennan's
// own numbers were ~99% on the top 10, 85% top 25, 65% top 50, 25-40% on the bottom 50 — so the
// low-confidence end needs real work while the top only needs protecting. The least-confident films
// join the work set, but in BATCHES: ordering 60 films takes ~500 comparisons, and that is three
// sittings, not one. Each session takes the least-confident batch, and their earned history carries
// forward so the next session moves on to the next band up the list.
const UNPROVEN_BATCH = 20;
const STALE_MIN_SESSIONS = 2;      // do not audit something asked about last sitting
const STALE_VET_COMPARISONS = 2;   // an audit is a couple of questions, not a full re-vet
const CHECKPOINT_EVERY = 10;
const SAVE_EVERY = 15;       // autosave ratings this often, so a closed tab loses nothing

// Opponent pool width for refinement pairing. Deliberately TIGHT — near-neighbour questions are the
// only ones that cannot create a spurious hop: a correct result over a film six ranks down still pays
// out more than the gap to the film immediately above, so the winner sails past a title it was never
// asked about. Adjacent-ish pairing keeps refinement from degrading a converged list.
const PROXIMITY_SCALE = RANK_SPACING * 2;
// …but a purely local pairing scheme is BLIND to a stale opinion. Measured: a settled film that
// should now rank #15 crawled from #90 to #87 over three sessions and stopped, because it was only
// ever asked about its immediate neighbours, so it could never produce the upset that would re-open
// its placement. A share of matchups therefore deliberately asks a long-range question — "is this
// really worse than the film twelve slots up?" — which is the only way a surge can surface.
const EXPLORE_RATE = 0.3;
const EXPLORE_MIN_RANKS = 4;
const EXPLORE_MAX_RANKS = 25;
const EXPLORE_UPWARD = 0.7;   // surges are the interesting direction

function expected(a, b) { return 1 / (1 + Math.pow(10, (b - a) / 400)); }
function updateElo(r, o, s, K) { return r + K * (s - expected(r, o)); }
function pairKey(idA, idB) { return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`; }

// ── SELECTION ────────────────────────────────────────────────────────────────────────────────

function weightedPick(list, wfn) {
  let total = 0;
  const ws = list.map(it => { const w = Math.max(0, wfn(it)); total += w; return w; });
  if (!(total > 0)) return list[Math.floor(Math.random() * list.length)];
  let roll = Math.random() * total;
  for (let i = 0; i < list.length; i++) { roll -= ws[i]; if (roll <= 0) return list[i]; }
  return list[list.length - 1];
}

// How badly this film needs attention. This is the "we don't need to show every film" knob: a
// settled top-25 title with carried history and no drift scores near zero and will only ever appear
// as an OPPONENT — which is the point, since a challenger still has to beat it to pass it.
function needScore(it) {
  const n = state.items.length;
  const rank = (it._eloRank || 1) - 1;
  const p = n > 1 ? rank / (n - 1) : 0;
  const seen = state.compared[it.Id] || 0;

  if (state.placing[it.Id]) return 40;                 // mid-bisection: finish the job
  // Films OUTSIDE the work set get a floor weight, not a weight of 1. That floor is the whole
  // "we don't need to see every film any more" behaviour: at 1 they were still winning ~70% of the
  // picks by sheer numbers, and a session that had two things to check was showing 113 of 116 titles.
  let w = state.dirty[it.Id] ? 12 : (state.unproven[it.Id] ? 6 : (state.stale[it.Id] ? 5 : 0.05));
  w *= 0.15 + 1.85 * Math.pow(p, 1.3);                 // bottom of the list is where doubt lives
  w /= (1 + seen);                                     // spread attention within the work set
  if ((state.carried[it.Id] || 0) > 0 && !state.dirty[it.Id]) w *= 0.5;  // has earned history
  const drift = Math.abs(state.ratings[it.Id] - state.startRating[it.Id]);
  if (drift >= DRIFT_VET) w *= 1 + 3 * Math.min(1, drift / 120);         // it moved — re-check it
  else if (seen >= vetTarget(it) && !state.dirty[it.Id]) w *= 0.1;       // vetted and stable
  return w;
}

function pickChallenger() {
  return weightedPick(state.items, needScore);
}

// Proximity pairing for refinement: opponents near in rating, with a penalty for pairs already
// judged this session so we do not re-ask the same question. A share of calls instead asks a
// long-range question (see EXPLORE_RATE) so a badly-placed film can be discovered at all.
function pickOpponent(a) {
  if (Math.random() < EXPLORE_RATE) {
    const far = pickFarOpponent(a);
    if (far) return far;
  }
  const aRating = state.ratings[a.Id];
  const pool = state.items.filter(it => it.Id !== a.Id);
  return weightedPick(pool, it => {
    const dist = Math.abs(state.ratings[it.Id] - aRating);
    let w = 1 / (1 + Math.pow(dist / PROXIMITY_SCALE, 2));
    if (state.pairsCompared.has(pairKey(a.Id, it.Id))) w *= 0.05;
    return w;
  });
}

// A film some distance up (usually) or down the list, skipping pairs already judged.
function pickFarOpponent(a) {
  const ranked = getRanked();
  const at = ranked.findIndex(x => x.Id === a.Id);
  const span = EXPLORE_MAX_RANKS - EXPLORE_MIN_RANKS;
  const d = EXPLORE_MIN_RANKS + Math.floor(Math.random() * (span + 1));
  const dirs = Math.random() < EXPLORE_UPWARD ? [-1, 1] : [1, -1];
  for (const dir of dirs) {
    for (let k = 0; k <= span; k++) {
      const idx = at + dir * (d + k);
      const cand = ranked[idx];
      if (cand && cand.Id !== a.Id && !state.pairsCompared.has(pairKey(a.Id, cand.Id))) return cand;
    }
  }
  return null;
}

// Bisection opponent: the film sitting in the middle of the challenger's remaining RATING band.
//
// The band is tracked in rating space, not rank space, precisely because the challenger's own
// rating jumps around during placement — a band held as "ranks 20 to 40" silently means something
// different after every probe, while "rated between 1387 and 1425" does not.
function bandMembers(a) {
  const b = state.bounds[a.Id];
  if (!b) return [];
  return state.items.filter(it => it.Id !== a.Id && state.ratings[it.Id] > b.lo && state.ratings[it.Id] < b.hi);
}

// The band with FINITE edges. An open side (nothing has bounded it yet) is closed just past the
// most extreme film still inside it, so "the middle of the band" is a real number on the very first
// probe instead of Infinity — which would otherwise make every opening probe pick the #1 film.
function effBand(a) {
  const b = state.bounds[a.Id];
  const rs = bandMembers(a).map(it => state.ratings[it.Id]);
  const here = state.ratings[a.Id];
  if (!rs.length) return { lo: Math.min(here, b.lo === -Infinity ? here : b.lo) - 20, hi: Math.max(here, b.hi === Infinity ? here : b.hi) + 20 };
  return {
    lo: Number.isFinite(b.lo) ? b.lo : Math.min(...rs) - 20,
    hi: Number.isFinite(b.hi) ? b.hi : Math.max(...rs) + 20,
  };
}

function pickProbe(a, seedRank) {
  const b = state.bounds[a.Id];
  if (!b) return null;
  // First probe honours Brennan's own placement: a film he dropped in at #50 is asked about the
  // film at #50 first, so a correct guess is confirmed in one click instead of bisected blindly.
  if (b.probes === 0 && seedRank != null) {
    const ranked = getRanked().filter(it => it.Id !== a.Id);   // …excluding itself: a film seeded at
    // the bottom of the playlist IS the bottom of the ranking, so ranked[seedRank] would be the film
    // we are trying to place and the seed hint would be silently discarded.
    const target = ranked[Math.min(ranked.length - 1, Math.max(0, seedRank))];
    if (target && !state.pairsCompared.has(pairKey(a.Id, target.Id))) return target;
  }
  const eb = effBand(a);
  const mid = (eb.lo + eb.hi) / 2;
  // PROBE AGAINST SETTLED FILMS. A film that is itself mid-placement has a provisional rating (its own
  // band midpoint), so bisecting against it sets a bound off a guess — and with a large batch being
  // placed at once (a bootstrapped list has ~67 of them) most of the list is provisional, so the two
  // would trade meaningless bounds that nothing later corrects. Fall back to a provisional opponent
  // only when the band holds nothing else.
  let best = null, bestD = Infinity, fallback = null, fallbackD = Infinity;
  for (const it of bandMembers(a)) {
    if (state.pairsCompared.has(pairKey(a.Id, it.Id))) continue;
    const d = Math.abs(state.ratings[it.Id] - mid);
    if (state.placing[it.Id]) { if (d < fallbackD) { fallbackD = d; fallback = it; } continue; }
    if (d < bestD) { bestD = d; best = it; }
  }
  return best || fallback;
}

function eloK(item) {
  const n = state.items.length;
  const seen = state.compared[item.Id] || 0;
  const decay = 1 / Math.sqrt(1 + seen / SESSION_DECAY);
  if (state.placing[item.Id]) return BASE_K * PLACEMENT_RANK_FACTOR * decay;
  const rank = (item._eloRank || 1) - 1;
  const p = n > 1 ? rank / (n - 1) : 0;
  const curve = MIN_RANK_FACTOR + (MAX_RANK_FACTOR - MIN_RANK_FACTOR) * Math.pow(p, RANK_GAMMA);
  // THE FREEZE PROTECTS AN EARNED POSITION, NOT A PROVISIONAL ONE. Scaled by how much history the
  // film actually carries: with none (a cold list, no saved ratings) this collapses to plain
  // symmetric elo, because a #2 slot nobody has voted on yet is a guess and freezing it would just
  // lock in the seed order. Fully-vetted titles get the whole curve.
  const trust = Math.min(CARRIED_CAP, state.carried[item.Id] || 0) / CARRIED_CAP;
  const rankFactor = 1 + trust * (curve - 1);
  const progress = Math.min(1, state.matchups / state.hardCapMatchups);
  const globalDecay = 1 - 0.3 * progress;
  return BASE_K * rankFactor * globalDecay * decay;
}

// ── LOADING + RECONCILIATION WITH THE SAVED RATINGS ──────────────────────────────────────────

// Longest increasing subsequence of `seq` (returns the indices kept). Used to find the MINIMAL set
// of films Brennan moved by hand: dragging one title from #80 to #20 shifts the relative position
// of 60 others, so a naive "position changed" test would flag 61 films as manually moved. The
// items NOT on the longest increasing run are the ones that actually moved.
function lisIndices(seq) {
  const n = seq.length;
  if (!n) return [];
  const tails = [], tailIdx = [], prev = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tails[m] < seq[i]) lo = m + 1; else hi = m; }
    tails[lo] = seq[i];
    tailIdx[lo] = i;
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
    }
  const out = [];
  for (let i = tailIdx[tails.length - 1]; i >= 0; i = prev[i]) out.push(i);
  return out.reverse();
}

// Seed a film with no trustworthy rating from where it sits in the PLAYLIST — the playlist is the
// source of truth for position, so a title Brennan dropped in at #50 starts life between its new
// neighbours rather than at 1500 or at the bottom. Interpolates by index so a run of several
// unseeded films in a row still comes out in playlist order and distinct.
function seedRating(items, i, anchored) {
  let lo = -1, hi = -1;
  for (let j = i - 1; j >= 0; j--) if (anchored[j] != null) { lo = j; break; }
  for (let j = i + 1; j < items.length; j++) if (anchored[j] != null) { hi = j; break; }
  if (lo >= 0 && hi >= 0) {
    const t = (i - lo) / (hi - lo);
    return anchored[lo] + t * (anchored[hi] - anchored[lo]);
  }
  if (lo >= 0) return anchored[lo] - RANK_SPACING * (i - lo);
  if (hi >= 0) return anchored[hi] + RANK_SPACING * (hi - i);
  return 1500 - i * RANK_SPACING;
}

function reconcile(items, saved) {
  const savedRatings = saved.ratings || {};
  const session = (saved.sessions || 0) + 1;
  const curKeys = items.map(it => it._eloKey);
  const curSet = new Set(curKeys);

  // The playlist order as of the last save, restricted to what is still in the playlist.
  const seen = (saved.seenOrder || []).filter((k, i, arr) => curSet.has(k) && arr.indexOf(k) === i);
  const seenPos = new Map(seen.map((k, i) => [k, i]));

  // Films present in both, in CURRENT playlist order, mapped to their previous position. A film
  // whose previous position is not on the longest increasing run moved by hand.
  const commonIdx = [];
  curKeys.forEach((k, i) => { if (seenPos.has(k) && savedRatings[k]) commonIdx.push(i); });
  const keptSet = new Set(lisIndices(commonIdx.map(i => seenPos.get(curKeys[i]))).map(j => commonIdx[j]));

  const carried = {}, dirty = {}, anchored = new Array(items.length).fill(null);
  const info = { carried: 0, moved: 0, fresh: 0, orphans: 0, cold: false };
  for (const k of Object.keys(savedRatings)) if (!curSet.has(k)) info.orphans++;

  // Pass 1: anchors — films whose saved rating we still trust.
  items.forEach((it, i) => {
    if (keptSet.has(i)) {
      anchored[i] = savedRatings[it._eloKey].rating;
      carried[it.Id] = savedRatings[it._eloKey].comparisons || 0;
      info.carried++;
    }
  });
  if (info.carried === 0) info.cold = true;

  // Pass 2: everything else is seeded from its playlist neighbourhood and marked for vetting —
  // both the brand-new titles and the ones Brennan re-positioned by hand. A manual move is a
  // statement about position, not about elo, so its stale rating is DISCARDED (that is the
  // invalidation): the film re-enters placement and re-earns a number from its new slot.
  const ratings = {}, startRating = {}, bounds = {}, placing = {}, fresh = {};
  items.forEach((it, i) => {
    if (anchored[i] != null) { ratings[it.Id] = anchored[i]; return; }
    ratings[it.Id] = seedRating(items, i, anchored);
    carried[it.Id] = 0;
    if (!info.cold) {
      dirty[it.Id] = true;
      const known = savedRatings[it._eloKey];
      if (known) { info.moved++; } else { info.fresh++; fresh[it.Id] = true; }
      placing[it.Id] = true;
      bounds[it.Id] = { lo: -Infinity, hi: Infinity, probes: 0, seedRank: i };
    }
  });
  // A cold list (no saved file, or nothing survived) behaves like the original tuner: everything
  // is in the work set, nothing is frozen.
  if (info.cold) items.forEach(it => { dirty[it.Id] = true; });
  items.forEach(it => { startRating[it.Id] = ratings[it.Id]; });

  // The unproven batch: the LEAST-CONFIDENT films, lowest carried history first, ties broken by rank so
  // the work starts at the bottom of the list.
  //
  // Deliberately relative, not a fixed threshold. With a hard cutoff the middle of a bootstrapped list
  // (65% confident, carried 8) sat just above it and was never worked at all — measured, its 157
  // inversions were still there four sessions later. Taking the lowest N instead makes the work march
  // steadily up the list: the bottom earns history first, and once it has, the next-least-confident
  // band becomes the batch. Films at full trust are excluded, so this does empty out.
  const unproven = {};
  if (!info.cold) {
    const cand = items
      .map((it, i) => ({ it, i, c: carried[it.Id] || 0 }))
      .filter(x => !dirty[x.it.Id] && x.c < CARRIED_CAP)
      .sort((a, b) => (a.c - b.c) || (b.i - a.i))
      .slice(0, UNPROVEN_BATCH);
    for (const x of cand) unproven[x.it.Id] = true;
    info.unproven = cand.length;
  }

  // The staleness audit batch: the longest-unseen anchored films. Skipped on a cold list (everything
  // is being vetted anyway) and skipped for films already in the work set.
  const stale = {};
  if (!info.cold) {
    const n = items.length;
    const cand = items
      .map((it, i) => ({ it, i, age: session - ((savedRatings[it._eloKey] || {}).lastSeen || 0) }))
      .filter(x => !dirty[x.it.Id] && !unproven[x.it.Id] && x.age >= STALE_MIN_SESSIONS)
      .map(x => ({ ...x, score: x.age * (0.6 + 1.0 * (n > 1 ? x.i / (n - 1) : 0)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, STALE_BATCH);
    for (const x of cand) stale[x.it.Id] = true;
    info.stale = cand.length;
  }

  return { ratings, carried, dirty, startRating, bounds, placing, fresh, unproven, stale, session, info };
}

async function init() {
  show('loading');
  try {
    const [r, rr] = await Promise.all([
      fetch(`${API}/top100`, { headers: { Accept: 'application/json' } }),
      fetch(`${API}/ratings`, { headers: { Accept: 'application/json' } }).catch(() => null),
    ]);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    let saved = { ts: 0, seenOrder: [], ratings: {} };
    if (rr && rr.ok) { try { saved = await rr.json(); } catch { /* cold start */ } }

    const rec = reconcile(data.items, saved);
    const vetCount = data.items.filter(it => rec.dirty[it.Id] || rec.unproven[it.Id] || rec.stale[it.Id]).length;
    state = {
      playlistId: data.playlistId,
      items: data.items,
      origOrder: data.items.map(i => i.Id),
      origKeys: data.items.map(i => i._eloKey),
      ratings: rec.ratings,
      carried: rec.carried,
      dirty: rec.dirty,
      startRating: rec.startRating,
      bounds: rec.bounds,
      placing: rec.placing,
      fresh: rec.fresh,
      unproven: rec.unproven,
      stale: rec.stale,
      session: rec.session,
      loadInfo: rec.info,
      savedLastSeen: Object.fromEntries(Object.entries(saved.ratings || {}).map(([k, v]) => [k, (v && v.lastSeen) || 0])),
      matchups: 0,
      lastSaveAt: 0,
      // The budget scales with the WORK SET, not the list: a session that only has to place three
      // new films is over in a couple of dozen matchups, not 290. This is a CEILING, not a target —
      // a session normally ends when the work set is settled, well before it.
      // 12 matchups per film to place (bisection is ~7 plus confirmations), 4 per staleness spot-check,
      // and a floor so a session is never pointlessly short. A ceiling, not a target.
      hardCapMatchups: Math.min(Math.round(data.items.length * 5),
        20 + 16 * data.items.filter(it => rec.fresh[it.Id]).length
           + 12 * data.items.filter(it => rec.dirty[it.Id] && !rec.fresh[it.Id]).length
           + 8 * data.items.filter(it => rec.unproven[it.Id]).length
           + 4 * data.items.filter(it => rec.stale[it.Id]).length),
      converged: false,
      compared: {},
      pairsCompared: new Set(),
      beat: {},
      lost: {},
      priorityQueue: [],
      history: [],
      ooHistory: [],
      lastOrder: null,
    };
    updateRanks();
    state.lastOrder = getRanked().map(it => it.Id);
    console.log(`[tuner] init: ${data.items.length} items · carried=${rec.info.carried} moved=${rec.info.moved} new=${rec.info.fresh} orphans=${rec.info.orphans} unproven=${rec.info.unproven || 0} stale=${rec.info.stale || 0} cold=${rec.info.cold} session=${rec.session} vetSet=${vetCount} hardCap=${state.hardCapMatchups}`);
    next();
  } catch (e) {
    const msg = e?.message || String(e) || 'unknown error (check console)';
    const em = $('#error-msg');
    if (em) em.textContent = msg;
    show('error');
  }
}

function show(id) {
  for (const s of ['compare', 'review', 'loading', 'error']) {
    const el = document.getElementById(s);
    if (el) el.hidden = s !== id;
  }
  const lbl = $('#phase-label');
  if (lbl) {
    if (id === 'compare') lbl.textContent = 'Comparing';
    else if (id === 'review') lbl.textContent = 'Review';
    else if (id === 'loading') lbl.textContent = 'Loading…';
    else lbl.textContent = 'Error';
  }
}

function getRanked() {
  return [...state.items].sort((a, b) => state.ratings[b.Id] - state.ratings[a.Id]);
}

function updateRanks() {
  getRanked().forEach((it, i) => { it._eloRank = i + 1; });
}

// How many comparisons this film owes before the session will call it settled. A staleness audit is
// cheaper than placing a newcomer: a couple of questions is enough to confirm nothing has changed.
function vetTarget(it) {
  if (state.fresh[it.Id]) return FRESH_VET_COMPARISONS;
  if (state.dirty[it.Id] || state.placing[it.Id] || state.unproven[it.Id]) return MIN_VET_COMPARISONS;
  return STALE_VET_COMPARISONS;
}

function vetSet() {
  return state.items.filter(it =>
    state.dirty[it.Id] ||
    state.placing[it.Id] ||
    state.unproven[it.Id] ||
    state.stale[it.Id] ||
    Math.abs(state.ratings[it.Id] - state.startRating[it.Id]) >= DRIFT_VET);
}

function estimateRemaining() {
  let need = state.priorityQueue.length;
  for (const it of vetSet()) {
    const seen = state.compared[it.Id] || 0;
    need += Math.max(0, vetTarget(it) - seen);
    if (state.placing[it.Id]) {
      const band = Math.max(1, bandMembers(it).length);
      need += Math.max(1, Math.ceil(Math.log2(band + 1)));
    }
  }
  // Two films per matchup, so the work above is roughly halved in practice.
  return Math.max(1, Math.min(Math.ceil(need / 1.6), state.hardCapMatchups - state.matchups));
}

function next() {
  resolving = false;
  updateRanks();
  if (state.converged) { goReview(); return; }

  const n = state.items.length;
  if (n < 2) { goReview(); return; }
  show('compare');

  let a, b;
  const itemById = id => state.items.find(it => it.Id === id);
  let queued;
  while (state.priorityQueue.length && !queued) {
    const [idA, idB] = state.priorityQueue.shift();
    // The pair may have already been settled by an earlier direct comparison
    // (e.g. queued twice, or resolved via the back button) — skip stale entries.
    if (!state.pairsCompared.has(pairKey(idA, idB)) && itemById(idA) && itemById(idB)) queued = [idA, idB];
  }
  if (queued) {
    a = itemById(queued[0]);
    b = itemById(queued[1]);
  } else {
    a = pickChallenger();
    if (state.placing[a.Id]) {
      b = pickProbe(a, state.bounds[a.Id] && state.bounds[a.Id].seedRank);
      if (!b) { finishPlacement(a); b = pickOpponent(a); }
    } else {
      b = pickOpponent(a);
    }
  }

  state.matchups++;
  const est = estimateRemaining();
  const pct = Math.min(100, Math.round((state.matchups / (state.matchups + est)) * 100));

  const left = Math.random() < 0.5 ? a : b;
  const right = left === a ? b : a;

  renderSide('a', left);
  renderSide('b', right);

  $('#prog-text').textContent = `Matchup ${state.matchups} · ~${est} left`;
  $('#progress-bar').style.width = pct + '%';

  $('#opt-a').onclick = () => resolve(left, right, left, right);
  $('#opt-b').onclick = () => resolve(left, right, right, left);
  updateBackBtn();
}

// DELIBERATELY BLIND. Title, year, genre, poster — nothing else. No current rank, no "locked in", no
// hint about why this pair came up: knowing a film is #3 is exactly the anchor that stops the answer
// from being about the two films.
function renderSide(side, it) {
  $(`#title-${side}`).textContent = it.Name;
  $(`#meta-${side}`).textContent = [it.ProductionYear, it.Genres?.[0]].filter(Boolean).join(' · ');
  setPoster(`poster-${side}`, it.Id, it);
}

let resolving = false;

// Placement bookkeeping. A probe result is a bound on where the film belongs, and the film's
// rating is then SET to the middle of the surviving band rather than nudged by an elo delta.
//
// That is the whole reason placement is a separate mode: elo deltas cannot carry a film across the
// list. Beating a title rated 500 points below you is already expected, so it pays out ~0 points —
// a masterpiece dumped at the bottom of the playlist would win eight matchups in a row and still
// sit at #93. Binary insertion moves it to where the answers say it belongs; elo then refines from
// there, under the normal rank-dependent K.
function bandMidRating(a) {
  const eb = effBand(a);
  return (eb.lo + eb.hi) / 2;
}

function narrowBand(challenger, opponentRating, won) {
  const b = state.bounds[challenger.Id];
  if (!b) return;
  b.probes++;
  if (won) b.lo = Math.max(b.lo, opponentRating);   // rated above the film it just beat
  else b.hi = Math.min(b.hi, opponentRating);       // rated below the film that beat it
  if (b.hi <= b.lo) b.hi = b.lo + 1;                // an intransitive answer pair — collapse, do not invert
  state.ratings[challenger.Id] = bandMidRating(challenger);
  if (bandMembers(challenger).length <= PLACE_BAND || b.probes >= PLACE_MAX) finishPlacement(challenger);
}

// Re-open placement for a film already on the list. Bounds start open and this very result narrows
// them (see narrowBand, called straight after) — the film's earned rating is discarded on purpose,
// because the upset says that rating is what is wrong.
function enterPlacement(it) {
  state.placing[it.Id] = true;
  state.dirty[it.Id] = true;      // stays in the work set until it is settled again
  state.bounds[it.Id] = { lo: -Infinity, hi: Infinity, probes: 0, seedRank: null };
}

// Leaving placement mode: the film now has a slot, but it reached it partly by inference (it never
// faced most of the list). Queue direct head-to-heads against the neighbours it landed between
// before trusting the slot — this is what pairs a surging title against the top 10.
function finishPlacement(it) {
  if (!state.placing[it.Id]) return;
  delete state.placing[it.Id];
  updateRanks();
  const ranked = getRanked();
  const at = ranked.findIndex(x => x.Id === it.Id);
  const reach = state.fresh[it.Id] ? CONFIRM_NEIGHBOURS_FRESH : CONFIRM_NEIGHBOURS;
  for (let d = 1; d <= reach; d++) {
    for (const idx of [at - d, at + d]) {
      const nb = ranked[idx];
      if (nb && nb.Id !== it.Id && !state.pairsCompared.has(pairKey(it.Id, nb.Id))) {
        state.priorityQueue.push([it.Id, nb.Id]);
      }
    }
  }
}

// NO HOPPING WITHOUT EVIDENCE. A rating gain is a claim about films the winner never faced: the gaps
// between adjacent films are uneven, so even a CORRECT adjacent win (#93 beats #94, confirming the
// order) can pay out more than the gap up to #92 and sail the winner past a film it was never asked
// about. Measured on a converged list, that leak added several inversions per 20-matchup refinement
// pass — the list quietly getting worse while every single answer was right.
//
// Two bounds, both from real answers only:
//   • a film is held below anything it has LOST to and above anything it has BEATEN this session;
//   • it may pass at most up to the nearest film it has NOT beaten (and fall at most to the nearest
//     it has not lost to) — one slot per result, unless it actually beat the titles it is passing.
// Transitive inference still moves films, it just cannot leapfrog a question nobody answered. Big
// legitimate jumps are placement's job (bisection), not elo's.
function clampToEvidence(it, rankedBefore) {
  const beat = state.beat[it.Id] || new Set();
  const lost = state.lost[it.Id] || new Set();
  let hi = Infinity, lo = -Infinity;
  // A film still being placed has a provisional rating (the midpoint of a wide band), so it is not
  // a usable bound for anyone else yet.
  for (const id of lost) if (!state.placing[id]) hi = Math.min(hi, state.ratings[id] - 1);
  for (const id of beat) if (!state.placing[id]) lo = Math.max(lo, state.ratings[id] + 1);

  const at = rankedBefore.findIndex(x => x.Id === it.Id);
  for (let j = at - 1; j >= 0; j--) {
    const o = rankedBefore[j];
    if (state.placing[o.Id] || beat.has(o.Id)) continue;
    hi = Math.min(hi, state.ratings[o.Id] - 1);
    break;
  }
  for (let j = at + 1; j < rankedBefore.length; j++) {
    const o = rankedBefore[j];
    if (state.placing[o.Id] || lost.has(o.Id)) continue;
    lo = Math.max(lo, state.ratings[o.Id] + 1);
    break;
  }

  // Contradictory answers (a preference cycle) can invert the two bounds; the newest result wins by
  // sitting between them rather than obeying an impossible constraint.
  if (lo > hi) { const mid = (lo + hi) / 2; lo = hi = mid; }
  state.ratings[it.Id] = Math.min(hi, Math.max(lo, state.ratings[it.Id]));
}

function resolve(left, right, winner, loser) {
  if (resolving) return;
  resolving = true;

  state.history.push({
    left, right,
    leftRating: state.ratings[left.Id],
    rightRating: state.ratings[right.Id],
    matchups: state.matchups,
    compared: { ...state.compared },
    pairsCompared: new Set(state.pairsCompared),
    beat: Object.fromEntries(Object.entries(state.beat).map(([k, v]) => [k, new Set(v)])),
    lost: Object.fromEntries(Object.entries(state.lost).map(([k, v]) => [k, new Set(v)])),
    priorityQueue: [...state.priorityQueue],
    ooHistory: [...state.ooHistory],
    lastOrder: [...state.lastOrder],
    placing: { ...state.placing },
    // Manual clone, not JSON round-trip: the initial band edges are ±Infinity, which JSON turns into null.
    bounds: Object.fromEntries(Object.entries(state.bounds).map(([k, v]) => [k, { ...v }])),
    dirty: { ...state.dirty },
  });

  const rW = state.ratings[winner.Id], rL = state.ratings[loser.Id];
  const rankedBefore = getRanked();
  const wAt = rankedBefore.findIndex(x => x.Id === winner.Id);
  const lAt = rankedBefore.findIndex(x => x.Id === loser.Id);
  // Big upset → re-place rather than nudge. Checked BEFORE the elo/band split below so the result is
  // consumed as the first bound of the new search instead of as a rating nudge.
  const wTrust = Math.min(CARRIED_CAP, state.carried[winner.Id] || 0) / CARRIED_CAP;
  const needed = wTrust >= UPSET_TRUST_GUARD ? UPSET_RANKS_CONFIDENT : UPSET_RANKS;
  if (!state.placing[winner.Id] && wAt > lAt + needed) enterPlacement(winner);
  // A PLACEMENT PROBE MOVES ONLY THE FILM BEING PLACED. The question "is this new film better than
  // your current #58?" is evidence about the newcomer's slot, not about whether #58 still belongs
  // above #59 — and treating it as both was destructive: each of the ~8 bisection probes handed its
  // opponent a large upset loss (the newcomer starts far away in rating, so every result reads as a
  // shock), which measured as ~50 fresh inversions in the tail from placing ONE film. The newcomer's
  // rating comes from its band instead; see narrowBand().
  if (!state.placing[winner.Id] && !state.placing[loser.Id]) {
    // ASYMMETRIC ON PURPOSE. The winner's and loser's K come from their own ranks, so a challenger
    // from #90 beating #4 gains more than #4 gives ground — the challenger still has to keep winning
    // to actually take the slot, which is what "hard to move at the top" means.
    state.ratings[winner.Id] = updateElo(rW, rL, 1, eloK(winner));
    state.ratings[loser.Id] = updateElo(rL, rW, 0, eloK(loser));
  }

  state.compared[winner.Id] = (state.compared[winner.Id] || 0) + 1;
  state.compared[loser.Id] = (state.compared[loser.Id] || 0) + 1;
  state.pairsCompared.add(pairKey(winner.Id, loser.Id));
  (state.beat[winner.Id] = state.beat[winner.Id] || new Set()).add(loser.Id);
  (state.lost[loser.Id] = state.lost[loser.Id] || new Set()).add(winner.Id);

  // Bounds come from the PRE-update ratings — the opponent's rating as it was when the question
  // was asked is the bound the answer establishes.
  const wasPlacement = !!(state.placing[winner.Id] || state.placing[loser.Id]);
  if (state.placing[winner.Id]) narrowBand(winner, rL, true);
  if (state.placing[loser.Id]) narrowBand(loser, rW, false);
  // Same rule as the elo update: a placement probe does not move the established film, and that
  // includes not clamping it. Clamping it against a film whose rating is still provisional is how
  // Film 059 once got pinned BELOW the bottom of the list by a single probe.
  if (!wasPlacement) { clampToEvidence(winner, rankedBefore); clampToEvidence(loser, rankedBefore); }

  if (state.matchups % SAVE_EVERY === 0) saveRatings();

  if (state.matchups % CHECKPOINT_EVERY === 0 && state.matchups >= CHECKPOINT_EVERY * 2) checkpoint();
  next();
}

function checkpoint() {
  updateRanks();
  const s2 = getRanked();
  const currentOrder = s2.map(it => it.Id);
  const prevPos = new Map(state.lastOrder.map((id, i) => [id, i]));
  // Tolerate drift instead of requiring exact position match: intransitive preference cycles
  // (A beats B, B beats C, C beats A) have no stable order and will rotate a few items around each
  // other forever under a strict equality test. Tolerance widens further down the list — the top of
  // the ranking matters most and should settle tightly, while lower-ranked ties are less important
  // to pin down exactly.
  const MIN_DRIFT_TOLERANCE = 1;
  const MAX_DRIFT_TOLERANCE = 8;
  const n = currentOrder.length;

  // Convergence is judged over the WORK SET only. Films outside it were deliberately not shown, so
  // asking whether they are "settled" would mean waiting forever for evidence we never collect.
  const work = vetSet();
  const workIds = new Set(work.map(it => it.Id));

  // Positions can shift purely by transitive inference (A>B and B>C implies a guessed A>C, without
  // A and C ever actually being paired). Before calling those swaps real, queue a direct head-to-head
  // for any adjacent pair whose relative order flipped since the last checkpoint but that has never
  // been directly compared.
  //
  // SCOPED TO THE WORK SET. Unscoped, this scan re-opens the whole list every checkpoint: two
  // settled films 60 ranks down trade places by a rounding-level rating change, that flip is queued,
  // the queue never empties, and a session that only had to place one new film runs to its hard cap
  // asking about films Brennan did not want to see again.
  for (let i = 0; i < n - 1; i++) {
    const idA = currentOrder[i], idB = currentOrder[i + 1];
    if (!workIds.has(idA) && !workIds.has(idB)) continue;
    const prevA = prevPos.get(idA), prevB = prevPos.get(idB);
    const flipped = prevA != null && prevB != null && prevA > prevB;
    if (flipped && !state.pairsCompared.has(pairKey(idA, idB))) state.priorityQueue.push([idA, idB]);
  }
  let ready = 0;
  for (const it of work) {
    const i = (it._eloRank || 1) - 1;
    const prev = prevPos.get(it.Id);
    const tolerance = MIN_DRIFT_TOLERANCE + (MAX_DRIFT_TOLERANCE - MIN_DRIFT_TOLERANCE) * (n > 1 ? i / (n - 1) : 0);
    const enough = (state.compared[it.Id] || 0) >= vetTarget(it);
    const stable = prev != null && Math.abs(prev - i) <= tolerance;
    if (enough && stable && !state.placing[it.Id]) ready++;
  }

  state.lastOrder = currentOrder;
  state.ooHistory.push({ matchups: state.matchups, ready, work: work.length });

  const est = estimateRemaining();
  console.log(`[tuner] check #${state.ooHistory.length}: matchup=${state.matchups} ready=${ready}/${work.length} queue=${state.priorityQueue.length} est=${est} hardCap=${state.hardCapMatchups}`);

  const done = ready >= work.length && state.priorityQueue.length === 0;
  if (done || state.matchups >= state.hardCapMatchups) {
    state.converged = true;
    console.log(`[tuner] CONVERGED at matchup ${state.matchups}${done ? '' : ' (hard cap)'}`);
  }
}

// ── PERSISTENCE ──────────────────────────────────────────────────────────────────────────────

// `seenOrder` is the playlist order we believe is live. Mid-session that is the order we LOADED
// (the playlist has not been touched); after a successful reorder it is the order we just wrote.
// Next session diffs it against the real playlist order — anything that moved without us is a
// manual edit, and that is what invalidates a saved rating.
async function saveRatings(seenOrder) {
  const ratings = {};
  for (const it of state.items) {
    ratings[it._eloKey] = {
      rating: state.ratings[it.Id],
      comparisons: (state.carried[it.Id] || 0) + (state.compared[it.Id] || 0),
      // Only films actually asked about this session count as seen — otherwise the audit batch would
      // reset the clock for all 116 every sitting and nothing would ever look stale.
      lastSeen: (state.compared[it.Id] || 0) > 0 ? state.session : ((state.savedLastSeen[it._eloKey] || 0)),
      name: it.Name,
      year: it.ProductionYear || null,
    };
  }
  try {
    const r = await fetch(`${API}/ratings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ratings, seenOrder: seenOrder || state.origKeys, sessions: state.session }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.lastSaveAt = state.matchups;
    console.log(`[tuner] ratings saved at matchup ${state.matchups}`);
    return true;
  } catch (e) {
    // A failed autosave is not worth interrupting a tuning session for — the ranking itself is
    // still correct in this tab, and Accept re-saves.
    console.log(`[tuner] rating save failed: ${e.message || e}`);
    return false;
  }
}

function goReview() {
  const ac = $('#review-accept');
  if (ac) { ac.hidden = false; ac.disabled = false; }
  $('#review-done').hidden = true;
  $('#review-loading').hidden = true;
  show('review');
  updateRanks();
  if (state.lastSaveAt !== state.matchups) saveRatings();
  const sorted = getRanked();
  const origByPos = {};
  state.origOrder.forEach((id, i) => { origByPos[id] = i + 1; });

  $('#review-list').innerHTML = sorted.map((it, i) => {
    const oldRank = origByPos[it.Id] || it._eloRank;
    const diff = oldRank - (i + 1);
    let ch;
    if (diff > 0) ch = `<span class="rl-change up">↑${diff}</span>`;
    else if (diff < 0) ch = `<span class="rl-change down">↓${Math.abs(diff)}</span>`;
    else ch = `<span class="rl-change same">—</span>`;
    return `<li><span class="rl-title">${esc(it.Name)}</span><span class="rl-meta">${it.ProductionYear || ''} · ${Math.round(state.ratings[it.Id])} elo</span>${ch}</li>`;
  }).join('');
}

// ---- Back button ----

function updateBackBtn() {
  const btn = $('#back-btn');
  if (btn) btn.hidden = !state.history.length;
}

function goBack() {
  if (!state.history.length) return;
  resolving = false;
  const e = state.history.pop();
  state.ratings[e.left.Id] = e.leftRating;
  state.ratings[e.right.Id] = e.rightRating;
  state.matchups = e.matchups;
  state.compared = e.compared;
  state.pairsCompared = e.pairsCompared;
  state.beat = e.beat;
  state.lost = e.lost;
  state.priorityQueue = e.priorityQueue;
  state.ooHistory = e.ooHistory;
  state.lastOrder = e.lastOrder;
  state.placing = e.placing;
  state.bounds = e.bounds;
  state.dirty = e.dirty;
  state.converged = false;

  updateRanks();
  show('compare');
  renderSide('a', e.left);
  renderSide('b', e.right);

  const est2 = estimateRemaining();
  const pct2 = Math.min(100, Math.round((state.matchups / (state.matchups + est2)) * 100));
  $('#prog-text').textContent = `Matchup ${state.matchups} · ~${est2} left`;
  $('#progress-bar').style.width = pct2 + '%';

  $('#opt-a').onclick = () => resolve(e.left, e.right, e.left, e.right);
  $('#opt-b').onclick = () => resolve(e.left, e.right, e.right, e.left);
  updateBackBtn();
}

// ---- Wire all click handlers ----

$('#review-accept').onclick = async function () {
  this.disabled = true;
  $('#review-loading').hidden = false;
  try {
    const sorted = getRanked();
    const r = await fetch(`${API}/top100/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playlistId: state.playlistId, itemIds: sorted.map(it => it.Id) }),
    });
    // The reorder route now REFUSES rather than writing a partial list (see
    // controller/lib/top100-write.js). A 409 means nothing was changed — usually this tab went stale
    // because a file swap re-minted Jellyfin's item ids, or a library scan is in flight. Surface the
    // server's own wording: it says whether to reload or just wait, and "HTTP 409" says neither.
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const b = await r.json(); if (b && b.error) msg = b.error; } catch (_) { /* keep the status */ }
      throw new Error(msg);
    }
    // Record the order we just wrote as the order we expect to find next time. Without this the
    // next session would read its own reorder as ~100 manual moves and throw away every rating.
    await saveRatings(sorted.map(it => it._eloKey));
    $('#review-loading').hidden = true;
    $('#review-done').hidden = false;
    this.hidden = true;
  } catch (e) {
    $('#review-loading').hidden = true;
    this.disabled = false;
    const em = $('#error-msg');
    if (em) em.textContent = e.message;
    show('error');
  }
};

$('#review-continue').onclick = () => {
  $('#review-done').hidden = true;
  const ac = $('#review-accept');
  if (ac) { ac.hidden = false; ac.disabled = false; }
  init();
};

$('#review-reject').onclick = init;

$('#review-export').onclick = () => {
  const sorted = getRanked();
  const blob = new Blob([JSON.stringify(sorted.map((it, i) => ({ rank: i + 1, title: it.Name, year: it.ProductionYear, rating: state.ratings[it.Id], id: it.Id, key: it._eloKey })), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'top100-proposed.json'; a.click();
  URL.revokeObjectURL(url);
};

$('#error-retry').onclick = init;
$('#back-btn').onclick = goBack;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function setPoster(id, itemId, item) {
  const img = $(`#${id}`);
  if (item.ImageTags?.Primary) {
    img.src = `/jf-img/Items/${itemId}/Images/Primary?maxWidth=300&quality=90`;
    img.onerror = () => { img.src = placeholderSvg(item); };
  } else {
    img.src = placeholderSvg(item);
  }
}

function placeholderSvg(item) {
  return 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300" fill="%231d2230"><rect width="200" height="300"/><text x="100" y="150" text-anchor="middle" fill="%238b93a7" font-size="14" font-family="sans-serif">${esc(item.Name?.charAt(0) || '?')}</text></svg>`
  );
}

init();
