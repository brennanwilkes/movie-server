'use strict';
// Where a restored Top 100 title lands. This is the only calculation in the guard that can DESTROY
// data: the playlist rewrite is clear-then-re-add (Jellyfin's MoveItem is broken under API-key auth),
// so an id this function drops is a permanently lost entry in the one piece of non-regenerable state
// on the box. Weighted accordingly — most of these are "must not lose / must not duplicate / must
// not promote", not "lands in the prettiest spot".
const { planOrder, parseSnapshot, mergedSnapshots } = require('../controller/lib/top100-guard');

let pass = 0; let fail = 0;
const ok = (c, why) => { if (c) pass++; else { fail++; console.log(`FAIL  ${why}`); } };
const eq = (got, want, why) => ok(JSON.stringify(got) === JSON.stringify(want), `${why}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);

// Shorthand: live playlist of keys a,b,c… with id "IDa" etc.
const live = (...ks) => ks.map((k) => ({ id: `ID${k}`, k }));
const want = (...ks) => ks.map((k) => ({ k }));
const keys = (out) => out.map((o) => o.k).join('');

// ---- the core case: a swapped-out title comes home next to its old neighbour --------------------
{
  // Record said a,b,c,d. 'c' was orphaned by a swap and now has a NEW id.
  const out = planOrder(live('a', 'b', 'd'), want('a', 'b', 'c', 'd'), [{ k: 'c', newId: 'NEWc' }]);
  eq(keys(out), 'abcd', 'restored title lands after its recorded predecessor');
  eq(out[2].id, 'NEWc', 'restored title is written with its NEW id, not the dead one');
}

// ---- live order is SACRED: the Elo tuner owns it and may have reshuffled everything --------------
{
  // Record a,b,c,d but the tuner has since reordered the survivors to d,a,b. 'c' followed 'b'.
  const out = planOrder(live('d', 'a', 'b'), want('a', 'b', 'c', 'd'), [{ k: 'c', newId: 'NEWc' }]);
  eq(keys(out), 'dabc', 'survivors keep their CURRENT order; returnee follows its recorded neighbour');
}

// ---- nothing to restore is a no-op ---------------------------------------------------------------
eq(keys(planOrder(live('a', 'b', 'c'), want('a', 'b', 'c'), [])), 'abc', 'empty restore changes nothing');
eq(keys(planOrder(live('c', 'a', 'b'), want('a', 'b', 'c'), [])), 'cab', 'empty restore does not "fix" order');

// ---- NEVER lose or duplicate an id ---------------------------------------------------------------
{
  const out = planOrder(live('a', 'b', 'c', 'd', 'e'), want('a', 'b', 'x', 'c', 'y', 'd', 'e'),
    [{ k: 'x', newId: 'NEWx' }, { k: 'y', newId: 'NEWy' }]);
  eq(keys(out), 'abxcyde', 'two returnees each land at their own anchor');
  ok(out.length === 7, `no id lost: length ${out.length}, want 7`);
  ok(new Set(out.map((o) => o.id)).size === 7, 'no id duplicated');
}

// ---- restore order must follow the RECORD, not the caller's array order --------------------------
{
  // x and y were adjacent (…a, x, y, b…). Hand them over backwards; they must still come back x,y.
  const out = planOrder(live('a', 'b'), want('a', 'x', 'y', 'b'), [{ k: 'y', newId: 'NEWy' }, { k: 'x', newId: 'NEWx' }]);
  eq(keys(out), 'axyb', 'adjacent returnees come back in recorded sequence regardless of input order');
}

// ---- the #1 slot: a title whose predecessors are ALL gone belongs at the front --------------------
{
  const out = planOrder(live('b', 'c'), want('a', 'b', 'c'), [{ k: 'a', newId: 'NEWa' }]);
  eq(keys(out), 'abc', 'rank-1 title with no surviving predecessor goes to the front');
}
{
  // Casablanca's real case: it was #1 in the 07-27 snapshot and the live list now starts at #2.
  const out = planOrder(live('apocalypse', 'raiders'), want('casablanca', 'apocalypse', 'raiders'),
    [{ k: 'casablanca', newId: 'NEW' }]);
  eq(keys(out), 'casablancaapocalypseraiders', 'Casablanca returns to #1, not the tail');
}

// ---- but an UNKNOWN title must never be promoted into the top ranks ------------------------------
// A title absent from the record has no anchor. Appending is the conservative answer: a hand-ranked
// list is damaged far more by a stranger appearing at #1 than at #101.
{
  const out = planOrder(live('a', 'b', 'c'), want('a', 'b', 'c'), [{ k: 'zz', newId: 'NEWz' }]);
  eq(keys(out), 'abczz', 'a title with no recorded position is APPENDED, never promoted to the front');
}

// ---- degenerate inputs must not throw or corrupt --------------------------------------------------
eq(keys(planOrder([], want('a'), [{ k: 'a', newId: 'NEWa' }])), 'a', 'restore into an empty live list works');
eq(keys(planOrder(live('a'), [], [{ k: 'b', newId: 'NEWb' }])), 'ab', 'empty record → append');
eq(keys(planOrder(live('a', 'b'), want('a', 'b'), [])), 'ab', 'no restore, no record change');
{
  // Live entries with no provider id at all (nothing to key on) are dropped from the rewrite rather
  // than written back with an undefined key — but this is a REAL loss, so assert it deliberately.
  const out = planOrder([{ id: 'ID1', k: 'a' }, { id: 'ID2', k: null }], want('a'), []);
  eq(keys(out), 'a', 'an item with no provider id is excluded (documented loss, not silent corruption)');
}

// ---- snapshot parsing ------------------------------------------------------------------------------
{
  const txt = [
    '# Jellyfin "Top 100" playlist — ordered snapshot',
    '# count: 2',
    '#',
    '  1\tCasablanca (1943)\ttt0034583\t5d8633ecc97b9d08e989d9990f697905',
    '  2\tApocalypse Now (1979)\ttt0078788\t9a0baff40f6daea8b082bba7ecd45ef8',
    '  3\tNo Imdb Here (2020)\t-\tdeadbeef',
    '',
  ].join('\n');
  const e = parseSnapshot(txt);
  ok(e.length === 2, `parseSnapshot skips comments/blank/'-' imdb: got ${e.length}, want 2`);
  eq(e[0], { k: 'imdb:tt0034583', name: 'Casablanca (1943)', lastId: '5d8633ecc97b9d08e989d9990f697905' }, 'first row parsed');
  ok(e[1].k === 'imdb:tt0078788', 'second row keyed by imdb');
  // The id in a snapshot is the one that has since DIED — that is precisely its value, because
  // idAlive(deadId) === false is the proof that the entry was orphaned rather than removed by hand.
  ok(e[0].lastId.length === 32, 'the dead jellyfin id is preserved for the orphan-vs-removal check');
}
ok(parseSnapshot('').length === 0, 'empty snapshot parses to nothing');
ok(parseSnapshot('# only a comment\n').length === 0, 'comment-only snapshot parses to nothing');
ok(typeof mergedSnapshots === 'function', 'mergedSnapshots is exported');

console.log(`\ntop100-order: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
